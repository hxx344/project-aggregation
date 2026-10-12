// Official public account ratios, sampled on demand by the caller. No timers,
// global scans, top-trader substitutions, or synthetic position-size estimates.
// Binance: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio
// Bybit: https://bybit-exchange.github.io/docs/v5/market/long-short-ratio
// OKX: https://www.okx.com/docs-v5/en/#trading-statistics-rest-api-get-contract-long-short-ratio
// Bitget: https://www.bitget.com/zh-CN/api-doc/common/apidata/Long-Short
// Gate: https://www.gate.com/docs/developers/apiv4/zh_CN/futures/#listfuturescontractstats

const SCOPE = '合约全体持仓账户（5 分钟）';
const MAX_FUTURE_MS = 5_000;

function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function shares(longValue, shortValue) {
  const long = number(longValue), short = number(shortValue);
  if (long === null || short === null || long < 0 || long > 1 || short < 0 || short > 1) return null;
  const total = long + short;
  // Both fields are fractions, not percentages. Only absorb published rounding.
  if (!total || Math.abs(total - 1) > 0.001) return null;
  return { longRatio: long / total, shortRatio: short / total };
}

function ratio(value) {
  const result = number(value);
  if (result === null || result < 0) return null;
  const shortRatio = 1 / (1 + result);
  return { longRatio: 1 - shortRatio, shortRatio };
}

function gateShares(row) {
  // Counts make an empty market distinguishable from a genuinely zero long side.
  if (row.long_users !== undefined || row.short_users !== undefined) {
    const long = number(row.long_users), short = number(row.short_users);
    if (!Number.isSafeInteger(long) || !Number.isSafeInteger(short) || long < 0 || short < 0) return null;
    const total = long + short;
    if (!Number.isSafeInteger(total) || total <= 0) return null;
    return { longRatio: long / total, shortRatio: short / total };
  }
  return ratio(row.lsr_account);
}

function sourceFor(quote) {
  const { exchange, symbol, quoteCurrency } = quote ?? {};
  // DEX symbols can legitimately use another format (for example io:SNDK).
  // Do not report a CEX symbol-validation error for a venue we have not connected.
  if (['hyperliquid', 'lighter', 'rh-lighter', 'aster', 'entropy'].includes(exchange)) {
    return { source: null, reason: '当前未接入该 DEX 的官方多空账户比' };
  }
  if (typeof symbol !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(symbol)) {
    return { source: null, reason: '合约代码格式无效，无法查询官方多空账户比' };
  }
  let path, params;
  switch (exchange) {
    case 'binance':
      path = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio';
      params = { symbol, period: '5m', limit: '1' };
      break;
    case 'bybit':
      // The documented linear account-ratio series covers USDT contracts.
      if (quoteCurrency !== 'USDT') return { source: null, reason: 'Bybit 当前仅接入 USDT 合约的官方多空账户比，该合约的计价类别不支持' };
      path = 'https://api.bybit.com/v5/market/account-ratio';
      params = { category: 'linear', symbol, period: '5min', limit: '1' };
      break;
    case 'okx':
      // instId scopes the series to this contract. The older ccy endpoint combines
      // perpetual and expiry contracts and must not silently replace this series.
      path = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract';
      params = { instId: symbol, period: '5m', limit: '1' };
      break;
    case 'bitget':
      if (quoteCurrency !== 'USDT') return { source: null, reason: 'Bitget 当前仅接入 USDT 合约的官方多空账户比，该合约的计价类别不支持' };
      path = 'https://api.bitget.com/api/v2/mix/market/long-short';
      params = { symbol, period: '5m' };
      break;
    case 'gate':
      if (quoteCurrency !== 'USDT' || !symbol.endsWith('_USDT')) return { source: null, reason: 'Gate 当前仅接入 USDT 结算且代码以 _USDT 结尾的合约多空账户比' };
      path = 'https://api.gateio.ws/api/v4/futures/usdt/contract_stats';
      params = { contract: symbol, interval: '5m', limit: '1' };
      break;
    default: return { source: null, reason: '当前未接入该平台的官方多空账户比' };
  }
  return { source: `${path}?${new URLSearchParams(params)}`, reason: null };
}

