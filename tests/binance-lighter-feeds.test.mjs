import assert from 'node:assert/strict';
import test from 'node:test';
import { CostFeedError, costRetryNotBefore, createCostFeedDecoder, discoverCostMarkets,
  parseCostMarkets, startCostFeeds } from '../server/research/binance-lighter-feeds.mjs';

const AT = 1793860982300;
const binanceBody = { symbols: ['BTC', 'ETH'].map(symbol => ({
  symbol: `${symbol}USDC`, baseAsset: symbol, quoteAsset: 'USDC', marginAsset: 'USDC', contractType: 'PERPETUAL', status: 'TRADING',
  quantityPrecision: 9, filters: [
    { filterType: 'PRICE_FILTER', tickSize: symbol === 'BTC' ? '0.1' : '0.01' },
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
    { filterType: 'MIN_NOTIONAL', notional: symbol === 'BTC' ? '50' : '20' },
  ],
})) };
const lighterBody = { code: 200, order_book_details: ['BTC', 'ETH'].map((symbol, i) => ({
  symbol, market_id: 1 - i, market_type: 'perp', status: 'active', multiplier: '1.000000000000000000', quote_multiplier: 1,
  supported_size_decimals: 5 - i, size_decimals: 5 - i, supported_price_decimals: 1 + i, price_decimals: 1 + i,
  min_base_amount: symbol === 'BTC' ? '0.00007' : '0.0020', min_quote_amount: '10.000000',
})) };
const markets = [...parseCostMarkets('binance', binanceBody, AT), ...parseCostMarkets('lighter', lighterBody, AT)];
const clocks = { receivedAt: AT, receivedMono: 100 };
const jsonResponse = (body, options) => new Response(JSON.stringify(body), options);
const bodyFor = url => url.includes('fapi.binance.com') ? binanceBody : lighterBody;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const tick = async (t, milliseconds) => { t.mock.timers.tick(milliseconds); await flush(); };

function lighterFrame({ type = 'update/order_book', nonce = 101, begin = 100, bids = [], asks = [], time = AT * 1000,
  channel = 'order_book:1' } = {}) {
  return { channel, type, timestamp: AT + 5, offset: 99999,
    order_book: { code: 0, bids, asks, nonce, begin_nonce: begin, last_updated_at: time, offset: 99999 } };
}
const snapshot = overrides => lighterFrame({ type: 'subscribed/order_book', nonce: 100, begin: 0,
  bids: [{ price: '80000.0', size: '2.00000' }], asks: [{ price: '80000.1', size: '3.00000' }], ...overrides });
const depth = overrides => ({ stream: 'btcusdc@depth20@100ms', data: { e: 'depthUpdate', s: 'BTCUSDC', st: 1,
  T: AT, E: AT + 2, U: 90, u: 100, pu: 89, b: [['80000.0', '2']], a: [['80000.1', '3']], ...overrides } });
const trade = overrides => ({ stream: 'btcusdc@aggTrade', data: { e: 'aggTrade', s: 'BTCUSDC', st: 1,
  T: AT, E: AT + 3, a: 100, p: '80000.0', q: '9.50', nq: '0.50', m: true, f: 90, l: 95, ...overrides } });

function fixture() {
  const books = [], trades = [], statuses = [], diagnostics = [], resyncs = [];
  const decoder = createCostFeedDecoder({ markets, now: () => AT, mono: () => 100,
    onBook: item => books.push(item), onTrade: item => trades.push(item), onStatus: item => statuses.push(item),
    onDiagnostic: item => diagnostics.push(item), resubscribe: item => resyncs.push(item) });
  return { decoder, books, trades, statuses, diagnostics, resyncs };
}

