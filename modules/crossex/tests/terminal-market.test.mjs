import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCandleReader, createTerminalMarket, normalizeCandles, INTERVALS } from '../server/terminal-market.mjs';
import { AppError } from '../server/model.mjs';

const NOW = Date.UTC(2026, 9, 8, 8), SYMBOL = 'BINANCE_FUTURE_BTC_USDT';
const bar = (time = NOW, changes = {}) => ({ time, open: '100', high: '103', low: '99', close: '102', volume: '0.125', ...changes });
const json = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function quote(exchange, base = 'BTC') {
  const currency = ['deribit', 'lighter'].includes(exchange) ? 'USDC' : exchange === 'kraken' ? 'USD' : 'USDT';
  return { exchange, base, quoteCurrency: currency, symbol: { binance: `${base}USDT`, bybit: `${base}USDT`, okx: `${base}-USDT-SWAP`, gate: `${base}_USDT`, kraken: `PF_${base === 'BTC' ? 'XBT' : base}USD`, hyperliquid: base, lighter: base, deribit: `${base}_USDC-PERPETUAL` }[exchange], ...(exchange === 'lighter' ? { marketId: 7 } : {}) };
}
const book = (q, at = NOW) => ({ exchange: q.exchange, symbol: q.symbol, base: q.base, quoteCurrency: q.quoteCurrency, at, bids: [[100, 2], [99, 3]], asks: [[101, 4], [102, 5]] });
function rawCandles(exchange, q, at = NOW) {
  const array = [String(at), '100', '103', '99', '102', '0.125', '12.5'];
  return {
    binance: [[at, ...array.slice(1)]], bybit: { retCode: 0, result: { category: 'linear', symbol: q.symbol, list: [array] } },
    okx: { code: '0', data: [[String(at), '100', '103', '99', '102', '125', '0.125', '12.5', '1']] },
    gate: [{ t: at / 1000, o: '100', h: '103', l: '99', c: '102', v: 1250 }],
    kraken: { candles: [{ time: at, open: 100, high: 103, low: 99, close: 102, volume: 0.125 }] },
    hyperliquid: [{ t: at, s: q.symbol, i: '1m', o: '100', h: '103', l: '99', c: '102', v: '0.125' }],
    lighter: { code: 200, c: [{ t: at, o: 100, h: 103, l: 99, c: 102, v: 0.125 }] },
    deribit: { jsonrpc: '2.0', result: { status: 'ok', ticks: [at], open: [100], high: [103], low: [99], close: [102], volume: [0.125] } },
  }[exchange];
}
function terminalFixture(options = {}) {
  let now = NOW;
  const calls = { resolve: [], depth: [], candles: [] };
  class Socket extends EventEmitter {
    static instances = [];
    constructor(url, socketOptions) { super(); this.url = url; this.options = socketOptions; this.readyState = 1; this.sent = []; this.closed = 0; this.pings = 0; this.constructor.instances.push(this); queueMicrotask(() => this.emit('open')); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { if (this.readyState === 3) return; this.closed++; this.readyState = 3; this.emit('close'); }
    terminate() { this.terminated = true; this.close(); }
    ping() { this.pings++; }
  }
  const service = createTerminalMarket({
    market: { resolveDisplaySymbol: async symbol => { if (options.display) return options.display(symbol); return { quote: quote(symbol.split('_')[0].toLowerCase(), symbol.split('_')[2]), rule: {} }; }, resolveSymbol: async symbol => { calls.resolve.push(symbol); if (options.resolve) return options.resolve(symbol); const q = quote(symbol.split('_')[0].toLowerCase(), symbol.split('_')[2]); return { quote: { ...q, nativeUnit: '0.01' }, rule: { contract_size: null } }; } },
    depthReader: async q => { calls.depth.push(q); return options.depth ? options.depth(q, now) : book(q, now); },
    candleReader: async (q, interval) => { calls.candles.push({ q, interval }); return options.candles ? options.candles(q, interval, now) : [bar(Math.floor(now / INTERVALS[interval]) * INTERVALS[interval])]; },
    WebSocketImpl: Socket, clock: () => now,
  });
  return { service, calls, Socket, advance(ms) { now += ms; }, setNow(value) { now = value; }, now: () => now };
}
const frame = (socket, channel, result, event = 'update') => socket.emit('message', Buffer.from(JSON.stringify({ channel, event, result })));

test('all eight candle adapters preserve native timestamps and base volumes without private requests', async () => {
  for (const exchange of ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter', 'deribit']) {
    const q = quote(exchange), calls = [];
    const reader = createCandleReader({ clock: () => NOW, fetcher: async (url, init) => {
      calls.push({ url, init }); const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
      assert.ok(!/private|accounts|orders|positions|transfers/.test(parsed.pathname));
      for (const key of Object.keys(init.headers || {})) assert.ok(!/authorization|^key$|sign|secret/i.test(key));
      if (exchange === 'hyperliquid') {
        assert.equal(url, 'https://api.hyperliquid.xyz/info'); assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: NOW - 240 * 60000, endTime: NOW } });
      } else { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); }
      return json(parsed.pathname.includes('/contracts/') ? { name: q.symbol, quanto_multiplier: '0.0001' } : rawCandles(exchange, q));
    } });
    assert.deepEqual(await reader(q, '1m'), [bar()], exchange);
    assert.equal(calls.length, exchange === 'gate' ? 2 : 1, exchange);
    if (exchange === 'lighter') assert.equal(new URL(calls[0].url).searchParams.get('market_id'), '7');
    if (exchange === 'kraken') assert.ok(calls[0].url.includes('/PF_XBTUSD/1m?'));
    if (exchange === 'deribit') assert.equal(new URL(calls[0].url).searchParams.get('instrument_name'), 'BTC_USDC-PERPETUAL');
  }
});

