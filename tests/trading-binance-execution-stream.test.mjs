import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionExchangeClient, ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createBinanceStreams } from '../server/trading-binance-stream.mjs';
import { createBinanceClock } from '../server/trading-binance-clock.mjs';
import { normalizeMarket, StaleMarketError } from '../server/trading-execution-plan.mjs';

const EPOCH = 1_800_000_000_000;
const ORDER = '9223372036854775806';
const credentials = Object.freeze({ apiKey: 'fixture-execution-stream-key', apiSecret: 'fixture-execution-stream-secret' });
const spec = Object.freeze({ symbol: 'CLUSDT', side: 'buy', positionSide: 'BOTH', quantity: '2', reduceOnly: false, clientId: 'execution_stream_001' });
const exact = Object.freeze({ ...spec, id: ORDER });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flush = async () => { for (let index = 0; index < 100; index += 1) await Promise.resolve(); };
const errorCode = code => error => error instanceof ExecutionExchangeError && error.code === code;

function fixture(t, { accountMode = 'standard', offset = 0, privateAvailable = true, bookAvailable = true } = {}) {
  let time = EPOCH, timerId = 0, sequence = 0;
  const timers = new Map(), calls = [], sockets = [];
  const options = { accountMode };
  const state = { privateAvailable, bookAvailable, handler: () => undefined };
  const row = (patch = {}) => ({ orderId: ORDER, symbol: spec.symbol, clientOrderId: spec.clientId,
    side: 'BUY', positionSide: 'BOTH', reduceOnly: false, origQty: '2', executedQty: '0', price: '80', avgPrice: '0',
    status: 'NEW', type: 'LIMIT', timeInForce: 'GTX', time: EPOCH + offset, updateTime: time + offset, ...patch });
  const orderFrame = (patch = {}, envelope = {}) => ({ e: 'ORDER_TRADE_UPDATE', E: time + offset, T: time + offset,
    ...(accountMode === 'portfolio-margin' ? { fs: 'UM' } : {}),
    o: { s: spec.symbol, i: ORDER, c: spec.clientId, S: 'BUY', ps: 'BOTH', R: false, q: '2', z: '0', ap: '0',
      p: '80', X: 'NEW', o: 'LIMIT', f: 'GTX', T: time + offset, ...patch }, ...envelope });
  const bookFrame = (patch = {}) => ({ e: 'bookTicker', s: spec.symbol, u: ++sequence, E: time + offset, T: time + offset,
    b: '80', a: '80.1', B: '10', A: '12', ...patch });
  class Socket {
    constructor(url) {
      this.url = url; this.listeners = new Map(); this.closed = false; sockets.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        const book = url.includes('/public/ws/');
        if (!(book ? state.bookAvailable : state.privateAvailable)) { this.emit('error'); return; }
        this.emit('open');
        if (book) this.frame(bookFrame());
      });
    }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
    emit(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
    frame(value) { this.raw(JSON.stringify(value)); }
    raw(value) { this.emit('message', { data: value }); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  }
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url), call = { url: parsed, init, parameters: Object.fromEntries(parsed.searchParams) };
    calls.push(call);
    const supplied = await state.handler(call);
    if (supplied !== undefined) return supplied instanceof Response ? supplied : json(supplied);
    const path = parsed.pathname;
    if (path.endsWith('/time')) return json({ serverTime: time + offset });
    if (path.endsWith('/listenKey')) return json({ listenKey: 'fixture-execution-listen-key' });
    if (path.endsWith('/apiRestrictions')) return json({ enableReading: true, enableWithdrawals: false, enableInternalTransfer: false,
      permitsUniversalTransfer: false, enableMargin: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false,
      enableFutures: accountMode === 'standard', enablePortfolioMarginTrading: accountMode === 'portfolio-margin', enableFixApiTrade: false });
    if (path.endsWith('/accountConfig')) return json({ canTrade: true, dualSidePosition: false });
    if (path.endsWith('/positionRisk') || path.endsWith('/openOrders') || path.endsWith('/openAlgoOrders')) return json([]);
    if (path.endsWith('/ticker/bookTicker')) return json({ symbol: spec.symbol, bidPrice: '80', askPrice: '80.1', bidQty: '10', askQty: '12', time: time + offset });
    if (path.endsWith('/order')) {
      if (init.method === 'POST') return json({ orderId: ORDER, symbol: spec.symbol, clientOrderId: call.parameters.newClientOrderId });
      return json(row(init.method === 'DELETE' ? { status: 'CANCELED' } : {}));
    }
    throw new Error(`Unexpected fixture route: ${init.method} ${path}`);
  };
  const now = () => time;
  const clock = createBinanceClock({ fetchImpl, now, monotonicNow: now });
  const stream = createBinanceStreams({ fetchImpl, WebSocketImpl: Socket, now, exchangeNow: clock.serverNow,
    ensureClock: value => clock.sync(value), purpose: 'execution',
    setTimeoutImpl: (fn, ms) => { const id = ++timerId; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimeoutImpl: id => timers.delete(id) });
  const client = createExecutionExchangeClient('binance', { fetchImpl, now, binanceClock: clock, binanceStreams: stream, WebSocketImpl: Socket });
  t.after(() => { client.close(); assert.equal(timers.size, 0); assert.ok(sockets.every(socket => socket.closed)); });
  const privateSocket = () => sockets.findLast(socket => !socket.closed && !socket.url.includes('/public/ws/'));
  const publicSocket = () => sockets.findLast(socket => !socket.closed && socket.url.includes('/public/ws/'));
  const orderReads = () => calls.filter(call => call.init.method === 'GET' && call.url.pathname.endsWith('/order'));
  const writes = () => calls.filter(call => call.init.method !== 'GET' && call.url.pathname.endsWith('/order'));
  return { client, stream, clock, state, calls, sockets, options, row, orderFrame, bookFrame, now,
    elapse: ms => { time += ms; }, privateSocket, publicSocket, orderReads, writes,
    boot: () => client.account(credentials, { ...options, symbols: [spec.symbol] }),
    inspect: (wanted = exact) => client.inspect(credentials, wanted, options),
    market: () => client.market(spec.symbol, { withRule: false }) };
}

