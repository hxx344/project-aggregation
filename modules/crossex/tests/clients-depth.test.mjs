import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPublicClients } from '../server/clients.mjs';
import { publicSnapshot } from '../server/public-snapshot.mjs';
import { D } from '../server/money.mjs';
import { validIdentity, validManualIdentity, validManualPair, contractIdentity } from '../server/model.mjs';

const NOW = 1790067200000;
function quote(exchange, currency = 'USDT', base = 'BTC') {
  const symbol = { binance: `${base}${currency}`, bybit: currency === 'USDC' ? `${base}PERP` : `${base}${currency}`, okx: `${base}-${currency}-SWAP`, gate: `${base}_USDT`, kraken: `PF_${base === 'BTC' ? 'XBT' : base}USD`, hyperliquid: base, lighter: base, deribit: `${base}_USDC-PERPETUAL` }[exchange];
  const settlementCurrency = exchange === 'hyperliquid' ? 'USDC' : currency;
  return { exchange, symbol, base, rawBase: base, quoteCurrency: currency, settlementCurrency, collateralCurrency: exchange === 'kraken' ? 'MULTI' : settlementCurrency, counterCurrency: settlementCurrency, contractKind: exchange === 'hyperliquid' && currency === 'USDT' ? 'quanto' : 'linear', crossexSymbol: `${exchange.toUpperCase()}_FUTURE_${base}_${settlementCurrency}`, multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'official-fixture', comparable: true, ...(exchange === 'lighter' ? { marketId: 1 } : {}) };
}
const rows = { bids: [['100', '20'], ['99', '10']], asks: [['101', '30'], ['102', '15']] };
const objects = key => rows[key].map(([price, size]) => ({ price, size }));
function socketFixture(messages) {
  return class Socket extends EventEmitter {
    static instances = [];
    constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.terminated = false; this.constructor.instances.push(this); queueMicrotask(() => this.emit('open')); }
    send(raw) { this.sent.push(JSON.parse(raw)); if (this.sent.length === 1) queueMicrotask(() => { for (const value of messages) if (!this.terminated) this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); }); }
    terminate() { this.terminated = true; }
  };
}
function fixture(q, overrides = {}) {
  const binance = { symbols: [{ symbol: `${q.base}${q.exchange === 'binance' ? q.quoteCurrency : 'USDT'}`, baseAsset: q.base, quoteAsset: q.exchange === 'binance' ? q.quoteCurrency : 'USDT', marginAsset: q.exchange === 'binance' ? q.quoteCurrency : 'USDT', contractType: 'PERPETUAL', status: 'TRADING', underlyingType: 'COIN', underlyingSubType: ['PoW', 'Crypto'] }] };
  const requests = [], metadata = {
    binance,
    bybit: { retCode: 0, result: { category: 'linear', list: [{ symbol: q.symbol, baseCoin: q.base, quoteCoin: q.quoteCurrency, settleCoin: q.settlementCurrency, contractType: 'LinearPerpetual', status: 'Trading', symbolType: '', deliveryTime: '0', isPreListing: false }] } },
    okx: { code: '0', data: [{ instId: q.symbol, instType: 'SWAP', ctType: 'linear', ctValCcy: q.base, settleCcy: q.settlementCurrency, state: 'live', instCategory: '1', ruleType: 'normal', ctVal: '0.01', ctMult: '1' }] },
    gate: { name: q.symbol, type: 'direct', contract_type: '', is_pre_market: false, quanto_multiplier: '0.0001', in_delisting: false },
    kraken: { result: 'success', instruments: [{ symbol: q.symbol, type: 'flexible_futures', base: 'XBT', quote: 'USD', contractSize: 1, tradeable: true, postOnly: false, isExpired: false, tradfi: false }] },
    hyperliquid: { collateralToken: 0, universe: [{ name: q.symbol, szDecimals: 5, maxLeverage: 40, isDelisted: false }] },
    lighter: { code: 200, order_book_details: [{ symbol: q.symbol, market_id: 1, market_type: 'perp', multiplier: '1', status: 'active', funding_premium_multiplier: 100 }] },
    deribit: { jsonrpc: '2.0', result: { instrument_name: q.symbol, kind: 'future', instrument_type: 'linear', future_type: 'linear', is_active: true, state: 'open', underlying_type: 'crypto', settlement_period: 'perpetual', base_currency: q.base, quote_currency: 'USDC', settlement_currency: 'USDC', contract_size: 0.0001, min_trade_amount: 0.0001, expiration_timestamp: 32503708800000 } },
  }[q.exchange];
  const depth = {
    binance: { T: NOW, ...rows },
    bybit: { retCode: 0, result: { s: q.symbol, cts: NOW, ts: NOW + 2, b: rows.bids, a: rows.asks } },
    okx: { code: '0', data: [{ ts: String(NOW), ...rows }] },
    gate: { update: NOW / 1000, current: NOW / 1000 + 2, bids: rows.bids.map(([p, s]) => ({ p, s })), asks: rows.asks.map(([p, s]) => ({ p, s })) },
    hyperliquid: { coin: q.symbol, time: NOW, levels: [rows.bids.map(([px, sz]) => ({ px, sz })), rows.asks.map(([px, sz]) => ({ px, sz }))] },
    deribit: { jsonrpc: '2.0', result: { instrument_name: q.symbol, state: 'open', timestamp: NOW, ...rows } },
  }[q.exchange];
  return { metadata, binance, depth, requests, fetcher: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    if (init.method === 'POST') { assert.equal(url, 'https://api.hyperliquid.xyz/info'); assert.ok(['meta', 'l2Book'].includes(JSON.parse(init.body).type)); }
    else assert.equal(init.method, 'GET');
    if (url.endsWith('/exchangeInfo') && q.exchange !== 'binance') return new Response(JSON.stringify(overrides.binance ?? binance));
    const isMetadata = /exchangeInfo|instruments-info|public\/instruments|public\/get_instrument\?|contracts\/|v3\/instruments|orderBookDetails/.test(url) || JSON.parse(init.body || '{}').type === 'meta';
    return new Response(JSON.stringify(isMetadata ? overrides.metadata ?? metadata : overrides.depth ?? depth));
  } };
}

