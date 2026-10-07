import { addDecimals, compareDecimals, decimal } from './trading-decimal.mjs';

const DAY = 86_400_000;
export const PNL_INTERVAL = 60_000;
const MAX_AGE = 75_000, MAX_SKEW = 45_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

// Reduce continuous runs independently. Keep every gap boundary, even if highly
// intermittent data needs more than the usual 1,200 display points.
export function reducePnlPoints(points) {
  if (points.length <= 1200) return points;
  const width = Math.ceil(points.length / 180), result = [];
  for (let offset = 0; offset < points.length;) {
    const mask = point => `${point.unrealizedPnl === null}:${point.fundingPnl === null}:${point.totalPnl === null}`;
    let end = offset + 1;
    while (end < points.length && end - offset < width && mask(points[end]) === mask(points[offset])) end++;
    const bucket = points.slice(offset, end);
    offset = end;
    const selected = new Set([0, bucket.length - 1]);
    for (const key of ['unrealizedPnl', 'totalPnl']) {
      if (bucket[0][key] === null) continue;
      let min = 0, max = 0;
      for (let i = 1; i < bucket.length; i++) {
        if (compareDecimals(bucket[i][key], bucket[min][key]) < 0) min = i;
        if (compareDecimals(bucket[i][key], bucket[max][key]) > 0) max = i;
      }
      selected.add(min); selected.add(max);
    }
    for (const index of [...selected].sort((a, b) => a - b)) result.push(bucket[index]);
  }
  return result;
}

export function createTradingPnl(db) {
  db.exec('CREATE TABLE IF NOT EXISTS trading_pnl_samples (time INTEGER NOT NULL, binance_revision INTEGER NOT NULL, bybit_revision INTEGER NOT NULL, binance_at INTEGER, bybit_at INTEGER, unrealized_pnl TEXT, PRIMARY KEY (binance_revision, bybit_revision, time))');
  const revisions = entries => entries.map(({ row }) => row.revision);
  const latestRow = entries => db.prepare('SELECT * FROM trading_pnl_samples WHERE binance_revision=? AND bybit_revision=? ORDER BY time DESC LIMIT 1').get(...revisions(entries));
  function record(entries, current) {
    if (entries.some(({ row }) => !row.credentials)) return;
    const sources = entries.map(({ snapshot }) => stamp(snapshot.positions.fetchedAt));
    const rows = entries.flatMap(({ snapshot }) => snapshot.positions.rows);
    const good = entries.every(({ snapshot }, index) => !snapshot.positions.error && validTime(sources[index]) && sources[index] <= current && current - sources[index] <= MAX_AGE)
      && Math.max(...sources) - Math.min(...sources) <= MAX_SKEW && rows.every(row => row.unrealizedPnl !== null);
    const time = good ? Math.max(...sources) : current;
    const previous = latestRow(entries);
    if (previous && (time <= previous.time || Math.floor(time / PNL_INTERVAL) === Math.floor(previous.time / PNL_INTERVAL) && (previous.unrealized_pnl !== null) === good)) return;
    const value = good ? addDecimals(rows.map(row => row.unrealizedPnl)) : null;
    db.prepare('INSERT OR IGNORE INTO trading_pnl_samples VALUES (?,?,?,?,?,?)').run(time, ...revisions(entries), ...sources.map(value => validTime(value) ? value : null), value);
    db.prepare('DELETE FROM trading_pnl_samples WHERE time < ? OR binance_revision != ? OR bybit_revision != ?').run(current - 31 * DAY, ...revisions(entries));
  }
  function read(entries, start, current) {
    const connected = entries.every(({ row }) => !!row.credentials);
    const records = connected ? db.prepare('SELECT * FROM trading_pnl_samples WHERE binance_revision=? AND bybit_revision=? AND time>=? AND time<=? ORDER BY time').all(...revisions(entries), start, current) : [];
    const first = connected ? db.prepare('SELECT MIN(time) AS time FROM trading_pnl_samples WHERE binance_revision=? AND bybit_revision=? AND unrealized_pnl IS NOT NULL').get(...revisions(entries)).time : null;
    const events = entries.flatMap(({ snapshot }) => snapshot.funding.events).filter(row => stamp(row.time) >= start).sort((a, b) => stamp(a.time) - stamp(b.time));
    let eventIndex = 0, accumulated = '0';
    const points = [], gap = time => ({ time, unrealizedPnl: null, fundingPnl: null, totalPnl: null });
    for (const row of records) {
      const previous = points.at(-1);
      if (previous && row.time - previous.time > PNL_INTERVAL * 2.5) points.push(gap(previous.time + PNL_INTERVAL));
      while (eventIndex < events.length && stamp(events[eventIndex].time) < row.time) accumulated = addDecimals([accumulated, events[eventIndex++].amount]);
      const known = entries.every(({ snapshot }) => snapshot.funding.coverage.some(range => range.start <= start && range.end >= row.time));
      const unrealizedPnl = row.unrealized_pnl === null ? null : decimal(row.unrealized_pnl);
      const fundingPnl = known ? accumulated : null;
      points.push({ time: row.time, unrealizedPnl, fundingPnl, totalPnl: unrealizedPnl !== null && fundingPnl !== null ? addDecimals([unrealizedPnl, fundingPnl]) : null });
    }
    if (points.length && current - points.at(-1).time > MAX_AGE) points.push(gap(current));
    const latest = points.at(-1) ?? null;
    return { currency: 'USDT', intervalMs: PNL_INTERVAL, cumulativeStart: start, end: current, recordingStartedAt: first,
      pointCount: records.length, points: reducePnlPoints(points), latest,
      status: !records.some(row => row.unrealized_pnl !== null) ? 'collecting' : latest?.totalPnl === null ? 'incomplete' : 'ready' };
  }
  return { record, read };
}
