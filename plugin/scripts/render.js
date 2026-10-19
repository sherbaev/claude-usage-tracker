// Terminal rendering for the window panel. Pure: returns strings.
import { WINDOWS } from './core.js';

const BAR_WIDTH = 20;
const WARN_PCT = 70;
const CRIT_PCT = 90;
const MINUTE_MS = 60 * 1000;

const makePalette = (color) => {
  const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33'), cyan: wrap('36') };
};

export function formatTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatAgo(iso, now) {
  const ms = now.getTime() - Date.parse(iso);
  return ms < MINUTE_MS ? 'just now' : `${formatDuration(ms)} ago`;
}

export const usd = (n) => `$${n.toFixed(2)}`;

function bar(pct, c) {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const paint = pct >= CRIT_PCT ? c.red : pct >= WARN_PCT ? c.yellow : c.green;
  return paint('█'.repeat(filled)) + c.dim('░'.repeat(BAR_WIDTH - filled));
}

function resetLabel(resetsAt, now, timeZone) {
  // Anthropic reports resets a few ms around the hour; round so 07:59:59.9 shows as 08:00.
  const at = new Date(Math.round(Date.parse(resetsAt) / MINUTE_MS) * MINUTE_MS);
  const sameDay = at.toDateString() === now.toDateString();
  const when = at.toLocaleString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short' }),
  });
  return `in ${formatDuration(at - now)} (${when})`;
}

function accountLines({ account, local }, now, c, timeZone) {
  const header = `  ${'Window'.padEnd(8)}${'Account (all devices)'.padEnd(29)}${'Resets'.padEnd(22)}This device`;
  const rows = Object.entries(WINDOWS).map(([key, { label }]) => {
    const win = account[key];
    if (!win) return `  ${label.padEnd(8)}${c.dim('n/a')}`;
    const pct = `${win.pct.toFixed(0)}%`.padStart(4);
    const mine = local[key] ? `${usd(local[key].costUSD)} · ${formatTokens(local[key].tokens)} tok` : '–';
    return `  ${label.padEnd(8)}${bar(win.pct, c)} ${c.bold(pct)}    ${resetLabel(win.resetsAt, now, timeZone).padEnd(22)}${mine}`;
  });
  return [c.dim(header), ...rows];
}

const CAP_WIDTH = 15;
const DEVICE_WIDTH = 22;
const MODEL_WIDTH = 28;

function capCell(row, c) {
  if (row.limitPct == null) return c.dim('—'.padEnd(CAP_WIDTH));
  if (row.overLimit) return c.red(`${row.limitPct}% OVER`.padEnd(CAP_WIDTH));
  const left = Math.max(0, row.limitPct - row.sharePct);
  return `${row.limitPct}% (${left.toFixed(0)} left)`.padEnd(CAP_WIDTH);
}

const deviceName = (device, selfDevice, c) =>
  device === selfDevice ? c.cyan(`${device} *`.padEnd(DEVICE_WIDTH)) : device.padEnd(DEVICE_WIDTH);
const shareText = (pct) => `≈ ${pct.toFixed(1)}%`.padEnd(14);

function deviceLines(summary, selfDevice, now, c) {
  const header = `  ${'Window'.padEnd(8)}${'Device'.padEnd(DEVICE_WIDTH)}${'≈ % of limit'.padEnd(14)}${'Cap'.padEnd(CAP_WIDTH)}${'Cost'.padEnd(11)}${'Tokens'.padEnd(10)}Synced`;
  const rows = Object.entries(WINDOWS).flatMap(([key, { label }]) =>
    (summary.windows[key] ?? []).map((row, i) => {
      const window = (i === 0 ? label : '').padEnd(8);
      return `  ${window}${deviceName(row.device, selfDevice, c)}${c.bold(shareText(row.sharePct))}${capCell(row, c)}${usd(row.costUSD).padEnd(11)}${formatTokens(row.tokens).padEnd(10)}${c.dim(formatAgo(row.reportedAt, now))}`;
    }),
  );
  return [c.dim(header), ...rows];
}

/** Model · effort rows under each device, per window. Empty when no device reported a breakdown. */
function modelLines(summary, selfDevice, c) {
  const rows = Object.entries(WINDOWS).flatMap(([key, { label }]) =>
    (summary.windows[key] ?? [])
      .filter((row) => row.models?.length)
      .flatMap((row, deviceIndex) =>
        row.models.map((m, i) => {
          const window = (deviceIndex === 0 && i === 0 ? label : '').padEnd(8);
          const name = i === 0 ? deviceName(row.device, selfDevice, c) : ''.padEnd(DEVICE_WIDTH);
          return `  ${window}${name}${m.label.padEnd(MODEL_WIDTH)}${c.bold(shareText(m.sharePct))}${usd(m.costUSD).padEnd(11)}${formatTokens(m.tokens)}`;
        }),
      ),
  );
  if (!rows.length) return [];
  const header = `  ${'Window'.padEnd(8)}${'Device'.padEnd(DEVICE_WIDTH)}${'Model · effort'.padEnd(MODEL_WIDTH)}${'≈ % of limit'.padEnd(14)}${'Cost'.padEnd(11)}Tokens`;
  return ['', `${c.bold('By model · effort')} ${c.dim('· each device % split by cost')}`, c.dim(header), ...rows];
}

/**
 * @param {{ device: string, account: object, local: object, summary?: object|null, syncError?: string|null, serverUrl?: string|null }} data
 */
export function renderPanel(data, { now = new Date(), color = false, timeZone } = {}) {
  const c = makePalette(color);
  const lines = [
    '',
    `${c.bold('Claude plan windows')} ${c.dim(`· device: ${data.device}`)}`,
    ...accountLines(data, now, c, timeZone),
  ];
  if (data.summary) {
    lines.push('', `${c.bold('Per device')} ${c.dim(`· ${data.serverUrl} · % split by cost share`)}`);
    lines.push(...deviceLines(data.summary, data.device, now, c), ...modelLines(data.summary, data.device, c));
  } else if (data.syncError) {
    lines.push('', c.yellow(`  sync: ${data.syncError}`));
  } else {
    lines.push('', c.dim('  Not connected to a tracker server — run /usage-tracker:setup to see all your devices.'));
  }
  return `${lines.join('\n')}\n`;
}
