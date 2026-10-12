import { HEDGE_HOUR_MS, HEDGE_PRICE_LEGS, hedgePriceRange, validateOilHedgePrices, type HedgeExchange, type HedgeSymbol, type HedgePriceRange, type HedgePriceRow, type OilHedgePrices } from './oil-hedge-prices.ts';

const PAGE_LIMIT = 1000;
const number = (input: unknown) => {
  if ((typeof input !== 'number' && typeof input !== 'string') || String(input).trim() === '' || !Number.isFinite(Number(input))) throw Error('Invalid mark price number');
  return Number(input);
};

function parseRows(input: unknown, range: HedgePriceRange): HedgePriceRow[] {
  if (!Array.isArray(input) || input.length > PAGE_LIMIT) throw Error('Invalid mark price page');
  const seen = new Set<number>();
  return input.map(row => {
    if (!Array.isArray(row) || row.length < 2) throw Error('Invalid mark price candle');
    // Only the hour's opening mark is usable at its timestamp, never the future close.
    const time = number(row[0]), price = number(row[1]);
    if (!Number.isSafeInteger(time) || time % HEDGE_HOUR_MS !== 0 || time < range.from || time > range.to || price <= 0 || seen.has(time)) throw Error('Invalid mark price time or price');
    seen.add(time);
    return { time, price };
  }).sort((a, b) => a.time - b.time);
}

/** https://bybit-exchange.github.io/docs/v5/market/mark-kline */
export function parseBybitMarkPrices(input: unknown, symbol: HedgeSymbol, range: HedgePriceRange): HedgePriceRow[] {
  const value = input as { retCode?: unknown; result?: { symbol?: unknown; category?: unknown; list?: unknown } };
  if (!value || value.retCode !== 0 || value.result?.symbol !== symbol || value.result?.category !== 'linear') throw Error('Bybit mark price contract mismatch');
  return parseRows(value.result.list, range);
}

/** https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price-Kline-Candlestick-Data */
export function parseBinanceMarkPrices(input: unknown, range: HedgePriceRange): HedgePriceRow[] {
  return parseRows(input, range);
}

function oldestInternalGap(rows: HedgePriceRow[], window: HedgePriceRange, recentFrom: number): HedgePriceRange | null {
  // Only gaps bracketed by actual records are repair candidates. A contract's
  // empty pre-listing prefix or not-yet-published tail must not force backfill.
  for (let index = 1; index < rows.length; index++) {
    const from = Math.max(window.from, rows[index - 1].time + HEDGE_HOUR_MS);
    if (from >= rows[index].time || from >= recentFrom) continue;
    return { from, to: Math.min(from + 23 * HEDGE_HOUR_MS, recentFrom - HEDGE_HOUR_MS, rows[rows.length - 1].time - HEDGE_HOUR_MS) };
  }
  return null;
}

export function createOilHedgePricesReader({ fetcher = fetch, clock = Date.now } = {}) {
  async function request(url: string): Promise<unknown> {
    const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw Error(`Mark price history HTTP ${response.status}`);
    return response.json();
  }
  async function readLeg(exchange: HedgeExchange, symbol: HedgeSymbol, range: HedgePriceRange) {
    const rows: HedgePriceRow[] = [];
    // Every inclusive window contains at most 1000 possible hours, so the API's
    // cap cannot silently truncate it. Empty/sparse windows never stop backfill.
    for (let from = range.from; from <= range.to; from += PAGE_LIMIT * HEDGE_HOUR_MS) {
      const to = Math.min(range.to, from + (PAGE_LIMIT - 1) * HEDGE_HOUR_MS);
      if (exchange === 'bybit') {
        const query = new URLSearchParams({ category: 'linear', symbol, interval: '60', start: String(from), end: String(to), limit: String(PAGE_LIMIT) });
        rows.push(...parseBybitMarkPrices(await request(`https://api.bybit.com/v5/market/mark-price-kline?${query}`), symbol, { from, to }));
      } else {
        const query = new URLSearchParams({ symbol, interval: '1h', startTime: String(from), endTime: String(to), limit: String(PAGE_LIMIT) });
        rows.push(...parseBinanceMarkPrices(await request(`https://fapi.binance.com/fapi/v1/markPriceKlines?${query}`), { from, to }));
      }
    }
    return rows;
  }
  return async (previous?: OilHedgePrices | null): Promise<OilHedgePrices> => {
    const startedAt = clock(), coverage = hedgePriceRange(startedAt);
    const old = previous ? validateOilHedgePrices(previous) : null;
    if (old && Date.parse(old.fetchedAt) > startedAt) throw Error('Hedge price clock moved backwards');
    const ranges = HEDGE_PRICE_LEGS.map((_, index) => {
      const previousCoverage = old?.legs[index].coverage;
      const from = previousCoverage && previousCoverage.from <= coverage.from && previousCoverage.to >= coverage.from ? Math.max(coverage.from, previousCoverage.to - 24 * HEDGE_HOUR_MS) : coverage.from;
      return { from, to: coverage.to };
    });
    const results = await Promise.allSettled(HEDGE_PRICE_LEGS.map(async (leg, index) => {
      const rows = await readLeg(leg.exchange, leg.symbol, ranges[index]);
      const repair = oldestInternalGap(old?.legs[index].rows ?? [], coverage, ranges[index].from);
      // At most one additional 24-hour window per leg. If it is still empty,
      // the gap remains in rows and will be retried on the next refresh.
      if (repair) rows.push(...await readLeg(leg.exchange, leg.symbol, repair));
      // A repair request failure rejects the whole leg, preserving its previous
      // records, coverage and source time through the same partial-failure path.
      return rows;
    }));
    if (results.every(result => result.status === 'rejected')) throw Error('Hourly mark price history unavailable');
    const fetchedAt = new Date(startedAt).toISOString();
    const legs = HEDGE_PRICE_LEGS.map((identity, index) => {
      const result = results[index], previousLeg = old?.legs[index];
      const merged = new Map((previousLeg?.rows ?? []).map(row => [row.time, row]));
      if (result.status === 'fulfilled') for (const row of result.value) merged.set(row.time, row);
      const rows = [...merged.values()].filter(row => row.time >= coverage.from && row.time <= coverage.to);
      const previousCoverage = previousLeg?.coverage;
      const retainedCoverage = previousCoverage && previousCoverage.to >= coverage.from ? { from: Math.max(previousCoverage.from, coverage.from), to: previousCoverage.to } : null;
      return { ...identity, fetchedAt: result.status === 'fulfilled' ? fetchedAt : previousLeg?.fetchedAt ?? null,
        error: result.status === 'fulfilled' ? '' : '本合约小时标记价格暂时读取失败，保留上次成功记录。',
        coverage: result.status === 'fulfilled' ? coverage : retainedCoverage, rows };
    });
    return validateOilHedgePrices({ monitorId: 'oil', currency: 'USDT', intervalMs: HEDGE_HOUR_MS, priceBasis: 'hour-open-mark', fetchedAt, status: 'live', legs });
  };
}

export const readOilHedgePrices = createOilHedgePricesReader();
