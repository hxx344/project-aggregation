import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { estimateHoldingScenario, fundingLegsFor } from '../src/holding-scenario.ts';
import { fundingOpportunities } from '../server/funding-opportunities.mjs';
import { feed, quote } from './fixtures.mjs';

const now = 1_800_000_000_000, hour = 3_600_000;
const funding = (exchange, overrides = {}) => ({ exchange, symbol: `${exchange.toUpperCase()}_FUTURE_BTC_USDT`, quoteCurrency: 'USDT',
  rate: 0.0001, intervalHours: 4, normalized8hBps: 2, nextFundingAt: now + hour, fundingAt: now, ...overrides });
const leg = (exchange, overrides = {}, fundingPatch = {}) => ({ exchange, symbol: `${exchange.toUpperCase()}_FUTURE_BTC_USDT`, quoteCurrency: 'USDT', settlementCurrency: 'USDT',
  price: '100', priceAt: now, priceLive: true, funding: funding(exchange, fundingPatch), takerRate: '0.0005', ...overrides });
const input = (patch = {}) => ({ quantity: '1', holdingHours: 8, now, long: leg('binance'), short: leg('gate'),
  fundingExpiresAt: now + 9000, fundingStatus: { eligible: true, reason: '' }, monitorStale: false, feesAsOf: now - 1000, slippageBps: 5, fx: [], ...patch });
const same = (actual, expected) => assert.equal(actual === null ? null : new Decimal(actual).toFixed(), expected === null ? null : new Decimal(expected).toFixed());

function monitorFundingRow({ long = {}, snapshot = {}, options = {} } = {}) {
  const quotes = ['binance', 'bybit'].map((exchange, index) => quote(exchange, now, {
    fundingRate: index ? 0.0003 : 0.0001, fundingIntervalHours: 4, fundingAt: now, nextFundingAt: now + hour,
    ...(index ? {} : long),
  }));
  const rows = fundingOpportunities({ ...feed(now), schemaVersion: 2, quotes, signals: [], ...snapshot },
    { now, ruleFor: q => ({ symbol: `${q.exchange.toUpperCase()}_FUTURE_BTC_USDT` }), ...options });
  assert.equal(rows.length, 1);
  return rows[0];
}

function scenarioForRow(row, reverse = false) {
  const long = reverse ? row.short : row.long, short = reverse ? row.long : row.short;
  const selected = fundingLegsFor([row], long, short);
  assert.ok(selected);
  return estimateHoldingScenario(input({
    long: leg(long.exchange, { symbol: long.symbol, funding: selected.long }),
    short: leg(short.exchange, { symbol: short.symbol, funding: selected.short }),
    fundingExpiresAt: selected.expiresAt, fundingStatus: selected,
  }));
}

test('settlements follow each leg schedule and cash flows carry the funding sign (Monitor vector)', () => {
  const result = estimateHoldingScenario(input({
    long: leg('binance', {}, { rate: 0.001, intervalHours: 4, nextFundingAt: now + hour }),
    short: leg('gate', {}, { rate: 0.002, intervalHours: 8, nextFundingAt: now + 7 * hour }) }));
  assert.equal(result.long.settlements, 2); assert.equal(result.short.settlements, 1);
  assert.equal(result.long.lastFundingAt, now + 5 * hour); assert.equal(result.short.lastFundingAt, now + 7 * hour);
  same(result.long.funding, '-0.2'); same(result.short.funding, '0.2');
  same(result.totals.fundingIncome, '0.2'); same(result.totals.fundingExpense, '-0.2'); same(result.totals.fundingNet, '0');
  assert.equal(result.complete, true); assert.deepEqual(result.reasons, []);
});

