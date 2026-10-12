import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualFundingHistoryCache, fundingHistoryRequestKey, isFundingHistoryReport, startPerpetualFundingHistoryFeed } from '../lib/perpetual-funding-history-feed.ts';
import { fundingWindowTotal } from '../lib/perpetual-funding-history.ts';

const pair = (base = 'BTC') => ({ base, longKey: `a:${base}`, shortKey: `b:${base}` });
const settle = () => new Promise(resolve => setImmediate(resolve));
const leg = (key, at = 1_700_000_000_000, status = 'ready') => {
  const [exchange, symbol] = key.split(':');
  return { key, exchange, symbol, identity: `${key}:v1`, status, fetchedAt: status === 'ready' ? at : null, error: '', coverage: status === 'ready' ? { from: at - 96 * 3_600_000, to: at } : null,
    records: status === 'ready' ? [96, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0].map(hours => ({ time: at - hours * 3_600_000, rate: exchange === 'a' ? .0001 : .0002 })) : [] };
};
const report = (pairs, at = 1_700_000_000_000, status = 'ready') => ({ schemaVersion: 1, generatedAt: at, legs: Object.fromEntries(pairs.flatMap(row => [row.longKey, row.shortKey]).map(key => [key, leg(key, at, status)])) });

function fixture(load = async pairs => report(pairs), cache = createPerpetualFundingHistoryCache()) {
  let now = 0, id = 0;
  const timers = new Map(), requests = [], results = [], errors = [];
  const feed = startPerpetualFundingHistoryFeed({ cache, now: () => now,
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

test('request identity ignores ranking order and quote updates but preserves exact direction and contract', () => {
  assert.equal(fundingHistoryRequestKey([pair(), pair('ETH')]), fundingHistoryRequestKey([pair('ETH'), { ...pair(), price: 123, includeSeries: true }]));
  assert.notEqual(fundingHistoryRequestKey([pair()]), fundingHistoryRequestKey([{ ...pair(), longKey: 'b:BTC', shortKey: 'a:BTC' }]));
  assert.notEqual(fundingHistoryRequestKey([pair()]), fundingHistoryRequestKey([{ ...pair(), longKey: 'a:BTC_USDT' }]));
  assert.equal(JSON.parse(fundingHistoryRequestKey([pair(), pair()])).length, 1);
  assert.equal(JSON.parse(fundingHistoryRequestKey(Array.from({ length: 80 }, (_, index) => pair(String(index))))).length, 30);
});

test('inactive pages read nothing; pending polls after 3 seconds and ready reads after 5 minutes', async () => {
  let pending = true;
  const f = fixture(async pairs => report(pairs, 1_700_000_000_000, pending ? 'pending' : 'ready'));
  f.feed.setPairs([pair()]); await f.advance(300000); assert.equal(f.requests.length, 0);
  f.feed.setActive(true); await settle(); assert.equal(f.requests.length, 1);
  await f.advance(2999); assert.equal(f.requests.length, 1);
  pending = false; await f.advance(1); assert.equal(f.requests.length, 2);
  for (let index = 0; index < 20; index++) f.feed.setPairs([{ ...pair(), price: index }]);
  await f.advance(299999); assert.equal(f.requests.length, 2);
  await f.advance(1); assert.equal(f.requests.length, 3);
  f.feed.stop(); assert.equal(f.timers.size, 0);
});

test('visible selection debounces and continuous changes cannot starve history loading', async () => {
  const f = fixture(); f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  f.feed.setPairs([pair('ETH')]); await f.advance(1000);
  f.feed.setPairs([pair('SOL')]); await f.advance(1199); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests[1].pairs[0].base, 'SOL');
  for (let index = 0; index < 5; index++) { f.feed.setPairs([pair(`TOKEN${index}`)]); await f.advance(1000); }
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2].pairs[0].base, 'TOKEN4');
  f.feed.stop();
});

test('one read remains in flight while changed selection waits, with contract-keyed results', async () => {
  const pending = [];
  const f = fixture(pairs => new Promise(resolve => pending.push(() => resolve(report(pairs)))));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  f.feed.setPairs([pair('ETH')]); await f.advance(1200); assert.equal(f.requests.length, 1);
  pending[0](); await settle(); assert.equal(f.requests.length, 2);
  assert.ok(f.results.at(-1).legs['a:BTC']); assert.equal(f.results.at(-1).legs['a:ETH'], undefined);
  pending[1](); await settle();
  const legs = f.results.at(-1).legs;
  const total = fundingWindowTotal(legs['a:BTC'], legs['b:BTC'], 24, 1_700_000_000_000);
  assert.ok(Math.abs(total.netPercent - .03) < 1e-12);
  assert.ok(Math.abs(fundingWindowTotal(legs['b:BTC'], legs['a:BTC'], 24, 1_700_000_000_000).netPercent + .03) < 1e-12);
  f.feed.stop();
});

