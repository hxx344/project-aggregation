import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountKey, createAccountWriter, getAccountWriterDiagnostics } from '../server/execution/account-writer.mjs';
import { parseWriterDiagnostics } from '../src/account-writer-diagnostics.ts';

const identity = (accountId = '918273645') => ({ authority: 'binance', environment: 'mainnet', accountId });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-diagnostics-'));
  const databasePath = path.join(directory, 'registry.sqlite');
  const writers = [];
  t.after(() => { for (const writer of writers) { try { writer.close(); } catch {} } fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, writer(moduleId = 'hub', options = {}) { const writer = createAccountWriter({ databasePath, moduleId, runtimeId: `private-runtime-${writers.length}`, now: () => 1000, ...options }); writers.push(writer); return writer; } };
}
const bindClaim = (writer, account = identity(), connection = 'private-connection') => { writer.bind(connection, account, 1); return writer.claim([account]); };
const diagnose = (writer, options) => parseWriterDiagnostics(getAccountWriterDiagnostics(writer, options));
function databaseState(writer) {
  const tables = ['aw_meta', 'aw_owners', 'aw_bindings', 'aw_accounts', 'aw_operations', 'aw_operation_accounts', 'aw_isolations'];
  return { tables: tables.map(table => writer.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()), changes: writer.db.prepare('SELECT total_changes() AS count').get().count,
    lastNow: writer.lastNow, retired: writer.retired, held: [...writer.held] };
}

test('diagnostics associate unverified bindings only with other modules in the same authority and environment', t => {
  const f = fixture(t), writer = f.writer('hub'), ticket = bindClaim(writer);
  const other = f.writer('aster');
  other.bind('wrong-environment', null, 1, { authority: 'binance', environment: 'testnet' });
  other.bind('wrong-authority', null, 1, { authority: 'bybit', environment: 'mainnet' });
  writer.bind('own-unverified', null, 1, { authority: 'binance', environment: 'mainnet' });
  assert.deepEqual(diagnose(writer).rows[0].unverifiedModules, []);
  other.bind('blocking-binding', null, 1, { authority: 'binance', environment: 'mainnet' });
  assert.throws(() => writer.assertOwned(ticket), error => error.code === 'UNVERIFIED_BINDING');
  const before = databaseState(writer), result = diagnose(writer);
  assert.deepEqual(result.rows[0].unverifiedModules, ['aster']);
  assert.ok(result.rows[0].reasons.includes('unverified-binding'));
  assert.deepEqual(databaseState(writer), before);
  assert.doesNotMatch(JSON.stringify(result), /blocking-binding|own-unverified/);
});

test('diagnostics explain conflicts, both pending states and isolation without changing writer state', (t) => {
  const f = fixture(t); let now = 1000;
  const writer = f.writer('hub', { now: () => now }); const ticket = bindClaim(writer);
  writer.prepare(ticket, 'private-operation-one', { groupId: 'private-group', leg: 1 });
  now = 2000;
  const operation = writer.prepare(ticket, 'private-operation-two', { groupId: 'private-group', leg: 2 });
  writer.finish(operation, 'unknown');
  const other = f.writer('aster', { now: () => now }); other.bind('private-other-connection', identity(), 1);
  other.freeze([identity()], 'legacy-conflict');
  const before = databaseState(writer);
  for (const method of ['_time', '_owner', '_transaction', 'claim', 'assertOwned', 'resolve', '_checkRegistryFile']) writer[method] = () => { throw new Error(`diagnostics called ${method}`); };
  const result = diagnose(writer);
  assert.equal(result.registry, 'available'); assert.equal(result.generatedAt, 2000);
  assert.equal(result.rows.length, 2);
  const row = result.rows.find(row => row.moduleId === 'aster');
  assert.deepEqual(row.pending, { sending: 1, unknown: 1, oldestAt: 1000, latestAt: 2000 });
  assert.equal(row.isolation.since, 2000); assert.equal(row.lease.until, 61_000); assert.equal(row.owner.state, 'active');
  assert.deepEqual(row.reasons, ['account-isolated', 'lease-conflict', 'sending', 'unknown-result']);
  assert.equal(result.modules.find(row => row.moduleId === 'greeks').ownerEvidence, 'unknown');
  assert.equal(result.modules.find(row => row.moduleId === 'greeks').activeOwners, null);
  assert.equal(result.modules.find(row => row.moduleId === 'greeks').unverifiedBindings, null);
  assert.equal(result.modules.find(row => row.moduleId === 'hub').reachability, 'unknown');
  const serialized = JSON.stringify(result);
  for (const secret of [identity().accountId, accountKey(identity()), writer.ownerId, writer.runtimeId, 'private-connection', 'private-operation-one', 'private-group']) assert.equal(serialized.includes(secret), false, secret);
  assert.doesNotMatch(serialized, /accountKey|connectionId|operationId|ticket_json|body_hash/);
  for (let repeat = 0; repeat < 5; repeat++) assert.deepEqual(diagnose(writer), result);
  assert.deepEqual(databaseState(writer), before);
  // Restore only cleanup; no diagnostic read is permitted to call this path.
  delete writer._transaction;
});

