import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertCandidates, DEFAULT_ALERTS, evaluateAlerts, normalizeAlertSettings, validateAlertSettings } from '../../server/src/telegram/alerts.js';
import { alertText, escapeHtml } from '../../server/src/telegram/format.js';
import { createSecretBox } from '../../server/src/telegram/secret-box.js';
import { alertsView, deviceKey, devicesView, helpView, MAIN_KEYBOARD, menuAction, outsideView, usageView } from '../../server/src/telegram/views.js';

const NOW = Date.parse('2026-10-19T10:00:00Z');
const R5 = '2026-10-19T12:00:00.000Z';
const RW = '2026-10-22T20:00:00.000Z';
const summary = (fivePct, weekPct, extra = {}) => ({
  account: { fiveHour: { pct: fivePct, resetsAt: R5 }, sevenDay: { pct: weekPct, resetsAt: RW } },
  windows: {
    fiveHour: [
      { device: 'Work Mac', sharePct: fivePct, limitPct: 50, overLimit: fivePct >= 50, costUSD: 1, tokens: 1, reportedAt: '2026-10-19T09:58:00Z', models: [] },
      { device: 'Home <PC>', sharePct: 2, limitPct: null, overLimit: false, costUSD: 1, tokens: 1, reportedAt: '2026-10-19T08:00:00Z', models: [] },
    ],
    sevenDay: [{ device: 'Work Mac', sharePct: 45, limitPct: 50, overLimit: false, costUSD: 9, tokens: 9, reportedAt: '2026-10-19T09:58:00Z', models: [] }],
  },
  devices: [
    { name: 'Home <PC>', reportedAt: '2026-10-19T08:00:00Z', limits: { fiveHour: null, sevenDay: null, enforce: false } },
    { name: 'Work Mac', reportedAt: '2026-10-19T09:58:00Z', limits: { fiveHour: 50, sevenDay: 50, enforce: true } },
  ],
  agents: [],
  ...extra,
});
const subscribed = (...devices) => ({ ...DEFAULT_ALERTS, devices });

test('alertCandidates lists Claude windows, device caps and agent plans', () => {
  const s = summary(30, 60, { agents: [{ id: 'codex', label: 'Codex', plan: { fiveHour: { pct: 95, resetsAt: R5 }, sevenDay: null }, devices: [] }] });
  assert.deepEqual(alertCandidates(s).map((c) => [c.key, c.kind, c.pct, c.limitPct]), [
    ['claude:fiveHour', 'plan', 30, 100],
    ['claude:sevenDay', 'plan', 60, 100],
    ['cap:Work Mac:fiveHour', 'cap', 30, 50],
    ['cap:Work Mac:sevenDay', 'cap', 45, 50],
    ['codex:fiveHour', 'agent', 95, 100],
  ]);
});

test('device cap alerts only fire for subscribed devices, for both windows', () => {
  const candidates = alertCandidates(summary(42, 10));
  assert.deepEqual(evaluateAlerts(candidates, DEFAULT_ALERTS, {}).alerts, [], 'no device subscribed by default');
  const on = evaluateAlerts(candidates, subscribed('Work Mac'), {});
  assert.deepEqual(on.alerts.map((a) => [a.key, a.level]), [['cap:Work Mac:fiveHour', 'near'], ['cap:Work Mac:sevenDay', 'near']]);
  assert.deepEqual(evaluateAlerts(candidates, subscribed('Home <PC>'), {}).alerts, [], 'a device without caps has nothing to alert on');
});

test('evaluateAlerts fires near, then hit, once per window', () => {
  const settings = subscribed('Work Mac');
  const near = evaluateAlerts(alertCandidates(summary(82, 10)), settings, {});
  assert.deepEqual(near.alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'near'], ['cap:Work Mac:fiveHour', 'hit'], ['cap:Work Mac:sevenDay', 'near']]);
  const jitter = (c) => ({ ...c, resetsAt: c.resetsAt.replace('.000Z', '.120Z') });
  assert.deepEqual(evaluateAlerts(alertCandidates(summary(85, 10)).map(jitter), settings, near.state).alerts, []);
  const hit = evaluateAlerts(alertCandidates(summary(100, 10)), settings, near.state);
  assert.deepEqual(hit.alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'hit']]);
  const next = alertCandidates(summary(81, 10)).map((c) => (c.key === 'claude:fiveHour' ? { ...c, resetsAt: '2026-10-19T17:00:00.000Z' } : c));
  assert.deepEqual(evaluateAlerts(next, settings, hit.state).alerts.map((a) => [a.key, a.level]), [['claude:fiveHour', 'near']]);
});

