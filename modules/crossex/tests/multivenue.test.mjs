import test from 'node:test';
import assert from 'node:assert/strict';
import { validIdentity, validSignal, catalogRule, pnl, fxRate, commonQuantity, pairKey, contractIdentity } from '../server/model.mjs';
import { fixture, quote, feed, epoch, catalog } from './fixtures.mjs';
const ids = ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter'];
function leg(id, at = epoch, extra = {}) {
  const currency = ['bybit', 'okx', 'lighter'].includes(id) ? 'USDC' : id === 'kraken' ? 'USD' : 'USDT';
  const settle = id === 'hyperliquid' ? 'USDC' : currency;
  const symbol = { binance: 'BTCUSDT', bybit: 'BTCPERP', okx: 'BTC-USDC-SWAP', gate: 'BTC_USDT', kraken: 'PF_XBTUSD', hyperliquid: 'BTC', lighter: 'BTC' }[id];
  return quote(id, at, { symbol, quoteCurrency: currency, rawBase: 'BTC', settlementCurrency: settle, collateralCurrency: id === 'kraken' ? 'MULTI' : settle, contractKind: id === 'hyperliquid' ? 'quanto' : 'linear', counterCurrency: settle, crossexSymbol: `${id.toUpperCase()}_FUTURE_BTC_${settle}`, ...(id === 'lighter' ? { marketId: 1 } : {}), ...extra });
}
const fx = (at = epoch) => ({ baseCurrency: 'USDT', generatedAt: at, staleAfterMs: 180000, rates: { USDC: { bid: 0.998, ask: 1.002, at, source: 'Gate spot' }, USD: { bid: 1.01, ask: 1.02, at, source: 'Kraken inverse USD' } } });
const rule = q => ({ ...catalog[0], symbol: q.crossexSymbol, exchange_type: q.exchange.toUpperCase(), min_notional: ['gate', 'okx'].includes(q.exchange) ? null : '5', max_market_size: ['hyperliquid', 'lighter'].includes(q.exchange) ? null : '1000' });
test('signals must retain current quote identity and lifecycle evidence', () => {
  const value = feed(), signal = value.signals[0];
  assert.equal(validSignal(signal, value, epoch), true);
  for (const patch of [{ settlementCurrency: 'USD' }, { identityVerified: false }, { delisting: true }, { bidAskAt: epoch - 10001 }]) {
    assert.equal(validSignal(signal, { ...value, quotes: value.quotes.map(q => q.exchange === signal.long.exchange ? { ...q, ...patch } : q) }, epoch), false);
  }
});
test('seven exact native identities accepted, unsupported and spoofed mappings rejected', () => {
  for (const id of ids) {
    const q = leg(id); assert.equal(validIdentity(q), true, id); assert.equal(catalogRule(q, [rule(q)]).symbol, q.crossexSymbol);
    for (const patch of [{ crossexSymbol: 'DERIBIT_FUTURE_BTC_USDC' }, { settlementCurrency: 'EUR' }, { symbol: 'FAKE' }, { rawBase: 'ETH' }, { multiplier: 1000 }, { assetClass: 'stock' }, { identityVerified: false }]) assert.equal(validIdentity({ ...q, ...patch }), false, `${id}:${JSON.stringify(patch)}`);
  }
  assert.equal(validIdentity(leg('binance', epoch, { exchange: 'deribit' })), false);
  assert.equal(contractIdentity(quote('binance')), contractIdentity(leg('binance')), 'old USDT positions keep identity');
});
test('explicit null rule constraints are recorded, malformed or missing constraints still reject', () => {
  const q = leg('gate'), r = catalogRule(q, [rule(q)]); assert.equal(r.min_notional, null); assert.match(r.unverifiedConstraints[0], /最小名义额/);
  const h = leg('hyperliquid'), hr = catalogRule(h, [rule(h)]); assert.equal(hr.max_market_size, null); assert.ok(commonQuantity(100, [100, 102], [r, hr]) > 0);
  for (const min_notional of [undefined, '', ' ', -1, NaN]) assert.throws(() => catalogRule(q, [{ ...rule(q), min_notional }]));
  for (const max_market_size of [undefined, '', 0, -1, Infinity]) assert.throws(() => catalogRule(h, [{ ...rule(h), max_market_size }]));
});
test('native derivative PnL avoids inventing profit from FX changes, fees retain entry FX', () => {
  const p = { long: leg('hyperliquid'), short: leg('kraken'), quantity: 2, longFill: { price: 100 }, shortFill: { price: 102 }, entryFees: 0.75, feeBps: 0 };
  assert.equal(pnl(p, 100, 102, fx(), epoch).gross, 0);
  const rates = fx(); rates.rates.USDC = { ...rates.rates.USDC, bid: 0.8, ask: 0.9 }; rates.rates.USD = { ...rates.rates.USD, bid: 1.2, ask: 1.3 };
  assert.equal(pnl(p, 100, 102, rates, epoch).net, -0.75);
  const marked = pnl(p, 101, 103, rates, epoch); assert.ok(Math.abs(marked.gross - (2 * 0.8 - 2 * 1.3)) < 1e-12);
  assert.throws(() => pnl(p, 101, 103, fx(epoch - 180001), epoch), /汇率/);
  assert.throws(() => fxRate('USD', null, epoch), /汇率/);
});
for (const id of ids) test(`${id} participates in equal-quantity paper open and close with persistence`, async t => {
  const f = fixture(t), long = id === 'binance' ? leg('gate', epoch, { bid: 99, ask: 100 }) : leg('binance'), short = leg(id, epoch, { bid: 103, ask: 104 });
  const value = { ...feed(), schemaVersion: 2, fx: fx(), quotes: [long, short], exchanges: [long, short].map(q => ({ id: q.exchange, status: 'live' })) };
  const signal = { id: `multi-${id}`, pairKey: pairKey({ base: 'BTC', long, short }), base: 'BTC', quoteCurrency: 'USDT', long, short, observedAt: epoch, expiresAt: epoch + 10000 };
  value.signals = [signal]; f.setFeed(value); f.setCatalog([rule(long), rule(short)]);
  await f.engine.tick(); assert.equal(f.engine.view().opportunities[0].eligible, true);
  const opened = await f.engine.open(signal.id, `open-${id}-request`);
  assert.ok(opened.longFill.notionalUSDT <= 100); assert.ok(opened.shortFill.notionalUSDT <= 100); assert.equal(opened.quantity, opened.shortFill.quantity);
  await f.reopen(); await f.engine.tick(); assert.equal(f.engine.view().positions.length, 1);
  const closed = await f.engine.closePosition(opened.id, `close-${id}-request`);
  assert.ok(Number.isFinite(closed.result.net)); assert.equal(f.engine.view().totals.closedCount, 1);
});
test('FX expiry and changed settlement identity cannot produce a fresh valuation or close', async t => {
  const f = fixture(t), long = leg('binance'), short = leg('hyperliquid'), value = { ...feed(), schemaVersion: 2, fx: fx(), quotes: [long, short], exchanges: [long, short].map(q => ({ id: q.exchange, status: 'live' })) };
  value.signals = [{ ...feed().signals[0], id: 'fx-identity-test', long, short, pairKey: pairKey({ base: 'BTC', long, short }) }];
  f.setCatalog([rule(long), rule(short)]); f.setFeed(value); await f.engine.tick(); const p = await f.engine.open(value.signals[0].id, 'fx-open-request');
  f.setFeed({ ...value, fx: fx(epoch - 180001) }); await f.engine.tick(); assert.equal(f.engine.view().positions[0].valuation.stale, true); assert.equal(f.engine.view().totals.unrealizedPnl, null);
  await assert.rejects(f.engine.closePosition(p.id, 'fx-close-request'), /汇率/);
  f.setFeed({ ...value, quotes: [long, { ...short, settlementCurrency: 'USDT' }] }); await f.engine.tick();
  await assert.rejects(f.engine.closePosition(p.id, 'identity-close-request'), /身份/);
  assert.equal(f.engine.view().totals.openCount, 1);
});
