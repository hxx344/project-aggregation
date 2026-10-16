import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingPair, fundingStaleReason } from '../src/funding-opportunities.ts';

const now = 1_800_000_000_000;
const long = { exchange: 'bybit', symbol: 'BYBIT_FUTURE_BTC_USDC', quoteCurrency: 'USDC', rate: 0, intervalHours: 1, normalized8hBps: 0, fundingAt: now - 1000, nextFundingAt: null };
const short = { ...long, exchange: 'binance', symbol: 'BINANCE_FUTURE_BTC_USDT', quoteCurrency: 'USDT', rate: 0.0001, intervalHours: 8, normalized8hBps: 1 };
const row = { id: 'funding-btc', base: 'BTC', long, short, equivalent8hBps: 1, grossBps: -12, asOf: now - 1000, expiresAt: now + 9000, eligible: true, reason: '' };
const instruments = [long, short].map(leg => ({ ...leg, base: 'BTC', settlementCurrency: leg.quoteCurrency, lot_size: '0.001', min_size: '0.001', tick_size: '0.1' }));

test('funding direction keeps exact native contracts and never falls back to a similar contract', () => {
  assert.deepEqual(fundingPair(row, instruments), { long: instruments[0], short: instruments[1] });
  for (const change of [{ symbol: 'BYBIT_FUTURE_BTC_USDT' }, { base: 'ETH' }, { exchange: 'binance' }, { quoteCurrency: 'USDT' }]) {
    assert.equal(fundingPair(row, [{ ...instruments[0], ...change }, instruments[1]]), null);
  }
  assert.equal(fundingPair({ ...row, short: long }, instruments), null);
  assert.equal(fundingPair(row, []), null);
});

test('funding selections use CrossEx counter currency and verified base aliases', () => {
  const hyperliquid = { ...long, exchange: 'hyperliquid', symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', quoteCurrency: 'USDT' };
  const catalogLeg = { ...instruments[0], ...hyperliquid, quoteCurrency: 'USDC' };
  assert.deepEqual(fundingPair({ ...row, long: hyperliquid }, [catalogLeg, instruments[1]]), { long: catalogLeg, short: instruments[1] });
  assert.equal(fundingPair({ ...row, long: hyperliquid }, [{ ...catalogLeg, quoteCurrency: 'USDT' }, instruments[1]]), null);
  const gate = { ...long, exchange: 'gate', symbol: 'GATE_FUTURE_LUNA_USDT', quoteCurrency: 'USDT' };
  const binance = { ...short, symbol: 'BINANCE_FUTURE_LUNA2_USDT' };
  const aliasCatalog = [{ ...instruments[0], ...gate, base: 'LUNA' }, { ...instruments[1], ...binance, base: 'LUNA2' }];
  assert.deepEqual(fundingPair({ ...row, base: 'LUNA2', long: gate, short: binance }, aliasCatalog), { long: aliasCatalog[0], short: aliasCatalog[1] });
  assert.equal(fundingPair({ ...row, base: 'LUNC', long: gate, short: binance }, aliasCatalog), null);
});

test('a visible funding opportunity expires without another poll and respects source failure', () => {
  assert.equal(fundingStaleReason(row, now, false), '');
  assert.equal(fundingStaleReason(row, row.expiresAt, false), '机会数据已过期，等待更新');
  assert.equal(fundingStaleReason(row, now, true), 'Monitor 行情待更新');
  for (const expiresAt of [undefined, null, NaN, Infinity]) assert.notEqual(fundingStaleReason({ ...row, expiresAt }, now, false), '');
  assert.notEqual(fundingStaleReason({ ...row, asOf: now + 1001 }, now, false), '');
  assert.notEqual(fundingStaleReason(row, NaN, false), '');
});

test('missing eligibility evidence cannot become a fillable direction', () => {
  assert.equal(fundingStaleReason({ ...row, eligible: false, reason: '缺少同两腿的筛选证据' }, now, false), '缺少同两腿的筛选证据');
  assert.equal(fundingStaleReason({ ...row, eligible: false }, now, false), '机会数据待核实');
});
