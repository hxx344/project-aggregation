import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleIds } from '../server/modules/catalog.mjs';
import { registerModuleTransport } from '../server/modules/transport.mjs';
import { UpdateError, createUpdateCoordinator } from '../server/updates.mjs';
import { createSecret, ensureRuntimeDir, MAX_REQUEST_BYTES, PROTOCOL_VERSION, readDiscovery, removeDiscovery, removeStaleRuntimeFiles, RUNTIME_KEY_HEADER, RuntimeError, runtimeDir, socketPathFor, validateSync, writeDiscovery } from '../server/runtime/protocol.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { createInternalHandler, startInternalServer } from '../server/runtime/internal-server.mjs';
import { coordinatorHooks, createInProcessClient, createSocketClient } from '../server/runtime/supervisor-client.mjs';

const windows = process.platform === 'win32';
const row = (moduleId, state = 'ready', extra = {}) => ({ moduleId, state, generation: 2, restartCount: 1, consecutiveFailures: 0, lastExitAt: null, lastExitKind: null,
  readyAt: '2026-10-24T00:00:00.000Z', nextAttemptAt: null, waitingFor: null, faultReason: state === 'fault' ? 'failures' : null, ...extra });

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
// A runtime with a scripted module supervisor and maintenance guard.
function runtime({ instanceId } = {}) {
  const state = { maintenance: false, states: Object.fromEntries(moduleIds.map(id => [id, 'ready'])), failing: [], syncCalls: [], restarts: [], prepare: async () => {}, automation: async () => {}, rows: null };
  const moduleRuntime = {
    status: () => state.rows ?? moduleIds.map(id => row(id, state.states[id])),
    restart: id => { state.restarts.push(id); return state.states[id] === 'fault'; },
  };
  const guard = {
    async setMaintenance(active, ids) {
      state.syncCalls.push({ active, ids });
      const failed = ids.filter(id => state.failing.includes(id));
      if (failed.length) throw Object.assign(new Error('unconfirmed'), { failed });
    },
    prepareApply: () => state.prepare(),
  };
  const service = createRuntimeService({ instanceId, moduleRuntime, guard, readMaintenance: () => state.maintenance, prepareAutomation: () => state.automation() });
  return { state, service };
}
const implementations = {
  'in-process': async (_t, service) => createInProcessClient(service),
  socket: async (t, service) => {
    const dir = await directory(t);
    const server = await startInternalServer({ service, dir, logger: { error() {} } });
    t.after(() => server.close());
    return createSocketClient({ dir });
  },
};

