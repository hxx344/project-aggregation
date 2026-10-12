import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { defaults } from './model.mjs';
import { createStatementCache } from './statement-cache.mjs';
export function createStore(directory) {
  mkdirSync(directory, { recursive: true });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const keyPath = join(directory, 'credentials.key'), dbPath = join(directory, 'crossex.sqlite');
  if (!existsSync(keyPath)) { if (existsSync(dbPath)) throw new Error('credentials.key 缺失，请恢复备份'); writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
  const key = readFileSync(keyPath); if (key.length !== 32) throw new Error('credentials.key 无效');
  const db = new DatabaseSync(dbPath);
  const statements = createStatementCache(db), prepare = statements.prepare;
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, status TEXT NOT NULL, pair_key TEXT NOT NULL, signal_id TEXT UNIQUE NOT NULL, opened_at INTEGER NOT NULL, json TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_open_pair ON positions(pair_key) WHERE status='open'; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL);`);
  if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, position_id TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_execution ON executions(position_id) WHERE state NOT IN ('completed','cancelled');
    CREATE TABLE IF NOT EXISTS samples (series TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(series,at));`);
  const get = (name, fallback = null) => { const row = prepare('SELECT value FROM settings WHERE key=?').get(name); return row ? JSON.parse(row.value) : fallback; };
  const set = (name, value) => prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  const event = (at, message) => { prepare('INSERT INTO events(at,message) VALUES (?,?)').run(at, message); db.exec('DELETE FROM events WHERE id <= (SELECT MAX(id)-500 FROM events)'); };
  const encrypt = value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); };
  const decrypt = value => { if (!value) return ''; const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8'); };
  const coolingBases = since => prepare("SELECT DISTINCT json_extract(json,'$.base') AS base FROM positions WHERE status='closed' AND json_extract(json,'$.closedAt')>?").all(since).map(x => x.base);
  const revision = () => set('historyRevision', get('historyRevision', 0) + 1);
  return { db, prepare, get, set, event, encrypt, decrypt, coolingBases, revision,
    config: () => ({ ...defaults, ...get('config', {}) }),
    executions: (active = false) => prepare("SELECT json FROM executions WHERE (?=0 OR state NOT IN ('completed','cancelled')) ORDER BY updated_at DESC LIMIT 100").all(active ? 1 : 0).map(x => JSON.parse(x.json)),
    findExecution: id => { const row = prepare('SELECT json FROM executions WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; },
    saveExecution(e) { prepare('INSERT INTO executions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,json=excluded.json').run(e.id, e.positionId, e.state, e.updatedAt, JSON.stringify(e)); revision(); },
    sample(series, at, value) { prepare('INSERT OR REPLACE INTO samples VALUES (?,?,?)').run(series, at, JSON.stringify(value)); prepare('DELETE FROM samples WHERE series=? AND at NOT IN (SELECT at FROM samples WHERE series=? ORDER BY at DESC LIMIT 5000)').run(series, series); revision(); },
    samples: series => prepare('SELECT json FROM samples WHERE series=? ORDER BY at').all(series).map(x => JSON.parse(x.json)),
    positions: (status = null, limit = 1000000) => prepare("SELECT json FROM positions WHERE (? IS NULL OR status=?) ORDER BY CASE WHEN status='closed' THEN json_extract(json,'$.closedAt') ELSE opened_at END DESC LIMIT ?").all(status, status, limit).map(x => JSON.parse(x.json)),
    findPosition: id => { const row = prepare('SELECT json FROM positions WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; },
    closedTotals: () => prepare("SELECT count(*) AS closedCount, coalesce(sum(json_extract(json,'$.result.net')),0) AS realizedPnl, coalesce(sum(json_extract(json,'$.funding.known')),0) AS fundingKnown, coalesce(sum(CASE WHEN json_extract(json,'$.funding.status')='complete' THEN 0 ELSE 1 END),0) AS fundingUnknown FROM positions WHERE status='closed'").get(),
    hasSignal: id => !!prepare('SELECT id FROM positions WHERE signal_id=?').get(id),
    savePosition(p) { prepare('INSERT INTO positions VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json').run(p.id, p.status, p.pairKey, p.signalId, p.openedAt, JSON.stringify(p)); if (p.status === 'closed') revision(); },
    transaction(callback) { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, close() { statements.clear(); db.close(); } };
}