test('native interval aliases and explicit no-data responses remain accurate', async () => {
  for (const [exchange, interval, name, expected] of [['bybit', '1d', 'interval', 'D'], ['okx', '1h', 'bar', '1H'], ['okx', '1d', 'bar', '1Dutc'], ['deribit', '4h', 'resolution', '60'], ['deribit', '1d', 'resolution', '1D']]) {
    const q = quote(exchange), at = Math.floor(NOW / INTERVALS[interval]) * INTERVALS[interval];
    const reader = createCandleReader({ clock: () => NOW, fetcher: async url => {
      assert.equal(new URL(url).searchParams.get(name), expected);
      return json(exchange === 'deribit' ? { result: { status: 'no_data' } } : rawCandles(exchange, q, at));
    } });
    assert.equal((await reader(q, interval)).length, exchange === 'deribit' ? 0 : 1);
  }
});

test('Deribit four-hour candles combine only complete or current contiguous source hours', async () => {
  const anchor = NOW - 2 * INTERVALS['4h'], hours = [0, 1, 2, 3, 4, 6, 8].map(i => bar(anchor + i * INTERVALS['1h'], { open: String(100 + i), high: String(104 + i), low: String(99 + i), close: String(102 + i), volume: '0.1' }));
  const result = { status: 'ok', ticks: hours.map(c => c.time), ...Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, hours.map(c => c[key])])) };
  const reader = createCandleReader({ clock: () => NOW, fetcher: async () => json({ result }) });
  const values = await reader(quote('deribit'), '4h');
  assert.deepEqual(values.map(c => c.time), [anchor, NOW]);
  assert.deepEqual(values[0], { time: anchor, open: '100', high: '107', low: '99', close: '105', volume: '0.4' });
  assert.equal(values[1].volume, '0.1');
});

test('candle validation rejects duplicates, future bars, invalid times, prices and missing volume', () => {
  for (const changes of [{ time: NOW + 60000 }, { time: NOW / 1000 }, { time: NOW + 1 }, { time: [NOW] }, { open: '0' }, { high: '101' }, { low: '103' }, { close: 'NaN' }, { volume: '-1' }, { volume: undefined }, { volume: {} }]) {
    assert.throws(() => normalizeCandles([bar(NOW, changes)], '1m', NOW), undefined, JSON.stringify(changes));
  }
  assert.throws(() => normalizeCandles([bar(), bar()], '1m', NOW));
  assert.throws(() => normalizeCandles({ data: [] }, '1m', NOW));
  assert.throws(() => normalizeCandles([bar()], 'bad', NOW));
});

test('candle normalization sorts real bars, preserves gaps and bounds history without seeding', () => {
  assert.deepEqual(normalizeCandles([], '1m', NOW), []);
  assert.deepEqual(normalizeCandles([bar(NOW), bar(NOW - 3 * 60000)], '1m', NOW).map(c => c.time), [NOW - 3 * 60000, NOW]);
  const many = Array.from({ length: 300 }, (_, i) => bar(NOW - (299 - i) * 60000));
  const normalized = normalizeCandles(many, '1m', NOW);
  assert.equal(normalized.length, 240); assert.equal(normalized[0].time, NOW - 239 * 60000);
});

