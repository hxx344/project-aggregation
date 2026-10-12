import { GOLD_OIL_INSTRUMENTS, GOLD_OIL_INTERVAL_MS, GOLD_OIL_STALE_MS, GOLD_OIL_SYMBOLS, validateGoldOilQuote, validateGoldOilHistory, type GoldOilHistory, type GoldOilType } from './gold-oil.ts';
import { validateGoldOilFunding, type FundingEvent, type GoldOilFundingHistory } from './gold-oil-funding.ts';

function number(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw Error('Invalid Bybit number');
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Bybit response');
  return value as Record<string, unknown>;
}
function envelope(input: unknown, now: number) {
  const value = object(input), result = object(value.result), time = number(value.time);
  if (value.retCode !== 0 || result.category !== 'linear' || !Array.isArray(result.list) || !Number.isSafeInteger(time) || time <= 0 || time < now - GOLD_OIL_STALE_MS || time > now + 1000) throw Error('Delayed or invalid Bybit response');
  return { result, list: result.list as unknown[], time };
}
export function validateBybitGoldOilContract(input: unknown, symbol: string, now = Date.now()) {
  const { list } = envelope(input, now);
  if (list.length !== 1) throw Error('Missing or duplicate Bybit contract');
  const spec = object(list[0]), launchTime = number(spec.launchTime);
  if (spec.symbol !== symbol || spec.baseCoin !== symbol.slice(0, -4) || spec.quoteCoin !== 'USDT' || spec.settleCoin !== 'USDT' || spec.status !== 'Trading' || spec.contractType !== 'LinearPerpetual' || spec.isPreListing !== false || !Number.isSafeInteger(launchTime) || launchTime <= 0 || launchTime > now) throw Error('Unsupported Bybit gold/oil contract');
  return { symbol, launchTime, fundingInterval: spec.fundingInterval };
}
type Contract = ReturnType<typeof validateBybitGoldOilContract>;

export function parseBybitGoldOilQuote(oilInput: unknown, xauInput: unknown, now = Date.now(), contracts: Contract[] = [], oilType: GoldOilType = 'cl') {
  const leg = (input: unknown, symbol: string) => {
    const { list, time } = envelope(input, now);
    if (list.length !== 1) throw Error('Missing or duplicate Bybit ticker');
    const ticker = object(list[0]);
    if (ticker.symbol !== symbol) throw Error('Unexpected Bybit contract');
    return { ticker, value: { symbol, price: number(ticker.markPrice), updatedAt: new Date(time).toISOString() } };
  };
  const oil = leg(oilInput, GOLD_OIL_INSTRUMENTS[oilType].symbol), xau = leg(xauInput, GOLD_OIL_SYMBOLS.xau);
  const base = { oilType, source: 'Bybit', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(Math.min(Date.parse(oil.value.updatedAt), Date.parse(xau.value.updatedAt))).toISOString(), oil: oil.value, xau: xau.value };
  try {
    const terms = ({ ticker, value }: ReturnType<typeof leg>) => {
      // A present but invalid ticker interval must never fall back to a guessed period.
      const hours = ticker.fundingIntervalHour === undefined ? number(contracts.find(row => row.symbol === value.symbol)?.fundingInterval) / 60 : number(ticker.fundingIntervalHour);
      if (!Number.isInteger(hours) || hours <= 0 || hours > 24) throw Error('Invalid Bybit funding interval');
      return { rate: number(ticker.fundingRate), intervalHours: hours, nextFundingAt: new Date(number(ticker.nextFundingTime)).toISOString() };
    };
    return validateGoldOilQuote({ ...base, funding: { oil: terms(oil), xau: terms(xau) } }, oilType, 'bybit');
  } catch { return validateGoldOilQuote(base, oilType, 'bybit'); }
}

