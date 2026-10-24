import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleIds } from '../server/modules/catalog.mjs';
import { startApi } from '../server/api/main.mjs';
import { startRuntime } from '../server/runtime/main.mjs';
import { tradingModules } from '../server/modules/updates.mjs';
import { dataPlaneOptions, fakeModules } from './fixtures/split-modules.mjs';
import { unavailableUpdateState } from '../server/updates.mjs';

// The runtime and the API as separate processes (design doc 3.1), over the
// fixture entries in tests/fixtures/split-*.mjs. POSIX only: the runtime lock
// helper and the module sockets are the Linux deployment's.
const password = 'split-process-test-password';
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const skip = process.platform === 'win32' ? 'POSIX process model only' : false;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (predicate, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 50)); } return false; };

async function dataDirectory(t) {
  const dataDir = await mkdtemp('/tmp/split-');
  mkdirSync(path.join(dataDir, 'modules'), { mode: 0o700 });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { WORKBENCH_RUNTIME_DIR: _ignored, ...inherited } = process.env;
  return { dataDir, env: { ...inherited, DATA_DIR: dataDir, INITIAL_PASSWORD: password, MODULE_SOCKET_DIR: path.join(dataDir, 'modules'), NODE_ENV: 'test' } };
}

// A child process with IPC; `next(type)` resolves with its next message of that type.
function spawnFixture(t, name, env) {
  const child = fork(fixture(name), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const messages = [], waiting = [];
  child.on('message', message => { const index = waiting.findIndex(entry => entry.type === message.type); if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else messages.push(message); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { child, exited, stderr: () => stderr,
    next(type, ms = 30_000) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ${type} message from ${name}: ${stderr}`)), ms);
        waiting.push({ type, resolve: message => { clearTimeout(timer); resolve(message); } });
        exited.then(result => { clearTimeout(timer); reject(new Error(`${name} exited (${JSON.stringify(result)}) before ${type}: ${stderr}`)); });
      });
    } };
}

// Browser-like requests against one API port; the session survives a new port.
function client(port, session = {}) {
  const host = `hub.localhost:${port}`;
  function request(route, { method = 'GET', body, host: target = host, headers = {}, auth = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
        headers: { Host: target, Origin: `http://${target}`, ...(auth && session.cookie ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } resolve({ status: res.statusCode, headers: res.headers, text, data }); });
      }); req.on('error', reject); req.end(encoded);
    });
  }
  return { session, request,
    async login() {
      const result = await request('/api/login', { method: 'POST', body: { password } }); assert.equal(result.status, 200, result.text);
      session.cookie = result.headers['set-cookie'][0].split(';')[0]; session.csrf = result.data.csrfToken;
    },
    async launch(id) {
      const result = await request(`/api/projects/${id}/launch`, { method: 'POST' }); assert.equal(result.status, 200, result.text);
      const url = new URL(result.data.url);
      const authorized = await request(url.pathname + url.search, { host: url.host, auth: false, headers: { Origin: `http://${host}` } });
      assert.equal(authorized.status, 302, authorized.text);
      return { host: url.host, cookie: authorized.headers['set-cookie'][0].split(';')[0] };
    } };
}

test('the launcher runs the runtime and the API as two processes; a crashed API restarts alone and keeps the sessions', { skip, timeout: 90_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const launcher = spawnFixture(t, 'split-launcher.mjs', env);
  const first = await launcher.next('api-ready');
  assert.ok(alive(first.runtimePid) && alive(first.apiPid)); assert.notEqual(first.runtimePid, first.apiPid);
  const c = client(first.port);
  assert.equal((await c.request('/api/health')).status, 200);
  assert.deepEqual((await c.request('/api/ready')).data, { ready: true });
  await c.login();
  assert.deepEqual((await c.request('/api/projects')).data.projects.map(project => project.id), moduleIds);
  // Forwarded to the data plane in the runtime process.
  assert.equal((await c.request('/api/trading')).status, 200);
  const modules = await c.request('/api/system/modules');
  assert.equal(modules.data.enabled, true); assert.deepEqual(modules.data.modules.map(row => row.moduleId), moduleIds);
  // Portal reaches a module whose transport only the runtime process knows.
  const monitor = await c.launch('monitor');
  const page = await c.request('/', { host: monitor.host, auth: false, headers: { Cookie: monitor.cookie } });
  assert.equal(page.status, 200, page.text); assert.deepEqual([page.data.module, page.data.pid], ['monitor', first.runtimePid]);

  process.kill(first.apiPid, 'SIGKILL');
  const second = await launcher.next('api-ready');
  assert.equal(second.runtimePid, first.runtimePid); assert.notEqual(second.apiPid, first.apiPid); assert.equal(alive(first.apiPid), false);
  const d = client(second.port, c.session);
  assert.equal((await d.request('/api/projects')).status, 200, 'sessions are stored in the database, not in the API process');
  assert.equal((await d.request('/api/trading')).status, 200);
  assert.equal((await d.request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await d.request('/api/trading')).status, 401);

  launcher.child.kill('SIGTERM');
  assert.deepEqual(await launcher.exited, { code: 0, signal: null }, launcher.stderr());
  assert.equal(alive(second.apiPid) || alive(second.runtimePid), false);
  assert.equal(existsSync(path.join(dataDir, 'run', 'runtime.json')), false, 'the runtime removed its discovery record');
});

