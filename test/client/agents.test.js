import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCodexPlan, claudeDaily, parseCodexSnapshot, summarizeAgents } from '../../plugin/scripts/agents.js';

const breakdown = (modelName, cost, tokens) => ({ modelName, cost, inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
const agentRow = (agent, totalCost, totalTokens, models) => ({ agent, totalCost, totalTokens, modelBreakdowns: models });
const daily = [
  { period: '2026-10-10', agents: [agentRow('codex', 99, 999, [breakdown('gpt-5.5-codex', 99, 999)])] }, // before the 7-day range
  { period: '2026-10-14', agents: [agentRow('codex', 4, 400, [breakdown('gpt-5.5-codex', 4, 400)]), agentRow('claude', 50, 5000, [breakdown('claude-opus-5-5', 50, 5000)])] },
  {
    period: '2026-10-19',
    agents: [
      agentRow('codex', 3, 300, [breakdown('gpt-5.5-codex', 2, 200), breakdown('gpt-5.5-mini', 1, 100)]),
      agentRow('gemini', 0.5, 50, [breakdown('gemini-3-pro', 0.5, 50)]),
      agentRow('opencode', 0, 0, []),
    ],
  },
];

test('summarizeAgents totals today and the last 7 days per non-Claude agent, with models', () => {
  const agents = summarizeAgents(daily, { today: '2026-10-19', weekStart: '2026-10-13' });
  assert.deepEqual(Object.keys(agents).sort(), ['codex', 'gemini']);
  assert.deepEqual(agents.codex.today, { costUSD: 3, tokens: 300 });
  assert.deepEqual(agents.codex.week, { costUSD: 7, tokens: 700 });
  assert.deepEqual(agents.codex.models, [
    { model: 'gpt-5.5-codex', effort: null, speed: null, costUSD: 6, tokens: 600 },
    { model: 'gpt-5.5-mini', effort: null, speed: null, costUSD: 1, tokens: 100 },
  ]);
  assert.deepEqual(agents.gemini.today, { costUSD: 0.5, tokens: 50 });
  assert.deepEqual(summarizeAgents(undefined, { today: '2026-10-19', weekStart: '2026-10-13' }), {});
});

test('claudeDaily keeps only Claude model breakdowns (for per-model prices)', () => {
  assert.deepEqual(claudeDaily(daily), [{ modelBreakdowns: [] }, { modelBreakdowns: [breakdown('claude-opus-5-5', 50, 5000)] }, { modelBreakdowns: [] }]);
});

const codexLine = (rateLimits, timestamp = '2026-10-19T06:38:51.036Z') =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: rateLimits } });

test('parseCodexSnapshot reads Codex 5h and weekly plan % by window length', () => {
  const snap = parseCodexSnapshot(
    codexLine({
      primary: { used_percent: 23, window_minutes: 300, resets_at: 1776943297 },
      secondary: { used_percent: 8, window_minutes: 10080, resets_at: 1777482720 },
      plan_type: 'team',
    }),
  );
  assert.deepEqual(snap, {
    observedAt: '2026-10-19T06:38:51.036Z',
    plan: {
      fiveHour: { pct: 23, resetsAt: new Date(1776943297 * 1000).toISOString() },
      sevenDay: { pct: 8, resetsAt: new Date(1777482720 * 1000).toISOString() },
    },
  });
  // Older Codex versions report seconds-until-reset instead of a timestamp.
  const relative = parseCodexSnapshot(codexLine({ primary: { used_percent: 5, window_minutes: 299, resets_in_seconds: 60 } }));
  assert.deepEqual(relative.plan.fiveHour, { pct: 5, resetsAt: '2026-10-19T06:39:51.036Z' });
  assert.equal(relative.plan.sevenDay, null);
});

test('parseCodexSnapshot ignores lines without usable rate limits', () => {
  assert.equal(parseCodexSnapshot('{"type":"event_msg"}'), null);
  assert.equal(parseCodexSnapshot('"rate_limits" but not json'), null);
  assert.equal(parseCodexSnapshot(codexLine(null)), null);
  assert.equal(parseCodexSnapshot(codexLine({ primary: { used_percent: 'x', window_minutes: 300, resets_at: 1 } })), null);
  assert.equal(parseCodexSnapshot(codexLine({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } }, 'nope')), null);
});

test('attachCodexPlan adds the plan snapshot to Codex usage, creating it if needed', () => {
  const snapshot = { observedAt: '2026-10-19T06:00:00.000Z', plan: { fiveHour: { pct: 1, resetsAt: '2026-10-19T08:00:00.000Z' }, sevenDay: null } };
  const withUsage = attachCodexPlan({ codex: { today: { costUSD: 1, tokens: 1 }, week: { costUSD: 2, tokens: 2 }, models: [] } }, snapshot);
  assert.deepEqual(withUsage.codex, { today: { costUSD: 1, tokens: 1 }, week: { costUSD: 2, tokens: 2 }, models: [], plan: snapshot.plan, planObservedAt: snapshot.observedAt });
  const created = attachCodexPlan({}, snapshot);
  assert.deepEqual(created.codex.week, { costUSD: 0, tokens: 0 });
  assert.deepEqual(attachCodexPlan({ gemini: {} }, null), { gemini: {} });
});
