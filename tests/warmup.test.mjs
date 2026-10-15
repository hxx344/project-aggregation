import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';

const INITIAL = Date.UTC(2026, 9, 12, 0);
const PASSWORD = 'warmup-test-only-password';
const IDS = ['aster', 'monitor', 'asset', 'crossex', 'variational', 'greeks'];
const ENV = ['WARMUP_ENABLED', 'WARMUP_PROJECTS', 'WARMUP_INTERVAL_MS'];
const quiet = { initialPassword: PASSWORD, logger: () => {}, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 };
const summary = () => ({ updatedAt: new Date().toISOString(), metrics: [], message: 'Synthetic summary' });

function environment(t, values = {}) {
  const previous = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  const apply = values => { for (const key of ENV) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } };
  apply(values);
  t.after(() => apply(previous));
  return apply;
}

async function fixture(t, { env, ...options } = {}) {
  environment(t, env);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: INITIAL });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-hub-warmup-'));
  const calls = [], handlers = {};
  let app, db, stopped = false, origin, cookie, csrf;
  async function stop() { if (app && !stopped) { await app.close(); stopped = true; } }
  t.after(async () => { await stop(); db?.close(); await rm(directory, { recursive: true, force: true }); });
  app = await createApp({ ...quiet, dataDir: path.join(directory, 'data'), ...options,
    summaryReader: async (project, credentials, request) => {
      calls.push({ id: project.id, apiUrl: project.apiUrl, at: Date.now() - INITIAL, signal: request.signal });
      return handlers[project.id] ? handlers[project.id](project, request) : summary();
    },
  });
  db = new DatabaseSync(path.join(app.dataDir, 'hub.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  async function request(route, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const req = http.request(origin + route, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  return {
    app, calls, handlers, stop,
    times: id => calls.filter(call => call.id === id).map(call => call.at),
    saved: id => JSON.parse(db.prepare('SELECT json FROM snapshots WHERE id=?').get(id).json),
    configure(id, changes) {
      const row = db.prepare('SELECT json FROM projects WHERE id=?').get(id);
      db.prepare('UPDATE projects SET json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.json), ...changes }), id);
    },
    remove: id => db.prepare('DELETE FROM projects WHERE id=?').run(id),
    async change(id, changes) {
      if (!origin) {
        await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${app.server.address().port}`;
        const login = await request('/api/login', 'POST', { password: PASSWORD });
        assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.data.csrfToken;
      }
      const result = await request(`/api/projects/${id}`, changes ? 'PUT' : 'DELETE', changes);
      assert.equal(result.status, 200); await nextTurn();
    },
    async advance(milliseconds) {
      // Drain each real scheduler turn; align ticks after the 100 ms first read.
      for (let remaining = milliseconds; remaining > 0;) {
        const elapsed = Date.now() - INITIAL;
        const step = Math.min(elapsed < 100 ? 100 - elapsed : 1000 - elapsed % 1000, remaining);
        t.mock.timers.tick(step); remaining -= step; await nextTurn();
      }
    },
  };
}

test('default warmup shares the first refresh and never adds reads to the faster normal cadence', async t => {
  const f = await fixture(t);
  await f.advance(99); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, IDS.length);
  await f.advance(119900);
  for (const id of IDS.filter(id => id !== 'greeks')) assert.deepEqual(f.times(id), [100, 31000, 61000, 91000], id);
  assert.deepEqual(f.times('greeks'), [100, 16000, 31000, 46000, 61000, 76000, 91000, 106000]);
});

test('custom targets accelerate only selected projects and preserve a faster source TTL', async t => {
  const f = await fixture(t, { warmupProjects: [' aster ', 'aster', '', 'crossex', 'unknown'], warmupIntervalMs: 2000 });
  f.handlers.crossex = () => ({ ...summary(), staleAfterSeconds: 2 });
  await f.advance(7000);
  assert.deepEqual(f.times('aster'), [100, 3000, 5000, 7000]);
  assert.deepEqual(f.times('crossex'), [100, 2000, 3000, 4000, 5000, 6000, 7000]);
  for (const id of ['monitor', 'asset', 'variational', 'greeks']) assert.deepEqual(f.times(id), [100], id);
});

test('summary reads use the remaining source lifetime at the last check before cached data expires', async t => {
  const f = await fixture(t, { warmupEnabled: false });
  f.handlers.crossex = () => ({ ...summary(), state: 'online', staleAfterSeconds: 15,
    updatedAt: new Date(Date.now() - 7900).toISOString() });
  await f.advance(7500);
  assert.deepEqual(f.times('crossex'), [100, 4000], 'the fixed check-time lifetime schedules one read, without a sliding deadline');
  const saved = f.saved('crossex');
  assert.equal(saved.updatedAt, new Date(INITIAL + 4000 - 7900).toISOString(), 'sampling must retain the real source timestamp');
  assert.equal(saved.staleAfterSeconds, 15, 'sampling must not extend the source TTL');
  assert.ok(Date.now() - Date.parse(saved.updatedAt) < saved.staleAfterSeconds * 1000);
  await f.advance(500);
  assert.deepEqual(f.times('crossex'), [100, 4000, 8000]);
});

test('partial dynamic summaries use the stricter project TTL and retain the one-second minimum', async t => {
  const f = await fixture(t, { warmupEnabled: false });
  f.configure('crossex', { staleAfterSeconds: 30 });
  f.handlers.crossex = () => ({ ...summary(), state: 'partial', staleAfterSeconds: 60,
    updatedAt: new Date(Date.now() - 20000).toISOString() });
  await f.advance(5000);
  assert.deepEqual(f.times('crossex'), [100]);
  await f.advance(1000);
  assert.deepEqual(f.times('crossex'), [100, 6000]);
  f.handlers.crossex = () => ({ ...summary(), state: 'online', staleAfterSeconds: 15,
    updatedAt: new Date(Date.now() - 14900).toISOString() });
  await f.app.check('crossex');
  await f.advance(999);
  assert.deepEqual(f.times('crossex'), [100, 6000, 6000]);
  await f.advance(1);
  assert.deepEqual(f.times('crossex'), [100, 6000, 6000, 7000]);
});

test('static, failed and invalid source snapshots retain the normal summary cadence', async t => {
  for (const [name, overrides] of [
    ['static', { freshness: 'static' }],
    ['offline', { state: 'offline' }],
    ['stale', { state: 'stale' }],
    ['missing source time', { updatedAt: null }],
    ['invalid source time', { updatedAt: 'invalid' }],
    ['already expired', { updatedAt: new Date(INITIAL - 20000).toISOString() }],
    ['future source time', { updatedAt: new Date(INITIAL + 60000).toISOString() }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { warmupEnabled: false });
    f.handlers.crossex = () => ({ ...summary(), state: 'online', staleAfterSeconds: 15,
      updatedAt: new Date(Date.now() - 7900).toISOString(), ...overrides });
    await f.advance(8000);
    assert.deepEqual(f.times('crossex'), [100, 8000]);
  });
  await t.test('failed read retains the last successful summary without accelerating retries', async t => {
    const f = await fixture(t, { warmupEnabled: false });
    f.handlers.crossex = () => ({ ...summary(), state: 'online', staleAfterSeconds: 15,
      updatedAt: new Date(Date.now() - 7900).toISOString() });
    await f.advance(100);
    f.handlers.crossex = () => { throw new Error('Synthetic summary failure'); };
    await f.app.check('crossex');
    await f.advance(7900);
    assert.deepEqual(f.times('crossex'), [100, 100, 8000]);
  });
});

test('environment targets are trimmed and empty entries removed; omitted targets use the defaults', async t => {
  for (const [name, targets, expected] of [
    ['explicit', ' asset, asset, , monitor, ', ['asset', 'monitor']],
    ['default', undefined, ['aster', 'monitor', 'asset']],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { env: { WARMUP_PROJECTS: targets, WARMUP_INTERVAL_MS: '2000' } });
    await f.advance(5000);
    for (const id of IDS) assert.deepEqual(f.times(id), expected.includes(id) ? [100, 3000, 5000] : [100], id);
  });
});

test('disabled warmup and an empty target list retain automatic refresh; nonpositive refresh disables all automatic reads', async t => {
  for (const [name, options] of [
    ['environment disabled', { env: { WARMUP_ENABLED: 'false', WARMUP_INTERVAL_MS: '1000' } }],
    ['option disabled', { warmupEnabled: false, warmupIntervalMs: 1000 }],
    ['empty environment list', { env: { WARMUP_PROJECTS: ' , , ', WARMUP_INTERVAL_MS: '1000' } }],
    ['empty option list', { warmupProjects: [], warmupIntervalMs: 1000 }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, options); await f.advance(31000);
    for (const id of IDS) assert.deepEqual(f.times(id), id === 'greeks' ? [100, 16000, 31000] : [100, 31000], id);
  });
  for (const refreshInterval of [0, -1]) await t.test(`refreshInterval=${refreshInterval}`, async t => {
    const f = await fixture(t, { refreshInterval, warmupIntervalMs: 1000 });
    await f.advance(91000); assert.equal(f.calls.length, 0);
    await f.app.refresh(); assert.equal(f.calls.length, IDS.length, 'manual refresh remains available');
  });
});

test('invalid warmup configuration fails before creating files, including when scheduling is disabled', async t => {
  const setEnvironment = environment(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-hub-warmup-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  async function rejected(options, expected) {
    const dataDir = path.join(directory, `invalid-${index++}`);
    await assert.rejects(createApp({ ...quiet, dataDir, refreshInterval: 0, warmupEnabled: false, ...options }).then(async app => { await app.close(); }), expected);
    assert.equal(existsSync(dataDir), false, 'invalid configuration must not create the data directory or database');
  }
  for (const warmupIntervalMs of [-1, 0, 999, 1000.5, NaN, Infinity, 2147483648, '2000', null]) {
    await rejected({ warmupIntervalMs }, { name: 'RangeError', message: /WARMUP_INTERVAL_MS/ });
  }
  for (const value of ['', 'invalid', '999', '1000.5', 'Infinity', '2147483648']) {
    setEnvironment({ WARMUP_INTERVAL_MS: value });
    await rejected({}, { name: 'RangeError', message: /WARMUP_INTERVAL_MS/ });
  }
  setEnvironment({});
  for (const warmupProjects of ['aster', null, 42, {}, ['aster', 42]]) {
    await rejected({ warmupProjects }, { name: 'TypeError', message: /warmupProjects/ });
  }
});

test('the maximum valid warmup interval does not overflow into rapid requests', async t => {
  const f = await fixture(t, { warmupIntervalMs: 2147483647 });
  await f.advance(31000);
  assert.deepEqual(f.times('aster'), [100, 31000]);
});

test('scheduler ignores disabled, link, missing-API and deleted projects and follows live configuration changes', async t => {
  const f = await fixture(t, { warmupProjects: IDS, warmupIntervalMs: 1000 });
  f.configure('aster', { enabled: false }); f.configure('monitor', { adapter: 'link' }); f.configure('asset', { apiUrl: '' }); f.remove('crossex');
  await f.advance(3000);
  for (const id of ['aster', 'monitor', 'asset', 'crossex']) assert.deepEqual(f.times(id), [], id);
  for (const id of ['variational', 'greeks']) assert.deepEqual(f.times(id), [100, 2000, 3000], id);
  await f.change('aster', { enabled: true });
  await f.change('monitor', { adapter: 'standard' });
  await f.change('asset', { apiUrl: 'http://127.0.0.1:4567' });
  await f.change('variational', { enabled: false });
  await f.change('greeks');
  await f.advance(3000);
  for (const id of ['aster', 'monitor', 'asset']) assert.deepEqual(f.times(id), [3000, 4000, 5000, 6000], id);
  assert.ok(f.calls.filter(call => call.id === 'asset').every(call => call.apiUrl === 'http://127.0.0.1:4567'));
  for (const id of ['variational', 'greeks']) assert.deepEqual(f.times(id), [100, 2000, 3000], id);
  assert.deepEqual(f.times('crossex'), []);
});

test('pending reads are merged, failures are isolated, and close aborts in-flight work and stops scheduled reads', async t => {
  const f = await fixture(t, { warmupProjects: ['aster', 'monitor'], warmupIntervalMs: 1000 });
  f.handlers.aster = (_project, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Synthetic abort')), { once: true }));
  let attempts = 0;
  f.handlers.monitor = () => { if (++attempts === 1) throw new Error('Synthetic failure'); return summary(); };
  await f.advance(100);
  assert.equal(f.saved('monitor').state, 'offline');
  const pending = [f.app.check('aster'), f.app.check('aster')];
  await f.advance(2900);
  assert.deepEqual(f.times('aster'), [100], 'manual checks and scheduler ticks share the pending read');
  assert.deepEqual(f.times('monitor'), [100, 2000, 3000], 'a failed read retries on schedule while another project is pending');
  assert.equal(f.saved('monitor').state, 'online');
  for (const id of ['asset', 'crossex', 'variational', 'greeks']) assert.deepEqual(f.times(id), [100], id);
  const count = f.calls.length;
  await f.stop(); await Promise.all(pending);
  assert.equal(f.calls.find(call => call.id === 'aster').signal.aborted, true);
  await f.advance(91000); assert.equal(f.calls.length, count);
});
