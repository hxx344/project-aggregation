import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createStore } from '../modules/crossex/server/store.mjs';
import { createLiveRuntime } from '../modules/crossex/server/live-runtime.mjs';
import { pythonExecutable as greeksPython } from '../server/modules/greeks.mjs';
import { pythonExecutable as asterPython } from '../server/modules/aster.mjs';
import { inspectTradingCheckpoint } from '../server/recovery/admission.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
let baseline;
function python(executable, source, module, target) {
  const result = spawnSync(executable, ['-c', source, target], {
    cwd: path.join(repository, 'modules', module), windowsHide: true, timeout: 30_000, encoding: 'utf8',
    env: { ...process.env, WORKSPACE_MANAGED: '0', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '' },
  });
  assert.equal(result.status, 0, `${module} actual schema fixture failed: ${result.stderr}`);
}

before(async () => {
  baseline = mkdtempSync(path.join(tmpdir(), 'recovery-admission-base-'));
  const app = await createApp({ dataDir: baseline, initialPassword: 'recovery-fixture-password-123',
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0,
    baselineIntervalMs: 0, warmupEnabled: false, logger: () => {} });
  await app.close();
  const writer = createAccountWriter({ databasePath: path.join(baseline, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: randomUUID() });
  const identity = { authority: 'binance', environment: 'mainnet', accountId: '123' };
  writer.bind('fixture', identity, 1);
  const ticket = writer.claim([identity]);
  const operation = writer.prepare(ticket, 'fixture:completed', { clientId: 'fixture-client', quantity: '1' });
  writer.finish(operation, 'confirmed');
  writer.freeze([identity]); writer.close();
  const cross = createStore(path.join(baseline, 'modules/crossex'));
  const live = createLiveRuntime(cross, { market: {} });
  await live.stop(); cross.close();
  const greeks = path.join(baseline, 'modules/greeks'); mkdirSync(greeks, { recursive: true });
  python(greeksPython(), `import sys
from pathlib import Path
from app.state import EngineState
state = EngineState(last_open_week=None, active_strategy_symbols=['BTC-position'], active_strategy_sizes={'BTC-position|Buy': .25}, exchange_network='mainnet')
Path(sys.argv[1]).write_text(state.model_dump_json(), encoding='utf-8')`, 'greeks', path.join(greeks, 'engine_state.json'));
  const aster = path.join(baseline, 'modules/aster'); mkdirSync(aster, { recursive: true });
  python(asterPython(), `import sys
from trading.store import Store
from trading.engine import Engine
from trading.paper import DemoMarket
from trading.pairing import validate_pair
from trading.pair_execution import runtime_default
store = Store(sys.argv[1], demo=False)
engine = Engine(store, market=DemoMarket())
for aid in ('left', 'right', 'solo'):
    engine.add_account({'id': aid, 'name': aid, 'mode': 'live', 'env_prefix': 'FIXTURE_' + aid.upper()})
engine.add_account({'id': 'paper', 'name': 'paper', 'mode': 'paper', 'env_prefix': 'FIXTURE_PAPER'})
pair = validate_pair({'id': 'paired', 'name': 'paired', 'long_account_id': 'left', 'short_account_id': 'right', 'enabled': False, 'adl': {'enabled': False}})
store.save_pair(pair, create=True)
runtime = runtime_default()
runtime['owned'] = {'LONG': '2', 'SHORT': '2'}
store.put('pair_runtime:paired', runtime)`, 'aster', path.join(aster, 'trading.sqlite3'));
});
after(() => { if (baseline) rmSync(baseline, { recursive: true, force: true }); });

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'recovery-admission-'));
  cpSync(baseline, directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filenames = { hub: 'hub.sqlite', shared: 'execution-control.sqlite', crossex: 'modules/crossex/crossex.sqlite', aster: 'modules/aster/trading.sqlite3' };
  return { directory,
    sql(module, action) { const db = new DatabaseSync(path.join(directory, filenames[module])); try { action(db); } finally { db.close(); } },
    greeks(action) { const filename = path.join(directory, 'modules/greeks/engine_state.json'); const state = JSON.parse(readFileSync(filename, 'utf8')); action(state); writeFileSync(filename, JSON.stringify(state)); },
    result(options) { return inspectTradingCheckpoint(directory, options); },
  };
}
const rejects = (f, moduleId, code, options) => {
  const result = f.result(options); assert.equal(result.safeForHandoff, false);
  assert.ok(result.reasons.some(reason => reason.moduleId === moduleId && reason.code === code), JSON.stringify(result));
  assert.ok(result.reasons.every(reason => Object.keys(reason).sort().join(',') === 'code,moduleId'));
};
const putKv = (f, key, value) => f.sql('aster', db => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)));
function hashes(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? hashes(filename) : [[filename, createHash('sha256').update(readFileSync(filename)).digest('hex')]];
  });
}