test('expired, closed, absent owner, unclaimed binding and recovery quarantine stay distinct', (t) => {
  const f = fixture(t); let now = 1000;
  const writer = f.writer('hub', { now: () => now }); bindClaim(writer);
  now = 62_000;
  assert.ok(diagnose(writer).rows[0].reasons.includes('lease-expired'));
  writer.db.prepare("UPDATE aw_owners SET status='closed'").run();
  assert.equal(diagnose(writer).rows[0].owner.state, 'closed');
  writer.db.prepare('DELETE FROM aw_owners').run();
  assert.equal(diagnose(writer).rows[0].owner.state, 'missing');
  const other = f.writer('greeks', { now: () => now }); other.bind('unclaimed', identity('23'), 1);
  other.bind('unverified', null, 1, { authority: 'binance', environment: 'mainnet' });
  const recovery = JSON.parse(writer.db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);
  writer.db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify({ ...recovery, state: 'quarantine' }));
  const result = diagnose(writer);
  assert.equal(result.recovery.state, 'quarantine'); assert.equal(result.recovery.since, null);
  const unclaimed = result.rows.find(row => row.moduleId === 'greeks');
  assert.equal(unclaimed.lease.state, 'missing'); assert.ok(unclaimed.reasons.includes('recovery-quarantine'));
  assert.equal(result.modules.find(row => row.moduleId === 'greeks').unverifiedBindings, 1);
});

test('disabled, closed, missing, malformed registry and invalid clocks never produce empty success', (t) => {
  assert.equal(diagnose(null).registry, 'disabled'); assert.equal(diagnose(null).completeness, 'unknown');
  const f = fixture(t); const writer = f.writer();
  writer.close();
  assert.equal(diagnose(writer).errorCode, 'WRITER_CLOSED');
  const missing = f.writer(); fs.unlinkSync(`${f.databasePath}.required`);
  const beforeRetired = missing.retired;
  const result = diagnose(missing);
  assert.equal(result.errorCode, 'REGISTRY_MISSING'); assert.equal(result.totalRows, null); assert.equal(missing.retired, beforeRetired);
  for (const module of result.modules) assert.equal(module.activeOwners, null);
  const broken = { snapshot() { throw new Error('malformed database /private/path and secret'); } };
  assert.equal(diagnose(broken).errorCode, 'REGISTRY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(diagnose(broken)), /private|secret|malformed/);
});

test('real schema damage, invalid recovery and backward time are diagnostic unknown without retirement', (t) => {
  const f = fixture(t); let now = 1000;
  const writer = f.writer('hub', { now: () => now });
  now = 999;
  assert.equal(diagnose(writer).errorCode, 'INVALID_CLOCK'); assert.equal(writer.retired, false);
  now = 1000;
  writer.db.prepare("UPDATE aw_meta SET value='broken' WHERE key='recovery_state'").run();
  assert.equal(diagnose(writer).errorCode, 'INVALID_RECOVERY_STATE'); assert.equal(writer.retired, false);
  writer.db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify({ schemaVersion: 1, state: 'normal', authorityId: crypto.randomUUID() }));
  writer.db.exec('DROP TABLE aw_isolations');
  assert.equal(diagnose(writer).errorCode, 'REGISTRY_UNAVAILABLE'); assert.equal(writer.retired, false);
});