for (const accountMode of ['standard', 'portfolio-margin']) {
  test(`Binance ${accountMode} preflight starts private WS and a minute of actual BBO/order frames needs no REST polling`, async t => {
    const f = fixture(t, { accountMode, offset: -60_000 });
    assert.equal((await f.boot()).modes.CLUSDT, 'one-way');
    assert.equal(f.privateSocket().url, `wss://fstream.binance.com/${accountMode === 'standard' ? 'private' : 'pm'}/ws/fixture-execution-listen-key`);
    const listen = f.calls.find(call => call.url.pathname.endsWith('/listenKey'));
    assert.equal(listen.url.pathname, accountMode === 'standard' ? '/fapi/v1/listenKey' : '/papi/v1/listenKey');
    assert.deepEqual(listen.parameters, {}); assert.deepEqual(listen.init.headers, { 'X-MBX-APIKEY': credentials.apiKey });
    assert.deepEqual(await f.market(), { symbol: spec.symbol, bid: '80', ask: '80.1', at: new Date(EPOCH).toISOString() });
    assert.equal(f.publicSocket().url, 'wss://fstream.binance.com/public/ws/clusdt@bookTicker');
    for (let second = 1; second <= 60; second += 1) {
      f.elapse(1000);
      const fill = String(second / 100), bid = String(80 + second), ask = String(81 + second);
      f.publicSocket().frame(f.bookFrame({ b: bid, a: ask }));
      const event = f.orderFrame({ z: fill, ap: '80', X: 'PARTIALLY_FILLED' });
      // Exercise the lossless JSON parser with a numeric ID above MAX_SAFE_INTEGER.
      f.privateSocket().raw(JSON.stringify(event).replace(`"i":"${ORDER}"`, `"i":${ORDER}`));
      if (accountMode === 'portfolio-margin') f.privateSocket().frame(f.orderFrame({ z: '2', X: 'FILLED', ap: '80' }, { fs: 'CM' }));
      const [market, order] = await Promise.all([f.market(), f.inspect()]);
      assert.equal(market.bid, bid); assert.equal(market.ask, ask); assert.equal(market.at, new Date(f.now()).toISOString());
      assert.equal(order.id, ORDER); assert.equal(order.filledQuantity, fill); assert.equal(order.terminal, false);
    }
    assert.equal(f.orderReads().length, 0);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/ticker/bookTicker')).length, 0);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/listenKey')).length, 1);
    assert.equal(f.writes().length, 0);
  });

  test(`Binance ${accountMode} NEW, partial fill, native amendment ACK and stop keep the same ID and original total`, async t => {
    const f = fixture(t, { accountMode }); await f.boot();
    let guards = 0;
    f.state.handler = call => {
      if (!call.url.pathname.endsWith('/order')) return;
      if (call.init.method === 'POST') {
        f.elapse(1); f.privateSocket().frame(f.orderFrame());
        return { orderId: ORDER, symbol: spec.symbol, clientOrderId: spec.clientId };
      }
      if (call.init.method === 'PUT') { f.elapse(2); return f.row({ price: '80.05', executedQty: '1', avgPrice: '80', status: 'PARTIALLY_FILLED' }); }
      if (call.init.method === 'DELETE') { f.elapse(1); return f.row({ price: '80.05', executedQty: '1.25', avgPrice: '80.01', status: 'CANCELED' }); }
    };
    const options = { ...f.options, beforeMutation: () => { guards += 1; } };
    assert.deepEqual(await f.client.create(credentials, spec, options), { id: ORDER, kind: 'order' });
    assert.equal((await f.inspect()).filledQuantity, '0');
    f.elapse(1); f.privateSocket().frame(f.orderFrame({ z: '1', ap: '80', X: 'PARTIALLY_FILLED' }));
    assert.equal((await f.inspect()).filledQuantity, '1');
    const beforeAmend = f.now();
    const amended = await f.client.amend(credentials, { ...exact, remainingQuantity: '1' }, options);
    assert.equal(amended.quantity, '2'); assert.equal(amended.filledQuantity, '1'); assert.equal(amended.price, '80.05');
    f.privateSocket().frame(f.orderFrame({ z: '1', ap: '80', X: 'PARTIALLY_FILLED', T: beforeAmend }));
    assert.equal((await f.inspect()).price, '80.05');
    f.elapse(1); f.privateSocket().frame(f.orderFrame({ p: '80.05', z: '1.25', ap: '80.01', X: 'PARTIALLY_FILLED' }));
    assert.equal((await f.inspect()).filledQuantity, '1.25');
    await f.client.stop(credentials, exact, options);
    const stopped = await f.inspect(); assert.equal(stopped.terminal, true); assert.equal(stopped.filledQuantity, '1.25');
    assert.deepEqual(f.writes().map(call => call.init.method), ['POST', 'PUT', 'DELETE']); assert.equal(guards, 3);
    const [, amend, stop] = f.writes();
    assert.equal(amend.parameters.orderId, ORDER); assert.equal(amend.parameters.quantity, '2'); assert.equal(amend.parameters.priceMatch, 'QUEUE');
    assert.equal(stop.parameters.orderId, ORDER); assert.equal(f.orderReads().length, 0);
  });
}

