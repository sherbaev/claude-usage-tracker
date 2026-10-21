// Usage outside Claude Code (Claude Desktop, claude.ai, the Chrome extension) never shows up in a device's
// local logs, only in the account's plan %. Once finished windows have taught us how much plan % a dollar of
// Claude Code uses, any % that the devices' Claude Code cost does not explain is outside usage — even while
// Claude Code is running. Before that, only a rise with no Claude Code cost at all counts. Each finding
// becomes an event: when reports show Claude Desktop, claude.ai or the Claude extension was just used on exactly
// one device, it is put on that device; otherwise the Telegram bot asks. Pure: the caller stores `state`.
import { randomBytes } from 'node:crypto';
import { sameWindow, WINDOWS, windowPools } from '../../plugin/scripts/core.js';

// Smaller amounts keep adding up instead of becoming a question. The 5h % climbs faster than the weekly one.
const MIN_OUTSIDE_PCT = Object.freeze({ fiveHour: 2, sevenDay: 1 });
// Claude Code cost changes below this are rounding, not activity.
const COST_EPSILON_USD = 0.01;
// Devices report at most every 5 minutes, so a device's Claude Code cost can lag the plan % by that much.
// Usage is only asked about once it has gone unexplained for longer than that.
export const SETTLE_MS = 6 * 60 * 1000;
// Enough for a week of questions: events are needed until their weekly window has been learned from.
const MAX_EVENTS = 100;
// Learning the rate: finished windows (5h windows, and the weekly % gained during each) with enough usage.
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 12;
const MIN_SAMPLE_COST_USD = 2;
const MIN_SAMPLE_PCT = 1;
// A window that used far more % per dollar than usual had outside usage in it: left out of the rate. The
// weekly % gained in one 5h window is small, so whole-point rounding alone can double it: allow more there.
const OUTLIER_FACTOR = Object.freeze({ fiveHour: 2, sevenDay: 3 });
// The rate is an estimate: unexplained % below this share of the expected % is treated as noise.
const RATE_TOLERANCE = 0.2;
// Until two windows have finished: the lowest % per dollar seen in recent windows. Outside usage only ever
// raises the ratio, so the lowest one is the cleanest. Whole-point rounding makes small % too coarse.
const MIN_LOW_PCT = 5;
const MIN_LOW_COST_USD = 5;
const MAX_LOWS = 6;
// Activity in Claude Desktop / claude.ai / the extension this long before the rise began still counts.
const ACTIVITY_LOOKBACK_MS = 60 * 60 * 1000;
// Backfill ignores leftovers smaller than this (rounding).
const MIN_CLAIM_PCT = 0.05;

export const EMPTY_OUTSIDE = Object.freeze({
  baseline: Object.freeze({}),
  events: Object.freeze([]),
  last: Object.freeze({}),
  segment: null,
  samples: Object.freeze({ fiveHour: Object.freeze([]), sevenDay: Object.freeze([]) }),
  lows: Object.freeze({ fiveHour: Object.freeze([]), sevenDay: Object.freeze([]) }),
  since: Object.freeze({}),
});

const randomId = () => randomBytes(4).toString('hex');
const isLive = (event, now) => Object.values(event.windows).some((w) => w && Date.parse(w.resetsAt) > now);
const isLater = (a, b) => !sameWindow(a.resetsAt, b.resetsAt) && Date.parse(a.resetsAt) > Date.parse(b.resetsAt);
const sum = (values) => values.reduce((total, v) => total + v, 0);
const inWindow = (e, key, resetsAt) => e.windows[key] && sameWindow(e.windows[key].resetsAt, resetsAt);
/** Outside usage already found in one window (answered or not), so it is not asked about twice. */
const knownPct = (events, key, resetsAt) => sum(events.filter((e) => inWindow(e, key, resetsAt)).map((e) => e.windows[key].pct));
/** Outside usage the user put on a device. "Not sure" and unanswered usage may well be Claude Code. */
const isConfirmed = (e) => Boolean(e.device);
/** An event is kept while its window is live or has not yet been learned from. */
const isKept = (e, last, now) => isLive(e, now) || Object.entries(e.windows).some(([key, w]) => w && last[key] && !isLater(last[key], w));

