import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceStreamError, createBinanceStreams } from '../server/trading-binance-stream.mjs';

const EPOCH = 1_800_000_000_000;
const credentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret' };
const spec = { symbol: 'ANTUSDT', id: '99', clientId: 'client-99' };
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const matches = code => cause => cause instanceof BinanceStreamError && cause.code === code;

function fixture(options = {}) {
  let time = EPOCH, exchangeOffset = 0, nextTimer = 0;
  const timers = new Map(), sockets = [], calls = [], replies = [];
  class Socket {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sockets.push(this); }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
    emit(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
    open() { this.emit('open'); }
    frame(row) { this.emit('message', { data: JSON.stringify(row) }); }
    raw(text) { this.emit('message', { data: text }); }
    close() { this.closed = true; this.emit('close'); }
  }
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const next = replies.shift();
    if (typeof next === 'function') return next(url, init);
    const { status = 200, body = { listenKey: 'fixture-listen-token' }, headers = {} } = next ?? {};
    return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => JSON.stringify(body) };
  };
  const stream = createBinanceStreams({ fetchImpl, WebSocketImpl: Socket, now: () => time, exchangeNow: () => time + exchangeOffset,
    setTimeoutImpl: (fn, ms) => { const timer = ++nextTimer; timers.set(timer, { at: time + ms, fn }); return timer; },
    clearTimeoutImpl: timer => timers.delete(timer), ...options });
  async function advance(ms) {
    await flush(); const until = time + ms;
    for (;;) {
      const first = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      timers.delete(first[0]); time = first[1].at; first[1].fn(); await flush();
    }
    time = until; await flush();
  }
  const row = (extra = {}) => ({ symbol: 'ANTUSDT', orderId: '99', clientOrderId: 'client-99', side: 'BUY', positionSide: 'BOTH',
    reduceOnly: false, origQty: '4', executedQty: '0', avgPrice: '0', price: '100', status: 'NEW', type: 'LIMIT', timeInForce: 'GTX',
    updateTime: time + exchangeOffset, ...extra });
  const orderFrame = (extra = {}, envelope = {}) => ({ e: 'ORDER_TRADE_UPDATE', E: time + exchangeOffset, T: time + exchangeOffset,
    o: { s: 'ANTUSDT', i: 99, c: 'client-99', S: 'BUY', ps: 'BOTH', R: false, q: '4', z: '0', ap: '0', p: '100',
      X: 'NEW', o: 'LIMIT', f: 'GTX', T: time + exchangeOffset, ...extra }, ...envelope });
  const bookFrame = (extra = {}) => ({ e: 'bookTicker', s: 'ANTUSDT', T: time + exchangeOffset, E: time + exchangeOffset,
    u: 1, b: '100', a: '101', B: '2', A: '3', ...extra });
  const positionFrame = (positions = [], extra = {}) => ({ e: 'ACCOUNT_UPDATE', E: time + exchangeOffset, T: time + exchangeOffset,
    a: { P: positions, m: 'ORDER' }, ...extra });
  async function bootPrivate(accountMode = 'standard', key = credentials) {
    const pending = stream.ready(key, { accountMode }); await flush(); sockets.at(-1).open(); return pending;
  }
  async function bootBook() {
    const pending = stream.book('ANTUSDT'); await flush(); sockets.at(-1).open(); sockets.at(-1).frame(bookFrame()); return pending;
  }
  return { stream, sockets, timers, calls, replies, advance, row, orderFrame, bookFrame, positionFrame, bootPrivate, bootBook,
    now: () => time, setTime: at => { time = at; }, setOffset: offset => { exchangeOffset = offset; } };
}

