import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityRequestKey, startPerpetualQualityFeed } from '../lib/perpetual-quality-feed.ts';

const pair = (base = 'BTC', short = 'b') => ({ base, longKey: `a:${base}`, shortKey: `${short}:${base}` });
const report = generatedAt => ({ schemaVersion: 1, generatedAt, sampleIntervalMs: 60000, priceWindowMs: 3600000, fundingWindowMs: 86400000, pairs: {}, assets: {}, assetErrors: {}, positioning: {}, positioningErrors: {} });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only the inspected pair requests minute series and selection changes the cache identity', () => {
  const plain = qualityRequestKey([pair(), pair('ETH')]);
  const selected = JSON.parse(qualityRequestKey([{ ...pair(), includeSeries: true }, { ...pair('ETH'), includeSeries: true }]));
  assert.equal(selected.filter(row => row.includeSeries).length, 1);
  assert.equal(selected.find(row => row.base === 'BTC').includeSeries, true);
  assert.notEqual(plain, JSON.stringify(selected));
});

function fixture(load = async () => report(1)) {
  let now = 0, id = 0;
  const timers = new Map(), requests = [], results = [], errors = [];
  const feed = startPerpetualQualityFeed({
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

test('only distinct current-page identities are requested, not ranking order or quote changes', async () => {
  assert.equal(qualityRequestKey([pair(), pair('ETH')]), qualityRequestKey([pair('ETH'), { ...pair(), price: 123, now: 999 }]));
  assert.equal(JSON.parse(qualityRequestKey(Array.from({ length: 50 }, (_, index) => pair(String(index))))).length, 30);
  const f = fixture(); f.feed.setPairs([pair(), pair('ETH')]); await f.advance(60000);
  assert.equal(f.requests.length, 0);
  f.feed.setActive(true); await settle();
  for (let index = 0; index < 20; index++) f.feed.setPairs([pair('ETH'), pair()]);
  await f.advance(59999); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests.length, 2);
  f.feed.stop(); assert.equal(f.timers.size, 0);
});

test('pair changes debounce while continuous changes cannot starve collection', async () => {
  const f = fixture(); f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  f.feed.setPairs([pair('ETH')]); await f.advance(1000);
  f.feed.setPairs([pair('SOL')]); await f.advance(1199); assert.equal(f.requests.length, 1);
  await f.advance(1); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].pairs[0].base, 'SOL');
  for (let index = 0; index < 5; index++) { f.feed.setPairs([pair(`TOKEN${index}`)]); await f.advance(1000); }
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2].pairs[0].base, 'TOKEN4');
  f.feed.stop();
});

test('changed combinations wait for the in-flight request, with no overlapping reads', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  f.feed.setPairs([pair('ETH')]); await f.advance(1200);
  assert.equal(f.requests.length, 1);
  pending[0](report(1)); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].pairs[0].base, 'ETH');
  pending[1](report(2)); await settle(); f.feed.stop();
});

test('hidden or inactive state cancels, rejects late results, and resumes the latest selection immediately', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  const firstSignal = f.requests[0].signal;
  f.feed.setActive(false); assert.equal(firstSignal.aborted, true); assert.equal(f.timers.size, 0);
  f.feed.setPairs([pair('ETH')]); await f.advance(60000); assert.equal(f.requests.length, 1);
  f.feed.setActive(true); assert.equal(f.requests.length, 1);
  pending[0](report(1)); await settle();
  assert.equal(f.results.length, 0); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].pairs[0].base, 'ETH');
  pending[1](report(2)); await settle(); assert.equal(f.results[0].generatedAt, 2);
  f.feed.stop(); await f.advance(120000); assert.equal(f.requests.length, 2);
});

test('empty pages stop reads and failures retain prior data until the next bounded refresh', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw Error('offline'); return report(1); });
  f.feed.setActive(true); f.feed.setPairs([pair()]); await settle(); assert.equal(f.results.length, 1);
  fail = true; await f.advance(60000);
  assert.equal(f.requests.length, 2); assert.equal(f.results.length, 1); assert.match(f.errors.at(-1), /保留上次记录/);
  f.feed.setPairs([]); await f.advance(120000); assert.equal(f.requests.length, 2);
  fail = false; f.feed.setPairs([pair('ETH')]); await settle(); assert.equal(f.requests.length, 3);
  f.feed.stop();
});

test('timed-out reads abort and do not permanently stop refresh', async () => {
  const f = fixture((_pairs, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  f.feed.setPairs([pair()]); f.feed.setActive(true);
  await f.advance(12000); assert.equal(f.requests[0].signal.aborted, true); assert.match(f.errors.at(-1), /暂时无法更新/);
  await f.advance(60000); assert.equal(f.requests.length, 2);
  f.feed.stop(); await settle(); assert.equal(f.timers.size, 0);
});

test('page A to B to A and a hidden resume retain cached evidence while a new read is pending', async () => {
  let fail = false;
  const f = fixture(async pairs => {
    if (fail) throw Error('offline');
    const value = report(10000);
    for (const row of pairs) value.assets[row.base] = { updatedAt: 10000, marketCapUsd: 100 };
    return value;
  });
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  f.feed.setPairs([pair('ETH')]); await f.advance(1200);
  assert.ok(f.results.at(-1).assets.BTC);
  assert.ok(f.results.at(-1).assets.ETH);
  const count = f.requests.length;
  f.feed.setPairs([pair()]);
  assert.equal(f.requests.length, count, 'Selection keeps bounded debounce');
  assert.ok(f.results.at(-1).assets.BTC, 'Previously visited page is already available');
  f.feed.setActive(false); f.feed.setPairs([]); await f.advance(120000);
  assert.equal(f.requests.length, count, 'Hidden panels perform no reads');
  fail = true;
  f.feed.setPairs([pair()]); f.feed.setActive(true); await settle();
  assert.equal(f.requests.length, count + 1, 'Returning refreshes immediately');
  assert.equal(f.results.at(-1).assets.BTC.updatedAt, 10000, 'Failed refresh retains the original source time');
  f.feed.stop();
});