test('evaluateAlerts respects the other settings', () => {
  const agents = [{ id: 'codex', label: 'Codex', plan: { fiveHour: { pct: 90, resetsAt: R5 }, sevenDay: null }, devices: [] }];
  const candidates = alertCandidates(summary(100, 10, { agents }));
  assert.deepEqual(evaluateAlerts(candidates, { ...subscribed('Work Mac'), hit: false, agents: false, near: false }, {}).alerts, []);
  assert.deepEqual(evaluateAlerts(candidates, { ...DEFAULT_ALERTS, nearPct: 95 }, {}).alerts.map((a) => a.key), ['claude:fiveHour']);
  assert.deepEqual(evaluateAlerts(candidates, { ...subscribed('Work Mac'), enabled: false }, {}).alerts, []);
});

test('validateAlertSettings and normalizeAlertSettings', () => {
  const good = { enabled: true, nearPct: 75, near: true, hit: false, agents: false, devices: ['Work Mac', 'Work Mac', 'Home PC'] };
  assert.deepEqual(validateAlertSettings(good), { ...good, devices: ['Work Mac', 'Home PC'] });
  assert.throws(() => validateAlertSettings({ ...good, nearPct: 120 }), /nearPct/);
  assert.throws(() => validateAlertSettings({ ...good, near: 'yes' }), /near/);
  assert.throws(() => validateAlertSettings({ ...good, devices: ['<script>'] }), /devices/);
  assert.throws(() => validateAlertSettings({ ...good, devices: 'Work Mac' }), /devices/);
  assert.throws(() => validateAlertSettings(null), /object/);
  // Settings saved before per-device alerts existed.
  assert.deepEqual(normalizeAlertSettings({ enabled: true, nearPct: 70, near: true, hit: true, caps: true, agents: true }), { ...DEFAULT_ALERTS, nearPct: 70 });
  assert.deepEqual(normalizeAlertSettings(null), DEFAULT_ALERTS);
});

test('alertText uses emojis and escapes names', () => {
  const [hit] = evaluateAlerts(alertCandidates(summary(100, 10)), DEFAULT_ALERTS, {}).alerts;
  assert.match(alertText(hit, NOW), /🚨.*Claude 5-hour limit reached.*100%.*resets in 2h 0m/s);
  const caps = evaluateAlerts(alertCandidates(summary(42, 10)), subscribed('Work Mac'), {}).alerts;
  assert.match(alertText(caps[1], NOW), /⚠️.*Work Mac.*45%.*50% weekly cap/s);
  const capHit = evaluateAlerts(alertCandidates(summary(55, 10)), subscribed('Work Mac'), {}).alerts.find((a) => a.kind === 'cap');
  assert.match(alertText(capHit, NOW), /🚨.*Work Mac.*5-hour cap.*🔒 Claude Code is blocked/s);
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;"');
});

test('usageView: emoji bars, every device with its alert bell, Refresh button', () => {
  const view = usageView(summary(34, 71), subscribed('Work Mac'), NOW);
  assert.match(view.text, /📊 <b>Claude plan<\/b>/);
  assert.match(view.text, /5-hour.*🟩🟩🟩⬜.*<b>34%<\/b>/);
  assert.match(view.text, /Weekly.*🟨.*<b>71%<\/b>/);
  assert.match(view.text, /🔔 <b>Work Mac<\/b>/);
  assert.match(view.text, /🔕 <b>Home &lt;PC&gt;<\/b>/);
  // Each device window: icon, a bar filling toward the device's cap, colored by how close it is.
  assert.match(view.text, /⏱ 5h\s+🟩🟩🟩⬜⬜ 34% of 50% cap/);
  assert.match(view.text, /📅 Weekly\s+🟥🟥🟥🟥🟥 45% of 50% cap/);
  assert.match(view.text, /⏱ 5h\s+2\.0% of plan · no cap/);
  assert.match(usageView(summary(55, 71), DEFAULT_ALERTS, NOW).text, /⏱ 5h\s+🟥🟥🟥🟥🟥 ⛔ 55% — over 50% cap/);
  assert.deepEqual(view.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['u:refresh', 'd:show']);
  assert.match(usageView({ account: null, windows: {}, devices: [], agents: [] }, DEFAULT_ALERTS, NOW).text, /No devices have reported yet/);
});

test('usageView: outside Claude Code usage — unassigned total with an Assign button, assigned part per device', () => {
  const base = summary(34, 71);
  const withOutside = {
    ...base,
    windows: { ...base.windows, fiveHour: [{ ...base.windows.fiveHour[0], sharePct: 40, outsidePct: 6 }, base.windows.fiveHour[1]] },
    outside: { fiveHour: { unassignedPct: 3 }, sevenDay: { unassignedPct: 1 } },
  };
  const view = usageView(withOutside, subscribed('Work Mac'), NOW);
  assert.match(view.text, /🧭 Desktop \/ web, not assigned: 5h 3\.0% · weekly 1\.0%/);
  // The outside part sits on its own short line under the window, so nothing wraps mid-phrase.
  assert.match(view.text, /⏱ 5h\s+(🟩|🟨|🟥)+⬜* 40% of 50% cap\n {12}🧭 incl\. 6\.0% Desktop \/ web\n/);
  assert.deepEqual(view.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['u:refresh', 'd:show', 'o:ask']);
  const none = usageView({ ...base, outside: { fiveHour: { unassignedPct: 0 }, sevenDay: { unassignedPct: 0 } } }, DEFAULT_ALERTS, NOW);
  assert.doesNotMatch(none.text, /🧭/);
});