function fakeSockets({ autoOpen = true } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0; sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    message(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    fail() { this.onerror?.({}); }
    close() { this.closeCount++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  return { sockets, FakeSocket };
}

test('metadata selects only BTC, checks identity and uses real LOT_SIZE instead of precision', () => {
  const rows = parseCostMarkets('binance', { symbols: [...binanceBody.symbols, { symbol: 'UNRELATED', filters: null }] }, AT);
  assert.equal(rows[0].quantityStep, 0.001);
  assert.equal(rows[0].tickSize, 0.1);
  assert.equal(rows[0].minNotional, 50);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settlement, 'USDC');
  const lighter = parseCostMarkets('lighter', lighterBody, AT);
  assert.equal(lighter[0].marketId, 1);
  assert.equal(lighter.length, 1);
  assert.equal(lighter[0].quantityStep, 0.00001);
  assert.equal(lighter[0].priceUnit, 'USD');
  assert.equal(lighter[0].quote, 'USDC');
  assert.equal(lighter[0].multiplier, 1);
  for (const field of ['quoteAsset', 'marginAsset', 'baseAsset', 'contractType', 'status']) {
    const copy = structuredClone(binanceBody); copy.symbols[0][field] = 'wrong';
    assert.throws(() => parseCostMarkets('binance', copy), /market_identity_mismatch/);
  }
  for (const field of ['multiplier', 'quote_multiplier']) {
    const copy = structuredClone(lighterBody); copy.order_book_details[0][field] = 100;
    assert.throws(() => parseCostMarkets('lighter', copy), /market_identity_mismatch/);
  }
  const missingLot = structuredClone(binanceBody); missingLot.symbols[0].filters.splice(1, 1);
  assert.throws(() => parseCostMarkets('binance', missingLot), /market_rules_invalid/);
  const badMin = structuredClone(lighterBody); badMin.order_book_details[0].min_base_amount = '';
  assert.throws(() => parseCostMarkets('lighter', badMin), /market_rules_invalid/);
  const badDecimals = structuredClone(lighterBody); badDecimals.order_book_details[0].size_decimals = 6;
  assert.throws(() => parseCostMarkets('lighter', badDecimals), /market_rules_invalid/);
  assert.throws(() => parseCostMarkets('binance', { symbols: [binanceBody.symbols[0], ...binanceBody.symbols] }), /duplicate_market/);
  assert.throws(() => parseCostMarkets('lighter', { order_book_details: [] }), /missing_market/);
  assert.throws(() => parseCostMarkets('binance', {}), /metadata_schema_error/);
});

test('discovery uses only fixed unauthenticated GET endpoints and fails closed on selected market errors', async () => {
  const calls = [];
  const result = await discoverCostMarkets({ cooldowns: {}, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return jsonResponse(bodyFor(url));
  } });
  assert.equal(result.length, 2); assert.ok(result.every(row => row.symbol === 'BTC'));
  assert.deepEqual(calls.map(row => row.url).sort(), [
    'https://fapi.binance.com/fapi/v1/exchangeInfo', 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails',
  ]);
  assert.ok(calls.every(row => row.options.method === 'GET' && row.options.redirect === 'error'
    && row.options.credentials === 'omit' && row.options.headers === undefined));
  await assert.rejects(discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => jsonResponse(url.includes('binance') ? { symbols: [] } : lighterBody) }),
    error => error instanceof CostFeedError && error.code === 'missing_market' && error.venue === 'binance');
});

test('missing or malformed ETH metadata cannot block BTC discovery and explicit ETH input is rejected before networking', async () => {
  for (const body of [{ symbols: [binanceBody.symbols[0]] }, { symbols: [binanceBody.symbols[0], { symbol: 'ETHUSDC', filters: null }] }]) {
    assert.equal(parseCostMarkets('binance', body, AT)[0].symbol, 'BTC');
  }
  for (const body of [{ order_book_details: [lighterBody.order_book_details[0]] },
    { order_book_details: [lighterBody.order_book_details[0], { symbol: 'ETH', market_id: 1 }] }]) {
    assert.equal(parseCostMarkets('lighter', body, AT)[0].marketId, 1);
  }
  await assert.rejects(discoverCostMarkets({ symbols: ['ETH'], fetchImpl: () => assert.fail('ETH must not issue a metadata request') }), /markets_invalid/);
  assert.throws(() => startCostFeeds({ markets: [{ ...markets[0], symbol: 'ETH', nativeSymbol: 'ETHUSDC' }] }), /markets_invalid/);
});

