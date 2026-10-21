// Bot screens: text + keyboard for Usage, Devices, Alerts, Help and the usage-outside-Claude-Code question. Pure. Telegram has no icon set, so
// emojis are the icons here; every state is spelled out in words too (not emoji alone).
import { createHash } from 'node:crypto';
import { duration, escapeHtml, pct, resetsIn, usd } from './format.js';

const BAR_WIDTH = 10;
const CAP_BAR_WIDTH = 5;
const CAP_WARN_RATIO = 0.7;
const CAP_CRIT_RATIO = 0.9;
const WARN_PCT = 70;
const CRIT_PCT = 90;
const THRESHOLDS = [70, 80, 90];
const INDENT = '      ';
const PLAN_ROWS = [
  ['fiveHour', '⏱', '5-hour'],
  ['sevenDay', '📅', 'Weekly'],
];
const SHORT = Object.freeze({ fiveHour: '5h', sevenDay: 'weekly' });
const LABEL = Object.freeze({ fiveHour: '5h', sevenDay: 'Weekly' });
const OUTSIDE_TITLE = '🧭 <b>Usage outside Claude Code</b>';
export const OUTSIDE_SPLIT = 'x';
const BELL_ON = '🔔';
const BELL_OFF = '🔕';
const CHECK_ON = '✅';
const CHECK_OFF = '⬜';

