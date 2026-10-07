import { createHmac } from 'node:crypto';
import { decimal, addDecimals, compareDecimals, negateDecimal } from './trading-decimal.mjs';

/**
 * Restricted live execution protocol. No caller-supplied host, path, order type,
 * time-in-force, or extra request parameters are forwarded to an exchange.
 *
 * createExecutionExchangeClient(exchange, { fetchImpl, now, timeoutMs }) exposes:
 *   verify(credentials, options) -> { identity: string | null }
 *   account(credentials, options) -> { identity, modes, positions, openOrders, strategies }
 *   market(symbol, { signal }) -> { symbol, bid, ask, at, rule }
 *   create(credentials, spec, options) -> { id, kind: 'order' | 'strategy' }
 *   inspect(credentials, { ...spec, id: string | null }, options) -> {
 *     id, kind, status: 'working' | 'paused' | 'terminal', quantity,
 *     filledQuantity, price, averagePrice, terminal, childrenSettled,
 *     symbol, side, reduceOnly, positionSide, createdAt
 *   }
 *   amend(credentials, { ...spec, id: string }, options) -> same as inspect (Binance only)
 *   stop(credentials, { ...spec, id: string | null }, options) -> void (ACK only)
 * options = { accountMode: 'standard' | 'portfolio-margin' | 'unified', signal,
 *   beforeMutation?: () => void } (the guard is an internal service callback).
 * spec = { symbol, side: 'buy' | 'sell', positionSide: 'BOTH' | 'LONG' | 'SHORT',
 *          quantity: decimal string, reduceOnly: boolean, clientId: string <= 32,
 *          stopPrice: positive decimal string }.
 *
 * Binance: LIMIT + GTX + priceMatch=QUEUE; never sends an explicit price.
 * stopPrice is a strategy stop trigger, NOT a guaranteed execution-price cap;
 * the caller watches prices and periodically amends the same order id with its
 * original total quantity. Each amendment is a single native modify operation,
 * not an exchange-managed chase. A failed amendment can leave the original live;
 * reconcile that order instead of canceling and replacing it to chase prices.
 * Bybit: native chaseOrder, zero offset, maxChasePrice=stopPrice. There is no
 * documented client id / idempotency token for native strategy creation. An
 * uncertain create must never be retried or matched by approximate parameters.
 * inspect requires an explicitly known strategyId and checks all child pages.
 * All create/stop ACKs require later inspection; a stopped strategy can contain
 * fills. Strategy status 3 alone never proves that the requested size filled.
 *
 * ExecutionExchangeError.uncertain means a mutation may have reached the venue.
 * Only an explicit timestamp rejection permits one retry after bounded clock
 * correction. No transport, 5xx, malformed ACK, or generic business-error retry.
 * Public instrument rules are cached for 60s; book timestamps remain venue time.
 * Binance conditional orders are queried separately; an existing conditional
 * order on either supported symbol blocks preflight with external_orders. The
 * module cannot cancel those orders, and never fabricates their missing fills.
 * Binance exposes no stable account UID in these endpoints, so identity is null.
 * Bybit identity is its userID (never the API key or API-key id).
 *
 * Official protocol references (verified 2026-10-07):
 * https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order
 * https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Modify-Order
 * https://developers.binance.com/docs/derivatives/portfolio-margin/trade/New-UM-Order
 * https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Modify-UM-Order
 * https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
 * https://bybit-exchange.github.io/docs/v5/strategy/create-strategy
 * https://bybit-exchange.github.io/docs/v5/strategy/strategy-list
 * https://bybit-exchange.github.io/docs/v5/strategy/order-list
 * https://bybit-exchange.github.io/docs/v5/strategy/stop-strategy
 * https://bybit-exchange.github.io/docs/v5/user/apikey-info
 */

const SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 40;
const MAX_ROWS = 2000;
const MAX_CLOCK_OFFSET = 300_000;
const RULE_TTL = 60_000;
const RECV_WINDOW = '5000';
const ID_KEYS = new Set(['orderId', 'tranId', 'userID', 'userIDInt64', 'uid']);
const BINANCE_RISKY_PERMISSIONS = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableMargin', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const BINANCE_TERMINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);
const BYBIT_ORDER_TERMINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled']);
const ERROR_MESSAGES = Object.freeze({
  input: '交易执行参数无效', configuration: '交易执行配置无效', credentials: '交易凭据格式无效',
  permissions: '交易密钥权限不符合要求', account_mode: '交易账户或持仓模式无法确认',
  invalid_data: '交易所响应不完整或格式无效', response_limit: '交易所响应超过大小限制',
  pagination: '交易所分页结果不完整', timeout: '交易所请求超时', transport: '交易所连接失败',
  aborted: '交易所请求已中断', upstream: '交易所请求失败', rejected: '交易所拒绝了请求',
  timestamp: '交易所拒绝了请求时间', clock: '交易所时钟偏差超出支持范围',
  not_found: '交易所尚未查到目标订单或策略', strategy_id_required: '需要明确的交易所策略编号才能核实',
  not_tradable: '合约当前不支持所需的限价交易', external_orders: '合约存在需先核实的条件委托',
});

