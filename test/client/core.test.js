import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAccountUsage,
  sumBlocksInRange,
  localWindowTotals,
  computeShares,
  validateReport,
} from '../../plugin/scripts/core.js';

const API_SAMPLE = {
  five_hour: { utilization: 10.0, resets_at: '2026-10-19T08:00:00.112731+00:00' },
  seven_day: { utilization: 61.0, resets_at: '2026-10-20T17:00:00.112752+00:00' },
  seven_day_opus: null,
};

const block = (start, cost, tokens, extra = {}) => ({
  startTime: start,
  endTime: new Date(Date.parse(start) + 3600_000).toISOString(),
  costUSD: cost,
  totalTokens: tokens,
  isGap: false,
  ...extra,
});

test('parseAccountUsage extracts 5h and weekly utilization', () => {
  const account = parseAccountUsage(API_SAMPLE);
  assert.deepEqual(account.fiveHour, { pct: 10, resetsAt: '2026-10-19T08:00:00.112Z' });
  assert.equal(account.sevenDay.pct, 61);
});

test('parseAccountUsage returns null for missing windows and throws on bad shape', () => {
  assert.equal(parseAccountUsage({ seven_day: API_SAMPLE.seven_day }).fiveHour, null);
  assert.throws(() => parseAccountUsage({ five_hour: { utilization: 'x', resets_at: 'nope' } }), /five_hour/);
  assert.throws(() => parseAccountUsage(null), /not an object/);
});

test('sumBlocksInRange includes overlapping blocks and skips gaps', () => {
  const blocks = [
    block('2026-10-19T02:00:00.000Z', 5, 500), // ends at 03:00 → before window start 03:00:00.112
    block('2026-10-19T03:00:00.000Z', 1, 100),
    block('2026-10-19T04:00:00.000Z', 2, 200, { isGap: true }),
    block('2026-10-19T07:00:00.000Z', 3, 300),
    block('2026-10-19T08:00:00.000Z', 9, 900), // starts at 08:00 → still overlaps until 08:00:00.112
  ];
  const start = Date.parse('2026-10-19T03:00:00.112Z');
  const end = Date.parse('2026-10-19T08:00:00.000Z');
  assert.deepEqual(sumBlocksInRange(blocks, start, end), { costUSD: 4, tokens: 400 });
});

test('localWindowTotals aligns to account reset times', () => {
  const account = parseAccountUsage(API_SAMPLE);
  const blocks = [block('2026-10-14T10:00:00.000Z', 7, 70), block('2026-10-19T05:00:00.000Z', 1, 10)];
  const totals = localWindowTotals(blocks, account);
  assert.deepEqual(totals.fiveHour, { costUSD: 1, tokens: 10 });
  assert.deepEqual(totals.sevenDay, { costUSD: 8, tokens: 80 });
  assert.equal(localWindowTotals(blocks, { fiveHour: null, sevenDay: null }).fiveHour, null);
});

const report = (device, reportedAt, fiveCost, weekCost, fivePct = 10, fiveReset = '2026-10-19T08:00:00.000Z') => ({
  device,
  reportedAt,
  account: {
    fiveHour: { pct: fivePct, resetsAt: fiveReset },
    sevenDay: { pct: 60, resetsAt: '2026-10-20T17:00:00.000Z' },
  },
  local: { fiveHour: { costUSD: fiveCost, tokens: 1 }, sevenDay: { costUSD: weekCost, tokens: 1 } },
});

test('computeShares splits account % by cost and uses freshest snapshot', () => {
  const result = computeShares([
    report('mac', '2026-10-19T06:00:00Z', 3, 30, 8),
    report('linux', '2026-10-19T06:30:00Z', 1, 90, 12),
  ]);
  assert.equal(result.account.fiveHour.pct, 12);
  const five = result.windows.fiveHour;
  assert.equal(five[0].device, 'mac');
  assert.equal(five[0].sharePct, 9);
  assert.equal(five[1].sharePct, 3);
  assert.equal(result.windows.sevenDay[0].device, 'linux');
  assert.equal(result.windows.sevenDay[0].sharePct, 45);
});

test('computeShares excludes devices reporting a previous window', () => {
  const result = computeShares([
    report('old', '2026-10-19T02:00:00Z', 5, 10, 50, '2026-10-19T03:00:00.000Z'),
    report('mac', '2026-10-19T06:00:00Z', 2, 10),
  ]);
  assert.deepEqual(result.windows.fiveHour.map((r) => r.device), ['mac']);
  assert.equal(result.windows.fiveHour[0].sharePct, 10);
  assert.equal(result.windows.sevenDay.length, 2);
});

test('computeShares handles empty input and zero cost', () => {
  assert.deepEqual(computeShares([]), { account: null, windows: {} });
  const zero = computeShares([report('mac', '2026-10-19T06:00:00Z', 0, 0)]);
  assert.equal(zero.windows.fiveHour[0].sharePct, 0);
});

test('validateReport accepts a good report and rejects bad input', () => {
  const good = report('my-mac.local', '2026-10-19T06:00:00Z', 1, 2);
  assert.equal(validateReport(good).device, 'my-mac.local');
  assert.throws(() => validateReport({ ...good, device: '<script>' }), /device/);
  assert.throws(() => validateReport({ ...good, reportedAt: 'x' }), /reportedAt/);
  assert.throws(() => validateReport('nope'), /object/);
  const partial = validateReport({ ...good, local: { fiveHour: { costUSD: -1, tokens: 1 } } });
  assert.equal(partial.local.fiveHour, null);
});
