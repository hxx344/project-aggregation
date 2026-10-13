import { createHash, createHmac } from 'node:crypto';
import type { Balance } from './types';

export type GateCredential = { apiKey: string; apiSecret: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;

const BALANCE_PATH = '/api/v4/wallet/total_balance';
const QUERY = 'currency=USD';
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

function readFailure(reason: string, status?: number, label?: ErrorLabel): Error {
  const parts = [typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : '', label].filter(Boolean);
  return new Error(`Gate 读取失败${parts.length ? `（${parts.join(' · ')}）` : ''}：${reason}；本次未更新资产数据`);
}

function apiFailure(status: number, label: unknown): Error {
  // Only exact, code-owned labels may reach the UI. Never reflect message/detail or unknown labels.
  if (typeof label === 'string' && Object.hasOwn(ERROR_HINTS, label)) {
    const known = label as ErrorLabel;
    return readFailure(ERROR_HINTS[known], status, known);
  }
  const unknown = '未返回可识别的 API 错误码，具体原因尚未确定';
  if (status === 401) return readFailure(`身份认证未通过，${unknown}；请核对国际站实盘 API v4 Key 及对应 Secret`, status);
  if (status === 403) return readFailure(`访问被拒绝，${unknown}；请核对钱包读取权限、服务器出口 IP 白名单及访问限制`, status);
  if (status === 429) return readFailure('请求受到限流；请稍后重试并减少手动刷新次数', status);
  if (status >= 500 && status <= 599) return readFailure('Gate 或其网关服务暂时不可用；请稍后重试', status);
  return readFailure(`${unknown}；请稍后重试，持续出现时反馈此提示`, status);
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

async function errorLabel(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > MAX_ERROR_BYTES) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isObject(data) && Object.hasOwn(data, 'label') ? data.label : undefined;
  } catch {
    // Invalid JSON and transport errors may contain secrets. Fall back to the HTTP status.
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usdAmount(account: unknown): number {
  if (!isObject(account)) throw new Error(INCOMPLETE);
  if (account.currency !== 'USD') throw new Error('Gate 返回的估值币种不是 USD；已保留上次数据');
  const amount = account.amount;
  if (typeof amount !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(amount)) throw new Error('Gate 美元估值不是有效数值；已保留上次数据');
  const result = Number(amount);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(amount))) throw new Error('Gate 美元估值不是有效数值；已保留上次数据');
  return result === 0 ? 0 : result;
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
      headers: { Accept: 'application/json', KEY: c.apiKey, Timestamp: timestamp, SIGN: signature },
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
    const label = await errorLabel(response);
    if (signal?.aborted) throw readFailure('读取错误响应超时（12 秒）；请检查服务器到 Gate API 的网络连接后重试', response.status);
    throw apiFailure(response.status, label);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (signal?.aborted) throw readFailure('读取账户响应超时（12 秒）；请检查服务器到 Gate API 的网络连接后重试', response.status);
    throw readFailure('账户响应无法解析为 JSON；请检查服务器网络或代理，稍后重试', response.status);
  }
  if (!isObject(data)) throw new Error(INCOMPLETE);
  if (Object.hasOwn(data, 'label')) throw apiFailure(response.status, data.label);
  return data;
}

export async function syncGate(c: GateCredential, fetcher: Fetcher = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  // This GET reads balances only. Gate's account/detail contract cannot verify key permissions.
  const data = await gateGet(c, BALANCE_PATH, fetcher);
  const total = usdAmount(data.total);
  if (!isObject(data.details) || Object.keys(data.details).length === 0) throw new Error(INCOMPLETE);
  const details: Balance[] = [];
  let otherAccounts = 0;
  for (const [key, account] of Object.entries(data.details)) {
    const value = usdAmount(account);
    // Account types are an open map. Preserve new accounts without reflecting upstream names.
    const name = Object.hasOwn(ACCOUNT_NAMES, key) ? ACCOUNT_NAMES[key as keyof typeof ACCOUNT_NAMES] : `其他账户 ${++otherAccounts}`;
    details.push({ coin: 'USD', account: `${name}（USD 估值）`, quantity: value, price: 1, value });
  }
  // Gate defines no net-equity formula here: never add P&L, subtract debt or sum details into total.
  // There is no source timestamp; this is retrieval time, and Gate may cache values for one minute.
  return { total, details, updatedAt: new Date().toISOString() };
}
