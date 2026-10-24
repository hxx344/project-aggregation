import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';
import { payload, scope, NOW, hynixPayload } from './fills-fixtures.mjs';

const password = 'hub-fills-test-only';
const assetPassword = 'asset-fills-test-only';
const body = payload;
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-fills-http-'));
  const calls = [], gates = [];
  let loginCount = 0, reply = async (_req, res) => send(res, 200, body());
  const asset = http.createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url });
    assert.equal(req.headers.origin, assetOrigin);
    if (req.url === '/api/login') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      assert.equal(JSON.parse(raw).password, assetPassword);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `asset_session=fixture-${++loginCount}; HttpOnly; Path=/` });
    }
    if (req.headers.cookie !== `asset_session=fixture-${loginCount}`) return send(res, 401, { error: 'secret-upstream-error' });
    assert.equal(req.method, 'GET'); assert.match(req.url, /^\/api\/hub\/fills(\?market=hynix)?$/);
    if (req.url.endsWith('market=hynix')) return send(res, 200, hynixPayload());
    await reply(req, res);
  });
  await new Promise(resolve => asset.listen(0, '127.0.0.1', resolve));
  const assetOrigin = `http://127.0.0.1:${asset.address().port}`;
  const app = await createApp({ dataDir: directory, initialPassword: password, logger: () => {}, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, assetFillsCacheMs: 0, assetFillsNow: () => NOW,
    summaryReader: async () => ({ metrics: [], updatedAt: null, message: 'fixture' }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  async function request(route, { method = 'GET', data, authenticated = true } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(authenticated && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    return { response, data: await response.json() };
  }
  const login = await request('/api/login', { method: 'POST', data: { password } });
  cookie = login.response.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrfToken;
  const configure = data => request('/api/projects/asset', { method: 'PUT', data });
  t.after(async () => {
    gates.forEach(gate => gate.resolve());
    await app.close(); asset.closeAllConnections(); await new Promise(resolve => asset.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { request, configure, calls, connect: () => configure({ apiUrl: assetOrigin, url: assetOrigin, password: assetPassword, autoSync: false }),
    reply: handler => { reply = handler; }, revoke: () => { loginCount++; },
    hold: () => { const entered = deferred(), gate = deferred(); gates.push(gate);
      reply = async (_req, res) => { entered.resolve(); await gate.promise; if (!res.destroyed) send(res, 200, body()); };
      return { entered: entered.promise, release: gate.resolve };
    },
  };
}

test('fills route requires Hub authentication and only reads the configured Asset API', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/trading/fills', { authenticated: false })).response.status, 401);
  let result = await f.request('/api/trading/fills');
  assert.equal(result.data.sources[0].status, 'unconfigured'); assert.equal(f.calls.length, 0);
  await f.connect(); result = await f.request('/api/trading/fills');
  assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.sources[0].status, 'ready'); assert.deepEqual(result.data.sources[0].data.exchanges[0].accounts[0].scopes[0].fills, payload().exchanges[0].accounts[0].scopes[0].fills);
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [['POST', '/api/login'], ['GET', '/api/hub/fills']]);
  assert.equal((await f.request('/api/trading/fills?pair=unknown')).response.status, 400);
  for (const query of ['?market=gold', '?market=oil&market=hynix', '?market=hynix&pair=x', '?market=__proto__']) {
    assert.equal((await f.request('/api/trading/fills' + query)).response.status, 400);
  }
  result = await f.request('/api/trading/fills?market=hynix');
  assert.equal(result.data.sources[0].status, 'ready');
  assert.deepEqual(result.data.sources[0].data.exchanges[0].accounts[0].scopes[0].fills.map(item => [item.symbol, item.base]), [['SKHYUSDT', 'SKHY']]);
  assert.equal(f.calls.at(-1).url, '/api/hub/fills?market=hynix', 'each market reads its own Asset query');
  assert.equal((await f.request('/api/trading/fills', { method: 'POST', data: {} })).response.status, 405);
});

test('old Asset versions get an upgrade message and session expiration is retried safely', async t => {
  const f = await fixture(t); await f.connect();
  f.reply(async (_req, res) => send(res, 404, { error: 'upstream-secret' }));
  let result = await f.request('/api/trading/fills');
  assert.equal(result.data.sources[0].status, 'unavailable'); assert.match(result.data.sources[0].error, /更新 Asset/);
  f.reply(async (_req, res) => send(res, 200, body())); f.revoke();
  result = await f.request('/api/trading/fills');
  assert.equal(result.data.sources[0].status, 'ready'); assert.equal(f.calls.filter(call => call.url === '/api/login').length, 2);
  assert.ok(!JSON.stringify(result.data).includes('upstream-secret'));
});

test('disabling a source during a read removes it and discards the late payload', async t => {
  const f = await fixture(t); await f.connect();
  const hold = f.hold(), pending = f.request('/api/trading/fills'); await hold.entered;
  assert.equal((await f.configure({ enabled: false })).response.status, 200);
  hold.release(); const result = await pending;
  assert.deepEqual(result.data.sources, []);
});

test('logout while an Asset request is pending does not return account data', async t => {
  const f = await fixture(t); await f.connect();
  const hold = f.hold(), pending = f.request('/api/trading/fills'); await hold.entered;
  await f.request('/api/logout', { method: 'POST', data: {} }); hold.release();
  const result = await pending; assert.equal(result.response.status, 401); assert.equal(result.data.sources, undefined);
});

test('upstream failures preserve stale fills; changing credentials clears the old snapshot', async t => {
  const f = await fixture(t); await f.connect();
  const first = (await f.request('/api/trading/fills')).data.sources[0];
  f.reply(async (_req, res) => send(res, 503, { error: 'upstream-secret' }));
  const stale = (await f.request('/api/trading/fills')).data.sources[0];
  assert.equal(stale.status, 'stale'); assert.equal(scope(stale.data).status, 'stale');
  assert.deepEqual(scope(stale.data).fills, scope(first.data).fills);
  assert.equal(scope(stale.data).fetchedAt, scope(first.data).fetchedAt);
  assert.ok(!JSON.stringify(stale).includes('upstream-secret'));
  await f.configure({ clearCredentials: true });
  const cleared = (await f.request('/api/trading/fills')).data.sources[0];
  assert.equal(cleared.status, 'unconfigured'); assert.equal(cleared.data, null);
});
