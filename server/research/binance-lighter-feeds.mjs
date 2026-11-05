// Public market data only: fixed endpoints, no account, credential or order APIs.
const HTTP_URLS = Object.freeze({
  binance: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  lighter: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails',
});
const SYMBOLS = ['BTC', 'ETH'];
const BODY_LIMIT = 8_000_000;
const LEVEL_LIMIT = 25_000;
const HTTP_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 8_000;
const STALE_MS = 10_000;
const MAX_ATTEMPTS = 5;
const sharedCooldowns = {};
const DECODE_REASONS = new Set(['invalid_receive_clock', 'invalid_message', 'invalid_levels', 'invalid_level',
  'invalid_nonce', 'book_level_limit', 'missing_source_timestamp', 'source_timestamp_regression',
  'empty_or_crossed_book', 'symbol_type_mismatch', 'invalid_sequence', 'normal_quantity_missing', 'invalid_trade', 'book_api_error']);

export class CostFeedError extends Error {
  constructor(code, venue, details = {}) {
    super(code);
    this.name = 'CostFeedError';
    this.code = code;
    this.venue = venue;
    Object.assign(this, details);
  }
}

class CallbackFailure extends Error {
  constructor(cause) { super('feed_callback_failed', { cause }); }
}

function invoke(callback, value) {
  try { callback?.(value); } catch (cause) { throw new CallbackFailure(cause); }
}

function diagnostic(callback, value, now = Date.now) {
  invoke(callback, { at: now(), ...value });
}

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : NaN;
const positive = value => numeric(value) > 0 ? numeric(value) : NaN;
const timestamp = value => Number.isSafeInteger(numeric(value)) && numeric(value) > 0 ? numeric(value) : null;
// Bound before either regex scanning or BigInt conversion, including retained state.
const sequence = value => typeof value === 'string' && value.length > 0 && value.length <= 40 && /^\d+$/.test(value) ? BigInt(value).toString()
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const cooldownAt = (cooldowns, venue) => Number.isSafeInteger(cooldowns[venue]) && cooldowns[venue] > 0 ? cooldowns[venue] : 0;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function costRetryNotBefore({ status, headers, body, now = Date.now() }) {
  const raw = headers?.get?.('retry-after');
  const seconds = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const headerAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw || '');
  // Binance's documented -1003 IP-ban message carries its absolute deadline.
  const match = body?.code === -1003 && typeof body.msg === 'string' ? body.msg.match(/banned until (\d{10,16})/i) : null;
  const banAt = match ? Number(match[1]) : 0;
  const explicit = Math.max(Number.isSafeInteger(headerAt) ? headerAt : 0, Number.isSafeInteger(banAt) ? banAt : 0);
  return explicit > now ? explicit : now + (status === 418 ? 30 * 60_000 : 60_000);
}

