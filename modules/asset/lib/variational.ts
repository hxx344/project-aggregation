import type { Balance } from './types';
import { readVariationalPythonBalance } from './variational-python-client.ts';
import { validateVariationalCredential, variationalDecimal as decimal, VARIATIONAL_ERRORS } from './variational-shared.ts';
import type { VariationalCredential } from './variational-shared.ts';

export type { VariationalCredential } from './variational-shared.ts';
export { hasValidVariationalBalance } from './variational-shared.ts';
type Json = Record<string, unknown>;
// Retain the original Node request headers for diagnostic comparisons only.
const GRID_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const INVALID = VARIATIONAL_ERRORS.invalid_data;
const FAILED = VARIATIONAL_ERRORS.network_error;
const RATE_LIMITED = VARIATIONAL_ERRORS.rate_limited;
const TIMED_OUT = VARIATIONAL_ERRORS.timeout;
const SAFE_ERRORS = new Set<string>(Object.values(VARIATIONAL_ERRORS));
const MAX_BYTES = 2 * 1024 * 1024;

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function variationalRequestHeaders(c: VariationalCredential): Record<string, string> {
  validateVariationalCredential(c);
  return {
    Accept: 'application/json',
    'User-Agent': GRID_USER_AGENT,
    Referer: 'https://omni.variational.io/',
    'Cache-Control': 'no-cache',
    Cookie: 'vr-token=' + c.vrToken,
  };
}

// Pricing remains in Node; these requests never receive session credentials.
async function read(url: string, headers: Record<string, string>, fetcher: typeof fetch): Promise<Json> {
  try {
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const rejectResponse = async (message: string): Promise<never> => {
      // Discard rejected bodies without reading or exposing challenge pages and account details.
      await response.body?.cancel().catch(() => {});
      throw new Error(message);
    };
    if (response.redirected) return rejectResponse(FAILED);
    if (!response.ok) {
      if (response.status === 429) return rejectResponse(RATE_LIMITED);
      return rejectResponse(FAILED);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType && contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) return rejectResponse(INVALID);
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES || !response.body) return rejectResponse(INVALID);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error(INVALID); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(data)) throw new Error(INVALID);
    return data;
  } catch (error) {
    // Whitelist our own errors; never echo raw HTTP, JSON, transport or credential content.
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(TIMED_OUT);
    throw new Error(FAILED);
  }
}

async function usdcQuote(fetcher: typeof fetch): Promise<{ price: number; at: number }> {
  try {
    const data = await read(COINGECKO, { Accept: 'application/json' }, fetcher);
    const coin = data['usd-coin'];
    if (!object(coin) || typeof coin.usd !== 'number' || !Number.isFinite(coin.usd) || coin.usd <= 0 || typeof coin.last_updated_at !== 'number') throw new Error(INVALID);
    const at = coin.last_updated_at * 1000;
    if (!Number.isSafeInteger(at) || at <= 0 || Date.now() - at > 900000 || at - Date.now() > 60000) throw new Error(INVALID);
    return { price: coin.usd, at };
  } catch {
    try {
      const data = await read(COINBASE, { Accept: 'application/json' }, fetcher);
      if (!object(data.data) || data.data.currency !== 'USDC' || !object(data.data.rates)) throw new Error(INVALID);
      const price = decimal(data.data.rates.USD);
      if (price <= 0) throw new Error(INVALID);
      return { price, at: Date.now() };
    } catch { throw new Error('Var USDC/USD 汇率读取失败；已保留上次数据'); }
  }
}

export async function syncVariational(c: VariationalCredential, fetcher: typeof fetch = fetch, portfolioReader: (c: VariationalCredential) => Promise<number | string> = readVariationalPythonBalance): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  // vr-token is a full web session, not a read-only API key. The application only reads this portfolio.
  validateVariationalCredential(c);
  let balance: number | string;
  try { balance = await portfolioReader(c); }
  catch (error) {
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
    throw new Error(FAILED);
  }
  const fetchedAt = Date.now();
  const quantity = decimal(balance);
  // Omni's portfolio header uses balance directly, including all sub-accounts and unrealized P&L.
  // Neither upnl, margin usage, sub-account balances nor position notional is added again.
  const quote = await usdcQuote(fetcher);
  const total = quantity * quote.price;
  if (!Number.isFinite(total) || (total === 0 && quantity !== 0)) throw new Error(INVALID);
  return {
    total: total === 0 ? 0 : total,
    details: [{ coin: 'USDC', account: 'Omni 账户净权益（含未实现盈亏）', quantity, price: quote.price, value: total === 0 ? 0 : total }],
    // The live portfolio response has no documented valuation timestamp. Keep receipt time honest,
    // and retain an older FX timestamp so a fresh account response cannot refresh an old valuation.
    updatedAt: new Date(Math.min(fetchedAt, quote.at)).toISOString(),
  };
}
