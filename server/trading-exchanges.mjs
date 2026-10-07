import { createHmac } from 'node:crypto';
import { decimal, negateDecimal, compareDecimals } from './trading-decimal.mjs';
import { normalizeTradingDiagnostic, formatTradingDiagnostic } from './trading-diagnostics.mjs';

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

const invalidData = () => new TradingExchangeError('交易所返回的数据不完整或格式无效', 'invalid_data');
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
function cursorOf(data) {
  if (data.nextPageCursor === undefined) return '';
  if (typeof data.nextPageCursor !== 'string' || data.nextPageCursor.length > 2000 || /[\r\n\0]/.test(data.nextPageCursor)) throw invalidData();
  return data.nextPageCursor;
}
function requireList(data, limit, category = false) {
  if (!object(data) || !Array.isArray(data.list) || data.list.length > limit || (category && data.category !== 'linear')) throw invalidData();
  return data.list;
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
    // PAPI UM omits marginAsset. Its fixed CLUSDT/BZUSDT requests identify the
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
  if (!object(row)) throw invalidData();
  if (typeof row.symbol !== 'string' || !/^[A-Z0-9_-]{1,80}$/.test(row.symbol)) throw invalidData();
  const binance = exchange === 'binance';
  const time = timestamp(binance ? row.time : row.transactionTime);
  // Requests use inclusive endTime=end-1. A record at end belongs to the next
  // window; records from adjacent windows cannot prove this window complete.
  // Validate even filtered Bybit symbols so an ignored time filter is visible.
  if (time < start || time >= end) throw new TradingExchangeError('资金费记录超出请求时间范围，当前结果不完整', 'window_range');
  if (exchange === 'bybit' && !SYMBOLS.includes(row.symbol)) return null;
  if (symbol !== undefined && row.symbol !== symbol) throw invalidData();
  if ((binance && row.incomeType !== 'FUNDING_FEE') || (!binance && (row.type !== 'SETTLEMENT' || row.category !== 'linear'))) throw invalidData();
  if ((binance ? row.asset : row.currency) !== 'USDT') throw new TradingExchangeError('原油资金费返回了非 USDT 币种，本次账本不完整', 'currency');
  const value = amount(binance ? row.income : row.funding);
  const identifier = rowId(binance ? row.tranId : row.id);
  // Ledger amounts already carry their cashflow sign: do not apply the current
  // position direction, funding rate, Bybit fee, cashFlow, or change fields.
  return { id: `${exchange}:${row.symbol}:${binance ? 'FUNDING_FEE:' : ''}${identifier}`, exchange, symbol: row.symbol, time: new Date(time).toISOString(), amount: value, currency: 'USDT' };
}

export function createTradingExchangeClient(exchange, { fetchImpl = fetch, now = Date.now, timeoutMs = 12_000 } = {}) {
  if (!Object.hasOwn(ENDPOINTS, exchange)) throw new TradingExchangeError('不支持的交易所', 'exchange');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TradingExchangeError('交易所读取配置无效', 'configuration');
  const clock = () => timestamp(now());
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
      error.diagnostic = diagnosticFor(operation, accountMode, error.code);
      return error;
    }
    return errorFor(operation, accountMode, 'transport');
  }

  async function request(operation, credentials, parameters = {}, signal, budget, accountMode) {
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
    const time = String(clock());
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

  async function permissions(credentials, signal, budget, accountMode) {
    const info = await request('permissions', credentials, {}, signal, budget, accountMode);
    if (exchange === 'binance') {
      if (!object(info) || info.enableReading !== true || CORE_WRITE_PERMISSIONS.some(field => info[field] !== false) || OPTIONAL_WRITE_PERMISSIONS.some(field => Object.hasOwn(info, field) && info[field] !== false) || (Object.hasOwn(info, 'enableFixReadOnly') && typeof info.enableFixReadOnly !== 'boolean')) throw errorFor('permissions', accountMode, 'permissions');
    } else {
      if (info.readOnly !== 1) throw errorFor('permissions', accountMode, 'permissions');
      const account = await request('account', credentials, {}, signal, budget);
      if (![3, 4, 5, 6].includes(account.unifiedMarginStatus)) throw errorFor('account', accountMode, 'account_mode');
    }
  }

  async function readPositions(credentials, signal, accountMode) {
    const positions = [], ids = new Set(), modes = new Map();
    for (const symbol of SYMBOLS) {
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
          for (const row of requireList(data, 1)) normalizeReceipt(exchange, row, { symbol, start, end });
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
              const rows = requireList(data, 50);
              const fingerprint = JSON.stringify(rows);
              if (rows.length && pages.has(fingerprint)) throw new TradingExchangeError('资金费分页未取得进展，当前结果不完整', 'pagination');
              if (rows.length) pages.add(fingerprint);
              for (const row of rows) collect(row, symbol, windowStart, windowEnd);
              cursor = cursorOf(data);
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

  return Object.freeze({ verify, positions, funding });
}
