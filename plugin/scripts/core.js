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

const sameWindow = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_TOLERANCE_MS;

/**
 * Splits the account-wide utilization across devices proportionally to each
 * device's local cost inside the same window. Uses the freshest account snapshot.
 */
export function computeShares(reports) {
  const fresh = [...reports].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  if (!fresh.length) return { account: null, windows: {} };
  // Per window, the freshest report that has Claude data (a device may report only other agents).
  const account = Object.fromEntries(Object.keys(WINDOWS).map((key) => [key, fresh.find((r) => r.account?.[key])?.account[key] ?? null]));

  const windows = Object.fromEntries(
    Object.keys(WINDOWS).map((key) => {
      const accountWin = account[key];
      if (!accountWin) return [key, []];
      const inWindow = fresh.filter(
        (r) => r.account?.[key] && r.local?.[key] && sameWindow(r.account[key].resetsAt, accountWin.resetsAt),
      );
      const totalCost = inWindow.reduce((sum, r) => sum + r.local[key].costUSD, 0);
      const rows = inWindow.map((r) => {
        const sharePct = totalCost > 0 ? (accountWin.pct * r.local[key].costUSD) / totalCost : 0;
        return {
          device: r.device,
          reportedAt: r.reportedAt,
          costUSD: r.local[key].costUSD,
          tokens: r.local[key].tokens,
          sharePct,
          models: modelShares(r.local[key].models, sharePct),
        };
      });
      return [key, rows.sort((a, b) => b.costUSD - a.costUSD)];
    }),
  );
  return { account, windows };
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
  };
}