test('HTTP retries only transport/5xx, with bounded attempts and body failures classified', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT });
  const counts = { binance: 0, lighter: 0 };
  const work = discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => {
    const venue = url.includes('binance') ? 'binance' : 'lighter'; counts[venue]++;
    if (counts[venue] < 3) {
      if (venue === 'binance') return jsonResponse({ msg: 'temporary' }, { status: 503 });
      throw new TypeError('network failure');
    }
    return jsonResponse(bodyFor(url));
  } });
  await flush(); await tick(t, 250); await tick(t, 500);
  assert.equal((await work).length, 2);
  assert.deepEqual(counts, { binance: 3, lighter: 3 });
  let refused = 0;
  await assert.rejects(discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => {
    if (url.includes('binance')) { refused++; return new Response('not JSON', { status: 403 }); }
    return jsonResponse(lighterBody);
  } }), error => error.code === 'http_error' && error.httpStatus === 403);
  assert.equal(refused, 1);
  await assert.rejects(discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => url.includes('binance')
    ? new Response('not JSON') : jsonResponse(lighterBody) }), /metadata_invalid_json/);
});

test('parallel HTTP failures retain shared cooldown and do not retry 429 or leak its body', async () => {
  const cooldowns = {}, diagnostics = [];
  let calls = 0;
  await assert.rejects(discoverCostMarkets({ cooldowns, onDiagnostic: row => diagnostics.push(row), fetchImpl: async url => {
    calls++;
    return url.includes('binance') ? jsonResponse({ symbols: [] })
      : jsonResponse({ code: 999, message: 'untrusted-body-marker' }, { status: 429, headers: { 'Retry-After': '120' } });
  } }), error => error.code === 'rate_limited' && error.venue === 'lighter' && error.retryNotBefore > Date.now() + 110_000);
  assert.ok(cooldowns.lighter > Date.now());
  assert.ok(diagnostics.some(row => row.retryNotBefore === cooldowns.lighter));
  assert.ok(!JSON.stringify(diagnostics).includes('untrusted-body-marker'));
  const before = calls;
  await assert.rejects(discoverCostMarkets({ cooldowns, fetchImpl: async () => { calls++; return jsonResponse(binanceBody); } }), /venue_cooldown/);
  assert.equal(calls, before + 1, 'the other venue remains independent');
  assert.equal(costRetryNotBefore({ status: 418, body: { code: -1003, msg: `IP banned until ${AT + 60_000}` }, now: AT }), AT + 60_000);
});

test('HTTP body size limit covers streamed bytes, not just headers', async () => {
  await assert.rejects(discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => {
    if (!url.includes('binance')) return jsonResponse(lighterBody);
    return new Response(new Uint8Array(8_000_001));
  } }), /metadata_body_limit/);
});

test('HTTP eight-second deadline includes stalled body and respects abort during retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT });
  const controller = new AbortController();
  let cancelled = 0, attempts = 0;
  const work = discoverCostMarkets({ signal: controller.signal, cooldowns: {}, fetchImpl: async url => {
    if (!url.includes('binance')) return jsonResponse(lighterBody);
    attempts++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  } });
  const rejection = assert.rejects(work, error => error.name === 'AbortError');
  await flush(); await tick(t, 8_000);
  assert.equal(cancelled, 1);
  controller.abort(); await rejection;
  await tick(t, 10_000);
  assert.equal(attempts, 1);
});

test('persistent stalled bodies exhaust exactly three total-deadline attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: AT });
  let attempts = 0, cancelled = 0;
  const work = discoverCostMarkets({ cooldowns: {}, fetchImpl: async url => {
    if (!url.includes('binance')) return jsonResponse(lighterBody);
    attempts++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  } });
  const rejection = assert.rejects(work, error => error.code === 'http_timeout');
  await flush();
  await tick(t, 8000); await tick(t, 250);
  await tick(t, 8000); await tick(t, 500);
  await tick(t, 8000); await rejection;
  assert.equal(attempts, 3); assert.equal(cancelled, 3);
});

