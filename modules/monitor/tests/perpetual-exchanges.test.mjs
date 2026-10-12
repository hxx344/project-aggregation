import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGES, normalizeUnderlying, classifyMarketIdentity, discoverMarkets, createSubscriptions, parseMessage, getControlResponse, fetchBookSnapshots } from '../modules/perpetual/exchanges.mjs';
import { mergePerpetualQuote } from '../server/perpetual-service.mjs';
import { normalizedFunding8h } from '../lib/perpetual-spreads.ts';

const NOW = 1_789_820_000_000;
function market(exchange, symbol = 'BTCUSDT', extra = {}) {
  return { id: `${exchange}:${symbol}`, exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, fundingIntervalHours: 8, ...extra };
}
function reader(handler) {
  return async (url, options) => ({ ok: true, status: 200, json: async () => handler(url, options) });
}

function directoryFixture(exchange, changes) {
  const defaults = {
    binance: { status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT' },
    aster: { status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT' },
    bybit: { status: 'Trading', contractType: 'LinearPerpetual', quoteCoin: 'USDT', settleCoin: 'USDT' },
    okx: { state: 'live', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT' },
    bitget: { symbolStatus: 'normal', symbolType: 'perpetual', quoteCoin: 'USDT' },
    gate: { status: 'trading', type: 'direct' },
  };
  const rows = changes.map((change, i) => ({ ...defaults[exchange], symbol: `COIN${i}USDT`, baseAsset: `COIN${i}`, baseCoin: `COIN${i}`, ctValCcy: `COIN${i}`, instId: `COIN${i}-USDT-SWAP`, name: `COIN${i}_USDT`, ...change }));
  const calls = [];
  return { calls, fetchImpl: reader(url => {
    calls.push(url);
    if (exchange === 'binance' || exchange === 'aster') return url.endsWith('fundingInfo') ? [] : { symbols: rows };
    if (exchange === 'bybit') return { retCode: 0, result: { list: rows, nextPageCursor: '' } };
    if (exchange === 'okx') return { code: '0', data: rows };
    if (exchange === 'bitget') return { code: '00000', data: url.endsWith('USDT-FUTURES') ? rows : [] };
    return rows;
  }) };
}

test('Bitget bulk directories retain per-contract taker rates including explicit zero without extra reads', async () => {
  const fixture = directoryFixture('bitget', [{ takerFeeRate: '0.0006' }, { takerFeeRate: '0.0008' }, { takerFeeRate: '0' }]);
  const rows = await discoverMarkets('bitget', { fetchImpl: fixture.fetchImpl, now: NOW });
  assert.deepEqual(rows.map(row => row.takerFeeRate), [0.0006, 0.0008, 0]);
  assert.ok(rows.every(row => row.takerFeeAt === NOW && row.takerFeeSource === 'bitget-contract'));
  assert.equal(fixture.calls.length, 2, 'Fees reuse the two existing product directories');
});

test('missing or malformed public contract fees remain unknown instead of becoming zero', async () => {
  const values = [undefined, null, '', ' ', 'NaN', 'Infinity', -0.0006, '0.6', false, [], {}];
  const fixture = directoryFixture('bitget', values.map(takerFeeRate => ({ takerFeeRate })));
  const rows = await discoverMarkets('bitget', { fetchImpl: fixture.fetchImpl, now: NOW });
  assert.equal(rows.length, values.length);
  for (const row of rows) { assert.equal(row.takerFeeRate, null); assert.equal(row.takerFeeAt, null); }
});

test('Bybit retail taker schedules distinguish innovation contracts and leave other categories unknown', async () => {
  const fixture = directoryFixture('bybit', [{ symbolType: '' }, { symbolType: 'crypto' }, { symbolType: 'innovation' }, { symbolType: 'stock' }, { symbolType: 'unknown-category' }, { symbolType: 'innovation', isPreListing: true }]);
  const rows = await discoverMarkets('bybit', { fetchImpl: fixture.fetchImpl, now: NOW });
  const byBase = new Map(rows.map(row => [row.rawBase, row]));
  assert.deepEqual(['COIN0', 'COIN1', 'COIN2', 'COIN3', 'COIN4'].map(base => byBase.get(base).takerFeeRate), [0.00055, 0.00055, 0.0011, null, null]);
  assert.ok(rows.every(row => row.takerFeeSource === 'bybit-standard'));
  assert.equal(byBase.get('COIN2').takerFeeAt, NOW);
  assert.equal(byBase.get('COIN3').takerFeeAt, null);
  assert.equal(rows.length, 5, 'Prelisting remains outside the supported market scope');
  assert.equal(fixture.calls.length, 1, 'No private or Pro/MM fee endpoint is needed');
});

test('Gate point-deduction contract fee fields are not exposed as retail VIP0 fees', async () => {
  const fixture = directoryFixture('gate', [{ taker_fee_rate: '0.00075' }]);
  const [row] = await discoverMarkets('gate', { fetchImpl: fixture.fetchImpl, now: NOW });
  assert.equal(Object.hasOwn(row, 'takerFeeRate'), false);
});

test('Gate directory retains the contract face value separately from token price normalization', async () => {
  const fixture = directoryFixture('gate', [{ name: '1000PEPE_USDT', quanto_multiplier: '10' }, { quanto_multiplier: '' }, { quanto_multiplier: '-1' }, { quanto_multiplier: '0.0001' }]);
  const rows = await discoverMarkets('gate', { fetchImpl: fixture.fetchImpl, now: NOW });
  const bySymbol = new Map(rows.map(row => [row.symbol, row]));
  assert.equal(bySymbol.get('1000PEPE_USDT').multiplier, 1000);
  assert.equal(bySymbol.get('1000PEPE_USDT').contractSize, 10);
  assert.equal(bySymbol.get('COIN1_USDT').contractSize, null);
  assert.equal(bySymbol.get('COIN2_USDT').contractSize, null);
  assert.equal(bySymbol.get('COIN3_USDT').contractSize, 0.0001);
});

test('OKX retail schedules apply only to identified normal crypto fee groups', async () => {
  const fixture = directoryFixture('okx', [{ groupId: '4', instCategory: '1' }, { groupId: '5', instCategory: '2' }, { groupId: '6', instCategory: '1' }, { groupId: '4', instCategory: '3' }, { groupId: '4', ruleType: 'pre_market' }, {}]);
  const rows = await discoverMarkets('okx', { fetchImpl: fixture.fetchImpl, now: NOW });
  const byBase = new Map(rows.map(row => [row.rawBase, row]));
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => byBase.get(`COIN${i}`).takerFeeRate), [0.0005, 0.0005, null, null, null, null]);
  assert.ok(rows.every(row => row.takerFeeSource === 'okx-standard'));
  assert.equal(fixture.calls.length, 1);
});

test('Aster retail schedules distinguish USDT, USD1 and RWA without applying crypto rates to unknown scopes', async () => {
  const fixture = directoryFixture('aster', [
    {}, { quoteAsset: 'USD1', marginAsset: 'USD1' }, { quoteAsset: 'USDC', marginAsset: 'USDC' },
    { underlyingSubType: ['stock'] }, { underlyingSubType: ['commodities'], quoteAsset: 'USD1', marginAsset: 'USD1' }, { underlyingSubType: ['pre-market'] },
  ]);
  const rows = await discoverMarkets('aster', { fetchImpl: fixture.fetchImpl, now: NOW });
  const byBase = new Map(rows.map(row => [row.rawBase, row]));
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => byBase.get(`COIN${i}`).takerFeeRate), [0.0004, 0.00005, null, 0.00009, 0.00009, null]);
  assert.ok(rows.every(row => row.takerFeeSource === 'aster-standard'));
  assert.equal(fixture.calls.length, 2);
});