test('amounts use the entered quantity and each leg price instead of an equal-notional rate spread', () => {
  // Issue #46: Bybit long 0.01%/4h at 103, Binance short 0.01%/1h at 99, 0.5 BTC each, held 24h.
  const result = estimateHoldingScenario(input({ quantity: '0.5', holdingHours: 24,
    long: leg('bybit', { price: '103' }, { rate: 0.0001, intervalHours: 4, nextFundingAt: now + 2 * hour }),
    short: leg('binance', { price: '99' }, { rate: 0.0001, intervalHours: 1, nextFundingAt: now + 0.5 * hour }) }));
  same(result.long.notional, '51.5'); same(result.short.notional, '49.5');
  assert.equal(result.long.settlements, 6); assert.equal(result.short.settlements, 24);
  same(result.long.funding, '-0.0309'); same(result.short.funding, '0.1188'); same(result.totals.fundingNet, '0.0879');
  same(result.long.fee, '0.0515'); same(result.short.fee, '0.0495'); same(result.totals.fee, '0.101');
  same(result.totals.slippage, '0.101');
  same(result.totals.net, '-0.1141');
  assert.equal(result.totals.currency, 'USDT'); assert.equal(result.totals.converted, false);
  assert.ok(result.assumptions.some(text => text.includes('假设结果')));
});

test('a settlement exactly at the exit instant is included and an elapsed one is never rolled forward', () => {
  const ending = estimateHoldingScenario(input({ holdingHours: 1 }));
  assert.equal(ending.long.settlements, 1); assert.equal(ending.long.lastFundingAt, now + hour);
  const before = estimateHoldingScenario(input({ holdingHours: 0.99 }));
  assert.equal(before.long.settlements, 0); same(before.long.funding, '0'); same(before.totals.fundingNet, '0');
  assert.equal(before.long.lastFundingAt, null); assert.equal(before.complete, true);
  const elapsed = estimateHoldingScenario(input({ long: leg('binance', {}, { nextFundingAt: now }) }));
  assert.equal(elapsed.long.settlements, null); assert.equal(elapsed.long.funding, null);
  assert.equal(elapsed.totals.fundingNet, null); assert.equal(elapsed.totals.net, null); assert.equal(elapsed.complete, false);
  assert.ok(elapsed.reasons.some(reason => /做多腿.*已过/.test(reason)));
  const inconsistent = estimateHoldingScenario(input({ long: leg('binance', {}, { nextFundingAt: now + 20 * hour }) }));
  assert.ok(inconsistent.reasons.some(reason => reason.includes('周期不一致')));
});

test('negative funding rates reverse the payer on each leg', () => {
  const result = estimateHoldingScenario(input({ long: leg('binance', {}, { rate: -0.001 }), short: leg('gate', {}, { rate: -0.002 }) }));
  same(result.long.funding, '0.2'); same(result.short.funding, '-0.4');
  same(result.totals.fundingIncome, '0.2'); same(result.totals.fundingExpense, '-0.4'); same(result.totals.fundingNet, '-0.2');
  // 8h: 2 settlements each; fees 2 × 100 × 0.0005 × 2; slippage 2 × 100 × 0.0005 × 2.
  same(result.totals.fee, '0.2'); same(result.totals.slippage, '0.2'); same(result.totals.net, '-0.6');
});

test('zero rates are a known result while missing or stale inputs leave the net unknown', () => {
  const zero = estimateHoldingScenario(input({ long: leg('binance', {}, { rate: 0 }), short: leg('gate', {}, { rate: 0 }) }));
  same(zero.totals.fundingNet, '0'); assert.equal(zero.complete, true);
  const cases = {
    rate: input({ long: leg('binance', {}, { rate: null }) }),
    oldRate: input({ long: leg('binance', {}, { fundingAt: now - 300_001 }) }),
    futureRate: input({ long: leg('binance', {}, { fundingAt: now + 5001 }) }),
    interval: input({ short: leg('gate', {}, { intervalHours: 0 }) }),
    next: input({ short: leg('gate', {}, { nextFundingAt: null }) }),
    noRow: input({ long: leg('binance', { funding: null }), short: leg('gate', { funding: null }), fundingExpiresAt: null }),
    rowExpired: input({ fundingExpiresAt: now }),
    monitorStale: input({ monitorStale: true }),
    price: input({ long: leg('binance', { price: null }) }),
    priceOld: input({ short: leg('gate', { priceAt: now - 10_001 }) }),
    priceNotLive: input({ short: leg('gate', { priceLive: false }) }),
    feesUnread: input({ feesAsOf: null }),
    feesOld: input({ feesAsOf: now - 300_001 }),
    feesError: input({ feesError: '读取失败' }),
    legSkew: input({ short: leg('gate', { priceAt: now - 5_001 }) }),
    taker: input({ short: leg('gate', { takerRate: null }) }),
    slippage: input({ slippageBps: NaN }),
    quantity: input({ quantity: '' }),
    settlementCurrency: input({ long: leg('binance', { settlementCurrency: 'USDC' }) }),
  };
  for (const [name, value] of Object.entries(cases)) {
    const result = estimateHoldingScenario(value);
    assert.equal(result.totals.net, null, name); assert.equal(result.complete, false, name);
    assert.ok(result.reasons.length > 0, name);
  }
  // A missing fee does not hide the funding part that is still known.
  const feesUnread = estimateHoldingScenario(cases.feesUnread);
  same(feesUnread.totals.fundingNet, '0'); assert.equal(feesUnread.totals.fee, null); assert.equal(feesUnread.long.fee, null);
  assert.deepEqual(feesUnread.reasons, ['账户手续费率尚未读取']);
  const missingRate = estimateHoldingScenario(cases.rate);
  assert.equal(missingRate.long.funding, null); same(missingRate.short.funding, '0.02'); assert.equal(missingRate.totals.fundingNet, null);
  const noPrice = estimateHoldingScenario(cases.price);
  assert.equal(noPrice.long.notional, null); assert.equal(noPrice.long.fee, null); assert.equal(noPrice.totals.slippage, null);
  assert.equal(noPrice.long.settlements, 2);
});