test('native error envelopes and invalid multiplier cannot masquerade as usable candles', async () => {
  for (const [exchange, payload] of [['bybit', { retCode: 10001, result: { list: [] } }], ['okx', { code: '51000', data: [] }], ['deribit', { error: { code: 10000 }, result: { status: 'ok', ticks: [] } }], ['deribit', { result: { status: 'ok', ticks: [NOW], open: [] } }]]) {
    await assert.rejects(createCandleReader({ clock: () => NOW, fetcher: async () => json(payload) })(quote(exchange), '1m'));
  }
  for (const multiplier of ['0', '-1', undefined]) await assert.rejects(createCandleReader({ clock: () => NOW, fetcher: async url => json(url.includes('/contracts/') ? { name: 'BTC_USDT', quanto_multiplier: multiplier } : rawCandles('gate', quote('gate'))) })(quote('gate'), '1m'));
});

test('unavailable symbols return no sample book, ticker, trades or candles', async t => {
  const f = terminalFixture({ display: async () => { throw new AppError('合约不可用'); } }); t.after(() => f.service.stop());
  await assert.rejects(f.service.read(SYMBOL), /合约不可用/);
  assert.equal(f.calls.depth.length, 0); assert.equal(f.calls.candles.length, 0); assert.equal(f.Socket.instances.length, 0);
});

test('public ticker and trade frames validate identity, time and prices, with trade ID deduplication', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0];
  const ticker = { s: SYMBOL, lp: '102', bp: '100', ap: '101', o: '100', ts: NOW };
  frame(socket, 'ticker', ticker); let value = await f.service.read(SYMBOL);
  assert.equal(value.ticker.lastPrice, '102'); assert.equal(value.ticker.change24h, '0.02'); assert.equal(value.ticker.volume24h, null);
  for (const change of [{ s: 'OKX_FUTURE_BTC_USDT' }, { ts: NOW - 1 }, { ts: NOW + 1001 }, { ts: [NOW] }, { bp: '102' }, { lp: '0' }, { ap: null }]) frame(socket, 'ticker', { ...ticker, lp: '999', ...change });
  frame(socket, 'ticker', { ...ticker, lp: '999' }, 'subscribe'); socket.emit('message', Buffer.from('bad-json'));
  const trade = { s: SYMBOL, i: 'trade-1', p: '100.5', q: '0.123456789012345678901', S: 'BUY', ts: NOW };
  frame(socket, 'trade', trade); frame(socket, 'trade', { ...trade, p: '900' });
  for (const change of [{ i: '' }, { i: 'x'.repeat(200) }, { i: 'array-time', ts: [NOW] }, { i: 'old', ts: NOW - 300000 }, { i: 'future', ts: NOW + 1001 }, { i: 'side', S: 'buy' }, { i: 'zero', q: '0' }, { i: 'bad-price', p: 'NaN' }]) frame(socket, 'trade', { ...trade, ...change });
  value = await f.service.read(SYMBOL);
  assert.equal(value.ticker.lastPrice, '102');
  assert.deepEqual(value.trades, [{ id: 'trade-1', price: '100.5', quantity: '0.123456789012345678901', side: 'BUY', at: NOW, quantityUnit: 'base' }]);
});

test('Gate and OKX WS trades convert only with confirmed native units, otherwise retain labeled contracts', async t => {
  for (const exchange of ['gate', 'okx']) for (const size of ['0.0001', undefined]) {
    const q = quote(exchange), symbol = `${exchange.toUpperCase()}_FUTURE_BTC_USDT`;
    const f = terminalFixture({ resolve: async () => ({ quote: { ...q, nativeUnit: size }, rule: { contract_size: null } }) }); t.after(() => f.service.stop());
    await f.service.read(symbol); frame(f.Socket.instances[0], 'trade', { s: symbol, i: 'native-1', p: '100', q: '1250', S: 'SELL', ts: NOW });
    const value = await f.service.read(symbol);
    assert.equal(value.trades.length, 1); assert.equal(value.trades[0].quantity, size ? '0.125' : '1250'); assert.equal(value.trades[0].quantityUnit, size ? 'base' : 'contracts');
  }
});

