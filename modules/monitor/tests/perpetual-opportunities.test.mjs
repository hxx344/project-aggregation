import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPerpetualOpportunities } from '../server/perpetual-opportunities.mjs';
import { unavailablePerpetualOpportunities } from '../lib/perpetual-opportunities.ts';
import { createPerpetualService, mergePerpetualQuote } from '../server/perpetual-service.mjs';
import { createHandler } from '../server/http.mjs';
import { discoverMarkets, parseMessage } from '../modules/perpetual/exchanges.mjs';

const NOW = 1_790_000_000_000;
const quote = (exchange, patch = {}) => ({
  exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT',
  multiplier: 1, assetClass: 'crypto', identitySource: exchange === 'binance' ? 'contractType=PERPETUAL;underlyingSubType=;symbolType=' : 'symbolType=', identityVerified: true,
  delisting: false, delistingAt: null, bid: exchange === 'binance' ? 99 : 102, ask: exchange === 'binance' ? 100 : 103,
  mark: null, last: null, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null,
  sourceTime: NOW - 100, receivedAt: NOW, bidAskAt: NOW - 100, transport: 'ws', ...patch,
});
const snapshot = (quotes = [quote('binance'), quote('bybit')], patch = {}) => ({
  schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: NOW, staleAfterMs: 30_000,
  exchanges: ['binance', 'bybit'].map(id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: NOW, error: null })),
  quotes, ...patch,
});
const project = value => createPerpetualOpportunities(value, NOW);

test('paper signal contract uses raw quotes, gross BBO spread and original oldest book time', () => {
  const source = snapshot([quote('binance', { bidAskAt: NOW - 1_000 }), quote('bybit')]);
  const result = project(source), signal = result.signals[0];
  assert.equal(result.schemaVersion, 1); assert.equal(result.mode, 'paper'); assert.equal(result.source, 'market-monitor');
  assert.equal(result.monitorId, 'perpetual'); assert.equal(result.status, source.status); assert.equal(result.staleAfterMs, 10_000);
  assert.equal(result.exchanges, source.exchanges); assert.deepEqual(result.quotes, source.quotes);
  assert.equal(result.signals.length, 1); assert.equal(signal.long, source.quotes[0]); assert.equal(signal.short, source.quotes[1]);
  assert.equal(signal.quoteCurrency, 'USDT'); assert.ok(Math.abs(signal.grossSpreadPercent - 2) < 1e-10);
  assert.equal(signal.observedAt, NOW - 1_000); assert.equal(signal.expiresAt, NOW + 9_000);
  assert.equal(signal.pairKey, JSON.stringify(['BTC', 'binance:BTCUSDT', 'bybit:BTCUSDT']));
  assert.match(signal.id, /^[a-f0-9]{64}$/);
});

test('BBO version ids remain stable across response clocks, order and funding-only updates', () => {
  const source = snapshot(), first = project(source).signals[0];
  const changed = createPerpetualOpportunities(snapshot([...source.quotes].reverse().map(q => ({ ...q, receivedAt: NOW + 50, fundingAt: NOW + 50, fundingRate: 0.002 })), { generatedAt: NOW + 50 }), NOW + 50).signals[0];
  assert.equal(first.id, changed.id); assert.equal(first.pairKey, changed.pairKey);
  for (const patch of [{ ask: 100.1 }, { bidAskAt: NOW - 50 }, { identitySource: 'corrected-official-source' }]) {
    const next = project(snapshot([quote('binance', patch), quote('bybit')])).signals[0];
    assert.notEqual(next.id, first.id); assert.equal(next.pairKey, first.pairKey);
  }
});

test('signals require fresh complete books and 5-second leg alignment; raw values survive', () => {
  const rejected = [
    { bidAskAt: NOW - 10_001 }, { bidAskAt: undefined }, { bidAskAt: NaN },
    { bidAskAt: NOW + 5_001, receivedAt: NOW + 5_001 }, { receivedAt: NOW - 10_001 },
    { bid: null }, { ask: null }, { bid: 104, ask: 100 }, { ask: Infinity },
  ];
  for (const patch of rejected) {
    const source = snapshot([quote('binance', patch), quote('bybit')]);
    const result = project(source);
    assert.deepEqual(result.signals, [], JSON.stringify(patch)); assert.deepEqual(result.quotes, source.quotes);
  }
  assert.equal(project(snapshot([quote('binance', { bidAskAt: NOW - 5_100 }), quote('bybit')])).signals.length, 1);
  assert.equal(project(snapshot([quote('binance', { bidAskAt: NOW - 5_101 }), quote('bybit')])).signals.length, 0);
  assert.equal(project(snapshot([quote('binance', { bidAskAt: NOW - 10_000 }), quote('bybit', { bidAskAt: NOW - 10_000 })])).signals.length, 1);
});

