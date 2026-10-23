import type { Credentials } from './validation.ts';
import type { ReadFill } from './hub-fills-types.ts';
import { decimal, text, POSITIONS_INVALID } from './positions-values.ts';
import { negate } from './positions-cycle.ts';
import { cycleSupported } from './positions-cycle-readers.ts';
import { historyContext, historyWindows, binanceRange, bybitPages, okxFillPages, BYBIT_FILLS, bybitAmount, positive, millis, identifier, MAX_FILLS, WEEK } from './positions-history.ts';
import type { HistoryOptions } from './positions-history.ts';

// Binance startTime-only covers 7d; reserve 120s for 60s clock skew + the 45s refresh deadline.
const BINANCE_LATEST_WINDOW_MS = WEEK - 120_000;
// Bybit startTime-only covers 24h since https://bybit-exchange.github.io/docs/changelog/v5#2025-04-24.
// Read the latest 23h so the implicit end leaves 1h for clock skew and request latency.
const BYBIT_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
const BYBIT_LATEST_WINDOW_MS = BYBIT_DEFAULT_WINDOW_MS - 60 * 60_000;

/** end anchors historical windows locally; the newest window omits the local upper bound. */
export type FillsRequest = { start: number; end: number };
const optional = (value: unknown, parse = decimal) => value === undefined || value === null || value === '' ? null : parse(value);
const fee = (value: unknown, parse = decimal) => { const result = optional(value, parse); return result === null ? null : negate(result); };
function inRange(value: unknown, start: number, end: number | null) {
  const time = millis(value);
  if (time < start || (end !== null && time > end)) throw new Error(POSITIONS_INVALID);
  return new Date(time).toISOString();
}
function fillWindows<T>(request: FillsRequest, latestWindow: number, read: (start: number, end: number | null) => Promise<T[]>) {
  // Omitting the latest endTime lets the exchange include already-executed trades ahead of our clock.
  const latestStart = Math.max(request.start, request.end - latestWindow);
  const older = historyWindows(latestStart - 1, read, request.start);
  let latest = true;
  return async () => {
    if (latest) { latest = false; return read(latestStart, null); }
    return older();
  };
}

/** Fixed oil instruments are read even when all current positions have closed.
 * Pagination, request budgets, decimal parsing and endpoint spacing are shared with cycle statistics. */
export async function readOilFills(credentials: Credentials, scope: string, request: FillsRequest, options: HistoryOptions = {}): Promise<ReadFill[]> {
  if (!cycleSupported(credentials.exchange, scope) || !['binance', 'bybit', 'okx'].includes(credentials.exchange)) throw new Error(POSITIONS_INVALID);
  if (credentials.exchange !== 'binance' && credentials.exchange !== 'bybit' && credentials.exchange !== 'okx') throw new Error(POSITIONS_INVALID);
  const ctx = historyContext(credentials.exchange, credentials, options), fills: ReadFill[] = [];
  let order = 0;
  const push = (fill: ReadFill) => { fills.push(fill); if (fills.length > MAX_FILLS) throw new Error(POSITIONS_INVALID); };
  for (const base of ['CL', 'BZ'] as const) {
    const currency = scope === 'linear-usdc' ? 'USDC' : 'USDT';
    if (credentials.exchange === 'binance') {
      const symbol = base + 'USDT', path = scope === 'pm-um' ? '/papi/v1/um/userTrades' : '/fapi/v1/userTrades';
      const next = fillWindows(request, BINANCE_LATEST_WINDOW_MS, async (start, end) => {
        const list = await binanceRange(ctx, path, { symbol }, start, end ?? request.end, 0, end === null);
        for (const row of list) {
          if (row.symbol !== symbol || !['BUY', 'SELL'].includes(String(row.side)) || !['BOTH', 'LONG', 'SHORT'].includes(String(row.positionSide))) throw new Error(POSITIONS_INVALID);
          // Binance trade ids are unique per symbol, not per account scope.
          push({ id: symbol + ':' + identifier(row.id), symbol, base, time: inRange(row.time, start, end),
            side: row.side === 'BUY' ? 'buy' : 'sell', positionSide: row.positionSide === 'BOTH' ? 'net' : row.positionSide === 'LONG' ? 'long' : 'short',
            quantity: positive(row.qty), quantityUnit: base, price: positive(row.price), priceCurrency: 'USDT',
            realizedPnl: optional(row.realizedPnl), fee: fee(row.commission), feeCurrency: row.commissionAsset ? text(row.commissionAsset) : null });
        }
        return list;
      });
      while (await next()) { /* Read every window, including empty ones after a position closed. */ }
    } else if (credentials.exchange === 'bybit') {
      const next = fillWindows(request, BYBIT_LATEST_WINDOW_MS, async (start, end) => {
        await bybitPages(ctx, { accountType: 'UNIFIED', category: 'linear', baseCoin: base, currency, startTime: String(start), ...(end === null ? {} : { endTime: String(end) }) }, row => {
          const allowed = currency === 'USDC' ? [base + 'USDC', base + 'PERP'] : [base + 'USDT'];
          if (!allowed.includes(String(row.symbol)) || !BYBIT_FILLS.has(String(row.type))) return;
          if (row.currency !== currency || (row.baseCoin !== undefined && row.baseCoin !== base) || (row.category !== undefined && row.category !== 'linear')
            || !['Buy', 'Sell'].includes(String(row.side))) throw new Error(POSITIONS_INVALID);
          push({ id: identifier(row.id), symbol: String(row.symbol), base, time: inRange(row.transactionTime, start, end),
            side: row.side === 'Buy' ? 'buy' : 'sell', positionSide: 'net', quantity: positive(bybitAmount(row.qty)), quantityUnit: base,
            price: positive(bybitAmount(row.tradePrice)), priceCurrency: currency, realizedPnl: optional(row.cashFlow, bybitAmount),
            fee: fee(row.fee, bybitAmount), feeCurrency: currency, sizeAfter: optional(row.size, bybitAmount), order: order++ });
        }, true);
        return [];
      });
      while (await next()) { /* Each window exhausts its transaction cursor. */ }
    } else {
      const symbol = base + '-USDT-SWAP', next = okxFillPages(ctx, symbol, request.start);
      for (let page = await next(); page; page = await next()) for (const row of page) {
        if (!['buy', 'sell'].includes(String(row.side)) || !['net', 'long', 'short'].includes(String(row.posSide))) throw new Error(POSITIONS_INVALID);
        push({ id: identifier(row.billId), symbol, base, time: inRange(row.ts, request.start, null),
          side: row.side as 'buy' | 'sell', positionSide: row.posSide as 'long' | 'short' | 'net', quantity: positive(row.fillSz), quantityUnit: '张',
          price: positive(row.fillPx), priceCurrency: 'USDT', realizedPnl: optional(row.fillPnl),
          fee: optional(row.fee), feeCurrency: row.feeCcy ? text(row.feeCcy) : null });
      }
    }
  }
  return fills;
}
