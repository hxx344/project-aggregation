import { ondoAuthHeaders } from './exchange-transport/ondo.mjs';
import { readJsonResponse } from './exchange-transport/response.mjs';
import { decimal } from './trading-decimal.mjs';

const BASE = 'https://api.ondoperps.xyz';
const MAX_BYTES = 4 * 1024 * 1024;
const PAGE = 1000, MAX_PAGES = 3;
const MAX_QUEUE = 64;
const COOLDOWN_MS = [2000, 4000, 8000, 16_000, 32_000, 60_000], MAX_COOLDOWN_MS = 300_000;
const CODE = /^[A-Za-z0-9_]{1,64}$/;
// A cancel waits out a cooldown only up to this long: a resting quote must not sit out five minutes.
const CANCEL_MAX_WAIT_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const ONDO_MARKET = /^[A-Z0-9]{1,16}-USD\.P$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// code is the venue's error_code or a local one. The venue's free-text message
// is never kept: it can echo the key id. `uncertain` marks a write the venue
// may have processed although no answer was read.
export class OndoError extends Error {
  constructor(code, { status = null, uncertain = false, retryAt = null } = {}) {
    super(`Ondo Perps: ${code}`);
    this.name = 'OndoError'; this.code = code; this.status = status; this.uncertain = uncertain; this.retryAt = retryAt;
  }
}
const invalid = () => new OndoError('invalid_data');
const amount = (value, options) => { try { return decimal(value, options); } catch { throw invalid(); } };

function orderOf(value) {
  if (!object(value) || typeof value.orderId !== 'string' || !ID.test(value.orderId) || !['buy', 'sell'].includes(value.side)
    || typeof value.market !== 'string' || typeof value.status !== 'string') throw invalid();
  const clientId = value.clientOrderId === undefined || value.clientOrderId === '' ? null : value.clientOrderId;
  if (clientId !== null && (typeof clientId !== 'string' || clientId.length > 64)) throw invalid();
  return { id: value.orderId, clientId, market: value.market, side: value.side, price: amount(value.price, { positive: true }),
    size: amount(value.size, { positive: true }), filled: amount(value.filledSize ?? '0', { nonnegative: true }),
    status: value.status, reduceOnly: value.reduceOnly === true };
}

