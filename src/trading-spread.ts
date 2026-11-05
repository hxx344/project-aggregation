import type { TradingExchange } from './trading-types';
import type { ExecutionMarket, ExecutionQuoteBook, ExecutionQuotes, ExecutionSymbol } from './trading-execution-types';

/**
 * Display-only spreads for the arbitrage page, computed from top of book.
 * Oil: BZ − CL, percent of CL (same sign as the monitor's Brent − WTI).
 * Hynix: ADR − ordinary ÷ 10 (10 ADR ≈ 1 ordinary share), percent of that
 * equivalent (the monitor's ADR premium). Cross-exchange: A − B on mid price,
 * percent of B; the executable edge sells at one venue's bid and buys at the
 * other's ask, percent of that ask. Values are floats for display only.
 */
export const SPREAD_MARKETS: Record<ExecutionMarket, { name: string; base: ExecutionSymbol; other: ExecutionSymbol; baseLabel: string; otherLabel: string; ratio: number; spreadLabel: string }> = {
  oil: { name: '原油', base: 'CLUSDT', other: 'BZUSDT', baseLabel: 'CL', otherLabel: 'BZ', ratio: 1, spreadLabel: 'BZ − CL' },
  hynix: { name: '海力士', base: 'SKHYNIXUSDT', other: 'SKHYUSDT', baseLabel: '正股', otherLabel: 'ADR', ratio: 10, spreadLabel: 'ADR − 正股 ÷ 10' },
};

export type Book = { bid: number; ask: number; mid: number; digits: number; stale: boolean; at: string };
export type BookRead = { book: Book | null; error: string | null };
export type Spread = { value: number; percent: number; digits: number; stale: boolean };
export type Edge = Spread & { sell: TradingExchange; buy: TradingExchange };

const fraction = (value: string) => value.split('.')[1]?.length ?? 0;
const price = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 ? Number(value) : null;

/** Parses one leg; a leg read more than maxAgeMs before the server reply is stale. */
export function readBook(quotes: ExecutionQuotes, exchange: TradingExchange, symbol: ExecutionSymbol): BookRead {
  const row: ExecutionQuoteBook | undefined = quotes.books.find(book => book.exchange === exchange && book.symbol === symbol);
  if (!row) return { book: null, error: '未取得盘口' };
  if (row.error) return { book: null, error: row.error };
  const bid = price(row.bid), ask = price(row.ask), at = Date.parse(row.at ?? ''), generated = Date.parse(quotes.generatedAt);
  if (bid === null || ask === null || bid >= ask || !Number.isFinite(at) || !Number.isFinite(generated)) return { book: null, error: '盘口不完整' };
  return { book: { bid, ask, mid: (bid + ask) / 2, digits: Math.min(8, Math.max(fraction(row.bid!), fraction(row.ask!)) + 1), stale: generated - at > quotes.maxAgeMs, at: row.at! }, error: null };
}

/** Same-venue spread of a market: other leg minus base leg (base scaled by the market ratio). */
export function venueSpread(market: ExecutionMarket, base: Book | null, other: Book | null): Spread | null {
  if (!base || !other) return null;
  const reference = base.mid / SPREAD_MARKETS[market].ratio;
  return { value: other.mid - reference, percent: (other.mid / reference - 1) * 100, digits: Math.max(base.digits, other.digits), stale: base.stale || other.stale };
}

/** Same contract across venues on mid price: first minus second, percent of second. */
export function crossSpread(first: Book | null, second: Book | null): Spread | null {
  if (!first || !second) return null;
  return { value: first.mid - second.mid, percent: (first.mid / second.mid - 1) * 100, digits: Math.max(first.digits, second.digits), stale: first.stale || second.stale };
}

/** The better of selling at one venue's bid while buying at the other's ask. Negative means no immediate edge. */
export function crossEdge(pair: [TradingExchange, TradingExchange], first: Book | null, second: Book | null): Edge | null {
  if (!first || !second) return null;
  const forward = first.bid - second.ask, backward = second.bid - first.ask;
  const [value, sell, buy, ask] = forward >= backward ? [forward, pair[0], pair[1], second.ask] : [backward, pair[1], pair[0], first.ask];
  return { value, percent: value / ask * 100, sell, buy, digits: Math.max(first.digits, second.digits) - 1, stale: first.stale || second.stale };
}

const plain = (value: number, digits: number) => (Object.is(Math.round(value * 10 ** digits), -0) ? 0 : value).toFixed(digits);
export const formatPrice = (value: number, digits: number) => plain(value, digits);
export const formatSigned = (value: number, digits: number) => { const text = plain(value, digits); return Number(text) > 0 ? `+${text}` : text; };
export const formatPercent = (value: number, digits = 3) => `${formatSigned(value, digits)}%`;
