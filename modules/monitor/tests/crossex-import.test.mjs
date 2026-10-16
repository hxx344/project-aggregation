import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCrossExImport, createCrossExImportId } from '../lib/crossex-import.ts';
import { createPerpetualClock } from '../lib/perpetual-feed.ts';
import { cleanHubQuery } from '../../../server/hub-navigation.mjs';

const NOW = 1_800_000_000_000;
const options = { connected: true, now: NOW, staleAfterMs: 30_000, priceMode: 'book', opportunityKind: 'spread' };
const quote = (exchange = 'binance', symbol = 'BTCUSDT', extra = {}) => ({
  exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', multiplier: 1,
  bid: 100, ask: 101, mark: 100.5, last: 100, fundingRate: .0001, fundingIntervalHours: 8,
  nextFundingAt: NOW + 3600000, sourceTime: NOW, receivedAt: NOW, bidAskAt: NOW, markAt: NOW, fundingAt: NOW,
  assetClass: 'crypto', identitySource: 'official-instrument-metadata', transport: 'ws', ...extra,
});
const pair = (long = quote(), short = quote('bybit')) => ({ base: long.base, long, short });
const prepare = (row = pair(), overrides = {}) => prepareCrossExImport(row, { ...options, ...overrides });

test('ordinary public snapshots produce exact contracts for all seven supported venues', () => {
  const cases = [
    ['binance', 'BTCUSDT', 'USDT', 'BINANCE_FUTURE_BTC_USDT'],
    ['bybit', 'BTCUSDT', 'USDT', 'BYBIT_FUTURE_BTC_USDT'],
    ['okx', 'BTC-USDT-SWAP', 'USDT', 'OKX_FUTURE_BTC_USDT'],
    ['gate', 'BTC_USDT', 'USDT', 'GATE_FUTURE_BTC_USDT'],
    ['kraken', 'PF_XBTUSD', 'USD', 'KRAKEN_FUTURE_BTC_USD'],
    ['hyperliquid', 'BTC', 'USDT', 'HYPERLIQUID_FUTURE_BTC_USDC'],
    ['lighter', 'BTC', 'USDC', 'LIGHTER_FUTURE_BTC_USDC'],
  ];
  for (const [exchange, symbol, quoteCurrency, contract] of cases) {
    const source = quote(exchange, symbol, { quoteCurrency });
    const peer = quote(exchange === 'binance' ? 'bybit' : 'binance');
    const result = prepare(pair(source, peer));
    assert.equal(result.reason, null, exchange);
    assert.equal(result.query.longContract, contract, exchange);
    assert.equal(result.query.symbol, 'BTC');
    assert.deepEqual(cleanHubQuery({ ...result.query, importId: 'ordinary-snapshot' }), { ...result.query, importId: 'ordinary-snapshot' });
  }
});

test('USDT, USDC and Hyperliquid settlement stay distinct without a default contract fallback', () => {
  const long = quote('binance', 'BTCUSDC', { quoteCurrency: 'USDC' });
  const short = quote('bybit', 'BTCPERP', { quoteCurrency: 'USDC' });
  assert.equal(prepare(pair(long, short)).query.longContract, 'BINANCE_FUTURE_BTC_USDC');
  assert.equal(prepare(pair(long, short)).query.shortContract, 'BYBIT_FUTURE_BTC_USDC');
  assert.equal(prepare(pair(quote('okx', 'BTC-USDC-SWAP', { quoteCurrency: 'USDC' }), short)).query.longContract, 'OKX_FUTURE_BTC_USDC');
  const mixed = prepare(pair(quote('hyperliquid', 'BTC'), quote('bybit'))).query;
  assert.equal(mixed.longContract, 'HYPERLIQUID_FUTURE_BTC_USDC');
  assert.equal(mixed.shortContract, 'BYBIT_FUTURE_BTC_USDT');
  const hype = prepare(pair(quote('hyperliquid', 'HYPE', { base: 'HYPE', quoteCurrency: 'USDC' }), quote('bybit', 'HYPEUSDT', { base: 'HYPE' })));
  assert.equal(hype.query.longContract, 'HYPERLIQUID_FUTURE_HYPE_USDC');
  for (const invalid of [quote('bybit', 'BTCUSDC', { quoteCurrency: 'USDC' }), quote('bybit', 'BTCPERP'), quote('binance', 'BTCUSDT', { quoteCurrency: 'USDC' }), quote('hyperliquid', 'BTC', { quoteCurrency: 'USDC' }), quote('gate', 'BTC_USDC', { quoteCurrency: 'USDC' })]) {
    assert.equal(prepare(pair(invalid, quote('okx', 'BTC-USDT-SWAP'))).query, null, invalid.symbol);
  }
});

test('verified aliases preserve native LUNA contracts and canonical Kraken Bitcoin identity', () => {
  const gate = quote('gate', 'LUNA_USDT', { base: 'LUNA2' });
  const binance = quote('binance', 'LUNA2USDT', { base: 'LUNA2' });
  assert.deepEqual(prepare(pair(gate, binance)).query, {
    symbol: 'LUNA2', longExchange: 'gate', shortExchange: 'binance', longContract: 'GATE_FUTURE_LUNA_USDT',
    shortContract: 'BINANCE_FUTURE_LUNA2_USDT', opportunityKind: 'spread',
  });
  assert.equal(prepare(pair(quote('okx', 'LUNA-USDT-SWAP', { base: 'LUNA2' }), binance)).query.longContract, 'OKX_FUTURE_LUNA_USDT');
  for (const rawBase of ['XBT', 'BTC']) {
    const kraken = quote('kraken', 'PF_XBTUSD', { quoteCurrency: 'USD', rawBase, crossexSymbol: 'KRAKEN_FUTURE_BTC_USD' });
    assert.equal(prepare(pair(kraken)).query.longContract, 'KRAKEN_FUTURE_BTC_USD');
  }
  assert.equal(prepare(pair({ ...gate, rawBase: 'LUNA2' }, binance)).query, null);
  assert.equal(prepare(pair({ ...gate, base: 'LUNC' }, binance)).query, null);
  assert.equal(prepare(pair(quote('kraken', 'PF_BTCUSD', { quoteCurrency: 'USD' }))).query, null);
});

