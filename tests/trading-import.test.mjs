import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';

const HUB_PASSWORD = 'hub-import-test-password';
const ASSET_PASSWORD = 'asset-import-test-password';
const CATALOG = '/api/hub/trading-connections';
const CATALOG_READ = CATALOG + '?include=okx';
const SOURCES = '/api/trading/import-sources';
const STAMP = '2026-10-07T00:00:00.000Z';
const NOW = Date.parse(STAMP);
const exchanges = ['binance', 'bybit', 'okx'];
const revisions = { binance: 'a'.repeat(64), bybit: 'b'.repeat(64), okx: 'e'.repeat(64) };
const credentials = suffix => ({ apiKey: `fixture_api_key_${suffix}`, apiSecret: `fixture_api_secret_${suffix}`, ...(suffix.includes('okx') ? { passphrase: 'fixture_private_passphrase' } : {}) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const importRoute = exchange => `/api/trading/accounts/${exchange}/import`;
const send = (res, status, data, headers = {}) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data));
};
const positions = (exchange, quantity = '2') => ({ fetchedAt: STAMP, positions: [{ exchange, symbol: 'CLUSDT', side: 'long', mode: 'one-way',
  quantity, entryPrice: '70', markPrice: '71', notional: '142', unrealizedPnl: '2', leverage: '2', liquidationPrice: null, sourceUpdatedAt: STAMP,
  ...(exchange === 'okx' ? { marginMode: 'cross', contractSize: '0.1' } : {}) }] });

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-trading-import-'));
  const calls = [], clientCalls = [], assetHandlers = {}, verifyHandlers = {}, releases = [];
  const secrets = Object.fromEntries(exchanges.map(exchange => [exchange, credentials(`imported_${exchange}`)]));
  const catalog = { schemaVersion: 1, connections: exchanges.map(exchange => ({ exchange, configured: true, supported: true,
    revision: revisions[exchange], label: secrets[exchange].apiKey.slice(-4), updatedAt: STAMP, reason: null })) };
  let origin, cookie = '', csrf = '', loginCount = 0, app, closed = false;
  const asset = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const call = { route: req.url, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      if (req.headers.origin !== assetOrigin) { send(res, 403, { error: 'Unexpected Asset Origin' }); return; }
      if (req.url === '/api/login' && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json' || call.body?.password !== ASSET_PASSWORD) { send(res, 401, { error: 'Asset password rejected' }); return; }
        send(res, 200, { ok: true }, { 'Set-Cookie': `asset_session=fixture-${++loginCount}; HttpOnly; Path=/` }); return;
      }
      if (!new RegExp(`(?:^|;\\s*)asset_session=fixture-${loginCount}(?:;|$)`).test(req.headers.cookie || '') || !loginCount) {
        send(res, 401, { error: 'Asset session required' }); return;
      }
      const stage = req.url === CATALOG_READ && req.method === 'GET' ? 'catalog' : req.url === CATALOG + '/export' && req.method === 'POST' ? 'export' : null;
      if (!stage) { send(res, 404, { error: 'Unexpected test route' }); return; }
      if (stage === 'export' && (req.headers['content-type'] !== 'application/json' || call.body.password !== ASSET_PASSWORD)) {
        send(res, 403, { error: 'Asset export password required' }); return;
      }
      if (assetHandlers[stage]) {
        const reply = await assetHandlers[stage](call);
        if (reply) { send(res, reply.status ?? 200, reply.data); return; }
      }
      if (stage === 'catalog') { send(res, 200, catalog); return; }
      const { exchange, revision } = call.body;
      if (!exchanges.includes(exchange) || revision !== revisions[exchange]) { send(res, 409, { error: 'Source connection changed' }); return; }
      send(res, 200, { schemaVersion: 1, exchange, revision, region: 'global', credentials: secrets[exchange] });
    } catch { send(res, 500, { error: 'Fixture request failed' }); }
  });
  await new Promise(resolve => asset.listen(0, '127.0.0.1', resolve));
  const assetOrigin = `http://127.0.0.1:${asset.address().port}`;
  t.after(async () => {
    for (const release of releases) release();
    if (app && !closed) await app.close();
    asset.closeAllConnections(); await new Promise(resolve => asset.close(resolve));
    const absolute = path.resolve(dataDir), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(tempRoot), 'cleanup must remain inside this test temporary directory');
    await rm(absolute, { recursive: true, force: true });
  });
  const clientFactory = exchange => Object.fromEntries(['verify', 'positions', 'funding'].map(method => [method, async (secret, options) => {
    clientCalls.push({ exchange, method, secret, ...options });
    if (method === 'verify' && verifyHandlers[exchange]) return verifyHandlers[exchange](secret, options);
    if (method === 'funding') return { fetchedAt: STAMP, events: [], coverage: [{ start: options.start, end: options.end }], complete: true };
    return positions(exchange, secret.apiKey.includes('original') ? '1' : '2');
  }]));
  app = await createApp({ dataDir, initialPassword: HUB_PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, tradingClientFactory: clientFactory, tradingNow: () => NOW,
    summaryReader: async () => ({ updatedAt: STAMP, metrics: [], message: 'fixture' }), logger: () => {}, ...overrides });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, { method = 'GET', body, rawBody, auth = true, originHeader = origin, csrfHeader = csrf, contentType = 'application/json' } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': contentType } : {}),
        ...(auth && cookie ? { Cookie: cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}), ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}) },
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const login = await request('/api/login', { method: 'POST', body: { password: HUB_PASSWORD } });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrfToken;
  async function update(body, projectId = 'asset') {
    const response = await request(`/api/projects/${projectId}`, { method: 'PUT', body }); assert.equal(response.status, 200); return response.data.project;
  }
  await update({ apiUrl: assetOrigin, url: assetOrigin, password: ASSET_PASSWORD, autoSync: false });
  function stored(exchange = 'binance') {
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM trading_accounts WHERE exchange=?').get(exchange); } finally { db.close(); }
  }
  async function body(exchange = 'binance', projectId = 'asset') {
    const response = await request(SOURCES); assert.equal(response.status, 200);
    const source = response.data.sources.find(row => row.projectId === projectId); assert.equal(source?.status, 'ready', JSON.stringify(response.data));
    return { revision: stored(exchange).revision, projectId, projectRevision: source.projectRevision,
      sourceRevision: source.connections.find(row => row.exchange === exchange).revision };
  }
  function hold(stage, exchange = 'binance') {
    const entered = deferred(), gate = deferred(); releases.push(gate.resolve);
    const handler = async (...args) => { entered.resolve(args); await gate.promise; return stage === 'verify' ? positions(exchange) : undefined; };
    if (stage === 'verify') verifyHandlers[exchange] = handler; else assetHandlers[stage] = handler;
    return { entered: entered.promise, release: gate.resolve };
  }
  async function connectOriginal(exchange = 'binance') {
    await app.trading.connect(exchange, { revision: stored(exchange).revision, ...credentials(`original_${exchange}`) });
    await app.trading.refresh(); return stored(exchange);
  }
  return { app, assetOrigin, catalog, secrets, calls, clientCalls, assetHandlers, verifyHandlers, dataDir, request, update, body, stored, hold, connectOriginal,
    async close() { await app.close(); closed = true; },
    revokeAssetSession() { loginCount++; },
  };
}

