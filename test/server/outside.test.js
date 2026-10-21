import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOutside, assignEvent, claimOutside, detectOutside, EMPTY_OUTSIDE, ignoreEvent, pendingEvents, planRates } from '../../server/src/outside.js';

const NOW = Date.parse('2026-10-19T10:00:00Z');
const R5 = '2026-10-19T12:00:00.000Z';
const RW = '2026-10-22T20:00:00.000Z';
let seq = 0;
const newId = () => `e${++seq}`;

const report = (device, minutesAgo, { five, week = 20, fiveCost = 1, weekCost = 5, r5 = R5 }) => ({
  device,
  reportedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  account: { fiveHour: { pct: five, resetsAt: r5 }, sevenDay: { pct: week, resetsAt: RW } },
  local: { fiveHour: { costUSD: fiveCost, tokens: 1 }, sevenDay: { costUSD: weekCost, tokens: 1 } },
});
const detect = (state, reports) => detectOutside(state, reports, { now: NOW, newId, settleMs: 0 });

test('the first report only records a baseline', () => {
  const { state, event } = detect(EMPTY_OUTSIDE, [report('mac', 0, { five: 30 })]);
  assert.equal(event, null);
  assert.deepEqual(state.baseline.fiveHour, { resetsAt: R5, pct: 30, cost: 1 });
  assert.deepEqual(state.events, []);
});

test('plan % rising while no Claude Code cost moved is usage outside Claude Code', () => {
  const first = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const { state, event } = detect(first, [report('mac', 0, { five: 16, week: 22 })]);
  assert.deepEqual(event.windows, { fiveHour: { pct: 6, resetsAt: R5 }, sevenDay: { pct: 2, resetsAt: RW } });
  assert.equal(event.device, null);
  assert.equal(state.events.length, 1);
  assert.equal(state.baseline.fiveHour.pct, 16, 'the baseline moves past the detected usage');
});

test('plan % rising together with Claude Code cost is not flagged', () => {
  const first = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const { state, event } = detect(first, [report('mac', 0, { five: 16, fiveCost: 3, weekCost: 7 })]);
  assert.equal(event, null);
  assert.equal(state.baseline.fiveHour.pct, 16);
  assert.equal(state.baseline.fiveHour.cost, 3);
});

test('small rises add up until they pass the threshold', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  let result = detect(state, [report('mac', 20, { five: 11 })]);
  assert.equal(result.event, null);
  assert.equal(result.state.baseline.fiveHour.pct, 10, 'kept, so the next rise adds to it');
  state = result.state;
  result = detect(state, [report('mac', 0, { five: 12.5 })]);
  assert.deepEqual(result.event.windows.fiveHour, { pct: 2.5, resetsAt: R5 });
});

test('another device reporting its own Claude Code cost is not outside usage', () => {
  const first = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 }), report('pc', 40, { five: 10, fiveCost: 2 })]).state;
  const { event } = detect(first, [report('mac', 30, { five: 10 }), report('pc', 0, { five: 15, fiveCost: 4 })]);
  assert.equal(event, null);
});

test('a new window counts from zero', () => {
  const first = detect(EMPTY_OUTSIDE, [report('mac', 300, { five: 40, fiveCost: 9 })]).state;
  const nextReset = '2026-10-19T17:00:00.000Z';
  const { event } = detect(first, [report('mac', 0, { five: 5, fiveCost: 0, r5: nextReset })]);
  assert.deepEqual(event.windows.fiveHour, { pct: 5, resetsAt: nextReset });
});

test('unanswered usage merges into the pending question; answered usage starts a new one', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const one = detect(state, [report('mac', 20, { five: 13 })]);
  const two = detect(one.state, [report('mac', 10, { five: 16 })]);
  assert.equal(two.event.id, one.event.id);
  assert.equal(two.event.windows.fiveHour.pct, 6);
  assert.equal(two.state.events.length, 1);

  state = assignEvent(two.state, one.event.id, 'mac').state;
  const three = detect(state, [report('mac', 0, { five: 19 })]);
  assert.notEqual(three.event.id, one.event.id);
  assert.equal(three.state.events.length, 2);
  assert.equal(pendingEvents(three.state, NOW).at(-1).id, three.event.id);
});