test('Lighter uses snapshot plus nonce-linked absolute updates, microsecond timestamps, and full retained depth', () => {
  const { decoder, books, resyncs, statuses } = fixture();
  decoder.handle('lighter', 'book', lighterFrame(), clocks);
  assert.equal(books.length, 0, 'incrementals cannot initialize a book');
  const bids = Array.from({ length: 60 }, (_, i) => ({ price: String(80000 - i), size: '1' }));
  decoder.handle('lighter', 'book', snapshot({ bids, time: AT * 1000 + 123 }), clocks);
  assert.equal(books[0].bids.length, 50);
  assert.equal(books[0].sourceAt, AT + 0.123);
  assert.equal(books[0].receivedAt, AT);
  assert.equal(books[0].sequence, '100');
  const update = lighterFrame({ bids: [{ price: '80000', size: '0' }], time: AT * 1000 + 500 });
  decoder.handle('lighter', 'book', update, { ...clocks, receivedMono: 200 });
  assert.equal(books[1].bids[0][0], 79999);
  assert.equal(books[1].bids.at(-1)[0], 79950, 'the 51st retained level becomes visible');
  decoder.handle('lighter', 'book', update, { ...clocks, receivedMono: 900 });
  assert.equal(books.length, 2);
  assert.equal(decoder.lastReceived('lighter', 'book', 'BTC'), 200, 'duplicate cannot refresh freshness');
  decoder.handle('lighter', 'book', lighterFrame({ nonce: 105, begin: 103 }), clocks);
  assert.equal(resyncs.length, 1);
  assert.equal(decoder.lastReceived('lighter', 'book', 'BTC'), undefined);
  assert.equal(statuses.at(-1).reason, 'sequence_gap');
  decoder.handle('lighter', 'book', lighterFrame({ nonce: 106, begin: 105 }), clocks);
  assert.equal(books.length, 2);
  decoder.handle('lighter', 'book', snapshot({ nonce: 110 }), clocks);
  assert.equal(books.length, 3);
});

test('invalid Lighter clocks, levels and unsafe sequences revoke the book and request bounded resync', () => {
  for (const malformed of [
    { nonce: Number.MAX_SAFE_INTEGER + 1 },
    { time: 0 },
    { bids: [{ price: '1', size: '-1' }] },
    { asks: [{ price: '79999', size: '1' }] },
    { bids: [{ price: '80000', size: '1' }, { price: '80000', size: '2' }] },
  ]) {
    const f = fixture(); f.decoder.handle('lighter', 'book', snapshot(), clocks);
    f.decoder.handle('lighter', 'book', lighterFrame(malformed), clocks);
    assert.equal(f.books.length, 1);
    assert.equal(f.decoder.lastReceived('lighter', 'book', 'BTC'), undefined);
    assert.equal(f.resyncs.length, 1);
    assert.equal(f.statuses.at(-1).state, 'fault');
  }
  const f = fixture(); f.decoder.handle('lighter', 'book', snapshot(), clocks);
  f.decoder.handle('lighter', 'book', '{broken', clocks);
  assert.equal(f.statuses.at(-1).reason, 'invalid_json');
  assert.equal(f.decoder.states.size, 0);
  const replacement = fixture(); replacement.decoder.handle('lighter', 'book', snapshot(), clocks);
  replacement.decoder.handle('lighter', 'book', snapshot({ nonce: 101, time: (AT - 1) * 1000 }), clocks);
  assert.equal(replacement.books.length, 1);
  assert.equal(replacement.statuses.at(-1).reason, 'source_timestamp_regression');
});

