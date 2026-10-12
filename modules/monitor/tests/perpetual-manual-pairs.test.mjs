import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateManualPair, parseManualPairs, validManualPair, manualQuoteKey, maxManualPairs } from '../lib/perpetual-manual-pairs.ts';
import { rankPerpetualSpreads, defaultPerpetualFilters } from '../lib/perpetual-spreads.ts';

const now = 1_800_000_000_000;
const pair = { id: 'pair', first: 'aster:POLYMARKETUSD1', second: 'gate:POLYMARKET_USDT', firstFactor: 1, secondFactor: 10 };
const quote = (exchange, symbol, price, extra = {}) => ({ exchange, symbol, base: `${exchange.toUpperCase()}:PRE-MARKET:POLYMARKET`, comparable: false, quoteCurrency: 'USDT', bid: price, ask: price, mark: price, last: price, bidAskAt: now, markAt: now, fundingAt: now, receivedAt: now, sourceTime: now, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: now + 3600000, transport: 'ws', ...extra });
const data = (a = {}, b = {}) => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30000, quotes: [quote('aster', 'POLYMARKETUSD1', 100, a), quote('gate', 'POLYMARKET_USDT', 11, b)], exchanges: ['aster', 'gate'].map(id => ({ id, name: id, kind: id === 'gate' ? 'cex' : 'dex', status: 'live' })) });
const budget = { takerOverrides: { aster: 0.05, gate: 0.1 }, slippagePercent: 0.2 };
const fx = { baseCurrency: 'USDT', generatedAt: now, staleAfterMs: 180000, rates: { USD1: { bid: 0.98, ask: 1.02, at: now, source: 'fixture' } } };
const run = (snapshot = data(), config = pair, options = {}) => evaluateManualPair(config, snapshot, new Map(snapshot.quotes.map(q => [manualQuoteKey(q), q])), options.mode ?? 'book', options.now ?? now, options.budget ?? budget, options.fx ?? null);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('manual pair scales prices in both directions and leaves the automatic catalog isolated', () => {
  const snapshot = data(), before = structuredClone(snapshot);
  const result = run(snapshot);
  assert.equal(result.reason, null); assert.equal(result.directions.length, 2);
  const [forward, reverse] = result.directions;
  assert.equal(forward.long.exchange, 'aster'); assert.equal(forward.buy, 100); assert.equal(forward.sell, 11);
  near(forward.spreadPercent, 10); near(reverse.spreadPercent, (100 / 110 - 1) * 100);
  near(forward.netSpreadPercent, 9.5);
  assert.deepEqual(snapshot, before);
  assert.equal(rankPerpetualSpreads(snapshot, defaultPerpetualFilters, now, budget).length, 0);
  assert.equal(forward.long, snapshot.quotes[0]);
  assert.equal(run(snapshot, { ...pair, firstFactor: 0.1, secondFactor: 1 }).directions[0].spreadPercent, forward.spreadPercent);
});
test('cross-currency comparison requires fresh bid/ask FX and applies direction-specific conversion', () => {
  const snapshot = data({ quoteCurrency: 'USD1' });
  assert.match(run(snapshot).reason, /汇率/);
  const result = run(snapshot, pair, { fx });
  near(result.directions[0].spreadPercent, (110 / 102 - 1) * 100);
  near(result.directions[1].spreadPercent, (98 / 110 - 1) * 100);
  assert.equal(result.directions[0].currency, 'USDT');
  assert.match(run(snapshot, pair, { fx: { ...fx, rates: { USD1: { ...fx.rates.USD1, at: now - 180001 } } } }).reason, /汇率/);
});
test('missing and stale quotes, crossed books, skew, unavailable venues and removal remain excluded', () => {
  for (const patch of [{ bidAskAt: now - 30001 }, { bidAskAt: now + 5001, receivedAt: now + 5001 }, { bidAskAt: undefined }, { receivedAt: now - 30001 }, { bid: 102, ask: 100 }, { bid: null, ask: null }, { bidAskAt: now - 6000 }]) assert.equal(run(data(patch)).directions.length, 0, JSON.stringify(patch));
  const snapshot = data(); snapshot.exchanges[0].status = 'stale'; assert.equal(run(snapshot).directions.length, 0);
  snapshot.quotes.pop(); assert.match(run(snapshot).reason, /未加载|下架/);
  assert.equal(run({ ...data(), status: 'unavailable' }).directions.length, 0);
  assert.equal(run(data({ bid: null })).directions.length, 1);
});
test('fees use original isolated identities; missing funding and mark estimates are never zero-filled', () => {
  const result = run(data({ fundingAt: now - 300001 }), pair, { budget: { takerOverrides: {}, slippagePercent: 0.1 } });
  assert.equal(result.directions[0].netSpreadPercent, null);
  assert.equal(result.directions[0].fundingSpread8h, null);
  assert.match(result.directions[0].feeNote, /费用缺失/);
  const marked = run(data(), pair, { mode: 'mark' });
  assert.equal(marked.directions[0].netSpreadPercent, null); assert.match(marked.directions[0].feeNote, /标记价/);
});
test('invalid ratios and same-venue pairs are rejected including malformed saved preferences', () => {
  for (const value of [0, -1, Infinity, NaN, '1', 1e-13, 1e13]) assert.equal(validManualPair({ ...pair, firstFactor: value }), false);
  assert.equal(validManualPair({ ...pair, second: 'aster:OTHERUSD1' }), false);
  assert.equal(validManualPair({ ...pair, second: pair.first }), false);
  assert.deepEqual(parseManualPairs('{broken'), []);
  assert.deepEqual(parseManualPairs(JSON.stringify({ version: 2, pairs: [pair] })), []);
  const saved = parseManualPairs(JSON.stringify({ version: 1, pairs: [null, { ...pair, firstFactor: 0 }, pair, pair, { ...pair, id: 'reverse', first: pair.second, second: pair.first }] }));
  assert.deepEqual(saved, [pair]);
  assert.equal(parseManualPairs(JSON.stringify({ version: 1, pairs: Array.from({ length: 25 }, (_, i) => ({ ...pair, id: `p${i}`, second: `gate:COIN${i}_USDT` })) })).length, maxManualPairs);
});
test('factor edits affect current quotes and overflowing conversions do not produce fake spreads', () => {
  near(run(data(), { ...pair, secondFactor: 1 }).directions[0].spreadPercent, (100 / 11 - 1) * 100);
  assert.equal(run(data({ bid: 1e308, ask: 1e308 }), { ...pair, firstFactor: 10 }).directions.length, 0);
});
