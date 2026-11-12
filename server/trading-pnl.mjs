import { addDecimals, compareDecimals, decimalUnits, formatDecimalUnits } from './trading-decimal.mjs';
import { createStatementCache } from './db-cache.mjs';


const DAY = 86_400_000;
export const PNL_INTERVAL = 60_000;
const MAX_AGE = 75_000, MAX_SKEW = 45_000;
const EXCHANGES = ['binance', 'bybit', 'okx'];
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

function pairSource(entries) {
  if (entries.length !== 2) throw new TypeError('PnL requires exactly two exchanges');
  // Older callers supplied Binance and Bybit in that order without exchange IDs.
  const sources = entries.map((entry, index) => ({ entry, exchange: entry.row.exchange ?? EXCHANGES[index] }));
  if (sources.some(({ exchange }) => !EXCHANGES.includes(exchange)) || sources[0].exchange === sources[1].exchange) throw new TypeError('PnL requires two distinct supported exchanges');
  sources.sort((a, b) => EXCHANGES.indexOf(a.exchange) - EXCHANGES.indexOf(b.exchange));
  return {
    entries: sources.map(({ entry }) => entry),
    pairKey: sources.map(({ exchange }) => exchange).join(':'),
    revisionKey: JSON.stringify(sources.map(({ entry, exchange }) => [exchange, entry.row.revision])),
  };
}

function migrateSamples(db, stmt) {
  // A persistent marker prevents retained legacy rows from resurrecting samples
  // that have since expired or belonged to a replaced account revision.
  db.exec('SAVEPOINT trading_pnl_v2_migration');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS trading_pnl_samples (time INTEGER NOT NULL, binance_revision INTEGER NOT NULL, bybit_revision INTEGER NOT NULL, binance_at INTEGER, bybit_at INTEGER, unrealized_pnl TEXT, PRIMARY KEY (binance_revision, bybit_revision, time))');
    db.exec('CREATE TABLE IF NOT EXISTS trading_pnl_samples_v2 (pair_key TEXT NOT NULL, revision_key TEXT NOT NULL, time INTEGER NOT NULL, first_at INTEGER, second_at INTEGER, unrealized_pnl TEXT, cumulative_funding_pnl TEXT, PRIMARY KEY (pair_key, revision_key, time))');
    // cumulative_funding_pnl is no longer written or read; keep the column so every database shares one schema.
    if (!stmt.prepare('PRAGMA table_info(trading_pnl_samples_v2)').all().some(col => col.name === 'cumulative_funding_pnl')) {
      db.exec('ALTER TABLE trading_pnl_samples_v2 ADD COLUMN cumulative_funding_pnl TEXT');
    }
    db.exec('CREATE TABLE IF NOT EXISTS trading_pnl_migrations (id TEXT PRIMARY KEY)');
    if (!stmt.prepare('SELECT id FROM trading_pnl_migrations WHERE id=?').get('pair_samples_v2')) {
      const insert = stmt.prepare('INSERT OR IGNORE INTO trading_pnl_samples_v2 (pair_key,revision_key,time,first_at,second_at,unrealized_pnl) VALUES (?,?,?,?,?,?)');
      for (const row of stmt.prepare('SELECT * FROM trading_pnl_samples').iterate()) {
        insert.run('binance:bybit', JSON.stringify([['binance', row.binance_revision], ['bybit', row.bybit_revision]]), row.time, row.binance_at, row.bybit_at, row.unrealized_pnl);
      }
      stmt.prepare('INSERT INTO trading_pnl_migrations (id) VALUES (?)').run('pair_samples_v2');
    }
    db.exec('RELEASE SAVEPOINT trading_pnl_v2_migration');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT trading_pnl_v2_migration');
    db.exec('RELEASE SAVEPOINT trading_pnl_v2_migration');
    throw error;
  }
}

// Reduce continuous runs independently. Keep every gap boundary, even if highly
// intermittent data needs more than the usual 1,200 display points.
function reducePoints(points, compare) {
  if (points.length <= 1200) return points;
  const width = Math.ceil(points.length / 180), result = [];
  for (let offset = 0; offset < points.length;) {
    const mask = point => (point.unrealizedPnl === null) | (point.fundingPnl === null) << 1 | (point.realizedPnl === null) << 2 | (point.totalPnl === null) << 3;
    let end = offset + 1;
    while (end < points.length && end - offset < width && mask(points[end]) === mask(points[offset])) end++;
    const bucket = points.slice(offset, end);
    offset = end;
    const selected = new Set([0, bucket.length - 1]);
    for (const key of ['unrealizedPnl', 'totalPnl']) {
      if (bucket[0][key] === null) continue;
      let min = 0, max = 0;
      for (let i = 1; i < bucket.length; i++) {
        if (compare(bucket[i][key], bucket[min][key]) < 0) min = i;
        if (compare(bucket[i][key], bucket[max][key]) > 0) max = i;
      }
      selected.add(min); selected.add(max);
    }
    for (const index of [...selected].sort((a, b) => a - b)) result.push(bucket[index]);
  }
  return result;
}
export const reducePnlPoints = points => reducePoints(points, compareDecimals);

