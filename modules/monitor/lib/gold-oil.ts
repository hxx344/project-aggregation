import { getQuoteStaleAfterMs, type QuoteFreshness } from './market-freshness.ts';

export const GOLD_OIL_INTERVAL_MS = 900_000;
export const GOLD_OIL_QUOTE_MS = 30_000;
export const GOLD_OIL_HISTORY_MS = 60_000;
export const GOLD_OIL_STALE_MS = 75_000;
export const GOLD_OIL_FUNDING_MS = 300_000;
export type GoldOilType = 'cl' | 'bz';
export type GoldOilExchange = 'binance' | 'bybit';
export const GOLD_OIL_EXCHANGES = { binance: { name: 'Binance' }, bybit: { name: 'Bybit' } } as const;
export const GOLD_OIL_VARIANTS = [
  { exchange: 'binance', oilType: 'cl' }, { exchange: 'binance', oilType: 'bz' },
  { exchange: 'bybit', oilType: 'cl' }, { exchange: 'bybit', oilType: 'bz' },
] as const;
export type GoldOilSource = typeof GOLD_OIL_EXCHANGES[GoldOilExchange]['name'];
export function goldOilVariantKey(oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') { return `${exchange}/${oilType}`; }
export function goldOilUnits(oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') {
  return exchange === 'bybit' && oilType === 'bz' ? { ratio: '报价比', oil: 'USDT/BZ' } : { ratio: '桶/盎司', oil: 'USDT/桶' };
}
export const GOLD_OIL_INSTRUMENTS = {
  cl: { symbol: 'CLUSDT', code: 'CL', name: 'WTI 原油' },
  bz: { symbol: 'BZUSDT', code: 'BZ', name: '布伦特原油' },
} as const;
export const GOLD_OIL_SYMBOLS = { cl: 'CLUSDT', xau: 'XAUUSDT' } as const;
export function goldOilAction(action: string, oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') { return `${exchange === 'bybit' ? 'bybit/' : ''}${oilType === 'bz' ? 'bz/' : ''}${action}`; }
export function parseGoldOilAction(action: string): { oilType: GoldOilType; exchange: GoldOilExchange; action: string } | null {
  const exchange = action.startsWith('bybit/') ? 'bybit' : 'binance', path = exchange === 'bybit' ? action.slice(6) : action;
  const oilType = path.startsWith('bz/') ? 'bz' : 'cl', name = oilType === 'bz' ? path.slice(3) : path;
  return ['quote', 'history', 'funding', 'status', 'config', 'events'].includes(name) ? { oilType, exchange, action: name } : null;
}
type Leg = { symbol: string; price: number; updatedAt: string };
export type GoldOilFundingLeg = { rate: number; intervalHours: number; nextFundingAt: string };
export type GoldOilQuote = QuoteFreshness & { oilType: GoldOilType; source: GoldOilSource; currency: 'USDT'; priceBasis: 'mark'; fetchedAt: string; oil: Leg; cl?: Leg; xau: Leg; ratio: number; status: 'live' | 'snapshot'; funding: { oil: GoldOilFundingLeg; cl?: GoldOilFundingLeg; xau: GoldOilFundingLeg } | null };
export type GoldOilPoint = { time: number; oil: number | null; cl?: number | null; xau: number | null; ratio: number | null };
export type GoldOilHistory = { oilType: GoldOilType; source: GoldOilSource; currency: 'USDT'; priceBasis: 'mark'; interval: '15m'; fetchedAt: string; status: 'live' | 'snapshot'; points: GoldOilPoint[]; coverageStart?: number };

/** Only historic Binance CL payloads may omit the variant. */
export function validateGoldOilIdentity(value: Record<string, unknown>, expectedOil: GoldOilType, expectedExchange: GoldOilExchange = 'binance') {
  if (!Object.hasOwn(GOLD_OIL_EXCHANGES, expectedExchange) || value.source !== GOLD_OIL_EXCHANGES[expectedExchange].name) throw Error('Unexpected gold/oil source');
  if (!['cl', 'bz'].includes(expectedOil) || (value.oilType === undefined ? expectedOil !== 'cl' || expectedExchange !== 'binance' : value.oilType !== expectedOil)) throw Error('Unexpected gold/oil variant');
}
function identical(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && identical(a[key], b[key]));
}
/** Enforce aliases before normalizing so no conflicting oil leg can be hidden. */
export function goldOilLegValue(value: Record<string, unknown>, oilType: GoldOilType): unknown {
  const hasOil = Object.hasOwn(value, 'oil'), hasCl = Object.hasOwn(value, 'cl');
  if (oilType === 'bz' && hasCl || hasOil && hasCl && !identical(value.oil, value.cl)) throw Error('Conflicting gold/oil leg');
  return hasOil ? value.oil : oilType === 'cl' ? value.cl : undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid gold/oil data');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw Error('Invalid gold/oil price');
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0) throw Error('Invalid gold/oil time');
  return value;
}
function common(value: Record<string, unknown>, exchange: GoldOilExchange) {
  if (!Object.hasOwn(GOLD_OIL_EXCHANGES, exchange) || value.source !== GOLD_OIL_EXCHANGES[exchange].name || value.currency !== 'USDT' || value.priceBasis !== 'mark' || !['live', 'snapshot'].includes(String(value.status))) throw Error('Invalid gold/oil source');
  return { source: GOLD_OIL_EXCHANGES[exchange].name, currency: 'USDT' as const, priceBasis: 'mark' as const, fetchedAt: stamp(value.fetchedAt), status: value.status as 'live' | 'snapshot' };
}
/** USDT/ounce divided by USDT/barrel gives barrels/ounce. */
export function goldOilRatio(oil: number | null, xau: number | null): number | null {
  if (oil === null || xau === null || !Number.isFinite(oil) || !Number.isFinite(xau) || oil <= 0 || xau <= 0) return null;
  const ratio = xau / oil;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
export function validateGoldOilQuote(input: unknown, expectedOil: GoldOilType = 'cl', expectedExchange: GoldOilExchange = 'binance'): GoldOilQuote {
  const value = object(input), base = common(value, expectedExchange);
  validateGoldOilIdentity(value, expectedOil, expectedExchange);
  const leg = (input: unknown, symbol: string): Leg => {
    const item = object(input);
    if (item.symbol !== symbol) throw Error('Unexpected gold/oil contract');
    return { symbol, price: positive(item.price), updatedAt: stamp(item.updatedAt) };
  };
  const oil = leg(goldOilLegValue(value, expectedOil), GOLD_OIL_INSTRUMENTS[expectedOil].symbol), xau = leg(value.xau, GOLD_OIL_SYMBOLS.xau), times = [Date.parse(oil.updatedAt), Date.parse(xau.updatedAt)];
  const ratio = goldOilRatio(oil.price, xau.price);
  if (Math.abs(times[0] - times[1]) > 15_000 || Date.parse(base.fetchedAt) !== Math.min(...times) || ratio === null) throw Error('Unsynchronized gold/oil quote');
  let funding: GoldOilQuote['funding'] = null;
  if (value.funding != null) {
    const terms = object(value.funding);
    const read = (input: unknown) => {
      const item = object(input), rate = item.rate, hours = positive(item.intervalHours), nextFundingAt = stamp(item.nextFundingAt);
      if (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1 || !Number.isInteger(hours) || hours > 24 || Date.parse(nextFundingAt) < Math.max(...times) - 60_000 || Date.parse(nextFundingAt) > Math.max(...times) + 25 * 3_600_000) throw Error('Invalid gold/oil funding');
      return { rate, intervalHours: hours, nextFundingAt };
    };
    const oil = read(goldOilLegValue(terms, expectedOil));
    funding = { oil, ...(expectedOil === 'cl' ? { cl: oil } : {}), xau: read(terms.xau) };
  }
  const maxAgeMs = getQuoteStaleAfterMs(value as QuoteFreshness, 0);
  return { ...base, oilType: expectedOil, oil, ...(expectedOil === 'cl' ? { cl: oil } : {}), xau, ratio, funding, ...(maxAgeMs ? { collection: { maxAgeMs } } : {}) };
}
export function validateGoldOilHistory(input: unknown, expectedOil: GoldOilType = 'cl', expectedExchange: GoldOilExchange = 'binance'): GoldOilHistory {
  const value = object(input), base = common(value, expectedExchange);
  validateGoldOilIdentity(value, expectedOil, expectedExchange);
  if (value.interval !== '15m' || !Array.isArray(value.points) || !value.points.length || value.points.length > 100_000) throw Error('Invalid gold/oil history');
  let previous = 0;
  const points = value.points.map(item => {
    const row = object(item), time = row.time;
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= previous || time % GOLD_OIL_INTERVAL_MS || time + GOLD_OIL_INTERVAL_MS > Date.parse(base.fetchedAt)) throw Error('Invalid gold/oil candle time');
    previous = time;
    const oilValue = goldOilLegValue(row, expectedOil), oil = oilValue === null ? null : positive(oilValue), xau = row.xau === null ? null : positive(row.xau);
    return { time, oil, ...(expectedOil === 'cl' ? { cl: oil } : {}), xau, ratio: goldOilRatio(oil, xau) };
  });
  if (!points.some(point => point.ratio !== null)) throw Error('No paired gold/oil history');
  if (Date.parse(base.fetchedAt) - points[0].time > 100_000 * GOLD_OIL_INTERVAL_MS) throw Error('Gold/oil history span is too large');
  const coverageStart = value.coverageStart;
  if (coverageStart !== undefined && (typeof coverageStart !== 'number' || !Number.isSafeInteger(coverageStart) || coverageStart <= 0 || coverageStart > points[0].time)) throw Error('Invalid gold/oil history coverage');
  return { ...base, oilType: expectedOil, interval: '15m', points, ...(typeof coverageStart === 'number' ? { coverageStart } : {}) };
}

/** Include explicit nulls so charts cannot join across a missing period. */
export function goldOilChartPoints(history: GoldOilHistory | null, days: number | '1m') {
  if (!history?.points.length) return [];
  const end = Math.floor(Date.parse(history.fetchedAt) / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  let cutoff = end;
  if (days === '1m') {
    const date = new Date(end), month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
    const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    month.setUTCHours(date.getUTCHours(), date.getUTCMinutes());
    cutoff = month.getTime();
  } else cutoff = end - days * 86_400_000;
  const first = history.coverageStart === undefined ? history.points[0].time : Math.ceil(history.coverageStart / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  const start = days === 0 ? first : Math.max(first, cutoff);
  const points = new Map(history.points.map(point => [point.time, point]));
  const rows: GoldOilPoint[] = [];
  for (let time = start; time < end; time += GOLD_OIL_INTERVAL_MS) rows.push(points.get(time) ?? { time, oil: null, ...(history.oilType === 'cl' ? { cl: null } : {}), xau: null, ratio: null });
  return rows;
}