test('assign, re-assign and ignore', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const { event, state: withEvent } = detect(state, [report('mac', 0, { five: 15 })]);
  state = assignEvent(withEvent, event.id, 'mac').state;
  assert.equal(state.events[0].device, 'mac');
  assert.deepEqual(pendingEvents(state, NOW), []);
  state = assignEvent(state, event.id, 'pc').state;
  assert.equal(state.events[0].device, 'pc');
  assert.equal(assignEvent(state, 'nope', 'pc'), null);
  const split = ignoreEvent(state, event.id);
  assert.equal(split.events[0].split, true, 'kept, so the same usage is not asked about again');
  assert.deepEqual(pendingEvents(split, NOW), []);
  assert.equal(assignEvent(split, event.id, 'mac').event.split, false, 'a split can still be changed to a device');
  assert.equal(ignoreEvent(state, 'nope'), null);
});

test('events are dropped once their windows have reset and newer windows have been seen', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  state = detect(state, [report('mac', 0, { five: 15 })]).state;
  const later = Date.parse(RW) + 1;
  assert.deepEqual(pendingEvents(state, later), [], 'no longer asked about');
  assert.equal(detectOutside(state, [], { now: later, newId }).state.events.length, 1, 'kept until it is learned from');
  const next = { device: 'mac', reportedAt: new Date(later).toISOString(),
    account: { fiveHour: { pct: 1, resetsAt: '2026-10-23T01:00:00.000Z' }, sevenDay: { pct: 1, resetsAt: '2026-10-29T20:00:00.000Z' } },
    local: { fiveHour: { costUSD: 1, tokens: 1 }, sevenDay: { costUSD: 1, tokens: 1 } } };
  assert.deepEqual(detectOutside(state, [next], { now: later, newId }).state.events, []);
});

test('ignores reports without Claude data and stale snapshots', () => {
  const first = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const codexOnly = { device: 'box', reportedAt: new Date(NOW).toISOString(), account: { fiveHour: null, sevenDay: null }, local: { fiveHour: null, sevenDay: null } };
  assert.equal(detect(first, [report('mac', 30, { five: 10 }), codexOnly]).event, null);
  const stale = detect(first, [report('mac', 0, { five: 50, r5: '2026-10-19T07:00:00.000Z' })]);
  assert.equal(stale.event?.windows.fiveHour, undefined);
  assert.equal(stale.state.baseline.fiveHour.resetsAt, R5);
});

test('a rise waits until a device that has not reported yet could have reported its Claude Code cost', () => {
  const at = (minutes) => ({ now: NOW + minutes * 60_000, newId });
  let state = detectOutside(EMPTY_OUTSIDE, [report('mac', 0, { five: 10 }), report('pc', 0, { five: 10 })], at(0)).state;
  // pc used Claude Code but its report is throttled; mac reports first with the higher plan %.
  let result = detectOutside(state, [report('mac', 0, { five: 18 }), report('pc', 0, { five: 10 })], at(1));
  assert.equal(result.event, null, 'not asked yet');
  result = detectOutside(result.state, [report('mac', 0, { five: 18 }), report('pc', 0, { five: 18, fiveCost: 3 })], at(4));
  assert.equal(result.event, null, 'pc reported the cost: it was Claude Code');
  assert.equal(result.state.baseline.fiveHour.pct, 18);

  // A rise nobody explains within the settle time is asked about.
  result = detectOutside(result.state, [report('mac', 0, { five: 24 }), report('pc', 0, { five: 18, fiveCost: 3 })], at(5));
  assert.equal(result.event, null);
  result = detectOutside(result.state, [report('mac', 0, { five: 25 }), report('pc', 0, { five: 18, fiveCost: 3 })], at(12));
  assert.deepEqual(result.event.windows.fiveHour, { pct: 7, resetsAt: R5 });
});

test('a lower % in the same window (an out-of-order snapshot) does not lower the baseline', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 20 })]).state;
  state = detect(state, [report('mac', 20, { five: 15 })]).state;
  assert.equal(state.baseline.fiveHour.pct, 20);
  assert.equal(detect(state, [report('mac', 0, { five: 20 })]).event, null);
});

test('only a new event is announced; growth of a pending one is merged quietly', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  const one = detect(state, [report('mac', 20, { five: 13 })]);
  assert.equal(one.isNew, true);
  const two = detect(one.state, [report('mac', 10, { five: 16 })]);
  assert.equal(two.event.id, one.event.id);
  assert.equal(two.isNew, false);
});

