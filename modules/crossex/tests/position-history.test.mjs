import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITION_HISTORY_WINDOW_MS, POSITION_HISTORY_BUCKET_MS, POSITION_HISTORY_GAP_MS, POSITION_HISTORY_MAX_POINTS,
  positionHistoryIdentity, positionHistorySamples, positionHistoryHasGap, updatePositionHistory,
} from '../src/position-history.ts';

const minute = POSITION_HISTORY_BUCKET_MS;
const start = 1_800_000_000_000;
const scope = JSON.stringify(['account-a', 1]);
const leg = (changes = {}) => ({ id: 'position-a', symbol: 'BINANCE_PERP_BTC_USDT', side: 'LONG', openedAt: start - minute, baseQuantity: '0.1', entryPrice: '100', ...changes });
const group = (changes = {}) => ({ base: 'BTC', legs: [leg(), leg({ id: 'position-b', symbol: 'OKX_PERP_BTC_USDT', side: 'SHORT' })], metrics: { currentSpread: '0.00123' }, ...changes });
const update = (previous, groups = [group()], changes = {}) => updatePositionHistory(previous, groups, { scope, at: start, now: start, stale: false, partial: false, ...changes });
const samples = state => state.series.BTC.samples;

test('session starts only at its first real observation and deduplicates timestamps', () => {
  const first = update(null);
  assert.deepEqual(samples(first), [{ at: start, spread: '0.00123' }]);
  assert.equal(update(first), first);
  assert.equal(update(first, [group({ metrics: { currentSpread: '9' } })]), first, 'same asOf cannot rewrite an observation');
  assert.equal(update(first, [group()], { at: start - 1 }), first, 'out-of-order snapshots cannot rewrite history');
  assert.deepEqual(samples(update(null, [group()], { at: null })), []);
});

test('minute buckets retain the latest observation without mutating earlier state', () => {
  const first = update(null);
  const next = update(first, [group({ metrics: { currentSpread: '0.001234567890123456789' } })], { at: start + 10_000, now: start + 10_000 });
  assert.deepEqual(samples(first), [{ at: start, spread: '0.00123' }]);
  assert.deepEqual(samples(next), [{ at: start + 10_000, spread: '0.001234567890123456789' }]);
  const later = update(next, [group()], { at: start + minute, now: start + minute });
  assert.equal(samples(later).length, 2);
});

test('24-hour retention trims old observations even while reads are stale', () => {
  const first = update(null);
  const boundary = update(first, [group()], { at: start + POSITION_HISTORY_WINDOW_MS, now: start + POSITION_HISTORY_WINDOW_MS });
  assert.equal(samples(boundary).length, 2);
  const pruned = update(boundary, [group()], { now: start + POSITION_HISTORY_WINDOW_MS + 1, stale: true });
  assert.deepEqual(samples(pruned), [{ at: start + POSITION_HISTORY_WINDOW_MS, spread: '0.00123' }]);
  const expired = update(pruned, [group()], { now: start + 2 * POSITION_HISTORY_WINDOW_MS + 1, partial: true });
  assert.deepEqual(samples(expired), []);
});

test('frequent sampling is bounded to 1440 observations per group', () => {
  let state = null;
  for (let index = 0; index <= POSITION_HISTORY_MAX_POINTS; index += 1) {
    state = update(state, [group()], { at: start + index * minute, now: start + index * minute });
    state = update(state, [group()], { at: start + index * minute + 1, now: start + index * minute + 1 });
  }
  assert.equal(samples(state).length, POSITION_HISTORY_MAX_POINTS);
  assert.equal(samples(state)[0].at, start + minute + 1);
  assert.equal(samples(state).at(-1).at, start + POSITION_HISTORY_MAX_POINTS * minute + 1);
});

test('account and connection version changes cannot expose the previous session', () => {
  const first = update(null);
  for (const nextScope of [JSON.stringify(['account-b', 1]), JSON.stringify(['account-a', 2])]) {
    assert.deepEqual(positionHistorySamples(first, group(), nextScope), []);
    const changed = update(first, [group()], { scope: nextScope, at: start + minute, now: start + minute });
    assert.deepEqual(samples(changed), [{ at: start + minute, spread: '0.00123' }]);
  }
});