test('import HTTP routes require Hub login, same Origin, CSRF and JSON, and reject client credential or URL fields', async t => {
  const f = await fixture(t), input = await f.body(), before = f.calls.length;
  assert.equal((await f.request(SOURCES, { auth: false })).status, 401);
  assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input, auth: false })).status, 401);
  for (const options of [{ originHeader: 'https://other.example' }, { csrfHeader: '' }]) {
    assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input, ...options })).status, 403);
  }
  assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input, contentType: 'text/plain' })).status, 415);
  for (const rawBody of ['{', '[]', 'null']) assert.equal((await f.request(importRoute('binance'), { method: 'POST', rawBody })).status, 400);
  for (const body of [{ ...input, apiUrl: f.assetOrigin }, { ...input, password: ASSET_PASSWORD }, { ...input, apiKey: 'attacker_key' },
    { ...input, apiSecret: 'attacker_secret' }, { ...input, revision: '0' }, { ...input, revision: -1 }, { ...input, sourceRevision: 'short' },
    { ...input, projectRevision: null }, { ...input, projectId: '../asset' }, { ...input, projectRevision: undefined },
    ...[null, '', 'unified', 'Portfolio-Margin', true, {}].map(accountMode => ({ ...input, accountMode }))]) {
    assert.equal((await f.request(importRoute('binance'), { method: 'POST', body })).status, 400);
  }
  for (const accountMode of [null, 'standard', 'portfolio-margin', []]) {
    assert.equal((await f.request(importRoute('bybit'), { method: 'POST', body: { ...input, accountMode } })).status, 400);
  }
  assert.equal((await f.request(importRoute('aster'), { method: 'POST', body: input })).status, 404);
  assert.equal(f.calls.length, before); assert.equal(f.clientCalls.length, 0); assert.equal(f.stored().revision, 0);
});