test('actual initialized stores and EngineState are stationary; positions and files stay unchanged', t => {
  const f = fixture(t), before = hashes(f.directory);
  const result = f.result();
  assert.equal(result.safeForHandoff, true, JSON.stringify(result));
  assert.deepEqual(result.reasons, []); assert.equal(result.counts.asterAccounts, 4);
  assert.deepEqual(hashes(f.directory), before, 'offline inspection never repairs, deletes, or rewrites state');
});

test('shared registry unknown operations block; existing isolations are carried without being cleared', t => {
  const f = fixture(t);
  assert.equal(f.result().safeForHandoff, true); assert.equal(f.result().counts.isolations, 1);
  f.sql('shared', db => db.exec("UPDATE aw_operations SET state='unknown'"));
  rejects(f, 'shared', 'WRITER_OPERATION_UNRESOLVED');
  assert.equal(f.result().counts.isolations, 1);
});

test('Hub paused jobs and settled orders with pending amendments cannot be sealed', t => {
  const f = fixture(t);
  f.sql('hub', db => {
    db.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('fixture-job', JSON.stringify({ id: 'fixture-job', status: 'paused' }));
    db.prepare('INSERT INTO execution_orders VALUES (?,?,?)').run('fixture-order', 'fixture-job', JSON.stringify({ localId: 'fixture-order', jobId: 'fixture-job', settled: true, unknown: false, state: 'terminal', amendPending: true }));
  });
  rejects(f, 'hub', 'HUB_JOB_UNRESOLVED'); rejects(f, 'hub', 'HUB_ORDER_UNRESOLVED');
});

test('CrossEx scans all historical executions and orders, including records beyond UI limit 100', t => {
  const f = fixture(t);
  f.sql('crossex', db => {
    for (let i = 0; i < 105; i++) {
      const executionId = `execution-${i}`, orderId = `order-${i}`;
      db.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run(executionId, `preview-${i}`, i, JSON.stringify({ id: executionId, kind: 'open' }));
      const status = i === 0 ? 'UNKNOWN' : 'FILLED';
      db.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run(orderId, executionId, `text-${i}`, 1, status, i, JSON.stringify({ id: orderId, executionId, status }));
    }
  });
  rejects(f, 'crossex', 'CROSSEX_ORDER_UNRESOLVED'); assert.equal(f.result().counts.crossexExecutions, 105);
});

test('CrossEx orphan execution and external cached orders cannot masquerade as empty inventory', t => {
  const f = fixture(t);
  f.sql('crossex', db => {
    db.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run('orphan', 'orphan-preview', 1, JSON.stringify({ id: 'orphan', kind: 'close' }));
    db.prepare('INSERT INTO live_cache VALUES (1,?)').run(JSON.stringify({ openOrders: [{ state: 'NEW' }] }));
  });
  rejects(f, 'crossex', 'CROSSEX_EXECUTION_WITHOUT_ORDERS'); rejects(f, 'crossex', 'CROSSEX_EXTERNAL_ORDER_UNRESOLVED');
});

test('Greeks AUTO_OPEN follows the root environment and the selected module override', t => {
  const f = fixture(t);
  rejects(f, 'greeks', 'GREEKS_AUTO_OPEN_ENABLED', { environment: { AUTO_OPEN: 'true', API_SECRET: 'must-never-escape' } });
  writeFileSync(path.join(f.directory, 'modules/greeks/.env'), 'AUTO_OPEN=false\n');
  assert.equal(f.result({ environment: { AUTO_OPEN: 'true' } }).safeForHandoff, true);
  writeFileSync(path.join(f.directory, 'modules/greeks/.env'), 'AUTO_OPEN=true\n');
  rejects(f, 'greeks', 'GREEKS_AUTO_OPEN_ENABLED', { environment: { AUTO_OPEN: 'false' } });
});