for (const [exchange, currency, expectedUnit] of [['binance', 'USDT', 1], ['binance', 'USDC', 1], ['bybit', 'USDT', 1], ['bybit', 'USDC', 1], ['okx', 'USDT', 0.01], ['okx', 'USDC', 0.01], ['gate', 'USDT', 0.0001], ['hyperliquid', 'USDT', 1], ['deribit', 'USDC', 1]]) {
  test(`${exchange} ${currency}: official identity, source time and base quantity retain native prices`, async () => {
    const q = quote(exchange, currency), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW + 100 });
    const book = await clients.loadDepth(q);
    assert.equal(book.at, NOW); assert.equal(book.quoteCurrency, currency); assert.equal(book.symbol, q.symbol);
    assert.deepEqual(book.bids, [[100, 20 * expectedUnit], [99, 10 * expectedUnit]]);
    assert.equal(book.asks[0][0], 101); assert.equal(book.receivedAt, NOW + 100);
    await clients.loadDepth(q); assert.equal(f.requests.length, exchange === 'binance' ? 3 : 4, 'verified native and independent metadata are reused, every depth read remains fresh');
  });
}

for (const [exchange, unit, quantities, expected, total] of [
  ['gate', '0.0001', ['75', '200', '10000', '2226'], [0.0075, 0.02, 1, 0.2226], '1.2501'],
  ['okx', '0.01', ['188', '75.5', '0.125'], [1.88, 0.755, 0.00125], '2.63625'],
  ['okx', '0.001', ['188', '75.5', '0.125'], [0.188, 0.0755, 0.000125], '0.263625'],
  ['okx', '0.0001', ['188', '75.5', '0.125'], [0.0188, 0.00755, 0.0000125], '0.0263625'],
]) test(`${exchange} ${unit}: native contract quantities avoid multiplication tails and keep numeric depth`, async () => {
  const q = quote(exchange), f = fixture(q);
  const bids = quantities.map((quantity, index) => [String(100 - index), quantity]);
  const asks = quantities.map((quantity, index) => [String(101 + index), quantity]);
  if (exchange === 'gate') {
    f.metadata.quanto_multiplier = unit;
    f.depth.bids = bids.map(([p, s]) => ({ p, s })); f.depth.asks = asks.map(([p, s]) => ({ p, s }));
  } else {
    f.metadata.data[0].ctVal = unit;
    Object.assign(f.depth.data[0], { bids, asks });
  }
  const book = await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q);
  for (const side of ['bids', 'asks']) {
    assert.deepEqual(book[side], expected.map((quantity, index) => [side === 'bids' ? 100 - index : 101 + index, quantity]));
    assert.ok(book[side].every(level => level.every(value => typeof value === 'number' && Number.isFinite(value))));
    assert.equal(book[side].reduce((sum, [, quantity]) => sum.plus(String(quantity)), D(0)).toString(), total,
      'the terminal decimal accumulator receives clean base quantities');
  }
});