test('Binance depth snapshots replace old levels; gaps revoke old evidence before publishing the new book', () => {
  const f = fixture(); f.decoder.handle('binance', 'book', depth(), clocks);
  f.decoder.handle('binance', 'book', depth({ u: 102, pu: 100, b: [['79999', '1']] }), clocks);
  assert.deepEqual(f.books[1].bids, [[79999, 1]]);
  f.decoder.handle('binance', 'book', depth({ u: 104, pu: 103 }), clocks);
  assert.ok(f.statuses.some(row => row.reason === 'sequence_gap'));
  assert.equal(f.books.at(-1).sequence, '104');
  f.decoder.handle('binance', 'book', depth({ u: 104 }), { ...clocks, receivedMono: 900 });
  assert.equal(f.books.length, 3);
  assert.equal(f.decoder.lastReceived('binance', 'book', 'BTC'), 100);
  f.decoder.handle('binance', 'book', depth({ u: 105, pu: 104, T: AT - 100 }), clocks);
  assert.equal(f.books.length, 3);
  assert.equal(f.statuses.at(-1).reason, 'source_timestamp_regression');
});

test('Binance maker direction and queue volume use m and nq, never q; zero nq is live without simulated fill', () => {
  const f = fixture(); f.decoder.handle('binance', 'trades', trade(), clocks);
  assert.equal(f.trades[0].quantity, 0.5);
  assert.equal(f.trades[0].buyerMaker, true);
  assert.equal(f.trades[0].sourceAt, AT);
  f.decoder.handle('binance', 'trades', trade({ a: 101, nq: '0', m: false }), clocks);
  assert.equal(f.trades.length, 2);
  assert.equal(f.trades[1].quantity, 0, 'zero normal quantity retains source/receive clocks for consumer health validation');
  assert.equal(f.decoder.states.get('binance:trades:BTC').sequence, '101');
  f.decoder.handle('binance', 'trades', trade({ a: 102, m: false }), clocks);
  assert.equal(f.trades[2].buyerMaker, false);
  f.decoder.handle('binance', 'trades', trade({ a: 105 }), clocks);
  assert.ok(f.statuses.some(row => row.reason === 'sequence_gap'));
  const count = f.trades.length;
  f.decoder.handle('binance', 'trades', trade({ a: 106, nq: undefined }), clocks);
  assert.equal(f.trades.length, count);
  assert.equal(f.statuses.at(-1).reason, 'normal_quantity_missing');
  assert.equal(f.decoder.lastReceived('binance', 'trades', 'BTC'), undefined);
});