test('Greeks orders, active tasks and filled-but-untracked RFQs all deny handoff', t => {
  const f = fixture(t);
  f.greeks(state => {
    state.order_journal.order = { symbol: 'BTC-position', side: 'Buy', qty: .25, filledQty: 0, reduce_only: false, terminal: false, status: 'unknown' };
    state.execution_groups.task = { type: 'open', task_version: 1, live: true, execution_status: 'recovering',
      environment: 'live', stop_requested: true, plan_id: 'plan', request_id: 'request',
      request_fingerprint: { plan_id: 'plan', request_id: 'request' }, legs: { 'BTC-position': { symbol: 'BTC-position' } } };
    state.rfq_state = { status: 'Filled', tracking_applied: false };
  });
  rejects(f, 'greeks', 'GREEKS_ORDER_UNRESOLVED'); rejects(f, 'greeks', 'GREEKS_TASK_UNRESOLVED'); rejects(f, 'greeks', 'GREEKS_RFQ_UNRESOLVED');
});

for (const [key, value, code] of [
  ['post_fill_check:solo', true, 'ASTER_POST_FILL_UNRESOLVED'],
  ['recovery_auto_pause:solo', { intent_id: 'old-intent' }, 'ASTER_AUTO_RESUME_REMAINS'],
  ['pair_runtime:paired', { pending: { id: 'unknown-order' } }, 'ASTER_PAIR_UNRESOLVED'],
  ['pair_margin:paired', { pending: { request_id: 'unknown-transfer', status: 'unknown' } }, 'ASTER_TRANSFER_UNRESOLVED'],
  ['pair_margin:paired', { status: 'acknowledged' }, 'ASTER_TRANSFER_UNRESOLVED'],
  ['adl_pair:paired', { status: 'blocked', hold: true, batches: [] }, 'ASTER_ADL_UNRESOLVED'],
  ['cycle:solo', { quantities: { LONG: '0.000000000000000000001', SHORT: '0' } }, 'ASTER_CYCLE_UNRESOLVED'],
  ['adl_event:retired:symbol:order', { account_id: 'solo', executed_qty: '1.000000000000000000001', handled_qty: '1' }, 'ASTER_ADL_EVENT_UNRESOLVED'],
]) test(`Aster ${key.split(':')[0]} remains a financial blocker after a restart`, t => {
  const f = fixture(t); putKv(f, key, value); rejects(f, 'aster', code);
});

test('Aster live automation includes paused pair ADL and independent margin settings', t => {
  const f = fixture(t);
  f.sql('aster', db => {
    const row = db.prepare("SELECT data FROM pairs WHERE id='paired'").get(); const pair = JSON.parse(row.data);
    pair.adl.enabled = true; pair.margin.enabled = true;
    db.prepare("UPDATE pairs SET data=? WHERE id='paired'").run(JSON.stringify(pair));
  });
  rejects(f, 'aster', 'ASTER_PAIR_AUTOMATION_ENABLED');
});

test('paper activity does not become a live-funds pending operation', t => {
  const f = fixture(t);
  f.sql('aster', db => {
    const row = db.prepare("SELECT data FROM accounts WHERE id='paper'").get(); const account = JSON.parse(row.data); account.enabled = true;
    db.prepare("UPDATE accounts SET data=? WHERE id='paper'").run(JSON.stringify(account));
    db.prepare('INSERT INTO intents VALUES (?,?,?,?)').run('paper-intent', 'paper', 'pending', JSON.stringify({ id: 'paper-intent', account_id: 'paper', status: 'pending' }));
  });
  putKv(f, 'post_fill_check:paper', true);
  assert.equal(f.result().safeForHandoff, true, JSON.stringify(f.result()));
});

