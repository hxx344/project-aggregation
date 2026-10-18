import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { assertRecoveryStartup } from '../server/recovery/startup.mjs';
import { createUpdateCoordinator, unavailableUpdateState } from '../server/updates.mjs';
import { runRecoveryCli } from '../server/recovery/cli.mjs';

test('unfinished recovery refuses both actual Hub factory and startup before creating new credentials or databases', async t => {
  for (const status of ['restoring', 'failed', 'complete']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-startup-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, 'recovery-control.json'), JSON.stringify({ body: { schemaVersion: 1, status } }));
    assert.throws(() => assertRecoveryStartup(dataDir), /恢复/);
    await assert.rejects(createApp({ dataDir, logger: () => {}, refreshInterval: 0 }), /恢复/);
    assert.equal(fs.existsSync(path.join(dataDir, 'credentials.key')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'hub.sqlite')), false);
  }
});

test('updater idle clears only its own maintenance state and cannot clear a real shared quarantine', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-idle-'));
  const databasePath = path.join(dataDir, 'execution-control.sqlite');
  const writer = createAccountWriter({ databasePath, moduleId: 'hub', runtimeId: randomUUID() });
  t.after(() => { writer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const db = new DatabaseSync(databasePath);
  const state = JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);
  db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify({ ...state, state: 'quarantine', recoveryId: randomUUID() })); db.close();
  let maintenance = true;
  const coordinator = createUpdateCoordinator({ execution: { state: () => ({ jobs: [] }) }, readMaintenance: () => maintenance,
    writeMaintenance: value => { maintenance = value; }, client: { status: async () => ({ ...unavailableUpdateState(), enabled: true }) } });
  await coordinator.status(); assert.equal(maintenance, false); assert.equal(writer.snapshot().recovery.state, 'quarantine');
  const identity = { authority: 'bybit', environment: 'mainnet', accountId: '123' };
  writer.bind('probe', identity, 1); const ticket = writer.claim([identity]);
  assert.throws(() => writer.prepare(ticket, 'blocked-after-idle', { action: 'create' }), { code: 'RECOVERY_REQUIRED' });
});

test('operator key initialization is idempotent and refuses a shared key path', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-keys-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, 'data.key'), secretsFile = path.join(directory, 'secrets.key');
  const args = ['keys', '--data-key-file', dataFile, '--secrets-key-file', secretsFile];
  assert.equal((await runRecoveryCli(args)).keysReady, true);
  const first = fs.readFileSync(dataFile), second = fs.readFileSync(secretsFile);
  assert.equal(first.length, 32); assert.equal(second.length, 32); assert.notDeepEqual(first, second);
  await runRecoveryCli(args); assert.deepEqual(fs.readFileSync(dataFile), first); assert.deepEqual(fs.readFileSync(secretsFile), second);
  await assert.rejects(runRecoveryCli(['keys', '--data-key-file', dataFile, '--secrets-key-file', dataFile]), { code: 'RECOVERY_KEYS_MUST_DIFFER' });
});

test('missing registry with a retained required marker never falls back to an unprotected Hub', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-missing-registry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'execution-control.sqlite.required'), '{}');
  await assert.rejects(createApp({ dataDir, embeddedModules: false, logger: () => {}, refreshInterval: 0 }), /保护数据库缺失/);
  assert.equal(fs.existsSync(path.join(dataDir, 'execution-control.sqlite')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'credentials.key')), false);
});

test('actual Hub external-module mode cannot bypass a recovered authority and submit a live task', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-legacy-entry-'));
  const databasePath = path.join(dataDir, 'execution-control.sqlite');
  const previous = createAccountWriter({ databasePath, moduleId: 'hub', runtimeId: randomUUID() }); previous.close();
  const db = new DatabaseSync(databasePath);
  const state = JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);
  db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify({ ...state, state: 'quarantine', recoveryId: randomUUID() })); db.close();
  let sends = 0;
  const clientFactory = exchange => ({
    verify: async () => ({ identity: exchange === 'binance' ? '100' : '200' }),
    account: async () => ({ identity: exchange === 'binance' ? '100' : '200', modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] }),
    market: async symbol => ({ symbol, bid: '70', ask: '70.01', at: new Date().toISOString(), rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } }),
    create: async () => { sends++; throw new Error('unexpected exchange write'); },
  });
  const app = await createApp({ dataDir, initialPassword: 'recovery-legacy-test-password', logger: () => {}, embeddedModules: false,
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, executionClientFactory: clientFactory });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'recovery-legacy-test-password' }) });
  assert.equal(login.status, 200);
  const sessions = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  const sessionId = sessions.prepare('SELECT id FROM sessions').get().id; sessions.close();
  for (const exchange of ['binance', 'bybit']) await app.execution.connect(exchange, { revision: 0, accountMode: exchange === 'binance' ? 'standard' : 'unified', apiKey: 'fixture_key', apiSecret: 'fixture_secret' });
  assert.ok(app.execution.state().connections.every(row => Object.hasOwn(row, 'writeProtection')));
  const plan = await app.execution.preview({ preset: 'cross-exchange', action: 'open', legs: [
    { exchange: 'binance', symbol: 'CLUSDT', side: 'long', quantity: '2', stopPrice: '90' },
    { exchange: 'bybit', symbol: 'CLUSDT', side: 'short', quantity: '2', stopPrice: '50' },
  ], batchCount: 1, batchIntervalMs: 1000, repriceIntervalMs: 1000, timeoutMs: 60000 }, sessionId);
  assert.throws(() => app.execution.start({ previewId: plan.id, requestId: randomUUID(), confirmLive: true }, sessionId), /许可|所有权/);
  await app.execution.tick(); assert.equal(sends, 0); assert.equal(app.execution.state().jobs.length, 0);
});
