import { ASSETS, API_URL, YEAR_START, DAY, requestInfo } from './hyperliquid.mjs';

export const HOUR = 3_600_000;
const YEAR_END = Date.UTC(2027, 0, 1);

function numeric(value, label) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) throw new Error(`Invalid ${label}`);
  return Number(value);
}

export function pairFundingHistory(brentRecords, wtiRecords, endTime = Date.now()) {
  function collect(records, coin) {
    if (!Array.isArray(records)) throw new Error(`Invalid funding history for ${coin}`);
    const map = new Map();
    for (const record of records) {
      if (record.coin !== coin) throw new Error(`Unexpected funding coin ${record.coin}`);
      const time = numeric(record.time, 'settlement time');
      const rate = numeric(record.fundingRate, 'settled hourly rate');
      if (!Number.isSafeInteger(time)) throw new Error('Invalid settlement timestamp');
      if (time < YEAR_START || time >= YEAR_END || time > endTime) continue;
      // Settlement blocks can be a few milliseconds after the UTC hour.
      const hour = Math.floor(time / HOUR) * HOUR;
      if (map.has(hour) && map.get(hour) !== rate) throw new Error(`Conflicting hourly rates for ${coin}`);
      map.set(hour, rate);
    }
    return map;
  }
  const brent = collect(brentRecords, ASSETS.brent.coin), wti = collect(wtiRecords, ASSETS.wti.coin);
  return [...new Set([...brent.keys(), ...wti.keys()])].sort((a, b) => a - b).map(time => ({ time, brent: brent.get(time) ?? null, wti: wti.get(time) ?? null }));
}

export function validateFundingRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid funding rows');
  let previous = -Infinity;
  return rows.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time % HOUR !== 0 || row.time < YEAR_START || row.time >= YEAR_END || row.time <= previous) throw new Error('Invalid or unordered funding hour');
    previous = row.time;
    const brent = row.brent === null ? null : numeric(row.brent, 'Brent historical rate');
    const wti = row.wti === null ? null : numeric(row.wti, 'WTI historical rate');
    if (brent === null && wti === null) throw new Error('Empty settlement hour');
    return { time: row.time, brent, wti };
  });
}

