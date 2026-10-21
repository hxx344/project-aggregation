import type { BinanceCredential, BybitCredential } from './exchanges.ts';
import type { OkxCredential } from './okx.ts';
import type { Position, PositionCycle } from './positions-types.ts';
import type { Credentials } from './validation.ts';
import { positionsGet } from './positions-readers.ts';
import { decimal, record, rows, text, POSITIONS_FAILED, POSITIONS_INVALID } from './positions-values.ts';
import { CYCLE_CURRENCY, CYCLE_LOOKBACK_MS, CYCLE_MISMATCH, cycleUnavailable, locateCycle, negate, newestFirst, sign, summarizeCycle } from './positions-cycle.ts';
import type { CycleCash, CycleFill } from './positions-cycle.ts';

type Fetcher = typeof fetch;
type Json = Record<string, unknown>;
const WEEK = 7 * 86_400_000;
// A fill this close to the snapshot may not be reflected in it yet; exchange and local clocks also differ slightly.
const SNAPSHOT_SKEW_MS = 2_000;
const MAX_REQUESTS = 80, MAX_FILLS = 20_000, MAX_SPLITS = 6;
// Minimum gap between calls to one path, below each venue's documented per-account limit.
const SPACING: Record<string, number> = {
  '/fapi/v1/userTrades': 250, '/papi/v1/um/userTrades': 250, '/fapi/v1/income': 250, '/papi/v1/um/income': 250,
  '/v5/account/transaction-log': 150, '/api/v5/trade/fills-history': 250, '/api/v5/account/bills-archive': 450,
};
const TOO_MANY = '成交记录过多，未能统计本轮';

export const CYCLE_SCOPES: Readonly<Record<string, readonly string[]>> = { binance: ['um', 'pm-um'], bybit: ['linear-usdt', 'linear-usdc'], okx: ['SWAP'] };
export const cycleSupported = (exchange: string, scope: string) => CYCLE_SCOPES[exchange]?.includes(scope) ?? false;

/** Its message is shown to the user as the cycle note. */
export class CycleUnavailable extends Error {}
/** The position changed after its snapshot was taken; the caller retries with a newer snapshot. */
export class CycleRetry extends Error {}

/** `snapshotAt` is when the positions read that produced `position` started. */
export type CycleRequest = { position: Position; siblings: readonly Position[]; snapshotAt: number };
export type CycleOptions = { fetcher?: Fetcher; signal?: AbortSignal; now?: () => number; spacing?: boolean };

const lastCall = new Map<string, number>();
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(POSITIONS_FAILED)); return; }
    const stop = () => { clearTimeout(timer); reject(new Error(POSITIONS_FAILED)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

type Context = { now: () => number; get: (path: string, params: Record<string, string>) => Promise<unknown> };
function context(exchange: 'binance' | 'bybit' | 'okx', credential: BinanceCredential | BybitCredential | OkxCredential, options: CycleOptions): Context {
  let used = 0;
  return {
    now: options.now ?? Date.now,
    async get(path, params) {
      if (++used > MAX_REQUESTS) throw new CycleUnavailable(TOO_MANY);
      if (options.spacing !== false) {
        const key = exchange + path, wait = (lastCall.get(key) ?? -Infinity) + (SPACING[path] ?? 0) - Date.now();
        if (wait > 0) await sleep(wait, options.signal);
        lastCall.set(key, Date.now());
      }
      return positionsGet(exchange, credential, path, new URLSearchParams(params), options.fetcher ?? fetch, options.signal);
    },
  };
}

function millis(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(POSITIONS_INVALID);
  return parsed;
}
function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(POSITIONS_INVALID);
  return value;
}
/** Cash-flow ids are never compared, so an int64 id that JSON.parse rounded (Binance tranId) is still usable. */
function cashId(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : identifier(value);
}
function positive(value: unknown) { const result = decimal(value); if (sign(result) <= 0) throw new Error(POSITIONS_INVALID); return result; }
/** Bybit ledger amounts may be empty or use exponent notation; the point is moved as text. */
function bybitAmount(value: unknown): string {
  if (value === '' || value === undefined) return '0';
  if (typeof value !== 'string' || value.length > 100) throw new Error(POSITIONS_INVALID);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match || Math.abs(Number(match[4] || 0)) > 100) throw new Error(POSITIONS_INVALID);
  const digits = match[2] + (match[3] || ''), point = match[2].length + Number(match[4] || 0);
  const integer = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '');
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '');
  return decimal(`${match[1] === '-' ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`);
}
const signedCurrent = (position: Position) => position.side === 'short' ? negate(position.quantity) : position.quantity;

