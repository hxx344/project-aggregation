import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { compareDecimals, decimal } from './trading-decimal.mjs';
import { EXECUTION_VENUE_SYMBOLS, executionSymbols } from './trading-markets.mjs';
import { signL1Action } from './trading-hyperliquid-signing.mjs';

// Hyperliquid HIP-3 perps (io:ANTH, xyz:ANT) through an API (agent) wallet.
// Only `order` and `cancel` actions exist here: no transfer, withdrawal,
// leverage, margin, approval or modify route can be built by this module.
// Chase legs are ordinary ALO (post-only) orders; repricing cancels and the
// engine recreates the remainder after the cancel is confirmed terminal.
// Market legs are IOC limit orders priced 1% through the opposite book.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
const HOST = 'https://api.hyperliquid.xyz';
const PATHS = new Set(['/info', '/exchange']);
export const HYPERLIQUID_SYMBOLS = EXECUTION_VENUE_SYMBOLS.hyperliquid;
// A signed action is void after this window, which bounds the unknown-create
// wait used by the execution engine (>= 120 s) with a wide margin.
export const HYPERLIQUID_EXPIRES_MS = 30_000;
const MARKET_SLIPPAGE = 1n; // percent through the opposite best price
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const META_TTL = 60_000;
const IDENTITY_TTL = 60_000;
const MAX_ROWS = 2000;
const MAX_FILL_PAGES = 5;
const MAX_ORDER_QUANTITY = '100000';
const MIN_NOTIONAL = '10';
const SCALE = 10n ** 18n;
const OPEN = 'open';
const TERMINAL_STATUSES = new Set(['filled', 'canceled', 'rejected', 'marginCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled',
  'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled', 'liquidatedCanceled', 'scheduledCancel',
  'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected', 'reduceOnlyRejected', 'badAloPxRejected', 'iocCancelRejected',
  'badTriggerPxRejected', 'marketOrderNoLiquidityRejected', 'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected',
  'tooAggressiveAtOpenInterestCapRejected', 'openInterestIncreaseRejected', 'insufficientSpotBalanceRejected', 'oracleRejected', 'perpMaxPositionRejected']);
// Exact upstream error texts that prove the action was not applied. Anything
// else from /exchange stays uncertain so the engine reconciles by client id.
const DEFINITIVE_ERRORS = [
  [/Insufficient margin/i, '保证金不足'],
  [/minimum value of \$?10/i, '低于 Hyperliquid 最小下单金额 10 USDC'],
  [/Post only order would have immediately matched/i, '只挂单会立即成交，已被拒绝'],
  [/could not immediately match/i, '没有可立即成交的对手盘'],
  [/Reduce only order would increase position/i, '只减仓委托会增加仓位'],
  [/divisible by tick size|invalid price/i, '价格精度无效'],
  [/too far from oracle|Order price cannot be more than/i, '委托价格偏离预言机价格过大'],
  [/open interest/i, '合约持仓量已达上限'],
  [/No liquidity available/i, '没有可用流动性'],
  [/Order has invalid size/i, '委托数量无效'],
  [/User or API Wallet .* does not exist/i, 'API 钱包未授权或已失效'],
  [/Too many|rate limit/i, '请求过于频繁'],
];
const ALO_BOUNCE = /Post only order would have immediately matched/i;
const GATEWAY_REFUSALS = new Set([400, 401, 403, 404, 405, 413, 415, 422]);
const ORDER_SIDES = Object.freeze({ B: 'buy', A: 'sell' });

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
const pow10 = exponent => exponent >= 0 ? 10n ** BigInt(exponent) * SCALE : SCALE / 10n ** BigInt(-exponent);
export const cloidOf = clientId => '0x' + createHash('sha256').update('hyperliquid:' + clientId).digest('hex').slice(0, 32);
const dexOf = symbol => symbol.slice(0, symbol.indexOf(':'));

/** Order of magnitude of a positive decimal: 1643.2 -> 3, 0.00521 -> -3. */
function magnitudeOf(value) {
  const [integer, fraction = ''] = decimal(value, { positive: true }).split('.');
  if (integer !== '0') return integer.length - 1;
  return -(fraction.match(/^0*/)[0].length + 1);
}

