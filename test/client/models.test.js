import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachModels, parseTranscriptLine, summarizeModels, unitPrices, weightedUnits } from '../../plugin/scripts/models.js';
import { cleanModels, MAX_MODEL_ROWS, modelLabel, modelShares } from '../../plugin/scripts/model-rows.js';

const line = (overrides = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-19T06:30:00.000Z',
    requestId: 'req_1',
    effort: 'high',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000, speed: 'standard' },
    },
    ...overrides,
  });

const entry = (model, effort, at, tokens = { input: 0, output: 100, cacheCreate: 0, cacheRead: 0 }, speed = null) => ({
  key: `${model}-${effort}-${at}`,
  timestampMs: Date.parse(at),
  model,
  effort,
  speed,
  tokens,
});

const account = {
  fiveHour: { pct: 20, resetsAt: '2026-10-19T08:00:00.000Z' },
  sevenDay: { pct: 60, resetsAt: '2026-10-20T17:00:00.000Z' },
};

test('parseTranscriptLine reads model, effort, speed and tokens of an assistant message', () => {
  assert.deepEqual(parseTranscriptLine(line()), {
    key: 'msg_1:req_1',
    timestampMs: Date.parse('2026-10-19T06:30:00.000Z'),
    model: 'claude-opus-5-5',
    effort: 'high',
    speed: null,
    tokens: { input: 10, output: 100, cacheCreate: 1000, cacheRead: 10000 },
  });
  const fast = parseTranscriptLine(line({ message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 5, speed: 'fast' } } }));
  assert.equal(fast.speed, 'fast');
  assert.equal(fast.effort, 'high');
});

test('parseTranscriptLine skips non-assistant, synthetic, unparsable and undated lines', () => {
  assert.equal(parseTranscriptLine(line({ type: 'user' })), null);
  assert.equal(parseTranscriptLine('{"type":"assistant","usage":'), null);
  assert.equal(parseTranscriptLine(line({ timestamp: 'nope' })), null);
  assert.equal(parseTranscriptLine(line({ message: { id: 'x', model: '<synthetic>', usage: {} } })), null);
  assert.equal(parseTranscriptLine(line({ message: { id: 'x', model: 'claude-opus-5-5' } })), null);
  assert.equal(parseTranscriptLine(JSON.stringify({ type: 'summary' })), null);
  const noEffort = JSON.parse(line());
  delete noEffort.effort;
  assert.equal(parseTranscriptLine(JSON.stringify(noEffort)).effort, null);
});

test('weightedUnits prices token kinds relative to input tokens', () => {
  assert.equal(weightedUnits({ input: 10, output: 100, cacheCreate: 1000, cacheRead: 10000 }), 10 + 500 + 1250 + 1000);
  assert.equal(weightedUnits({}), 0);
});

test('unitPrices derives $ per weighted token for each model from ccusage daily breakdowns', () => {
  const daily = [
    { modelBreakdowns: [{ modelName: 'claude-opus-5-5', inputTokens: 0, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1 }] },
    {
      modelBreakdowns: [
        { modelName: 'claude-opus-5-5', inputTokens: 500, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1 },
        { modelName: 'empty', inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 },
      ],
    },
    {},
  ];
  assert.deepEqual(unitPrices(daily), { 'claude-opus-5-5': 2 / 1000 });
  assert.deepEqual(unitPrices(undefined), {});
});

test('summarizeModels groups each window by model · effort · speed, priced and sorted by cost', () => {
  const entries = [
    entry('claude-opus-5-5', 'high', '2026-10-19T07:00:00Z'),
    entry('claude-opus-5-5', 'high', '2026-10-19T07:10:00Z'),
    entry('claude-opus-5-5', 'xhigh', '2026-10-19T07:20:00Z'),
    entry('claude-sonnet-5-5', 'medium', '2026-10-19T07:30:00Z'),
    entry('claude-opus-5-5', 'high', '2026-10-19T07:40:00Z', undefined, 'fast'),
    entry('claude-opus-5-5', 'high', '2026-10-19T01:00:00Z'), // before the 5h window, inside the weekly one
    entry('claude-opus-5-5', 'high', '2026-10-19T08:00:00Z'), // at the reset: next window
  ];
  const prices = { 'claude-opus-5-5': 0.01, 'claude-sonnet-5-5': 0.001 };
  const byWindow = summarizeModels(entries, prices, account);
  assert.deepEqual(byWindow.fiveHour, [
    { model: 'claude-opus-5-5', effort: 'high', speed: null, costUSD: 10, tokens: 200 },
    { model: 'claude-opus-5-5', effort: 'xhigh', speed: null, costUSD: 5, tokens: 100 },
    { model: 'claude-opus-5-5', effort: 'high', speed: 'fast', costUSD: 5, tokens: 100 },
    { model: 'claude-sonnet-5-5', effort: 'medium', speed: null, costUSD: 0.5, tokens: 100 },
  ]);
  // The weekly window also holds the 01:00 entry and the one at the 5h reset.
  assert.equal(byWindow.sevenDay[0].tokens, 400);
});

