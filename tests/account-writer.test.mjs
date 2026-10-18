import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { accountKey, createAccountWriter, normalizeAccountIdentity } from '../server/execution/account-writer.mjs';

const identity = (accountId = '918273645', extra = {}) => ({ authority: 'binance', environment: 'mainnet', accountId, ...extra });
const code = (expected) => (error) => error.code === expected;
const pythonCommand = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-writer-'));
  const databasePath = path.join(directory, 'execution-control.sqlite');
  const writers = [];
  t.after(() => { for (const writer of writers) { try { writer.close(); } catch (error) { if (!['REGISTRY_MISSING', 'REGISTRY_REPLACED'].includes(error.code)) throw error; } } fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, writer(moduleId = 'hub', options = {}) { const result = createAccountWriter({ databasePath, moduleId, runtimeId: crypto.randomUUID(), ...options }); writers.push(result); return result; } };
}
function bindClaim(writer, values = [identity()]) { values.forEach((value, index) => writer.bind(`connection-${index}`, value, 1)); return writer.claim(values); }
function readRow(databasePath, sql, ...args) { const database = new DatabaseSync(databasePath, { readOnly: true }); try { return database.prepare(sql).get(...args); } finally { database.close(); } }

test('account identity is independent of API key revision, parent, and decimal UID formatting', (t) => {
  const f = fixture(t); const writer = f.writer();
  assert.equal(accountKey(identity('000123')), accountKey(identity('123', { parentAccountId: '80' })));
  assert.notEqual(accountKey(identity('124', { parentAccountId: '80' })), accountKey(identity('123', { parentAccountId: '80' })));
  assert.notEqual(accountKey(identity('123')), accountKey(identity('123', { environment: 'testnet' })));
  assert.equal(normalizeAccountIdentity(identity(123)).accountId, '123');
  for (const bad of ['0', '-1', '1.0', ' 1', 'abc']) assert.throws(() => accountKey(identity(bad)), code('INVALID_IDENTITY'));
  assert.throws(() => accountKey({ ...identity(), apiKey: 'forbidden' }), code('INVALID_IDENTITY'));
  const wallet = `0x${'Aa'.repeat(20)}`;
  assert.equal(normalizeAccountIdentity(identity(wallet, { authority: 'aster' })).accountId, wallet.toLowerCase());
  const old = bindClaim(writer);
  writer.bind('connection-0', identity(), 2);
  assert.throws(() => writer.assertOwned(old, 0), code('BINDING_CHANGED'));
  const next = writer.claim([identity()]);
  assert.equal(next.claims[0].fence, old.claims[0].fence);
  assert.equal(writer.assertOwned(next, 0), true);
  writer.bind('connection-0', identity(undefined, { parentAccountId: '555' }), 2);
  assert.throws(() => writer.assertOwned(next), code('BINDING_CHANGED'));
});

test('multi-account claim rolls back atomically and module pin survives closed owner and expiry', (t) => {
  const f = fixture(t); const first = f.writer('hub'); const second = f.writer('greeks');
  const pinned = identity('123'); const free = identity('124');
  bindClaim(first, [pinned]); first.close();
  second.bind('a', pinned, 1); second.bind('b', free, 1);
  assert.throws(() => second.claim([free, pinned]), code('ACCOUNT_PINNED'));
  assert.equal(readRow(f.databasePath, 'SELECT COUNT(*) AS count FROM aw_accounts WHERE module_id=?', 'greeks').count, 0);
  assert.equal(second.claim([free]).claims.length, 1);
  const distinct = identity('123', { environment: 'testnet' }); second.bind('test', distinct, 1);
  assert.equal(second.claim([distinct]).claims.length, 1);
});

test('unknown scope blocks foreign module and release generation never resurrects old tickets', (t) => {
  const f = fixture(t); const first = f.writer('hub'); const second = f.writer('greeks');
  first.bind('legacy', null, 1, { authority: 'binance', environment: 'mainnet' });
  second.bind('real', identity(), 1);
  assert.throws(() => second.claim([identity()]), code('UNVERIFIED_BINDING'));
  first.releaseBinding('legacy');
  const ticket = second.claim([identity()]);
  second.releaseBinding('real'); second.bind('real', identity(), 1);
  assert.throws(() => second.assertOwned(ticket), code('BINDING_CHANGED'));
  assert.ok(second.claim([identity()]).bindings[0].generation > ticket.bindings[0].generation);
});