async function readMetadata(venue, { signal, fetchImpl, onDiagnostic, cooldowns }) {
  const enforceCooldown = () => {
    signal?.throwIfAborted();
    const retryNotBefore = cooldownAt(cooldowns, venue);
    if (retryNotBefore > Date.now()) throw new CostFeedError('venue_cooldown', venue, { retryNotBefore });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    enforceCooldown();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let reader;
    let httpStatus;
    let rateError;
    let timer;
    const limited = (response, body) => {
      const retryNotBefore = Math.max(cooldownAt(cooldowns, venue), costRetryNotBefore({ status: response.status, headers: response.headers, body }));
      cooldowns[venue] = retryNotBefore;
      rateError = new CostFeedError('rate_limited', venue, { httpStatus: response.status, retryNotBefore });
      diagnostic(onDiagnostic, { venue, level: 'warn', event: 'cooldown', reason: rateError.code,
        httpStatus: response.status, retryNotBefore });
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new CostFeedError('http_timeout', venue);
        controller.abort(error);
        reject(error);
      }, HTTP_TIMEOUT_MS);
    });
    const aborted = new Promise((_, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([timeout, aborted, (async () => {
        const response = await fetchImpl(HTTP_URLS[venue], { method: 'GET', redirect: 'error', credentials: 'omit', signal: combined });
        combined.throwIfAborted();
        httpStatus = response.status;
        if (response.status === 418 || response.status === 429) limited(response, null);
        const length = response.headers?.get?.('content-length');
        if (length && Number(length) > BODY_LIMIT) throw new CostFeedError('metadata_body_limit', venue);
        if (!response.body?.getReader) throw new CostFeedError('metadata_body_missing', venue);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        while (true) {
          const chunk = await reader.read();
          combined.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > BODY_LIMIT) throw new CostFeedError('metadata_body_limit', venue);
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        let body;
        try { body = JSON.parse(text); }
        catch {
          if (!response.ok) throw new CostFeedError('http_error', venue, { httpStatus });
          throw new CostFeedError('metadata_invalid_json', venue);
        }
        if (body?.code === -1003 || rateError) limited(response, body);
        if (rateError) throw rateError;
        if (!response.ok) throw new CostFeedError('http_error', venue, { httpStatus });
        if (venue === 'lighter' && body?.code !== 200) throw new CostFeedError('metadata_api_error', venue);
        return parseCostMarkets(venue, body, Date.now());
      })()]);
      return result;
    } catch (cause) {
      if (cause instanceof CallbackFailure) throw cause;
      if (signal?.aborted) throw signal.reason;
      const error = rateError || (cause instanceof CostFeedError ? cause
        : new CostFeedError('http_transport_error', venue, { ...(httpStatus ? { httpStatus } : {}) }));
      const retryable = !rateError && (error.code === 'http_transport_error' || error.code === 'http_timeout'
        || error.code === 'http_error' && error.httpStatus >= 500);
      diagnostic(onDiagnostic, { venue, level: retryable && attempt < 2 ? 'warn' : 'error', event: 'metadata_failed',
        reason: error.code, attempt: attempt + 1, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
        ...(error.retryNotBefore ? { retryNotBefore: error.retryNotBefore } : {}) });
      if (!retryable || attempt === 2) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Release synchronously; an uncooperative stream cannot extend the deadline.
      try { void reader?.cancel().catch(() => {}); } catch { /* Already closed. */ }
    }
    await wait(250 * 2 ** attempt, signal);
  }
}

/** Only selected BTC/ETH rows are validated; unrelated directory rows are ignored. */
export function parseCostMarkets(venue, body, observedAt = Date.now()) {
  const rows = venue === 'binance' ? body?.symbols : venue === 'lighter' ? body?.order_book_details : null;
  if (!Array.isArray(rows) || !timestamp(observedAt)) throw new CostFeedError('metadata_schema_error', venue);
  const result = SYMBOLS.map(symbol => {
    const nativeSymbol = venue === 'binance' ? `${symbol}USDC` : symbol;
    const selected = rows.filter(row => row?.symbol === nativeSymbol);
    if (selected.length !== 1) throw new CostFeedError(selected.length ? 'duplicate_market' : 'missing_market', venue, { symbol });
    const raw = selected[0];
    let tickSize, quantityStep, minQuantity, minNotional;
    if (venue === 'binance') {
      if (raw.baseAsset !== symbol || raw.quoteAsset !== 'USDC' || raw.marginAsset !== 'USDC'
        || raw.contractType !== 'PERPETUAL' || raw.status !== 'TRADING') throw new CostFeedError('market_identity_mismatch', venue, { symbol });
      const filter = type => {
        const found = Array.isArray(raw.filters) ? raw.filters.filter(row => row?.filterType === type) : [];
        if (found.length !== 1) throw new CostFeedError('market_rules_invalid', venue, { symbol });
        return found[0];
      };
      tickSize = positive(filter('PRICE_FILTER').tickSize);
      const lot = filter('LOT_SIZE');
      quantityStep = positive(lot.stepSize);
      minQuantity = positive(lot.minQty);
      minNotional = positive(filter('MIN_NOTIONAL').notional);
    } else {
      if (!Number.isSafeInteger(raw.market_id) || raw.market_id < 0 || raw.market_type !== 'perp'
        || raw.status !== 'active' || positive(raw.multiplier) !== 1 || raw.is_frozen === true
        || raw.market_config?.force_reduce_only === true || raw.quote_multiplier !== undefined && positive(raw.quote_multiplier) !== 1) {
        throw new CostFeedError('market_identity_mismatch', venue, { symbol });
      }
      const decimals = kind => {
        const supported = raw[`supported_${kind}_decimals`];
        const actual = raw[`${kind}_decimals`];
        const value = supported ?? actual;
        if (!Number.isInteger(value) || value < 0 || value > 12 || supported !== undefined && actual !== undefined && supported !== actual) {
          throw new CostFeedError('market_rules_invalid', venue, { symbol });
        }
        return value;
      };
      tickSize = 10 ** -decimals('price');
      quantityStep = 10 ** -decimals('size');
      minQuantity = positive(raw.min_base_amount);
      minNotional = positive(raw.min_quote_amount);
    }
    if (![tickSize, quantityStep, minQuantity, minNotional].every(Number.isFinite)) {
      throw new CostFeedError('market_rules_invalid', venue, { symbol });
    }
    return { venue, symbol, nativeSymbol, marketId: venue === 'lighter' ? raw.market_id : null,
      quote: 'USDC', priceUnit: venue === 'lighter' ? 'USD' : 'USDC', settlement: 'USDC', status: 'active', multiplier: 1,
      tickSize, quantityStep, minQuantity, minNotional, observedAt };
  });
  if (venue === 'lighter' && result[0].marketId === result[1].marketId) throw new CostFeedError('duplicate_market_id', venue);
  return result;
}

