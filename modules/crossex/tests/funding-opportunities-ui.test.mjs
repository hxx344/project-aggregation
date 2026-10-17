import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingCapitalRoc, fundingPair, fundingStaleReason } from '../src/funding-opportunities.ts';

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

test('funding capital efficiency uses the shared assumptions and never hides missing gross quotes', () => {
  const roc = fundingCapitalRoc(row);
  const capital = (100 / 3 + (1 - 12 / 10000) * 100 / 3) * 1.2;
  assert.ok(Math.abs(roc.capitalPercent - capital) < 1e-9);
  assert.ok(Math.abs(roc.rocPercent - 0.03 * (1 - 12 / 10000) / capital * 100) < 1e-9);
  assert.ok(Math.abs(roc.fundingRocAnnualizedPercent - 10.95 * (1 - 12 / 10000) / capital * 100) < 1e-9);
  assert.equal(roc.reason, '');

  for (const patch of [{ grossBps: null }, { grossBps: NaN }, { equivalent8hBps: NaN }]) {
    const missing = fundingCapitalRoc({ ...row, ...patch });
    assert.equal(missing.rocPercent, null);
    assert.notEqual(missing.reason, '');
  }
});

test('funding ROC weights both notionals and normalizes each funding interval', () => {
  const result = fundingCapitalRoc({ ...row, grossBps: 1000,
    long: { ...long, rate: .005, intervalHours: 4 }, short: { ...short, rate: .01, intervalHours: 8 } });
  assert.ok(Math.abs(result.rocPercent - .3 / 84 * 100) < 1e-9);
  const negative = fundingCapitalRoc({ ...row, grossBps: -1000,
    long: { ...long, rate: .01, intervalHours: 8 }, short: { ...short, rate: .0101, intervalHours: 8 } });
  assert.ok(negative.rocPercent < 0, 'positive equal-notional carry can lose money for equal-quantity legs');
  for (const invalid of [{ rate: NaN }, { intervalHours: 0 }, { intervalHours: 169 }]) {
    const missing = fundingCapitalRoc({ ...row, long: { ...long, ...invalid } });
    assert.equal(missing.rocPercent, null);
    assert.equal(missing.fundingRocAnnualizedPercent, null);
    assert.match(missing.reason, /资金费缺失/);
  }
});