test('same-millisecond pre-amend WS evidence cannot replace exact REST confirmation when ACK lacks updateTime', async t => {
  const f = fixture(t); await f.boot(); f.privateSocket().frame(f.orderFrame());
  assert.equal((await f.inspect()).price, '80');
  f.state.handler = call => {
    if (!call.url.pathname.endsWith('/order')) return;
    if (call.init.method === 'PUT') {
      f.privateSocket().frame(f.orderFrame());
      const acknowledgement = f.row({ price: '80.05' }); delete acknowledgement.updateTime; return acknowledgement;
    }
    return f.row({ price: '80.05' });
  };
  await f.client.amend(credentials, exact, f.options);
  assert.equal((await f.inspect()).price, '80.05'); assert.equal(f.orderReads().length, 1);
  assert.equal((await f.inspect()).price, '80.05'); assert.equal(f.orderReads().length, 1);
});

for (const byClientId of [false, true]) {
  test(`absent private evidence recovers the exact original ${byClientId ? 'client ID' : 'order ID'}, disconnected REST cache expires after five seconds`, async t => {
    const f = fixture(t); await f.boot();
    const wanted = byClientId ? spec : exact;
    assert.equal((await f.inspect(wanted)).id, ORDER); assert.equal(f.orderReads().length, 1);
    f.state.privateAvailable = false; f.privateSocket().close();
    for (let second = 1; second < 5; second += 1) {
      f.elapse(1000); assert.equal((await f.inspect(wanted)).id, ORDER); assert.equal(f.orderReads().length, 1);
    }
    f.elapse(1000); await f.inspect(wanted); assert.equal(f.orderReads().length, 2);
    for (const call of f.orderReads()) {
      assert.equal(call.parameters.symbol, spec.symbol);
      assert.equal(call.parameters[byClientId ? 'origClientOrderId' : 'orderId'], byClientId ? spec.clientId : ORDER);
      assert.equal(call.parameters[byClientId ? 'orderId' : 'origClientOrderId'], undefined);
    }
    assert.equal(f.writes().length, 0);
  });
}