// ---------- learning the rate ----------

/** Plan % per dollar: pooled over recent samples, leaving out windows with outside usage in them. */
function rateOf(samples = [], outlierFactor) {
  if (samples.length < MIN_SAMPLES) return null;
  const ratios = samples.map((s) => s.pct / s.cost).sort((a, b) => a - b);
  const median = ratios[Math.floor((ratios.length - 1) / 2)];
  const kept = samples.filter((s) => s.pct / s.cost <= median * outlierFactor);
  return sum(kept.map((s) => s.pct)) / sum(kept.map((s) => s.cost));
}

/** Median of the lowest % per dollar seen in each recent window, or null. */
function provisionalRate(lows = []) {
  if (!lows.length) return null;
  const ratios = lows.map((l) => l.ratio).sort((a, b) => a - b);
  return ratios[Math.floor((ratios.length - 1) / 2)];
}

/**
 * Plan % per dollar of Claude Code: the lower of the learned and the lowest-seen rate (outside usage only
 * ever raises a rate, so the lower one is the cleaner), or null before either exists.
 * @returns {{ fiveHour: number|null, sevenDay: number|null }}
 */
export function planRates(state) {
  return Object.fromEntries(
    Object.keys(WINDOWS).map((key) => {
      const rates = [rateOf(state.samples?.[key], OUTLIER_FACTOR[key]), provisionalRate(state.lows?.[key])].filter((r) => r !== null);
      return [key, rates.length ? Math.min(...rates) : null];
    }),
  );
}

/** Keeps the lowest % per dollar of each window (last few windows). */
function updateLows(lows = [], snap) {
  if (!snap || snap.pct < MIN_LOW_PCT || snap.cost < MIN_LOW_COST_USD) return lows;
  const ratio = snap.pct / snap.cost;
  const current = lows.at(-1);
  if (current && sameWindow(current.resetsAt, snap.resetsAt)) return [...lows.slice(0, -1), { ...current, ratio: Math.min(current.ratio, ratio) }];
  return [...lows, { resetsAt: snap.resetsAt, ratio }].slice(-MAX_LOWS);
}

/** When a 5h window ends: its Claude Code %/$ and the weekly %/$ gained during it, minus outside usage found. */
function finishedSamples(state, current5) {
  const prev5 = state.last.fiveHour;
  if (!prev5 || !current5 || !isLater(current5, prev5)) return {};
  const confirmed = state.events.filter(isConfirmed);
  const fiveHour = { pct: prev5.pct - knownPct(confirmed, 'fiveHour', prev5.resetsAt), cost: prev5.cost };
  const { segment } = state;
  const prevW = state.last.sevenDay;
  // A device that joined the weekly window during this 5h window brought its earlier weekly cost along.
  const isWholeSegment =
    segment && !segment.isMixed && prevW && sameWindow(segment.fiveResetsAt, prev5.resetsAt) && sameWindow(segment.weekResetsAt, prevW.resetsAt);
  const inSegment = confirmed.filter((e) => inWindow(e, 'fiveHour', prev5.resetsAt));
  const sevenDay = isWholeSegment
    ? { pct: prevW.pct - segment.weekPct - sum(inSegment.map((e) => e.windows.sevenDay?.pct ?? 0)), cost: prevW.cost - segment.weekCost }
    : null;
  return Object.fromEntries(
    Object.entries({ fiveHour, sevenDay }).filter(([, s]) => s && s.cost >= MIN_SAMPLE_COST_USD && s.pct >= MIN_SAMPLE_PCT),
  );
}