test('real HTTP Asset imports all three exchanges through session and password export, sanitizes sources and encrypts copies', async t => {
  const f = await fixture(t);
  const privateDetail = 'provider-private-diagnostic';
  f.catalog.password = ASSET_PASSWORD;
  for (const row of f.catalog.connections) Object.assign(row, { apiKey: f.secrets[row.exchange].apiKey, apiSecret: f.secrets[row.exchange].apiSecret, reason: privateDetail });
  const listed = await f.request(SOURCES);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(listed.data.sources.map(row => row.projectId), ['asset']);
  assert.deepEqual(listed.data.sources[0].connections.map(row => row.label), exchanges.map(exchange => f.secrets[exchange].apiKey.slice(-4)));
  const responses = [listed];
  for (const exchange of exchanges) {
    const input = await f.body(exchange), accountMode = exchange === 'binance' ? 'portfolio-margin' : 'unified';
    if (exchange === 'binance') input.accountMode = accountMode;
    const response = await f.request(importRoute(exchange), { method: 'POST', body: input }); responses.push(response);
    assert.equal(response.status, 202, JSON.stringify(response.data));
    await f.app.trading.refresh();
    assert.equal(f.stored(exchange).revision, 1); assert.ok(f.stored(exchange).credentials);
    assert.equal(f.stored(exchange).account_mode, accountMode);
    assert.equal(response.data.accounts.find(row => row.exchange === exchange).accountMode, accountMode);
    assert.deepEqual(f.clientCalls.find(row => row.exchange === exchange && row.method === 'verify').secret, f.secrets[exchange]);
    assert.ok(f.clientCalls.filter(row => row.exchange === exchange).every(row => row.accountMode === accountMode));
    const exported = f.calls.find(row => row.route === CATALOG + '/export' && row.body.exchange === exchange);
    assert.deepEqual(exported.body, { exchange, revision: revisions[exchange], password: ASSET_PASSWORD });
    assert.match(exported.headers.cookie, /^asset_session=fixture-\d+$/);
    assert.equal(exported.headers.origin, f.assetOrigin); assert.equal(exported.headers['content-type'], 'application/json');
  }
  assert.equal(f.calls.filter(row => row.route === '/api/login').length, 1);
  assert.ok(f.calls.every(row => ['/api/login', CATALOG_READ, CATALOG + '/export'].includes(row.route)));
  assert.ok(f.clientCalls.every(row => ['verify', 'positions', 'funding'].includes(row.method)));
  responses.push(await f.request('/api/trading'), await f.request('/api/overview'));
  const sensitive = [ASSET_PASSWORD, privateDetail, ...Object.values(f.secrets).flatMap(Object.values)];
  for (const response of responses) for (const value of sensitive) assert.equal(JSON.stringify(response.data).includes(value), false);
  for (const filename of (await readdir(f.dataDir)).filter(name => /^hub\.sqlite/.test(name))) {
    const content = await readFile(path.join(f.dataDir, filename));
    for (const value of [ASSET_PASSWORD, ...Object.values(f.secrets).flatMap(Object.values)]) assert.equal(content.includes(Buffer.from(value)), false, filename);
  }
});