test('hidden, offline or inactive state aborts, rejects late data and resumes current selection', async () => {
  const pending = [];
  const f = fixture(pairs => new Promise(resolve => pending.push(() => resolve(report(pairs)))));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  f.feed.setActive(false); assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.timers.size, 0);
  f.feed.setPairs([pair('ETH')]); await f.advance(300000); assert.equal(f.requests.length, 1);
  f.feed.setActive(true); pending[0](); await settle();
  assert.equal(f.results.length, 0); assert.equal(f.requests[1].pairs[0].base, 'ETH');
  pending[1](); await settle(); assert.equal(f.results.at(-1).legs['a:BTC'], undefined);
  f.feed.setPairs([]); await f.advance(120000); assert.equal(f.requests.length, 2);
  f.feed.stop();
});

test('cache retains source timestamps through pending/error refreshes and old server snapshots', async () => {
  let at = 1_700_000_000_000, status = 'ready';
  const f = fixture(async pairs => {
    const result = report(pairs, at, status);
    if (status === 'error') for (const row of Object.values(result.legs)) row.error = 'upstream failed';
    return result;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  const original = f.results.at(-1).legs['a:BTC'];
  status = 'pending'; await f.advance(300000);
  assert.deepEqual(f.results.at(-1).legs['a:BTC'].records, original.records);
  assert.equal(f.results.at(-1).legs['a:BTC'].fetchedAt, original.fetchedAt);
  status = 'error'; await f.advance(3000);
  assert.equal(f.results.at(-1).legs['a:BTC'].error, 'upstream failed');
  assert.deepEqual(f.results.at(-1).legs['a:BTC'].coverage, original.coverage);
  status = 'ready'; at -= 60000; await f.advance(300000);
  assert.deepEqual(f.results.at(-1).legs['a:BTC'].coverage, original.coverage);
  f.feed.stop();
});

test('A to B to A reuses distinct cached legs; cache is capped at 500 and excludes unsolicited legs', async () => {
  const f = fixture(async pairs => { const value = report(pairs); if (pairs.length < 30) value.legs['other:BTC'] = leg('other:BTC'); return value; });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  f.feed.setPairs([pair('ETH')]); await f.advance(1200);
  assert.ok(f.results.at(-1).legs['a:BTC']); assert.ok(f.results.at(-1).legs['a:ETH']);
  assert.equal(f.results.at(-1).legs['other:BTC'], undefined);
  f.feed.setPairs([pair()]); assert.ok(f.results.at(-1).legs['a:BTC']); await f.advance(1200);
  assert.equal(f.requests.length, 2, 'Returning to fresh contracts does not request them again');
  for (let index = 0; index < 9; index++) {
    f.feed.setPairs(Array.from({ length: 30 }, (_, token) => pair(`TOKEN${index * 30 + token}`))); await f.advance(1200);
  }
  assert.equal(Object.keys(f.results.at(-1).legs).length, 500);
  assert.equal(f.results.at(-1).legs['a:BTC'], undefined);
  assert.ok(f.results.at(-1).legs['a:TOKEN269']); f.feed.stop();
});

test('failed/malformed reads preserve data and timeout aborts with a bounded retry', async () => {
  let fail = false;
  const f = fixture(async pairs => fail ? { schemaVersion: 1, generatedAt: 0, legs: [] } : report(pairs));
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  fail = true; await f.advance(300000);
  assert.equal(f.results.length, 1); assert.match(f.errors.at(-1), /保留上次记录/); f.feed.stop();
  const timeout = fixture((_pairs, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  timeout.feed.setPairs([pair()]); timeout.feed.setActive(true);
  await timeout.advance(12000); assert.equal(timeout.requests[0].signal.aborted, true); assert.match(timeout.errors.at(-1), /暂时无法更新/);
  await timeout.advance(60000); assert.equal(timeout.requests.length, 2);
  timeout.feed.stop(); await settle(); assert.equal(timeout.timers.size, 0);
});

test('runtime validation rejects invalid identity, nonfinite data and reversed coverage', () => {
  assert.equal(isFundingHistoryReport(report([pair()])), true);
  for (const change of [row => { row.key = 'wrong:BTC'; }, row => { row.identity = ''; }, row => { row.records[0].rate = NaN; }, row => { row.records[0].rate = 2; }, row => { row.coverage.from = row.coverage.to + 1; }, row => { row.records[0].time = row.coverage.to + 1; }, row => { row.records[0].time += .1; }, row => { row.records.push(row.records[0]); }, row => { row.records = null; }, row => { row.records = Array.from({ length: 2001 }, (_, index) => ({ time: row.coverage.to - index, rate: 0 })); }]) {
    const value = report([pair()]); change(value.legs['a:BTC']); assert.equal(isFundingHistoryReport(value), false);
  }
});

test('changed catalog identity clears prior settlements even when the same contract key is pending', async () => {
  let changed = false;
  const f = fixture(async pairs => {
    const value = report(pairs, 1_700_000_000_000, changed ? 'pending' : 'ready');
    if (changed) value.legs['a:BTC'].identity = 'relisted-market-v2';
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  assert.ok(f.results.at(-1).legs['a:BTC'].records.length);
  changed = true; await f.advance(300000);
  const legs = f.results.at(-1).legs;
  assert.equal(legs['a:BTC'].identity, 'relisted-market-v2');
  assert.equal(legs['a:BTC'].coverage, null); assert.deepEqual(legs['a:BTC'].records, []);
  assert.equal(fundingWindowTotal(legs['a:BTC'], legs['b:BTC'], 24, 1_700_000_000_000).netPercent, null);
  assert.ok(legs['b:BTC'].records.length, 'Unchanged identity retains its own source history');
  f.feed.stop();
});

test('backfill with the same newest timestamp extends coverage without reloading existing windows', async () => {
  let complete = false;
  const f = fixture(async pairs => {
    const value = report(pairs);
    for (const item of Object.values(value.legs)) {
      item.backfillComplete = complete;
      if (complete) {
        item.coverage.from -= 28 * 86_400_000;
        item.records.unshift({ time: item.coverage.from, rate: .0001 });
      }
    }
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  const original = f.results.at(-1).legs['a:BTC'];
  assert.equal(fundingWindowTotal(original, f.results.at(-1).legs['b:BTC'], 24, original.coverage.to).status, 'ready');
  complete = true; await f.advance(3000);
  const extended = f.results.at(-1).legs['a:BTC'];
  assert.equal(extended.coverage.to, original.coverage.to);
  assert.ok(extended.coverage.from < original.coverage.from);
  assert.ok(extended.records.length > original.records.length);
  await f.advance(299999); assert.equal(f.requests.length, 2);
  f.feed.stop();
});

test('a shared cache deduplicates concurrent hooks, survives remount and does not abort remaining subscribers', async () => {
  const cache = createPerpetualFundingHistoryCache();
  let resolve;
  const first = fixture(pairs => new Promise(done => { resolve = () => done(report(pairs)); }), cache);
  const second = fixture(undefined, cache);
  first.feed.setPairs([pair()]); first.feed.setActive(true);
  second.feed.setPairs([pair()]); second.feed.setActive(true);
  assert.equal(first.requests.length, 1); assert.equal(second.requests.length, 0);
  first.feed.stop();
  assert.equal(first.requests[0].signal.aborted, false, 'A remaining subscriber owns the same request');
  resolve(); await settle();
  assert.equal(second.results.at(-1).legs['a:BTC'].status, 'ready');
  second.feed.stop();
  const remounted = fixture(undefined, cache);
  remounted.feed.setPairs([{ ...pair(), longKey: 'b:BTC', shortKey: 'a:BTC' }]); remounted.feed.setActive(true);
  assert.equal(remounted.requests.length, 0);
  assert.ok(remounted.results.at(-1).legs['a:BTC']);
  remounted.feed.stop();
});

test('isolated default server instances never share data and reports preserve persistence errors', async () => {
  const first = fixture(async pairs => ({ ...report(pairs), storageError: '历史缓存保存失败' }));
  const second = fixture();
  first.feed.setPairs([pair()]); first.feed.setActive(true); await settle();
  assert.equal(first.results.at(-1).storageError, '历史缓存保存失败');
  second.feed.setPairs([pair()]); second.feed.setActive(true); await settle();
  assert.equal(second.requests.length, 1);
  first.feed.stop(); second.feed.stop();
});

test('unsupported funding with incomplete coverage does not stay on the backfill short poll', async () => {
  const f = fixture(async pairs => {
    const value = report(pairs, 1_700_000_000_000, 'unsupported');
    for (const item of Object.values(value.legs)) item.backfillComplete = false;
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  await f.advance(299999); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests.length, 2);
  f.feed.stop();
});
