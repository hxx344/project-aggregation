export const API_URL = 'https://api.hyperliquid.xyz/info';
export const YEAR_START = Date.UTC(2026, 0, 1);
export const DAY = 86_400_000;
export const ASSETS = Object.freeze({
  brent: { coin: 'xyz:BRENTOIL', label: '布伦特', page: 'https://app.hyperliquid.xyz/trade/xyz:BRENTOIL' },
  wti: { coin: 'xyz:CL', label: 'WTI', page: 'https://app.hyperliquid.xyz/trade/xyz:WTIOIL' }
});

function finiteNumber(value, name, positive = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '') || !Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) throw new Error(`Invalid ${name}`);
  return Number(value);
}

export async function requestInfo(payload, { fetcher = fetch, timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

/** @returns {{fetchedAt: string, brent: {coin: string, markPx: number, oraclePx: number, funding: number}, wti: {coin: string, markPx: number, oraclePx: number, funding: number}}} */
export function parseMarketResponse(response, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(response) || !Array.isArray(response[0]?.universe) || !Array.isArray(response[1])) throw new Error('Invalid market response');
  const market = { fetchedAt };
  for (const [leg, asset] of Object.entries(ASSETS)) {
    const index = response[0].universe.findIndex(item => item.name === asset.coin);
    if (index < 0 || !response[1][index]) throw new Error(`Missing ${asset.coin}`);
    if (response[0].universe[index].isDelisted) throw new Error(`Inactive ${asset.coin}`);
    const context = response[1][index];
    market[leg] = { coin: asset.coin, markPx: finiteNumber(context.markPx, 'mark price', true), oraclePx: finiteNumber(context.oraclePx, 'oracle price', true), funding: finiteNumber(context.funding, 'hourly funding') };
  }
  return market;
}

export function pairDailyCandles(brentCandles, wtiCandles, now = Date.now()) {
  function collect(candles, coin) {
    if (!Array.isArray(candles)) throw new Error(`Invalid candles for ${coin}`);
    const map = new Map();
    for (const candle of candles) {
      const t = finiteNumber(candle.t, 'candle start');
      const end = finiteNumber(candle.T, 'candle end');
      if (candle.s !== coin || candle.i !== '1d' || t % DAY !== 0 || end !== t + DAY - 1) throw new Error(`Unexpected candle for ${coin}`);
      if (t < YEAR_START || t >= Date.UTC(2027, 0, 1) || end >= now) continue;
      if (map.has(t)) throw new Error(`Duplicate candle for ${coin}`);
      map.set(t, finiteNumber(candle.c, 'daily close', true));
    }
    return map;
  }
  const brent = collect(brentCandles, ASSETS.brent.coin), wti = collect(wtiCandles, ASSETS.wti.coin);
  const timestamps = [...new Set([...brent.keys(), ...wti.keys()])].sort((a, b) => a - b);
  const data = timestamps.map(t => ({ date: new Date(t).toISOString().slice(0, 10), brent: brent.get(t) ?? null, wti: wti.get(t) ?? null }));
  const paired = data.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length) throw new Error('No common completed daily candles');
  return { data, firstCommonObservation: paired[0].date, lastCommonObservation: paired.at(-1).date, pairedObservationRows: paired.length };
}

export function calculateShortSpreadFunding(market, basis = 'quantity') {
  if (!['quantity', 'notional'].includes(basis)) throw new Error('Invalid funding basis');
  const brentPrice = finiteNumber(market.brent.oraclePx, 'Brent oracle price', true);
  const wtiPrice = finiteNumber(market.wti.oraclePx, 'WTI oracle price', true);
  const brentRate = finiteNumber(market.brent.funding, 'Brent funding');
  const wtiRate = finiteNumber(market.wti.funding, 'WTI funding');
  // Positive funding: the short Brent leg receives; the long WTI leg pays.
  // Funding notionals use oracle prices, never mark prices or posted margin.
  const brentNotional = basis === 'quantity' ? brentPrice : 1;
  const wtiNotional = basis === 'quantity' ? wtiPrice : 1;
  const grossNotional = brentNotional + wtiNotional;
  const brentCashflow = brentNotional * brentRate;
  const wtiCashflow = -wtiNotional * wtiRate;
  const hourlyCashflow = brentCashflow + wtiCashflow;
  const hourlyRate = hourlyCashflow / grossNotional;
  return { basis, brentRate, wtiRate, brentCashflow, wtiCashflow, brentNotional, wtiNotional, grossNotional, hourlyCashflow, hourlyRate, singleLegRateDifference: brentRate - wtiRate, annualizedRate: hourlyRate * 24 * 365, cashflowPer10k: hourlyRate * 10_000 };
}

export async function fetchMarket(options = {}) {
  return parseMarketResponse(await requestInfo({ type: 'metaAndAssetCtxs', dex: 'xyz' }, options));
}

export async function fetchSnapshot(options = {}) {
  const now = Date.now();
  const responses = await Promise.all([
    requestInfo({ type: 'candleSnapshot', req: { coin: ASSETS.brent.coin, interval: '1d', startTime: YEAR_START, endTime: now } }, options),
    requestInfo({ type: 'candleSnapshot', req: { coin: ASSETS.wti.coin, interval: '1d', startTime: YEAR_START, endTime: now } }, options),
    fetchMarket(options).then(market => { options.onMarket?.(market); return market; })
  ]);
  const paired = pairDailyCandles(responses[0], responses[1], now);
  return {
    metadata: { source: 'Hyperliquid / XYZ', api: API_URL, fetchedAt: new Date(now).toISOString(), interval: '1d', timezone: 'UTC', priceBasis: 'Completed daily trade candle close', firstCommonObservation: paired.firstCommonObservation, lastCommonObservation: paired.lastCommonObservation, pairedObservationRows: paired.pairedObservationRows, assets: ASSETS, mappingSource: 'https://docs.trade.xyz/asset-directory/commodities', fundingSource: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding' },
    data: paired.data,
    market: responses[2]
  };
}
