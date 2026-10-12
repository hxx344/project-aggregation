import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { startPerpetualPriceHistoryFeed, validatePerpetualPriceHistory, perpetualPriceIdentity } from '../lib/perpetual-price-history.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 11, 12);
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'aster:BTCUSDT' };
const second = { base: 'ETH', longKey: 'binance:ETHUSDT', shortKey: 'aster:ETHUSDT' };
function report(selected = pair, overrides = {}) {
  return { schemaVersion: 1, generatedAt: NOW, intervalMs: HOUR, legs: Object.fromEntries([selected.longKey, selected.shortKey].map(key => {
    const split = key.indexOf(':'), market = { exchange: key.slice(0, split), symbol: key.slice(split + 1), base: selected.base, quoteCurrency: 'USDT' };
    return [key, { key, identity: perpetualPriceIdentity(market), exchange: market.exchange, symbol: market.symbol, currency: 'USDT', status: 'ready', from: NOW - 30 * 24 * HOUR, to: NOW, fetchedAt: NOW, points: [{ time: NOW, close: 100 }], error: '', backfillComplete: true, ...overrides }];
  })) };
}
function fixture(t, load) {
  let now = NOW;
  const tasks = new Map(), data = [], errors = [], calls = [];
  const feed = startPerpetualPriceHistoryFeed({ now: () => now, load: (...args) => { calls.push(args); return load(...args); }, onData: value => data.push(value), onError: error => errors.push(error), onLoading: () => {}, schedule: (fn, delay) => { const token = {}; tasks.set(token, { fn, at: now + delay }); return token; }, cancel: token => tasks.delete(token) });
  t.after(() => feed.stop());
  return { feed, data, errors, calls, tasks, tick: async ms => { now += ms; const due = [...tasks].filter(([, task]) => task.at <= now); for (const [token, task] of due) { tasks.delete(token); task.fn(); } await turn(); }, last: () => data.at(-1) };
}
test('selected only; null/disabled makes no calls; window and direction reuse one report', async t => {
  const f = fixture(t, async selected => report(selected));
  f.feed.setSelection(null, 7); f.feed.setActive(true); assert.equal(f.calls.length, 0);
  f.feed.setActive(false); f.feed.setSelection(pair, 7); assert.equal(f.calls.length, 0);
  f.feed.setActive(true); await turn(); assert.equal(f.calls.length, 1);
  f.feed.setSelection(pair, 30); f.feed.setSelection({ ...pair, longKey: pair.shortKey, shortKey: pair.longKey }, 3); await turn();
  assert.equal(f.calls.length, 1); assert.equal(f.last().legs[pair.longKey].points[0].close, 100);
  await f.tick(60_000); assert.equal(f.calls.length, 2);
  await f.tick(60_000); assert.equal(f.calls.length, 3);
});
test('pair switches abort pending read and ignore late noncooperative results', async t => {
  const pending = [];
  const f = fixture(t, (selected, _days, signal) => new Promise(resolve => pending.push({ selected, signal, resolve })));
  f.feed.setSelection(pair, 7); f.feed.setActive(true); f.feed.refresh(); assert.equal(pending.length, 1);
  f.feed.setSelection(second, 7); assert.equal(pending[0].signal.aborted, true); assert.equal(f.last(), null);
  pending[1].resolve(report(second)); await turn(); pending[0].resolve(report(pair)); await turn();
  assert.equal(f.last().legs[second.longKey].symbol, 'ETHUSDT'); assert.equal(f.last().legs[pair.longKey], undefined);
});
test('pending polls at three seconds, stop aborts and suppresses callbacks', async t => {
  let pendingResolve;
  const f = fixture(t, async (_selected, _days, signal) => {
    if (f.calls.length > 1) return new Promise(resolve => { pendingResolve = resolve; signal.addEventListener('abort', () => {}); });
    return report(pair, { status: 'pending', backfillComplete: false });
  });
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); await f.tick(2999); assert.equal(f.calls.length, 1); await f.tick(1); assert.equal(f.calls.length, 2);
  const count = f.data.length; f.feed.stop(); pendingResolve(report()); await turn(); assert.equal(f.data.length, count); assert.equal(f.tasks.size, 0);
});
test('request failure retains data, backoffs, and allows recovery', async t => {
  let fail = false;
  const f = fixture(t, async () => { if (fail) throw Error('unavailable'); return report(); });
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); const previous = f.last();
  fail = true; await f.tick(60_000); assert.equal(f.last(), previous); assert.match(f.errors.at(-1), /保留/);
  await f.tick(1000); assert.equal(f.calls.length, 2); fail = false; await f.tick(59_000); assert.equal(f.calls.length, 3); assert.equal(f.errors.at(-1), '');
});
test('missing/unrelated legs or malformed transport are rejected before publish', async t => {
  const f = fixture(t, async () => report(second));
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); assert.equal(f.last(), null); assert.ok(f.errors.at(-1));
  for (const transform of [r => { r.intervalMs = 1000; }, r => { r.legs[pair.longKey].points.push({ time: NOW, close: 100 }); }, r => { r.legs[pair.longKey].points[0].close = 0; }, r => { r.legs[pair.longKey].to = NOW + HOUR; }, r => { r.legs[pair.longKey].identity = '[]'; }, r => { r.legs[pair.longKey].fetchedAt = NOW + HOUR; }]) {
    const value = report(); transform(value); assert.equal(validatePerpetualPriceHistory(value, NOW), false);
  }
});
test('fresh identity discards old prices; same identity failed report can retain prior validated cache', async t => {
  let result = report(); const f = fixture(t, async () => result);
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn();
  result = report(pair, { points: [], status: 'error', from: null, to: null, fetchedAt: null, backfillComplete: false, error: 'failure' });
  await f.tick(60_000); assert.equal(f.last().legs[pair.longKey].points.length, 1);
  result = report(pair, { points: [], status: 'pending', from: null, to: null, fetchedAt: null, backfillComplete: false });
  for (const leg of Object.values(result.legs)) { const identity = JSON.parse(leg.identity); identity[5] = 1000; leg.identity = JSON.stringify(identity); }
  await f.tick(60_000); assert.equal(f.last().legs[pair.longKey].points.length, 0);
});
