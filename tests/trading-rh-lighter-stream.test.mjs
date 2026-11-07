import test from 'node:test';
import assert from 'node:assert/strict';
import { createRhLighterStream } from '../server/trading-rh-lighter-stream.mjs';

const EPOCH = 1_800_000_000_000;
class UpstreamError extends Error {
  constructor(code, options = {}) { super(code); this.code = code; Object.assign(this, options); }
}
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function fixture(options = {}) {
  let time = EPOCH, nextTimer = 0;
  const timers = new Map(), sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = new Map(); this.closed = false; sockets.push(this); }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
    emit(name, value) { for (const fn of this.listeners.get(name) ?? []) fn(value); }
    send(text) { if (this.closed) throw new Error('secret must never escape'); this.sent.push(JSON.parse(text)); }
    frame(value) { this.emit('message', { data: JSON.stringify(value) }); }
    connected() { this.frame({ type: 'connected' }); }
    close() { this.closed = true; this.emit('close', {}); }
  }
  const stream = createRhLighterStream({ ErrorClass: UpstreamError, WebSocketImpl: Socket, now: () => time,
    setTimeoutImpl: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeoutImpl: id => timers.delete(id), ...options });
  const auth = { token: 'test-auth-token', tokenExpiresAt: EPOCH + 600_000, identity: 'credential-fingerprint' };
  const readOrder = (extra = {}, index = 7) => stream.order(38, 12, index, { ...auth, ...extra });
  async function advance(ms) {
    await flush();
    const until = time + ms;
    for (;;) {
      const first = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, value] = first;
      timers.delete(id); time = value.at; value.fn(); await flush();
    }
    time = until; await flush();
  }
  const ticker = (nonce = 1, extra = {}) => ({ type: 'subscribed/ticker', channel: 'ticker:38', nonce,
    timestamp: time, last_updated_at: time * 1000,
    ticker: { s: 'ANT', b: { price: '100', size: '2' }, a: { price: '101', size: '3' }, last_updated_at: time * 1000 }, ...extra });
  const row = (extra = {}) => ({ market_index: 38, owner_account_index: 12, client_order_index: 7, client_order_id: '7',
    order_index: 99, order_id: '99', order_version: 1, nonce: 1, status: 'open', filled_base_amount: '0', filled_quote_amount: '0', ...extra });
  const orderFrame = (rows = [], nonce = 1, extra = {}) => ({ type: 'subscribed/account_orders', channel: 'account_orders:38',
    account: 12, nonce, orders: { 38: rows }, ...extra });
  async function bootBook() {
    const pending = stream.book(38, 'ANT'); sockets.at(-1).connected(); sockets.at(-1).frame(ticker()); return pending;
  }
  async function bootOrder(rows = [row()]) {
    const pending = readOrder(); sockets.at(-1).connected(); sockets.at(-1).frame(orderFrame(rows)); return pending;
  }
  return { stream, sockets, timers, auth, readOrder, advance, ticker, row, orderFrame, bootBook, bootOrder,
    now: () => time, setTime: value => { time = value; } };
}
const upstream = error => error instanceof UpstreamError && error.code === 'upstream';
const invalidData = error => error instanceof UpstreamError && error.code === 'invalid_data';

test('ticker shares one fixed-host socket and only a subscription snapshot makes it ready', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  let resolved = false;
  const first = f.stream.book(38, 'ANT').then(value => { resolved = true; return value; });
  const second = f.stream.book(38, 'ANT');
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'wss://api.rh.lighter.xyz/stream');
  assert.equal(f.sockets[0].sent.length, 0);
  f.sockets[0].connected();
  assert.deepEqual(f.sockets[0].sent, [{ type: 'subscribe', channel: 'ticker/38' }]);
  f.sockets[0].frame(f.ticker(2, { type: 'update/ticker' })); await flush();
  assert.equal(resolved, false);
  f.sockets[0].frame(f.ticker(2));
  const expected = { bid: '100', ask: '101', at: EPOCH };
  assert.deepEqual(await first, expected); assert.deepEqual(await second, expected);
});