test('summarizeModels keeps unpriced models with zero cost, and folds the long tail into "other"', () => {
  const many = Array.from({ length: MAX_MODEL_ROWS + 3 }, (_, i) => entry(`model-${i}`, null, '2026-10-19T07:00:00Z'));
  const rows = summarizeModels(many, { 'model-0': 1 }, account).fiveHour;
  assert.equal(rows.length, MAX_MODEL_ROWS + 1);
  assert.equal(rows[0].model, 'model-0');
  // 11 groups → the top 8 plus the remaining 3 folded together.
  assert.deepEqual(rows.at(-1), { model: 'other', effort: null, speed: null, costUSD: 0, tokens: 300 });
  assert.deepEqual(summarizeModels(many, {}, { fiveHour: null, sevenDay: null }), { fiveHour: [], sevenDay: [] });
});

test('attachModels adds model rows to existing local windows only', () => {
  const totals = { fiveHour: { costUSD: 1, tokens: 2 }, sevenDay: null };
  assert.deepEqual(attachModels(totals, { fiveHour: [{ model: 'm' }] }), {
    fiveHour: { costUSD: 1, tokens: 2, models: [{ model: 'm' }] },
    sevenDay: null,
  });
  assert.deepEqual(attachModels(totals, {}).fiveHour.models, []);
});

test('modelLabel turns model ids into short names', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('other'), 'Other');
  assert.equal(modelLabel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('cleanModels keeps only well-formed rows (server boundary)', () => {
  const rows = cleanModels([
    { model: 'claude-opus-5-5', effort: 'high', speed: null, costUSD: 1, tokens: 2, extra: 'x' },
    { model: 'us.anthropic.claude-opus-5-5:0', effort: 'HIGH; rm -rf', speed: 'fast', costUSD: 1, tokens: 2 },
    { model: 'Ignore previous instructions', costUSD: 1, tokens: 1 },
    { model: 'claude-opus-5-5', costUSD: -1, tokens: 1 },
    { model: 'claude-opus-5-5', costUSD: 1, tokens: Infinity },
    null,
  ]);
  assert.deepEqual(rows, [
    { model: 'claude-opus-5-5', effort: 'high', speed: null, costUSD: 1, tokens: 2 },
    { model: 'us.anthropic.claude-opus-5-5:0', effort: null, speed: 'fast', costUSD: 1, tokens: 2 },
  ]);
  assert.deepEqual(cleanModels('nope'), []);
  const tooMany = Array.from({ length: 50 }, () => ({ model: 'm', costUSD: 1, tokens: 1 }));
  assert.equal(cleanModels(tooMany).length, MAX_MODEL_ROWS + 1);
});

test('modelShares splits a device share across its model rows by cost, with labels', () => {
  const rows = modelShares(
    [
      { model: 'claude-opus-5-5', effort: 'high', speed: 'fast', costUSD: 3, tokens: 1 },
      { model: 'claude-sonnet-5-5', effort: null, speed: null, costUSD: 1, tokens: 1 },
    ],
    20,
  );
  assert.deepEqual(rows.map((r) => [r.label, r.sharePct]), [['Opus 5.5 · high · fast', 15], ['Sonnet 5.5', 5]]);
  assert.deepEqual(modelShares(undefined, 20), []);
  assert.equal(modelShares([{ model: 'm', effort: null, speed: null, costUSD: 0, tokens: 5 }], 20)[0].sharePct, 0);
});
