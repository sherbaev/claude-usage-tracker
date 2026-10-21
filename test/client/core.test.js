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

test('computeShares takes each window from the freshest report that has Claude data', () => {
  const codexOnly = { device: 'codex-box', reportedAt: '2026-10-19T07:00:00Z', account: { fiveHour: null, sevenDay: null }, local: { fiveHour: null, sevenDay: null } };
  const result = computeShares([report('mac', '2026-10-19T06:00:00Z', 3, 30, 8), codexOnly]);
  assert.equal(result.account.fiveHour.pct, 8);
  assert.deepEqual(result.windows.fiveHour.map((r) => r.device), ['mac']);
  const none = { unassignedPct: 0 };
  assert.deepEqual(computeShares([codexOnly]), {
    account: { fiveHour: null, sevenDay: null },
    windows: { fiveHour: [], sevenDay: [] },
    outside: { fiveHour: none, sevenDay: none },
  });
});

const outsideEvent = (device, fivePct, fiveReset = '2026-10-19T08:00:00.000Z') => ({
  id: 'e1',
  device,
  windows: { fiveHour: { pct: fivePct, resetsAt: fiveReset }, sevenDay: null },
});

test('computeShares holds unassigned outside usage apart from the devices', () => {
  const result = computeShares([report('mac', '2026-10-19T06:00:00Z', 3, 30, 12), report('linux', '2026-10-19T06:30:00Z', 1, 90, 12)], [outsideEvent(null, 4)]);
  assert.deepEqual(result.windows.fiveHour.map((r) => [r.device, r.sharePct, r.outsidePct]), [['mac', 6, 0], ['linux', 2, 0]]);
  assert.equal(result.outside.fiveHour.unassignedPct, 4);
  assert.equal(result.outside.sevenDay.unassignedPct, 0);
});

test('computeShares adds assigned outside usage to that device only', () => {
  const reports = [report('mac', '2026-10-19T06:00:00Z', 3, 30, 12), report('linux', '2026-10-19T06:30:00Z', 1, 90, 12)];
  const result = computeShares(reports, [outsideEvent('linux', 4)]);
  assert.deepEqual(result.windows.fiveHour.map((r) => [r.device, r.sharePct, r.outsidePct]), [['mac', 6, 0], ['linux', 6, 4]]);
  assert.equal(result.windows.fiveHour[1].models.length, 0);
  assert.equal(result.outside.fiveHour.unassignedPct, 0);
});

test('computeShares gives a device with only outside usage its own row', () => {
  const idle = report('ipad', '2026-10-19T01:00:00Z', 0, 0, 1, '2026-10-19T03:00:00.000Z');
  const result = computeShares([report('mac', '2026-10-19T06:00:00Z', 3, 30, 12), idle], [outsideEvent('ipad', 5)]);
  const row = result.windows.fiveHour.find((r) => r.device === 'ipad');
  assert.deepEqual([row.sharePct, row.outsidePct, row.costUSD], [5, 5, 0]);
  assert.equal(result.windows.fiveHour.find((r) => r.device === 'mac').sharePct, 7);
});

test('computeShares ignores outside usage of another window or a removed device', () => {
  const reports = [report('mac', '2026-10-19T06:00:00Z', 3, 30, 12)];
  assert.equal(computeShares(reports, [outsideEvent(null, 4, '2026-10-19T03:00:00.000Z')]).windows.fiveHour[0].sharePct, 12);
  assert.equal(computeShares(reports, [outsideEvent('gone', 4)]).windows.fiveHour[0].sharePct, 12);
  assert.equal(computeShares(reports, [{ ...outsideEvent(null, 4), split: true }]).windows.fiveHour[0].sharePct, 12, 'split by usage');
});

test('validateReport keeps cleaned agent usage', () => {
  const body = { ...report('mac', '2026-10-19T06:00:00Z', 1, 2), agents: { codex: { today: { costUSD: 1, tokens: 1 }, week: { costUSD: 2, tokens: 2 }, models: [] }, claude: {} } };
  assert.deepEqual(Object.keys(validateReport(body).agents), ['codex']);
  assert.deepEqual(validateReport(report('mac', '2026-10-19T06:00:00Z', 1, 2)).agents, {});
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

// ---- learned rate: each device gets only what its own Claude Code explains ----
const weekly = (device, reportedAt, weekCost, weekPct) => ({
  device,
  reportedAt,
  account: { fiveHour: null, sevenDay: { pct: weekPct, resetsAt: '2026-10-27T17:00:00.000Z' } },
  local: { fiveHour: null, sevenDay: { costUSD: weekCost, tokens: 1 } },
});
const close = (a, b) => Math.abs(a - b) < 1e-6;

test('computeShares with a learned rate: an idle device keeps its share; the rest is outside usage', () => {
  // The other Mac stopped at $109.20; this Mac's Desktop use pushed the plan from 7.8% to 11%.
  const reports = [weekly('other', '2026-10-21T12:12:00Z', 109.2, 6), weekly('mac', '2026-10-21T19:15:00Z', 72.89, 11)];
  const result = computeShares(reports, [], { sevenDay: 0.043 });
  const share = (d) => result.windows.sevenDay.find((r) => r.device === d).sharePct;
  assert.ok(close(share('other'), 0.043 * 109.2), String(share('other')));
  assert.ok(close(share('mac'), 0.043 * 72.89), String(share('mac')));
  assert.ok(close(result.outside.sevenDay.unassignedPct, 11 - 0.043 * 182.09), String(result.outside.sevenDay.unassignedPct));
});

test('computeShares with a rate above what the plan shows scales every device down, nothing outside', () => {
  const result = computeShares([weekly('mac', '2026-10-21T19:15:00Z', 200, 5)], [], { sevenDay: 0.043 });
  assert.equal(result.windows.sevenDay[0].sharePct, 5);
  assert.equal(result.outside.sevenDay.unassignedPct, 0);
});

test('validateReport keeps when Claude Desktop, claude.ai and the Chrome extension were last used', () => {
  const body = { ...report('mac', '2026-10-21T19:15:00Z', 1, 2), surfaces: { desktop: '2026-10-21T19:10:00Z', web: 'nope', extension: '2030-01-01T00:00:00Z', other: '2026-10-21T19:00:00Z' } };
  assert.deepEqual(validateReport(body).surfaces, { desktop: '2026-10-21T19:10:00.000Z', web: null, extension: null });
  assert.deepEqual(validateReport(report('mac', '2026-10-21T19:15:00Z', 1, 2)).surfaces, { desktop: null, web: null, extension: null });
});

test('computeShares with a rate counts "Not sure" usage as Claude Code, not as unassigned', () => {
  const reports = [weekly('other', '2026-10-21T12:12:00Z', 109.2, 6), weekly('mac', '2026-10-21T19:15:00Z', 72.89, 11)];
  const leftover = 11 - 0.043 * 182.09;
  const split = { id: 's', device: null, split: true, windows: { sevenDay: { pct: leftover, resetsAt: '2026-10-27T17:00:00.000Z' } } };
  const result = computeShares(reports, [split], { sevenDay: 0.043 });
  assert.ok(close(result.outside.sevenDay.unassignedPct, 0), String(result.outside.sevenDay.unassignedPct));
  assert.ok(close(result.windows.sevenDay.reduce((sum, r) => sum + r.sharePct, 0), 11));
});
