import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createUpdateClient, unavailableUpdateState, UpdateError } from '../server/updates.mjs';

const PASSWORD = 'updates-http-fixture-password';
const PREFIX = '/api/system/updates';
const EXECUTION = '/api/trading/execution';
const planId = 'a'.repeat(64);
const stamp = '2026-10-09T12:00:00.000Z';
const state = () => ({ enabled: true, checking: false, checkedAt: stamp, checkError: null, planId, expiresAt: stamp,
  modules: [{ id: 'hub', name: '统一工作台', state: 'available', currentVersion: null, latestVersion: null, currentCommit: 'b'.repeat(40), latestCommit: 'a'.repeat(40) }], job: null });
const job = (status = 'running') => ({ id: 'update-job', status, startedAt: stamp, finishedAt: status === 'running' ? null : stamp, activeModule: null, steps: [], message: '更新状态' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { client, initialMaintenance = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-updates-http-'));
  const calls = [], jobs = [], handlers = {};
  let current = null, value = state();
  const updatesClient = client || Object.fromEntries(['status', 'check', 'apply'].map(method => [method, async (...args) => {
    calls.push({ method, args });
    if (handlers[method]) return handlers[method](...args);
    if (method === 'apply') value = { ...value, job: job() };
    return structuredClone(value);
  }]));
  const app = await createApp({ dataDir, initialPassword: PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, updatesClient, secureCookies: false, publicOrigin: '', logger: () => {} });
  if (initialMaintenance) {
    await app.close();
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('updates-maintenance', '1'); db.close();
  }
  const live = initialMaintenance ? await createApp({ dataDir, refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0,
    executionIntervalMs: 0, updatesClient, secureCookies: false, publicOrigin: '', logger: () => {} }) : app;
  const executionCalls = [];
  live.execution.state = () => ({ jobs: structuredClone(jobs) });
  for (const method of ['start', 'preview', 'connect', 'disconnect', 'stop', 'reconcile']) live.execution[method] = (...args) => {
    executionCalls.push({ method, args });
    if (handlers[`execution:${method}`]) return handlers[`execution:${method}`](...args);
    if (method === 'start') jobs.push({ id: randomUUID(), status: 'queued' });
    return { jobs: structuredClone(jobs) };
  };
  await new Promise(resolve => live.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${live.server.address().port}`;
  t.after(async () => {
    await live.close();
    const target = path.resolve(dataDir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('hub-updates-http-')); await rm(target, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, auth = true, originHeader = origin, csrfHeader = current?.csrf } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(auth && current ? { Cookie: current.cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}),
      ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const result = await request('/api/login', { method: 'POST', body: { password: PASSWORD }, auth: false });
    assert.equal(result.status, 200); current = { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.data.csrfToken };
  }
  function maintenance() {
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT value FROM settings WHERE key=?').get('updates-maintenance')?.value === '1'; } finally { db.close(); }
  }
  return { app: live, calls, jobs, handlers, executionCalls, request, login, origin, maintenance,
    get session() { return current; }, set state(next) { value = next; }, get state() { return value; } };
}

test('update HTTP routes require login, Origin and CSRF and accept only their fixed inputs', async t => {
  const f = await fixture(t);
  for (const [route, method] of [[PREFIX, 'GET'], [`${PREFIX}/check`, 'POST'], [`${PREFIX}/apply`, 'POST']]) {
    assert.equal((await f.request(route, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, 401);
  }
  await f.login();
  for (const action of ['check', 'apply']) {
    const body = action === 'check' ? {} : { planId };
    for (const override of [{ originHeader: '' }, { originHeader: 'https://other.example' }, { csrfHeader: '' }, { csrfHeader: 'wrong' }]) {
      assert.equal((await f.request(`${PREFIX}/${action}`, { method: 'POST', body, ...override })).status, 403);
    }
    for (const extra of [{ command: 'id' }, { socketPath: '/tmp/other' }, { url: 'http://remote' }, { modules: ['hub'] }]) {
      assert.equal((await f.request(`${PREFIX}/${action}`, { method: 'POST', body: { ...body, ...extra } })).status, 400);
    }
  }
  assert.equal((await f.request(`${PREFIX}?socketPath=other`)).status, 400);
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId: '../file' } })).status, 400);
  assert.equal((await f.request(`${PREFIX}/command`, { method: 'POST', body: {} })).status, 404);
  assert.equal(f.calls.length, 0);
  const status = await f.request(PREFIX); assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request(`${PREFIX}/check`, { method: 'POST', body: {} })).status, 202);
  assert.deepEqual(f.calls.map(row => row.method), ['status', 'check']);
});

test('concurrent identical applies share acceptance and atomically block live entry while stop/reconcile remain available', async t => {
  const f = await fixture(t); await f.login();
  const entered = deferred(), release = deferred();
  f.handlers.apply = async () => { entered.resolve(); await release.promise; f.state = { ...f.state, job: job() }; return f.state; };
  const first = f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } }); await entered.promise;
  const second = f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } });
  assert.equal(f.maintenance(), true);
  for (const [route, method] of [[`${EXECUTION}/jobs`, 'POST'], [`${EXECUTION}/preview`, 'POST'], [`${EXECUTION}/accounts/binance`, 'PUT'], [`${EXECUTION}/accounts/binance`, 'DELETE']]) {
    assert.equal((await f.request(route, { method, body: {} })).status, 409);
  }
  for (const action of ['stop', 'reconcile']) assert.equal((await f.request(`${EXECUTION}/jobs/${randomUUID()}/${action}`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId: 'b'.repeat(64) } })).status, 409);
  release.resolve(); assert.equal((await first).status, 202); assert.equal((await second).status, 202);
  assert.equal(f.calls.filter(row => row.method === 'apply').length, 1);
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 409);
  f.state = { ...f.state, job: job('succeeded') };
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 202);
  assert.equal(f.maintenance(), false);
});

test('live entry reserves the gate before awaiting root status, preventing a racing update', async t => {
  const f = await fixture(t); await f.login();
  const entered = deferred(), release = deferred();
  f.handlers.status = async () => { entered.resolve(); await release.promise; return f.state; };
  const start = f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} }); await entered.promise;
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 409);
  assert.equal(f.calls.filter(row => row.method === 'apply').length, 0);
  release.resolve(); assert.equal((await start).status, 202);
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 409);
});

test('all nonterminal or unknown live task states block updates', async t => {
  const f = await fixture(t); await f.login();
  for (const status of ['queued', 'running', 'stopping', 'paused', 'attention', 'unknown']) {
    f.jobs.splice(0, f.jobs.length, { id: randomUUID(), status });
    assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 409, status);
  }
  assert.equal(f.calls.length, 0);
  f.jobs.splice(0, f.jobs.length, { id: randomUUID(), status: 'completed' }, { id: randomUUID(), status: 'stopped' });
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 202);
});

test('root active state is recovered before the first live entry after a Hub restart', async t => {
  const f = await fixture(t); await f.login(); f.state = { ...f.state, job: job() };
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 409);
  assert.equal(f.maintenance(), true); assert.equal(f.executionCalls.length, 0);
});

test('a durable maintenance latch survives restart and unavailable status until completion is confirmed', async t => {
  const f = await fixture(t, { initialMaintenance: true }); await f.login();
  f.state = unavailableUpdateState();
  assert.equal((await f.request(PREFIX)).data.enabled, false);
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 409);
  f.state = { ...state(), job: job('interrupted') };
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 202);
  assert.equal(f.maintenance(), false);
});

test('a late pre-apply status response cannot clear the maintenance latch', async t => {
  const f = await fixture(t); await f.login();
  const entered = deferred(), release = deferred(), before = structuredClone(f.state);
  f.handlers.status = async () => { entered.resolve(); await release.promise; return before; };
  const reading = f.request(PREFIX); await entered.promise;
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 202);
  release.resolve(); assert.equal((await reading).status, 200); assert.equal(f.maintenance(), true);
});

test('a status read during apply cannot clear the latch if its idle response arrives after acceptance', async t => {
  const f = await fixture(t); await f.login();
  const accepting = deferred(), accept = deferred(), reading = deferred(), release = deferred(), before = structuredClone(f.state);
  f.handlers.apply = async () => { accepting.resolve(); await accept.promise; f.state = { ...f.state, job: job() }; return f.state; };
  f.handlers.status = async () => { reading.resolve(); await release.promise; return before; };
  const applying = f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } }); await accepting.promise;
  const status = f.request(PREFIX); await reading.promise;
  accept.resolve(); assert.equal((await applying).status, 202);
  release.resolve(); assert.equal((await status).status, 200); assert.equal(f.maintenance(), true);
});

test('uncertain update acceptance retains the gate and a definitive failed connection releases it', async t => {
  const f = await fixture(t); await f.login();
  f.handlers.apply = () => { throw new UpdateError(503, '更新服务暂不可用', { uncertain: false }); };
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 503); assert.equal(f.maintenance(), false);
  f.handlers.apply = () => { throw new UpdateError(503, '更新结果待确认', { uncertain: true }); };
  assert.equal((await f.request(`${PREFIX}/apply`, { method: 'POST', body: { planId } })).status, 503); assert.equal(f.maintenance(), true);
  f.state = unavailableUpdateState();
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 409);
});

test('an uninstalled helper does not prevent normal startup or existing live entry', async t => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\missing-updater-${randomUUID()}` : path.join(os.tmpdir(), `missing-updater-${randomUUID()}.sock`);
  const f = await fixture(t, { client: createUpdateClient({ socketPath: socket, timeoutMs: 100 }) }); await f.login();
  const status = await f.request(PREFIX); assert.equal(status.status, 200); assert.equal(status.data.enabled, false);
  assert.match(status.data.reason, /一键部署/);
  for (const action of ['check', 'apply']) assert.equal((await f.request(`${PREFIX}/${action}`, { method: 'POST', body: action === 'check' ? {} : { planId } })).status, 503);
  assert.equal((await f.request(`${EXECUTION}/jobs`, { method: 'POST', body: {} })).status, 202);
});

test('logout while an apply body is arriving revokes authorization before the privileged request', async t => {
  const f = await fixture(t); await f.login();
  let sender;
  const response = new Promise((resolve, reject) => {
    sender = http.request(f.origin + `${PREFIX}/apply`, { method: 'POST', headers: {
      Cookie: f.session.cookie, Origin: f.origin, 'X-CSRF-Token': f.session.csrf, 'Content-Type': 'application/json',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    sender.on('error', reject); sender.write('{"planId":');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  sender.end(JSON.stringify(planId) + '}');
  assert.equal(await response, 401); assert.equal(f.calls.length, 0); assert.equal(f.maintenance(), false);
});
