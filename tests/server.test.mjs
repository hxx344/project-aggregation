import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { UpstreamError } from '../server/adapters.mjs';
import { createOverviewDecoder } from '../src/overview-feed.ts';

const password = 'test-password-not-a-real-secret';
const summary = () => ({ updatedAt: new Date().toISOString(), metrics: [{ key: 'total', label: '总额', value: 42, unit: 'USD' }], message: '测试数据' });

test('partial diagnostics survive the check endpoint, overview refresh and restart', async t => {
  const message = '测试账户（account-a）：成交统计已过期（超过 15 秒）';
  const f = await fixture(t, { summaryReader: async () => ({ ...summary(), state: 'partial', message }) }); await f.login();
  const checked = await f.request('/api/projects/aster/check', { method: 'POST' });
  assert.equal(checked.data.snapshot.state, 'partial'); assert.equal(checked.data.snapshot.message, message);
  await f.reopen();
  const snapshot = (await f.request('/api/overview')).data.projects.find(item => item.project.id === 'aster');
  assert.equal(snapshot.state, 'partial'); assert.equal(snapshot.message, message);
});

test('source health and stricter TTL survive checks, persistence and missing timestamps', async t => {
  let value = { ...summary(), state: 'partial', staleAfterSeconds: 10, updatedAt: new Date(Date.now() - 11000).toISOString() };
  const f = await fixture(t, { summaryReader: async () => value }); await f.login();
  const old = await f.app.check('crossex'); assert.equal(old.state, 'stale'); assert.equal(old.staleAfterSeconds, 10);
  value = { ...value, state: 'offline' }; assert.equal((await f.app.check('crossex')).state, 'offline');
  value = { ...value, state: 'online', updatedAt: null }; assert.equal((await f.app.check('crossex')).state, 'stale');
  value = { ...value, freshness: 'static' }; assert.equal((await f.app.check('asset')).state, 'online');
  await f.reopen();
  const projects = (await f.request('/api/overview')).data.projects;
  assert.equal(projects.find(item => item.project.id === 'crossex').state, 'stale');
  assert.equal(projects.find(item => item.project.id === 'asset').freshness, 'static');
});

