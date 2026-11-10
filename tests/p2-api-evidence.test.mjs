import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p2-evidence-http-'));
  const app = await createApp({ dataDir: directory, initialPassword: 'p2-http-test-password', logger: () => {},
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, warmupEnabled: false, baselineIntervalMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const db = new DatabaseSync(path.join(directory, 'hub.sqlite'));
  t.after(async () => { db.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', data, auth, headers = {} } = {}) {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const result = await request('/api/login', { method: 'POST', data: { password: 'p2-http-test-password' } });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: result.data.csrfToken, id: createHash('sha256').update(cookie.slice('hub_session='.length)).digest('hex') };
  }
  return { request, login, db };
}

test('real API restricts module grant management to its current session and CSRF origin', async t => {
  const f = await fixture(t), auth = await f.login(), foreign = await f.login();
  const row = f.db.prepare('SELECT * FROM projects WHERE id=?').get('asset');
  const project = JSON.parse(row.json);
  project.apiUrl = 'http://127.0.0.1:49001'; project.enabled = true;
  f.db.prepare('UPDATE projects SET json=? WHERE id=?').run(JSON.stringify(project), 'asset');
  // The management endpoint derives the exact revision via the real catalog.
  const { createProjectCatalog } = await import('../server/control/projects.mjs');
  const { createControlStore } = await import('../server/control/store.mjs');
  const catalog = createProjectCatalog({ control: createControlStore(f.db), embeddedModules: false, decrypt: () => null });
  const revision = catalog.projectRevision('asset'), expires = Date.now() + 60_000;
  const insert = f.db.prepare('INSERT INTO portal_grants(digest,project_id,session_id,revision,expires) VALUES (?,?,?,?,?)');
  insert.run('a'.repeat(64), 'asset', auth.id, revision, expires);
  insert.run('b'.repeat(64), 'asset', foreign.id, revision, expires);
  assert.equal((await f.request('/api/portal/grants')).status, 401);
  const listed = await f.request('/api/portal/grants', { auth });
  assert.equal(listed.status, 200); assert.equal(listed.data.grants.length, 1);
  assert.ok(!JSON.stringify(listed.data).includes('a'.repeat(64)));
  const route = `/api/portal/grants/${listed.data.grants[0].id}`;
  assert.equal((await f.request(route, { method: 'DELETE', auth, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.request(route, { method: 'DELETE', auth, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await f.request(route, { method: 'DELETE', auth: foreign })).status, 404);
  assert.equal((await f.request(route, { method: 'DELETE', auth })).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM portal_grants WHERE session_id=?').get(auth.id).n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM portal_grants WHERE session_id=?').get(foreign.id).n, 1);
});

test('real research export route is authenticated, bounded and does not start collection', async t => {
  const f = await fixture(t), auth = await f.login();
  const query = new URLSearchParams({ session: randomUUID(), symbol: 'ANTH', from: '1794283200000', to: '1794283201000' });
  const route = `/api/research/entropy-lighter/evidence?${query}`;
  assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request(route, { auth, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const before = await f.request('/api/research/entropy-lighter', { auth });
  const result = await f.request(route, { auth });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(typeof result.data.jsonl, 'string');
  assert.ok(result.data.manifest);
  assert.equal((await f.request(route + '&from=0', { auth })).status, 400);
  assert.equal((await f.request(route.replace('from=1794283200000', 'from=1e3'), { auth })).status, 400);
  assert.equal((await f.request(route, { method: 'POST', auth, data: {} })).status, 405);
  const after = await f.request('/api/research/entropy-lighter', { auth });
  assert.equal(result.data.manifest.collectionStarted, false);
  assert.equal(before.data.state, 'stopped');
  assert.equal(after.data.state, before.data.state);
});

test('real execution evidence route is authenticated and does not manufacture absent jobs', async t => {
  const f = await fixture(t), auth = await f.login();
  const route = `/api/trading/execution/jobs/${randomUUID()}/evidence`;
  assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request(route, { auth })).status, 404);
  assert.equal((await f.request(route, { method: 'POST', auth, data: {} })).status, 405);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_jobs').get().n, 0);
});

test('backup ledger API requires current authentication and never accepts raw key material', async t => {
  const f = await fixture(t), auth = await f.login(), route = '/api/system/backup-readiness';
  assert.equal((await f.request(route)).status, 401);
  const current = await f.request(route, { auth });
  assert.equal(current.status, 200); assert.equal(current.data.schemaVersion, 1);
  const result = await f.request(route, { method: 'POST', auth, data: { dataKey: 'forbidden-key-material', expectedRevision: current.data.ledgerRevision } });
  assert.equal(result.status, 400);
  assert.ok(!JSON.stringify(result.data).includes('forbidden-key-material'));
  assert.equal((await f.request(route, { method: 'POST', auth, data: {}, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
});
