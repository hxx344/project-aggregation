import { ASSETS, API_URL, SOURCE, HISTORY_START, DAY, numeric, requestBinance } from './binance.mjs';

export const HOUR = 3_600_000;
// Both oil contracts launched with four-hour settlement and are exempt from automatic interval adjustment.
// Reject an unexpected schedule instead of relabeling it or inferring missing settlements as zero.
export const FUNDING_HOURS = 4;
export const FUNDING_MS = FUNDING_HOURS * HOUR;
export const FIRST_SETTLEMENT = Math.ceil(HISTORY_START / FUNDING_MS) * FUNDING_MS;

export function pairFundingHistory(brent, wti, now = Date.now()) {
  const collect = (rows, symbol) => {
    if (!Array.isArray(rows)) throw Error('Invalid Binance funding history');
    const result = new Map();
    for (const row of rows) {
      const stamp = numeric(row.fundingTime), time = Math.floor(stamp / FUNDING_MS) * FUNDING_MS;
      if (row.symbol !== symbol || !Number.isSafeInteger(stamp) || stamp - time >= 60_000 || time < FIRST_SETTLEMENT || (row.rateType !== undefined && row.rateType !== 'Regular')) throw Error('Unexpected Binance funding settlement');
      if (stamp > now) continue;
      const rate = numeric(row.fundingRate);
      if (Math.abs(rate) > 1 || result.has(time)) throw Error('Invalid or duplicate Binance funding rate');
      result.set(time, rate);
    }
    return result;
  };
  const left = collect(brent, ASSETS.brent.coin), right = collect(wti, ASSETS.wti.coin);
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b).map(time => ({ time, brent: left.get(time) ?? null, wti: right.get(time) ?? null }));
}

export function validateFundingRows(rows) {
  if (!Array.isArray(rows)) throw Error('Invalid Binance funding rows');
  let previous = -1;
  return rows.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time < FIRST_SETTLEMENT || row.time % FUNDING_MS || row.time <= previous) throw Error('Invalid Binance settlement time');
    previous = row.time;
    const brent = row.brent === null ? null : numeric(row.brent), wti = row.wti === null ? null : numeric(row.wti);
    if ((brent === null && wti === null) || (brent !== null && Math.abs(brent) > 1) || (wti !== null && Math.abs(wti) > 1)) throw Error('Invalid Binance settlement rates');
    return { time: row.time, brent, wti };
  });
}

export function createFundingSnapshot(rows, fetchedAt = new Date().toISOString()) {
  const data = validateFundingRows(rows), paired = data.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length || !Number.isFinite(Date.parse(fetchedAt)) || data.some(row => row.time > Date.parse(fetchedAt))) throw Error('Invalid Binance funding snapshot');
  return { metadata: { source: SOURCE, api: `${API_URL}/fapi/v1/fundingRate`, fetchedAt, interval: '4h', settlementIntervalHours: FUNDING_HOURS, timezone: 'UTC', currency: 'USDT', basis: 'Equal USDT notionals; actual settled rate divided by both legs gross notional', firstSettlementTime: paired[0].time, lastSettlementTime: paired.at(-1).time, pairedObservationRows: paired.length, brentObservationRows: data.filter(row => row.brent !== null).length, wtiObservationRows: data.filter(row => row.wti !== null).length, symbols: [ASSETS.brent.coin, ASSETS.wti.coin] }, data };
}

export function validateFundingSnapshot(input) {
  const meta = input?.metadata;
  if (meta?.source !== SOURCE || meta.currency !== 'USDT' || meta.interval !== '4h' || meta.settlementIntervalHours !== FUNDING_HOURS || meta.timezone !== 'UTC' || JSON.stringify(meta.symbols) !== JSON.stringify([ASSETS.brent.coin, ASSETS.wti.coin])) throw Error('Expected Binance four-hour funding history');
  const result = createFundingSnapshot(input.data, meta.fetchedAt);
  for (const field of ['firstSettlementTime', 'lastSettlementTime', 'pairedObservationRows', 'brentObservationRows', 'wtiObservationRows']) if (meta[field] !== result.metadata[field]) throw Error('Binance funding metadata mismatch');
  return result;
}

