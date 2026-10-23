import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPairNoticeStore } from '../lib/pair-notice-store.ts';

function pair(timestamp = 100, state = {}) {
  return {
    id: 'pair-a',
    enabled: true,
    ordinary: { enabled: true },
    margin: { enabled: false },
    state: {
      phase: 'waiting',
      updated_at: timestamp,
      snapshots: {
        long: { timestamp, positions: [] },
        short: { timestamp, positions: [] },
      },
      ...state,
    },
  };
}

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let milliseconds = 0;
  return {
    read: () => milliseconds / 1000,
    advance(delta) {
      milliseconds += delta;
      t.mock.timers.tick(delta);
    },
  };
}

function watch(t, time) {
  const store = createPairNoticeStore(time.read);
  const listener = t.mock.fn();
  const unsubscribe = store.subscribe(listener);
  t.after(unsubscribe);
  return { store, listener, unsubscribe };
}

const state = (store) => store.getSnapshot().get('pair-a');

for (const offline of [false, true]) {
  test(`${offline ? 'offline' : 'stale'} data confirms after three seconds without another input update`, (t) => {
    const time = clock(t);
    const { store, listener } = watch(t, time);
    store.update([pair(offline ? 100 : 1)], 100, offline);
    assert.deepEqual(state(store).current, []);
    assert.deepEqual(state(store).history.entries, []);
    const initialNotifications = listener.mock.callCount();

    time.advance(2999);
    assert.equal(listener.mock.callCount(), initialNotifications);
    assert.deepEqual(state(store).current, []);
    assert.deepEqual(state(store).history.entries, []);

    time.advance(1);
    assert.equal(listener.mock.callCount(), initialNotifications + 1);
    assert.equal(state(store).current[0].kind, 'data');
    const [entry] = state(store).history.entries;
    assert.equal(entry.key, state(store).current[0].key);
    assert.equal(entry.firstSeen, 103);
    assert.equal(entry.lastSeen, 103);
    assert.equal(entry.occurrences, 1);
  });
}

test('recovery cancels the pending callback and a later outage gets its own full delay', (t) => {
  const time = clock(t);
  const { store, listener } = watch(t, time);
  store.update([pair()], 100, true);
  time.advance(2000);
  store.update([pair(102)], 102, false);
  const recovered = store.getSnapshot();
  const recoveryNotifications = listener.mock.callCount();

  time.advance(1000);
  assert.equal(store.getSnapshot(), recovered);
  assert.equal(listener.mock.callCount(), recoveryNotifications);
  assert.deepEqual(state(store).history.entries, []);

  store.update([pair(103)], 103, true);
  time.advance(2999);
  assert.deepEqual(state(store).current, []);
  assert.deepEqual(state(store).history.entries, []);
  time.advance(1);
  assert.equal(state(store).current[0].kind, 'data');
  assert.equal(state(store).history.entries[0].firstSeen, 106);
});

test('removing a pair cancels its deadline and reusing its id starts a new observation', (t) => {
  const time = clock(t);
  const { store, listener } = watch(t, time);
  store.update([pair(1)], 100, false);
  time.advance(1000);
  store.update([], 101, false);
  const removed = store.getSnapshot();
  const removalNotifications = listener.mock.callCount();

  time.advance(2000);
  assert.equal(store.getSnapshot(), removed);
  assert.equal(listener.mock.callCount(), removalNotifications);
  assert.equal(store.getSnapshot().size, 0);

  store.update([pair(1)], 103, false);
  time.advance(2999);
  assert.deepEqual(state(store).history.entries, []);
  time.advance(1);
  assert.equal(state(store).history.entries[0].firstSeen, 106);
});

test('the last unsubscribe stops the timer and resubscribing resumes the original observation', (t) => {
  const time = clock(t);
  const { store, listener, unsubscribe } = watch(t, time);
  store.update([pair(1)], 100, false);
  time.advance(1000);
  unsubscribe();
  const unmounted = store.getSnapshot();
  const notifications = listener.mock.callCount();

  time.advance(4000);
  assert.equal(store.getSnapshot(), unmounted);
  assert.equal(listener.mock.callCount(), notifications);
  assert.deepEqual(state(store).history.entries, []);

  const resumedListener = t.mock.fn();
  t.after(store.subscribe(resumedListener));
  time.advance(1);
  assert.equal(resumedListener.mock.callCount(), 1);
  assert.equal(listener.mock.callCount(), notifications);
  assert.equal(state(store).current[0].kind, 'data');
  assert.equal(state(store).history.entries[0].firstSeen, 105.001);
});

test('workspaces with the same pair id keep independent deadlines and histories', (t) => {
  const time = clock(t);
  const first = watch(t, time).store;
  const second = watch(t, time).store;
  first.update([pair(1)], 100, false);
  time.advance(1000);
  second.update([pair(1)], 101, false);

  time.advance(2000);
  assert.equal(state(first).current[0].kind, 'data');
  assert.equal(state(first).history.entries[0].firstSeen, 103);
  assert.deepEqual(state(second).current, []);
  assert.deepEqual(state(second).history.entries, []);

  first.update([pair(103)], 103, false);
  first.clear('pair-a');
  time.advance(1000);
  assert.deepEqual(state(first).history.entries, []);
  assert.deepEqual(state(first).current, []);
  assert.equal(state(second).current[0].kind, 'data');
  assert.equal(state(second).history.entries[0].firstSeen, 104);
});

test('clearing past notices neither confirms nor restarts a pending data warning', (t) => {
  const time = clock(t);
  const { store } = watch(t, time);
  store.update(
    [pair(100, { api_notice: { kind: 'rate_limit', text: 'API 限流' } })],
    100,
    false,
  );
  assert.equal(state(store).history.entries[0].kind, 'api');
  time.advance(1000);
  store.update([pair(1)], 101, false);
  assert.deepEqual(state(store).current, []);
  time.advance(1000);
  store.clear('pair-a');
  assert.deepEqual(state(store).history.entries, []);
  assert.deepEqual(state(store).current, []);

  time.advance(1999);
  assert.deepEqual(state(store).history.entries, []);
  assert.deepEqual(state(store).current, []);
  time.advance(1);
  assert.equal(state(store).current[0].kind, 'data');
  assert.equal(state(store).history.entries[0].firstSeen, 104);
  assert.equal(state(store).history.entries[0].occurrences, 1);
});
