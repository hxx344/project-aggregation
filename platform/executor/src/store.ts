// The executor's own SQLite database. It never opens a legacy runtime file:
// the entry point gives it a dedicated data directory (plan 1, 6.3).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface Migration { version: number; name: string; sql: string }

// Append only. A released migration is never edited: its SQL hash is stored
// and a mismatch stops the process instead of running on a drifted schema.
export const MIGRATIONS: readonly Migration[] = Object.freeze([{
  version: 1,
  name: 'executor-core',
  sql: `
CREATE TABLE accounts (account_key TEXT PRIMARY KEY, venue TEXT NOT NULL, environment TEXT NOT NULL, account_id TEXT NOT NULL,
  account_mode TEXT NOT NULL, credential_version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX accounts_venue ON accounts(venue, environment);
CREATE TABLE writer (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE previews (id TEXT PRIMARY KEY, session TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_job TEXT, json TEXT NOT NULL);
CREATE TABLE commands (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL, session TEXT NOT NULL, job_id TEXT NOT NULL, accepted_at INTEGER NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, final INTEGER NOT NULL, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX jobs_unfinished ON jobs(created_at) WHERE final = 0;
CREATE TABLE operations (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), leg INTEGER NOT NULL, venue TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, settled INTEGER NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX operations_job ON operations(job_id, leg);
CREATE TABLE locks (resource TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id));
CREATE TABLE stop_requests (job_id TEXT PRIMARY KEY REFERENCES jobs(id), request_id TEXT NOT NULL, requested_at INTEGER NOT NULL);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, type TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX events_job ON events(job_id, seq);
`,
}, {
  version: 2,
  name: 'history-retention',
  sql: `
CREATE INDEX events_at ON events(at);
CREATE INDEX commands_accepted ON commands(accepted_at);
CREATE INDEX previews_consumed ON previews(expires_at) WHERE consumed_job IS NOT NULL;
`,
}]);

export const sqlHash = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const WAIT_BUCKETS_MS = [1, 10, 100, 1000, 5000] as const;
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SAMPLE_LIMIT = 20_000;
export interface WriteStats { transactions: number; busy: number; waitBuckets: number[]; maxWaitMs: number; maxHoldMs: number; waits: number[]; holds: number[] }

export interface Store {
  readonly db: DatabaseSync;
  readonly file: string;
  schemaVersion(): number;
  /** Short IMMEDIATE transaction. The callback must be synchronous: no network or timers inside. */
  tx<T>(operation: () => T): T;
  stats(): WriteStats;
  close(): void;
}

const isBusy = (error: unknown): boolean => (error as { code?: string; errcode?: number })?.code === 'ERR_SQLITE_ERROR' && (((error as { errcode?: number }).errcode ?? 0) & 0xff) === 5;

export function openStore(file: string, { busyTimeoutMs = 5000 }: { busyTimeoutMs?: number } = {}): Store {
  const db = new DatabaseSync(file);
  const stats: WriteStats = { transactions: 0, busy: 0, waitBuckets: Array(WAIT_BUCKETS_MS.length + 1).fill(0), maxWaitMs: 0, maxHoldMs: 0, waits: [], holds: [] };
  const sample = (list: number[], value: number) => { if (list.length >= SAMPLE_LIMIT) list.splice(0, list.length - SAMPLE_LIMIT + 1); list.push(value); };
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new StoreError('journal_mode', `数据库未能进入 WAL 模式：${mode}`);
    // journal_size_limit truncates the WAL back to 64 MiB after a checkpoint; it does not cap a WAL a long reader keeps growing.
    db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${Math.trunc(busyTimeoutMs)}; PRAGMA journal_size_limit=${WAL_SIZE_LIMIT_BYTES};`);
  } catch (error) { db.close(); throw error; }

  function tx<T>(operation: () => T): T {
    if (db.isTransaction) throw new StoreError('nested_transaction', '不允许嵌套事务');
    const requested = performance.now();
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (isBusy(error)) stats.busy++; throw error; }
    const acquired = performance.now(), wait = acquired - requested;
    stats.transactions++;
    const bucket = WAIT_BUCKETS_MS.findIndex(limit => wait < limit);
    stats.waitBuckets[bucket < 0 ? WAIT_BUCKETS_MS.length : bucket]++;
    stats.maxWaitMs = Math.max(stats.maxWaitMs, wait); sample(stats.waits, wait);
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new StoreError('async_transaction', '事务回调不能是异步函数');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      const hold = performance.now() - acquired;
      stats.maxHoldMs = Math.max(stats.maxHoldMs, hold); sample(stats.holds, hold);
    }
  }

  try { migrate(db, tx); } catch (error) { db.close(); throw error; }
  return {
    db, file,
    schemaVersion: () => (db.prepare('SELECT IFNULL(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version,
    tx,
    stats: () => ({ ...stats, waitBuckets: [...stats.waitBuckets], waits: [...stats.waits], holds: [...stats.holds] }),
    close: () => { if (db.isOpen) db.close(); },
  };
}

function migrate(db: DatabaseSync, tx: <T>(operation: () => T) => T): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sql_sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const known = new Map(MIGRATIONS.map(migration => [migration.version, migration]));
  const applied = db.prepare('SELECT version, name, sql_sha256 FROM schema_migrations ORDER BY version').all() as { version: number; name: string; sql_sha256: string }[];
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) throw new StoreError('newer_schema', `数据库结构版本 ${row.version} 比本程序更新，拒绝打开`);
    if (migration.name !== row.name || sqlHash(migration.sql) !== row.sql_sha256) throw new StoreError('schema_drift', `数据库结构版本 ${row.version} 与本程序记录的定义不一致`);
  }
  const done = new Set(applied.map(row => row.version));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    if (migration.version !== Math.max(0, ...done) + 1) throw new StoreError('migration_gap', `迁移版本不连续：${migration.version}`);
    tx(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, sql_sha256, applied_at) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, sqlHash(migration.sql), Date.now());
    });
    done.add(migration.version);
  }
}
