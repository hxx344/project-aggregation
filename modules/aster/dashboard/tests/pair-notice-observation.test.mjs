import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearPastPairNotices,
  nextPairNoticeDeadline,
  observePairNotices,
  PAIR_DATA_NOTICE_DELAY,
  updatePairNoticeStates,
  visiblePairNotices,
} from '../lib/pair-notices.ts';
import { pairDataFresh, pairDeletionBlock } from '../lib/pairs.ts';

function pair(state = {}, options = {}) {
  return {
    id: 'pair-a',
    enabled: true,
    ordinary: { enabled: true },
    margin: { enabled: false },
    state: {
      phase: 'waiting',
      updated_at: 100,
      snapshots: {
        long: { timestamp: 100, positions: [] },
        short: { timestamp: 100, positions: [] },
      },
      ...state,
    },
    ...options,
  };
}
const stale = () => pair({ updated_at: 1 });
const current = (state) => visiblePairNotices(state);
const observe = (previous, fixture, elapsed, offline = false) =>
  observePairNotices(previous, fixture, 100 + elapsed, offline, elapsed);

test('data warnings need three observed seconds and a server-clock jump cannot mature them', () => {
  assert.equal(PAIR_DATA_NOTICE_DELAY, 3);
  let state = observe(undefined, stale(), 0);
  assert.deepEqual(current(state), []);
  assert.equal(nextPairNoticeDeadline(new Map([['a', state]])), 3);
  state = observePairNotices(state, stale(), 10_000, false, 2.999);
  assert.equal(state.data.group.confirmed, false);
  assert.deepEqual(state.history.entries, []);
  state = observe(state, stale(), 3);
  assert.equal(state.data.group.confirmed, true);
  assert.equal(current(state)[0].kind, 'data');
  assert.equal(state.history.entries[0].firstSeen, 103);
  assert.equal(state.history.entries[0].occurrences, 1);
  assert.equal(nextPairNoticeDeadline(new Map([['a', state]])), null);
  assert.deepEqual(observe(state, stale(), 3), state);
});

test('transient recovery cancels the deadline and never creates history', () => {
  let state = observe(undefined, stale(), 0);
  state = observe(state, pair(), 2.999);
  assert.deepEqual(state.history.entries, []);
  assert.equal(state.data.group.since, null);
  assert.equal(nextPairNoticeDeadline(new Map([['a', state]])), null);
  state = observe(state, stale(), 3);
  state = observe(state, stale(), 5.999);
  assert.deepEqual(state.history.entries, []);
  state = observe(state, stale(), 6);
  assert.equal(state.history.entries[0].firstSeen, 106);
});

test('only confirmed recurrences change history counts or timestamps', () => {
  let state = observe(undefined, stale(), 0);
  state = observe(state, stale(), 3);
  const confirmed = structuredClone(state.history.entries);
  state = observe(state, pair(), 4);
  assert.deepEqual(current(state), []);
  state = observe(state, stale(), 4.5);
  state = observe(state, pair(), 5.5);
  assert.deepEqual(state.history.entries, confirmed);
  state = observe(state, stale(), 6);
  state = observe(state, stale(), 9);
  assert.equal(state.history.entries[0].occurrences, 2);
  assert.equal(state.history.entries[0].firstSeen, 103);
  assert.equal(state.history.entries[0].lastSeen, 109);
});

test('clearing past entries neither confirms nor restarts a pending warning', () => {
  let state = observe(undefined, stale(), 0);
  state = observe(state, stale(), 3);
  state = observe(state, pair(), 4);
  state = observe(state, stale(), 5);
  state = { ...state, history: clearPastPairNotices(state.history) };
  assert.equal(state.data.group.since, 5);
  assert.deepEqual(state.history.entries, []);
  state = observe(state, stale(), 7.999);
  assert.deepEqual(state.history.entries, []);
  state = observe(state, stale(), 8);
  assert.equal(state.history.entries[0].occurrences, 1);
  assert.deepEqual(clearPastPairNotices(state.history), state.history);
});

test('each side and runtime has its own timer even while the group warning is active', () => {
  const fixture = pair({
    snapshots: {
      long: { timestamp: 1, positions: [] },
      short: { timestamp: 100, positions: [] },
    },
  });
  let state = observe(undefined, fixture, 0);
  state = observe(state, fixture, 3);
  assert.equal(state.data.group.confirmed, true);
  assert.equal(state.data.long.confirmed, true);
  assert.equal(state.data.short.confirmed, false);
  assert.equal(state.data.runtime.confirmed, false);
  const both = structuredClone(fixture);
  both.state.snapshots.short.timestamp = 1;
  both.state.updated_at = 1;
  state = observe(state, both, 4);
  state = observe(state, both, 6.999);
  assert.equal(state.data.short.confirmed, false);
  assert.equal(state.data.runtime.confirmed, false);
  state = observe(state, both, 7);
  assert.equal(state.data.short.confirmed, true);
  assert.equal(state.data.runtime.confirmed, true);
});

test('offline and changing notice text preserve a continuous data anomaly', () => {
  let state = observe(undefined, stale(), 0);
  state = observe(state, { ...stale(), enabled: false }, 1);
  state = observe(state, stale(), 2, true);
  assert.deepEqual(current(state), []);
  state = observe(state, stale(), 3, true);
  assert.match(current(state)[0].text, /连接中断/);
  assert.equal(state.data.group.since, 0);
  // Offline controls and eight-second source validity do not wait for display.
  assert.equal(pairDataFresh(100, 108), false);
  assert.match(
    pairDeletionBlock({ ...pair(), enabled: false }, 100, true),
    /连接恢复/,
  );
});

