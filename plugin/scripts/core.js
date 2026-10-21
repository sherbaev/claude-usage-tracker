// Pure logic shared by the CLI and the server. No I/O here.
import { cleanAgents } from './agent-rows.js';
import { cleanModels, modelShares } from './model-rows.js';

export const HOUR_MS = 60 * 60 * 1000;
export const WINDOWS = Object.freeze({
  fiveHour: Object.freeze({ label: '5h', apiKey: 'five_hour', lengthMs: 5 * HOUR_MS }),
  sevenDay: Object.freeze({ label: 'Weekly', apiKey: 'seven_day', lengthMs: 7 * 24 * HOUR_MS }),
});
// Reports whose window reset time differs by more than this belong to another window.
const SAME_WINDOW_TOLERANCE_MS = 2 * 60 * 1000;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function parseWindow(raw, name) {
  if (raw == null) return null;
  const resetsAtMs = Date.parse(raw.resets_at);
  if (!isFiniteNumber(raw.utilization) || Number.isNaN(resetsAtMs)) {
    throw new Error(`Unexpected "${name}" shape in Anthropic usage response`);
  }
  return { pct: raw.utilization, resetsAt: new Date(resetsAtMs).toISOString() };
}

/** Normalizes the /api/oauth/usage response into { fiveHour, sevenDay }. */
export function parseAccountUsage(json) {
  if (json == null || typeof json !== 'object') {
    throw new Error('Anthropic usage response is not an object');
  }
  return Object.fromEntries(
    Object.entries(WINDOWS).map(([key, { apiKey }]) => [key, parseWindow(json[apiKey], apiKey)]),
  );
}

/** Sums ccusage blocks that overlap [startMs, endMs). */
export function sumBlocksInRange(blocks, startMs, endMs) {
  return blocks
    .filter((b) => !b.isGap)
    .filter((b) => Date.parse(b.endTime) > startMs && Date.parse(b.startTime) < endMs)
    .reduce(
      (acc, b) => ({ costUSD: acc.costUSD + (b.costUSD ?? 0), tokens: acc.tokens + (b.totalTokens ?? 0) }),
      { costUSD: 0, tokens: 0 },
    );
}

/** Local cost/tokens for every account window, aligned to Anthropic's reset times. */
export function localWindowTotals(blocks, account) {
  return Object.fromEntries(
    Object.entries(WINDOWS).map(([key, { lengthMs }]) => {
      const win = account[key];
      if (!win) return [key, null];
      const endMs = Date.parse(win.resetsAt);
      return [key, sumBlocksInRange(blocks, endMs - lengthMs, endMs)];
    }),
  );
}

export const sameWindow = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_TOLERANCE_MS;

/**
 * Per window: the freshest account snapshot (from a report that has Claude data — a device may report
 * only other agents) and the reports with local usage in that same window.
 */
export function windowPools(reports) {
  const fresh = [...reports].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  const account = Object.fromEntries(Object.keys(WINDOWS).map((key) => [key, fresh.find((r) => r.account?.[key])?.account[key] ?? null]));
  const inWindow = Object.fromEntries(
    Object.keys(WINDOWS).map((key) => [
      key,
      account[key] ? fresh.filter((r) => r.account?.[key] && r.local?.[key] && sameWindow(r.account[key].resetsAt, account[key].resetsAt)) : [],
    ]),
  );
  return { account, inWindow };
}

/**
 * Usage outside Claude Code (Claude Desktop, claude.ai, the Chrome extension) in one window: the % the
 * user assigned to each known device, and the % nobody has been assigned yet.
 */
function outsideUsage(events, key, accountWin, knownDevices) {
  const inThisWindow = events.filter((e) => e.windows?.[key] && sameWindow(e.windows[key].resetsAt, accountWin.resetsAt));
  // "Not sure" usage is treated as Claude Code: shared by cost.
  const splitPct = inThisWindow.filter((e) => e.split).reduce((sum, e) => sum + e.windows[key].pct, 0);
  return inThisWindow
    .filter((e) => !e.split && (!e.device || knownDevices.has(e.device)))
    .reduce(
      (acc, e) =>
        e.device
          ? { ...acc, assigned: { ...acc.assigned, [e.device]: (acc.assigned[e.device] ?? 0) + e.windows[key].pct } }
          : { ...acc, unassignedPct: acc.unassignedPct + e.windows[key].pct },
      { assigned: {}, unassignedPct: 0, splitPct },
    );
}

/**
 * The % Claude Code explains per dollar. With a learned `rate`, each device gets rate × its own cost, so a
 * device that stopped working keeps its share and plan % beyond that (usage outside Claude Code nobody has
 * placed yet) is returned as `residualPct`. Without one, or when the rate explains more than the plan shows,
 * the Claude Code % is split by cost.
 */
function codeSplit(codePct, totalCost, rate, splitPct) {
  const expected = rate > 0 && totalCost > 0 ? rate * totalCost + splitPct : null;
  if (expected === null || expected >= codePct) return { perDollar: totalCost > 0 ? codePct / totalCost : 0, residualPct: 0 };
  return { perDollar: expected / totalCost, residualPct: codePct - expected };
}

