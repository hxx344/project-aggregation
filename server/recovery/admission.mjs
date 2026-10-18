import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

// This is local checkpoint evidence, not exchange reconciliation or proof that
// writers stopped. The caller must hold the exclusive runtime lock throughout
// inspection, sealing and retirement. Nothing here repairs or clears a journal.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const own = (value, key) => Object.hasOwn(value, key);
const empty = value => value === null || value === false || object(value) && Object.keys(value).length === 0;
const HUB_FINAL = new Set(['completed', 'stopped']);
const CROSS_FINAL = new Set(['FILLED', 'CANCELLED', 'FAIL', 'REJECT', 'UNSENT']);
const GREEKS_FINAL = new Set(['completed', 'partial', 'stopped', 'failed']);
const GREEKS_ORDER_FINAL = new Set(['filled', 'partial', 'timeout_cancelled', 'not_submitted']);
const RFQ_FINAL = new Set(['Canceled', 'Expired', 'Filled', 'Failed']);
const WRITER_FINAL = new Set(['confirmed', 'rejected']);
const ASTER_ORDER_FINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);

class InvalidCheckpoint extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireThat = (condition, code = 'INVALID_JOURNAL') => { if (!condition) throw new InvalidCheckpoint(code); };
function regularFile(filename) {
  const info = lstatSync(filename);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'UNSAFE_FILE');
  return info;
}
function json(raw) { return JSON.parse(raw); }
function jsonObject(raw) { const value = json(raw); requireThat(object(value)); return value; }
function readJson(filename) { regularFile(filename); return jsonObject(readFileSync(filename, 'utf8')); }
function columns(db, schema) {
  const integers = new Set(['revision', 'generation', 'active', 'fence', 'lease_until', 'pid', 'last_now',
    'created_at', 'updated_at', 'singleton', 'version', 'requested_at']);
  for (const [table, expected] of Object.entries(schema)) {
    const row = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(table);
    requireThat(row?.type === 'table', 'SCHEMA_MISMATCH');
    const actual = db.prepare(`PRAGMA table_info("${table}")`).all();
    const composite = ['aw_bindings', 'aw_operation_accounts'].includes(table);
    requireThat(actual.length === expected.length && actual.every((column, i) => column.name === expected[i]
      && column.type.toUpperCase() === (column.name === 'revision' && table === 'aw_bindings' ? 'TEXT'
        : integers.has(column.name) ? 'INTEGER' : column.name === 'deleted_at' ? 'REAL' : 'TEXT')
      && column.pk === (i === 0 ? 1 : composite && i === 1 ? 2 : 0)), 'SCHEMA_MISMATCH');
  }
}
function withDatabase(filename, schema, inspect) {
  regularFile(filename);
  // READONLY alone still creates SQLite WAL/SHM files. Immutable readers do
  // not, but ignore WAL: require the caller's successful TRUNCATE checkpoint.
  try { requireThat(regularFile(`${filename}-wal`).size === 0, 'DATABASE_WAL_UNCHECKPOINTED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(`${pathToFileURL(filename).href}?immutable=1`, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
    requireThat(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok', 'DATABASE_INVALID');
    columns(db, schema);
    inspect(db);
  } finally { db.close(); }
}

const HUB_SCHEMA = {
  execution_accounts: ['exchange', 'revision', 'credentials', 'account_mode', 'identity', 'key_label', 'verified_at', 'snapshot'],
  execution_jobs: ['id', 'json'], execution_orders: ['id', 'job_id', 'json'],
  execution_locks: ['resource', 'job_id'], execution_stop_requests: ['job_id', 'requested_at'],
};
const WRITER_SCHEMA = {
  aw_meta: ['key', 'value'], aw_owners: ['owner_id', 'module_id', 'runtime_id', 'pid', 'status', 'last_now'],
  aw_bindings: ['module_id', 'connection_id', 'authority', 'environment', 'account_key', 'revision', 'generation', 'active', 'evidence_hash'],
  aw_accounts: ['account_key', 'authority', 'environment', 'module_id', 'owner_id', 'fence', 'lease_until'],
  aw_operations: ['operation_id', 'module_id', 'body_hash', 'account_keys', 'owner_id', 'ticket_json', 'state', 'created_at', 'updated_at', 'group_id', 'intent_action', 'intent_target_hash'],
  aw_operation_accounts: ['operation_id', 'account_key'],
  aw_isolations: ['account_key', 'authority', 'environment', 'reason', 'module_id', 'created_at'],
};
const CROSS_SCHEMA = {
  live_connection: ['singleton', 'json'], live_cache: ['singleton', 'json'],
  live_executions: ['id', 'preview_id', 'updated_at', 'json'],
  live_orders: ['id', 'execution_id', 'text', 'version', 'state', 'updated_at', 'json'],
  live_requests: ['id', 'fingerprint', 'kind', 'result'],
};
const ASTER_SCHEMA = {
  accounts: ['id', 'data'], deleted_accounts: ['id', 'data', 'deleted_at'],
  pairs: ['id', 'data'], pair_members: ['account_id', 'pair_id', 'direction'],
  intents: ['id', 'account_id', 'status', 'data'], kv: ['key', 'data'],
};

function inspectHub(db, add, counts) {
  const jobs = new Map();
  for (const row of db.prepare('SELECT id,json FROM execution_jobs').iterate()) {
    const value = jsonObject(row.json); counts.hubJobs++;
    requireThat(value.id === row.id && text(value.status)); jobs.set(row.id, value);
    if (!HUB_FINAL.has(value.status)) add('HUB_JOB_UNRESOLVED');
  }
  for (const row of db.prepare('SELECT id,job_id,json FROM execution_orders').iterate()) {
    const value = jsonObject(row.json); counts.hubOrders++;
    requireThat(value.localId === row.id && value.jobId === row.job_id && jobs.has(row.job_id));
    requireThat(typeof value.settled === 'boolean' && typeof value.unknown === 'boolean' && text(value.state));
    if (value.settled !== true || value.unknown !== false || value.amendPending === true
        || !['terminal', 'rejected'].includes(value.state)) add('HUB_ORDER_UNRESOLVED');
    if (own(value, 'amendPending')) requireThat(typeof value.amendPending === 'boolean');
    if (value.writerOperation != null) {
      requireThat(object(value.writerOperation) && text(value.writerOperation.state));
      if (!WRITER_FINAL.has(value.writerOperation.state)) add('HUB_WRITE_UNRESOLVED');
    }
  }
  for (const row of db.prepare('SELECT job_id FROM execution_locks').iterate()) {
    requireThat(jobs.has(row.job_id));
    add('HUB_EXECUTION_LOCK_REMAINS');
  }
  for (const row of db.prepare('SELECT job_id FROM execution_stop_requests').iterate()) {
    requireThat(jobs.has(row.job_id));
    if (!HUB_FINAL.has(jobs.get(row.job_id).status)) add('HUB_CANCEL_UNRESOLVED');
  }
}

function inspectWriter(db, add, counts) {
  requireThat(db.prepare("SELECT value FROM aw_meta WHERE key='schema'").get()?.value === '1', 'SCHEMA_MISMATCH');
  requireThat(/^[a-f0-9-]{36}$/.test(db.prepare("SELECT value FROM aw_meta WHERE key='registry_id'").get()?.value), 'SCHEMA_MISMATCH');
  for (const row of db.prepare('SELECT state,account_keys,ticket_json FROM aw_operations').iterate()) {
    counts.writerOperations++;
    requireThat(Array.isArray(json(row.account_keys)) && object(json(row.ticket_json)));
    if (!WRITER_FINAL.has(row.state)) add('WRITER_OPERATION_UNRESOLVED');
  }
  // Isolations are deliberately neither removed nor converted to a global
  // failure: the restored M1 registry must keep denying those same accounts.
  counts.isolations = db.prepare('SELECT count(*) AS count FROM aw_isolations').get().count;
}

function inspectCrossEx(db, add, counts) {
  const executions = new Map(), orderCounts = new Map();
  for (const row of db.prepare('SELECT id,json FROM live_executions').iterate()) {
    const value = jsonObject(row.json); counts.crossexExecutions++;
    requireThat(value.id === row.id && ['open', 'close', 'position'].includes(value.kind));
    executions.set(row.id, value);
  }
  for (const row of db.prepare('SELECT id,execution_id,state,json FROM live_orders').iterate()) {
    const value = jsonObject(row.json); counts.crossexOrders++;
    requireThat(value.id === row.id && value.status === row.state && text(value.status));
    requireThat(value.external === true || value.executionId === row.execution_id && executions.has(row.execution_id));
    orderCounts.set(row.execution_id, (orderCounts.get(row.execution_id) || 0) + 1);
    if (!CROSS_FINAL.has(value.status) || value.writerCancelPrepared === true) add('CROSSEX_ORDER_UNRESOLVED');
  }
  // State is computed from the durable legs, not saved in live_executions.json.
  // Do not use runtime.executionRecords(), whose UI history has LIMIT 100.
  for (const id of executions.keys()) if (!orderCounts.has(id)) add('CROSSEX_EXECUTION_WITHOUT_ORDERS');
  for (const row of db.prepare('SELECT json FROM live_cache').iterate()) {
    const value = jsonObject(row.json);
    requireThat(Array.isArray(value.openOrders));
    for (const order of value.openOrders) {
      requireThat(object(order) && text(order.state));
      if (!CROSS_FINAL.has(order.state)) add('CROSSEX_EXTERNAL_ORDER_UNRESOLVED');
    }
  }
}

function inspectGreeks(state, environment, add, counts) {
  const keys = new Set(['schema_version', 'exchange_network', 'last_open_week', 'active_strategy_symbols', 'active_strategy_sizes',
    'active_strategy_group_id', 'rfq_state', 'execution_groups', 'execution_group_links', 'pm_baseline', 'order_journal',
    'performance_executions', 'performance_start_ms', 'performance_cursor_ms', 'performance_samples']);
  requireThat(Object.keys(state).every(key => keys.has(key)) && state.schema_version === 1
    && ['mainnet', 'testnet'].includes(state.exchange_network) && Array.isArray(state.active_strategy_symbols)
    && object(state.active_strategy_sizes) && object(state.order_journal) && object(state.rfq_state)
    && object(state.execution_groups) && object(state.execution_group_links), 'INVALID_STATE');
  const auto = environment.auto_open;
  if (auto !== undefined && !['0', 'false', 'off', 'no'].includes(String(auto).toLowerCase())) add('GREEKS_AUTO_OPEN_ENABLED');
  for (const entry of Object.values(state.order_journal)) {
    counts.greeksOrders++;
    requireThat(object(entry) && typeof entry.terminal === 'boolean' && text(entry.status)
      && text(entry.symbol) && ['Buy', 'Sell'].includes(entry.side) && Number.isFinite(entry.qty) && entry.qty > 0
      && Number.isFinite(entry.filledQty) && entry.filledQty >= 0 && entry.filledQty <= entry.qty + 1e-9);
    if (!entry.terminal || !GREEKS_ORDER_FINAL.has(entry.status)) add('GREEKS_ORDER_UNRESOLVED');
  }
  for (const group of Object.values(state.execution_groups)) {
    counts.greeksExecutions++;
    requireThat(object(group) && ['open', 'close'].includes(group.type));
    if (own(group, 'task_version')) {
      requireThat(group.task_version === 1 && typeof group.live === 'boolean' && text(group.execution_status));
      if (group.live && !GREEKS_FINAL.has(group.execution_status)) add('GREEKS_TASK_UNRESOLVED');
      requireThat(['dry-run', 'testnet', 'live'].includes(group.environment) && typeof group.stop_requested === 'boolean'
        && text(group.plan_id) && text(group.request_id) && object(group.request_fingerprint)
        && group.request_fingerprint.plan_id === group.plan_id && group.request_fingerprint.request_id === group.request_id
        && object(group.legs) && Object.keys(group.legs).length > 0);
    } else if (own(group, 'execution_status')) add('GREEKS_TASK_VERSION_UNKNOWN');
  }
  const rfq = state.rfq_state;
  if (Object.keys(rfq).length) {
    requireThat(text(rfq.status));
    if (!RFQ_FINAL.has(rfq.status) || rfq.status === 'Filled' && rfq.tracking_applied !== true
        || rfq.selected_quote_id && rfq.execution_resolved !== true) add('GREEKS_RFQ_UNRESOLVED');
  }
}

function disabled(container, key, fallback = false) {
  if (!own(container, key)) return fallback === false;
  requireThat(object(container[key]) && (!own(container[key], 'enabled') || typeof container[key].enabled === 'boolean'));
  return (container[key].enabled ?? fallback) === false;
}
function nonzeroQuantities(value) {
  requireThat(object(value));
  return Object.values(value).some(qty => {
    requireThat(typeof qty === 'string' && /^-?\d+(?:\.\d+)?$/.test(qty));
    return /[1-9]/.test(qty);
  });
}
function inspectAster(db, add, counts) {
  const accounts = new Map(), deleted = new Map(), pairs = new Map();
  for (const [table, target] of [['accounts', accounts], ['deleted_accounts', deleted]]) {
    for (const row of db.prepare(`SELECT id,data FROM ${table}`).iterate()) {
      const value = jsonObject(row.data);
      requireThat(value.id === row.id && ['live', 'paper'].includes(value.mode) && typeof value.enabled === 'boolean');
      target.set(row.id, value);
      if (table === 'accounts') {
        counts.asterAccounts++;
        if (value.mode === 'live' && (value.enabled || !disabled(value, 'cycle') || !disabled(value, 'migration'))) add('ASTER_ACCOUNT_AUTOMATION_ENABLED');
      }
    }
  }
  const accountMode = id => accounts.get(id)?.mode ?? deleted.get(id)?.mode;
  for (const row of db.prepare('SELECT id,data FROM pairs').iterate()) {
    const value = jsonObject(row.data); counts.asterPairs++;
    requireThat(value.id === row.id && typeof value.enabled === 'boolean');
    const modes = [accountMode(value.long_account_id), accountMode(value.short_account_id)];
    requireThat(modes.every(mode => ['live', 'paper'].includes(mode)) && modes[0] === modes[1]);
    pairs.set(row.id, { ...value, mode: modes[0] });
    if (modes[0] === 'live' && (value.enabled || !disabled(value, 'ordinary') || !disabled(value, 'cycle')
        || !disabled(value, 'margin') || !disabled(value, 'adl', true))) add('ASTER_PAIR_AUTOMATION_ENABLED');
  }
  for (const row of db.prepare('SELECT id,account_id,status,data FROM intents').iterate()) {
    const value = jsonObject(row.data); counts.asterIntents++;
    requireThat(value.id === row.id && value.account_id === row.account_id && value.status === row.status);
    const mode = accountMode(row.account_id);
    if (!['complete', 'aborted'].includes(row.status) && mode !== 'paper') add('ASTER_INTENT_UNRESOLVED');
    if (mode !== 'paper' && value.resolution?.execution_result_unknown === true) add('ASTER_INTENT_OUTCOME_UNKNOWN');
    if (!mode && !['complete', 'aborted'].includes(row.status)) add('ASTER_RECOVERY_OWNER_UNKNOWN');
  }
  let mode;
  for (const row of db.prepare('SELECT key,data FROM kv').iterate()) {
    const value = json(row.data);
    if (row.key === 'runtime_mode') { mode = value; continue; }
    const [kind, owner] = row.key.split(':');
    if (['post_fill_check', 'recovery_auto_pause', 'cycle'].includes(kind)) {
      if (accountMode(owner) === 'paper' || empty(value)) continue;
      if (!accountMode(owner)) add('ASTER_RECOVERY_OWNER_UNKNOWN');
      if (kind !== 'cycle') { add(kind === 'post_fill_check' ? 'ASTER_POST_FILL_UNRESOLVED' : 'ASTER_AUTO_RESUME_REMAINS'); continue; }
      requireThat(object(value));
      requireThat(!own(value, 'phase') || ['waiting_open', 'holding', 'waiting_close'].includes(value.phase));
      if (value.pending != null || own(value, 'quantities') && nonzeroQuantities(value.quantities)) add('ASTER_CYCLE_UNRESOLVED');
      if (value.phase && value.phase !== 'waiting_open') add('ASTER_CYCLE_UNRESOLVED');
    } else if (['pair_runtime', 'pair_margin', 'adl_pair'].includes(kind)) {
      requireThat(object(value));
      if (pairs.get(owner)?.mode === 'paper') continue;
      if (empty(value)) continue;
      if (!pairs.has(owner)) { add('ASTER_RECOVERY_OWNER_UNKNOWN'); continue; }
      if (value.pending != null || value.recovery_watch != null) add(kind === 'pair_margin' ? 'ASTER_TRANSFER_UNRESOLVED' : 'ASTER_PAIR_UNRESOLVED');
      if (kind === 'pair_runtime' && ['submitting', 'reconciling', 'recovering'].includes(value.phase)) add('ASTER_PAIR_UNRESOLVED');
      if (kind === 'pair_margin' && ['submitting', 'accepted', 'acknowledged', 'unknown'].includes(value.status)) add('ASTER_TRANSFER_UNRESOLVED');
      if (kind === 'pair_runtime' && value.progress != null) {
        requireThat(object(value.progress));
        if (own(value.progress, 'quantities') && nonzeroQuantities(value.progress.quantities)) add('ASTER_CYCLE_UNRESOLVED');
        if (value.progress.phase && value.progress.phase !== 'waiting_open') add('ASTER_CYCLE_UNRESOLVED');
      }
      if (kind === 'adl_pair') {
        requireThat(['active', 'blocked', 'completed'].includes(value.status) && typeof value.hold === 'boolean');
        if (value.status !== 'completed' || value.hold) add('ASTER_ADL_UNRESOLVED');
        for (const list of ['batches', 'prior_orders']) {
          if (!own(value, list)) continue;
          requireThat(Array.isArray(value[list]));
          if (value[list].some(batch => !object(batch) || batch.state !== 'terminal')) add('ASTER_ADL_UNRESOLVED');
        }
      }
    } else if (kind === 'adl_event') {
      requireThat(object(value));
      if (accountMode(value.account_id) === 'paper') continue;
      requireThat(typeof value.executed_qty === 'string' && typeof value.handled_qty === 'string');
      // Equal canonical decimal quantities are sufficient; unequal spellings
      // reject conservatively instead of rounding away a tiny residual.
      const canonical = raw => { requireThat(/^\d+(?:\.\d+)?$/.test(raw)); const [whole, fraction = ''] = raw.split('.'); return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`; };
      if (!ASTER_ORDER_FINAL.has(value.status) || value.conflict || canonical(value.executed_qty) !== canonical(value.handled_qty)) add('ASTER_ADL_EVENT_UNRESOLVED');
    }
  }
  requireThat(['authenticated', 'demo'].includes(mode), 'INVALID_RUNTIME_MODE');
  requireThat(mode !== 'demo' || [...accounts.values()].every(account => account.mode === 'paper'), 'INVALID_RUNTIME_MODE');
}

/** Read-only, offline evidence. Reasons and counts never include credentials or account IDs. */
export function inspectTradingCheckpoint(dataDir, { environment = {} } = {}) {
  const root = path.resolve(dataDir), reasons = [], seen = new Set();
  const counts = { hubJobs: 0, hubOrders: 0, writerOperations: 0, isolations: 0, crossexExecutions: 0,
    crossexOrders: 0, greeksOrders: 0, greeksExecutions: 0, asterAccounts: 0, asterPairs: 0, asterIntents: 0 };
  const add = (moduleId, code) => { const key = `${moduleId}:${code}`; if (!seen.has(key)) { seen.add(key); reasons.push({ moduleId, code }); } };
  const inspect = (moduleId, action) => {
    try { action(code => add(moduleId, code)); }
    catch (error) { add(moduleId, error instanceof InvalidCheckpoint ? error.code : error.code === 'ENOENT' ? 'FILE_MISSING' : error instanceof SyntaxError ? 'INVALID_JSON' : 'CHECKPOINT_UNREADABLE'); }
  };
  inspect('hub', add => withDatabase(path.join(root, 'hub.sqlite'), HUB_SCHEMA, db => inspectHub(db, add, counts)));
  inspect('shared', add => withDatabase(path.join(root, 'execution-control.sqlite'), WRITER_SCHEMA, db => inspectWriter(db, add, counts)));
  inspect('crossex', add => withDatabase(path.join(root, 'modules/crossex/crossex.sqlite'), CROSS_SCHEMA, db => inspectCrossEx(db, add, counts)));
  inspect('greeks', add => {
    requireThat(object(environment), 'INVALID_ENVIRONMENT');
    let moduleEnvironment = {};
    try {
      const filename = path.join(root, 'modules/greeks/.env'); regularFile(filename);
      moduleEnvironment = parseEnv(readFileSync(filename, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const effective = Object.fromEntries(Object.entries({ ...environment, ...moduleEnvironment }).map(([key, value]) => [key.toLowerCase(), value]));
    inspectGreeks(readJson(path.join(root, 'modules/greeks/engine_state.json')), effective, add, counts);
  });
  inspect('aster', add => withDatabase(path.join(root, 'modules/aster/trading.sqlite3'), ASTER_SCHEMA, db => inspectAster(db, add, counts)));
  return { safeForHandoff: reasons.length === 0, reasons, counts };
}