/** Latest snapshot per window (ignoring out-of-order ones), the weekly position when this 5h window began, samples. */
function learn(state, account, costs, weekDevices) {
  const snapshots = Object.fromEntries(
    Object.keys(WINDOWS)
      .filter((key) => account[key])
      .map((key) => [key, { resetsAt: account[key].resetsAt, pct: account[key].pct, cost: costs[key] }]),
  );
  const last = { ...state.last };
  for (const [key, snap] of Object.entries(snapshots)) {
    const prev = state.last[key];
    if (!prev || isLater(snap, prev)) last[key] = snap;
    else if (sameWindow(snap.resetsAt, prev.resetsAt)) last[key] = { ...snap, pct: Math.max(snap.pct, prev.pct) };
  }
  const added = finishedSamples(state, snapshots.fiveHour);
  const samples = Object.fromEntries(
    Object.keys(WINDOWS).map((key) => [key, [...(state.samples[key] ?? []), ...(added[key] ? [added[key]] : [])].slice(-MAX_SAMPLES)]),
  );
  const isNewSegment =
    snapshots.fiveHour && snapshots.sevenDay && !(state.segment && sameWindow(state.segment.fiveResetsAt, snapshots.fiveHour.resetsAt));
  const segment = isNewSegment
    ? { fiveResetsAt: snapshots.fiveHour.resetsAt, weekResetsAt: snapshots.sevenDay.resetsAt, weekPct: snapshots.sevenDay.pct, weekCost: snapshots.sevenDay.cost, devices: weekDevices }
    : state.segment && { ...state.segment, isMixed: state.segment.isMixed || weekDevices.some((d) => !state.segment.devices?.includes(d)) };
  // Outside usage already put on a device is not Claude Code: leave it out of the ratio.
  const confirmed = state.events.filter(isConfirmed);
  const codeOnly = (key) => snapshots[key] && { ...snapshots[key], pct: snapshots[key].pct - knownPct(confirmed, key, snapshots[key].resetsAt) };
  const lows = Object.fromEntries(Object.keys(WINDOWS).map((key) => [key, updateLows(state.lows[key], codeOnly(key))]));
  return { last, samples, segment, lows };
}

// ---------- finding outside usage ----------

/**
 * Before a rate is learned: plan % gained with no Claude Code cost behind it. A quiet rise keeps the old
 * baseline (noting when it began), so small rises add up; any Claude Code activity moves the baseline.
 */
function quietRise(key, base, current, cost, now, settleMs) {
  const snapshot = { resetsAt: current.resetsAt, pct: current.pct, cost };
  if (!base) return { base: snapshot, amount: 0, isDue: false };
  const isSame = sameWindow(base.resetsAt, current.resetsAt);
  // An older window, or a lower % in the same one: an out-of-order snapshot, not news.
  if (isSame ? current.pct < base.pct : !isLater(current, base)) return { base, amount: 0, isDue: false };
  const from = isSame ? base : { resetsAt: current.resetsAt, pct: 0, cost: 0 }; // a new window starts at zero
  const rise = current.pct - from.pct;
  if (Math.abs(cost - from.cost) >= COST_EPSILON_USD || rise <= 0) return { base: snapshot, amount: 0, isDue: false };
  const risingSince = from.risingSince ?? now;
  const isDue = rise >= MIN_OUTSIDE_PCT[key] && now - risingSince >= settleMs;
  return { base: { ...from, risingSince }, rebase: snapshot, amount: rise, isDue };
}

/** With a learned rate: plan % in the window that neither Claude Code cost nor known outside usage explains. */
function unexplained(key, current, cost, rate, events, since, now, settleMs) {
  const expected = rate * cost;
  const amount = current.pct - expected - knownPct(events, key, current.resetsAt);
  const isOver = amount >= Math.max(MIN_OUTSIDE_PCT[key], RATE_TOLERANCE * expected);
  // The wait starts over in a new window.
  const at = since && sameWindow(since.resetsAt, current.resetsAt) ? since.at : now;
  const overSince = isOver ? { resetsAt: current.resetsAt, at } : null;
  return { amount: Math.max(0, amount), overSince, isDue: isOver && now - at >= settleMs };
}

