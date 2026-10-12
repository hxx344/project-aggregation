import test from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../server/money.mjs';
import { resolveFee, feeSnapshot, roundTripFeeBps } from '../server/fees.mjs';
import { commonQuantity, commonQuantityExact, configuration, convert, defaults, fill, notionalUSDT, partialFill, pnl, referencePrice } from '../server/model.mjs';

const long = { exchange: 'binance', symbol: 'BTCUSDT', quoteCurrency: 'USDT' };
test('exact quantity path preserves steps beyond Number integer precision', () => {
  const rules = Array.from({ length: 2 }, () => ({ lot_size: '0.01', min_size: '0.01', min_notional: null, max_market_size: '9999999999999999.99' }));
  const quantity = commonQuantityExact(1000000, [1e-11, 1e-11], rules);
  assert.equal(quantity, '9999999999999999.99');
  assert.equal(fill([['0.00000000001', quantity]], quantity, 'buy', 0).exact.quantity, quantity);
});
const short = { exchange: 'bybit', symbol: 'BTCUSDT', quoteCurrency: 'USDT' };
const row = (extra = {}) => ({ exchange: 'binance', symbol: '', makerBps: -1, takerBps: 2, source: 'published tier', updatedAt: 100, ...extra });

test('legacy settings gain new defaults and fee rows are independent copies', () => {
  const old = { enabled: true, feeBps: 9, monitorUsername: 'paper' };
  const result = configuration({ entryPaused: true }, old);
  assert.equal(result.enabled, true); assert.equal(result.feeBps, 9); assert.equal(result.executionMode, 'atomic'); assert.equal(result.fundingEnabled, true); assert.equal(result.entryPaused, true);
  const previous = configuration({ feeSchedule: [row()] });
  const next = configuration({ maxOpen: 4 }, previous);
  next.feeSchedule[0].takerBps = 99;
  assert.equal(previous.feeSchedule[0].takerBps, 2); assert.deepEqual(defaults.feeSchedule, []);
  assert.equal(configuration({ feeSchedule: [] }, previous).feeSchedule.length, 0);
});

test('execution and sampling settings enforce bounded values and enums', () => {
  for (const update of [
    { entryPaused: 1 }, { fundingEnabled: 'true' }, { executionMode: 'live' }, { executionScenario: 'unbounded' },
    { executionSeed: 0 }, { executionSeed: 2147483649 }, { executionSeed: 1.1 }, { executionDelayMs: -1 }, { executionDelayMs: 10001 },
    { clipNotional: 0 }, { clipNotional: 100001 }, { partialFillPct: 0 }, { partialFillPct: 101 }, { repairAttempts: 0 }, { repairAttempts: 11 }, { repairAttempts: 1.5 },
    { depthRefreshSeconds: 4 }, { depthRefreshSeconds: 301 }, { historySampleSeconds: 4 }, { historySampleSeconds: 301 },
  ]) assert.throws(() => configuration(update), JSON.stringify(update));
  const boundary = configuration({ executionMode: 'staged', executionScenario: 'unknown-short', executionSeed: 2147483648, executionDelayMs: 0, clipNotional: 1, partialFillPct: 100, repairAttempts: 10, depthRefreshSeconds: 5, historySampleSeconds: 300 });
  assert.equal(boundary.executionSeed, 2147483648);
});

