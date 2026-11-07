import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubDatabase, seedProjects } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createProjectCatalog } from '../server/control/projects.mjs';
import { createDataPlane } from '../server/runtime/data-plane.mjs';
import { CHANGE_DEADLINE_MARGIN_MS } from '../server/automation/aero-safe.mjs';

test('every queued Aero Safe route passes the API deadline before validation or side effects', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aero-deadline-http-'));
  const db = openHubDatabase(join(dataDir, 'hub.sqlite')), control = createControlStore(db);
  seedProjects(control, { embeddedModules: false });
  const decrypt = () => null;
  const plane = createDataPlane({ db, control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }),
    encrypt: (value) => value, decrypt, embeddedModules: false, dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} }, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0 });
  t.after(async () => { await plane.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  await plane.initialize();
  control.sessions.create('deadline-session', 'csrf-fixture', Date.now() + 60_000);
  const root = '/api/automation/aero-safe';
  const request = (method, suffix, body, deadline) => plane.handle({ method, target: root + suffix, sessionId: 'deadline-session',
    contentType: 'application/json', body: [Buffer.from(JSON.stringify(body))], deadline });
  const routes = [
    ['PUT', '/config', { config: {} }], ['PUT', '/wallet', { privateKey: 'invalid' }], ['POST', '/wallet/clear', {}],
    ['POST', '/preview', { params: {} }], ['POST', '/execute', { action: 'claim', params: {} }],
    ['PUT', '/auto', { auto: {} }], ['PUT', '/policy', { policy: {} }], ['POST', '/auto/discard', {}],
    ['POST', '/changes/pool', { pool: 'invalid' }], ['POST', '/changes/allowances', { allowances: {} }],
    ['POST', '/changes/remove', { pool: 'invalid' }], ['POST', '/changes/batch', {}],
    ['POST', '/changes/apply', {}], ['POST', '/changes/clear', {}],
  ];
  // The API itself still has time left, but the inner safety margin has expired.
  for (const [method, suffix, body] of routes) {
    const result = await request(method, suffix, body, Date.now() + CHANGE_DEADLINE_MARGIN_MS - 1);
    assert.equal(result.status, 504, `${method} ${suffix}: ${JSON.stringify(result.body)}`);
  }
  assert.deepEqual(await readdir(join(dataDir, 'aero-safe')), []);
  // A normal request still reaches field validation; deadlines cannot come from request bodies.
  assert.equal((await request('PUT', '/config', { config: {} }, Date.now() + 60_000)).status, 400);
  assert.equal((await request('POST', '/changes/clear', { deadline: Date.now() + 60_000 }, Date.now() + 60_000)).status, 400);
  assert.equal((await request('POST', '/changes/clear', {}, Date.now() + 60_000)).status, 200);
});