test('source discovery includes only enabled Asset projects and configured legal project IDs remain importable', async t => {
  const f = await fixture(t);
  for (const [id, adapter, enabled] of [['disabled-asset', 'asset', false], ['standard-source', 'standard', true], ['unconfigured-asset', 'asset', true]]) {
    const response = await f.request('/api/projects', { method: 'POST', body: { id, name: id, adapter, enabled, autoSync: false,
      ...(id !== 'unconfigured-asset' ? { apiUrl: f.assetOrigin, password: ASSET_PASSWORD } : {}) } }); assert.equal(response.status, 201);
  }
  const listed = await f.request(SOURCES);
  assert.deepEqual(listed.data.sources.map(row => [row.projectId, row.status]), [['asset', 'ready'], ['unconfigured-asset', 'unconfigured']]);
  for (const projectId of ['disabled-asset', 'standard-source', 'missing-source']) {
    const rejected = await f.request(importRoute('binance'), { method: 'POST', body: { ...(await f.body()), projectId } }); assert.equal(rejected.status, 409);
  }
  const legalId = '_Asset-' + 'X'.repeat(57);
  assert.equal(legalId.length, 64);
  assert.equal((await f.request('/api/projects', { method: 'POST', body: { id: legalId, name: 'Existing custom Asset', adapter: 'asset', autoSync: false,
    apiUrl: f.assetOrigin, password: ASSET_PASSWORD } })).status, 201);
  const imported = await f.request(importRoute('bybit'), { method: 'POST', body: await f.body('bybit', legalId) });
  assert.equal(imported.status, 202, JSON.stringify(imported.data));
});

test('legacy two-exchange Asset catalog remains importable and marks only OKX unsupported', async t => {
  const f = await fixture(t);
  f.catalog.connections = f.catalog.connections.filter(row => row.exchange !== 'okx');
  const listed = await f.request(SOURCES);
  assert.equal(listed.data.sources[0].status, 'ready');
  const okx = listed.data.sources[0].connections.find(row => row.exchange === 'okx');
  assert.equal(okx.configured, false); assert.equal(okx.supported, false); assert.equal(okx.revision, null);
  assert.match(okx.reason, /更新 Asset/);
  assert.equal((await f.request(importRoute('bybit'), { method: 'POST', body: await f.body('bybit') })).status, 202);
  const attempted = { ...(await f.body('binance')), sourceRevision: revisions.okx };
  assert.equal((await f.request(importRoute('okx'), { method: 'POST', body: attempted })).status, 409);
  assert.equal(f.calls.some(row => row.route === CATALOG + '/export' && row.body.exchange === 'okx'), false);
});

test('OKX import requires its Passphrase and never replaces a verified connection on malformed exports', async t => {
  const f = await fixture(t), previous = await f.connectOriginal('okx'), input = await f.body('okx');
  f.assetHandlers.export = () => ({ data: { schemaVersion: 1, exchange: 'okx', revision: revisions.okx, region: 'global', credentials: credentials('missing_passphrase') } });
  const failed = await f.request(importRoute('okx'), { method: 'POST', body: input });
  assert.equal(failed.status, 400); assert.deepEqual(f.stored('okx'), previous);
  assert.equal(f.clientCalls.filter(row => row.exchange === 'okx' && row.method === 'verify').length, 1);
});