test('fee table rejects duplicate, unsafe, oversized and unbounded rows', () => {
  for (const feeSchedule of [
    [row(), row()], Array.from({ length: 101 }, (_, i) => row({ symbol: `BTC${i}` })),
    [row({ makerBps: -101 })], [row({ makerBps: 101 })], [row({ makerBps: NaN })],
    [row({ takerBps: -1 })], [row({ takerBps: 101 })], [row({ takerBps: Infinity })],
    [row({ exchange: 'unknown' })], [row({ symbol: 'x'.repeat(101) })], [row({ source: 'x'.repeat(201) })],
    [row({ updatedAt: -1 })], [row({ updatedAt: NaN })], [row({ unknown: true })], [row({ constructor: {} })],
  ]) assert.throws(() => configuration({ feeSchedule }));
  assert.throws(() => configuration(JSON.parse('{"__proto__": {"enabled": true}}')));
  assert.throws(() => configuration(Object.create({ enabled: true })));
  assert.throws(() => configuration({ feeSchedule: [Object.assign(Object.create({ exchange: 'binance' }), row())] }));
  assert.throws(() => configuration({ monitorUrl: `http://localhost/${'x'.repeat(2048)}` }));
  assert.equal(configuration({ feeSchedule: [row({ makerBps: -100, takerBps: 0, updatedAt: null })] }).feeSchedule[0].makerBps, -100);
  assert.equal(configuration({ feeSchedule: [row({ makerBps: 100, takerBps: 100 })] }).feeSchedule[0].takerBps, 100);
});

test('fees resolve symbol, venue and legacy fallback; market snapshots always take taker rates', () => {
  const config = configuration({ feeBps: 7, feeSchedule: [row(), row({ symbol: 'BTCUSDT', makerBps: -5, takerBps: 3, source: 'contract', updatedAt: 200 })] });
  assert.deepEqual(resolveFee(config, long), { bps: 3, source: 'contract', updatedAt: 200 });
  assert.equal(resolveFee(config, { ...long, symbol: 'ETHUSDT' }).bps, 2);
  assert.equal(resolveFee(config, long, 'maker').bps, -5);
  assert.deepEqual(resolveFee(config, short), { bps: 7, source: 'legacy-feeBps', updatedAt: null });
  assert.throws(() => resolveFee(config, long, 'unknown'));
  const snapshot = feeSnapshot(config, long, short);
  assert.equal(roundTripFeeBps(snapshot), 20);
  config.feeSchedule[1].takerBps = 90; config.feeBps = 99;
  assert.equal(snapshot.long.entry.bps, 3); assert.equal(snapshot.short.exit.bps, 7);
  snapshot.long.entry.bps = 1;
  assert.equal(snapshot.long.exit.bps, 3);
});

test('decimal fills keep exact notionals and never fill missing epsilon quantity', () => {
  const filled = fill([[0.1, 0.1], [0.2, 0.2]], 0.3, 'buy', 10000);
  assert.equal(filled.notional, 0.05); assert.equal(filled.exact.quantity, '0.3'); assert.equal(filled.exact.notional, '0.05');
  assert.equal(filled.exact.remaining, '0');
  const partial = partialFill([[100, '0.29999999999']], '0.3', 'buy', 0);
  assert.equal(partial.status, 'partial'); assert.equal(partial.exact.remaining, '0.00000000001');
  assert.throws(() => fill([[100, '0.29999999999']], '0.3', 'buy', 0), /深度不足/);
  assert.deepEqual(partialFill([], 0.3, 'buy', 0), { quantity: 0, requestedQuantity: 0.3, remaining: 0.3, price: null, notional: 0, status: 'empty', exact: { quantity: '0', requestedQuantity: '0.3', remaining: '0.3', price: null, notional: '0' } });
  for (const side of ['buy', 'sell']) {
    const price = side === 'buy' ? '0.1001' : '0.0999';
    assert.equal(fill([['0.1', '0.1'], [price, '0.2']], '0.3', side, 10).status, 'filled');
    const outside = side === 'buy' ? '0.10010000000001' : '0.09989999999999';
    assert.equal(partialFill([['0.1', '0.1'], [outside, '0.2']], '0.3', side, 10).status, 'partial');
  }
});

