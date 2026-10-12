import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualScannerDataService } from '../server/perpetual-scanner-data.mjs';
import { scannerDataPairKey, scannerDataHistoryForPair } from '../lib/perpetual-scanner-data.ts';

const NOW = Date.UTC(2026, 9, 8), HOUR = 3600000;
const markets = ['a', 'b'].map(exchange => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', comparable: true }));
const pair = { base: 'BTC', longKey: 'a:BTCUSDT', shortKey: 'b:BTCUSDT' };
const records = rate => Array.from({ length: 769 }, (_, index) => ({ time: NOW - index * HOUR, rate }));
function fixture() {
  const calls = [], catalog = new Map(markets.map(market => [`${market.exchange}:${market.symbol}`, { ...market }]));
  const service = createPerpetualScannerDataService({ clock: () => NOW, getSnapshot: () => ({ quotes: markets }), getMarket: (exchange, symbol) => catalog.get(`${exchange}:${symbol}`),
    marketMetrics: { read(input) { calls.push(['metrics', input]); return { legs: { 'a:BTCUSDT': { volume24h: { value: 0 } } }, storageError: '保存失败' }; } },
    fundingHistory: { read(input) { calls.push(['history', input]); return { legs: Object.fromEntries(markets.map((market, index) => [`${market.exchange}:${market.symbol}`, { status: 'ready', coverage: { from: NOW - 32 * 24 * HOUR, to: NOW }, records: records(index ? 0.0002 : 0.0001), error: '', backfillComplete: true }])) }; } },
  });
  return { service, calls, catalog };
}

test('compact scanner reads canonicalize reverse pairs and return exact directed window totals without raw records', () => {
  const f = fixture(), reverse = { ...pair, longKey: pair.shortKey, shortKey: pair.longKey };
  const report = f.service.read({ pairs: [reverse, pair], metrics: true, historyHours: [24, 168, 720] });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0][1].pairs.length, 1);
  assert.equal(Object.keys(report.history).length, 1); assert.equal(report.metrics['a:BTCUSDT'].volume24h.value, 0);
  const normal = scannerDataHistoryForPair(report, pair, 24), flipped = scannerDataHistoryForPair(report, reverse, 24);
  assert.ok(Math.abs(normal.netPercent - 0.24) < 1e-10); assert.equal(flipped.netPercent, -normal.netPercent);
  assert.equal(flipped.longPercent, normal.shortPercent); assert.equal(flipped.longCount, normal.shortCount);
  assert.equal(report.history[scannerDataPairKey(pair)][720].longCount, 720);
  assert.equal(JSON.stringify(report).includes('records'), false); assert.equal(report.storageError, '保存失败');
});

test('the entire scanner batch and catalog identity validate before either collector registers anything', () => {
  const f = fixture(), valid = { pairs: [pair], metrics: true, historyHours: [24] };
  for (const input of [
    { ...valid, pairs: [pair, { ...pair, shortKey: 'missing:BTC' }] },
    { ...valid, pairs: Array(31).fill(pair) }, { ...valid, historyHours: [1] }, { ...valid, metrics: 'true' },
    { ...valid, pairs: [{ ...pair, identity: 123 }] }, { ...valid, pairs: [{ ...pair, base: 'ETH' }] },
  ]) assert.throws(() => f.service.read(input), error => error.status === 400);
  f.catalog.get(pair.shortKey).comparable = false;
  assert.throws(() => f.service.read(valid), error => error.status === 400);
  assert.equal(f.calls.length, 0);
});

test('unused requirements never register the corresponding collector', () => {
  const f = fixture();
  f.service.read({ pairs: [pair], metrics: false, historyHours: [] }); assert.equal(f.calls.length, 0);
  f.service.read({ pairs: [pair], metrics: true, historyHours: [] }); assert.deepEqual(f.calls.map(([kind]) => kind), ['metrics']);
  f.calls.length = 0; f.service.read({ pairs: [pair], metrics: false, historyHours: [24] }); assert.deepEqual(f.calls.map(([kind]) => kind), ['history']);
});

test('a busy or failed funding registration becomes an explicit terminal error so later candidates can proceed', () => {
  const service = createPerpetualScannerDataService({ clock: () => NOW, getSnapshot: () => ({ quotes: markets }), getMarket: (exchange, symbol) => markets.find(market => market.exchange === exchange && market.symbol === symbol),
    fundingHistory: { read() { return { legs: Object.fromEntries(markets.map(market => [`${market.exchange}:${market.symbol}`, { status: 'pending', coverage: null, records: [], error: '历史查询队列繁忙，稍后重试' }])) }; } },
  });
  const value = service.read({ pairs: [pair], metrics: false, historyHours: [720] }).history[scannerDataPairKey(pair)][720];
  assert.equal(value.status, 'error'); assert.match(value.reason, /繁忙/); assert.equal(value.netPercent, null);
});