test('pendingEvents lists every unanswered event still in its window', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 300, { five: 10 })]).state;
  state = detect(state, [report('mac', 200, { five: 14 })]).state;
  state = detect(state, [report('mac', 0, { five: 5, fiveCost: 0, r5: '2026-10-19T17:00:00.000Z' })]).state;
  assert.equal(pendingEvents(state, NOW).length, 2);
  assert.equal(pendingEvents(assignEvent(state, state.events[0].id, 'mac').state, NOW).length, 1);
});

// ---- learned rate: plan % per $ of Claude Code, from finished windows ----
const RB = '2026-10-19T17:00:00.000Z';
const RC = '2026-10-19T22:00:00.000Z';
const mac = (five, fiveCost, week, weekCost, r5) => report('mac', 0, { five, fiveCost, week, weekCost, r5 });
const at = (minutes, extra = {}) => ({ now: NOW + minutes * 60_000, newId, ...extra });

/** Two finished 5h windows at 0.25 %/$ (5h) and 0.05 %/$ (weekly); now early in a third one. */
function learned() {
  return [
    mac(2, 8, 5, 100, R5),
    mac(10, 40, 6.6, 132, R5),
    mac(1, 4, 6.8, 136, RB),
    mac(20, 80, 10.6, 212, RB),
    mac(1, 4, 10.8, 216, RC),
  ].reduce((state, r) => detectOutside(state, [r], at(0, { settleMs: 0 })).state, EMPTY_OUTSIDE);
}

test('learns how much plan % a dollar of Claude Code uses from finished windows', () => {
  assert.deepEqual(planRates(EMPTY_OUTSIDE), { fiveHour: null, sevenDay: null });
  const rates = planRates(learned());
  assert.equal(rates.fiveHour, 0.25);
  assert.ok(Math.abs(rates.sevenDay - 0.05) < 1e-9, String(rates.sevenDay));
});

test('a window with much more % per dollar than usual (outside usage) does not skew the rate', () => {
  const samples = { fiveHour: [{ pct: 10, cost: 40 }, { pct: 20, cost: 80 }, { pct: 40, cost: 40 }], sevenDay: [] };
  assert.equal(planRates({ ...EMPTY_OUTSIDE, samples }).fiveHour, 0.25);
});

test('usage outside Claude Code is found while Claude Code is also running', () => {
  const { event } = detectOutside(learned(), [mac(12, 20, 13, 232, RC)], at(0, { settleMs: 0 }));
  assert.equal(event.windows.fiveHour.pct, 7);
  assert.ok(Math.abs(event.windows.sevenDay.pct - 1.4) < 1e-9, String(event.windows.sevenDay.pct));
});

test('a rise that Claude Code cost explains at the learned rate is not asked about', () => {
  assert.equal(detectOutside(learned(), [mac(6, 24, 12, 236, RC)], at(0, { settleMs: 0 })).event, null);
});

test('Claude Desktop first, then a Claude Code session: still asked once the rise has settled', () => {
  let result = detectOutside(learned(), [mac(9, 4, 12.8, 216, RC)], at(1)); // session start, before any Claude Code
  assert.equal(result.event, null, 'waits for other devices to report');
  result = detectOutside(result.state, [mac(11, 12, 13.2, 224, RC)], at(8)); // Claude Code has run since
  assert.equal(result.event.windows.fiveHour.pct, 8);
});

test('with a learned rate, a device reporting its Claude Code cost late is not outside usage', () => {
  const pc = (cost) => report('pc', 0, { five: 9, fiveCost: cost, week: 12.4, weekCost: 216 + cost, r5: RC });
  let result = detectOutside(learned(), [mac(9, 4, 12.4, 216, RC), pc(0)], at(1));
  result = detectOutside(result.state, [mac(9, 4, 12.4, 216, RC), pc(32)], at(4));
  result = detectOutside(result.state, [mac(9, 4, 12.4, 216, RC), pc(32)], at(12));
  assert.equal(result.event, null);
});

test('usage split by Claude Code usage is not asked about again', () => {
  const first = detectOutside(learned(), [mac(12, 20, 13, 232, RC)], at(0, { settleMs: 0 }));
  const split = ignoreEvent(first.state, first.event.id);
  assert.equal(detectOutside(split, [mac(12, 20, 13, 232, RC)], at(1, { settleMs: 0 })).event, null);
});

