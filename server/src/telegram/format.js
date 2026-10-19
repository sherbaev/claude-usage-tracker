// Telegram message text (HTML parse mode). Pure. Everything user-provided goes through escapeHtml.
const MINUTE_MS = 60 * 1000;
const BAR_WIDTH = 10;
const WINDOW_NAMES = Object.freeze({ fiveHour: '5-hour', sevenDay: 'weekly' });
const WINDOW_SHORT = Object.freeze({ fiveHour: '5h', sevenDay: 'Weekly' });

export const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pct = (n) => `${n.toFixed(n < 10 ? 1 : 0)}%`;
const usd = (n) => `$${n.toFixed(2)}`;

export function duration(ms) {
  const totalMin = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${totalMin % 60}m`;
  return `${totalMin % 60}m`;
}

const resetsIn = (iso, now) => `resets in ${duration(Date.parse(iso) - now)}`;

function bar(value) {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

/** One alert as a short message. */
export function alertText(alert, now = Date.now()) {
  const window = WINDOW_NAMES[alert.window] ?? alert.window;
  const resets = resetsIn(alert.resetsAt, now);
  if (alert.kind === 'cap') {
    const name = `<b>${escapeHtml(alert.device)}</b>`;
    if (alert.level === 'hit') {
      const blocked = alert.enforce ? ' Claude Code is blocked on it' : ' (warning only)';
      return `⛔ ${name} reached its ${window} cap of ${alert.limitPct}%.${blocked} — ${resets}.`;
    }
    return `⚠️ ${name} is at ${pct(alert.pct)} of its ${alert.limitPct}% ${window} cap — ${resets}.`;
  }
  const what = `${escapeHtml(alert.source)} ${window}`;
  if (alert.level === 'hit') return `⛔ <b>${what} limit reached</b> (${pct(alert.pct)}) — ${resets}.`;
  return `⚠️ <b>${what} window</b> at ${pct(alert.pct)} — ${resets}.`;
}

function planLines(account, now) {
  const rows = Object.entries(WINDOW_SHORT)
    .filter(([key]) => account?.[key])
    .map(([key, label]) => `${label}: ${bar(account[key].pct)} <b>${pct(account[key].pct)}</b> · ${resetsIn(account[key].resetsAt, now)}`);
  return rows.length ? ['<b>Claude plan</b>', ...rows] : [];
}

function deviceLine(device, windows) {
  const parts = Object.entries(WINDOW_SHORT)
    .map(([key, label]) => {
      const row = (windows[key] ?? []).find((r) => r.device === device);
      if (!row) return null;
      const cap = row.limitPct == null ? '' : row.overLimit ? ` (OVER cap ${row.limitPct}%)` : ` (cap ${row.limitPct}%)`;
      return `${label.toLowerCase()} ${pct(row.sharePct)}${cap}`;
    })
    .filter(Boolean);
  return parts.length ? `• <b>${escapeHtml(device)}</b> — ${parts.join(' · ')}` : null;
}

function agentLines(agents) {
  return (agents ?? [])
    .filter((a) => a.devices.length)
    .flatMap((a) => {
      const plan = Object.entries(WINDOW_SHORT)
        .filter(([key]) => a.plan?.[key])
        .map(([key, label]) => `${label.toLowerCase()} ${pct(a.plan[key].pct)}`);
      return [
        '',
        `<b>${escapeHtml(a.label)}</b>${plan.length ? ` · ${plan.join(' · ')}` : ''}`,
        ...a.devices.map((d) => `• <b>${escapeHtml(d.device)}</b> — today ${usd(d.today.costUSD)} · 7 days ${usd(d.week.costUSD)}`),
      ];
    });
}

/** The /usage reply: plan windows, every device's share and cap, other agents. */
export function usageText(summary, now = Date.now()) {
  const devices = [...new Set(Object.values(summary.windows ?? {}).flatMap((rows) => rows.map((r) => r.device)))];
  const deviceLines = devices.map((d) => deviceLine(d, summary.windows)).filter(Boolean);
  const agents = agentLines(summary.agents);
  if (!deviceLines.length && !agents.length && !summary.account?.fiveHour && !summary.account?.sevenDay) {
    return 'No devices have reported yet. Install the plugin and run Claude Code on a device.';
  }
  const lines = [
    ...planLines(summary.account, now),
    ...(deviceLines.length ? ['', '<b>Devices</b> · ≈ share of the plan', ...deviceLines] : []),
    ...agents,
  ];
  return lines.join('\n').trim();
}