test('Lighter standard market fee percentages are normalized once and missing fees stay unknown', async () => {
  const values = ['0', '0.028', '', null, '-0.1', 'Infinity'];
  let calls = 0;
  const rows = await discoverMarkets('lighter', { now: NOW, fetchImpl: reader(() => {
    calls++;
    return { order_book_details: values.map((taker_fee, i) => ({ symbol: `COIN${i}`, market_id: i, market_type: 'perp', status: 'active', funding_premium_multiplier: 100, taker_fee })) };
  }) });
  assert.equal(rows[0].takerFeeRate, 0);
  assert.ok(Math.abs(rows[1].takerFeeRate - 0.00028) < 1e-12);
  assert.ok(rows.slice(2).every(row => row.takerFeeRate === null));
  assert.deepEqual(rows.map(row => row.takerFeeAt), [NOW, NOW, null, null, null, null]);
  assert.ok(rows.every(row => row.takerFeeSource === 'lighter-standard'));
  assert.equal(calls, 1);
});

test('bulk directories expose scheduled delistings as UTC milliseconds without extra requests', async () => {
  const deadline = Date.parse('2026-09-22T15:00:00+08:00');
  const fields = { binance: 'deliveryDate', aster: 'deliveryDate', bybit: 'deliveryTime', okx: 'expTime', bitget: 'offTime', gate: 'delisted_time' };
  for (const [exchange, field] of Object.entries(fields)) {
    const fixture = directoryFixture(exchange, [{ [field]: String(exchange === 'gate' ? deadline / 1000 : deadline) }]);
    const [row] = await discoverMarkets(exchange, { fetchImpl: fixture.fetchImpl, now: NOW });
    assert.equal(row.delisting, true, exchange);
    assert.equal(row.delistingAt, 1_790_060_400_000, exchange);
    assert.equal(new Date(row.delistingAt).toISOString(), '2026-09-22T07:00:00.000Z');
    assert.equal(fixture.calls.length, ['binance', 'aster', 'bitget'].includes(exchange) ? 2 : 1, exchange);
  }
});

test('normal perpetual placeholders, missing dates and invalid data never announce delisting', async () => {
  const fields = { binance: 'deliveryDate', aster: 'deliveryDate', bybit: 'deliveryTime', okx: 'expTime', bitget: 'offTime', gate: 'delisted_time' };
  for (const [exchange, field] of Object.entries(fields)) {
    const emptyValues = [undefined, null, '', ' ', '0', '-1', 'NaN', 'Infinity', '2026-09-22T07:00:00Z', 8_640_000_000_000_001];
    if (['binance', 'aster'].includes(exchange)) emptyValues.push(4_133_404_800_000, '4133404800000');
    const fixture = directoryFixture(exchange, emptyValues.map(value => ({ [field]: value })));
    const rows = await discoverMarkets(exchange, { fetchImpl: fixture.fetchImpl, now: NOW });
    assert.equal(rows.length, emptyValues.length, exchange);
    for (const row of rows) {
      assert.equal(row.delisting, false, `${exchange} ${row.symbol}`);
      assert.equal(row.delistingAt, null, `${exchange} ${row.symbol}`);
    }
  }
  // A far-future real date must not be dismissed by an arbitrary horizon rule.
  for (const exchange of ['binance', 'aster']) {
    const deadline = Date.parse('2120-01-01T00:00:00Z');
    const fixture = directoryFixture(exchange, [{ deliveryDate: deadline }]);
    const [row] = await discoverMarkets(exchange, { fetchImpl: fixture.fetchImpl, now: NOW });
    assert.equal(row.delisting, true); assert.equal(row.delistingAt, deadline);
  }
});

test('Gate preserves an explicit trading delisting flag without guessing its final deadline', async () => {
  const fixture = directoryFixture('gate', [
    { in_delisting: true, position_size: '12' },
    { in_delisting: true },
    { in_delisting: false, delisting_time: (NOW + 60000) / 1000 },
    { in_delisting: 'false' },
    { in_delisting: true, position_size: '0' },
    { in_delisting: true, position_size: '10', status: 'delisting' },
    { in_delisting: true, position_size: '10', status: 'delisted' },
    { status: 'prelaunch' },
    { status: 'circuit_breaker' },
  ]);
  const rows = await discoverMarkets('gate', { fetchImpl: fixture.fetchImpl, now: NOW });
  assert.deepEqual(rows.map(row => row.base), ['COIN0', 'COIN1', 'COIN2', 'COIN3']);
  assert.deepEqual(rows.map(row => row.delisting), [true, true, false, false]);
  assert.ok(rows.every(row => row.delistingAt === null));
});

