// Usage outside Claude Code (Claude Desktop, claude.ai, the Chrome extension) never shows up in a device's
// local logs: the plan % rises while no device's Claude Code cost does. Each report is compared with a
// per-window baseline; such a rise becomes an event the user assigns to a device from the Telegram bot.
// Pure: the caller stores the returned `state`.
import { randomBytes } from 'node:crypto';
import { sameWindow, WINDOWS, windowPools } from '../../plugin/scripts/core.js';

// Smaller rises keep adding up instead of becoming a question. The 5h % climbs faster than the weekly one.
const MIN_OUTSIDE_PCT = Object.freeze({ fiveHour: 2, sevenDay: 1 });
// Claude Code cost changes below this are rounding, not activity.
const COST_EPSILON_USD = 0.01;
// Devices report at most every 5 minutes, so a device's Claude Code cost can lag the plan % by that much.
// A rise is only asked about once it has gone unexplained for longer than that.
export const SETTLE_MS = 6 * 60 * 1000;
const MAX_EVENTS = 20;

export const EMPTY_OUTSIDE = Object.freeze({ baseline: Object.freeze({}), events: Object.freeze([]) });

const randomId = () => randomBytes(4).toString('hex');
const isLive = (event, now) => Object.values(event.windows).some((w) => w && Date.parse(w.resetsAt) > now);

/**
 * One window against its baseline. `rise` is plan % gained with no Claude Code cost behind it. A quiet
 * rise keeps the old baseline (noting when it began), so small rises add up and a lagging device can still
 * explain it; any Claude Code activity moves the baseline.
 */
function scanWindow(base, current, cost, now, settleMs) {
  const snapshot = { resetsAt: current.resetsAt, pct: current.pct, cost };
  const unchanged = { base, snapshot: base, rise: 0, isSettled: false };
  if (!base) return { base: snapshot, snapshot, rise: 0, isSettled: false };
  const isSame = sameWindow(base.resetsAt, current.resetsAt);
  // An older window, or a lower % in the same one: an out-of-order snapshot, not news.
  if (isSame ? current.pct < base.pct : Date.parse(current.resetsAt) < Date.parse(base.resetsAt)) return unchanged;
  const from = isSame ? base : { resetsAt: current.resetsAt, pct: 0, cost: 0 }; // a new window starts at zero
  const rise = current.pct - from.pct;
  const isQuiet = Math.abs(cost - from.cost) < COST_EPSILON_USD;
  if (!isQuiet || rise <= 0) return { base: snapshot, snapshot, rise: 0, isSettled: false };
  const risingSince = from.risingSince ?? now;
  return { base: { ...from, risingSince }, snapshot, rise, isSettled: now - risingSince >= settleMs };
}

/** Adds to the latest unanswered event when it covers the same windows, else starts a new one. */
function addEvent(events, windows, detectedAt, newId) {
  const pending = events.at(-1);
  const canMerge =
    pending && !pending.device && Object.entries(windows).every(([key, w]) => !pending.windows[key] || sameWindow(pending.windows[key].resetsAt, w.resetsAt));
  if (canMerge) {
    const added = Object.fromEntries(Object.entries(windows).map(([key, w]) => [key, { pct: (pending.windows[key]?.pct ?? 0) + w.pct, resetsAt: w.resetsAt }]));
    const merged = { ...pending, detectedAt, windows: { ...pending.windows, ...added } };
    return { events: [...events.slice(0, -1), merged], event: merged, isNew: false };
  }
  const event = { id: newId(), device: null, detectedAt, windows };
  return { events: [...events, event].slice(-MAX_EVENTS), event, isNew: true };
}

/**
 * Compares the account's latest reports with the stored baseline.
 * @returns {{ state: object, event: object|null, isNew: boolean }} `event`: new (`isNew`) or grown usage outside Claude Code
 */
export function detectOutside(state, reports, { now = Date.now(), newId = randomId, settleMs = SETTLE_MS } = {}) {
  const { account, inWindow } = windowPools(reports);
  const costIn = (key) => inWindow[key].reduce((sum, r) => sum + r.local[key].costUSD, 0);
  const scans = Object.fromEntries(
    Object.keys(WINDOWS)
      .filter((key) => account[key])
      .map((key) => [key, scanWindow(state.baseline[key], account[key], costIn(key), now, settleMs)]),
  );
  const isAsking = Object.entries(scans).some(([key, s]) => s.isSettled && s.rise >= MIN_OUTSIDE_PCT[key]);
  const baseline = {
    ...state.baseline,
    ...Object.fromEntries(Object.entries(scans).map(([key, s]) => [key, isAsking && s.rise > 0 ? s.snapshot : s.base])),
  };
  const events = state.events.filter((e) => isLive(e, now));
  if (!isAsking) return { state: { baseline, events }, event: null, isNew: false };
  const windows = Object.fromEntries(
    Object.entries(scans)
      .filter(([, s]) => s.rise > 0)
      .map(([key, s]) => [key, { pct: s.rise, resetsAt: account[key].resetsAt }]),
  );
  const added = addEvent(events, windows, new Date(now).toISOString(), newId);
  return { state: { baseline, events: added.events }, event: added.event, isNew: added.isNew };
}

/** Unanswered events whose windows have not all reset, oldest first. */
export const pendingEvents = (state, now = Date.now()) => state.events.filter((e) => !e.device && isLive(e, now));

/** @returns {{ state: object, event: object }|null} null when the event is gone */
export function assignEvent(state, id, device) {
  const found = state.events.find((e) => e.id === id);
  if (!found) return null;
  const event = { ...found, device };
  return { state: { ...state, events: state.events.map((e) => (e.id === id ? event : e)) }, event };
}

/** "Not sure": drop the event so its % is split across devices by their Claude Code usage. */
export function ignoreEvent(state, id) {
  if (!state.events.some((e) => e.id === id)) return null;
  return { ...state, events: state.events.filter((e) => e.id !== id) };
}