test('alive PID cannot be replaced after TTL; dead takeover fences old results permanently', (t) => {
  const f = fixture(t); let time = 1000;
  const first = f.writer('hub', { now: () => time }); const ticket = bindClaim(first);
  const other = f.writer('hub', { now: () => 100_000 });
  assert.throws(() => other.claim([identity()]), code('OWNER_ALIVE'));
  const takeover = f.writer('hub', { now: () => 100_000, processAlive: () => false });
  const current = takeover.claim([identity()]);
  assert.equal(current.claims[0].fence, ticket.claims[0].fence + 1);
  assert.throws(() => first.assertOwned(ticket, 0), code('OWNERSHIP_LOST'));
  time = 1001;
  assert.throws(() => first.claim([identity()]), code('WRITER_RETIRED'));
  takeover.close();
  const latest = other.claim([identity()]);
  assert.equal(latest.claims[0].fence, current.claims[0].fence + 1);
});

test('expired lease and backward clock retire instance; budget renews only still-valid lease', (t) => {
  const f = fixture(t); let current = 1000;
  const writer = f.writer('hub', { now: () => current }); const ticket = bindClaim(writer);
  current += 20_000; writer.assertOwned(ticket, 35_000);
  assert.equal(readRow(f.databasePath, 'SELECT lease_until FROM aw_accounts').lease_until, current + 60_000);
  current += 60_000;
  assert.throws(() => writer.assertOwned(ticket, 0), code('LEASE_EXPIRED'));
  current -= 100;
  assert.throws(() => writer.claim([identity()]), code('WRITER_RETIRED'));
  const rollback = f.writer('greeks', { now: () => current }); const rollbackTicket = bindClaim(rollback, [identity('31')]);
  current--;
  assert.throws(() => rollback.assertOwned(rollbackTicket), code('CLOCK_ROLLBACK'));
  current += 100;
  assert.throws(() => rollback.assertOwned(rollbackTicket), code('WRITER_RETIRED'));
});

test('durable operation ledger blocks repeats, conflicting semantics, and unknown-account writes', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer);
  const payload = { kind: 'create', clientOrderId: 'order-1', quantity: '0.01', symbol: 'BTCUSDT' };
  const operation = writer.prepare(ticket, 'create:order-1', payload);
  assert.throws(() => writer.prepare(ticket, 'create:order-1', payload), code('OPERATION_UNRESOLVED'));
  assert.throws(() => writer.prepare(ticket, 'create:order-1', { ...payload, quantity: '0.02' }), code('OPERATION_CONFLICT'));
  writer.finish(operation, 'unknown');
  const recoveryTicket = writer.claim([identity()]);
  assert.throws(() => writer.prepare(recoveryTicket, 'create:order-2', payload), code('ACCOUNT_UNRESOLVED'));
  assert.throws(() => writer.releaseBinding('connection-0'), code('BINDING_UNRESOLVED'));
  assert.deepEqual(writer.unresolved(recoveryTicket).map((row) => row.operationId), ['create:order-1']);
  writer.resolve('create:order-1', recoveryTicket);
  assert.throws(() => writer.prepare(recoveryTicket, 'create:order-1', payload), code('ALREADY_SUBMITTED'));
  const next = writer.prepare(recoveryTicket, 'create:order-2', payload); writer.finish(next, 'rejected');
  assert.throws(() => writer.prepare(recoveryTicket, 'create:order-2', payload), code('ALREADY_REJECTED'));
  assert.equal(writer.importUnknown(recoveryTicket, 'create:order-2', payload).state, 'rejected');
  assert.throws(() => writer.resolve('missing', recoveryTicket), code('OPERATION_NOT_FOUND'));
});