export function dailyFundingRates(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.brent === null || row.wti === null) continue;
    const date = new Date(row.time).toISOString().slice(0, 10);
    const group = groups.get(date) ?? { date, count: 0, brentRate: 0, wtiRate: 0, shortRate: 0, longRate: 0 };
    // Equal oracle USD notionals; denominator is BOTH legs' gross notional.
    group.shortRate += (row.brent - row.wti) / 2;
    group.brentRate += row.brent; group.wtiRate += row.wti; group.count++;
    groups.set(date, group);
  }
  return [...groups.values()].map(group => ({ ...group, brentRate: group.brentRate / group.count, wtiRate: group.wtiRate / group.count, shortRate: group.shortRate / group.count, longRate: -group.shortRate / group.count })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Sum actual paired settlements across the entire selected UTC date interval. */
export function analyzeFundingRange(rows, firstDate, lastDate) {
  const start = Date.parse(`${firstDate}T00:00:00Z`), end = Date.parse(`${lastDate}T00:00:00Z`) + DAY;
  if (![firstDate, lastDate].every(date => /^2026-\d{2}-\d{2}$/.test(date)) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || new Date(start).toISOString().slice(0, 10) !== firstDate || new Date(end - DAY).toISOString().slice(0, 10) !== lastDate) throw new Error('Invalid funding date range');
  const days = new Map();
  for (const row of validateFundingRows(rows)) {
    if (row.time < start || row.time >= end || row.brent === null || row.wti === null) continue;
    const date = new Date(row.time).toISOString().slice(0, 10);
    const day = days.get(date) ?? { date, count: 0, sum: 0 };
    day.sum += (row.brent - row.wti) / 2; day.count++;
    days.set(date, day);
  }
  let count = 0, cumulative = 0;
  const points = [...days.values()].map(day => {
    count += day.count; cumulative += day.sum;
    const annualized = cumulative / count * 8760;
    if (!Number.isFinite(day.sum) || !Number.isFinite(cumulative) || !Number.isFinite(annualized)) throw new Error('Historical funding calculation overflow');
    return { date: day.date, count: day.count, cumulativeCount: count, shortRate: day.sum / day.count, longRate: -day.sum / day.count, shortCumulative: cumulative, longCumulative: -cumulative, shortAnnualized: annualized, longAnnualized: -annualized };
  });
  const expectedHours = (end - start) / HOUR;
  return { points, count, expectedHours, missingHours: expectedHours - count, shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null, shortAnnualized: count ? cumulative / count * 8760 : null, longAnnualized: count ? -cumulative / count * 8760 : null };
}

/** Exact intraday window, grouped by UTC settlement day for the funding chart. */
export function analyzeFundingWindow(rows, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw Error('Invalid funding time window');
  const days = new Map();
  for (const row of validateFundingRows(rows)) {
    if (row.time < start || row.time >= end || row.brent === null || row.wti === null) continue;
    const date = new Date(row.time).toISOString().slice(0, 10), day = days.get(date) ?? { date, count: 0, sum: 0, time: row.time };
    day.sum += (row.brent - row.wti) / 2; day.count++; day.time = row.time; days.set(date, day);
  }
  let count = 0, cumulative = 0;
  const points = [...days.values()].map(day => {
    count += day.count; cumulative += day.sum;
    const annualized = cumulative / count * 8760;
    if (!Number.isFinite(cumulative) || !Number.isFinite(annualized)) throw Error('Historical funding calculation overflow');
    return { date: day.date, time: day.time, count: day.count, cumulativeCount: count, shortRate: day.sum / day.count, longRate: -day.sum / day.count, shortCumulative: cumulative, longCumulative: -cumulative, shortAnnualized: annualized, longAnnualized: -annualized };
  });
  const expectedHours = Math.ceil(end / HOUR) - Math.ceil(start / HOUR);
  return { points, count, expectedHours, missingHours: expectedHours - count, shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null, shortAnnualized: count ? cumulative / count * 8760 : null, longAnnualized: count ? -cumulative / count * 8760 : null };
}

export function createFundingSnapshot(data, fetchedAt = new Date().toISOString()) {
  const validated = validateFundingRows(data);
  const paired = validated.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('No paired funding observations');
  if (validated.some(row => row.time > Date.parse(fetchedAt))) throw new Error('Funding snapshot contains future settlements');
  return { metadata: { source: 'Hyperliquid fundingHistory', api: API_URL, fetchedAt, interval: '1h', timezone: 'UTC', basis: 'Equal oracle USD notional; rate divided by gross notional of both legs', firstSettlementTime: paired[0].time, lastSettlementTime: paired.at(-1).time, pairedObservationRows: paired.length, brentObservationRows: validated.filter(row => row.brent !== null).length, wtiObservationRows: validated.filter(row => row.wti !== null).length, coins: [ASSETS.brent.coin, ASSETS.wti.coin] }, data: validated };
}

export async function fetchFundingHistory(coin, startTime, endTime, options = {}) {
  if (![ASSETS.brent.coin, ASSETS.wti.coin].includes(coin)) throw new Error('Unsupported funding market');
  let cursor = startTime;
  const records = new Map();
  for (let page = 0; page < 100 && cursor <= endTime; page++) {
    const response = await requestInfo({ type: 'fundingHistory', coin, startTime: cursor, endTime }, options);
    if (!Array.isArray(response)) throw new Error(`Invalid funding page for ${coin}`);
    if (!response.length) return [...records.values()].sort((a, b) => a.time - b.time);
    let last = -Infinity;
    for (const row of response) {
      const time = numeric(row.time, 'funding pagination time');
      if (row.coin !== coin || !Number.isSafeInteger(time) || time > endTime) throw new Error('Unexpected funding pagination record');
      if (time >= startTime) records.set(time, row);
      last = Math.max(last, time);
    }
    if (last < cursor) throw new Error('Funding pagination did not advance');
    cursor = last + 1;
  }
  if (cursor <= endTime) throw new Error('Funding pagination exceeded its limit');
  return [...records.values()].sort((a, b) => a.time - b.time);
}

/** @param {{ data: Array<{time: number, brent: number | null, wti: number | null}>, metadata: {fetchedAt: string} } | null} existing */
export async function fetchFundingSnapshot(existing = null, options = {}) {
  const now = options.now ?? Date.now(), endTime = Math.min(now, YEAR_END - 1);
  const previous = existing ? createFundingSnapshot(existing.data, existing.metadata.fetchedAt) : null;
  let missing = Infinity, expected = previous?.data[0]?.time;
  for (const row of previous?.data ?? []) {
    if (row.time > expected) missing = Math.min(missing, expected);
    if (row.brent === null || row.wti === null) missing = Math.min(missing, row.time);
    expected = row.time + HOUR;
  }
  const startTime = previous ? Math.max(YEAR_START, Math.min(previous.metadata.lastSettlementTime - 2 * DAY, missing)) : YEAR_START;
  const [brent, wti] = await Promise.all([
    fetchFundingHistory(ASSETS.brent.coin, startTime, endTime, options),
    fetchFundingHistory(ASSETS.wti.coin, startTime, endTime, options)
  ]);
  const merged = new Map((previous?.data ?? []).map(row => [row.time, row]));
  for (const row of pairFundingHistory(brent, wti, endTime)) {
    const old = merged.get(row.time);
    merged.set(row.time, { time: row.time, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null });
  }
  return createFundingSnapshot([...merged.values()].sort((a, b) => a.time - b.time), new Date(now).toISOString());
}