export async function discoverCostMarkets({ signal, fetchImpl = fetch, onDiagnostic, cooldowns = sharedCooldowns } = {}) {
  signal?.throwIfAborted();
  const results = await Promise.allSettled(['binance', 'lighter'].map(venue => readMetadata(venue, { signal, fetchImpl, onDiagnostic, cooldowns })));
  signal?.throwIfAborted();
  const failures = results.filter(result => result.status === 'rejected');
  // Complete both reads so a parallel failure cannot hide a venue cooldown.
  if (failures.length) throw (failures.find(result => result.reason instanceof CallbackFailure)
    || failures.find(result => result.reason.retryNotBefore) || failures[0]).reason;
  return results.flatMap(result => result.value);
}

function validMarkets(markets) {
  const seen = new Set();
  const ids = new Set();
  if (!Array.isArray(markets) || !markets.length || markets.length > 4) throw new CostFeedError('markets_invalid');
  for (const market of markets) {
    const key = `${market?.venue}:${market?.symbol}`;
    if (!['binance', 'lighter'].includes(market?.venue) || !SYMBOLS.includes(market.symbol) || seen.has(key)
      || market.nativeSymbol !== (market.venue === 'binance' ? `${market.symbol}USDC` : market.symbol)
      || market.status !== 'active' || market.multiplier !== 1 || market.quote !== 'USDC' || market.settlement !== 'USDC'
      || market.priceUnit !== (market.venue === 'binance' ? 'USDC' : 'USD')
      || ![market.tickSize, market.quantityStep, market.minQuantity, market.minNotional].every(value => Number.isFinite(value) && value > 0)
      || market.venue === 'binance' && market.marketId !== null
      || market.venue === 'lighter' && (!Number.isSafeInteger(market.marketId) || market.marketId < 0 || ids.has(market.marketId))) {
      throw new CostFeedError('markets_invalid', market?.venue);
    }
    seen.add(key);
    if (market.venue === 'lighter') ids.add(market.marketId);
  }
  return markets;
}

function levels(rows) {
  if (!Array.isArray(rows) || rows.length > LEVEL_LIMIT) throw new Error('invalid_levels');
  const seen = new Set();
  return rows.map(row => {
    const price = positive(Array.isArray(row) ? row[0] : row?.price);
    const size = numeric(Array.isArray(row) ? row[1] : row?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size < 0 || seen.has(price)) throw new Error('invalid_level');
    seen.add(price);
    return [price, size];
  });
}

