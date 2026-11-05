import { oilSpread } from './spread.mjs';

export function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No daily observations');
  let previous = '';
  return rows.map(row => {
    const time = typeof row.date === 'string' ? Date.parse(row.date) : NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== row.date || row.date <= previous || !Number.isFinite(row.brent) || !Number.isFinite(row.wti) || row.brent <= 0 || row.wti <= 0) throw new Error('Invalid daily observation');
    previous = row.date;
    const spread = oilSpread(row.brent, row.wti);
    if (spread === null) throw new Error('Invalid daily spread');
    return { date: row.date, brent: row.brent, wti: row.wti, spread };
  });
}