test('migration imports all unknowns and isolation immediately blocks prior owner without deleting journal', (t) => {
  const f = fixture(t); const first = f.writer('hub'); const ticket = bindClaim(first);
  first.importUnknown(ticket, 'legacy:1', { clientId: 'one' }); first.importUnknown(ticket, 'legacy:2', { clientId: 'two' });
  const other = f.writer('aster'); other.bind('same', identity(), 1);
  assert.throws(() => other.claim([identity()]), code('ACCOUNT_PINNED'));
  other.freeze([identity()]);
  assert.throws(() => first.assertOwned(ticket, 0), code('ACCOUNT_ISOLATED'));
  assert.throws(() => first.claim([identity()]), code('ACCOUNT_ISOLATED'));
  assert.equal(readRow(f.databasePath, 'SELECT COUNT(*) AS count FROM aw_operations').count, 2);
  assert.deepEqual(first.snapshot().isolations, [{ authority: 'binance', environment: 'mainnet', reason: 'legacy-conflict', moduleId: 'aster' }]);
  assert.throws(() => other.freeze([identity(), identity('unverified')]), code('INVALID_IDENTITY'));
});

test('one atomic account ticket admits same-group legs but refuses other groups, unknowns and replacement owners', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer, [identity('71'), identity('72')]);
  const first = writer.prepare(ticket, 'pair:one', { groupId: 'trusted-pair', leg: 1 });
  const second = writer.prepare(ticket, 'pair:two', { groupId: 'trusted-pair', leg: 2 });
  assert.throws(() => writer.prepare(ticket, 'another-pair', { groupId: 'other', leg: 1 }), code('ACCOUNT_UNRESOLVED'));
  assert.throws(() => writer.prepare(ticket, 'pair:one', { groupId: 'trusted-pair', leg: 1 }), code('OPERATION_UNRESOLVED'));
  writer.finish(first, 'unknown');
  assert.throws(() => writer.prepare(ticket, 'pair:three', { groupId: 'trusted-pair', leg: 3 }), code('ACCOUNT_UNRESOLVED'));
  writer.resolve('pair:one', ticket);
  writer.close();
  const replacement = f.writer(); const recovery = replacement.claim([identity('71'), identity('72')]);
  assert.throws(() => replacement.prepare(recovery, 'pair:three', { groupId: 'trusted-pair', leg: 3 }), code('ACCOUNT_UNRESOLVED'));
  assert.throws(() => replacement.finish(second, 'confirmed'), code('INVALID_TICKET'));
  replacement.resolve('pair:two', recovery, 'confirmed');
  assert.equal(replacement.prepare(recovery, 'pair:three', { groupId: 'trusted-pair', leg: 3 }).state, 'sending');
});

test('positive-budget operation ticket rejects late transport after same-group unknown and terminal replay', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer, [identity('71'), identity('72')]);
  const first = writer.prepare(ticket, 'one', { groupId: 'pair', leg: 1 });
  const second = writer.prepare(ticket, 'two', { groupId: 'pair', leg: 2 });
  assert.equal(writer.assertOwned(second, 35000), true);
  writer.finish(first, 'unknown');
  assert.throws(() => writer.assertOwned(second, 35000), code('ACCOUNT_UNRESOLVED'));
  assert.throws(() => writer.assertOwned({ ...second, bodyHash: 'wrong' }, 35000), code('OPERATION_CONFLICT'));
  assert.throws(() => writer.assertOwned(first, 35000), code('OPERATION_UNRESOLVED'));
  assert.equal(writer.assertOwned(second, 0), true);
  writer.finish(second, 'confirmed');
  assert.throws(() => writer.assertOwned(second, 35000), code('ALREADY_SUBMITTED'));
  assert.equal(writer.assertOwned(second, 0), true);
});

test('verified same-original-order cancel can reduce unknown amend risk without clearing that unknown', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer);
  const intentTarget = { symbol: 'BTCUSDT', clientOrderId: 'original-client-order' };
  const amend = writer.prepare(ticket, 'amend', { intentAction: 'amend', intentTarget, price: '100' });
  writer.finish(amend, 'unknown');
  assert.throws(() => writer.prepare(ticket, 'other-cancel', { intentAction: 'cancel', intentTarget: { ...intentTarget, clientOrderId: 'different' } }), code('ACCOUNT_UNRESOLVED'));
  assert.throws(() => writer.prepare(ticket, 'new-create', { kind: 'create', clientId: 'new' }), code('ACCOUNT_UNRESOLVED'));
  const cancel = writer.prepare(ticket, 'cancel', { intentAction: 'cancel', intentTarget });
  assert.equal(writer.assertOwned(cancel, 35000), true);
  writer.finish(cancel, 'confirmed');
  assert.deepEqual(writer.unresolved(ticket).map((row) => row.operationId), ['amend']);
  assert.throws(() => writer.prepare(ticket, 'cancel', { intentAction: 'cancel', intentTarget }), code('ALREADY_SUBMITTED'));
  assert.throws(() => writer.prepare(ticket, 'forged', { intentAction: 'create', intentTarget }), code('INVALID_INTENT_TARGET'));
  const next = writer.prepare(ticket, 'cancel-again', { intentAction: 'cancel', intentTarget });
  writer.importUnknown(ticket, 'unrelated-create', { kind: 'create', clientId: 'unrelated' });
  assert.throws(() => writer.assertOwned(next, 35000), code('ACCOUNT_UNRESOLVED'));
});