// read() keeps values as exact fixed-point units: rebuilding a month of minute
// samples through decimal strings blocked the shared runtime for seconds.
const compareUnits = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const POINT_VALUES = ['unrealizedPnl', 'fundingPnl', 'realizedPnl', 'feePnl', 'totalPnl'];
function formatPoint(point) {
  const result = { time: point.time };
  for (const key of POINT_VALUES) result[key] = point[key] === null ? null : formatDecimalUnits(point[key]);
  return result;
}

export function createTradingPnl(db, stmt) {
  if (!stmt) stmt = createStatementCache(db);
  migrateSamples(db, stmt);

  // Lazy-load prepared statements to avoid triggering them during initialization
  const latestRow = ({ pairKey, revisionKey }) => stmt.prepare('SELECT * FROM trading_pnl_samples_v2 WHERE pair_key=? AND revision_key=? ORDER BY time DESC LIMIT 1').get(pairKey, revisionKey);
  let insertSample, deleteSamples, selectSamples, countSamples, selectFirstTime;
  // Parsed samples per pair, so each minute's view rebuild reads only the rows
  // recorded since the last read instead of re-parsing a month of samples.
  // record() only appends rows newer than the latest one; a row count check on
  // every read catches retention deletes or any other change, and reloads.
  const sampleCache = new Map();

  function record(entries, current) {
    if (!insertSample) {
      insertSample = stmt.prepare('INSERT OR IGNORE INTO trading_pnl_samples_v2 (pair_key,revision_key,time,first_at,second_at,unrealized_pnl) VALUES (?,?,?,?,?,?)');
      deleteSamples = stmt.prepare('DELETE FROM trading_pnl_samples_v2 WHERE pair_key=? AND (time < ? OR revision_key != ?)');
    }
    const pair = pairSource(entries);
    entries = pair.entries;
    if (entries.some(({ row }) => !row.credentials)) return false;
    const sources = entries.map(({ snapshot }) => stamp(snapshot.positions.fetchedAt));
    const rows = entries.flatMap(({ snapshot }) => snapshot.positions.rows);
    const good = entries.every(({ snapshot }, index) => !snapshot.positions.error && validTime(sources[index]) && sources[index] <= current && current - sources[index] <= MAX_AGE)
      && Math.max(...sources) - Math.min(...sources) <= MAX_SKEW && rows.every(row => row.unrealizedPnl !== null);
    const time = good ? Math.max(...sources) : current;
    const previous = latestRow(pair);
    if (previous && (time <= previous.time || Math.floor(time / PNL_INTERVAL) === Math.floor(previous.time / PNL_INTERVAL) && (previous.unrealized_pnl !== null) === good)) return false;
    const value = good ? addDecimals(rows.map(row => row.unrealizedPnl)) : null;
    insertSample.run(pair.pairKey, pair.revisionKey, time, ...sources.map(value => validTime(value) ? value : null), value);
    deleteSamples.run(pair.pairKey, current - 31 * DAY, pair.revisionKey);
    return true;
  }
  function samples({ pairKey, revisionKey }, start, current) {
    let cache = sampleCache.get(pairKey);
    const bound = time => {
      let lo = 0, hi = cache.time.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cache.time[mid] < time) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const append = after => {
      for (const row of selectSamples.all(pairKey, revisionKey, after + 1, current)) {
        cache.time.push(row.time); cache.firstAt.push(row.first_at); cache.secondAt.push(row.second_at);
        cache.units.push(row.unrealized_pnl === null ? null : decimalUnits(row.unrealized_pnl));
      }
    };
    const reload = () => {
      sampleCache.delete(pairKey);
      cache = { revisionKey, from: start, time: [], firstAt: [], secondAt: [], units: [] };
      append(start - 1);
      sampleCache.set(pairKey, cache);
    };
    if (cache?.revisionKey === revisionKey && current - 31 * DAY > cache.from) {
      // Retention keeps 31 days (see record); drop older rows as the database does.
      const keep = bound(current - 31 * DAY);
      for (const key of ['time', 'firstAt', 'secondAt', 'units']) cache[key].splice(0, keep);
      cache.from = current - 31 * DAY;
    }
    if (!cache || cache.revisionKey !== revisionKey || start < cache.from) reload();
    else append(cache.time.length ? cache.time.at(-1) : cache.from - 1);
    let from = bound(start), to = bound(current + 1);
    if (to - from !== countSamples.get(pairKey, revisionKey, start, current).count) {
      reload(); from = bound(start); to = bound(current + 1);
    }
    return { ...cache, from, to };
  }
  function read(entries, start, current) {
    if (!selectSamples) {
      selectSamples = stmt.prepare('SELECT time, first_at, second_at, unrealized_pnl FROM trading_pnl_samples_v2 WHERE pair_key=? AND revision_key=? AND time>=? AND time<=? ORDER BY time');
      countSamples = stmt.prepare('SELECT COUNT(*) AS count FROM trading_pnl_samples_v2 WHERE pair_key=? AND revision_key=? AND time>=? AND time<=?');
      selectFirstTime = stmt.prepare('SELECT MIN(time) AS time FROM trading_pnl_samples_v2 WHERE pair_key=? AND revision_key=? AND unrealized_pnl IS NOT NULL');
    }
    const pair = pairSource(entries);
    entries = pair.entries;
    const connected = entries.every(({ row }) => !!row.credentials);
    const records = connected ? samples(pair, start, current) : null;
    const count = records ? records.to - records.from : 0;
    const first = connected ? selectFirstTime.get(pair.pairKey, pair.revisionKey).time : null;
    // Ledger rows since the period start, oldest first, each with its parsed time.
    const since = rows => rows.map(row => ({ at: stamp(row.time), row })).filter(item => item.at >= start).sort((a, b) => a.at - b.at);
    const events = since(entries.flatMap(({ snapshot }) => snapshot.funding.events));
    // Closing PnL and fees move value out of unrealized PnL into the account
    // balance; without them a reduction would read as a loss.
    // Each exchange's trades stop at its own position read time, so a fill between
    // the two reads is never counted both as closing PnL and as unrealized PnL.
    const trades = entries.map(({ snapshot }) => since(snapshot.trades?.events ?? [])), tradeIndex = trades.map(() => 0);
    let eventIndex = 0, accumulated = 0n, realized = 0n, fees = 0n;
    const points = [], gap = time => ({ time, unrealizedPnl: null, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null });
    // A ledger covers a sample when, on every exchange, one of its ranges spans
    // from the period start to the sample time: time <= the reach computed here.
    const coveredUntil = ledger => {
      let reach = Infinity;
      for (const { snapshot } of entries) {
        let best = -Infinity;
        for (const range of ledger(snapshot)?.coverage ?? []) if (range.start <= start && range.end > best) best = range.end;
        if (best < reach) reach = best;
      }
      return reach;
    };
    const fundingUntil = coveredUntil(snapshot => snapshot.funding), tradesUntil = coveredUntil(snapshot => snapshot.trades);
    let recorded = false;
    for (let sample = records?.from ?? 0; sample < (records?.to ?? 0); sample++) {
      const time = records.time[sample], previous = points.at(-1);
      if (previous && time - previous.time > PNL_INTERVAL * 2.5) points.push(gap(previous.time + PNL_INTERVAL));
      while (eventIndex < events.length && events[eventIndex].at < time) accumulated += decimalUnits(events[eventIndex++].row.amount);
      for (const [index, rows] of trades.entries()) {
        const cutoff = (index === 0 ? records.firstAt[sample] : index === 1 ? records.secondAt[sample] : undefined) ?? time;
        while (tradeIndex[index] < rows.length && rows[tradeIndex[index]].at < cutoff) {
          const trade = rows[tradeIndex[index]++].row;
          if (trade.kind === 'fee') fees += decimalUnits(trade.amount); else realized += decimalUnits(trade.amount);
        }
      }
      const known = time <= fundingUntil, tradesKnown = time <= tradesUntil, unrealizedPnl = records.units[sample];
      if (unrealizedPnl !== null) recorded = true;
      const fundingPnl = known ? accumulated : null, realizedPnl = tradesKnown ? realized : null, feePnl = tradesKnown ? fees : null;
      points.push({ time, unrealizedPnl, fundingPnl, realizedPnl, feePnl, totalPnl: unrealizedPnl !== null && fundingPnl !== null && realizedPnl !== null && feePnl !== null ? unrealizedPnl + fundingPnl + realizedPnl + feePnl : null });
    }
    if (points.length && current - points.at(-1).time > MAX_AGE) points.push(gap(current));
    const latest = points.length ? formatPoint(points.at(-1)) : null;
    return { currency: 'USDT', intervalMs: PNL_INTERVAL, cumulativeStart: start, end: current, recordingStartedAt: first,
      pointCount: count, points: reducePoints(points, compareUnits).map(formatPoint), latest,
      status: !recorded ? 'collecting' : latest?.totalPnl === null ? 'incomplete' : 'ready' };
  }
  return { record, read, sourceKey: entries => latestRow(pairSource(entries))?.time ?? null };
}