test('contract multipliers retain their supplied decimal precision until final numeric depth conversion', async () => {
  for (const exchange of ['gate', 'okx']) {
    const q = quote(exchange), f = fixture(q);
    if (exchange === 'gate') {
      f.metadata.quanto_multiplier = '0.00010000000000000001';
      f.depth.bids = [{ p: '100', s: '75' }]; f.depth.asks = [{ p: '101', s: '75' }];
    } else {
      f.metadata.data[0].ctVal = '0.00010000000000000001';
      Object.assign(f.depth.data[0], { bids: [['100', '75']], asks: [['101', '75']] });
    }
    const book = await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q);
    // The source product is 0.00750000000000000075; do not erase valid digits to prettify it.
    assert.equal(book.bids[0][1], 0.007500000000000001);
    assert.equal(book.asks[0][1], 0.007500000000000001);
  }
});

test('external CrossEx positions resolve native contracts without Monitor, including Lighter market IDs', async () => {
  for (const [exchange, currency] of [['binance', 'USDT'], ['bybit', 'USDC'], ['okx', 'USDT'], ['gate', 'USDT'], ['kraken', 'USD'], ['hyperliquid', 'USDT'], ['lighter', 'USDC'], ['deribit', 'USDC']]) {
    const q = quote(exchange, currency), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
    const resolved = await clients.resolveCrossexQuote(q.crossexSymbol);
    assert.equal(resolved.symbol, q.symbol); assert.equal(resolved.counterCurrency, q.counterCurrency);
    assert.equal(resolved.settlementCurrency, q.settlementCurrency); assert.equal(resolved.marketId, q.marketId);
  }
  const q = quote('binance'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
  for (const symbol of ['DERIBIT_FUTURE_BTC_USDT', 'DERIBIT_FUTURE_BTC_USD', 'BINANCE_SPOT_BTC_USDT', 'GATE_FUTURE_BTC_USDC']) await assert.rejects(clients.resolveCrossexQuote(symbol));
  assert.equal(f.requests.length, 0);
});

test('Hyperliquid HYPE uses USDC and sends only public metadata/L2 POST bodies', async () => {
  const q = quote('hyperliquid', 'USDC', 'HYPE'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
  assert.equal((await clients.loadDepth(q)).quoteCurrency, 'USDC');
  assert.deepEqual(f.requests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body)), [{ type: 'meta' }, { type: 'l2Book', coin: 'HYPE' }]);
});

test('Kraken reads only complete matching snapshots, ignores deltas and uses exchange timestamp', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  const Socket = socketFixture([{ feed: 'book', product_id: q.symbol, timestamp: NOW + 50, bids: objects('bids'), asks: objects('asks') }, { feed: 'book_snapshot', product_id: q.symbol, timestamp: NOW, bids: objects('bids'), asks: objects('asks') }]);
  const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW + 100 });
  const book = await clients.loadDepth(q), socket = Socket.instances[0];
  assert.equal(book.at, NOW); assert.equal(book.quoteCurrency, 'USD'); assert.deepEqual(book.bids, [[100, 20], [99, 10]]);
  assert.deepEqual(socket.sent, [{ event: 'subscribe', feed: 'book', product_ids: ['PF_XBTUSD'] }]);
  assert.equal(socket.terminated, true); assert.equal(socket.options.followRedirects, false); assert.equal(socket.options.maxPayload, 8 * 1024 * 1024);
});

test('Lighter validates market_id against official metadata and accepts initial snapshot only', async () => {
  const q = quote('lighter', 'USDC'), f = fixture(q);
  const Socket = socketFixture([{ type: 'ping' }, { type: 'update/order_book', channel: 'order_book:1', timestamp: NOW }, { type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, last_updated_at: (NOW - 50) * 1000, bids: objects('bids'), asks: objects('asks') } }]);
  const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW + 100 });
  const book = await clients.loadDepth(q), socket = Socket.instances[0];
  assert.equal(book.at, NOW - 50); assert.equal(book.quoteCurrency, 'USDC'); assert.deepEqual(book.asks, [[101, 30], [102, 15]]);
  assert.deepEqual(socket.sent, [{ type: 'subscribe', channel: 'order_book/1' }, { type: 'pong' }]); assert.equal(socket.terminated, true);
  await assert.rejects(clients.loadDepth({ ...q, marketId: 2 }), /market_id/); assert.equal(Socket.instances.length, 1);
});