test('cancel exception distinguishes identical client IDs on different accounts in a full group ticket', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer, [identity('71'), identity('72')]);
  const target = { symbol: 'BTCUSDT', clientOrderId: 'same-client-id' };
  assert.throws(() => writer.prepare(ticket, 'ambiguous', { intentAction: 'amend', intentTarget: target }), code('INVALID_INTENT_TARGET'));
  const amend = writer.prepare(ticket, 'amend-a', { intentAction: 'amend', intentTarget: { ...target, accountKey: accountKey(identity('71')) } });
  writer.finish(amend, 'unknown');
  assert.throws(() => writer.prepare(ticket, 'cancel-b', { intentAction: 'cancel', intentTarget: { ...target, accountKey: accountKey(identity('72')) } }), code('ACCOUNT_UNRESOLVED'));
  const cancel = writer.prepare(ticket, 'cancel-a', { intentAction: 'cancel', intentTarget: { ...target, accountKey: accountKey(identity('71')) } });
  assert.equal(writer.assertOwned(cancel, 35000), true);
});

test('payload credentials are rejected and ledger/snapshot never persist request bodies or raw identity', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer);
  for (const secret of ['apiKey', 'api_key', 'secretKey', 'secret_key', 'privateKey', 'signature', 'timestamp', 'nonce', 'passphrase', 'authorization']) assert.throws(() => writer.prepare(ticket, 'bad', { nested: { [secret]: 'DO-NOT-SAVE-THIS' } }), code('UNSAFE_PAYLOAD'));
  const operation = writer.prepare(ticket, 'safe', { clientId: 'body-only-not-persisted', quantity: 0.1 }); writer.finish(operation, 'confirmed');
  assert.doesNotMatch(JSON.stringify(writer.snapshot()), /918273645|accountKey|body-only-not-persisted/);
  const databaseBytes = Buffer.concat(['', '-wal'].filter((suffix) => fs.existsSync(f.databasePath + suffix)).map((suffix) => fs.readFileSync(f.databasePath + suffix))).toString('utf8');
  assert.doesNotMatch(databaseBytes, /DO-NOT-SAVE-THIS|body-only-not-persisted|918273645/);
});

