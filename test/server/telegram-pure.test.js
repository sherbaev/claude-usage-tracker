import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertCandidates, evaluateAlerts, validateAlertSettings, DEFAULT_ALERTS } from '../../server/src/telegram/alerts.js';
import { alertText, escapeHtml, usageText } from '../../server/src/telegram/format.js';
import { createSecretBox } from '../../server/src/telegram/secret-box.js';

const NOW = Date.parse('2026-10-19T10:00:00Z');
const R5 = '2026-10-19T12:00:00.000Z';
const RW = '2026-10-22T20:00:00.000Z';
const summary = (fivePct, weekPct, extra = {}) => ({
  account: { fiveHour: { pct: fivePct, resetsAt: R5 }, sevenDay: { pct: weekPct, resetsAt: RW } },
  windows: {
    fiveHour: [{ device: 'Work Mac', sharePct: fivePct, limitPct: null, overLimit: false, costUSD: 1, tokens: 1, reportedAt: '2026-10-19T09:59:00Z', models: [] }],
    sevenDay: [{ device: 'Work Mac', sharePct: 45, limitPct: 50, overLimit: false, costUSD: 9, tokens: 9, reportedAt: '2026-10-19T09:59:00Z', models: [{ label: 'Opus 5.5 · high', sharePct: 40 }] }],
  },
  devices: [{ name: 'Work Mac', reportedAt: '2026-10-19T09:59:00Z', limits: { fiveHour: null, sevenDay: 50, enforce: true } }],
  agents: [],
  ...extra,
});

test('alertCandidates lists Claude windows, device caps and agent plans', () => {
  const s = summary(30, 60, {
    agents: [{ id: 'codex', label: 'Codex', plan: { fiveHour: { pct: 95, resetsAt: R5 }, sevenDay: null }, devices: [] }],
  });
  const keys = alertCandidates(s).map((c) => [c.key, c.kind, c.pct, c.limitPct]);
  assert.deepEqual(keys, [
    ['claude:fiveHour', 'plan', 30, 100],
    ['claude:sevenDay', 'plan', 60, 100],
    ['cap:Work Mac:sevenDay', 'cap', 45, 50],
    ['codex:fiveHour', 'agent', 95, 100],
  ]);
});

test('evaluateAlerts fires near, then hit, once per window', () => {
  const near = evaluateAlerts(alertCandidates(summary(82, 10)), DEFAULT_ALERTS, {});
  assert.deepEqual(near.alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'near'], ['cap:Work Mac:sevenDay', 'near']]);
  // Same level again in the same window (reset time jitters by a few ms): nothing new.
  const again = evaluateAlerts(alertCandidates(summary(85, 10)).map((c) => ({ ...c, resetsAt: c.resetsAt.replace('.000Z', '.120Z') })), DEFAULT_ALERTS, near.state);
  assert.deepEqual(again.alerts, []);
  const hit = evaluateAlerts(alertCandidates(summary(100, 10)), DEFAULT_ALERTS, again.state);
  assert.deepEqual(hit.alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'hit']]);
  // A new window starts over.
  const next = alertCandidates(summary(81, 10)).map((c) => (c.key === 'claude:fiveHour' ? { ...c, resetsAt: '2026-10-19T17:00:00.000Z' } : c));
  assert.deepEqual(evaluateAlerts(next, DEFAULT_ALERTS, hit.state).alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'near']]);
});

test('evaluateAlerts respects the settings', () => {
  const candidates = alertCandidates(summary(100, 10, { agents: [{ id: 'codex', label: 'Codex', plan: { fiveHour: { pct: 90, resetsAt: R5 }, sevenDay: null }, devices: [] }] }));
  const off = { ...DEFAULT_ALERTS, hit: false, caps: false, agents: false };
  assert.deepEqual(evaluateAlerts(candidates, off, {}).alerts, []);
  const higher = { ...DEFAULT_ALERTS, nearPct: 95 };
  assert.deepEqual(evaluateAlerts(candidates, higher, {}).alerts.map((a) => a.key), ['claude:fiveHour']);
  assert.deepEqual(evaluateAlerts(candidates, { ...DEFAULT_ALERTS, enabled: false }, {}).alerts, []);
});

test('validateAlertSettings checks types and ranges', () => {
  assert.deepEqual(validateAlertSettings({ enabled: true, nearPct: 75, near: true, hit: false, caps: true, agents: false }), {
    enabled: true, nearPct: 75, near: true, hit: false, caps: true, agents: false,
  });
  assert.throws(() => validateAlertSettings({ ...DEFAULT_ALERTS, nearPct: 120 }), /nearPct/);
  assert.throws(() => validateAlertSettings({ ...DEFAULT_ALERTS, near: 'yes' }), /near/);
  assert.throws(() => validateAlertSettings(null), /object/);
});

test('alertText and usageText escape names and read clearly', () => {
  const [alert] = evaluateAlerts(alertCandidates(summary(100, 10)), DEFAULT_ALERTS, {}).alerts;
  assert.match(alertText(alert, NOW), /Claude 5-hour limit reached.*100%.*resets in 2h 0m/s);
  const capNear = evaluateAlerts(alertCandidates(summary(10, 10)), DEFAULT_ALERTS, {}).alerts[0];
  assert.match(alertText(capNear, NOW), /Work Mac.*45% of its 50% weekly cap/s);
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;"');

  const text = usageText(summary(34, 71, { agents: [{ id: 'codex', label: 'Codex', plan: { fiveHour: { pct: 23, resetsAt: R5 }, sevenDay: null }, devices: [{ device: 'Box', today: { costUSD: 1, tokens: 1 }, week: { costUSD: 4.5, tokens: 9 }, models: [] }] }] }), NOW);
  assert.match(text, /Claude plan/);
  assert.match(text, /5h.*34%.*resets in 2h 0m/);
  assert.match(text, /Weekly.*71%/);
  assert.match(text, /Work Mac/);
  assert.match(text, /45%.*cap 50%/);
  assert.match(text, /Codex/);
  assert.match(text, /Box.*\$4\.50/);
  assert.match(usageText({ account: null, windows: {}, devices: [], agents: [] }, NOW), /No devices have reported yet/);
});

test('secret box seals and opens, and rejects tampering', () => {
  const box = createSecretBox(Buffer.alloc(32, 7));
  const sealed = box.seal('123456:secret-token');
  assert.notEqual(sealed, '123456:secret-token');
  assert.equal(box.open(sealed), '123456:secret-token');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  assert.throws(() => box.open(tampered));
  assert.throws(() => createSecretBox(Buffer.alloc(16)), /32 bytes/);
});