function windowRows(key, accountWin, inWindow, outside, reportedAt, rate) {
  const assignedTotal = Object.values(outside.assigned).reduce((sum, pct) => sum + pct, 0);
  const codePct = Math.max(0, accountWin.pct - assignedTotal - outside.unassignedPct);
  const totalCost = inWindow.reduce((sum, r) => sum + r.local[key].costUSD, 0);
  const { perDollar, residualPct } = codeSplit(codePct, totalCost, rate, outside.splitPct ?? 0);
  const rows = inWindow.map((r) => {
    const fromCode = perDollar * r.local[key].costUSD;
    const outsidePct = outside.assigned[r.device] ?? 0;
    return {
      device: r.device,
      reportedAt: r.reportedAt,
      costUSD: r.local[key].costUSD,
      tokens: r.local[key].tokens,
      sharePct: fromCode + outsidePct,
      outsidePct,
      models: modelShares(r.local[key].models, fromCode),
    };
  });
  const outsideOnly = Object.entries(outside.assigned)
    .filter(([device]) => !inWindow.some((r) => r.device === device))
    .map(([device, pct]) => ({ device, reportedAt: reportedAt.get(device), costUSD: 0, tokens: 0, sharePct: pct, outsidePct: pct, models: [] }));
  return { rows: [...rows, ...outsideOnly].sort((a, b) => b.costUSD - a.costUSD), residualPct };
}

/**
 * Splits the account-wide utilization across devices by each device's local cost inside the same window,
 * using the freshest account snapshot. Usage outside Claude Code (`outsideEvents`) is added to the device
 * it was assigned to; unassigned usage, and with a learned `rates[window]` (% per dollar) any % Claude Code
 * cost does not explain, is held apart as `outside[window].unassignedPct`.
 */
export function computeShares(reports, outsideEvents = [], rates = {}) {
  if (!reports.length) return { account: null, windows: {} };
  const { account, inWindow } = windowPools(reports);
  const reportedAt = new Map(reports.map((r) => [r.device, r.reportedAt]));
  const keys = Object.keys(WINDOWS);
  const outside = Object.fromEntries(
    keys.map((key) => [key, account[key] ? outsideUsage(outsideEvents, key, account[key], reportedAt) : { assigned: {}, unassignedPct: 0, splitPct: 0 }]),
  );
  const split = Object.fromEntries(
    keys.map((key) => [key, account[key] ? windowRows(key, account[key], inWindow[key], outside[key], reportedAt, rates[key]) : { rows: [], residualPct: 0 }]),
  );
  return {
    account,
    windows: Object.fromEntries(keys.map((key) => [key, split[key].rows])),
    outside: Object.fromEntries(keys.map((key) => [key, { unassignedPct: outside[key].unassignedPct + split[key].residualPct }])),
  };
}

const DEVICE_RE = /^[\w.\- ]{1,64}$/;

export const isValidDeviceName = (name) => typeof name === 'string' && DEVICE_RE.test(name);

// Upper bounds keep sums finite (Infinity serializes as null and breaks dashboards).
const MAX_PCT = 1000;
const MAX_COST_USD = 1e7;
const MAX_TOKENS = 1e13;

export const inRange = (value, max) => isFiniteNumber(value) && value >= 0 && value <= max;

function cleanAccountWindow(acc) {
  return acc && inRange(acc.pct, MAX_PCT) && !Number.isNaN(Date.parse(acc.resetsAt))
    ? { pct: acc.pct, resetsAt: new Date(acc.resetsAt).toISOString() }
    : null;
}

function cleanLocalWindow(loc) {
  return loc && inRange(loc.costUSD, MAX_COST_USD) && inRange(loc.tokens, MAX_TOKENS)
    ? { costUSD: loc.costUSD, tokens: loc.tokens, models: cleanModels(loc.models) }
    : null;
}

// When Claude Desktop, claude.ai or the Claude Chrome extension last wrote its local storage on the device.
export const SURFACES = Object.freeze(['desktop', 'web', 'extension']);
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function cleanSurfaces(surfaces, reportedAt) {
  const latest = Date.parse(reportedAt) + CLOCK_SKEW_MS;
  return Object.fromEntries(
    SURFACES.map((name) => {
      const at = Date.parse(surfaces?.[name]);
      return [name, Number.isNaN(at) || at > latest ? null : new Date(at).toISOString()];
    }),
  );
}

/** Validates an incoming device report (server boundary). Returns a clean copy. */
export function validateReport(body) {
  if (body == null || typeof body !== 'object') throw new Error('body must be an object');
  if (!isValidDeviceName(body.device)) {
    throw new Error('device must be 1-64 chars of [A-Za-z0-9_. -]');
  }
  if (Number.isNaN(Date.parse(body.reportedAt))) throw new Error('reportedAt must be an ISO date');

  const keys = Object.keys(WINDOWS);
  return {
    device: body.device,
    reportedAt: new Date(body.reportedAt).toISOString(),
    account: Object.fromEntries(keys.map((k) => [k, cleanAccountWindow(body.account?.[k])])),
    local: Object.fromEntries(keys.map((k) => [k, cleanLocalWindow(body.local?.[k])])),
    agents: cleanAgents(body.agents),
    surfaces: cleanSurfaces(body.surfaces, body.reportedAt),
  };
}