test('metadata cache is refreshed after expiry and a changed contract is rejected', async () => {
  let now = NOW;
  const q = quote('okx'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => now });
  await clients.loadDepth(q); now += 300_001; f.metadata.data[0].ctType = 'inverse';
  await assert.rejects(clients.loadDepth(q), /单位或身份/);
  assert.equal(f.requests.length, 4);
});

test('incorrect official unit, identity, status, or settlement blocks the depth read', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { x.symbols[0].marginAsset = 'BTC'; }],
    ['bybit', 'USDC', x => { x.result.list[0].settleCoin = 'USDT'; }],
    ['bybit', 'USDT', x => { x.result.list[0].contractType = 'LinearFutures'; }],
    ['bybit', 'USDT', x => { x.result.list[0].symbolType = 'xstocks'; }],
    ['okx', 'USDT', x => { x.data[0].ctValCcy = 'USD'; }],
    ['okx', 'USDT', x => { x.data[0].ctMult = '100'; }],
    ['okx', 'USDT', x => { x.data[0].ruleType = 'pre_market'; }],
    ['okx', 'USDT', x => { x.data[0].expTime = String(NOW + 60000); }],
    ['gate', 'USDT', x => { x.quanto_multiplier = '0'; }],
    ['gate', 'USDT', x => { x.in_delisting = true; }],
    ['gate', 'USDT', x => { x.status = 'reduce_only'; }],
    ['gate', 'USDT', x => { x.is_pre_market = true; }],
    ['kraken', 'USD', x => { x.instruments[0].type = 'futures_inverse'; }],
    ['kraken', 'USD', x => { x.instruments[0].contractSize = 10; }],
    ['kraken', 'USD', x => { delete x.instruments[0].tradfi; }],
    ['kraken', 'USD', x => { delete x.instruments[0].isExpired; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].isDelisted = true; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].multiplier = '1000'; }],
  ]) {
    const q = quote(exchange, currency), f = fixture(q); change(f.metadata);
    const clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
    await assert.rejects(clients.loadDepth(q), /未确认|变化/); assert.equal(f.requests.length, 1);
  }
});

test('fresh response time never rejuvenates an old Gate book or Lighter matching-engine time', async () => {
  const q = quote('gate'), f = fixture(q); f.depth.update = (NOW - 10_001) / 1000; f.depth.current = NOW / 1000;
  await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /过期/);
  const l = quote('lighter', 'USDC'), lf = fixture(l), Socket = socketFixture([{ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, last_updated_at: (NOW - 10_001) * 1000, bids: objects('bids'), asks: objects('asks') } }]);
  await assert.rejects(createPublicClients({ fetcher: lf.fetcher, clock: () => NOW, WebSocketImpl: Socket }).loadDepth(l), /过期/);
});

test('invalid symbols, multipliers and contradictory venue identity make no public requests', async () => {
  let requests = 0;
  const clients = createPublicClients({ fetcher: async () => { requests++; throw Error('unexpected'); } });
  for (const patch of [{ exchange: 'deribit' }, { multiplier: 1000 }, { symbol: 'BTCUSDT&other=1' }, { identityVerified: false }]) await assert.rejects(clients.loadDepth({ ...quote('binance'), ...patch }), /不支持/);
  assert.equal(requests, 0);
});

test('snapshots fail closed on wrong products, missing time, crossed books and malformed levels', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  for (const change of [value => { value.product_id = 'PF_ETHUSD'; }, value => { delete value.timestamp; }, value => { value.timestamp = NOW + 1001; }, value => { value.bids[0].price = '102'; }, value => { value.asks[0].size = null; }]) {
    const message = { feed: 'book_snapshot', product_id: q.symbol, timestamp: NOW, bids: objects('bids'), asks: objects('asks') }; change(message);
    const Socket = socketFixture([message]), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW, WebSocketImpl: Socket });
    await assert.rejects(clients.loadDepth(q), /不一致|过期|交叉|无效|排序/); assert.equal(Socket.instances[0].terminated, true);
  }
});

