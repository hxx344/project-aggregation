export const API_URL = 'https://fapi.binance.com';
export const SOURCE = 'Binance';
export const DAY = 86_400_000;
export const HISTORY_START = Date.UTC(2026, 3, 1, 9);
export const ASSETS = Object.freeze({
  brent: { coin: 'BZUSDT', label: '布伦特', page: 'https://www.binance.com/en/futures/BZUSDT' },
  wti: { coin: 'CLUSDT', label: 'WTI', page: 'https://www.binance.com/en/futures/CLUSDT' },
});

export function numeric(value, positive = false) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) throw Error('Invalid Binance number');
  return Number(value);
}

export async function requestBinance(path, params = {}, { fetcher = fetch, timeout = 15_000 } = {}) {
  const url = new URL(path, API_URL);
  url.search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const response = await fetcher(url.href, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error(`Binance HTTP ${response.status}`);
  return response.json();
}

export function validateMarket(input) {
  if (input?.source !== SOURCE || input.currency !== 'USDT' || !Number.isFinite(Date.parse(input.fetchedAt))) throw Error('Expected Binance oil quote');
  const leg = key => {
    const item = input[key];
    if (item?.coin !== ASSETS[key].coin) throw Error('Unexpected Binance oil contract');
    const rate = item.fundingRate === null ? null : numeric(item.fundingRate);
    const hours = item.fundingIntervalHours === null ? null : numeric(item.fundingIntervalHours, true);
    if ((rate !== null && Math.abs(rate) > 1) || (hours !== null && (!Number.isInteger(hours) || hours > 24))) throw Error('Invalid Binance funding terms');
    if (item.nextFundingAt !== null && !Number.isFinite(Date.parse(item.nextFundingAt))) throw Error('Invalid Binance settlement time');
    if (rate !== null && (hours === null || item.nextFundingAt === null)) throw Error('Incomplete Binance funding terms');
    return { coin: item.coin, markPx: numeric(item.markPx, true), fundingRate: rate, fundingIntervalHours: hours, nextFundingAt: item.nextFundingAt };
  };
  return { source: SOURCE, currency: 'USDT', fetchedAt: input.fetchedAt, brent: leg('brent'), wti: leg('wti') };
}

export function marketFromExchangeQuote(quote) {
  if (quote?.exchange !== 'binance' || quote.monitorId !== 'oil' || quote.priceBasis !== 'mark') throw Error('Expected Binance oil exchange quote');
  const leg = item => ({ coin: item.symbol, markPx: item.price, fundingRate: item.fundingRate, fundingIntervalHours: item.fundingIntervalHours, nextFundingAt: item.nextFundingAt });
  return validateMarket({ source: SOURCE, currency: quote.currency, fetchedAt: quote.fetchedAt, brent: leg(quote.left), wti: leg(quote.right) });
}

/** Positive = short Brent receives minus long WTI pays, over both legs' mark notionals. */
export function calculateShortSpreadFunding(market, basis = 'quantity') {
  if (!['quantity', 'notional'].includes(basis)) throw Error('Invalid funding basis');
  const validated = validateMarket(market);
  const brentNotional = basis === 'quantity' ? validated.brent.markPx : 1;
  const wtiNotional = basis === 'quantity' ? validated.wti.markPx : 1;
  const grossNotional = brentNotional + wtiNotional;
  const brentRate = validated.brent.fundingRate === null ? null : validated.brent.fundingRate / validated.brent.fundingIntervalHours;
  const wtiRate = validated.wti.fundingRate === null ? null : validated.wti.fundingRate / validated.wti.fundingIntervalHours;
  const brentCashflow = brentRate === null ? null : brentNotional * brentRate;
  const wtiCashflow = wtiRate === null ? null : -wtiNotional * wtiRate;
  const hourlyCashflow = brentCashflow === null || wtiCashflow === null ? null : brentCashflow + wtiCashflow;
  const hourlyRate = hourlyCashflow === null ? null : hourlyCashflow / grossNotional;
  return { basis, brentNotional, wtiNotional, grossNotional, brentRate, wtiRate, brentCashflow, wtiCashflow, hourlyCashflow, hourlyRate, annualizedRate: hourlyRate === null ? null : hourlyRate * 8760, cashflowPer10k: hourlyRate === null ? null : hourlyRate * 10_000 };
}

/** Bounded ascending pages. Never silently publish a truncated history. */
export async function fetchCandles(symbol, interval, startTime, endTime, options = {}) {
  if (!Object.values(ASSETS).some(asset => asset.coin === symbol) || !['15m', '1d'].includes(interval)) throw Error('Unsupported Binance oil candles');
  const step = interval === '15m' ? 900_000 : DAY, limit = options.pageSize ?? 1500;
  let cursor = startTime;
  const result = [];
  for (let page = 0; page < 500 && cursor <= endTime; page++) {
    const rows = await requestBinance('/fapi/v1/klines', { symbol, interval, startTime: cursor, endTime, limit }, options);
    if (!Array.isArray(rows)) throw Error('Invalid Binance candle page');
    if (!rows.length) return result;
    let previous = cursor - 1;
    for (const row of rows) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] <= previous || row[0] < cursor || row[0] > endTime || row[0] % step || row[6] !== row[0] + step - 1) throw Error('Invalid Binance candle pagination');
      numeric(row[4], true); previous = row[0]; result.push(row);
    }
    cursor = previous + step;
    if (rows.length < limit) return result;
  }
  if (cursor <= endTime) throw Error('Binance candle pagination exceeded its limit');
  return result;
}

export async function fetchDailySnapshot(market, options = {}) {
  const now = options.now ?? Date.now();
  const candles = await Promise.all(Object.values(ASSETS).map(asset => fetchCandles(asset.coin, '1d', Math.floor(HISTORY_START / DAY) * DAY, now, options)));
  const maps = candles.map(rows => new Map(rows.filter(row => row[6] < now).map(row => [row[0], numeric(row[4], true)])));
  const data = [...new Set(maps.flatMap(map => [...map.keys()]))].sort((a, b) => a - b).map(time => ({ date: new Date(time).toISOString().slice(0, 10), brent: maps[0].get(time) ?? null, wti: maps[1].get(time) ?? null }));
  const paired = data.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length) throw Error('No Binance daily history');
  return { metadata: { source: SOURCE, api: API_URL, currency: 'USDT', fetchedAt: new Date(now).toISOString(), interval: '1d', timezone: 'UTC', firstCommonObservation: paired[0].date, lastCommonObservation: paired.at(-1).date, pairedObservationRows: paired.length }, data, market: validateMarket(market) };
}