for (const [name, connect] of Object.entries(implementations)) {
  test(`${name}: status reports identity, protocol, faults and contract fields only`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    state.states.greeks = 'fault';
    state.rows = moduleIds.map(id => ({ ...row(id, state.states[id]), pid: 4242, socketPath: '/secret' }));
    const status = await client.status();
    assert.equal(status.instanceId, service.instanceId); assert.equal(status.protocol, PROTOCOL_VERSION);
    assert.equal(status.ready, true); assert.equal(status.modulesEnabled, true); assert.deepEqual(status.degraded, ['greeks']);
    assert.deepEqual(status.modules.map(item => item.moduleId), moduleIds);
    assert.equal(status.modules[0].pid, undefined); assert.equal(status.modules[0].socketPath, undefined);
    assert.deepEqual(status.modules.find(item => item.moduleId === 'greeks'), row('greeks', 'fault'));
    status.modules[0].state = 'mutated';
    assert.equal((await client.status()).modules[0].state, 'ready');
  });

  test(`${name}: invalid runtime output is reported as unavailable`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    for (const rows of [[row('monitor', 'exploded')], [row('unknown')], [row('monitor'), row('monitor')], [row('monitor', 'ready', { generation: -1 })], [row('monitor', 'backoff', { waitingFor: ['nobody'] })]]) {
      state.rows = rows;
      await assert.rejects(client.status(), error => error instanceof RuntimeError && error.status === 503 && error.origin === 'transport', JSON.stringify(rows));
    }
  });

  test(`${name}: module transport resolves the registered instance and fails closed otherwise`, async t => {
    const { service } = runtime();
    const client = await connect(t, service);
    const secret = createSecret();
    const remove = registerModuleTransport('crossex', { socketPath: '/run/crossex.sock', secret }, { instanceId: 'crossex-1', generation: 900 + Math.floor(Math.random() * 1e6) });
    t.after(remove);
    const transport = await client.resolveTransport('crossex');
    assert.equal(transport.moduleId, 'crossex'); assert.equal(transport.secret, secret); assert.equal(transport.instanceId, 'crossex-1');
    await assert.rejects(client.resolveTransport('nobody'), error => error.status === 404 && error.origin === 'runtime');
    remove();
    await assert.rejects(client.resolveTransport('crossex'), error => error.status === 503 && error.message === '模块暂不可用' && error.origin === 'runtime');
  });

  test(`${name}: maintenance sync applies the durable flag and confirms each module`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    state.maintenance = true; state.failing = ['greeks'];
    assert.deepEqual(await client.syncMaintenance(['crossex', 'greeks']), { active: true, modules: [{ id: 'crossex', confirmed: true, generation: 2 }, { id: 'greeks', confirmed: false, generation: 2 }] });
    assert.deepEqual(state.syncCalls, [{ active: true, ids: ['crossex', 'greeks'] }]);
    for (const ids of [[], ['monitor'], ['crossex', 'crossex'], 'crossex', null]) {
      await assert.rejects(client.syncMaintenance(ids), error => error.status === 400, JSON.stringify(ids));
    }
    assert.equal(state.syncCalls.length, 1);
  });

  test(`${name}: prepare-stop passes the guard's refusal through and hides unexpected failures`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    assert.deepEqual(await client.prepareStop(), { ready: true });
    state.prepare = async () => { throw new UpdateError(409, 'Aster 5x 尚未满足安全停机条件，暂不能更新'); };
    await assert.rejects(client.prepareStop(), error => error.status === 409 && error.message === 'Aster 5x 尚未满足安全停机条件，暂不能更新' && error.origin === 'runtime');
    // A module reason may be long or multi-line; both implementations return the same bounded single-line text.
    const prefix = 'Aster 5x 尚未满足安全停机条件，暂不能更新：';
    const reason = `${prefix}${'保证金不足'.repeat(90)}\n第二行`;
    state.prepare = async () => { throw new UpdateError(409, reason); };
    await assert.rejects(client.prepareStop(), error => error.status === 409 && error.origin === 'runtime' && error.message === reason.slice(0, 400));
    // The 400th character is whitespace: one pass and two passes (server, then client) give the same text.
    const spaced = `${'a'.repeat(399)}\n${'b'.repeat(10)}`;
    state.prepare = async () => { throw new UpdateError(409, spaced); };
    await assert.rejects(client.prepareStop(), error => error.status === 409 && error.message === 'a'.repeat(399));
    state.prepare = async () => { throw new TypeError('socket /private/path failed'); };
    await assert.rejects(client.prepareStop(), error => error.status === 503 && !error.message.includes('/private'));
    // The data plane's LP signer refuses beside the modules, with the same mapping.
    state.prepare = async () => {};
    state.automation = async () => { throw new UpdateError(409, 'LP 调仓正在执行链上交易，尚未满足安全停机条件，请稍后重试'); };
    await assert.rejects(client.prepareStop(), error => error.status === 409 && error.message.startsWith('LP 调仓正在执行链上交易'));
    state.automation = async () => { throw new TypeError('ipc /private/path failed'); };
    await assert.rejects(client.prepareStop(), error => error.status === 503 && error.message === '无法确认 LP 调仓的停机条件，暂不能更新');
  });

  test(`${name}: operator restart accepts only a faulted known module`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    await assert.rejects(client.restartModule('greeks'), error => error.status === 409 && error.origin === 'runtime');
    state.states.greeks = 'fault';
    assert.deepEqual(await client.restartModule('greeks'), { accepted: true, moduleId: 'greeks' });
    await assert.rejects(client.restartModule('constructor'), error => error.status === 404);
    assert.deepEqual(state.restarts, ['greeks', 'greeks']);
  });

  test(`${name}: coordinator hooks fail closed when the applied flag differs or a module is unconfirmed`, async t => {
    const { state, service } = runtime();
    const hooks = coordinatorHooks(await connect(t, service));
    state.maintenance = true;
    await hooks.setModuleMaintenance(true, ['crossex', 'aster']);
    await assert.rejects(hooks.setModuleMaintenance(false, ['crossex', 'aster']), error => error instanceof UpdateError && error.status === 503 && error.failed.join() === 'crossex,aster');
    state.failing = ['aster'];
    await assert.rejects(hooks.setModuleMaintenance(true, ['crossex', 'aster']), error => error.failed.join() === 'aster');
    state.prepare = async () => { throw new UpdateError(503, '无法确认 Greeks 的委托状态，请稍后重试'); };
    await assert.rejects(hooks.prepareApply(), error => error instanceof UpdateError && error.status === 503 && error.message === '无法确认 Greeks 的委托状态，请稍后重试' && !error.uncertain);
  });

  test(`${name}: maintenance syncs name the module generation they started with, also when a module fails`, async t => {
    const { state, service } = runtime();
    const client = await connect(t, service);
    state.rows = moduleIds.map(id => row(id, 'ready', { generation: id === 'aster' ? 7 : 3 }));
    assert.deepEqual((await client.syncMaintenance(['crossex', 'aster'])).modules, [{ id: 'crossex', confirmed: true, generation: 3 }, { id: 'aster', confirmed: true, generation: 7 }]);
    const hooks = coordinatorHooks(client);
    assert.deepEqual(await hooks.setModuleMaintenance(false, ['crossex', 'aster']), { generations: { crossex: 3, aster: 7 } });
    state.failing = ['aster'];
    await assert.rejects(hooks.setModuleMaintenance(false, ['crossex', 'aster']), error => error.failed.join() === 'aster' && error.generations.crossex === 3);
  });
}