test('one-shot socket terminates on malformed data and timeout; subscription cannot send transactions', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  for (const messages of [[], ['not json'], [{ event: 'error', message: 'no' }]]) {
    const Socket = socketFixture(messages), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW, timeoutMs: 20 });
    await assert.rejects(clients.loadDepth(q), /超时|格式|订阅/); assert.equal(Socket.instances[0].terminated, true);
  }
  assert.throws(() => publicSnapshot({ source: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true', subscription: { type: 'jsonapi/sendtx', data: {} } }), /仅允许/);
});

test('Monitor-supported Bybit innovation and OKX category 2 remain usable; unknown metadata rejects', async () => {
  for (const [exchange, field, supported] of [['bybit', 'symbolType', 'innovation'], ['okx', 'instCategory', '2']]) {
    const q = quote(exchange), f = fixture(q), row = exchange === 'bybit' ? f.metadata.result.list[0] : f.metadata.data[0];
    row[field] = supported;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
    for (const invalid of [undefined, 'unknown', 'stock']) {
      row[field] = invalid;
      await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /身份/);
    }
  }
});

test('saved identity flags cannot bypass missing or newly non-crypto native classification', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { delete x.symbols[0].underlyingType; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingType = 'STOCK'; }],
    ['binance', 'USDT', x => { delete x.symbols[0].underlyingSubType; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['stock']; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['ETF']; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['pre-IPO']; }],
    ['gate', 'USDT', x => { delete x.contract_type; }],
    ['gate', 'USDT', x => { x.contract_type = 'stocks'; }],
    ['gate', 'USDT', x => { delete x.is_pre_market; }],
    ['lighter', 'USDC', x => { delete x.order_book_details[0].funding_premium_multiplier; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 50; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 1; }],
    ['hyperliquid', 'USDT', x => { delete x.universe[0].szDecimals; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].szDecimals = -1; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].szDecimals = 1.5; }],
    ['hyperliquid', 'USDT', x => { delete x.universe[0].maxLeverage; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].maxLeverage = 0; }],
    ['hyperliquid', 'USDT', x => { delete x.collateralToken; }],
    ['hyperliquid', 'USDT', x => { x.collateralToken = 1; }],
  ]) {
    const q = quote(exchange, currency), f = fixture(q); change(f.metadata);
    const Socket = socketFixture([]), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW });
    await assert.rejects(clients.loadDepth(q), /未确认|变化/);
    assert.equal(f.requests.length, 1, 'contradictory native metadata blocks all depth requests');
    assert.equal(Socket.instances.length, 0);
  }
});

test('every non-Binance venue rechecks independent COIN evidence even without a current feed quote', async () => {
  for (const [exchange, currency] of [['bybit', 'USDT'], ['okx', 'USDT'], ['gate', 'USDT'], ['kraken', 'USD'], ['hyperliquid', 'USDT'], ['lighter', 'USDC'], ['deribit', 'USDC']]) {
    for (const change of [
      x => { x.symbols = []; },
      x => { delete x.symbols[0].underlyingType; },
      x => { x.symbols[0].underlyingSubType = ['stock']; },
      x => { x.symbols[0].baseAsset = 'ETH'; x.symbols[0].symbol = 'ETHUSDT'; },
      x => { x.symbols[0].status = 'SETTLING'; },
    ]) {
      const q = quote(exchange, currency), f = fixture(q); change(f.binance);
      const Socket = socketFixture([]), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW });
      await assert.rejects(clients.loadDepth(q), /独立 Binance COIN/);
      assert.equal(f.requests.length, 2, 'reads both directories, never a book'); assert.equal(Socket.instances.length, 0);
    }
  }
});

test('native classification withdrawal after metadata cache expiry blocks another depth read', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['stock']; }],
    ['gate', 'USDT', x => { x.contract_type = 'stocks'; }],
    ['hyperliquid', 'USDT', x => { x.collateralToken = 1; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 50; }],
  ]) {
    let now = NOW;
    const q = quote(exchange, currency), f = fixture(q);
    const Socket = socketFixture([{ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, bids: objects('bids'), asks: objects('asks') } }]);
    const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => now });
    await clients.loadDepth(q); const previousRequests = f.requests.length, previousSockets = Socket.instances.length;
    change(f.metadata); now += 300_001;
    await assert.rejects(clients.loadDepth(q), /未确认|变化/);
    assert.equal(f.requests.length, previousRequests + 1); assert.equal(Socket.instances.length, previousSockets);
  }
});

