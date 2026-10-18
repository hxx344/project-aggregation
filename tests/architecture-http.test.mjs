import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

test('baseline endpoints require a live same-origin session and never refresh sources, trading or maintenance', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'architecture-http-'));
  let reads = 0, updateReads = 0;
  const app = await createApp({ dataDir, initialPassword: 'architecture-test-password', refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, logger: { info() {}, warn() {}, error() {} },
    summaryReader: async () => { reads++; return { updatedAt: new Date().toISOString(), metrics: [], message: 'fixture' }; },
    updatesClient: { status: async () => { updateReads++; throw new Error('metrics must not request updater status'); } },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'architecture-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
  for (const route of ['/api/system/metrics', '/api/system/architecture']) {
    assert.equal((await fetch(origin + route)).status, 401);
    assert.equal((await fetch(origin + route, { headers: { Cookie: cookie, Origin: 'https://wrong.example' } })).status, 403);
    assert.equal((await fetch(origin + route, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await fetch(origin + route + '?extra=1', { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(origin + route, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken } })).status, 405);
    const response = await fetch(origin + route, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    assert.equal(value.schemaVersion, 1);
    if (route.endsWith('metrics')) { assert.equal(value.sampling.retainedBuckets, 0); assert.equal(value.summaries.missing, 6); }
    else assert.deepEqual(value.modules, []);
    assert.equal(JSON.stringify(value).includes('credentials.key'), false);
  }
  assert.equal(reads, 0); assert.equal(updateReads, 0);
  await app.check('aster'); await app.baseline.sample();
  const before = app.baseline.read(); assert.equal(before.summaryReads.success, 1); assert.equal(before.sampling.retainedBuckets, 1);
  await fetch(origin + '/api/system/metrics', { headers: { Cookie: cookie } });
  assert.equal(reads, 1); assert.equal(updateReads, 0);
  await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken } });
  assert.equal((await fetch(origin + '/api/system/metrics', { headers: { Cookie: cookie } })).status, 401);
});
