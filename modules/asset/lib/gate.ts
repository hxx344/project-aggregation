import { createHash, createHmac } from 'node:crypto';
import type { Balance } from './types';

export type GateCredential = { apiKey: string; apiSecret: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;

const BALANCE_PATH = '/api/v4/wallet/total_balance';
const QUERY = 'currency=USDT';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDT';
const QUOTE_FAILED = 'Gate USDT/USD 汇率读取失败或已过期；本次未更新资产数据';
const EMPTY_PAYLOAD_HASH = createHash('sha512').update('').digest('hex');
const ACCOUNT_NAMES = {
  cross_margin: '全仓杠杆账户',
  spot: '现货账户',
  finance: '金融账户',
  margin: '杠杆账户',
  quant: '量化账户',
  futures: '永续合约账户',
  delivery: '交割合约账户',
  warrant: '认股权证账户',
  cbbc: '牛熊证账户',
  meme_box: 'Alpha 账户',
  options: '期权账户',
  payment: '支付账户',
} as const;
const INCOMPLETE = 'Gate 返回的账户数据不完整；已保留上次数据';
const MAX_ERROR_BYTES = 16 * 1024;
const ERROR_HINTS = {
  INVALID_PARAM_VALUE: 'Gate 拒绝了请求参数；本程序固定请求 currency=USDT，请反馈此错误码检查接口兼容性，无需增加 API 权限',
  INVALID_PROTOCOL: 'Gate 拒绝了请求格式；请反馈此错误码检查 API 接入及服务器代理配置',
  INVALID_ARGUMENT: 'Gate 拒绝了请求参数；请反馈此错误码检查接口兼容性，无需增加 API 权限',
  INVALID_REQUEST_BODY: 'Gate 拒绝了请求正文；本程序使用无正文 GET 请求，请检查服务器代理是否改写请求',
  MISSING_REQUIRED_PARAM: 'Gate 报告缺少请求参数；请反馈此错误码检查接口兼容性，无需增加 API 权限',
  BAD_REQUEST: 'Gate 判定请求无效；请反馈此错误码检查请求格式及服务器代理配置',
  INVALID_CONTENT_TYPE: 'Gate 拒绝了 Content-Type 请求头；本程序使用 application/json，请检查服务器代理是否改写请求头',
  NOT_ACCEPTABLE: 'Gate 拒绝了 Accept 请求头；本程序请求 application/json，请检查服务器代理是否改写请求头',
  METHOD_NOT_ALLOWED: 'Gate 不允许当前请求方法；本程序仅使用 GET，请检查服务器代理是否改写请求',
  NOT_FOUND: 'Gate 未找到总资产接口；请反馈此错误码检查 API 接入地址及服务器代理配置',
  INVALID_CURRENCY: 'Gate 拒绝了估值币种；本程序固定使用官方支持的 USDT，请反馈此错误码检查接口兼容性',
  ACCOUNT_EXCEPTION: 'Gate 报告账户异常；请在 Gate 核对账户状态，持续出现时联系 Gate 支持',
  MARGIN_BALANCE_EXCEPTION: 'Gate 报告杠杆账户余额异常；请在 Gate 核对杠杆账户状态，持续出现时联系 Gate 支持',
  INVALID_CREDENTIALS: 'API 凭据认证失败；请核对同一组 API v4 Key 和 Secret，并确认使用 Gate 国际站实盘密钥',
  INVALID_KEY: 'API v4 Key 无效或已失效；请确认使用 Gate 国际站实盘 Key 并重新复制，新建或修改后最多等待 5 分钟再试',
  IP_FORBIDDEN: '服务器出口 IP 不在 API Key 白名单中；请填写运行平台的服务器出口 IPv4，修改后最多等待 5 分钟再试',
  FORBIDDEN: '当前账户或 API Key 无权读取该接口；请检查钱包（Wallet）读取权限及账户限制，修改权限后最多等待 5 分钟再试',
  INVALID_SIGNATURE: '签名校验失败；请确认 API v4 Key 与 Secret 属于同一组且复制完整',
  REQUEST_EXPIRED: '请求时间与 Gate 服务器时间相差过大；请同步运行平台的服务器时间，时间误差不能超过 60 秒',
  MISSING_REQUIRED_HEADER: '认证请求缺少必要请求头；请检查服务器代理是否改写请求，持续出现时反馈该错误码',
  ACCOUNT_LOCKED: 'Gate 账户已锁定；请登录 Gate 核对账户状态或联系 Gate 支持',
  READ_ONLY: 'Gate 报告密钥只读限制，但本程序仅发送读取请求；请核对账户及 API 状态或联系 Gate 支持，无需开启交易或提现权限',
  TOO_MANY_REQUESTS: '请求过于频繁，已触发限流；请稍后重试并减少手动刷新次数',
  TOO_BUSY: 'Gate 服务繁忙；请稍后重试',
  INTERNAL: 'Gate 服务内部异常；请稍后重试',
  SERVER_ERROR: 'Gate 服务内部异常；请稍后重试',
  INTERNAL_SERVER_ERROR: 'Gate 服务内部异常；请稍后重试',
} as const;
type ErrorLabel = keyof typeof ERROR_HINTS;
const RESPONSE_HINTS = {
  API_CODE_UNKNOWN: '已收到 JSON 错误响应，但 API 错误码尚未收录；请反馈此诊断代号，暂不能确定具体原因',
  API_CODE_MISSING: '已收到 JSON 响应，但未包含有效的 API 错误码；请反馈此诊断代号，暂不能确定具体原因',
  RESPONSE_EMPTY: '收到空错误响应，无法取得 Gate 错误码；请检查服务器到 Gate API 的网络或代理后重试',
  RESPONSE_HTML: '收到 HTML 页面，未取得可识别的 API 错误响应；请检查服务器出口网络、代理或访问限制',
  RESPONSE_NON_JSON: '错误响应不是有效 JSON，无法取得 Gate 错误码；请检查服务器网络或代理后重试',
  RESPONSE_TOO_LARGE: '错误响应超过 16 KiB，已停止读取；请检查服务器代理或访问限制并反馈此诊断代号',
  RESPONSE_READ_FAILED: '错误响应读取中断，无法取得完整错误码；请检查服务器网络或代理后重试',
} as const;
type ResponseCode = keyof typeof RESPONSE_HINTS;
type ErrorResponse = { kind: 'known'; label: ErrorLabel } | { kind: 'response'; code: ResponseCode };

function readFailure(reason: string, status?: number, label?: ErrorLabel | ResponseCode): Error {
  const parts = [typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : '', label].filter(Boolean);
  return new Error(`Gate 读取失败${parts.length ? `（${parts.join(' · ')}）` : ''}：${reason}；本次未更新资产数据`);
}

function classifyError(data: unknown): ErrorResponse {
  if (isObject(data) && Object.hasOwn(data, 'label') && typeof data.label === 'string' && data.label.trim()) {
    if (Object.hasOwn(ERROR_HINTS, data.label)) return { kind: 'known', label: data.label as ErrorLabel };
    return { kind: 'response', code: 'API_CODE_UNKNOWN' };
  }
  return { kind: 'response', code: 'API_CODE_MISSING' };
}

function apiFailure(status: number, error: ErrorResponse): Error {
  // Only exact, code-owned API labels or response classifications may reach the UI.
  if (error.kind === 'known') return readFailure(ERROR_HINTS[error.label], status, error.label);
  const detail = RESPONSE_HINTS[error.code];
  if (status === 401) return readFailure(`身份认证未通过；${detail}`, status, error.code);
  if (status === 403) return readFailure(`访问被拒绝；${detail}`, status, error.code);
  if (status === 429) return readFailure(`请求受到限流；请稍后重试并减少手动刷新次数；${detail}`, status, error.code);
  if (status >= 500 && status <= 599) return readFailure(`Gate 或其网关服务暂时不可用；${detail}`, status, error.code);
  return readFailure(detail, status, error.code);
}

function transportFailure(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return readFailure('请求超时（12 秒）；请检查服务器到 Gate API 的网络连接后重试');
  const cause = isObject(error) && isObject(error.cause) ? error.cause : error;
  const code = isObject(cause) ? cause.code : undefined;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return readFailure('无法解析 Gate API 域名；请检查运行平台的服务器 DNS 和网络配置');
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return readFailure('连接 Gate API 超时；请检查服务器网络或代理配置后重试');
  if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return readFailure('无法建立到 Gate API 的连接；请检查服务器网络、防火墙或代理配置');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return readFailure('与 Gate API 的连接中断；请检查服务器网络或代理后重试');
  if (typeof code === 'string' && ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
    return readFailure('Gate API 的 TLS 证书校验失败；请检查服务器时间、证书信任及代理配置');
  }
  return readFailure('网络请求未完成；请检查运行平台的服务器网络、DNS 或代理配置后重试');
}

async function errorResponse(response: Response): Promise<ErrorResponse> {
  const reader = response.body?.getReader();
  if (!reader) return { kind: 'response', code: 'RESPONSE_EMPTY' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > MAX_ERROR_BYTES) {
      void reader.cancel().catch(() => {});
      return { kind: 'response', code: 'RESPONSE_TOO_LARGE' };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BYTES) {
        void reader.cancel().catch(() => {});
        return { kind: 'response', code: 'RESPONSE_TOO_LARGE' };
      }
      chunks.push(value);
    }
    const content = Buffer.concat(chunks).toString('utf8').trim();
    if (!content) return { kind: 'response', code: 'RESPONSE_EMPTY' };
    try { return classifyError(JSON.parse(content)); }
    catch {
      const html = /^<(?:!doctype\s+html\b|html\b|head\b|body\b)/i.test(content)
        || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'text/html';
      return { kind: 'response', code: html ? 'RESPONSE_HTML' : 'RESPONSE_NON_JSON' };
    }
  } catch {
    // The original body, headers and transport errors never cross the diagnostic boundary.
    return { kind: 'response', code: 'RESPONSE_READ_FAILED' };
  } finally {
    reader.releaseLock();
  }
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usdtAmount(account: unknown): number {
  if (!isObject(account)) throw new Error(INCOMPLETE);
  if (account.currency !== 'USDT') throw new Error('Gate 返回的估值币种不是 USDT；已保留上次数据');
  const amount = account.amount;
  if (typeof amount !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(amount)) throw new Error('Gate USDT 估值不是有效数值；已保留上次数据');
  const result = Number(amount);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(amount))) throw new Error('Gate USDT 估值不是有效数值；已保留上次数据');
  return result === 0 ? 0 : result;
}