export function parseBybitGoldOilHistory(oilInput: unknown, xauInput: unknown, now = Date.now(), previous: GoldOilHistory | null = null, coverageStart?: number, oilType: GoldOilType = 'cl') {
  if (previous) previous = validateGoldOilHistory(previous, oilType, 'bybit');
  const end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  const candles = (input: unknown) => {
    if (!Array.isArray(input) || !input.length) throw Error('Missing Bybit candles');
    const values = new Map<number, number>(), seen = new Set<number>();
    for (const row of input) {
      if (!Array.isArray(row) || row.length < 5) throw Error('Invalid Bybit candle');
      const time = number(row[0]), price = number(row[4]);
      if (!Number.isSafeInteger(time) || time <= 0 || time % GOLD_OIL_INTERVAL_MS || price <= 0 || seen.has(time)) throw Error('Invalid Bybit candle');
      seen.add(time);
      if (time < end) values.set(time, price);
    }
    if (!values.size) throw Error('Missing completed Bybit candles');
    return values;
  };
  const oil = candles(oilInput), xau = candles(xauInput);
  if (previous) for (const row of previous.points) {
    if (row.time >= end) continue;
    if (!oil.has(row.time) && row.oil !== null) oil.set(row.time, row.oil);
    if (!xau.has(row.time) && row.xau !== null) xau.set(row.time, row.xau);
  }
  const points = [...new Set([...oil.keys(), ...xau.keys()])].sort((a, b) => a - b).map(time => ({ time, oil: oil.get(time) ?? null, xau: xau.get(time) ?? null }));
  return validateGoldOilHistory({ oilType, source: 'Bybit', currency: 'USDT', priceBasis: 'mark', interval: '15m', status: 'live', fetchedAt: new Date(now).toISOString(), points, ...(coverageStart === undefined ? {} : { coverageStart: Math.min(coverageStart, previous?.coverageStart ?? coverageStart) }) }, oilType, 'bybit');
}

export function parseBybitGoldOilFunding(oilInput: unknown, xauInput: unknown, start: number, end: number, now: number, previous: GoldOilFundingHistory | null = null, oilType: GoldOilType = 'cl') {
  if (previous) previous = validateGoldOilFunding(previous, oilType, 'bybit');
  const values = new Map<number, FundingEvent>((previous?.points ?? []).map(({ time, oil, xau }) => [time, { time, oil, xau }]));
  for (const [key, input, symbol] of [['oil', oilInput, GOLD_OIL_INSTRUMENTS[oilType].symbol], ['xau', xauInput, GOLD_OIL_SYMBOLS.xau]] as const) {
    if (!Array.isArray(input)) throw Error('Invalid Bybit funding history');
    const seen = new Set<number>();
    for (const item of input) {
      const row = object(item), time = number(row.fundingRateTimestamp), rate = number(row.fundingRate);
      if (row.symbol !== symbol || !Number.isSafeInteger(time) || time < start || time >= end || seen.has(time) || Math.abs(rate) > 1) throw Error('Invalid Bybit funding event');
      seen.add(time);
      const event = values.get(time) ?? { time, oil: null, xau: null };
      event[key] = rate; values.set(time, event);
    }
  }
  return validateGoldOilFunding({ oilType, source: 'Bybit', status: 'live', fetchedAt: new Date(now).toISOString(), coverageStart: Math.min(start, previous?.coverageStart ?? start), coverageEnd: end, points: [...values.values()].sort((a, b) => a.time - b.time) }, oilType, 'bybit');
}