test('expired independent evidence is refreshed and cannot be rescued by the saved quote or cached native identity', async () => {
  let now = NOW;
  const q = quote('hyperliquid'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => now });
  await clients.loadDepth(q); now += 300_001; f.binance.symbols[0].underlyingType = 'STOCK';
  await assert.rejects(clients.loadDepth(q), /独立 Binance COIN/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/exchangeInfo')).length, 2);
  assert.equal(f.requests.filter(r => r.init.body && JSON.parse(r.init.body).type === 'l2Book').length, 1);
});

test('legitimate crypto categories and independently listed native Hyperliquid assets stay available', async () => {
  for (const subtypes of [[], ['PoW', 'Crypto'], ['DeFi', 'Layer-1']]) {
    const q = quote('binance'), f = fixture(q); f.binance.symbols[0].underlyingSubType = subtypes;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
  }
  for (const contract_type of ['', 'crypto']) {
    const q = quote('gate'), f = fixture(q); f.metadata.contract_type = contract_type;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
  }
  for (const base of ['HYPE', 'PURR']) {
    const q = quote('hyperliquid', 'USDC', base), f = fixture(q); f.metadata.universe[0].szDecimals = 0;
    assert.equal((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).quoteCurrency, 'USDC');
  }
});

test('Deribit linear USDC depth amounts are base coins, independent of contract size', async () => {
  // Deribit public/get_instrument and Linear Perpetual specifications, checked 2026-10-08:
  // https://docs.deribit.com/api-reference/market-data/public-get_instrument
  // https://support.deribit.com/hc/en-us/articles/31424969384605-Linear-Perpetual
  const q = quote('deribit', 'USDC'), f = fixture(q);
  f.depth.result.bids = [[65000.1, 0.1234], [65000, 0.0001]];
  f.depth.result.asks = [[65000.2, 0.2345], [65000.3, 0.5]];
  const clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW + 25 });
  const resolved = await clients.resolveCrossexQuote('DERIBIT_FUTURE_BTC_USDC');
  const book = await clients.loadDepth(resolved);
  assert.equal(resolved.symbol, 'BTC_USDC-PERPETUAL'); assert.equal(resolved.multiplier, 1);
  assert.equal(book.quoteCurrency, 'USDC'); assert.equal(book.at, NOW); assert.equal(book.receivedAt, NOW + 25);
  assert.deepEqual(book.bids, [[65000.1, 0.1234], [65000, 0.0001]]);
  assert.deepEqual(book.asks, [[65000.2, 0.2345], [65000.3, 0.5]]);
  assert.equal(f.requests[0].url, 'https://www.deribit.com/api/v2/public/get_instrument?instrument_name=BTC_USDC-PERPETUAL');
  assert.equal(book.source, 'https://www.deribit.com/api/v2/public/get_order_book?instrument_name=BTC_USDC-PERPETUAL&depth=100');
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(item => item.init.method === 'GET' && item.init.body === undefined));
});

test('Deribit documented future_type is a fallback only when instrument_type is absent', async () => {
  const q = quote('deribit', 'USDC'), f = fixture(q); delete f.metadata.result.instrument_type;
  assert.equal((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).symbol, q.symbol);
  for (const row of [{ instrument_type: 'reversed', future_type: 'linear' }, { instrument_type: 'linear', future_type: 'reversed' }, { instrument_type: undefined, future_type: undefined }]) {
    const invalid = fixture(q); Object.assign(invalid.metadata.result, row);
    await assert.rejects(createPublicClients({ fetcher: invalid.fetcher, clock: () => NOW }).loadDepth(q), /未确认/);
    assert.equal(invalid.requests.length, 1);
  }
});

