import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModules } from '../server/modules/runtime.mjs';
import { moduleOrigin, moduleTransport, registerModuleTransport } from '../server/modules/transport.mjs';
import { moduleIds } from '../server/modules/catalog.mjs';
import { moduleCapabilities } from '../server/modules/capabilities.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixtureSource = `
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export async function createModule({ root, dataDir, environment, transports }) {
  const id = path.basename(root);
  const started = { id, pid: process.pid, startedAt: Date.now(), dependencies: Object.keys(transports), maintenance: environment.WORKSPACE_MAINTENANCE, writerDb: environment.WORKSPACE_WRITER_DB, runtimeId: environment.WORKSPACE_RUNTIME_ID, writerModule: environment.WORKSPACE_WRITER_MODULE };
  await writeFile(path.join(dataDir, 'started.json'), JSON.stringify(started));
  if (environment.FIXTURE_START === 'fail') throw new Error('fixture startup failure');
  if (environment.FIXTURE_START === 'hang') await new Promise(() => {});
  if (environment.FIXTURE_START === 'orphan') {
    // Stands in for a Python bridge that ignores both stdin EOF and SIGTERM.
    const orphan = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    orphan.unref();
    await writeFile(path.join(dataDir, 'orphan.pid'), String(orphan.pid));
  }
  let closing;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Fixture-Handler', 'reached');
    res.end(JSON.stringify({ id, pid: process.pid, address: server.address(), maintenance: environment.WORKSPACE_MAINTENANCE,
      tcpListeners: process._getActiveHandles().filter(handle => handle instanceof net.Server && handle.listening && typeof handle.address() !== 'string').length }));
    if (req.url === '/crash') setTimeout(() => process.exit(27), 20);
  });
  // The worker owns the listen call; record the real path before it reports ready.
  server.once('listening', () => writeFileSync(path.join(dataDir, 'started.json'), JSON.stringify({ ...started, socketPath: server.address() })));
  return { server, updateDependency(name, transport) { appendFileSync(path.join(dataDir, 'dependencies.jsonl'), JSON.stringify({ name, socketPath: transport?.socketPath ?? null }) + '\\n'); }, writerProtectionVersion: environment.FIXTURE_START === 'unguarded' ? null : 1, recoveryProtectionVersion: environment.FIXTURE_START === 'legacy-recovery' ? null : 1, close() {
    return closing ??= (async () => {
      await delay(Number(environment.FIXTURE_CLOSE_DELAY_MS || 0));
      if (server.listening) await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
      await writeFile(path.join(dataDir, 'closed'), 'closed');
    })();
  } };
}
`;

async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function request(transport, pathname = '/', secret = transport.secret, method = 'GET') {
  return new Promise((accept, reject) => {
    const pending = http.request({ socketPath: transport.socketPath, path: pathname, method, headers: { 'x-workspace-key': secret } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    pending.setTimeout(2000, () => pending.destroy(new Error('Fixture request timed out')));
    pending.once('error', reject); pending.end();
  });
}
const registered = id => moduleTransport(moduleOrigin(id));
const assertUnavailable = () => { for (const id of moduleIds) assert.throws(() => registered(id), /unavailable/); };
const exists = file => readFile(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const generation = id => { try { return registered(id).generation; } catch { return 0; } };
async function until(predicate, label, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`${label} was not reached within ${milliseconds} ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const hasProcess = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function transportDirectory(record) {
  if (process.platform !== 'win32') return path.dirname(record.socketPath);
  const prefix = '\\\\.\\pipe\\workbench-';
  assert.ok(record.socketPath.startsWith(prefix));
  return path.join(tmpdir(), record.socketPath.slice(prefix.length).replace(new RegExp(`-${record.id}-\\d+$`), ''));
}
async function removeFixture(directory) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('embedded-runtime-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
}