test('all wire and retained sequences are bounded before BigInt, while safe integers and 40-digit strings remain valid', t => {
  const originalBigInt = globalThis.BigInt;
  let oversizedConversions = 0;
  t.mock.method(globalThis, 'BigInt', value => {
    if (typeof value === 'string' && value.length > 40) { oversizedConversions++; throw new Error('oversized conversion reached'); }
    return originalBigInt(value);
  });
  const oversized = '9'.repeat(41);
  const cases = [
    ['lighter', 'book', snapshot(), lighterFrame({ nonce: oversized })],
    ['lighter', 'book', snapshot(), lighterFrame({ begin: oversized })],
    ['binance', 'book', depth(), depth({ u: oversized, pu: 100 })],
    ['binance', 'book', depth(), depth({ u: 101, pu: oversized })],
    ['binance', 'trades', trade(), trade({ a: oversized })],
  ];
  for (const [venue, channel, initial, invalid] of cases) {
    const f = fixture(); f.decoder.handle(venue, channel, initial, clocks);
    f.decoder.handle(venue, channel, invalid, clocks);
    assert.equal(f.books.length + f.trades.length, 1, `${venue}:${channel}`);
    assert.equal(f.decoder.lastReceived(venue, channel, 'BTC'), undefined);
    assert.equal(f.statuses.at(-1).state, 'fault');
  }
  for (const [venue, channel, initial, next] of [
    ['lighter', 'book', snapshot(), lighterFrame()],
    ['binance', 'book', depth(), depth({ u: 101, pu: 100 })],
    ['binance', 'trades', trade(), trade({ a: 101 })],
  ]) {
    const f = fixture(); f.decoder.handle(venue, channel, initial, clocks);
    f.decoder.states.get(`${venue}:${channel}:BTC`).sequence = oversized;
    f.decoder.handle(venue, channel, next, clocks);
    assert.equal(f.books.length + f.trades.length, 1, 'retained values are validated before comparison');
    assert.equal(f.statuses.at(-1).state, 'fault');
  }
  for (const invalid of ['', '0'.repeat(41), '1e3', '-1', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.decoder.handle('binance', 'trades', trade({ a: invalid }), clocks);
    assert.equal(f.trades.length, 0);
  }
  for (const valid of [0, Number.MAX_SAFE_INTEGER, '9'.repeat(40), '0'.repeat(39) + '1']) {
    const f = fixture(); f.decoder.handle('binance', 'trades', trade({ a: valid }), clocks);
    assert.equal(f.trades.length, 1);
    assert.equal(f.trades[0].sequence, originalBigInt(valid).toString());
  }
  assert.equal(oversizedConversions, 0);
});

test('a seven-megabyte decimal nonce below the wire-size limit never reaches BigInt and valid recovery still publishes', async t => {
  const originalBigInt = globalThis.BigInt;
  let oversizedConversions = 0;
  t.mock.method(globalThis, 'BigInt', value => {
    if (typeof value === 'string' && value.length > 40) { oversizedConversions++; throw new Error('oversized conversion reached'); }
    return originalBigInt(value);
  });
  const { sockets, FakeSocket } = fakeSockets();
  const books = [], statuses = [];
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter' && m.symbol === 'BTC'), cooldowns: {},
    WebSocketImpl: FakeSocket, onBook: row => books.push(row), onStatus: row => statuses.push(row) });
  await flush();
  const frame = JSON.stringify(snapshot({ nonce: '9'.repeat(7_000_000) }));
  assert.ok(Buffer.byteLength(frame) < 8_000_000);
  sockets[0].message(frame);
  assert.equal(oversizedConversions, 0);
  assert.equal(books.length, 0);
  assert.equal(statuses.at(-1).reason, 'invalid_nonce');
  sockets[0].message(snapshot());
  assert.equal(books.length, 1);
  await feeds.stop();
});

test('three fixed sockets route books/trades independently and stop synchronously clears handlers and timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets();
  const books = [], trades = [], statuses = [];
  const feeds = startCostFeeds({ markets, cooldowns: {}, WebSocketImpl: FakeSocket, now: Date.now, mono: Date.now,
    onBook: row => books.push(row), onTrade: row => trades.push(row), onStatus: row => statuses.push(row) });
  await flush();
  assert.equal(sockets.length, 3);
  assert.match(sockets[0].url, /^wss:\/\/fstream\.binance\.com\/public\/stream\?streams=btcusdc@depth20@100ms$/);
  assert.match(sockets[1].url, /^wss:\/\/fstream\.binance\.com\/market\/stream\?streams=btcusdc@aggTrade$/);
  assert.deepEqual(sockets[2].sent, [{ type: 'subscribe', channel: 'order_book/1' }]);
  sockets[0].message(depth()); sockets[1].message(trade()); sockets[2].message(snapshot());
  assert.equal(books.length, 2); assert.equal(trades.length, 1);
  const lateHandler = sockets[0].onmessage;
  await feeds.stop(); await feeds.stop();
  assert.ok(sockets.every(ws => ws.closeCount === 1 && ws.onmessage === null && ws.onopen === null));
  lateHandler({ data: JSON.stringify(depth({ u: 200 })) });
  await tick(t, 60_000);
  assert.equal(sockets.length, 3); assert.equal(books.length, 2);
  assert.ok(statuses.some(row => row.state === 'disconnected' && row.reason === 'stopped'));
});