test('outside usage confirmed for a device is taken out of the finished window before learning from it', () => {
  // Two clean windows at 0.25 %/$, then a window with 2 points of Desktop use the user assigned.
  let state = learned();
  const found = detectOutside(state, [mac(5, 12, 11.2, 224, RC)], at(0, { settleMs: 0 })); // 2 points over; weekly fully explained
  assert.deepEqual(Object.keys(found.event.windows), ['fiveHour']);
  state = assignEvent(found.state, found.event.id, 'mac').state;
  // A late report still from the old window, after it reset, then the next window.
  const afterReset = { now: Date.parse(RC) + 60_000, newId, settleMs: 0 };
  state = detectOutside(state, [mac(5, 12, 11.2, 224, RC)], afterReset).state;
  state = detectOutside(state, [mac(1, 4, 13.4, 228, '2026-10-20T03:00:00.000Z')], afterReset).state;
  assert.equal(planRates(state).fiveHour, 0.25, 'the 2 Desktop points are not learned as Claude Code');
});

test('"Not sure" usage is learned as Claude Code', () => {
  const found = detectOutside(learned(), [mac(5, 12, 11.2, 224, RC)], at(0, { settleMs: 0 }));
  let state = ignoreEvent(found.state, found.event.id);
  const later = { now: Date.parse(RC) + 60_000, newId, settleMs: 0 };
  state = detectOutside(state, [mac(1, 4, 13.4, 228, '2026-10-20T03:00:00.000Z')], later).state;
  assert.deepEqual(state.samples.fiveHour.at(-1), { pct: 5, cost: 12 }, 'the 2 points are not taken out');
});

test('the settle wait starts over in a new window', () => {
  let result = detectOutside(learned(), [mac(9, 4, 12.8, 216, RC)], at(1)); // over, waiting
  const nextReset = '2026-10-20T03:00:00.000Z';
  result = detectOutside(result.state, [mac(9, 4, 13, 216, nextReset)], at(400));
  assert.equal(result.event, null, 'a new window waits again');
});

test('a device joining the weekly window mid-way does not skew the weekly rate', () => {
  let state = learned();
  const pc = (cost, r5) => report('pc', 0, { five: 1, fiveCost: 0, week: 11, weekCost: cost, r5 });
  state = detectOutside(state, [mac(2, 8, 12.5, 224, RC), pc(400, RC)], at(0, { settleMs: 0 })).state; // pc brings a week of cost
  state = detectOutside(state, [mac(1, 4, 12.6, 228, '2026-10-20T03:00:00.000Z'), pc(400, RC)], at(0, { settleMs: 0 })).state;
  assert.equal(state.samples.sevenDay.length, 2, 'that weekly segment is not learned from');
});

// ---- provisional rate, backfill, and which device it was ----
test('before any window has finished, the lowest %-per-dollar seen so far is the rate', () => {
  let state = EMPTY_OUTSIDE;
  state = detect(state, [report('mac', 30, { five: 5, fiveCost: 21.92, week: 5, weekCost: 116.17 })]).state;
  state = detect(state, [report('mac', 20, { five: 3, fiveCost: 15.44, week: 6, weekCost: 139.42 })]).state; // 3%: too coarse
  state = detect(state, [report('mac', 0, { five: 9, fiveCost: 30, week: 11, weekCost: 182.09 })]).state; // Desktop use on top
  const rates = planRates(state);
  assert.ok(Math.abs(rates.fiveHour - 5 / 21.92) < 1e-9, String(rates.fiveHour));
  assert.ok(Math.abs(rates.sevenDay - 6 / 139.42) < 1e-9, String(rates.sevenDay));
});

test('claimOutside puts unanswered and not-yet-asked outside usage on a device (backfill)', () => {
  const reports = [mac(12, 20, 13, 232, RC)];
  const opts = at(0, { settleMs: 60 * 60_000 }); // nothing asked yet
  const state = detectOutside(learned(), reports, opts).state;
  const claimed = claimOutside(state, reports, 'mac', opts);
  assert.equal(claimed.event.device, 'mac');
  assert.equal(claimed.event.windows.fiveHour.pct, 7);
  assert.ok(Math.abs(claimed.event.windows.sevenDay.pct - 1.4) < 1e-9);
  assert.equal(claimOutside(claimed.state, reports, 'mac', opts), null, 'nothing left to claim');
});

const withSurfaces = (r, surfaces) => ({ ...r, surfaces: { desktop: null, web: null, extension: null, ...surfaces } });
const recently = new Date(NOW - 10 * 60_000).toISOString();