// Every request: one attempt bounded by timeoutMs. Nothing is retried except a
// request the venue refused for its timestamp, which is re-signed once against
// the venue's clock. A 429 starts a cooldown during which nothing is sent
// except cancels, which wait at most CANCEL_MAX_WAIT_MS of it. A
// write that fails after it was sent, or answers 5xx, is reported uncertain and
// left to the caller to look up. Requests share one token bucket of `rps`
// (burst = one second); urgent ones (cancels, closes) go first.
export function createOndoClient({ credentials = null, fetchImpl = fetch, now = Date.now, timeoutMs = 5000, rps = 4,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, cooldownUntil = 0 } = {}) {
  if (!Number.isFinite(rps) || rps < 1 || rps > 20) throw new RangeError('Ondo rps must be 1-20');
  const queue = [];
  let tokens = rps, refilledAt = now(), timer = null, closed = false, offset = 0, strikes = 0, limitedAt = -Infinity,
    cancelUntil = cooldownUntil > now() ? Math.min(cooldownUntil, now() + CANCEL_MAX_WAIT_MS) : 0;
  const controllers = new Set();

  function pump() {
    const at = now();
    tokens = Math.min(rps, tokens + Math.max(0, at - refilledAt) * rps / 1000); refilledAt = at;
    while (queue.length && tokens >= 1) {
      const index = Math.max(0, queue.findIndex(item => item.urgent));
      const [item] = queue.splice(index, 1);
      tokens -= 1; item.resolve();
    }
    if (queue.length && timer === null) {
      timer = setTimeoutImpl(() => { timer = null; pump(); }, Math.ceil((1 - tokens) * 1000 / rps));
      timer?.unref?.();
    }
  }
  function slot(urgent) {
    // A backlog means quotes are already stale: fresh ones are refused, cancels still queue.
    if (!urgent && queue.length >= MAX_QUEUE) return Promise.reject(new OndoError('local_backlog'));
    return new Promise((resolve, reject) => { queue.push({ urgent, resolve, reject }); pump(); });
  }
  function cool(response, sentAt) {
    const header = Number(response.headers?.get?.('retry-after'));
    // Requests sent before the last 429 was read belong to the same burst and count as one strike.
    const repeat = sentAt <= limitedAt && strikes > 0;
    const wait = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, MAX_COOLDOWN_MS) : COOLDOWN_MS[Math.min(repeat ? strikes - 1 : strikes, COOLDOWN_MS.length - 1)];
    if (!repeat) strikes += 1;
    limitedAt = now();
    cooldownUntil = Math.max(cooldownUntil, now() + wait);
    cancelUntil = Math.max(cancelUntil, now() + Math.min(wait, CANCEL_MAX_WAIT_MS));
  }
  const refuse = cancel => {
    if (closed) throw new OndoError('closed');
    const until = cancel ? Math.min(cooldownUntil, cancelUntil) : cooldownUntil;
    if (now() < until) throw new OndoError('rate_limited', { retryAt: until });
  };

  async function request(method, path, { body, auth = true, urgent = false, write = false, cancel = false } = {}, resigned = false) {
    refuse(cancel);
    await slot(urgent);
    refuse(cancel);
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { Accept: 'application/json', ...(text ? { 'Content-Type': 'application/json' } : {}) };
    if (auth) {
      if (!credentials) throw new OndoError('no_credentials');
      Object.assign(headers, ondoAuthHeaders(credentials, { timestamp: String(Math.trunc(now() + offset)), method, requestPath: path, body: text }));
    }
    const sentAt = now();
    const controller = new AbortController(); controllers.add(controller);
    const deadline = setTimeoutImpl(() => controller.abort(), timeoutMs);
    let response, payload = null;
    try {
      response = await fetchImpl(BASE + path, { method, headers, ...(text ? { body: text } : {}), signal: controller.signal, redirect: 'error', cache: 'no-store' });
      try { payload = await readJsonResponse(response, { maxBytes: MAX_BYTES, signal: controller.signal }); }
      catch (error) { if (error?.code === 'aborted' || controller.signal.aborted) throw error; }
    } catch {
      throw new OndoError(closed ? 'closed' : controller.signal.aborted ? 'timeout' : 'network', { uncertain: write });
    } finally { clearTimeoutImpl(deadline); controllers.delete(controller); }
    const status = response.status;
    if (status === 429) { cool(response, sentAt); throw new OndoError('rate_limited', { status, retryAt: cooldownUntil }); }
    if (status >= 500) throw new OndoError('upstream', { status, uncertain: write });
    const code = object(payload) && typeof payload.error_code === 'string' && CODE.test(payload.error_code) ? payload.error_code.toLowerCase() : null;
    if (status >= 200 && status < 300 && object(payload) && payload.success === true) { strikes = 0; return payload; }
    // A 2xx that is neither a success nor a coded refusal says nothing about what the venue did.
    if (status >= 200 && status < 300 && (!object(payload) || !code)) throw new OndoError('invalid_data', { status, uncertain: write });
    if (code && code.includes('timestamp') && auth && !resigned) {
      const date = Date.parse(response.headers?.get?.('date') ?? '');
      if (Number.isFinite(date)) { offset = date - now(); return request(method, path, { body, auth, urgent, write, cancel }, true); }
    }
    throw new OndoError(code ?? `http_${status}`, { status });
  }

  const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Invalid Ondo order id'); return value; };
  const market = value => { if (typeof value !== 'string' || !ONDO_MARKET.test(value)) throw new TypeError('Invalid Ondo market'); return value; };
  return {
    cooldownUntil: () => cooldownUntil,
    /** Trading rules of every perps market: Map market -> { tick, step, trading }. */
    async markets() {
      const pairs = (await request('GET', '/v1/markets', { auth: false })).result?.perps?.tradingPairs;
      if (!Array.isArray(pairs)) throw invalid();
      const rules = new Map();
      for (const pair of pairs) {
        if (!object(pair) || typeof pair.market !== 'string' || !ONDO_MARKET.test(pair.market)) continue;
        rules.set(pair.market, { tick: amount(pair.quoteIncrement, { positive: true }), step: amount(pair.baseIncrement, { positive: true }),
          trading: pair.tradingState === 'TRADING' && pair.disabled !== true });
      }
      return rules;
    },
    /** A post-only GTC limit order. Rejections carry the venue's code (post_only_has_match, ...). */
    async place({ market: name, side, price, size, reduceOnly = false, clientOrderId }) {
      if (!['buy', 'sell'].includes(side)) throw new TypeError('Invalid Ondo order side');
      const body = { market: market(name), side, price: decimal(price, { positive: true }), size: decimal(size, { positive: true }), type: 'limit',
        timeInForce: 'GTC', postOnly: true, reduceOnly: reduceOnly === true, clientOrderId: id(clientOrderId) };
      const payload = await request('POST', '/v1/perps/orders', { body, write: true, urgent: reduceOnly === true });
      // An accepted placement whose description cannot be read may be resting.
      try { return orderOf(payload.result); } catch { throw new OndoError('invalid_data', { status: 200, uncertain: true }); }
    },
    /** Cancels one order and returns it as cancelled, or null when the answer does not describe it. order_not_found, order_already_canceled and order_already_fully_filled are rejections. */
    async cancel(orderId) {
      const payload = await request('DELETE', `/v1/perps/orders/${id(orderId)}`, { write: true, urgent: true, cancel: true });
      try { return orderOf(payload.result); } catch { return null; }
    },
    /** The order with this client id, or null when the venue has none. */
    async orderByClientId(clientOrderId) {
      try { return orderOf((await request('GET', `/v1/perps/orders/client:${id(clientOrderId)}`, { urgent: true })).result); }
      catch (error) { if (error instanceof OndoError && (error.code === 'order_not_found' || error.status === 404)) return null; throw error; }
    },
    /** Every open order of the account. Fails with incomplete_data rather than return a partial list. */
    async openOrders() {
      const orders = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const payload = await request('GET', `/v1/perps/orders?status=open&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { urgent: true });
        if (!Array.isArray(payload.result)) throw invalid();
        for (const item of payload.result) orders.push(orderOf(item));
        const next = payload.pageInfo?.nextCursor;
        if (next === undefined || next === null || next === '' || payload.result.length === 0) return orders;
        if (typeof next !== 'string' || next.length > 256) throw invalid();
        cursor = next;
      }
      throw new OndoError('incomplete_data');
    },
    /** Signed position size per market: Map market -> decimal string (long > 0). */
    async positions() {
      const rows = (await request('GET', '/v1/perps/positions', { urgent: true })).result;
      if (!Array.isArray(rows)) throw invalid();
      const positions = new Map();
      for (const row of rows) {
        if (!object(row) || typeof row.market !== 'string' || !['long', 'short'].includes(row.direction)) throw invalid();
        const size = amount(String(row.netQuantity ?? '').replace(/^-/, ''), { nonnegative: true });
        if (positions.has(row.market)) throw invalid();
        positions.set(row.market, row.direction === 'short' && size !== '0' ? `-${size}` : size);
      }
      return positions;
    },
    close() {
      closed = true;
      if (timer !== null) { clearTimeoutImpl(timer); timer = null; }
      for (const item of queue.splice(0)) item.reject(new OndoError('closed'));
      for (const controller of controllers) controller.abort();
    },
  };
}
