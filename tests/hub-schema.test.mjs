import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase } from '../server/control/schema.mjs';
import { inspectHubSchema } from '../server/control/hub-schema.mjs';
import { createTrading } from '../server/trading.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { createTradingAuto } from '../server/trading-auto.mjs';
import { createAnthropicReduction } from '../server/trading-anthropic-reduction.mjs';
import { createBaseline } from '../server/observability.mjs';

// The version contract of hub.sqlite (docs/hub-schema-inventory.md) against
// the real creators: the runtime runs all of them on every start.
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const same = value => value;
const LEGACY_SQL = [
  'CREATE TABLE trading_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, verified_at TEXT, snapshot TEXT)',
  'CREATE TABLE trading_pnl_samples_v2 (pair_key TEXT NOT NULL, revision_key TEXT NOT NULL, time INTEGER NOT NULL, first_at INTEGER, second_at INTEGER, unrealized_pnl TEXT, PRIMARY KEY (pair_key, revision_key, time))',
  'CREATE TABLE platform_baseline_samples (bucket_ms INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, json TEXT NOT NULL)',
  'CREATE TABLE trading_views (days INTEGER PRIMARY KEY, version INTEGER NOT NULL, source_key TEXT NOT NULL, json TEXT NOT NULL)',
];

async function hubFile(t, seed = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hub.sqlite');
  if (seed.length) {
    const raw = new DatabaseSync(file);
    raw.exec(['PRAGMA journal_mode=WAL', ...seed].join(';'));
    raw.close();
  }
  return file;
}

async function runCreators(file) {
  const db = openHubDatabase(file);
  const trading = createTrading({ db, encrypt: same, decrypt: same, clientFactory: () => ({}), intervalMs: 1e9, logger: quiet });
  const execution = createTradingExecution({ db, encrypt: same, decrypt: same, clientFactory: () => ({}), intervalMs: 0 });
  const auto = createTradingAuto({ db, execution, intervalMs: 0, log: () => {} });
  const reduction = createAnthropicReduction({ db, execution, intervalMs: 0, log: quiet });
  const baseline = createBaseline({ db, readSnapshot: async () => null, intervalMs: 0, logger: quiet });
  for (const service of [baseline, reduction, auto, execution, trading]) await service.close();
  return db;
}

const diff = report => ({ missing: report.missing, legacy: report.legacy, mismatched: report.mismatched, unexpected: report.unexpected });
const clean = { missing: [], legacy: [], mismatched: [], unexpected: [] };

test('the current creators produce exactly the version 1 layout', async t => {
  const db = await runCreators(await hubFile(t));
  t.after(() => db.close());
  const report = inspectHubSchema(db);
  // A failure here means a creator's DDL changed: give hub.sqlite a new version and a migration.
  assert.deepEqual(diff(report), clean);
  assert.equal(report.state, 'v0-complete');
  assert.equal(report.userVersion, 0);
});

test('known version 0 layouts are legacy, and the creators complete them', async t => {
  const file = await hubFile(t, LEGACY_SQL);
  const before = new DatabaseSync(file, { readOnly: true });
  const report = inspectHubSchema(before);
  before.close();
  assert.equal(report.state, 'v0-legacy');
  assert.deepEqual(report.legacy, ['platform_baseline_samples', 'trading_accounts', 'trading_pnl_samples_v2']);
  assert.ok(report.missing.includes('settings') && report.missing.includes('execution_jobs_unfinished'));
  assert.deepEqual(report.retired, ['trading_views']);

  const db = await runCreators(file);
  t.after(() => db.close());
  const after = inspectHubSchema(db);
  assert.deepEqual(diff(after), clean);
  assert.equal(after.state, 'v0-complete');
  assert.deepEqual(after.retired, ['trading_views']);
});

test('an index condition or generated column redefined under the same name is unknown', async t => {
  const file = await hubFile(t, [
    'CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL)',
    "CREATE INDEX execution_jobs_unfinished ON execution_jobs(json_extract(json,'$.createdAt')) WHERE json_extract(json,'$.status') NOT IN ('completed')",
    'CREATE TABLE platform_baseline_samples (bucket_ms INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, json TEXT NOT NULL, valid_sample INTEGER GENERATED ALWAYS AS (1) VIRTUAL)',
  ]);
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  const report = inspectHubSchema(db);
  assert.equal(report.state, 'unknown');
  assert.deepEqual(report.mismatched, ['execution_jobs_unfinished', 'platform_baseline_samples']);
});

test('extra columns, tables and views are unknown', async t => {
  const db = await runCreators(await hubFile(t));
  t.after(() => db.close());
  db.exec('ALTER TABLE settings ADD COLUMN note TEXT; CREATE TABLE future_rows (id TEXT PRIMARY KEY); CREATE VIEW future_view AS SELECT key FROM settings');
  const report = inspectHubSchema(db);
  assert.equal(report.state, 'unknown');
  assert.deepEqual(report.mismatched, ['settings']);
  assert.deepEqual(report.unexpected, ['future_rows', 'future_view']);
});

test('user_version separates version 1, a newer version and an inconsistent mark', async t => {
  const db = await runCreators(await hubFile(t));
  t.after(() => db.close());
  db.exec('PRAGMA user_version=1');
  assert.equal(inspectHubSchema(db).state, 'v1');
  db.exec('PRAGMA user_version=2');
  assert.equal(inspectHubSchema(db).state, 'newer');
  db.exec('PRAGMA user_version=-1');
  assert.equal(inspectHubSchema(db).state, 'unknown');
  db.exec('PRAGMA user_version=1; DROP INDEX execution_orders_unsettled');
  const report = inspectHubSchema(db);
  assert.equal(report.state, 'unknown');
  assert.deepEqual(report.missing, ['execution_orders_unsettled']);
});

test('inspection reads a query-only connection and leaves the version unmarked', async t => {
  const file = await hubFile(t);
  (await runCreators(file)).close();
  const db = openHubDatabase(file, { create: false });
  t.after(() => db.close());
  assert.equal(inspectHubSchema(db).state, 'v0-complete');
  assert.equal(inspectHubSchema(db).userVersion, 0);
});
