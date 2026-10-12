import { createHmac } from 'node:crypto';
import type { Balance } from './types';

export type OkxCredential = { apiKey: string; apiSecret: string; passphrase: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;

const CONFIG_PATH = '/api/v5/account/config';
const VALUATION_PATH = '/api/v5/asset/asset-valuation';
const READ_PATHS = new Set([CONFIG_PATH, VALUATION_PATH]);
const ACCOUNT_NAMES = {
  funding: '资金账户（USD 估值）',
  trading: '交易账户（USD 估值）',
  earn: '赚币账户（USD 估值）',
  classic: '经典账户（USD 估值）',
} as const;
const INCOMPLETE = 'OKX 返回的账户数据不完整；已保留上次数据';
const READ_FAILED = 'OKX 读取失败，请检查网络、API 权限、IP 白名单及服务器时间；已保留上次数据';

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usdValue(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('OKX 美元估值不是有效数值；已保留上次数据');
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value))) throw new Error('OKX 美元估值不是有效数值；已保留上次数据');
  return result === 0 ? 0 : result;
}

function singleAccount(data: unknown[]): Json {
  if (data.length !== 1 || !isObject(data[0])) throw new Error(INCOMPLETE);
  return data[0];
}

export async function okxGet(c: OkxCredential, path: string, fetcher: Fetcher = fetch): Promise<unknown[]> {
  if (!READ_PATHS.has(path)) throw new Error('仅支持 OKX 只读账户接口');
  if ([c?.apiKey, c?.apiSecret, c?.passphrase].some(value => typeof value !== 'string' || !value.trim())) throw new Error('OKX API Key、Secret 与 Passphrase 不能为空');
  // The fixed USD query is included in the exact request path used for signing.
  const requestPath = path + (path === VALUATION_PATH ? '?ccy=USD' : '');
  let response: Response;
  try {
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', c.apiSecret).update(timestamp + 'GET' + requestPath).digest('base64');
    response = await fetcher('https://openapi.okx.com' + requestPath, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'OK-ACCESS-KEY': c.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': c.passphrase,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Transport errors can contain authenticated request details; never relay them.
    throw new Error(READ_FAILED);
  }
  if (response.redirected || !response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `（HTTP ${response.status}）` : '';
    throw new Error(`OKX 读取失败${status}，请检查网络、API 权限及服务器时间；已保留上次数据`);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error(READ_FAILED); }
  if (!isObject(data)) throw new Error(INCOMPLETE);
  if (data.code !== '0') {
    const code = typeof data.code === 'string' && /^\d{1,10}$/.test(data.code) ? data.code : '未知代码';
    throw new Error(`OKX 读取失败（${code}），请检查 API 权限、IP 白名单及服务器时间；已保留上次数据`);
  }
  if (!Array.isArray(data.data)) throw new Error(INCOMPLETE);
  return data.data;
}

export async function syncOkx(c: OkxCredential, fetcher: Fetcher = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  const config = singleAccount(await okxGet(c, CONFIG_PATH, fetcher));
  if (config.perm !== 'read_only') throw new Error('此 OKX API 无法确认只读权限，请使用仅启用读取的 API');
  const valuation = singleAccount(await okxGet(c, VALUATION_PATH, fetcher));
  const total = usdValue(valuation.totalBal);
  if (typeof valuation.ts !== 'string' || !/^\d{1,16}$/.test(valuation.ts)) throw new Error('OKX 估值时间无效或已过期；已保留上次数据');
  const timestamp = Number(valuation.ts);
  const now = Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || now - timestamp > 900000 || timestamp - now > 60000) throw new Error('OKX 估值时间无效或已过期；已保留上次数据');
  if (!isObject(valuation.details)) throw new Error(INCOMPLETE);
  const accounts = valuation.details;
  if (Object.keys(accounts).some(key => !Object.hasOwn(ACCOUNT_NAMES, key))) throw new Error('OKX 返回未知账户分项，无法确认估值结构；已保留上次数据');
  const details: Balance[] = [];
  for (const key of Object.keys(ACCOUNT_NAMES) as (keyof typeof ACCOUNT_NAMES)[]) {
    // OKX deprecated classic; the other documented account categories must exist.
    if (key === 'classic' && !Object.hasOwn(accounts, key)) continue;
    const value = usdValue(accounts[key]);
    details.push({ coin: 'USD', account: ACCOUNT_NAMES[key], quantity: value, price: 1, value });
  }
  // totalBal is the sole total. Account valuations are display-only and may round differently.
  return { total, details, updatedAt: new Date(timestamp).toISOString() };
}
