import { validateExchangeQuote, type ExchangeLeg, type ExchangeQuote } from './exchange-quotes.ts';

type JsonObject = Record<string, unknown>;
type OilCex = 'okx' | 'bitget';
type Funding = Pick<ExchangeLeg, 'fundingRate' | 'fundingIntervalHours' | 'nextFundingAt'> & { sourceTime: number };
type ReaderOptions = {
  request: (url: string) => Promise<unknown>;
  shared: (key: string, ttl: number, load: () => Promise<unknown>) => Promise<unknown>;
  clock?: () => number;
};
const HOUR = 3_600_000;
const bases = ['BZ', 'CL'] as const;
const emptyFunding = { fundingRate: null, fundingIntervalHours: null, nextFundingAt: null };

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid oil exchange response');
  return value as JsonObject;
}
function number(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('Invalid oil exchange number');
  return Number(value);
}
function timestamp(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid oil exchange timestamp');
  return result;
}
function sourceTime(value: unknown, now: number): number {
  const result = timestamp(value);
  if (result < now - 120_000 || result > now + 60_000) throw new Error('Delayed or invalid oil exchange quote');
  return result;
}
function envelope(value: unknown, code: string) {
  const response = object(value);
  if (response.code !== code || !Array.isArray(response.data)) throw new Error('Oil exchange market response failed');
  return { response, items: response.data.map(object) };
}
// Keep official response envelopes, including Bitget's server requestTime.
function envelopes(value: unknown): unknown[] { return Array.isArray(value) ? value : [value]; }
function rows(value: unknown, code: string): JsonObject[] { return envelopes(value).flatMap(item => envelope(item, code).items); }
function unique(items: JsonObject[], field: string, symbol: string): JsonObject {
  const matches = items.filter(item => item[field] === symbol);
  if (matches.length !== 1) throw new Error(`Missing or duplicate oil contract ${symbol}`);
  return matches[0];
}
function synchronized(times: number[]) {
  if (Math.max(...times) - Math.min(...times) > 15_000) throw new Error('Oil exchange quote legs are not synchronized');
}
function priceLeg(symbol: string, value: unknown): ExchangeLeg {
  const price = number(value);
  if (price <= 0) throw new Error('Invalid oil exchange mark price');
  return { symbol, price, fundingPrice: price, ...emptyFunding };
}
function fundingFields(rate: unknown, interval: unknown, next: unknown, time: number, priceTime: number, now: number): Funding {
  const fundingRate = number(rate), fundingIntervalHours = number(interval), nextTime = timestamp(next);
  if (Math.abs(fundingRate) > 1 || !Number.isInteger(fundingIntervalHours) || fundingIntervalHours < 1 || fundingIntervalHours > 24) throw new Error('Invalid oil funding rate or interval');
  if (nextTime < Math.max(time, now, priceTime) - 60_000 || nextTime > priceTime + 25 * HOUR) throw new Error('Invalid oil funding settlement time');
  return { fundingRate, fundingIntervalHours, nextFundingAt: new Date(nextTime).toISOString(), sourceTime: time };
}
function optionalFunding(load: () => Funding[], priceTime: number): Funding[] | null {
  try {
    const result = load();
    if (result.length !== 2) throw new Error('Missing oil funding leg');
    // Funding snapshots update independently (OKX every 30–90s). Each leg
    // already passed its own freshness check; only prices need the 15s gap.
    if (Math.max(...result.map(item => item.sourceTime)) > priceTime + 60_000) throw new Error('Funding source is ahead of mark prices');
    return result;
  } catch { return null; }
}
function finish(exchange: OilCex, times: number[], legs: ExchangeLeg[], funding: Funding[] | null): ExchangeQuote {
  synchronized(times);
  const apply = (leg: ExchangeLeg, index: number): ExchangeLeg => {
    const item = funding?.[index];
    return item ? { ...leg, fundingRate: item.fundingRate, fundingIntervalHours: item.fundingIntervalHours, nextFundingAt: item.nextFundingAt } : leg;
  };
  return validateExchangeQuote({
    exchange, monitorId: 'oil', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark',
    fetchedAt: new Date(Math.min(...times)).toISOString(),
    fundingFetchedAt: funding ? new Date(Math.min(...funding.map(item => item.sourceTime))).toISOString() : null,
    status: 'live', left: apply(legs[0], 0), right: apply(legs[1], 1),
    fundingError: funding ? '' : '资金费或结算周期暂不可用，价格仍正常更新。',
  }, exchange, 'oil');
}