test('busy registry rejects within bounded deadline and unsafe database paths fail closed', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer);
  const lock = new DatabaseSync(f.databasePath); lock.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  try { assert.throws(() => writer.assertOwned(ticket), code('REGISTRY_BUSY')); assert.ok(Date.now() - started < 1800); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  for (const databasePath of ['relative.sqlite', '\\\\server\\share\\execution-control.sqlite']) assert.throws(() => createAccountWriter({ databasePath, moduleId: 'x', runtimeId: 'x' }), code('UNSAFE_DATABASE_PATH'));
  const link = path.join(f.directory, 'linked.sqlite');
  try { fs.symlinkSync(f.databasePath, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.throws(() => createAccountWriter({ databasePath: link, moduleId: 'x', runtimeId: 'x' }), code('UNSAFE_DATABASE_PATH'));
});

test('POSIX writable ancestors reject unsafe rename while a trusted sticky temporary parent remains valid', { skip: process.platform === 'win32' ? 'POSIX ownership and sticky-directory behavior runs in native POSIX CI' : false }, (t) => {
  const f = fixture(t); const ancestor = path.join(f.directory, 'public-parent'); const parent = path.join(ancestor, 'protected-data');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(ancestor, 0o777);
  const databasePath = path.join(parent, 'execution-control.sqlite');
  assert.throws(() => f.writer('hub', { databasePath }), code('UNSAFE_DATABASE_PATH'));
  fs.chmodSync(ancestor, 0o1777);
  assert.equal(bindClaim(f.writer('hub', { databasePath })).claims.length, 1);
});

test('persistent required marker rejects registry disappearance and replacement before a new writer starts', (t) => {
  const f = fixture(t); const writer = f.writer(); const ticket = bindClaim(writer); writer.close();
  const saved = `${f.databasePath}.saved`;
  fs.renameSync(f.databasePath, saved);
  assert.throws(() => f.writer('greeks'), code('REGISTRY_MISSING'));
  assert.equal(fs.existsSync(f.databasePath), false);
  fs.copyFileSync(saved, f.databasePath);
  assert.throws(() => f.writer('greeks'), code('REGISTRY_REPLACED'));
  fs.unlinkSync(f.databasePath); fs.renameSync(saved, f.databasePath);
  const recovered = f.writer();
  const current = recovered.claim([identity()]);
  assert.equal(current.claims[0].fence, ticket.claims[0].fence + 1);
  fs.unlinkSync(`${f.databasePath}.required`);
  assert.throws(() => recovered.assertOwned(current, 0), code('REGISTRY_MISSING'));
  assert.throws(() => recovered.claim([identity()]), code('WRITER_RETIRED'));
});

async function pythonPeer(t, databasePath, moduleId = 'greeks', options = {}) {
  const peer = spawn(pythonCommand, [fileURLToPath(new URL('./account-writer-peer.py', import.meta.url)), JSON.stringify({ databasePath, moduleId, runtimeId: crypto.randomUUID(), ...options })], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(); let sequence = 0; let stderr = '';
  peer.stderr.on('data', (value) => { stderr += value; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { peer.kill(); reject(new Error('Python registry fixture startup timed out')); }, 10_000);
    const lines = createInterface({ input: peer.stdout });
    lines.on('line', (line) => { const value = JSON.parse(line); if (value.ready) { clearTimeout(timeout); resolve(); } else { const waiter = pending.get(value.id); pending.delete(value.id); waiter?.resolve(value); } });
    peer.on('error', (error) => { clearTimeout(timeout); reject(error); }); peer.on('exit', () => { clearTimeout(timeout); reject(new Error(`Python registry fixture exited: ${stderr}`)); for (const waiter of pending.values()) waiter.reject(new Error(`Peer exited: ${stderr}`)); });
  });
  await ready;
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); peer.kill(); reject(new Error(`Python registry fixture timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve(value) { clearTimeout(timeout); resolve(value); }, reject(error) { clearTimeout(timeout); reject(error); } });
    peer.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await call('close'); peer.stdin.end(); await new Promise((resolve) => { if (peer.exitCode !== null) resolve(); else peer.once('exit', resolve); }); };
  t.after(() => { if (!closed) { closed = true; peer.kill(); } });
  const kill = async () => { if (closed) return; closed = true; peer.kill(); await new Promise((resolve) => { if (peer.exitCode !== null) resolve(); else peer.once('exit', resolve); }); };
  return { call, close, kill };
}

test('cold Node/Python initialization publishes only a complete marker and preserves a concurrent winner', async (t) => {
  const f = fixture(t); const markerGate = path.join(f.directory, 'publish-gate');
  const starting = pythonPeer(t, f.databasePath, 'greeks', { markerGate });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(`${markerGate}.ready`)) {
    assert.ok(Date.now() < deadline, 'Python marker publication gate must become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(`${f.databasePath}.required`), false);
  const node = f.writer('hub'); const evidence = JSON.parse(fs.readFileSync(`${f.databasePath}.required`, 'utf8'));
  fs.writeFileSync(markerGate, 'continue');
  const peer = await starting;
  assert.equal(evidence.schema, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.databasePath}.required`, 'utf8')), evidence);
  assert.equal(node.snapshot().accounts.length, 0);
  assert.equal((await peer.call('snapshot')).result.accounts.length, 0);
  await peer.close(); node.close();
  fs.writeFileSync(`${f.databasePath}.required`, '');
  assert.throws(() => f.writer(), code('REGISTRY_REPLACED'));
  assert.equal(fs.readFileSync(`${f.databasePath}.required`, 'utf8'), '');
});