test('a sync reply without generations reads as unknown, and an invalid generation is refused', () => {
  const reply = generation => ({ active: false, modules: [{ id: 'crossex', confirmed: true, ...(generation === undefined ? {} : { generation }) }] });
  assert.deepEqual(validateSync(reply(undefined), ['crossex']).modules, [{ id: 'crossex', confirmed: true, generation: null }]);
  assert.equal(validateSync(reply(null), ['crossex']).modules[0].generation, null);
  for (const invalid of [-1, 1.5, '2', {}]) assert.throws(() => validateSync(reply(invalid), ['crossex']), error => error instanceof RuntimeError, String(invalid));
});

test('the coordinator takes a trading module whose generation changed through maintenance again', async t => {
  const { state, service } = runtime();
  const hooks = coordinatorHooks(createInProcessClient(service));
  const coordinator = createUpdateCoordinator({ client: {}, execution: { state: () => ({ jobs: [] }), openEntries: () => 0, transaction: fn => fn() },
    setModuleMaintenance: hooks.setModuleMaintenance, tradingModules: ['crossex', 'greeks', 'aster'], moduleIds, releasePollMs: 0 });
  t.after(() => coordinator.close());
  const rows = generation => moduleIds.map(id => row(id, 'ready', { generation: id === 'greeks' ? generation : 2 }));
  state.rows = rows(2);
  await coordinator.initialize();
  assert.equal(state.syncCalls.length, 1);
  coordinator.observeModules(rows(2));
  assert.equal(state.syncCalls.length, 1, 'the instance that acknowledged is still running');
  // Greeks restarted in maintenance and its acknowledgement fails at first.
  state.rows = rows(3); state.failing = ['greeks'];
  coordinator.observeModules(state.rows);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.syncCalls.at(-1).ids, ['greeks'], 'only the restarted module is synchronized');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(coordinator.moduleMaintenance().greeks.confirmed, false);
  assert.equal(coordinator.moduleMaintenance().crossex.confirmed, true);
  // An unknown generation (the failed sync) is not compared until a sync succeeds.
  const calls = state.syncCalls.length;
  coordinator.observeModules(state.rows);
  assert.equal(state.syncCalls.length, calls);
  state.failing = [];
  await coordinator.resynchronize('greeks');
  assert.equal(coordinator.moduleMaintenance().greeks.confirmed, true);
  coordinator.observeModules(state.rows);
  assert.equal(state.syncCalls.length, calls + 1);
});

test('a runtime without modules reports them disabled and refuses module operations', async () => {
  const client = createInProcessClient(createRuntimeService({ readMaintenance: () => false }));
  assert.deepEqual((await client.status()).modules, []);
  assert.equal((await client.status()).modulesEnabled, false);
  await assert.rejects(client.restartModule('greeks'), error => error.status === 404 && error.message === '模块不存在');
  await assert.rejects(client.syncMaintenance(['greeks']), error => error.status === 404);
  await assert.rejects(client.prepareStop(), error => error.status === 404);
});

