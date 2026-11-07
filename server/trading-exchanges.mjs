import { createHash, createHmac } from 'node:crypto';
import { decimal, negateDecimal, compareDecimals } from './trading-decimal.mjs';
import { normalizeTradingDiagnostic, formatTradingDiagnostic } from './trading-diagnostics.mjs';
import { createOkxTradingClient } from './trading-okx-readonly.mjs';
import { TRADING_ANTHROPIC_SYMBOLS, TRADING_HYNIX_SYMBOLS } from './trading-markets.mjs';
import { createBinanceClock } from './trading-binance-clock.mjs';
import { createBinanceStreams } from './trading-binance-stream.mjs';

const SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
const BYBIT_BASE_COINS = Object.freeze({ CLUSDT: 'CL', BZUSDT: 'BZ' });
const DAY = 86_400_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 240;
export const MAX_FUNDING_EVENTS = 50_000;
const CORE_WRITE_PERMISSIONS = ['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const OPTIONAL_WRITE_PERMISSIONS = ['enableFixApiTrade', 'enablePortfolioMarginTrading'];
const ENDPOINTS = Object.freeze({
  binance: Object.freeze({
    permissions: ['https://api.binance.com', '/sapi/v1/account/apiRestrictions'],
    positions: ['https://fapi.binance.com', '/fapi/v3/positionRisk'],
    funding: ['https://fapi.binance.com', '/fapi/v1/income'],
    portfolioPositions: ['https://papi.binance.com', '/papi/v1/um/positionRisk'],
    portfolioFunding: ['https://papi.binance.com', '/papi/v1/um/income'],
  }),
  bybit: Object.freeze({
    permissions: ['https://api.bybit.com', '/v5/user/query-api'],
    account: ['https://api.bybit.com', '/v5/account/info'],
    positions: ['https://api.bybit.com', '/v5/position/list'],
    funding: ['https://api.bybit.com', '/v5/account/transaction-log'],
  }),
});

export class TradingExchangeError extends Error {
  constructor(message, code = 'upstream', diagnostic = null) { super(message); this.name = 'TradingExchangeError'; this.code = code; this.diagnostic = normalizeTradingDiagnostic(diagnostic); }
}

function invalidData(field, value, reason = 'format') {
  const error = new TradingExchangeError('交易所返回的数据不完整或格式无效', 'invalid_data');
  if (field) Object.assign(error, { field, reason, valueType: value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
  return error;
}
function abortError() { return new DOMException('读取已取消', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '' || value === 0 || value === '0')) return null;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw invalidData();
  return value;
}
function sourceTime(value) { const time = timestamp(value, { optional: true }); return time === null ? null : new Date(time).toISOString(); }
function amount(value, options) { try { return decimal(value, options); } catch { throw invalidData(); } }
function optionalAmount(value, options = {}) { return value === undefined || value === null || value === '' ? null : amount(value, options); }
function absolute(value) { return compareDecimals(value, '0') < 0 ? negateDecimal(value) : value; }
function optionalAbsolute(value) { const normalized = optionalAmount(value); return normalized === null ? null : absolute(normalized); }
function liquidation(value) { const normalized = optionalAmount(value, { nonnegative: true }); return normalized === '0' ? null : normalized; }
function rowId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !value || value.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw invalidData();
  return value;
}
function cursorOf(data, funding = false) {
  // An explicit null is an absent next-page token, not an unread page.
  if (funding && data.nextPageCursor === null) return '';
  if (data.nextPageCursor === undefined) return '';
  if (typeof data.nextPageCursor !== 'string' || data.nextPageCursor.length > 2000 || /[\r\n\0]/.test(data.nextPageCursor)) throw invalidData(funding ? 'nextPageCursor' : undefined, data.nextPageCursor);
  return data.nextPageCursor;
}
function requireList(data, limit, category = false) {
  if (!object(data) || !Array.isArray(data.list) || data.list.length > limit || (category && data.category !== 'linear')) throw invalidData();
  return data.list;
}
function fundingList(data, limit) {
  if (!object(data)) throw invalidData('result', data, 'type');
  if (!Array.isArray(data.list)) throw invalidData('list', data.list, 'type');
  if (data.list.length > limit) throw invalidData('list', data.list, 'limit');
  return data.list;
}
function receiptField(field, value, parse) {
  try { return parse(value); }
  catch { throw invalidData(field, value, value === '' ? 'empty' : 'format'); }
}
function bybitReceiptId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  // The provider defines id as a string, not a locally generated identifier.
  // Preserve opaque punctuation verbatim for deduplication, never in diagnostics.
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw invalidData();
  return value;
}
function bybitFundingAmount(value) {
  if (typeof value !== 'string') return decimal(value);
  if (value.length > 100) throw invalidData();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) throw invalidData();
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 100) throw invalidData();
  // Move the decimal point as text. Do not round through Number or toFixed.
  const digits = match[2] + (match[3] || ''), point = match[2].length + exponent;
  const integer = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '');
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '');
  return decimal(`${match[1] === '-' ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`);
}

