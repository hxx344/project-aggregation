import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualQualityCache } from '../lib/perpetual-quality-cache.ts';

const pair = (base = 'BTC', short = 'b') => ({ base, longKey: `a:${base}`, shortKey: `${short}:${base}` });
const key = row => JSON.stringify([row.base, row.longKey, row.shortKey]);
function report(row, at = 10000) {
  return {
    schemaVersion: 1, generatedAt: at, sampleIntervalMs: 60000, priceWindowMs: 3600000, fundingWindowMs: 86400000,
    pairs: { [key(row)]: { ...row, identity: row.base, spread: { lastAt: at, samples: 60 }, funding: { lastAt: at, samples: 288 }, convergence: { lastAt: at, samples: 288 }, priceSeries: [[at, 1]] } },
    assets: { [row.base]: { updatedAt: at, marketCapUsd: 100 } }, assetErrors: {},
    positioning: { [row.longKey]: { observedAt: at, longRatio: 0 }, [row.shortKey]: { observedAt: at, longRatio: .5 }, [`c:${row.base}`]: { observedAt: at, longRatio: .4 } },
    positioningErrors: {}, positioningOverview: { [row.base]: { observedAt: at, constituents: [{ key: `c:${row.base}` }] } },
  };
}

test('visiting another page retains the first page without renewing any source timestamp', () => {
  const cache = createPerpetualQualityCache(), btc = pair(), eth = pair('ETH');
  const first = cache.accept(report(btc), [btc]);
  const second = cache.accept(report(eth, 200000), [eth]);
  assert.equal(second.pairs[key(btc)], first.pairs[key(btc)]);
  assert.equal(second.assets.BTC.updatedAt, 10000);
  assert.equal(second.positioning[btc.longKey].observedAt, 10000);
  assert.equal(second.positioning[btc.longKey].longRatio, 0);
  assert.equal(second.positioningOverview.BTC.observedAt, 10000);
  assert.deepEqual(second.pairs[key(btc)].priceSeries, [[10000, 1]]);
  assert.equal(second.pairs[key(btc)].convergence.lastAt, 10000);
  assert.deepEqual(Object.keys(first.pairs), [key(btc)], 'Previous React snapshots remain immutable');
});

test('a refreshed scope replaces missing and changed evidence instead of reviving old values', () => {
  const cache = createPerpetualQualityCache(), btc = pair(), eth = pair('ETH');
  cache.accept(report(btc), [btc]); cache.accept(report(eth), [eth]);
  const missing = { ...report(btc, 20000), pairs: {}, assets: {}, positioning: {}, positioningOverview: {}, assetErrors: { BTC: 'unmapped' }, positioningErrors: { [btc.longKey]: 'unavailable' } };
  const result = cache.accept(missing, [btc]);
  assert.equal(result.pairs[key(btc)], undefined);
  assert.equal(result.assets.BTC, undefined);
  assert.equal(result.positioning[btc.shortKey], undefined);
  assert.equal(result.positioning['c:BTC'], undefined);
  assert.equal(result.positioningOverview.BTC, undefined);
  assert.equal(result.assetErrors.BTC, 'unmapped');
  assert.equal(result.positioningErrors[btc.longKey], 'unavailable');
  assert.ok(result.pairs[key(eth)]);
  const changed = report(btc, 30000); changed.pairs[key(btc)].identity = 'new-unit';
  const refreshed = cache.accept(changed, [btc]);
  assert.equal(refreshed.pairs[key(btc)].identity, 'new-unit');
  assert.equal(refreshed.assetErrors.BTC, undefined);
  assert.equal(refreshed.positioningErrors[btc.longKey], undefined);
});

test('the cache evicts least recently refreshed combinations and their unreferenced data', () => {
  const cache = createPerpetualQualityCache(2), btc = pair(), eth = pair('ETH'), sol = pair('SOL');
  cache.accept(report(btc), [btc]); cache.accept(report(eth), [eth]);
  cache.accept(report(btc, 20000), [btc]);
  const result = cache.accept(report(sol, 30000), [sol]);
  assert.deepEqual(new Set(Object.keys(result.pairs)), new Set([key(btc), key(sol)]));
  for (const field of ['assets', 'assetErrors', 'positioningOverview']) assert.equal(result[field].ETH, undefined);
  for (const id of ['a:ETH', 'b:ETH', 'c:ETH']) assert.equal(result.positioning[id], undefined);
});