test('standard and PM use separate authenticated listenKey and routed WS endpoints without signing', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const standard = await f.bootPrivate();
  const pm = await f.bootPrivate('portfolio-margin');
  assert.equal(standard.connectedAt, EPOCH); assert.ok(pm.generation > standard.generation);
  assert.deepEqual(f.calls.map(call => call.url), ['https://fapi.binance.com/fapi/v1/listenKey', 'https://papi.binance.com/papi/v1/listenKey']);
  assert.deepEqual(f.sockets.map(socket => socket.url), ['wss://fstream.binance.com/private/ws/fixture-listen-token',
    'wss://fstream.binance.com/pm/ws/fixture-listen-token']);
  for (const call of f.calls) {
    assert.equal(call.method, 'POST'); assert.equal(call.redirect, 'error');
    assert.deepEqual(call.headers, { 'X-MBX-APIKEY': credentials.apiKey });
    assert.equal(call.body, undefined); assert.doesNotMatch(call.url, /signature|timestamp|listenKey=/);
  }
  assert.equal(await f.stream.order(credentials, spec), null); // Open is not an account snapshot.
});

test('listenKey renews without private events; close/forget never DELETE shared tokens', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const events = [], resets = [];
  f.stream.subscribePositions(credentials, { onEvent: event => events.push(event), onReset: value => resets.push(value) });
  await f.bootPrivate(); await f.advance(30 * 60_000);
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'PUT']); assert.equal(f.sockets.length, 1);
  assert.deepEqual(events, []); assert.deepEqual(resets, []);
  f.stream.forget(credentials); assert.equal(f.sockets[0].closed, true); assert.equal(resets.length, 1);
  assert.equal(f.timers.size, 0); await f.advance(120 * 60_000);
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'PUT']);
});

test('-1125 and listenKeyExpired discard old generations and recreate after bounded backoff', async t => {
  const f = fixture(); t.after(() => f.stream.close()); const resets = [];
  f.stream.subscribePositions(credentials, { onReset: value => resets.push(value) });
  const first = await f.bootPrivate(); f.sockets[0].frame(f.orderFrame());
  f.replies.push({ status: 400, body: { code: -1125, msg: 'sensitive body fixture-secret' } });
  await f.advance(30 * 60_000); assert.equal(f.sockets[0].closed, true); assert.equal(resets.length, 1);
  await f.advance(999); assert.equal(f.calls.length, 2); await f.advance(1);
  assert.equal(f.calls.at(-1).method, 'POST'); f.sockets[1].open();
  const second = await f.stream.ready(credentials); assert.ok(second.generation > first.generation);
  f.sockets[0].frame(f.orderFrame({ z: '4', X: 'FILLED' })); assert.equal(await f.stream.order(credentials, spec), null);
  f.sockets[1].frame({ e: 'listenKeyExpired' }); await f.advance(2000);
  assert.equal(f.calls.at(-1).method, 'POST'); assert.equal(f.sockets.length, 3);
});

test('HTTP and socket deadlines reject even when callbacks arrive after delayed timers', async t => {
  const f = fixture(); t.after(() => f.stream.close()); let release;
  f.replies.push(() => new Promise(resolve => { release = resolve; }));
  const pending = assert.rejects(f.stream.ready(credentials), matches('timeout')); await flush();
  f.setTime(EPOCH + 5000);
  release({ ok: true, status: 200, text: async () => JSON.stringify({ listenKey: 'late-token' }) }); await pending;
  assert.equal(f.sockets.length, 0);
  const g = fixture(); t.after(() => g.stream.close());
  const connection = assert.rejects(g.stream.ready(credentials), matches('timeout')); await flush();
  g.setTime(EPOCH + 5000); g.sockets[0].open(); await connection; assert.equal(g.sockets[0].closed, true);
});

test('pending requests are aborted on close and every waiter/timer is released', async () => {
  const f = fixture(); f.replies.push(() => new Promise(() => {}));
  const pending = assert.rejects(f.stream.ready(credentials), matches('aborted')); await flush();
  f.stream.close(); await pending; assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.timers.size, 0);
  await f.advance(60_000); assert.equal(f.calls.length, 1);
  await assert.rejects(f.stream.ready(credentials), matches('aborted'));
});