test('open-only and heartbeat-only sockets do not become live or reset the five-attempt failure budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets();
  const statuses = [];
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter'), cooldowns: {}, WebSocketImpl: FakeSocket,
    now: Date.now, mono: Date.now, onStatus: row => statuses.push(row), onBook: () => assert.fail('control frames are not books') });
  const exhausted = assert.rejects(feeds.done, error => error.code === 'reconnect_exhausted');
  await flush();
  for (let second = 0; second < 70; second++) {
    sockets.at(-1).message({ type: 'ping' });
    await tick(t, 1000);
  }
  await exhausted;
  assert.equal(sockets.length, 5);
  assert.ok(!statuses.some(row => row.state === 'live'));
  assert.ok(statuses.some(row => row.state === 'stale'));
  assert.equal(statuses.at(-1).reason, 'reconnect_exhausted');
  await assert.rejects(feeds.stop(), /reconnect_exhausted/);
});

test('connection deadlines and exponential retry stop after five attempts; cooldown blocks new sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets({ autoOpen: false });
  const cooldowns = { lighter: AT + 5000 };
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter'), cooldowns, WebSocketImpl: FakeSocket,
    now: Date.now, mono: Date.now });
  const exhausted = assert.rejects(feeds.done, error => error.code === 'reconnect_exhausted');
  await flush(); assert.equal(sockets.length, 0);
  await tick(t, 4999); assert.equal(sockets.length, 0);
  await tick(t, 1); assert.equal(sockets.length, 1);
  for (let second = 0; second < 60; second++) await tick(t, 1000);
  await exhausted;
  assert.equal(sockets.length, 5);
  assert.ok(sockets.every(ws => ws.closeCount === 1));
});

test('Lighter sequence resubscriptions are bounded within a connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets();
  const statuses = [];
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter' && m.symbol === 'BTC'), cooldowns: {},
    WebSocketImpl: FakeSocket, now: Date.now, mono: Date.now, onStatus: row => statuses.push(row) });
  await flush();
  for (let attempt = 0; attempt < 4; attempt++) {
    sockets[0].message(snapshot({ nonce: 100 + attempt * 10 }));
    sockets[0].message(lighterFrame({ nonce: 105 + attempt * 10, begin: 103 + attempt * 10 }));
  }
  assert.equal(sockets[0].sent.filter(row => row.type === 'unsubscribe').length, 3);
  assert.equal(sockets[0].closeCount, 1);
  assert.ok(statuses.some(row => row.reason === 'resync_exhausted'));
  await feeds.stop();
});

test('valid data for every selected market resets the consecutive-failure budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets();
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter' && m.symbol === 'BTC'), cooldowns: {},
    WebSocketImpl: FakeSocket, now: Date.now, mono: Date.now });
  const exhausted = assert.rejects(feeds.done, error => error.code === 'reconnect_exhausted');
  await flush();
  for (const delay of [1000, 2000, 4000]) { sockets.at(-1).fail(); await flush(); await tick(t, delay); }
  assert.equal(sockets.length, 4);
  sockets.at(-1).message(snapshot());
  for (const delay of [1000, 2000, 4000, 8000]) { sockets.at(-1).fail(); await flush(); await tick(t, delay); }
  sockets.at(-1).fail(); await exhausted;
  assert.equal(sockets.length, 8);
});