async function fixture(t, { modes = {}, closeDelay = 0, omitRoot } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'embedded-runtime-'));
  const root = path.join(directory, 'root'), dataDir = path.join(directory, 'data'), logs = [];
  await mkdir(path.join(root, 'server/modules'), { recursive: true });
  for (const file of ['worker.mjs', 'capabilities.mjs', 'transport.mjs']) await copyFile(path.join(repository, 'server/modules', file), path.join(root, 'server/modules', file));
  for (const id of moduleIds) {
    if (id !== omitRoot) await mkdir(path.join(root, 'modules', id), { recursive: true });
    await writeFile(path.join(root, 'server/modules', `${id}.mjs`), fixtureSource);
    const moduleData = path.join(dataDir, 'modules', id);
    await mkdir(moduleData, { recursive: true });
    await writeFile(path.join(moduleData, '.env'), `FIXTURE_START=${modes[id] || 'ok'}\nFIXTURE_CLOSE_DELAY_MS=${closeDelay}\nWORKSPACE_MAINTENANCE=0\nWORKSPACE_WRITER_DB=untrusted.sqlite\nWORKSPACE_RUNTIME_ID=untrusted\nWORKSPACE_WRITER_MODULE=untrusted.py\n`);
  }
  const record = async id => JSON.parse(await readFile(path.join(dataDir, 'modules', id, 'started.json'), 'utf8'));
  const records = async () => {
    const result = [];
    for (const id of moduleIds) if (await exists(path.join(dataDir, 'modules', id, 'started.json'))) result.push(await record(id));
    return result;
  };
  let runtime;
  t.after(async () => {
    try { await bounded(runtime?.close() ?? Promise.resolve(), 5000, 'fixture close'); }
    finally {
      // Only processes created by these temporary modules are eligible for cleanup.
      for (const row of await records()) if (hasProcess(row.pid)) process.kill(row.pid, 'SIGKILL');
      for (const id of moduleIds) {
        const orphan = await readFile(path.join(dataDir, 'modules', id, 'orphan.pid'), 'utf8').catch(() => null);
        if (orphan && hasProcess(Number(orphan))) process.kill(Number(orphan), 'SIGKILL');
      }
      await removeFixture(directory);
    }
  });
  return { directory, root, dataDir, record, records, logs,
    closed: id => exists(path.join(dataDir, 'modules', id, 'closed')),
    mode: (id, value) => writeFile(path.join(dataDir, 'modules', id, '.env'), `FIXTURE_START=${value}\nFIXTURE_CLOSE_DELAY_MS=${closeDelay}\n`),
    state: id => runtime.status().find(row => row.moduleId === id),
    async start(options = {}) { runtime = await startModules({ root, dataDir, timeoutMs: 2000, logger: { info: value => logs.push(value), warn: value => logs.push(value) }, ...options }); return runtime; },
  };
}

test('supervisor readies all real workers on authenticated private pipes and closes every owned process', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const runtime = await bounded(f.start(), 8000, 'startup');
  const rows = [];
  for (const id of moduleIds) {
    const transport = registered(id), response = await request(transport);
    assert.equal(response.status, 200);
    const value = JSON.parse(response.body); rows.push(await f.record(id));
    assert.equal(value.id, id); assert.equal(value.address, transport.socketPath);
    assert.equal(value.tcpListeners, 0); assert.equal(value.maintenance, '1');
    const rejected = await request(transport, '/', 'wrong-key');
    assert.equal(rejected.status, 403); assert.equal(rejected.headers['x-fixture-handler'], undefined);
    const capabilities = await request(transport, '/__workspace/capabilities');
    assert.equal(capabilities.status, 200);
    assert.deepEqual(JSON.parse(capabilities.body), moduleCapabilities(id));
    assert.equal(capabilities.headers['x-fixture-handler'], undefined, 'capabilities never reaches module business handlers');
    assert.equal((await request(transport, '/__workspace/capabilities', 'wrong-key')).status, 403);
    assert.equal((await request(transport, '/__workspace/capabilities?extra=1')).status, 400);
    assert.equal((await request(transport, '/__workspace/capabilities', transport.secret, 'POST')).status, 405);
  }
  for (const row of rows) {
    assert.equal(row.writerDb, path.join(f.dataDir, 'execution-control.sqlite'));
    assert.match(row.runtimeId, /^[a-f0-9-]{36}$/);
    assert.equal(row.writerModule, path.join(f.root, 'server', 'execution', 'account_writer.py'));
  }
  assert.equal(new Set(rows.map(row => row.pid)).size, moduleIds.length);
  for (const row of rows) {
    assert.equal(registered(row.id).generation, 1);
    assert.match(registered(row.id).instanceId, /^[a-f0-9-]{36}$/);
    assert.ok(row.socketPath.endsWith(`${row.id}-1${process.platform === 'win32' ? '' : '.sock'}`));
    // Only CrossEx declares a dependency; nobody receives its own or a peer's credentials otherwise.
    assert.deepEqual(row.dependencies, row.id === 'crossex' ? ['monitor'] : []);
  }
  await bounded(runtime.close(), 5000, 'shutdown');
  assertUnavailable();
  for (const row of rows) { assert.equal(hasProcess(row.pid), false); assert.equal(await f.closed(row.id), true); }
  await assert.rejects(readdir(transportDirectory(rows[0])), { code: 'ENOENT' });
});