test('old Asset, unsafe HTTP, malformed catalogs and non-global exports never replace the current account', async t => {
  for (const scenario of ['old-asset', 'unsafe-http', 'malformed-catalog', 'non-global', 'unsupported', 'bad-credentials']) await t.test(scenario, async t => {
    const f = await fixture(t), previous = await f.connectOriginal(), input = await f.body();
    if (scenario === 'old-asset') f.assetHandlers.catalog = () => ({ status: 404, data: { error: f.secrets.binance.apiSecret } });
    if (scenario === 'unsafe-http') {
      const project = await f.update({ apiUrl: 'http://192.0.2.1', password: ASSET_PASSWORD }); input.projectRevision = project.revision;
    }
    if (scenario === 'malformed-catalog') f.catalog.connections[0].label = f.secrets.binance.apiKey;
    if (scenario === 'non-global' || scenario === 'bad-credentials') f.assetHandlers.export = () => ({ data: { schemaVersion: 1, exchange: 'binance', revision: revisions.binance,
      region: scenario === 'non-global' ? 'eu' : 'global', credentials: scenario === 'bad-credentials' ? { apiKey: 'bad', apiSecret: 'bad' } : f.secrets.binance } });
    if (scenario === 'unsupported') Object.assign(f.catalog.connections[0], { configured: false, supported: false, revision: null, label: null, reason: f.secrets.binance.apiSecret });
    const response = await f.request(importRoute('binance'), { method: 'POST', body: input });
    assert.equal(response.status, scenario === 'unsupported' ? 409 : 400, JSON.stringify(response.data));
    assert.deepEqual(f.stored(), previous);
    assert.equal(f.clientCalls.filter(row => row.method === 'verify').length, 1);
    assert.equal(JSON.stringify(response.data).includes(f.secrets.binance.apiSecret), false);
    if (scenario === 'old-asset') assert.match(response.data.error, /更新 Asset/);
    if (scenario === 'unsafe-http') assert.match(response.data.error, /HTTPS|回环/);
  });
});

test('stale source, project and target revisions fail without overwriting the previous snapshot', async t => {
  const f = await fixture(t), previous = await f.connectOriginal(), input = await f.body();
  for (const change of [{ sourceRevision: 'c'.repeat(64) }, { projectRevision: 'd'.repeat(64) }, { revision: 0 }]) {
    const before = f.calls.length;
    const response = await f.request(importRoute('binance'), { method: 'POST', body: { ...input, ...change } });
    assert.equal(response.status, 409); assert.deepEqual(f.stored(), previous);
    if (!change.sourceRevision) assert.equal(f.calls.length, before);
  }
  f.assetHandlers.export = () => ({ status: 409, data: { error: 'source changed after catalog read' } });
  assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input })).status, 409);
  assert.deepEqual(f.stored(), previous); assert.equal(f.clientCalls.filter(row => row.method === 'verify').length, 1);
});

test('project changes after catalog/export reads and during verification prevent a late save', async t => {
  const scenarios = [['catalog', 'password'], ['export', 'password'], ['verify', 'password'], ['verify', 'address'], ['verify', 'disabled'], ['verify', 'deleted']];
  for (const [stage, mutation] of scenarios) await t.test(`${stage}: ${mutation}`, async t => {
    const f = await fixture(t), previous = await f.connectOriginal(), input = await f.body(), held = f.hold(stage);
    const importing = f.request(importRoute('binance'), { method: 'POST', body: input }); await held.entered;
    if (mutation === 'deleted') assert.equal((await f.request('/api/projects/asset', { method: 'DELETE' })).status, 200);
    else await f.update(mutation === 'password' ? { password: 'changed-fixture-password' } : mutation === 'disabled' ? { enabled: false } : { apiUrl: 'http://127.0.0.1:9' });
    held.release(); const response = await importing;
    assert.equal(response.status, 409, JSON.stringify(response.data)); assert.deepEqual(f.stored(), previous);
    assert.equal(f.clientCalls.filter(row => row.method === 'verify').length, stage === 'verify' ? 2 : 1);
  });
});

test('per-exchange import lock covers source reads, while disconnect cancels source or verification and late work cannot save', async t => {
  for (const stage of ['catalog', 'verify']) await t.test(stage, async t => {
    const f = await fixture(t), input = await f.body(), held = f.hold(stage);
    const importing = f.request(importRoute('binance'), { method: 'POST', body: input }); await held.entered;
    const count = f.calls.length;
    assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input })).status, 409);
    assert.equal(f.calls.length, count);
    assert.equal((await f.request('/api/trading/accounts/binance', { method: 'DELETE', body: { revision: 0 } })).status, 200);
    const cancelled = await importing; assert.equal(cancelled.status, 400); assert.match(cancelled.data.error, /取消/);
    const signal = f.clientCalls.find(row => row.method === 'verify')?.signal;
    if (stage === 'verify') assert.equal(signal.aborted, true);
    held.release(); await nextTurn(); await nextTurn();
    assert.equal(f.stored().revision, 1); assert.equal(f.stored().credentials, null); assert.equal(f.stored().snapshot, null);
    assert.equal(f.clientCalls.filter(row => row.method === 'funding').length, 0);
  });
});

