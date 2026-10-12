import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { moduleIds } from '../server/modules/catalog.mjs';
import { registerModuleTransport, moduleOrigin, moduleTransport } from '../server/modules/transport.mjs';
import { requestJson } from '../server/adapters.mjs';
import { unavailableUpdateState } from '../server/updates.mjs';

const password = 'embedded-hub-test-password';
const options = { initialPassword: password, logger: () => {}, refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 };
async function fixture(t, { existing = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'embedded-hub-'));
  const modules = [], calls = [], removers = [];
  let app, cookie, csrf, port;
  t.after(async () => {
    await app?.close(); for (const remove of removers) remove();
    await Promise.all(modules.map(server => new Promise(resolve => server.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  });
  if (existing) {
    const old = await createApp({ ...options, dataDir }); await old.close();
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
    db.prepare('DELETE FROM projects WHERE id=?').run('crossex');
    for (let i = 0; i < 26; i++) db.prepare('INSERT INTO projects(id,json) VALUES (?,?)').run(`saved-${i}`, JSON.stringify({ id: `saved-${i}`, enabled: true, order: i, adapter: 'link', name: `old-${i}` }));
    db.close();
  }
  for (const id of moduleIds) {
    const secret = randomUUID(), socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\embedded-hub-${randomUUID()}` : path.join(dataDir, `${id}.sock`);
    const server = http.createServer(async (req, res) => {
      assert.equal(req.headers['x-workspace-key'], secret);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : null;
      calls.push({ id, path: req.url, method: req.method, body, headers: req.headers });
      let value = req.url === '/__workspace/update-status' ? { busy: false } : { ok: true, module: id };
      if (req.url === '/__workspace/maintenance') value = { active: body.active };
      if (req.url === '/api/hub/positions') value = { schemaVersion: 1, generatedAt: new Date().toISOString(), accounts: [] };
      if (req.url.startsWith('/api/hub/trading-connections')) value = { schemaVersion: 1, connections: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    });
    await new Promise(resolve => server.listen(socketPath, resolve)); modules.push(server);
    removers.push(registerModuleTransport(id, { socketPath, secret }));
  }
  app = await createApp({ ...options, dataDir, embeddedModules: true, updatesClient: { status: async () => unavailableUpdateState() } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); port = app.server.address().port;
  const origin = `http://hub.localhost:${port}`;
  function request(route, { method = 'GET', body, host = `hub.localhost:${port}`, headers = {}, auth = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
        headers: { Host: host, Origin: `http://${host}`, ...(auth && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } resolve({ status: res.statusCode, headers: res.headers, text, data }); });
      }); req.on('error', reject); req.end(encoded);
    });
  }
  async function login() { const result = await request('/api/login', { method: 'POST', body: { password } }); assert.equal(result.status, 200); cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.data.csrfToken; }
  async function launch(id) {
    const result = await request(`/api/projects/${id}/launch`, { method: 'POST' }); assert.equal(result.status, 200);
    const url = new URL(result.data.url); assert.equal(url.port, String(port));
    const authorized = await request(url.pathname + url.search, { host: url.host, auth: false, headers: { Origin: origin } });
    assert.equal(authorized.status, 302, authorized.text);
    return { host: url.host, cookie: authorized.headers['set-cookie'][0].split(';')[0] };
  }
  return { request, login, launch, calls, dataDir, app };
}

test('migration exposes exactly four built-ins, keeps the native trading module and preserves old configuration', async t => {
  const f = await fixture(t, { existing: true });
  assert.equal((await f.request('/api/projects')).status, 401);
  await f.login();
  const projects = (await f.request('/api/projects')).data.projects;
  assert.deepEqual(projects.map(project => project.id), moduleIds);
  assert.ok(projects.every(project => project.embedded && project.accessMode === 'proxy'));
  assert.equal((await f.request('/api/trading')).status, 200);
  assert.equal((await f.request('/api/trading/execution')).status, 200);
  assert.equal((await f.request('/api/projects/aster/launch', { method: 'POST' })).status, 404);
  assert.equal((await f.request('/api/projects', { method: 'POST', body: { id: 'other' } })).status, 405);
  assert.equal((await f.request('/api/projects/monitor', { method: 'PUT', body: { apiUrl: 'http://127.0.0.1:3000' } })).status, 400);
  assert.equal((await f.request('/api/projects/asset', { method: 'PUT', body: { autoSync: false, order: 7 } })).status, 200);
  const db = new DatabaseSync(path.join(f.dataDir, 'hub.sqlite'));
  assert.ok(db.prepare('SELECT json FROM projects WHERE id=?').get('aster'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM projects WHERE id LIKE ?').get('saved-%').count, 26); db.close();
});

test('one hub login reaches all four modules on one TCP port; private controls and export stay backend-only', async t => {
  const f = await fixture(t); await f.login();
  for (const id of moduleIds) {
    const module = await f.launch(id);
    const headers = { Cookie: module.cookie, 'x-workspace-key': 'browser-forged' };
    const response = await f.request('/', { host: module.host, auth: false, headers });
    assert.equal(response.status, 200); assert.equal(response.data.module, id);
    assert.equal((await f.request('/api/read', { host: module.host, auth: false })).status, 401);
    for (const route of ['/__workspace/update-status', '/%5f%5fworkspace/maintenance', '/api/hub/trading-connections/export', '/api/hub/trading-connections/%65xport']) {
      assert.equal((await f.request(route, { host: module.host, auth: false, headers })).status, 403, route);
    }
    assert.equal((await f.request('/api/write', { method: 'POST', body: {}, host: module.host, auth: false, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  }
  const module = await f.launch('monitor');
  await f.request('/api/logout', { method: 'POST' });
  assert.equal((await f.request('/', { host: module.host, auth: false, headers: { Cookie: module.cookie } })).status, 401);
});

test('native trading reads the embedded Asset without a separate web password or login call', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.request('/api/trading/import-sources')).status, 200);
  assert.ok(f.calls.some(call => call.id === 'asset' && call.path.startsWith('/api/hub/trading-connections')));
  assert.ok(!f.calls.some(call => call.path === '/api/login'));
});

test('virtual transports fail closed after unregister and never fall back to DNS or TCP', async t => {
  const f = await fixture(t);
  assert.equal(moduleTransport('http://example.com'), null);
  assert.throws(() => moduleTransport('http://unknown.workspace.internal'), /unavailable/);
  const result = await requestJson(moduleOrigin('monitor'), '/', { deadline: Date.now() + 1000 });
  assert.equal(result.data.module, 'monitor');
  assert.equal(f.calls.at(-1).headers.host, 'monitor.workspace.internal');
});