test('public stream outage uses five-second REST evidence without renewing its age on cache reads', async t => {
  const f = fixture(t, { bookAvailable: false, offset: -60_000 });
  assert.equal((await f.market()).at, new Date(EPOCH).toISOString());
  for (let second = 1; second < 5; second += 1) {
    f.elapse(1000); assert.equal((await f.market()).at, new Date(EPOCH).toISOString());
  }
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/ticker/bookTicker')).length, 1);
  f.elapse(1000); assert.equal((await f.market()).at, new Date(EPOCH + 5000).toISOString());
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/ticker/bookTicker')).length, 2);
});

test('public traffic, duplicate private frames and repeated inspection cannot extend the 30-second order evidence window', async t => {
  const f = fixture(t); await f.boot(); await f.market();
  const original = f.orderFrame(); f.privateSocket().frame(original);
  for (let second = 0; second < 30; second += 1) {
    if (second) f.elapse(1000);
    f.publicSocket().frame(f.bookFrame()); f.privateSocket().frame(original);
    await Promise.all([f.market(), f.inspect()]); assert.equal(f.orderReads().length, 0);
  }
  f.elapse(1000); await f.inspect(); assert.equal(f.orderReads().length, 1);
  for (let second = 1; second < 30; second += 1) {
    f.elapse(1000); await f.inspect(); assert.equal(f.orderReads().length, 1);
  }
  f.elapse(1000); await f.inspect(); assert.equal(f.orderReads().length, 2);
});

for (const operation of ['amend', 'stop']) {
  test(`a delayed REST inspection started before ${operation} cannot overwrite the acknowledged order`, async t => {
    const f = fixture(t); await f.boot();
    let release;
    const old = f.row();
    f.state.handler = call => {
      if (!call.url.pathname.endsWith('/order')) return;
      if (call.init.method === 'GET') return new Promise(resolve => { release = resolve; });
      f.elapse(1);
      return f.row({ price: '80.05', executedQty: '1', avgPrice: '80', status: operation === 'amend' ? 'PARTIALLY_FILLED' : 'CANCELED' });
    };
    const delayed = assert.rejects(f.inspect(), errorCode('upstream')); await flush();
    assert.equal(typeof release, 'function');
    await f.client[operation](credentials, exact, f.options);
    release(old); await delayed;
    const current = await f.inspect(); assert.equal(current.price, '80.05'); assert.equal(current.filledQuantity, '1');
    assert.equal(current.terminal, operation === 'stop'); assert.equal(f.orderReads().length, 1);
  });
}

test('forget invalidates a delayed REST result and old socket events before the next account session', async t => {
  const f = fixture(t); await f.boot(); const oldSocket = f.privateSocket(); let release;
  f.state.handler = call => {
    if (call.init.method === 'GET' && call.url.pathname.endsWith('/order')) return new Promise(resolve => { release = resolve; });
  };
  const delayed = assert.rejects(f.inspect(), errorCode('aborted')); await flush(); assert.equal(typeof release, 'function');
  f.client.forget(); release(f.row()); oldSocket.frame(f.orderFrame({ z: '2', ap: '80', X: 'FILLED' })); await delayed;
  f.elapse(1); f.state.handler = call => call.init.method === 'GET' && call.url.pathname.endsWith('/order')
    ? f.row({ executedQty: '1', avgPrice: '80', status: 'PARTIALLY_FILLED' }) : undefined;
  await f.boot(); assert.notEqual(f.privateSocket(), oldSocket);
  assert.equal((await f.inspect()).filledQuantity, '1'); assert.equal(f.orderReads().length, 2);
});