test('spread and funding selections preserve the row long/short direction and carry no order or price fields', () => {
  const row = pair(quote('bybit', 'BTCUSDT', { fundingRate: -.001 }), quote('binance', 'BTCUSDT', { fundingRate: .002 }));
  for (const opportunityKind of ['spread', 'funding']) {
    const result = prepare({ ...row, spreadPercent: 12, buyPrice: 100, sellPrice: 112 }, { opportunityKind });
    assert.equal(result.query.longExchange, 'bybit'); assert.equal(result.query.shortExchange, 'binance');
    assert.equal(result.query.longContract, 'BYBIT_FUTURE_BTC_USDT'); assert.equal(result.query.shortContract, 'BINANCE_FUTURE_BTC_USDT');
    assert.equal(result.query.opportunityKind, opportunityKind);
    assert.deepEqual(Object.keys(result.query).sort(), ['longContract', 'longExchange', 'opportunityKind', 'shortContract', 'shortExchange', 'symbol']);
  }
});

test('unsupported, scaled, noncrypto, unverified and delisting sources expose a reason', () => {
  for (const patch of [
    { exchange: 'aster' }, { multiplier: 1000 }, { multiplier: undefined }, { assetClass: 'equity' }, { assetClass: undefined },
    { comparable: false }, { identitySource: '' }, { identitySource: undefined }, { delisting: true }, { delistingAt: NOW + 60_000 },
    { base: 'GATE:EDGE:DEFINITIVE' }, { symbol: 'ETHUSDT' }, { rawBase: 'ETH' },
    { crossexSymbol: 'BINANCE_FUTURE_BTC_USDC' }, { counterCurrency: 'USDC' }, { settlementCurrency: 'USDC' },
    { symbol: '1000PEPEUSDT', base: 'PEPE', multiplier: 1 },
  ]) {
    const result = prepare(pair(quote('binance', 'BTCUSDT', patch)));
    assert.equal(result.query, null, JSON.stringify(patch)); assert.ok(result.reason, JSON.stringify(patch));
  }
  assert.equal(prepare(pair(quote(), quote())).query, null);
  assert.equal(prepare(pair(quote(), quote('bybit', 'ETHUSDT', { base: 'ETH' }))).query, null);
  assert.equal(prepare({ ...pair(), base: 'ETH' }).query, null);
});

test('freshness follows the chosen price source and never a recent funding message', () => {
  const old = quote('binance', 'BTCUSDT', { bidAskAt: NOW - 30_001 });
  assert.match(prepare(pair(old)).reason, /报价已过期/);
  assert.equal(prepare(pair(old), { priceMode: 'mark' }).reason, null);
  for (const patch of [{ bidAskAt: undefined }, { bidAskAt: NOW + 5_001 }, { receivedAt: NOW - 30_001 }, { ask: null }, { bid: 102, ask: 101 }]) {
    assert.equal(prepare(pair(quote('binance', 'BTCUSDT', patch))).query, null, JSON.stringify(patch));
  }
  assert.equal(prepare(pair(), { now: NOW + 30_001 }).query, null, 'frozen detail row expires at click time');
  assert.equal(prepare(pair(), { now: NaN }).query, null);
  assert.equal(prepare(pair(), { staleAfterMs: 0 }).query, null);
});

test('funding opportunities require complete current funding data but spread imports do not', () => {
  for (const patch of [{ fundingAt: NOW - 300_001 }, { fundingAt: undefined }, { fundingRate: null }, { fundingIntervalHours: null }]) {
    const row = pair(quote('binance', 'BTCUSDT', patch));
    assert.equal(prepare(row, { opportunityKind: 'spread' }).reason, null);
    assert.match(prepare(row, { opportunityKind: 'funding' }).reason, /资金费资料已过期或不完整/);
  }
});

test('click-time checks age the server clock while a retained row is frozen', () => {
  let elapsed = 0;
  const sourceClock = createPerpetualClock(() => elapsed);
  sourceClock.accept(NOW, 'monitor-import-test');
  const readNow = sourceClock.read;
  assert.equal(prepare(pair(), { now: readNow() }).reason, null);
  elapsed = 30_001;
  assert.match(prepare(pair(), { now: readNow() }).reason, /报价已过期/);
  // A newly received source baseline recovers without consulting the viewer's wall clock.
  sourceClock.accept(NOW + 60_000, 'monitor-import-test', true);
  const refreshQuote = source => ({ ...source, receivedAt: NOW + 60_000, bidAskAt: NOW + 60_000 });
  assert.equal(prepare(pair(refreshQuote(quote()), refreshQuote(quote('bybit'))), { now: readNow() }).reason, null);
});

test('standalone pages explain the workbench requirement and every click gets a new bounded import id', () => {
  assert.match(prepare(pair(), { connected: false }).reason, /从工作台打开/);
  const ids = Array.from({ length: 20 }, createCrossExImportId);
  assert.equal(new Set(ids).size, ids.length);
  for (const importId of ids) {
    assert.match(importId, /^[A-Za-z0-9_-]{1,80}$/);
    assert.ok(cleanHubQuery({ ...prepare().query, importId }));
  }
});