test('429 server Retry-After constrains explicit and automatic reconnection and errors contain no tokens', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  f.replies.push({ status: 429, headers: { 'Retry-After': '120' }, body: { code: -1003, msg: 'fixture-secret fixture-key' } });
  const rejected = assert.rejects(f.stream.ready(credentials), cause => {
    assert.equal(cause.rateLimited, true); assert.equal(cause.retryAt, EPOCH + 120_000);
    assert.doesNotMatch(JSON.stringify(cause) + cause.message, /fixture-secret|fixture-key|https:/); return true;
  }); await rejected;
  await assert.rejects(f.stream.ready(credentials), matches('upstream')); assert.equal(f.calls.length, 1);
  await f.advance(119_999); assert.equal(f.calls.length, 1);
  const waiting = f.stream.ready(credentials); await assert.rejects(waiting, matches('upstream'));
  await f.advance(1); assert.equal(f.calls.length, 2);
});

test('public routed book uses calibrated exchange time and original local receipt time', async t => {
  let syncs = 0; const f = fixture({ ensureClock: async () => { syncs += 1; } }); t.after(() => f.stream.close());
  f.setOffset(-60_000); const row = await f.bootBook();
  assert.equal(syncs, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.sockets[0].url, 'wss://fstream.binance.com/public/ws/antusdt@bookTicker');
  assert.deepEqual(row, { symbol: 'ANTUSDT', bidPrice: '100', askPrice: '101', bidQty: '2', askQty: '3', time: EPOCH - 60_000, receivedAt: EPOCH });
  await f.advance(1000); f.sockets[0].frame(f.bookFrame());
  assert.equal((await f.stream.book('ANTUSDT')).receivedAt, EPOCH); // Same u does not renew age.
  f.sockets[0].frame(f.bookFrame({ u: 2 })); assert.equal((await f.stream.book('ANTUSDT')).receivedAt, EPOCH + 1000);
  f.sockets[0].frame(f.bookFrame({ u: 1 })); assert.equal((await f.stream.book('ANTUSDT')).receivedAt, EPOCH + 1000);
});

test('stale source, future source, wrong symbols, zero quantities and crossed quotes fail closed', async t => {
  for (const patch of [{ T: EPOCH - 5000 }, { T: EPOCH + 1001 }, { E: EPOCH + 1001 }, { s: 'ETHUSDT' }, { A: '0' }, { b: '102' }]) {
    const f = fixture(); t.after(() => f.stream.close());
    const pending = assert.rejects(f.stream.book('ANTUSDT'), cause => cause instanceof BinanceStreamError);
    await flush(); f.sockets[0].open(); f.sockets[0].frame(f.bookFrame(patch)); await pending;
    assert.equal(f.sockets[0].closed, true);
  }
  const f = fixture(); t.after(() => f.stream.close());
  const pending = f.stream.book('ANTUSDT'); await flush(); f.sockets[0].open();
  f.sockets[0].frame(f.bookFrame({ T: EPOCH - 4500, E: EPOCH - 4500 })); await pending;
  f.setTime(EPOCH + 500); const stale = assert.rejects(f.stream.book('ANTUSDT'), matches('timeout'));
  await f.advance(5000); await stale;
});

