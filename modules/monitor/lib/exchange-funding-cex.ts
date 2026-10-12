import { HISTORY_WINDOW_MS, type FundingHistoryRange, type SettledFundingRecord } from './exchange-funding-history.ts';

export type CexFundingExchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'aster';
type JsonObject = Record<string, unknown>;
type ReaderOptions = {
  request: (url: string, init?: RequestInit) => Promise<unknown>;
  clock?: () => number;
  /** Server-owned exact contracts from a validated market directory. Oil callers omit this. */
  contracts?: Partial<Record<CexFundingExchange, readonly string[]>>;
  bitgetProductType?: 'USDT-FUTURES' | 'USDC-FUTURES';
  /** Optional contiguous progress for the owning durable contract cache. */
  onProgress?: (progress: { coverage: FundingHistoryRange; records: SettledFundingRecord[] }) => void;
};
const PAGE_SIZES: Record<CexFundingExchange, number> = { binance: 1000, bybit: 200, okx: 400, bitget: 100, aster: 1000 };
const MAX_PAGES = 32;
const symbols: Record<CexFundingExchange, readonly string[]> = {
  binance: ['BZUSDT', 'CLUSDT'],
  bybit: ['BZUSDT', 'CLUSDT'],
  okx: ['BZ-USDT-SWAP', 'CL-USDT-SWAP'],
  bitget: ['BZUSDT', 'CLUSDT'],
  aster: [],
};

function validateContract(exchange: CexFundingExchange, symbol: string, contracts: ReaderOptions['contracts'] = symbols) {
  if (!Object.hasOwn(PAGE_SIZES, exchange) || !contracts || !Object.hasOwn(contracts, exchange) || !contracts[exchange]?.includes(symbol)) throw new Error('Unsupported CEX oil funding contract');
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CEX funding response');
  return value as JsonObject;
}
function number(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new Error('Invalid CEX funding number');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid CEX funding number');
  return result;
}
function timestamp(value: unknown): number {
  const time = number(value);
  // These APIs use Unix milliseconds. A seconds timestamp must not become a
  // plausible-looking 1970 settlement, and sub-millisecond data is invalid.
  if (!Number.isSafeInteger(time) || time < 1_000_000_000_000) throw new Error('Invalid CEX funding timestamp');
  return time;
}
function rows(exchange: CexFundingExchange, input: unknown): unknown[] {
  if (exchange === 'binance' || exchange === 'aster') {
    if (!Array.isArray(input)) throw new Error('Binance funding history response failed');
    return input;
  }
  const response = object(input);
  if (exchange === 'bybit') {
    if (response.retCode !== 0) throw new Error('Bybit funding history response failed');
    const result = object(response.result);
    if (result.category !== undefined && result.category !== 'linear') throw new Error('Invalid Bybit funding category');
    if (!Array.isArray(result.list)) throw new Error('Invalid Bybit funding history list');
    return result.list;
  }
  if (response.code !== (exchange === 'okx' ? '0' : '00000') || !Array.isArray(response.data)) throw new Error('CEX funding history response failed');
  return response.data;
}

/** Rates are decimal amounts for the actual settlement, never hourly forecasts. */
export function parseCexFundingHistory(exchange: CexFundingExchange, symbol: string, input: unknown, now = Date.now()): SettledFundingRecord[] {
  validateContract(exchange, symbol);
  return parseFundingPage(exchange, symbol, input, now);
}

function parseFundingPage(exchange: CexFundingExchange, symbol: string, input: unknown, now: number): SettledFundingRecord[] {
  timestamp(now);
  const records = new Map<number, number>();
  for (const value of rows(exchange, input)) {
    const row = object(value), identity = exchange === 'okx' ? row.instId : row.symbol;
    if (identity !== undefined && identity !== symbol) throw new Error('CEX funding contract mismatch');
    if ((exchange === 'binance' || exchange === 'aster') && row.rateType !== undefined && row.rateType !== 'Regular') throw new Error('Unsupported funding rate type');
    if (exchange === 'okx' && row.instType !== undefined && row.instType !== 'SWAP') throw new Error('Invalid OKX funding instrument');
    const time = timestamp(exchange === 'bybit' ? row.fundingRateTimestamp : row.fundingTime);
    // OKX calls fundingRate predicted and realizedRate actual. A historical
    // next_period method still has an actual realizedRate; no forecast fallback.
    const rate = number(exchange === 'okx' ? row.realizedRate : row.fundingRate);
    if (Math.abs(rate) > 1) throw new Error('Invalid CEX funding rate');
    if (time > now) continue;
    if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
    records.set(time, rate);
  }
  return [...records].sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
}

