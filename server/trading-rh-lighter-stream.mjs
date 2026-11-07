import { Buffer } from 'node:buffer';
import { compareDecimals, decimal } from './trading-decimal.mjs';

const URL = 'wss://api.rh.lighter.xyz/stream';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ORDERS = 2000;
const MAX_SUBSCRIPTIONS = 32;
const TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30_000;
const PRIVATE_REFRESH_MS = 30_000;
const SILENCE_MS = 45_000;
const IDLE_MS = 60_000;
const COOLDOWN_MS = 60_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000];
const AUTH_CODES = new Set([20013, 21109, 21120]);
const WORKING = new Set(['open', 'pending', 'in-progress']);
const TERMINAL = new Set(['filled', 'canceled', 'canceled-post-only', 'canceled-reduce-only', 'canceled-position-not-allowed',
  'canceled-margin-not-allowed', 'canceled-too-much-slippage', 'canceled-not-enough-liquidity', 'canceled-self-trade',
  'canceled-expired', 'canceled-oco', 'canceled-child', 'canceled-liquidation', 'canceled-invalid-balance']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const ORDER_IDENTITY_FIELDS = ['is_ask', 'side', 'reduce_only', 'type', 'time_in_force', 'market_symbol', 'market_kind'];
const ORDER_VALUE_FIELDS = ['price', 'initial_base_amount', 'base_size', 'base_price'];

// No REST or transaction writes exist here. The caller owns exact REST recovery
// for absent orders. Socket failures invalidate every snapshot; reconnects need
// fresh subscribed/* frames. Only ticker nonces have an increasing contract;
// private order progress is checked by row version, fills and terminal state.
export function createRhLighterStream({ ErrorClass = Error, WebSocketImpl = globalThis.WebSocket, now = Date.now,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, maxBookAgeMs = 5000 } = {}) {
  const subscriptions = new Map(), orders = new Map(), waiters = new Set(), timers = new Set();
  let socket = null, generation = 0, connected = false, closed = false;
  let lastCall = 0, lastClock = now(), lastFrame = 0, failures = 0, retryAt = 0;
  let rateLimitUntil = 0, rateLimitCode = null;
  let permissionCode = null;
  let invalidData = false;
  let retryTimer = null, idleTimer = null, connectTimer = null, heartbeatTimer = null, silenceTimer = null, authTimer = null;

  const error = (detail, limited = false) => Object.assign(new ErrorClass(invalidData && !limited ? 'invalid_data' : 'upstream', {
    detail: `Lighter RH WebSocket：${detail}`, ...(limited ? { providerCode: rateLimitCode } : {}),
  }), limited ? { rateLimited: true, retryAt: rateLimitUntil, providerCode: rateLimitCode } : {});
  const aborted = () => new ErrorClass('aborted');
  const invalid = detail => new ErrorClass('invalid_data', { detail: `Lighter RH WebSocket：${detail}` });
  const permissionError = () => new ErrorClass('permissions', { providerCode: permissionCode,
    detail: 'Lighter RH WebSocket：订单订阅授权被拒绝，请刷新授权或核对 API Key' });
  function schedule(fn, ms, background = true) {
    const timer = setTimeoutImpl(() => { timers.delete(timer); fn(); }, Math.max(0, ms));
    timers.add(timer);
    if (background) timer?.unref?.();
    return timer;
  }
  function cancel(timer) { if (timer !== null) { clearTimeoutImpl(timer); timers.delete(timer); } }
  function settle(waiter, cause, value) {
    if (!waiters.delete(waiter)) return;
    cancel(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (cause) waiter.reject(cause); else waiter.resolve(value);
  }
  function notify() {
    for (const waiter of [...waiters]) {
      const result = waiter.read();
      if (result !== undefined) settle(waiter, null, result);
    }
  }
  function wait(read, ms, signal, timeoutValue) {
    if (signal?.aborted) return Promise.reject(aborted());
    const value = read();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const waiter = { read, resolve, reject, signal, timer: null, abort: null };
      waiter.abort = () => settle(waiter, aborted());
      waiters.add(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiter.timer = schedule(() => settle(waiter, timeoutValue instanceof Error ? timeoutValue : null,
        timeoutValue instanceof Error ? undefined : timeoutValue), ms, false);
      if (signal?.aborted) waiter.abort();
    });
  }
  function detach(cause) {
    generation += 1;
    const old = socket;
    socket = null;
    connected = false;
    for (const timer of [...timers]) cancel(timer);
    retryTimer = idleTimer = connectTimer = heartbeatTimer = silenceTimer = authTimer = null;
    for (const sub of subscriptions.values()) {
      sub.ready = false; sub.sent = false; sub.nonce = -1; sub.book = null; sub.timer = null; sub.privateTimer = null; sub.privateAt = null; sub.privateUntil = 0;
    }
    orders.clear();
    for (const waiter of [...waiters]) settle(waiter, cause);
    // Do not propagate close reasons or socket exceptions: they can echo auth.
    try { old?.close(); } catch { /* The detached generation is already unusable. */ }
  }
  function clock() {
    const at = now();
    if (!Number.isFinite(at) || at < lastClock) {
      lastClock = at;
      failConnection('本机时间回退，请等待重新订阅');
      throw error('本机时间回退，请等待重新订阅');
    }
    lastClock = at;
    return at;
  }
  function armIdle() {
    cancel(idleTimer);
    idleTimer = schedule(() => {
      idleTimer = null;
      if (now() - lastCall >= IDLE_MS) {
        detach(error('空闲连接已释放'));
        subscriptions.clear();
      } else armIdle();
    }, Math.max(1, IDLE_MS - (now() - lastCall)));
  }
  function retryLater() {
    cancel(retryTimer);
    if (closed || subscriptions.size === 0 || now() - lastCall >= IDLE_MS) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      if (now() - lastCall >= IDLE_MS) return;
      try { connect(); } catch { /* Failures remain bounded by retryAt. */ }
    }, Math.max(1, retryAt - now()));
    armIdle();
  }
  function failConnection(detail, providerCode = null, hard = false) {
    invalidData ||= hard;
    const rateLimited = integer(providerCode, 23000, 23003);
    if (rateLimited) { rateLimitUntil = now() + COOLDOWN_MS; rateLimitCode = providerCode; }
    if (AUTH_CODES.has(providerCode)) permissionCode = providerCode;
    detach(permissionCode !== null ? permissionError() : error(detail, rateLimited));
    failures += 1;
    const backoff = failures <= RETRY_MS.length ? RETRY_MS[failures - 1] : COOLDOWN_MS;
    retryAt = Math.max(now() + backoff, rateLimitUntil);
    // Five bounded retries, then a full cooldown before a new round.
    if (failures > RETRY_MS.length) failures = 0;
    retryLater();
  }
  function send(value) {
    try { socket.send(JSON.stringify(value)); } catch { failConnection('发送失败，等待重新连接'); }
  }
  function healthy() {
    if ([...subscriptions.values()].every(sub => sub.ready)) { failures = 0; retryAt = 0; invalidData = false; }
  }
  function armAuth() {
    cancel(authTimer);
    const deadlines = [...subscriptions.values()].filter(sub => sub.kind === 'orders').map(sub => sub.tokenExpiresAt);
    if (deadlines.length === 0) { authTimer = null; return; }
    authTimer = schedule(() => {
      authTimer = null;
      failConnection('订单订阅授权已过期，请刷新授权');
    }, Math.max(1, Math.min(...deadlines) - now()));
  }
  function subscribe(sub) {
    if (!connected || sub.sent) return;
    if (sub.kind === 'orders' && sub.tokenExpiresAt <= now()) return;
    sub.sent = true;
    const era = generation;
    sub.timer = schedule(() => {
      if (generation === era && !sub.ready) failConnection('订阅快照超时，等待重新连接');
    }, TIMEOUT_MS);
    send({ type: 'subscribe', channel: sub.requestChannel, ...(sub.kind === 'orders' ? { auth: sub.token } : {}) });
  }
  const privateFresh = sub => sub.ready && sub.privateAt !== null && now() >= sub.privateAt && now() < sub.privateUntil;
  function refreshPrivate(sub) {
    if (!socket || !connected || !sub.ready) return;
    const era = generation;
    cancel(sub.privateTimer);
    sub.privateTimer = null; sub.privateAt = null; sub.privateUntil = 0;
    sub.ready = false; sub.sent = false;
    for (const key of orders.keys()) if (key.startsWith(`${sub.key}:`)) orders.delete(key);
    send({ type: 'unsubscribe', channel: sub.requestChannel });
    if (generation === era) subscribe(sub);
  }
  function armPrivate(sub, at) {
    cancel(sub.privateTimer);
    sub.privateAt = at; sub.privateUntil = at + PRIVATE_REFRESH_MS;
    const era = generation;
    sub.privateTimer = schedule(() => {
      sub.privateTimer = null;
      if (generation !== era || !socket || !connected || !sub.ready) return;
      // Public ticker/pong traffic cannot prove the private channel is live.
      // Refresh only this subscription; no REST request is made by the stream.
      refreshPrivate(sub);
    }, PRIVATE_REFRESH_MS);
  }
  function armSilence() {
    cancel(silenceTimer);
    silenceTimer = schedule(() => {
      silenceTimer = null;
      if (now() - lastFrame >= SILENCE_MS) failConnection('连接长时间无响应，等待重新连接');
      else armSilence();
    }, Math.max(1, SILENCE_MS - (now() - lastFrame)));
  }
  function heartbeat() {
    heartbeatTimer = schedule(() => {
      heartbeatTimer = null;
      if (!socket || !connected) return;
      send({ type: 'ping' });
      if (socket && connected) heartbeat();
    }, HEARTBEAT_MS);
  }
  function connect() {
    if (closed) throw error('连接已关闭');
    if (socket) return;
    const at = clock();
    if (at < rateLimitUntil) throw error('上游限流冷却中，请稍后重试', true);
    if (permissionCode !== null) throw permissionError();
    if (at < retryAt) throw error('连接恢复退避中，请稍后重试');
    if (typeof WebSocketImpl !== 'function') throw error('当前运行环境不支持 WebSocket');
    cancel(retryTimer); retryTimer = null;
    const era = ++generation;
    let ws;
    try { ws = new WebSocketImpl(URL); } catch { failConnection('无法建立连接'); throw error('无法建立连接'); }
    socket = ws;
    ws.binaryType = 'arraybuffer';
    connectTimer = schedule(() => { if (era === generation) failConnection('建立连接超时'); }, TIMEOUT_MS);
    const active = () => socket === ws && era === generation && !closed;
    ws.addEventListener('message', event => {
      if (!active()) return;
      try { receive(event.data); } catch (cause) {
        if (active()) failConnection('消息格式、身份或状态校验失败，等待重新订阅', null,
          !(cause instanceof ErrorClass) || cause.code !== 'upstream');
      }
    });
    ws.addEventListener('error', () => { if (active()) failConnection('连接异常，等待重新连接'); });
    ws.addEventListener('close', () => { if (active()) failConnection('连接中断，等待重新订阅'); });
    armIdle();
    armAuth();
  }
  function sourceTime(value) {
    if (!integer(value, 1)) throw invalid('报价时间无效');
    // ticker.last_updated_at is Unix microseconds; timestamp is milliseconds.
    const at = value >= 100_000_000_000_000 ? value / 1000 : value;
    if (at < 100_000_000_000) throw invalid('报价时间单位无效');
    return at;
  }
  function quote(sub, message, at) {
    const value = message.ticker;
    if (!object(value) || value.s !== sub.symbol || !object(value.a) || !object(value.b)) throw invalid('盘口身份无效');
    const bid = decimal(value.b.price, { positive: true }), ask = decimal(value.a.price, { positive: true });
    decimal(value.a.size, { positive: true }); decimal(value.b.size, { positive: true });
    if (compareDecimals(bid, ask) >= 0) throw invalid('盘口买卖价无效');
    const source = [value.last_updated_at, message.last_updated_at, message.timestamp].filter(item => item !== undefined).map(sourceTime);
    if (source.length === 0 || source.some(time => time > at + 1000)) throw invalid('盘口时间无效');
    if (source.some(time => at - time > maxBookAgeMs)) throw error('盘口已过期');
    sub.book = { bid, ask, at, sourceAt: Math.min(...source) };
  }
  function accountOrders(sub, message, at) {
    if (message.account !== sub.accountIndex || !object(message.orders)
      || Object.keys(message.orders).some(key => key !== String(sub.marketId))) throw invalid('订单订阅身份无效');
    const rows = message.orders[String(sub.marketId)] ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_ORDERS) throw invalid('订单快照过大');
    const seen = new Set(), updates = [];
    for (const row of rows) {
      // The snapshot carries every order of the account in this market. A
      // manual or venue-generated order has client index 0; it can never be
      // one the engine addresses, so it must not veto the rest. Any other
      // malformed index still fails the snapshot as a format change.
      if (object(row) && row.client_order_index === 0 && row.market_index === sub.marketId && row.owner_account_index === sub.accountIndex) continue;
      if (!object(row) || row.market_index !== sub.marketId || row.owner_account_index !== sub.accountIndex
        || !integer(row.client_order_index, 1, 2 ** 48 - 1) || !integer(row.order_index, 1)
        || !integer(row.order_version) || !integer(row.nonce) || (!WORKING.has(row.status) && !TERMINAL.has(row.status))
        || row.client_order_id !== undefined && row.client_order_id !== String(row.client_order_index)
        || row.order_id !== undefined && row.order_id !== String(row.order_index)
        || seen.has(row.client_order_index)) throw invalid('订单行身份或顺序无效');
      seen.add(row.client_order_index);
      const filled = decimal(row.filled_base_amount, { nonnegative: true });
      const quoteFilled = decimal(row.filled_quote_amount, { nonnegative: true });
      const key = `${sub.key}:${row.client_order_index}`, previous = orders.get(key);
      const identity = { ...previous?.identity };
      for (const field of ORDER_IDENTITY_FIELDS) {
        if (row[field] === undefined) continue;
        if (identity[field] !== undefined && row[field] !== identity[field]) throw invalid('订单不可变字段发生冲突');
        identity[field] = row[field];
      }
      if (previous) {
        const old = previous.row;
        if (row.order_index !== old.order_index) throw invalid('订单编号发生冲突');
        // Queue nonces are side-dependent (buy ranks can decrease). The
        // explicit modification version, not queue position, orders revisions.
        if (row.order_version < old.order_version) continue;
        const baseChange = compareDecimals(filled, old.filled_base_amount), quoteChange = compareDecimals(quoteFilled, old.filled_quote_amount);
        if (baseChange < 0 || quoteChange < 0 || TERMINAL.has(old.status) && row.status !== old.status) throw invalid('订单成交量或终态发生回退');
        if (row.order_version === old.order_version && row.nonce === old.nonce && baseChange === 0 && quoteChange === 0) {
          for (const field of ORDER_VALUE_FIELDS) {
            if (row[field] !== undefined && old[field] !== undefined && compareDecimals(row[field], old[field]) !== 0) throw invalid('同一订单版本的价格或数量发生冲突');
          }
          if (row.status === old.status) {
            if (row.remaining_base_amount !== undefined && old.remaining_base_amount !== undefined
              && compareDecimals(row.remaining_base_amount, old.remaining_base_amount) !== 0) throw invalid('同一订单状态的剩余数量发生冲突');
            // Retain optional identity evidence even if this duplicate brought
            // no new version or fill. A duplicate cannot renew private health.
            previous.identity = identity;
            continue;
          }
        }
      }
      updates.push([key, { row: { ...row }, identity, at }]);
    }
    // Only present rows update the cache; absence never proves cancellation.
    for (const [key, value] of updates) { orders.delete(key); orders.set(key, value); }
    while (orders.size > MAX_ORDERS) orders.delete(orders.keys().next().value);
    return updates.length > 0;
  }
  function receive(data) {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength;
    if (!integer(bytes, 1, MAX_BYTES)) throw invalid('消息大小无效');
    const text = typeof data === 'string' ? data : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).toString('utf8');
    const message = JSON.parse(text);
    if (!object(message)) throw invalid('消息格式无效');
    const at = clock();
    lastFrame = at;
    armSilence();
    if (object(message.error)) {
      const limited = integer(message.error.code, 23000, 23003);
      failConnection(limited ? '上游限流，等待 60 秒后重新连接' : '上游拒绝订阅，请检查授权或稍后重试',
        limited || AUTH_CODES.has(message.error.code) ? message.error.code : null);
      return;
    }
    if (message.type === 'connected') {
      if (connected) return;
      connected = true; cancel(connectTimer); connectTimer = null;
      heartbeat();
      for (const sub of subscriptions.values()) subscribe(sub);
      return;
    }
    if (message.type === 'ping') { send({ type: 'pong' }); return; }
    if (message.type === 'pong') return;
    const ticker = message.type === 'subscribed/ticker' || message.type === 'update/ticker';
    const privateOrders = message.type === 'subscribed/account_orders' || message.type === 'update/account_orders';
    if (!ticker && !privateOrders) return;
    const candidates = [...subscriptions.values()].filter(sub => sub.channel === message.channel && sub.kind === (ticker ? 'book' : 'orders'));
    const sub = ticker ? candidates[0] : candidates.find(item => item.accountIndex === message.account);
    if (!sub) { if (candidates.length) throw invalid('订单账户身份无效'); return; }
    if (!connected || !sub.sent || (ticker || message.nonce !== undefined) && !integer(message.nonce)) throw invalid('订阅消息顺序无效');
    if (sub.kind === 'orders' && at >= sub.tokenExpiresAt) throw error('订阅授权已过期');
    if (ticker && message.nonce <= sub.nonce) return;
    if (!sub.ready && !message.type.startsWith('subscribed/')) return;
    if (ticker) { quote(sub, message, at); sub.nonce = message.nonce; }
    else {
      const changed = accountOrders(sub, message, at);
      if (!sub.ready || changed) armPrivate(sub, at);
    }
    sub.ready = true;
    cancel(sub.timer); sub.timer = null;
    healthy();
    notify();
  }
  function touch(signal) {
    if (signal?.aborted) throw aborted();
    if (closed) throw error('连接已关闭');
    lastCall = clock();
    armIdle();
  }
  function add(sub) {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) throw error('订阅数量超出限制');
    subscriptions.set(sub.key, { ready: false, sent: false, nonce: -1, book: null, timer: null, privateTimer: null, privateAt: null, privateUntil: 0, ...sub });
    return subscriptions.get(sub.key);
  }
  async function ready(sub, signal) {
    // Timer callbacks can lag behind the clock. Revoke old private evidence
    // synchronously at the read boundary, before waiting for a new snapshot.
    if (sub.kind === 'orders' && sub.ready && !privateFresh(sub)) refreshPrivate(sub);
    connect(); subscribe(sub);
    const era = generation;
    await wait(() => sub.ready && socket && connected ? true : undefined, TIMEOUT_MS, signal, error('等待订阅快照超时'));
    // A resolved waiter can outlive a synchronous close or credential rotation.
    if (era !== generation || !sub.ready || !socket || !connected || subscriptions.get(sub.key) !== sub) throw error('订阅已失效，请重新读取');
    if (signal?.aborted) throw aborted();
  }
  async function book(marketId, symbol, { signal } = {}) {
    touch(signal);
    if (!integer(marketId, 0, 65_535) || typeof symbol !== 'string' || !/^[A-Z0-9._-]{1,32}$/.test(symbol)) throw error('市场标识无效');
    const key = `book:${marketId}`;
    let sub = subscriptions.get(key);
    if (sub && sub.symbol !== symbol) throw error('市场与代码不一致');
    sub ??= add({ key, kind: 'book', marketId, symbol, channel: `ticker:${marketId}`, requestChannel: `ticker/${marketId}` });
    await ready(sub, signal);
    const era = generation;
    const read = () => {
      const value = sub.book, at = now();
      return sub.ready && value && at >= value.at && at - value.at <= maxBookAgeMs && at >= value.sourceAt - 1000
        && at - value.sourceAt <= maxBookAgeMs ? { bid: value.bid, ask: value.ask, at: value.at } : undefined;
    };
    await wait(read, TIMEOUT_MS, signal, error('盘口过期，等待新报价超时'));
    clock();
    if (era !== generation || !sub.ready || !socket || !connected || !read()) throw error('盘口已失效，请重新读取');
    return read();
  }
  async function order(marketId, accountIndex, clientOrderIndex, { token, tokenExpiresAt, identity, signal, waitMs = 0, minVersion = 0 } = {}) {
    touch(signal);
    if (!integer(marketId, 0, 65_535) || !integer(accountIndex) || !integer(clientOrderIndex, 1, 2 ** 48 - 1)
      || typeof token !== 'string' || token.length < 1 || token.length > 2048 || typeof identity !== 'string' || identity.length < 1
      || identity.length > 256 || !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= now()
      || !integer(minVersion) || !integer(waitMs, 0, TIMEOUT_MS)) throw error('订单订阅参数或授权无效');
    const key = `orders:${marketId}:${accountIndex}`;
    const sameAccount = [...subscriptions.values()].filter(sub => sub.kind === 'orders' && sub.accountIndex === accountIndex);
    if (sameAccount.some(sub => sub.identity !== identity || sub.token !== token || sub.tokenExpiresAt !== tokenExpiresAt)) {
      detach(error('授权已更新，等待新订阅快照'));
      for (const sub of sameAccount) { sub.identity = identity; sub.token = token; sub.tokenExpiresAt = tokenExpiresAt; }
      if (permissionCode !== null) { permissionCode = null; failures = 0; retryAt = rateLimitUntil; }
      // Rotation cannot bypass an upstream rate-limit or failure cooldown.
    }
    const sub = subscriptions.get(key) ?? add({ key, kind: 'orders', marketId, accountIndex, token, tokenExpiresAt, identity,
      channel: `account_orders:${marketId}`, requestChannel: `account_orders/${marketId}/${accountIndex}` });
    armAuth();
    await ready(sub, signal);
    const era = generation;
    const read = () => {
      const cached = orders.get(`${key}:${clientOrderIndex}`);
      // A terminal original order cannot be revived by an outstanding modify;
      // its terminal state settles the wait even if that modify never executed.
      return privateFresh(sub) && cached && (cached.row.order_version >= minVersion || TERMINAL.has(cached.row.status)) ? { ...cached.row } : undefined;
    };
    if (waitMs > 0) await wait(read, waitMs, signal, null);
    clock();
    if (sub.ready && !privateFresh(sub)) { refreshPrivate(sub); throw error('私有订单证据已过期，等待新快照'); }
    if (era !== generation || !sub.ready || !socket || !connected || sub.token !== token || now() >= sub.tokenExpiresAt) throw error('订单订阅已失效，请重新读取');
    if (signal?.aborted) throw aborted();
    return read() ?? null;
  }
  function forget() {
    detach(aborted());
    subscriptions.clear();
    if (permissionCode !== null) { failures = 0; retryAt = rateLimitUntil; }
    permissionCode = null;
    invalidData = false;
    // Rate-limit deadlines survive cache invalidation and credential changes.
  }
  function close() { closed = true; forget(); }
  return { book, order, forget, close };
}
