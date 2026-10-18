import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const root = path.resolve(process.argv[2] || '.');
const dataDir = await mkdtemp(path.join(tmpdir(), 'ci-package-data-'));
const password = 'package-test-only-123456';
let app, modules, failure, accountWriter;
try {
  const { startModules } = await import(pathToFileURL(path.join(root, 'server/modules/runtime.mjs')));
  const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.mjs')));
  const { readSummary } = await import(pathToFileURL(path.join(root, 'server/adapters.mjs')));
  const { createAccountWriter } = await import(pathToFileURL(path.join(root, 'server/execution/account-writer.mjs')));
  const writerContext = { databasePath: path.join(dataDir, 'execution-control.sqlite'), runtimeId: randomUUID() };
  accountWriter = createAccountWriter({ ...writerContext, moduleId: 'hub' });
  modules = await startModules({ root, dataDir, logger: console, writerContext, onFailure: error => { failure = error; } });
  app = await createApp({ dataDir, initialPassword: password, embeddedModules: true, accountWriter, logger: () => {},
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(Number(process.env.PACKAGE_TEST_PORT || 3100), '127.0.0.1', resolve); });
  const port = app.server.address().port, host = `hub.localhost:${port}`;
  let cookie = '', csrf = '';
  function request(route, { method = 'GET', body, moduleHost = host, headers = {}, authorize = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
        headers: { Host: moduleHost, Origin: `http://${moduleHost}`, ...(authorize && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
          ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, text, data }); });
      }); req.on('error', reject); req.setTimeout(60_000, () => req.destroy(new Error(`Request timed out: ${route}`))); req.end(encoded);
    });
  }
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/projects')).status, 401);
  const login = await request('/api/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.data.csrfToken;
  const architecture = (await request('/api/system/architecture')).data;
  assert.equal(architecture.accountWriterVersion, 1);
  for (const module of architecture.modules.filter(row => ['crossex', 'greeks', 'aster'].includes(row.moduleId))) {
    assert.equal(module.state, 'compatible'); assert.equal(module.capabilities.accountWriterVersion, 1);
  }
  const accounts = await request('/api/system/accounts');
  assert.equal(accounts.status, 200); assert.equal(accounts.data.enabled, true); assert.deepEqual(accounts.data.operations, []);
  const projects = (await request('/api/projects')).data.projects;
  assert.deepEqual(projects.map(item => item.id), ['monitor', 'asset', 'crossex', 'greeks', 'aster']);
  assert.equal((await request('/api/trading')).status, 200, 'Original trading module remains available');
  const hubPage = await request('/'); assert.equal(hubPage.status, 200); assert.match(hubPage.text, /<html/);
  const hubAssets = [...hubPage.text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(hubAssets.length > 0);
  for (const asset of hubAssets) { assert.ok((await readFile(path.join(root, 'dist', asset))).length); assert.equal((await request(asset)).status, 200); }
  const grants = [];
  for (const project of projects) {
    const launch = await request(`/api/projects/${project.id}/launch`, { method: 'POST' });
    assert.equal(launch.status, 200, launch.text);
    const url = new URL(launch.data.url); assert.equal(url.port, String(port));
    const auth = await request(url.pathname + url.search, { moduleHost: url.host, authorize: false, headers: { Origin: `http://${host}` } });
    assert.equal(auth.status, 302, auth.text);
    const headers = { Cookie: auth.headers['set-cookie'][0].split(';')[0] }, settings = { moduleHost: url.host, authorize: false, headers };
    grants.push(settings);
    const destination = new URL(auth.headers.location, url).pathname + new URL(auth.headers.location, url).search;
    const page = await request(destination, settings);
    assert.equal(page.status, 200, `${project.id}: ${page.text.slice(0, 300)}`); assert.match(page.text, /<html/i);
    const assets = [...page.text.matchAll(/(?:src|href)="(\/(?:assets|_next\/static|static)\/[^"#]+)"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, `${project.id}: frontend assets are referenced`);
    for (const asset of [...new Set(assets)].slice(0, 6)) assert.equal((await request(asset, settings)).status, 200, `${project.id}: ${asset}`);
    const summary = await request('/api/hub/summary?schemaVersion=2', settings);
    assert.equal(summary.status, 200, `${project.id} summary: ${summary.text.slice(0, 300)}`);
    if (project.id === 'aster') {
      const state = await request('/api/state', settings);
      assert.equal(state.status, 200, state.text.slice(0, 300));
      assert.equal(state.data.workspaceManaged, true);
      assert.equal((await request('/api/login', { ...settings, method: 'POST', body: { password } })).status, 409);
      assert.equal((await request('/api/logout', { ...settings, method: 'POST', body: {} })).status, 409);
    }
    const normalized = await readSummary(modules.projects.find(item => item.id === project.id), null, { deadline: Date.now() + 30_000 });
    assert.ok(Array.isArray(normalized.metrics), `${project.id}: summary is accepted by the real hub adapter`);
    assert.equal((await request('/__workspace/update-status', settings)).status, 403);
    console.log(`Packaged ${project.id}: page, static assets, authenticated summary and private boundary passed on ${port}.`);
  }
  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  for (const settings of grants) assert.equal((await request('/', settings)).status, 401);
  assert.equal(failure, undefined, failure?.message);
  await import(pathToFileURL(path.join(root, 'server/logger.mjs')));
  console.log('Complete deployment package passed: five real modules + native trading, one port, one login, logout revocation.');
} finally {
  await app?.close();
  await modules?.close();
  if (!app) accountWriter?.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
