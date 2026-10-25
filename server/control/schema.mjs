import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
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

const TABLES = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,json TEXT NOT NULL,credentials TEXT); CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires); CREATE TABLE IF NOT EXISTS execution_entries (id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);';

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
export function openHubDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    immediate(db, () => db.exec(TABLES));
    if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  } catch (error) { db.close(); throw error; }
  return db;
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
