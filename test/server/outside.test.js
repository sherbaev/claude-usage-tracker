import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignEvent, detectOutside, EMPTY_OUTSIDE, ignoreEvent, pendingEvents } from '../../server/src/outside.js';

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
  assert.deepEqual(ignoreEvent(state, event.id).events, []);
  assert.equal(ignoreEvent(state, 'nope'), null);
});

test('events are dropped once all their windows have reset', () => {
  let state = detect(EMPTY_OUTSIDE, [report('mac', 30, { five: 10 })]).state;
  state = detect(state, [report('mac', 0, { five: 15 })]).state;
  const later = Date.parse(RW) + 1;
  const after = detectOutside(state, [], { now: later, newId });
  assert.deepEqual(after.state.events, []);
  assert.deepEqual(pendingEvents(state, later), []);
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
