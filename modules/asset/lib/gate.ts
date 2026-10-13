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
const READ_FAILED = 'Gate 读取失败，请检查网络、API 权限、IP 白名单及服务器时间；已保留上次数据';

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
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = ['GET', BALANCE_PATH, QUERY, EMPTY_PAYLOAD_HASH, timestamp].join('\n');
    const signature = createHmac('sha512', c.apiSecret).update(payload).digest('hex');
    response = await fetcher('https://api.gateio.ws' + BALANCE_PATH + '?' + QUERY, {
      method: 'GET',
      headers: { Accept: 'application/json', KEY: c.apiKey, Timestamp: timestamp, SIGN: signature },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Transport errors can contain credentials or signed requests; never forward them.
    throw new Error(READ_FAILED);
  }
  if (response.redirected || !response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `（HTTP ${response.status}）` : '';
    throw new Error(`Gate 读取失败${status}，请检查网络、API 权限、IP 白名单及服务器时间；已保留上次数据`);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error(READ_FAILED); }
  if (!isObject(data)) throw new Error(INCOMPLETE);
  // Gate errors use label/message; do not expose either field or treat errors as zero balances.
  if (Object.hasOwn(data, 'label')) throw new Error(READ_FAILED);
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