/** Read the complete requested settlement interval; transport owns HTTP checks/timeouts. */
export function createCexFundingHistoryReader({ request, clock = Date.now, contracts = symbols, bitgetProductType = 'USDT-FUTURES', onProgress }: ReaderOptions) {
  return async (exchange: CexFundingExchange, symbol: string, range?: FundingHistoryRange): Promise<SettledFundingRecord[]> => {
    validateContract(exchange, symbol, contracts);
    if (exchange === 'bitget' && !['USDT-FUTURES', 'USDC-FUTURES'].includes(bitgetProductType)) throw new Error('Invalid Bitget funding product type');
    const now = timestamp(clock());
    const from = timestamp(range?.from ?? now - HISTORY_WINDOW_MS), to = timestamp(range?.to ?? now);
    if (from > to || to > now) throw new Error('Invalid CEX funding history range');
    const pageSize = PAGE_SIZES[exchange], records = new Map<number, number>();
    const forward = exchange === 'binance' || exchange === 'aster';
    let cursor = forward ? from : exchange === 'okx' ? to + 1 : to;
    let previousOldest = Infinity;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let url: URL;
      if (forward) {
        // Binance and Aster return the earliest results from an inclusive startTime.
        // https://asterdex.github.io/aster-api-website/futures/market-data/#get-funding-rate-history
        url = new URL(exchange === 'aster' ? 'https://fapi.asterdex.com/fapi/v1/fundingRate' : 'https://fapi.binance.com/fapi/v1/fundingRate');
        url.search = new URLSearchParams({ symbol, limit: String(pageSize), startTime: String(cursor), endTime: String(to) }).toString();
      } else if (exchange === 'bybit') {
        url = new URL('https://api.bybit.com/v5/market/funding/history');
        url.search = new URLSearchParams({ category: 'linear', symbol, limit: String(pageSize), endTime: String(cursor) }).toString();
      } else if (exchange === 'okx') {
        // OKX after means strictly earlier; to + 1 includes a settlement at to.
        url = new URL('https://www.okx.com/api/v5/public/funding-rate-history');
        url.search = new URLSearchParams({ instId: symbol, limit: String(pageSize), after: String(cursor) }).toString();
      } else {
        // Bitget has no time cursor. Deduplication also handles page offsets
        // shifting when a new settlement appears during this read.
        url = new URL('https://api.bitget.com/api/v2/mix/market/history-fund-rate');
        url.search = new URLSearchParams({ symbol, productType: bitgetProductType, pageSize: String(pageSize), pageNo: String(page) }).toString();
      }
      const response = await request(url.toString()), rawCount = rows(exchange, response).length;
      if (!rawCount) break;
      if (rawCount > pageSize) throw new Error('Invalid CEX funding history page size');
      const settlements = parseFundingPage(exchange, symbol, response, now);
      if (!settlements.length) throw new Error('CEX funding history pagination did not advance');
      const oldest = settlements[0].time, newest = settlements[settlements.length - 1].time;
      if (exchange !== 'bitget' && newest > to) throw new Error('Invalid CEX funding history page range');
      for (const { time, rate } of settlements) {
        if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
        records.set(time, rate);
      }
      if (forward ? newest < cursor : oldest >= previousOldest || (exchange === 'bybit' && oldest > cursor) || (exchange === 'okx' && oldest >= cursor)) {
        throw new Error('CEX funding history pagination did not advance');
      }
      // Bitget lacks a time cursor. Save only the verified contiguous portion
      // reached by this page, so a later page failure need not lose earlier work.
      if (exchange === 'bitget' && onProgress && oldest <= to) {
        const coverage = { from: Math.max(from, oldest), to };
        onProgress({ coverage, records: [...records].filter(([time]) => time >= coverage.from && time <= to).sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate })) });
      }
      if (rawCount < pageSize || (forward ? newest >= to : oldest <= from)) break;
      if (page === MAX_PAGES) throw new Error('CEX funding history pagination exceeded page limit');
      previousOldest = oldest;
      cursor = forward ? newest + 1 : exchange === 'okx' ? oldest : oldest - 1;
    }
    return [...records].filter(([time]) => time >= from && time <= to).sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
  };
}