export const MAIN_KEYBOARD = Object.freeze({
  keyboard: [
    [{ text: '📊 Usage' }, { text: '💻 Devices' }],
    [{ text: '🔔 Alerts' }, { text: '❓ Help' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Tap a button below',
});
const MENU = Object.freeze({ '📊 Usage': 'usage', '💻 Devices': 'devices', '🔔 Alerts': 'alerts', '❓ Help': 'help' });
const SLASH = Object.freeze({ start: 'start', usage: 'usage', status: 'usage', devices: 'devices', alerts: 'alerts', help: 'help', stop: 'stop' });

/** Keyboard button text or /command → action name ('help' for anything else). */
export function menuAction(text) {
  const t = String(text ?? '').trim();
  if (MENU[t]) return MENU[t];
  const command = /^\/(\w+)(?:@\w+)?/.exec(t)?.[1]?.toLowerCase();
  return SLASH[command] ?? 'help';
}

/** Short, stable id for a device name in callback data (Telegram allows 64 bytes). */
export const deviceKey = (name) => createHash('sha256').update(name).digest('base64url').slice(0, 12);

const inline = (rows) => ({ inline_keyboard: rows });
const button = (text, data) => ({ text, callback_data: data });

function bar(value) {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * BAR_WIDTH);
  const block = value >= CRIT_PCT ? '🟥' : value >= WARN_PCT ? '🟨' : '🟩';
  return block.repeat(filled) + '⬜'.repeat(BAR_WIDTH - filled);
}

const deviceNames = (summary) => (summary.devices ?? []).map((d) => d.name);
const rowFor = (summary, key, device) => (summary.windows?.[key] ?? []).find((r) => r.device === device);
const bell = (settings, device) => (settings.devices.includes(device) ? BELL_ON : BELL_OFF);

function planLines(account, now) {
  const rows = PLAN_ROWS.filter(([key]) => account?.[key]).flatMap(([key, icon, label]) => [
    `${icon} ${label}  ${bar(account[key].pct)} <b>${pct(account[key].pct)}</b>`,
    `${INDENT}↻ ${resetsIn(account[key].resetsAt, now)}`,
  ]);
  return rows.length ? ['📊 <b>Claude plan</b>', ...rows] : [];
}

/** A short bar of how much of its cap a device has used: 🟩 fine, 🟨 getting close, 🟥 at or near the cap. */
function capBar(share, cap) {
  const ratio = share / cap;
  const filled = Math.min(CAP_BAR_WIDTH, Math.round(ratio * CAP_BAR_WIDTH));
  const block = ratio >= CAP_CRIT_RATIO ? '🟥' : ratio >= CAP_WARN_RATIO ? '🟨' : '🟩';
  return block.repeat(filled) + '⬜'.repeat(CAP_BAR_WIDTH - filled);
}

function shareText(row) {
  if (row.limitPct == null) return `${pct(row.sharePct)} of plan · no cap`;
  const bar = capBar(row.sharePct, row.limitPct);
  if (row.overLimit) return `${bar} ⛔ ${pct(row.sharePct)} — over ${row.limitPct}% cap`;
  return `${bar} ${pct(row.sharePct)} of ${row.limitPct}% cap`;
}

/** One window of one device, e.g. "⏱ 5h  🟩🟩⬜⬜⬜ 9.0% of 50% cap · 🧭 2.0% outside Claude Code". */
function deviceWindowLine(row, icon, label) {
  if (!row) return null;
  const outside = row.outsidePct > 0 ? ` · 🧭 ${pct(row.outsidePct)} outside Claude Code` : '';
  return `${INDENT}${icon} ${label}  ${shareText(row)}${outside}`;
}

const deviceWindowLines = (summary, name) =>
  PLAN_ROWS.map(([key, icon]) => deviceWindowLine(rowFor(summary, key, name), icon, LABEL[key])).filter(Boolean);

/** Usage outside Claude Code nobody has been assigned yet, e.g. "5h 3.0% · weekly 1.0%", or ''. */
function unassignedText(outside) {
  return PLAN_ROWS.filter(([key]) => outside?.[key]?.unassignedPct > 0)
    .map(([key]) => `${SHORT[key]} ${pct(outside[key].unassignedPct)}`)
    .join(' · ');
}

function deviceUsageLines(summary, settings) {
  return deviceNames(summary).flatMap((name) => {
    const windows = deviceWindowLines(summary, name);
    return [`${bell(settings, name)} <b>${escapeHtml(name)}</b>`, ...(windows.length ? windows : [`${INDENT}💤 no Claude usage in these windows`])];
  });
}

function agentLines(agents) {
  return (agents ?? [])
    .filter((a) => a.devices.length)
    .flatMap((a) => {
      const plan = PLAN_ROWS.filter(([key]) => a.plan?.[key]).map(([key]) => `${SHORT[key]} ${pct(a.plan[key].pct)}`);
      return [
        '',
        `🤖 <b>${escapeHtml(a.label)}</b>${plan.length ? ` · ${plan.join(' · ')}` : ''}`,
        ...a.devices.map((d) => `${INDENT}${escapeHtml(d.device)} — today ${usd(d.today.costUSD)} · 7d ${usd(d.week.costUSD)}`),
      ];
    });
}

/** 📊 Usage: plan windows, every device (with its alert bell), other agents. */
export function usageView(summary, settings, now = Date.now()) {
  const unassigned = unassignedText(summary.outside);
  const plan = [...planLines(summary.account, now), ...(unassigned ? [`🧭 Outside Claude Code: ${unassigned} — <b>not assigned</b>`] : [])];
  const devices = deviceUsageLines(summary, settings);
  const agents = agentLines(summary.agents);
  const assign = unassigned ? [[button('🧭 Assign outside usage', 'o:ask')]] : [];
  const markup = inline([[button('🔄 Refresh', 'u:refresh'), button('💻 Device alerts', 'd:show')], ...assign]);
  if (!plan.length && !devices.length && !agents.length) {
    return { text: '📭 No devices have reported yet.\nInstall the plugin and use Claude Code on a device — it reports within a few minutes.', reply_markup: markup };
  }
  const text = [...plan, ...(devices.length ? ['', '💻 <b>Devices</b> · share of the plan', ...devices] : []), ...agents].join('\n').trim();
  return { text, reply_markup: markup };
}

function capsText(limits) {
  const caps = [limits?.fiveHour != null && `5h ${limits.fiveHour}%`, limits?.sevenDay != null && `weekly ${limits.sevenDay}%`].filter(Boolean);
  return caps.length ? caps.join(' · ') : null;
}

/** 💻 Devices: one bell button per device to turn its cap alerts on or off. */
export function devicesView(summary, settings, now = Date.now()) {
  const devices = summary.devices ?? [];
  const back = [button('⚙️ Alert settings', 'a:show')];
  if (!devices.length) return { text: '💻 No devices yet.\nInstall the plugin on a device first.', reply_markup: inline([back]) };
  const lines = devices.flatMap((d) => {
    const caps = capsText(d.limits);
    return [
      '',
      `${bell(settings, d.name)} <b>${escapeHtml(d.name)}</b> · synced ${duration(now - Date.parse(d.reportedAt))} ago`,
      caps ? `${INDENT}🎯 Caps: ${caps}` : `${INDENT}⚠️ No cap set — add one on the dashboard (Devices → Set cap)`,
      ...deviceWindowLines(summary, d.name),
    ];
  });
  const text = ['💻 <b>Devices</b>', `Tap a device to turn its alerts ${BELL_ON} on or ${BELL_OFF} off. You're told when it nears or reaches a cap.`, ...lines].join('\n');
  const rows = devices.map((d) => [button(`${bell(settings, d.name)} ${d.name}`, `d:${deviceKey(d.name)}`)]);
  return { text, reply_markup: inline([...rows, back]) };
}

const toggle = (on, label) => `${on ? CHECK_ON : CHECK_OFF} ${label}`;

/** 🔔 Alerts: on/off, which alerts, near-limit threshold, link to device alerts. */
export function alertsView(settings, summary) {
  const names = deviceNames(summary);
  const subscribed = names.filter((n) => settings.devices.includes(n));
  const devicesLine = subscribed.length
    ? `💻 Devices: ${subscribed.map(escapeHtml).join(', ')} (${subscribed.length} of ${names.length})`
    : '💻 Devices: none yet — tap 💻 Device alerts to pick some';
  const text = [
    settings.enabled ? `${BELL_ON} <b>Alerts are on</b>` : `${BELL_OFF} <b>Alerts are off</b>`,
    'Checked whenever a device reports · each alert once per window.',
    '',
    `${toggle(settings.near, 'Near the limit')} — at ${settings.nearPct}%`,
    toggle(settings.hit, 'Limit reached'),
    toggle(settings.agents, 'Codex & other agents'),
    devicesLine,
  ].join('\n');
  const rows = [
    [button(settings.enabled ? `${CHECK_ON} Alerts on` : `${BELL_OFF} Alerts off`, 'a:enabled')],
    [button(toggle(settings.near, 'Near limit'), 'a:near'), button(toggle(settings.hit, 'Limit reached'), 'a:hit')],
    THRESHOLDS.map((p) => button(p === settings.nearPct ? `• ${p}% •` : `${p}%`, `a:p${p}`)),
    [button(toggle(settings.agents, 'Codex & other agents'), 'a:agents')],
    [button('💻 Device alerts', 'd:show')],
  ];
  return { text, reply_markup: inline(rows) };
}

/** ❓ Help, with the main keyboard. */
export function helpView() {
  const text = [
    '👋 <b>Claude Usage Tracker</b>',
    'Use the buttons below:',
    '📊 Usage — plan windows and every device',
    '💻 Devices — choose which devices send alerts',
    '🔔 Alerts — when to notify you',
    '❓ Help — this message',
    '🧭 Used Claude Desktop, claude.ai or the Chrome extension? The bot asks which device it was, so caps stay right.',
    '',
    'Send /stop to unlink this chat.',
  ].join('\n');
  return { text, reply_markup: MAIN_KEYBOARD };
}

const outsideAmounts = (windows) =>
  PLAN_ROWS.filter(([key]) => windows?.[key]?.pct > 0)
    .map(([key, icon]) => `${icon} ${LABEL[key]} +${pct(windows[key].pct)}`)
    .join(' · ');

/**
 * 🧭 Usage outside Claude Code: asks whose it was (one button per device), shows the chosen device, or —
 * with `outcome` 'split' or 'expired' — closes the question.
 */
export function outsideView(event, deviceNames, outcome = null) {
  if (!event || outcome === 'expired') return { text: `${OUTSIDE_TITLE}\n⌛ Already answered, or its window has reset.` };
  const amounts = outsideAmounts(event.windows);
  if (outcome === 'split') return { text: [OUTSIDE_TITLE, amounts, '🙈 Split across devices by their Claude Code usage.'].join('\n') };
  const lines = event.device
    ? [OUTSIDE_TITLE, amounts, `✅ Counted for <b>${escapeHtml(event.device)}</b>. Tap another device to change.`]
    : [
        OUTSIDE_TITLE,
        "Your plan went up more than your devices' Claude Code explains — likely Claude Desktop, claude.ai or the Chrome extension.",
        amounts,
        '',
        "👉 <b>Whose was it?</b> It then counts toward that device's share and caps.",
      ];
  const rows = deviceNames.map((name) => [button(`${name === event.device ? CHECK_ON : '💻'} ${name}`, `o:${event.id}:${deviceKey(name)}`)]);
  return { text: lines.join('\n'), reply_markup: inline([...rows, [button('🙈 Not sure — split by usage', `o:${event.id}:${OUTSIDE_SPLIT}`)]]) };
}