test('a runtime that exits ends the API and the launcher with a non-zero code', { skip, timeout: 60_000 }, async t => {
  const { env } = await dataDirectory(t);
  const launcher = spawnFixture(t, 'split-launcher.mjs', env);
  const ready = await launcher.next('api-ready');
  process.kill(ready.runtimePid, 'SIGKILL');
  assert.deepEqual(await launcher.exited, { code: 1, signal: null });
  assert.equal(alive(ready.apiPid), false);
});

test('an API that outlives its runtime reports it unavailable, then reaches the next instance', { skip, timeout: 90_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  let runtime = spawnFixture(t, 'split-runtime.mjs', env);
  const { instanceId } = await runtime.next('ready');
  const api = await startApi({ dataDir, logger: quiet, env, port: 0, distDir: path.join(dataDir, 'dist'), updatesClient: { status: async () => unavailableUpdateState() } });
  t.after(() => api.close());
  const c = client(api.ready.port);
  await c.login();
  assert.equal((await c.request('/api/trading')).status, 200);

  runtime.child.kill('SIGKILL'); await runtime.exited;
  assert.equal((await c.request('/api/ready')).status, 503);
  const down = await c.request('/api/trading');
  assert.equal(down.status, 503); assert.equal(down.data.error, '运行时不可用');

  runtime = spawnFixture(t, 'split-runtime.mjs', env);
  const next = await runtime.next('ready');
  assert.notEqual(next.instanceId, instanceId);
  assert.ok(await until(async () => (await c.request('/api/ready')).status === 200), 'the API found the new instance');
  assert.equal((await c.request('/api/trading')).status, 200);
  // The new instance's trading modules were taken through the durable maintenance value without a status read.
  const crossex = await c.launch('crossex');
  const calls = async () => (await c.request('/maintenance-calls', { host: crossex.host, auth: false, headers: { Cookie: crossex.cookie } })).data?.calls;
  assert.ok(await until(async () => await calls() >= 1), 'maintenance synchronized after the instance change');
  runtime.child.kill('SIGTERM');
  assert.deepEqual(await runtime.exited, { code: 0, signal: null }, runtime.stderr());
});

test('a module the runtime restarted takes the durable maintenance value from the runtime itself', { skip, timeout: 60_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const modules = fakeModules(path.join(dataDir, 'modules'));
  let onModuleReady;
  const runtime = await startRuntime({ dataDir, logger: quiet, env, dataPlaneOptions, startModules: options => { onModuleReady = options.onModuleReady; return modules.startModules(options); } });
  t.after(() => runtime.close());
  // Modules of the first start are left to the API's initialization.
  assert.deepEqual(Object.values(modules.maintenanceCalls), [0, 0, 0, 0, 0]);
  for (const id of ['monitor', ...tradingModules]) onModuleReady({ id, generation: 2 });
  assert.ok(await until(() => tradingModules.every(id => modules.maintenanceCalls[id] === 1)));
  assert.equal(modules.maintenanceCalls.monitor, 0, 'only trading modules have a maintenance gate');
  await runtime.close();
  assert.equal(existsSync(path.join(dataDir, 'run', 'runtime.json')), false);
});

test('the API starts while a trading module refuses maintenance and keeps that module unconfirmed', { skip, timeout: 60_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const runtime = spawnFixture(t, 'split-runtime.mjs', { ...env, FAIL_MAINTENANCE: 'crossex' });
  await runtime.next('ready');
  const api = await startApi({ dataDir, logger: quiet, env, port: 0, distDir: path.join(dataDir, 'dist'), updatesClient: { status: async () => unavailableUpdateState() } });
  t.after(() => api.close());
  const c = client(api.ready.port);
  assert.deepEqual((await c.request('/api/ready')).data, { ready: true });
  await c.login();
  const rows = (await c.request('/api/system/modules')).data.modules;
  const confirmed = Object.fromEntries(rows.filter(row => tradingModules.includes(row.moduleId)).map(row => [row.moduleId, row.maintenanceConfirmed]));
  assert.deepEqual(confirmed, Object.fromEntries(tradingModules.map(id => [id, id !== 'crossex'])));
  runtime.child.kill('SIGTERM'); await runtime.exited;
});