test('concurrent close callers all await graceful shutdown and transport cleanup', { timeout: 15000 }, async t => {
  const f = await fixture(t, { closeDelay: 200 }), runtime = await f.start();
  const records = await f.records();
  const first = runtime.close(), second = runtime.close();
  assert.equal(first, second, 'close must expose the same in-flight cleanup promise');
  await bounded(second, 5000, 'second shutdown caller');
  for (const row of records) { assert.equal(hasProcess(row.pid), false); assert.equal(await f.closed(row.id), true); }
  assertUnavailable();
});

test('a ready worker crash restarts only that worker under a new generation after backoff', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let offset = 0;
  const readies = [];
  const runtime = await f.start({ restartPolicy: { delaysMs: [100, 200], stableMs: 60_000 }, random: () => 0.5, now: () => Date.now() + offset,
    onModuleReady: event => readies.push(event), onFailure: error => assert.fail(error) });
  const before = await f.records(), old = await f.record('asset');
  assert.equal((await request(registered('asset'), '/crash')).status, 200);
  await until(() => generation('asset') === 2, 'asset generation 2');
  const next = await f.record('asset');
  assert.notEqual(next.pid, old.pid); assert.notEqual(next.socketPath, old.socketPath);
  assert.equal(hasProcess(old.pid), false); assert.equal(next.maintenance, '1');
  assert.equal(JSON.parse((await request(registered('asset'))).body).pid, next.pid);
  for (const row of before.filter(row => row.id !== 'asset')) {
    assert.equal((await f.record(row.id)).pid, row.pid); assert.equal(hasProcess(row.pid), true);
    assert.equal(generation(row.id), 1); assert.equal(await f.closed(row.id), false);
  }
  assert.deepEqual(readies, [{ id: 'asset', generation: 2 }]);
  let asset = f.state('asset');
  assert.deepEqual(Object.keys(asset).sort(), ['consecutiveFailures', 'generation', 'lastExitAt', 'lastExitKind', 'moduleId', 'nextAttemptAt', 'readyAt', 'restartCount', 'state'], 'status never exposes pids, paths or secrets');
  assert.equal(asset.state, 'ready'); assert.equal(asset.restartCount, 1); assert.equal(asset.consecutiveFailures, 1); assert.equal(asset.lastExitKind, 'exit');
  // An instance that stayed ready past stableMs does not count its exit as a failure.
  offset += 60_000;
  assert.equal((await request(registered('asset'), '/crash')).status, 200);
  await until(() => generation('asset') === 3, 'asset generation 3');
  asset = f.state('asset');
  assert.equal(asset.restartCount, 2); assert.equal(asset.consecutiveFailures, 0);
  assert.deepEqual(f.logs.filter(entry => entry?.event === 'backoff').map(entry => entry.delayMs), [110, 110]);
  assert.equal(runtime.restart('asset'), false, 'operator restart is only for fault');
  assert.throws(() => runtime.restart('unknown'), /Unknown embedded module/);
});

test('a ready worker that exits before the whole group is ready still fails startup and drains its peers', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { asset: 'hang' } });
  let failed;
  const failure = new Promise(accept => { failed = accept; });
  const rejected = assert.rejects(f.start({ onFailure: failed }), /interrupted|exited|startup/);
  // started.json may be read mid-write while asset is still starting.
  await until(async () => (await f.records().catch(() => [])).length === 2, 'asset startup');
  assert.equal((await request(registered('monitor'), '/crash')).status, 200);
  assert.match((await bounded(failure, 5000, 'worker failure callback')).message, /monitor stopped \(27\)/);
  await rejected;
  for (const row of await f.records()) assert.equal(hasProcess(row.pid), false);
  assertUnavailable();
});

test('module initialization failure closes already-ready peers and removes their pipe directory', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { asset: 'fail' } });
  await assert.rejects(bounded(f.start(), 5000, 'failed startup'), /asset:|asset exited/);
  const rows = await f.records();
  assert.deepEqual(rows.map(row => row.id), ['monitor', 'asset']);
  assert.equal(await f.closed('monitor'), true);
  for (const row of rows) assert.equal(hasProcess(row.pid), false);
  assertUnavailable();
  await assert.rejects(readdir(transportDirectory(rows[0])), { code: 'ENOENT' });
});