test('final deadlines and terminal states remove markets; operational maintenance is never a delisting signal', async () => {
  const fields = { binance: 'deliveryDate', aster: 'deliveryDate', bybit: 'deliveryTime', okx: 'expTime', bitget: 'offTime', gate: 'delisted_time' };
  const terminal = { binance: { status: 'SETTLING' }, aster: { status: 'SETTLING' }, bybit: { status: 'Closed' }, okx: { state: 'suspend' }, bitget: { symbolStatus: 'off' }, gate: { status: 'delisted' } };
  for (const [exchange, field] of Object.entries(fields)) {
    const scale = exchange === 'gate' ? 1000 : 1;
    const fixture = directoryFixture(exchange, [{ [field]: (NOW - 1000) / scale }, { [field]: NOW / scale }, { [field]: (NOW + 1000) / scale }, { ...terminal[exchange], [field]: (NOW + 1000) / scale }]);
    const rows = await discoverMarkets(exchange, { fetchImpl: fixture.fetchImpl, now: NOW });
    assert.deepEqual(rows.map(row => row.base), ['COIN2'], exchange);
  }
  const fixture = directoryFixture('bitget', [
    { maintainTime: String(NOW + 60000), limitOpenTime: String(NOW + 60000), offTime: '-1' },
    { symbolStatus: 'maintain', maintainTime: String(NOW + 60000) },
    { symbolStatus: 'limit_open', offTime: String(NOW + 60000) },
    { symbolType: 'delivery', deliveryTime: String(NOW + 60000) },
  ]);
  const rows = await discoverMarkets('bitget', { fetchImpl: fixture.fetchImpl, now: NOW });
  assert.equal(rows.length, 1); assert.equal(rows[0].delisting, false); assert.equal(rows[0].delistingAt, null);
});

test('normalizes explicit contract baskets without guessing arbitrary digit or namespace symbols', () => {
  assert.deepEqual(normalizeUnderlying('1000PEPE'), { base: 'PEPE', multiplier: 1000 });
  assert.deepEqual(normalizeUnderlying('1000000MOG'), { base: 'MOG', multiplier: 1000000 });
  assert.deepEqual(normalizeUnderlying('kBONK', 'hyperliquid'), { base: 'BONK', multiplier: 1000 });
  for (const base of ['1INCH', '1000NEW', 'KAS', 'XYZ:TSLA']) assert.deepEqual(normalizeUnderlying(base), { base, multiplier: 1 });
});

test('Binance market discovery excludes inverse, delivery, delisted and TradFi; reads funding intervals', async () => {
  const good = { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' };
  const result = await discoverMarkets('binance', { fetchImpl: reader(url => url.endsWith('fundingInfo') ? [{ symbol: good.symbol, fundingIntervalHours: 4 }] : { symbols: [good, { ...good, symbol: 'BTCUSDT', baseAsset: 'BTC' }, { ...good, symbol: 'OLD', status: 'SETTLING' }, { ...good, symbol: 'INVERSE', marginAsset: 'PEPE' }, { ...good, symbol: 'FUTURE', contractType: 'CURRENT_QUARTER' }, { ...good, symbol: 'STOCK', contractType: 'TRADIFI_PERPETUAL' }] }) });
  assert.equal(result.length, 2);
  assert.equal(result.find(row => row.base === 'PEPE').multiplier, 1000);
  assert.equal(result.find(row => row.base === 'PEPE').fundingIntervalHours, 4);
  assert.equal(result.find(row => row.base === 'BTC').fundingIntervalHours, 8);
});

test('failed funding metadata never assigns a guessed funding interval', async () => {
  const fetchImpl = reader(url => {
    if (url.endsWith('fundingInfo')) throw new Error('timeout');
    return { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' }] };
  });
  assert.equal((await discoverMarkets('binance', { fetchImpl }))[0].fundingIntervalHours, null);
});

test('Bybit follows pagination and filters prelisting or dated contracts', async () => {
  const good = { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', fundingInterval: 240 };
  const calls = [];
  const result = await discoverMarkets('bybit', { fetchImpl: reader(url => {
    calls.push(url);
    return { retCode: 0, result: { list: url.includes('cursor=') ? [{ ...good, symbol: 'ETHUSDT', baseCoin: 'ETH' }, { ...good, symbol: 'PRE', isPreListing: true }, { ...good, symbol: 'FUT', contractType: 'LinearFutures' }] : [good], nextPageCursor: url.includes('cursor=') ? '' : 'page+2' } };
  }) });
  assert.equal(result.length, 2);
  assert.equal(result[0].fundingIntervalHours, 4);
  assert.match(calls[1], /cursor=page%2B2/);
  await assert.rejects(discoverMarkets('bybit', { fetchImpl: reader(() => ({ retCode: 0, result: { list: [], nextPageCursor: 'repeat' } })) }), /repeated pagination/);
});

test('discovery respects Hyperliquid denomination and excludes spot or inactive Lighter markets', async () => {
  const hl = await discoverMarkets('hyperliquid', { fetchImpl: reader(() => ({ universe: [{ name: 'BTC' }, { name: 'HYPE' }, { name: 'PURR' }, { name: 'kPEPE' }, { name: 'xyz:BTC' }, { name: 'OLD', isDelisted: true }] })) });
  assert.equal(hl.length, 4);
  assert.equal(hl.find(row => row.base === 'BTC').quoteCurrency, 'USDT');
  assert.equal(hl.find(row => row.base === 'HYPE').quoteCurrency, 'USDC');
  assert.equal(hl.find(row => row.base === 'PEPE').multiplier, 1000);
  const lighter = await discoverMarkets('lighter', { fetchImpl: reader(() => ({ code: 200, order_book_details: [{ symbol: '1000PEPE', market_id: 4, status: 'active', market_type: 'perp', multiplier: '1', funding_premium_multiplier: 100 }, { symbol: 'BTC/USDC', market_id: 2001, status: 'active', market_type: 'spot' }, { symbol: 'OLD', market_id: 10, status: 'inactive', market_type: 'perp' }] })) });
  assert.equal(lighter.length, 1);
  assert.equal(lighter[0].multiplier, 1000);
  assert.equal(lighter[0].marketId, 4);
});

test('Binance and Aster book ticker prices normalize while mark frames never refresh the book', () => {
  for (const exchange of ['binance', 'aster']) {
    const markets = [market(exchange, '1000PEPEUSDT', { base: 'PEPE', multiplier: 1000 })];
    const [book] = parseMessage(exchange, JSON.stringify({ stream: '1000pepeusdt@bookTicker', data: { e: 'bookTicker', s: '1000PEPEUSDT', b: '.01', a: '.0101', T: NOW - 1 } }), markets, NOW);
    assert.equal(book.bid, .00001); assert.equal(book.ask, .0000101); assert.equal(book.sourceTime, NOW - 1);
    const [mark] = parseMessage(exchange, { e: 'markPriceUpdate', s: '1000PEPEUSDT', p: '.01', r: '0', T: NOW + 10000, E: NOW }, markets, NOW);
    assert.equal(mark.fundingRate, 0); assert.equal(mark.mark, .00001); assert.equal(Object.hasOwn(mark, 'bid'), false); assert.equal(Object.hasOwn(mark, 'ask'), false);
    assert.deepEqual(parseMessage(exchange, { e: 'bookTicker', s: '1000PEPEUSDT', b: '1', a: '2', st: 2 }, markets, NOW), []);
  }
});

test('Bybit delta preserves missing fields and invalid or empty quote explicitly clears an old value', () => {
  const markets = [market('bybit')], context = {};
  parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'snapshot', ts: NOW, data: { symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', fundingRate: '0.0001' } }, markets, NOW, context);
  const [delta] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'delta', ts: NOW + 1, data: { markPrice: '105' } }, markets, NOW + 1, context);
  assert.equal(delta.mark, 105); assert.equal(Object.hasOwn(delta, 'bid'), false); assert.equal(Object.hasOwn(delta, 'fundingRate'), false);
  const [empty] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { bid1Price: '', ask1Price: 'NaN' } }, markets, NOW);
  assert.equal(empty.bid, null); assert.equal(empty.ask, null);
  assert.deepEqual(parseMessage('bybit', { op: 'subscribe', success: true }, markets), []);
});