/** Reads pages newest first until the fill that opened the current position is found or the lookback is exhausted. */
async function walk(request: CycleRequest, now: number, next: () => Promise<CycleFill[] | null>) {
  const current = signedCurrent(request.position), fills: CycleFill[] = [], ids = new Set<string>();
  let located: ReturnType<typeof locateCycle> = null;
  for (let page = await next(); page; page = located ? null : await next()) {
    for (const fill of page) { if (ids.has(fill.id)) throw new Error(POSITIONS_INVALID); ids.add(fill.id); fills.push(fill); }
    if (fills.length > MAX_FILLS) throw new CycleUnavailable(TOO_MANY);
    fills.sort(newestFirst);
    located = locateCycle(current, fills);
  }
  if (fills.some(fill => fill.time >= request.snapshotAt - SNAPSHOT_SKEW_MS)) throw new CycleRetry();
  const lookbackStart = now - CYCLE_LOOKBACK_MS;
  return { current, located, fills: located ? fills.slice(0, located.index + 1) : fills, since: located ? fills[located.index].time : lookbackStart };
}

/** Week-long windows from `end` back to the lookback start, inclusive on both ends. */
function windows(now: number, read: (start: number, end: number) => Promise<CycleFill[]>) {
  const lookbackStart = now - CYCLE_LOOKBACK_MS;
  let end = now;
  return async () => {
    if (end < lookbackStart) return null;
    const start = Math.max(lookbackStart, end - WEEK + 1), page = await read(start, end);
    end = start - 1;
    return page;
  };
}

type Walked = Awaited<ReturnType<typeof walk>>;
function finish(request: CycleRequest, walked: Walked, cash: CycleCash[], fundingAttributable: boolean, now: number): PositionCycle {
  return summarizeCycle({ current: walked.current, currency: request.position.pnlCurrency, fills: walked.fills, cash,
    complete: walked.located !== null, openingFraction: walked.located?.openingFraction ?? null, since: walked.since,
    fundingAttributable, notes: [], updatedAt: new Date(now).toISOString() });
}
const opposed = (request: CycleRequest) => request.siblings.some(item => item.instrumentId === request.position.instrumentId && item.side !== request.position.side);

async function binanceCycle(c: BinanceCredential, scope: string, request: CycleRequest, options: CycleOptions): Promise<PositionCycle> {
  const ctx = context('binance', c, options), now = ctx.now(), { position } = request, symbol = position.instrumentId;
  const pm = scope === 'pm-um', tradesPath = pm ? '/papi/v1/um/userTrades' : '/fapi/v1/userTrades', incomePath = pm ? '/papi/v1/um/income' : '/fapi/v1/income';
  const own = position.side === 'long' ? 'LONG' : 'SHORT', other = position.side === 'long' ? 'SHORT' : 'LONG', otherTimes: number[] = [];
  // A full page cannot prove the window complete, so it is split until each half fits.
  async function range(path: string, params: Record<string, string>, start: number, end: number, depth = 0): Promise<Json[]> {
    const list = rows(await ctx.get(path, { symbol, ...params, startTime: String(start), endTime: String(end), limit: '1000' }));
    if (list.length < 1000) return list;
    if (depth >= MAX_SPLITS || end - start < 2) throw new CycleUnavailable(TOO_MANY);
    const middle = Math.floor((start + end) / 2);
    return [...await range(path, params, middle + 1, end, depth + 1), ...await range(path, params, start, middle, depth + 1)];
  }
  const walked = await walk(request, now, windows(now, async (start, end) => (await range(tradesPath, {}, start, end)).flatMap((row): CycleFill[] => {
    const time = millis(row.time);
    if (row.symbol !== symbol || time < start || time > end || (row.side !== 'BUY' && row.side !== 'SELL')) throw new Error(POSITIONS_INVALID);
    if (row.positionSide === other) { otherTimes.push(time); return []; }
    if (row.positionSide !== 'BOTH' && row.positionSide !== own) throw new Error(POSITIONS_INVALID);
    // commission is the charged amount (positive), so the cash flow is its negation; a rebate arrives negative.
    return [{ id: identifier(row.id), time, side: row.side === 'BUY' ? 'buy' : 'sell', quantity: positive(row.qty), price: positive(row.price),
      realizedPnl: decimal(row.realizedPnl), fee: negate(decimal(row.commission)), feeCurrency: text(row.commissionAsset) }];
  })));
  const cash: CycleCash[] = [];
  for (let start = walked.since; start <= now; start += WEEK) {
    const end = Math.min(now, start + WEEK - 1);
    for (const row of await range(incomePath, { incomeType: 'FUNDING_FEE' }, start, end)) {
      const time = millis(row.time);
      if (row.symbol !== symbol || row.incomeType !== 'FUNDING_FEE' || time < start || time > end) throw new Error(POSITIONS_INVALID);
      cash.push({ id: cashId(row.tranId), time, kind: 'funding', amount: decimal(row.income), currency: text(row.asset) });
    }
  }
  // Binance books funding per symbol; an opposite hedge leg in the same period shares it.
  return finish(request, walked, cash, !opposed(request) && !otherTimes.some(time => time >= walked.since), now);
}

