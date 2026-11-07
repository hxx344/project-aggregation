import { createHash } from 'node:crypto';
import { compareDecimals, decimal } from './trading-decimal.mjs';
import { EXECUTION_VENUE_SYMBOLS, executionSymbols } from './trading-markets.mjs';
import { createRhLighterSigner } from './trading-rh-lighter-signer.mjs';

// Lighter on Robinhood Chain (USDG perps) through one API key of one account.
// The signer worker can only build CreateOrder, CancelOrder and auth tokens:
// no transfer, withdrawal, leverage, margin or key change exists here.
// Chase legs are post-only limit orders; repricing cancels by client order
// index and the engine re-sends the remainder once the cancel is terminal.
// Market legs are IOC limit orders priced 1% through the opposite book.
// https://docs.lighter.xyz/developers/robinhood-chain/overview
// https://docs.lighter.xyz/developers/reference/rate-limits
const HOST = 'https://api.rh.lighter.xyz';
const READ_PATHS = new Set(['/api/v1/orderBooks', '/api/v1/orderBookDetails', '/api/v1/orderBookOrders', '/api/v1/account',
  '/api/v1/accountsByL1Address', '/api/v1/accountActiveOrders', '/api/v1/accountOrders', '/api/v1/nextNonce']);
const SEND_PATH = '/api/v1/sendTx';
export const RH_LIGHTER_SYMBOLS = EXECUTION_VENUE_SYMBOLS['rh-lighter'];
// lighter-go signs every transaction with ExpiredAt = signing time + 10 min - 1 s
// (client.DefaultExpireTime); an unanswered create can execute until then.
export const RH_LIGHTER_TX_EXPIRES_MS = 600_000;
// Standard accounts get 60 requests per rolling minute, sendTx included, with a
// 60 s firewall cooldown once exceeded. Unauthenticated reads count per IP and
// L1 address; authenticated reads and sendTx count per L1 address only (checked
// against the rate-limit page on 2026-11-07). The monitor, asset and position
// alert reads are unauthenticated, so they spend the IP bucket; this client's
// authenticated traffic shares the L1 bucket with the operator's own app and
// every sub-account of the same owner, and keeps a third of it free.
const REQUESTS_PER_MINUTE = 40;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_WAIT_MS = 8000;
const COOLDOWN_MS = 60_000;
// The engine ticks every second and the display quotes poll every 2 s. These
// keep one working order near 30 reads per minute and the display near 10.
const BOOK_TTL = 4000;
const DISPLAY_BOOK_TTL = 6000;
const ORDER_TTL = 4000;
const MARKET_ID_TTL = 600_000;
const RULE_TTL = 60_000;
const IDENTITY_TTL = 60_000;
const AUTH_LIFETIME_S = 1800;
const AUTH_REFRESH_MS = 600_000;
// A create is accepted into the sequencer queue; the order shows up once executed.
const VISIBLE_WAIT_MS = 1500;
const VISIBLE_RETRY_MS = 1000;
// A task runs at most one hour (trading-execution-plan timeoutMs). A resting
// order the engine can no longer cancel expires at the venue soon after
// instead of resting for weeks; the venue accepts 5 min .. 30 days.
const CHASE_EXPIRY_MS = 2 * 3_600_000;
const MARKET_SLIPPAGE = 1n; // percent through the opposite best price
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_ORDER_QUANTITY = '100000';
const MAX_CLIENT_ORDER_INDEX = (1n << 48n) - 1n;
const MAX_BASE_AMOUNT = (1n << 48n) - 1n;
const MAX_PRICE = (1n << 32n) - 1n;
const SCALE = 10n ** 18n;
const WORKING = new Set(['open', 'pending', 'in-progress']);
const TERMINAL = new Set(['filled', 'canceled', 'canceled-post-only', 'canceled-reduce-only', 'canceled-position-not-allowed', 'canceled-margin-not-allowed',
  'canceled-too-much-slippage', 'canceled-not-enough-liquidity', 'canceled-self-trade', 'canceled-expired', 'canceled-oco', 'canceled-child',
  'canceled-liquidation', 'canceled-invalid-balance']);
