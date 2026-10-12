import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogRule, commonQuantity, configuration, fill, freshQuote, monitorUrl, validateBooks, validateFeed, validSignal, validIdentity, contractIdentity } from '../server/model.mjs';
import { epoch, quote, feed, catalog, book } from './fixtures.mjs';
test('loopback source URLs only; credentials and unsafe paths are rejected', () => {
  assert.equal(monitorUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  for (const value of ['http://169.254.169.254', 'http://localhost.evil.test', 'https://example.com', 'http://user:secret@localhost', 'http://localhost/?x=y', 'http://localhost/api']) assert.throws(() => monitorUrl(value));
});
test('settings require bounded numeric inputs and reject unknown or inherited keys', () => {
  for (const value of [{ enabled: 'true' }, { maxOpen: 1.5 }, { feeBps: NaN }, { notionalPerLeg: -1 }, { maxTotalNotional: 20 }, { constructor: {} }]) assert.throws(() => configuration(value));
});
test('per-leg book time, identity and quote currency are enforced independently', () => {
  assert.ok(freshQuote(quote('binance'), epoch));
  for (const extra of [{ bidAskAt: epoch - 10001 }, { bidAskAt: epoch + 5000, receivedAt: epoch + 5000 }, { multiplier: 1000 }, { collateralCurrency: 'USDC' }, { identityVerified: false }, { assetClass: 'equity' }, { bid: 101 }, { receivedAt: null }]) assert.equal(!!freshQuote(quote('binance', epoch, extra), epoch), false);
});
test('version, mode, heartbeat freshness and quote limits gate signal envelopes', () => {
  assert.equal(validateFeed(feed(), epoch).schemaVersion, 1);
  assert.equal(validateFeed({ ...feed(), schemaVersion: 2 }, epoch).schemaVersion, 2);
  for (const extra of [{ mode: 'live' }, { schemaVersion: 3 }, { generatedAt: epoch - 10001 }, { generatedAt: epoch + 5000 }, { status: 'snapshot' }, { quotes: Array(5001).fill({}) }]) assert.throws(() => validateFeed({ ...feed(), ...extra }, epoch));
});
test('signal expiry, direction, venue status and pairing are not trusted', () => {
  const value = feed(); assert.equal(validSignal(value.signals[0], value, epoch), true);
  for (const extra of [{ expiresAt: undefined }, { expiresAt: epoch - 1 }, { pairKey: 'fake' }, { long: quote('binance', epoch - 6000) }, { short: quote('bybit', epoch, { delisting: true }) }]) assert.equal(validSignal({ ...value.signals[0], ...extra }, value, epoch), false);
  value.exchanges[1].status = 'error'; assert.equal(validSignal(value.signals[0], value, epoch), false);
});

test('manual identity flags cannot authorize Monitor signals or disguise a changed asset class', () => {
  const snapshot = feed(), signal = snapshot.signals[0];
  const manual = { ...signal.long, identityScope: 'manual', nativeUnit: '1', comparable: true };
  assert.equal(validIdentity(manual), false); assert.equal(freshQuote(manual, epoch), false);
  assert.equal(validSignal({ ...signal, long: manual }, { ...snapshot, quotes: [manual, signal.short] }, epoch), false);
  assert.notEqual(contractIdentity(signal.long), contractIdentity(manual));
  for (const changes of [{ assetClass: 'commodity' }, { nativeUnit: '0.01' }, { comparable: false }]) assert.notEqual(contractIdentity(signal.long), contractIdentity({ ...signal.long, ...changes }));
});
test('CrossEx exact venue/contract matching, suspension and missing limits fail closed', () => {
  assert.equal(catalogRule(quote('binance'), catalog).symbol, 'BINANCE_FUTURE_BTC_USDT');
  for (const extra of [{ state: 'suspend' }, { delist_time: String(epoch + 10000) }, { lot_size: null }, { business_type: 'SPOT' }, { min_notional: undefined }]) assert.throws(() => catalogRule(quote('binance'), [{ ...catalog[0], ...extra }]));
});
test('equal base-quantity uses the exact common lot, with minimum and maximum sizes', () => {
  const rules = [{ ...catalog[0], lot_size: '0.002' }, { ...catalog[1], lot_size: '0.003' }];
  assert.equal(commonQuantity(100, [100, 102], rules), 0.978);
  assert.throws(() => commonQuantity(1, [100, 102], rules));
  assert.equal(commonQuantity(1000, [100, 102], rules.map(r => ({ ...r, max_market_size: '0.1' }))), 0.096);
  const centRules = rules.map(r => ({ ...r, lot_size: '0.01', min_size: '0.01', min_notional: '0', max_market_size: '0.29' }));
  assert.equal(commonQuantity(100, [1, 1], centRules), 0.29);
  assert.equal(commonQuantity(0.29, [1, 1], centRules.map(r => ({ ...r, max_market_size: null }))), 0.29);
});
test('depth walks levels, never double counts slippage, and rejects partial fills', () => {
  const result = fill([[100, 1], [101, 2]], 2, 'buy', 100); assert.equal(result.price, 100.5); assert.equal(result.notional, 201);
  assert.throws(() => fill([[100, 1], [101, 2]], 2, 'buy', 50)); assert.throws(() => fill([[100, 1]], 2, 'buy', 100));
});
test('unsorted, crossed, stale and asynchronous depth cannot be used', () => {
  const a = book(quote('binance')), b = book(quote('bybit')); validateBooks([a, b], epoch);
  for (const extra of [{ at: epoch - 10001 }, { at: epoch + 1001 }, { asks: [[100, 1], [99, 1]] }, { bids: [[101, 1]] }, { asks: [] }, { asks: [[100, -1]] }]) assert.throws(() => validateBooks([{ ...a, ...extra }, b], epoch));
  assert.throws(() => validateBooks([a, { ...b, at: epoch - 6000 }], epoch));
});