test('a trading worker cannot become ready without its real protection handshake', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { crossex: 'unguarded' } });
  await assert.rejects(bounded(f.start(), 5000, 'guard handshake'), /crossex:|crossex exited/);
  assertUnavailable();
  for (const row of await f.records()) assert.equal(hasProcess(row.pid), false);
});

test('a trading worker cannot advertise recovery protection using an older executor', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { crossex: 'legacy-recovery' } });
  await assert.rejects(bounded(f.start(), 5000, 'recovery handshake'), /crossex:|crossex exited/);
  assertUnavailable();
  for (const row of await f.records()) assert.equal(hasProcess(row.pid), false);
});

test('parent can drain real workers during startup before a complete runtime is returned', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { asset: 'hang' } });
  let startup;
  const starting = f.start({ onStarting: handle => { startup = handle; } });
  const rejected = assert.rejects(starting, /startup|exited|interrupted/);
  const deadline = Date.now() + 3000;
  while ((await f.records()).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.records()).length, 2);
  await startup.close(); await rejected;
  for (const row of await f.records()) assert.equal(hasProcess(row.pid), false);
  assertUnavailable();
});

test('spawn failure without a PID rejects promptly and still cleans up a ready peer', { timeout: 15000 }, async t => {
  const f = await fixture(t, { omitRoot: 'asset' });
  await assert.rejects(bounded(f.start(), 5000, 'spawn failure'), /ENOENT|IPC|closed/i);
  const rows = await f.records();
  assert.deepEqual(rows.map(row => row.id), ['monitor']);
  assert.equal(await f.closed('monitor'), true); assert.equal(hasProcess(rows[0].pid), false);
  assertUnavailable();
  await assert.rejects(readdir(transportDirectory(rows[0])), { code: 'ENOENT' });
});

test('a factory that never becomes ready times out without leaving a child or private transport', { timeout: 15000 }, async t => {
  const f = await fixture(t, { modes: { asset: 'hang' } });
  await assert.rejects(bounded(f.start({ timeoutMs: 500 }), 5000, 'startup timeout'), /asset startup timed out/);
  const rows = await f.records();
  assert.deepEqual(rows.map(row => row.id), ['monitor', 'asset']);
  for (const row of rows) assert.equal(hasProcess(row.pid), false);
  assertUnavailable();
  await assert.rejects(readdir(transportDirectory(rows[0])), { code: 'ENOENT' });
});

test('a larger generation replaces a module transport and the old remover cannot evict it', t => {
  const id = 'greeks', secret = 'g'.repeat(32);
  const legacy = registerModuleTransport(id, { socketPath: 'legacy.sock', secret });
  t.after(() => legacy());
  assert.throws(() => registerModuleTransport(id, { socketPath: 'again.sock', secret }), /already registered/);
  const first = registerModuleTransport(id, { socketPath: 'one.sock', secret }, { instanceId: 'a', generation: 1 });
  t.after(() => first());
  assert.equal(registered(id).socketPath, 'one.sock');
  assert.throws(() => registerModuleTransport(id, { socketPath: 'same.sock', secret }, { generation: 1 }), /already registered/);
  assert.throws(() => registerModuleTransport(id, { socketPath: 'older.sock', secret }, { generation: 0 }), /already registered/);
  assert.throws(() => registerModuleTransport(id, { socketPath: 'bad.sock', secret }, { generation: 1.5 }), /Invalid module generation/);
  const second = registerModuleTransport(id, { socketPath: 'two.sock', secret }, { instanceId: 'b', generation: 2 });
  first(); legacy();
  assert.equal(registered(id).socketPath, 'two.sock', 'a stale instance cleanup leaves its successor registered');
  second();
  assert.throws(() => registered(id), /unavailable/);
});

test('CrossEx follows a restarted Monitor without restarting and no other worker receives a transport', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.start({ restartPolicy: { delaysMs: [50] }, onFailure: error => assert.fail(error) });
  const crossex = await f.record('crossex');
  assert.equal((await request(registered('monitor'), '/crash')).status, 200);
  await until(() => generation('monitor') === 2, 'monitor generation 2');
  const file = path.join(f.dataDir, 'modules', 'crossex', 'dependencies.jsonl');
  const updates = async () => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await updates()).length === 2, 'CrossEx dependency updates');
  assert.deepEqual(await updates(), [{ name: 'monitor', socketPath: null }, { name: 'monitor', socketPath: registered('monitor').socketPath }]);
  assert.equal((await f.record('crossex')).pid, crossex.pid); assert.equal(generation('crossex'), 1);
  for (const id of moduleIds) assert.equal(await exists(path.join(f.dataDir, 'modules', id, 'dependencies.jsonl')), id === 'crossex');
});