test('Binance trade exhaustion rejects the whole feed set even while both venues keep healthy books', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: AT });
  const { sockets, FakeSocket } = fakeSockets();
  const statuses = [], books = [];
  const feeds = startCostFeeds({ markets, cooldowns: {}, WebSocketImpl: FakeSocket, now: Date.now, mono: Date.now,
    onStatus: row => statuses.push(row), onBook: row => books.push(row) });
  const exhausted = assert.rejects(feeds.done, error => error instanceof CostFeedError && error.code === 'reconnect_exhausted'
    && error.venue === 'binance' && error.channel === 'trades' && error.attempts === 5);
  await flush();
  const binanceBook = sockets.find(ws => ws.url.includes('/public/'));
  const lighterBook = sockets.find(ws => ws.url.includes('zklighter'));
  let nonce = 100, tradeFailures = 0;
  for (let second = 0; second <= 20; second++) {
    for (const symbol of ['BTC']) {
      binanceBook.message(depth({ s: `${symbol}USDC`, u: nonce, pu: nonce - 1, T: Date.now() }));
      const frame = second === 0 ? snapshot({ nonce, channel: `order_book:${symbol === 'BTC' ? 1 : 0}`, time: Date.now() * 1000 })
        : lighterFrame({ nonce, begin: nonce - 1, channel: `order_book:${symbol === 'BTC' ? 1 : 0}`, time: Date.now() * 1000 });
      lighterBook.message(frame);
    }
    const tradeSocket = sockets.findLast(ws => ws.url.includes('/market/') && ws.readyState === 1);
    if (tradeSocket) { tradeSocket.fail(); tradeFailures++; await flush(); }
    if (tradeFailures === 5) break;
    nonce++; await tick(t, 1000);
  }
  await exhausted;
  assert.equal(tradeFailures, 5);
  assert.equal(sockets.length, 7, 'healthy books were never reconnected');
  assert.ok(books.length > 4, 'healthy book frames continued during trade retries');
  assert.ok(sockets.every(ws => ws.closeCount === 1 && ws.onmessage === null));
  const faultIndex = statuses.findIndex(row => row.channel === 'trades' && row.reason === 'reconnect_exhausted');
  assert.ok(faultIndex >= 0);
  assert.ok(statuses.findIndex(row => row.channel === 'book' && row.state === 'disconnected') > faultIndex,
    'the required-channel fault is visible before cleaning up healthy channels');
  assert.equal(statuses.findLast(row => row.venue === 'binance' && row.channel === 'trades' && row.symbol === 'BTC').state, 'fault');
  await tick(t, 60_000); assert.equal(sockets.length, 7);
  await assert.rejects(feeds.stop(), /reconnect_exhausted/);
});

test('stop during venue cooldown clears connecting status without opening a socket', async () => {
  const { sockets, FakeSocket } = fakeSockets();
  const statuses = [];
  const feeds = startCostFeeds({ markets: markets.filter(m => m.venue === 'lighter'), WebSocketImpl: FakeSocket,
    cooldowns: { lighter: Date.now() + 60_000 }, onStatus: row => statuses.push(row) });
  await feeds.stop();
  assert.equal(sockets.length, 0);
  assert.deepEqual(statuses.filter(row => row.state === 'disconnected').map(row => [row.symbol, row.state, row.reason]),
    [['BTC', 'disconnected', 'stopped']]);
});

test('consumer callback failures terminate all feed tasks instead of becoming market-data retries', async () => {
  const { sockets, FakeSocket } = fakeSockets();
  const feeds = startCostFeeds({ markets, cooldowns: {}, WebSocketImpl: FakeSocket, onBook: () => { throw new Error('consumer broken'); } });
  const rejected = assert.rejects(feeds.done, /feed_callback_failed/);
  await flush(); sockets[0].message(depth()); await rejected;
  assert.ok(sockets.every(ws => ws.closeCount === 1));
  await assert.rejects(feeds.stop(), /feed_callback_failed/);
});

test('pre-aborted feeds and metadata create no network calls; unverified symbols cannot change endpoints', async () => {
  const controller = new AbortController(); controller.abort();
  const { sockets, FakeSocket } = fakeSockets();
  const feeds = startCostFeeds({ markets, signal: controller.signal, WebSocketImpl: FakeSocket });
  await feeds.done; await feeds.stop(); assert.equal(sockets.length, 0);
  await assert.rejects(discoverCostMarkets({ signal: controller.signal, fetchImpl: () => assert.fail('must not fetch') }), { name: 'AbortError' });
  assert.throws(() => startCostFeeds({ markets: [{ ...markets[0], nativeSymbol: 'BTCUSDC/../../other' }] }), /markets_invalid/);
});