/** Availability and collection share one routing decision; null means a public request is supported. */
export function positioningUnavailableReason(quote) {
  return sourceFor(quote).reason;
}

function upstreamError(exchange, message, status, code) {
  const error = new Error(`${exchange} 多空账户数据：${message}`);
  error.status = status;
  if (code !== undefined) error.code = code;
  return error;
}

function apiError(exchange, body) {
  if (exchange === 'bybit' && body?.retCode !== undefined && String(body.retCode) !== '0') {
    return upstreamError(exchange, String(body.retMsg || '上游返回错误'), ['10006', '10429'].includes(String(body.retCode)) ? 429 : 502, body.retCode);
  }
  if (exchange === 'okx' && body?.code !== undefined && String(body.code) !== '0') {
    return upstreamError(exchange, String(body.msg || '上游返回错误'), String(body.code) === '50011' ? 429 : 502, body.code);
  }
  if (exchange === 'bitget' && body?.code !== undefined && String(body.code) !== '00000') {
    return upstreamError(exchange, String(body.msg || '上游返回错误'), String(body.code) === '429' ? 429 : 502, body.code);
  }
  if (exchange === 'binance' && body?.code !== undefined && Number(body.code) < 0) {
    return upstreamError(exchange, String(body.msg || '上游返回错误'), Number(body.code) === -1003 ? 429 : 502, body.code);
  }
  return null;
}

function timestamp(value, seconds, now) {
  const result = number(value);
  if (result === null) return null;
  const ms = seconds ? result * 1_000 : result;
  // Every supported venue launched after 2001. Reject wrong units instead of
  // guessing seconds/milliseconds or substituting HTTP receipt time.
  return Number.isSafeInteger(ms) && ms >= 1e12 && ms < 1e13 && ms <= now + MAX_FUTURE_MS ? ms : null;
}

/** One public request at most. The caller owns queueing, cache, and staleness. */
export async function fetchPositioning(quote, { fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const { source, reason } = sourceFor(quote);
  if (reason) return null;
  const deadline = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(source, { signal: requestSignal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const error = upstreamError(quote.exchange, `HTTP ${response.status}`, response.status);
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
      const seconds = number(retryAfter);
      const delay = seconds === null ? Date.parse(retryAfter) - now : seconds * 1_000;
      if (Number.isFinite(delay) && delay >= 0) error.retryAfterMs = delay;
    }
    throw error;
  }
  let body;
  try { body = await response.json(); }
  catch { throw upstreamError(quote.exchange, '响应不是有效 JSON', 502); }
  const error = apiError(quote.exchange, body);
  if (error) throw error;
  const rows = quote.exchange === 'bybit' ? body?.result?.list
    : ['okx', 'bitget'].includes(quote.exchange) ? body?.data : body;
  if (rows === null || rows === undefined) return null;
  if (!Array.isArray(rows)) throw upstreamError(quote.exchange, '响应数据格式不正确', 502);
  let latest = null, observedAt = -Infinity;
  for (const row of rows) {
    if (!row || (row.symbol !== undefined && row.symbol !== quote.symbol)) continue;
    const rawTime = quote.exchange === 'okx' ? row[0] : quote.exchange === 'gate' ? row.time : quote.exchange === 'bitget' ? row.ts : row.timestamp;
    const time = timestamp(rawTime, quote.exchange === 'gate', now);
    if (time !== null && time > observedAt) { latest = row; observedAt = time; }
  }
  if (!latest) return null;
  let values;
  switch (quote.exchange) {
    case 'binance': values = shares(latest.longAccount, latest.shortAccount); break;
    case 'bybit': values = shares(latest.buyRatio, latest.sellRatio); break;
    case 'okx': values = ratio(latest[1]); break;
    case 'bitget': values = shares(latest.longRatio, latest.shortRatio); break;
    case 'gate': values = gateShares(latest); break;
  }
  return values ? { exchange: quote.exchange, symbol: quote.symbol, ...values, kind: 'accounts', scope: SCOPE, source, observedAt } : null;
}