// sendTx answers HTTP 400 with a result code when it refuses a transaction
// before queueing it. 21728 means an order with this client index already
// exists, so the earlier send may have landed: that stays uncertain.
const REJECTIONS = Object.freeze({
  21104: 'nonce 无效，请重试', 21109: 'API Key 不存在或已更换', 21120: '签名无效，请核对 API 私钥与索引',
  21701: '委托数量无效', 21702: '委托价格无效', 21706: '委托数量或价格无效', 21733: '委托价格偏离标记价格过大', 21734: '委托价格偏离标记价格过大',
  21753: '委托价格偏离标记价格过大', 21738: '只减仓委托会增加仓位', 21739: '保证金不足', 23000: '请求过于频繁', 52002: '账户已达到 Standard 限额，只能减仓',
  21600: '订单已成交、已撤销或不存在', 21709: '订单已成交、已撤销或不存在', 21715: '订单已成交、已撤销或不存在',
});
const UNCERTAIN_CODES = new Set([21728]);
const AUTH_CODES = new Set([20013, 21109, 21120]);
const GATEWAY_REFUSALS = new Set([403, 404, 413, 415, 422]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const units = value => {
  const [integer, fraction = ''] = decimal(value).split('.');
  const negative = integer.startsWith('-');
  const magnitude = BigInt(negative ? integer.slice(1) : integer) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -magnitude : magnitude;
};
const fromUnits = value => {
  const negative = value < 0n, magnitude = negative ? -value : value;
  const fraction = String(magnitude % SCALE).padStart(18, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + String(magnitude / SCALE) + (fraction ? '.' + fraction : '');
};
const stepOf = decimals => fromUnits(SCALE / 10n ** BigInt(decimals));

/** Client order index (1 .. 2^48 - 1) for an engine client id. */
export function clientOrderIndexOf(clientId) {
  const value = BigInt('0x' + createHash('sha256').update('rh-lighter:' + clientId).digest('hex').slice(0, 16));
  return Number(value % MAX_CLIENT_ORDER_INDEX + 1n);
}

function onTick(price, tickSize) {
  try { const tick = units(tickSize); return tick > 0n && units(decimal(price, { positive: true })) % tick === 0n; } catch { return false; }
}

export function protectivePrice(side, bestPrice, tickSize) {
  const best = units(bestPrice), tick = units(tickSize);
  const target = side === 'buy' ? best * (100n + MARKET_SLIPPAGE) / 100n : best * (100n - MARKET_SLIPPAGE) / 100n;
  const rounded = target / tick * tick + (side === 'buy' && target % tick !== 0n ? tick : 0n);
  return rounded > 0n ? fromUnits(rounded) : null;
}

/**
 * Wire price of an order spec and why it cannot be sent. Synchronous and
 * network-free, so the engine runs it for every leg before any leg is sent.
 */
export function orderPrice(spec, tickSize) {
  const price = spec.orderType === 'market' ? protectivePrice(spec.side, spec.limitPrice, tickSize) : spec.limitPrice;
  if (!price || !onTick(price, tickSize) || units(price) / units(tickSize) > MAX_PRICE) return { price: null, problem: '价格不满足 Lighter RH 精度' };
  if (spec.stopPrice && (spec.side === 'buy' ? compareDecimals(price, spec.stopPrice) >= 0 : compareDecimals(price, spec.stopPrice) <= 0)) return { price: null, problem: '委托价已达到追价界限' };
  return { price, problem: null };
}

export function createRhLighterExecutionClient({ ErrorClass, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000, signer = null,
  sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); }) } = {}) {
  if (typeof ErrorClass !== 'function') throw new TypeError('ExecutionExchangeError is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeout is invalid');
  const fail = (code = 'invalid_data', details) => { throw new ErrorClass(code, details); };
  const checkAbort = signal => { if (signal?.aborted) fail('aborted'); };
  // A request the rate limit refused (locally, in cooldown or by the venue
  // firewall) carries when the next one can be admitted.
  const limited = (mutation, detail, retryAt, providerCode) => { throw Object.assign(new ErrorClass(mutation ? 'rejected' : 'upstream', { detail, providerCode }), { rateLimited: true, retryAt }); };
  const amount = (value, options = {}) => {
    try { if (typeof value !== 'string') fail(); return decimal(value, options); } catch { return fail(); }
  };
  const integerOf = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); return value; };
  let sign = signer;
  const signerOf = () => (sign ??= createRhLighterSigner());
  const marketIds = new Map(), rules = new Map(), books = new Map(), orderReads = new Map(), identities = new Map(), tokens = new Map(), nonces = new Map();
  const sent = [];
  // generation is bumped by forget(): a call still in flight then cannot put a token, identity,
  // nonce or order read back, nor start a signer worker for the forgotten key.
  let cooldownUntil = 0, shared = null, mutations = Promise.resolve(), generation = 0;

  function keys(credentials) {
    if (!object(credentials) || typeof credentials.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(credentials.address)
      || !Number.isSafeInteger(credentials.accountIndex) || credentials.accountIndex < 1
      || !Number.isSafeInteger(credentials.apiKeyIndex) || credentials.apiKeyIndex < 4 || credentials.apiKeyIndex > 254 || credentials.apiKeyIndex === 157
      || typeof credentials.apiKey !== 'string' || !/^(?:0x)?[0-9a-fA-F]{80}$/.test(credentials.apiKey)) fail('credentials');
    const privateKey = credentials.apiKey.replace(/^0x/, '').toLowerCase();
    return { address: credentials.address.toLowerCase(), accountIndex: credentials.accountIndex, apiKeyIndex: credentials.apiKeyIndex, privateKey,
      era: generation, slot: `${credentials.accountIndex}:${credentials.apiKeyIndex}`, fingerprint: createHash('sha256').update(`${credentials.accountIndex}:${credentials.apiKeyIndex}:${privateKey}`).digest('hex') };
  }

  async function readJson(response, signal) {
    const length = response.headers?.get?.('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('response_limit');
    if (!response.body?.getReader) fail();
    const reader = response.body.getReader(), chunks = [];
    let size = 0, done = false;
    try {
      while (true) {
        checkAbort(signal);
        const chunk = await reader.read();
        checkAbort(signal);
        if (chunk.done) { done = true; break; }
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) fail('response_limit');
        chunks.push(Buffer.from(chunk.value));
      }
      try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { return fail(); }
    } finally {
      if (!done) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // Sliding one-minute window shared by reads and sends. A request that would
  // wait longer than MAX_RATE_WAIT_MS fails before anything is sent.
  async function admit(signal, mutation) {
    while (true) {
      const time = now();
      if (time < cooldownUntil) limited(mutation, '请求过于频繁，Lighter RH 冷却中', cooldownUntil);
      while (sent.length && sent[0] <= time - RATE_WINDOW_MS) sent.shift();
      if (sent.length < REQUESTS_PER_MINUTE) { sent.push(time); return; }
      const wait = sent[0] + RATE_WINDOW_MS - time;
      if (wait > MAX_RATE_WAIT_MS) limited(mutation, '请求过于频繁，已达到本地限速', sent[0] + RATE_WINDOW_MS);
      await sleep(wait, signal);
      checkAbort(signal);
    }
  }

  async function request(path, { query, form, token, signal, beforeMutation } = {}) {
    const mutation = path === SEND_PATH;
    if (mutation ? !form : !READ_PATHS.has(path) || form) fail('configuration');
    checkAbort(signal);
    await admit(signal, mutation);
    checkAbort(signal);
    const url = HOST + path + (query ? '?' + new URLSearchParams(query).toString() : '');
    const headers = { Accept: 'application/json', ...(token ? { Authorization: token } : {}), ...(mutation ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) };
    const body = mutation ? new URLSearchParams(form).toString() : undefined;
    // No await between the final lease guard and dispatch.
    if (mutation) beforeMutation?.();
    const controller = new AbortController();
    let timedOut = false, dispatched = false, abortListener;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const interrupted = new Promise((_resolve, reject) => {
      abortListener = () => reject(new ErrorClass(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched }));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      checkAbort(signal);
      const run = async () => {
        dispatched = true;
        const response = await fetchImpl(url, { method: mutation ? 'POST' : 'GET', headers, body, redirect: 'error', cache: 'no-store', signal: controller.signal });
        checkAbort(controller.signal);
        if (!response || response.redirected || response.status >= 300 && response.status < 400) fail('upstream', { uncertain: mutation });
        if (response.status === 429 || response.status === 405) {
          cooldownUntil = now() + COOLDOWN_MS;
          limited(mutation, '请求过于频繁', cooldownUntil);
        }
        if (GATEWAY_REFUSALS.has(response.status)) fail(mutation ? 'rejected' : 'upstream');
        // An expired or foreign auth token is answered 401 with code 20013.
        if (response.status === 400 || response.status === 401) {
          let data = null;
          try { data = await readJson(response, controller.signal); } catch (error) { if (!mutation) throw error; }
          const code = object(data) && Number.isSafeInteger(data.code) ? data.code : null;
          if (code === 23000) { cooldownUntil = now() + COOLDOWN_MS; limited(mutation, REJECTIONS[23000], cooldownUntil, code); }
          if (mutation && UNCERTAIN_CODES.has(code)) fail('upstream', { providerCode: code, uncertain: true });
          if (AUTH_CODES.has(code)) dropToken(token);
          if (AUTH_CODES.has(code)) fail('permissions', { providerCode: code, detail: 'API 私钥与账户或 API Key 索引不匹配，或已被更换' });
          fail(mutation ? 'rejected' : 'upstream', { providerCode: code ?? undefined, detail: code === null ? undefined : REJECTIONS[code] ?? `代码 ${code}` });
        }
        if (!response.ok) fail('upstream', { uncertain: mutation });
        const data = await readJson(response, controller.signal);
        if (!object(data)) fail('invalid_data', { uncertain: mutation });
        if (data.code !== 200 && data.code !== undefined) {
          // A send answered 200 with code 23000 keeps the uncertain path below; a read is a plain rate limit.
          if (data.code === 23000) { cooldownUntil = now() + COOLDOWN_MS; if (!mutation) limited(false, REJECTIONS[23000], cooldownUntil, 23000); }
          if (AUTH_CODES.has(data.code)) dropToken(token);
          if (AUTH_CODES.has(data.code) && !mutation) fail('permissions', { providerCode: data.code, detail: 'API 私钥与账户或 API Key 索引不匹配，或已被更换' });
          fail('upstream', { providerCode: Number.isSafeInteger(data.code) ? data.code : undefined, uncertain: mutation });
        }
        return data;
      };
      return await Promise.race([run(), interrupted]);
    } catch (error) {
      if (timedOut || signal?.aborted) throw new ErrorClass(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched });
      if (error instanceof ErrorClass) {
        if (mutation && dispatched && ['invalid_data', 'response_limit', 'transport', 'aborted'].includes(error.code)) error.uncertain = true;
        throw error;
      }
      throw new ErrorClass('transport', { uncertain: mutation && dispatched });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }

  async function signed(k, method, params) {
    // A key forgotten while this call waited is not handed to a new signer worker.
    if (k.era !== generation) fail('aborted');
    let result;
    try { result = await signerOf()[method](params); } catch { fail('credentials', { detail: 'Lighter RH 签名失败，请核对 API 私钥与索引' }); }
    if (!object(result)) fail('credentials');
    return result;
  }

  // A token the venue refused is signed again on the next request instead of being reused for 20 minutes.
  function dropToken(token) {
    if (!token) return;
    for (const [key, entry] of tokens) if (entry.token === token) tokens.delete(key);
    if (shared?.token === token) shared = null;
  }
  async function tokenFor(k, signal) {
    const cached = tokens.get(k.fingerprint);
    if (cached && cached.until > now()) { shared = cached; return cached.token; }
    const deadline = Math.floor(now() / 1000) + AUTH_LIFETIME_S;
    const { authToken } = await signed(k, 'authToken', { privateKey: k.privateKey, apiKeyIndex: k.apiKeyIndex, accountIndex: k.accountIndex, deadline });
    checkAbort(signal);
    if (typeof authToken !== 'string' || !authToken.startsWith(`${deadline}:${k.accountIndex}:${k.apiKeyIndex}:`) || authToken.length > 1024) fail('credentials');
    const entry = { token: authToken, until: deadline * 1000 - AUTH_REFRESH_MS };
    if (k.era === generation) { tokens.set(k.fingerprint, entry); shared = entry; }
    return authToken;
  }
  // Market reads carry the last account token: authenticated requests count
  // against the L1 address only, not the IP shared with the monitor.
  const publicToken = () => shared && shared.until > now() ? shared.token : undefined;

  async function marketIdOf(symbol, signal) {
    if (!RH_LIGHTER_SYMBOLS.includes(symbol)) fail('input');
    const cached = marketIds.get(symbol);
    if (cached && cached.until > now()) return cached.id;
    const data = await request('/api/v1/orderBooks', { token: publicToken(), signal });
    if (!Array.isArray(data.order_books) || data.order_books.length > 10_000) fail();
    const matches = data.order_books.filter(row => object(row) && row.symbol === symbol && row.market_type === 'perp');
    if (matches.length !== 1) fail('not_tradable');
    const id = integerOf(matches[0].market_id, 0, 65_535);
    marketIds.set(symbol, { id, until: now() + MARKET_ID_TTL });
    return id;
  }

  async function ruleOf(symbol, signal) {
    const marketId = await marketIdOf(symbol, signal);
    const cached = rules.get(symbol);
    if (cached && cached.until > now() && cached.rule.assetId === marketId) return cached.rule;
    const data = await request('/api/v1/orderBookDetails', { query: { market_id: String(marketId) }, token: publicToken(), signal });
    const rows = Array.isArray(data.order_book_details) ? data.order_book_details : [];
    if (rows.length !== 1 || !object(rows[0])) fail();
    const row = rows[0];
    if (row.market_id !== marketId || row.symbol !== symbol || row.market_type !== 'perp') { marketIds.delete(symbol); fail('not_tradable', { detail: '合约编号已变化，请重新预览' }); }
    if (row.status !== 'active' || row.is_frozen === true) fail('not_tradable');
    const sizeDecimals = integerOf(row.size_decimals, 0, 8), priceDecimals = integerOf(row.price_decimals, 0, 8);
    const quantityStep = stepOf(sizeDecimals), minBase = amount(row.min_base_amount, { nonnegative: true });
    const imf = integerOf(row.default_initial_margin_fraction, 1, 10_000);
    const rule = {
      assetId: marketId, tickSize: stepOf(priceDecimals), quantityStep,
      minQuantity: compareDecimals(minBase, quantityStep) > 0 ? minBase : quantityStep,
      maxQuantity: MAX_ORDER_QUANTITY, maxMarketQuantity: MAX_ORDER_QUANTITY,
      minNotional: amount(row.min_quote_amount, { nonnegative: true }), maxNotional: amount(row.order_quote_limit, { positive: true }), quoteAsset: 'USDG',
      defaultLeverage: Math.max(1, Math.floor(10_000 / imf)),
    };
    if (units(rule.minQuantity) % units(quantityStep) !== 0n) fail();
    rules.set(symbol, { rule, until: now() + RULE_TTL });
    return rule;
  }

  function bestOf(rows, side) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 250) fail('not_tradable', { detail: '盘口为空' });
    let best = null;
    for (const row of rows) {
      if (!object(row)) fail();
      const price = amount(row.price, { positive: true });
      amount(row.remaining_base_amount, { positive: true });
      if (best === null || (side === 'bid' ? compareDecimals(price, best) > 0 : compareDecimals(price, best) < 0)) best = price;
    }
    return best;
  }

  async function market(symbol, { signal, withRule = true } = {}) {
    if (!RH_LIGHTER_SYMBOLS.includes(symbol)) fail('input');
    const rule = await ruleOf(symbol, signal);
    let book = books.get(rule.assetId);
    if (!book || now() - book.received >= (withRule ? BOOK_TTL : DISPLAY_BOOK_TTL)) {
      const data = await request('/api/v1/orderBookOrders', { query: { market_id: String(rule.assetId), limit: '5' }, token: publicToken(), signal });
      const bid = bestOf(data.bids, 'bid'), ask = bestOf(data.asks, 'ask');
      if (compareDecimals(bid, ask) >= 0) fail();
      // The venue sends no book timestamp: the receive time is the honest age.
      book = { bid, ask, received: now() };
      books.set(rule.assetId, book);
    }
    const result = { symbol, bid: book.bid, ask: book.ask, at: new Date(book.received).toISOString() };
    if (!withRule) return result;
    const { defaultLeverage, ...limits } = rule;
    return { ...result, rule: limits };
  }

  async function verify(credentials, { signal } = {}) {
    const k = keys(credentials);
    const label = `${k.accountIndex}#${k.apiKeyIndex}`;
    const cached = identities.get(k.fingerprint);
    if (cached && cached.until > now() && cached.address === k.address) return { identity: k.address, keyLabel: label };
    const owned = await request('/api/v1/accountsByL1Address', { query: { l1_address: credentials.address }, signal }).catch(error => {
      if (error instanceof ErrorClass && error.code === 'upstream' && error.providerCode && error.providerCode !== 23000) fail('permissions', { detail: '该钱包地址在 Lighter RH 没有账户' });
      throw error;
    });
    if (!Array.isArray(owned.sub_accounts) || owned.sub_accounts.length > 1000) fail();
    const match = owned.sub_accounts.filter(row => object(row) && row.index === k.accountIndex);
    if (match.length !== 1 || typeof match[0].l1_address !== 'string' || match[0].l1_address.toLowerCase() !== k.address) fail('permissions', { detail: '账户索引不属于该钱包地址' });
    // The server checks the token against the public key registered for this account and key index.
    const token = await tokenFor(k, signal);
    const data = await request('/api/v1/accountActiveOrders', { query: { account_index: String(k.accountIndex) }, token, signal });
    if (!Array.isArray(data.orders)) fail();
    if (k.era === generation) identities.set(k.fingerprint, { address: k.address, until: now() + IDENTITY_TTL });
    return { identity: k.address, keyLabel: label };
  }

  async function accountRow(k, signal) {
    const data = await request('/api/v1/account', { query: { by: 'index', value: String(k.accountIndex) }, token: await tokenFor(k, signal), signal });
    if (!Array.isArray(data.accounts) || data.accounts.length !== 1 || !object(data.accounts[0])) fail();
    const row = data.accounts[0];
    if (row.index !== k.accountIndex || typeof row.l1_address !== 'string' || row.l1_address.toLowerCase() !== k.address) fail('permissions', { detail: '账户索引不属于该钱包地址' });
    if (!Array.isArray(row.positions) || row.positions.length > MAX_ROWS) fail();
    return row;
  }

  function openOrderOf(row, symbol) {
    if (!object(row) || typeof row.is_ask !== 'boolean' || typeof row.reduce_only !== 'boolean') fail();
    const id = Number.isSafeInteger(row.client_order_index) && row.client_order_index > 0 ? row.client_order_index : integerOf(row.order_index, 1);
    const quantity = amount(row.initial_base_amount, { positive: true }), filledQuantity = amount(row.filled_base_amount, { nonnegative: true });
    if (compareDecimals(filledQuantity, quantity) > 0) fail();
    return { id: String(id), symbol, side: row.is_ask ? 'sell' : 'buy', positionSide: 'BOTH', quantity, filledQuantity, reduceOnly: row.reduce_only };
  }

  async function account(credentials, { signal, symbols } = {}) {
    const k = keys(credentials);
    const selected = executionSymbols(symbols, RH_LIGHTER_SYMBOLS);
    if (!selected?.length) fail('input');
    const selectedRules = await Promise.all(selected.map(symbol => ruleOf(symbol, signal)));
    const row = await accountRow(k, signal);
    const token = await tokenFor(k, signal);
    const positions = [], openOrders = [], leverage = {};
    for (const [index, symbol] of selected.entries()) {
      const rule = selectedRules[index];
      const entries = row.positions.filter(entry => object(entry) && entry.market_id === rule.assetId);
      if (entries.length > 1) fail();
      const entry = entries[0];
      if (entry) {
        const size = amount(entry.position, { nonnegative: true });
        if (size !== '0') {
          if (entry.sign !== 1 && entry.sign !== -1) fail();
          positions.push({ symbol, side: entry.sign === 1 ? 'long' : 'short', quantity: size });
        }
        if (![0, 1].includes(entry.margin_mode)) fail();
        // initial_margin_fraction is a percentage; like defaultLeverage, the usable leverage rounds down.
        const value = Number(100n * SCALE / units(amount(entry.initial_margin_fraction, { positive: true })));
        if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail();
        leverage[symbol] = { type: entry.margin_mode === 1 ? 'isolated' : 'cross', value };
      } else leverage[symbol] = { type: 'cross', value: rule.defaultLeverage };
      const active = await request('/api/v1/accountActiveOrders', { query: { account_index: String(k.accountIndex), market_id: String(rule.assetId) }, token, signal });
      if (!Array.isArray(active.orders) || active.orders.length > MAX_ROWS || typeof active.next_cursor === 'string' && active.next_cursor) fail('pagination');
      for (const order of active.orders) {
        if (!object(order) || order.market_index !== rule.assetId) fail();
        openOrders.push(openOrderOf(order, symbol));
      }
    }
    return { identity: k.address, modes: Object.fromEntries(selected.map(symbol => [symbol, 'one-way'])), positions, openOrders, strategies: [], leverage };
  }

  function specOf(value, { requireId = false, requirePrice = false } = {}) {
    if (!object(value) || !RH_LIGHTER_SYMBOLS.includes(value.symbol) || !['buy', 'sell'].includes(value.side) || value.positionSide !== 'BOTH'
      || typeof value.reduceOnly !== 'boolean' || typeof value.clientId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,32}$/.test(value.clientId)
      || !['chase', 'market'].includes(value.orderType) || !Number.isSafeInteger(value.assetId) || value.assetId < 0 || value.assetId > 65_535) fail('input');
    const spec = { ...value, quantity: (() => { try { return decimal(value.quantity, { positive: true }); } catch { return fail('input'); } })() };
    if (value.stopPrice !== null && value.stopPrice !== undefined) {
      if (value.orderType !== 'chase') fail('input');
      try { spec.stopPrice = decimal(value.stopPrice, { positive: true }); } catch { fail('input'); }
    } else spec.stopPrice = null;
    if (requirePrice || value.limitPrice !== undefined) { try { spec.limitPrice = decimal(value.limitPrice, { positive: true }); } catch { fail('input'); } }
    spec.clientOrderIndex = clientOrderIndexOf(value.clientId);
    // The engine passes id: null for a create whose answer never arrived; the client index alone identifies it.
    if (value.id === null) delete spec.id;
    if (requireId || spec.id !== undefined) {
      if (value.id !== String(spec.clientOrderIndex)) fail('input');
    }
    return spec;
  }

  async function checkedRule(spec, signal) {
    const rule = await ruleOf(spec.symbol, signal);
    if (rule.assetId !== spec.assetId) fail('not_tradable', { detail: '合约编号已变化，请重新预览' });
    return rule;
  }

  // Signs and sends one transaction at a time so nonces stay in order. Any
  // answer other than acceptance re-reads the nonce before the next send.
  // A failure before the final send guard (local rate limit or cooldown,
  // nonce read, signing) is marked notSent: nothing reached the venue.
  function transact(k, method, params, { signal, beforeMutation }) {
    let guarded = false;
    const guard = () => { if (k.era !== generation) fail('aborted'); beforeMutation?.(); guarded = true; };
    const run = async () => {
      checkAbort(signal);
      let nonce = nonces.get(k.slot);
      if (nonce === undefined) {
        const data = await request('/api/v1/nextNonce', { query: { account_index: String(k.accountIndex), api_key_index: String(k.apiKeyIndex) }, token: await tokenFor(k, signal), signal });
        nonce = integerOf(data.nonce);
      }
      const tx = await signed(k, method, { ...params, privateKey: k.privateKey, apiKeyIndex: k.apiKeyIndex, accountIndex: k.accountIndex, nonce });
      if (!Number.isSafeInteger(tx.txType) || typeof tx.txInfo !== 'string' || tx.txInfo.length > 8192 || typeof tx.txHash !== 'string' || !/^[0-9a-f]{64,128}$/.test(tx.txHash)) fail('credentials');
      orderReads.clear();
      let data;
      try {
        data = await request(SEND_PATH, { form: { tx_type: String(tx.txType), tx_info: tx.txInfo, price_protection: 'true' }, signal, beforeMutation: guard });
      } catch (error) { nonces.delete(k.slot); throw error; }
      finally { orderReads.clear(); }
      if (typeof data.tx_hash !== 'string' || data.tx_hash.toLowerCase() !== tx.txHash) { nonces.delete(k.slot); fail('invalid_data', { uncertain: true }); }
      if (k.era === generation) nonces.set(k.slot, nonce + 1);
      const predicted = Number.isSafeInteger(data.predicted_execution_time_ms) ? data.predicted_execution_time_ms : null;
      return { txHash: tx.txHash, predicted };
    };
    const result = mutations.then(run, run).catch(error => { if (!guarded) markUnsent(error); throw error; });
    mutations = result.then(() => {}, () => {});
    return result;
  }
  function markUnsent(error) { if (error instanceof ErrorClass && !error.uncertain) error.notSent = true; }
  async function sendRule(spec, signal) {
    try { return await checkedRule(spec, signal); } catch (error) { markUnsent(error); throw error; }
  }

  async function ordersByIndex(k, indexes, signal, fresh = false) {
    const key = `${k.accountIndex}:${indexes.join(',')}`;
    const cached = orderReads.get(key);
    if (!fresh && cached && now() - cached.at < ORDER_TTL) return cached.rows;
    const data = await request('/api/v1/accountOrders', { query: { account_index: String(k.accountIndex), client_order_indexes: indexes.join(',') }, token: await tokenFor(k, signal), signal });
    if (!Array.isArray(data.orders) || data.orders.length > 20) fail();
    if (k.era === generation) orderReads.set(key, { rows: data.orders, at: now() });
    return data.orders;
  }

  function matchOf(rows, spec) {
    const matches = rows.filter(row => object(row) && row.client_order_index === spec.clientOrderIndex);
    if (matches.length > 1) fail();
    return matches[0] ?? null;
  }

  function inspection(row, spec) {
    const tif = spec.orderType === 'market' ? 'immediate-or-cancel' : 'post-only';
    if (row.market_index !== spec.assetId || row.is_ask !== (spec.side === 'sell') || row.reduce_only !== spec.reduceOnly || row.type !== 'limit'
      || row.time_in_force !== tif || typeof row.status !== 'string' || !Number.isSafeInteger(row.timestamp) || row.timestamp <= 0
      // Unix seconds per the Order schema; a millisecond value would read as a date far in the future.
      || row.timestamp >= 1e11) fail();
    if (!WORKING.has(row.status) && !TERMINAL.has(row.status)) fail();
    const quantity = amount(row.initial_base_amount, { positive: true }), filledQuantity = amount(row.filled_base_amount, { nonnegative: true });
    const remaining = amount(row.remaining_base_amount, { nonnegative: true });
    if (compareDecimals(filledQuantity, quantity) > 0 || units(filledQuantity) + units(remaining) > units(quantity)) fail();
    const terminal = TERMINAL.has(row.status);
    if (row.status === 'filled' && compareDecimals(filledQuantity, quantity) !== 0) fail();
    let averagePrice = null;
    if (filledQuantity !== '0') averagePrice = fromUnits(units(amount(row.filled_quote_amount, { positive: true })) * SCALE / units(filledQuantity));
    return {
      id: String(spec.clientOrderIndex), kind: 'order', status: terminal ? 'terminal' : 'working', quantity, filledQuantity,
      price: amount(row.price, { positive: true }), averagePrice, terminal, childrenSettled: terminal,
      symbol: spec.symbol, side: spec.side, reduceOnly: row.reduce_only, positionSide: 'BOTH',
      createdAt: new Date(row.timestamp * 1000).toISOString(),
      // A post-only order the book crossed after the read: nothing rested or filled.
      ...(spec.orderType === 'chase' && row.status === 'canceled-post-only' && filledQuantity === '0' ? { bounced: true } : {}),
    };
  }

  async function create(credentials, value, { signal, beforeMutation } = {}) {
    const spec = specOf(value, { requirePrice: true });
    const k = keys(credentials);
    const rule = await sendRule(spec, signal);
    if (units(spec.quantity) % units(rule.quantityStep) !== 0n) fail('input');
    const baseAmount = units(spec.quantity) / units(rule.quantityStep);
    if (baseAmount < 1n || baseAmount > MAX_BASE_AMOUNT) fail('input');
    const { price, problem } = orderPrice(spec, rule.tickSize);
    if (problem) fail('input', { detail: problem });
    const market = spec.orderType === 'market';
    const sentAt = await transact(k, 'createOrder', {
      marketIndex: rule.assetId, clientOrderIndex: spec.clientOrderIndex, baseAmount: Number(baseAmount), price: Number(units(price) / units(rule.tickSize)),
      isAsk: spec.side === 'sell' ? 1 : 0, orderType: 0, timeInForce: market ? 0 : 2, reduceOnly: spec.reduceOnly ? 1 : 0,
      orderExpiry: market ? 0 : now() + CHASE_EXPIRY_MS,
    }, { signal, beforeMutation });
    // Acceptance only queues the transaction. The id is claimed once the order
    // is visible; otherwise the create stays uncertain and marked `accepted`:
    // the engine keeps looking it up by client index until the signed expiry
    // has passed instead of pausing the task.
    const first = Math.min(VISIBLE_WAIT_MS, Math.max(0, (sentAt.predicted ?? now()) - now())) + 300;
    try {
      for (const delay of [first, VISIBLE_RETRY_MS]) {
        await sleep(delay, signal);
        // The transaction was accepted: an interrupted check never means "not sent".
        if (signal?.aborted) fail('aborted', { uncertain: true });
        const row = matchOf(await ordersByIndex(k, [spec.clientOrderIndex], signal, true), spec);
        if (row) {
          try { inspection(row, spec); } catch { fail('invalid_data', { uncertain: true }); }
          return { id: String(spec.clientOrderIndex), kind: 'order' };
        }
      }
      return fail('not_found', { uncertain: true, detail: '委托已提交但尚未在交易所查到' });
    } catch (error) {
      if (!(error instanceof ErrorClass)) throw Object.assign(new ErrorClass('invalid_data', { uncertain: true }), { accepted: true });
      throw Object.assign(error, { uncertain: true, accepted: true });
    }
  }

  async function inspect(credentials, value, { signal } = {}) {
    const spec = specOf(value);
    const k = keys(credentials);
    const row = matchOf(await ordersByIndex(k, [spec.clientOrderIndex], signal), spec);
    if (!row) fail('not_found', { notFound: true });
    const result = inspection(row, spec);
    // The cached book is the one the post-only order crossed; the re-send must read a new one.
    if (result.bounced) books.delete(spec.assetId);
    return result;
  }

  async function stop(credentials, value, { signal, beforeMutation } = {}) {
    const spec = specOf(value, { requireId: true });
    const k = keys(credentials);
    const rule = await sendRule(spec, signal);
    // Index at or below 2^48 - 1 names the client order index.
    await transact(k, 'cancelOrder', { marketIndex: rule.assetId, index: spec.clientOrderIndex }, { signal, beforeMutation });
    return { id: spec.id };
  }

  // A disconnected key leaves no token, identity, nonce or signer state behind:
  // market reads go back to unauthenticated and the signer thread holding the
  // key is stopped (the next connection starts a fresh one).
  function forget() {
    generation += 1; tokens.clear(); identities.clear(); nonces.clear(); orderReads.clear(); shared = null;
    if (sign && sign !== signer) { const current = sign; sign = null; void Promise.resolve(current.close()).catch(() => {}); }
  }

  const unsupported = async () => fail('input');
  return { exchange: 'rh-lighter', verify, account, market, create, amend: unsupported, inspect, stop, endedStrategies: unsupported, forget };
}