export class ExecutionExchangeError extends Error {
  constructor(code = 'upstream', { uncertain = false, notFound = false, providerCode } = {}) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.upstream);
    this.name = 'ExecutionExchangeError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'upstream';
    this.uncertain = uncertain === true;
    if (notFound) this.notFound = true;
    if (Number.isSafeInteger(providerCode)) this.providerCode = providerCode;
  }
}

function fail(code = 'invalid_data', details) { throw new ExecutionExchangeError(code, details); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireObject(value) { if (!object(value)) fail(); return value; }
function checkAbort(signal) { if (signal?.aborted) fail('aborted'); }
function amount(value, options = {}) {
  try { if (typeof value !== 'string') fail(); return decimal(value, options); }
  catch { fail(); }
}
function optionalPrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = amount(value, { nonnegative: true });
  return normalized === '0' ? null : normalized;
}
function milliseconds(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) fail();
  return value;
}
function iso(value, optional = false) {
  return optional && (value === undefined || value === null || value === '' || value === 0 || value === '0') ? null : new Date(milliseconds(value)).toISOString();
}
function identifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) fail();
  return value;
}
function strategyId(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value)) fail();
  return value;
}
function numericEnum(value, allowed) {
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) value = Number(value);
  if (!allowed.includes(value)) fail();
  return value;
}
function sideOf(value) { if (value !== 'BUY' && value !== 'SELL' && value !== 'Buy' && value !== 'Sell') fail(); return value.toLowerCase(); }
function positionSideOf(value) { if (!['BOTH', 'LONG', 'SHORT'].includes(value)) fail(); return value; }
function positionSideForIndex(value) { return ['BOTH', 'LONG', 'SHORT'][numericEnum(value, [0, 1, 2])]; }
function hedgeClose(side, positionSide) { return positionSide === 'LONG' && side === 'sell' || positionSide === 'SHORT' && side === 'buy'; }
function volumes(quantity, filledQuantity) {
  quantity = amount(quantity, { positive: true });
  filledQuantity = amount(filledQuantity, { nonnegative: true });
  if (compareDecimals(filledQuantity, quantity) > 0) fail();
  return { quantity, filledQuantity };
}
function array(value, limit = MAX_ROWS) { if (!Array.isArray(value) || value.length > limit) fail(); return value; }
function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (!ID_KEYS.has(key) || typeof value !== 'number') return value;
    if (context?.source && /^\d{1,30}$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    fail();
  });
}