const BYBIT_FILLS = new Set(['TRADE', 'LIQUIDATION', 'ADL']);
async function bybitCycle(c: BybitCredential, scope: string, request: CycleRequest, options: CycleOptions): Promise<PositionCycle> {
  const { position } = request;
  // The ledger has no position index, so hedge legs on one symbol cannot be told apart.
  if (opposed(request)) throw new CycleUnavailable('同一合约同时持有多空两边，暂不统计本轮');
  const ctx = context('bybit', c, options), now = ctx.now(), symbol = position.instrumentId, currency = scope === 'linear-usdc' ? 'USDC' : 'USDT';
  const cash: CycleCash[] = [];
  let order = 0;
  const walked = await walk(request, now, windows(now, async (start, end) => {
    const fills: CycleFill[] = [], cursors = new Set<string>();
    let cursor = '';
    do {
      const data = record(await ctx.get('/v5/account/transaction-log', { accountType: 'UNIFIED', category: 'linear', baseCoin: position.quantityUnit,
        currency, startTime: String(start), endTime: String(end), limit: '50', ...(cursor ? { cursor } : {}) }));
      for (const row of rows(data.list)) {
        if (row.symbol !== symbol) continue;
        const time = millis(row.transactionTime);
        if (time < start || time > end || row.currency !== currency) throw new Error(POSITIONS_INVALID);
        const id = identifier(row.id);
        if (BYBIT_FILLS.has(String(row.type))) {
          if (row.side !== 'Buy' && row.side !== 'Sell') throw new Error(POSITIONS_INVALID);
          // cashFlow is the realized trading PnL; fee is positive when charged; size is the signed position afterwards.
          fills.push({ id, time, side: row.side === 'Buy' ? 'buy' : 'sell', quantity: positive(bybitAmount(row.qty)), price: positive(bybitAmount(row.tradePrice)),
            realizedPnl: bybitAmount(row.cashFlow), fee: negate(bybitAmount(row.fee)), feeCurrency: currency, sizeAfter: bybitAmount(row.size), order: order++ });
        } else if (row.type === 'SETTLEMENT') {
          // funding already carries its cash-flow sign; USDC session settlement realizes PnL through cashFlow.
          cash.push({ id: id + ':funding', time, kind: 'funding', amount: bybitAmount(row.funding), currency });
          cash.push({ id: id + ':settlement', time, kind: 'realized', amount: bybitAmount(row.cashFlow), currency });
        }
      }
      cursor = typeof data.nextPageCursor === 'string' ? data.nextPageCursor : '';
      if (cursor && (cursors.has(cursor) || cursor.length > 4096)) throw new Error(POSITIONS_INVALID);
      cursors.add(cursor);
    } while (cursor);
    return fills;
  }));
  return finish(request, walked, cash, true, now);
}