test('Deribit native classification, lifecycle and settlement contradictions block depth', async () => {
  for (const changes of [
    { underlying_type: 'equity' }, { underlying_type: 'preipo' }, { underlying_type: undefined },
    { state: 'locked' }, { state: 'halted' }, { state: 'settlement' }, { is_active: false },
    { kind: 'option' }, { kind: 'future_combo' }, { settlement_period: 'month' },
    { instrument_name: 'ETH_USDC-PERPETUAL' }, { base_currency: 'ETH' }, { quote_currency: 'USD' }, { settlement_currency: 'BTC' },
  ]) {
    const q = quote('deribit', 'USDC'), f = fixture(q); Object.assign(f.metadata.result, changes);
    await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /未确认/);
    assert.equal(f.requests.length, 1, 'rejected metadata never reaches independent evidence or depth');
  }
  const q = quote('deribit', 'USDC'), f = fixture(q); f.metadata.error = { code: 11050, message: 'invalid_request' };
  await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /未确认/);
});

test('Deribit book matching, lifecycle and source timestamps are required on every read', async () => {
  for (const changes of [
    { instrument_name: 'ETH_USDC-PERPETUAL' }, { state: 'locked' }, { state: 'halted' }, { state: 'settlement' },
    { timestamp: NOW - 10_001 }, { timestamp: NOW + 1001 }, { timestamp: NOW / 1000 }, { timestamp: undefined },
    { bids: [[101.1, 1]] }, { asks: [[101, 0]] },
  ]) {
    const q = quote('deribit', 'USDC'), f = fixture(q); Object.assign(f.depth.result, changes);
    await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /无效|过期|交叉/);
    assert.equal(f.requests.length, 3);
  }
  const q = quote('deribit', 'USDC'), f = fixture(q); f.depth.error = { code: 10000, message: 'authorization_required' };
  await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /无效/);
});

test('Deribit inverse, mismatched settlement and unverified quantity identities fail before network', async () => {
  let requests = 0;
  const clients = createPublicClients({ fetcher: async () => { requests++; throw Error('unexpected request'); } });
  for (const changes of [{ symbol: 'BTC-PERPETUAL' }, { quoteCurrency: 'USD' }, { settlementCurrency: 'BTC' }, { collateralCurrency: 'BTC' }, { counterCurrency: 'USDT' }, { contractKind: 'inverse' }, { multiplier: 0.0001 }, { rawBase: '1000BTC' }, { crossexSymbol: 'DERIBIT_FUTURE_BTC_USDT' }]) {
    await assert.rejects(clients.loadDepth({ ...quote('deribit', 'USDC'), ...changes }), /不支持/);
  }
  assert.equal(requests, 0);
});

test('Deribit native crypto evidence is refreshed after metadata cache expiry', async () => {
  let now = NOW;
  const q = quote('deribit', 'USDC'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => now });
  await clients.loadDepth(q); f.metadata.result.underlying_type = 'crypto_index'; now += 300_001;
  await assert.rejects(clients.loadDepth(q), /未确认/);
  assert.equal(f.requests.filter(item => item.url.includes('/get_instrument?')).length, 2);
  assert.equal(f.requests.filter(item => item.url.includes('/get_order_book?')).length, 1);
});

test('Gate requests decimal contract sizes before converting fractional lots to base quantities', async () => {
  const q = quote('gate', 'USDT', 'ETH'), f = fixture(q); f.metadata.quanto_multiplier = '0.01';
  const fetcher = async (url, init) => {
    if (!url.includes('/order_book?')) return f.fetcher(url, init);
    assert.equal(init.headers['X-Gate-Size-Decimal'], '1');
    return new Response(JSON.stringify({ update: NOW / 1000, bids: [{ p: '100', s: '0.15' }], asks: [{ p: '101', s: '0.25' }] }));
  };
  const clients = createPublicClients({ fetcher, clock: () => NOW });
  assert.deepEqual((await clients.loadDepth(q)).bids, [[100, 0.0015]]);
  const manual = await clients.resolveManualQuote(q.crossexSymbol);
  assert.deepEqual((await clients.loadManualDepth(manual)).asks, [[101, 0.0025]]);
});

test('manual native identities and depth remain available without independent Binance metadata', async () => {
  for (const [exchange, currency] of [['gate', 'USDT'], ['okx', 'USDT'], ['bybit', 'USDT'], ['deribit', 'USDC']]) {
    const q = quote(exchange, currency), f = fixture(q); let independentRequests = 0;
    const clients = createPublicClients({ clock: () => NOW, fetcher: (url, init) => {
      if (url.endsWith('/exchangeInfo')) { independentRequests++; throw new Error('Binance unavailable'); }
      return f.fetcher(url, init);
    } });
    const manual = await clients.resolveManualQuote(q.crossexSymbol);
    assert.equal(manual.identityScope, 'manual'); assert.equal(manual.assetClass, 'crypto');
    assert.equal(validManualIdentity(manual), true); assert.equal(validIdentity(manual), false);
    assert.ok((await clients.loadManualDepth(manual)).bids.length); assert.equal(independentRequests, 0);
    await assert.rejects(clients.loadDepth(manual), /不支持/); assert.equal(independentRequests, 0);
    await assert.rejects(clients.loadDepth(q), /Binance unavailable/); assert.equal(independentRequests, 1);
  }
});

