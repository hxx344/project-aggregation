import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { hash } from './crypto.mjs';
import { assertLifecycleLock } from './lifecycle-lock.mjs';

export const MODULES = ['monitor', 'asset', 'crossex', 'greeks', 'aster'];
export const REGISTRY = 'execution-control.sqlite';
export const CONTROL = 'recovery-control.json';
export const ASTER_ENV = 'modules/aster/.env';
export const ASTER_CA = 'ASTER_CAPACITY_RELAY_CA_FILE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA_FILES = new Set([REGISTRY, REGISTRY + '.required', 'hub.sqlite',
  'modules/monitor/market.sqlite', 'modules/monitor/perpetual/market.sqlite',
  'modules/asset/ledger.sqlite', 'modules/crossex/crossex.sqlite', 'modules/aster/trading.sqlite3']);
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes(':') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || path.isAbsolute(value)) throw new Error('RECOVERY_UNSAFE_PATH');
  return value;
}
export function safePath(filename, { missing = false, directory = false } = {}) {
  const full = path.resolve(filename); let current = path.parse(full).root;
  if (/^(?:\\\\|\/\/)/.test(full) || (process.platform === 'win32' && full.slice(2).includes(':'))) throw new Error('RECOVERY_UNSAFE_PATH');
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info; try { info = fs.lstatSync(current); } catch (error) { if (missing && error.code === 'ENOENT') return full; throw error; }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw new Error('RECOVERY_UNSAFE_FILE');
    if (process.platform !== 'win32') {
      const caller = process.getuid();
      if (caller !== 0 && info.uid !== 0 && info.uid !== caller) throw new Error('RECOVERY_UNSAFE_OWNER');
      if ((info.mode & 0o022) && !(info.isDirectory() && (info.mode & 0o1000) && current !== full)) throw new Error('RECOVERY_UNSAFE_PERMISSIONS');
    }
  }
  if (directory && !fs.statSync(full).isDirectory()) throw new Error('RECOVERY_UNSAFE_DIRECTORY');
  return full;
}
export function within(parent, child) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
export const identity = (filename) => { safePath(filename); const info = fs.statSync(filename, { bigint: true }); return { dev: String(info.dev), ino: String(info.ino) }; };
export function sourceDatabaseState(filename, { allowMissingShm = false } = {}) {
  safePath(filename); const database = fs.statSync(filename); const sidecars = {};
  let rootOwned = false;
  for (const suffix of ['-wal','-shm','-journal']) {
    let info; try { info = fs.lstatSync(filename + suffix); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    safePath(filename + suffix);
    if (process.platform !== 'win32' && info.uid !== database.uid) {
      if (process.getuid() !== 0 || info.uid !== 0 || (info.mode & 0o777) !== 0o600) throw new Error('RECOVERY_DATABASE_SIDECAR_OWNER');
      rootOwned = true;
    }
    sidecars[suffix] = info;
  }
  if (sidecars['-journal']?.size) throw new Error('RECOVERY_DATABASE_CHECKPOINT_REQUIRED');
  const wal = Boolean(sidecars['-wal']?.size);
  if (wal && !sidecars['-shm'] && !allowMissingShm) throw new Error('RECOVERY_DATABASE_CHECKPOINT_REQUIRED');
  return { wal, rootOwned };
}
// READONLY on a cold WAL-mode DB can create root-owned WAL/SHM files. Immutable
// reads are safe only when there are no pending WAL pages or rollback journal.
// Existing nonempty WAL reads require both original, correctly owned sidecars.
export function openSourceDatabase(filename) {
  const { wal } = sourceDatabaseState(filename);
  const db = new DatabaseSync(wal ? filename : `${pathToFileURL(filename).href}?immutable=1`, { readOnly: true });
  try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=750'); return db; }
  catch (error) { db.close(); throw error; }
}
export function openLockedSourceDatabase(filename, { lock, dataDir }) {
  assertLifecycleLock(lock, { dataDir });
  if (!within(dataDir, filename)) throw new Error('RECOVERY_UNSAFE_PATH');
  // A root checkpoint interrupted after TRUNCATE can leave empty root-owned
  // sidecars. An immutable read would hide them and break the service restart.
  if (sourceDatabaseState(filename, { allowMissingShm: true }).rootOwned) checkpointSourceDatabase(filename, { lock, dataDir });
  try { return openSourceDatabase(filename); }
  catch (error) {
    if (error.message !== 'RECOVERY_DATABASE_CHECKPOINT_REQUIRED') throw error;
    checkpointSourceDatabase(filename, { lock, dataDir }); return openSourceDatabase(filename);
  }
}
export function checkpointSourceDatabase(filename, { lock, dataDir } = {}) {
  assertLifecycleLock(lock, { dataDir });
  if (!within(dataDir, filename)) throw new Error('RECOVERY_UNSAFE_PATH');
  const state = sourceDatabaseState(filename, { allowMissingShm: true });
  if (!state.wal && !state.rootOwned) return;
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=750');
    if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy !== 0) throw new Error('RECOVERY_DATABASE_BUSY');
  } finally { db.close(); }
}
export function writeJson(filename, value, { replace = false } = {}) {
  const temporary = filename + '.tmp-' + randomUUID(); const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (!replace && fs.existsSync(filename)) throw new Error('RECOVERY_TARGET_EXISTS');
    fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename));
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function syncDirectory(directory) { if (process.platform === 'win32') return; const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function syncTreeDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) syncTreeDirectories(path.join(directory, entry.name));
  syncDirectory(directory);
}
export function budget({ maxBytes = 10 * 1024 ** 3, maxFiles = 10_000, timeoutMs = 600_000, maxCheckpointRows = 100_000, maxRecordBytes = 8 * 1024 * 1024 } = {}, held = () => {}) {
  for (const v of [maxBytes, maxFiles, timeoutMs, maxCheckpointRows, maxRecordBytes]) if (!Number.isSafeInteger(v) || v <= 0) throw new Error('RECOVERY_LIMIT_INVALID');
  const deadline = performance.now() + timeoutMs; let bytes = 0, files = 0;
  const check = () => { held(); if (performance.now() > deadline) throw new Error('RECOVERY_TIMEOUT'); };
  check.signal = AbortSignal.timeout(Math.min(timeoutMs, 0xffffffff));
  return { check, remainingMs: () => Math.max(1, Math.ceil(deadline - performance.now())), maxBytes, maxFiles, maxCheckpointRows, maxRecordBytes, add(size) { check(); if (!Number.isSafeInteger(size) || size < 0 || (bytes += size) > maxBytes || ++files > maxFiles) throw new Error('RECOVERY_LIMIT_EXCEEDED'); }, space(directory, needed) { check(); const s = fs.statfsSync(directory, { bigint: true }); if (s.bavail * s.bsize < BigInt(needed) + 1024n * 1024n) throw new Error('RECOVERY_SPACE_INSUFFICIENT'); } };
}
// `run` is the runtime directory (server/runtime/protocol.mjs): discovery
// record and sockets of the runtime and its modules, rebuilt at every start.
export function excluded(relative) {
  const name = path.posix.basename(relative);
  return relative === 'run' || name === '.runtime.lock' || name === 'instance.lock' || name.endsWith('-wal') || name.endsWith('-shm') || /(?:\.sock|\.socket|\.tmp|\.lock)$/.test(name) || name.includes('.tmp-') || name === CONTROL;
}
export function category(relative) {
  // Ordinary configuration and future/unknown paths may contain cleartext
  // credentials at any nesting depth (including migrated notification channels).
  // Only known application DBs (whose credentials are app-encrypted) and
  // registry identity evidence use the data key. All other paths require the
  // independently held secrets key, including unknown SQLite files.
  return DATA_FILES.has(relative) || /^modules\/asset\/backups\/before-import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/.test(relative) ? 'data' : 'secrets';
}
export function inventory(dataDir, limits) {
  const root = safePath(dataDir, { directory: true }); const entries = [];
  function walk(directory, prefix = '', depth = 0) {
    if (depth > 32) throw new Error('RECOVERY_DEPTH_EXCEEDED');
    for (const name of fs.readdirSync(directory).sort()) {
      limits.check(); const relative = prefix ? prefix + '/' + name : name; safeRelative(relative);
      const filename = path.join(directory, name); safePath(filename); const info = fs.lstatSync(filename);
      // Links and special files are rejected even if their names normally would be excluded.
      if (excluded(relative)) continue;
      if (info.isDirectory()) {
        if (prefix === 'modules' && !MODULES.includes(name)) throw new Error('RECOVERY_UNKNOWN_MODULE');
        walk(filename, relative, depth + 1);
      } else { limits.add(info.size); entries.push({ path: relative, source: filename, size: info.size, category: category(relative), sqlite: /\.(?:sqlite|sqlite3|db)$/i.test(name) }); }
    }
  }
  walk(root);
  if (!entries.some(e => e.path === REGISTRY) || !entries.some(e => e.path === REGISTRY + '.required') || !entries.some(e => e.path === 'hub.sqlite') || !entries.some(e => e.path === 'credentials.key')) throw new Error('RECOVERY_REQUIRED_MATERIAL_MISSING');
  for (const moduleId of MODULES) safePath(path.join(root, 'modules', moduleId), { directory: true });
  return entries;
}
export function discoverPathBindings(dataDir, files, environment = {}) {
  const envFile = files.find(entry => entry.path === ASTER_ENV); let moduleEnv = {};
  if (envFile) {
    if (envFile.size > 8 * 1024 * 1024) throw new Error('RECOVERY_ENVIRONMENT_INVALID');
    moduleEnv = parseEnv(fs.readFileSync(envFile.source, 'utf8'));
  }
  const inherited = !Object.hasOwn(moduleEnv, ASTER_CA);
  const raw = inherited ? environment[ASTER_CA] : moduleEnv[ASTER_CA];
  if (raw === undefined || typeof raw === 'string' && !raw.trim()) return { pathBindings: [], unresolvedDependencies: [], syntheticEnv: false };
  const unresolved = (code) => ({ pathBindings: [], unresolvedDependencies: [{ envEntry: ASTER_ENV, key: ASTER_CA, code }], syntheticEnv: false });
  if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw) || !path.isAbsolute(raw.trim())) return unresolved('UNSUPPORTED_REFERENCE');
  const reference = path.resolve(raw.trim());
  // Do not stat, open, follow or copy anything selected outside DATA_DIR by .env.
  if (!within(dataDir, reference) || reference === path.resolve(dataDir)) return unresolved('EXTERNAL_MATERIAL_NOT_INCLUDED');
  const relativeEntry = path.relative(dataDir, reference).split(path.sep).join('/');
  const included = files.find(entry => entry.path === relativeEntry);
  if (!included || included.sqlite || included.path === ASTER_ENV) return unresolved('REFERENCED_MATERIAL_MISSING');
  safeRelative(relativeEntry);
  return { pathBindings: [{ envEntry: ASTER_ENV, key: ASTER_CA, relativeEntry, sourceValueHash: hash(raw), inherited }], unresolvedDependencies: [], syntheticEnv: !envFile };
}
export function tables(db) { return new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name)); }
function inspectDatabase(filename) {
  const db = openSourceDatabase(filename);
  try {
    db.exec('PRAGMA busy_timeout=750');
    if (db.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('RECOVERY_DATABASE_INTEGRITY');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 2001").all();
    const counts = {}; const tableList = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1001").all();
    if (schema.length > 2000 || tableList.length > 1000 || Buffer.byteLength(JSON.stringify(schema)) > 2 * 1024 * 1024) throw new Error('RECOVERY_SCHEMA_TOO_LARGE');
    for (const { name } of tableList) counts[name] = db.prepare('SELECT count(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n;
    return { schemaHash: hash(JSON.stringify(schema)), userVersion: Object.values(db.prepare('PRAGMA user_version').get())[0], applicationId: Object.values(db.prepare('PRAGMA application_id').get())[0], tableCounts: counts };
  } finally { db.close(); }
}
// SQLite integrity/table scans have no JS interrupt. A killable process bounds them.
async function boundedProbe(kind, filename, limits, input = {}) {
  limits.check();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(import.meta.url), kind, filename], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['pipe','pipe','ignore'] });
    let output = '', error;
    const timer = setTimeout(() => { error = new Error('RECOVERY_TIMEOUT'); child.kill('SIGKILL'); }, limits.remainingMs());
    const monitor = setInterval(() => { try { limits.check(); } catch (reason) { error = reason; child.kill('SIGKILL'); } }, 100);
    const finish = (reason, value) => { clearTimeout(timer); clearInterval(monitor); reason ? reject(reason) : resolve(value); };
    child.once('error', reason => finish(reason));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...input, maxCheckpointRows: limits.maxCheckpointRows, maxRecordBytes: limits.maxRecordBytes }));
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { error = new Error('RECOVERY_SCHEMA_TOO_LARGE'); child.kill('SIGKILL'); } });
    child.once('close', code => { if (error || code !== 0) return finish(error || new Error(kind === '--database-evidence' ? 'RECOVERY_DATABASE_INTEGRITY' : 'RECOVERY_CHECKPOINT_LIMIT_OR_INVALID')); try { limits.check(); finish(null, JSON.parse(output)); } catch (reason) { finish(reason); } });
  });
}
export const databaseEvidence = (filename, limits) => boundedProbe('--database-evidence', filename, limits);
export const checkpointEvidence = (dataDir, limits, environment = {}) => boundedProbe('--checkpoint-evidence', dataDir, limits, { environment });
function boundCheckpoint(dataDir, { maxCheckpointRows, maxRecordBytes }) {
  let rows = 0;
  const journals = {
    'hub.sqlite': ['execution_jobs','execution_orders','execution_locks','execution_stop_requests','projects','trading_accounts','execution_accounts'],
    [REGISTRY]: ['aw_operations','aw_isolations'],
    'modules/crossex/crossex.sqlite': ['live_executions','live_orders','live_cache','live_connection','settings'],
    'modules/aster/trading.sqlite3': ['accounts','deleted_accounts','pairs','intents','kv'],
    'modules/asset/ledger.sqlite': ['connections'],
  };
  for (const [relative, names] of Object.entries(journals)) {
    if (relative === 'modules/asset/ledger.sqlite' && !fs.existsSync(path.join(dataDir, relative))) continue;
    const filename = safePath(path.join(dataDir, relative)); const db = new DatabaseSync(`${pathToFileURL(filename).href}?immutable=1`, { readOnly: true });
    try {
      for (const name of names) {
        if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)) continue;
        const table = '"' + name.replaceAll('"', '""') + '"';
        rows += db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ?)`).get(maxCheckpointRows + 1).n;
        if (rows > maxCheckpointRows) throw new Error('RECOVERY_CHECKPOINT_LIMIT');
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        for (const column of columns) {
          const col = '"' + column.name.replaceAll('"', '""') + '"';
          if (db.prepare(`SELECT 1 FROM ${table} WHERE typeof(${col}) IN ('text','blob') AND length(CAST(${col} AS BLOB))>? LIMIT 1`).get(maxRecordBytes)) throw new Error('RECOVERY_CHECKPOINT_LIMIT');
        }
      }
    } finally { db.close(); }
  }
  for (const relative of ['modules/greeks/engine_state.json', 'modules/greeks/.env']) {
    const filename = path.join(dataDir, relative);
    if (fs.existsSync(filename) && fs.statSync(safePath(filename)).size > maxRecordBytes) throw new Error('RECOVERY_CHECKPOINT_LIMIT');
  }
}
if (import.meta.main && ['--database-evidence','--checkpoint-evidence'].includes(process.argv[2])) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 8 * 1024 * 1024) throw new Error('RECOVERY_INPUT_LIMIT'); }
    const options = JSON.parse(input || '{}'); let result;
    if (process.argv[2] === '--database-evidence') result = inspectDatabase(process.argv[3]);
    else { boundCheckpoint(process.argv[3], options); const { inspectTradingCheckpoint } = await import('./admission.mjs'); result = inspectTradingCheckpoint(process.argv[3], { environment: options.environment }); }
    process.stdout.write(JSON.stringify(result));
  } catch { process.exitCode = 1; }
}
export function readRegistry(dataDir, { marker = true } = {}) {
  const filename = path.join(dataDir, REGISTRY); safePath(filename);
  let evidence = null;
  if (marker) {
    if (fs.statSync(safePath(filename + '.required')).size > 4096) throw new Error('RECOVERY_REGISTRY_REPLACED');
    evidence = JSON.parse(fs.readFileSync(filename + '.required', 'utf8')); const file = identity(filename);
    if (!evidence || Object.keys(evidence).length !== 4 || evidence.schema !== 1 || !UUID.test(evidence.registryId ?? '') || evidence.dev !== file.dev || evidence.ino !== file.ino) throw new Error('RECOVERY_REGISTRY_REPLACED');
  }
  const db = openSourceDatabase(filename);
  try {
    db.exec('PRAGMA busy_timeout=750');
    const get = (key) => db.prepare('SELECT value FROM aw_meta WHERE key=? AND length(value)<=65536').get(key)?.value;
    if (get('schema') !== '1' || (get('recovery_schema') !== undefined && get('recovery_schema') !== '1')) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
    const registryId = get('registry_id'); const state = JSON.parse(get('recovery_state') || 'null');
    if (!UUID.test(registryId ?? '') || state?.schemaVersion !== 1 || !UUID.test(state.authorityId ?? '') || !['normal', 'quarantine', 'retired'].includes(state.state)) throw new Error('RECOVERY_STATE_INVALID');
    const file = identity(filename);
    if (marker && (evidence?.schema !== 1 || evidence.registryId !== registryId || evidence.dev !== file.dev || evidence.ino !== file.ino)) throw new Error('RECOVERY_REGISTRY_REPLACED');
    return { registryId, state, identity: file, marker: evidence, handoff: JSON.parse(get('recovery_handoff') || 'null') };
  } finally { db.close(); }
}
export function readLockedRegistry(dataDir, lock) {
  assertLifecycleLock(lock, { dataDir });
  try {
    const result = readRegistry(dataDir); const state = sourceDatabaseState(path.join(dataDir, REGISTRY));
    if (!state.wal && !state.rootOwned) return result;
    checkpointSourceDatabase(path.join(dataDir, REGISTRY), { lock, dataDir }); return readRegistry(dataDir);
  }
  catch (error) {
    if (error.message !== 'RECOVERY_DATABASE_CHECKPOINT_REQUIRED') throw error;
    checkpointSourceDatabase(path.join(dataDir, REGISTRY), { lock, dataDir }); return readRegistry(dataDir);
  }
}
