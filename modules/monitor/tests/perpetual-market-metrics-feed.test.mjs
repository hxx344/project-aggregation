import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualMarketMetricsCache, isPerpetualMarketMetricsReport, startPerpetualMarketMetricsFeed } from '../lib/perpetual-market-metrics-feed.ts';

const anchor = 1_700_000_000_000;
const pair = (base = 'BTC') => ({ base, longKey: `a:${base}`, shortKey: `b:${base}` });
const settle = () => new Promise(resolve => setImmediate(resolve));
const metric = (value = 0, currency = 'USDT', at = anchor) => ({ value, currency: value === null ? null : currency, observedAt: value === null ? null : at, source: 'official public ticker', error: '' });
function report(pairs, status = 'ready') {
  return { schemaVersion: 1, generatedAt: anchor, legs: Object.fromEntries(pairs.flatMap(pair => [pair.longKey, pair.shortKey]).map(key => {
    const [exchange, symbol] = key.split(':');
    return [key, { key, exchange, symbol, identity: `${key}:v1`, status, fetchedAt: status === 'ready' ? anchor : null, error: '', volume24h: metric(status === 'ready' ? 0 : null), openInterest: metric(status === 'ready' ? 12_500_000 : null, 'USDC') }];
  })) };
}
function fixture(load = async pairs => report(pairs), cache = createPerpetualMarketMetricsCache()) {
  let now = 0, id = 0;
  const timers = new Map(), requests = [], results = [], errors = [];
  const feed = startPerpetualMarketMetricsFeed({
    cache, now: () => now,
    load: (pairs, signal) => { requests.push({ pairs, signal }); return load(pairs, signal); },
    onData: value => results.push(value), onError: error => errors.push(error), onLoading() {},
    schedule: (callback, delay) => { const timer = ++id; timers.set(timer, { callback, at: now + delay }); return timer; },
    cancel: timer => timers.delete(timer),
  });
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
    }
    now = target; await settle();
  }
  return { feed, requests, results, errors, timers, advance };
}

test('metrics validate true zero, independent currencies and unavailable values', () => {
  const value = report([pair()]);
  assert.equal(isPerpetualMarketMetricsReport(value), true);
  assert.equal(value.legs['a:BTC'].volume24h.value, 0);
  value.legs['a:BTC'].openInterest = metric(null);
  assert.equal(isPerpetualMarketMetricsReport(value), true);
  for (const change of [leg => { leg.identity = ''; }, leg => { leg.key = 'wrong:BTC'; }, leg => { leg.volume24h.value = NaN; }, leg => { leg.volume24h.value = -1; }, leg => { leg.volume24h.currency = null; }, leg => { leg.volume24h.observedAt = null; }, leg => { leg.openInterest.source = null; }]) {
    const invalid = report([pair()]); change(invalid.legs['a:BTC']); assert.equal(isPerpetualMarketMetricsReport(invalid), false);
  }
});

test('pending polls only local cache and completed metrics reuse contracts for thirty seconds', async () => {
  let pending = true;
  const f = fixture(async pairs => report(pairs, pending ? 'pending' : 'ready'));
  f.feed.setPairs([pair()]); await f.advance(1000); assert.equal(f.requests.length, 0);
  f.feed.setActive(true); await settle();
  pending = false; await f.advance(3000); assert.equal(f.requests.length, 2);
  f.feed.setPairs([pair('ETH')]); await f.advance(1200); assert.equal(f.requests.length, 3);
  f.feed.setPairs([{ ...pair(), longKey: 'b:BTC', shortKey: 'a:BTC', price: 200 }]);
  await f.advance(28799); assert.equal(f.requests.length, 3);
  await f.advance(1); assert.equal(f.requests.length, 4);
  f.feed.stop(); assert.equal(f.timers.size, 0);
});

test('partial refresh failure retains only the failed metric with its original timestamp and currency', async () => {
  let changed = false;
  const f = fixture(async pairs => {
    const value = report(pairs);
    if (changed) {
      for (const leg of Object.values(value.legs)) {
        leg.volume24h = metric(99, 'USDT', anchor + 300_000);
        leg.openInterest = { ...metric(null), error: 'interest upstream failed' };
        leg.fetchedAt = anchor + 300_000;
      }
    }
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  changed = true; await f.advance(300_000);
  const leg = f.results.at(-1).legs['a:BTC'];
  assert.equal(leg.volume24h.value, 99); assert.equal(leg.volume24h.observedAt, anchor + 300_000);
  assert.equal(leg.openInterest.value, 12_500_000); assert.equal(leg.openInterest.currency, 'USDC');
  assert.equal(leg.openInterest.observedAt, anchor); assert.equal(leg.openInterest.error, 'interest upstream failed');
  f.feed.stop();
});

test('changed identity clears cached values while failed and malformed reads retain source data', async () => {
  let state = 'ready';
  const f = fixture(async pairs => {
    if (state === 'malformed') return { schemaVersion: 1, generatedAt: anchor, legs: [] };
    const value = report(pairs, state === 'identity' ? 'pending' : 'ready');
    if (state === 'identity') value.legs['a:BTC'].identity = 'relisted:v2';
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  state = 'malformed'; await f.advance(300_000);
  assert.equal(f.results.length, 1); assert.match(f.errors.at(-1), /保留上次数值/);
  state = 'identity'; await f.advance(60_000);
  assert.equal(f.results.at(-1).legs['a:BTC'].volume24h.value, null);
  assert.equal(f.results.at(-1).legs['a:BTC'].identity, 'relisted:v2');
  assert.equal(f.results.at(-1).legs['b:BTC'].volume24h.value, 0);
  f.feed.stop();
});

test('two subscribers share an in-flight read and a remount restores completed metrics', async () => {
  const cache = createPerpetualMarketMetricsCache();
  let resolve;
  const a = fixture(pairs => new Promise(done => { resolve = () => done(report(pairs)); }), cache), b = fixture(undefined, cache);
  a.feed.setPairs([pair()]); a.feed.setActive(true);
  b.feed.setPairs([pair()]); b.feed.setActive(true);
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 0);
  a.feed.stop(); assert.equal(a.requests[0].signal.aborted, false);
  resolve(); await settle(); b.feed.stop();
  const remount = fixture(undefined, cache); remount.feed.setPairs([pair()]); remount.feed.setActive(true);
  assert.equal(remount.requests.length, 0); assert.equal(remount.results.at(-1).legs['a:BTC'].volume24h.value, 0);
  remount.feed.stop();
});

test('timeout releases even a loader that ignores cancellation and permits bounded retry', async () => {
  const f = fixture(() => new Promise(() => {}));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  await f.advance(12_000);
  assert.equal(f.requests[0].signal.aborted, true); assert.match(f.errors.at(-1), /暂时无法更新/);
  await f.advance(60_000); assert.equal(f.requests.length, 2);
  f.feed.stop(); await settle(); assert.equal(f.timers.size, 0);
});
