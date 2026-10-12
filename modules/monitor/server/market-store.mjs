import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateHynixQuote, validateHynixHistory, validateHynixFunding, validateOilQuote, validateOilHistory, validateOilFunding } from '../lib/market-validation.ts';
import { comparisonExchanges, exchangeAction, validateComparisonQuote } from '../lib/exchange-quotes.ts';
import { OIL_CANDLE_ACTION, validateIntradaySnapshot } from '../modules/oil/intraday.mjs';
import { validateGoldOilQuote, validateGoldOilHistory, GOLD_OIL_VARIANTS, goldOilAction } from '../lib/gold-oil.ts';
import { validateGoldOilFunding } from '../lib/gold-oil-funding.ts';
import { exchangeFundingAction, validateExchangeFundingHistory } from '../lib/exchange-funding-history.ts';
import { OIL_HEDGE_PRICES_ACTION, validateOilHedgePrices } from '../lib/oil-hedge-prices.ts';

const validators = { 'hynix/quote': validateHynixQuote, 'hynix/history': validateHynixHistory, 'hynix/funding': validateHynixFunding, 'oil/quote': validateOilQuote, 'oil/history': validateOilHistory, 'oil/funding': validateOilFunding };
validators[`oil/${OIL_CANDLE_ACTION}`] = validateIntradaySnapshot;
for (const { oilType, exchange } of GOLD_OIL_VARIANTS) for (const [action, validate] of Object.entries({ quote: validateGoldOilQuote, history: validateGoldOilHistory, funding: validateGoldOilFunding })) {
  validators[`cl-xau/${goldOilAction(action, oilType, exchange)}`] = value => validate(value, oilType, exchange);
}
validators[`oil/${OIL_HEDGE_PRICES_ACTION}`] = validateOilHedgePrices;
for (const id of ['oil', 'hynix']) for (const exchange of comparisonExchanges(id)) validators[`${id}/${exchangeAction(exchange)}`] = value => validateComparisonQuote(value, exchange, id);
for (const exchange of comparisonExchanges('oil')) validators[`oil/${exchangeFundingAction(exchange)}`] = value => validateExchangeFundingHistory(value, exchange);
export const datasetKeys = Object.keys(validators);
const timestamp = value => Date.parse(value.fetchedAt ?? value.metadata?.fetchedAt);
const keyFor = (id, action) => { const key = `${id}/${action}`; if (!Object.hasOwn(validators, key)) throw new Error('Unknown market dataset'); return key; };
// Old CL payloads remain on disk; normalize only at the read boundary.
const decode = (key, payload) => key.startsWith('cl-xau/') ? validators[key](JSON.parse(payload)) : JSON.parse(payload);
// Source changes use a new namespace. Existing Hyperliquid snapshots and every old observation stay untouched.
export const storageKey = key => ['oil/quote', 'oil/history', 'oil/funding', `oil/${OIL_CANDLE_ACTION}`].includes(key) ? key.replace('oil/', 'oil/binance/') : key;

function hedgePriceObservations(value) {
  const hours = new Map();
  for (const leg of value.legs) for (const row of leg.rows) {
    const hour = hours.get(row.time) ?? { time: row.time, legs: [] };
    hour.legs.push({ exchange: leg.exchange, symbol: leg.symbol, price: row.price, fetchedAt: leg.fetchedAt });
    hours.set(row.time, hour);
  }
  return [...hours.values()].sort((a, b) => a.time - b.time);
}

/** One durable source of truth. GETs never invoke a loader or write to this database. */
export async function openMarketStore(filename, { clock = Date.now } = {}) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported market database version');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS market_datasets (key TEXT PRIMARY KEY, payload TEXT, source_ms INTEGER, saved_ms INTEGER, attempt_ms INTEGER, success_ms INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS market_observations (dataset TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL, source_ms INTEGER NOT NULL, PRIMARY KEY(dataset, time));
      PRAGMA user_version=1;
      COMMIT;`);
    const get = db.prepare('SELECT * FROM market_datasets WHERE key=?');
    const insert = db.prepare('INSERT OR IGNORE INTO market_datasets(key) VALUES (?)');
    for (const key of datasetKeys) insert.run(storageKey(key));
    const observation = db.prepare(`INSERT INTO market_observations(dataset,time,payload,source_ms) VALUES (?,?,?,?)
      ON CONFLICT(dataset,time) DO UPDATE SET payload=excluded.payload,source_ms=excluded.source_ms
      WHERE excluded.source_ms>=market_observations.source_ms AND excluded.payload<>market_observations.payload`);
    const save = db.prepare('UPDATE market_datasets SET payload=?,source_ms=?,saved_ms=?,attempt_ms=?,success_ms=?,error=NULL WHERE key=?');
    const recordFailure = db.prepare('UPDATE market_datasets SET attempt_ms=?,error=? WHERE key=?');
    const countObservations = db.prepare('SELECT count(*) AS count FROM market_observations WHERE dataset=?');
    let closed = false;
    return {
      raw(id, action) { const key = keyFor(id, action), row = get.get(storageKey(key)); return row.payload ? decode(key, row.payload) : null; },
      write(id, action, input, { seed = false } = {}) {
        const key = keyFor(id, action), persistedKey = storageKey(key), previous = get.get(persistedKey);
        if (seed && previous.payload) return false;
        const now = clock();
        let value, sourceMs;
        try {
          value = validators[key](action === 'quote' || action.endsWith('/quote') ? input : { ...input, status: seed ? 'snapshot' : 'live' });
          sourceMs = timestamp(value);
          if (!Number.isFinite(sourceMs) || sourceMs > now + 60_000) throw new Error('Invalid future market timestamp');
          if (previous.payload && sourceMs < previous.source_ms) throw new Error('Refusing an older market dataset');
        } catch (cause) { throw Object.assign(new Error('Invalid collected market data', { cause }), { code: 'MARKET_DATA_INVALID' }); }
        const rows = action === OIL_HEDGE_PRICES_ACTION ? hedgePriceObservations(value) : action === 'quote' || action.endsWith('/quote') ? [{ time: sourceMs, ...value }] : value.points ?? value.rows ?? value.data;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of rows) observation.run(persistedKey, row.time ?? Date.parse(row.date), JSON.stringify(row), sourceMs);
          save.run(JSON.stringify(value), sourceMs, now, seed ? null : now, seed ? null : now, persistedKey);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return true;
      },
      fail(id, action, message) {
        recordFailure.run(clock(), message, storageKey(keyFor(id, action)));
      },
      read(id, action, { maxAgeMs = action === 'quote' || action.endsWith('/quote') ? 45_000 : 615_000, fresh = false } = {}) {
        const key = keyFor(id, action), row = get.get(storageKey(key));
        if (!row.payload) throw new Error('数据库尚未收到行情，后台正在采集。');
        const stale = row.success_ms === null || Boolean(row.error) || clock() - row.source_ms > maxAgeMs;
        if (fresh && stale) throw new Error('后台行情采集失败或已过期。');
        return { ...decode(key, row.payload), status: stale ? 'snapshot' : 'live', collection: { source: 'database', stale, maxAgeMs, lastAttemptAt: row.attempt_ms === null ? null : new Date(row.attempt_ms).toISOString(), lastSuccessAt: row.success_ms === null ? null : new Date(row.success_ms).toISOString(), error: row.error } };
      },
      status() { return datasetKeys.map(key => { const { payload: _payload, ...row } = get.get(storageKey(key)); return { ...row, key }; }).sort((a, b) => a.key.localeCompare(b.key)); },
      count(id, action) { return countObservations.get(storageKey(keyFor(id, action))).count; },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