test('nonce gaps are valid; duplicate and out-of-order frames cannot renew quote time', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook();
  await f.advance(1000);
  f.sockets[0].frame(f.ticker(50, { type: 'update/ticker' }));
  assert.equal((await f.stream.book(38, 'ANT')).at, EPOCH + 1000);
  await f.advance(1000);
  f.sockets[0].frame(f.ticker(50, { type: 'update/ticker' }));
  f.sockets[0].frame(f.ticker(49, { type: 'update/ticker' }));
  assert.equal((await f.stream.book(38, 'ANT')).at, EPOCH + 1000);
  await f.advance(4100);
  const stale = assert.rejects(f.stream.book(38, 'ANT'), upstream);
  await f.advance(5000); await stale;
});

test('expired, future, crossed, zero-size and mismatched-symbol quotes fail closed', async t => {
  const cases = [
    f => ({ timestamp: f.now() - 5001 }),
    f => ({ last_updated_at: (f.now() + 1001) * 1000 }),
    f => ({ ticker: { ...f.ticker().ticker, a: { price: '99', size: '1' } } }),
    f => ({ ticker: { ...f.ticker().ticker, b: { price: '100', size: '0' } } }),
    f => ({ ticker: { ...f.ticker().ticker, s: 'OTHER' } }),
    () => ({ timestamp: EPOCH / 1000 }),
  ];
  for (const [index, invalid] of cases.entries()) {
    const f = fixture(); t.after(() => f.stream.close());
    const pending = assert.rejects(f.stream.book(38, 'ANT'), index === 0 ? upstream : invalidData);
    f.sockets[0].connected(); f.sockets[0].frame(f.ticker(1, invalid(f))); await pending;
    assert.equal(f.sockets[0].closed, true);
  }
});

test('source time and local receive time both constrain freshness', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const pending = f.stream.book(38, 'ANT'); f.sockets[0].connected();
  f.sockets[0].frame(f.ticker(1, { timestamp: EPOCH - 4500 }));
  assert.equal((await pending).at, EPOCH);
  await f.advance(501);
  const stale = assert.rejects(f.stream.book(38, 'ANT'), upstream); await f.advance(5000); await stale;
});

test('private snapshot is independent of public health and missing orders return null without REST', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected REST request'); });
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook();
  let completed = false;
  const pending = f.readOrder().then(value => { completed = true; return value; });
  await flush();
  assert.deepEqual(f.sockets[0].sent.at(-1), { type: 'subscribe', channel: 'account_orders/38/12', auth: f.auth.token });
  f.sockets[0].frame(f.ticker(2)); await flush(); assert.equal(completed, false);
  f.sockets[0].frame(f.orderFrame()); assert.equal(await pending, null);
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.sockets[0].sent.map(row => row.type), ['subscribe', 'subscribe']);
  assert.equal(fetch.mock.callCount(), 0);
});

test('public updates do not prevent missing private subscription from timing out', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook();
  const pending = assert.rejects(f.readOrder(), upstream);
  for (let index = 0; index < 4; index += 1) { await f.advance(1000); f.sockets[0].frame(f.ticker(index + 2)); }
  await f.advance(1000); await pending; assert.equal(f.sockets[0].closed, true);
});

test('order identity validates envelope, market, owner and numeric/string client identifiers', async t => {
  const invalid = [
    f => f.orderFrame([f.row()], 1, { account: 13 }),
    f => f.orderFrame([f.row({ owner_account_index: 13 })]),
    f => f.orderFrame([f.row({ market_index: 37 })]),
    f => f.orderFrame([f.row({ client_order_id: '8' })]),
    f => f.orderFrame([f.row({ order_id: '100' })]),
    f => f.orderFrame([f.row({ client_order_index: 1.2 })]),
    f => f.orderFrame([f.row({ client_order_index: undefined, client_order_id: undefined })]),
    f => f.orderFrame([f.row({ client_order_index: 0, client_order_id: '0', owner_account_index: 13 })]),
    f => f.orderFrame([f.row()], -1),
    f => f.orderFrame([f.row(), f.row()]),
    f => f.orderFrame([], 1, { orders: { 37: [f.row()] } }),
  ];
  for (const frame of invalid) {
    const f = fixture(); t.after(() => f.stream.close());
    const pending = assert.rejects(f.readOrder(), invalidData); f.sockets[0].connected(); f.sockets[0].frame(frame(f)); await pending;
  }
});