test('OKX funding uses upcoming fundingTime and derives interval without emitting prices', () => {
  const [row] = parseMessage('okx', { arg: { channel: 'funding-rate' }, data: [{ instId: 'BTC-USDT-SWAP', fundingRate: '-0.0001', fundingTime: String(NOW + 1000), nextFundingTime: String(NOW + 1000 + 4 * 3600000), ts: String(NOW) }] }, [market('okx', 'BTC-USDT-SWAP')], NOW);
  assert.equal(row.nextFundingAt, NOW + 1000); assert.equal(row.fundingIntervalHours, 4); assert.equal(row.fundingRate, -.0001); assert.equal(Object.hasOwn(row, 'mark'), false);
});

test('Gate and Bitget parse ticker prices without inventing executable BBOs from last or mark', () => {
  const [gate] = parseMessage('gate', { channel: 'futures.tickers', event: 'update', time_ms: NOW, result: [{ contract: 'BTC_USDT', mark_price: '101', last: '102', funding_rate: '0' }] }, [market('gate', 'BTC_USDT')], NOW);
  assert.equal(gate.fundingRate, 0); assert.equal(Object.hasOwn(gate, 'bid'), false); assert.equal(Object.hasOwn(gate, 'nextFundingAt'), false);
  const [bitget] = parseMessage('bitget', { arg: { channel: 'ticker', instId: 'BTCUSDT' }, data: [{ bidPr: '100', askPr: '101', lastPr: '102', ts: String(NOW), fundingRate: '' }] }, [market('bitget')], NOW);
  assert.equal(bitget.bid, 100); assert.equal(bitget.ask, 101); assert.equal(bitget.fundingRate, null);
});

test('Hyperliquid distinguishes BBO, mark and missing source timestamp', () => {
  const markets = [market('hyperliquid', 'BTC')];
  const [book] = parseMessage('hyperliquid', { channel: 'bbo', data: { coin: 'BTC', time: NOW, bbo: [{ px: '100' }, null] } }, markets, NOW);
  assert.equal(book.bid, 100); assert.equal(book.ask, null);
  const [ctx] = parseMessage('hyperliquid', { channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '101', funding: '0.00001' } } }, markets, NOW);
  assert.equal(ctx.sourceTime, null); assert.equal(ctx.fundingIntervalHours, 1); assert.equal(Object.hasOwn(ctx, 'bid'), false);
});

test('Lighter BBO uses market ID, handles microseconds, and funding uses current percentage points only', () => {
  const markets = [market('lighter', '1000PEPE', { marketId: 4, base: 'PEPE', multiplier: 1000, quoteCurrency: 'USDC' })];
  const [book] = parseMessage('lighter', { channel: 'ticker:4', type: 'update/ticker', ticker: { a: { price: '.0101' }, b: { price: '.01' }, last_updated_at: NOW * 1000 } }, markets, NOW);
  assert.equal(book.bid, .00001); assert.equal(book.sourceTime, NOW);
  const [stats] = parseMessage('lighter', { channel: 'market_stats:all', timestamp: NOW, market_stats: { 4: { market_id: 4, current_funding_rate: '0.0012', funding_rate: '0.08', mark_price: '.01', best_bid_price: '5', best_ask_price: '6' } } }, markets, NOW);
  assert.ok(Math.abs(stats.fundingRate - 0.000012) < 1e-12); assert.equal(stats.fundingIntervalHours, 1); assert.equal(stats.bid, .005); assert.equal(stats.ask, .006); assert.equal(stats.sourceTime, NOW);
  const [missing] = parseMessage('lighter', { channel: 'market_stats:4', timestamp: NOW, market_stats: { market_id: 4, funding_rate: '0.08', mark_price: '.01' } }, markets, NOW);
  assert.equal(Object.hasOwn(missing, 'fundingRate'), false);
  assert.equal(Object.hasOwn(missing, 'bid'), false);
  assert.equal(Object.hasOwn(missing, 'ask'), false);
});