test('integer common lots preserve decimal budget and minimum boundaries', () => {
  const rules = ['0.01', '0.01'].map(lot_size => ({ lot_size, min_size: '0.01', min_notional: '0.029', max_market_size: '0.29' }));
  assert.equal(commonQuantity(0.029, [0.1, 0.1], rules), 0.29);
  assert.throws(() => commonQuantity(0.028999, [0.1, 0.1], rules), /最小/);
  const tiny = rules.map(r => ({ ...r, lot_size: 1e-8, min_size: '0.00000001', min_notional: '0', max_market_size: null }));
  assert.equal(commonQuantity(0.00000003, [1, 1], tiny), 0.00000003);
  assert.throws(() => commonQuantity(1, [1, 1], tiny.map(r => ({ ...r, lot_size: '0.000000001' }))));
});

test('FX conversion performs decimal multiplication on signed amounts', () => {
  const fx = { baseCurrency: 'USDT', staleAfterMs: 1000, rates: { USDC: { bid: 0.2, ask: 0.3, at: 100, source: 'fixture' } } };
  const q = { ...long, quoteCurrency: 'USDC', settlementCurrency: 'USDC' };
  assert.equal(convert(0.1, 'USDC', fx, 100), 0.02); assert.equal(convert(-0.1, 'USDC', fx, 100), -0.03);
  assert.equal(referencePrice(q, 0.1, 'buy', fx, 100), 0.03); assert.equal(notionalUSDT(q, 0.1, fx, 100), 0.03);
});

test('P&L prices each fee from its saved leg rate and preserves legacy fees', () => {
  const config = configuration({ feeSchedule: [row({ symbol: 'BTCUSDT', takerBps: 2 }), row({ exchange: 'bybit', takerBps: 7 })] });
  const savedFees = feeSnapshot(config, long, short);
  savedFees.long.exit.bps = 3; savedFees.short.exit.bps = 11;
  const longFill = fill([[0.1, 0.3]], 0.3, 'buy', 0), shortFill = fill([[0.2, 0.3]], 0.3, 'sell', 0);
  const entryFees = D(longFill.exact.notional).times(savedFees.long.entry.bps).plus(D(shortFill.exact.notional).times(savedFees.short.entry.bps)).div(10000).toString();
  const p = { long, short, quantity: 0.3, longFill, shortFill, feeSnapshot: savedFees, entryFees: Number(entryFees), entryFeesExact: entryFees, feeBps: 99, fundingPnl: null };
  config.feeSchedule[0].takerBps = 90;
  const result = pnl(p, 0.15, 0.15, undefined, 100);
  assert.equal(result.exact.gross, '0.03'); assert.equal(result.exact.entryFees, '0.000048'); assert.equal(result.exact.exitFees, '0.000063');
  assert.equal(result.exact.net, '0.029889'); assert.equal(result.priceOnlyNet, result.net);
  assert.equal(result.exact.longGross, '0.015'); assert.equal(result.exact.shortGross, '0.015');
  const legacy = pnl({ ...p, feeSnapshot: undefined, feeBps: 5 }, 0.15, 0.15, undefined, 100);
  assert.equal(legacy.exact.exitFees, '0.000045'); assert.equal(legacy.exact.net, '0.029907');
});

test('staged P&L accounts only actual fills and permits a missing zero-quantity leg', () => {
  const p = { long, short, quantity: 10, longQuantity: 0.3, shortQuantity: 0, longFill: fill([[0.1, 0.3]], 0.3, 'buy', 0), shortFill: { quantity: 0, price: null }, entryFees: 0.000003, feeBps: 1 };
  const result = pnl(p, 0.2, null, undefined, 100);
  assert.equal(result.exact.longGross, '0.03'); assert.equal(result.exact.shortGross, '0'); assert.equal(result.exact.exitFees, '0.000006'); assert.equal(result.exact.net, '0.029991');
  const sold = fill([[0.1, 0.1], [0.2, 0.2]], 0.3, 'buy', 10000);
  const exact = pnl({ ...p, entryFees: 0, feeBps: 0 }, sold, null, undefined, 100);
  assert.equal(exact.exact.longGross, '0.02');
});
