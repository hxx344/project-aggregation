import { createHash } from 'node:crypto';
import { binanceSignedQuery } from './exchange-transport/binance.mjs';
import { bybitAuthHeaders } from './exchange-transport/bybit.mjs';
import { ExchangeResponseError, readJsonResponse } from './exchange-transport/response.mjs';
import { decimal, addDecimals, compareDecimals, negateDecimal } from './trading-decimal.mjs';
import { createOkxExecutionClient } from './trading-okx-execution.mjs';
import { createHyperliquidExecutionClient } from './trading-hyperliquid-execution.mjs';
import { createRhLighterExecutionClient } from './trading-rh-lighter-execution.mjs';
import { createBinanceStreams } from './trading-binance-stream.mjs';
import { createBinanceClock } from './trading-binance-clock.mjs';
import { EXECUTION_VENUE_SYMBOLS, executionSymbols } from './trading-markets.mjs';

/**
 * Restricted live execution protocol. No caller-supplied host, path, order type,
 * time-in-force, or extra request parameters are forwarded to an exchange.
 *
 * createExecutionExchangeClient(exchange, { fetchImpl, now, timeoutMs }) exposes:
 *   verify(credentials, options) -> { identity: string | null }
 *   account(credentials, options) -> { identity, modes, positions, openOrders, strategies }
 *     Anthropic positions also expose risk: { markPrice, liquidationPrice, at, noLiquidation };
 *     noLiquidation is true only when the venue explicitly reports no liquidation price.
 *     prices are positive decimal strings or null, at is the local receipt time.
 *   positionSnapshot(credentials, options) -> { identity, fetchedAt, positions }
 *     Anthropic only, using the execution connection's exact account scope;
 *     no order reads, user-stream startup or trading writes.
 *   market(symbol, { signal, withRule = true }) -> { symbol, bid, ask, at, rule }
 *     (withRule: false reads the book only, for display; rule is then absent)
 *   create(credentials, spec, options) -> { id, kind: 'order' | 'strategy' }
 *   inspect(credentials, { ...spec, id: string | null }, options) -> {
 *     id, kind, status: 'working' | 'paused' | 'terminal', quantity,
 *     filledQuantity, price, averagePrice, terminal, childrenSettled,
 *     symbol, side, reduceOnly, positionSide, createdAt
 *   }
 *   amend(credentials, { ...spec, id: string }, options) -> same as inspect (Binance / OKX)
 *   stop(credentials, { ...spec, id: string | null }, options) -> void (ACK only)
 *   endedStrategies(credentials, { ...options, symbol, startTime, endTime }) -> strategies
 *     (Bybit only; ended strategies created within a window of at most 1 h)
 * options = { accountMode: 'standard' | 'portfolio-margin' | 'unified' | 'cross' | 'isolated', signal,
 *   beforeMutation?: () => void } (the guard is an internal service callback).
 *   amend also receives amendSequence: the persisted per-order intent number
 *   (OKX derives its reqId from it; Binance ignores it).
 * spec = { symbol, side: 'buy' | 'sell', positionSide: 'BOTH' | 'LONG' | 'SHORT',
 *          quantity: decimal string, reduceOnly: boolean, clientId: string <= 32,
 *          orderType?: 'chase' | 'market' (default 'chase'),
 *          stopPrice: positive decimal string | null (chase only; null = no limit),
 *          limitPrice?: positive decimal string (Binance chase only) }.
 *
 * Market legs (orderType 'market') send one ordinary market order and are
 * never amended: Binance MARKET, Bybit linear Market with orderLinkId=clientId
 * (kind 'order', inspected by orderId/orderLinkId like Binance). Market size
 * is capped by rule.maxMarketQuantity (null = market orders unavailable).
 *
 * Binance: LIMIT + GTX + priceMatch=QUEUE, or LIMIT + GTX + price=limitPrice
 * when the caller needs a hard price bound (it must lie strictly inside
 * stopPrice, buy below / sell above). Without limitPrice,
 * stopPrice is a strategy stop trigger, NOT a guaranteed execution-price cap;
 * the caller watches prices and periodically amends the same order id with its
 * original total quantity. Each amendment is a single native modify operation,
 * not an exchange-managed chase. A failed amendment can leave the original live;
 * reconcile that order instead of canceling and replacing it to chase prices.
 * Bybit: native chaseOrder, zero offset (chasePercentE4: 0; the venue refuses
 * chaseDistance "0" with 10001), maxChasePrice=stopPrice (omitted when
 * the leg has no limit). There is no
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
 * Managed execution additionally verifies Binance UID through signed Spot USER_DATA.
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
 * https://bybit-exchange.github.io/docs/v5/order/create-order
 * https://bybit-exchange.github.io/docs/v5/order/open-order
 * https://bybit-exchange.github.io/docs/v5/order/order-list
 * https://bybit-exchange.github.io/docs/v5/order/cancel-order
 * https://bybit-exchange.github.io/docs/v5/user/apikey-info
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 40;
const MAX_ROWS = 2000;
const MAX_CLOCK_OFFSET = 300_000;
const RULE_TTL = 60_000;
export const MAX_STRATEGY_WINDOW = 7 * 86_400_000;
const RECV_WINDOW = '5000';
const ID_KEYS = new Set(['orderId', 'tranId', 'userID', 'userIDInt64', 'uid']);
const BINANCE_RISKY_PERMISSIONS = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableMargin', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
// Names as shown on Binance's API management page, so the operator knows which box to change.
const BINANCE_PERMISSION_LABELS = Object.freeze({
  enableReading: '允许读取', enableFutures: '允许合约', enablePortfolioMarginTrading: '开启统一账户交易',
  enableWithdrawals: '允许提现', enableInternalTransfer: '允许子母账户划转', permitsUniversalTransfer: '允许万向划转',
  enableMargin: '允许杠杆借贷', enableVanillaOptions: '允许欧式期权', enableSpotAndMarginTrading: '启用现货、杠杆和股票交易',
  enableFixApiTrade: '允许 FIX API 交易',
});
const BINANCE_ALLOWED_PERMISSIONS = ['enableReading', 'enableFutures', 'enablePortfolioMarginTrading', 'enableFixReadOnly'];
const BYBIT_SCOPE_LABELS = Object.freeze({ ContractTrade: '合约交易', Derivatives: '统一账户衍生品', Wallet: '钱包', Spot: '现货', Options: '期权' });
const BINANCE_TERMINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);
const BYBIT_ORDER_TERMINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled']);
// Market support is optional: an unparsable market size field means "no market legs".
const optionalMarketQuantity = parse => { try { return parse(); } catch { return null; } };
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
  constructor(code = 'upstream', { uncertain = false, notFound = false, providerCode, detail } = {}) {
    const base = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.upstream;
    super(typeof detail === 'string' && detail ? `${base}：${detail}` : base);
    this.name = 'ExecutionExchangeError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'upstream';
    this.uncertain = uncertain === true;
    if (notFound) this.notFound = true;
    if (Number.isSafeInteger(providerCode)) this.providerCode = providerCode;
  }
}

function fail(code = 'invalid_data', details) { throw new ExecutionExchangeError(code, details); }

/**
 * Returns a Chinese description of what to change on a Binance API key, or
 * null when the key has exactly the permissions this execution mode needs.
 * Only reading plus the one futures trading permission for the selected
 * account mode may be on; every other enable/permits flag must be false.
 */