test('exchange rejection retains encrypted credentials and snapshots; successful retry atomically replaces the account', async t => {
  const f = await fixture(t), previous = await f.connectOriginal(), input = await f.body();
  input.accountMode = 'portfolio-margin';
  assert.equal(previous.account_mode, 'standard');
  f.verifyHandlers.binance = async () => { throw new Error(`private provider rejection ${f.secrets.binance.apiKey} ${f.secrets.binance.apiSecret}`); };
  const failed = await f.request(importRoute('binance'), { method: 'POST', body: input });
  assert.equal(failed.status, 400); assert.deepEqual(f.stored(), previous);
  for (const value of Object.values(f.secrets.binance)) assert.equal(JSON.stringify(failed.data).includes(value), false);
  delete f.verifyHandlers.binance;
  const imported = await f.request(importRoute('binance'), { method: 'POST', body: input });
  assert.equal(imported.status, 202); await f.app.trading.refresh();
  const replaced = f.stored(); assert.equal(replaced.revision, previous.revision + 1); assert.notEqual(replaced.credentials, previous.credentials);
  assert.equal(replaced.account_mode, 'portfolio-margin');
  assert.equal(f.app.trading.state().legs[0].positions[0].quantity, '2');
});

test('expired Asset sessions are renewed, and export failures stay sanitized with the old account intact', async t => {
  const f = await fixture(t), previous = await f.connectOriginal(), input = await f.body();
  f.revokeAssetSession();
  const ready = await f.request(SOURCES); assert.equal(ready.data.sources[0].status, 'ready');
  assert.equal(f.calls.filter(row => row.route === '/api/login').length, 2);
  for (const status of [401, 403, 429, 500]) {
    f.assetHandlers.export = () => ({ status, data: { error: f.secrets.binance.apiSecret } });
    const response = await f.request(importRoute('binance'), { method: 'POST', body: input });
    assert.equal(response.status, status === 429 ? 429 : 400); assert.deepEqual(f.stored(), previous);
    assert.equal(JSON.stringify(response.data).includes(f.secrets.binance.apiSecret), false);
  }
});

test('import deadline bounds both source and exchange work, releases the lock, and ignores late completion', async t => {
  for (const stage of ['catalog', 'verify']) await t.test(stage, async t => {
    const f = await fixture(t, { tradingImportTimeoutMs: 100, tradingImportSourceTimeoutMs: 1000 });
    const previous = await f.connectOriginal(), input = await f.body(), held = f.hold(stage);
    const importing = f.request(importRoute('binance'), { method: 'POST', body: input }); await held.entered;
    const response = await importing; assert.equal(response.status, 400); assert.match(response.data.error, /超时/);
    assert.deepEqual(f.stored(), previous);
    if (stage === 'verify') assert.equal(f.clientCalls.filter(row => row.method === 'verify').at(-1).signal.aborted, true);
    held.release(); delete f.assetHandlers[stage]; delete f.verifyHandlers.binance; await nextTurn();
    assert.equal((await f.request(importRoute('binance'), { method: 'POST', body: input })).status, 202);
    assert.equal(f.stored().revision, previous.revision + 1);
  });
});

test('closing Hub cancels an import during source or exchange work before encrypted state can be saved', async t => {
  for (const stage of ['catalog', 'verify']) await t.test(stage, async t => {
    const f = await fixture(t), input = await f.body(), held = f.hold(stage);
    const importing = f.request(importRoute('binance'), { method: 'POST', body: input }); await held.entered;
    const closing = f.close(); const response = await importing; await closing;
    assert.equal(response.status, 400); assert.match(response.data.error, /取消/);
    held.release(); await nextTurn();
    assert.equal(f.stored().revision, 0); assert.equal(f.stored().credentials, null);
    if (stage === 'verify') assert.equal(f.clientCalls.find(row => row.method === 'verify').signal.aborted, true);
  });
});