export function createBybitGoldOilReader({ oilType = 'cl', fetcher = fetch, clock = Date.now }: { oilType?: GoldOilType; fetcher?: typeof fetch; clock?: () => number } = {}) {
  const symbols = [GOLD_OIL_INSTRUMENTS[oilType].symbol, GOLD_OIL_SYMBOLS.xau];
  let metadataUntil = 0, commonStart = 0, contracts: Contract[] = [], pendingMetadata: Promise<void> | undefined;
  let latestHistory: GoldOilHistory | null = null, latestFunding: GoldOilFundingHistory | null = null;
  async function request(path: string, params: Record<string, string>) {
    const url = new URL(path, 'https://api.bybit.com'); url.search = new URLSearchParams({ category: 'linear', ...params }).toString();
    const response = await fetcher(url.href, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw Error(`Bybit HTTP ${response.status}`);
    const value: unknown = await response.json(); envelope(value, clock());
    return value;
  }
  function metadata() {
    if (clock() < metadataUntil) return Promise.resolve();
    pendingMetadata ??= Promise.all(symbols.map(async symbol => validateBybitGoldOilContract(await request('/v5/market/instruments-info', { symbol }), symbol, clock()))).then(value => {
      contracts = value;
      commonStart = Math.ceil(Math.max(...contracts.map(row => row.launchTime)) / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
      metadataUntil = clock() + 300_000;
    }).finally(() => { pendingMetadata = undefined; });
    return pendingMetadata;
  }
  async function pages(symbol: string, start: number, end: number, candles: boolean) {
    let cursor = end - 1;
    const rows: unknown[] = [], limit = candles ? 1000 : 200;
    // Both endpoints return newest first. Moving the upper bound avoids losing older rows.
    for (let page = 0; page < 500 && cursor >= start; page++) {
      // Bounded candle windows continue across sparse or empty periods after listing.
      const windowStart = candles ? Math.max(start, cursor - limit * GOLD_OIL_INTERVAL_MS + 1) : start;
      const input = await request(candles ? '/v5/market/mark-price-kline' : '/v5/market/funding/history', { symbol, limit: String(limit), ...(candles ? { interval: '15', start: String(windowStart), end: String(cursor) } : { startTime: String(start), endTime: String(cursor) }) });
      const { result, list } = envelope(input, clock());
      if (candles && result.symbol !== symbol || list.length > limit) throw Error('Invalid Bybit history page');
      let earliest = cursor + 1;
      for (const item of list) {
        const time = candles ? Array.isArray(item) ? number(item[0]) : NaN : number(object(item).fundingRateTimestamp);
        if (!Number.isSafeInteger(time) || time < windowStart || time > cursor || time >= earliest) throw Error('Invalid Bybit pagination');
        if (!candles && object(item).symbol !== symbol) throw Error('Unexpected Bybit funding contract');
        earliest = time; rows.push(item);
      }
      if (!candles && list.length < limit) return rows;
      cursor = candles ? windowStart - 1 : earliest - 1;
    }
    if (cursor >= start) throw Error('Bybit pagination limit exceeded');
    return rows;
  }
  return {
    async quote() {
      const [, oil, xau] = await Promise.all([metadata(), ...symbols.map(symbol => request('/v5/market/tickers', { symbol }))]);
      return parseBybitGoldOilQuote(oil, xau, clock(), contracts, oilType);
    },
    async history(previous: GoldOilHistory | null = null) {
      previous ??= latestHistory;
      if (previous) previous = validateGoldOilHistory(previous, oilType, 'bybit');
      await metadata();
      const now = clock(), end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
      let start = previous?.coverageStart !== undefined && previous.coverageStart <= commonStart ? Math.max(commonStart, previous.points.at(-1)!.time - 86_400_000) : commonStart;
      let expected = commonStart;
      for (const row of previous?.points ?? []) { if (row.time > expected) start = Math.min(start, expected); if (row.oil === null || row.xau === null) start = Math.min(start, row.time); expected = row.time + GOLD_OIL_INTERVAL_MS; }
      const [oil, xau] = await Promise.all(symbols.map(symbol => pages(symbol, start, end, true)));
      latestHistory = parseBybitGoldOilHistory(oil, xau, now, previous, start, oilType);
      return latestHistory;
    },
    async funding(previous: GoldOilFundingHistory | null = null) {
      previous ??= latestFunding;
      if (previous) previous = validateGoldOilFunding(previous, oilType, 'bybit');
      await metadata();
      const now = clock(), start = previous && previous.coverageStart <= commonStart ? Math.max(commonStart, previous.coverageEnd - 2 * 86_400_000) : commonStart;
      const [oil, xau] = await Promise.all(symbols.map(symbol => pages(symbol, start, now, false)));
      latestFunding = parseBybitGoldOilFunding(oil, xau, start, now, now, previous, oilType);
      return latestFunding;
    },
  };
}
