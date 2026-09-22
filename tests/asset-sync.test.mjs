import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssetSync, syncAsset } from '../server/asset-sync.mjs';
import { readSummary, UpstreamError } from '../server/adapters.mjs';

let port = 41000;
const fixture = (id = 'asset', overrides = {}) => ({ project: {
  id, adapter: 'asset', apiUrl: 'http://127.0.0.1:' + port++, enabled: true, autoSync: true, ...overrides,
}, credentials: { password: 'test-password-' + id }, revision: 1 });
const ledger = () => ({ dataKind: 'personal', assets: [], history: [], fx: 7, fxStatus: { fetchedAt: new Date().toISOString(), error: null }, connections: {}, asterAccounts: [] });
async function until(predicate, duration = 1000) {
  const end = Date.now() + duration;
  while (!predicate()) { if (Date.now() >= end) assert.fail('Timed out waiting for test condition'); await delay(5); }
}

test('server timer syncs enabled asset targets without any browser requests', async t => {
  const targets = [fixture('active'), fixture('paused', { autoSync: false }), fixture('disabled', { enabled: false }),
    fixture('monitor', { adapter: 'monitor' }), fixture('aster', { adapter: 'aster' }), { ...fixture('missing'), credentials: null }];
  const calls = []; const completed = [];
  const worker = createAssetSync({ listTargets: () => targets, intervalMs: 30, timeoutMs: 100,
    syncReader: async project => { calls.push({ id: project.id, at: Date.now() }); return {}; },
    onComplete: (id, revision, status) => completed.push({ id, revision, status }),
  });
  t.after(() => worker.close());
  await until(() => calls.length >= 2);
  assert.ok(calls.every(call => call.id === 'active'));
  assert.ok(calls[1].at - calls[0].at >= 25);
  assert.equal(worker.getStatus('paused').state, 'disabled');
  assert.equal(worker.getStatus('missing').state, 'unconfigured');
  assert.equal(worker.getStatus('monitor'), null);
  assert.equal(completed[0].status.state, 'success');
});

test('overlapping refresh and run share one flight and obey the per-project interval', async t => {
  const target = fixture(); let clock = 100000; let calls = 0; let release;
  const worker = createAssetSync({ listTargets: () => [target], autoStart: false, now: () => clock,
    syncReader: async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return {}; },
  });
  t.after(() => worker.close());
  const first = worker.refresh(); const second = worker.run('asset');
  await until(() => calls === 1);
  assert.equal(worker.getStatus('asset').state, 'syncing');
  release(); await Promise.all([first, second]);
  await worker.refresh(); await worker.run('asset'); assert.equal(calls, 1);
  clock += 60000; await worker.run('asset'); assert.equal(calls, 2);
});

test('a hanging asset sync has its own deadline and does not block another target', async t => {
  const targets = [fixture('slow'), fixture('fast')]; const completed = [];
  let slowAborted = false;
  const worker = createAssetSync({ listTargets: () => targets, autoStart: false, timeoutMs: 35,
    syncReader: async (project, _credentials, { signal }) => {
      if (project.id === 'fast') return {};
      signal.addEventListener('abort', () => { slowAborted = true; }, { once: true });
      await new Promise(() => {});
    },
    onComplete: (id, _revision, status) => completed.push([id, status.state]),
  });
  t.after(() => worker.close());
  const work = worker.refresh();
  await until(() => completed.some(([id]) => id === 'fast'));
  await work;
  assert.equal(slowAborted, true);
  assert.equal(worker.getStatus('fast').state, 'success');
  assert.equal(worker.getStatus('slow').state, 'error');
  assert.match(worker.getStatus('slow').message, /超时/);
});

