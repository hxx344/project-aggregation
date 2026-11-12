import { Buffer } from 'node:buffer';
import { ondoWsLogin } from './exchange-transport/ondo.mjs';
import { decimalUnits } from './trading-decimal.mjs';

const URL = 'wss://api.ondoperps.xyz/ws';
const MAX_BYTES = 1024 * 1024;
const MAX_LEVELS = 200;
const CONNECT_MS = 8000, LOGIN_MS = 8000;
const PING_MS = 5000, SILENCE_MS = 15_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000], AUTH_RETRY_MS = 60_000;
const PRIVATE = ['ordersPerps', 'fillsPerps', 'positionsPerps'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function levels(rows, ascending) {
  if (!Array.isArray(rows) || rows.length > MAX_LEVELS) throw new Error('levels');
  let last = null;
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 2) throw new Error('level');
    const price = decimalUnits(row[0]), size = decimalUnits(row[1]);
    if (price <= 0n || size <= 0n || (last !== null && (ascending ? price <= last : price >= last))) throw new Error('level');
    last = price;
    return [price, size];
  });
}
/** One depth snapshot in exact units, or null when it is malformed or crossed. */
export function parseOndoBook(row) {
  try {
    const time = Date.parse(row.time);
    const bids = levels(row.bids, false), asks = levels(row.asks, true);
    if (!Number.isFinite(time) || (bids.length && asks.length && bids[0][0] >= asks[0][0])) return null;
    return { time, bids, asks };
  } catch { return null; }
}

// One socket: full depth snapshots of `markets` (about four a second) and,
// with credentials, the account's order, fill and position channels. It sends
// nothing but login, subscriptions and pings. A lost, silent or refused
// connection reports onDown at once (every book it gave is void) and is
// reopened after 1-30 s, 60 s after a refused login, without a retry limit:
// reconnecting places no order. Private payloads are passed on unparsed; the
// caller treats them as hints and reads the account over REST.
export function createOndoStream({ markets, credentials = null, depth = 50, onBook, onPrivate = () => {}, onDown = () => {},
  WebSocketImpl = globalThis.WebSocket, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const wanted = new Set(markets);
  let socket = null, era = 0, closed = false, started = false, failures = 0, lastFrame = 0, error = null;
  let open = false, loggedIn = false, subscribed = new Set();
  const timers = new Set();
  let retryTimer = null;

  function schedule(fn, ms) {
    const timer = setTimeoutImpl(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer); timer?.unref?.();
    return timer;
  }
  function clearTimers() { for (const timer of timers) clearTimeoutImpl(timer); timers.clear(); retryTimer = null; }
  function fail(reason, auth = false) {
    const old = socket;
    era += 1; socket = null; open = false; loggedIn = false; subscribed = new Set();
    clearTimers();
    error = reason;
    // Close reasons and socket errors are not propagated: they can echo credentials.
    try { old?.close(); } catch { /* already unusable */ }
    onDown(reason);
    if (closed) return;
    const wait = auth ? AUTH_RETRY_MS : RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
    failures += 1;
    retryTimer = schedule(() => { retryTimer = null; connect(); }, wait);
  }
  function send(value) {
    try { socket.send(JSON.stringify(value)); return true; } catch { fail('send_failed'); return false; }
  }
  function watch(current) {
    schedule(function beat() {
      if (current !== era || !open) return;
      if (now() - lastFrame >= SILENCE_MS) { fail('silent'); return; }
      if (send({ op: 'ping' }) && current === era) schedule(beat, PING_MS);
    }, PING_MS);
  }
  const privateReady = () => loggedIn && PRIVATE.every(channel => subscribed.has(channel));
  function receive(data) {
    const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    if (raw.length > MAX_BYTES) throw new Error('size');
    const message = JSON.parse(raw);
    if (!object(message)) throw new Error('shape');
    lastFrame = now();
    if (message.type === 'pong') return;
    if (message.type === 'loggedIn') {
      if (!credentials || loggedIn) return;
      loggedIn = true;
      for (const channel of PRIVATE) if (!send({ op: 'subscribe', channel })) return;
      return;
    }
    if (message.type === 'subscribed') {
      if (typeof message.channel === 'string') subscribed.add(message.channel);
      if (subscribed.has('depthBooksPerps') && (!credentials || privateReady())) { failures = 0; error = null; }
      return;
    }
    if (message.type === 'error') {
      // The text is not kept. An error before the private channels are confirmed is treated as a refused login.
      fail(credentials && !privateReady() ? 'login_refused' : 'venue_error', !!credentials && !privateReady());
      return;
    }
    if (message.type !== 'update' || typeof message.channel !== 'string') return;
    if (message.channel === 'depthBooksPerps') {
      if (!Array.isArray(message.data)) throw new Error('shape');
      for (const row of message.data) {
        if (!object(row) || !wanted.has(row.market)) continue;
        onBook(row.market, parseOndoBook(row), lastFrame);
      }
    } else if (PRIVATE.includes(message.channel) && privateReady()) onPrivate(message.channel, message.data);
  }
  function connect() {
    if (closed || socket) return;
    if (typeof WebSocketImpl !== 'function') { error = 'unsupported'; return; }
    const current = ++era;
    let ws;
    try { ws = new WebSocketImpl(URL); } catch { fail('connect_failed'); return; }
    socket = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* text frames only */ }
    const active = () => socket === ws && current === era && !closed;
    schedule(() => { if (active() && !open) fail('connect_timeout'); }, CONNECT_MS);
    ws.addEventListener('open', () => {
      if (!active()) return;
      open = true; lastFrame = now();
      if (!send({ op: 'subscribe', channel: 'depthBooksPerps', markets: [...wanted], limit: depth })) return;
      if (credentials) {
        let login;
        try { login = ondoWsLogin(credentials, String(Math.trunc(now()))); } catch { fail('login_refused', true); return; }
        if (!send(login)) return;
        schedule(() => { if (active() && !privateReady()) fail('login_timeout'); }, LOGIN_MS);
      }
      watch(current);
    });
    ws.addEventListener('message', event => {
      if (!active()) return;
      try { receive(event.data); } catch { if (active()) fail('invalid_data'); }
    });
    ws.addEventListener('error', () => { if (active()) fail('socket_error'); });
    ws.addEventListener('close', () => { if (active()) fail('disconnected'); });
  }
  return {
    start() { if (!started && !closed) { started = true; connect(); } },
    status: () => ({ connected: open, publicReady: open && subscribed.has('depthBooksPerps'), privateReady: open && privateReady(), lastFrameAt: lastFrame || null, error }),
    close() {
      if (closed) return;
      closed = true;
      const old = socket;
      era += 1; socket = null; open = false; loggedIn = false; subscribed = new Set();
      clearTimers();
      try { old?.close(); } catch { /* already unusable */ }
    },
  };
}
