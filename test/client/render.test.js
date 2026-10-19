import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgo, formatDuration, formatTokens, renderPanel } from '../../plugin/scripts/render.js';

const now = new Date('2026-10-19T06:00:00Z');
const data = {
  device: 'mac',
  account: {
    fiveHour: { pct: 11, resetsAt: '2026-10-19T08:00:00Z' },
    sevenDay: { pct: 61, resetsAt: '2026-10-20T17:00:00Z' },
  },
  local: { fiveHour: { costUSD: 5.5, tokens: 6_400_000 }, sevenDay: { costUSD: 853.2, tokens: 2_350_000_000 } },
};

test('formatters', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(6_400_000), '6.4M');
  assert.equal(formatTokens(2_350_000_000), '2.35B');
  assert.equal(formatDuration(110 * 60_000), '1h 50m');
  assert.equal(formatDuration(35 * 3600_000), '1d 11h');
  assert.equal(formatDuration(-5), '0m');
  assert.equal(formatAgo('2026-10-19T05:59:30Z', now), 'just now');
  assert.equal(formatAgo('2026-10-19T05:48:00Z', now), '12m ago');
});

test('renderPanel shows account %, resets and local usage without a server', () => {
  const out = renderPanel(data, { now, timeZone: 'UTC' });
  assert.match(out, /5h .* 11%\s+in 2h 0m \(08:00\)\s+\$5\.50 · 6\.4M tok/);
  assert.match(out, /Weekly .* 61%\s+in 1d 11h \(Tue 17:00\)\s+\$853\.20 · 2\.35B tok/);
  assert.match(out, /Not connected to a tracker server — run \/usage-tracker:setup/);
});

test('renderPanel shows per-device split and sync errors', () => {
  const summary = {
    windows: {
      fiveHour: [
        { device: 'mac', costUSD: 5.5, tokens: 10, sharePct: 8.25, reportedAt: '2026-10-19T06:00:00Z', limitPct: 8, overLimit: true },
        { device: 'linux', costUSD: 1.83, tokens: 5, sharePct: 2.75, reportedAt: '2026-10-19T05:30:00Z', limitPct: null, overLimit: false },
      ],
      sevenDay: [],
    },
  };
  const out = renderPanel({ ...data, summary, serverUrl: 'https://usage.example.com' }, { now, timeZone: 'UTC' });
  assert.match(out, /Per device · https:\/\/usage\.example\.com/);
  assert.match(out, /5h\s+mac \*\s+≈ 8\.3%\s+8% OVER\s+\$5\.50/);
  assert.match(out, /linux\s+≈ 2\.8%\s+—\s+\$1\.83.*30m ago/);

  const err = renderPanel({ ...data, syncError: 'HTTP 401 unauthorized' }, { now, timeZone: 'UTC', color: true });
  assert.match(err, /sync: HTTP 401 unauthorized/);
  assert.match(err, /\x1b\[/);
});

test('renderPanel handles a missing window', () => {
  const out = renderPanel({ ...data, account: { ...data.account, fiveHour: null } }, { now, timeZone: 'UTC' });
  assert.match(out, /5h\s+n\/a/);
});