test('changed revisions, disabled targets and deleted targets cannot publish old results', async () => {
  for (const change of ['revision', 'disabled', 'deleted']) {
    let targets = [fixture()]; let release; const completions = [];
    const worker = createAssetSync({ listTargets: () => targets, autoStart: false,
      syncReader: () => new Promise(resolve => { release = resolve; }), onComplete: (...args) => completions.push(args),
    });
    const work = worker.run('asset'); await until(() => !!release);
    if (change === 'revision') targets = [{ ...targets[0], revision: 2 }];
    if (change === 'disabled') targets = [{ ...targets[0], project: { ...targets[0].project, enabled: false } }];
    if (change === 'deleted') targets = [];
    // A revision check also protects publication if the caller has not reconciled yet.
    if (change !== 'revision') await worker.refresh();
    release({}); await work;
    assert.equal(completions.length, 0, change);
    if (change === 'revision') assert.equal(worker.getStatus('asset').state, 'idle');
    if (change === 'disabled') assert.equal(worker.getStatus('asset').state, 'disabled');
    if (change === 'deleted') assert.equal(worker.getStatus('asset'), null);
    await worker.close();
  }
});

test('close cancels in-flight work, prevents completion callbacks and stops timer requests', async () => {
  const target = fixture(); let calls = 0; let aborted = false; const completions = [];
  const worker = createAssetSync({ listTargets: () => [target], intervalMs: 15, timeoutMs: 500,
    syncReader: async (_project, _credentials, { signal }) => {
      calls++; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); await new Promise(() => {});
    }, onComplete: (...args) => completions.push(args),
  });
  await until(() => calls === 1); await worker.close(); await delay(45);
  await worker.run('asset'); await worker.refresh();
  assert.equal(aborted, true); assert.equal(calls, 1); assert.equal(completions.length, 0);
  const never = createAssetSync({ listTargets: () => [target], syncReader: async () => { calls++; } });
  await never.close(); await delay(5); assert.equal(calls, 1);
});

test('partial and failed syncs keep the previous success time and sanitize status messages', async t => {
  const target = fixture(); let clock = 100000; let attempt = 0; const completions = [];
  const worker = createAssetSync({ listTargets: () => [target], autoStart: false, now: () => clock,
    syncReader: async () => { attempt++; if (attempt === 1) return {}; if (attempt === 2) return { partial: true }; throw new Error('private-provider-response test-password-secret'); },
    onComplete: (_id, _revision, status) => completions.push(status),
  });
  t.after(() => worker.close());
  await worker.run('asset'); const successAt = worker.getStatus('asset').lastSuccessAt;
  clock += 60000; await worker.run('asset');
  assert.equal(worker.getStatus('asset').state, 'partial'); assert.equal(worker.getStatus('asset').lastSuccessAt, successAt);
  clock += 60000; await worker.run('asset');
  assert.equal(worker.getStatus('asset').state, 'error'); assert.equal(worker.getStatus('asset').lastSuccessAt, successAt);
  assert.equal(JSON.stringify(completions).includes('private-provider-response'), false);
  assert.equal(JSON.stringify(completions).includes('password'), false);
});

test('summary and sync share one login and only sync invokes POST /api/sync with JSON body', async () => {
  const { project, credentials } = fixture();
  project.authOrigin = 'https://asset.example.com';
  const calls = []; let finishLogin;
  const request = async (base, route, options) => {
    calls.push({ base, route, options });
    if (route === '/api/login') { await new Promise(resolve => { finishLogin = resolve; }); return { data: { ok: true }, cookies: ['asset_session=shared-cookie; Path=/'] }; }
    return { data: ledger() };
  };
  const read = readLegacySummary(project, credentials, { request });
  const sync = syncAsset(project, credentials, { request });
  await until(() => !!finishLogin);
  assert.equal(calls.filter(call => call.route === '/api/login').length, 1);
  finishLogin(); await Promise.all([read, sync]); await syncAsset(project, credentials, { request });
  assert.equal(calls.filter(call => call.route === '/api/login').length, 1);
  assert.ok(calls.every(call => call.base === project.apiUrl && call.options.headers.Origin === project.authOrigin));
  const syncCalls = calls.filter(call => call.route === '/api/sync');
  assert.equal(syncCalls.length, 2);
  assert.ok(syncCalls.every(call => call.options.method === 'POST' && call.options.headers.Cookie === 'asset_session=shared-cookie'));
  assert.deepEqual(syncCalls.map(call => call.options.body), [{}, {}]);
  assert.ok(calls.filter(call => call.options.method === 'POST').every(call => ['/api/login', '/api/sync'].includes(call.route)));
});

