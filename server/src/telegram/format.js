// Telegram message primitives and alert text (HTML parse mode). Pure. User-provided text goes through escapeHtml.
const MINUTE_MS = 60 * 1000;
export const WINDOW_NAMES = Object.freeze({ fiveHour: '5-hour', sevenDay: 'weekly' });

export const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const pct = (n) => `${n.toFixed(n < 10 ? 1 : 0)}%`;
export const usd = (n) => `$${n.toFixed(2)}`;

export function duration(ms) {
  const totalMin = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${totalMin % 60}m`;
  return `${totalMin % 60}m`;
}

export const resetsIn = (iso, now) => `resets in ${duration(Date.parse(iso) - now)}`;

/** One alert as a short message. */
export function alertText(alert, now = Date.now()) {
  const window = WINDOW_NAMES[alert.window] ?? alert.window;
  const resets = `⏳ ${resetsIn(alert.resetsAt, now)}`;
  if (alert.kind === 'cap') {
    const name = `💻 <b>${escapeHtml(alert.device)}</b>`;
    if (alert.level === 'hit') {
      const effect = alert.enforce ? '🔒 Claude Code is blocked on it until the window resets' : 'ℹ️ Warning only — it is not blocked';
      return `🚨 ${name} reached its ${window} cap of ${alert.limitPct}%\n${effect}\n${resets}`;
    }
    return `⚠️ ${name} is at <b>${pct(alert.pct)}</b> of its ${alert.limitPct}% ${window} cap\n${resets}`;
  }
  const what = `${escapeHtml(alert.source)} ${window}`;
  if (alert.level === 'hit') return `🚨 <b>${what} limit reached</b> (${pct(alert.pct)})\n${resets}`;
  return `⚠️ <b>${what}</b> is at <b>${pct(alert.pct)}</b>\n${resets}`;
}