test('snapshot regressions and failed refreshes preserve the last book with an honest stale status', async t => {
  let at = NOW, fails = false;
  const f = terminalFixture({ depth: q => { if (fails) throw new AppError('上游不可用'); return book(q, at); } }); t.after(() => f.service.stop());
  assert.equal((await f.service.read(SYMBOL)).status, 'live'); f.advance(2000); at = NOW - 1;
  let value = await f.service.read(SYMBOL); assert.equal(value.status, 'stale'); assert.equal(value.asOf, NOW); assert.match(value.error, /回退/);
  f.advance(2000); at = f.now(); value = await f.service.read(SYMBOL); assert.equal(value.status, 'live'); assert.equal(value.asOf, at);
  f.advance(11000); fails = true; value = await f.service.read(SYMBOL);
  assert.equal(value.status, 'stale'); assert.equal(value.asOf, at); assert.equal(value.book.bids[0][0], '100');
});

test('simultaneous readers share depth and candle work while repeated polling does not resubscribe', async t => {
  const gate = deferred(), f = terminalFixture({ depth: async q => { await gate.promise; return book(q); } }); t.after(() => f.service.stop());
  const reads = [f.service.read(SYMBOL), f.service.read(SYMBOL), f.service.read(SYMBOL)];
  await new Promise(setImmediate); assert.equal(f.calls.depth.length, 1); gate.resolve();
  const values = await Promise.all(reads); assert.ok(values.every(value => value.status === 'live'));
  assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.candles.length, 1);
  for (let i = 0; i < 5; i++) { f.advance(2000); await f.service.read(SYMBOL); }
  assert.equal(f.Socket.instances.length, 1); assert.equal(f.Socket.instances[0].sent.filter(message => message.event === 'subscribe').length, 5);
  assert.equal(f.calls.candles.length, 1);
  await f.service.read(SYMBOL, '1m'); assert.equal(f.calls.candles.length, 2);
  assert.equal(f.Socket.instances[0].url, 'wss://api.gateio.ws/ws/crossex/public');
  assert.ok(f.Socket.instances[0].sent.every(message => ['ticker', 'trade', 'funding_rate', 'mark_price', 'order_book_5'].includes(message.channel)));
  assert.equal(f.Socket.instances[0].options.maxPayload, 1000000);
});

test('idle subscriptions are released and the empty public socket closes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0]; f.advance(120001); t.mock.timers.tick(25000);
  assert.equal(socket.sent.filter(message => message.event === 'unsubscribe').length, 5); assert.equal(socket.closed, 1);
  await f.service.read(SYMBOL); assert.equal(f.Socket.instances.length, 2); assert.equal(f.calls.resolve.length, 2);
});

test('stream cache and trade history remain bounded without mixing symbols', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop());
  for (let i = 0; i < 13; i++) { await f.service.read(`BINANCE_FUTURE_COIN${i}_USDT`); f.advance(1); }
  const socket = f.Socket.instances[0];
  assert.deepEqual(socket.sent.filter(message => message.event === 'unsubscribe').map(message => message.payload), Array(5).fill(['BINANCE_FUTURE_COIN0_USDT']));
  const symbol = 'BINANCE_FUTURE_COIN12_USDT';
  for (let i = 0; i < 70; i++) frame(socket, 'trade', { s: symbol, i: String(i), p: '100', q: '0.1', S: 'SELL', ts: f.now() - i });
  assert.equal((await f.service.read(symbol)).trades.length, 60);
  assert.deepEqual((await f.service.read('BINANCE_FUTURE_COIN11_USDT')).trades, []);
});

test('stop closes the socket and prevents a pending depth read from starting new candle work', async () => {
  const gate = deferred(), f = terminalFixture({ depth: async q => { await gate.promise; return book(q); } });
  const reading = f.service.read(SYMBOL); await new Promise(setImmediate);
  const stopping = f.service.stop(); gate.resolve(); await Promise.allSettled([reading, stopping]);
  assert.equal(f.Socket.instances[0].closed, 1); assert.equal(f.calls.candles.length, 0);
  await assert.rejects(f.service.read(SYMBOL), /停止/); await f.service.stop();
});

test('invalid symbols and intervals fail before resolving sources or starting a socket', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop());
  for (const symbol of ['', null, '../accounts', 'BINANCE_SPOT_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT?key=x', 'binance_FUTURE_BTC_USDT', 'UNKNOWN_FUTURE_BTC_USDT']) await assert.rejects(f.service.read(symbol));
  for (const interval of ['1s', '7w', '__proto__', '', null]) await assert.rejects(f.service.read(SYMBOL, interval));
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.Socket.instances.length, 0);
  let network = 0;
  const candles = createCandleReader({ fetcher: async () => { network++; throw Error('unexpected'); } });
  await assert.rejects(candles(quote('binance'), '7w')); await assert.rejects(candles(quote('unknown'), '1m'));
  assert.equal(network, 0);
});

