import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Bounded latest quotes only: no unbounded tick history or writes on page reads. */
export async function openPerpetualStore(filename) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    // This is a recoverable public-quote cache, separate from alert/user data.
    // WAL NORMAL avoids a disk fsync on every batch. A busy writer fails quickly
    // and the collector retries its bounded dirty map, instead of blocking WS for 5s.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=4194304;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported perpetual database version');
    db.exec('CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version=1;');
    // Additive cache tables keep older binaries compatible during installer rollback.
    db.exec('CREATE TABLE IF NOT EXISTS quality_samples (bucket INTEGER PRIMARY KEY, payload BLOB NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS price_history_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS funding_history_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS contract_metrics_cache (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL);');
    const upsert = db.prepare('INSERT INTO quotes(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    const insertSample = db.prepare('INSERT INTO quality_samples(bucket,payload) VALUES (?,?) ON CONFLICT(bucket) DO NOTHING');
    const pruneSamples = db.prepare('DELETE FROM quality_samples WHERE bucket<=? OR bucket NOT IN (SELECT bucket FROM quality_samples ORDER BY bucket DESC LIMIT 1440)');
    const selectQuotes = db.prepare('SELECT payload FROM quotes');
    const removeQuote = db.prepare('DELETE FROM quotes WHERE id=?');
    const selectExchangeQuotes = db.prepare('SELECT id FROM quotes WHERE id >= ? AND id < ?');
    function publicCache(table) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_updated_at ON ${table}(updated_at DESC)`);
      const selectOne = db.prepare(`SELECT payload FROM ${table} WHERE id=?`);
      const selectRecent = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at DESC LIMIT ?`);
      const write = db.prepare(`INSERT INTO ${table}(id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload`);
      const trim = db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY updated_at DESC LIMIT 5000)`);
      const size = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
      return {
        load(key, limit = 500) {
          const rows = key === undefined ? selectRecent.all(Math.max(1, Math.min(5000, Math.trunc(limit) || 500))) : selectOne.all(key);
          return rows.flatMap(row => {
            try { return [JSON.parse(gunzipSync(row.payload, { maxOutputLength: 1_000_000 }).toString())]; }
            catch { return []; } // A corrupt recoverable cache is a miss, never invented data.
          });
        },
        save(entry) {
          if (!entry || typeof entry.key !== 'string' || !entry.key || entry.key.length > 200 || !Number.isSafeInteger(entry.lastAccessAt) || entry.lastAccessAt < 0) throw new Error('Invalid contract cache entry');
          const json = JSON.stringify(entry);
          if (Buffer.byteLength(json) > 1_000_000) throw new Error('Contract cache entry exceeds size limit');
          const payload = gzipSync(json, { level: 1 });
          db.exec('BEGIN IMMEDIATE');
          try { write.run(entry.key, entry.lastAccessAt, payload); if (size.get().count > 5000) trim.run(); db.exec('COMMIT'); }
          catch (error) { db.exec('ROLLBACK'); throw error; }
        },
      };
    }
    const priceCache = publicCache('price_history_cache'), fundingCache = publicCache('funding_history_cache'), metricsCache = publicCache('contract_metrics_cache');
    let closed = false;
    return {
      load() { return selectQuotes.all().map(row => JSON.parse(row.payload)); },
      loadPriceHistory: priceCache.load,
      savePriceHistory: priceCache.save,
      loadFundingHistory: fundingCache.load,
      saveFundingHistory: fundingCache.save,
      loadContractMetrics: metricsCache.load,
      saveContractMetrics: metricsCache.save,
      *loadQualitySamples(now) {
        // Decode one minute at a time: no full-day JSON allocation on restart.
        // Each iterator needs its own statement so interleaved readers stay independent.
        for (const row of db.prepare('SELECT bucket,payload FROM quality_samples WHERE bucket>? AND bucket<=? ORDER BY bucket LIMIT 1440').iterate(now - 86_400_000, now)) {
          try { yield { bucket: row.bucket, rows: JSON.parse(gunzipSync(row.payload, { maxOutputLength: 2_000_000 }).toString()) }; }
          catch { /* A corrupt public-history bucket remains a gap, never fake data. */ }
        }
      },
      saveQualitySample(bucket, rows) {
        const payload = gzipSync(JSON.stringify(rows), { level: 1 });
        db.exec('BEGIN IMMEDIATE');
        try { insertSample.run(bucket, payload); pruneSamples.run(bucket - 86_400_000); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      save(quotes) {
        db.exec('BEGIN IMMEDIATE');
        try { for (const quote of quotes) upsert.run(`${quote.exchange}:${quote.symbol}`, JSON.stringify(quote)); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      prune(exchange, symbols) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const prefix = `${exchange}:`;
          for (const row of selectExchangeQuotes.all(prefix, `${exchange};`)) {
            if (!symbols.has(row.id.slice(prefix.length))) removeQuote.run(row.id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