/**
 * The one device where Claude Desktop, claude.ai or the Claude extension was used since `from`, with the
 * surface used last, or null when none or several were.
 */
function activeDevice(reports, from) {
  const active = reports
    .map((r) => {
      const [surface, at] = Object.entries(r.surfaces ?? {})
        .filter(([, iso]) => iso && Date.parse(iso) >= from)
        .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))[0] ?? [];
      return surface ? { device: r.device, surface, at } : null;
    })
    .filter(Boolean);
  return active.length === 1 ? active[0] : null;
}

/** When the unexplained rise began: the earliest settle start among the windows, else now. */
const riseStart = (findings, now) =>
  Math.min(now, ...Object.values(findings).map((f) => f.overSince?.at ?? f.base?.risingSince ?? now));

/**
 * Adds to the latest event when it is unanswered (or put automatically on the same device) and covers the
 * same windows, else starts a new one — on `auto.device` when there is one.
 */
function addEvent(events, windows, detectedAt, newId, auto) {
  const pending = events.at(-1);
  const isOpen = pending && !pending.split && (!pending.device || (pending.auto && pending.device === auto?.device));
  const canMerge =
    isOpen && Object.entries(windows).every(([key, w]) => !pending.windows[key] || sameWindow(pending.windows[key].resetsAt, w.resetsAt));
  if (canMerge) {
    const added = Object.fromEntries(
      Object.entries(windows).map(([key, w]) => [key, { pct: (pending.windows[key]?.pct ?? 0) + w.pct, resetsAt: w.resetsAt }]),
    );
    const merged = { ...pending, detectedAt, windows: { ...pending.windows, ...added } };
    return { events: [...events.slice(0, -1), merged], event: merged, isNew: false };
  }
  const event = auto ? { id: newId(), device: auto.device, auto: auto.surface, detectedAt, windows } : { id: newId(), device: null, detectedAt, windows };
  return { events: [...events, event].slice(-MAX_EVENTS), event, isNew: true };
}

/**
 * Looks at the account's latest reports: learns the rate, then looks for usage outside Claude Code.
 * @returns {{ state: object, event: object|null, isNew: boolean }} `event`: new (`isNew`) or grown usage outside Claude Code
 */
export function detectOutside(stored, reports, { now = Date.now(), newId = randomId, settleMs = SETTLE_MS } = {}) {
  const state = { ...EMPTY_OUTSIDE, ...stored };
  const { account, inWindow } = windowPools(reports);
  const costs = Object.fromEntries(Object.keys(WINDOWS).map((key) => [key, sum(inWindow[key].map((r) => r.local[key].costUSD))]));
  const learned = learn(state, account, costs, inWindow.sevenDay.map((r) => r.device));
  const rates = planRates(learned);
  const findings = Object.fromEntries(
    Object.keys(WINDOWS)
      .filter((key) => account[key])
      .map((key) => [
        key,
        rates[key] === null
          ? quietRise(key, state.baseline[key], account[key], costs[key], now, settleMs)
          : unexplained(key, account[key], costs[key], rates[key], state.events, state.since[key], now, settleMs),
      ]),
  );
  const isAsking = Object.values(findings).some((f) => f.isDue);
  const isAsked = (f) => isAsking && f.amount > 0;
  const baseline = {
    ...state.baseline,
    ...Object.fromEntries(Object.entries(findings).filter(([, f]) => f.base).map(([key, f]) => [key, isAsked(f) ? f.rebase : f.base])),
  };
  const since = Object.fromEntries(Object.entries(findings).filter(([, f]) => f.overSince && !isAsked(f)).map(([key, f]) => [key, f.overSince]));
  const events = state.events.filter((e) => isKept(e, learned.last, now));
  const next = { ...state, ...learned, baseline, since, events };
  if (!isAsking) return { state: next, event: null, isNew: false };
  // Every event carries its 5h window (maybe at 0%), so its weekly part is tied to that 5h window.
  const windows = Object.fromEntries(
    Object.entries(findings)
      .filter(([key, f]) => isAsked(f) || key === 'fiveHour')
      .map(([key, f]) => [key, { pct: isAsked(f) ? f.amount : 0, resetsAt: account[key].resetsAt }]),
  );
  const auto = activeDevice(reports, riseStart(findings, now) - ACTIVITY_LOOKBACK_MS);
  const added = addEvent(events, windows, new Date(now).toISOString(), newId, auto);
  return { state: { ...next, events: added.events }, event: added.event, isNew: added.isNew };
}