test('funding rates retain source time and never rejuvenate old, regressed or settled frames', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0];
  const send = (at, settlement = NOW + 3600000, rate = '0.001') => socket.emit('message', Buffer.from(JSON.stringify({ channel: 'funding_rate', event: 'update', time_ms: at, result: { s: SYMBOL, r: rate, T: settlement } })));
  send(NOW - 86400000, NOW - 3600000); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, null);
  send(NOW); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, '0.001');
  for (const at of [NOW - 1, NOW + 1001, [NOW], undefined]) send(at, NOW + 3600000, '0.5');
  send(NOW, NOW - 1, '0.5'); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, '0.001');
  f.advance(60001); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, null);
});

test('Deribit retains 960 source hours until all 240 four-hour bars are aggregated', async () => {
  const ticks = Array.from({ length: 960 }, (_, i) => NOW - (960 - i) * INTERVALS['1h']);
  const reader = createCandleReader({ clock: () => NOW, fetcher: async () => json({ result: { status: 'ok', ticks, open: ticks.map(() => 100), high: ticks.map(() => 103), low: ticks.map(() => 99), close: ticks.map(() => 102), volume: ticks.map(() => 1) } }) });
  const values = await reader(quote('deribit'), '4h');
  assert.equal(values.length, 240); assert.equal(values[0].time, ticks[0]); assert.equal(values[0].volume, '4');
});

test('CrossEx books and mark prices remain usable when native identity and history are unavailable', async t => {
  const symbol = 'OKX_FUTURE_CL_USDC';
  const f = terminalFixture({ resolve: async () => { throw new AppError('原生合约不存在'); } }); t.after(() => f.service.stop());
  let value = await f.service.read(symbol);
  assert.equal(value.tradingAvailable, false);
  const socket = f.Socket.instances[0];
  frame(socket, 'order_book_5', { s: symbol, ts: NOW, b: [['72.1', '1250'], ['72', '100']], a: [['72.2', '300']] });
  socket.emit('message', Buffer.from(JSON.stringify({ channel: 'mark_price', event: 'update', time_ms: NOW, result: { s: symbol, mp: '72.15' } })));
  frame(socket, 'trade', { s: symbol, ts: NOW, p: '72.2', q: '10', S: 'BUY', i: 'cl-1' });
  value = await f.service.read(symbol);
  assert.equal(value.status, 'live'); assert.equal(value.error, null); assert.equal(value.ticker.bidPrice, '72.1'); assert.equal(value.ticker.markPrice, '72.15');
  assert.equal(value.book.quantityUnit, 'contracts'); assert.equal(value.book.bids[0][1], '1250');
  assert.equal(value.trades[0].quantityUnit, 'contracts'); assert.match(value.tradingReason, /原生合约不存在/);
  assert.equal(value.tradingAvailable, false); assert.deepEqual(value.candles, []); assert.equal(f.calls.depth.length, 0);
  f.advance(11000); value = await f.service.read(symbol);
  assert.equal(value.status, 'stale'); assert.equal(value.ticker.markPrice, null);
});

test('native quantity confirmation converts cached raw books and prints together without mixing units', async t => {
  const symbol = 'GATE_FUTURE_ETH_USDT'; let available = false;
  const f = terminalFixture({ resolve: async () => { if (!available) throw new AppError('暂未确认单位'); return { quote: { ...quote('gate', 'ETH'), nativeUnit: '0.01' }, rule: {} }; } }); t.after(() => f.service.stop());
  await f.service.read(symbol); const socket = f.Socket.instances[0];
  frame(socket, 'order_book_5', { s: symbol, ts: NOW, b: [['3000', '0.75']], a: [['3001', '125']] });
  frame(socket, 'trade', { s: symbol, ts: NOW, p: '3000', q: '0.75', S: 'BUY', i: 'eth-1' });
  assert.equal((await f.service.read(symbol)).book.quantityUnit, 'contracts');
  available = true; f.advance(30001); frame(socket, 'order_book_5', { s: symbol, ts: f.now(), b: [['3000', '0.75']], a: [['3001', '125']] }); const value = await f.service.read(symbol);
  assert.equal(value.book.quantityUnit, 'base'); assert.equal(value.book.bids[0][1], '0.0075'); assert.equal(value.trades[0].quantity, '0.0075'); assert.equal(value.tradingAvailable, true);
  assert.equal(f.calls.depth.length, 0);
});