test('different quote currencies convert to USDT conservatively and stale FX keeps native leg amounts only', () => {
  const usdc = leg('hyperliquid', { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', quoteCurrency: 'USDC', settlementCurrency: 'USDC' }, { rate: 0.001 });
  const fx = [{ currency: 'USDC', state: 'live', bid: 0.99, ask: 1.01, at: now - 1000 }];
  const result = estimateHoldingScenario(input({ long: usdc, short: leg('gate', {}, { rate: 0.002 }), fx }));
  assert.equal(result.totals.currency, 'USDT'); assert.equal(result.totals.converted, true); assert.equal(result.long.currency, 'USDC');
  same(result.long.funding, '-0.2'); same(result.short.funding, '0.4');
  // The USDC expense converts at the ask, USDT income at 1.
  same(result.totals.fundingExpense, '-0.202'); same(result.totals.fundingIncome, '0.4'); same(result.totals.fundingNet, '0.198');
  same(result.totals.fee, new Decimal('0.1').mul('1.01').add('0.1').toFixed());
  same(result.totals.net, new Decimal('0.198').sub('0.201').sub('0.201').toFixed());
  assert.ok(result.assumptions.some(text => text.includes('USDT 汇率')));
  for (const stale of [[], [{ ...fx[0], at: now - 180_001 }], [{ ...fx[0], state: 'unavailable' }], [{ ...fx[0], bid: 1.02 }]]) {
    const value = estimateHoldingScenario(input({ long: usdc, short: leg('gate'), fx: stale }));
    assert.equal(value.totals.net, null); assert.equal(value.totals.fundingNet, null); assert.equal(value.totals.fee, null);
    same(value.long.funding, '-0.2'); same(value.long.fee, '0.1');
    assert.ok(value.reasons.includes('USDC / USDT 汇率缺失或过期'));
  }
});

test('the monotonic page clock may carry fractional milliseconds', () => {
  const result = estimateHoldingScenario(input({ now: now + 12.5, holdingHours: 1 }));
  assert.equal(result.complete, true); assert.equal(result.long.settlements, 1);
});

test('funding data comes only from the row with the exact selected contracts, in either direction', () => {
  const row = { id: 'x', base: 'BTC', long: funding('binance'), short: funding('gate', { rate: 0.0003 }), equivalent8hBps: 4, grossBps: 1,
    asOf: now, expiresAt: now + 9000, eligible: true, reason: '' };
  const binance = { exchange: 'binance', symbol: 'BINANCE_FUTURE_BTC_USDT' }, gate = { exchange: 'gate', symbol: 'GATE_FUTURE_BTC_USDT' };
  assert.deepEqual(fundingLegsFor([row], binance, gate), { long: row.long, short: row.short, expiresAt: row.expiresAt, eligible: true, reason: '' });
  assert.deepEqual(fundingLegsFor([row], gate, binance), { long: row.short, short: row.long, expiresAt: row.expiresAt, eligible: true, reason: '' });
  assert.equal(fundingLegsFor([row], { ...binance, symbol: 'BINANCE_FUTURE_BTC_USDC' }, gate), null);
  assert.equal(fundingLegsFor([row], { exchange: 'okx', symbol: binance.symbol }, gate), null);
  assert.equal(fundingLegsFor([], binance, gate), null);
});

test('an offline Monitor venue in a partial source cannot yield a complete scenario from fresh CrossEx books', () => {
  const row = monitorFundingRow({ snapshot: { status: 'partial',
    exchanges: [{ id: 'binance', status: 'offline' }, { id: 'bybit', status: 'live' }] } });
  assert.equal(row.eligible, false); assert.match(row.reason, /交易所行情离线/);
  assert.ok(row.expiresAt > now);
  for (const reverse of [false, true]) {
    const result = scenarioForRow(row, reverse);
    assert.equal(result.complete, false); assert.equal(result.totals.net, null);
    assert.equal(result.long.funding, null); assert.equal(result.short.funding, null);
    assert.equal(result.totals.fundingNet, null);
    assert.ok(result.reasons.includes(row.reason));
    same(result.totals.fee, '0.2'); same(result.totals.slippage, '0.2');
  }
});

test('server-side funding, book and source validity failures block funding totals before the row deadline', () => {
  const rows = [
    monitorFundingRow({ long: { fundingAt: now + 1001 } }),
    monitorFundingRow({ long: { bidAskAt: now + 1001 } }),
    monitorFundingRow({ long: { bidAskAt: now - 5001 } }),
    monitorFundingRow({ long: { bid: 0 } }),
    monitorFundingRow({ options: { sourceReason: 'Monitor 行情读取失败' } }),
  ];
  for (const row of rows) {
    assert.equal(row.eligible, false); assert.ok(row.expiresAt > now);
    const result = scenarioForRow(row);
    assert.equal(result.complete, false, row.reason); assert.equal(result.totals.net, null, row.reason);
    assert.equal(result.totals.fundingNet, null, row.reason);
    assert.ok(result.reasons.includes(row.reason), row.reason);
  }
});

test('entry-only pause and transfer policy states remain visible without suppressing a valid scenario', () => {
  const rows = [
    monitorFundingRow({ options: { entryPaused: true } }),
    monitorFundingRow({ snapshot: { crossexFilter: { requireSpotTransfer: true, blockedBases: [] } } }),
    monitorFundingRow({ snapshot: { crossexFilter: { requireSpotTransfer: 'invalid', blockedBases: [] } } }),
  ];
  for (const row of rows) {
    assert.equal(row.eligible, false); assert.ok(row.expiresAt > now);
    const result = scenarioForRow(row);
    assert.equal(result.complete, true, row.reason); same(result.totals.net, '-0.36');
    assert.deepEqual(result.reasons, []); assert.deepEqual(result.notices, [row.reason]);
  }
  const paused = rows[0], invalidSchedule = { ...paused, long: { ...paused.long, nextFundingAt: now } };
  const result = scenarioForRow(invalidSchedule);
  assert.equal(result.complete, false); assert.equal(result.totals.net, null);
  assert.ok(result.reasons.some(reason => reason.includes('已过')));
  assert.deepEqual(result.notices, [paused.reason]);
});

test('missing and unrecognized row validity cannot silently authorize complete scenario totals', () => {
  const row = monitorFundingRow();
  for (const reason of ['', '新的来源数据异常']) {
    const result = scenarioForRow({ ...row, eligible: false, reason });
    assert.equal(result.complete, false); assert.equal(result.totals.net, null);
    assert.ok(result.reasons.includes(reason || '资金费机会数据有效性待核实'));
  }
  const missing = estimateHoldingScenario(input({ fundingStatus: null }));
  assert.equal(missing.complete, false); assert.equal(missing.totals.net, null);
  assert.ok(missing.reasons.includes('资金费机会数据有效性待核实'));
  // This policy check precedes the server's data checks and can mask an offline venue.
  const missingPolicy = monitorFundingRow({ options: { entryPolicyKnown: true }, snapshot: {
    status: 'partial', exchanges: [{ id: 'binance', status: 'offline' }, { id: 'bybit', status: 'live' }],
  } });
  const result = scenarioForRow(missingPolicy);
  assert.equal(result.complete, false); assert.equal(result.totals.net, null);
  assert.ok(result.reasons.includes(missingPolicy.reason));
});
