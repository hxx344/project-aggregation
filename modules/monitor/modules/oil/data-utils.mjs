import { oilSpreadPercent } from './spread.mjs';

export const round = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000;
export const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(3)}`;

export function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No daily observations');
  let previous = '';
  return rows.map(row => {
    const time = typeof row.date === 'string' ? Date.parse(row.date) : NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== row.date || row.date <= previous || !Number.isFinite(row.brent) || !Number.isFinite(row.wti) || row.brent <= 0 || row.wti <= 0) throw new Error('Invalid daily observation');
    previous = row.date;
    const spread = oilSpreadPercent(row.brent, row.wti);
    if (spread === null) throw new Error('Invalid daily spread');
    return { date: row.date, brent: row.brent, wti: row.wti, spread };
  });
}

function rangeStart(endTime, range) {
  if (range === '1d' || range === '1w') return endTime - (range === '1d' ? 1 : 7) * 86_400_000;
  if (!['1m', '3m'].includes(range)) throw Error('Invalid chart range');
  const end = new Date(endTime);
  const months = range === '1m' ? 1 : 3;
  const cutoff = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  cutoff.setUTCHours(end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds());
  return cutoff.getTime();
}

export function filterRows(rows, range, intervalMs = 0) {
  if (range === 'ytd' || range === 'all' || !rows.length) return rows;
  const cutoff = rangeStart(Date.parse(rows.at(-1).date) + intervalMs, range);
  return rows.filter(row => Date.parse(row.date) >= cutoff);
}

/** Compute on complete, validated history before filtering the display range.
 * Fixed windows require all paired candles; all-history means use only the
 * observations available up to each point. Neither mode reads future samples.
 * `field` picks the averaged metric: percent `spread` or `absolute` USDT.
 */
export function rollingAverages(rows, range, intervalMs, field = 'spread') {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw Error('Invalid candle interval');
  if (!['1d', '1w', '1m', 'all'].includes(range)) throw Error('Invalid average range');
  const totals = [0];
  for (const row of rows) totals.push(totals.at(-1) + row[field]);
  return rows.map((row, index) => {
    const end = row.time + intervalMs;
    const start = range === 'all' ? rows[0].time : rangeStart(end, range);
    // Month-end clamping can move the cutoff backwards, so search each prefix.
    let left = 0, right = index + 1;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (rows[middle].time < start) left = middle + 1;
      else right = middle;
    }
    const averageCount = index - left + 1;
    const averageExpectedCount = (end - start) / intervalMs;
    const complete = averageCount === averageExpectedCount;
    return { ...row, average: range === 'all' || complete ? (totals[index + 1] - totals[left]) / averageCount : null,
      averageCount, averageExpectedCount };
  });
}

export function summarize(rows, field = 'spread') {
  if (!rows.length) throw new Error('Cannot summarize empty observations');
  return { average: rows.reduce((sum, row) => sum + row[field], 0) / rows.length, min: rows.reduce((a, b) => b[field] < a[field] ? b : a), max: rows.reduce((a, b) => b[field] > a[field] ? b : a), latest: rows.at(-1), first: rows[0], count: rows.length };
}

export function monthlyAverages(rows, field = 'spread') {
  const groups = new Map();
  for (const row of rows) { const month = row.date.slice(0, 7); const group = groups.get(month) ?? []; group.push(row); groups.set(month, group); }
  return [...groups].map(([month, group]) => ({ month, average: summarize(group, field).average, count: group.length }));
}

export function chartDomain(values) {
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, 0.5);
  return { min: Math.floor((min - padding) * 2) / 2, max: Math.ceil((max + padding) * 2) / 2 };
}