test('Lighter unchanged BBO snapshots confirm only their source time and funding or heartbeats cannot renew them', () => {
  const markets = [market('lighter', 'BTC', { marketId: 1, quoteCurrency: 'USDC', fundingIntervalHours: 1 })];
  const context = {};
  const stats = (timestamp, fields) => ({ type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp,
    market_stats: { 1: { market_id: 1, symbol: 'BTC', ...fields } } });
  const book = { best_bid_price: '100', best_ask_price: '101' };
  const merge = (previous, payload, receivedAt) => parseMessage('lighter', payload, markets, receivedAt, context)
    .reduce((quote, row) => mergePerpetualQuote(quote, row, receivedAt), previous);
  const first = merge(null, stats(NOW, book), NOW + 100);
  const confirmed = merge(first, stats(NOW + 3_000, book), NOW + 3_200);
  assert.equal(confirmed.bid, first.bid); assert.equal(confirmed.ask, first.ask);
  assert.equal(confirmed.bidAskAt, NOW + 3_000, 'A new full snapshot confirms unchanged real prices');
  assert.equal(confirmed.sourceTime, NOW + 3_000);
  assert.equal(confirmed.receivedAt, NOW + 3_200, 'Receipt time stays separate from the exchange confirmation');
  const funding = merge(confirmed, stats(NOW + 6_000, { current_funding_rate: '0.0012', mark_price: '102' }), NOW + 6_200);
  assert.equal(funding.fundingAt, NOW + 6_000);
  assert.equal(funding.markAt, NOW + 6_000);
  assert.equal(funding.bidAskAt, confirmed.bidAskAt);
  const heartbeat = merge(funding, { type: 'ping', timestamp: NOW + 12_000 }, NOW + 12_000);
  assert.equal(heartbeat, funding);
  const delayed = merge(heartbeat, stats(NOW, book), NOW + 15_000);
  assert.equal(delayed.bidAskAt, confirmed.bidAskAt, 'Replayed source times cannot revive a stale book');
});

test('subscription shards fit connection caps and keep Binance public/market endpoints separate', () => {
  assert.equal(EXCHANGES.length, 11);
  const markets = Array.from({ length: 451 }, (_, i) => market('lighter', `COIN${i}`, { marketId: i }));
  const lighter = createSubscriptions('lighter', markets);
  assert.equal(lighter.length, 1); assert.equal(lighter[0].subscribe.length, 1); assert.equal(lighter[0].markets.length, 451);
  assert.deepEqual(lighter[0].poll.messages.map(message => message.type), ['unsubscribe', 'subscribe']);
  assert.equal(lighter[0].poll.intervalMs, 3000);
  const aster = createSubscriptions('aster', markets.map(row => ({ ...row, exchange: 'aster' })));
  assert.ok(aster.every(spec => spec.subscribe[0].params.length <= 200));
  const binance = createSubscriptions('binance', [market('binance')]);
  assert.ok(binance[0].url.includes('/public/')); assert.ok(binance[1].url.includes('/market/'));
  assert.deepEqual(binance[0].subscribe[0].params, ['!bookTicker']);
  assert.deepEqual(binance[1].subscribe[0].params, ['!markPrice@arr']);
  assert.deepEqual(createSubscriptions('okx', []), []);
});

test('application heartbeats are answered and malformed control messages yield no quotes', () => {
  assert.deepEqual(getControlResponse('lighter', '{"type":"ping"}'), { type: 'pong' });
  assert.equal(getControlResponse('okx', 'ping'), 'pong');
  assert.equal(getControlResponse('bitget', 'pong'), null);
  assert.deepEqual(parseMessage('binance', 'broken', []), []);
});

test('Bybit orderbook level 1 snapshots confirm unchanged current prices independently of ticker deltas', () => {
  const [book] = parseMessage('bybit', { topic: 'orderbook.1.BTCUSDT', type: 'snapshot', ts: NOW, cts: NOW - 60000, data: { s: 'BTCUSDT', b: [['100', '2']], a: [['101', '0']], u: 44 } }, [market('bybit')], NOW);
  assert.equal(book.bid, 100); assert.equal(book.ask, null); assert.equal(book.sourceTime, NOW);
  const specs = createSubscriptions('bybit', [market('bybit')]);
  assert.deepEqual(specs[0].subscribe[0].args, ['tickers.BTCUSDT']);
  assert.equal(typeof specs[0].snapshot, 'function');
});

test('subscription errors surface for reconnection; OKX mark-price specifies instrument type', () => {
  for (const [exchange, payload] of [['bybit', { success: false, ret_msg: 'Invalid symbol' }], ['okx', { event: 'error', code: '60012', msg: 'Invalid request' }], ['hyperliquid', { channel: 'error', data: 'Invalid subscription' }], ['gate', { error: { code: 2, message: 'Invalid request' } }]]) assert.throws(() => parseMessage(exchange, payload, []), /WebSocket/);
  const specs = createSubscriptions('okx', [market('okx', 'BTC-USDT-SWAP')]);
  assert.ok(specs[0].subscribe.flatMap(row => row.args).filter(row => row.channel === 'mark-price').every(row => row.instType === 'SWAP'));
});

test('official asset categories prevent stock-versus-token collisions for BB, CAT and ON', () => {
  const cases = [
    ['okx', 'BB', { instCategory: '3', ruleType: 'normal' }],
    ['gate', 'CAT', { contract_type: 'stocks', is_pre_market: false }],
    ['bybit', 'ON', { symbolType: 'stock', marketRegion: 'US', underlyingTicker: 'ON' }],
    ['aster', 'NVDA', { underlyingSubType: ['STOCK', 'Semiconductor'], symbolType: 1 }],
    ['lighter', 'BB', { funding_premium_multiplier: 50 }],
  ];
  for (const [exchange, raw, metadata] of cases) {
    const identity = classifyMarketIdentity(exchange, raw, metadata);
    assert.notEqual(identity.base, raw);
    assert.equal(identity.comparable, false);
    assert.equal(identity.multiplier, 1);
  }
  assert.equal(classifyMarketIdentity('binance', 'BB', { contractType: 'PERPETUAL', underlyingSubType: [] }).assetClass, 'crypto');
  assert.equal(classifyMarketIdentity('gate', 'ON', { contract_type: '' }).assetClass, 'crypto');
});