test('an API started before the runtime refuses to create the database', { skip, timeout: 30_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  await assert.rejects(startApi({ dataDir, logger: { info() {}, debug() {}, warn() {}, error() {} }, env, port: 0 }), /请先启动运行时/);
  assert.equal(existsSync(path.join(dataDir, 'hub.sqlite')), false);
});

test('the runtime retries a restarted module that did not take maintenance until it confirms', { skip, timeout: 60_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const warnings = [];
  const logger = { info() {}, debug() {}, error() {}, warn: fields => { if (fields?.moduleId) warnings.push(fields); } };
  const modules = fakeModules(path.join(dataDir, 'modules'), { failMaintenance: { crossex: 2, aster: Infinity } });
  let onModuleReady;
  const runtime = await startRuntime({ dataDir, logger, env, dataPlaneOptions, syncRetryMs: Array(100).fill(20), startModules: options => { onModuleReady = options.onModuleReady; return modules.startModules(options); } });
  t.after(() => runtime.close());
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  const warned = (id, generation) => warnings.filter(row => row.moduleId === id && row.generation === generation).length;
  onModuleReady({ id: 'crossex', generation: 2 });
  assert.ok(await until(() => modules.maintenanceCalls.crossex === 3));
  await pause();
  assert.equal(modules.maintenanceCalls.crossex, 3, 'no retry after the module confirmed');
  // A new instance of the same module replaces the retries of the previous one.
  onModuleReady({ id: 'aster', generation: 2 });
  assert.ok(await until(() => warned('aster', 2) >= 2));
  onModuleReady({ id: 'aster', generation: 3 });
  assert.ok(await until(() => warned('aster', 3) >= 1));
  const previous = warned('aster', 2);
  await pause();
  assert.equal(warned('aster', 2), previous, 'the previous instance is no longer retried');
  assert.ok(warned('aster', 3) > 1);
  const before = warnings.length;
  await runtime.close();
  await pause();
  assert.equal(warnings.length, before, 'no retry after close');
});

test('a retry waits while another maintenance sync is running; a first sync after a restart queues instead', { skip, timeout: 60_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const warnings = [];
  const logger = { info() {}, debug() {}, error() {}, warn: fields => { if (fields?.moduleId) warnings.push(fields); } };
  const modules = fakeModules(path.join(dataDir, 'modules'), { failMaintenance: { aster: Infinity } });
  let onModuleReady;
  const runtime = await startRuntime({ dataDir, logger, env, dataPlaneOptions, syncRetryMs: Array(100).fill(20), startModules: options => { onModuleReady = options.onModuleReady; return modules.startModules(options); } });
  t.after(() => runtime.close());
  onModuleReady({ id: 'aster', generation: 2 });
  assert.ok(await until(() => warnings.length >= 1));
  // A sync that does not finish: aster's retries are skipped, neither sent nor logged.
  const release = modules.hold('crossex');
  onModuleReady({ id: 'crossex', generation: 2 });
  assert.ok(await until(() => modules.maintenanceCalls.crossex === 1));
  const calls = modules.maintenanceCalls.aster, logged = warnings.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([modules.maintenanceCalls.aster, warnings.length], [calls, logged]);
  release();
  assert.ok(await until(() => modules.maintenanceCalls.aster > calls), 'retries resume once the sync finished');
  await runtime.close();
});

test('the first sync of a restarted module waits behind a running one instead of being skipped', { skip, timeout: 60_000 }, async t => {
  const { dataDir, env } = await dataDirectory(t);
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const modules = fakeModules(path.join(dataDir, 'modules'));
  let onModuleReady;
  const runtime = await startRuntime({ dataDir, logger: quiet, env, dataPlaneOptions, syncRetryMs: [60_000], startModules: options => { onModuleReady = options.onModuleReady; return modules.startModules(options); } });
  t.after(() => runtime.close());
  const release = modules.hold('crossex');
  onModuleReady({ id: 'crossex', generation: 2 });
  assert.ok(await until(() => modules.maintenanceCalls.crossex === 1));
  onModuleReady({ id: 'aster', generation: 2 });
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  assert.ok(await until(() => modules.maintenanceCalls.aster === 1, 5000), 'sent right after the running sync, not one retry delay later');
  await runtime.close();
});
