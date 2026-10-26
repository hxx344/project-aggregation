import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { moduleCatalog, moduleIds } from '../modules/catalog.mjs';
import { isSqliteBusy, recordBusy, recordHold, recordWait } from '../sqlite-writes.mjs';

export const MAX_PROJECTS = 30;
const defaults = [
  { id: 'aster', name: 'ASTER 5X', description: '交易账户、保证金占用与运行状态', category: 'trading', adapter: 'aster', url: 'http://127.0.0.1:8765', apiUrl: 'http://127.0.0.1:8765', staleAfterSeconds: 120 },
  { id: 'monitor', name: 'Market Monitor', description: '原油价差与市场监控', category: 'monitoring', adapter: 'monitor', url: 'http://127.0.0.1:3000/?monitor=oil', apiUrl: 'http://127.0.0.1:3000', staleAfterSeconds: 120 },
  { id: 'asset', name: 'Asset Ledger', description: '资产账本、持有金额与历史变化', category: 'assets', adapter: 'asset', url: 'http://127.0.0.1:5678', apiUrl: 'http://127.0.0.1:5678', staleAfterSeconds: 900 },
  { id: 'crossex', name: 'Gate CrossEx', description: '跨交易所永续手动实盘与持仓观察', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:3200', apiUrl: 'http://127.0.0.1:3200', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 120 },
  { id: 'variational', name: 'Variational Grid', description: 'Lighter QQQ / Variational US100 对冲剥头皮模拟', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:9876', apiUrl: 'http://127.0.0.1:9876', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 120 },
  { id: 'greeks', name: 'Greeks · BTC 期权', description: 'Bybit BTC 铁鹰期权、持仓与策略收益', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:8000', apiUrl: 'http://127.0.0.1:8000', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 30 },
].map((project, order) => ({ ...project, authOrigin: '', mode: 'external', enabled: true, order }));

const TABLES = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,json TEXT NOT NULL,credentials TEXT); CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires); CREATE TABLE IF NOT EXISTS execution_entries (id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS login_ip_attempts (ip TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS login_account_guard (account TEXT PRIMARY KEY,failed INTEGER NOT NULL,first_failure_at INTEGER NOT NULL,until INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS login_pending (id TEXT PRIMARY KEY,account TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS portal_tickets (digest TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,revision TEXT NOT NULL,destination TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_portal_tickets_expires ON portal_tickets(expires); CREATE TABLE IF NOT EXISTS portal_grants (digest TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,revision TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_portal_grants_expires ON portal_grants(expires);';

// Every write transaction on hub.sqlite: the wait for the lock and the time it is held count in server/sqlite-writes.mjs.
export function immediate(db, fn) {
  const started = performance.now();
  try { db.exec('BEGIN IMMEDIATE'); } catch (error) { if (isSqliteBusy(error)) recordBusy(); throw error; }
  const acquired = performance.now();
  recordWait(acquired - started);
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { recordHold(performance.now() - acquired); }
}

// Every process that opens hub.sqlite creates the tables; the write lock serializes a concurrent first start.
// A candidate API slot (design doc api-dual-slot 3.3) passes create: false: the
// connection is query-only, and the tables and columns are only checked.
export function openHubDatabase(dbPath, { create = true } = {}) {
  if (!create && !existsSync(dbPath)) throw new Error('工作台数据库尚未创建');
  const db = new DatabaseSync(dbPath);
  try {
    // busy_timeout first: the runtime and the API may open the database at the same time.
    if (!create) {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') throw new Error('工作台数据库未处于 WAL 模式');
      assertTables(db);
      return db;
    }
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    immediate(db, () => db.exec(TABLES));
    if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  } catch (error) { db.close(); throw error; }
  return db;
}

// Every table and column TABLES creates must exist; hub.sqlite has no schema version.
function assertTables(db) {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(TABLES);
    const columns = (target, table) => target.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(row => row.name);
    for (const { name } of expected.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
      const present = new Set(columns(db, name));
      const missing = columns(expected, name).filter(column => !present.has(column));
      if (!present.size || missing.length) throw new Error(`工作台数据库缺少 ${name}${missing.length && present.size ? `.${missing.join(',')}` : ''}`);
    }
  } finally { expected.close(); }
}

// Seeds and one-time migrations of the project table; each marker records that a step ran, so a later user deletion stays deleted.
export function seedProjects(store, { embeddedModules }) {
  const { db, getSetting, setSetting, stmt } = store;
  const presets = embeddedModules ? moduleCatalog : defaults;
  const insertBelowLimit = project => stmt.prepare('INSERT OR IGNORE INTO projects(id,json) SELECT ?,? WHERE (SELECT COUNT(*) FROM projects) < ?').run(project.id, JSON.stringify(project), MAX_PROJECTS);
  if (!getSetting('seeded')) immediate(db, () => { for (const project of presets) insertBelowLimit(project); setSetting('seeded', '1'); });
  if (embeddedModules) {
    // Fixed modules are always present, even when a previous external preset
    // was deleted or a legacy installation already used all project slots.
    for (const project of moduleCatalog) stmt.prepare('INSERT OR IGNORE INTO projects(id,json) VALUES (?,?)').run(project.id, JSON.stringify(project));
  }
  for (const id of (embeddedModules ? moduleIds : ['crossex', 'variational', 'greeks'])) {
    const marker = `seeded-${id}-v1`;
    if (getSetting(marker)) continue;
    // Keep existing connections intact; the marker also preserves a later user deletion.
    immediate(db, () => { insertBelowLimit(presets.find(item => item.id === id)); setSetting(marker, '1'); });
  }
  const describe = (id, previous, marker) => {
    if (getSetting(marker)) return;
    immediate(db, () => {
      const row = stmt.prepare('SELECT json FROM projects WHERE id=?').get(id);
      const project = row ? JSON.parse(row.json) : null;
      if (project?.description === previous) {
        project.description = defaults.find(item => item.id === id).description;
        stmt.prepare('UPDATE projects SET json=? WHERE id=?').run(JSON.stringify(project), id);
      }
      setSetting(marker, '1');
    });
  };
  describe('crossex', '同币种跨交易所永续价差套利模拟', 'updated-crossex-live-description-v1');
  if (!embeddedModules) describe('variational', 'CL/BZ 网格、库存组合与 QQQ / US100 对冲模拟', 'updated-variational-description-v1');
}

// Whether every step seedProjects runs has run, without writing: a candidate
// slot relies on the serving slot of the same control code having seeded.
export function seedComplete({ getSetting, projects }, { embeddedModules }) {
  const markers = ['seeded', 'updated-crossex-live-description-v1', ...(embeddedModules ? moduleIds : ['crossex', 'variational', 'greeks']).map(id => `seeded-${id}-v1`),
    ...(embeddedModules ? [] : ['updated-variational-description-v1'])];
  return markers.every(marker => getSetting(marker)) && (!embeddedModules || moduleCatalog.every(project => projects.exists(project.id)));
}