test('pre-IPO specifications and missing Lighter identity metadata stay venue-specific', () => {
  const identities = [
    classifyMarketIdentity('okx', 'OPENAI', { instCategory: '3', ruleType: 'pre_market' }),
    classifyMarketIdentity('gate', 'OPENAI', { contract_type: 'stocks', is_pre_market: true }),
    classifyMarketIdentity('aster', 'OPENAI', { underlyingSubType: ['pre-launch', 'STOCK'], symbolType: 1 }),
    classifyMarketIdentity('lighter', 'OPENAI', { funding_premium_multiplier: 1 }),
  ];
  assert.equal(new Set(identities.map(row => row.base)).size, identities.length);
  assert.ok(identities.every(row => row.comparable === false));
  assert.equal(classifyMarketIdentity('lighter', 'BTC', {}).base, 'LIGHTER:UNVERIFIED:BTC');
  assert.equal(classifyMarketIdentity('lighter', 'BTC', { funding_premium_multiplier: 100 }).assetClass, 'crypto');
  assert.equal(classifyMarketIdentity('gate', 'EDGE', {}).base, 'GATE:EDGE:DEFINITIVE');
  assert.equal(classifyMarketIdentity('binance', 'EDGE', {}).base, undefined);
  assert.equal(classifyMarketIdentity('lighter', 'AI', { funding_premium_multiplier: 100 }).base, 'LIGHTER:AI:ARTIFICIAL-INU');
  assert.equal(classifyMarketIdentity('aster', 'MEME', { symbolType: 0 }).base, 'ASTER:MEME:A-MEME-COIN');
  const asterAI = classifyMarketIdentity('aster', 'AI', { symbolType: 0 });
  assert.equal(asterAI.base, 'ASTER:AI:CONTRACT');
  assert.equal(asterAI.comparable, false);
  assert.match(asterAI.identitySource, /0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18/);
  assert.equal(classifyMarketIdentity('okx', 'AI', { instCategory: '1' }).base, undefined);
});

test('verified US share contracts match Entropy while crypto or unknown units never inherit that identity', () => {
  for (const base of ['SNDK', 'NBIS', 'GPRO', 'IONQ']) {
    const metadata = { symbolType: 'stock', marketRegion: 'US', underlyingTicker: base };
    const identity = classifyMarketIdentity('bybit', base, metadata);
    assert.equal(identity.base, `EQUITY:${base}`); assert.equal(identity.comparable, true); assert.equal(identity.multiplier, 1);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, marketRegion: 'HK' }).base, identity.base);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, underlyingTicker: 'OTHER' }).base, identity.base);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, symbolType: '' }).base, identity.base);
  }
});