test('orders preserve IDs above MAX_SAFE_INTEGER and cumulative fill deduplicates repeated partial trades', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate();
  f.sockets[0].raw(JSON.stringify(f.orderFrame({ z: '1', ap: '100', X: 'PARTIALLY_FILLED', l: '1' }))
    .replace('"i":99', '"i":9007199254740993123'));
  const wanted = { ...spec, id: '9007199254740993123' };
  assert.equal((await f.stream.order(credentials, wanted)).executedQty, '1');
  await assert.rejects(f.stream.order(credentials, { ...wanted, id: 9007199254740993000 }), matches('invalid_data'));
  await f.advance(1000);
  const second = f.orderFrame({ i: wanted.id, z: '2', l: '1', ap: '100', X: 'PARTIALLY_FILLED' });
  f.sockets[0].frame(second); f.sockets[0].frame(second);
  assert.equal((await f.stream.order(credentials, wanted)).executedQty, '2');
  f.sockets[0].frame(f.orderFrame({ i: wanted.id, z: '1', ap: '100', X: 'PARTIALLY_FILLED', T: EPOCH }));
  assert.equal((await f.stream.order(credentials, wanted)).executedQty, '2');
  f.sockets[0].frame(f.orderFrame({ i: wanted.id, z: '4', ap: '100', X: 'FILLED' }));
  assert.equal((await f.stream.order(credentials, wanted)).status, 'FILLED');
  await f.advance(1); f.sockets[0].frame(f.orderFrame({ i: wanted.id }));
  assert.equal(await f.stream.order(credentials, wanted), null);
});

test('same-millisecond fill progress is usable but ambiguous amendment/identity/regression requires exact REST', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate();
  f.sockets[0].frame(f.orderFrame());
  f.sockets[0].frame(f.orderFrame({ z: '1', ap: '100', X: 'PARTIALLY_FILLED' }));
  assert.equal((await f.stream.order(credentials, spec)).executedQty, '1');
  f.sockets[0].frame(f.orderFrame({ z: '2', ap: '100', X: 'PARTIALLY_FILLED' }));
  assert.equal((await f.stream.order(credentials, spec)).executedQty, '2');
  f.sockets[0].frame(f.orderFrame({ z: '2', ap: '100', X: 'PARTIALLY_FILLED', p: '101' }));
  assert.equal(await f.stream.order(credentials, spec), null);
  f.stream.seedOrder(credentials, f.row({ executedQty: '2', avgPrice: '100', status: 'PARTIALLY_FILLED', price: '101' }));
  assert.equal((await f.stream.order(credentials, spec)).price, '101');
  f.sockets[0].frame(f.orderFrame({ z: '2', ap: '100', X: 'PARTIALLY_FILLED', p: '100' }));
  assert.equal(await f.stream.order(credentials, spec), null);
});

test('seed does not let an older WS overwrite REST and invalidation blocks late pre-mutation frames', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate();
  f.stream.seedOrder(credentials, f.row({ time: EPOCH - 100_000 }));
  await f.advance(1); f.stream.invalidateOrder(credentials, spec);
  f.sockets[0].frame(f.orderFrame({ T: EPOCH })); assert.equal(await f.stream.order(credentials, spec), null);
  f.stream.seedOrder(credentials, f.row({ price: '101', time: EPOCH - 100_000 }));
  f.sockets[0].frame(f.orderFrame({ T: EPOCH }));
  assert.equal((await f.stream.order(credentials, spec)).price, '101');
  await f.advance(1); f.sockets[0].frame(f.orderFrame({ p: '101', z: '1', ap: '101', X: 'PARTIALLY_FILLED' }));
  assert.equal((await f.stream.order(credentials, spec)).time, EPOCH - 100_000);
});

test('order age expires on read at 30s; repeated duplicate frames and public messages cannot extend it', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate(); await f.bootBook();
  f.sockets[0].frame(f.orderFrame()); await f.advance(29_999);
  f.sockets[0].frame(f.orderFrame({ T: EPOCH }));
  assert.ok(await f.stream.order(credentials, spec));
  f.sockets[1].frame(f.bookFrame({ u: 2 })); f.setTime(EPOCH + 30_000);
  assert.equal(await f.stream.order(credentials, spec), null); assert.equal(f.sockets[0].closed, false);
  // Long-lived resting orders confirmed by REST remain eligible for their new receipt window.
  f.stream.seedOrder(credentials, f.row({ updateTime: EPOCH - 3600_000 }));
  assert.equal(await f.stream.order(credentials, spec), null); // Cannot supersede newer evidence with an older row.
});