async function quoteJson(url: string, fetcher: Fetcher): Promise<Json> {
  // Public pricing requests are constructed separately and never receive Gate headers.
  const response = await fetcher(url, {
    method: 'GET', headers: { Accept: 'application/json' },
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12000),
  });
  const limit = 128 * 1024;
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error(QUOTE_FAILED);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new Error(QUOTE_FAILED);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isObject(data)) throw new Error(QUOTE_FAILED);
  return data;
}

async function usdtQuote(fetcher: Fetcher): Promise<{ price: number; at: number }> {
  try {
    const data = await quoteJson(COINGECKO, fetcher);
    const coin = data.tether;
    if (!isObject(coin) || typeof coin.usd !== 'number' || !Number.isFinite(coin.usd) || coin.usd <= 0 || typeof coin.last_updated_at !== 'number') throw new Error(QUOTE_FAILED);
    const at = coin.last_updated_at * 1000;
    if (!Number.isSafeInteger(at) || at <= 0 || Date.now() - at > 900000 || at - Date.now() > 60000) throw new Error(QUOTE_FAILED);
    return { price: coin.usd, at };
  } catch {
    try {
      const data = await quoteJson(COINBASE, fetcher);
      if (!isObject(data.data) || data.data.currency !== 'USDT' || !isObject(data.data.rates)) throw new Error(QUOTE_FAILED);
      const rate = data.data.rates.USD;
      if (typeof rate !== 'string' || !/^\d+(?:\.\d+)?$/.test(rate)) throw new Error(QUOTE_FAILED);
      const price = Number(rate);
      if (!Number.isFinite(price) || price <= 0) throw new Error(QUOTE_FAILED);
      // Coinbase publishes no rate timestamp here; retain the local retrieval time.
      return { price, at: Date.now() };
    } catch { throw new Error(QUOTE_FAILED); }
  }
}