test('bulk BBO snapshots retain source times, clear empty sides and filter markets', async () => {
  const bybit = [market('bybit')];
  const [snapshot] = await fetchBookSnapshots('bybit', bybit, { now: NOW, fetchImpl: reader(() => ({ retCode: 0, time: NOW - 10, result: { list: [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', bid1Size: '2', ask1Size: '0' }, { symbol: 'UNKNOWN', bid1Price: '1', ask1Price: '2' }] } })) });
  assert.equal(snapshot.bid, 100); assert.equal(snapshot.ask, null);
  assert.equal(snapshot.sourceTime, NOW - 10); assert.equal(snapshot.transport, 'rest');
  assert.equal(Object.hasOwn(snapshot, 'mark'), false);
  const [aster] = await fetchBookSnapshots('aster', [market('aster')], { now: NOW, fetchImpl: reader(() => [{ symbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', time: NOW - 60000 }]) });
  assert.equal(aster.sourceTime, NOW - 60000);
  await assert.rejects(fetchBookSnapshots('bybit', bybit, { fetchImpl: reader(() => ({ retCode: 10006, retMsg: 'Too many visits' })) }), /Too many visits/);
  const specs = createSubscriptions('bybit', Array.from({ length: 400 }, (_, i) => market('bybit', `COIN${i}`)));
  assert.equal(specs.filter(spec => spec.snapshot).length, 1);
  const rows = await specs[0].snapshot({ now: NOW, fetchImpl: reader(() => ({ retCode: 0, time: NOW, result: { list: [{ symbol: 'COIN399', bid1Price: '100', ask1Price: '101' }] } })) });
  assert.equal(rows[0].symbol, 'COIN399');
});

test('Bybit REST funding restores expired negative and zero rates through the existing bulk snapshot', async () => {
  const markets = [market('bybit')];
  const [spec] = createSubscriptions('bybit', markets);
  for (const rate of [-0.0001, 0]) {
    const [initial] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'snapshot', ts: NOW, data: { symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', fundingRate: String(rate) } }, markets, NOW);
    let current = mergePerpetualQuote(undefined, initial, NOW);
    assert.equal(normalizedFunding8h(current, NOW), rate);
    for (const elapsed of [60_000, 180_000, 300_001]) {
      const time = NOW + elapsed;
      const [delta] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'delta', ts: time, data: { bid1Price: '102', ask1Price: '103' } }, markets, time);
      current = mergePerpetualQuote(current, delta, time);
    }
    const confirmedAt = NOW + 305_000;
    assert.equal(current.bidAskAt, NOW + 300_001);
    assert.equal(current.fundingAt, NOW);
    assert.equal(normalizedFunding8h(current, confirmedAt), null);
    const calls = [];
    const [confirmation] = await spec.snapshot({ now: confirmedAt, fetchImpl: reader(url => {
      calls.push(url);
      return { retCode: 0, time: confirmedAt, result: { list: [{ symbol: 'BTCUSDT', bid1Price: '102', ask1Price: '103', fundingRate: String(rate), fundingIntervalHour: '4', nextFundingTime: String(confirmedAt + 3_600_000) }] } };
    }) });
    assert.deepEqual(calls, ['https://api.bybit.com/v5/market/tickers?category=linear']);
    current = mergePerpetualQuote(current, confirmation, confirmedAt);
    assert.equal(current.fundingAt, confirmedAt);
    assert.equal(current.fundingRate, rate);
    assert.equal(normalizedFunding8h(current, confirmedAt), rate * 2);
    assert.equal(current.fundingIntervalHours, 4);
    assert.equal(current.nextFundingAt, confirmedAt + 3_600_000);
  }
});

test('Bybit REST funding maps server time and prefers ticker interval over catalog fallback', async () => {
  const markets = [market('bybit'), market('bybit', 'ETHUSDT', { base: 'ETH', fundingIntervalHours: 4 })];
  const rows = await fetchBookSnapshots('bybit', markets, { now: NOW, fetchImpl: reader(() => ({ retCode: 0, time: NOW - 20, result: { list: [
    { symbol: 'BTCUSDT', fundingRate: '-0.0002', fundingIntervalHour: '1', nextFundingTime: String(NOW + 3_600_000) },
    { symbol: 'ETHUSDT', fundingRate: '0' },
  ] } })) });
  assert.equal(rows.length, 2);
  const [explicit, fallback] = rows;
  assert.equal(explicit.sourceTime, NOW - 20);
  assert.equal(explicit.transport, 'rest');
  assert.equal(explicit.fundingRate, -0.0002);
  assert.equal(explicit.fundingIntervalHours, 1);
  assert.equal(explicit.nextFundingAt, NOW + 3_600_000);
  assert.equal(fallback.fundingRate, 0);
  assert.equal(fallback.fundingIntervalHours, 4);
  assert.equal(Object.hasOwn(fallback, 'nextFundingAt'), false);
});

test('Bybit REST funding omission preserves stale rate while explicit empty fields clear values', async () => {
  const markets = [market('bybit')], later = NOW + 300_001;
  const [initial] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { fundingRate: '-0.0001', nextFundingTime: String(NOW + 3_600_000) } }, markets, NOW);
  const prior = mergePerpetualQuote(undefined, initial, NOW);
  const [missing] = await fetchBookSnapshots('bybit', markets, { now: later, fetchImpl: reader(() => ({ retCode: 0, time: later, result: { list: [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101' }] } })) });
  for (const key of ['fundingRate', 'fundingIntervalHours', 'nextFundingAt']) assert.equal(Object.hasOwn(missing, key), false, `${key} must remain omitted`);
  const unchanged = mergePerpetualQuote(prior, missing, later);
  assert.equal(unchanged.fundingAt, NOW);
  assert.equal(unchanged.fundingRate, prior.fundingRate);
  assert.equal(unchanged.nextFundingAt, prior.nextFundingAt);
  assert.equal(normalizedFunding8h(unchanged, later), null);
  for (const empty of ['', null]) {
    const [cleared] = await fetchBookSnapshots('bybit', markets, { now: later, fetchImpl: reader(() => ({ retCode: 0, time: later, result: { list: [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', fundingRate: empty, fundingIntervalHour: empty, nextFundingTime: empty }] } })) });
    for (const key of ['fundingRate', 'fundingIntervalHours', 'nextFundingAt']) assert.equal(cleared[key], null, `${key} must clear explicit ${String(empty)}`);
    const current = mergePerpetualQuote(prior, cleared, later);
    assert.equal(current.fundingRate, null);
    assert.equal(current.fundingIntervalHours, null);
    assert.equal(current.nextFundingAt, null);
    assert.equal(normalizedFunding8h(current, later), null);
  }
});

test('Bybit REST funding old response time cannot refresh or overwrite a newer funding confirmation', async () => {
  const markets = [market('bybit')], receivedAt = NOW + 360_000;
  const [initial] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { fundingRate: '-0.0001', nextFundingTime: String(NOW + 3_600_000) } }, markets, NOW);
  const prior = mergePerpetualQuote(undefined, initial, NOW);
  const [old] = await fetchBookSnapshots('bybit', markets, { now: receivedAt, fetchImpl: reader(() => ({ retCode: 0, time: NOW - 1, result: { list: [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', fundingRate: '0.0003', fundingIntervalHour: '1', nextFundingTime: String(NOW + 7_200_000) }] } })) });
  assert.equal(old.fundingRate, 0.0003);
  assert.equal(old.sourceTime, NOW - 1);
  const current = mergePerpetualQuote(prior, old, receivedAt);
  assert.equal(current.fundingAt, NOW);
  assert.equal(current.fundingRate, prior.fundingRate);
  assert.equal(current.fundingIntervalHours, prior.fundingIntervalHours);
  assert.equal(current.nextFundingAt, prior.nextFundingAt);
  assert.equal(normalizedFunding8h(current, receivedAt), null);
});

test('Bybit REST funding failed confirmations emit no update and cannot refresh a stale rate', async () => {
  const markets = [market('bybit')], later = NOW + 300_001;
  const [initial] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { fundingRate: '-0.0001' } }, markets, NOW);
  const prior = mergePerpetualQuote(undefined, initial, NOW);
  const [spec] = createSubscriptions('bybit', markets);
  for (const fetchImpl of [reader(() => ({ retCode: 10006, retMsg: 'Too many visits' })), async () => { throw new Error('Network unavailable'); }]) {
    let current = prior;
    await assert.rejects(async () => {
      const updates = await spec.snapshot({ now: later, fetchImpl });
      for (const update of updates) current = mergePerpetualQuote(current, update, later);
    }, /Too many visits|Network unavailable/);
    assert.equal(current, prior);
    assert.equal(current.fundingAt, NOW);
    assert.equal(normalizedFunding8h(current, later), null);
  }
});

test('Hyperliquid WS info snapshots confirm exact BBO and expose post or partial subscription errors', () => {
  const markets = [market('hyperliquid', 'BTC')];
  const payload = { channel: 'post', data: { id: 0, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'BTC', time: NOW, levels: [[{ px: '100.01', sz: '1' }, { px: '99', sz: '2' }], []] } } } } };
  const [book] = parseMessage('hyperliquid', payload, markets, NOW);
  assert.equal(book.bid, 100.01); assert.equal(book.ask, null); assert.equal(book.sourceTime, NOW);
  const spec = createSubscriptions('hyperliquid', markets)[0];
  assert.equal(spec.poll.intervalMs, 30000);
  assert.deepEqual(spec.poll.messages[0].request.payload, { type: 'l2Book', coin: 'BTC' });
  assert.ok(spec.subscribe.some(message => message.subscription.type === 'bbo'));
  assert.throws(() => parseMessage('hyperliquid', { channel: 'post', data: { response: { type: 'error', payload: '429 Too Many Requests' } } }, markets), /429/);
  assert.throws(() => parseMessage('bybit', { op: 'COMMAND_RESP', success: true, data: { failTopics: ['tickers.BTCUSDT'] } }, []), /failTopics/);
  assert.throws(() => parseMessage('binance', { code: 0, msg: 'Unknown property' }, []), /Unknown property/);
  assert.throws(() => parseMessage('gate', { event: 'subscribe', result: { status: 'fail' } }, []), /WebSocket/);
});

test('market lookup cache is reused and refreshed when discovery replaces identities', () => {
  const markets = [market('binance')], context = {};
  const payload = { e: 'bookTicker', s: 'BTCUSDT', b: '100', a: '101', E: NOW };
  parseMessage('binance', payload, markets, NOW, context);
  const index = context.marketIndex;
  parseMessage('binance', payload, markets, NOW, context);
  assert.equal(context.marketIndex, index);
  const [next] = parseMessage('binance', payload, [{ ...markets[0], base: 'VERIFIED:BTC' }], NOW, context);
  assert.equal(next.base, 'VERIFIED:BTC');
  assert.notEqual(context.marketIndex, index);
});

test('Gate requests decimal quantities and retains executable fractional-contract BBOs', () => {
  const markets = [market('gate', 'BTC_USDT')];
  const spec = createSubscriptions('gate', markets)[0];
  assert.deepEqual(spec.headers, { 'X-Gate-Size-Decimal': '1' });
  const payload = { channel: 'futures.book_ticker', event: 'update', time_ms: NOW, result: { s: 'BTC_USDT', b: '100', B: '0.1', a: '101', A: '0.25', t: NOW } };
  const [book] = parseMessage('gate', payload, markets, NOW);
  assert.equal(book.bid, 100); assert.equal(book.ask, 101);
  const [removed] = parseMessage('gate', { ...payload, result: { ...payload.result, B: '0' } }, markets, NOW);
  assert.equal(removed.bid, null);
});

test('Bitget keeps bounded major-coin WS subscriptions and discovers all snapshot products', async () => {
  const markets = [market('bitget'), market('bitget', 'ETHUSDT', { base: 'ETH' }), market('bitget', 'SOLUSDT', { base: 'SOL' }), market('bitget', 'OTHERUSDT', { base: 'OTHER' }), market('bitget', 'BTCPERP', { quoteCurrency: 'USDC', productType: 'USDC-FUTURES' })];
  const [spec] = createSubscriptions('bitget', markets);
  assert.equal(spec.markets.length, markets.length);
  assert.deepEqual(spec.subscribe[0].args.map(row => row.instId), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(spec.snapshotIntervalMs, 5000);
  const calls = [];
  const rows = await spec.snapshot({ now: NOW, fetchImpl: reader(url => {
    calls.push(url);
    return { code: '00000', requestTime: NOW, data: [{ symbol: url.includes('USDC') ? 'BTCPERP' : 'OTHERUSDT', ts: String(NOW - 100), bidPr: '100', bidSz: '1', askPr: '101', askSz: '2', markPrice: '100.5', fundingRate: '0.0001' }] };
  }) });
  assert.equal(calls.length, 2);
  assert.ok(calls.some(url => url.endsWith('productType=USDT-FUTURES')));
  assert.ok(calls.some(url => url.endsWith('productType=USDC-FUTURES')));
  assert.deepEqual(rows.map(row => row.symbol).sort(), ['BTCPERP', 'OTHERUSDT']);
  assert.ok(rows.every(row => row.transport === 'rest' && row.sourceTime === NOW - 100 && row.fundingRate === .0001));
  assert.equal(rows[0].mark, 100.5);
  assert.equal(Object.hasOwn(rows[0], 'nextFundingAt'), false);
});

test('Bitget snapshots preserve old row times, normalize baskets and tolerate one unavailable product', async () => {
  const markets = [market('bitget', '1000PEPEUSDT', { base: 'PEPE', multiplier: 1000 }), market('bitget', 'BTCPERP', { quoteCurrency: 'USDC' })];
  const rows = await fetchBookSnapshots('bitget', markets, { now: NOW, fetchImpl: reader(url => {
    if (url.includes('USDC')) return { code: '429', msg: 'Rate limit' };
    return { code: '00000', requestTime: NOW, data: [{ symbol: '1000PEPEUSDT', ts: NOW - 60000, bidPr: '.01', bidSz: '.1', askPr: '.02', askSz: '0', fundingRate: '0' }, { symbol: 'UNLISTED', bidPr: '1', askPr: '2' }] };
  }) });
  assert.equal(rows.length, 1); assert.equal(rows[0].bid, .00001); assert.equal(rows[0].ask, null);
  assert.equal(rows[0].sourceTime, NOW - 60000); assert.equal(rows[0].fundingRate, 0);
  const [fallback] = await fetchBookSnapshots('bitget', markets.slice(0, 1), { now: NOW, fetchImpl: reader(() => ({ code: '00000', requestTime: NOW - 20, data: [{ symbol: '1000PEPEUSDT', bidPr: '.01', askPr: '.02' }] })) });
  assert.equal(fallback.sourceTime, NOW - 20);
});

test('Hyperliquid and Entropy auxiliary snapshots share a capped budget and only target inactive books', () => {
  const hl = Array.from({ length: 178 }, (_, index) => market('hyperliquid', `COIN${index}`));
  const entropy = Array.from({ length: 8 }, (_, index) => market('entropy', `io:COIN${index}`));
  const specs = [...createSubscriptions('hyperliquid', hl), ...createSubscriptions('entropy', entropy)];
  // The service enforces this per host, not independently per connection.
  // This is our conservative cap, not a claim about the official WS limiter.
  assert.equal(new Set(specs.map(spec => new URL(spec.url).host)).size, 1);
  assert.ok(specs.every(spec => spec.poll.maxPerMinute === 60));
  assert.ok(specs.every(spec => spec.poll.staleBookAfterMs === 15000));
  assert.ok(specs[0].poll.maxPerMinute * 2 < 1200);
  assert.ok(specs.every(spec => spec.subscribe.some(row => row.subscription.type === 'bbo')));
  assert.ok(specs.every(spec => spec.poll.sendIntervalMs * spec.poll.messages.length < spec.poll.intervalMs));
});
