import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { discoverMarkets } from '../modules/perpetual/exchanges.mjs';
import { defaultPerpetualFilters, rankPerpetualSpreads } from '../lib/perpetual-spreads.ts';
import { defaultQualityBudget } from '../lib/perpetual-fees.ts';
import { perpetualChartUrl, readPerpetualChartSelection, validPerpetualChartSelection } from '../lib/perpetual-chart-state.ts';
import { createPerpetualPriceReader } from '../server/perpetual-price-reader.mjs';
import { createPerpetualPriceHistoryService } from '../server/perpetual-price-history.mjs';

// Producer → consumer contract: real directory discovery, real ranking, the
// chart URL round trip, then the real history service and price reader. Only
// the venues' HTTP responses are fixtures; no layer gets a hand-made market.
const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 30, 12, 30);
const ok = data => ({ ok: true, json: async () => data });
const cex = baseAsset => ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', underlyingSubType: [] });
const bybit = (baseCoin, quoteCoin, extra = {}) => ({ symbol: `${baseCoin}${quoteCoin}`, baseCoin, quoteCoin, settleCoin: quoteCoin, status: 'Trading', contractType: 'LinearPerpetual', isPreListing: false, symbolType: '', ...extra });

async function directoryFetch(input, init = {}) {
  const url = String(input), body = init.body ? JSON.parse(init.body) : null;
  if (url.endsWith('/fapi/v1/fundingInfo')) return ok([]);
  if (url === 'https://fapi.binance.com/fapi/v1/exchangeInfo') return ok({ symbols: ['BTC', 'ETH', 'HYPE', 'PURR', '币安人生'].map(cex) });
  if (url === 'https://fapi.asterdex.com/fapi/v1/exchangeInfo') return ok({ symbols: ['BTC', '币安人生'].map(cex) });
  if (url.startsWith('https://api.bybit.com/v5/market/instruments-info')) return ok({ retCode: 0, result: { nextPageCursor: '', list: [bybit('BTC', 'USD1'), bybit('SNDK', 'USDT', { symbolType: 'stock', marketRegion: 'US', underlyingTicker: 'SNDK' })] } });
  if (body?.type === 'meta' && body.dex === 'io') return ok({ collateralToken: 0, universe: [{ name: 'io:SNDK', deployerFeeScale: 0, growthMode: 'disabled' }] });
  if (body?.type === 'meta') return ok({ universe: ['BTC', 'ETH', 'HYPE', 'PURR'].map(name => ({ name, szDecimals: 2, maxLeverage: 10 })) });
  throw Error(`unexpected directory request ${url}`);
}

/** Answers every official candle endpoint and records the contract it was asked for. */
function historyFetch(calls) {
  const rows = (from, to) => { const list = []; for (let open = Math.ceil(from / HOUR) * HOUR; open <= to; open += HOUR) list.push(open); return list; };
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.host === 'api.hyperliquid.xyz') {
      const { type, req } = JSON.parse(init.body);
      assert.equal(type, 'candleSnapshot'); calls.push(`hyperliquid-api:${req.coin}`);
      return ok(rows(req.startTime, req.endTime).map(open => ({ t: open, T: open + HOUR - 1, c: '100', i: '1h', s: req.coin })));
    }
    const symbol = url.searchParams.get('symbol'); calls.push(`${url.host}:${symbol}`);
    const start = Number(url.searchParams.get('startTime') ?? url.searchParams.get('start')), end = Number(url.searchParams.get('endTime') ?? url.searchParams.get('end'));
    const list = rows(start, end).map(open => [open, '100', '100', '100', '100', '1', open + HOUR - 1]);
    if (url.host === 'api.bybit.com') return ok({ retCode: 0, result: { category: 'linear', symbol, list: list.reverse() } });
    return ok(list);
  };
}

