import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingLedger } from '../server/funding.mjs';

const HOUR = 3_600_000, START = Date.UTC(2026, 8, 23, 10), END = START + 3 * HOUR;
function position(extra = {}) { return { accountingVersion: 3, id: 'paper-position', openedAt: START, quantity: 2, long: { exchange: 'binance', symbol: 'BTCUSDT', quoteCurrency: 'USDT' }, short: { exchange: 'bybit', symbol: 'BTCUSDT', quoteCurrency: 'USDT' }, longFill: { price: '100' }, shortFill: { price: '110' }, quantityHistory: [{ at: START, longQuantity: '2', shortQuantity: '2' }], ...extra }; }
function report(q, rows = [], extra = {}) { return { exchange: q.exchange, symbol: q.symbol, from: START, to: END, coveredFrom: START, coveredTo: END, complete: true, sourceAt: END, current: null, settlements: rows, ...extra }; }
const settled = (at, rate = '0.01', markPrice = '100') => ({ at, rate, markPrice, unit: 'rate', intervalHours: 1, source: 'https://official.example/history' });
function reports(p, long = [], short = []) { return { long: report(p.long, long), short: report(p.short, short) }; }
function fx(at, bid = 1, ask = 1) { return { baseCurrency: 'USDT', staleAfterMs: 180_000, rates: { USDC: { at, bid, ask, source: 'historical-fx' }, USD: { at, bid, ask, source: 'historical-fx' } } }; }