// Node >=24 provides the original numeric token to JSON.parse revivers. Keeping
// tranId as text prevents int64 transaction identifiers from being rounded.
function parseResponse(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key !== 'tranId' || typeof value !== 'number') return value;
    if (context?.source && /^\d{1,30}$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    throw invalidData();
  });
}

async function limitedJson(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new TradingExchangeError('交易所响应超过大小限制', 'response_limit');
  if (!response.body?.getReader) throw invalidData();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, finished = false;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new TradingExchangeError('交易所响应超过大小限制', 'response_limit');
      chunks.push(Buffer.from(value));
    }
    return parseResponse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalizePosition(exchange, row, symbol, accountMode) {
  if (!object(row) || row.symbol !== symbol) throw invalidData();
  let side, mode, quantity, suffix;
  if (exchange === 'binance') {
    if (!['BOTH', 'LONG', 'SHORT'].includes(row.positionSide)) throw invalidData();
    const signed = amount(row.positionAmt);
    if ((row.positionSide === 'LONG' && compareDecimals(signed, '0') < 0) || (row.positionSide === 'SHORT' && compareDecimals(signed, '0') > 0)) throw invalidData();
    quantity = absolute(signed);
    if (quantity === '0') return null;
    // PAPI UM omits marginAsset. Its fixed per-symbol USDT requests identify the
    // USDT contract; an explicitly conflicting asset must still be rejected.
    if (accountMode === 'portfolio-margin' ? Object.hasOwn(row, 'marginAsset') && row.marginAsset !== 'USDT' : row.marginAsset !== 'USDT') throw invalidData();
    side = compareDecimals(signed, '0') > 0 ? 'long' : 'short';
    mode = row.positionSide === 'BOTH' ? 'one-way' : 'hedge';
    suffix = row.positionSide;
  } else {
    if (![0, 1, 2].includes(row.positionIdx)) throw invalidData();
    quantity = amount(row.size, { nonnegative: true });
    if (quantity === '0') {
      if (!['', 'Buy', 'Sell'].includes(row.side)) throw invalidData();
      return null;
    }
    if (!['Buy', 'Sell'].includes(row.side) || (row.positionIdx === 1 && row.side !== 'Buy') || (row.positionIdx === 2 && row.side !== 'Sell')) throw invalidData();
    side = row.side === 'Buy' ? 'long' : 'short';
    mode = row.positionIdx === 0 ? 'one-way' : 'hedge';
    suffix = String(row.positionIdx);
  }
  const binance = exchange === 'binance';
  return {
    id: `${exchange}:${symbol}:${suffix}`, exchange, symbol, side, mode, quantity,
    entryPrice: optionalAmount(binance ? row.entryPrice : row.avgPrice, { nonnegative: true }),
    markPrice: optionalAmount(row.markPrice, { nonnegative: true }),
    notional: optionalAbsolute(binance ? row.notional : row.positionValue),
    unrealizedPnl: optionalAmount(binance ? row.unRealizedProfit : row.unrealisedPnl),
    leverage: optionalAmount(row.leverage, { positive: true }),
    liquidationPrice: liquidation(binance ? row.liquidationPrice : row.liqPrice),
    sourceUpdatedAt: sourceTime(binance ? row.updateTime : row.updatedTime),
  };
}

function normalizeReceipt(exchange, row, { symbol, start, end }) {
  const binance = exchange === 'binance';
  if (!object(row)) throw invalidData(binance ? undefined : 'record', row, 'type');
  if (typeof row.symbol !== 'string' || !/^[A-Z0-9_-]{1,80}$/.test(row.symbol)) throw invalidData(binance ? undefined : 'symbol', row.symbol);
  const time = binance ? timestamp(row.time) : receiptField('transactionTime', row.transactionTime, timestamp);
  // Requests use inclusive endTime=end-1. A record at end belongs to the next
  // window; records from adjacent windows cannot prove this window complete.
  // Validate even filtered Bybit symbols so an ignored time filter is visible.
  if (time < start || time >= end) throw new TradingExchangeError('资金费记录超出请求时间范围，当前结果不完整', 'window_range');
  if (exchange === 'bybit' && !SYMBOLS.includes(row.symbol)) return null;
  if (symbol !== undefined && row.symbol !== symbol) throw invalidData(binance ? undefined : 'symbol', row.symbol, 'unexpected');
  if (binance && row.incomeType !== 'FUNDING_FEE') throw invalidData();
  if (!binance && row.type !== 'SETTLEMENT') throw invalidData('type', row.type, 'unexpected');
  if (!binance && row.category !== 'linear') throw invalidData('category', row.category, 'unexpected');
  if ((binance ? row.asset : row.currency) !== 'USDT') throw new TradingExchangeError('原油资金费返回了非 USDT 币种，本次账本不完整', 'currency');
  const value = binance ? amount(row.income) : receiptField('funding', row.funding, bybitFundingAmount);
  const identifier = binance ? rowId(row.tranId) : receiptField('id', row.id, bybitReceiptId);
  // Ledger amounts already carry their cashflow sign: do not apply the current
  // position direction, funding rate, Bybit fee, cashFlow, or change fields.
  return { id: `${exchange}:${row.symbol}:${binance ? 'FUNDING_FEE:' : ''}${identifier}`, exchange, symbol: row.symbol, time: new Date(time).toISOString(), amount: value, currency: 'USDT' };
}

