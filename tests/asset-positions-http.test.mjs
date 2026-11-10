import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';

const password = 'hub-positions-test-only';
const assetPassword = 'asset-positions-test-only';
const body = () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), exchanges: [{ id: 'binance', name: 'Binance', accounts: [
  { id: 'default', name: '主账户', configured: true, revision: 'a'.repeat(64), scopes: [{ id: 'usdm', label: '普通 U 本位', status: 'live', refreshing: false, fetchedAt: new Date().toISOString(), error: null, positions: [] }] },
] }] });
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-positions-http-'));
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
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/hub/positions');
    await reply(req, res);
  });
  await new Promise(resolve => asset.listen(0, '127.0.0.1', resolve));
  const assetOrigin = `http://127.0.0.1:${asset.address().port}`;
  const app = await createApp({ dataDir: directory, initialPassword: password, logger: () => {}, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, assetPositionsCacheMs: 0,
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
    hold: (snapshot = body) => { const entered = deferred(), gate = deferred(); gates.push(gate);
      reply = async (_req, res) => { entered.resolve(); await gate.promise; if (!res.destroyed) send(res, 200, snapshot()); };
      return { entered: entered.promise, release: gate.resolve };
    },
  };
}

test('positions route requires Hub authentication and only reads the configured Asset API', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/trading/positions', { authenticated: false })).response.status, 401);
  let result = await f.request('/api/trading/positions');
  assert.equal(result.data.sources[0].status, 'unconfigured'); assert.equal(f.calls.length, 0);
  await f.connect(); result = await f.request('/api/trading/positions');
  assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.sources[0].status, 'ready'); assert.deepEqual(result.data.sources[0].data.exchanges[0].accounts[0].scopes[0].positions, []);
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [['POST', '/api/login'], ['GET', '/api/hub/positions']]);
  assert.equal((await f.request('/api/trading/positions?pair=unknown')).response.status, 400);
  assert.equal((await f.request('/api/trading/positions', { method: 'POST', data: {} })).response.status, 405);
});

test('old Asset versions get an upgrade message and session expiration is retried safely', async t => {
  const f = await fixture(t); await f.connect();
  f.reply(async (_req, res) => send(res, 404, { error: 'upstream-secret' }));
  let result = await f.request('/api/trading/positions');
  assert.equal(result.data.sources[0].status, 'unavailable'); assert.match(result.data.sources[0].error, /更新 Asset/);
  f.reply(async (_req, res) => send(res, 200, body())); f.revoke();
  result = await f.request('/api/trading/positions');
  assert.equal(result.data.sources[0].status, 'ready'); assert.equal(f.calls.filter(call => call.url === '/api/login').length, 2);
  assert.ok(!JSON.stringify(result.data).includes('upstream-secret'));
});

test('positions HTTP reads serve cached rows while a slow refresh is shared, then publish a confirmed empty result', async t => {
  const f = await fixture(t); await f.connect();
  const initial = body(), initialScope = initial.exchanges[0].accounts[0].scopes[0];
  initialScope.positions.push({ id: 'BTCUSDT:long', symbol: 'BTCUSDT', instrumentId: 'BTCUSDT', side: 'long', quantity: '1', quantityUnit: 'BTC',
    contractSize: null, entryPrice: '60000', markPrice: '61000', priceCurrency: 'USDT', notional: '61000', notionalCurrency: 'USDT',
    unrealizedPnl: '1000', pnlCurrency: 'USDT', leverage: null, marginMode: null, liquidationPrice: null, sourceUpdatedAt: initialScope.fetchedAt });
  f.reply(async (_req, res) => send(res, 200, initial));
  const first = await f.request('/api/trading/positions');
  const hold = f.hold(); let timer;
  try {
    const reads = Promise.all(Array.from({ length: 3 }, () => f.request('/api/trading/positions')));
    const cached = await Promise.race([reads, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('positions HTTP route waited for its slow refresh')), 500); })]);
    await hold.entered;
    for (const result of cached) {
      const source = result.data.sources[0], currentScope = source.data.exchanges[0].accounts[0].scopes[0];
      assert.equal(result.response.status, 200);
      assert.equal(source.checkedAt, first.data.sources[0].checkedAt);
      assert.equal(currentScope.fetchedAt, initialScope.fetchedAt);
      assert.equal(currentScope.refreshing, true); assert.equal(currentScope.positions.length, 1);
    }
    assert.equal(f.calls.filter(call => call.url === '/api/hub/positions').length, 2, 'concurrent UI consumers share the refresh');
    f.reply(async (_req, res) => send(res, 200, body())); hold.release();
    let current;
    for (let attempt = 0; attempt < 50; attempt++) {
      current = (await f.request('/api/trading/positions')).data.sources[0].data.exchanges[0].accounts[0].scopes[0];
      if (!current.positions.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(current.status, 'live'); assert.deepEqual(current.positions, []);
  } finally { clearTimeout(timer); hold.release(); }
});

test('disabling a source during a read removes it and discards the late payload', async t => {
  const f = await fixture(t); await f.connect();
  const hold = f.hold(), pending = f.request('/api/trading/positions'); await hold.entered;
  assert.equal((await f.configure({ enabled: false })).response.status, 200);
  hold.release(); const result = await pending;
  assert.deepEqual(result.data.sources, []);
});

test('checking an unchanged project drops positions from a removed Asset account before the next read', async t => {
  const f = await fixture(t), connected = await f.connect();
  assert.equal(typeof connected.data.project.revision, 'string');
  const initial = body(), initialScope = initial.exchanges[0].accounts[0].scopes[0];
  initialScope.positions.push({ id: 'BTCUSDT:long', symbol: 'BTCUSDT', instrumentId: 'BTCUSDT', side: 'long', quantity: '1', quantityUnit: 'BTC',
    contractSize: null, entryPrice: '60000', markPrice: '61000', priceCurrency: 'USDT', notional: '61000', notionalCurrency: 'USDT',
    unrealizedPnl: '1000', pnlCurrency: 'USDT', leverage: null, marginMode: null, liquidationPrice: null, sourceUpdatedAt: initialScope.fetchedAt });
  f.reply(async (_req, res) => send(res, 200, initial));
  const first = await f.request('/api/trading/positions');
  assert.equal(first.data.sources[0].data.exchanges[0].accounts[0].scopes[0].positions.length, 1);
  const removed = body(); removed.exchanges[0].accounts = [];
  const hold = f.hold(() => removed);
  try {
    const checked = await f.request('/api/projects/asset/check', { method: 'POST', data: {} });
    assert.equal(checked.response.status, 200);
    assert.equal(checked.data.snapshot.project.revision, connected.data.project.revision, 'the Asset account change does not alter the Hub project revision');
    let completed = false;
    const pending = f.request('/api/trading/positions').then(result => { completed = true; return result; });
    await hold.entered;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, 'the invalidated snapshot cannot be returned as live while the new account directory is pending');
    hold.release(); const current = await pending;
    assert.equal(current.response.status, 200); assert.equal(current.data.sources[0].status, 'ready');
    assert.deepEqual(current.data.sources[0].data.exchanges[0].accounts, []);
    assert.equal(f.calls.filter(call => call.url === '/api/hub/positions').length, 2);
  } finally { hold.release(); }
});

test('logout while an Asset request is pending does not return account data', async t => {
  const f = await fixture(t); await f.connect();
  const hold = f.hold(), pending = f.request('/api/trading/positions'); await hold.entered;
  await f.request('/api/logout', { method: 'POST', data: {} }); hold.release();
  const result = await pending; assert.equal(result.response.status, 401); assert.equal(result.data.sources, undefined);
});