test('socket server publishes a private discovery record and withdraws it with the socket', { skip: windows }, async t => {
  const dir = await directory(t);
  const { service } = runtime();
  const server = await startInternalServer({ service, dir, release: 'a5f451b', logger: { error() {} } });
  const file = path.join(dir, 'runtime.json');
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(server.socketPath).mode & 0o077, 0);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['instanceId', 'pid', 'protocol', 'release', 'schemaVersion', 'secret', 'socketPath', 'startedAt']);
  assert.equal(record.instanceId, service.instanceId); assert.equal(record.pid, process.pid); assert.equal(record.socketPath, socketPathFor(dir, service.instanceId));
  assert.deepEqual(readDiscovery(dir), record);
  await server.close();
  assert.equal(existsSync(file), false); assert.equal(existsSync(server.socketPath), false);
});

test('internal requests without the key are refused before any route runs', { skip: windows }, async t => {
  const dir = await directory(t);
  const { state, service } = runtime();
  const server = await startInternalServer({ service, dir, logger: { error() {} } });
  t.after(() => server.close());
  const call = headers => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: server.socketPath, method: 'POST', path: '/internal/v1/modules/greeks/restart', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  state.states.greeks = 'fault';
  assert.equal(await call({}), 401);
  assert.equal(await call({ [RUNTIME_KEY_HEADER]: 'x'.repeat(43) }), 401);
  assert.deepEqual(state.restarts, []);
  assert.equal(await call({ [RUNTIME_KEY_HEADER]: readDiscovery(dir).secret }), 200);
});

test('discovery files that are linked, shared, oversized or point elsewhere are rejected', { skip: windows }, async t => {
  const dir = await directory(t);
  const instanceId = randomUUID();
  const record = { schemaVersion: 1, protocol: 1, instanceId, pid: process.pid, socketPath: socketPathFor(dir, instanceId), secret: createSecret(), startedAt: new Date().toISOString(), release: null };
  assert.equal(readDiscovery(dir), null);
  writeDiscovery(dir, record);
  assert.deepEqual(readDiscovery(dir), record);
  const file = path.join(dir, 'runtime.json');
  chmodSync(file, 0o640); assert.throws(() => readDiscovery(dir)); chmodSync(file, 0o600);
  assert.throws(() => writeDiscovery(dir, { ...record, socketPath: '/tmp/elsewhere.sock' }));
  writeFileSync(file, JSON.stringify({ ...record, socketPath: '/tmp/elsewhere.sock' }), { mode: 0o600 }); assert.throws(() => readDiscovery(dir));
  // Valid fields padded with JSON whitespace: only the size limit rejects it.
  writeFileSync(file, JSON.stringify(record) + ' '.repeat(5000), { mode: 0o600 }); assert.throws(() => readDiscovery(dir), /discovery file/);
  writeFileSync(file, JSON.stringify(record) + ' '.repeat(100), { mode: 0o600 }); assert.deepEqual(readDiscovery(dir), record);
  if (!windows) {
    // A FIFO must be rejected without blocking on open.
    await rm(file); execFileSync('mkfifo', ['-m', '600', file]); assert.throws(() => readDiscovery(dir), /discovery file/); await rm(file); writeDiscovery(dir, record);
  }
  const other = await directory(t);
  writeDiscovery(other, { ...record, socketPath: socketPathFor(other, instanceId) });
  await rm(file); symlinkSync(path.join(other, 'runtime.json'), file); assert.throws(() => readDiscovery(dir));
  await rm(file); writeDiscovery(dir, record);
  removeDiscovery(dir, randomUUID()); assert.deepEqual(readDiscovery(dir), record, 'a stopping instance keeps its successor\'s record');
  removeDiscovery(dir, instanceId); assert.equal(readDiscovery(dir), null);
  assert.throws(() => socketPathFor(path.join(dir, 'x'.repeat(80)), instanceId), /超过 100 字节/);
  // deploy/install.sh (check_runtime_dir) accepts a DATA_DIR of at most 46 bytes; the bound below is that of the runtime directory.
  assert.ok(socketPathFor(runtimeDir('/' + 'x'.repeat(45), {}), instanceId));
  assert.throws(() => socketPathFor(runtimeDir('/' + 'x'.repeat(46), {}), instanceId), /超过 100 字节/);
  assert.ok(socketPathFor(runtimeDir('/data', { WORKBENCH_RUNTIME_DIR: '/' + 'x'.repeat(49) }), instanceId));
  assert.throws(() => socketPathFor(runtimeDir('/data', { WORKBENCH_RUNTIME_DIR: '/' + 'x'.repeat(50) }), instanceId), /超过 100 字节/);
});