/**
 * Backfill with known amounts: puts `amounts` (% per window) on `device` in the current windows. Null when
 * an amount is not a number between 0 and the plan % of its window.
 */
export function addOutside(state, reports, device, amounts, { now = Date.now(), newId = randomId } = {}) {
  const { account } = windowPools(reports);
  const entries = Object.entries(amounts ?? {}).filter(([key]) => key in WINDOWS);
  const isValid = entries.length && entries.every(([key, pct]) => account[key] && Number.isFinite(pct) && pct > 0 && pct <= account[key].pct);
  if (!isValid) return null;
  const windows = Object.fromEntries(entries.map(([key, pct]) => [key, { pct, resetsAt: account[key].resetsAt }]));
  const event = { id: newId(), device, detectedAt: new Date(now).toISOString(), windows };
  return { state: { ...state, events: [...state.events, event].slice(-MAX_EVENTS) }, event };
}

/**
 * Backfill and on-demand questions: puts every unanswered event on `device`, plus — as a new event — any %
 * the plan rate says Claude Code cost does not explain yet. With `device` null the new event is left
 * unanswered (to ask about). Returns null when there is nothing to claim.
 */
export function claimOutside(state, reports, device, { now = Date.now(), newId = randomId } = {}) {
  const { account, inWindow } = windowPools(reports);
  const rates = planRates(state);
  const leftovers = Object.fromEntries(
    Object.keys(WINDOWS)
      .filter((key) => account[key] && rates[key] !== null)
      .map((key) => {
        const cost = sum(inWindow[key].map((r) => r.local[key].costUSD));
        return [key, { pct: account[key].pct - rates[key] * cost - knownPct(state.events, key, account[key].resetsAt), resetsAt: account[key].resetsAt }];
      })
      .filter(([, w]) => w.pct >= MIN_CLAIM_PCT),
  );
  const pending = device ? pendingEvents(state, now).map((e) => e.id) : [];
  if (!pending.length && !Object.keys(leftovers).length) return null;
  const events = state.events.map((e) => (pending.includes(e.id) ? { ...e, device, split: false } : e));
  if (!Object.keys(leftovers).length) return { state: { ...state, events }, event: null, assigned: pending.length };
  const event = { id: newId(), device, detectedAt: new Date(now).toISOString(), windows: leftovers };
  return { state: { ...state, events: [...events, event].slice(-MAX_EVENTS) }, event, assigned: pending.length };
}

/** Unanswered events whose windows have not all reset, oldest first. */
export const pendingEvents = (state, now = Date.now()) => state.events.filter((e) => !e.device && !e.split && isLive(e, now));

/** @returns {{ state: object, event: object }|null} null when the event is gone */
export function assignEvent(state, id, device) {
  const found = state.events.find((e) => e.id === id);
  if (!found) return null;
  const event = { ...found, device, split: false };
  return { state: { ...state, events: state.events.map((e) => (e.id === id ? event : e)) }, event };
}

/** "Not sure": split the usage across devices by their Claude Code usage. Kept, so it is not asked about again. */
export function ignoreEvent(state, id) {
  if (!state.events.some((e) => e.id === id)) return null;
  return { ...state, events: state.events.map((e) => (e.id === id ? { ...e, device: null, split: true } : e)) };
}