test('initializing Python waits boundedly for the atomic hard-link publication cleanup', async (t) => {
  const f = fixture(t); const node = f.writer(); node.close();
  const heldLink = `${f.databasePath}.required-held`;
  fs.linkSync(`${f.databasePath}.required`, heldLink);
  const starting = pythonPeer(t, f.databasePath);
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.unlinkSync(heldLink);
  const peer = await starting;
  assert.equal((await peer.call('snapshot')).result.accounts.length, 0);
  await peer.close();
});

test('crashed marker publisher recovers only its proven dead-process temporary link', async (t) => {
  const f = fixture(t);
  const result = spawnSync(pythonCommand, [fileURLToPath(new URL('./account-writer-peer.py', import.meta.url)), JSON.stringify({ databasePath: f.databasePath, moduleId: 'greeks', runtimeId: 'crash-probe', exitAfterMarkerLink: true })], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  assert.equal(result.status, 73, result.stderr);
  assert.equal(fs.lstatSync(`${f.databasePath}.required`).nlink, 2);
  const markerBody = fs.readFileSync(`${f.databasePath}.required`, 'utf8');
  const crashedTemporary = fs.readdirSync(f.directory).find((name) => name.includes('.required.tmp-'));
  for (const body of ['{}', JSON.stringify({ ...JSON.parse(markerBody), registryId: crypto.randomUUID() }), JSON.stringify({ ...JSON.parse(markerBody), ino: '0' })]) {
    fs.writeFileSync(`${f.databasePath}.required`, body);
    assert.throws(() => f.writer('hub'), code('REGISTRY_REPLACED'));
    assert.equal(fs.existsSync(path.join(f.directory, crashedTemporary)), true);
    assert.equal(fs.lstatSync(`${f.databasePath}.required`).nlink, 2);
  }
  fs.writeFileSync(`${f.databasePath}.required`, markerBody);
  const recoveryGate = path.join(f.directory, 'recovery-gate');
  const recovering = pythonPeer(t, f.databasePath, 'hub', { recoveryGate });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(`${recoveryGate}.ready`)) {
    assert.ok(Date.now() < deadline, 'Python dead-publisher recovery gate must become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const node = f.writer('hub');
  fs.writeFileSync(recoveryGate, 'continue');
  const recoveredPeer = await recovering;
  assert.equal(fs.lstatSync(`${f.databasePath}.required`).nlink, 1);
  assert.equal(bindClaim(node).claims[0].fence, 1);
  assert.equal(fs.readdirSync(f.directory).some((name) => name.includes('.required.tmp-')), false);
  await recoveredPeer.close();
  node.close();
  const untrustedLink = `${f.databasePath}.unknown-hardlink`;
  fs.linkSync(`${f.databasePath}.required`, untrustedLink);
  assert.throws(() => f.writer('hub'), code('REGISTRY_BUSY'));
  assert.equal(fs.existsSync(untrustedLink), true);
  fs.unlinkSync(untrustedLink);
  const peer = await pythonPeer(t, f.databasePath, 'hub');
  assert.equal((await peer.call('claim', [identity()])).result.claims[0].fence, 2);
  await peer.close();
});

test('native Node and Python processes contend for the same SQLite account and retain permanent module pin', async (t) => {
  const f = fixture(t); const node = f.writer('hub'); const python = await pythonPeer(t, f.databasePath);
  node.bind('node', identity(), 1); assert.ok((await python.call('bind', 'python', identity(), 1)).result.verified);
  const pythonClaim = python.call('claim', [identity()]);
  let nodeResult;
  try { nodeResult = { result: node.claim([identity()]) }; } catch (error) { nodeResult = { code: error.code }; }
  const pythonResult = await pythonClaim;
  assert.equal(Number(Boolean(nodeResult.result)) + Number(Boolean(pythonResult.result)), 1);
  assert.equal(nodeResult.code ?? pythonResult.code, 'ACCOUNT_PINNED');
  await python.close();
  if (pythonResult.result) assert.throws(() => node.claim([identity()]), code('ACCOUNT_PINNED'));
});

test('Node-to-Python takeover preserves fences, JSON semantic hashes, unknown ledger and isolation', async (t) => {
  const f = fixture(t); const node = f.writer('hub'); const ticket = bindClaim(node);
  const payload = { symbol: 'BTCUSDT', quantity: 0.1, nested: [1.0, 1e-7, -0, true, null, '恢复'], '\uE000': 'private-use', '😀': 'emoji' };
  const operation = node.prepare(ticket, 'cross-language', payload); node.finish(operation, 'unknown');
  const peer = await pythonPeer(t, f.databasePath, 'hub');
  assert.equal((await peer.call('claim', [identity()])).code, 'OWNER_ALIVE');
  assert.equal((await peer.call('account_key', identity('000918273645'))).result, ticket.claims[0].accountKey);
  node.close();
  const recovered = (await peer.call('claim', [identity()])).result;
  assert.equal(recovered.claims[0].fence, ticket.claims[0].fence + 1);
  const imported = await peer.call('import_unknown', recovered, 'cross-language', payload);
  assert.ok(imported.result, JSON.stringify(imported));
  assert.equal(imported.result.bodyHash, operation.bodyHash);
  assert.equal((await peer.call('prepare', recovered, 'fresh', payload)).code, 'ACCOUNT_UNRESOLVED');
  assert.equal((await peer.call('unresolved', recovered)).result[0].operationId, 'cross-language');
  await peer.call('resolve', 'cross-language', recovered, 'confirmed');
  const next = (await peer.call('prepare', recovered, 'fresh', payload)).result;
  assert.equal(next.bodyHash, operation.bodyHash);
  assert.equal((await peer.call('finish', next, 'confirmed')).result.state, 'confirmed');
  assert.equal((await peer.call('prepare', recovered, 'cross-language', payload)).code, 'ALREADY_SUBMITTED');
  await peer.call('freeze', [identity()]);
  assert.equal((await peer.call('assert_owned', recovered, 0)).code, 'ACCOUNT_ISOLATED');
  assert.doesNotMatch(JSON.stringify((await peer.call('snapshot')).result), /918273645|accountKey|cross-language/);
  await peer.close();
});

test('native dead-Python takeover increments fence but cannot resend the crashed sending operation', async (t) => {
  const f = fixture(t); const peer = await pythonPeer(t, f.databasePath, 'hub');
  await peer.call('bind', 'python', identity(), 1);
  const old = (await peer.call('claim', [identity()])).result;
  await peer.call('prepare', old, 'crashed-order', { clientId: 'original' });
  const node = f.writer('hub');
  assert.throws(() => node.claim([identity()]), code('OWNER_ALIVE'));
  await peer.kill();
  const recovered = node.claim([identity()]);
  assert.equal(recovered.claims[0].fence, old.claims[0].fence + 1);
  assert.throws(() => node.prepare(recovered, 'replacement-order', { clientId: 'replacement' }), code('ACCOUNT_UNRESOLVED'));
  assert.equal(node.unresolved(recovered)[0].operationId, 'crashed-order');
  node.resolve('crashed-order', recovered);
  assert.equal(node.prepare(recovered, 'replacement-order', { clientId: 'replacement' }).state, 'sending');
});

test('five-second heartbeat isolates one account while renewing unrelated account without changing full group safety', async (t) => {
  const f = fixture(t); let now = 1000;
  const writer = f.writer('hub', { now: () => now }); const ticket = bindClaim(writer, [identity('71'), identity('72')]);
  const standalone = writer.claim([identity('72')]);
  const other = f.writer('greeks', { now: () => now }); other.bind('conflict', identity('71'), 1); other.freeze([identity('71')]);
  now = 2000;
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const row = readRow(f.databasePath, 'SELECT lease_until,fence FROM aw_accounts WHERE account_key=?', accountKey(identity('72')));
  assert.equal(row.lease_until, 62000);
  assert.equal(row.fence, standalone.claims[0].fence);
  assert.equal(writer.assertOwned(standalone, 0), true);
  assert.throws(() => writer.assertOwned(ticket, 0), code('ACCOUNT_ISOLATED'));
  assert.equal(writer.retired, false);
});

test('Python registry contract and failure scenarios run under the normal Node test entrypoint', () => {
  const result = spawnSync(pythonCommand, [fileURLToPath(new URL('./test_account_writer.py', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 14 tests/);
});
