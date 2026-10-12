export const OIL_HEDGE_PRICES_ACTION = 'funding-hedge/prices';
export const HEDGE_HOUR_MS = 3_600_000;
export const HEDGE_WINDOW_MS = 60 * 24 * HEDGE_HOUR_MS;
export const HEDGE_PRICES_REFRESH_MS = 300_000;
export const HEDGE_PRICES_STALE_MS = HEDGE_PRICES_REFRESH_MS * 2 + 15_000;

export type HedgeExchange = 'bybit' | 'binance';
export type HedgeSymbol = 'BZUSDT' | 'CLUSDT';
export type HedgePriceRow = { time: number; price: number };
export type HedgePriceRange = { from: number; to: number };
export type HedgePriceLeg = {
  exchange: HedgeExchange;
  symbol: HedgeSymbol;
  fetchedAt: string | null;
  error: string;
  /** Queried bounds only: a missing hour remains missing within this range. */
  coverage: HedgePriceRange | null;
  rows: HedgePriceRow[];
};
export type OilHedgePrices = {
  monitorId: 'oil';
  currency: 'USDT';
  intervalMs: typeof HEDGE_HOUR_MS;
  priceBasis: 'hour-open-mark';
  fetchedAt: string;
  status: 'live' | 'snapshot';
  legs: HedgePriceLeg[];
};

export const HEDGE_PRICE_LEGS: ReadonlyArray<Readonly<Pick<HedgePriceLeg, 'exchange' | 'symbol'>>> = [
  { exchange: 'bybit', symbol: 'BZUSDT' },
  { exchange: 'bybit', symbol: 'CLUSDT' },
  { exchange: 'binance', symbol: 'BZUSDT' },
  { exchange: 'binance', symbol: 'CLUSDT' },
];

export function hedgePriceRange(now: number): HedgePriceRange {
  return { from: Math.ceil((now - HEDGE_WINDOW_MS) / HEDGE_HOUR_MS) * HEDGE_HOUR_MS, to: Math.floor(now / HEDGE_HOUR_MS) * HEDGE_HOUR_MS };
}

const validHour = (time: unknown): time is number => typeof time === 'number' && Number.isSafeInteger(time) && time >= Date.UTC(2020, 0, 1) && time % HEDGE_HOUR_MS === 0;
const validStamp = (time: unknown): time is string => typeof time === 'string' && Number.isFinite(Date.parse(time));

export function validateOilHedgePrices(input: unknown): OilHedgePrices {
  const value = input as OilHedgePrices;
  if (!value || value.monitorId !== 'oil' || value.currency !== 'USDT' || value.intervalMs !== HEDGE_HOUR_MS || value.priceBasis !== 'hour-open-mark' || !validStamp(value.fetchedAt) || !['live', 'snapshot'].includes(value.status) || !Array.isArray(value.legs) || value.legs.length !== HEDGE_PRICE_LEGS.length) throw Error('Invalid oil hedge prices');
  const now = Date.parse(value.fetchedAt), range = hedgePriceRange(now);
  const seenLegs = new Set<string>();
  for (const leg of value.legs) {
    if (!leg || !HEDGE_PRICE_LEGS.some(item => item.exchange === leg.exchange && item.symbol === leg.symbol) || seenLegs.has(`${leg.exchange}/${leg.symbol}`) || typeof leg.error !== 'string' || !Array.isArray(leg.rows) || leg.rows.length > 1441 || (leg.fetchedAt !== null && (!validStamp(leg.fetchedAt) || Date.parse(leg.fetchedAt) > now))) throw Error('Invalid hedge price leg');
    seenLegs.add(`${leg.exchange}/${leg.symbol}`);
    const coverage = leg.coverage;
    if (coverage !== null && (!coverage || !validHour(coverage.from) || !validHour(coverage.to) || coverage.from < range.from || coverage.to > range.to || coverage.from > coverage.to || leg.fetchedAt === null || coverage.to > Date.parse(leg.fetchedAt))) throw Error('Invalid hedge price query coverage');
    const seenTimes = new Set<number>();
    for (const row of leg.rows) {
      if (!row || !validHour(row.time) || row.time < range.from || row.time > range.to || seenTimes.has(row.time) || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0 || leg.fetchedAt === null || row.time > Date.parse(leg.fetchedAt) || (coverage !== null && (row.time < coverage.from || row.time > coverage.to))) throw Error('Invalid hourly mark price');
      seenTimes.add(row.time);
    }
  }
  return { monitorId: 'oil', currency: 'USDT', intervalMs: HEDGE_HOUR_MS, priceBasis: 'hour-open-mark', fetchedAt: value.fetchedAt, status: value.status,
    legs: HEDGE_PRICE_LEGS.map(identity => {
      const leg = value.legs.find(item => item.exchange === identity.exchange && item.symbol === identity.symbol)!;
      return { ...identity, fetchedAt: leg.fetchedAt, error: leg.error, coverage: leg.coverage === null ? null : { ...leg.coverage }, rows: leg.rows.map(row => ({ time: row.time, price: row.price })).sort((a, b) => a.time - b.time) };
    }),
  };
}
