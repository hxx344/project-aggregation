import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApiServer, supervisorTransports } from '../server/api/server.mjs';
import { openHubDatabase, seedProjects } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createProjectCatalog } from '../server/control/projects.mjs';
import { ensurePassword } from '../server/control/password.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { createInProcessClient } from '../server/runtime/supervisor-client.mjs';
import { createDataPlane } from '../server/runtime/data-plane.mjs';
import { createExecutionJobsReader } from '../server/control/execution-jobs.mjs';

const PASSWORD = 'test-password-not-a-real-secret';
const generatedAt = '2026-10-24T00:00:00.000Z';
const stamp = '2026-10-09T12:00:00.000Z';
const updateState = () => ({ enabled: true, checking: false, checkedAt: stamp, checkError: null, planId: 'a'.repeat(64), expiresAt: stamp,
  modules: [{ id: 'hub', name: '统一工作台', state: 'available', currentVersion: null, latestVersion: null, currentCommit: 'b'.repeat(40), latestCommit: 'a'.repeat(40) }], job: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// The API server against a scripted data plane: overview reads can be held
// open, overview events are pushed by the test, and project change notices
// follow `projectChanged` (by default they always fail).
async function fixture(t, { projectChanged = async () => { throw new Error('data plane unreachable'); }, ...options } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-api-server-'));
  const db = openHubDatabase(path.join(dataDir, 'hub.sqlite'));
  const control = createControlStore(db);
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn: (fields, message) => warnings.push({ fields, message }) };
  await ensurePassword(control, { initialPassword: PASSWORD, log }); seedProjects(control, { embeddedModules: false });
  const encrypt = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const decrypt = value => value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  const readMaintenance = () => control.getSetting('updates-maintenance') === '1';
  let gate = null, subscriber = null, current = { projects: [], generatedAt }; const reads = [], notices = [];
  const runtime = {
    async overview() { const value = current, read = deferred(); reads.push(read); await gate?.promise; return value; },
    subscribeOverview: value => { subscriber = value; return () => { subscriber = null; }; },
    async projectChanged(id, change) { notices.push([id, change.reason]); return projectChanged(id, change); },
    async coordinateAssetSync() { return null; },
    async forward() { return { status: 200, body: {} }; },
    async observeSlowConsumer() { return { accepted: true }; },
  };
  const updatesClient = Object.fromEntries(['status', 'check', 'apply', 'token'].map(method => [method, async () => updateState()]));
  const api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }), encrypt, decrypt, embeddedModules: false, log,
    supervisor: createInProcessClient(createRuntimeService({ moduleRuntime: null, guard: null, readMaintenance })), runtime,
    executionJobs: { state: () => ({ jobs: [] }) }, readMaintenance, updatesClient, secureCookies: false, configuredOrigin: '', distDir: path.join(dataDir, 'dist'), noticeRetryMs: [5, 5], ...options });
  await api.initialize();
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.server.address().port}`;
  let closed = false;
  t.after(async () => { if (!closed) await api.close(); await api.closeServer(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const request = (route, { method = 'GET', body } = {}) => fetch(origin + route, { method,
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { api, control, origin, cookie, warnings, notices, request,
    set overview(value) { current = value; },
    push(overview) { current = overview; subscriber.deliver({ revision: 1, overview }); },
    // Holds the next overview reads until release(); resolves once a read has started. A held read returns what was current when it started.
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

const settle = async (predicate, ms = 2000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); };
const failures = f => f.warnings.filter(entry => entry.message === '项目变更未能通知运行时');

test('project writes succeed, retry the change notice and log the reason once it is given up', async t => {
  const f = await fixture(t);
  const updated = await f.request('/api/projects/crossex', { method: 'PUT', body: { password: 'changed-test-password' } });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).project.hasCredentials, true);
  const deleted = await f.request('/api/projects/crossex', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await f.request('/api/projects/crossex', { method: 'DELETE' })).status, 404);
  await settle(() => failures(f).length === 2);
  assert.deepEqual(failures(f).map(entry => [entry.fields.projectId, entry.fields.reason, entry.fields.attempts, entry.fields.err.message]),
    [['crossex', 'updated', 3, 'data plane unreachable'], ['crossex', 'deleted', 3, 'data plane unreachable']]);
  assert.equal(f.notices.length, 6, 'each notice was sent once and retried twice');
});

test('a change notice that succeeds on retry is not reported', async t => {
  let calls = 0;
  const f = await fixture(t, { projectChanged: async () => { if (++calls === 1) throw new Error('busy'); return { accepted: true }; } });
  assert.equal((await f.request('/api/projects/crossex', { method: 'PUT', body: { password: 'changed-test-password' } })).status, 200);
  await settle(() => calls === 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 2); assert.equal(failures(f).length, 0);
});

test('change notices still waiting for a retry are dropped when the API closes', async t => {
  const f = await fixture(t, { noticeRetryMs: [100, 100] });
  assert.equal((await f.request('/api/projects/crossex', { method: 'PUT', body: { password: 'changed-test-password' } })).status, 200);
  await f.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.notices.length, 1); assert.equal(failures(f).length, 0);
});

// Reads SSE frames from a protocol 2 stream.
async function frames(f, t) {
  const controller = new AbortController(); t.after(() => controller.abort());
  const res = await fetch(f.origin + '/api/overview/events?protocol=2', { headers: { Cookie: f.cookie }, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader(); let buffered = '';
  return async () => {
    while (!buffered.includes('\n\n')) { const { value, done } = await reader.read(); if (done) return null; buffered += new TextDecoder().decode(value); }
    const end = buffered.indexOf('\n\n'); const entry = buffered.slice(0, end); buffered = buffered.slice(end + 2);
    return JSON.parse(entry.split('\n').find(line => line.startsWith('data: ')).slice(6));
  };
}
const project = (id, state = 'online') => ({ project: { id }, state, message: '', metrics: [] });

test('streams get the API heartbeat while the runtime is quiet, and every project turns stale once it has been silent too long', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { overviewHeartbeatMs: 40, runtimeStaleMs: 300 });
  f.overview = { projects: [project('asset')], generatedAt };
  const next = await frames(f, t);
  assert.equal((await next()).type, 'snapshot');
  assert.equal((await next()).type, 'heartbeat', 'the cached projection again, so nothing changed');
  let frame; do frame = await next(); while (frame.type === 'heartbeat');
  assert.equal(frame.type, 'patch');
  assert.deepEqual(frame.projects.map(item => [item.project.id, item.state, item.message]), [['asset', 'stale', '运行时不可用']]);
  // A push from the runtime replaces the stale view at once.
  f.push({ projects: [project('asset')], generatedAt });
  do frame = await next(); while (frame.type === 'heartbeat');
  assert.deepEqual(frame.projects.map(item => [item.project.id, item.state]), [['asset', 'online']]);
});

test('a read that a push overtook does not bring its older projection back', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { overviewHeartbeatMs: 40 });
  f.overview = { projects: [project('asset')], generatedAt };
  const next = await frames(f, t);
  assert.equal((await next()).type, 'snapshot');
  const held = f.hold(), read = f.request('/api/overview');
  await held.started;
  f.push({ projects: [project('asset', 'offline')], generatedAt });
  let frame; do frame = await next(); while (frame.type === 'heartbeat');
  assert.deepEqual(frame.projects.map(item => item.state), ['offline']);
  held.release();
  assert.deepEqual((await (await read).json()).projects.map(item => item.state), ['online']);
  // The heartbeat repeats the pushed projection, so nothing changes.
  assert.equal((await next()).type, 'heartbeat');
});

test('the API heartbeat ends streams whose session is gone without any runtime push', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { overviewHeartbeatMs: 40 });
  const next = await frames(f, t);
  assert.equal((await next()).type, 'snapshot');
  // Sessions removed behind the API's back: only its heartbeat notices.
  f.control.sessions.clear();
  let frame; do frame = await next(); while (frame !== null);
  assert.equal(f.api.streamCount(), 0);
});

test('the data plane refuses to start without a source for the open stream count', () => {
  assert.throws(() => createDataPlane({}), { name: 'TypeError', message: 'Data plane needs readConnections()' });
});

test('the split API asks the supervisor for module transports and keeps moduleTransport()\'s checks', async () => {
  const asked = [], transport = { moduleId: 'monitor', socketPath: '/run/monitor.sock', secret: 's'.repeat(43), instanceId: null, generation: 1 };
  const resolve = supervisorTransports({ resolveTransport: async id => { asked.push(id); return transport; } });
  assert.equal(await resolve(new URL('http://127.0.0.1:3000/api')), null);
  assert.equal(await resolve(new URL('http://monitor.workspace.internal/')), transport);
  for (const value of ['http://user@monitor.workspace.internal/', 'http://monitor.workspace.internal:8080/', 'https://monitor.workspace.internal/', 'http://other.workspace.internal/', 'http://constructor.workspace.internal/']) {
    await assert.rejects(resolve(new URL(value)), { message: 'Embedded module is unavailable' }, value);
  }
  assert.deepEqual(asked, ['monitor']);
});

test('the idle check reads job states from the database and counts unreadable rows as unfinished', () => {
  const db = new DatabaseSync(':memory:');
  const reader = createExecutionJobsReader(db);
  assert.deepEqual(reader.state(), { jobs: [] }, 'no table until the executor created it');
  db.exec('CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO execution_jobs(id,json) VALUES (?,?)');
  insert.run('a', JSON.stringify({ status: 'completed', plan: {} })); insert.run('b', '{'); insert.run('c', '{}');
  assert.deepEqual(reader.state().jobs.map(job => job.status), ['completed', 'unknown', 'unknown']);
  db.close();
});