/** Stateful decoder shared by live feeds and deterministic replay tests. */
export function createCostFeedDecoder({ markets, onBook, onTrade, onStatus, onDiagnostic,
  resubscribe = () => {}, now = Date.now, mono = () => performance.now() }) {
  validMarkets(markets);
  const states = new Map();
  const statuses = new Map();
  const keyOf = (venue, channel, symbol) => `${venue}:${channel}:${symbol}`;
  function status(venue, channel, symbol, state, reason) {
    const key = keyOf(venue, channel, symbol);
    const signature = `${state}:${reason || ''}`;
    if (statuses.get(key) === signature) return;
    statuses.set(key, signature);
    invoke(onStatus, { venue, channel, symbol, state, ...(reason ? { reason } : {}), at: now() });
  }
  function invalidate(venue, channel, symbol, reason, state = 'stale') {
    for (const market of markets.filter(m => m.venue === venue && (!symbol || m.symbol === symbol))) {
      states.delete(keyOf(venue, channel, market.symbol));
      status(venue, channel, market.symbol, state, reason);
    }
  }
  function publish(market, state, bids, asks, sourceAt, seq, clocks) {
    if (!sourceAt) throw new Error('missing_source_timestamp');
    if (state.sourceAt > sourceAt) throw new Error('source_timestamp_regression');
    const sortedBids = bids.filter(row => row[1] > 0).sort((a, b) => b[0] - a[0]).slice(0, 50);
    const sortedAsks = asks.filter(row => row[1] > 0).sort((a, b) => a[0] - b[0]).slice(0, 50);
    if (!sortedBids.length || !sortedAsks.length || sortedBids[0][0] >= sortedAsks[0][0]) throw new Error('empty_or_crossed_book');
    Object.assign(state, { sourceAt, receivedMono: clocks.receivedMono, sequence: seq });
    states.set(keyOf(market.venue, 'book', market.symbol), state);
    status(market.venue, 'book', market.symbol, 'live');
    invoke(onBook, { venue: market.venue, symbol: market.symbol, nativeSymbol: market.nativeSymbol,
      bids: sortedBids, asks: sortedAsks, sourceAt, ...clocks, sequence: seq });
  }
  function handle(venue, channel, raw, clocks = { receivedAt: now(), receivedMono: mono() }) {
    let payload;
    let market;
    try {
      if (!Number.isFinite(clocks.receivedMono) || !timestamp(clocks.receivedAt)) throw new Error('invalid_receive_clock');
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!payload || typeof payload !== 'object') throw new Error('invalid_message');
      if (venue === 'lighter' && channel === 'book') {
        if (!['subscribed/order_book', 'update/order_book'].includes(payload.type)) return null;
        const id = typeof payload.channel === 'string' ? payload.channel.match(/^order_book:(\d+)$/)?.[1] : null;
        market = markets.find(m => m.venue === venue && String(m.marketId) === id);
        if (!market) return null;
        const ob = payload.order_book;
        if (ob?.code !== undefined && ob.code !== 0) throw new Error('book_api_error');
        const seq = sequence(ob?.nonce);
        if (seq === null) throw new Error('invalid_nonce');
        const begin = ob.begin_nonce === undefined ? null : sequence(ob.begin_nonce);
        if (ob.begin_nonce !== undefined && begin === null) throw new Error('invalid_nonce');
        const key = keyOf(venue, channel, market.symbol);
        let state = states.get(key);
        const previousSeq = state ? sequence(state.sequence) : null;
        if (state && previousSeq === null) throw new Error('invalid_nonce');
        if (previousSeq !== null && BigInt(seq) <= BigInt(previousSeq)) return null;
        if (payload.type === 'subscribed/order_book') state = { bids: new Map(), asks: new Map(), sourceAt: state?.sourceAt };
        else {
          if (!state) return null;
          if (begin !== previousSeq) {
            invalidate(venue, channel, market.symbol, 'sequence_gap');
            diagnostic(onDiagnostic, { venue, channel, symbol: market.symbol, level: 'warn', event: 'invalidated', reason: 'sequence_gap' }, now);
            invoke(resubscribe, market);
            return null;
          }
        }
        // Validate both sides before mutating the retained full-depth state.
        const changes = [levels(ob.bids), levels(ob.asks)];
        for (const [index, side] of [state.bids, state.asks].entries()) {
          for (const [price, size] of changes[index]) { if (size === 0) side.delete(price); else side.set(price, size); }
          if (side.size > LEVEL_LIMIT) throw new Error('book_level_limit');
        }
        const sourceAt = timestamp(ob.last_updated_at ?? payload.last_updated_at);
        publish(market, state, [...state.bids], [...state.asks], sourceAt ? sourceAt / 1000 : null, seq, clocks);
      } else if (venue === 'binance') {
        const data = payload.data ?? payload;
        if (data.e !== (channel === 'book' ? 'depthUpdate' : 'aggTrade')) return null;
        market = markets.find(m => m.venue === venue && m.nativeSymbol === data.s);
        if (!market) return null;
        if (data.st !== undefined && data.st !== 1) throw new Error('symbol_type_mismatch');
        const key = keyOf(venue, channel, market.symbol);
        const previous = states.get(key);
        const seq = sequence(channel === 'book' ? data.u : data.a);
        const previousSeq = previous ? sequence(previous.sequence) : null;
        const previousUpdate = channel === 'book' && data.pu !== undefined ? sequence(data.pu) : null;
        const sourceAt = timestamp(data.T ?? data.E);
        if (seq === null || previous && previousSeq === null || channel === 'book' && data.pu !== undefined && previousUpdate === null) {
          throw new Error('invalid_sequence');
        }
        if (previousSeq !== null && BigInt(seq) <= BigInt(previousSeq)) return null;
        if (!sourceAt) throw new Error('missing_source_timestamp');
        if (previous?.sourceAt > sourceAt) throw new Error('source_timestamp_regression');
        if (previous && (channel === 'trades' ? BigInt(seq) !== BigInt(previousSeq) + 1n
          : data.pu !== undefined && previousUpdate !== previousSeq)) {
          // A new full book or trade is usable only after consumers discard old queue evidence.
          invalidate(venue, channel, market.symbol, 'sequence_gap');
        }
        if (channel === 'book') publish(market, {}, levels(data.b), levels(data.a), sourceAt, seq, clocks);
        else {
          const price = positive(data.p);
          const quantity = numeric(data.nq);
          if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity < 0 || typeof data.m !== 'boolean') {
            throw new Error(data.nq === undefined ? 'normal_quantity_missing' : 'invalid_trade');
          }
          // q includes hidden RPI liquidity; only nq may consume a normal maker queue.
          states.set(key, { sequence: seq, sourceAt, receivedMono: clocks.receivedMono });
          status(venue, channel, market.symbol, 'live');
          // Even nq=0 reaches the consumer so it can validate source freshness
          // before treating this channel as recovered. It cannot fill a queue.
          invoke(onTrade, { venue, symbol: market.symbol, price, quantity, buyerMaker: data.m,
            sourceAt, ...clocks, sequence: seq });
        }
      } else return null;
      return market.symbol;
    } catch (error) {
      if (error instanceof CallbackFailure) throw error;
      const reason = error instanceof SyntaxError ? 'invalid_json' : DECODE_REASONS.has(error.message) ? error.message : 'invalid_message';
      invalidate(venue, channel, market?.symbol, reason, 'fault');
      diagnostic(onDiagnostic, { venue, channel, ...(market ? { symbol: market.symbol } : {}), level: 'warn', event: 'invalidated', reason }, now);
      if (venue === 'lighter' && market) invoke(resubscribe, market);
      return null;
    }
  }
  return { handle, invalidate, status, states,
    lastReceived: (venue, channel, symbol) => states.get(keyOf(venue, channel, symbol))?.receivedMono };
}