test('only a 401 from sync permits one renewed login and retry; other failures are not retried', async () => {
  const { project, credentials } = fixture();
  let logins = 0; let syncs = 0;
  const result = await syncAsset(project, credentials, { request: async (_base, route) => {
    if (route === '/api/login') { logins++; return { data: {}, cookies: ['asset_session=cookie-' + logins] }; }
    syncs++; if (syncs === 1) throw new UpstreamError('unauthorized', 'expired cookie', 401);
    return { data: { ...ledger(), fxStatus: { error: 'private fx details' } } };
  } });
  assert.equal(logins, 2); assert.equal(syncs, 2); assert.equal(result.partial, true);
  for (const statusCode of [403, 429, 503]) {
    const target = fixture('failed-' + statusCode); let attempts = 0;
    await assert.rejects(syncAsset(target.project, target.credentials, { request: async (_base, route) => {
      if (route === '/api/login') return { data: {}, cookies: ['asset_session=no-retry'] };
      attempts++; throw new UpstreamError(statusCode === 503 ? 'offline' : 'unauthorized', 'provider detail', statusCode);
    } }));
    assert.equal(attempts, 1, 'status ' + statusCode);
  }
});

test('a short summary deadline does not cancel a shared login still needed by the sync', async () => {
  const { project, credentials } = fixture(); let release; let loginSignal; let logins = 0;
  const request = async (_base, route, options) => {
    if (route === '/api/login') {
      logins++; loginSignal = options.signal;
      await new Promise(resolve => { release = resolve; });
      return { data: {}, cookies: ['asset_session=longer-waiter'] };
    }
    return { data: ledger() };
  };
  const read = readLegacySummary(project, credentials, { request, deadline: Date.now() + 30 });
  const rejected = assert.rejects(read, error => error.code === 'timeout');
  const sync = syncAsset(project, credentials, { request, deadline: Date.now() + 500 });
  await until(() => !!release); await rejected;
  assert.equal(loginSignal.aborted, false);
  release(); await sync;
  await syncAsset(project, credentials, { request });
  assert.equal(logins, 1);
});

test('canceling all login waiters aborts the login and does not cache its rejection', async () => {
  const { project, credentials } = fixture(); const controller = new AbortController(); let started = false; let canceled = false; let logins = 0;
  const request = async (_base, route, options) => {
    if (route === '/api/login') {
      logins++;
      if (logins === 1) {
        started = true;
        await new Promise((_, reject) => options.signal.addEventListener('abort', () => { canceled = true; reject(new Error('canceled')); }, { once: true }));
      }
      return { data: {}, cookies: ['asset_session=recovered'] };
    }
    return { data: ledger() };
  };
  const pending = syncAsset(project, credentials, { request, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === 'timeout');
  await until(() => started); controller.abort(); await rejected; await until(() => canceled);
  await syncAsset(project, credentials, { request });
  assert.equal(logins, 2);
  let sent = false;
  await assert.rejects(syncAsset(project, null, { request: async () => { sent = true; } }));
  assert.equal(sent, false);
});

// Model an unupgraded module explicitly: only a missing summary route permits fallback.
function readLegacySummary(project, credentials, options) {
  return readSummary(project, credentials, { ...options, request: (...args) => {
    if (args[1] === '/api/hub/summary?schemaVersion=2') throw new UpstreamError('offline', 'Not found', 404);
    return options.request(...args);
  } });
}