test('socket client refuses an instance whose identity or protocol does not match the discovery record', { skip: windows }, async t => {
  const dir = await directory(t);
  const { state, service } = runtime();
  state.states.greeks = 'fault';
  const claimed = randomUUID(), secret = createSecret(), socketPath = socketPathFor(dir, claimed);
  // The socket named for `claimed` is served by a different instance.
  const server = http.createServer(createInternalHandler({ service, secret }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const record = { schemaVersion: 1, protocol: 1, instanceId: claimed, pid: process.pid, socketPath, secret, startedAt: new Date().toISOString(), release: null };
  writeDiscovery(dir, record);
  // A non-status call proves the identity check runs while resolving, before any operation is sent.
  await assert.rejects(createSocketClient({ dir }).restartModule('greeks'), error => error.status === 503 && error.origin === 'transport');
  await assert.rejects(createSocketClient({ dir }).status(), error => error.status === 503 && error.origin === 'transport');
  writeDiscovery(dir, { ...record, instanceId: service.instanceId, socketPath: socketPathFor(dir, service.instanceId) });
  await assert.rejects(createSocketClient({ dir }).status(), error => error.origin === 'transport', 'the derived socket does not exist');
  assert.deepEqual(state.restarts, [], 'no operation reached an unverified instance');
});

test('socket client refuses a runtime whose protocol it does not support', { skip: windows }, async t => {
  const dir = await directory(t);
  const { service } = runtime();
  const server = await startInternalServer({ service, dir, logger: { error() {} } });
  t.after(() => server.close());
  assert.equal((await createSocketClient({ dir }).status()).instanceId, service.instanceId);
  // Same live instance and key; only the advertised protocol differs.
  writeDiscovery(dir, { ...readDiscovery(dir), protocol: 2 });
  await assert.rejects(createSocketClient({ dir }).status(), error => error.origin === 'transport');
  await assert.rejects(createSocketClient({ dir, protocols: [2] }).status(), error => error.origin === 'transport');
});

test('socket client re-resolves a replaced runtime for reads but never retries writes', { skip: windows }, async t => {
  const dir = await directory(t);
  const first = runtime(), second = runtime(), changes = [];
  const a = await startInternalServer({ service: first.service, dir, logger: { error() {} } });
  const client = createSocketClient({ dir, onInstanceChange: (next, previous) => changes.push([next, previous]) });
  assert.equal((await client.status()).instanceId, first.service.instanceId);
  await a.close();
  const b = await startInternalServer({ service: second.service, dir, logger: { error() {} } });
  t.after(() => b.close());
  assert.equal((await client.status()).instanceId, second.service.instanceId, 'one read retries after re-resolving');
  assert.deepEqual(changes, [[second.service.instanceId, first.service.instanceId]]);
  await b.close();
  const c = runtime(), server = await startInternalServer({ service: c.service, dir, logger: { error() {} } });
  t.after(() => server.close());
  await assert.rejects(client.syncMaintenance(['crossex']), error => error.origin === 'transport' && !error.uncertain);
  assert.deepEqual(c.state.syncCalls, [], 'the failed write was not sent to the replacement');
  assert.deepEqual(await client.syncMaintenance(['crossex']), { active: false, modules: [{ id: 'crossex', confirmed: true, generation: 2 }] });
  assert.equal(c.state.syncCalls.length, 1);
});

test('socket client bounds a write by its wall-clock budget and reports it as uncertain', { skip: windows }, async t => {
  const dir = await directory(t);
  const { state, service } = runtime();
  const server = await startInternalServer({ service, dir, logger: { error() {} } });
  t.after(() => server.close());
  state.prepare = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(createSocketClient({ dir, budgets: { prepareStop: 200 } }).prepareStop(), error => error.origin === 'transport' && error.uncertain);
  assert.ok(Date.now() - started < 2000);
});

// A scripted runtime on a real socket: `/status` confirms the identity, other routes follow `handle`.
async function scripted(t, handle, { status = true } = {}) {
  const dir = await directory(t), instanceId = randomUUID(), secret = createSecret(), socketPath = socketPathFor(dir, instanceId), hits = [];
  const body = JSON.stringify({ schemaVersion: 1, protocol: 1, instanceId, ready: true, degraded: [], modulesEnabled: true, modules: [] });
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('/status')) { if (status) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); } return; }
    handle(req, res);
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  writeDiscovery(dir, { schemaVersion: 1, protocol: 1, instanceId, pid: process.pid, socketPath, secret, startedAt: new Date().toISOString(), release: null });
  return { dir, hits };
}
const transportBody = JSON.stringify({ moduleId: 'crossex', socketPath: '/run/crossex.sock', secret: createSecret(), instanceId: null, generation: 1 });