test('PM only forwards UM deltas, empty P does not produce a snapshot, observers receive isolated copies', async t => {
  const f = fixture(); t.after(() => f.stream.close()); const events = [], second = [], resets = [];
  f.stream.subscribePositions(credentials, { accountMode: 'portfolio-margin', onEvent: event => { events.push(event); event.positions.length = 0; }, onReset: value => resets.push(value) });
  f.stream.subscribePositions(credentials, { accountMode: 'portfolio-margin', onEvent: event => second.push(event) });
  await f.bootPrivate('portfolio-margin'); assert.deepEqual(events, []); assert.deepEqual(resets, []);
  const position = { s: 'ANTUSDT', ps: 'BOTH', pa: '2', ep: '100', up: '3' };
  f.sockets[0].frame(f.positionFrame([position], { fs: 'CM' }));
  f.sockets[0].frame(f.orderFrame({}, { fs: 'CM' }));
  f.sockets[0].frame(f.positionFrame([position])); assert.equal(events.length, 0);
  f.sockets[0].frame(f.positionFrame([position], { fs: 'UM' }));
  assert.equal(second[0].positions.length, 1); assert.equal(second[0].receivedAt, EPOCH);
  f.sockets[0].frame(f.positionFrame([], { fs: 'UM' }));
  assert.deepEqual(second[1].positions, []); assert.equal(second[0].positions[0].pa, '2');
  assert.equal(await f.stream.order(credentials, spec, { accountMode: 'portfolio-margin' }), null);
  f.sockets[0].close(); assert.equal(resets.length, 1);
});

test('credentials, mode and purpose isolate all private evidence; forget ignores late old frames', async t => {
  const f = fixture(), other = fixture({ purpose: 'readonly' }); t.after(() => { f.stream.close(); other.stream.close(); });
  await f.bootPrivate(); f.sockets[0].frame(f.orderFrame());
  const rotated = { ...credentials, apiSecret: 'replacement-secret' };
  await f.bootPrivate('standard', rotated);
  assert.equal(await f.stream.order(rotated, spec), null);
  await f.bootPrivate('portfolio-margin');
  assert.equal(await f.stream.order(credentials, spec, { accountMode: 'portfolio-margin' }), null);
  await other.bootPrivate(); assert.equal(await other.stream.order(credentials, spec), null);
  f.stream.forget(credentials, { accountMode: 'standard' });
  assert.equal(f.sockets[0].closed, true); assert.equal(f.sockets[1].closed, false); assert.equal(f.sockets[2].closed, false);
  f.sockets[0].frame(f.orderFrame({ z: '4', X: 'FILLED' }));
  await f.bootPrivate(); assert.equal(await f.stream.order(credentials, spec), null);
});

test('deadline validation invalidates expired token when the renewal timer has not run', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  f.stream.subscribePositions(credentials, {}); await f.bootPrivate(); f.sockets[0].frame(f.orderFrame());
  f.setTime(EPOCH + 60 * 60_000);
  await assert.rejects(f.stream.order(credentials, spec), matches('upstream')); assert.equal(f.sockets[0].closed, true);
});

test('24-hour connection rollover happens early and does not rely on a message arriving', async t => {
  const f = fixture(); t.after(() => f.stream.close()); let resets = 0;
  f.stream.subscribePositions(credentials, { onReset: () => { resets += 1; } }); await f.bootPrivate();
  await f.advance((24 * 60 - 10) * 60_000); assert.equal(f.sockets[0].closed, true); assert.equal(resets, 1);
  await f.advance(1000); assert.equal(f.sockets.length, 2); f.sockets[1].open();
  assert.equal(await f.stream.order(credentials, spec), null);
});