test('outside usage goes to the one device where Claude Desktop, claude.ai or the extension was just used', () => {
  const pc = withSurfaces(report('pc', 0, { five: 12, fiveCost: 0, week: 13, weekCost: 0, r5: RC }), {});
  const { event, isNew } = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: recently }), pc], at(0, { settleMs: 0 }));
  assert.equal(isNew, true);
  assert.equal(event.device, 'mac');
  assert.equal(event.auto, 'desktop');
});

test('with activity on two devices, or none, the bot asks', () => {
  const pc = (surfaces) => withSurfaces(report('pc', 0, { five: 12, fiveCost: 0, week: 13, weekCost: 0, r5: RC }), surfaces);
  const both = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: recently }), pc({ web: recently })], at(0, { settleMs: 0 }));
  assert.equal(both.event.device, null);
  const old = new Date(NOW - 5 * 60 * 60_000).toISOString();
  const none = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: old }), pc({})], at(0, { settleMs: 0 }));
  assert.equal(none.event.device, null);
});

test('more outside usage on the same device is added quietly to its automatic event', () => {
  const first = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: recently })], at(0, { settleMs: 0 }));
  const more = detectOutside(first.state, [withSurfaces(mac(16, 20, 14, 232, RC), { desktop: recently })], at(5, { settleMs: 0 }));
  assert.equal(more.isNew, false);
  assert.equal(more.event.id, first.event.id);
  assert.equal(more.event.windows.fiveHour.pct, 11);
});

test('the lowest %-per-dollar leaves out outside usage already put on a device', () => {
  const r = (week, weekCost) => report('mac', 0, { five: 1, fiveCost: 1, week, weekCost });
  let state = detect(EMPTY_OUTSIDE, [r(11, 182.09)]).state; // Desktop use already in the plan %
  const desktop = { id: 'd1', device: 'mac', detectedAt: new Date(NOW).toISOString(), windows: { sevenDay: { pct: 11 - 0.043 * 182.09, resetsAt: RW } } };
  state = detect({ ...state, events: [desktop], lows: EMPTY_OUTSIDE.lows }, [r(11, 182.09)]).state;
  assert.ok(Math.abs(planRates(state).sevenDay - 0.043) < 1e-9, String(planRates(state).sevenDay));
});

test('with both, the lower of the learned and the lowest-seen rate is used', () => {
  const samples = { fiveHour: [{ pct: 30, cost: 100 }, { pct: 30, cost: 100 }], sevenDay: [] };
  const lows = { fiveHour: [{ resetsAt: R5, ratio: 0.25 }], sevenDay: [] };
  assert.equal(planRates({ ...EMPTY_OUTSIDE, samples, lows }).fiveHour, 0.25);
});

test('changing an automatic event by hand drops the "automatically" label', () => {
  const auto = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: recently })], at(0, { settleMs: 0 }));
  assert.equal(auto.event.auto, 'desktop');
  assert.equal(assignEvent(auto.state, auto.event.id, 'pc').event.auto, undefined);
  assert.equal(ignoreEvent(auto.state, auto.event.id).events.at(-1).auto, undefined);
});

test('no automatic assignment while any device does not report activity (old plugin, Windows, …)', () => {
  const old = report('pc', 0, { five: 12, fiveCost: 0, week: 13, weekCost: 0, r5: RC }); // no surfaces at all
  const result = detectOutside(learned(), [withSurfaces(mac(12, 20, 13, 232, RC), { desktop: recently }), old], at(0, { settleMs: 0 }));
  assert.equal(result.event.device, null);
});

test('backfill events always carry the 5h window and cannot exceed what is left of the plan', () => {
  const reports = [mac(12, 20, 13, 232, RC)];
  const added = addOutside(learned(), reports, 'mac', { sevenDay: 1 }, at(0));
  assert.deepEqual(added.event.windows.fiveHour, { pct: 0, resetsAt: RC });
  assert.equal(addOutside(added.state, reports, 'mac', { sevenDay: 12.5 }, at(0)), null, 'only 12 of 13 points are left');
  assert.equal(addOutside(added.state, reports, 'mac', { constructor: 1 }, at(0)), null);
  const claimed = claimOutside(learned(), [mac(12, 20, 13, 232, RC)], 'mac', at(0));
  assert.ok(claimed.event.windows.fiveHour);
});
