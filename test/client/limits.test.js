import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport } from '../../plugin/scripts/core.js';
import { activeViolations, applyLimits, deviceStatus, validateLimits } from '../../plugin/scripts/limits.js';

const shares = {
  account: {
    fiveHour: { pct: 40, resetsAt: '2026-10-19T08:00:00.000Z' },
    sevenDay: { pct: 60, resetsAt: '2026-10-20T17:00:00.000Z' },
  },
  windows: {
    fiveHour: [
      { device: 'mac', sharePct: 30 },
      { device: 'linux', sharePct: 10 },
    ],
    sevenDay: [{ device: 'mac', sharePct: 60 }],
  },
};

test('validateLimits accepts numbers 0-100 or null', () => {
  assert.deepEqual(validateLimits({ fiveHour: 25, sevenDay: null, enforce: true }), { fiveHour: 25, sevenDay: null, enforce: true });
  assert.deepEqual(validateLimits({}), { fiveHour: null, sevenDay: null, enforce: false });
  assert.throws(() => validateLimits({ fiveHour: 0 }), /fiveHour/);
  assert.throws(() => validateLimits({ sevenDay: 101 }), /sevenDay/);
  assert.throws(() => validateLimits({ fiveHour: '20' }), /fiveHour/);
  assert.throws(() => validateLimits({ enforce: 'yes' }), /enforce/);
  assert.throws(() => validateLimits(null), /object/);
});

test('applyLimits marks devices at or over their cap', () => {
  const limited = applyLimits(shares, { mac: { fiveHour: 30, sevenDay: null } });
  assert.deepEqual(limited.windows.fiveHour.map((r) => [r.device, r.limitPct, r.overLimit]), [
    ['mac', 30, true],
    ['linux', null, false],
  ]);
  assert.equal(limited.windows.sevenDay[0].overLimit, false);
  assert.equal(shares.windows.fiveHour[0].limitPct, undefined, 'input is not mutated');
});

test('deviceStatus + activeViolations drive the enforcement hook', () => {
  const limited = applyLimits(shares, { mac: { fiveHour: 20, sevenDay: 50 } });
  const status = deviceStatus(limited, 'mac', { fiveHour: 20, sevenDay: 50, enforce: true });
  assert.equal(status.enforce, true);
  assert.equal(status.windows.fiveHour.resetsAt, '2026-10-19T08:00:00.000Z');

  const beforeReset = Date.parse('2026-10-19T07:00:00Z');
  assert.deepEqual(activeViolations(status, beforeReset).map((v) => v.window), ['5h', 'Weekly']);
  const afterFiveHourReset = Date.parse('2026-10-19T09:00:00Z');
  assert.deepEqual(activeViolations(status, afterFiveHourReset).map((v) => v.window), ['Weekly'], 'reset windows no longer block');
  assert.deepEqual(activeViolations(null), []);
  assert.equal(deviceStatus(limited, 'unknown').windows.fiveHour, null);
});

test('validateReport rejects out-of-range numbers', () => {
  const base = {
    device: 'mac',
    reportedAt: '2026-10-19T06:00:00Z',
    account: { fiveHour: { pct: 1e308, resetsAt: '2026-10-19T08:00:00Z' } },
    local: { fiveHour: { costUSD: 1e300, tokens: 5 }, sevenDay: { costUSD: 5, tokens: -1 } },
  };
  const clean = validateReport(base);
  assert.equal(clean.account.fiveHour, null);
  assert.equal(clean.local.fiveHour, null);
  assert.equal(clean.local.sevenDay, null);
});