async function okxCycle(c: OkxCredential, request: CycleRequest, options: CycleOptions): Promise<PositionCycle> {
  const { position } = request, instId = position.instrumentId;
  // Cross and isolated positions on one contract and side share fills that carry no position id.
  if (request.siblings.some(item => item.id !== position.id && item.instrumentId === instId && item.side === position.side)) throw new CycleUnavailable('同一合约有多笔同向仓位，暂不统计本轮');
  const ctx = context('okx', c, options), now = ctx.now();
  const other = position.side === 'long' ? 'short' : 'long', otherTimes: number[] = [], begin = String(now - CYCLE_LOOKBACK_MS);
  // bills-archive pages by billId, newest first.
  async function pages(path: string, params: Record<string, string>, collect: (row: Json) => void) {
    let after = '';
    for (;;) {
      const list = rows(await ctx.get(path, { ...params, end: String(now), limit: '100', ...(after ? { after } : {}) }));
      for (const row of list) {
        const billId = identifier(row.billId);
        if (!/^\d+$/.test(billId) || (after && BigInt(billId) >= BigInt(after))) throw new Error(POSITIONS_INVALID);
        if (row.instId !== instId) throw new Error(POSITIONS_INVALID);
        collect(row); after = billId;
      }
      if (list.length < 100) return;
    }
  }
  // fills-history pages by billId, newest first; each call reads one page so the walk can stop at the opening fill.
  let cursor = '', exhausted = false;
  const next = async () => {
    if (exhausted) return null;
    const list = rows(await ctx.get('/api/v5/trade/fills-history', { instType: 'SWAP', instId, begin, end: String(now), limit: '100', ...(cursor ? { after: cursor } : {}) }));
    const result: CycleFill[] = [];
    for (const row of list) {
      const billId = identifier(row.billId), time = millis(row.ts);
      if (!/^\d+$/.test(billId) || (cursor && BigInt(billId) >= BigInt(cursor)) || row.instId !== instId || (row.side !== 'buy' && row.side !== 'sell')) throw new Error(POSITIONS_INVALID);
      cursor = billId;
      if (row.posSide === other) { otherTimes.push(time); continue; }
      if (row.posSide !== 'net' && row.posSide !== position.side) throw new Error(POSITIONS_INVALID);
      // fillSz is in contracts, like the position; fee is already a signed cash flow.
      result.push({ id: billId, time, side: row.side, quantity: positive(row.fillSz), price: positive(row.fillPx),
        realizedPnl: decimal(row.fillPnl), fee: decimal(row.fee), feeCurrency: text(row.feeCcy) });
    }
    if (list.length < 100) exhausted = true;
    return result;
  };
  const walked = await walk(request, now, next);
  const cash: CycleCash[] = [];
  await pages('/api/v5/account/bills-archive', { instType: 'SWAP', instId, type: '8', begin: String(walked.since) }, row => {
    if (row.type !== '8' || (row.subType !== '173' && row.subType !== '174')) throw new Error(POSITIONS_INVALID);
    cash.push({ id: identifier(row.billId), time: millis(row.ts), kind: 'funding', amount: decimal(row.pnl), currency: text(row.ccy) });
  });
  return finish(request, walked, cash, !opposed(request) && !otherTimes.some(time => time >= walked.since), now);
}

/** Summarizes realized results since the position last opened from zero. Failures become an unavailable summary with a note. */
export async function readPositionCycle(credentials: Credentials, scope: string, request: CycleRequest, options: CycleOptions = {}): Promise<PositionCycle> {
  const at = () => new Date((options.now ?? Date.now)()).toISOString();
  if (!cycleSupported(credentials.exchange, scope)) return cycleUnavailable('此产品范围暂不支持统计本轮平仓', at());
  if (!request.position.pnlCurrency) return cycleUnavailable('缺少结算币种，无法统计本轮平仓', at());
  try {
    if (credentials.exchange === 'binance') return await binanceCycle(credentials, scope, request, options);
    if (credentials.exchange === 'bybit') return await bybitCycle(credentials, scope, request, options);
    if (credentials.exchange === 'okx') return await okxCycle(credentials, request, options);
    return cycleUnavailable('此交易所暂不支持统计本轮平仓', at());
  } catch (error) {
    if (error instanceof CycleRetry || options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : '';
    return cycleUnavailable(error instanceof CycleUnavailable || message === CYCLE_MISMATCH || message === CYCLE_CURRENCY ? message
      : message === POSITIONS_INVALID ? '交易所成交数据格式无法识别，暂不统计本轮' : '本轮成交读取失败，稍后重试', at());
  }
}