test('malformed, regressed and wrong-channel public books never replace a validated snapshot', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL); const socket = f.Socket.instances[0];
  const good = { s: SYMBOL, ts: NOW + 1, b: [['100', '1'], ['99', '2']], a: [['101', '1']] };
  frame(socket, 'order_book_5', good);
  for (const change of [{ ts: NOW }, { ts: [NOW] }, { ts: NOW + 1001 }, { b: [['102', '1']] }, { b: [['100', '0']] }, { b: [['100', '1'], ['100', '2']] }, { a: [] }, { b: Array(6).fill(['100', '1']) }]) frame(socket, 'order_book_5', { ...good, ...change });
  frame(socket, 'order_book_1', { ...good, b: [['98', '1']] });
  const value = await f.service.read(SYMBOL); assert.equal(value.book.at, NOW + 1); assert.deepEqual(value.book.bids, good.b);
});

test('slow native and candle requests do not hold the public terminal response open', async t => {
  const hold = deferred();
  const f = terminalFixture({ resolve: async () => { await hold.promise; throw new AppError('慢来源'); } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const start = performance.now(); await f.service.read(SYMBOL); assert.ok(performance.now() - start < 1000);
  assert.equal(f.Socket.instances.length, 1);
  frame(f.Socket.instances[0], 'ticker', { s: SYMBOL, ts: NOW, bp: '100', ap: '101', lp: '100.5', o: '100' });
  const value = await f.service.read(SYMBOL); assert.equal(value.status, 'live'); assert.equal(value.ticker.bidPrice, '100'); assert.equal(value.tradingAvailable, false);
  hold.resolve();
});

test('mark price uses its own time and Bybit subscribes only to supported depth', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); const symbol = 'BYBIT_FUTURE_BTC_USDT'; await f.service.read(symbol);
  const socket = f.Socket.instances[0];
  assert.ok(socket.sent.some(m => m.channel === 'order_book_1')); assert.ok(!socket.sent.some(m => m.channel === 'order_book_5'));
  const send = (at, price) => socket.emit('message', Buffer.from(JSON.stringify({ channel: 'mark_price', event: 'update', time_ms: at, result: { s: symbol, mp: price } })));
  send(NOW, '101'); for (const at of [NOW - 1, NOW + 1001, [NOW], undefined]) send(at, '999');
  assert.equal((await f.service.read(symbol)).ticker.markPrice, '101');
  f.advance(11000); frame(socket, 'ticker', { s: symbol, ts: f.now(), bp: '100', ap: '101', lp: '100.5' });
  const value = await f.service.read(symbol); assert.equal(value.status, 'live'); assert.equal(value.ticker.markPrice, null);
});

test('concurrent catalog lookups retain the twelve-symbol subscription bound', async t => {
  const hold = deferred();
  const f = terminalFixture({ display: async symbol => { await hold.promise; return { quote: quote('binance', symbol.split('_')[2]), rule: {} }; } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const reads = Array.from({ length: 12 }, (_, i) => f.service.read(`BINANCE_FUTURE_COIN${i}_USDT`));
  const same = f.service.read('BINANCE_FUTURE_COIN0_USDT');
  await assert.rejects(f.service.read('BINANCE_FUTURE_EXTRA_USDT'), error => error.status === 429);
  hold.resolve(); await Promise.all([...reads, same]);
  const subscribed = new Set(f.Socket.instances[0].sent.filter(m => m.event === 'subscribe').flatMap(m => m.payload));
  assert.equal(subscribed.size, 12); assert.equal(f.calls.resolve.length, 12);
});

test('socket open never subscribes a symbol whose catalog identity is still pending', async t => {
  const hold = deferred();
  const f = terminalFixture({ display: async symbol => { if (symbol.includes('WAIT')) { await hold.promise; throw new AppError('目录不存在'); } return { quote: quote('binance'), rule: {} }; } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const rejected = assert.rejects(f.service.read('BINANCE_FUTURE_WAIT_USDT'), /目录不存在/);
  await f.service.read(SYMBOL);
  assert.ok(f.Socket.instances[0].sent.every(m => !m.payload.includes('BINANCE_FUTURE_WAIT_USDT')));
  hold.resolve(); await rejected;
});
