import { GOLD_OIL_INSTRUMENTS, GOLD_OIL_INTERVAL_MS, GOLD_OIL_STALE_MS, GOLD_OIL_SYMBOLS, validateGoldOilQuote, validateGoldOilHistory, type GoldOilHistory, type GoldOilType, type GoldOilExchange } from './gold-oil.ts';
import { parseGoldOilFunding, validateGoldOilFunding, type GoldOilFundingHistory } from './gold-oil-funding.ts';
import { createBybitGoldOilReader } from './gold-oil-bybit-service.ts';

function number(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw Error('Invalid Binance number');
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Binance response');
  return value as Record<string, unknown>;
}
export function validateGoldOilContracts(input: unknown, oilType: GoldOilType = 'cl') {
  const symbols = object(input).symbols;
  if (!Array.isArray(symbols)) throw Error('Missing Binance contracts');
  for (const [base, symbol] of [[oilType, GOLD_OIL_INSTRUMENTS[oilType].symbol], ['xau', GOLD_OIL_SYMBOLS.xau]]) {
    const matches = symbols.map(object).filter(item => item.symbol === symbol), spec = matches[0];
    if (matches.length !== 1 || spec.status !== 'TRADING' || !['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(String(spec.contractType)) || spec.baseAsset !== base.toUpperCase() || spec.quoteAsset !== 'USDT' || spec.marginAsset !== 'USDT') throw Error('Unsupported Binance gold/oil contract');
  }
}
export function parseGoldOilQuote(oilInput: unknown, xauInput: unknown, now = Date.now(), fundingInfo: unknown = null, oilType: GoldOilType = 'cl') {
  const leg = (input: unknown, symbol: string) => {
    const value = object(input), time = number(value.time);
    if (value.symbol !== symbol || !Number.isSafeInteger(time) || time < now - GOLD_OIL_STALE_MS || time > now + 1000) throw Error('Delayed or unexpected Binance quote');
    return { symbol, price: number(value.markPrice), updatedAt: new Date(time).toISOString() };
  };
  const oil = leg(oilInput, GOLD_OIL_INSTRUMENTS[oilType].symbol), xau = leg(xauInput, GOLD_OIL_SYMBOLS.xau);
  const base = { oilType, source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(Math.min(Date.parse(oil.updatedAt), Date.parse(xau.updatedAt))).toISOString(), oil, xau };
  try {
    if (!Array.isArray(fundingInfo)) throw Error('Missing funding terms');
    const terms = (symbol: string, input: unknown) => {
      const matches = fundingInfo.map(object).filter(row => row.symbol === symbol), ticker = object(input);
      if (matches.length !== 1) throw Error('Missing funding interval');
      return { rate: number(ticker.lastFundingRate), intervalHours: number(matches[0].fundingIntervalHours), nextFundingAt: new Date(number(ticker.nextFundingTime)).toISOString() };
    };
    return validateGoldOilQuote({ ...base, funding: { oil: terms(oil.symbol, oilInput), xau: terms(xau.symbol, xauInput) } }, oilType);
  } catch { return validateGoldOilQuote(base, oilType); }
}
export function parseGoldOilHistory(oilInput: unknown, xauInput: unknown, now = Date.now(), previous: GoldOilHistory | null = null, coverageStart?: number, oilType: GoldOilType = 'cl') {
  if (previous) previous = validateGoldOilHistory(previous, oilType);
  const end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  const candles = (input: unknown) => {
    if (!Array.isArray(input) || !input.length) throw Error('Missing Binance candles');
    const values = new Map<number, number>();
    for (const row of input) {
      if (!Array.isArray(row) || row.length < 7) throw Error('Invalid Binance candle');
      const time = number(row[0]), close = number(row[6]), price = number(row[4]);
      if (!Number.isSafeInteger(time) || time % GOLD_OIL_INTERVAL_MS || close !== time + GOLD_OIL_INTERVAL_MS - 1 || price <= 0 || values.has(time)) throw Error('Invalid Binance candle');
      if (time > 0 && time < end) values.set(time, price);
    }
    return values;
  };
  const oil = candles(oilInput), xau = candles(xauInput);
  // Keep genuine prior observations when an upstream page omits an older candle.
  if (previous) for (const row of previous.points) {
    if (row.time >= end) continue;
    if (!oil.has(row.time) && row.oil !== null) oil.set(row.time, row.oil);
    if (!xau.has(row.time) && row.xau !== null) xau.set(row.time, row.xau);
  }
  const points = [...new Set([...oil.keys(), ...xau.keys()])].sort((a, b) => a - b).map(time => ({ time, oil: oil.get(time) ?? null, xau: xau.get(time) ?? null }));
  return validateGoldOilHistory({ oilType, source: 'Binance', currency: 'USDT', priceBasis: 'mark', interval: '15m', status: 'live', fetchedAt: new Date(now).toISOString(), points, ...(coverageStart === undefined ? {} : { coverageStart: Math.min(coverageStart, previous?.coverageStart ?? coverageStart) }) }, oilType);
}

export function createGoldOilReader({ oilType = 'cl', exchange = 'binance', fetcher = fetch, clock = Date.now }: { oilType?: GoldOilType; exchange?: GoldOilExchange; fetcher?: typeof fetch; clock?: () => number } = {}) {
  if (!['cl', 'bz'].includes(oilType) || !['binance', 'bybit'].includes(exchange)) throw Error('Unsupported gold/oil variant');
  if (exchange === 'bybit') return createBybitGoldOilReader({ oilType, fetcher, clock });
  const symbols = [GOLD_OIL_INSTRUMENTS[oilType].symbol, GOLD_OIL_SYMBOLS.xau];
  let metadataUntil = 0, commonStart = 0, pendingMetadata: Promise<void> | undefined;
  let fundingUntil = 0, fundingInfo: unknown = null, pendingFunding: Promise<unknown> | undefined;
  let latestHistory: GoldOilHistory | null = null, latestFunding: GoldOilFundingHistory | null = null;
  async function request(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, 'https://fapi.binance.com'); url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.href, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw Error(`Binance HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
  function metadata() {
    if (clock() < metadataUntil) return Promise.resolve();
    pendingMetadata ??= request('/fapi/v1/exchangeInfo').then(value => {
      validateGoldOilContracts(value, oilType);
      const items = object(value).symbols as Record<string, unknown>[];
      const dates = symbols.map(symbol => number(items.find(item => item.symbol === symbol)?.onboardDate));
      if (dates.some(date => !Number.isSafeInteger(date) || date <= 0 || date > clock())) throw Error('Invalid contract listing date');
      commonStart = Math.ceil(Math.max(...dates) / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
      metadataUntil = clock() + 300_000;
    }).finally(() => { pendingMetadata = undefined; });
    return pendingMetadata;
  }
  function fundingTerms() {
    if (clock() < fundingUntil) return Promise.resolve(fundingInfo);
    pendingFunding ??= request('/fapi/v1/fundingInfo').then(value => { fundingInfo = value; fundingUntil = clock() + 300_000; return value; }).finally(() => { pendingFunding = undefined; });
    return pendingFunding.catch(() => null);
  }
  async function pages(path: string, symbol: string, start: number, end: number, candles: boolean) {
    let cursor = start;
    const rows: unknown[] = [], limit = 1000;
    for (let page = 0; page < 200 && cursor < end; page++) {
      const batch = await request(path, { symbol, startTime: String(cursor), endTime: String(end - 1), limit: String(limit), ...(candles ? { interval: '15m' } : {}) });
      if (!Array.isArray(batch)) throw Error('Invalid Binance history page');
      let last = cursor - 1;
      for (const item of batch) {
        const time = candles ? Array.isArray(item) ? number(item[0]) : NaN : number(object(item).fundingTime);
        if (!Number.isSafeInteger(time) || time < cursor || time <= last || time >= end) throw Error('Invalid Binance pagination');
        last = time; rows.push(item);
      }
      if (batch.length < limit) return rows;
      cursor = last + (candles ? GOLD_OIL_INTERVAL_MS : 1);
    }
    if (cursor < end) throw Error('Binance pagination limit exceeded');
    return rows;
  }
  return {
    async quote() {
      const [, oil, xau, funding] = await Promise.all([metadata(), ...symbols.map(symbol => request('/fapi/v1/premiumIndex', { symbol })), fundingTerms()]);
      return parseGoldOilQuote(oil, xau, clock(), funding, oilType);
    },
    async history(previous: GoldOilHistory | null = null) {
      previous ??= latestHistory;
      if (previous) previous = validateGoldOilHistory(previous, oilType);
      await metadata();
      const now = clock(), end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
      let start = previous?.coverageStart !== undefined && previous.coverageStart <= commonStart ? Math.max(commonStart, previous.points.at(-1)!.time - 86_400_000) : commonStart;
      let expected = commonStart;
      for (const row of previous?.points ?? []) { if (row.time > expected) start = Math.min(start, expected); if (row.oil === null || row.xau === null) start = Math.min(start, row.time); expected = row.time + GOLD_OIL_INTERVAL_MS; }
      const [oil, xau] = await Promise.all(symbols.map(symbol => pages('/fapi/v1/markPriceKlines', symbol, start, end, true)));
      latestHistory = parseGoldOilHistory(oil, xau, now, previous, start, oilType);
      return latestHistory;
    },
    async funding(previous: GoldOilFundingHistory | null = null) {
      previous ??= latestFunding;
      if (previous) previous = validateGoldOilFunding(previous, oilType);
      await metadata();
      const now = clock(), start = previous && previous.coverageStart <= commonStart ? Math.max(commonStart, previous.coverageEnd - 2 * 86_400_000) : commonStart;
      const [oil, xau] = await Promise.all(symbols.map(symbol => pages('/fapi/v1/fundingRate', symbol, start, now, false)));
      latestFunding = parseGoldOilFunding(oil, xau, start, now, now, previous, oilType);
      return latestFunding;
    },
  };
}
export const goldOilReader = createGoldOilReader();
export const goldOilBzReader = createGoldOilReader({ oilType: 'bz' });
export const goldOilBybitReader = createGoldOilReader({ exchange: 'bybit' });
export const goldOilBybitBzReader = createGoldOilReader({ oilType: 'bz', exchange: 'bybit' });