/** Price tick at this price: five significant figures, at most 6 - szDecimals decimals, integers always valid. */
export function priceTick(price, szDecimals) {
  return fromUnits(pow10(Math.min(0, Math.max(magnitudeOf(price) - 4, -(6 - szDecimals)))));
}

export function validPrice(price, szDecimals) {
  let value;
  try { value = decimal(price, { positive: true }); } catch { return false; }
  if (!value.includes('.')) return true;
  const fraction = value.split('.')[1];
  const digits = value.replace('.', '').replace(/^0+/, '');
  return fraction.length <= 6 - szDecimals && digits.length <= 5;
}

/** Rounds a positive scaled price onto the valid grid, toward `up` or down. */
function roundPrice(value, szDecimals, up) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tick = units(priceTick(fromUnits(value), szDecimals));
    const rounded = (value / tick) * tick + (up && value % tick !== 0n ? tick : 0n);
    if (validPrice(fromUnits(rounded), szDecimals)) return fromUnits(rounded);
    value = rounded;
  }
  return null;
}

export function protectivePrice(side, bestPrice, szDecimals) {
  const best = units(bestPrice);
  const target = side === 'buy' ? best * (100n + MARKET_SLIPPAGE) / 100n : best * (100n - MARKET_SLIPPAGE) / 100n;
  return target > 0n ? roundPrice(target, szDecimals, side === 'buy') : null;
}

/** szDecimals of a quantity step that is a power of ten (1, 0.1, …, 0.000001), else null. */
export function stepDecimals(step) {
  if (typeof step !== 'string' || !/^(?:1|0\.0{0,5}1)$/.test(step)) return null;
  return step === '1' ? 0 : step.length - 2;
}

/**
 * Wire price of an order spec and why it cannot be sent. Synchronous and
 * network-free, so the engine runs it for every leg before any leg is sent.
 */
export function orderPrice(spec, szDecimals) {
  const price = spec.orderType === 'market' ? protectivePrice(spec.side, spec.limitPrice, szDecimals) : spec.limitPrice;
  if (!price || !validPrice(price, szDecimals)) return { price: null, problem: '价格不满足 Hyperliquid 精度' };
  if (spec.stopPrice && (spec.side === 'buy' ? compareDecimals(price, spec.stopPrice) >= 0 : compareDecimals(price, spec.stopPrice) <= 0)) return { price: null, problem: '委托价已达到追价界限' };
  return { price, problem: null };
}