for (const protocol of ['', '?protocol=2']) test(`authenticated overview stream ${protocol || 'legacy'} publishes checks and config revocation, then closes on logout`, async t => {
  const f = await fixture(t); await f.login();
  const url = f.origin + '/api/overview/events' + protocol;
  const decode = createOverviewDecoder();
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Cookie: f.cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { headers: { Cookie: f.cookie, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  const controller = new AbortController(); t.after(() => controller.abort());
  const res = await fetch(url, { headers: { Cookie: f.cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.equal(res.headers.get('cache-control'), 'no-store');
  const reader = res.body.getReader(); let buffered = '';
  async function event() {
    while (!buffered.includes('\n\n')) { const { value, done } = await reader.read(); if (done) return null; buffered += new TextDecoder().decode(value); }
    const end = buffered.indexOf('\n\n'); const entry = buffered.slice(0, end); buffered = buffered.slice(end + 2);
    const raw = entry.split('\n').find(line => line.startsWith('data: ')).slice(6);
    if (protocol) assert.ok(['snapshot', 'patch', 'heartbeat'].includes(JSON.parse(raw).type));
    return decode(raw) || event();
  }
  const first = await event(); const revision = first.projects.find(item => item.project.id === 'crossex').project.revision;
  await f.app.check('crossex'); const checked = await event(); assert.equal(checked.projects.find(item => item.project.id === 'crossex').metrics[0].value, 42);
  await f.request('/api/projects/crossex', { method: 'PUT', body: { password: 'changed-test-password' } });
  const revised = await event(); const next = revised.projects.find(item => item.project.id === 'crossex').project;
  assert.notEqual(next.revision, revision); assert.equal(next.hasCredentials, true); assert.equal(next.password, undefined);
  await f.request('/api/logout', { method: 'POST' });
  // A config-triggered check can already be queued; logout must terminate the stream.
  let last; for (let i = 0; i < 4; i++) { last = await event(); if (last === null) break; }
  assert.equal(last, null);
});

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'project-hub-test-'));
  let app = await createApp({ dataDir, initialPassword: password, refreshInterval: 0, assetSyncIntervalMs: 0, summaryReader: async () => summary(), ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = ''; let csrf = '';
  async function request(route, { method = 'GET', body, auth = true, originHeader = origin, csrfHeader = csrf } = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}), ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(value = password) {
    const result = await request('/api/login', { method: 'POST', body: { password: value } });
    if (result.status === 200) { cookie = result.headers.get('set-cookie').split(';')[0]; csrf = result.data.csrfToken; }
    return result;
  }
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { get app() { return app; }, get origin() { return origin; }, get cookie() { return cookie; }, dataDir, request, login, async reopen(editDatabase) {
    await app.close();
    if (editDatabase) {
      const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
      try { db.exec('PRAGMA foreign_keys=ON'); editDatabase(db); } finally { db.close(); }
    }
    app = await createApp({ dataDir, initialPassword: 'different-password-ignored', refreshInterval: 0, assetSyncIntervalMs: 0, summaryReader: options.summaryReader || (async () => summary()) });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
  } };
}

test('authentication gates private data, enforces Origin/CSRF, and logout revokes session', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/health', { auth: false })).data, { status: 'ok' });
  assert.equal((await f.request('/api/overview')).status, 401);
  assert.deepEqual((await f.request('/api/session')).data, { authenticated: false });
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password }, originHeader: 'https://evil.example' })).status, 403);
  assert.equal((await f.login('wrong-password')).status, 401);
  const logged = await f.login();
  assert.equal(logged.status, 200); assert.match(logged.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('/api/projects')).data.projects.length, 4);
  assert.equal((await f.request('/api/logout', { method: 'POST', csrfHeader: '' })).status, 403);
  assert.equal((await f.request('/api/logout', { method: 'POST', originHeader: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/projects')).status, 401);
});

test('CrossEx is the fourth proxy preset and its simulated balance stays in its own snapshot', async t => {
  let requested;
  const f = await fixture(t, { summaryReader: async project => {
    if (project.id === 'crossex') { requested = project; return { ...summary(), metrics: [{ key: 'sim_equity', label: '模拟权益', value: 100000, unit: 'USDT', detail: '模拟账本，不计入真实资产' }] }; }
    return summary();
  } });
  await f.login();
  const projects = (await f.request('/api/projects')).data.projects;
  assert.deepEqual(projects.map(project => project.id), ['aster', 'monitor', 'asset', 'crossex']);
  assert.match(projects[3].revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(projects[3], { id: 'crossex', name: 'Gate CrossEx', description: '同币种跨交易所永续价差套利模拟', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:3200', apiUrl: 'http://127.0.0.1:3200', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 120, authOrigin: '', mode: 'external', enabled: true, order: 3, hasCredentials: false, revision: projects[3].revision });
  const asset = await f.app.check('asset');
  const simulation = await f.app.check('crossex');
  assert.equal(requested.adapter, 'standard');
  assert.equal(simulation.metrics[0].value, 100000);
  const snapshots = (await f.request('/api/overview')).data.projects;
  assert.deepEqual(snapshots.find(item => item.project.id === 'asset').metrics, asset.metrics);
  assert.equal(snapshots.find(item => item.project.id === 'asset').metrics[0].value, 42);
});

test('an existing installation gains CrossEx once without restoring deleted presets or changing saved data', async t => {
  const f = await fixture(t); await f.login();
  await f.request('/api/projects/aster', { method: 'PUT', body: { name: 'My ASTER', apiUrl: 'http://127.0.0.1:9876', accessMode: 'direct', password: 'saved-upstream-password' } });
  await f.request('/api/projects/asset', { method: 'PUT', body: { autoSync: false, staleAfterSeconds: 1800 } });
  await f.request('/api/projects/monitor', { method: 'DELETE' });
  await f.app.check('asset');
  const before = (await f.request('/api/overview')).data.projects.filter(item => item.project.id !== 'crossex');
  await f.reopen(db => db.exec("DELETE FROM projects WHERE id='crossex'; DELETE FROM settings WHERE key='seeded-crossex-v1';"));
  const upgraded = (await f.request('/api/overview')).data.projects;
  assert.equal(upgraded.length, 3);
  assert.deepEqual(upgraded.filter(item => item.project.id !== 'crossex'), before);
  assert.equal(upgraded.find(item => item.project.id === 'crossex').project.accessMode, 'proxy');
  assert.equal((await f.request('/api/projects/crossex', { method: 'DELETE' })).status, 200);
  await f.reopen();
  assert.deepEqual((await f.request('/api/projects')).data.projects.map(item => item.id), ['aster', 'asset']);
});

test('the CrossEx migration preserves an existing same-id project, credentials and cached summary', async t => {
  const f = await fixture(t); await f.login();
  await f.request('/api/projects/crossex', { method: 'PUT', body: { name: 'Existing CrossEx', apiUrl: 'http://127.0.0.1:9320', url: 'http://127.0.0.1:9320/custom', accessMode: 'direct', order: 12, username: 'custom-reader', password: 'saved-crossex-password' } });
  const before = await f.app.check('crossex');
  let saved;
  await f.reopen(db => { saved = db.prepare("SELECT * FROM projects WHERE id='crossex'").get(); db.exec("DELETE FROM settings WHERE key='seeded-crossex-v1'"); });
  assert.deepEqual((await f.request('/api/overview')).data.projects.find(item => item.project.id === 'crossex'), before);
  await f.reopen(db => { assert.deepEqual(db.prepare("SELECT * FROM projects WHERE id='crossex'").get(), saved); });
});

test('CrossEx migration respects the 30-project limit and does not retry after a full installation frees a slot', async t => {
  for (const size of [29, 30]) await t.test(`${size} existing projects`, async t => {
    const f = await fixture(t); await f.login();
    await f.reopen(db => {
      db.exec("DELETE FROM projects WHERE id='crossex'; DELETE FROM settings WHERE key='seeded-crossex-v1';");
      const template = JSON.parse(db.prepare("SELECT json FROM projects WHERE id='aster'").get().json);
      for (let index = 3; index < size; index++) {
        const project = { ...template, id: `custom-${index}`, name: `Custom ${index}`, adapter: 'link', enabled: false, order: index + 10 };
        db.prepare('INSERT INTO projects(id,json) VALUES (?,?)').run(project.id, JSON.stringify(project));
      }
    });
    const projects = (await f.request('/api/projects')).data.projects;
    assert.equal(projects.length, 30);
    assert.equal(projects.some(item => item.id === 'crossex'), size === 29);
    assert.equal((await f.request('/api/projects', { method: 'POST', body: { id: 'over-limit', name: 'Extra' } })).status, 400);
    const removed = size === 29 ? 'crossex' : 'custom-3';
    assert.equal((await f.request(`/api/projects/${removed}`, { method: 'DELETE' })).status, 200);
    await f.reopen();
    const restarted = (await f.request('/api/projects')).data.projects;
    assert.equal(restarted.length, 29);
    assert.equal(restarted.some(item => item.id === 'crossex'), false);
  });
});

test('Aster reads the server port independently of its browser tunnel and preserves saved addresses', async t => {
  let requested;
  const f = await fixture(t, { summaryReader: async project => { requested = project; return summary(); } });
  await f.login();
  await f.app.check('aster');
  assert.equal(requested.apiUrl, 'http://127.0.0.1:8765');
  assert.equal(requested.url, 'http://127.0.0.1:8765');
  const custom = { apiUrl: 'http://127.0.0.1:9876', url: 'http://127.0.0.1:19876' };
  assert.equal((await f.request('/api/projects/aster', { method: 'PUT', body: custom })).status, 200);
  await f.reopen(); await f.login();
  const project = (await f.request('/api/projects')).data.projects.find(item => item.id === 'aster');
  assert.equal(project.apiUrl, custom.apiUrl); assert.equal(project.url, custom.url);
});

test('single-port launch requires hub login and CSRF, and logout revokes an open project', async t => {
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || '' })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const f = await fixture(t);
  assert.equal((await f.request('/api/projects/aster/launch', { method: 'POST' })).status, 401);
  await f.login();
  const target = `http://127.0.0.1:${upstream.address().port}`;
  await f.request('/api/projects/aster', { method: 'PUT', body: { apiUrl: target, url: 'http://127.0.0.1:18765/?view=accounts' } });
  assert.equal((await f.request('/api/projects/aster/launch', { method: 'POST', csrfHeader: '' })).status, 403);
  const launched = await f.request('/api/projects/aster/launch', { method: 'POST' });
  assert.equal(launched.status, 200);
  const url = new URL(launched.data.url);
  assert.match(url.hostname, /^p-[a-f0-9]+\.hub\.localhost$/);
  assert.equal(url.port, new URL(f.origin).port);
  const routed = (pathname, cookie = '') => new Promise((resolve, reject) => {
    const request = http.request(f.origin + pathname, { agent: false, headers: { Host: url.host, ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: name => { const value = response.headers[name]; return Array.isArray(value) ? value[0] : value; } }, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject); request.end();
  });
  const authorization = await routed(url.pathname + url.search);
  assert.equal(authorization.status, 302);
  assert.equal(authorization.headers.get('location'), '/?view=accounts');
  const grant = authorization.headers.get('set-cookie').split(';')[0];
  const content = await routed('/?view=accounts', grant);
  assert.equal(content.status, 200);
  assert.deepEqual(await content.json(), { path: '/?view=accounts', cookie: '' });
  await f.request('/api/logout', { method: 'POST' });
  assert.equal((await routed('/', grant)).status, 401);
});

test('proxy and asset sync preferences persist and canonical navigation keeps the same port', async t => {
  const f = await fixture(t); await f.login();
  const projects = (await f.request('/api/projects')).data.projects;
  assert.ok(projects.every(project => project.accessMode === 'proxy'));
  assert.equal(projects.find(project => project.id === 'asset').autoSync, true);
  for (const body of [{ accessMode: 'arbitrary' }, { autoSync: 'true' }]) assert.equal((await f.request('/api/projects/asset', { method: 'PUT', body })).status, 400);
  assert.equal((await f.request('/api/projects/asset', { method: 'PUT', body: { autoSync: false, accessMode: 'direct' } })).status, 200);
  assert.equal((await f.request('/api/projects/asset/launch', { method: 'POST' })).status, 400);
  assert.equal((await f.request('/api/projects/asset/sync', { method: 'POST' })).status, 400);
  await f.reopen(); await f.login();
  const asset = (await f.request('/api/overview')).data.projects.find(item => item.project.id === 'asset');
  assert.equal(asset.project.accessMode, 'direct'); assert.equal(asset.sync.state, 'disabled');
  const navigation = await fetch(f.origin + '/?view=projects', { redirect: 'manual' });
  assert.equal(navigation.status, 302);
  assert.equal(navigation.headers.get('location'), `http://hub.localhost:${new URL(f.origin).port}/?view=projects`);
});

test('project and encrypted credentials persist; changing service clears credentials', async t => {
  const f = await fixture(t); await f.login();
  const secret = 'upstream-password-do-not-disclose';
  const created = await f.request('/api/projects', { method: 'POST', body: { name: '标准项目', adapter: 'standard', enabled: false, apiUrl: 'http://127.0.0.1:9999', url: 'http://127.0.0.1:9999/?view=all', password: secret, username: 'reader' } });
  assert.equal(created.status, 201);
  const id = created.data.project.id;
  assert.equal(created.data.project.hasCredentials, true);
  assert.equal(JSON.stringify(created.data).includes(secret), false);
  await f.reopen(); assert.equal((await f.login()).status, 200);
  const persisted = (await f.request('/api/projects')).data.projects.find(item => item.id === id);
  assert.equal(persisted.username, 'reader'); assert.equal(persisted.hasCredentials, true);
  assert.equal((await readFile(path.join(f.dataDir, 'hub.sqlite'))).includes(Buffer.from(secret)), false);
  const changed = await f.request(`/api/projects/${id}`, { method: 'PUT', body: { apiUrl: 'http://127.0.0.1:9998' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.project.hasCredentials, false);
  assert.equal((await f.request(`/api/projects/${id}`, { method: 'DELETE' })).status, 200);
  await f.reopen();
  assert.equal((await f.request('/api/projects')).data.projects.some(item => item.id === id), false);
});

test('last successful snapshot survives failures and restarts without changing source time', async t => {
  let failing = false; const at = new Date().toISOString();
  const f = await fixture(t, { summaryReader: async () => { if (failing) throw new UpstreamError('timeout', '服务响应超时'); return { ...summary(), updatedAt: at }; } });
  await f.login();
  const first = await f.app.check('asset'); assert.equal(first.state, 'online');
  failing = true;
  const failed = await f.app.check('asset'); assert.equal(failed.state, 'stale'); assert.equal(failed.updatedAt, at); assert.equal(failed.metrics[0].value, 42); assert.match(failed.message, /保留上次成功数据/);
  await f.reopen();
  const after = (await f.request('/api/overview')).data.projects.find(item => item.project.id === 'asset');
  assert.equal(after.updatedAt, at); assert.equal(after.metrics[0].value, 42);
});

test('concurrent checks share one upstream operation and a project failure stays isolated', async t => {
  let calls = 0;
  const f = await fixture(t, { summaryReader: async project => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); if (project.id === 'monitor') throw new UpstreamError('unauthorized', '需要登录'); return summary(); } });
  const results = await Promise.all([f.app.check('aster'), f.app.check('aster'), f.app.check('monitor')]);
  assert.equal(calls, 2); assert.equal(results[0].state, 'online'); assert.equal(results[1].state, 'online'); assert.equal(results[2].state, 'unauthorized');
});

test('password reset revokes sessions and stores only new password hash', async t => {
  const f = await fixture(t); await f.login(); const next = await f.app.resetPassword();
  assert.equal((await f.request('/api/projects')).status, 401);
  assert.equal((await f.login()).status, 401); assert.equal((await f.login(next)).status, 200);
});

test('project input rejects dangerous URLs and unexpected fields', async t => {
  const f = await fixture(t); await f.login();
  for (const body of [{ name: 'bad', apiUrl: 'http://169.254.169.254' }, { name: 'bad', apiUrl: 'http://example.com?password=x' }, { name: 'bad', url: 'javascript:alert(1)' }, { name: 'bad', apiUrl: 'http://user:pass@127.0.0.1' }, { name: 'bad', hasCredentials: true }]) assert.equal((await f.request('/api/projects', { method: 'POST', body })).status, 400);
});

test('explicit project identifiers are stable and duplicate identifiers are rejected', async t => {
  const f = await fixture(t); await f.login();
  const body = { id: 'my-next-project', name: '新项目', adapter: 'link', enabled: false, url: 'http://127.0.0.1:9900' };
  const created = await f.request('/api/projects', { method: 'POST', body });
  assert.equal(created.status, 201); assert.equal(created.data.project.id, body.id);
  assert.equal((await f.request('/api/projects', { method: 'POST', body })).status, 409);
  assert.equal((await f.request('/api/projects/my-next-project', { method: 'PUT', body: { id: body.id, name: '改名' } })).status, 200);
  assert.equal((await f.request('/api/projects/my-next-project', { method: 'PUT', body: { id: 'different-id' } })).status, 400);
});

test('saving while a check is running discards the old response without blocking the user', async t => {
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { summaryReader: async () => { started(); await hold; return summary(); } });
  await f.login();
  const running = f.app.check('aster'); await ready;
  const saved = await f.request('/api/projects/aster', { method: 'PUT', body: { id: 'aster', name: '新配置', enabled: false } });
  assert.equal(saved.status, 200); release(); await running;
  const result = (await f.request('/api/overview')).data.projects.find(item => item.project.id === 'aster');
  assert.equal(result.project.name, '新配置'); assert.equal(result.state, 'disabled'); assert.deepEqual(result.metrics, []);
});


test('concurrent partial login bodies reserve quota before await and success releases only itself', async t => {
  const f = await fixture(t);
  const partials = [];
  for (let index = 0; index < 10; index++) {
    const body = JSON.stringify({ password: index === 0 ? password : 'wrong-password' });
    const received = new Promise(resolve => f.app.server.once('request', resolve));
    let resolveResponse; let rejectResponse;
    const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const req = http.request(`${f.origin}/api/login`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
    req.on('error', rejectResponse); req.setTimeout(2000, () => req.destroy());
    response.catch(() => {});
    req.write(body.slice(0, 5)); await received;
    partials.push({ req, response, remainder: body.slice(5) });
  }
  t.after(() => { for (const part of partials) part.req.destroy(); });
  assert.equal((await f.login()).status, 429);
  partials[0].req.end(partials[0].remainder);
  assert.equal(await partials[0].response, 200);
  // Nine pending attempts remain reserved despite one successful login.
  const extra = http.request(`${f.origin}/api/login`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': 2 } });
  const reserved = new Promise(resolve => f.app.server.once('request', resolve));
  const extraResponse = new Promise((resolve, reject) => { extra.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); extra.on('error', reject); });
  extra.setTimeout(2000, () => extra.destroy()); extra.write('{'); await reserved;
  assert.equal((await f.login()).status, 429);
  extra.end('}'); assert.equal(await extraResponse, 401);
  for (const part of partials.slice(1)) part.req.end(part.remainder);
  assert.deepEqual(await Promise.all(partials.slice(1).map(part => part.response)), Array(9).fill(401));
});

test('malformed login bodies consume quota and a valid login works after the window expires', async t => {
  const f = await fixture(t, { loginWindowMs: 120 });
  // HTTP and password hashing can exceed a 120 ms window on a busy CI worker.
  // Advance the rate-limit clock explicitly instead of racing wall-clock time.
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < 10; index++) {
    const response = await fetch(`${f.origin}/api/login`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400); await response.arrayBuffer();
  }
  assert.equal((await f.login()).status, 429);
  now += 121;
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.login()).status, 200);
});

test('authOrigin accepts only an origin and changing it clears credentials', async t => {
  const f = await fixture(t); await f.login();
  const created = await f.request('/api/projects', { method: 'POST', body: { id: 'origin-project', name: 'Origin', adapter: 'asset', enabled: false, apiUrl: 'http://127.0.0.1:9991', authOrigin: 'https://asset.example.com', password: 'mock-upstream-password' } });
  assert.equal(created.status, 201); assert.equal(created.data.project.authOrigin, 'https://asset.example.com'); assert.equal(created.data.project.hasCredentials, true);
  for (const authOrigin of ['javascript:alert(1)', 'https://a.example/path', 'https://a.example?x=1', 'https://a.example#x', 'https://user:password@a.example', 'https://a.example/?', ' a.example ']) assert.equal((await f.request('/api/projects/origin-project', { method: 'PUT', body: { authOrigin } })).status, 400);
  const updated = await f.request('/api/projects/origin-project', { method: 'PUT', body: { authOrigin: 'https://new.example.com' } });
  assert.equal(updated.status, 200); assert.equal(updated.data.project.hasCredentials, false);
});

test('explicitly static valuations preserve source date without automatic staleness', async t => {
  const at = '2021-01-01T00:00:00Z';
  const f = await fixture(t, { summaryReader: async () => ({ ...summary(), freshness: 'static', updatedAt: at, message: '静态估值账本' }) });
  const snapshot = await f.app.check('asset');
  assert.equal(snapshot.state, 'online'); assert.equal(snapshot.freshness, 'static'); assert.equal(snapshot.updatedAt, at);
  await f.reopen(); await f.login();
  const persisted = (await f.request('/api/overview')).data.projects.find(item => item.project.id === 'asset');
  assert.equal(persisted.state, 'online'); assert.equal(persisted.freshness, 'static'); assert.equal(persisted.updatedAt, at);
});