function usdValue(quantity: number, price: number): number {
  const value = quantity * price;
  if (!Number.isFinite(value) || (value === 0 && quantity !== 0)) throw new Error('Gate 美元换算结果无效；本次未更新资产数据');
  return value === 0 ? 0 : value;
}

export async function gateGet(c: GateCredential, path: string, fetcher: Fetcher = fetch): Promise<Json> {
  if (path !== BALANCE_PATH) throw new Error('仅支持 Gate 只读账户接口');
  if ([c?.apiKey, c?.apiSecret].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Gate API Key 与 Secret 不能为空');
  let response: Response;
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(12000);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = ['GET', BALANCE_PATH, QUERY, EMPTY_PAYLOAD_HASH, timestamp].join('\n');
    const signature = createHmac('sha512', c.apiSecret).update(payload).digest('hex');
    response = await fetcher('https://api.gateio.ws' + BALANCE_PATH + '?' + QUERY, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', KEY: c.apiKey, Timestamp: timestamp, SIGN: signature },
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    // Transport errors can contain credentials or signed requests; never forward them.
    throw transportFailure(error, signal);
  }
  if (response.redirected || (response.status >= 300 && response.status <= 399)) {
    throw readFailure('官方 API 请求返回重定向，已停止请求以保护密钥；请检查服务器网络或代理配置', response.status);
  }
  if (!response.ok) {
    const error = await errorResponse(response);
    if (signal?.aborted) throw readFailure('读取错误响应超时（12 秒）；请检查服务器到 Gate API 的网络连接后重试', response.status);
    throw apiFailure(response.status, error);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (signal?.aborted) throw readFailure('读取账户响应超时（12 秒）；请检查服务器到 Gate API 的网络连接后重试', response.status);
    throw readFailure('账户响应无法解析为 JSON；请检查服务器网络或代理，稍后重试', response.status);
  }
  if (!isObject(data)) throw new Error(INCOMPLETE);
  if (Object.hasOwn(data, 'label')) throw apiFailure(response.status, classifyError(data));
  return data;
}

export async function syncGate(c: GateCredential, fetcher: Fetcher = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  // This GET reads balances only. Gate's account/detail contract cannot verify key permissions.
  const data = await gateGet(c, BALANCE_PATH, fetcher);
  const fetchedAt = Date.now();
  const quantity = usdtAmount(data.total);
  if (!isObject(data.details) || Object.keys(data.details).length === 0) throw new Error(INCOMPLETE);
  const details: Balance[] = [];
  let otherAccounts = 0;
  for (const [key, account] of Object.entries(data.details)) {
    const amount = usdtAmount(account);
    // Account types are an open map. Preserve new accounts without reflecting upstream names.
    const name = Object.hasOwn(ACCOUNT_NAMES, key) ? ACCOUNT_NAMES[key as keyof typeof ACCOUNT_NAMES] : `其他账户 ${++otherAccounts}`;
    details.push({ coin: 'USDT', account: `${name}（USDT 估值）`, quantity: amount, price: 0, value: 0 });
  }
  // Fetch only the required conversion after validating every account; USDT is not USD.
  const quote = await usdtQuote(fetcher);
  const total = usdValue(quantity, quote.price);
  for (const detail of details) {
    detail.price = quote.price;
    detail.value = usdValue(detail.quantity, quote.price);
  }
  // Gate defines no net-equity formula here: never add P&L, subtract debt or sum details into total.
  // Gate may cache values for one minute. A new balance cannot refresh an older price timestamp.
  return { total, details, updatedAt: new Date(Math.min(fetchedAt, quote.at)).toISOString() };
}
