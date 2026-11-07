import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { compareDecimals, decimal } from './trading-decimal.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 32;
const MAX_ORDERS = 2000;
const MAX_WAITERS = 128;
const ORDER_AGE_MS = 30_000;
const IDLE_MS = 120_000;
const KEEPALIVE_MS = 30 * 60_000;
const TOKEN_MS = 60 * 60_000;
const ROLLOVER_MS = (24 * 60 - 10) * 60_000;
const RETRIES = [1000, 2000, 4000, 8000, 15_000];
const TERMINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);
const STATUS = new Set(['NEW', 'PARTIALLY_FILLED', ...TERMINAL]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const symbolOk = value => typeof value === 'string' && /^[\p{L}\p{N}_]{1,80}$/u.test(value);
const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const clientId = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value) ? value : null;

export class BinanceStreamError extends Error {
  constructor(code, { detail, providerCode, rateLimited, retryAt } = {}) {
    super(detail ?? 'Binance WebSocket 暂时不可用');
    this.name = 'BinanceStreamError'; this.code = code;
    if (detail) this.detail = detail;
    if (Number.isSafeInteger(providerCode)) this.providerCode = providerCode;
    if (rateLimited) this.rateLimited = true;
    if (Number.isFinite(retryAt)) this.retryAt = retryAt;
  }
}
const error = (code, detail, extra) => new BinanceStreamError(code, { detail: `Binance WebSocket：${detail}`, ...extra });
const invalid = () => error('invalid_data', '上游数据格式或身份不匹配');
const aborted = () => error('aborted', '读取已取消');

// Node 24 preserves the JSON token, including integer IDs beyond 2^53.
// Never convert an already-rounded unsafe Number back to an order ID.
function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && /^(i|orderId|u|t)$/.test(key)) {
      if (!/^\d{1,30}$/.test(context?.source ?? '')) throw invalid();
      return context.source;
    }
    return value;
  });
}

function modeOf(mode = 'standard') {
  if (!['standard', 'portfolio-margin'].includes(mode)) throw invalid();
  return mode;
}
function credentialsOf(credentials) {
  if (!object(credentials) || typeof credentials.apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.apiKey)
    || typeof credentials.apiSecret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.apiSecret)) throw invalid();
  return { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret };
}
function normalizeOrder(row) {
  if (!object(row) || !symbolOk(row.symbol) || !id(row.orderId) || !clientId(row.clientOrderId)
    || !['BUY', 'SELL'].includes(row.side) || !['BOTH', 'LONG', 'SHORT'].includes(row.positionSide)
    || typeof row.reduceOnly !== 'boolean' || !STATUS.has(row.status) || !timestamp(row.updateTime)
    || typeof row.type !== 'string' || !/^[A-Z_]{1,40}$/.test(row.type)
    || !['GTC', 'IOC', 'FOK', 'GTX', 'GTD'].includes(row.timeInForce)) throw invalid();
  const result = { symbol: row.symbol, orderId: id(row.orderId), clientOrderId: row.clientOrderId,
    side: row.side, positionSide: row.positionSide, reduceOnly: row.reduceOnly,
    origQty: decimal(row.origQty, { positive: true }), executedQty: decimal(row.executedQty, { nonnegative: true }),
    avgPrice: decimal(row.avgPrice, { nonnegative: true }), price: decimal(row.price, { nonnegative: true }),
    status: row.status, type: row.type, timeInForce: row.timeInForce, updateTime: row.updateTime };
  if (compareDecimals(result.executedQty, result.origQty) > 0
    || row.status === 'FILLED' && compareDecimals(result.executedQty, result.origQty) !== 0
    || row.status === 'NEW' && result.executedQty !== '0'
    || row.status === 'PARTIALLY_FILLED' && (result.executedQty === '0' || result.executedQty === result.origQty)) throw invalid();
  if (row.time !== undefined) { if (!timestamp(row.time)) throw invalid(); result.time = row.time; }
  return result;
}

