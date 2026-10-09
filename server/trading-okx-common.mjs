import { createHmac } from 'node:crypto';
import { decimal, compareDecimals, negateDecimal } from './trading-decimal.mjs';

// OKX v5 protocol, checked against official documentation and public oil
// instruments on 2026-10-09. Private requests are restricted to this allowlist.
// https://www.okx.com/docs-v5/en/#overview-rest-authentication
// https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
export const OKX_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
const INSTRUMENTS = Object.freeze({ CLUSDT: 'CL-USDT-SWAP', BZUSDT: 'BZ-USDT-SWAP' });
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SCALE = 10n ** 18n;
const ROUTES = Object.freeze({
  config: ['/api/v5/account/config', 'GET', true],
  positions: ['/api/v5/account/positions', 'GET', true],
  bills: ['/api/v5/account/bills-archive', 'GET', true],
  orders: ['/api/v5/trade/orders-pending', 'GET', true],
  algos: ['/api/v5/trade/orders-algo-pending', 'GET', true],
  create: ['/api/v5/trade/order', 'POST', true],
  amend: ['/api/v5/trade/amend-order', 'POST', true],
  inspect: ['/api/v5/trade/order', 'GET', true],
  stop: ['/api/v5/trade/cancel-order', 'POST', true],
  rules: ['/api/v5/public/instruments', 'GET', false],
  book: ['/api/v5/market/books', 'GET', false],
  time: ['/api/v5/public/time', 'GET', false],
});
const MESSAGES = Object.freeze({
  input: 'OKX 交易参数无效', configuration: 'OKX 接口配置无效', credentials: 'OKX Key、Secret 或 Passphrase 无效',
  permissions: 'OKX API 密钥权限不符合要求', account_mode: 'OKX 账户、持仓或保证金模式无法确认',
  invalid_data: 'OKX 响应不完整或格式无效', response_limit: 'OKX 响应超过大小限制',
  pagination: 'OKX 分页未取得进展，当前结果不完整', page_limit: 'OKX 读取达到请求上限，当前结果不完整',
  record_limit: 'OKX 资金费记录达到读取上限', duplicate: 'OKX 返回了重复仓位',
  duplicate_conflict: 'OKX 资金费账本出现冲突记录', window_range: 'OKX 资金费记录超出请求时间范围',
  currency: 'OKX 原油资金费返回了非 USDT 币种', range: '资金费读取仅支持最近 30 天内的有效时间范围',
  timeout: 'OKX 请求超时', transport: 'OKX 连接失败', aborted: 'OKX 请求已中断',
  upstream: 'OKX 请求失败', rejected: 'OKX 拒绝了请求', timestamp: 'OKX 拒绝了请求时间',
  clock: 'OKX 时钟偏差超出支持范围', not_found: 'OKX 尚未查到目标订单',
  not_tradable: 'OKX 合约或盘口当前不支持所需的限价交易', external_orders: 'OKX 原油合约存在外部策略委托',
});