test('manual rows with client index 0 are skipped instead of vetoing the snapshot', async t => {
  for (const foreign of [{ client_order_index: 0, client_order_id: '0' }, { client_order_index: 0, client_order_id: undefined }]) {
    const f = fixture(); t.after(() => f.stream.close());
    const pending = f.readOrder(); f.sockets[0].connected();
    f.sockets[0].frame(f.orderFrame([f.row({ ...foreign, order_index: 500, order_id: '500', status: 'unexpected' }), f.row()]));
    const row = await pending;
    assert.equal(row.client_order_index, 7); assert.equal(row.order_index, 99);
    assert.equal(f.sockets[0].closed, false);
  }
});

test('order row ordering ignores old versions and rejects terminal resurrection as invalid data', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const update = (row, nonce) => f.sockets[0].frame(f.orderFrame([row], nonce, { type: 'update/account_orders' }));
  update(f.row({ order_version: 2, nonce: 2, filled_base_amount: '2', filled_quote_amount: '200' }), 10);
  assert.equal((await f.readOrder()).order_version, 2);
  update(f.row({ order_version: 1, nonce: 3 }), 20);
  assert.equal((await f.readOrder()).filled_base_amount, '2');
  update(f.row({ order_version: 3, nonce: 5, status: 'filled', filled_base_amount: '3', filled_quote_amount: '300' }), 40);
  update(f.row({ order_version: 2, nonce: 4, filled_base_amount: '2', filled_quote_amount: '200' }), 50);
  assert.equal((await f.readOrder()).status, 'filled');
  f.sockets[0].frame(f.orderFrame([], 60, { type: 'subscribed/account_orders' }));
  assert.equal((await f.readOrder()).status, 'filled');
  update(f.row({ order_version: 4, nonce: 6, filled_base_amount: '3', filled_quote_amount: '300' }), 70);
  await assert.rejects(f.readOrder(), invalidData);
});

test('private envelopes may reuse, omit or decrease nonce while maker fills still advance', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  for (const [index, nonce] of [1, undefined, 0].entries()) {
    const filled = String(index + 1);
    f.sockets[0].frame(f.orderFrame([f.row({ filled_base_amount: filled, filled_quote_amount: String((index + 1) * 100) })], nonce,
      { type: 'update/account_orders', nonce }));
    assert.equal((await f.readOrder()).filled_base_amount, filled);
  }
  assert.equal(f.sockets.length, 1);
});

test('buy-side queue nonces may decrease without hiding newer versions or additional fills', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  await f.bootOrder([f.row({ order_version: 4, nonce: 100, price: '100', filled_base_amount: '3', filled_quote_amount: '300' })]);
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 5, nonce: 99, price: '101', filled_base_amount: '5', filled_quote_amount: '502' })], 1, { type: 'update/account_orders' }));
  const modified = await f.readOrder({ minVersion: 5 });
  assert.deepEqual([modified.order_version, modified.nonce, modified.filled_base_amount, modified.price], [5, 99, '5', '101']);
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 5, nonce: 98, price: '101', filled_base_amount: '6', filled_quote_amount: '603' })], 1, { type: 'update/account_orders' }));
  assert.equal((await f.readOrder()).filled_base_amount, '6');
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 4, nonce: 100, price: '100', filled_base_amount: '3', filled_quote_amount: '300' })], 2, { type: 'update/account_orders' }));
  assert.equal((await f.readOrder()).order_version, 5);
});