for (const [accountMode, offset] of [['standard', -60_000], ['portfolio-margin', 60_000]]) {
  test(`Binance ${accountMode} preserves delayed WS source time through the execution freshness check`, async t => {
    const f = fixture(t, { accountMode, offset }); await f.boot(); await f.market();
    f.elapse(4000);
    f.publicSocket().frame(f.bookFrame({ E: EPOCH + offset, T: EPOCH + offset }));
    const market = await f.market();
    // The event was four seconds old on arrival. A slower second leg must not
    // make those four seconds disappear from the shared ten-second guard.
    f.elapse(7000);
    const rule = { tickSize: '0.1', quantityStep: '0.1', minQuantity: '0.1', maxQuantity: '100', minNotional: '0' };
    assert.throws(() => normalizeMarket({ ...market, rule }, spec.symbol, f.now(), 'binance'), StaleMarketError);
    assert.equal(market.at, new Date(EPOCH).toISOString());
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/ticker/bookTicker')).length, 0);
    assert.equal(f.writes().length, 0);
  });
}

test('concurrent explicit -1021 mutations share one clock correction and recheck each send guard', async t => {
  const f = fixture(t, { offset: 2000 }); const attempts = new Map(), guards = new Map(); let releaseTime;
  f.state.handler = call => {
    if (call.url.pathname.endsWith('/time')) return new Promise(resolve => { releaseTime = resolve; });
    if (call.init.method === 'POST' && call.url.pathname.endsWith('/order')) {
      const id = call.parameters.newClientOrderId, count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
      if (count === 1) return json({ code: -1021 }, 400);
    }
  };
  const pending = ['first', 'second'].map(suffix => {
    const clientId = `execution_stream_${suffix}`;
    return f.client.create(credentials, { ...spec, clientId }, { beforeMutation: () => guards.set(clientId, (guards.get(clientId) ?? 0) + 1) });
  });
  await flush(); assert.equal(typeof releaseTime, 'function'); assert.equal(f.writes().length, 2);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/time')).length, 1);
  releaseTime({ serverTime: EPOCH + 2000 }); await Promise.all(pending);
  assert.equal(attempts.size, 2); assert.equal(guards.size, 2);
  for (const count of attempts.values()) assert.equal(count, 2);
  for (const count of guards.values()) assert.equal(count, 2);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/time')).length, 1);
  assert.deepEqual(f.writes().map(call => call.parameters.timestamp), [String(EPOCH), String(EPOCH), String(EPOCH + 2000), String(EPOCH + 2000)]);
  const timeCall = f.calls.find(call => call.url.pathname.endsWith('/time'));
  assert.deepEqual([...new Headers(timeCall.init.headers)], []); assert.deepEqual(timeCall.parameters, {});
});

for (const operation of ['create', 'amend']) {
  for (const failure of ['5xx', 'transport']) {
    test(`unknown ${operation} ${failure} is never resent and requires exact REST despite a subsequent private event`, async t => {
      const f = fixture(t); await f.boot();
      if (operation === 'amend') { f.privateSocket().frame(f.orderFrame()); await f.inspect(); }
      f.state.handler = call => {
        if (!call.url.pathname.endsWith('/order')) return;
        if (call.init.method !== 'GET') {
          f.elapse(1); f.privateSocket().frame(f.orderFrame({ z: '1', ap: '80', X: 'PARTIALLY_FILLED' }));
          if (failure === 'transport') throw new TypeError('fixture connection interrupted');
          return json({ code: -1000 }, 503);
        }
        return f.row({ executedQty: '1', avgPrice: '80', status: 'PARTIALLY_FILLED' });
      };
      await assert.rejects(f.client[operation](credentials, operation === 'create' ? spec : exact, f.options), error => {
        assert.ok(error instanceof ExecutionExchangeError); assert.equal(error.code, failure === 'transport' ? 'transport' : 'upstream');
        assert.equal(error.uncertain, true); return true;
      });
      assert.equal((await f.inspect(operation === 'create' ? spec : exact)).filledQuantity, '1');
      assert.equal(f.writes().length, 1); assert.equal(f.orderReads().length, 1);
    });
  }
}