test('socket client caps the response size of a result that is otherwise valid', { skip: windows }, async t => {
  for (const [padding, accepted] of [[1024, true], [5 * 1024 * 1024, false]]) {
    const { dir } = await scripted(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(transportBody + ' '.repeat(padding)); });
    const result = createSocketClient({ dir }).resolveTransport('crossex');
    if (accepted) assert.equal((await result).moduleId, 'crossex');
    else await assert.rejects(result, error => error.origin === 'transport');
  }
});

test('socket client retries a failed read once and its budget also covers resolving', { skip: windows }, async t => {
  const broken = await scripted(t, req => req.socket.destroy());
  await assert.rejects(createSocketClient({ dir: broken.dir }).resolveTransport('crossex'), error => error.origin === 'transport');
  assert.equal(broken.hits.filter(url => url.endsWith('/transport')).length, 2, 'one attempt plus one retry');
  const silent = await scripted(t, () => {}, { status: false });
  const started = Date.now();
  await assert.rejects(createSocketClient({ dir: silent.dir, budgets: { read: 200 } }).status(), error => error.origin === 'transport');
  assert.ok(Date.now() - started < 2000);
});

test('a rejected key drops the cached record and the read succeeds against the restarted server', { skip: windows }, async t => {
  const dir = await directory(t);
  const { service } = runtime();
  const first = await startInternalServer({ service, dir, logger: { error() {} } });
  const client = createSocketClient({ dir });
  await client.status();
  // Same instance id and socket path, new key: the cached key is now refused.
  await first.close();
  const second = await startInternalServer({ service, dir, logger: { error() {} } });
  t.after(() => second.close());
  // The retry reached the new server: its own answer (no transport registered), not a transport failure.
  const retried = await client.resolveTransport('crossex').catch(error => error);
  assert.equal(retried.status, 503); assert.equal(retried.origin, 'runtime');
  assert.equal((await client.status()).instanceId, service.instanceId);
});

test('internal request bodies are bounded', { skip: windows }, async t => {
  const dir = await directory(t);
  const { state, service } = runtime();
  const server = await startInternalServer({ service, dir, logger: { error() {} } });
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: server.socketPath, method: 'POST', path: '/internal/v1/maintenance/sync', headers: { [RUNTIME_KEY_HEADER]: readDiscovery(dir).secret, 'Content-Type': 'application/json' } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ modules: ['crossex'], padding: 'x'.repeat(MAX_REQUEST_BYTES) }));
  });
  assert.equal(status, 400); assert.deepEqual(state.syncCalls, []);
});

test('the runtime directory must be private, owned and not a link', { skip: windows }, async t => {
  const base = await directory(t);
  const created = ensureRuntimeDir(path.join(base, 'run'));
  assert.equal(statSync(created).mode & 0o777, 0o700);
  const open = path.join(base, 'open'); mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
  assert.throws(() => ensureRuntimeDir(open), /0700/); assert.equal(statSync(open).mode & 0o777, 0o755, 'refused, not changed');
  assert.throws(() => readDiscovery(open), /0700/);
  const link = path.join(base, 'link'); symlinkSync(created, link);
  assert.throws(() => ensureRuntimeDir(link), /普通目录/); assert.throws(() => readDiscovery(link), /普通目录/);
  assert.equal(readDiscovery(path.join(base, 'missing')), null);
});

