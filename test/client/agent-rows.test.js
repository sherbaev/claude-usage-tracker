import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentLabel, cleanAgents, summarizeAgentReports } from '../../plugin/scripts/agent-rows.js';

const usage = (cost, extra = {}) => ({ today: { costUSD: cost / 2, tokens: 10 }, week: { costUSD: cost, tokens: 100 }, models: [{ model: 'gpt-5.5-codex', costUSD: cost, tokens: 100 }], ...extra });
const NOW = Date.parse('2026-10-19T07:00:00Z');

test('agentLabel names known agents and passes others through', () => {
  assert.equal(agentLabel('codex'), 'Codex');
  assert.equal(agentLabel('gemini'), 'Gemini CLI');
  assert.equal(agentLabel('newtool'), 'newtool');
});

test('cleanAgents keeps valid agents and fields only (server boundary)', () => {
  const clean = cleanAgents({
    codex: usage(4, { plan: { fiveHour: { pct: 23, resetsAt: '2026-10-19T08:00:00Z' }, sevenDay: { pct: 'x' } }, planObservedAt: '2026-10-19T06:00:00Z', extra: 1 }),
    claude: usage(1),
    'Bad Agent!': usage(1),
    gemini: { today: null, week: { costUSD: -1, tokens: 1 } },
  });
  assert.deepEqual(Object.keys(clean), ['codex']);
  assert.deepEqual(clean.codex, {
    today: { costUSD: 2, tokens: 10 },
    week: { costUSD: 4, tokens: 100 },
    models: [{ model: 'gpt-5.5-codex', effort: null, speed: null, costUSD: 4, tokens: 100 }],
    plan: { fiveHour: { pct: 23, resetsAt: '2026-10-19T08:00:00.000Z' }, sevenDay: null },
    planObservedAt: '2026-10-19T06:00:00.000Z',
  });
  assert.deepEqual(cleanAgents('nope'), {});
  assert.deepEqual(cleanAgents(undefined), {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`agent${i}`, usage(1)]));
  assert.equal(Object.keys(cleanAgents(many)).length, 24);
});

test('summarizeAgentReports groups devices per agent and uses the freshest unexpired plan', () => {
  const reports = [
    { device: 'mac', reportedAt: '2026-10-19T06:00:00Z', agents: { codex: usage(4, { plan: { fiveHour: { pct: 20, resetsAt: '2026-10-19T08:00:00Z' }, sevenDay: { pct: 5, resetsAt: '2026-10-22T00:00:00Z' } }, planObservedAt: '2026-10-19T05:00:00Z' }) } },
    { device: 'pc', reportedAt: '2026-10-19T06:30:00Z', agents: { codex: usage(6, { plan: { fiveHour: { pct: 30, resetsAt: '2026-10-19T06:45:00Z' }, sevenDay: { pct: 9, resetsAt: '2026-10-22T00:00:00Z' } }, planObservedAt: '2026-10-19T06:20:00Z' }), gemini: usage(1) } },
    { device: 'old-plugin', reportedAt: '2026-10-19T06:00:00Z' },
  ];
  const agents = summarizeAgentReports(reports, NOW);
  assert.deepEqual(agents.map((a) => a.id), ['codex', 'gemini']);
  const codex = agents[0];
  assert.equal(codex.label, 'Codex');
  // pc's snapshot is fresher, but its 5h window already reset (06:45 < 07:00).
  assert.deepEqual(codex.plan, { fiveHour: null, sevenDay: { pct: 9, resetsAt: '2026-10-22T00:00:00Z' } });
  assert.equal(codex.planObservedAt, '2026-10-19T06:20:00Z');
  assert.deepEqual(codex.devices.map((d) => [d.device, d.week.costUSD]), [['pc', 6], ['mac', 4]]);
  assert.equal(codex.devices[0].models[0].label, 'gpt-5.5-codex');
  assert.equal(agents[1].plan, null);
  assert.deepEqual(summarizeAgentReports([], NOW), []);
});
