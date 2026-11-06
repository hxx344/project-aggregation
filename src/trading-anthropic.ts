import type { AnthropicShares, AnthropicSymbol, ExecutionExchange } from './trading-execution-types';
import type { Book, BookRead } from './trading-spread';

/**
 * Anthropic pre-IPO contracts quote different units. Per native unit
 * (mirrors server/trading-execution-plan.mjs SHARE_BASIS):
 * Binance quotes valuation per 1B reference shares, so one unit is S shares
 * (S = outstanding, billions); OKX was rebased to per 10B, one contract is
 * S / 10 shares; Entropy io:ANTH settles valuation per 1B fully diluted
 * shares, one unit is F shares; trade.xyz xyz:ANT is one Class A share.
 * Per-share price = quote ÷ shares per unit. These are assumptions about a
 * future listing; values here are floats for display only.
 */
export type AnthropicContract = { exchange: ExecutionExchange; symbol: AnthropicSymbol; venue: string; label: string; basis: keyof AnthropicShares | null; divisor: number };
export const ANTHROPIC_CONTRACTS: AnthropicContract[] = [
  { exchange: 'hyperliquid', symbol: 'io:ANTH', venue: 'Entropy', label: 'Hyperliquid io:ANTH（Entropy）', basis: 'diluted', divisor: 1 },
  { exchange: 'hyperliquid', symbol: 'xyz:ANT', venue: 'trade.xyz', label: 'Hyperliquid xyz:ANT（trade.xyz）', basis: null, divisor: 1 },
  { exchange: 'binance', symbol: 'ANTHROPICUSDT', venue: 'Binance', label: 'Binance ANTHROPICUSDT', basis: 'outstanding', divisor: 1 },
  { exchange: 'okx', symbol: 'ANTHROPICUSDT', venue: 'OKX', label: 'OKX ANTHROPIC-USDT-SWAP', basis: 'outstanding', divisor: 10 },
];
export const DEFAULT_SHARES: AnthropicShares = { outstanding: '12.7', diluted: '16.7' };
export const contractKey = (contract: Pick<AnthropicContract, 'exchange' | 'symbol'>) => `${contract.exchange}:${contract.symbol}`;
export const findContract = (key: string) => ANTHROPIC_CONTRACTS.find(contract => contractKey(contract) === key) ?? null;

const decimal = /^\d+(?:\.\d{1,18})?$/;
/** Same bounds as the server: each 1–100 billion, fully diluted at least outstanding. Returns an error or null. */
export function sharesProblem(shares: AnthropicShares): string | null {
  const values = [shares.outstanding.trim(), shares.diluted.trim()];
  if (values.some(value => !decimal.test(value) || Number(value) < 1 || Number(value) > 100)) return '股数假设须为 1 至 100 之间的十亿股数。';
  if (Number(values[1]) < Number(values[0])) return '完全稀释股数不能小于流通股数。';
  return null;
}
export function sharesPerUnit(contract: AnthropicContract, shares: AnthropicShares): number | null {
  if (sharesProblem(shares)) return null;
  return contract.basis ? Number(shares[contract.basis]) / contract.divisor : 1;
}

export type ShareBook = { contract: AnthropicContract; read: BookRead; perUnit: number | null; bid: number | null; ask: number | null; mid: number | null; stale: boolean };
/** `readContract` is the caller's book reader (readBook in the page), keeping this module free of value imports. */
export function shareBooks(readContract: (contract: AnthropicContract) => BookRead, shares: AnthropicShares): ShareBook[] {
  return ANTHROPIC_CONTRACTS.map(contract => {
    const read = readContract(contract), perUnit = sharesPerUnit(contract, shares), book: Book | null = read.book;
    const per = (value: number | undefined) => book && perUnit ? value! / perUnit : null;
    return { contract, read, perUnit, bid: per(book?.bid), ask: per(book?.ask), mid: per(book?.mid), stale: !!book?.stale };
  });
}

/**
 * Executable gap for buying `long` at its ask and selling `short` at its bid,
 * both per share: (short bid − long ask) ÷ long ask. It is the convergence
 * space if both settle to the same share price, not a guaranteed return
 * (fees, funding, margin and the share-count assumptions are excluded).
 * Hedge ratio: native units of `short` per unit of `long` at equal shares.
 */
export type AnthropicPair = { long: ShareBook; short: ShareBook; gap: number; ratio: number; stale: boolean };
export function pairOf(long: ShareBook, short: ShareBook): AnthropicPair | null {
  if (long.ask === null || short.bid === null || !long.perUnit || !short.perUnit) return null;
  return { long, short, gap: (short.bid - long.ask) / long.ask * 100, ratio: long.perUnit / short.perUnit, stale: long.stale || short.stale };
}
/** Each pair of contracts once, in its better direction, widest gap first. */
export function bestPairs(books: ShareBook[]): AnthropicPair[] {
  const pairs: AnthropicPair[] = [];
  books.forEach((first, index) => books.slice(index + 1).forEach(second => {
    const options = [pairOf(first, second), pairOf(second, first)].filter((pair): pair is AnthropicPair => pair !== null);
    if (options.length) pairs.push(options.reduce((best, pair) => pair.gap > best.gap ? pair : best));
  }));
  return pairs.sort((a, b) => b.gap - a.gap);
}