test('maintenance syncs run one at a time and each reads the durable flag when it starts', async () => {
  const events = [];
  let flag = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const guard = { async setMaintenance(active) { events.push(`start:${active}`); if (!active) await held; events.push(`done:${active}`); }, prepareApply: async () => {} };
  const service = createRuntimeService({ guard, readMaintenance: () => flag });
  const first = service.syncMaintenance(['crossex']);
  await new Promise(resolve => setImmediate(resolve));
  flag = true;
  const second = service.syncMaintenance(['crossex']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:false'], 'the later sync waits even though its caller is not blocked');
  release();
  assert.equal((await first).active, false); assert.equal((await second).active, true);
  assert.deepEqual(events, ['start:false', 'done:false', 'start:true', 'done:true']);
});

test('an ifIdle maintenance sync is skipped while another one is queued or running', async () => {
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const guard = { async setMaintenance() { calls += 1; await held; }, prepareApply: async () => {} };
  const service = createRuntimeService({ guard, readMaintenance: () => false });
  const running = service.syncMaintenance(['crossex']);
  assert.equal(await service.syncMaintenance(['aster'], { ifIdle: true }), null);
  // Also while a second call is queued behind the running one.
  const queued = service.syncMaintenance(['greeks']);
  assert.equal(await service.syncMaintenance(['aster'], { ifIdle: true }), null);
  release(); await running; await queued;
  assert.deepEqual(await service.syncMaintenance(['aster'], { ifIdle: true }), { active: false, modules: [{ id: 'aster', confirmed: true, generation: null }] });
  assert.equal(calls, 3);
});

test('a maintenance sync whose durable read failed does not keep later ifIdle calls skipped', async () => {
  let fail = true;
  const guard = { setMaintenance: async () => {}, prepareApply: async () => {} };
  const service = createRuntimeService({ guard, readMaintenance: () => { if (fail) { fail = false; throw new Error('database closed'); } return false; } });
  await assert.rejects(service.syncMaintenance(['crossex']), /database closed/);
  assert.deepEqual(await service.syncMaintenance(['crossex'], { ifIdle: true }), { active: false, modules: [{ id: 'crossex', confirmed: true, generation: null }] });
});

test('socket client reports a write whose 200 reply fails validation as uncertain', { skip: windows }, async t => {
  const { dir } = await scripted(t, (req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); });
  const client = createSocketClient({ dir });
  for (const call of [() => client.syncMaintenance(['crossex']), () => client.prepareStop(), () => client.restartModule('crossex')]) {
    await assert.rejects(call(), error => error instanceof RuntimeError && error.origin === 'transport' && error.uncertain);
  }
});

test('the coordinator hooks and the in-process client log the causes they hide', async () => {
  const warnings = [], errors = [];
  const failing = { syncMaintenance: async () => { throw new Error('sync cause'); }, prepareStop: async () => { throw new Error('stop cause'); } };
  const hooks = coordinatorHooks(failing, { log: { warn: (fields, message) => warnings.push([message, fields.err.message]) } });
  await assert.rejects(hooks.setModuleMaintenance(true, ['crossex']), error => error instanceof UpdateError && error.status === 503);
  await assert.rejects(hooks.prepareApply(), error => error instanceof UpdateError && error.message === '运行时不可用，暂不能更新');
  assert.deepEqual(warnings, [['维护同步未获运行时确认', 'sync cause'], ['停机准入未获运行时确认', 'stop cause']]);
  const service = { ...createRuntimeService({ readMaintenance: () => false }), status: () => { throw new Error('status cause'); } };
  await assert.rejects(createInProcessClient(service, { log: { error: (fields, message) => errors.push([message, fields.err.message]) } }).status(), error => error.status === 503 && error.message === '运行时内部错误');
  assert.deepEqual(errors, [['运行时调用失败', 'status cause']]);
});

test('a starting runtime removes leftover temp records and other instances\' sockets, and nothing else', { skip: windows }, async t => {
  const dir = await directory(t), self = randomUUID(), other = randomUUID();
  const names = ['.runtime.json.0a1b.tmp', `runtime-${other}.sock`, `runtime-${self}.sock`, 'runtime.json', '.runtime.lock', 'notes.tmp'];
  for (const name of names) writeFileSync(path.join(dir, name), '');
  removeStaleRuntimeFiles(dir, self);
  assert.deepEqual(names.filter(name => existsSync(path.join(dir, name))), [`runtime-${self}.sock`, 'runtime.json', '.runtime.lock', 'notes.tmp']);
});