test('outsideView asks whose usage it was, marks the chosen device, and closes when split', () => {
  const event = { id: 'ab12cd34', device: null, windows: { fiveHour: { pct: 6, resetsAt: R5 }, sevenDay: { pct: 2, resetsAt: RW } } };
  const names = ['Home <PC>', 'Work Mac'];
  const ask = outsideView(event, names);
  assert.match(ask.text, /🧭 <b>Usage outside Claude Code<\/b>/);
  assert.match(ask.text, /Claude Desktop, claude\.ai or the Chrome extension/);
  assert.match(ask.text, /⏱ 5h \+6\.0% · 📅 Weekly \+2\.0%/);
  assert.match(ask.text, /Whose was it\?/);
  const buttons = ask.reply_markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]);
  assert.deepEqual(buttons, [
    ['💻 Home <PC>', `o:ab12cd34:${deviceKey('Home <PC>')}`],
    ['💻 Work Mac', `o:ab12cd34:${deviceKey('Work Mac')}`],
    ['🙈 Not sure — split by usage', 'o:ab12cd34:x'],
  ]);
  assert.ok(buttons.every(([, data]) => Buffer.byteLength(data) <= 64));

  const chosen = outsideView({ ...event, device: 'Work Mac' }, names);
  assert.match(chosen.text, /✅ Counted for <b>Work Mac<\/b>/);
  assert.ok(chosen.reply_markup.inline_keyboard.flat().some((b) => b.text === '✅ Work Mac'));

  const split = outsideView(event, names, 'split');
  assert.match(split.text, /🙈 Split across devices by their Claude Code usage/);
  assert.equal(split.reply_markup, undefined);
  assert.match(outsideView(null, names, 'expired').text, /⌛ Already answered, or its window has reset/);
});

test('devicesView: one toggle button per device, caps and a warning for devices without caps', () => {
  const view = devicesView(summary(34, 71), subscribed('Work Mac'), NOW);
  assert.match(view.text, /🔔 <b>Work Mac<\/b>.*🎯 Caps: 5h 50% · weekly 50%/s);
  assert.match(view.text, /🔕 <b>Home &lt;PC&gt;<\/b>.*No cap set/s);
  const buttons = view.reply_markup.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data]));
  assert.deepEqual(buttons, [
    [['🔕 Home <PC>', `d:${deviceKey('Home <PC>')}`]],
    [['🔔 Work Mac', `d:${deviceKey('Work Mac')}`]],
    [['⚙️ Alert settings', 'a:show']],
  ]);
  assert.ok(buttons.flat().every(([, data]) => Buffer.byteLength(data) <= 64), 'callback data fits Telegram limit');
  assert.match(devicesView({ devices: [], windows: {} }, DEFAULT_ALERTS, NOW).text, /No devices yet/);
});

test('alertsView: toggles, threshold choices and a way to the device list', () => {
  const view = alertsView({ ...subscribed('Work Mac'), nearPct: 80, hit: false }, summary(1, 1));
  assert.match(view.text, /🔔 <b>Alerts are on<\/b>/);
  assert.match(view.text, /💻 Devices: Work Mac \(1 of 2\)/);
  const buttons = view.reply_markup.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data]));
  assert.deepEqual(buttons, [
    [['✅ Alerts on', 'a:enabled']],
    [['✅ Near limit', 'a:near'], ['⬜ Limit reached', 'a:hit']],
    [['70%', 'a:p70'], ['• 80% •', 'a:p80'], ['90%', 'a:p90']],
    [['✅ Codex & other agents', 'a:agents']],
    [['💻 Device alerts', 'd:show']],
  ]);
  assert.match(alertsView({ ...DEFAULT_ALERTS, enabled: false }, summary(1, 1)).text, /🔕 <b>Alerts are off<\/b>/);
});

test('main keyboard buttons map to actions; slash commands still work', () => {
  assert.deepEqual(MAIN_KEYBOARD.keyboard.flat().map((b) => b.text), ['📊 Usage', '💻 Devices', '🔔 Alerts', '❓ Help']);
  assert.equal(MAIN_KEYBOARD.is_persistent, true);
  assert.equal(menuAction('📊 Usage'), 'usage');
  assert.equal(menuAction('💻 Devices'), 'devices');
  assert.equal(menuAction('/alerts'), 'alerts');
  assert.equal(menuAction('/usage@my_bot'), 'usage');
  assert.equal(menuAction('hello'), 'help');
  assert.match(helpView().text, /📊 Usage/);
  assert.match(helpView().text, /🧭/);
  assert.equal(helpView().reply_markup, MAIN_KEYBOARD);
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