export function createTradingExchangeClient(exchange, { fetchImpl = fetch, now = Date.now, timeoutMs = 12_000, WebSocketImpl = globalThis.WebSocket, binanceClock, binanceStreams } = {}) {
  if (exchange === 'okx') return createOkxTradingClient({ fetchImpl, now, timeoutMs, ErrorClass: TradingExchangeError });
  if (!Object.hasOwn(ENDPOINTS, exchange)) throw new TradingExchangeError('不支持的交易所', 'exchange');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TradingExchangeError('交易所读取配置无效', 'configuration');
  const clock = () => timestamp(now());
  const signingClock = exchange === 'binance' ? binanceClock ?? createBinanceClock({ fetchImpl, now, timeoutMs }) : null;
  const streams = exchange === 'binance' ? binanceStreams ?? createBinanceStreams({ fetchImpl, WebSocketImpl, now, exchangeNow: signingClock.serverNow, ensureClock: options => signingClock.sync(options), timeoutMs, purpose: 'readonly' }) : null;
  const sessions = new Map(), permissionReads = new Map();
  const fetchedAt = () => new Date(clock()).toISOString();
  function modeOf(value) {
    const mode = value === undefined ? (exchange === 'binance' ? 'standard' : 'unified') : value;
    if (!(exchange === 'binance' ? ['standard', 'portfolio-margin'] : ['unified']).includes(mode)) throw new TradingExchangeError('交易所账户模式无效', 'account_mode');
    return mode;
  }
  function diagnosticFor(operation, accountMode, code, details = {}) {
    return normalizeTradingDiagnostic({ version: 1, exchange, operation, accountMode: accountMode ?? modeOf(), code, ...details });
  }
  function errorFor(operation, accountMode, code, details) {
    const diagnostic = diagnosticFor(operation, accountMode, code, details);
    return new TradingExchangeError(formatTradingDiagnostic(diagnostic), code, diagnostic);
  }
  function withDiagnostic(error, operation, accountMode) {
    if (error?.name === 'AbortError') return error;
    const diagnostic = normalizeTradingDiagnostic(error?.diagnostic);
    if (diagnostic && diagnostic.exchange === exchange && diagnostic.accountMode === accountMode) return error;
    if (error instanceof TradingExchangeError) {
      error.diagnostic = diagnosticFor(operation, accountMode, error.code, { field: error.field, valueType: error.valueType, reason: error.reason });
      if (error.diagnostic?.field) error.message = formatTradingDiagnostic(error.diagnostic);
      return error;
    }
    return errorFor(operation, accountMode, 'transport');
  }

  async function rawRequest(operation, credentials, parameters = {}, signal, budget, accountMode) {
    checkAbort(signal);
    if (!object(credentials) || typeof credentials.apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.apiKey) || typeof credentials.apiSecret !== 'string' || !credentials.apiSecret.trim() || credentials.apiSecret.length > 1024 || /[\r\n\0]/.test(credentials.apiSecret)) throw errorFor(operation, accountMode, 'credentials');
    if (budget && ++budget.requests > MAX_REQUESTS) throw errorFor(operation, accountMode, 'page_limit');
    const endpoint = exchange === 'binance' && accountMode === 'portfolio-margin'
      ? ({ positions: 'portfolioPositions', funding: 'portfolioFunding' }[operation] ?? operation) : operation;
    const [host, path] = ENDPOINTS[exchange][endpoint];
    function upstreamError(status, data) {
      const code = exchange === 'binance' ? data?.code : data?.retCode;
      return errorFor(operation, accountMode, status === undefined ? 'api' : 'http', { httpStatus: status, providerCode: code });
    }
    const params = new URLSearchParams(parameters);
    const time = String(signingClock ? signingClock.timestamp() : clock());
    const headers = {};
    let query;
    if (exchange === 'binance') {
      params.set('timestamp', time); params.set('recvWindow', '5000');
      query = params.toString();
      query += '&signature=' + createHmac('sha256', credentials.apiSecret).update(query).digest('hex');
      headers['X-MBX-APIKEY'] = credentials.apiKey;
    } else {
      query = params.toString();
      headers['X-BAPI-API-KEY'] = credentials.apiKey;
      headers['X-BAPI-TIMESTAMP'] = time;
      headers['X-BAPI-RECV-WINDOW'] = '5000';
      headers['X-BAPI-SIGN'] = createHmac('sha256', credentials.apiSecret).update(time + credentials.apiKey + '5000' + query).digest('hex');
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let interrupted;
    const abortPromise = new Promise((_resolve, reject) => {
      interrupted = () => reject(abortError());
      controller.signal.addEventListener('abort', interrupted, { once: true });
    });
    try {
      checkAbort(signal);
      // Bound the whole request, including streamed body reads, even when an
      // injected transport or response stream does not honour AbortSignal.
      const read = async () => {
      const response = await fetchImpl(host + path + (query ? '?' + query : ''), { method: 'GET', headers, redirect: 'error', signal: controller.signal, cache: 'no-store' });
      checkAbort(signal);
      if (controller.signal.aborted) throw abortError();
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw upstreamError(response.status);
      if (!response.ok) {
        let failure;
        try { failure = await limitedJson(response, controller.signal); }
        catch (error) {
          if (error?.name === 'AbortError' || error instanceof TradingExchangeError && error.code === 'response_limit') throw error;
          // Non-JSON error pages never become user-visible upstream text.
        }
        throw upstreamError(response.status, failure);
      }
      const data = await limitedJson(response, controller.signal);
      if (exchange === 'bybit') {
        if (!object(data) || data.retCode !== 0 || !object(data.result)) {
          throw upstreamError(undefined, data);
        }
        return data.result;
      }
      if (!object(data) && !Array.isArray(data)) throw invalidData();
      if (object(data) && Object.hasOwn(data, 'code')) {
        throw upstreamError(undefined, data);
      }
      return data;
      };
      return await Promise.race([read(), abortPromise]);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw errorFor(operation, accountMode, 'timeout');
      if (error instanceof TradingExchangeError) throw withDiagnostic(error, operation, accountMode ?? modeOf());
      // Never return upstream error text, response bodies, signed URLs, or keys.
      throw errorFor(operation, accountMode, 'transport');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', interrupted);
      controller.abort();
    }
  }

  async function request(operation, credentials, parameters = {}, signal, budget, accountMode) {
    try { return await rawRequest(operation, credentials, parameters, signal, budget, accountMode); }
    catch (error) {
      if (exchange !== 'binance' || error?.diagnostic?.providerCode !== -1021) throw error;
      // An explicit timestamp rejection is safe to retry exactly once. The
      // caller's existing deadline also bounds the public time read and retry.
      try { await signingClock.sync({ signal, force: true }); }
      catch (cause) { if (cause?.name === 'AbortError') throw cause; throw errorFor(operation, accountMode, 'timestamp', { providerCode: -1021 }); }
      return rawRequest(operation, credentials, parameters, signal, budget, accountMode);
    }
  }

  async function permissions(credentials, signal, budget, accountMode) {
    try {
      const info = exchange === 'binance' ? await sharedPermissionRead(credentials, signal, budget, accountMode) : await request('permissions', credentials, {}, signal, budget, accountMode);
      if (exchange === 'binance') {
        if (!object(info) || info.enableReading !== true || CORE_WRITE_PERMISSIONS.some(field => info[field] !== false) || OPTIONAL_WRITE_PERMISSIONS.some(field => Object.hasOwn(info, field) && info[field] !== false) || (Object.hasOwn(info, 'enableFixReadOnly') && typeof info.enableFixReadOnly !== 'boolean')) throw errorFor('permissions', accountMode, 'permissions');
      } else {
        if (info.readOnly !== 1) throw errorFor('permissions', accountMode, 'permissions');
        const account = await request('account', credentials, {}, signal, budget);
        if (![3, 4, 5, 6].includes(account.unifiedMarginStatus)) throw errorFor('account', accountMode, 'account_mode');
      }
    } catch (error) {
      if (exchange === 'binance' && error?.name !== 'AbortError') {
        const session = sessions.get(sessionKey(credentials, accountMode));
        if (session) suspend(session);
      }
      throw error;
    }
  }

  const watchedSymbols = new Set([...SYMBOLS, ...TRADING_HYNIX_SYMBOLS, ...TRADING_ANTHROPIC_SYMBOLS]);
  const sessionKey = (credentials, accountMode) => createHash('sha256').update(JSON.stringify([accountMode, credentials?.apiKey, credentials?.apiSecret])).digest('hex');
  async function sharedPermissionRead(credentials, signal, budget, accountMode) {
    checkAbort(signal);
    if (budget && ++budget.requests > MAX_REQUESTS) throw errorFor('permissions', accountMode, 'page_limit');
    const key = sessionKey(credentials, accountMode);
    let entry = permissionReads.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), waiters: 0, promise: null };
      const pending = entry;
      entry.promise = request('permissions', credentials, {}, entry.controller.signal, undefined, accountMode)
        .finally(() => { if (permissionReads.get(key) === pending) permissionReads.delete(key); });
      permissionReads.set(key, entry);
    }
    entry.waiters++;
    let abort;
    const interrupted = new Promise((_, reject) => { abort = () => reject(abortError()); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
    try { return await Promise.race([entry.promise, interrupted]); }
    finally {
      signal?.removeEventListener('abort', abort);
      if (--entry.waiters === 0 && permissionReads.get(key) === entry) { permissionReads.delete(key); entry.controller.abort(); }
    }
  }
  function notify(session, changedSymbols) {
    for (const listener of session.listeners) {
      if (changedSymbols && !listener.symbols.some(symbol => changedSymbols.has(symbol))) continue;
      const snapshots = listener.symbols.map(symbol => session.baselines.get(symbol));
      if (snapshots.some(value => !value)) continue;
      // fetchedAt remains the oldest REST risk observation. Account events do
      // not contain mark/liquidation prices and must never renew their age.
      const result = { fetchedAt: new Date(Math.min(...snapshots.map(value => Date.parse(value.fetchedAt)))).toISOString(),
        positions: snapshots.flatMap(value => [...value.rows.values()].map(row => ({ ...row }))) };
      try { listener.onSnapshot(result); } catch { /* A consumer cannot stop the private stream. */ }
    }
  }
  function suspend(session, reason = 'stream_reset') {
    session.subscription = null; session.epoch++; session.generation = null; session.baselines.clear(); session.events.clear();
    session.unsubscribe?.(); session.unsubscribe = null;
    streams.forget?.(session.credentials, { accountMode: session.accountMode });
    for (const listener of session.listeners) { try { listener.onReset?.(reason); } catch { /* Isolated consumer. */ } }
  }
  function invalidateRisk(row) {
    return { ...row, markPrice: null, notional: null, leverage: null, liquidationPrice: null, riskFetchedAt: null };
  }
  function receive(session, event) {
    if (sessions.get(session.key) !== session) return;
    if (session.generation === null) session.generation = event.generation;
    if (session.generation !== event.generation) return;
    const eventTime = timestamp(event.transactionTime ?? event.eventTime);
    const parsed = [], changedSymbols = new Set();
    const accountRiskChanged = event.balanceChanged === true || event.positions.some(row => !watchedSymbols.has(row?.s));
    for (const row of event.positions) {
      if (!watchedSymbols.has(row?.s)) continue;
      const position = normalizePosition('binance', { symbol: row.s, positionSide: row.ps, positionAmt: row.pa,
        entryPrice: row.ep, unRealizedProfit: row.up, marginAsset: 'USDT', updateTime: eventTime }, row.s, session.accountMode);
      const id = `binance:${row.s}:${row.ps}`, previous = session.events.get(id);
      if (previous && (previous.time > eventTime || previous.time === eventTime && JSON.stringify(previous.position) === JSON.stringify(position ? invalidateRisk(position) : null))) continue;
      parsed.push({ id, symbol: row.s, time: eventTime, position: position ? invalidateRisk(position) : null, sequence: ++session.sequence });
    }
    if (!parsed.length && !accountRiskChanged) return;
    if (accountRiskChanged) {
      // Collateral and other contracts can change cross/portfolio liquidation
      // risk without changing any watched quantity. Also invalidate REST reads
      // that were already in flight when this account event arrived.
      session.riskSequence++;
      for (const [symbol, snapshot] of session.baselines) {
        if (eventTime < snapshot.startedAt) continue;
        for (const [id, position] of snapshot.rows) {
          if (position.riskFetchedAt !== null) changedSymbols.add(symbol);
          snapshot.rows.set(id, invalidateRisk(position));
        }
      }
    }
    for (const update of parsed) {
      session.events.set(update.id, update);
      const baseline = session.baselines.get(update.symbol);
      if (!baseline) { session.riskSequence++; continue; }
      const previous = baseline.rows.get(update.id), previousTime = baseline.times.get(update.id) ?? baseline.startedAt;
      if (update.time < previousTime) continue;
      session.riskSequence++;
      changedSymbols.add(update.symbol);
      baseline.times.set(update.id, update.time);
      if (update.position) baseline.rows.set(update.id, update.position); else baseline.rows.delete(update.id);
      // A changed cross/portfolio position can change another leg's risk too.
      if (!previous || !update.position || previous.quantity !== update.position.quantity || previous.entryPrice !== update.position.entryPrice) {
        for (const [symbol, snapshot] of session.baselines) for (const [id, position] of snapshot.rows) {
          if (position.riskFetchedAt !== null) changedSymbols.add(symbol);
          snapshot.rows.set(id, invalidateRisk(position));
        }
      }
    }
    notify(session, changedSymbols);
  }
  async function prepareStream(session, signal) {
    if (!session.unsubscribe) {
      const subscription = {}; session.subscription = subscription;
      session.unsubscribe = streams.subscribePositions(session.credentials, { accountMode: session.accountMode,
        onEvent(event) { if (session.subscription !== subscription) return; try { receive(session, event); } catch { suspend(session, 'invalid_data'); } },
        onReset(event) {
          if (sessions.get(session.key) !== session || session.subscription !== subscription) return;
          session.epoch++; session.generation = event.generation; session.baselines.clear(); session.events.clear();
          for (const listener of session.listeners) { try { listener.onReset?.('stream_reset'); } catch { /* Isolated consumer. */ } }
        },
        onError() {
          if (session.subscription !== subscription) return;
          for (const listener of session.listeners) { try { listener.onReset?.('stream_error'); } catch { /* Isolated consumer. */ } }
        },
      });
    }
    const ready = await streams.ready(session.credentials, { accountMode: session.accountMode, signal });
    if (session.generation !== ready.generation) { session.epoch++; session.generation = ready.generation; session.baselines.clear(); session.events.clear(); }
  }
  function watchPositions(credentials, { accountMode: requestedMode, symbols = SYMBOLS, onSnapshot, onReset } = {}) {
    if (exchange !== 'binance' || !streams) return () => {};
    const accountMode = modeOf(requestedMode), key = sessionKey(credentials, accountMode);
    if (!Array.isArray(symbols) || !symbols.length || symbols.some(symbol => !watchedSymbols.has(symbol)) || typeof onSnapshot !== 'function') throw errorFor('positions', accountMode, 'configuration');
    let session = sessions.get(key);
    if (!session) {
      session = { key, credentials: { ...credentials }, accountMode, listeners: new Set(), baselines: new Map(), events: new Map(), generation: null, epoch: 0, sequence: 0, riskSequence: 0, requestSequence: 0, unsubscribe: null };
      sessions.set(key, session);
    }
    const listener = { symbols: [...symbols], onSnapshot, onReset };
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
      if (!session.listeners.size && sessions.get(key) === session) { sessions.delete(key); suspend(session); streams.forget?.(credentials, { accountMode }); }
    };
  }
  async function readPositions(credentials, signal, accountMode, symbols = SYMBOLS) {
    const session = exchange === 'binance' ? sessions.get(sessionKey(credentials, accountMode)) : null;
    if (!session) return readRestPositions(credentials, signal, accountMode, symbols);
    let connected = false;
    try { await prepareStream(session, signal); connected = true; }
    catch (error) {
      checkAbort(signal);
      // Clock/ready checks may fail while the old socket still emits. A REST
      // fallback cannot leave that socket's earlier baseline publishable.
      session.epoch++; session.baselines.clear(); session.events.clear();
    }
    const epoch = session.epoch, startedAt = signingClock.serverNow(), sequence = session.sequence, riskSequence = session.riskSequence, requestSequence = ++session.requestSequence;
    const result = await readRestPositions(credentials, signal, accountMode, symbols);
    if (sessions.get(session.key) !== session || session.epoch !== epoch || !connected) return result;
    for (const symbol of symbols) {
      if ((session.baselines.get(symbol)?.requestSequence ?? 0) > requestSequence) continue;
      const rows = new Map(result.positions.filter(row => row.symbol === symbol).map(row => [row.id, { ...row, riskFetchedAt: result.fetchedAt }]));
      // A different cross/portfolio leg may change while this multi-symbol
      // REST batch is pending. Its earlier risk reads are no longer current.
      if (session.riskSequence !== riskSequence) for (const [id, row] of rows) rows.set(id, invalidateRisk(row));
      const times = new Map([...rows].map(([id, row]) => [id, Date.parse(row.sourceUpdatedAt) || 0]));
      for (const update of session.events.values()) {
        if (update.symbol !== symbol) continue;
        const previousTime = times.get(update.id), observed = rows.get(update.id);
        // updateTime need not advance for a balance/PnL-only account event.
        // A later REST observation of the same amount and entry proves the
        // position is reflected and can restore its separately-read risk.
        if (update.sequence <= sequence && observed && update.position && observed.quantity === update.position.quantity && observed.entryPrice === update.position.entryPrice) {
          times.set(update.id, Math.max(previousTime ?? 0, update.time));
          continue;
        }
        if (previousTime !== undefined ? update.time < previousTime || update.time === previousTime && update.sequence <= sequence : update.sequence <= sequence && update.time < startedAt) continue;
        times.set(update.id, update.time);
        if (update.position) rows.set(update.id, update.position); else rows.delete(update.id);
      }
      session.baselines.set(symbol, { rows, times, fetchedAt: result.fetchedAt, startedAt, requestSequence });
    }
    notify(session, new Set(symbols));
    return { fetchedAt: result.fetchedAt, positions: symbols.flatMap(symbol => [...session.baselines.get(symbol).rows.values()].map(row => ({ ...row }))) };
  }

  async function readRestPositions(credentials, signal, accountMode, symbols = SYMBOLS) {
    const positions = [], ids = new Set(), modes = new Map();
    for (const symbol of symbols) {
      let cursor = '';
      const cursors = new Set();
      let pages = 0;
      do {
        if (++pages > 20) throw new TradingExchangeError('仓位分页超过支持范围', 'page_limit');
        const params = exchange === 'binance' ? { symbol } : { category: 'linear', symbol, limit: '200', ...(cursor ? { cursor } : {}) };
        const data = await request('positions', credentials, params, signal, undefined, accountMode);
        const rows = exchange === 'binance' ? data : requireList(data, 200, true);
        if (!Array.isArray(rows) || rows.length > 200) throw invalidData();
        for (const row of rows) {
          const position = normalizePosition(exchange, row, symbol, accountMode);
          if (!position) continue;
          if (ids.has(position.id)) throw new TradingExchangeError('交易所仓位返回重复记录，无法确认持仓', 'duplicate');
          if (modes.has(symbol) && modes.get(symbol) !== position.mode) throw new TradingExchangeError('交易所仓位模式存在冲突，无法确认持仓', 'invalid_data');
          modes.set(symbol, position.mode);
          ids.add(position.id); positions.push(position);
        }
        cursor = exchange === 'bybit' ? cursorOf(data) : '';
        if (cursor) {
          if (cursors.has(cursor) || rows.length === 0) throw new TradingExchangeError('交易所仓位分页未取得进展', 'pagination');
          cursors.add(cursor);
        }
      } while (cursor);
    }
    checkAbort(signal);
    return { fetchedAt: fetchedAt(), positions };
  }

  async function verify(credentials, { signal, accountMode: requestedMode } = {}) {
    const accountMode = modeOf(requestedMode);
    await permissions(credentials, signal, undefined, accountMode);
    let result;
    try { result = await readPositions(credentials, signal, accountMode); }
    catch (error) { throw withDiagnostic(error, 'positions', accountMode); }
    const end = clock(), start = end - DAY;
    try {
      if (exchange === 'binance') {
        for (const symbol of SYMBOLS) {
          const rows = await request('funding', credentials, { symbol, incomeType: 'FUNDING_FEE', startTime: String(start), endTime: String(end - 1), page: '1', limit: '1' }, signal, undefined, accountMode);
          if (!Array.isArray(rows) || rows.length > 1) throw invalidData();
          for (const row of rows) normalizeReceipt(exchange, row, { symbol, start, end });
        }
      } else {
        for (const symbol of SYMBOLS) {
          const data = await request('funding', credentials, { accountType: 'UNIFIED', category: 'linear', baseCoin: BYBIT_BASE_COINS[symbol], currency: 'USDT', type: 'SETTLEMENT', startTime: String(start), endTime: String(end - 1), limit: '1' }, signal, undefined, accountMode);
          for (const row of fundingList(data, 1)) normalizeReceipt(exchange, row, { symbol, start, end });
        }
      }
    } catch (error) { throw withDiagnostic(error, 'funding', accountMode); }
    checkAbort(signal);
    return result;
  }

  async function positions(credentials, { signal, accountMode: requestedMode } = {}) {
    const accountMode = modeOf(requestedMode);
    await permissions(credentials, signal, undefined, accountMode);
    try { return await readPositions(credentials, signal, accountMode); }
    catch (error) { throw withDiagnostic(error, 'positions', accountMode); }
  }

  async function hynixPositions(credentials, { signal, accountMode: requestedMode } = {}) {
    const accountMode = modeOf(requestedMode);
    await permissions(credentials, signal, undefined, accountMode);
    try { return await readPositions(credentials, signal, accountMode, TRADING_HYNIX_SYMBOLS); }
    catch (error) { throw withDiagnostic(error, 'positions', accountMode); }
  }

  // Bybit lists no Anthropic contract; only Binance reads it.
  async function anthropicPositions(credentials, { signal, accountMode: requestedMode } = {}) {
    if (exchange !== 'binance') throw new TradingExchangeError('该交易所没有 Anthropic 合约', 'input');
    const accountMode = modeOf(requestedMode);
    await permissions(credentials, signal, undefined, accountMode);
    try { return await readPositions(credentials, signal, accountMode, TRADING_ANTHROPIC_SYMBOLS); }
    catch (error) { throw withDiagnostic(error, 'positions', accountMode); }
  }

  async function funding(credentials, { start, end, signal, accountMode: requestedMode, onProgress } = {}) {
    const accountMode = modeOf(requestedMode);
    checkAbort(signal);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 30 * DAY || end > clock() + 1000 || start < clock() - 31 * DAY) throw errorFor('funding', accountMode, 'range');
    const receipts = new Map(), coverage = [], budget = { requests: 0 };
    function collect(row, symbol, windowStart, windowEnd) {
      const receipt = normalizeReceipt(exchange, row, { symbol, start: windowStart, end: windowEnd });
      if (!receipt) return;
      const previous = receipts.get(receipt.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw new TradingExchangeError('资金费账本出现冲突记录，当前结果不完整', 'duplicate_conflict');
      if (!previous && receipts.size >= MAX_FUNDING_EVENTS) throw new TradingExchangeError('资金费记录达到读取上限，当前结果不完整', 'record_limit');
      receipts.set(receipt.id, receipt);
    }
    function snapshot(complete, diagnostic = null) {
      return { fetchedAt: fetchedAt(), events: [...receipts.values()].map(row => ({ ...row })).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)),
        coverage: coverage.map(window => ({ ...window })), complete, error: formatTradingDiagnostic(diagnostic), diagnostic };
    }
    let diagnostic = null;
    try {
      await permissions(credentials, signal, budget, accountMode);
      for (let windowStart = start; windowStart < end; windowStart += 7 * DAY) {
        const windowEnd = Math.min(windowStart + 7 * DAY, end);
        const timeParams = { startTime: String(windowStart), endTime: String(windowEnd - 1) };
        if (exchange === 'binance') {
          for (const symbol of SYMBOLS) {
            const pages = new Set();
            for (let page = 1; ; page++) {
              const rows = await request('funding', credentials, { symbol, incomeType: 'FUNDING_FEE', ...timeParams, page: String(page), limit: '1000' }, signal, budget, accountMode);
              if (!Array.isArray(rows) || rows.length > 1000) throw invalidData();
              const fingerprint = JSON.stringify(rows);
              if (rows.length && pages.has(fingerprint)) throw new TradingExchangeError('资金费分页未取得进展，当前结果不完整', 'pagination');
              if (rows.length) pages.add(fingerprint);
              for (const row of rows) collect(row, symbol, windowStart, windowEnd);
              if (rows.length < 1000) break;
            }
          }
        } else {
          for (const symbol of SYMBOLS) {
            let cursor = '';
            const cursors = new Set(), pages = new Set();
            do {
              const data = await request('funding', credentials, { accountType: 'UNIFIED', category: 'linear', baseCoin: BYBIT_BASE_COINS[symbol], currency: 'USDT', type: 'SETTLEMENT', ...timeParams, limit: '50', ...(cursor ? { cursor } : {}) }, signal, budget, accountMode);
              const rows = fundingList(data, 50);
              const fingerprint = JSON.stringify(rows);
              if (rows.length && pages.has(fingerprint)) throw new TradingExchangeError('资金费分页未取得进展，当前结果不完整', 'pagination');
              if (rows.length) pages.add(fingerprint);
              for (const row of rows) collect(row, symbol, windowStart, windowEnd);
              cursor = cursorOf(data, true);
              if (cursor) {
                if (cursors.has(cursor) || rows.length === 0) throw new TradingExchangeError('资金费分页未取得进展，当前结果不完整', 'pagination');
                cursors.add(cursor);
              }
            } while (cursor);
          }
        }
        coverage.push({ start: windowStart, end: windowEnd });
        checkAbort(signal);
        if (onProgress) { await onProgress(snapshot(false)); checkAbort(signal); }
      }
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw abortError();
      diagnostic = normalizeTradingDiagnostic(withDiagnostic(cause, 'funding', accountMode).diagnostic) ?? diagnosticFor('funding', accountMode, 'upstream');
    }
    checkAbort(signal);
    return snapshot(diagnostic === null, diagnostic);
  }

  function close() {
    for (const pending of permissionReads.values()) pending.controller.abort(); permissionReads.clear();
    for (const session of sessions.values()) { session.listeners.clear(); suspend(session); }
    sessions.clear(); streams?.close?.(); signingClock?.forget();
  }
  return Object.freeze({ verify, positions, hynixPositions, anthropicPositions, funding, ...(exchange === 'binance' ? { watchPositions, close } : {}) });
}
