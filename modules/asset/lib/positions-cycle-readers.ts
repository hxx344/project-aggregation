import type { BinanceCredential, BybitCredential } from './exchanges.ts';
import type { OkxCredential } from './okx.ts';
import type { Position, PositionCycle } from './positions-types.ts';
import type { Credentials } from './validation.ts';
import { decimal, rows, text, POSITIONS_INVALID } from './positions-values.ts';
import { CYCLE_CURRENCY, CYCLE_LOOKBACK_MS, CYCLE_MISMATCH, cycleUnavailable, locateCycle, negate, newestFirst, summarizeCycle } from './positions-cycle.ts';
import type { CycleCash, CycleFill } from './positions-cycle.ts';

import { WEEK, SNAPSHOT_SKEW_MS, MAX_FILLS, TOO_MANY, CycleUnavailable, historyContext as context, millis, identifier, positive, bybitAmount, historyWindows as windows, binanceRange, bybitPages, okxFillPages, BYBIT_FILLS } from './positions-history.ts';
import type { HistoryOptions } from './positions-history.ts';
export { CycleUnavailable } from './positions-history.ts';

type Json = Record<string, unknown>;
export const CYCLE_SCOPES: Readonly<Record<string, readonly string[]>> = { binance: ['um', 'pm-um'], bybit: ['linear-usdt', 'linear-usdc'], okx: ['SWAP'] };
export const cycleSupported = (exchange: string, scope: string) => CYCLE_SCOPES[exchange]?.includes(scope) ?? false;

/** The position changed after its snapshot was taken; the caller retries with a newer snapshot. */
export class CycleRetry extends Error {}

/** `snapshotAt` is when the positions read that produced `position` started. */
export type CycleRequest = { position: Position; siblings: readonly Position[]; snapshotAt: number };
export type CycleOptions = HistoryOptions;

/** Cash-flow ids are never compared, so an int64 id that JSON.parse rounded (Binance tranId) is still usable. */
function cashId(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : identifier(value);
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
  const range = (path: string, params: Record<string, string>, start: number, end: number) => binanceRange(ctx, path, { symbol, ...params }, start, end);
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

async function bybitCycle(c: BybitCredential, scope: string, request: CycleRequest, options: CycleOptions): Promise<PositionCycle> {
  const { position } = request;
  // The ledger has no position index, so hedge legs on one symbol cannot be told apart.
  if (opposed(request)) throw new CycleUnavailable('同一合约同时持有多空两边，暂不统计本轮');
  const ctx = context('bybit', c, options), now = ctx.now(), symbol = position.instrumentId, currency = scope === 'linear-usdc' ? 'USDC' : 'USDT';
  const cash: CycleCash[] = [];
  let order = 0;
  const walked = await walk(request, now, windows(now, async (start, end) => {
    const fills: CycleFill[] = [];
    await bybitPages(ctx, { accountType: 'UNIFIED', category: 'linear', baseCoin: position.quantityUnit,
        currency, startTime: String(start), endTime: String(end) }, row => {
        if (row.symbol !== symbol) return;
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
    });
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
  const pagesNext = okxFillPages(ctx, instId, Number(begin), now);
  const next = async () => {
    const list = await pagesNext();
    if (!list) return null;
    const result: CycleFill[] = [];
    for (const row of list) {
      const billId = identifier(row.billId), time = millis(row.ts);
      if (row.side !== 'buy' && row.side !== 'sell') throw new Error(POSITIONS_INVALID);
      if (row.posSide === other) { otherTimes.push(time); continue; }
      if (row.posSide !== 'net' && row.posSide !== position.side) throw new Error(POSITIONS_INVALID);
      // fillSz is in contracts, like the position; fee is already a signed cash flow.
      result.push({ id: billId, time, side: row.side, quantity: positive(row.fillSz), price: positive(row.fillPx),
        realizedPnl: decimal(row.fillPnl), fee: decimal(row.fee), feeCurrency: text(row.feeCcy) });
    }
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
