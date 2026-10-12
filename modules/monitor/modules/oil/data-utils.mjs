import { oilSpreadPercent } from './spread.mjs';

export const round = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000;
export const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(3)}`;

export function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No daily observations');
  let previous = '';
  return rows.map(row => {
    if (!/^2026-\d{2}-\d{2}$/.test(row.date) || row.date <= previous || !Number.isFinite(row.brent) || !Number.isFinite(row.wti) || row.brent <= 0 || row.wti <= 0) throw new Error('Invalid daily observation');
    previous = row.date;
    const spread = oilSpreadPercent(row.brent, row.wti);
    if (spread === null) throw new Error('Invalid daily spread');
    return { date: row.date, brent: row.brent, wti: row.wti, spread };
  });
}

export function filterRows(rows, range, intervalMs = 0) {
  if (range === 'ytd' || range === 'all' || !rows.length) return rows;
  const end = new Date(Date.parse(rows.at(-1).date) + intervalMs);
  if (range === '1d' || range === '1w') return rows.filter(row => Date.parse(row.date) >= end.getTime() - (range === '1d' ? 1 : 7) * 86_400_000);
  if (!['1m', '3m'].includes(range)) throw Error('Invalid chart range');
  const months = range === '1m' ? 1 : 3;
  const cutoff = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  cutoff.setUTCHours(end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds());
  return rows.filter(row => Date.parse(row.date) >= cutoff.getTime());
}

export function summarize(rows) {
  if (!rows.length) throw new Error('Cannot summarize empty observations');
  return { average: rows.reduce((sum, row) => sum + row.spread, 0) / rows.length, min: rows.reduce((a, b) => b.spread < a.spread ? b : a), max: rows.reduce((a, b) => b.spread > a.spread ? b : a), latest: rows.at(-1), first: rows[0], count: rows.length };
}

export function monthlyAverages(rows) {
  const groups = new Map();
  for (const row of rows) { const month = row.date.slice(0, 7); const group = groups.get(month) ?? []; group.push(row); groups.set(month, group); }
  return [...groups].map(([month, group]) => ({ month, average: summarize(group).average, count: group.length }));
}

export function chartDomain(values) {
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, 0.5);
  return { min: Math.floor((min - padding) * 2) / 2, max: Math.ceil((max + padding) * 2) / 2 };
}