function binancePermissionProblem(info, mode) {
  const label = name => labelOf(BINANCE_PERMISSION_LABELS, name);
  const portfolio = mode === 'portfolio-margin';
  const parts = [];
  // A key for the other account mode is reported as a mode problem, so the
  // remaining checks do not also ask to toggle that mode's trading permission.
  let mismatch = true;
  if (portfolio && info.enableFutures === true && info.enablePortfolioMarginTrading !== true) parts.push('密钥为普通合约密钥，请将账户模式改为「普通 U 本位」，或在组合保证金账户下新建开启统一账户交易的密钥');
  else if (!portfolio && info.enablePortfolioMarginTrading === true) parts.push('密钥已开启统一账户交易，请将账户模式改为「组合保证金（Portfolio Margin）」');
  else mismatch = false;
  const required = mismatch ? ['enableReading'] : ['enableReading', portfolio ? 'enablePortfolioMarginTrading' : 'enableFutures'];
  const missing = required.filter(name => info[name] !== true);
  const unknown = [...BINANCE_RISKY_PERMISSIONS, 'enableFutures'].filter(name => typeof info[name] !== 'boolean');
  const enabled = Object.entries(info)
    .filter(([name, value]) => /^(?:enable|permits)/.test(name) && !BINANCE_ALLOWED_PERMISSIONS.includes(name) && value !== false)
    .map(([name]) => name);
  if (!portfolio && !mismatch && Object.hasOwn(info, 'enablePortfolioMarginTrading') && info.enablePortfolioMarginTrading !== false) enabled.push('enablePortfolioMarginTrading');
  if (missing.length) parts.push(`请开启：${missing.map(label).join('、')}`);
  const toClose = enabled.filter(name => !unknown.includes(name));
  if (toClose.length) parts.push(`请关闭：${toClose.map(label).join('、')}`);
  if (unknown.length) parts.push(`Binance 未返回权限状态：${unknown.map(label).join('、')}`);
  return parts.length ? parts.join('；') : null;
}
/** Exchange-supplied names reach the UI only as short printable text. */
function labelOf(labels, name) {
  return Object.hasOwn(labels, name) ? labels[name] : String(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
}
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
// Order and transaction ids stay as their original int64 text (Node >= 24).
function idText(key, value, context) {
  if (!ID_KEYS.has(key) || typeof value !== 'number') return value;
  if (context?.source && /^\d{1,30}$/.test(context.source)) return context.source;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return fail();
}

// The shared bounded reader (docs/evolution-plan.md E2). Its codes keep their
// meaning here; one it may add later reads as invalid_data, which keeps an
// unreadable mutation response uncertain.
async function readJson(response, signal) {
  try { return await readJsonResponse(response, { maxBytes: MAX_BODY_BYTES, signal, reviver: idText }); }
  catch (error) {
    if (error instanceof ExchangeResponseError) fail(['response_limit', 'aborted'].includes(error.code) ? error.code : 'invalid_data');
    throw error;
  }
}

function binanceEndpoints(mode) {
  const portfolio = mode === 'portfolio-margin';
  const host = portfolio ? 'https://papi.binance.com' : 'https://fapi.binance.com';
  const prefix = portfolio ? '/papi/v1/um' : '/fapi/v1';
  return {
    permissions: ['https://api.binance.com', '/sapi/v1/account/apiRestrictions', 'GET', true],
    identity: ['https://api.binance.com', '/api/v3/account', 'GET', true],
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
  orderCreate: ['https://api.bybit.com', '/v5/order/create', 'POST', true],
  orderCancel: ['https://api.bybit.com', '/v5/order/cancel', 'POST', true],
  orderHistory: ['https://api.bybit.com', '/v5/order/history', 'GET', true],
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
  // Bybit 60081 means another chase on the same symbol and side exists and this
  // request created nothing: a create is re-sent only after a timestamp refusal.
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
      60063, 60064, 60066, 60067, 60069, 60070, 60075, 60077, 60078, 60079, 60081,
    ].includes(providerCode);
  return new ExecutionExchangeError(knownRejection && status < 500 ? 'rejected' : 'upstream', {
    providerCode, uncertain: mutation && (status >= 500 || !knownRejection),
  });
}

export function createExecutionExchangeClient(exchange, { fetchImpl = fetch, now = Date.now, timeoutMs = 12_000,
  binanceStreams = null, binanceClock = null, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (exchange === 'okx') return createOkxExecutionClient({ fetchImpl, now, timeoutMs, ErrorClass: ExecutionExchangeError });
  if (exchange === 'hyperliquid') return createHyperliquidExecutionClient({ fetchImpl, now, timeoutMs, ErrorClass: ExecutionExchangeError });
  if (exchange === 'rh-lighter') return createRhLighterExecutionClient({ fetchImpl, now, timeoutMs, ErrorClass: ExecutionExchangeError });
  if (!['binance', 'bybit'].includes(exchange) || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('configuration');
  const SYMBOLS = EXECUTION_VENUE_SYMBOLS[exchange];
  let timeOffset = 0;
  const ruleCache = new Map();
  const binanceTime = exchange === 'binance' ? binanceClock ?? createBinanceClock({ fetchImpl, now, timeoutMs }) : null;
  const streams = exchange === 'binance' ? binanceStreams ?? createBinanceStreams({ fetchImpl, WebSocketImpl, now,
    exchangeNow: () => binanceTime.serverNow(), ensureClock: options => binanceTime.sync(options), purpose: 'execution', timeoutMs: Math.min(5000, timeoutMs) }) : null;
  const recoveredBooks = new Map(), recoveredOrders = new Map(), requiredRest = new Set(), orderEpochs = new Map();
  let streamGeneration = 0, mutationEpoch = 0;
  const streamKey = (credentials, options, spec) => createHash('sha256').update(`${options.accountMode}\0${credentials.apiKey}\0${credentials.apiSecret}\0${spec.symbol}\0${spec.clientId}`).digest('hex');
  function streamFailure(error, signal) {
    checkAbort(signal);
    if (error?.code === 'aborted' || error?.name === 'AbortError') fail('aborted');
    // Any other stream failure, malformed frames included, only disables the
    // push path. The exact REST read is validated on its own and owns the
    // result; a stream fault must not pause a job and cancel its hedge (L103).
    // Listen-key availability is not an account/transaction authorization.
  }
  function streamMark(credentials, options) {
    try { return streams.orderGeneration?.(credentials, options) ?? null; } catch { return null; }
  }
  async function prepareStream(credentials, options) {
    if (!streams) return;
    validateCredentials(credentials);
    try { await streams.ready(credentials, options); } catch (error) { streamFailure(error, options.signal); }
  }
  function invalidateStreamOrder(credentials, spec, options) {
    const key = streamKey(credentials, options, spec);
    const at = performance.now();
    for (const [id, entry] of orderEpochs) if (at - entry.at > 300_000) { orderEpochs.delete(id); requiredRest.delete(id); recoveredOrders.delete(id); }
    if (!orderEpochs.has(key) && orderEpochs.size >= 4096) fail('response_limit');
    recoveredOrders.delete(key); requiredRest.add(key); orderEpochs.set(key, { version: ++mutationEpoch, at });
    try { streams.invalidateOrder(credentials, spec, options); } catch { /* REST reconciliation remains required. */ }
    return key;
  }
  function seedStreamOrder(credentials, row, spec, options, generation) {
    const key = streamKey(credentials, options, spec);
    // ACK-only responses cannot prime a full order. REST inspection remains
    // the fallback if an optional cache cannot validate the complete shape.
    if (!Number.isSafeInteger(row?.updateTime)) return;
    // A row read while the stream was down (or across a reconnect) cannot be
    // kept current by the new socket; keep requiring exact REST for it.
    if (generation === null) { requiredRest.add(key); return; }
    try {
      if (streams.seedOrder(credentials, row, { ...options, generation }) === false) requiredRest.add(key);
      else requiredRest.delete(key);
    } catch { requiredRest.add(key); }
  }
  let identityEvidence = null;
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
    const timestamp = String(exchange === 'binance' ? binanceTime.timestamp() : clock() + timeOffset);
    // A request the shared signer refuses is a configuration fault that was never sent.
    const sign = create => { try { return create(); } catch { return fail('configuration'); } };
    if (exchange === 'binance') {
      const params = new URLSearchParams(parameters);
      if (authenticated) {
        const signed = sign(() => binanceSignedQuery(credentials, params, { timestamp, recvWindow: RECV_WINDOW }));
        Object.assign(headers, signed.headers);
        query = signed.query;
      } else query = params.toString();
    } else {
      if (method === 'GET') query = new URLSearchParams(parameters).toString();
      else { body = JSON.stringify(parameters); headers['Content-Type'] = 'application/json'; }
      if (authenticated) Object.assign(headers, sign(() => bybitAuthHeaders(credentials, { timestamp, recvWindow: RECV_WINDOW, payload: body ?? query })));
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
      if (exchange === 'binance') {
        try { await binanceTime.sync({ signal: options.signal, force: true }); }
        catch (cause) { checkAbort(options.signal); fail(cause?.code === 'timeout' ? 'timeout' : 'clock'); }
        return rawRequest(operation, credentials, parameters, options);
      }
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
    const orderType = spec.orderType ?? 'chase';
    if (!['chase', 'market'].includes(orderType) || orderType === 'market' && spec.stopPrice !== null && spec.stopPrice !== undefined) fail('input');
    let quantity, stopPrice = null, limitPrice = null;
    try {
      if (typeof spec.quantity !== 'string') fail('input');
      quantity = decimal(spec.quantity, { positive: true });
      if (spec.stopPrice !== null && spec.stopPrice !== undefined) {
        if (typeof spec.stopPrice !== 'string') fail('input');
        stopPrice = decimal(spec.stopPrice, { positive: true });
      }
      if (spec.limitPrice !== null && spec.limitPrice !== undefined) {
        if (exchange !== 'binance' || orderType !== 'chase' || typeof spec.limitPrice !== 'string') fail('input');
        limitPrice = decimal(spec.limitPrice, { positive: true });
      }
    } catch { fail('input'); }
    if (limitPrice !== null && stopPrice !== null && compareDecimals(limitPrice, stopPrice) * (spec.side === 'buy' ? 1 : -1) >= 0) fail('input');
    if (spec.positionSide !== 'BOTH' && spec.reduceOnly !== hedgeClose(spec.side, spec.positionSide)) fail('input');
    // Bybit chase legs are native strategies (UUID); every other leg is an ordinary order.
    const strategy = exchange === 'bybit' && orderType === 'chase';
    let id = spec.id ?? null;
    if (id !== null) {
      try { id = strategy ? strategyId(id) : identifier(id); }
      catch { fail('input'); }
      // Binance ids are numeric; Bybit linear order ids are UUID-like strings.
      if (exchange === 'binance' && !/^\d{1,30}$/.test(id)) fail('input');
    }
    if (idRequired && strategy && id === null) fail('strategy_id_required');
    return { symbol: spec.symbol, side: spec.side, positionSide: spec.positionSide, quantity, reduceOnly: spec.reduceOnly, clientId: spec.clientId, orderType, stopPrice, limitPrice, strategy, id };
  }

  async function permissionSnapshot(credentials, options) {
    const mode = modeOf(options.accountMode);
    const info = requireObject(await request('permissions', credentials, {}, options));
    if (exchange === 'binance') {
      const detail = binancePermissionProblem(info, mode);
      if (detail) fail('permissions', { detail });
      const config = requireObject(await request('config', credentials, {}, options));
      if (config.canTrade !== true) fail('permissions', { detail: 'Binance 合约账户当前不可交易' });
      if (typeof config.dualSidePosition !== 'boolean') fail('account_mode');
      let identity = null;
      if (options.requireIdentity) {
        const revision = createHash('sha256').update(mode).update('\0').update(credentials.apiKey).update('\0').update(credentials.apiSecret).digest('hex');
        if (identityEvidence?.revision === revision && clock() >= identityEvidence.at && clock() - identityEvidence.at < 60_000) identity = identityEvidence.identity;
        else {
          identityEvidence = null;
          try {
            const value = requireObject(await request('identity', credentials, { omitZeroBalances: 'true' }, options));
            const uid = identifier(value.uid);
            if (!/^[1-9][0-9]{0,39}$/.test(uid)) fail('invalid_data');
            identity = uid; identityEvidence = { revision, identity, at: clock() };
          } catch { checkAbort(options.signal); /* A readable connection without verified UID remains read-only. */ }
        }
      }
      return { identity, positionMode: config.dualSidePosition ? 'hedge' : 'one-way' };
    }
    if (info.readOnly !== 0) fail('permissions', { detail: '密钥为只读，请改为读写并开启合约交易（订单、持仓）' });
    if (!object(info.permissions)) fail('permissions', { detail: 'Bybit 未返回密钥权限清单' });
    const scopes = info.permissions;
    // ContractTrade is documented as [Order, Position]. DerivativesTrade is the
    // UTA scope. Other nonempty capabilities (including transfer/withdrawal) are
    // intentionally rejected; missing Wallet/Spot/Options cannot prove absence.
    for (const name of ['ContractTrade', 'Wallet', 'Spot', 'Options', 'Derivatives']) if (!Array.isArray(scopes[name])) fail('permissions', { detail: `Bybit 未返回「${BYBIT_SCOPE_LABELS[name]}」权限状态` });
    if (!scopes.ContractTrade.includes('Order')) fail('permissions', { detail: '请开启：合约交易 - 订单' });
    for (const [name, values] of Object.entries(scopes)) {
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('permissions', { detail: 'Bybit 权限清单格式无效' });
      const allowed = name === 'ContractTrade' ? ['Order', 'Position'] : name === 'Derivatives' ? ['DerivativesTrade'] : [];
      const extra = values.filter(value => !allowed.includes(value));
      if (extra.length) fail('permissions', { detail: `请关闭：${labelOf(BYBIT_SCOPE_LABELS, name)} - ${extra.map(value => labelOf({}, value)).join('、')}` });
    }
    const identity = identifier(info.userID);
    const config = requireObject(await request('config', credentials, {}, options));
    if (![3, 4, 5, 6].includes(config.unifiedMarginStatus)) {
      const status = config.unifiedMarginStatus;
      fail('account_mode', { detail: status === 1 ? 'Bybit 账户为经典账户，请先在 Bybit 升级为统一交易账户' : Number.isSafeInteger(status) ? `Bybit 返回了未识别的账户状态 ${status}` : status === undefined ? 'Bybit 未返回账户状态' : 'Bybit 返回的账户状态格式无效' });
    }
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
  function parseBybitOrder(row, spec) {
    requireObject(row);
    if (row.symbol !== spec.symbol || row.orderLinkId !== spec.clientId || row.orderType !== 'Market'
      || !['Created', 'New', 'PartiallyFilled', ...BYBIT_ORDER_TERMINAL].includes(row.orderStatus) || typeof row.reduceOnly !== 'boolean'
      || Object.hasOwn(row, 'stopOrderType') && !['', 'UNKNOWN'].includes(row.stopOrderType)) fail();
    const side = sideOf(row.side), positionSide = positionSideForIndex(row.positionIdx), size = volumes(row.qty, row.cumExecQty);
    if (row.orderStatus === 'Filled' && size.quantity !== size.filledQuantity) fail();
    const terminal = BYBIT_ORDER_TERMINAL.has(row.orderStatus);
    return { id: identifier(row.orderId), kind: 'order', status: terminal ? 'terminal' : 'working', ...size,
      price: null, averagePrice: optionalPrice(row.avgPrice), terminal, childrenSettled: terminal,
      symbol: row.symbol, side, reduceOnly: row.reduceOnly || hedgeClose(side, positionSide), positionSide, createdAt: iso(row.createdTime) };
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

  async function verify(credentials, { accountMode, signal, requireIdentity = false } = {}) {
    const snapshot = await permissionSnapshot(credentials, { accountMode: modeOf(accountMode), signal, requireIdentity });
    return { identity: snapshot.identity };
  }

  function binancePositions(rows, symbol, options, positionMode, receivedAt, display = false) {
    const positions = [], seen = new Set();
    const optional = (value, constraints) => { try { return amount(value, constraints); } catch { return null; } };
    for (const row of rows) {
      requireObject(row);
      if (row.symbol !== symbol || options.accountMode === 'standard' && row.marginAsset !== 'USDT'
        || Object.hasOwn(row, 'marginAsset') && row.marginAsset !== 'USDT') fail();
      const positionSide = positionSideOf(row.positionSide);
      if ((positionSide === 'BOTH') !== (positionMode === 'one-way') || seen.has(positionSide)) fail('account_mode');
      seen.add(positionSide);
      const signed = amount(row.positionAmt);
      if (positionSide === 'LONG' && compareDecimals(signed, '0') < 0 || positionSide === 'SHORT' && compareDecimals(signed, '0') > 0) fail();
      if (signed === '0') continue;
      const position = { symbol, side: compareDecimals(signed, '0') > 0 ? 'long' : 'short', quantity: signed.startsWith('-') ? negateDecimal(signed) : signed };
      // Display fields are optional. Missing risk prices never manufacture a
      // zero or prevent the existing execution preflight from reading size.
      const risk = { markPrice: optional(row.markPrice, { positive: true }), liquidationPrice: optional(row.liquidationPrice, { positive: true }), at: receivedAt };
      // Binance reports "0" when the position has no liquidation price; missing or malformed stays unknown.
      risk.noLiquidation = risk.liquidationPrice === null && optional(row.liquidationPrice, { nonnegative: true }) !== null;
      if (display) {
        const notional = optional(row.notional);
        positions.push({ ...position, quantityUnit: 'ANTHROPIC', entryPrice: optional(row.entryPrice, { positive: true }), markPrice: risk.markPrice,
          notional: notional?.startsWith('-') ? negateDecimal(notional) : notional, unrealizedPnl: optional(row.unRealizedProfit),
          leverage: optional(row.leverage, { positive: true }), marginMode: ['cross', 'isolated'].includes(row.marginType) ? row.marginType : null,
          liquidationPrice: risk.liquidationPrice, liquidationKnown: optional(row.liquidationPrice, { nonnegative: true }) !== null, riskFetchedAt: risk.at });
      } else positions.push({ ...position, ...(symbol === 'ANTHROPICUSDT' ? { risk } : {}) });
    }
    return positions;
  }

  async function positionSnapshot(credentials, { accountMode, signal, symbols } = {}) {
    const selected = executionSymbols(symbols, ['ANTHROPICUSDT']);
    if (exchange !== 'binance' || !selected) fail('input');
    const options = { accountMode: modeOf(accountMode), signal, requireIdentity: true };
    const snapshot = await permissionSnapshot(credentials, options);
    if (snapshot.identity === null) fail('permissions', { detail: 'Binance UID 尚未核验，无法关联执行账户仓位' });
    const rows = array(await request('positions', credentials, { symbol: selected[0] }, options), 20);
    const fetchedAt = new Date(clock()).toISOString();
    const positions = binancePositions(rows, selected[0], options, snapshot.positionMode, fetchedAt, true);
    checkAbort(signal);
    return { identity: snapshot.identity, fetchedAt, positions };
  }

  async function account(credentials, { accountMode, signal, requireIdentity = false, symbols } = {}) {
    const options = { accountMode: modeOf(accountMode), signal, requireIdentity }, selected = executionSymbols(symbols, SYMBOLS);
    if (!selected) fail('input');
    const snapshot = await permissionSnapshot(credentials, options);
    // Start the read-only user stream during the account preflight, before the
    // engine sends either trading leg. Failure keeps exact REST checks in use.
    await prepareStream(credentials, options);
    const positions = [], openOrders = [], strategies = [], modes = {}, seenOrders = new Set(), seenStrategies = new Set();
    for (const symbol of selected) {
      if (exchange === 'binance') {
        modes[symbol] = snapshot.positionMode;
        const rows = array(await request('positions', credentials, { symbol }, options), 20);
        const receivedAt = new Date(clock()).toISOString();
        positions.push(...binancePositions(rows, symbol, options, snapshot.positionMode, receivedAt));
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
        // One symbol has at most three position rows, so one page is complete and its cursor is
        // not followed; the mode check below refuses a page that lacks a side.
        const data = requireObject(await request('positions', credentials, { category: 'linear', symbol, limit: '200' }, options));
        if (data.category !== 'linear') fail();
        const rows = array(data.list, 200);
        const indices = new Set();
        for (const row of rows) {
          requireObject(row);
          if (row.symbol !== symbol) fail();
          const idx = numericEnum(row.positionIdx, [0, 1, 2]);
          if (indices.has(idx)) fail('account_mode', { detail: `Bybit 对 ${symbol} 在同一页返回了重复的持仓记录（持仓方向编号 ${idx}）` });
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
        else fail('account_mode', { detail: indices.size ? `Bybit 对 ${symbol} 返回的持仓记录不完整（持仓方向编号 ${[...indices].sort().join('、')}）` : `Bybit 没有返回 ${symbol} 的持仓记录，该账户可能不能交易这个合约` });
        const orders = await pages('openOrders', credentials, { category: 'linear', symbol, openOnly: '0', limit: '50' }, options, { category: 'linear' });
        for (const row of orders) {
          requireObject(row);
          if (row.symbol !== symbol || !['Created', 'New', 'PartiallyFilled', 'Untriggered', 'Triggered', ...BYBIT_ORDER_TERMINAL].includes(row.orderStatus)) fail();
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

  // Operator confirmation only. Ended strategies (status 3) are outside the
  // routine account snapshot, so a create that ended without a fill is looked
  // up in a bounded window around the request instead of scanning history.
  // The venue takes whole seconds and filters by creation time; a window whose
  // two ends are the creation second returned nothing, so an end may be
  // exclusive and the window starts one second early. The caller filters by
  // creation time again; incomplete pagination fails.
  async function endedStrategies(credentials, { accountMode, signal, symbol, startTime, endTime } = {}) {
    if (exchange !== 'bybit' || !SYMBOLS.includes(symbol) || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime)
      || startTime < 0 || endTime <= startTime || endTime - startTime > MAX_STRATEGY_WINDOW) fail('input');
    const options = { accountMode: modeOf(accountMode), signal }, seen = new Set(), strategies = [];
    const rows = await pages('strategies', credentials, { category: 'UTA_USDT', symbol, strategyType: 'chaseOrder', status: '3', beginTimeE0: String(Math.floor(startTime / 1000) - 1), endTimeE0: String(Math.ceil(endTime / 1000)), pageSize: '50' }, options, { cursorField: 'nextCursor' });
    for (const row of rows) {
      const strategy = parseStrategy(row);
      if (strategy.symbol !== symbol || seen.has(strategy.id)) fail();
      seen.add(strategy.id);
      strategies.push({ id: strategy.id, symbol, side: strategy.side, quantity: strategy.quantity, filledQuantity: strategy.filledQuantity, status: strategy.status, reduceOnly: strategy.reduceOnly, createdAt: strategy.createdAt });
    }
    checkAbort(signal);
    return strategies;
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
      // Oil and equity perpetuals are listed as TRADIFI_PERPETUAL; both settle as ordinary USDT-M perpetuals.
      if (row.status !== 'TRADING' || !['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row.contractType) || row.quoteAsset !== 'USDT' || row.marginAsset !== 'USDT'
        || !Array.isArray(row.orderTypes) || !row.orderTypes.includes('LIMIT') || !Array.isArray(row.timeInForce) || !row.timeInForce.includes('GTX')) fail('not_tradable');
      const filters = array(row.filters, 50);
      const getFilter = name => { const values = filters.filter(filter => filter?.filterType === name); if (values.length !== 1) fail(); return values[0]; };
      const price = getFilter('PRICE_FILTER'), lot = getFilter('LOT_SIZE'), notional = getFilter('MIN_NOTIONAL');
      rule = { tickSize: amount(price.tickSize, { positive: true }), quantityStep: amount(lot.stepSize, { positive: true }),
        minQuantity: amount(lot.minQty, { positive: true }), maxQuantity: amount(lot.maxQty, { positive: true }), minNotional: amount(notional.notional, { nonnegative: true }), maxNotional: null, maxMarketQuantity: null };
      // Market orders have their own size filter. Offer them only when that
      // filter shares the limit-order step, so one batch split fits both.
      // A malformed market filter only disables market legs, never chase legs.
      const marketLots = filters.filter(filter => filter?.filterType === 'MARKET_LOT_SIZE');
      if (row.orderTypes.includes('MARKET') && marketLots.length === 1) rule.maxMarketQuantity = optionalMarketQuantity(() => {
        const lot = marketLots[0];
        return amount(lot.stepSize, { positive: true }) === rule.quantityStep && compareDecimals(amount(lot.minQty, { positive: true }), rule.minQuantity) <= 0 ? amount(lot.maxQty, { positive: true }) : null;
      });
    } else {
      const data = requireObject(await request('rules', null, { category: 'linear', symbol }, { signal }));
      if (data.category !== 'linear') fail();
      const rows = array(data.list, 2);
      if (rows.length !== 1 || rows[0]?.symbol !== symbol) fail('not_tradable');
      const row = rows[0];
      if (row.status !== 'Trading' || row.contractType !== 'LinearPerpetual' || row.quoteCoin !== 'USDT' || row.settleCoin !== 'USDT' || row.unifiedMarginTrade !== true) fail('not_tradable');
      const price = requireObject(row.priceFilter), lot = requireObject(row.lotSizeFilter);
      rule = { tickSize: amount(price.tickSize, { positive: true }), quantityStep: amount(lot.qtyStep, { positive: true }),
        minQuantity: amount(lot.minOrderQty, { positive: true }), maxQuantity: amount(lot.maxOrderQty, { positive: true }), minNotional: amount(lot.minNotionalValue, { nonnegative: true }), maxNotional: null,
        maxMarketQuantity: optionalMarketQuantity(() => lot.maxMktOrderQty === undefined || lot.maxMktOrderQty === '' ? null : amount(lot.maxMktOrderQty, { positive: true })) };
    }
    if (compareDecimals(rule.maxQuantity, rule.minQuantity) < 0 || compareDecimals(rule.quantityStep, rule.maxQuantity) > 0) fail();
    ruleCache.set(symbol, { rule, expiresAt: clock() + RULE_TTL });
    return { ...rule };
  }

  async function market(symbol, { signal, withRule = true } = {}) {
    if (!SYMBOLS.includes(symbol)) fail('input');
    checkAbort(signal);
    const readBook = async () => {
      if (streams) {
        try { const pushed = await streams.book(symbol, { signal }); if (pushed) return { book: pushed, pushed: true }; }
        catch (error) { streamFailure(error, signal); }
        const cached = recoveredBooks.get(symbol), time = clock();
        if (cached && time >= cached.at && time - cached.at < 5000) return { book: cached.book, pushed: false };
      }
      const book = await request('book', null, exchange === 'binance' ? { symbol } : { category: 'linear', symbol, limit: '1' }, { signal });
      if (streams) recoveredBooks.set(symbol, { book, at: clock() });
      return { book, pushed: false };
    };
    const [rule, received] = await Promise.all([
      withRule ? loadRule(symbol, signal) : null,
      readBook(),
    ]);
    const { book } = received;
    requireObject(book);
    let bid, ask, at;
    if (exchange === 'binance') {
      if (book.symbol !== symbol) fail();
      bid = amount(book.bidPrice, { positive: true }); ask = amount(book.askPrice, { positive: true });
      amount(book.bidQty, { positive: true }); amount(book.askQty, { positive: true });
      // Keep transport delay in the shared execution freshness budget for
      // both WS and REST; only translate venue time into the local clock.
      at = iso(milliseconds(book.time) - (binanceTime.serverNow() - clock()));
    } else {
      if (book.s !== symbol || array(book.b, 1).length !== 1 || array(book.a, 1).length !== 1
        || array(book.b[0], 2).length !== 2 || array(book.a[0], 2).length !== 2) fail();
      bid = amount(book.b[0][0], { positive: true }); ask = amount(book.a[0][0], { positive: true });
      amount(book.b[0][1], { positive: true }); amount(book.a[0][1], { positive: true });
      at = iso(book.ts);
    }
    if (compareDecimals(bid, ask) >= 0) fail();
    checkAbort(signal);
    return withRule ? { symbol, bid, ask, at, rule } : { symbol, bid, ask, at };
  }

  async function create(credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) {
    const options = { accountMode: modeOf(accountMode), signal, beforeMutation }, spec = validateSpec(rawSpec);
    const market = spec.orderType === 'market';
    let parameters;
    if (exchange === 'binance') parameters = {
      symbol: spec.symbol, side: spec.side.toUpperCase(), positionSide: spec.positionSide,
      ...(market ? { type: 'MARKET' } : { type: 'LIMIT', timeInForce: 'GTX', ...(spec.limitPrice === null ? { priceMatch: 'QUEUE' } : { price: spec.limitPrice }) }), quantity: spec.quantity,
      ...(spec.positionSide === 'BOTH' ? { reduceOnly: String(spec.reduceOnly) } : {}), newClientOrderId: spec.clientId, newOrderRespType: 'ACK',
    };
    else if (market) parameters = {
      category: 'linear', symbol: spec.symbol, side: spec.side === 'buy' ? 'Buy' : 'Sell', orderType: 'Market', qty: spec.quantity,
      positionIdx: ['BOTH', 'LONG', 'SHORT'].indexOf(spec.positionSide), reduceOnly: spec.reduceOnly, orderLinkId: spec.clientId,
    };
    else parameters = {
      category: 'UTA_USDT', symbol: spec.symbol, side: spec.side === 'buy' ? 'Buy' : 'Sell', size: spec.quantity,
      strategyType: 'chaseOrder', positionIdx: ['BOTH', 'LONG', 'SHORT'].indexOf(spec.positionSide),
      // maxChasePrice is optional: without it the strategy follows the book until filled or stopped.
      reduceOnly: spec.reduceOnly, chasePercentE4: 0, ...(spec.stopPrice === null ? {} : { maxChasePrice: spec.stopPrice }),
    };
    if (streams) { validateCredentials(credentials); invalidateStreamOrder(credentials, spec, options); }
    const result = await request(exchange === 'bybit' && market ? 'orderCreate' : 'create', credentials, parameters, options);
    try {
      requireObject(result);
      if (exchange === 'bybit' && market) {
        const id = identifier(result.orderId);
        if (result.orderLinkId !== spec.clientId) fail();
        return { id, kind: 'order' };
      }
      if (exchange === 'binance') {
        const id = identifier(result.orderId);
        if (!/^\d{1,30}$/.test(id) || Object.hasOwn(result, 'symbol') && result.symbol !== spec.symbol
          || Object.hasOwn(result, 'clientOrderId') && result.clientOrderId !== spec.clientId) fail();
        // New client IDs cannot have earlier live events. Once creation was
        // accepted, its private stream can supply the first full status.
        requiredRest.delete(streamKey(credentials, options, spec));
        return { id, kind: 'order' };
      }
      if (result.result !== null) fail();
      return { id: strategyId(result.strategyId), kind: 'strategy' };
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  async function amend(credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) {
    if (exchange !== 'binance') fail('input');
    const options = { accountMode: modeOf(accountMode), signal, beforeMutation }, spec = validateSpec(rawSpec, true);
    if (spec.id === null || spec.orderType !== 'chase') fail('input');
    validateCredentials(credentials); invalidateStreamOrder(credentials, spec, options);
    const generation = streamMark(credentials, options);
    const row = await request('amend', credentials, {
      symbol: spec.symbol, side: spec.side.toUpperCase(), orderId: spec.id,
      quantity: spec.quantity, ...(spec.limitPrice === null ? { priceMatch: 'QUEUE' } : { price: spec.limitPrice }),
      // FAPI uses this flag only to validate the original order. Hedge closes
      // have no explicit reduceOnly flag, and PAPI does not accept this field.
      ...(options.accountMode === 'standard' && spec.positionSide === 'BOTH' && spec.reduceOnly ? { reduceOnly: 'true' } : {}),
    }, options);
    try {
      const result = parseBinanceOrder(row);
      if (result.id !== spec.id || result.symbol !== spec.symbol || result.side !== spec.side
        || result.positionSide !== spec.positionSide || result.reduceOnly !== spec.reduceOnly
        || result.quantity !== spec.quantity || row.clientOrderId !== spec.clientId
        || row.type !== 'LIMIT' || row.timeInForce !== 'GTX'
        || spec.limitPrice !== null && (result.price === null || compareDecimals(result.price, spec.limitPrice) !== 0)) fail();
      seedStreamOrder(credentials, row, spec, options, generation);
      return result;
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  async function inspect(credentials, rawSpec, { accountMode, signal } = {}) {
    const options = { accountMode: modeOf(accountMode), signal }, spec = validateSpec(rawSpec, true);
    if (exchange === 'binance') {
      validateCredentials(credentials);
      const key = streamKey(credentials, options, spec), epoch = orderEpochs.get(key)?.version, generation = streamGeneration;
      let row, fetched = false, seedGeneration = null;
      if (!requiredRest.has(key)) {
        try { row = await streams.order(credentials, spec, options); } catch (error) { streamFailure(error, signal); }
        if (row) recoveredOrders.delete(key);
      }
      if (!row) {
        const cached = recoveredOrders.get(key), time = clock();
        if (cached && time >= cached.at && time - cached.at < 5000) row = cached.row;
        else {
          seedGeneration = streamMark(credentials, options);
          row = await request('inspect', credentials, { symbol: spec.symbol, ...(spec.id ? { orderId: spec.id } : { origClientOrderId: spec.clientId }) }, options);
          fetched = true;
          if (generation !== streamGeneration) fail('aborted');
          if (epoch !== orderEpochs.get(key)?.version) fail('upstream', { detail: '订单读取早于最近写入，请重新核对' });
        }
      }
      checkAbort(signal);
      const result = parseBinanceOrder(row);
      if (result.symbol !== spec.symbol || result.side !== spec.side || result.positionSide !== spec.positionSide
        || result.reduceOnly !== spec.reduceOnly || spec.id && result.id !== spec.id || row.clientOrderId !== spec.clientId
        || (spec.orderType === 'market' ? row.type !== 'MARKET' : row.type !== 'LIMIT' || row.timeInForce !== 'GTX')) fail();
      if (generation !== streamGeneration) fail('aborted');
      if (epoch !== orderEpochs.get(key)?.version) fail('upstream', { detail: '订单读取早于最近写入，请重新核对' });
      // Never renew cached evidence by reading it again; the stream owns its
      // own timestamp and the REST repair retains its original receipt time.
      if (fetched) {
        if (recoveredOrders.size >= 4096 && !recoveredOrders.has(key)) recoveredOrders.delete(recoveredOrders.keys().next().value);
        recoveredOrders.set(key, { row, at: clock() });
        seedStreamOrder(credentials, row, spec, options, seedGeneration);
      }
      return result;
    }
    if (!spec.strategy) {
      // Recent orders (open or closed) come from the realtime endpoint; older
      // or restart-cleared ones from history. Both are keyed by our id.
      const key = spec.id ? { orderId: spec.id } : { orderLinkId: spec.clientId };
      let rows = await pages('openOrders', credentials, { category: 'linear', symbol: spec.symbol, ...key, limit: '50' }, options, { category: 'linear' });
      if (rows.length === 0) rows = await pages('orderHistory', credentials, { category: 'linear', symbol: spec.symbol, ...key, limit: '50' }, options, { category: 'linear' });
      if (rows.length === 0) fail('not_found', { notFound: true });
      if (rows.length !== 1) fail();
      const result = parseBybitOrder(rows[0], spec);
      if (spec.id && result.id !== spec.id || result.side !== spec.side || result.positionSide !== spec.positionSide || result.reduceOnly !== spec.reduceOnly) fail();
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
      // The venue reports the text UNKNOWN for a chase child (documented: 1 market, 2 limit), so this field no longer tells them apart.
      if (child.orderType !== 'UNKNOWN' && numericEnum(child.orderType, [1, 2]) !== 2 || positionSide !== spec.positionSide || state === 5 && size.quantity !== size.filledQuantity) fail();
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
    if (streams) { validateCredentials(credentials); invalidateStreamOrder(credentials, spec, options); }
    const generation = streams ? streamMark(credentials, options) : null;
    const result = exchange === 'binance'
      ? await request('stop', credentials, { symbol: spec.symbol, ...(spec.id ? { orderId: spec.id } : { origClientOrderId: spec.clientId }) }, options)
      : spec.strategy ? await request('stop', credentials, { strategyId: spec.id }, options)
        : await request('orderCancel', credentials, { category: 'linear', symbol: spec.symbol, ...(spec.id ? { orderId: spec.id } : { orderLinkId: spec.clientId }) }, options);
    try {
      requireObject(result);
      if (exchange === 'bybit' && spec.strategy) { if (strategyId(result.strategyId) !== spec.id) fail(); }
      else if (exchange === 'bybit') { if (spec.id && identifier(result.orderId) !== spec.id || result.orderLinkId !== spec.clientId) fail(); }
      else {
        const id = identifier(result.orderId);
        if (spec.id && id !== spec.id || result.symbol !== spec.symbol || result.clientOrderId !== spec.clientId) fail();
        seedStreamOrder(credentials, result, spec, options, generation);
      }
    } catch { fail('invalid_data', { uncertain: true }); }
  }

  function forget() {
    streamGeneration += 1; identityEvidence = null; recoveredBooks.clear(); recoveredOrders.clear(); requiredRest.clear(); orderEpochs.clear();
    streams?.forget(); binanceTime?.forget();
  }
  return Object.freeze({ verify, account, ...(exchange === 'binance' ? { positionSnapshot } : {}), endedStrategies, market, create, amend, inspect, stop, forget,
    close() { forget(); streams?.close(); } });
}