test('oversize, malformed and unsafe rounded IDs fail closed without leaking raw input', async t => {
  for (const raw of ['x'.repeat(2 * 1024 * 1024 + 1), '{malformed fixture-secret',
    JSON.stringify({ e: 'ORDER_TRADE_UPDATE', E: EPOCH, T: EPOCH, o: {} })]) {
    const f = fixture(); t.after(() => f.stream.close()); const errors = [];
    f.stream.subscribePositions(credentials, { onError: cause => errors.push(cause) }); await f.bootPrivate();
    f.sockets[0].raw(raw); assert.equal(f.sockets[0].closed, true); assert.equal(errors[0].code, 'invalid_data');
    assert.doesNotMatch(errors[0].message, /fixture-secret/);
  }
});

test('caller abort detaches only its waiter; closing clears all sockets and prevents network resurrection', async () => {
  const f = fixture(), controller = new AbortController();
  const first = assert.rejects(f.stream.ready(credentials, { signal: controller.signal }), matches('aborted'));
  const second = f.stream.ready(credentials); await flush(); controller.abort(); await first;
  f.sockets[0].open(); await second;
  const book = assert.rejects(f.stream.book('ANTUSDT'), matches('aborted')); await flush();
  f.stream.close(); await book; assert.equal(f.timers.size, 0); assert.ok(f.sockets.every(socket => socket.closed));
  await f.advance(60 * 60_000); assert.equal(f.calls.length, 1); assert.equal(f.sockets.length, 2);
});

test('persistent connection failures have a full cooldown after five bounded retries', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  f.stream.subscribePositions(credentials, {});
  const pending = assert.rejects(f.stream.ready(credentials), matches('transport')); await flush();
  f.sockets[0].emit('error', { message: 'fixture-secret' }); await pending;
  for (const delay of [1000, 2000, 4000, 8000, 15_000]) {
    const count = f.calls.length;
    await f.advance(delay - 1); assert.equal(f.calls.length, count);
    await f.advance(1); assert.equal(f.calls.length, count + 1);
    f.sockets.at(-1).open(); f.sockets.at(-1).close();
  }
  const count = f.calls.length; await f.advance(59_999); assert.equal(f.calls.length, count);
  await f.advance(1); assert.equal(f.calls.length, count + 1);
});

test('order queries require the exact supplied symbol and identifiers without silently discarding invalid IDs', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate(); f.sockets[0].frame(f.orderFrame());
  assert.equal(await f.stream.order(credentials, { ...spec, symbol: 'ETHUSDT' }), null);
  assert.equal(await f.stream.order(credentials, { ...spec, clientId: 'different-client' }), null);
  assert.equal(await f.stream.order(credentials, { ...spec, id: '100' }), null);
  await assert.rejects(f.stream.order(credentials, { ...spec, id: {} }), matches('invalid_data'));
  await assert.rejects(f.stream.order(credentials, { ...spec, clientId: [] }), matches('invalid_data'));
});

test('order cache is bounded and unresolved mutation fences fail closed rather than evicting safety evidence', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate();
  for (let index = 0; index < 2001; index += 1) f.stream.seedOrder(credentials, f.row({ orderId: String(index), clientOrderId: `client-${index}` }));
  assert.equal(await f.stream.order(credentials, { symbol: 'ANTUSDT', id: '0' }), null);
  assert.equal((await f.stream.order(credentials, { symbol: 'ANTUSDT', id: '2000' })).orderId, '2000');
  for (let index = 0; index < 2000; index += 1) f.stream.invalidateOrder(credentials, { symbol: 'ANTUSDT', id: String(index), clientId: `client-${index}` });
  assert.throws(() => f.stream.invalidateOrder(credentials, { symbol: 'ANTUSDT', id: '2000', clientId: 'client-2000' }), matches('upstream'));
  assert.equal(f.sockets[0].closed, true);
});