async function readJson(response, signal) {
  const length = response.headers?.get('content-length');
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
    try { return parseJson(Buffer.concat(chunks, size).toString('utf8')); }
    catch (error) { if (error instanceof ExecutionExchangeError) throw error; fail(); }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function binanceEndpoints(mode) {
  const portfolio = mode === 'portfolio-margin';
  const host = portfolio ? 'https://papi.binance.com' : 'https://fapi.binance.com';
  const prefix = portfolio ? '/papi/v1/um' : '/fapi/v1';
  return {
    permissions: ['https://api.binance.com', '/sapi/v1/account/apiRestrictions', 'GET', true],
    config: [host, `${prefix}/accountConfig`, 'GET', true],
    positions: [host, portfolio ? `${prefix}/positionRisk` : '/fapi/v3/positionRisk', 'GET', true],
    openOrders: [host, `${prefix}/openOrders`, 'GET', true],
    openAlgoOrders: [host, portfolio ? `${prefix}/algo/openAlgoOrders` : '/fapi/v1/openAlgoOrders', 'GET', true],
    create: [host, `${prefix}/order`, 'POST', true],
    amend: [host, `${prefix}/order`, 'PUT', true],
    inspect: [host, `${prefix}/order`, 'GET', true],
    stop: [host, `${prefix}/order`, 'DELETE', true],
    rules: ['https://fapi.binance.com', '/fapi/v1/exchangeInfo', 'GET', false],
    book: ['https://fapi.binance.com', '/fapi/v1/ticker/bookTicker', 'GET', false],
    time: ['https://fapi.binance.com', '/fapi/v1/time', 'GET', false],
  };
}
const BYBIT_ENDPOINTS = Object.freeze({
  permissions: ['https://api.bybit.com', '/v5/user/query-api', 'GET', true],
  config: ['https://api.bybit.com', '/v5/account/info', 'GET', true],
  positions: ['https://api.bybit.com', '/v5/position/list', 'GET', true],
  openOrders: ['https://api.bybit.com', '/v5/order/realtime', 'GET', true],
  strategies: ['https://api.bybit.com', '/v5/strategy/list', 'GET', true],
  children: ['https://api.bybit.com', '/v5/strategy/order-list', 'GET', true],
  create: ['https://api.bybit.com', '/v5/strategy/create', 'POST', true],
  stop: ['https://api.bybit.com', '/v5/strategy/stop', 'POST', true],
  rules: ['https://api.bybit.com', '/v5/market/instruments-info', 'GET', false],
  book: ['https://api.bybit.com', '/v5/market/orderbook', 'GET', false],
  time: ['https://api.bybit.com', '/v5/market/time', 'GET', false],
});

function upstreamFailure(exchange, status, data, mutation) {
  const raw = exchange === 'binance' ? data?.code : data?.retCode;
  const providerCode = Number.isSafeInteger(raw) ? raw : undefined;
  const isTime = exchange === 'binance' ? providerCode === -1021 : providerCode === 10002;
  if (status < 500 && isTime) return new ExecutionExchangeError('timestamp', { providerCode });
  const notFound = exchange === 'binance' ? providerCode === -2013 : providerCode === 60065;
  if (notFound && status < 500) return new ExecutionExchangeError('not_found', { providerCode, notFound: true, uncertain: mutation });
  // Only explicit parameter, permission, balance and limit rejections prove
  // non-execution. Never infer that property from a numeric error-code range:
  // duplicate, processing, completed/canceled and unknown codes remain uncertain.
  const knownRejection = exchange === 'binance'
    ? [
      -1002, -1003, -1008, -1013, -1015, -1020, -1022,
      -1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1114, -1115, -1116, -1117, -1118, -1119, -1121, -1128, -1130,
      -2014, -2015, -2017, -2018, -2019, -2022, -2025, -2026, -2027,
      -4001, -4002, -4003, -4004, -4005, -4013, -4014, -4016, -4023, -4024, -4061, -4164, -5022,
    ].includes(providerCode)
    : [
      10001, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10017, 10024, 10027, 10028, 100029,
      110003, 110004, 110007, 110009, 110012, 110016, 110017, 110020, 110021, 110022, 110032, 110094,
      60063, 60064, 60066, 60067, 60069, 60070, 60075, 60077, 60078, 60079,
    ].includes(providerCode);
  return new ExecutionExchangeError(knownRejection && status < 500 ? 'rejected' : 'upstream', {
    providerCode, uncertain: mutation && (status >= 500 || !knownRejection),
  });
}

export function createExecutionExchangeClient(exchange, { fetchImpl = fetch, now = Date.now, timeoutMs = 12_000 } = {}) {
  if (!['binance', 'bybit'].includes(exchange) || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('configuration');
  let timeOffset = 0;
  const ruleCache = new Map();
  function clock() { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) fail('configuration'); return value; }
  function modeOf(value) {
    const mode = value ?? (exchange === 'binance' ? 'standard' : 'unified');
    if (!(exchange === 'binance' ? ['standard', 'portfolio-margin'] : ['unified']).includes(mode)) fail('account_mode');
    return mode;
  }
  function validateCredentials(credentials) {
    if (!object(credentials) || typeof credentials.apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.apiKey)
      || typeof credentials.apiSecret !== 'string' || !credentials.apiSecret.trim() || credentials.apiSecret.length > 1024 || /[\r\n\0]/.test(credentials.apiSecret)) fail('credentials');
  }

  async function rawRequest(operation, credentials, parameters, { accountMode, signal, beforeMutation } = {}) {
    checkAbort(signal);
    const endpoints = exchange === 'binance' ? binanceEndpoints(modeOf(accountMode)) : BYBIT_ENDPOINTS;
    const endpoint = endpoints[operation];
    if (!endpoint) fail('configuration');
    const [host, path, method, authenticated] = endpoint;
    const mutation = method !== 'GET';
    if (authenticated) validateCredentials(credentials);
    const headers = {};
    let query = '', body;
    const timestamp = String(clock() + timeOffset);
    if (exchange === 'binance') {
      const params = new URLSearchParams(parameters);
      if (authenticated) {
        params.set('timestamp', timestamp); params.set('recvWindow', RECV_WINDOW);
        headers['X-MBX-APIKEY'] = credentials.apiKey;
        query = params.toString();
        query += '&signature=' + createHmac('sha256', credentials.apiSecret).update(query).digest('hex');
      } else query = params.toString();
    } else {
      if (method === 'GET') query = new URLSearchParams(parameters).toString();
      else { body = JSON.stringify(parameters); headers['Content-Type'] = 'application/json'; }
      if (authenticated) {
        headers['X-BAPI-API-KEY'] = credentials.apiKey;
        headers['X-BAPI-TIMESTAMP'] = timestamp;
        headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
        headers['X-BAPI-SIGN'] = createHmac('sha256', credentials.apiSecret).update(timestamp + credentials.apiKey + RECV_WINDOW + (body ?? query)).digest('hex');
      }
    }
    // Keep this outside transport error handling and leave no await before fetch.
    // A lost execution lease must retain its original error, including on retry.
    if (mutation) beforeMutation?.();
    const controller = new AbortController();
    let timedOut = false, dispatched = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let abortListener;
    const interrupted = new Promise((_resolve, reject) => {
      abortListener = () => reject(new ExecutionExchangeError(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched }));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      checkAbort(signal);
      const run = async () => {
        dispatched = true;
        const response = await fetchImpl(host + path + (query ? '?' + query : ''), { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', cache: 'no-store', signal: controller.signal });
        checkAbort(controller.signal);
        if (!response || response.redirected || response.status >= 300 && response.status < 400) fail('upstream', { uncertain: mutation });
        const data = await readJson(response, controller.signal);
        checkAbort(controller.signal);
        if (!response.ok) throw upstreamFailure(exchange, response.status, data, mutation);
        if (exchange === 'bybit') {
          if (!object(data) || !Number.isSafeInteger(data.retCode)) fail();
          if (data.retCode !== 0) throw upstreamFailure(exchange, response.status, data, mutation);
          return requireObject(data.result);
        }
        if (!object(data) && !Array.isArray(data)) fail();
        if (object(data) && Object.hasOwn(data, 'code')) throw upstreamFailure(exchange, response.status, data, mutation);
        return data;
      };
      return await Promise.race([run(), interrupted]);
    } catch (error) {
      if (timedOut || signal?.aborted) throw new ExecutionExchangeError(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched });
      if (error instanceof ExecutionExchangeError) {
        if (mutation && dispatched && ['invalid_data', 'response_limit', 'transport', 'aborted'].includes(error.code)) error.uncertain = true;
        throw error;
      }
      throw new ExecutionExchangeError('transport', { uncertain: mutation && dispatched });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }

  async function request(operation, credentials, parameters = {}, options = {}) {
    try { return await rawRequest(operation, credentials, parameters, options); }
    catch (error) {
      if (!(error instanceof ExecutionExchangeError) || error.code !== 'timestamp' || error.uncertain) throw error;
      // The rejected request did not execute. A single retry preserves the same
      // client id and business payload; public time reads never retry recursively.
      const before = clock();
      const time = await rawRequest('time', null, {}, options);
      const after = clock();
      let serverTime;
      if (exchange === 'binance') serverTime = milliseconds(time.serverTime);
      else {
        if (typeof time.timeNano !== 'string' || !/^\d{1,25}$/.test(time.timeNano)) fail('clock');
        serverTime = milliseconds(Number(BigInt(time.timeNano) / 1_000_000n));
      }
      const offset = Math.round(serverTime - (before + after) / 2);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > MAX_CLOCK_OFFSET) fail('clock');
      timeOffset = offset;
      return rawRequest(operation, credentials, parameters, options);
    }
  }

  function validateSpec(spec, idRequired = false) {
    if (!object(spec) || !SYMBOLS.includes(spec.symbol) || !['buy', 'sell'].includes(spec.side)
      || !['BOTH', 'LONG', 'SHORT'].includes(spec.positionSide) || typeof spec.reduceOnly !== 'boolean'
      || typeof spec.clientId !== 'string' || !/^[.A-Z:/a-z0-9_-]{1,32}$/.test(spec.clientId)) fail('input');
    let quantity, stopPrice;
    try {
      if (typeof spec.quantity !== 'string' || typeof spec.stopPrice !== 'string') fail('input');
      quantity = decimal(spec.quantity, { positive: true }); stopPrice = decimal(spec.stopPrice, { positive: true });
    } catch { fail('input'); }
    if (spec.positionSide !== 'BOTH' && spec.reduceOnly !== hedgeClose(spec.side, spec.positionSide)) fail('input');
    let id = spec.id ?? null;
    if (id !== null) {
      try { id = exchange === 'bybit' ? strategyId(id) : identifier(id); }
      catch { fail('input'); }
      if (exchange === 'binance' && !/^\d{1,30}$/.test(id)) fail('input');
    }
    if (idRequired && exchange === 'bybit' && id === null) fail('strategy_id_required');
    return { symbol: spec.symbol, side: spec.side, positionSide: spec.positionSide, quantity, reduceOnly: spec.reduceOnly, clientId: spec.clientId, stopPrice, id };
  }

  async function permissionSnapshot(credentials, options) {
    const mode = modeOf(options.accountMode);
    const info = requireObject(await request('permissions', credentials, {}, options));
    if (exchange === 'binance') {
      if (info.enableReading !== true || BINANCE_RISKY_PERMISSIONS.some(field => info[field] !== false)
        || Object.hasOwn(info, 'enableFixApiTrade') && info.enableFixApiTrade !== false
        || typeof info.enableFutures !== 'boolean'
        || (mode === 'standard' ? info.enableFutures !== true || Object.hasOwn(info, 'enablePortfolioMarginTrading') && info.enablePortfolioMarginTrading !== false : info.enablePortfolioMarginTrading !== true)) fail('permissions');
      for (const [name, value] of Object.entries(info)) {
        if (/^(?:enable|permits)/.test(name) && !['enableReading', 'enableFutures', 'enablePortfolioMarginTrading', 'enableFixReadOnly'].includes(name) && value !== false) fail('permissions');
      }
      const config = requireObject(await request('config', credentials, {}, options));
      if (config.canTrade !== true) fail('permissions');
      if (typeof config.dualSidePosition !== 'boolean') fail('account_mode');
      return { identity: null, positionMode: config.dualSidePosition ? 'hedge' : 'one-way' };
    }
    if (info.readOnly !== 0 || !object(info.permissions)) fail('permissions');
    const scopes = info.permissions;
    // ContractTrade is documented as [Order, Position]. DerivativesTrade is the
    // UTA scope. Other nonempty capabilities (including transfer/withdrawal) are
    // intentionally rejected; missing Wallet/Spot/Options cannot prove absence.
    for (const name of ['ContractTrade', 'Wallet', 'Spot', 'Options', 'Derivatives']) if (!Array.isArray(scopes[name])) fail('permissions');
    if (!scopes.ContractTrade.includes('Order')) fail('permissions');
    for (const [name, values] of Object.entries(scopes)) {
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('permissions');
      const allowed = name === 'ContractTrade' ? ['Order', 'Position'] : name === 'Derivatives' ? ['DerivativesTrade'] : [];
      if (values.some(value => !allowed.includes(value))) fail('permissions');
    }
    const identity = identifier(info.userID);
    const config = requireObject(await request('config', credentials, {}, options));
    if (![3, 4, 5, 6].includes(config.unifiedMarginStatus)) fail('account_mode');
    return { identity, positionMode: null };
  }

  async function pages(operation, credentials, parameters, options, { cursorField = 'nextPageCursor', category, pageSize = 50 } = {}) {
    const rows = [], seenCursors = new Set();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = requireObject(await request(operation, credentials, { ...parameters, ...(cursor ? { cursor } : {}) }, options));
      if (category !== undefined && data.category !== category) fail();
      const list = array(data.list, pageSize);
      rows.push(...list);
      if (rows.length > MAX_ROWS) fail('pagination');
      if (!Object.hasOwn(data, cursorField) || typeof data[cursorField] !== 'string' || data[cursorField].length > 2000 || /[\r\n\0]/.test(data[cursorField])) fail('pagination');
      cursor = data[cursorField];
      if (!cursor) return rows;
      if (list.length === 0 || seenCursors.has(cursor)) fail('pagination');
      seenCursors.add(cursor);
    }
    fail('pagination');
  }

  function parseBinanceOrder(row) {
    requireObject(row);
    if (!SYMBOLS.includes(row.symbol)) fail();
    const side = sideOf(row.side), positionSide = positionSideOf(row.positionSide);
    if (typeof row.reduceOnly !== 'boolean' || !['NEW', 'PARTIALLY_FILLED', ...BINANCE_TERMINAL].includes(row.status)) fail();
    const size = volumes(row.origQty, row.executedQty);
    if (row.status === 'FILLED' && size.quantity !== size.filledQuantity) fail();
    const terminal = BINANCE_TERMINAL.has(row.status);
    return { id: identifier(row.orderId), kind: 'order', status: terminal ? 'terminal' : 'working', ...size,
      price: optionalPrice(row.price), averagePrice: optionalPrice(row.avgPrice), terminal, childrenSettled: terminal,
      symbol: row.symbol, side, reduceOnly: row.reduceOnly || hedgeClose(side, positionSide), positionSide, createdAt: iso(row.time, true) };
  }
  function parseStrategy(row) {
    requireObject(row);
    if (!SYMBOLS.includes(row.symbol) || row.category !== 'UTA_USDT' || row.strategyType !== 'chaseOrder' || typeof row.reduceOnly !== 'boolean') fail();
    const state = numericEnum(row.status, [2, 3, 4, 5, 6]);
    const terminal = state === 3 || state === 4;
    return { id: strategyId(row.strategyId), kind: 'strategy', status: terminal ? 'terminal' : state === 5 || state === 6 ? 'paused' : 'working',
      ...volumes(row.size, row.executedSize), price: optionalPrice(row.chaseOrderPrice), averagePrice: optionalPrice(row.executedAvgPrice),
      terminal, childrenSettled: false, symbol: row.symbol, side: sideOf(row.side), reduceOnly: row.reduceOnly,
      positionSide: null, createdAt: iso(row.createdTimeE3) };
  }

  async function verify(credentials, { accountMode, signal } = {}) {
    const snapshot = await permissionSnapshot(credentials, { accountMode: modeOf(accountMode), signal });
    return { identity: snapshot.identity };
  }

  async function account(credentials, { accountMode, signal } = {}) {
    const options = { accountMode: modeOf(accountMode), signal };
    const snapshot = await permissionSnapshot(credentials, options);
    const positions = [], openOrders = [], strategies = [], modes = {}, seenOrders = new Set(), seenStrategies = new Set();
    for (const symbol of SYMBOLS) {
      if (exchange === 'binance') {
        modes[symbol] = snapshot.positionMode;
        const rows = array(await request('positions', credentials, { symbol }, options), 20), seen = new Set();
        for (const row of rows) {
          requireObject(row);
          if (row.symbol !== symbol || options.accountMode === 'standard' && row.marginAsset !== 'USDT'
            || Object.hasOwn(row, 'marginAsset') && row.marginAsset !== 'USDT') fail();
          const positionSide = positionSideOf(row.positionSide);
          if ((positionSide === 'BOTH') !== (snapshot.positionMode === 'one-way') || seen.has(positionSide)) fail('account_mode');
          seen.add(positionSide);
          const signed = amount(row.positionAmt);
          if (positionSide === 'LONG' && compareDecimals(signed, '0') < 0 || positionSide === 'SHORT' && compareDecimals(signed, '0') > 0) fail();
          if (signed !== '0') positions.push({ symbol, side: compareDecimals(signed, '0') > 0 ? 'long' : 'short', quantity: signed.startsWith('-') ? negateDecimal(signed) : signed });
        }
        for (const row of array(await request('openOrders', credentials, { symbol }, options))) {
          const order = parseBinanceOrder(row);
          if (order.symbol !== symbol || seenOrders.has(order.id)) fail();
          seenOrders.add(order.id);
          if (!order.terminal) openOrders.push({ id: order.id, symbol, side: order.side, positionSide: order.positionSide, quantity: order.quantity, filledQuantity: order.filledQuantity });
        }
        // Conditional/algo orders no longer live in the ordinary open-order
        // endpoint. Their API does not expose cumulative fills, so do not invent
        // an ordinary order snapshot or accidentally approve concurrent orders.
        const conditional = array(await request('openAlgoOrders', credentials, { symbol }, options));
        for (const row of conditional) if (!object(row) || row.symbol !== symbol) fail();
        if (conditional.length !== 0) fail('external_orders');
      } else {
        const rows = await pages('positions', credentials, { category: 'linear', symbol, limit: '200' }, options, { category: 'linear', pageSize: 200 });
        const indices = new Set();
        for (const row of rows) {
          requireObject(row);
          if (row.symbol !== symbol) fail();
          const idx = numericEnum(row.positionIdx, [0, 1, 2]);
          if (indices.has(idx)) fail('account_mode');
          indices.add(idx);
          const quantity = amount(row.size, { nonnegative: true });
          if (quantity === '0') {
            if (!['', 'Buy', 'Sell'].includes(row.side) || idx === 1 && row.side === 'Sell' || idx === 2 && row.side === 'Buy') fail();
          } else {
            const side = sideOf(row.side);
            if (idx === 1 && side !== 'buy' || idx === 2 && side !== 'sell') fail();
            positions.push({ symbol, side: side === 'buy' ? 'long' : 'short', quantity });
          }
        }
        if (indices.size === 1 && indices.has(0)) modes[symbol] = 'one-way';
        else if (indices.size === 2 && indices.has(1) && indices.has(2)) modes[symbol] = 'hedge';
        else fail('account_mode');
        const orders = await pages('openOrders', credentials, { category: 'linear', symbol, openOnly: '0', limit: '50' }, options, { category: 'linear' });
        for (const row of orders) {
          requireObject(row);
          if (row.symbol !== symbol || !['New', 'PartiallyFilled', 'Untriggered', 'Triggered', ...BYBIT_ORDER_TERMINAL].includes(row.orderStatus)) fail();
          const id = identifier(row.orderId), size = volumes(row.qty, row.cumExecQty), positionSide = positionSideForIndex(row.positionIdx);
          if (seenOrders.has(id)) fail();
          seenOrders.add(id);
          if (!BYBIT_ORDER_TERMINAL.has(row.orderStatus)) openOrders.push({ id, symbol, side: sideOf(row.side), positionSide, ...size });
        }
        // Query active status buckets instead of paginating unbounded history.
        // Status 4 is retained because an ended strategy may still have orders.
        for (const status of ['2', '4', '5', '6']) {
          const active = await pages('strategies', credentials, { category: 'UTA_USDT', symbol, strategyType: 'chaseOrder', status, pageSize: '50' }, options, { cursorField: 'nextCursor' });
          for (const row of active) {
            const strategy = parseStrategy(row);
            if (strategy.symbol !== symbol) fail();
            // A strategy can move between status buckets during this snapshot.
            if (seenStrategies.has(strategy.id)) continue;
            seenStrategies.add(strategy.id);
            strategies.push({ id: strategy.id, symbol, side: strategy.side, quantity: strategy.quantity, filledQuantity: strategy.filledQuantity, status: strategy.status, reduceOnly: strategy.reduceOnly, createdAt: strategy.createdAt });
          }
        }
      }
    }
    checkAbort(signal);
    return { identity: snapshot.identity, modes, positions, openOrders, strategies };
  }

  async function loadRule(symbol, signal) {
    const cached = ruleCache.get(symbol);
    if (cached && cached.expiresAt > clock()) return { ...cached.rule };
    let rule;
    if (exchange === 'binance') {
      const info = requireObject(await request('rules', null, {}, { signal }));
      const matches = array(info.symbols, 5000).filter(row => row?.symbol === symbol);
      if (matches.length !== 1) fail('not_tradable');
      const row = matches[0];
      if (row.status !== 'TRADING' || row.contractType !== 'PERPETUAL' || row.quoteAsset !== 'USDT' || row.marginAsset !== 'USDT'
        || !Array.isArray(row.orderTypes) || !row.orderTypes.includes('LIMIT') || !Array.isArray(row.timeInForce) || !row.timeInForce.includes('GTX')) fail('not_tradable');
      const filters = array(row.filters, 50);
      const getFilter = name => { const values = filters.filter(filter => filter?.filterType === name); if (values.length !== 1) fail(); return values[0]; };
      const price = getFilter('PRICE_FILTER'), lot = getFilter('LOT_SIZE'), notional = getFilter('MIN_NOTIONAL');
      rule = { tickSize: amount(price.tickSize, { positive: true }), quantityStep: amount(lot.stepSize, { positive: true }),
        minQuantity: amount(lot.minQty, { positive: true }), maxQuantity: amount(lot.maxQty, { positive: true }), minNotional: amount(notional.notional, { nonnegative: true }), maxNotional: null };
    } else {
      const data = requireObject(await request('rules', null, { category: 'linear', symbol }, { signal }));
      if (data.category !== 'linear') fail();
      const rows = array(data.list, 2);
      if (rows.length !== 1 || rows[0]?.symbol !== symbol) fail('not_tradable');
      const row = rows[0];
      if (row.status !== 'Trading' || row.contractType !== 'LinearPerpetual' || row.quoteCoin !== 'USDT' || row.settleCoin !== 'USDT' || row.unifiedMarginTrade !== true) fail('not_tradable');
      const price = requireObject(row.priceFilter), lot = requireObject(row.lotSizeFilter);
      rule = { tickSize: amount(price.tickSize, { positive: true }), quantityStep: amount(lot.qtyStep, { positive: true }),
        minQuantity: amount(lot.minOrderQty, { positive: true }), maxQuantity: amount(lot.maxOrderQty, { positive: true }), minNotional: amount(lot.minNotionalValue, { nonnegative: true }), maxNotional: null };
    }
    if (compareDecimals(rule.maxQuantity, rule.minQuantity) < 0 || compareDecimals(rule.quantityStep, rule.maxQuantity) > 0) fail();
    ruleCache.set(symbol, { rule, expiresAt: clock() + RULE_TTL });
    return { ...rule };
  }

  async function market(symbol, { signal } = {}) {
    if (!SYMBOLS.includes(symbol)) fail('input');
    checkAbort(signal);
    const [rule, book] = await Promise.all([
      loadRule(symbol, signal),
      request('book', null, exchange === 'binance' ? { symbol } : { category: 'linear', symbol, limit: '1' }, { signal }),
    ]);
    requireObject(book);
    let bid, ask, at;
    if (exchange === 'binance') {
      if (book.symbol !== symbol) fail();
      bid = amount(book.bidPrice, { positive: true }); ask = amount(book.askPrice, { positive: true });
      amount(book.bidQty, { positive: true }); amount(book.askQty, { positive: true });
      at = iso(book.time);
    } else {
      if (book.s !== symbol || array(book.b, 1).length !== 1 || array(book.a, 1).length !== 1
        || array(book.b[0], 2).length !== 2 || array(book.a[0], 2).length !== 2) fail();
      bid = amount(book.b[0][0], { positive: true }); ask = amount(book.a[0][0], { positive: true });
      amount(book.b[0][1], { positive: true }); amount(book.a[0][1], { positive: true });
      at = iso(book.ts);
    }
    if (compareDecimals(bid, ask) >= 0) fail();
    checkAbort(signal);
    return { symbol, bid, ask, at, rule };
  }

  async function create(credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) {
    const options = { accountMode: modeOf(accountMode), signal, beforeMutation }, spec = validateSpec(rawSpec);
    let parameters;
    if (exchange === 'binance') parameters = {
      symbol: spec.symbol, side: spec.side.toUpperCase(), positionSide: spec.positionSide,
      type: 'LIMIT', timeInForce: 'GTX', priceMatch: 'QUEUE', quantity: spec.quantity,
      ...(spec.positionSide === 'BOTH' ? { reduceOnly: String(spec.reduceOnly) } : {}), newClientOrderId: spec.clientId, newOrderRespType: 'ACK',
    };
    else parameters = {
      category: 'UTA_USDT', symbol: spec.symbol, side: spec.side === 'buy' ? 'Buy' : 'Sell', size: spec.quantity,
      strategyType: 'chaseOrder', positionIdx: ['BOTH', 'LONG', 'SHORT'].indexOf(spec.positionSide),
      reduceOnly: spec.reduceOnly, chaseDistance: '0', maxChasePrice: spec.stopPrice,
    };
    const result = await request('create', credentials, parameters, options);
    try {
      requireObject(result);
      if (exchange === 'binance') {
        const id = identifier(result.orderId);
        if (!/^\d{1,30}$/.test(id) || Object.hasOwn(result, 'symbol') && result.symbol !== spec.symbol
          || Object.hasOwn(result, 'clientOrderId') && result.clientOrderId !== spec.clientId) fail();
        return { id, kind: 'order' };
      }
      if (result.result !== null) fail();
      return { id: strategyId(result.strategyId), kind: 'strategy' };
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  async function amend(credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) {
    if (exchange !== 'binance') fail('input');
    const options = { accountMode: modeOf(accountMode), signal, beforeMutation }, spec = validateSpec(rawSpec, true);
    if (spec.id === null) fail('input');
    const row = await request('amend', credentials, {
      symbol: spec.symbol, side: spec.side.toUpperCase(), orderId: spec.id,
      quantity: spec.quantity, priceMatch: 'QUEUE',
      // FAPI uses this flag only to validate the original order. Hedge closes
      // have no explicit reduceOnly flag, and PAPI does not accept this field.
      ...(options.accountMode === 'standard' && spec.positionSide === 'BOTH' && spec.reduceOnly ? { reduceOnly: 'true' } : {}),
    }, options);
    try {
      const result = parseBinanceOrder(row);
      if (result.id !== spec.id || result.symbol !== spec.symbol || result.side !== spec.side
        || result.positionSide !== spec.positionSide || result.reduceOnly !== spec.reduceOnly
        || result.quantity !== spec.quantity || row.clientOrderId !== spec.clientId
        || row.type !== 'LIMIT' || row.timeInForce !== 'GTX') fail();
      return result;
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  async function inspect(credentials, rawSpec, { accountMode, signal } = {}) {
    const options = { accountMode: modeOf(accountMode), signal }, spec = validateSpec(rawSpec, true);
    if (exchange === 'binance') {
      const row = await request('inspect', credentials, { symbol: spec.symbol, ...(spec.id ? { orderId: spec.id } : { origClientOrderId: spec.clientId }) }, options);
      const result = parseBinanceOrder(row);
      if (result.symbol !== spec.symbol || result.side !== spec.side || result.positionSide !== spec.positionSide
        || result.reduceOnly !== spec.reduceOnly || spec.id && result.id !== spec.id
        || row.clientOrderId !== spec.clientId || row.type !== 'LIMIT' || row.timeInForce !== 'GTX') fail();
      return result;
    }
    const rows = await pages('strategies', credentials, { strategyId: spec.id, category: 'UTA_USDT', symbol: spec.symbol, strategyType: 'chaseOrder', pageSize: '50' }, options, { cursorField: 'nextCursor' });
    if (rows.length === 0) fail('not_found', { notFound: true });
    if (rows.length !== 1) fail();
    const result = parseStrategy(rows[0]);
    if (result.id !== spec.id || result.symbol !== spec.symbol || result.side !== spec.side || result.reduceOnly !== spec.reduceOnly) fail();
    const children = await pages('children', credentials, { strategyId: spec.id, symbol: spec.symbol, strategyType: 'chaseOrder', pageSize: '50' }, options, { cursorField: 'nextCursor' });
    const known = new Map(), positionSides = new Set();
    let allSettled = true;
    for (const child of children) {
      requireObject(child);
      if (child.strategyId !== spec.id || child.symbol !== spec.symbol || sideOf(child.side) !== spec.side
        || Object.hasOwn(child, 'category') && child.category !== 'UTA_USDT') fail();
      const id = identifier(child.orderId), positionSide = positionSideForIndex(child.positionIdx);
      const state = numericEnum(child.status, [2, 3, 4, 5, 6, 7]);
      const size = volumes(child.size, child.executedSize);
      if (numericEnum(child.orderType, [1, 2]) !== 2 || positionSide !== spec.positionSide || state === 5 && size.quantity !== size.filledQuantity) fail();
      const fingerprint = JSON.stringify({ positionSide, state, ...size });
      if (known.has(id)) { if (known.get(id).fingerprint !== fingerprint) fail(); continue; }
      known.set(id, { fingerprint, filledQuantity: size.filledQuantity });
      positionSides.add(positionSide);
      if (state === 2 || state === 4) allSettled = false;
    }
    if (positionSides.size > 1) fail();
    const filled = addDecimals([...known.values()].map(row => row.filledQuantity));
    if (compareDecimals(filled, result.quantity) > 0) fail();
    result.positionSide = [...positionSides][0] ?? null;
    // REST snapshots can race. Do not release the child until strategy totals
    // and every distinct child agree, including fills during stop/cancellation.
    result.childrenSettled = result.terminal && allSettled && filled === result.filledQuantity;
    return result;
  }

  async function stop(credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) {
    const options = { accountMode: modeOf(accountMode), signal, beforeMutation }, spec = validateSpec(rawSpec, true);
    const result = await request('stop', credentials, exchange === 'binance'
      ? { symbol: spec.symbol, ...(spec.id ? { orderId: spec.id } : { origClientOrderId: spec.clientId }) }
      : { strategyId: spec.id }, options);
    try {
      requireObject(result);
      if (exchange === 'bybit') { if (strategyId(result.strategyId) !== spec.id) fail(); }
      else {
        const id = identifier(result.orderId);
        if (spec.id && id !== spec.id || result.symbol !== spec.symbol || result.clientOrderId !== spec.clientId) fail();
      }
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  return Object.freeze({ verify, account, market, create, amend, inspect, stop });
}