// Only listenKey lifecycle HTTP is allowed here. Callers own baseline/risk REST
// reads and exact-order recovery. An open socket is never a complete snapshot or
// trading permission. Readonly and execution instances share no mutable state.
export function createBinanceStreams({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  now = Date.now, exchangeNow = now, purpose = 'execution', timeoutMs = 5000, maxBookAgeMs = 5000,
  ensureClock = async () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!['execution', 'readonly'].includes(purpose)) throw invalid();
  const timeout = Math.max(1, Math.min(5000, Number(timeoutMs) || 5000));
  const bookAge = Math.max(1, Math.min(5000, Number(maxBookAgeMs) || 5000));
  const sessions = new Map();
  let closed = false, era = 0, lastClock = now();

  function schedule(session, fn, ms, background = true) {
    const timer = setTimeoutImpl(() => { session.timers.delete(timer); fn(); }, Math.max(1, ms));
    session.timers.add(timer); if (background) timer?.unref?.(); return timer;
  }
  function cancel(session, timer) {
    if (timer !== null && timer !== undefined) { clearTimeoutImpl(timer); session.timers.delete(timer); }
  }
  function safeCall(fn, value) { try { fn?.(value); } catch { /* Observer errors never escape the stream boundary. */ } }
  function settle(session, waiter, cause, value) {
    if (!session.waiters.delete(waiter)) return;
    cancel(session, waiter.timer); waiter.signal?.removeEventListener('abort', waiter.abort);
    if (cause) waiter.reject(cause); else waiter.resolve(value);
  }
  function notify(session) {
    for (const waiter of [...session.waiters]) {
      if (now() >= waiter.deadline) { settle(session, waiter, error('timeout', '等待数据超时')); continue; }
      const value = waiter.read(); if (value !== undefined) settle(session, waiter, null, value);
    }
  }
  function wait(session, read, signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    const value = read(); if (value !== undefined) return Promise.resolve(value);
    if (session.waiters.size >= MAX_WAITERS) return Promise.reject(error('upstream', '等待队列已满'));
    return new Promise((resolve, reject) => {
      const waiter = { read, resolve, reject, signal, deadline: now() + timeout, timer: null, abort: null };
      waiter.abort = () => settle(session, waiter, aborted());
      session.waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true });
      waiter.timer = schedule(session, () => {
        settle(session, waiter, error('timeout', '等待数据超时'));
        if (session.kind === 'book' && !freshBook(session)) fail(session, error('timeout', '盘口更新超时'));
      }, timeout, false);
      if (signal?.aborted) waiter.abort();
    });
  }
  function detach(session, cause, remove = false) {
    session.generation = ++era;
    const socket = session.socket;
    session.socket = null; session.connected = false; session.connecting = false; session.book = null;
    session.orders.clear(); session.fences.clear(); session.token = null; session.tokenUntil = 0;
    for (const timer of [...session.timers]) cancel(session, timer);
    session.connectTimer = session.renewTimer = session.idleTimer = session.retryTimer = null;
    for (const request of [...session.requests]) { request.abort(); session.requests.delete(request); }
    for (const waiter of [...session.waiters]) settle(session, waiter, cause);
    // Mark detached before close: late events and synchronous close handlers are inert.
    try { socket?.close(); } catch { /* Socket exception text may contain the listenKey. */ }
    for (const observer of [...session.observers]) safeCall(observer.onReset, { generation: session.generation, reason: cause.code });
    if (remove) { session.observers.clear(); sessions.delete(session.key); session.credentials = null; }
  }
  function active(session) { return !closed && sessions.get(session.key) === session; }
  function demanded(session) { return session.observers.size > 0 || now() - session.lastUse < IDLE_MS; }
  function armIdle(session) {
    cancel(session, session.idleTimer);
    if (session.observers.size > 0) return;
    session.idleTimer = schedule(session, () => {
      session.idleTimer = null;
      if (!demanded(session)) detach(session, error('upstream', '空闲连接已释放'), true);
      else armIdle(session);
    }, IDLE_MS - (now() - session.lastUse));
  }
  function fail(session, cause) {
    if (!active(session)) return;
    if (session.connected && now() - session.connectedAt >= 30_000) session.failures = 0;
    detach(session, cause);
    session.failures += 1; session.lastError = cause;
    session.retryAt = Math.max(now() + (RETRIES[session.failures - 1] ?? 60_000), cause.retryAt ?? 0);
    if (session.failures > RETRIES.length) session.failures = 0;
    for (const observer of [...session.observers]) safeCall(observer.onError, cause);
    if (demanded(session)) session.retryTimer = schedule(session, () => {
      session.retryTimer = null;
      if (demanded(session)) connect(session);
    }, session.retryAt - now());
    armIdle(session);
  }
  function clock() {
    const at = now();
    if (!Number.isFinite(at) || at < lastClock) {
      lastClock = at;
      const cause = error('upstream', '本机时间回退，等待重新连接');
      for (const session of [...sessions.values()]) fail(session, cause);
      throw cause;
    }
    lastClock = at; return at;
  }
  function check(session) {
    const at = clock();
    if (closed) throw aborted();
    if (!active(session)) throw error('upstream', '连接已释放');
    if (session.connected && (at >= session.rolloverAt || session.kind === 'private' && at >= session.tokenUntil)) {
      const cause = error('upstream', '连接或订阅已到期'); fail(session, cause); throw cause;
    }
    if (session.connecting && at >= session.connectDeadline) {
      const cause = error('timeout', '连接超时'); fail(session, cause); throw cause;
    }
    session.lastUse = at; armIdle(session);
  }
  function makeSession(key, kind, extra) {
    if (sessions.size >= MAX_SESSIONS) throw error('upstream', '连接数量已达上限');
    const session = { key, kind, ...extra, generation: ++era, timers: new Set(), waiters: new Set(), requests: new Set(),
      observers: new Set(), orders: new Map(), fences: new Map(), socket: null, connected: false, connecting: false,
      token: null, tokenUntil: 0, book: null, lastUse: now(), failures: 0, retryAt: 0, lastError: null };
    sessions.set(key, session); return session;
  }
  function privateSession(credentials, options = {}) {
    const values = credentialsOf(credentials), mode = modeOf(options.accountMode);
    const fingerprint = createHash('sha256').update(JSON.stringify([purpose, mode, values.apiKey, values.apiSecret])).digest('hex');
    const key = `private:${fingerprint}`;
    if (closed) throw aborted();
    return sessions.get(key) ?? makeSession(key, 'private', { credentials: values, mode });
  }
  async function responseText(response) {
    if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) throw invalid();
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > MAX_BYTES) throw invalid(); chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
      } finally { try { await reader.cancel(); } catch { /* Already closed/aborted. */ } reader.releaseLock(); }
    }
    const text = await response.text(); if (Buffer.byteLength(text) > MAX_BYTES) throw invalid(); return text;
  }
  async function listenKey(session, method) {
    const controller = new AbortController(); session.requests.add(controller);
    let timer;
    const deadline = now() + timeout;
    const pending = (async () => {
      const pm = session.mode === 'portfolio-margin';
      const response = await fetchImpl(pm ? 'https://papi.binance.com/papi/v1/listenKey' : 'https://fapi.binance.com/fapi/v1/listenKey', {
        method, headers: { 'X-MBX-APIKEY': session.credentials.apiKey }, signal: controller.signal, redirect: 'error',
      });
      const text = await responseText(response);
      let data; try { data = text ? parseJson(text) : {}; } catch { throw invalid(); }
      const providerCode = Number.isSafeInteger(data?.code) && data.code < 0 ? data.code : undefined;
      if (!response.ok || providerCode !== undefined) {
        const rateLimited = response.status === 429 || response.status === 418 || providerCode === -1003;
        const after = response.headers?.get?.('retry-after');
        const until = /^\d+(?:\.\d+)?$/.test(after ?? '') ? now() + Number(after) * 1000 : Date.parse(after ?? '');
        throw error([-2014, -2015].includes(providerCode) || response.status === 401 || response.status === 403 ? 'permissions' : 'upstream',
          providerCode === -1125 ? '订阅令牌已失效' : rateLimited ? '上游限流，等待冷却' : '订阅请求被拒绝',
          { providerCode, rateLimited, ...(rateLimited ? { retryAt: Math.max(now() + 60_000, Number.isFinite(until) ? until : 0) } : {}) });
      }
      if (now() >= deadline) throw error('timeout', '订阅请求超时');
      if (method === 'POST' && (typeof data.listenKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(data.listenKey))) throw invalid();
      return data;
    })();
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(aborted()), { once: true });
        timer = schedule(session, () => { reject(error('timeout', '订阅请求超时')); controller.abort(); }, timeout, false);
      })]);
    } catch (cause) {
      throw cause instanceof BinanceStreamError ? cause : error('transport', '订阅网络请求失败');
    } finally { cancel(session, timer); session.requests.delete(controller); }
  }
  function armRenew(session, generation) {
    cancel(session, session.renewTimer);
    session.renewTimer = schedule(session, async () => {
      session.renewTimer = null;
      if (!active(session) || generation !== session.generation) return;
      try {
        const startedAt = now(); await listenKey(session, 'PUT');
        if (!active(session) || generation !== session.generation) return;
        if (now() >= session.tokenUntil) { fail(session, error('upstream', '订阅令牌已到期')); return; }
        session.tokenUntil = startedAt + TOKEN_MS; armRenew(session, generation);
      } catch (cause) { if (active(session) && generation === session.generation) fail(session, cause); }
    }, KEEPALIVE_MS);
  }
  function freshBook(session) {
    const row = session.book, at = now(), exchangeAt = exchangeNow();
    return session.connected && row && Number.isFinite(exchangeAt) && at >= row.receivedAt && at - row.receivedAt < bookAge
      && exchangeAt >= row.time - 1000 && exchangeAt - row.time < bookAge ? { ...row } : undefined;
  }
  function bookMessage(session, message) {
    if (message.e !== 'bookTicker' || message.s !== session.symbol || !timestamp(message.T) || !timestamp(message.E)) throw invalid();
    const sequence = id(message.u); if (!sequence) throw invalid();
    const source = message.T, at = exchangeNow();
    if (!Number.isFinite(at)) throw invalid();
    // A future source time is a clock-estimate problem, not malformed data.
    if (source > at + 1000 || message.E > at + 1000) throw error('upstream', '盘口时间超前于校准时间');
    if (at - source >= bookAge || at - message.E >= bookAge) throw error('upstream', '盘口时间已过期');
    const row = { symbol: session.symbol, bidPrice: decimal(message.b, { positive: true }), askPrice: decimal(message.a, { positive: true }),
      bidQty: decimal(message.B, { positive: true }), askQty: decimal(message.A, { positive: true }), time: source, receivedAt: now() };
    if (compareDecimals(row.bidPrice, row.askPrice) >= 0) throw invalid();
    if (session.book && BigInt(sequence) <= BigInt(session.sequence)) return;
    if (session.book && source < session.book.time) throw invalid();
    session.book = row; session.sequence = sequence; notify(session);
  }
  function aliases(row) { return [`${row.symbol}:id:${row.orderId}`, `${row.symbol}:client:${row.clientOrderId}`]; }
  function remember(session, row, eventTime, source) {
    const key = `${row.symbol}:${row.orderId}`, old = session.orders.get(key);
    const fence = Math.max(0, ...aliases(row).map(alias => session.fences.get(alias) ?? 0));
    if (source === 'ws' && row.updateTime <= fence) return;
    if (old && row.updateTime < old.row.updateTime) return;
    // An ambiguous row remains unavailable until exact REST confirmation.
    if (old?.blocked && source === 'ws') return;
    if (old && !old.blocked) {
      const before = old.row;
      const identityConflict = ['clientOrderId', 'side', 'positionSide', 'reduceOnly', 'type', 'timeInForce'].some(field => row[field] !== before[field]);
      const fillBackwards = compareDecimals(row.executedQty, before.executedQty) < 0;
      const terminalBackwards = TERMINAL.has(before.status) && row.status !== before.status;
      const sameTime = row.updateTime === before.updateTime;
      const ambiguous = sameTime && (row.price !== before.price || row.origQty !== before.origQty
        || row.executedQty === before.executedQty && (row.avgPrice !== before.avgPrice
          || before.status === 'PARTIALLY_FILLED' && row.status === 'NEW'));
      if (identityConflict || fillBackwards || terminalBackwards || ambiguous) { old.blocked = true; return; }
      const equal = Object.keys(row).filter(field => field !== 'time').every(field => row[field] === before[field]);
      if (equal && source === 'ws') return; // Duplicates cannot renew evidence age.
      if (before.time && !row.time) row.time = before.time;
    }
    if (!old && session.orders.size >= MAX_ORDERS) session.orders.delete(session.orders.keys().next().value);
    session.orders.set(key, { row, eventTime, receivedAt: now(), source, blocked: false });
    if (source === 'rest') for (const alias of aliases(row)) session.fences.delete(alias);
  }
  function privateMessage(session, message) {
    if (message.e === 'listenKeyExpired') { fail(session, error('upstream', '订阅令牌已失效')); return; }
    if (!['ACCOUNT_UPDATE', 'ORDER_TRADE_UPDATE'].includes(message.e)) return;
    if (session.mode === 'portfolio-margin' && message.fs !== 'UM') return;
    const exchangeAt = exchangeNow();
    if (!timestamp(message.E) || !timestamp(message.T) || !Number.isFinite(exchangeAt)) throw invalid();
    if (message.E > exchangeAt + 1000 || message.T > exchangeAt + 1000) throw error('upstream', '私有事件时间超前于校准时间');
    if (exchangeAt - message.E >= ORDER_AGE_MS) throw error('upstream', '私有事件已过期，等待重新核对');
    if (message.e === 'ORDER_TRADE_UPDATE') {
      const row = message.o;
      if (!object(row)) throw invalid();
      remember(session, normalizeOrder({ symbol: row.s, orderId: row.i, clientOrderId: row.c, side: row.S,
        positionSide: row.ps, reduceOnly: row.R, origQty: row.q, executedQty: row.z, avgPrice: row.ap, price: row.p,
        status: row.X, type: row.o, timeInForce: row.f, updateTime: row.T ?? message.T }), message.E, 'ws');
    } else {
      if (!object(message.a) || message.a.P !== undefined && (!Array.isArray(message.a.P) || message.a.P.length > MAX_ORDERS)
        || message.a.B !== undefined && (!Array.isArray(message.a.B) || message.a.B.length > MAX_ORDERS)) throw invalid();
      const positions = message.a.P ?? [];
      for (const row of positions) {
        if (!object(row) || !symbolOk(row.s) || !['BOTH', 'LONG', 'SHORT'].includes(row.ps)) throw invalid();
        decimal(row.pa); decimal(row.ep, { nonnegative: true });
      }
      // ACCOUNT_UPDATE is a delta. Empty P says nothing about other positions.
      const event = { generation: session.generation, eventTime: message.E, transactionTime: message.T,
        receivedAt: now(), positions: positions.map(row => ({ ...row })), balanceChanged: (message.a.B?.length ?? 0) > 0,
        reason: typeof message.a.m === 'string' ? message.a.m : null };
      for (const observer of [...session.observers]) safeCall(observer.onEvent, structuredClone(event));
    }
  }
  function connect(session) {
    if (!active(session) || session.socket || session.connecting || now() < session.retryAt) return;
    session.connecting = true; session.generation = ++era; session.connectDeadline = now() + timeout;
    const generation = session.generation;
    session.connectTimer = schedule(session, () => {
      if (active(session) && generation === session.generation) fail(session, error('timeout', '连接超时'));
    }, timeout);
    const start = async () => {
      let url;
      if (session.kind === 'private') {
        const startedAt = now(), result = await listenKey(session, 'POST');
        if (!active(session) || generation !== session.generation) return;
        session.token = result.listenKey; session.tokenUntil = startedAt + TOKEN_MS;
        url = `wss://fstream.binance.com/${session.mode === 'portfolio-margin' ? 'pm' : 'private'}/ws/${session.token}`;
      } else url = `wss://fstream.binance.com/public/ws/${encodeURIComponent(session.symbol.toLowerCase())}@bookTicker`;
      if (!active(session) || generation !== session.generation) return;
      if (now() >= session.connectDeadline) throw error('timeout', '连接超时');
      const socket = new WebSocketImpl(url); session.socket = socket;
      const current = () => active(session) && generation === session.generation && session.socket === socket;
      socket.addEventListener('open', () => {
        if (!current()) return;
        if (now() >= session.connectDeadline) { fail(session, error('timeout', '连接超时')); return; }
        cancel(session, session.connectTimer); session.connectTimer = null;
        session.connected = true; session.connecting = false; session.connectedAt = now(); session.lastError = null;
        session.rolloverAt = now() + ROLLOVER_MS;
        schedule(session, () => { if (current()) fail(session, error('upstream', '连接定期轮换')); }, ROLLOVER_MS);
        if (session.kind === 'private') armRenew(session, generation);
        armIdle(session); notify(session);
      });
      socket.addEventListener('message', event => {
        if (!current() || !session.connected) return;
        try {
          clock();
          if (now() >= session.rolloverAt || session.kind === 'private' && now() >= session.tokenUntil) throw error('upstream', '订阅已到期');
          const text = typeof event.data === 'string' ? event.data : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : null;
          if (text === null || Buffer.byteLength(text) > MAX_BYTES) throw invalid();
          const message = parseJson(text); if (!object(message)) throw invalid();
          if (session.kind === 'book') bookMessage(session, message); else privateMessage(session, message);
        } catch (cause) { if (current()) fail(session, cause instanceof BinanceStreamError ? cause : invalid()); }
      });
      for (const type of ['error', 'close']) socket.addEventListener(type, () => {
        if (current()) fail(session, error('transport', '连接中断，等待重连'));
      });
    };
    void start().catch(cause => {
      if (active(session) && generation === session.generation) fail(session, cause instanceof BinanceStreamError ? cause : error('transport', '连接失败'));
    });
  }
  function ensure(session) {
    check(session);
    if (now() < session.retryAt) throw session.lastError ?? error('upstream', '连接正在冷却');
    connect(session);
  }
  async function ready(credentials, options = {}) {
    if (closed || options.signal?.aborted) throw aborted();
    await ensureClock({ signal: options.signal });
    if (options.signal?.aborted) throw aborted();
    const session = privateSession(credentials, options); ensure(session);
    return wait(session, () => session.connected ? { generation: session.generation, connectedAt: session.connectedAt } : undefined, options.signal);
  }
  async function book(symbol, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (!symbolOk(symbol) || symbol !== symbol.toUpperCase()) throw invalid();
    if (closed) throw aborted();
    await ensureClock({ signal });
    if (closed || signal?.aborted) throw aborted();
    const key = `book:${symbol}`, session = sessions.get(key) ?? makeSession(key, 'book', { symbol });
    ensure(session); return wait(session, () => freshBook(session), signal);
  }
  function specOf(spec) {
    const rawId = spec?.id ?? spec?.orderId, rawClient = spec?.clientId ?? spec?.clientOrderId;
    const orderId = id(rawId), client = clientId(rawClient);
    if (!object(spec) || !symbolOk(spec.symbol) || !orderId && !client
      || rawId !== undefined && rawId !== null && !orderId || rawClient !== undefined && rawClient !== null && !client) throw invalid();
    return { symbol: spec.symbol, orderId, clientOrderId: client };
  }
  async function order(credentials, spec, options = {}) {
    const wanted = specOf(spec); await ready(credentials, options);
    const session = privateSession(credentials, options); check(session);
    const candidates = [...session.orders.values()].filter(entry => entry.row.symbol === wanted.symbol
      && (!wanted.orderId || entry.row.orderId === wanted.orderId) && (!wanted.clientOrderId || entry.row.clientOrderId === wanted.clientOrderId));
    if (candidates.length !== 1) return null;
    const entry = candidates[0], at = now();
    if (entry.blocked || at < entry.receivedAt || at - entry.receivedAt >= ORDER_AGE_MS
      || entry.source === 'ws' && (exchangeNow() < entry.eventTime - 1000 || exchangeNow() - entry.eventTime >= ORDER_AGE_MS)) return null;
    return { ...entry.row };
  }
  // The connected generation observed before a REST read. A row read across a
  // disconnect cannot be seeded: the new socket never replays the gap's events.
  function orderGeneration(credentials, options = {}) {
    const session = privateSession(credentials, options); check(session);
    return session.connected ? session.generation : null;
  }
  function seedOrder(credentials, row, options = {}) {
    const session = privateSession(credentials, options); check(session);
    const normalized = normalizeOrder(row);
    if (!Number.isFinite(exchangeNow()) || normalized.updateTime > exchangeNow() + 1000) throw invalid();
    if (!session.connected || options.generation !== undefined && options.generation !== session.generation) return false;
    remember(session, normalized, exchangeNow(), 'rest');
    return true;
  }
  function invalidateOrder(credentials, spec, options = {}) {
    const session = privateSession(credentials, options), wanted = specOf(spec); check(session);
    const until = exchangeNow(); if (!Number.isFinite(until)) throw invalid();
    const affected = [];
    for (const [key, entry] of session.orders) {
      if (entry.row.symbol === wanted.symbol && (!wanted.orderId || entry.row.orderId === wanted.orderId)
        && (!wanted.clientOrderId || entry.row.clientOrderId === wanted.clientOrderId)) {
        affected.push(...aliases(entry.row)); session.orders.delete(key);
      }
    }
    if (wanted.orderId) affected.push(`${wanted.symbol}:id:${wanted.orderId}`);
    if (wanted.clientOrderId) affected.push(`${wanted.symbol}:client:${wanted.clientOrderId}`);
    for (const alias of affected) session.fences.set(alias, until);
    // Evicting an unresolved mutation fence could make a delayed old event look
    // current again. Reset the generation instead; callers recover by exact REST.
    if (session.fences.size > MAX_ORDERS * 2) {
      const cause = error('upstream', '订单失效记录已达上限，等待重新核对'); fail(session, cause); throw cause;
    }
  }
  function subscribePositions(credentials, options = {}) {
    const session = privateSession(credentials, options); check(session);
    if (session.observers.size >= MAX_SESSIONS) throw error('upstream', '订阅数量已达上限');
    const observer = { onEvent: options.onEvent, onReset: options.onReset, onError: options.onError };
    session.observers.add(observer); armIdle(session);
    return () => { if (session.observers.delete(observer) && active(session)) armIdle(session); };
  }
  function forget(credentials, options = {}) {
    if (credentials) {
      const values = credentialsOf(credentials);
      for (const session of [...sessions.values()]) {
        if (session.kind === 'private' && session.credentials.apiKey === values.apiKey && session.credentials.apiSecret === values.apiSecret
          && (!options.accountMode || session.mode === modeOf(options.accountMode))) detach(session, aborted(), true);
      }
    } else for (const session of [...sessions.values()]) detach(session, aborted(), true);
  }
  function close() { if (closed) return; closed = true; forget(); }
  return { book, ready, order, orderGeneration, seedOrder, invalidateOrder, subscribePositions, forget, close };
}