test('settled financial history, tracked RFQ and retained account isolations survive inspection', t => {
  const f = fixture(t);
  f.sql('hub', db => {
    db.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('completed-job', JSON.stringify({ id: 'completed-job', status: 'completed' }));
    db.prepare('INSERT INTO execution_orders VALUES (?,?,?)').run('completed-order', 'completed-job', JSON.stringify({ localId: 'completed-order', jobId: 'completed-job', settled: true, unknown: false, state: 'terminal', writerOperation: { state: 'confirmed' } }));
  });
  f.sql('crossex', db => {
    db.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run('filled', 'filled-preview', 1, JSON.stringify({ id: 'filled', kind: 'open' }));
    db.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run('filled-order', 'filled', 'filled-text', 1, 'FILLED', 1, JSON.stringify({ id: 'filled-order', executionId: 'filled', status: 'FILLED' }));
  });
  f.greeks(state => {
    state.order_journal.filled = { symbol: 'BTC-position', side: 'Buy', qty: .25, filledQty: .25, reduce_only: false, terminal: true, status: 'filled' };
    state.rfq_state = { status: 'Filled', tracking_applied: true, selected_quote_id: 'filled-quote', execution_resolved: true };
  });
  const before = hashes(f.directory), result = f.result();
  assert.equal(result.safeForHandoff, true, JSON.stringify(result));
  assert.equal(result.counts.hubOrders, 1); assert.equal(result.counts.crossexOrders, 1); assert.equal(result.counts.isolations, 1);
  assert.deepEqual(hashes(f.directory), before);
});

test('terminal Aster manual archives with explicitly unknown execution outcomes are not sealed', t => {
  const f = fixture(t);
  f.sql('aster', db => db.prepare('INSERT INTO intents VALUES (?,?,?,?)').run('archived', 'solo', 'aborted', JSON.stringify({ id: 'archived', account_id: 'solo', status: 'aborted', resolution: { execution_result_unknown: true } })));
  rejects(f, 'aster', 'ASTER_INTENT_OUTCOME_UNKNOWN');
});

test('missing required files, damaged JSON and missing risk tables fail closed with redacted reasons', t => {
  const f = fixture(t);
  rmSync(path.join(f.directory, 'execution-control.sqlite'));
  writeFileSync(path.join(f.directory, 'modules/greeks/engine_state.json'), '{"secret":"must-never-escape"');
  f.sql('hub', db => db.exec('DROP TABLE execution_orders'));
  rejects(f, 'shared', 'FILE_MISSING'); rejects(f, 'greeks', 'INVALID_JSON'); rejects(f, 'hub', 'SCHEMA_MISMATCH');
  assert.ok(!JSON.stringify(f.result()).includes('must-never-escape'));
});

test('unknown schema columns and inconsistent order row identities are never accepted', t => {
  const f = fixture(t);
  f.sql('hub', db => db.exec('ALTER TABLE execution_jobs ADD COLUMN unknown_dispatch TEXT'));
  f.sql('crossex', db => db.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run('row-id', 'missing', 'unique-text', 1, 'FILLED', 1, JSON.stringify({ id: 'different-id', status: 'FILLED' })));
  rejects(f, 'hub', 'SCHEMA_MISMATCH'); rejects(f, 'crossex', 'INVALID_JOURNAL');
});

test('uncheckpointed WAL is refused rather than reading an older main-file inventory', t => {
  const f = fixture(t), db = new DatabaseSync(path.join(f.directory, 'hub.sqlite'));
  try {
    db.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('wal-only-job', JSON.stringify({ id: 'wal-only-job', status: 'running' }));
    rejects(f, 'hub', 'DATABASE_WAL_UNCHECKPOINTED');
  } finally { db.close(); }
  rejects(f, 'hub', 'HUB_JOB_UNRESOLVED');
});

test('zero-fill and partially handled ADL candidates remain unresolved until the venue order is terminal', t => {
  const f = fixture(t);
  for (const [status, quantity] of [['NEW_ADL', '0'], ['NEW', '0'], ['PARTIALLY_FILLED', '0.25']]) {
    putKv(f, 'adl_event:owner:symbol:order', { account_id: 'solo', status, executed_qty: quantity, handled_qty: quantity });
    rejects(f, 'aster', 'ASTER_ADL_EVENT_UNRESOLVED');
  }
  putKv(f, 'adl_event:owner:symbol:order', { account_id: 'solo', status: 'FILLED', executed_qty: '1', handled_qty: '1' });
  assert.equal(f.result().safeForHandoff, true, JSON.stringify(f.result()));
});
