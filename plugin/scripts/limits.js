// Per-device usage caps: the max share (% of the account's plan limit) a device may use per window.
// Pure; shared by the server (applies caps) and the client (enforcement hook reads cached status).
import { WINDOWS, inRange } from './core.js';

const MAX_LIMIT_PCT = 100;
export const NO_LIMITS = Object.freeze({ fiveHour: null, sevenDay: null, enforce: false });

function cleanLimit(value, key) {
  if (value === null || value === undefined || value === '') return null;
  if (!inRange(value, MAX_LIMIT_PCT) || value === 0) throw new Error(`${key} must be a number between 0 and 100, or null`);
  return value;
}

/** Validates a limits update from the website (server boundary). */
export function validateLimits(body) {
  if (body == null || typeof body !== 'object') throw new Error('body must be an object');
  if (body.enforce !== undefined && typeof body.enforce !== 'boolean') throw new Error('enforce must be a boolean');
  return {
    fiveHour: cleanLimit(body.fiveHour, 'fiveHour'),
    sevenDay: cleanLimit(body.sevenDay, 'sevenDay'),
    enforce: body.enforce === true,
  };
}

/** Adds limitPct/overLimit to every per-device window row. */
export function applyLimits(shares, limitsByDevice) {
  const windows = Object.fromEntries(
    Object.entries(shares.windows).map(([key, rows]) => [
      key,
      rows.map((row) => {
        const limitPct = limitsByDevice[row.device]?.[key] ?? null;
        return { ...row, limitPct, overLimit: limitPct !== null && row.sharePct >= limitPct };
      }),
    ]),
  );
  return { ...shares, windows };
}

/** One device's view of a limited summary, cached by the client for the enforcement hook. */
export function deviceStatus(limitedShares, device, limits = NO_LIMITS) {
  const windows = Object.fromEntries(
    Object.keys(WINDOWS).map((key) => {
      const row = (limitedShares.windows[key] ?? []).find((r) => r.device === device);
      const resetsAt = limitedShares.account?.[key]?.resetsAt ?? null;
      return [key, row ? { sharePct: row.sharePct, limitPct: row.limitPct, overLimit: row.overLimit, resetsAt } : null];
    }),
  );
  return { enforce: limits.enforce, windows };
}

/** Windows (still open at `now`) in which a cached device status is over its cap. */
export function activeViolations(status, now = Date.now()) {
  if (!status?.windows) return [];
  return Object.entries(status.windows)
    .filter(([, w]) => w?.overLimit && w.resetsAt && Date.parse(w.resetsAt) > now)
    .map(([key, w]) => ({ window: WINDOWS[key]?.label ?? key, ...w }));
}