test('unsupported or unknown identities, multipliers, settlements and lifecycle states never export', () => {
  const rejected = [
    { exchange: 'gate' }, { assetClass: 'equity' }, { assetClass: 'rwa' }, { assetClass: undefined },
    { identitySource: '' }, { identitySource: undefined }, { identityVerified: false }, { identityVerified: undefined },
    { base: 'EQUITY:BTC' }, { comparable: false }, { quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' },
    { collateralCurrency: undefined }, { multiplier: 1000 }, { multiplier: undefined },
    { delisting: true }, { delisting: undefined }, { delistingAt: NOW + 60_000 }, { delistingAt: NOW - 1 },
  ];
  for (const patch of rejected) {
    const result = project(snapshot([quote('binance'), quote('bybit', patch)]));
    assert.equal(result.quotes.length, 1, JSON.stringify(patch)); assert.deepEqual(result.signals, []);
  }
  assert.deepEqual(project(snapshot([quote('bybit')])).quotes, [], 'Bybit needs a verified matching Binance crypto identity');
});

test('negative/zero spreads, stale venues and unavailable snapshots retain quotes without entry signals', () => {
  for (const short of [{ bid: 99, ask: 103 }, { bid: 100, ask: 103 }]) {
    const result = project(snapshot([quote('binance'), quote('bybit', short)]));
    assert.equal(result.quotes.length, 2); assert.deepEqual(result.signals, []);
  }
  for (const status of ['stale', 'connecting', 'error', 'disabled']) {
    const source = snapshot(); source.exchanges[1].status = status;
    assert.equal(project(source).quotes.length, 2); assert.deepEqual(project(source).signals, []);
  }
  const result = project(snapshot(undefined, { status: 'unavailable' }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.quotes.length, 2); assert.deepEqual(result.signals, []);
});

test('directory evidence never relabels a quote with a different contract identity', () => {
  const source = snapshot();
  for (const patch of [{ base: 'ETH' }, { symbol: 'ETHUSDT' }, { quoteCurrency: 'USDC' }, { multiplier: 1000 }, { exchange: 'gate' }]) {
    const result = createPerpetualOpportunities(source, NOW, (exchange, symbol) => ({ ...quote(exchange), symbol, ...patch }));
    assert.deepEqual(result.quotes, []); assert.deepEqual(result.signals, []);
  }
  assert.deepEqual(createPerpetualOpportunities(source, NOW, () => undefined).quotes, []);
});

test('signal cap preserves all raw quotes and quote overflow fails closed with an explicit contract', () => {
  const quotes = Array.from({ length: 210 }, (_, i) => ['binance', 'bybit'].map(exchange => quote(exchange, { base: `COIN${i}`, symbol: `COIN${i}USDT` }))).flat();
  const limited = project(snapshot(quotes));
  assert.equal(limited.signals.length, 200); assert.equal(limited.quotes.length, 420);
  const tooMany = Array.from({ length: 5_001 }, (_, i) => quote('binance', { base: `COIN${i}`, symbol: `COIN${i}USDT` }));
  const overflow = project(snapshot(tooMany));
  assert.equal(overflow.status, 'unavailable'); assert.equal(overflow.errorCode, 'QUOTE_LIMIT_EXCEEDED');
  assert.match(overflow.error, /5001/); assert.deepEqual(overflow.quotes, []); assert.deepEqual(overflow.signals, []);
  const duplicate = project(snapshot([quote('binance'), quote('binance'), quote('bybit')]));
  assert.equal(duplicate.errorCode, 'DUPLICATE_QUOTES'); assert.deepEqual(duplicate.quotes, []);
});

test('official discovery carries explicit class and settlement evidence, rejecting missing and unknown categories', async () => {
  const binanceBase = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', underlyingType: 'COIN', underlyingSubType: [] };
  const binanceRows = [binanceBase, { ...binanceBase, symbol: 'ETHUSDT', baseAsset: 'ETH', underlyingType: undefined }, { ...binanceBase, symbol: 'GOLDUSDT', baseAsset: 'GOLD', underlyingSubType: ['commodity'] }];
  const bybitBase = { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', symbolType: '', isPreListing: false };
  const bybitRows = [bybitBase, { ...bybitBase, symbol: 'ETHUSDT', baseCoin: 'ETH', symbolType: undefined }, { ...bybitBase, symbol: 'NEWUSDT', baseCoin: 'NEW' }, { ...bybitBase, symbol: 'INNOUSDT', baseCoin: 'INNO', symbolType: 'innovation' }, { ...bybitBase, symbol: 'GOLDUSDT', baseCoin: 'GOLD', symbolType: 'commodity' }, { ...bybitBase, symbolType: 'crypto', symbol: 'SOLUSDT', baseCoin: 'SOL' }];
  const binance = await discoverMarkets('binance', { fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('fundingInfo') ? [] : { symbols: binanceRows } }) });
  const bybit = await discoverMarkets('bybit', { fetchImpl: async () => ({ ok: true, json: async () => ({ retCode: 0, result: { list: bybitRows, nextPageCursor: '' } }) }) });
  assert.deepEqual(binanceRows.map(row => binance.find(q => q.symbol === row.symbol).identityVerified), [true, false, false]);
  assert.deepEqual(bybitRows.map(row => bybit.find(q => q.symbol === row.symbol).identityVerified), [true, false, false, true, false, false]);
  assert.equal(bybit.find(q => q.symbol === 'BTCUSDT').identitySource, 'symbolType='); assert.equal(bybit.find(q => q.symbol === 'ETHUSDT').identitySource, 'symbolType=unknown');
  for (const row of [...binance, ...bybit]) assert.equal(row.collateralCurrency, 'USDT');
  const [parsed] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { symbol: 'BTCUSDT', bid1Price: '102', ask1Price: '103' } }, bybit, NOW);
  const merged = mergePerpetualQuote(null, parsed, NOW);
  assert.equal(merged.collateralCurrency, undefined, 'Original snapshots must keep legacy paper position identity keys');
  const base = quote('binance', { assetClass: undefined, identityVerified: undefined, collateralCurrency: undefined, identitySource: undefined });
  const result = createPerpetualOpportunities(snapshot([base, { ...merged, delisting: false, delistingAt: null }]), NOW,
    (exchange, symbol) => (exchange === 'binance' ? binance : bybit).find(row => row.symbol === symbol));
  assert.equal(result.quotes.length, 2); assert.equal(result.signals.length, 1);
  assert.equal(result.quotes[1].identityVerified, true); assert.equal(result.quotes[1].collateralCurrency, 'USDT');
  assert.equal(base.collateralCurrency, undefined); assert.equal(merged.collateralCurrency, undefined);
});

test('stateless preview returns the same unavailable paper contract without synthetic timestamps', () => {
  const result = unavailablePerpetualOpportunities(NOW);
  assert.equal(result.mode, 'paper'); assert.equal(result.source, 'market-monitor'); assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'NO_RESIDENT_FEED'); assert.equal(result.generatedAt, NOW); assert.equal(result.staleAfterMs, 10_000);
  assert.deepEqual(result.signals, []); assert.deepEqual(result.quotes, []);
});

test('opportunities HTTP route reuses authentication, allows only GET and never triggers discovery', async t => {
  let discoveries = 0;
  const service = createPerpetualService({ exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }], clock: () => NOW, discover: async () => { discoveries++; return []; } });
  t.after(() => service.stop());
  const server = createServer(createHandler({ services: new Map([['perpetual', service]]), username: 'test', password: 'test-password', nextHandler: (_q, r) => { r.writeHead(404); r.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/opportunities`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}` };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic invalid' } })).status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await fetch(url, { headers, method })).status, 405);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.equal(result.mode, 'paper'); assert.equal(result.status, 'connecting');
  assert.deepEqual(result.quotes, []); assert.deepEqual(result.signals, []); assert.equal(discoveries, 0);
});