test('private expiry is enforced at read time even when the refresh timer has not run', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  f.setTime(EPOCH + 29_999); assert.equal((await f.readOrder()).status, 'open');
  f.setTime(EPOCH + 31_000);
  let returned = false;
  const pending = f.readOrder().then(value => { returned = true; return value; });
  await flush();
  assert.equal(returned, false);
  assert.deepEqual(f.sockets[0].sent.filter(message => message.channel === 'account_orders/38/12').map(message => message.type), ['subscribe', 'unsubscribe', 'subscribe']);
  f.sockets[0].frame(f.orderFrame([f.row({ status: 'filled', filled_base_amount: '1', filled_quote_amount: '100' })]));
  assert.equal((await pending).status, 'filled');
});

test('a private snapshot that expires during a resolved wait cannot be returned', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const pending = assert.rejects(f.readOrder({ minVersion: 2, waitMs: 1500 }), upstream);
  await flush();
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 2, nonce: 2 })], 2, { type: 'update/account_orders' }));
  f.setTime(EPOCH + 31_000);
  await pending;
  assert.equal(f.sockets[0].sent.filter(message => message.type === 'subscribe').length, 2);
});

test('private snapshot permits absent envelope nonce but rejects a present invalid nonce', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const pending = f.readOrder(); f.sockets[0].connected(); f.sockets[0].frame(f.orderFrame([f.row()], 1, { nonce: undefined }));
  assert.equal((await pending).status, 'open');
  f.sockets[0].frame(f.orderFrame([], 1, { nonce: null, type: 'update/account_orders' }));
  await assert.rejects(f.readOrder(), invalidData);
});

test('public traffic cannot renew private health; silence refreshes the private snapshot without REST', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected REST request'); });
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook(); await f.bootOrder();
  for (let index = 1; index <= 3; index += 1) {
    await f.advance(10_000); f.sockets[0].frame(f.ticker(index + 1)); f.sockets[0].frame({ type: 'pong' });
  }
  const controls = f.sockets[0].sent.filter(value => value.channel === 'account_orders/38/12');
  assert.deepEqual(controls.map(value => value.type), ['subscribe', 'unsubscribe', 'subscribe']);
  assert.equal(controls[2].auth, f.auth.token);
  let resolved = false;
  const pending = f.readOrder().then(value => { resolved = true; return value; }); await flush();
  f.sockets[0].frame(f.orderFrame([f.row({ filled_base_amount: '1', filled_quote_amount: '100' })], 1,
    { type: 'update/account_orders' })); await flush(); assert.equal(resolved, false);
  f.sockets[0].frame(f.orderFrame([f.row({ filled_base_amount: '2', filled_quote_amount: '200' })], 1));
  assert.equal((await pending).filled_base_amount, '2'); assert.equal(f.sockets.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test('duplicate private rows do not postpone the private refresh deadline', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  await f.advance(15_000);
  f.sockets[0].frame(f.orderFrame([f.row()], 999, { type: 'update/account_orders' }));
  await f.advance(15_000);
  assert.deepEqual(f.sockets[0].sent.filter(value => value.channel).map(value => value.type), ['subscribe', 'unsubscribe', 'subscribe']);
});

test('a same-nonce fill update renews private evidence without requiring a REST poll', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder(); await f.advance(20_000);
  f.sockets[0].frame(f.orderFrame([f.row({ filled_base_amount: '1', filled_quote_amount: '100' })], 1,
    { type: 'update/account_orders' }));
  await f.advance(10_000); assert.equal(f.sockets[0].sent.filter(value => value.type === 'subscribe').length, 1);
  await f.advance(20_000); assert.equal(f.sockets[0].sent.filter(value => value.type === 'subscribe').length, 2);
});

test('private refresh loses cached authority immediately and closes if its new snapshot misses the five-second deadline', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook(); await f.bootOrder(); await f.advance(30_000);
  const pending = assert.rejects(f.readOrder(), upstream);
  for (let index = 1; index <= 4; index += 1) { await f.advance(1000); f.sockets[0].frame(f.ticker(index + 1)); }
  assert.equal(f.sockets[0].closed, false);
  await f.advance(1000); await pending; assert.equal(f.sockets[0].closed, true);
});

