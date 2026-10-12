import test from 'node:test';
import assert from 'node:assert/strict';
import { contractFeeMaxAgeMs, defaultQualityBudget, pairTakerFees, parseQualityBudget, resolveTakerFee } from '../lib/perpetual-fees.ts';

const NOW = Date.UTC(2026, 8, 21, 8);
const quote = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', ...patch });
const metadata = (exchange, source, rate, patch = {}) => quote(exchange, { takerFeeSource: source, takerFeeRate: rate, takerFeeAt: NOW, ...patch });

test('public taker selection respects quote currencies, native namespaces and Gate ordinary-account scope', () => {
  for (const [row, expected] of [
    [quote('binance'), 0.05], [quote('binance', { quoteCurrency: 'USDC' }), 0.04],
    [quote('binance', { quoteCurrency: 'USD1' }), null], [quote('binance', { base: 'BINANCE:RWA:BTC' }), null],
    [quote('gate', { takerFeeRate: 0.00075 }), 0.05], [quote('gate', { base: 'GATE:PREMARKET:BTC' }), null],
    [quote('hyperliquid', { symbol: 'BTC', quoteCurrency: 'USDC' }), 0.045],
    [quote('hyperliquid', { symbol: 'BTC', quoteCurrency: 'USDT' }), 0.045],
    [quote('hyperliquid', { symbol: 'io:BTC', quoteCurrency: 'USDC' }), null],
    [quote('entropy'), null], [quote('bybit'), null], [quote('okx'), null],
  ]) assert.equal(resolveTakerFee(row, {}, NOW).percent, expected);
  assert.match(resolveTakerFee(quote('gate'), {}, NOW).detail, /点卡/);
});

test('contract metadata converts decimal units and preserves verified zero without a fallback on missing sources', () => {
  for (const [venue, source, rate, expected] of [
    ['bitget', 'bitget-contract', 0.0006, 0.06],
    ['bybit', 'bybit-standard', 0.0011, 0.11],
    ['okx', 'okx-standard', 0.0005, 0.05],
    ['lighter', 'lighter-standard', 0, 0],
    ['rh-lighter', 'rh-lighter-standard', 0, 0],
    ['aster', 'aster-standard', 0.00009, 0.009],
    ['entropy', 'entropy-standard', 0.00009, 0.009],
  ]) {
    const row = metadata(venue, source, rate), fee = resolveTakerFee(row, {}, NOW);
    assert.ok(Math.abs(fee.percent - expected) < 1e-12);
    assert.equal(fee.basis, 'public');
    assert.equal(fee.checkedAt, NOW);
    assert.equal(resolveTakerFee({ ...row, takerFeeSource: 'wrong-source' }, {}, NOW).percent, null);
    for (const invalid of [null, undefined, '', '0', -0.001, NaN, Infinity, 0.101]) assert.equal(resolveTakerFee({ ...row, takerFeeRate: invalid }, {}, NOW).percent, null);
  }
});

test('public contract fee freshness is independent from quote ticks and cannot be revived by an old snapshot', () => {
  const row = metadata('bitget', 'bitget-contract', 0.0006);
  assert.equal(resolveTakerFee(row, {}, NOW + contractFeeMaxAgeMs).percent, 0.06);
  const expired = resolveTakerFee({ ...row, receivedAt: NOW + contractFeeMaxAgeMs + 1 }, {}, NOW + contractFeeMaxAgeMs + 1);
  assert.equal(expired.percent, null);
  assert.match(expired.detail, /15 分钟/);
  for (const time of [null, 0, NaN, Infinity, NOW + 5_001]) assert.equal(resolveTakerFee({ ...row, takerFeeAt: time }, {}, NOW).percent, null);
});

test('round-trip fees count both taker legs on entry and exit; account overrides take precedence including zero', () => {
  const row = { long: quote('binance'), short: metadata('bybit', 'bybit-standard', 0.0011) };
  assert.equal(pairTakerFees(row, {}, NOW).roundTripPercent, 0.32);
  const vip = pairTakerFees(row, { binance: 0, bybit: 0.04 }, NOW);
  assert.equal(vip.roundTripPercent, 0.08);
  assert.equal(vip.long.basis, 'account');
  assert.equal(vip.short.basis, 'account');
  assert.equal(resolveTakerFee({ ...row.short, takerFeeAt: 0 }, { bybit: 0 }, NOW).percent, 0);
  assert.equal(pairTakerFees({ ...row, short: quote('entropy') }, {}, NOW).roundTripPercent, null);
  assert.equal(resolveTakerFee(quote('binance'), { binance: -1 }, NOW).percent, null);
});

test('v2 account settings validate bounded venue keys, reject coercion and retain legitimate zero', () => {
  const parsed = parseQualityBudget(JSON.stringify({ version: 2, takerOverrides: { binance: 0, bybit: 0.055, gate: '0.1', okx: -1, bitget: 10.1, mystery: 0 }, slippagePercent: 0 }));
  assert.deepEqual(parsed, { takerOverrides: { binance: 0, bybit: 0.055 }, slippagePercent: 0 });
  for (const values of [null, [], 'hello', 2]) assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 2, takerOverrides: values })), defaultQualityBudget);
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: 0.24, takerOverrides: { gate: 10 }, slippagePercent: 0.3 })), { takerOverrides: {}, slippagePercent: 0.3 });
});