test('evicting one direction keeps shared token and exchange evidence for another direction', () => {
  const cache = createPerpetualQualityCache(2), first = pair(), second = pair('BTC', 'c'), eth = pair('ETH');
  cache.accept(report(first), [first]); cache.accept(report(second, 20000), [second]);
  const result = cache.accept(report(eth, 30000), [eth]);
  assert.equal(result.pairs[key(first)], undefined);
  assert.ok(result.pairs[key(second)]);
  assert.equal(result.assets.BTC.updatedAt, 20000);
  assert.ok(result.positioning['c:BTC']);
});

test('unrequested response keys cannot grow the bounded cache', () => {
  const cache = createPerpetualQualityCache(), row = pair(), data = report(row);
  data.assets.UNRELATED = { updatedAt: 10000 };
  data.positioning.UNRELATED = { observedAt: 10000 };
  data.pairs.UNRELATED = {};
  const result = cache.accept(data, [row]);
  assert.equal(result.assets.UNRELATED, undefined);
  assert.equal(result.positioning.UNRELATED, undefined);
  assert.equal(result.pairs.UNRELATED, undefined);
});

test('another page cannot rehabilitate observations that were ahead of their own report', () => {
  const cache = createPerpetualQualityCache(), btc = pair(), eth = pair('ETH');
  const invalid = report(btc, 10000);
  invalid.assets.BTC.updatedAt = 20000;
  invalid.positioning[btc.longKey].observedAt = 20000;
  invalid.positioningOverview.BTC.observedAt = 20000;
  invalid.pairs[key(btc)].spread.lastAt = 20000;
  invalid.pairs[key(btc)].funding.lastAt = 20000;
  invalid.pairs[key(btc)].convergence.lastAt = 20000;
  cache.accept(invalid, [btc]);
  const result = cache.accept(report(eth, 16000), [eth]);
  assert.equal(result.assets.BTC.updatedAt, null);
  assert.equal(result.positioning[btc.longKey].observedAt, 0);
  assert.equal(result.positioningOverview.BTC, undefined);
  assert.equal(result.pairs[key(btc)].spread.lastAt, null);
  assert.equal(result.pairs[key(btc)].funding.lastAt, null);
  assert.equal(result.pairs[key(btc)].convergence.lastAt, null);
  assert.equal(result.pairs[key(btc)].priceSeries, undefined);
  assert.equal(invalid.assets.BTC.updatedAt, 20000, 'The incoming report remains immutable');
});

test('invalid original report times cannot be laundered by later cache merges', () => {
  for (const generatedAt of [undefined, null, NaN, Infinity, 0, -1, '10000', 15001]) {
    const cache = createPerpetualQualityCache(), btc = pair(), eth = pair('ETH');
    const invalid = { ...report(btc, 10000), generatedAt };
    cache.accept(invalid, [btc], 10000);
    const next = cache.accept(report(eth, 20000), [eth], 20000);
    assert.equal(next.pairs[key(btc)].spread.lastAt, null, String(generatedAt));
    assert.equal(next.pairs[key(btc)].funding.lastAt, null, String(generatedAt));
    assert.equal(next.pairs[key(btc)].convergence.lastAt, null, String(generatedAt));
    assert.equal(next.pairs[key(btc)].priceSeries, undefined, String(generatedAt));
    assert.equal(next.assets.BTC.updatedAt, null, String(generatedAt));
    assert.equal(next.positioning[btc.longKey].observedAt, 0, String(generatedAt));
    assert.equal(next.positioningOverview.BTC, undefined, String(generatedAt));
    assert.equal(invalid.pairs[key(btc)].convergence.lastAt, 10000, 'Incoming evidence is immutable');
  }
});

test('convergence freshness uses its own observation time and the permitted original report skew', () => {
  const cache = createPerpetualQualityCache(), btc = pair(), eth = pair('ETH');
  const data = report(btc, 10000);
  data.pairs[key(btc)].convergence.lastAt = 15000;
  const accepted = cache.accept(data, [btc], 10000);
  assert.equal(accepted.pairs[key(btc)].convergence.lastAt, 15000);
  const merged = cache.accept(report(eth, 900000), [eth], 900000);
  assert.equal(merged.pairs[key(btc)].convergence.lastAt, 15000, 'Reading another page never renews convergence evidence');
  const legacy = report(btc, 950000); delete legacy.pairs[key(btc)].convergence;
  assert.equal(cache.accept(legacy, [btc], 950000).pairs[key(btc)].convergence, undefined, 'A legacy response cannot revive the previous study');
});