export class OkxProtocolError extends Error {
  constructor(code = 'invalid_data', details = {}) {
    super(MESSAGES[code] ?? MESSAGES.upstream);
    this.code = code;
    this.uncertain = details.uncertain === true;
    if (details.notFound) this.notFound = true;
    if (Number.isSafeInteger(details.providerCode)) this.providerCode = details.providerCode;
    if (Number.isInteger(details.httpStatus)) this.httpStatus = details.httpStatus;
  }
}
export function fail(code = 'invalid_data', details) { throw new OkxProtocolError(code, details); }
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function requireObject(value) { if (!object(value)) fail(); return value; }
export function list(value, limit = 100) { if (!Array.isArray(value) || value.length > limit) fail(); return value; }
export function one(value) { const rows = list(value, 1); if (rows.length !== 1) fail(); return requireObject(rows[0]); }
export function checkAbort(signal) { if (signal?.aborted) fail('aborted'); }
export function amount(value, options = {}) {
  try { if (typeof value !== 'string') fail(); return decimal(value, options); } catch { fail(); }
}
export function optionalAmount(value, options = {}) { return value === '' || value === null || value === undefined ? null : amount(value, options); }
export function optionalPrice(value) { const result = optionalAmount(value, { nonnegative: true }); return result === '0' ? null : result; }
export function absolute(value) { return compareDecimals(value, '0') < 0 ? negateDecimal(value) : value; }
export function id(value) { if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) fail(); return value; }
export function milliseconds(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail();
  return value;
}
export function iso(value, optional = false) {
  return optional && (value === '' || value === undefined || value === null || value === '0') ? null : new Date(milliseconds(value)).toISOString();
}
export function instrumentId(symbol) { if (!Object.hasOwn(INSTRUMENTS, symbol)) fail('input'); return INSTRUMENTS[symbol]; }
export function symbolOf(instId) { return OKX_SYMBOLS.find(symbol => INSTRUMENTS[symbol] === instId) ?? null; }
function units(value) {
  const text = decimal(value), negative = text.startsWith('-');
  const [integer, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const result = BigInt(integer) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -result : result;
}
export function multiply(...values) {
  let result = SCALE;
  for (const value of values) {
    const product = result * units(value);
    // Oil contract quantities and ticks are exactly representable. Reject a
    // future unsupported precision instead of silently rounding financial data.
    if (product % SCALE !== 0n) fail();
    result = product / SCALE;
  }
  const sign = result < 0n ? '-' : '', magnitude = result < 0n ? -result : result;
  const fraction = String(magnitude % SCALE).padStart(18, '0').replace(/0+$/, '');
  return amount(sign + String(magnitude / SCALE) + (fraction ? '.' + fraction : ''));
}
export function multiple(value, step) { return units(step) > 0n && units(value) % units(step) === 0n; }

export function validateConfig(row, { execution = false } = {}) {
  requireObject(row);
  if (typeof row.perm !== 'string') fail('permissions');
  const permissions = row.perm.split(',');
  const allowed = execution ? ['read_only', 'trade'] : ['read_only'];
  if (permissions.length !== allowed.length || new Set(permissions).size !== allowed.length
    || allowed.some(value => !permissions.includes(value))) fail('permissions');
  if (!(execution ? ['2', '3'] : ['2', '3', '4']).includes(row.acctLv)
    || !['net_mode', 'long_short_mode'].includes(row.posMode)
    || row.acctLv === '4' && row.posMode !== 'net_mode') fail('account_mode');
  return { identity: id(row.uid), positionMode: row.posMode === 'net_mode' ? 'one-way' : 'hedge' };
}

export function positionSize(row, symbol, mode) {
  requireObject(row);
  if (row.instId !== instrumentId(symbol) || row.instType !== 'SWAP' || !['cross', 'isolated'].includes(row.mgnMode)
    || !['net', 'long', 'short'].includes(row.posSide) || (row.posSide === 'net') !== (mode === 'one-way')) fail('account_mode');
  const signed = amount(row.pos);
  if (row.posSide !== 'net' && compareDecimals(signed, '0') < 0) fail();
  const quantity = absolute(signed);
  if (quantity === '0') return null;
  // Some unified/cross responses omit margin currency. The fixed oil instId
  // identifies a USDT contract; the instrument rule independently requires
  // settleCcy=USDT. An explicit conflicting currency is never accepted.
  if (row.ccy !== undefined && row.ccy !== '' && row.ccy !== 'USDT') fail();
  return { quantity, side: row.posSide === 'short' || row.posSide === 'net' && compareDecimals(signed, '0') < 0 ? 'short' : 'long' };
}

async function readJson(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('response_limit');
  if (!response.body?.getReader) fail();
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      checkAbort(signal);
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) fail('response_limit');
      chunks.push(Buffer.from(chunk.value));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail(); }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function providerFailure(raw, httpStatus, mutation) {
  const providerCode = typeof raw === 'string' && /^\d{1,8}$/.test(raw) ? Number(raw) : undefined;
  if (httpStatus < 500 && providerCode === 50102) return new OkxProtocolError('timestamp', { providerCode, httpStatus });
  if (httpStatus < 500 && providerCode === 51603) return new OkxProtocolError('not_found', { providerCode, httpStatus, notFound: true, uncertain: mutation });
  // Unknown, duplicate-id and timeout errors do not prove non-execution. Never
  // infer safety from a range of provider codes, or retry ambiguous mutations.
  const rejected = [50011, 50101, 50103, 50104, 50105, 50106, 50107, 50108, 50109, 50110, 50111, 50113, 50114,
    51000, 51001, 51004, 51005, 51006, 51007, 51008, 51010, 51020, 51120, 51121, 51122, 51131].includes(providerCode);
  return new OkxProtocolError(rejected && httpStatus < 500 ? 'rejected' : 'upstream', {
    providerCode, httpStatus, uncertain: mutation && (httpStatus >= 500 || !rejected),
  });
}
function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new OkxProtocolError('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createOkxProtocol({ fetchImpl = fetch, now = Date.now, timeoutMs = 12_000, waitImpl = delay } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof waitImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('configuration');
  let offset = 0, fundingQueue = Promise.resolve(), previousFunding = false;
  const ruleCache = new Map();
  function clock() { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) fail('configuration'); return value + offset; }
  function credentialsValid(credentials) {
    if (!object(credentials) || typeof credentials.apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.apiKey)
      || typeof credentials.apiSecret !== 'string' || !credentials.apiSecret.trim() || credentials.apiSecret.length > 1024 || /[\r\n\0]/.test(credentials.apiSecret)
      || typeof credentials.passphrase !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(credentials.passphrase)) fail('credentials');
  }
  async function rawRequest(operation, credentials, parameters, { signal, beforeMutation } = {}) {
    checkAbort(signal);
    if (!Object.hasOwn(ROUTES, operation)) fail('configuration');
    const [path, method, authenticated] = ROUTES[operation], mutation = method !== 'GET';
    if (authenticated) credentialsValid(credentials);
    const query = method === 'GET' ? new URLSearchParams(parameters).toString() : '';
    const body = mutation ? JSON.stringify(parameters) : undefined;
    const requestPath = path + (query ? '?' + query : ''), headers = {};
    if (mutation) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      const timestamp = new Date(clock()).toISOString();
      headers['OK-ACCESS-KEY'] = credentials.apiKey;
      headers['OK-ACCESS-PASSPHRASE'] = credentials.passphrase;
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-SIGN'] = createHmac('sha256', credentials.apiSecret).update(timestamp + method + requestPath + (body ?? '')).digest('base64');
    }
    // A caller's lease guard remains outside transport wrapping, and is run
    // again for the sole permitted retry after an explicit timestamp rejection.
    if (mutation) beforeMutation?.();
    const controller = new AbortController();
    let timedOut = false, dispatched = false, interruptedListener;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const interrupted = new Promise((_resolve, reject) => {
      interruptedListener = () => reject(new OkxProtocolError(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched }));
      controller.signal.addEventListener('abort', interruptedListener, { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      checkAbort(signal);
      const run = async () => {
        dispatched = true;
        const response = await fetchImpl('https://www.okx.com' + requestPath, {
          method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal, redirect: 'error', cache: 'no-store',
        });
        checkAbort(controller.signal);
        if (!response || response.redirected || response.status >= 300 && response.status < 400) fail('upstream', { uncertain: mutation });
        const data = await readJson(response, controller.signal);
        checkAbort(controller.signal);
        if (!response.ok) throw providerFailure(data?.code, response.status, mutation);
        if (!object(data) || typeof data.code !== 'string') fail();
        if (data.code !== '0') {
          // A single-order failure can put its actionable rejection in sCode
          // under top-level code=1. An inconsistent success remains unknown.
          if (mutation && data.code === '1' && Array.isArray(data.data) && data.data.length === 1
            && object(data.data[0]) && typeof data.data[0].sCode === 'string' && data.data[0].sCode !== '0') {
            throw providerFailure(data.data[0].sCode, response.status, true);
          }
          throw providerFailure(data.code, response.status, mutation);
        }
        const rows = list(data.data, operation === 'positions' ? 100 : 5000);
        if (mutation) {
          const row = one(rows);
          if (typeof row.sCode !== 'string') fail();
          if (row.sCode !== '0') throw providerFailure(row.sCode, response.status, true);
        }
        return rows;
      };
      return await Promise.race([run(), interrupted]);
    } catch (error) {
      if (timedOut || signal?.aborted) throw new OkxProtocolError(timedOut ? 'timeout' : 'aborted', { uncertain: mutation && dispatched });
      if (error instanceof OkxProtocolError) {
        if (mutation && dispatched && ['invalid_data', 'response_limit', 'transport', 'aborted'].includes(error.code)) error.uncertain = true;
        throw error;
      }
      throw new OkxProtocolError('transport', { uncertain: mutation && dispatched });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', interruptedListener);
      controller.abort();
    }
  }
  async function requestOnce(operation, credentials, parameters = {}, options = {}) {
    try { return await rawRequest(operation, credentials, parameters, options); }
    catch (error) {
      if (!(error instanceof OkxProtocolError) || error.code !== 'timestamp' || error.uncertain) throw error;
      const before = clock() - offset;
      const time = one(await rawRequest('time', null, {}, options));
      const after = clock() - offset;
      const nextOffset = Math.round(milliseconds(time.ts) - (before + after) / 2);
      if (!Number.isSafeInteger(nextOffset) || Math.abs(nextOffset) > 300_000) fail('clock');
      offset = nextOffset;
      return rawRequest(operation, credentials, parameters, options);
    }
  }
  async function request(operation, credentials, parameters = {}, options = {}) {
    if (operation !== 'bills') return requestOnce(operation, credentials, parameters, options);
    // Archive bills allow five requests per two seconds per user. Serialize
    // these streams so CL/BZ and income/expense pagination share that budget.
    const pending = fundingQueue.then(async () => {
      checkAbort(options.signal);
      if (previousFunding) await waitImpl(420, options.signal);
      checkAbort(options.signal); previousFunding = true;
      return requestOnce(operation, credentials, parameters, options);
    });
    fundingQueue = pending.catch(() => {});
    return pending;
  }
  async function rule(symbol, signal, refresh = false) {
    const instId = instrumentId(symbol), cached = ruleCache.get(symbol);
    if (!refresh && cached && cached.until > clock()) return { ...cached.value };
    const row = one(await request('rules', null, { instType: 'SWAP', instId }, { signal }));
    if (row.instId !== instId || row.instType !== 'SWAP' || row.ctType !== 'linear' || row.settleCcy !== 'USDT'
      || row.ctValCcy !== symbol.slice(0, -4) || !['live', 'post_only'].includes(row.state)) fail('not_tradable');
    const value = {
      instrumentId: instId, quantityUnit: '张', contractSize: multiply(amount(row.ctVal, { positive: true }), amount(row.ctMult, { positive: true })),
      tickSize: amount(row.tickSz, { positive: true }), quantityStep: amount(row.lotSz, { positive: true }),
      minQuantity: amount(row.minSz, { positive: true }), maxQuantity: amount(row.maxLmtSz, { positive: true }),
      // maxLmtAmt is explicitly USD. Do not label it as the generic USDT
      // maxNotional or silently assume the stablecoin trades at dollar parity.
      minNotional: '0', maxNotional: null, maxNotionalUsd: optionalAmount(row.maxLmtAmt, { positive: true }),
    };
    if (compareDecimals(value.minQuantity, value.maxQuantity) > 0 || compareDecimals(value.quantityStep, value.maxQuantity) > 0) fail();
    ruleCache.set(symbol, { value, until: clock() + 60_000 });
    return { ...value };
  }
  async function market(symbol, { signal, refreshRule = false } = {}) {
    const instId = instrumentId(symbol);
    const [rules, response] = await Promise.all([rule(symbol, signal, refreshRule), request('book', null, { instId, sz: '1' }, { signal })]);
    const book = one(response);
    if (list(book.bids, 1).length !== 1 || list(book.asks, 1).length !== 1
      || list(book.bids[0], 4).length < 2 || list(book.asks[0], 4).length < 2) fail();
    const bid = amount(book.bids[0][0], { positive: true }), ask = amount(book.asks[0][0], { positive: true });
    amount(book.bids[0][1], { positive: true }); amount(book.asks[0][1], { positive: true });
    if (compareDecimals(bid, ask) >= 0 || !multiple(bid, rules.tickSize) || !multiple(ask, rules.tickSize)) fail('not_tradable');
    return { symbol, bid, ask, at: iso(book.ts), rule: rules };
  }
  return Object.freeze({ request, clock, rule, market, credentialsValid });
}