export function createHyperliquidExecutionClient({ ErrorClass, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  if (typeof ErrorClass !== 'function') throw new TypeError('ExecutionExchangeError is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeout is invalid');
  const fail = (code = 'invalid_data', details) => { throw new ErrorClass(code, details); };
  const checkAbort = signal => { if (signal?.aborted) fail('aborted'); };
  const amount = (value, options = {}) => {
    try { if (typeof value !== 'string') fail(); return decimal(value, options); } catch { return fail(); }
  };
  const milliseconds = value => { if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) fail(); return value; };
  const metaCache = new Map();
  const identityCache = new Map();
  let lastNonce = 0;

  function keys(credentials) {
    if (!object(credentials) || typeof credentials.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(credentials.address)
      || typeof credentials.agentKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(credentials.agentKey)) fail('credentials');
    let wallet;
    try { wallet = new Wallet(credentials.agentKey); } catch { fail('credentials'); }
    return { master: credentials.address.toLowerCase(), agent: wallet.address.toLowerCase(), wallet };
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

  async function post(path, payload, { signal, beforeMutation } = {}) {
    if (!PATHS.has(path)) fail('configuration');
    const mutation = path === '/exchange';
    checkAbort(signal);
    const body = JSON.stringify(payload);
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
        const response = await fetchImpl(HOST + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', cache: 'no-store', signal: controller.signal });
        checkAbort(controller.signal);
        if (!response || response.redirected || response.status >= 300 && response.status < 400) fail('upstream', { uncertain: mutation });
        if (response.status === 429) fail(mutation ? 'rejected' : 'upstream', { detail: '请求过于频繁' });
        // Only these gateway answers prove the body was refused before processing;
        // proxy or timeout statuses (408, 409, 425, 499 …) leave a write uncertain.
        if (GATEWAY_REFUSALS.has(response.status)) fail(mutation ? 'rejected' : 'upstream');
        if (!response.ok) fail('upstream', { uncertain: mutation });
        return await readJson(response, controller.signal);
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

  const info = (payload, signal) => post('/info', payload, { signal });

  function nextNonce() {
    const nonce = Math.max(milliseconds(now()), lastNonce + 1);
    lastNonce = nonce;
    return nonce;
  }

  async function exchangeAction(credentials, action, { signal, beforeMutation }) {
    const { wallet } = keys(credentials);
    const nonce = nextNonce(), expiresAfter = nonce + HYPERLIQUID_EXPIRES_MS;
    const signature = signL1Action(wallet, action, { nonce, expiresAfter, mainnet: true });
    const data = await post('/exchange', { action, nonce, signature, vaultAddress: null, expiresAfter }, { signal, beforeMutation });
    if (!object(data)) fail('invalid_data', { uncertain: true });
    if (data.status === 'err') {
      const known = typeof data.response === 'string' && DEFINITIVE_ERRORS.find(([pattern]) => pattern.test(data.response));
      if (known) fail('rejected', { detail: known[1] });
      fail('upstream', { uncertain: true });
    }
    if (data.status !== 'ok' || !object(data.response) || data.response.type !== action.type || !object(data.response.data)
      || !Array.isArray(data.response.data.statuses) || data.response.data.statuses.length !== 1) fail('invalid_data', { uncertain: true });
    return data.response.data.statuses[0];
  }

  async function verify(credentials, { signal } = {}) {
    const { master, agent } = keys(credentials);
    if (agent === master) fail('permissions', { detail: '请填写 Hyperliquid API 钱包私钥，不要使用主钱包私钥' });
    const key = createHash('sha256').update(master + agent).digest('hex');
    const cached = identityCache.get(key);
    if (cached && cached.until > now()) return { identity: master, agentAddress: agent };
    const [agentRole, masterRole] = await Promise.all([info({ type: 'userRole', user: agent }, signal), info({ type: 'userRole', user: master }, signal)]);
    if (!object(agentRole) || agentRole.role !== 'agent' || !object(agentRole.data) || typeof agentRole.data.user !== 'string'
      || agentRole.data.user.toLowerCase() !== master) fail('permissions', { detail: 'API 钱包未授权给该主账户，或已过期、已撤销' });
    if (!object(masterRole) || masterRole.role !== 'user') fail('account_mode', { detail: '主账户地址须为普通用户账户，不支持子账户或金库' });
    identityCache.set(key, { until: now() + IDENTITY_TTL });
    return { identity: master, agentAddress: agent };
  }

  async function ruleOf(symbol, signal) {
    if (!HYPERLIQUID_SYMBOLS.includes(symbol)) fail('input');
    const dex = dexOf(symbol);
    const cached = metaCache.get(dex);
    let entry = cached && cached.until > now() ? cached : null;
    if (!entry) {
      const [dexes, meta] = await Promise.all([info({ type: 'perpDexs' }, signal), info({ type: 'meta', dex }, signal)]);
      if (!Array.isArray(dexes) || dexes.length > 1000 || !object(meta) || !Array.isArray(meta.universe) || meta.universe.length > 10_000) fail();
      const dexIndex = dexes.findIndex(row => object(row) && row.name === dex);
      if (dexIndex < 1 || dexes.filter(row => object(row) && row.name === dex).length !== 1) fail('not_tradable');
      // Collateral token 0 is USDC; any other quote asset is outside this design.
      if (meta.collateralToken !== 0) fail('not_tradable', { detail: '合约保证金不是 USDC' });
      entry = { dexIndex, universe: meta.universe, until: now() + META_TTL };
      metaCache.set(dex, entry);
    }
    const matches = entry.universe.map((row, index) => [row, index]).filter(([row]) => object(row) && row.name === symbol);
    if (matches.length !== 1) fail('not_tradable');
    const [row, index] = matches[0];
    if (row.isDelisted === true || !Number.isSafeInteger(row.szDecimals) || row.szDecimals < 0 || row.szDecimals > 6) fail('not_tradable');
    const step = fromUnits(pow10(-row.szDecimals));
    return {
      assetId: 100_000 + entry.dexIndex * 10_000 + index, szDecimals: row.szDecimals, onlyIsolated: row.onlyIsolated === true,
      maxLeverage: Number.isSafeInteger(row.maxLeverage) ? row.maxLeverage : null,
      quantityStep: step, minQuantity: step, maxQuantity: MAX_ORDER_QUANTITY, maxMarketQuantity: MAX_ORDER_QUANTITY,
      minNotional: MIN_NOTIONAL, maxNotional: null, quoteAsset: 'USDC',
    };
  }

  function level(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || !object(rows[0])) fail('not_tradable', { detail: '盘口为空' });
    const price = amount(rows[0].px, { positive: true });
    amount(rows[0].sz, { positive: true });
    return price;
  }

  async function market(symbol, { signal, withRule = true } = {}) {
    if (!HYPERLIQUID_SYMBOLS.includes(symbol)) fail('input');
    const [rule, book] = await Promise.all([withRule ? ruleOf(symbol, signal) : null, info({ type: 'l2Book', coin: symbol }, signal)]);
    if (!object(book) || book.coin !== symbol || !Array.isArray(book.levels) || book.levels.length !== 2) fail();
    const bid = level(book.levels[0]), ask = level(book.levels[1]);
    if (compareDecimals(bid, ask) >= 0) fail();
    const result = { symbol, bid, ask, at: new Date(milliseconds(book.time)).toISOString() };
    if (!rule) return result;
    const { szDecimals, onlyIsolated, maxLeverage, ...limits } = rule;
    return { ...result, rule: { ...limits, tickSize: priceTick(bid, szDecimals) }, onlyIsolated, maxLeverage };
  }

  function positionsOf(state, selected, coins) {
    if (!object(state) || !Array.isArray(state.assetPositions) || state.assetPositions.length > MAX_ROWS) fail();
    const positions = [];
    for (const entry of state.assetPositions) {
      if (!object(entry) || !object(entry.position) || typeof entry.position.coin !== 'string') fail();
      const coin = entry.position.coin;
      if (!selected.includes(coin)) continue;
      if (entry.type !== 'oneWay') fail('account_mode');
      if (coins.has(coin)) fail();
      coins.add(coin);
      const size = amount(entry.position.szi);
      if (size === '0') continue;
      const short = size.startsWith('-');
      positions.push({ symbol: coin, side: short ? 'short' : 'long', quantity: short ? size.slice(1) : size });
    }
    return positions;
  }

  function openOrdersOf(rows, selected) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('pagination');
    return rows.filter(row => object(row) && selected.includes(row.coin)).map(row => {
      if (!Number.isSafeInteger(row.oid) || row.oid <= 0 || !Object.hasOwn(ORDER_SIDES, row.side) || typeof row.reduceOnly !== 'boolean') fail();
      const quantity = amount(row.origSz, { positive: true }), remaining = amount(row.sz, { nonnegative: true });
      if (compareDecimals(remaining, quantity) > 0) fail();
      return { id: String(row.oid), symbol: row.coin, side: ORDER_SIDES[row.side], positionSide: 'BOTH', quantity, filledQuantity: fromUnits(units(quantity) - units(remaining)), reduceOnly: row.reduceOnly };
    });
  }

  async function account(credentials, { signal, symbols } = {}) {
    const { master } = keys(credentials);
    const selected = executionSymbols(symbols, HYPERLIQUID_SYMBOLS);
    if (!selected?.length) fail('input');
    const dexes = [...new Set(selected.map(dexOf))];
    const [reads, active] = await Promise.all([
      Promise.all(dexes.map(dex => Promise.all([info({ type: 'clearinghouseState', user: master, dex }, signal), info({ type: 'frontendOpenOrders', user: master, dex }, signal)]))),
      Promise.all(selected.map(coin => info({ type: 'activeAssetData', user: master, coin }, signal))),
    ]);
    const coins = new Set(), positions = [], openOrders = [];
    for (const [state, orders] of reads) { positions.push(...positionsOf(state, selected, coins)); openOrders.push(...openOrdersOf(orders, selected)); }
    const leverage = {};
    selected.forEach((coin, index) => {
      const row = active[index];
      if (!object(row) || row.coin !== coin || !object(row.leverage) || !['cross', 'isolated'].includes(row.leverage.type)
        || !Number.isSafeInteger(row.leverage.value) || row.leverage.value < 1 || row.leverage.value > 100) fail();
      leverage[coin] = { type: row.leverage.type, value: row.leverage.value };
    });
    return { identity: master, modes: Object.fromEntries(selected.map(symbol => [symbol, 'one-way'])), positions, openOrders, strategies: [], leverage };
  }

  function specOf(value, { requireId = false, requirePrice = false } = {}) {
    if (!object(value) || !HYPERLIQUID_SYMBOLS.includes(value.symbol) || !['buy', 'sell'].includes(value.side) || value.positionSide !== 'BOTH'
      || typeof value.reduceOnly !== 'boolean' || typeof value.clientId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,32}$/.test(value.clientId)
      || !['chase', 'market'].includes(value.orderType) || !Number.isSafeInteger(value.assetId) || value.assetId < 100_000) fail('input');
    const spec = { ...value, quantity: (() => { try { return decimal(value.quantity, { positive: true }); } catch { return fail('input'); } })() };
    if (value.stopPrice !== null && value.stopPrice !== undefined) {
      if (value.orderType !== 'chase') fail('input');
      try { spec.stopPrice = decimal(value.stopPrice, { positive: true }); } catch { fail('input'); }
    } else spec.stopPrice = null;
    if (requirePrice || value.limitPrice !== undefined) { try { spec.limitPrice = decimal(value.limitPrice, { positive: true }); } catch { fail('input'); } }
    // The engine passes id: null for a create whose answer never arrived; the cloid alone identifies it.
    if (value.id === null) delete spec.id;
    if (requireId || spec.id !== undefined) {
      if (typeof value.id !== 'string' || !/^[1-9]\d{0,15}$/.test(value.id) || !Number.isSafeInteger(Number(value.id))) fail('input');
    }
    return spec;
  }

  async function checkedRule(spec, signal) {
    const rule = await ruleOf(spec.symbol, signal);
    // Asset ids follow the venue list order; a changed id means the plan is stale.
    if (rule.assetId !== spec.assetId) fail('not_tradable', { detail: '合约编号已变化，请重新预览' });
    return rule;
  }

  async function create(credentials, value, { signal, beforeMutation } = {}) {
    const spec = specOf(value, { requirePrice: true });
    keys(credentials);
    const rule = await checkedRule(spec, signal);
    if (units(spec.quantity) % units(rule.quantityStep) !== 0n) fail('input');
    const { price, problem } = orderPrice(spec, rule.szDecimals);
    if (problem) fail('input', { detail: problem });
    const order = { a: rule.assetId, b: spec.side === 'buy', p: price, s: spec.quantity, r: spec.reduceOnly,
      t: { limit: { tif: spec.orderType === 'market' ? 'Ioc' : 'Alo' } }, c: cloidOf(spec.clientId) };
    const status = await exchangeAction(credentials, { type: 'order', orders: [order], grouping: 'na' }, { signal, beforeMutation });
    const placed = object(status) ? status.resting ?? status.filled : null;
    if (object(placed) && Number.isSafeInteger(placed.oid) && placed.oid > 0) return { id: String(placed.oid), kind: 'order' };
    if (object(status) && typeof status.error === 'string') {
      const known = DEFINITIVE_ERRORS.find(([pattern]) => pattern.test(status.error));
      const error = new ErrorClass('rejected', { detail: known?.[1] ?? '委托被拒绝' });
      // A post-only order bounced by a book that moved after the read; nothing rests or fills.
      if (spec.orderType === 'chase' && ALO_BOUNCE.test(status.error)) error.repriceable = true;
      throw error;
    }
    return fail('invalid_data', { uncertain: true });
  }

  async function filledBy(master, symbol, oid, createdAt, signal) {
    let startTime = Math.max(0, createdAt - 5000), total = 0n, prices = 0n;
    const seen = new Set();
    for (let page = 0; page < MAX_FILL_PAGES; page += 1) {
      const rows = await info({ type: 'userFillsByTime', user: master, startTime, aggregateByTime: false }, signal);
      if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail();
      let last = startTime;
      for (const row of rows) {
        if (!object(row) || !Number.isSafeInteger(row.time)) fail();
        last = Math.max(last, row.time);
        if (row.oid !== oid) continue;
        if (row.coin !== symbol) fail();
        const key = `${row.tid}:${row.hash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const size = units(amount(row.sz, { positive: true }));
        total += size;
        prices += size * units(amount(row.px, { positive: true })) / SCALE;
      }
      if (rows.length < MAX_ROWS) return { total: fromUnits(total), average: total > 0n ? fromUnits(prices * SCALE / total) : null };
      if (last === startTime) fail('pagination');
      startTime = last;
    }
    return fail('pagination');
  }

  async function inspect(credentials, value, { signal } = {}) {
    const spec = specOf(value);
    const { master } = keys(credentials);
    const cloid = cloidOf(spec.clientId);
    const data = await info({ type: 'orderStatus', user: master, oid: cloid }, signal);
    if (object(data) && data.status === 'unknownOid') fail('not_found', { notFound: true });
    if (!object(data) || data.status !== 'order' || !object(data.order) || !object(data.order.order)) fail();
    const row = data.order.order, status = data.order.status;
    if (row.coin !== spec.symbol || typeof row.cloid !== 'string' || row.cloid.toLowerCase() !== cloid || !Number.isSafeInteger(row.oid) || row.oid <= 0
      || spec.id !== undefined && String(row.oid) !== spec.id || !Object.hasOwn(ORDER_SIDES, row.side) || ORDER_SIDES[row.side] !== spec.side || row.reduceOnly !== spec.reduceOnly
      || row.tif !== (spec.orderType === 'market' ? 'Ioc' : 'Alo') || typeof status !== 'string') fail();
    if (status !== OPEN && !TERMINAL_STATUSES.has(status)) fail();
    const quantity = amount(row.origSz, { positive: true }), remaining = amount(row.sz, { nonnegative: true });
    if (compareDecimals(remaining, quantity) > 0) fail();
    const filledQuantity = fromUnits(units(quantity) - units(remaining));
    const terminal = status !== OPEN;
    if (status === 'filled' && remaining !== '0') fail();
    let averagePrice = null;
    if (terminal) {
      // Every ended order, including one reported unfilled, must agree with
      // the fill history before the engine re-sends its remainder.
      const fills = await filledBy(master, spec.symbol, row.oid, milliseconds(row.timestamp), signal);
      if (compareDecimals(fills.total, filledQuantity) !== 0) fail();
      averagePrice = fills.average;
    }
    return {
      id: String(row.oid), kind: 'order', status: terminal ? 'terminal' : 'working', quantity, filledQuantity,
      price: amount(row.limitPx, { positive: true }), averagePrice, terminal, childrenSettled: terminal,
      symbol: row.coin, side: ORDER_SIDES[row.side], reduceOnly: row.reduceOnly, positionSide: 'BOTH',
      createdAt: new Date(milliseconds(row.timestamp)).toISOString(),
    };
  }

  async function stop(credentials, value, { signal, beforeMutation } = {}) {
    const spec = specOf(value, { requireId: true });
    keys(credentials);
    const rule = await checkedRule(spec, signal);
    const status = await exchangeAction(credentials, { type: 'cancel', cancels: [{ a: rule.assetId, o: Number(spec.id) }] }, { signal, beforeMutation });
    if (status === 'success') return { id: spec.id };
    if (object(status) && typeof status.error === 'string') fail('rejected', { detail: '订单已成交、已撤销或不存在' });
    return fail('invalid_data', { uncertain: true });
  }

  const unsupported = async () => fail('input');
  return { exchange: 'hyperliquid', verify, account, market, create, amend: unsupported, inspect, stop, endedStrategies: unsupported };
}