/** Official OKX envelopes; funding may contain one response per contract. */
export function parseOkxOilQuote(instruments: unknown, marks: unknown, funding: unknown, now = Date.now()): ExchangeQuote {
  const metadata = rows(instruments, '0'), prices = rows(marks, '0'), times: number[] = [];
  const legs = bases.map(base => {
    const symbol = `${base}-USDT-SWAP`, spec = unique(metadata, 'instId', symbol), mark = unique(prices, 'instId', symbol);
    if (spec.state !== 'live' || spec.instType !== 'SWAP' || spec.ctType !== 'linear' || spec.settleCcy !== 'USDT' || spec.ctValCcy !== base || spec.instFamily !== `${base}-USDT` || spec.uly !== `${base}-USDT` || spec.ruleType !== 'normal' || mark.instType !== 'SWAP') throw new Error('Unsupported OKX oil contract');
    times.push(sourceTime(mark.ts, now));
    // ctVal is contract size; markPx already quotes one barrel in USDT.
    return priceLeg(symbol, mark.markPx);
  });
  const priceTime = Math.min(...times);
  const completeFunding = optionalFunding(() => {
    const rates = rows(funding, '0');
    return legs.map(leg => {
      const item = unique(rates, 'instId', leg.symbol);
      if (item.instType !== 'SWAP' || item.method !== 'current_period') throw new Error('Unsupported OKX funding contract');
      const time = sourceTime(item.ts, now), settlement = timestamp(item.fundingTime);
      // fundingTime settles fundingRate; nextFundingTime is the following cycle.
      return fundingFields(item.fundingRate, (timestamp(item.nextFundingTime) - settlement) / HOUR, settlement, time, priceTime, now);
    });
  }, priceTime);
  return finish('okx', times, legs, completeFunding);
}

/** Official Bitget USDT-FUTURES envelopes; rates are decimal values, not percentages. */
export function parseBitgetOilQuote(instruments: unknown, tickers: unknown, funding: unknown, now = Date.now()): ExchangeQuote {
  const metadata = rows(instruments, '00000'), prices = rows(tickers, '00000'), times: number[] = [];
  const legs = bases.map(base => {
    const symbol = `${base}USDT`, spec = unique(metadata, 'symbol', symbol), ticker = unique(prices, 'symbol', symbol);
    if (spec.symbolStatus !== 'normal' || spec.symbolType !== 'perpetual' || spec.baseCoin !== base || spec.quoteCoin !== 'USDT' || !Array.isArray(spec.supportMarginCoins) || spec.supportMarginCoins.length !== 1 || spec.supportMarginCoins[0] !== 'USDT') throw new Error('Unsupported Bitget oil contract');
    times.push(sourceTime(ticker.ts, now));
    return priceLeg(symbol, ticker.markPrice);
  });
  const priceTime = Math.min(...times);
  const completeFunding = optionalFunding(() => {
    const rates = envelopes(funding).flatMap(value => {
      const { response, items } = envelope(value, '00000'), time = sourceTime(response.requestTime, now);
      return items.map(item => ({ item, time }));
    });
    return legs.map(leg => {
      const matches = rates.filter(rate => rate.item.symbol === leg.symbol);
      if (matches.length !== 1) throw new Error('Missing or duplicate Bitget funding contract');
      const { item, time } = matches[0];
      return fundingFields(item.fundingRate, item.fundingRateInterval, item.nextUpdate, time, priceTime, now);
    });
  }, priceTime);
  return finish('bitget', times, legs, completeFunding);
}

/** Public market transport only; funding outages leave validated prices available. */
export function createOilCexReader({ request, shared, clock = Date.now }: ReaderOptions) {
  const cached = (key: string, ttl: number, url: string, code: string) => shared(key, ttl, async () => {
    const value = await request(url);
    envelope(value, code);
    return value;
  });
  return async (exchange: OilCex): Promise<ExchangeQuote> => {
    if (exchange === 'okx') {
      const [instruments, marks, funding] = await Promise.all([
        cached('okx/oil/instruments', 60_000, 'https://www.okx.com/api/v5/public/instruments?instType=SWAP', '0'),
        cached('okx/oil/marks', 1000, 'https://www.okx.com/api/v5/public/mark-price?instType=SWAP', '0'),
        Promise.all(bases.map(base => cached(`okx/oil/funding/${base}`, 15_000, `https://www.okx.com/api/v5/public/funding-rate?instId=${base}-USDT-SWAP`, '0').catch(() => null))),
      ]);
      return parseOkxOilQuote(instruments, marks, funding, clock());
    }
    if (exchange === 'bitget') {
      const [instruments, tickers, funding] = await Promise.all([
        cached('bitget/oil/instruments', 60_000, 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES', '00000'),
        cached('bitget/oil/tickers', 1000, 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', '00000'),
        Promise.all(bases.map(base => cached(`bitget/oil/funding/${base}`, 15_000, `https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=${base}USDT`, '00000').catch(() => null))),
      ]);
      return parseBitgetOilQuote(instruments, tickers, funding, clock());
    }
    throw new Error('Unsupported oil exchange');
  };
}