test('clock rollback invalidates cached evidence, and idle sessions release their resources', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootPrivate(); f.sockets[0].frame(f.orderFrame());
  f.setTime(EPOCH - 1); await assert.rejects(f.stream.order(credentials, spec), matches('upstream'));
  assert.equal(f.sockets[0].closed, true);
  const g = fixture(); t.after(() => g.stream.close()); await g.bootPrivate();
  await g.advance(120_000); assert.equal(g.sockets[0].closed, true); assert.equal(g.timers.size, 0);
});

test('delayed private frames invalidate their generation as recoverable upstream failures, while invalid times remain hard failures', async t => {
  for (const kind of ['order', 'position']) {
    const f = fixture(); t.after(() => f.stream.close()); const errors = [], resets = [], events = [];
    f.stream.subscribePositions(credentials, { onError: cause => errors.push(cause), onReset: value => resets.push(value), onEvent: event => events.push(event) });
    const initial = await f.bootPrivate(); await f.bootBook();
    const delayed = kind === 'order' ? f.orderFrame() : f.positionFrame([{ s: 'ANTUSDT', ps: 'BOTH', pa: '2', ep: '100' }]);
    await f.advance(30_000);
    f.stream.seedOrder(credentials, f.row({ price: '101' }));
    assert.equal((await f.stream.order(credentials, spec)).price, '101');
    f.sockets[1].frame(f.bookFrame({ u: 2 }));
    f.sockets[0].frame(delayed);
    assert.equal(errors[0].code, 'upstream'); assert.equal(resets.length, 1);
    assert.equal(f.sockets[0].closed, true); assert.equal(f.sockets[1].closed, false);
    assert.equal(events.length, 0);
    await assert.rejects(f.stream.order(credentials, spec), matches('upstream'));
    await f.advance(1000); f.sockets.at(-1).open();
    assert.ok((await f.stream.ready(credentials)).generation > initial.generation);
    f.sockets[0].frame(f.orderFrame({ z: '4', ap: '100', X: 'FILLED' }));
    assert.equal(await f.stream.order(credentials, spec), null);
  }
  for (const envelope of [{ E: undefined }, { T: 'invalid' }]) {
    const f = fixture(); t.after(() => f.stream.close()); const errors = [];
    f.stream.subscribePositions(credentials, { onError: cause => errors.push(cause) }); await f.bootPrivate();
    f.sockets[0].frame(f.orderFrame({}, envelope)); assert.equal(errors[0].code, 'invalid_data');
  }
  // A future time reflects the local server-time estimate, not malformed data.
  for (const envelope of [{ E: EPOCH + 1001 }, { T: EPOCH + 1001 }]) {
    const f = fixture(); t.after(() => f.stream.close()); const errors = [];
    f.stream.subscribePositions(credentials, { onError: cause => errors.push(cause) }); await f.bootPrivate();
    f.sockets[0].frame(f.orderFrame({}, envelope)); assert.equal(errors[0].code, 'upstream');
  }
});

test('REST rows read while disconnected or across a reconnect are not seeded as current stream evidence', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const first = await f.bootPrivate();
  assert.equal(f.stream.orderGeneration(credentials), first.generation);
  // Disconnect: the gap's events will never be replayed by the next socket.
  f.sockets[0].close();
  assert.equal(f.stream.orderGeneration(credentials), null);
  assert.equal(f.stream.seedOrder(credentials, f.row()), false);
  assert.equal(f.stream.seedOrder(credentials, f.row(), { generation: first.generation }), false);
  await f.advance(1000); f.sockets.at(-1).open();
  const second = await f.stream.ready(credentials);
  assert.ok(second.generation > first.generation);
  // The order filled during the gap; no event arrives. A NEW row read before the
  // reconnect must not be returned as the current status.
  assert.equal(f.stream.seedOrder(credentials, f.row(), { generation: first.generation }), false);
  assert.equal(await f.stream.order(credentials, spec), null);
  assert.equal(f.stream.seedOrder(credentials, f.row(), { generation: second.generation }), true);
  assert.equal((await f.stream.order(credentials, spec)).status, 'NEW');
});