test('bounded rows report truncation, stable pseudonyms and no private owner metadata', (t) => {
  const f = fixture(t); const writer = f.writer();
  for (let i = 1; i <= 205; i++) writer.bind(`connection-${i}`, identity(String(i)), 1);
  const result = diagnose(writer);
  assert.equal(result.rows.length, 200); assert.equal(result.totalRows, 205); assert.equal(result.truncated, true); assert.equal(result.completeness, 'truncated');
  assert.equal(new Set(result.rows.map(row => row.accountRef)).size, 200);
  const limited = diagnose(writer, { rowLimit: 2 }); assert.deepEqual(limited.rows, result.rows.slice(0, 2));
  assert.equal(limited.rowLimit, 2);
  assert.throws(() => writer.snapshot({ includeDiagnostics: true, rowLimit: 0 }), error => error.code === 'REGISTRY_UNAVAILABLE');
});

test('diagnostic reads never recover or delete a marker temporary hardlink', (t) => {
  const f = fixture(t); const writer = f.writer();
  const temporary = `${f.databasePath}.required.tmp-99999999-${crypto.randomUUID()}`;
  fs.linkSync(`${f.databasePath}.required`, temporary);
  const before = databaseState(writer);
  assert.equal(diagnose(writer).errorCode, 'REGISTRY_BUSY');
  assert.equal(fs.existsSync(temporary), true);
  assert.equal(fs.statSync(temporary).nlink, 2);
  assert.deepEqual(databaseState(writer), before);
  fs.unlinkSync(temporary);
});

test('a recovery transition during collection is unknown rather than mixed normal evidence', (t) => {
  const f = fixture(t); const writer = f.writer();
  const prepare = writer.db.prepare.bind(writer.db);
  writer.db.prepare = (sql) => {
    if (sql.startsWith('WITH')) {
      const recovery = JSON.parse(prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);
      prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify({ ...recovery, state: 'quarantine' }));
    }
    return prepare(sql);
  };
  assert.equal(diagnose(writer).errorCode, 'REGISTRY_BUSY');
  writer.db.prepare = prepare;
  assert.equal(diagnose(writer).recovery.state, 'quarantine');
});

test('native Python writer records use the same Node projection and preserve closed pending evidence', (t) => {
  const f = fixture(t); const writer = f.writer('hub', { now: () => 3000 });
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const directory = fileURLToPath(new URL('../server/execution', import.meta.url));
  const script = `import sys\nsys.path.insert(0, sys.argv[1])\nfrom account_writer import AccountWriter\ni={"authority":"binance","environment":"mainnet","accountId":"771234567"}\nw=AccountWriter(sys.argv[2],"aster","private-python-runtime",now=lambda:2000)\nw.bind("private-python-connection",i,1)\nt=w.claim([i])\no=w.prepare(t,"private-python-operation",{"symbol":"BTCUSDT","target":10})\nw.finish(o,"unknown")\nw.freeze([i],"manual-isolation")\nw.close()\n`;
  const result = spawnSync(python, ['-c', script, directory, f.databasePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const before = databaseState(writer);
  const snapshot = diagnose(writer); const row = snapshot.rows[0];
  assert.equal(row.moduleId, 'aster'); assert.equal(row.owner.state, 'closed'); assert.equal(row.pending.unknown, 1); assert.equal(row.pending.oldestAt, 2000);
  assert.equal(row.isolation.reason, 'manual-isolation'); assert.equal(row.isolation.since, 2000);
  assert.ok(row.reasons.includes('owner-closed'));
  assert.doesNotMatch(JSON.stringify(snapshot), /771234567|private-python|operationId|connectionId/);
  assert.deepEqual(databaseState(writer), before);
});

test('legacy or malformed API responses cannot claim a complete empty registry', () => {
  assert.throws(() => parseWriterDiagnostics({ accounts: [] }), /未知/);
  const disabled = getAccountWriterDiagnostics(null);
  assert.throws(() => parseWriterDiagnostics({ diagnostics: { ...disabled.diagnostics, registry: 'available' } }), /未知/);
});