test('repeated failures fault a module, its dependent waits without counting, and an operator restart resumes both', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const runtime = await f.start({ restartPolicy: { delaysMs: [50, 100, 200], maxFailures: 3 }, random: () => 0, onFailure: error => assert.fail(error) });
  await f.mode('monitor', 'fail');
  assert.equal((await request(registered('monitor'), '/crash')).status, 200);
  await until(() => f.state('monitor').state === 'fault', 'monitor fault');
  let monitor = f.state('monitor');
  assert.equal(monitor.generation, 3); assert.equal(monitor.consecutiveFailures, 3); assert.equal(monitor.lastExitKind, 'startup');
  assert.deepEqual(f.logs.filter(entry => entry?.event === 'backoff').map(entry => entry.delayMs), [50, 100]);
  assert.equal(f.logs.find(entry => entry?.event === 'fault').reason, 'failures');
  assert.throws(() => registered('monitor'), /unavailable/);
  // CrossEx is due for restart but must not start, or count failures, without Monitor.
  assert.equal((await request(registered('crossex'), '/crash')).status, 200);
  await until(() => f.state('crossex').state === 'backoff', 'crossex backoff');
  await new Promise(resolve => setTimeout(resolve, 400));
  let crossex = f.state('crossex');
  assert.equal(crossex.state, 'backoff'); assert.equal(crossex.generation, 1); assert.equal(crossex.restartCount, 0); assert.equal(crossex.consecutiveFailures, 1);
  assert.equal(runtime.restart('crossex'), false);
  await f.mode('monitor', 'ok');
  assert.equal(runtime.restart('monitor'), true);
  assert.equal(runtime.restart('monitor'), false, 'a second request while recovering is rejected');
  await until(() => f.state('crossex').state === 'ready', 'crossex ready after Monitor');
  monitor = f.state('monitor'); crossex = f.state('crossex');
  assert.equal(monitor.state, 'ready'); assert.equal(monitor.generation, 4); assert.equal(monitor.consecutiveFailures, 0);
  assert.equal(crossex.generation, 2); assert.equal(crossex.consecutiveFailures, 1);
  assert.ok((await f.record('crossex')).startedAt >= (await f.record('monitor')).startedAt);
  assert.deepEqual((await f.record('crossex')).dependencies, ['monitor']);
});

test('a successor starts only after a lingering process from the old group is gone', { timeout: 15000, skip: process.platform === 'win32' ? 'Windows children are tracked by reported pids' : false }, async t => {
  const f = await fixture(t, { modes: { asset: 'orphan' } });
  await f.start({ restartPolicy: { delaysMs: [10] }, drainTimeoutMs: () => 400, onFailure: error => assert.fail(error) });
  await f.mode('asset', 'ok');
  const orphan = Number(await readFile(path.join(f.dataDir, 'modules', 'asset', 'orphan.pid'), 'utf8'));
  assert.equal(hasProcess(orphan), true);
  const crashedAt = Date.now();
  assert.equal((await request(registered('asset'), '/crash')).status, 200);
  await until(() => generation('asset') === 2, 'asset generation 2');
  assert.equal(hasProcess(orphan), false, 'the old group was killed after the drain budget');
  const drained = f.logs.find(entry => entry?.event === 'drained' && entry.moduleId === 'asset');
  assert.equal(drained.drained, true); assert.ok(drained.drainMs >= 400);
  assert.ok((await f.record('asset')).startedAt >= crashedAt + 400);
});

test('close cancels a pending restart while a module waits in backoff', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const runtime = await f.start({ restartPolicy: { delaysMs: [10_000] }, onFailure: error => assert.fail(error) });
  const rows = await f.records();
  assert.equal((await request(registered('asset'), '/crash')).status, 200);
  await until(() => f.state('asset').state === 'backoff', 'asset backoff');
  await bounded(runtime.close(), 3000, 'close during backoff');
  assert.equal(f.state('asset').generation, 1); assert.equal(f.state('asset').state, 'stopped');
  for (const row of rows) assert.equal(hasProcess(row.pid), false);
  assertUnavailable();
});