test('position identity is order independent and resets for replacement, resize, or repricing', () => {
  const original = group(), first = update(null, [original]);
  assert.equal(positionHistoryIdentity({ ...original, legs: [...original.legs].reverse() }), positionHistoryIdentity(original));
  assert.equal(update(first, [{ ...original, legs: [...original.legs].reverse() }]), first);
  for (const change of [
    { id: 'replacement' }, { symbol: 'BYBIT_PERP_BTC_USDT' }, { side: 'SHORT' },
    { openedAt: start }, { baseQuantity: '0.2' }, { entryPrice: '101' },
  ]) {
    const changed = group({ legs: [leg(change), original.legs[1]] });
    assert.deepEqual(positionHistorySamples(first, changed, scope), []);
    assert.deepEqual(samples(update(first, [changed], { at: start + minute, now: start + minute })), [{ at: start + minute, spread: '0.00123' }]);
  }
  const added = group({ legs: [...original.legs, leg({ id: 'position-c' })] });
  assert.deepEqual(positionHistorySamples(first, added, scope), []);
  assert.deepEqual(positionHistorySamples(first, group({ legs: [original.legs[0]] }), scope), []);
});

test('disappearing groups are removed and reappearance begins a new observation series', () => {
  const first = update(null);
  const removed = update(first, []);
  assert.deepEqual(Object.keys(removed.series), []);
  const returned = update(removed, [group()], { at: start + minute, now: start + minute });
  assert.deepEqual(samples(returned), [{ at: start + minute, spread: '0.00123' }]);
});

test('stale, partial, missing, future, and expired timestamps never add observations', () => {
  const first = update(null);
  for (const flags of [
    { stale: true }, { partial: true }, { at: null }, { at: NaN }, { at: Infinity },
    { at: -1 }, { at: start + 2 * minute }, { now: NaN },
  ]) {
    const rejected = update(first, [group()], { at: start + minute, now: start + minute, ...flags });
    assert.deepEqual(samples(rejected), samples(first));
  }
  assert.deepEqual(samples(update(null, [group()], { now: start + POSITION_HISTORY_WINDOW_MS + 1 })), []);
});

test('missing spread remains a visible null and cannot be erased in its minute', () => {
  let state = update(null);
  state = update(state, [group({ metrics: { currentSpread: null } })], { at: start + minute, now: start + minute });
  state = update(state, [group()], { at: start + minute + 10_000, now: start + minute + 10_000 });
  assert.deepEqual(samples(state), [{ at: start, spread: '0.00123' }, { at: start + minute, spread: null }]);
  state = update(state, [group()], { at: start + 2 * minute, now: start + 2 * minute });
  assert.equal(positionHistoryHasGap(samples(state)[0], samples(state)[1]), true);
  assert.equal(positionHistoryHasGap(samples(state)[1], samples(state)[2]), true);
  for (const value of ['', ' ', 'NaN', 'Infinity', 'broken', '0x10', '1e9999']) {
    assert.equal(samples(update(null, [group({ metrics: { currentSpread: value } })]))[0].spread, null);
  }
  for (const value of ['0', '-0.01', '0.0000000000000000001', '1e-9']) {
    assert.equal(samples(update(null, [group({ metrics: { currentSpread: value } })]))[0].spread, value);
  }
});

test('recovery after a gap over five minutes never draws a continuous line', () => {
  let state = update(null);
  state = update(state, [group()], { at: start + minute, now: start + minute, stale: true });
  state = update(state, [group()], { at: start + POSITION_HISTORY_GAP_MS + 1, now: start + POSITION_HISTORY_GAP_MS + 1 });
  assert.equal(samples(state).length, 2);
  assert.equal(positionHistoryHasGap(samples(state)[0], samples(state)[1]), true);
  assert.equal(positionHistoryHasGap(samples(state)[0], { at: start + POSITION_HISTORY_GAP_MS, spread: '1' }), false);
});