/** Three supervised required sockets. An exhausted channel terminates the entire feed set. */
export function startCostFeeds({ markets, onBook, onTrade, onStatus, onDiagnostic, signal,
  WebSocketImpl = WebSocket, now = Date.now, mono = () => performance.now(), cooldowns = sharedCooldowns }) {
  validMarkets(markets);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const sockets = new Set();
  const connections = [
    { venue: 'binance', channel: 'book', base: 'wss://fstream.binance.com/public/stream?streams=', suffix: '@depth20@100ms' },
    { venue: 'binance', channel: 'trades', base: 'wss://fstream.binance.com/market/stream?streams=', suffix: '@aggTrade' },
    { venue: 'lighter', channel: 'book', base: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true' },
  ].filter(connection => markets.some(m => m.venue === connection.venue));

  async function supervise(connection) {
    const { venue, channel } = connection;
    const selected = markets.filter(m => m.venue === venue);
    let failures = 0;
    let stopReported = false;
    try {
      while (!combined.aborted) {
      while (cooldownAt(cooldowns, venue) > now() && !combined.aborted) {
        invoke(onStatus, { venue, channel, state: 'connecting', reason: 'venue_cooldown', at: now() });
        try { await wait(Math.min(cooldownAt(cooldowns, venue) - now(), 60_000), combined); } catch { return; }
      }
      if (combined.aborted) return;
      const result = await new Promise((resolve, reject) => {
        let ws;
        let finished = false;
        let opened = false;
        let openedMono = mono();
        let deadline;
        let heartbeat;
        let watchdog;
        const healthy = new Set();
        const resyncs = new Map();
        const decoder = createCostFeedDecoder({ markets: selected, onBook, onTrade, onStatus, onDiagnostic, now, mono,
          resubscribe(market) {
            const attempts = (resyncs.get(market.symbol) || 0) + 1;
            resyncs.set(market.symbol, attempts);
            if (attempts > 3) { finish('resync_exhausted'); return; }
            send({ type: 'unsubscribe', channel: `order_book/${market.marketId}` });
            send({ type: 'subscribe', channel: `order_book/${market.marketId}` });
          } });
        const send = body => { if (!finished && ws?.readyState === 1) ws.send(JSON.stringify(body)); };
        function finish(reason, fatal) {
          if (finished) return;
          finished = true;
          if (reason === 'stopped') stopReported = true;
          clearTimeout(deadline);
          clearInterval(heartbeat);
          clearInterval(watchdog);
          combined.removeEventListener('abort', abort);
          // Detach first: late close/message events must not revive invalidated books.
          if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            sockets.delete(ws);
            try { ws.close(); } catch { /* Closing an unopened socket is implementation dependent. */ }
          }
          try { decoder.invalidate(venue, channel, null, reason, 'disconnected'); } catch (error) { fatal ||= error; }
          if (fatal) reject(fatal); else resolve({ healthy: healthy.size === selected.length, reason });
        }
        const abort = () => finish('stopped');
        const guard = action => { try { action(); } catch (error) { finish('callback_or_socket_failure', error); } };
        combined.addEventListener('abort', abort, { once: true });
        guard(() => {
          for (const market of selected) decoder.status(venue, channel, market.symbol, 'connecting');
          if (combined.aborted) { finish('stopped'); return; }
          const url = venue === 'lighter' ? connection.base
            : connection.base + selected.map(m => m.nativeSymbol.toLowerCase() + connection.suffix).join('/');
          try { ws = new WebSocketImpl(url); sockets.add(ws); }
          catch { finish('connection_failed'); return; }
          deadline = setTimeout(() => finish('connect_timeout'), CONNECT_TIMEOUT_MS);
          ws.onopen = () => guard(() => {
            if (finished) return;
            opened = true;
            openedMono = mono();
            clearTimeout(deadline);
            if (venue === 'lighter') for (const market of selected) send({ type: 'subscribe', channel: `order_book/${market.marketId}` });
            heartbeat = setInterval(() => guard(() => send(venue === 'lighter' ? { type: 'ping' }
              : { method: 'LIST_SUBSCRIPTIONS', id: 1 })), 30_000);
            watchdog = setInterval(() => guard(() => {
              const stale = selected.filter(m => mono() - (decoder.lastReceived(venue, channel, m.symbol) ?? openedMono) >= STALE_MS);
              if (stale.length) {
                for (const market of stale) decoder.invalidate(venue, channel, market.symbol, 'stale_timeout');
                finish('stale_timeout');
              }
            }), 1_000);
          });
          ws.onmessage = event => guard(() => {
            if (finished || !opened) return;
            const raw = event.data;
            if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > BODY_LIMIT) { finish('message_limit'); return; }
            let control;
            try { control = JSON.parse(raw); } catch { /* Decoder emits the schema failure. */ }
            if (control?.type === 'ping') send({ type: 'pong' });
            if (control?.error || control?.code !== undefined && control?.msg !== undefined) {
              decoder.invalidate(venue, channel, null, 'subscription_error', 'fault');
              finish('subscription_error');
              return;
            }
            const symbol = decoder.handle(venue, channel, raw, { receivedAt: now(), receivedMono: mono() });
            if (symbol) healthy.add(symbol);
          });
          ws.onerror = () => finish('socket_error');
          ws.onclose = () => finish('disconnected');
        });
      });
      if (combined.aborted) return;
      // Opening a socket or receiving a heartbeat never resets the failure budget.
      failures = result.healthy ? 1 : failures + 1;
      if (failures >= MAX_ATTEMPTS) {
        for (const market of selected) invoke(onStatus, { venue, channel, symbol: market.symbol, state: 'fault', reason: 'reconnect_exhausted', at: now() });
        diagnostic(onDiagnostic, { venue, channel, level: 'error', event: 'reconnect_exhausted', attempts: failures, reason: result.reason }, now);
        throw new CostFeedError('reconnect_exhausted', venue, { channel, attempts: failures });
      }
      diagnostic(onDiagnostic, { venue, channel, level: 'warn', event: 'reconnect_wait', attempt: failures, waitMs: 1000 * 2 ** (failures - 1), reason: result.reason }, now);
      try { await wait(1000 * 2 ** (failures - 1), combined); } catch { return; }
      }
    } finally {
      if (combined.aborted && !stopReported) for (const market of selected) {
        invoke(onStatus, { venue, channel, symbol: market.symbol, state: 'disconnected', reason: 'stopped', at: now() });
      }
    }
  }
  const tasks = connections.map(supervise);
  const done = Promise.all(tasks).then(() => undefined).catch(async error => {
    controller.abort(error);
    await Promise.allSettled(tasks);
    throw error;
  });
  return { done, async stop() { controller.abort(); for (const ws of sockets) { try { ws.close(); } catch { /* Already closed. */ } } await done; } };
}
