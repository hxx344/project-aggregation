import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePerpetualExitPnl, exitEstimateExpired, perpetualExitIdentity, validatePerpetualExitPosition } from '../lib/perpetual-exit.ts';
import { createInspectionBudget, createPerpetualExecutionService, estimateExitPair } from '../server/perpetual-depth.mjs';

const NOW = 1_800_000_000_000;
const quote = (exchange, extra = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', comparable: true, ...extra });
const quotes = [quote('binance'), quote('bybit', { takerFeeRate: 0.00055, takerFeeAt: NOW, takerFeeSource: 'bybit-standard' })];
const book = (index, extra = {}) => ({ ...quotes[index], sourceTime: NOW, receivedAt: NOW, transport: 'rest', source: 'fixture', bids: [[110, 5], [100, 5]], asks: [[111, 5], [121, 5]], ...extra });
const position = (extra = {}) => ({ quantity: 10, entryLongPrice: 100, entryShortPrice: 120, entryFeePaid: 2, settledFunding: -3, capital: 500, ...extra });
const input = (extra = {}) => ({ ...position(), long: { exchange: quotes[0].exchange, symbol: quotes[0].symbol }, short: { exchange: quotes[1].exchange, symbol: quotes[1].symbol }, ...extra });
const fee = percent => ({ percent, basis: percent === null ? 'missing' : 'public', detail: 'fixture', source: null, checkedAt: NOW });
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const response = data => ({ ok: true, json: async () => data });

test('exit PnL uses opposing directions, actual close notionals and separate return denominators', () => {
  const result = calculatePerpetualExitPnl(position(), 110, 115, { long: fee(0.1), short: fee(0.2) });
  assert.equal(result.longPnl, 100); assert.equal(result.shortPnl, 50);
  assert.equal(result.rawPnl, 150); almost(result.closeFeePaid, 1100 * .001 + 1150 * .002);
  almost(result.netPnl, 141.6); almost(result.notionalReturnPercent, 14.16); almost(result.capitalReturnPercent, 28.32);
  assert.equal(result.entryNotional, 1000); assert.equal(result.entryShortNotional, 1200);
  // A fixed four-fill opening notional would charge the wrong closing cost.
  assert.notEqual(result.closeFeePaid, 1000 * (.001 + .002));
  const loss = calculatePerpetualExitPnl(position({ settledFunding: 3, capital: null }), 90, 130, { long: fee(0), short: fee(0) });
  assert.equal(loss.longPnl, -100); assert.equal(loss.shortPnl, -100); assert.equal(loss.netPnl, -199); assert.equal(loss.capitalReturnPercent, null);
});

test('unknown or invalid fees preserve gross PnL but never make a net return', () => {
  for (const percent of [null, NaN, -1, 11]) {
    const result = calculatePerpetualExitPnl(position(), 110, 115, { long: fee(percent), short: fee(0) });
    assert.equal(result.rawPnl, 150); assert.equal(result.netPnl, null); assert.equal(result.closeFeePaid, null);
    assert.equal(result.capitalReturnPercent, null); assert.equal(result.notionalReturnPercent, null);
  }
});

test('exit validation rejects non-numbers, missing money fields and impossible quantities', () => {
  for (const patch of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1e19 }, { quantity: '10' }, { entryLongPrice: NaN }, { entryShortPrice: Infinity }, { entryLongPrice: 1e8 }, { entryFeePaid: undefined }, { entryFeePaid: -1 }, { settledFunding: NaN }, { settledFunding: 1e10 }, { capital: 0 }, { capital: undefined }]) {
    assert.throws(() => validatePerpetualExitPosition(position(patch)));
  }
  assert.doesNotThrow(() => validatePerpetualExitPosition(position({ quantity: .0001, settledFunding: 0, entryFeePaid: 0, capital: null })));
});

test('exit book estimator sells long bids and buys short asks at the same underlying quantity', () => {
  const result = estimateExitPair(book(0), book(1), input(), quotes, NOW);
  assert.equal(result.complete, true); assert.equal(result.bookComplete, true);
  assert.equal(result.long.action, 'sell'); assert.equal(result.short.action, 'buy');
  assert.equal(result.long.vwap, 105); assert.equal(result.short.vwap, 116);
  assert.equal(result.long.filledQuantity, 10); assert.equal(result.short.filledQuantity, 10);
  assert.equal(result.longPnl, 50); assert.equal(result.shortPnl, 40); assert.equal(result.rawPnl, 90);
  almost(result.closeFeePaid, 1050 * .0005 + 1160 * .00055); almost(result.netPnl, 90 - 2 - 3 - result.closeFeePaid);
  assert.equal(result.fees.long.basis, 'public'); assert.equal(result.fees.short.basis, 'public');
});

test('exit partial liquidity shows capacity without assigning a whole-position net result', () => {
  const result = estimateExitPair(book(0, { bids: [[105, 3]] }), book(1), input(), quotes, NOW);
  assert.equal(result.bookComplete, false); assert.equal(result.complete, false);
  assert.equal(result.long.filledQuantity, 3); assert.equal(result.long.pnl, null);
  assert.equal(result.short.filledQuantity, 10); assert.equal(result.short.pnl, 40);
  assert.equal(result.rawPnl, null); assert.equal(result.closeFeePaid, null); assert.equal(result.netPnl, null);
  assert.match(result.reasons.join(), /不足以全部平仓/);
});