test('conflicting immutable fields and unchanged-version price or quantity are hard errors until a fresh snapshot', async t => {
  const baseline = { is_ask: false, side: 'buy', reduce_only: false, type: 'limit', time_in_force: 'post-only',
    market_symbol: 'ANT', market_kind: 'perps', price: '100', initial_base_amount: '5', remaining_base_amount: '5', base_size: 500, base_price: 10_000 };
  const conflicts = [{ is_ask: true }, { side: 'sell' }, { reduce_only: true }, { type: 'market' }, { time_in_force: 'good-till-time' },
    { market_symbol: 'OTHER' }, { market_kind: 'spot' }, { price: '101' }, { initial_base_amount: '6' },
    { remaining_base_amount: '4' }, { base_size: 600 }, { base_price: 10_100 }];
  for (const conflict of conflicts) {
    const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder([f.row(baseline)]);
    const waiting = assert.rejects(f.readOrder({ minVersion: 2, waitMs: 1500 }), invalidData); await flush();
    f.sockets[0].frame(f.orderFrame([f.row({ ...baseline, ...conflict })], 1, { type: 'update/account_orders' })); await waiting;
    await assert.rejects(f.readOrder(), invalidData);
    await f.advance(1000); f.sockets[1].connected();
    const recovered = f.readOrder(); f.sockets[1].frame(f.orderFrame([f.row(baseline)]));
    assert.equal((await recovered).price, '100');
  }
});

test('new-version quantity changes remain visible to adapter inspection, but cumulative fills cannot regress', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder([f.row({ price: '100', initial_base_amount: '5' })]);
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 2, nonce: 2, price: '101', initial_base_amount: '6',
    filled_base_amount: '2', filled_quote_amount: '202' })], 1, { type: 'update/account_orders' }));
  assert.equal((await f.readOrder()).initial_base_amount, '6');
  f.sockets[0].frame(f.orderFrame([f.row({ order_version: 2, nonce: 2, price: '101', initial_base_amount: '6',
    filled_base_amount: '1', filled_quote_amount: '101' })], 1, { type: 'update/account_orders' }));
  await assert.rejects(f.readOrder(), invalidData);
});

test('waiting for modify ignores older working versions, accepts a newer version and returns independent copies', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  let completed = false;
  const pending = f.readOrder({ minVersion: 2, waitMs: 1500 }).then(value => { completed = true; return value; }); await flush();
  f.sockets[0].frame(f.orderFrame([f.row({ nonce: 2 })], 2, { type: 'update/account_orders' }));
  await flush(); assert.equal(completed, false);
  f.sockets[0].frame(f.orderFrame([f.row({ nonce: 3, order_version: 2, price: '102' })], 8, { type: 'update/account_orders' }));
  const result = await pending; assert.equal(result.price, '102'); result.price = 'wrong';
  assert.equal((await f.readOrder()).price, '102');
});

test('known terminal original order settles a pending modify even below its requested version', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const pending = f.readOrder({ minVersion: 2, waitMs: 1500 }); await flush();
  f.sockets[0].frame(f.orderFrame([f.row({ nonce: 2, status: 'canceled' })], 2, { type: 'update/account_orders' }));
  assert.equal((await pending).status, 'canceled');
});

test('missing or older orders time out as null; abort removes only the aborted waiter', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const first = f.readOrder({ minVersion: 2, waitMs: 1500 }); await flush(); await f.advance(1500); assert.equal(await first, null);
  const abort = new AbortController();
  const aborted = assert.rejects(f.readOrder({ waitMs: 1500, signal: abort.signal }, 8), error => error.code === 'aborted');
  const other = f.readOrder({ waitMs: 1500 }, 8); await flush(); abort.abort(); await aborted;
  f.sockets[0].frame(f.orderFrame([f.row({ client_order_index: 8, client_order_id: '8', order_index: 100, order_id: '100' })], 2,
    { type: 'update/account_orders' }));
  assert.equal((await other).client_order_index, 8);
});