test('execution and API failures display immediately alongside an unconfirmed data warning', () => {
  const fixture = pair({
    updated_at: 1,
    phase: 'reconciling',
    pending: { kind: 'ordinary' },
    reason: '原订单读取失败',
    api_notice: { kind: 'rate_limit', text: '请求限流，等待恢复' },
  });
  const state = observe(undefined, fixture, 0);
  assert.deepEqual(
    current(state).map(({ kind }) => kind),
    ['execution', 'api'],
  );
  assert.equal(state.data.group.confirmed, false);
});

test('invalid clocks never hide new execution/API errors or keep recovered errors current', () => {
  const fixture = pair({
    phase: 'reconciling',
    pending: { kind: 'ordinary' },
    reason: '原订单读取失败',
    api_notice: { kind: 'rate_limit', text: '请求限流，等待恢复' },
  });
  for (const [now, elapsed] of [
    [0, 0],
    [NaN, 0],
    [100, NaN],
  ]) {
    const state = observePairNotices(undefined, fixture, now, false, elapsed);
    assert.deepEqual(
      current(state).map(({ kind }) => kind),
      ['execution', 'api'],
    );
    assert.deepEqual(state.history.entries, []);
    const recovered = observePairNotices(state, pair(), now, false, elapsed);
    assert.deepEqual(current(recovered), []);
    const recorded = observe(undefined, fixture, 0);
    const withoutClock = observePairNotices(
      recorded,
      pair(),
      now,
      false,
      elapsed,
    );
    assert.deepEqual(current(withoutClock), []);
    assert.deepEqual(withoutClock.history, recorded.history);
  }
});

test('invalid or backwards monotonic clocks restart only unconfirmed signals', () => {
  const pending = observe(undefined, stale(), 2);
  for (const [now, elapsed] of [
    [0, 4],
    [NaN, 4],
    [104, NaN],
    [104, -1],
  ]) {
    const invalid = observePairNotices(pending, stale(), now, false, elapsed);
    assert.deepEqual(invalid.history, pending.history);
    assert.equal(invalid.data.group.since, null);
    const restarted = observe(invalid, stale(), 6);
    assert.equal(restarted.data.group.since, 6);
    assert.equal(
      observe(restarted, stale(), 8.999).data.group.confirmed,
      false,
    );
    assert.equal(observe(restarted, stale(), 9).data.group.confirmed, true);
  }
  const rollback = observe(pending, stale(), 1);
  assert.equal(rollback.data.group.since, 1);
  assert.equal(observe(rollback, stale(), 3.999).data.group.confirmed, false);
  const confirmed = observe(rollback, stale(), 4);
  const earlier = observe(confirmed, stale(), 0);
  assert.equal(earlier.data.group.confirmed, true);
  assert.equal(earlier.history.entries[0].occurrences, 1);
  assert.equal(earlier.history.entries[0].lastSeen, 104);
});

test('selection order preserves pending groups and removing a group discards its timer', () => {
  const a = stale(),
    b = { ...stale(), id: 'pair-b' };
  let states = updatePairNoticeStates(new Map(), [a], 100, false, 0);
  states = updatePairNoticeStates(states, [b, a], 102, false, 2);
  states = updatePairNoticeStates(states, [a, b], 103, false, 3);
  assert.equal(states.get('pair-a').data.group.confirmed, true);
  assert.equal(states.get('pair-b').data.group.confirmed, false);
  assert.equal(nextPairNoticeDeadline(states), 5);
  states = updatePairNoticeStates(states, [a], 104, false, 4);
  assert.equal(nextPairNoticeDeadline(states), null);
  states = updatePairNoticeStates(states, [a, b], 105, false, 5);
  assert.equal(states.get('pair-b').data.group.since, 5);
});

test('margin-only balances use their own timestamps and planned waits reset stale timers', () => {
  const fixture = pair(
    {
      phase: 'monitoring',
      snapshots: { long: { timestamp: 1 }, short: { timestamp: 1 } },
      margin_balances: { long: { timestamp: 100 }, short: { timestamp: 100 } },
      margin: {
        enabled: true,
        blocks_trading: false,
        status: 'waiting',
        checked_at: 100,
        next_check_at: 130,
      },
    },
    { ordinary: { enabled: false }, margin: { enabled: true } },
  );
  let state = observe(undefined, fixture, 0);
  state = observe(state, fixture, 3);
  assert.deepEqual(current(state), []);
  assert.equal(state.data.long.since, null);
  const overdue = structuredClone(fixture);
  overdue.state.updated_at = 1;
  state = observe(state, overdue, 4);
  state = observe(state, fixture, 6);
  assert.deepEqual(state.history.entries, []);
  assert.equal(state.data.group.since, null);
  const unplanned = structuredClone(fixture);
  unplanned.state.margin.status = 'attention';
  unplanned.state.margin_balances.long.timestamp = 1;
  state = observe(state, unplanned, 6);
  assert.equal(state.data.long.since, 6);
  assert.equal(state.data.short.since, null);
});