test('exit quote metadata chooses actual account overrides and reports unknown fees', () => {
  const overridden = estimateExitPair(book(0), book(1), input({ takerOverrides: { binance: 0, bybit: 0.01 } }), quotes, NOW);
  assert.equal(overridden.fees.long.basis, 'account'); assert.equal(overridden.fees.short.basis, 'account');
  almost(overridden.closeFeePaid, 1160 * .0001);
  const missing = estimateExitPair(book(0), book(1), input(), [quotes[0], { ...quotes[1], takerFeeAt: NOW - 16 * 60_000 }], NOW);
  assert.equal(missing.bookComplete, true); assert.equal(missing.complete, false); assert.equal(missing.rawPnl, 90); assert.equal(missing.netPnl, null);
  assert.match(missing.reasons.join(), /15 分钟/);
});

test('exit source freshness, skew, identity and settlement-currency checks fail closed', () => {
  for (const patch of [{ sourceTime: NOW - 10_001 }, { receivedAt: NOW - 10_001 }, { sourceTime: NOW + 5001 }, { sourceTime: null }, { symbol: 'ETHUSDT' }, { bids: [[120, 10]] }]) {
    assert.equal(estimateExitPair(book(0, patch), book(1), input(), quotes, NOW).complete, false);
  }
  assert.match(estimateExitPair(book(0, { sourceTime: NOW - 5001 }), book(1), input(), quotes, NOW).reasons.join(), /相差/);
  assert.match(estimateExitPair(book(0), book(1), input({ identity: 'old' }), quotes, NOW).reasons.join(), /身份/);
  for (const patch of [{ quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' }]) {
    assert.match(estimateExitPair(book(0), book(1), input(), [quotes[0], { ...quotes[1], ...patch }], NOW).reasons.join(), /USDT 计价及结算/);
  }
  const good = estimateExitPair(book(0, { sourceTime: NOW - 4000 }), book(1), input(), quotes, NOW);
  assert.equal(exitEstimateExpired(good, NOW + 6000), false); assert.equal(exitEstimateExpired(good, NOW + 6001), true);
  assert.equal(exitEstimateExpired({ ...good, long: null }, NOW), true);
});

test('contract identity includes both market symbols, collateral and normalized units', () => {
  const identity = perpetualExitIdentity(...quotes);
  for (const patch of [{ symbol: '1000BTCUSDT' }, { base: 'XBT' }, { quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' }, { multiplier: 1000 }, { contractUnit: 'lots' }]) {
    assert.notEqual(perpetualExitIdentity(quotes[0], { ...quotes[1], ...patch }), identity);
  }
  assert.equal(perpetualExitIdentity(quotes[0], { ...quotes[1], bid: 123, takerFeeAt: NOW + 1 }), identity);
});

test('exit service shares book cache with entry checks and validates old identity before network', async () => {
  let calls = 0;
  const limiter = createInspectionBudget({ spacingMs: 0 }), current = [...quotes];
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, getQuote: exchange => current.find(row => row.exchange === exchange), fetchImpl: async url => {
    calls++; return response(url.includes('bybit') ? { result: { s: 'BTCUSDT', ts: NOW, b: [[110, 20]], a: [[111, 20]] } } : { E: NOW, bids: [[100, 20]], asks: [[101, 20]] });
  } });
  try {
    assert.equal((await service.depth({ ...input(), notional: 1000 })).complete, true);
    const result = await service.exit(input({ identity: perpetualExitIdentity(...quotes) }));
    assert.equal(result.complete, true); assert.equal(calls, 2); assert.equal(result.long.vwap, 100); assert.equal(result.short.vwap, 111);
    await assert.rejects(service.exit(input({ quantity: -1 })), /数量/); assert.equal(calls, 2);
    current[1] = { ...current[1], multiplier: 1000 };
    await assert.rejects(service.exit(input({ identity: perpetualExitIdentity(...quotes) })), error => error.status === 409);
    assert.equal(calls, 2);
    await service.exit(input()); assert.equal(calls, 3); // Changed unit invalidates only its own book cache.
  } finally { service.stop(); limiter.stop(); }
});

test('exit service refuses a catalog identity change while an upstream request is running', async () => {
  let changed = false; const current = [...quotes], limiter = createInspectionBudget({ spacingMs: 0 });
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, getQuote: exchange => current.find(row => row.exchange === exchange), fetchImpl: async url => {
    if (!changed) { changed = true; current[0] = { ...current[0], multiplier: 1000 }; }
    return response(url.includes('bybit') ? { result: { s: 'BTCUSDT', ts: NOW, b: [[110, 20]], a: [[111, 20]] } } : { E: NOW, bids: [[100, 20]], asks: [[101, 20]] });
  } });
  try { await assert.rejects(service.exit(input()), error => error.status === 409 && /查询期间/.test(error.message)); }
  finally { service.stop(); limiter.stop(); }
});

test('exit service rejects cross-settlement positions before fetching and can inspect a delisting close', async () => {
  let calls = 0; const current = [...quotes], limiter = createInspectionBudget({ spacingMs: 0 });
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, getQuote: exchange => current.find(row => row.exchange === exchange), fetchImpl: async url => {
    calls++; return response(url.includes('bybit') ? { result: { s: 'BTCUSDT', ts: NOW, b: [[110, 20]], a: [[111, 20]] } } : { E: NOW, bids: [[100, 20]], asks: [[101, 20]] });
  } });
  try {
    current[1] = { ...current[1], collateralCurrency: 'USDC' };
    await assert.rejects(service.exit(input()), /USDT 计价及结算/); assert.equal(calls, 0);
    current[1] = { ...quotes[1], delistingAt: NOW - 1 };
    await assert.rejects(service.depth({ ...input(), notional: 1000 }), /下架时间/);
    const closing = await service.exit(input()); assert.equal(closing.complete, true); assert.match(closing.reasons.join(), /是否仍允许平仓/); assert.equal(calls, 2);
  } finally { service.stop(); limiter.stop(); }
});