async function setup(t) {
  const discovered = (await Promise.all(['binance', 'aster', 'hyperliquid', 'bybit', 'entropy'].map(id => discoverMarkets(id, { fetchImpl: directoryFetch, now: NOW })))).flat();
  const markets = new Map(discovered.map(market => [`${market.exchange}:${market.symbol}`, market]));
  const quotes = discovered.map(market => ({ ...market, bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: NOW + HOUR, sourceTime: NOW, receivedAt: NOW, bidAskAt: NOW, markAt: NOW, fundingAt: NOW, transport: 'ws' }));
  const snapshot = { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: NOW, staleAfterMs: 30_000, quotes,
    exchanges: ['binance', 'aster', 'hyperliquid', 'bybit', 'entropy'].map(id => ({ id, name: id, kind: ['binance', 'bybit'].includes(id) ? 'cex' : 'dex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: NOW, error: null })) };
  const fx = { baseCurrency: 'USDT', generatedAt: NOW, staleAfterMs: 180_000, rates: { USDC: { bid: 1, ask: 1, at: NOW, source: 'fixture' }, USD1: { bid: 1, ask: 1, at: NOW, source: 'fixture' } } };
  const ranked = rankPerpetualSpreads(snapshot, { ...defaultPerpetualFilters, crossCurrency: true, applyNumericThresholds: false }, NOW, defaultQualityBudget, fx);
  const calls = [], reader = createPerpetualPriceReader({ clock: () => NOW, requestSpacingMs: 0, fetchImpl: historyFetch(calls) });
  const service = createPerpetualPriceHistoryService({ getSnapshot: () => snapshot, getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => NOW, hostSpacingMs: 0, reader });
  service.start(); t.after(() => service.stop());
  return { markets, ranked, calls, reader, service };
}
// The panel's openChart() builds the selection exactly this way.
const selectionOf = row => ({ base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, days: 7 });
const rowFor = (ranked, base, long, short) => ranked.find(row => row.base === base && row.long.exchange === long && row.short.exchange === short);
const reload = href => readPerpetualChartSelection(new URL(href).searchParams);

const CASES = [
  // Unicode native code accepted by discovery (Binance/Aster 币安人生USDT).
  { base: '币安人生', long: 'binance', short: 'aster', upstream: ['fapi.binance.com:币安人生USDT', 'fapi.asterdex.com:币安人生USDT'], currency: ['USDT', 'USDT'] },
  // Hyperliquid BTC/ETH: USDT-quoted, USDC-settled directory identity.
  { base: 'BTC', long: 'binance', short: 'hyperliquid', upstream: ['fapi.binance.com:BTCUSDT', 'hyperliquid-api:BTC'], currency: ['USDT', 'USDT'] },
  { base: 'ETH', long: 'hyperliquid', short: 'binance', upstream: ['hyperliquid-api:ETH', 'fapi.binance.com:ETHUSDT'], currency: ['USDT', 'USDT'] },
  // HYPE/PURR are USDC-quoted on Hyperliquid.
  { base: 'HYPE', long: 'binance', short: 'hyperliquid', upstream: ['fapi.binance.com:HYPEUSDT', 'hyperliquid-api:HYPE'], currency: ['USDT', 'USDC'] },
  { base: 'PURR', long: 'hyperliquid', short: 'binance', upstream: ['hyperliquid-api:PURR', 'fapi.binance.com:PURRUSDT'], currency: ['USDC', 'USDT'] },
  // Entropy io namespace against a verified Bybit share contract.
  { base: 'EQUITY:SNDK', long: 'bybit', short: 'entropy', upstream: ['api.bybit.com:SNDKUSDT', 'hyperliquid-api:io:SNDK'], currency: ['USDT', 'USDC'] },
];

test('discovered and ranked contracts survive chart URL reloads, direction swaps and reach official price history', async t => {
  for (const item of CASES) {
    // One service per pair: leases of earlier pairs would otherwise share host slots.
    const f = await setup(t), row = rowFor(f.ranked, item.base, item.long, item.short);
    assert.ok(row, `${item.base} ${item.long}/${item.short} must be ranked`);
    const selection = selectionOf(row);
    assert.equal(validPerpetualChartSelection(selection), true, item.base);
    const href = perpetualChartUrl('https://local.example/?monitor=perpetual', selection);
    assert.deepEqual(reload(href), selection, `${item.base} shared/reloaded URL`);
    const swapped = { ...selection, longKey: selection.shortKey, shortKey: selection.longKey, days: 30 };
    assert.deepEqual(reload(perpetualChartUrl(href, swapped)), swapped, `${item.base} direction swap`);

    const decoded = reload(href);
    const pending = f.service.read({ pair: decoded, days: decoded.days });
    assert.deepEqual(Object.keys(pending.legs), [decoded.longKey, decoded.shortKey]);
    for (let i = 0; i < 4; i++) { await f.service.collect(); await turn(); }
    const report = f.service.read({ pair: decoded, days: decoded.days });
    [decoded.longKey, decoded.shortKey].forEach((key, index) => {
      const leg = report.legs[key];
      assert.equal(leg.error, '', `${key} must not be rejected`);
      assert.ok(leg.points.length >= 72 && leg.points.every(point => point.close === 100), key);
      assert.equal(leg.currency, item.currency[index], `${key} keeps the directory quote currency`);
    });
    assert.deepEqual([...new Set(f.calls)].sort(), [...item.upstream].sort(), item.base);
  }
});

test('unsupported currencies and wrong identities fail before any upstream request', async t => {
  const f = await setup(t);
  const range = { from: Math.floor(NOW / HOUR) * HOUR - 72 * HOUR, to: Math.floor(NOW / HOUR) * HOUR };
  // Discovered, but no verified history endpoint for this quote currency.
  await assert.rejects(f.reader(f.markets.get('bybit:BTCUSD1'), range), { code: 'UNSUPPORTED' });
  // Hyperliquid acceptance depends on its USDC settlement contract.
  await assert.rejects(f.reader({ ...f.markets.get('hyperliquid:BTC'), settlementCurrency: 'USDT' }, range), { code: 'UNSUPPORTED' });
  await assert.rejects(f.reader({ ...f.markets.get('hyperliquid:BTC'), quoteCurrency: 'USD1' }, range), { code: 'UNSUPPORTED' });
  await assert.rejects(f.reader({ ...f.markets.get('binance:币安人生USDT'), symbol: '币安人生USDT/../x' }, range), /合约无效/);

  const unicode = selectionOf(rowFor(f.ranked, '币安人生', 'binance', 'aster'));
  for (const pair of [
    { ...unicode, base: 'BTC' }, // base differs from the directory identity
    { ...unicode, longKey: 'binance:币安人生USDC' }, // not in the directory
    { ...unicode, shortKey: 'binance:BTCUSDT' }, // same venue
    { ...unicode, longKey: 'binance:币安 人生USDT' }, { ...unicode, longKey: 'binance:币安人生\u0000USDT' }, { ...unicode, longKey: 'binance:币安/人生USDT' },
    { ...unicode, longKey: 'binance:币安人生USDT?x=1' }, { ...unicode, base: '币安人生#' }, { ...unicode, base: '币'.repeat(101) },
  ]) {
    assert.throws(() => f.service.read({ pair, days: 7 }), { status: 400 }, JSON.stringify(pair));
  }
  for (const update of [{ longKey: 'binance:币安 人生USDT' }, { longKey: 'binance:币安人生\nUSDT' }, { longKey: 'binance:币安/人生USDT' }, { base: '币安人生%2F' }, { base: '币'.repeat(101) }, { longKey: `binance:${'币'.repeat(152)}` }]) {
    assert.equal(validPerpetualChartSelection({ ...unicode, ...update }), false, JSON.stringify(update));
  }
  for (let i = 0; i < 3; i++) { await f.service.collect(); await turn(); }
  assert.deepEqual(f.calls, []);
});
