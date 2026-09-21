import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { HUB_HOST } from '../server/portal.mjs';

const hubPassword = 'hub-test-password-not-real';
const assetPassword = 'asset-test-password-not-real';
const originalTime = '2026-01-01T00:00:00.000Z';
const refreshedTime = '2026-01-01T00:01:00.000Z';

async function until(predicate, duration = 2000) {
  const end = Date.now() + duration;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for the fake Asset request');
    await delay(5);
  }
}

function routedRequest(port, host, route, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent: false,
      headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}),
        ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', reject);
    req.end(encoded);
  });
}

async function fixture(t, { autoSync = true, failure = false, partial = false, savedPassword = assetPassword } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const summaryReads = [];
  let version = 0;
  let logins = 0;
  const ledger = () => ({
    dataKind: 'personal',
    assets: [{ id: 'test-holding', name: 'Fixture holding', mode: 'market', updatedAt: version ? refreshedTime : originalTime,
      ...(partial && version ? { error: 'Fixture quote unavailable' } : {}) }],
    history: [],
    fxStatus: { fetchedAt: version ? refreshedTime : originalTime, error: null },
    connections: {},
    asterAccounts: [],
    testVersion: version,
  });
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const call = { method: req.method, path: req.url, cookie: req.headers.cookie || '', origin: req.headers.origin, body };
      calls.push(call);
      if (req.url === '/api/login' && req.method === 'POST') {
        if (JSON.parse(body).password !== assetPassword) { send(res, 401, { error: 'Login required' }); return; }
        send(res, 200, { ok: true }, { 'Set-Cookie': `asset_session=login-${++logins}; HttpOnly; Path=/` }); return;
      }
      const authorized = /(?:^|;\s*)asset_session=(?:login-\d+|browser-one|browser-two)(?:;|$)/.test(call.cookie);
      if (!authorized) { send(res, 401, { error: 'Please log in to Asset' }); return; }
      if (req.url === '/api/ledger' && req.method === 'GET') { send(res, 200, ledger()); return; }
      if (req.url === '/api/sync' && req.method === 'POST') {
        await gate;
        if (res.destroyed) return;
        if (failure) { send(res, 500, { error: 'PRIVATE_UPSTREAM_FAILURE_DO_NOT_EXPOSE' }); return; }
        version++;
        send(res, 200, ledger()); return;
      }
      send(res, 404, { error: 'Unexpected test route' });
    } catch {
      if (!res.destroyed) send(res, 500, { error: 'Fake Asset request failed' });
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'asset-portal-test-'));
  let app;
  t.after(async () => {
    release();
    app?.server.closeAllConnections();
    upstream.closeAllConnections();
    if (app) await app.close();
    await new Promise(resolve => upstream.close(resolve));
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(dataDir).startsWith(tempRoot), 'cleanup must stay inside the test temporary directory');
    await rm(dataDir, { recursive: true, force: true });
  });
  app = await createApp({
    dataDir, initialPassword: hubPassword, refreshInterval: 0, assetSyncIntervalMs: 0,
    summaryReader: async project => {
      summaryReads.push(project.id);
      return { updatedAt: version ? refreshedTime : originalTime, metrics: [], message: 'Fixture saved ledger' };
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const hubHost = HUB_HOST + ':' + port;
  const hubOrigin = 'http://' + hubHost;
  let hubCookie = '';
  let csrf = '';
  const hub = (route, { method = 'GET', body } = {}) => routedRequest(port, hubHost, route, {
    method, body, cookie: hubCookie, headers: { Origin: hubOrigin, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
  });
  const login = await hub('/api/login', { method: 'POST', body: { password: hubPassword } });
  assert.equal(login.status, 200);
  hubCookie = login.headers['set-cookie'][0].split(';')[0];
  csrf = login.data.csrfToken;
  const configured = await hub('/api/projects/asset', { method: 'PUT', body: {
    apiUrl: upstreamOrigin, url: upstreamOrigin, accessMode: 'proxy', enabled: true, autoSync, ...(savedPassword ? { password: savedPassword } : { clearCredentials: true }),
  } });
  assert.equal(configured.status, 200);
  assert.equal(configured.data.project.hasCredentials, !!savedPassword);
  await until(() => summaryReads.includes('asset'));

  async function launch() {
    const launch = await hub('/api/projects/asset/launch', { method: 'POST' });
    assert.equal(launch.status, 200);
    const url = new URL(launch.data.url);
    const authorized = await routedRequest(port, url.host, url.pathname + url.search, {
      headers: { Origin: hubOrigin, 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
    });
    return { url, authorized };
  }
  async function browser(session = '') {
    const { url, authorized } = await launch();
    assert.equal(authorized.status, 302);
    assert.ok(authorized.headers['set-cookie'].every(value => value.startsWith('hub_portal=')), 'upstream sessions stay on the server');
    const grant = authorized.headers['set-cookie'][0].split(';')[0];
    return {
      ledger: () => routedRequest(port, url.host, '/api/ledger', { cookie: grant + (session ? '; asset_session=' + session : '') }),
      sync: () => routedRequest(port, url.host, '/api/sync', {
        method: 'POST', body: {}, cookie: grant + (session ? '; asset_session=' + session : ''),
        headers: { Origin: url.origin, 'Sec-Fetch-Site': 'same-origin' },
      }),
    };
  }
  return { app, calls, summaryReads, browser, launch, hub, upstreamOrigin, release,
    syncCalls: () => calls.filter(call => call.method === 'POST' && call.path === '/api/sync'),
    ledgerCalls: () => calls.filter(call => call.method === 'GET' && call.path === '/api/ledger'),
  };
}

test('automatic Asset page sessions and the independent background session share one sync POST', async t => {
  const f = await fixture(t);
  const one = await f.browser('browser-one');
  const two = await f.browser('browser-two');
  const background = f.app.assetSync.run('asset');
  await until(() => f.syncCalls().length === 1);
  const first = one.sync();
  const second = two.sync();
  await until(() => f.ledgerCalls().length === 2);
  assert.equal(f.app.assetSync.getStatus('asset').state, 'syncing');
  assert.equal(f.syncCalls().length, 1);
  f.release();
  const [status, firstResult, secondResult] = await Promise.all([background, first, second]);
  assert.equal(status.state, 'success');
  for (const response of [firstResult, secondResult]) {
    assert.equal(response.status, 200);
    assert.equal(response.data.testVersion, 1);
    assert.equal(response.data.assets[0].updatedAt, refreshedTime);
    assert.ok(!response.text.includes(assetPassword));
  }
  assert.equal(f.syncCalls().length, 1);
  assert.equal(f.syncCalls()[0].cookie, 'asset_session=login-3');
  assert.equal(f.syncCalls()[0].body, '{}');
  assert.equal(f.syncCalls()[0].origin, f.upstreamOrigin);
  assert.equal(f.calls.filter(call => call.path === '/api/login').length, 3);
  assert.deepEqual(f.ledgerCalls().map(call => call.cookie).sort(), [
    'asset_session=login-1', 'asset_session=login-1', 'asset_session=login-2', 'asset_session=login-2',
  ]);
  assert.ok(f.calls.every(call => !call.cookie.includes('hub_')));
  assert.equal(f.summaryReads.filter(id => id === 'asset').length, 2);
});

test('without saved credentials, a portal grant alone cannot access a protected Asset service', async t => {
  const f = await fixture(t, { savedPassword: '' });
  const page = await f.browser('');
  const response = await page.ledger();
  assert.equal(response.status, 401);
  assert.equal(response.data.error, 'Please log in to Asset');
  assert.equal(f.syncCalls().length, 0);
  assert.equal(f.calls.filter(call => call.path === '/api/login').length, 0);
  assert.equal(f.ledgerCalls().length, 1);
  assert.equal(f.ledgerCalls()[0].cookie, '');
  assert.equal(f.app.assetSync.getStatus('asset').state, 'unconfigured');
});

test('a shared Asset sync failure remains a failure and does not return the saved ledger as success', async t => {
  const f = await fixture(t, { failure: true });
  const page = await f.browser();
  const background = f.app.assetSync.run('asset');
  await until(() => f.syncCalls().length === 1);
  const responsePromise = page.sync();
  await until(() => f.ledgerCalls().length === 1);
  f.release();
  const [status, response] = await Promise.all([background, responsePromise]);
  assert.equal(status.state, 'error');
  assert.equal(response.status, 502);
  assert.equal(typeof response.data.error, 'string');
  assert.equal(response.data.testVersion, undefined);
  assert.ok(!response.text.includes('PRIVATE_UPSTREAM_FAILURE_DO_NOT_EXPOSE'));
  assert.equal(f.syncCalls().length, 1, 'non-401 failure must not repeat the sync POST');
  assert.equal(f.ledgerCalls().length, 1, 'failure must not fetch and return a success ledger');
  assert.equal(f.summaryReads.filter(id => id === 'asset').length, 1);
  const overview = await f.hub('/api/overview');
  assert.equal(overview.data.projects.find(item => item.project.id === 'asset').updatedAt, originalTime);
});

test('a partial shared sync returns the original ledger and retains its source error', async t => {
  const f = await fixture(t, { partial: true });
  const page = await f.browser();
  const responsePromise = page.sync();
  await until(() => f.syncCalls().length === 1);
  f.release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.data.testVersion, 1);
  assert.equal(response.data.assets[0].error, 'Fixture quote unavailable');
  assert.equal(f.app.assetSync.getStatus('asset').state, 'partial');
  assert.equal(f.syncCalls().length, 1);
  assert.equal(f.ledgerCalls().length, 2);
  assert.equal(f.summaryReads.filter(id => id === 'asset').length, 2);
});

test('disabling Asset background sync transparently forwards the original browser sync POST', async t => {
  const f = await fixture(t, { autoSync: false });
  const page = await f.browser('browser-two');
  const responsePromise = page.sync();
  await until(() => f.syncCalls().length === 1);
  f.release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.data.testVersion, 1);
  assert.equal(f.syncCalls()[0].cookie, 'asset_session=login-1');
  assert.equal(f.syncCalls()[0].body, '{}');
  assert.equal(f.calls.filter(call => call.path === '/api/login').length, 1);
  assert.equal(f.ledgerCalls().length, 0);
  assert.equal(f.app.assetSync.getStatus('asset').state, 'disabled');
  assert.equal(f.summaryReads.filter(id => id === 'asset').length, 1);
});


test('invalid saved Asset credentials do not grant access or expose a password challenge', async t => {
  const f = await fixture(t, { savedPassword: 'wrong-fixture-password' });
  const { authorized } = await f.launch();
  assert.equal(authorized.status, 401);
  assert.equal(authorized.headers['set-cookie'], undefined);
  assert.equal(authorized.headers['www-authenticate'], undefined);
  assert.ok(!authorized.text.includes('wrong-fixture-password'));
  assert.ok(!authorized.text.includes(assetPassword));
  assert.equal(f.calls.filter(call => call.path === '/api/login').length, 1);
  assert.equal(f.ledgerCalls().length, 0);
  assert.equal(f.syncCalls().length, 0);
});