test('disconnect invalidates caches, rejects in-flight waits and ignores old socket frames after reconnection', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const pending = assert.rejects(f.readOrder({ waitMs: 1500 }, 8), upstream); await flush();
  const old = f.sockets[0]; old.close(); await pending;
  await assert.rejects(f.readOrder(), upstream);
  await f.advance(1000); const current = f.sockets[1]; current.connected();
  const read = f.readOrder(); old.frame(f.orderFrame([f.row({ status: 'filled' })], 99));
  current.frame(f.orderFrame([], 1)); assert.equal(await read, null);
  current.frame(f.orderFrame([f.row({ nonce: 2 })], 2, { type: 'update/account_orders' }));
  assert.equal((await f.readOrder()).status, 'open');
});

test('credential identity and token rotations force fresh socket snapshots and discard old rows', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  for (const patch of [{ token: 'rotated-token' }, { identity: 'new-credential-fingerprint' }]) {
    Object.assign(f.auth, patch);
    const old = f.sockets.at(-1), pending = f.readOrder();
    assert.equal(old.closed, true);
    const ws = f.sockets.at(-1); assert.notEqual(ws, old); ws.connected();
    assert.equal(ws.sent[0].auth, f.auth.token);
    old.frame(f.orderFrame([f.row({ status: 'filled' })], 9)); ws.frame(f.orderFrame()); assert.equal(await pending, null);
  }
});

test('expired auth invalidates private subscription without waiting for another caller', async t => {
  const f = fixture(); t.after(() => f.stream.close()); f.auth.tokenExpiresAt = EPOCH + 1000; await f.bootOrder();
  await f.advance(1000); assert.equal(f.sockets[0].closed, true); await assert.rejects(f.readOrder(), upstream);
});

test('known authentication errors remain permission failures until a refreshed token replaces the rejected token', async t => {
  for (const providerCode of [20013, 21109, 21120]) {
    const f = fixture(); t.after(() => f.stream.close());
    const permission = error => error.code === 'permissions' && error.providerCode === providerCode
      && !JSON.stringify(error).includes('secret');
    const first = assert.rejects(f.readOrder(), permission); f.sockets[0].connected();
    f.sockets[0].frame({ error: { code: providerCode, message: 'secret:test-auth-token' } }); await first;
    await assert.rejects(f.readOrder(), permission); await f.advance(1000); await assert.rejects(f.readOrder(), permission);
    assert.equal(f.sockets.length, 1);
    f.auth.token = 'refreshed-token';
    const recovered = f.readOrder(); f.sockets[1].connected(); f.sockets[1].frame(f.orderFrame()); assert.equal(await recovered, null);
  }
});

test('waiting for the connected envelope has a five-second deadline', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const pending = assert.rejects(f.stream.book(38, 'ANT'), upstream);
  await f.advance(4999); assert.equal(f.sockets[0].closed, false);
  await f.advance(1); await pending; assert.equal(f.sockets[0].closed, true);
});

test('heartbeat keeps the connection alive without renewing quote receive time', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook();
  await f.advance(30_000); assert.deepEqual(f.sockets[0].sent.at(-1), { type: 'ping' });
  f.sockets[0].frame({ type: 'pong' });
  const stale = assert.rejects(f.stream.book(38, 'ANT'), upstream); await f.advance(5000); await stale;
  assert.equal(f.sockets[0].closed, false);
  f.sockets[0].frame({ type: 'ping' }); assert.deepEqual(f.sockets[0].sent.at(-1), { type: 'pong' });
});

test('silent connections close after bounded inactivity and successful snapshots reset backoff', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook(); await f.advance(45_000);
  assert.equal(f.sockets[0].closed, true); await f.advance(1000);
  f.sockets[1].connected(); f.sockets[1].frame(f.ticker(1)); f.sockets[1].close();
  await f.advance(1000); assert.equal(f.sockets.length, 3);
});

