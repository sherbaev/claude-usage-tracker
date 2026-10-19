// Server responses end up in the terminal and in Claude's context (slash command output), so treat
// them as untrusted: keep only known fields with valid values, strip control characters, truncate text.
import { WINDOWS, isValidDeviceName } from './core.js';
import { AGENT_RE } from './agent-rows.js';
import { MAX_MODEL_ROWS } from './model-rows.js';

const MAX_TEXT = 200;
const MAX_LABEL = 80;
const MAX_MODEL_ROWS_SHOWN = MAX_MODEL_ROWS + 1;
// C0/C1 control characters, including ESC (ANSI sequences).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export const cleanText = (value, max = MAX_TEXT) => String(value ?? '').replace(CONTROL_CHARS, ' ').slice(0, max);

function cleanModelRow(row) {
  const sharePct = finite(row?.sharePct);
  const costUSD = finite(row?.costUSD);
  const tokens = finite(row?.tokens);
  if (typeof row?.label !== 'string' || sharePct === null || costUSD === null || tokens === null) return null;
  return { label: cleanText(row.label, MAX_LABEL), sharePct, costUSD, tokens };
}

const cleanModelRows = (rows) => (Array.isArray(rows) ? rows.slice(0, MAX_MODEL_ROWS_SHOWN).map(cleanModelRow).filter(Boolean) : []);

function cleanRow(row) {
  if (!isValidDeviceName(row?.device)) return null;
  const sharePct = finite(row.sharePct);
  const costUSD = finite(row.costUSD);
  const tokens = finite(row.tokens);
  const reportedAt = isoOrNull(row.reportedAt);
  if (sharePct === null || costUSD === null || tokens === null || reportedAt === null) return null;
  return {
    device: row.device,
    reportedAt,
    sharePct,
    costUSD,
    tokens,
    limitPct: finite(row.limitPct),
    overLimit: row.overLimit === true,
    models: cleanModelRows(row.models),
  };
}

function cleanAccountWindow(win) {
  const pct = finite(win?.pct);
  const resetsAt = isoOrNull(win?.resetsAt);
  return pct !== null && resetsAt ? { pct, resetsAt } : null;
}

const cleanTotals = (t) => {
  const costUSD = finite(t?.costUSD);
  const tokens = finite(t?.tokens);
  return costUSD === null || tokens === null ? null : { costUSD, tokens };
};

// Agent model rows have no plan share: label, cost and tokens only.
function cleanAgentModelRow(row) {
  const costUSD = finite(row?.costUSD);
  const tokens = finite(row?.tokens);
  if (typeof row?.label !== 'string' || costUSD === null || tokens === null) return null;
  return { label: cleanText(row.label, MAX_LABEL), costUSD, tokens };
}

const cleanAgentModelRows = (rows) => (Array.isArray(rows) ? rows.slice(0, MAX_MODEL_ROWS_SHOWN).map(cleanAgentModelRow).filter(Boolean) : []);

function cleanAgentDevice(d) {
  const reportedAt = isoOrNull(d?.reportedAt);
  const week = cleanTotals(d?.week);
  if (!isValidDeviceName(d?.device) || !reportedAt || !week) return null;
  return { device: d.device, reportedAt, today: cleanTotals(d.today) ?? { costUSD: 0, tokens: 0 }, week, models: cleanAgentModelRows(d.models) };
}

function cleanAgentSummary(agent) {
  if (typeof agent?.id !== 'string' || !AGENT_RE.test(agent.id)) return null;
  const plan = agent.plan ? { fiveHour: cleanAccountWindow(agent.plan.fiveHour), sevenDay: cleanAccountWindow(agent.plan.sevenDay) } : null;
  return {
    id: agent.id,
    label: cleanText(agent.label ?? agent.id, MAX_LABEL),
    plan: plan && (plan.fiveHour || plan.sevenDay) ? plan : null,
    planObservedAt: isoOrNull(agent.planObservedAt),
    devices: Array.isArray(agent.devices) ? agent.devices.map(cleanAgentDevice).filter(Boolean) : [],
  };
}

const MAX_AGENTS_SHOWN = 24;
const cleanAgentList = (agents) => (Array.isArray(agents) ? agents.slice(0, MAX_AGENTS_SHOWN).map(cleanAgentSummary).filter(Boolean) : []);

const cleanLimits = (limits) => ({
  fiveHour: finite(limits?.fiveHour),
  sevenDay: finite(limits?.sevenDay),
  enforce: limits?.enforce === true,
});

/** @returns {{ account: object|null, windows: Record<string, object[]>, devices: object[] }} */
export function sanitizeSummary(data) {
  const keys = Object.keys(WINDOWS);
  const windows = Object.fromEntries(
    keys.map((k) => [k, Array.isArray(data?.windows?.[k]) ? data.windows[k].map(cleanRow).filter(Boolean) : []]),
  );
  const account = data?.account ? Object.fromEntries(keys.map((k) => [k, cleanAccountWindow(data.account[k])])) : null;
  const devices = sanitizeDeviceList(data?.devices).map((d) => ({
    ...d,
    limits: cleanLimits(data.devices.find((raw) => raw?.name === d.name)?.limits),
  }));
  return { account, windows, devices, agents: cleanAgentList(data?.agents) };
}

/** Device list from GET /api/me: valid names with a valid timestamp only. */
export function sanitizeDeviceList(devices) {
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((d) => isValidDeviceName(d?.name) && isoOrNull(d?.reportedAt))
    .map((d) => ({ name: d.name, reportedAt: isoOrNull(d.reportedAt) }));
}

/** The per-device status returned by POST /api/report, cached for the enforcement hook. */
export function sanitizeStatus(status) {
  const windows = Object.fromEntries(
    Object.keys(WINDOWS).map((k) => {
      const w = status?.windows?.[k];
      const sharePct = finite(w?.sharePct);
      if (!w || sharePct === null) return [k, null];
      return [k, { sharePct, limitPct: finite(w.limitPct), overLimit: w.overLimit === true, resetsAt: isoOrNull(w.resetsAt) }];
    }),
  );
  return { enforce: status?.enforce === true, windows };
}
