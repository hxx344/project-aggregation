import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/api/server.mjs';
import { openHubDatabase, seedProjects } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createProjectCatalog } from '../server/control/projects.mjs';
import { ensurePassword } from '../server/control/password.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { createInProcessClient } from '../server/runtime/supervisor-client.mjs';
import { createDataPlane } from '../server/runtime/data-plane.mjs';

const PASSWORD = 'test-password-not-a-real-secret';
const generatedAt = '2026-10-24T00:00:00.000Z';
const stamp = '2026-10-09T12:00:00.000Z';
const updateState = () => ({ enabled: true, checking: false, checkedAt: stamp, checkError: null, planId: 'a'.repeat(64), expiresAt: stamp,
  modules: [{ id: 'hub', name: '统一工作台', state: 'available', currentVersion: null, latestVersion: null, currentCommit: 'b'.repeat(40), latestCommit: 'a'.repeat(40) }], job: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// The API server against a scripted data plane: overview reads can be held
// open, and project change notices always fail.
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-api-server-'));
  const db = openHubDatabase(path.join(dataDir, 'hub.sqlite'));
  const control = createControlStore(db);
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn: (fields, message) => warnings.push({ fields, message }) };
  await ensurePassword(control, { initialPassword: PASSWORD, log }); seedProjects(control, { embeddedModules: false });
  const encrypt = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const decrypt = value => value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  const readMaintenance = () => control.getSetting('updates-maintenance') === '1';
  let gate = null; const reads = [];
  const runtime = {
    async overview() { const read = deferred(); reads.push(read); await gate?.promise; return { projects: [], generatedAt }; },
    subscribeOverview: () => () => {},
    async projectChanged() { throw new Error('data plane unreachable'); },
    async coordinateAssetSync() { return null; },
    async forward() { return { status: 200, body: {} }; },
    async observeSlowConsumer() { return { accepted: true }; },
  };
  const updatesClient = Object.fromEntries(['status', 'check', 'apply', 'token'].map(method => [method, async () => updateState()]));
  const api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }), encrypt, decrypt, embeddedModules: false, log,
    supervisor: createInProcessClient(createRuntimeService({ moduleRuntime: null, guard: null, readMaintenance })), runtime,
    executionJobs: { state: () => ({ jobs: [] }) }, readMaintenance, updatesClient, secureCookies: false, configuredOrigin: '', distDir: path.join(dataDir, 'dist') });
  await api.initialize();
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.server.address().port}`;
  let closed = false;
  t.after(async () => { if (!closed) await api.close(); await api.closeServer(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const request = (route, { method = 'GET', body } = {}) => fetch(origin + route, { method,
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { api, origin, cookie, warnings, request,
    // Holds the next overview reads until release(); resolves once a read has started.
    hold() { gate = deferred(); const started = reads.length; return { started: (async () => { while (reads.length === started) await new Promise(resolve => setImmediate(resolve)); })(), release: () => gate.resolve() }; },
    async close() { closed = true; await api.close(); } };
}

const subscribe = (f, signal) => fetch(f.origin + '/api/overview/events', { headers: { Cookie: f.cookie }, signal });

test('a subscriber that disconnects while its first overview is read is never registered', async t => {
  const f = await fixture(t);
  const responses = []; f.api.server.on('request', (req, res) => { if (req.url === '/api/overview/events') responses.push(res); });
  const held = f.hold(), controller = new AbortController();
  const pending = subscribe(f, controller.signal).catch(error => error);
  await held.started; controller.abort(); await pending;
  if (!responses[0].destroyed) await once(responses[0], 'close');
  held.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.streamCount(), 0);
});

test('a subscription whose first overview read outlasts shutdown or logout is refused before it opens', async t => {
  const f = await fixture(t);
  let held = f.hold(); let pending = subscribe(f);
  await held.started; const logout = await f.request('/api/logout', { method: 'POST' }); assert.equal(logout.status, 200);
  held.release(); let res = await pending;
  assert.equal(res.status, 401); assert.equal((await res.json()).error, '登录已失效，请重新登录'); assert.equal(f.api.streamCount(), 0);

  const g = await fixture(t);
  held = g.hold(); pending = subscribe(g);
  await held.started; const closing = g.close();
  held.release(); res = await pending; await closing;
  assert.equal(res.status, 503); assert.equal((await res.json()).error, '工作台正在关闭'); assert.equal(g.api.streamCount(), 0);
});

test('project writes succeed and log the reason when the data plane cannot be notified', async t => {
  const f = await fixture(t);
  const updated = await f.request('/api/projects/crossex', { method: 'PUT', body: { password: 'changed-test-password' } });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).project.hasCredentials, true);
  const deleted = await f.request('/api/projects/crossex', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await f.request('/api/projects/crossex', { method: 'DELETE' })).status, 404);
  assert.deepEqual(f.warnings.filter(entry => entry.message === '项目变更未能通知运行时').map(entry => [entry.fields.projectId, entry.fields.reason, entry.fields.err.message]),
    [['crossex', 'updated', 'data plane unreachable'], ['crossex', 'deleted', 'data plane unreachable']]);
});

test('the data plane refuses to start without a source for the open stream count', () => {
  assert.throws(() => createDataPlane({}), { name: 'TypeError', message: 'Data plane needs readConnections()' });
});
