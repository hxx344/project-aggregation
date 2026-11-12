import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOndoStream, parseOndoBook } from '../server/trading-ondo-stream.mjs';
import { formatDecimalUnits as f } from '../server/trading-decimal.mjs';

const EPOCH = 1_800_000_000_000;
const keys = { keyId: 'ondoKeyId_fixture', secret: 'ondoApiSecret_fixture-secret' };
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function fixture(options = {}) {
  let time = EPOCH, nextTimer = 0;
  const timers = new Map(), sockets = [], books = [], hints = [], downs = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = new Map(); this.closed = false; sockets.push(this); }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
    emit(name, value) { for (const fn of this.listeners.get(name) ?? []) fn(value); }
    send(text) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(text)); }
    frame(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    close() { this.closed = true; this.emit('close', {}); }
  }
  const stream = createOndoStream({ markets: ['NVDA-USD.P'], WebSocketImpl: Socket, now: () => time,
    setTimeoutImpl: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: time + ms }); return id; }, clearTimeoutImpl: id => timers.delete(id),
    onBook: (market, book, at) => books.push({ market, book, at }), onPrivate: (channel, data) => hints.push({ channel, data }), onDown: reason => downs.push(reason), ...options });
  async function advance(ms) {
    const until = time + ms;
    for (;;) {
      const first = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      timers.delete(first[0]); time = first[1].at; first[1].fn(); await flush();
    }
    time = until;
  }
  const depth = (extra = {}) => ({ type: 'update', channel: 'depthBooksPerps', timestamp: time, data: [{ market: 'NVDA-USD.P', time: new Date(time).toISOString(), asks: [['200.04', '10'], ['200.06', '20']], bids: [['200.00', '10'], ['199.98', '20']], ...extra }] });
  return { stream, sockets, books, hints, downs, advance, depth, now: () => time };
}

test('depth snapshots are parsed exactly and malformed or crossed ones become null', () => {
  const book = parseOndoBook({ time: '2026-11-12T18:30:26.554762785Z', asks: [['166.01', '56.97']], bids: [['165.95', '310.32'], ['165.93', '225.9']] });
  assert.equal(book.time, Date.parse('2026-11-12T18:30:26.554Z'));
  assert.deepEqual(book.bids.map(([price, size]) => [f(price), f(size)]), [['165.95', '310.32'], ['165.93', '225.9']]);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['165.95', '1']], bids: [['165.95', '1']] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [], bids: [['165.93', '1'], ['165.95', '1']] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['1e3', '1']], bids: [] }), null);
  assert.equal(parseOndoBook({ time: 'never', asks: [], bids: [] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['1', '0']], bids: [] }), null);
});

test('a public stream subscribes to depth only and passes each snapshot on', async () => {
  const s = fixture(); s.stream.start();
  const socket = s.sockets[0];
  assert.equal(socket.url, 'wss://api.ondoperps.xyz/ws');
  socket.emit('open');
  assert.deepEqual(socket.sent, [{ op: 'subscribe', channel: 'depthBooksPerps', markets: ['NVDA-USD.P'], limit: 50 }]);
  socket.frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  assert.deepEqual(s.stream.status(), { connected: true, publicReady: true, privateReady: false, lastFrameAt: EPOCH, error: null });
  socket.frame(s.depth());
  socket.frame(s.depth({ market: 'TSLA-USD.P' }));
  socket.frame(s.depth({ bids: [['200.04', '1']] }));
  assert.equal(s.books.length, 2);
  assert.equal(f(s.books[0].book.bids[0][0]), '200'); assert.equal(s.books[1].book, null);
  socket.frame({ type: 'update', channel: 'ordersPerps', data: [{ market: 'NVDA-USD.P' }] });
  assert.equal(s.hints.length, 0);
  s.stream.close();
  assert.equal(socket.closed, true); assert.deepEqual(s.downs, []);
});

test('with credentials the private channels follow a signed login', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  const socket = s.sockets[0];
  socket.emit('open');
  assert.deepEqual(socket.sent[1], { op: 'login', args: { key: keys.keyId, time: String(EPOCH), sign: createHmac('sha256', keys.secret).update(`${EPOCH}ondo_perps_ws_login`).digest('hex') } });
  socket.frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  socket.frame({ type: 'update', channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P' }] });
  assert.equal(s.hints.length, 0);
  assert.equal(s.stream.status().privateReady, false);
  socket.frame({ type: 'loggedIn' });
  assert.deepEqual(socket.sent.slice(2), ['ordersPerps', 'fillsPerps', 'positionsPerps'].map(channel => ({ op: 'subscribe', channel })));
  for (const channel of ['ordersPerps', 'fillsPerps', 'positionsPerps']) socket.frame({ type: 'subscribed', channel });
  assert.equal(s.stream.status().privateReady, true);
  socket.frame({ type: 'update', channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P', size: '0.5' }] });
  assert.deepEqual(s.hints, [{ channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P', size: '0.5' }] }]);
  s.stream.close();
});

test('a silent, broken or closed connection is reported down and reopened with backoff', async () => {
  const s = fixture(); s.stream.start();
  s.sockets[0].emit('open'); s.sockets[0].frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  await s.advance(5000);
  assert.deepEqual(s.sockets[0].sent.at(-1), { op: 'ping' });
  s.sockets[0].frame({ type: 'pong' });
  await s.advance(14_000);
  assert.deepEqual(s.downs, []);
  await s.advance(6000);
  assert.deepEqual(s.downs, ['silent']);
  assert.equal(s.stream.status().connected, false); assert.equal(s.sockets[0].closed, true);
  await s.advance(1000);
  assert.equal(s.sockets.length, 2);
  s.sockets[1].emit('open');
  s.sockets[1].frame('not json');
  assert.deepEqual(s.downs, ['silent', 'invalid_data']);
  await s.advance(1999);
  assert.equal(s.sockets.length, 2);
  await s.advance(1);
  assert.equal(s.sockets.length, 3);
  // A connection that never opens is dropped after the connect timeout.
  await s.advance(8000);
  assert.equal(s.downs.at(-1), 'connect_timeout');
  await s.advance(4000);
  assert.equal(s.sockets.length, 4);
  s.sockets[3].emit('open'); s.sockets[3].frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  s.sockets[3].close();
  assert.equal(s.downs.at(-1), 'disconnected');
  // A confirmed subscription resets the backoff.
  await s.advance(1000);
  assert.equal(s.sockets.length, 5);
  s.stream.close();
  await s.advance(120_000);
  assert.equal(s.sockets.length, 5);
});

test('a refused login waits a minute and never exposes the venue text', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  s.sockets[0].emit('open');
  s.sockets[0].frame({ type: 'error', msg: `bad key ${keys.keyId}` });
  assert.deepEqual(s.downs, ['login_refused']);
  assert.ok(!JSON.stringify(s.stream.status()).includes(keys.keyId));
  await s.advance(59_999);
  assert.equal(s.sockets.length, 1);
  await s.advance(1);
  assert.equal(s.sockets.length, 2);
  // A login that is never answered is dropped as well.
  s.sockets[1].emit('open');
  await s.advance(8000);
  assert.equal(s.downs.at(-1), 'login_timeout');
  s.stream.close();
});