test('manual noncrypto instruments require a documented native class and cannot authorize a crypto pair', async () => {
  for (const [category, assetClass] of [['1', 'crypto'], ['3', 'stock'], ['4', 'commodity'], ['5', 'forex'], ['6', 'bond']]) {
    const q = quote('okx', 'USDT', 'CL'), f = fixture(q); f.metadata.data[0].instCategory = category; f.metadata.data[0].ctVal = '0.1';
    const clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
    const manual = await clients.resolveManualQuote(q.crossexSymbol);
    assert.equal(manual.assetClass, assetClass); assert.equal(manual.nativeUnit, '0.1');
    assert.deepEqual((await clients.loadManualDepth(manual)).bids, [[100, 2], [99, 1]]);
    const other = { ...manual, exchange: 'gate', symbol: 'CL_USDT', crossexSymbol: 'GATE_FUTURE_CL_USDT' };
    assert.equal(validManualPair(manual, other), assetClass === 'crypto');
    assert.ok(f.requests.every(r => !r.url.endsWith('/exchangeInfo')));
  }
  for (const category of [undefined, '', '2', 'unknown']) {
    const q = quote('okx', 'USDT', 'CL'), f = fixture(q); f.metadata.data[0].instCategory = category;
    await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).resolveManualQuote(q.crossexSymbol), /未确认/);
    assert.equal(f.requests.length, 1);
  }
});

test('manual metadata resolution rechecks native units and classification before cache expiry', async () => {
  const q = quote('gate'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
  const first = await clients.resolveManualQuote(q.crossexSymbol);
  f.metadata.quanto_multiplier = '0.01';
  const changed = await clients.resolveManualQuote(q.crossexSymbol);
  assert.equal(changed.nativeUnit, '0.01'); assert.notEqual(contractIdentity(first), contractIdentity(changed));
  await assert.rejects(clients.loadManualDepth(first), /数量单位已变化/);
  f.metadata.contract_type = 'commodities';
  const commodity = await clients.resolveManualQuote(q.crossexSymbol);
  assert.equal(commodity.comparable, false); assert.notEqual(contractIdentity(changed), contractIdentity(commodity));
  f.metadata.status = 'circuit_breaker';
  await assert.rejects(clients.resolveManualQuote(q.crossexSymbol), /未确认/);
});

test('manual pairs preserve native crypto identity, currency and known ambiguous ticker boundaries', async () => {
  const gateFixture = fixture(quote('gate')), okxFixture = fixture(quote('okx'));
  const gate = await createPublicClients({ fetcher: gateFixture.fetcher }).resolveManualQuote('GATE_FUTURE_BTC_USDT');
  const okx = await createPublicClients({ fetcher: okxFixture.fetcher }).resolveManualQuote('OKX_FUTURE_BTC_USDT');
  assert.equal(validManualPair(gate, okx), true);
  for (const change of [{ rawBase: 'OTHER' }, { assetClass: 'commodity' }, { comparable: false }, { multiplier: 1000 }, { nativeUnit: undefined }, { settlementCurrency: 'USDC' }, { identitySource: 'browser' }, { identityVerified: false }]) {
    assert.equal(validManualPair(gate, { ...okx, ...change }), false);
  }
  const edgeFixture = fixture(quote('gate', 'USDT', 'EDGE'));
  const edge = await createPublicClients({ fetcher: edgeFixture.fetcher }).resolveManualQuote('GATE_FUTURE_EDGE_USDT');
  assert.equal(validManualIdentity(edge), true); assert.equal(edge.comparable, false);
  assert.equal(validManualPair(edge, { ...okx, base: 'EDGE', rawBase: 'EDGE', symbol: 'EDGE-USDT-SWAP', crossexSymbol: 'OKX_FUTURE_EDGE_USDT' }), false);
});
