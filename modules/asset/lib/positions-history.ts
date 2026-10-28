import type { BinanceCredential, BybitCredential } from './exchanges.ts';
import type { OkxCredential } from './okx.ts';
import { positionsGet } from './positions-readers.ts';
import { decimal, record, rows, POSITIONS_FAILED, POSITIONS_INVALID } from './positions-values.ts';
import { CYCLE_LOOKBACK_MS, sign } from './positions-cycle.ts';

export const WEEK = 7 * 86_400_000;
export const SNAPSHOT_SKEW_MS = 2_000;
export const MAX_REQUESTS = 80, MAX_FILLS = 20_000;
const MAX_SPLITS = 6;
const SPACING: Record<string, number> = {
  '/fapi/v1/userTrades': 250, '/papi/v1/um/userTrades': 250, '/fapi/v1/income': 250, '/papi/v1/um/income': 250,
  '/v5/account/transaction-log': 150, '/api/v5/trade/fills-history': 250, '/api/v5/account/bills-archive': 450,
};
export const TOO_MANY = '成交记录过多，未能统计本轮';
export class CycleUnavailable extends Error {}
export type HistoryOptions = { fetcher?: typeof fetch; signal?: AbortSignal; now?: () => number; spacing?: boolean };
export type HistoryContext = { now: () => number; get: (path: string, params: Record<string, string>) => Promise<unknown> };
type Json = Record<string, unknown>;
const lastCall = new Map<string, number>();
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(POSITIONS_FAILED)); return; }
    const stop = () => { clearTimeout(timer); reject(new Error(POSITIONS_FAILED)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Shared with cycle statistics. Reserve the slot before awaiting, including across service instances.
 * Fixed GETs: 10s each, 2MB maximum, no automatic retries; caller supplies its overall deadline. */
export function historyContext(exchange: 'binance' | 'bybit' | 'okx', credential: BinanceCredential | BybitCredential | OkxCredential, options: HistoryOptions): HistoryContext {
  let used = 0;
  return {
    now: options.now ?? Date.now,
    async get(path, params) {
      if (++used > MAX_REQUESTS) throw new CycleUnavailable(TOO_MANY);
      if (options.spacing !== false) {
        const key = exchange + path, at = Math.max(Date.now(), (lastCall.get(key) ?? -Infinity) + (SPACING[path] ?? 0));
        lastCall.set(key, at);
        if (at > Date.now()) await sleep(at - Date.now(), options.signal);
      }
      if (options.signal?.aborted) throw new Error(POSITIONS_FAILED);
      return positionsGet(exchange, credential, path, new URLSearchParams(params), options.fetcher ?? fetch, options.signal);
    },
  };
}
export function millis(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 8_640_000_000_000_000) throw new Error(POSITIONS_INVALID);
  return parsed;
}
export function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(POSITIONS_INVALID);
  return value;
}
export function positive(value: unknown) { const result = decimal(value); if (sign(result) <= 0) throw new Error(POSITIONS_INVALID); return result; }
/** Move the decimal point as text, never round an exchange amount through Number. */
export function bybitAmount(value: unknown): string {
  if (value === '' || value === undefined) return '0';
  if (typeof value !== 'string' || value.length > 100) throw new Error(POSITIONS_INVALID);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match || Math.abs(Number(match[4] || 0)) > 100) throw new Error(POSITIONS_INVALID);
  const digits = match[2] + (match[3] || ''), point = match[2].length + Number(match[4] || 0);
  const integer = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '');
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '');
  return decimal(`${match[1] === '-' ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`);
}
export const BYBIT_FILLS = new Set(['TRADE', 'LIQUIDATION', 'ADL']);

export function historyWindows<T>(end: number, read: (start: number, end: number) => Promise<T[]>, start = end - CYCLE_LOOKBACK_MS) {
  return async () => {
    if (end < start) return null;
    const begin = Math.max(start, end - WEEK + 1), page = await read(begin, end);
    end = begin - 1;
    return page;
  };
}
// Binance startTime-only covers 7d; reserve 120s for 60s clock skew + the 45s refresh deadline.
export const BINANCE_LATEST_WINDOW_MS = WEEK - 120_000;
// Bybit startTime-only covers 24h since https://bybit-exchange.github.io/docs/changelog/v5#2025-04-24.
// Read the latest 23h so the implicit end leaves 1h for clock skew and request latency.
const BYBIT_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export const BYBIT_LATEST_WINDOW_MS = BYBIT_DEFAULT_WINDOW_MS - 60 * 60_000;
/** Newest window first with no local upper bound (end null), then closed weekly windows back to start.
 * Omitting the latest endTime lets the exchange include already-executed trades stamped ahead of our clock. */
export function latestOpenWindows<T>(start: number, end: number, latestWindow: number, read: (start: number, end: number | null) => Promise<T[]>) {
  const latestStart = Math.max(start, end - latestWindow);
  const older = historyWindows(latestStart - 1, read, start);
  let latest = true;
  return async () => {
    if (latest) { latest = false; return read(latestStart, null); }
    return older();
  };
}
/** A full Binance page does not prove coverage; split until both inclusive subwindows fit. */
export async function binanceRange(ctx: HistoryContext, path: string, params: Record<string, string>, start: number, end: number, depth = 0, openEnd = false): Promise<Json[]> {
  const list = rows(await ctx.get(path, { ...params, startTime: String(start), ...(openEnd ? {} : { endTime: String(end) }), limit: '1000' }));
  if (list.length < 1000) return list;
  if (depth >= MAX_SPLITS || end - start < 2) throw new CycleUnavailable(TOO_MANY);
  const middle = Math.floor((start + end) / 2);
  return [...await binanceRange(ctx, path, params, middle + 1, end, depth + 1, openEnd), ...await binanceRange(ctx, path, params, start, middle, depth + 1)];
}
export async function bybitPages(ctx: HistoryContext, params: Record<string, string>, collect: (row: Json) => void, strictCursor = false) {
  const cursors = new Set<string>();
  let cursor = '';
  do {
    const data = record(await ctx.get('/v5/account/transaction-log', { ...params, limit: '50', ...(cursor ? { cursor } : {}) }));
    if (strictCursor && typeof data.nextPageCursor !== 'string') throw new Error(POSITIONS_INVALID);
    for (const row of rows(data.list)) collect(row);
    cursor = typeof data.nextPageCursor === 'string' ? data.nextPageCursor : '';
    if (cursor && (cursors.has(cursor) || cursor.length > 4096)) throw new Error(POSITIONS_INVALID);
    cursors.add(cursor);
  } while (cursor);
}
export function okxFillPages(ctx: HistoryContext, instId: string, start: number, end?: number) {
  let cursor = '', exhausted = false;
  return async () => {
    if (exhausted) return null;
    const list = rows(await ctx.get('/api/v5/trade/fills-history', { instType: 'SWAP', instId, begin: String(start), ...(end === undefined ? {} : { end: String(end) }), limit: '100', ...(cursor ? { after: cursor } : {}) }));
    for (const row of list) {
      const id = identifier(row.billId);
      if (!/^\d+$/.test(id) || (cursor && BigInt(id) >= BigInt(cursor)) || row.instId !== instId) throw new Error(POSITIONS_INVALID);
      cursor = id;
    }
    if (list.length < 100) exhausted = true;
    return list;
  };
}