test('positive rates debit long, credit short; negative rates reverse cash flows exactly', () => {
  const p = position(), value = fundingLedger(p, reports(p, [settled(START + HOUR, '0.01')], [settled(START + HOUR, '-0.02', '110')]), END);
  assert.equal(value.status, 'complete'); assert.equal(value.confirmed, -6.4); assert.equal(value.known, -6.4); assert.equal(value.entries[0].amountNative, '-2'); assert.equal(value.entries[1].amountNative, '-4.4');
});
test('point funding uses pre-settlement leg quantities, includes close boundary and excludes open boundary', () => {
  const p = position({ closedAt: START + 2 * HOUR, quantityHistory: [{ at: START, longQuantity: '2', shortQuantity: '2' }, { at: START + HOUR, longQuantity: '1', shortQuantity: '0.5' }, { at: START + 2 * HOUR, longQuantity: '0', shortQuantity: '0' }] });
  const r = reports(p, [settled(START), settled(START + HOUR), settled(START + 2 * HOUR), settled(END)]);
  const value = fundingLedger(p, r, END); assert.equal(value.confirmed, -3); assert.deepEqual(value.entries.map(x => x.quantity), ['2', '1']);
});
test('repeated history reads are idempotent and conflicting same-time data is incomplete', () => {
  const p = position(), row = settled(START + HOUR), r = reports(p, [row, { ...row }]);
  const first = fundingLedger(p, r, END), again = fundingLedger(p, structuredClone(r), END);
  assert.deepEqual(again, first); assert.equal(first.entries.length, 1); assert.equal(first.entries[0].key, `paper-position:long:${START + HOUR}`);
  r.long.settlements.push({ ...row, rate: '0.02' }); assert.equal(fundingLedger(p, r, END).confirmed, null);
});
test('missing settlement price is an explicit entry-price estimate, not confirmed cash flow', () => {
  const p = position(), result = fundingLedger(p, reports(p, [settled(START + HOUR, '0.01', null)]), END);
  assert.equal(result.confirmed, null); assert.equal(result.known, 0); assert.equal(result.estimated, -2);
  assert.equal(result.entries[0].amountNative, null); assert.equal(result.entries[0].quality, 'estimated_price'); assert.equal(result.entries[0].estimateUSDT, '-2');
});
test('old entry FX cannot confirm historical conversion; a contemporaneous saved sample can', () => {
  const p = position({ long: { exchange: 'binance', symbol: 'BTCUSDC', quoteCurrency: 'USDC' }, entryFx: fx(START, 0.9, 1.1) });
  const r = reports(p, [settled(START + HOUR)]), old = fundingLedger(p, r, END);
  assert.equal(old.confirmed, null); assert.equal(old.estimated, -2.2); assert.equal(old.entries[0].amountNative, '-2'); assert.equal(old.entries[0].quality, 'estimated_fx');
  p.quantityHistory.push({ at: START + HOUR - 1000, longQuantity: '2', shortQuantity: '2', fx: fx(START + HOUR - 1000, 0.8, 1.2) });
  assert.equal(fundingLedger(p, r, END).confirmed, -2.4);
});
test('future FX samples and no FX remain unknown, zero funding needs no mark or FX', () => {
  const p = position({ long: { exchange: 'binance', symbol: 'BTCUSDC', quoteCurrency: 'USDC' }, entryFx: fx(END) });
  assert.equal(fundingLedger(p, reports(p, [settled(START + HOUR)]), END).estimated, null);
  const zero = fundingLedger(p, reports(p, [settled(START + HOUR, '0', null)]), END);
  assert.equal(zero.confirmed, 0); assert.equal(zero.entries[0].amountUSDT, '0');
});
test('partial history, missing leg, mismatched contract and late data never masquerade as zero', () => {
  const p = position(), r = reports(p, [settled(START + HOUR)]);
  r.long.complete = false; assert.equal(fundingLedger(p, r, END).confirmed, null); assert.equal(fundingLedger(p, r, END).known, -2);
  delete r.short; assert.equal(fundingLedger(p, r, END).through, null);
  r.short = report(p.short, [], { symbol: 'ETHUSDT' }); assert.equal(fundingLedger(p, r, END).confirmed, null);
  r.long.complete = true; r.short = report(p.short, [settled(START + HOUR)]); assert.equal(fundingLedger(p, r, END).confirmed, 0);
});
test('old positions remain legacy and do not have their price-only result recomputed', () => {
  const p = position({ accountingVersion: 2, result: { net: 42 } }), before = structuredClone(p), result = fundingLedger(p, reports(p, [settled(START + HOUR)]), END);
  assert.equal(result.status, 'legacy'); assert.equal(result.confirmed, null); assert.deepEqual(p, before); assert.deepEqual(result.entries, []);
});
test('Hyperliquid and Lighter do not substitute mark price for oracle/index settlement price', () => {
  for (const exchange of ['hyperliquid', 'lighter']) {
    const p = position({ long: { exchange, symbol: 'BTC', quoteCurrency: 'USDC' }, entryFx: fx(START) });
    p.quantityHistory.push({ at: START + HOUR - 1000, longQuantity: '2', shortQuantity: '2', fx: fx(START + HOUR - 1000) });
    const value = fundingLedger(p, reports(p, [settled(START + HOUR)]), END); assert.equal(value.confirmed, null); assert.equal(value.entries[0].amountNative, null);
  }
});
test('Kraken integrates only the held fraction of each hour and settles when quantity changes', () => {
  const p = position({ openedAt: START + HOUR / 2, closedAt: START + HOUR, long: { exchange: 'kraken', symbol: 'PF_XBTUSD', quoteCurrency: 'USD' }, entryFx: fx(START + HOUR / 2), quantityHistory: [{ at: START + HOUR / 2, longQuantity: '2', shortQuantity: '2' }, { at: START + HOUR - 1000, longQuantity: '2', shortQuantity: '2', fx: fx(START + HOUR - 1000) }] });
  const row = { at: START + HOUR, accrualStart: START, accrualEnd: START + HOUR, rate: '10', unit: 'per_base', markPrice: null, source: 'kraken', intervalHours: 1 };
  const r = reports(p); r.long.accruals = [row]; r.long.settlements = [row];
  const value = fundingLedger(p, r, END);
  assert.equal(value.confirmed, -10); assert.equal(value.entries.reduce((n, entry) => n + Number(entry.amountNative), 0), -10);
});
test('Kraken current-hour accrual is estimated until a close realizes it; gaps stay unknown', () => {
  const p = position({ long: { exchange: 'kraken', symbol: 'PF_XBTUSD', quoteCurrency: 'USD' }, entryFx: fx(START) });
  const now = START + 60_000, r = reports(p); r.long.coveredTo = r.short.coveredTo = now;
  r.long.accruals = [{ at: START + HOUR, accrualStart: START, accrualEnd: START + HOUR, rate: '3', unit: 'per_base', source: 'kraken' }];
  const pending = fundingLedger(p, r, now); assert.equal(pending.confirmed, null); assert.equal(pending.estimated, -0.1); assert.equal(pending.entries[0].quality, 'accrued_unsettled');
  p.closedAt = now; assert.equal(fundingLedger(p, r, now).confirmed, -0.1);
  r.long.accruals = []; assert.equal(fundingLedger(p, r, now).confirmed, null);
});
test('invalid chronological quantity history does not silently use final quantities', () => {
  const p = position(); p.quantityHistory.push({ at: START - 1, longQuantity: '100', shortQuantity: '100' });
  assert.equal(fundingLedger(p, reports(p, [settled(START + HOUR)]), END).status, 'unknown');
});
test('an FX-only observation does not settle Kraken funding or split its accumulation', () => {
  const now = START + 120_000, p = position({ long: { exchange: 'kraken', symbol: 'PF_XBTUSD', quoteCurrency: 'USD' }, entryFx: fx(START), quantityHistory: [{ at: START, longQuantity: '2', shortQuantity: '2' }, { at: now, longQuantity: '2', shortQuantity: '2', fx: fx(now) }] });
  const r = reports(p); r.long.coveredTo = r.short.coveredTo = now;
  r.long.accruals = [{ at: START + HOUR, accrualStart: START, accrualEnd: START + HOUR, rate: '3', unit: 'per_base', source: 'kraken' }];
  const result = fundingLedger(p, r, now); assert.equal(result.confirmed, null); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].quality, 'accrued_unsettled'); assert.equal(result.estimated, -0.2);
});