test('connection attempts and subscription failures use bounded backoff then a 60s cooldown', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const first = assert.rejects(f.stream.book(38, 'ANT'), upstream);
  f.sockets[0].close(); await first;
  for (const [index, delay] of [1000, 2000, 4000, 8000, 15_000].entries()) {
    await assert.rejects(f.stream.book(38, 'ANT'), upstream);
    await f.advance(delay - 1); assert.equal(f.sockets.length, index + 1);
    await f.advance(1); assert.equal(f.sockets.length, index + 2); f.sockets.at(-1).close();
  }
  await f.advance(30_000); await assert.rejects(f.stream.book(38, 'ANT'), upstream);
  await f.advance(29_999); assert.equal(f.sockets.length, 6);
  await f.advance(1); assert.equal(f.sockets.length, 7);
});

test('all documented WS rate-limit codes enforce cooldown across forget and credential changes without leaking errors', async t => {
  for (const code of [23000, 23001, 23002, 23003]) {
    const f = fixture(); t.after(() => f.stream.close());
    const limited = error => upstream(error) && error.rateLimited === true && error.retryAt === EPOCH + 60_000
      && error.providerCode === code && !JSON.stringify(error).includes('secret');
    const pending = assert.rejects(f.readOrder(), limited);
    f.sockets[0].connected(); f.sockets[0].frame({ error: { code, message: 'secret:test-auth-token' } }); await pending;
    f.stream.forget(); Object.assign(f.auth, { token: 'next-token' });
    await assert.rejects(f.readOrder(), limited); assert.equal(f.sockets.length, 1);
    await f.advance(59_999); await assert.rejects(f.readOrder(), limited); assert.equal(f.sockets.length, 1);
    await f.advance(1); const next = f.readOrder(); f.sockets.at(-1).connected(); f.sockets.at(-1).frame(f.orderFrame()); assert.equal(await next, null);
  }
});

test('oversized and malformed messages terminate safely without echoing message bodies', async t => {
  for (const data of ['x'.repeat(2 * 1024 * 1024 + 1), '{secret:invalid-json']) {
    const f = fixture(); t.after(() => f.stream.close());
    const pending = assert.rejects(f.readOrder(), error => invalidData(error) && !JSON.stringify(error).includes('secret'));
    f.sockets[0].connected(); f.sockets[0].emit('message', { data }); await pending;
  }
});

test('order cache is bounded and eviction returns unknown rather than fabricating a terminal state', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootOrder();
  const rows = Array.from({ length: 2000 }, (_, index) => f.row({ client_order_index: 100 + index, client_order_id: String(100 + index),
    order_index: 1000 + index, order_id: String(1000 + index) }));
  f.sockets[0].frame(f.orderFrame(rows, 2, { type: 'update/account_orders' }));
  assert.equal(await f.readOrder(), null); assert.equal((await f.readOrder({}, 2099)).client_order_index, 2099);
});

test('clock rollback invalidates cached quotes', async t => {
  const f = fixture(); t.after(() => f.stream.close()); await f.bootBook(); f.setTime(EPOCH - 1);
  await assert.rejects(f.stream.book(38, 'ANT'), upstream); assert.equal(f.sockets[0].closed, true);
});

test('idle release, forget and permanent close clean all timers and waiters', async () => {
  const f = fixture(); await f.bootBook();
  await f.advance(30_000); f.sockets[0].frame({ type: 'pong' }); await f.advance(30_000);
  assert.equal(f.sockets[0].closed, true); assert.equal(f.timers.size, 0);
  const waiting = assert.rejects(f.stream.book(38, 'ANT'), error => error.code === 'aborted');
  f.stream.forget(); await waiting; assert.equal(f.timers.size, 0);
  const again = f.bootBook(); assert.equal((await again).bid, '100');
  f.stream.close(); assert.equal(f.timers.size, 0); await assert.rejects(f.stream.book(38, 'ANT'), upstream);
  assert.equal(f.timers.size, 0);
});

test('a disconnect after a resolving snapshot cannot return a prior generation result', async t => {
  const f = fixture(); t.after(() => f.stream.close());
  const pending = assert.rejects(f.readOrder(), upstream); f.sockets[0].connected();
  f.sockets[0].frame(f.orderFrame([f.row()])); f.sockets[0].close(); await pending;
});
