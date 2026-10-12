import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feed, catalog, book } from './fixtures.mjs';
const password = 'isolated-test-password-only';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-http-test-'));
  const distDir = join(directory, 'dist'); mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>test</title>');
  writeFileSync(join(distDir, 'assets', 'index-abcdefgh.js'), 'export const value = 1;');
  writeFileSync(join(distDir, 'assets', 'index-abcdefgh.css'), 'body { color: black; }');
  const app = createApp({ dataDir: directory, distDir, initialPassword: password, intervalMs: 0, engineOptions: { feedReader: async () => feed(Date.now()), catalogReader: async () => catalog, depthReader: async q => book(q, Date.now()) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`; let csrf = '';
  async function request(path, { method = 'GET', body, auth = true, originHeader = origin, csrfHeader = csrf, headers = {} } = {}) {
    const res = await fetch(origin + path, { method, headers: { ...(auth ? { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } : {}), ...(originHeader ? { Origin: originHeader } : {}), ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); if (data.csrfToken) csrf = data.csrfToken; return { status: res.status, data, headers: res.headers };
  }
  t.after(async () => { await app.close(); if (!directory.startsWith(tmpdir()) || !directory.includes('crossex-http-test-')) throw new Error('unsafe path'); rmSync(directory, { recursive: true, force: true }); });
  return { app, directory, request, origin };
}
test('health is public; state and summaries require module authentication', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/health', { auth: false })).data.liveTradingAvailable, true);
  for (const path of ['/api/state', '/api/hub/summary']) assert.equal((await f.request(path, { auth: false })).status, 401);
  assert.equal((await f.request('/api/state')).status, 200);
});
test('writes require same-origin JSON and csrf; automation settings are rejected', async t => {
  const f = await fixture(t); await f.request('/api/state');
  const body = { config: { entryPaused: true } };
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, originHeader: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, originHeader: '' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, csrfHeader: '' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body })).status, 200);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body: { config: { enabled: true } } })).status, 400);
  assert.equal((await f.request('/api/live/orders', { method: 'POST', body: {} })).status, 404);
});
test('summary never marks absent data fresh, secrets never enter public state or plaintext DB', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/hub/summary')).data.data.updatedAt, '1970-01-01T00:00:00.000Z');
  await f.request('/api/state'); await f.request('/api/settings', { method: 'PUT', body: { config: {}, monitorPassword: 'not-a-real-monitor-secret' } });
  assert.doesNotMatch(JSON.stringify((await f.request('/api/state')).data), /not-a-real-monitor-secret/);
  assert.equal(readFileSync(join(f.directory, 'crossex.sqlite')).includes(Buffer.from('not-a-real-monitor-secret')), false);
  await f.app.market.refresh(); const summary = (await f.request('/api/hub/summary')).data; assert.equal(summary.schemaVersion, 1); assert.deepEqual(Object.keys(summary.data).sort(), ['metrics', 'updatedAt']);
});
test('reset revokes cached Basic authorization immediately', async t => {
  const f = await fixture(t); await f.request('/api/state'); f.app.resetPassword(); assert.equal((await f.request('/api/state')).status, 401);
});
test('removed simulation routes cannot create or manage positions', async t => {
  const f = await fixture(t); await f.request('/api/state'); await f.app.market.refresh();
  for (const route of ['/api/open', '/api/close', '/api/execution']) {
    assert.equal((await f.request(route, { method: 'POST', body: { signalId: 'legacy', requestId: 'legacy-http-request' } })).status, 410);
  }
  assert.equal(f.app.store.positions().length, 0); assert.equal(f.app.store.executions().length, 0);
  assert.equal((await f.request('/api/state')).data.mode, 'live');
});
test('wrong-password bursts do not lock out a subsequent correct login', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) {
    const attempt = await f.request('/api/state', { headers: { Authorization: `Basic ${Buffer.from(`admin:incorrect-${i}`).toString('base64')}` } });
    assert.equal(attempt.status, i < 9 ? 401 : 429);
  }
  const started = Date.now();
  assert.equal((await f.request('/api/state')).status, 200);
  assert.ok(Date.now() - started < 5000, 'first correct login remains inside the Hub five-second timeout');
});


test('summary v2 reports live connection without exposing archived paper history', async t => {
  const f = await fixture(t);
  const summary = await f.request('/api/hub/summary?schemaVersion=2');
  assert.equal(summary.status, 200); assert.equal(summary.data.schemaVersion, 2); assert.equal(summary.data.data.updatedAt, null); assert.equal(summary.data.data.health.state, 'offline');
  const light = await f.request('/api/state?history=0'); assert.equal(light.data.history, undefined);
  const full = await f.request('/api/state');
  assert.equal(full.data.mode, 'live'); assert.equal(full.data.history, undefined); assert.deepEqual(full.data.live.positions, []);
});

test('only hashed JS and CSS have immutable asset caching; HTML and APIs remain no-store', async t => {
  const f = await fixture(t), headers = { Authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64') };
  for (const path of ['/assets/index-abcdefgh.js', '/assets/index-abcdefgh.css']) {
    const response = await fetch(f.origin + path, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable'); await response.arrayBuffer();
  }
  for (const path of ['/', '/api/state']) { const response = await fetch(f.origin + path, { headers }); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer(); }
});