/** Cumulative fee uses actual settlement rates. Hourly averages divide by four, exactly once. */
export function analyzeFundingWindow(rows, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw Error('Invalid funding time window');
  const days = new Map();
  for (const row of validateFundingRows(rows)) {
    if (row.time < start || row.time >= end || row.brent === null || row.wti === null) continue;
    const date = new Date(row.time).toISOString().slice(0, 10), day = days.get(date) ?? { date, time: row.time, count: 0, sum: 0 };
    day.sum += (row.brent - row.wti) / 2; day.count++; day.time = row.time; days.set(date, day);
  }
  let count = 0, cumulative = 0;
  const points = [...days.values()].map(day => {
    count += day.count; cumulative += day.sum;
    const annualized = cumulative / (count * FUNDING_HOURS) * 8760;
    if (!Number.isFinite(cumulative) || !Number.isFinite(annualized)) throw Error('Funding calculation overflow');
    return { date: day.date, time: day.time, count: day.count, cumulativeCount: count, shortRate: day.sum / (day.count * FUNDING_HOURS), longRate: -day.sum / (day.count * FUNDING_HOURS), shortCumulative: cumulative, longCumulative: -cumulative, shortAnnualized: annualized, longAnnualized: -annualized };
  });
  const expectedSettlements = Math.max(0, Math.ceil(end / FUNDING_MS) - Math.ceil(Math.max(start, FIRST_SETTLEMENT) / FUNDING_MS));
  return { points, count, expectedSettlements, missingSettlements: expectedSettlements - count, coveredHours: count * FUNDING_HOURS, shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null, shortAnnualized: count ? cumulative / (count * FUNDING_HOURS) * 8760 : null, longAnnualized: count ? -cumulative / (count * FUNDING_HOURS) * 8760 : null };
}

export async function fetchFundingHistory(symbol, startTime, endTime, options = {}) {
  if (!Object.values(ASSETS).some(asset => asset.coin === symbol)) throw Error('Unsupported Binance funding symbol');
  let cursor = startTime;
  const result = [], limit = options.pageSize ?? 1000;
  for (let page = 0; page < 500 && cursor <= endTime; page++) {
    const rows = await requestBinance('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime, limit }, options);
    if (!Array.isArray(rows)) throw Error('Invalid Binance funding page');
    if (!rows.length) return result;
    let previous = cursor - 1;
    for (const row of rows) {
      if (row.symbol !== symbol || !Number.isSafeInteger(row.fundingTime) || row.fundingTime <= previous || row.fundingTime < cursor || row.fundingTime > endTime) throw Error('Invalid Binance funding pagination');
      previous = row.fundingTime; result.push(row);
    }
    cursor = previous + 1;
    if (rows.length < limit) return result;
  }
  if (cursor <= endTime) throw Error('Binance funding pagination exceeded its limit');
  return result;
}

/** @param {ReturnType<typeof createFundingSnapshot> | null} existing */
export async function fetchFundingSnapshot(existing = null, options = {}) {
  const now = options.now ?? Date.now(), previous = existing ? validateFundingSnapshot(existing) : null;
  let missing = Infinity, expected = previous?.data[0]?.time;
  for (const row of previous?.data ?? []) {
    if (row.time > expected) missing = Math.min(missing, expected);
    if (row.brent === null || row.wti === null) missing = Math.min(missing, row.time);
    expected = row.time + FUNDING_MS;
  }
  const start = previous ? Math.max(FIRST_SETTLEMENT, Math.min(previous.metadata.lastSettlementTime - 2 * DAY, missing)) : FIRST_SETTLEMENT;
  const records = await Promise.all(Object.values(ASSETS).map(asset => fetchFundingHistory(asset.coin, start, now, options)));
  const merged = new Map((previous?.data ?? []).map(row => [row.time, row]));
  for (const row of pairFundingHistory(records[0], records[1], now)) {
    const old = merged.get(row.time);
    merged.set(row.time, { time: row.time, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null });
  }
  return createFundingSnapshot([...merged.values()].sort((a, b) => a.time - b.time), new Date(now).toISOString());
}
