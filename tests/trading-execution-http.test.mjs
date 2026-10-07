import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';

const INITIAL_TIME = Date.UTC(2026, 9, 7, 12);
const PASSWORD = 'execution-http-fixture-password';
const PREFIX = '/api/trading/execution';
const credentials = suffix => ({ apiKey: `fixture_key_sensitive_${suffix}`, apiSecret: `fixture_secret_sensitive_${suffix}` });
const stamp = time => new Date(time).toISOString();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const leg = (exchange, symbol, side) => ({ exchange, symbol, side, quantity: '2', stopPrice: side === 'long' ? '90' : '50' });
function intent(preset = 'cross-exchange') {
  const legs = preset === 'same-exchange'
    ? [leg('binance', 'CLUSDT', 'long'), leg('binance', 'BZUSDT', 'short')]
    : [leg('binance', 'CLUSDT', 'long'), leg('bybit', 'CLUSDT', 'short')];
  if (preset === 'four-leg') legs.push(leg('binance', 'BZUSDT', 'short'), leg('bybit', 'BZUSDT', 'long'));
  return { preset, action: 'open', legs, batchCount: 2, batchIntervalMs: 1000, repriceIntervalMs: 1000, timeoutMs: 60_000 };
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-execution-http-'));
  let clock = INITIAL_TIME, currentSession = null, serial = 0;
  const calls = [], readOnlyCalls = [], records = new Map(), handlers = {};
  const accounts = Object.fromEntries(['binance', 'bybit'].map(exchange => [exchange, {
    identity: exchange === 'bybit' ? 'fixture-uid' : null,
    modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [],
  }]));
  const market = symbol => ({ symbol, bid: '70', ask: '70.01', at: stamp(clock),
    rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } });
  const executionClientFactory = exchange => Object.fromEntries(['verify', 'account', 'market', 'create', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity };
    if (method === 'account') return structuredClone(accounts[exchange]);
    if (method === 'market') return market(args[0]);
    const spec = args[1];
    if (method === 'create') {
      args[2].beforeMutation();
      const id = String(++serial), record = { ...spec, id, kind: exchange === 'bybit' ? 'strategy' : 'order',
        status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '70', averagePrice: null, createdAt: stamp(clock) };
      records.set(id, record); return { id, kind: record.kind };
    }
    const record = spec.id ? records.get(spec.id) : [...records.values()].find(row => row.clientId === spec.clientId);
    if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
    if (method === 'inspect') return structuredClone(record);
    args[2].beforeMutation();
    Object.assign(record, { status: 'terminal', terminal: true, childrenSettled: true });
  }]));
  const tradingClientFactory = exchange => Object.fromEntries(['verify', 'positions', 'funding'].map(method => [method, async (secret, options) => {
    readOnlyCalls.push({ exchange, method, secret, options });
    return method === 'funding'
      ? { fetchedAt: stamp(clock), events: [], coverage: [{ start: options.start, end: options.end }], complete: true, error: null }
      : { fetchedAt: stamp(clock), positions: [] };
  }]));
  const app = await createApp({ dataDir, initialPassword: PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, tradingClientFactory, executionClientFactory,
    executionNow: () => clock, tradingNow: () => clock, secureCookies: false, publicOrigin: '',
    summaryReader: async () => ({ updatedAt: stamp(clock), metrics: [], message: 'fixture' }),
    assetSyncReader: async () => { throw new Error('Unexpected asset fixture call'); }, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    const target = path.resolve(dataDir), temp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), temp); assert.ok(path.basename(target).startsWith('hub-execution-http-'));
    await rm(target, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, rawBody, session = currentSession, auth = true,
    originHeader = origin, csrfHeader = session?.csrf, contentType = 'application/json' } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(auth && session ? { Cookie: session.cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}),
      ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}),
      ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': contentType } : {}),
    }, ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { password: PASSWORD }, auth: false });
    assert.equal(response.status, 200);
    currentSession = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.data.csrfToken };
    return currentSession;
  }
  function rows(sql, ...parameters) {
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare(sql).all(...parameters); } finally { db.close(); }
  }
  async function connect(exchange, secret = credentials(exchange)) {
    const revision = app.execution.state().connections.find(row => row.exchange === exchange).revision;
    const response = await request(`${PREFIX}/accounts/${exchange}`, { method: 'PUT', body: {
      revision, accountMode: exchange === 'binance' ? 'standard' : 'unified', ...secret,
    } });
    assert.equal(response.status, 200); return response;
  }
  async function connectBoth() { for (const exchange of ['binance', 'bybit']) await connect(exchange); }
  async function preview(body = intent(), options = {}) {
    const response = await request(`${PREFIX}/preview`, { method: 'POST', body, ...options });
    assert.equal(response.status, 200); return response.data;
  }
  return { app, calls, readOnlyCalls, handlers, accounts, records, rows, dataDir, request, login, connect, connectBoth, preview,
    advance: amount => { clock += amount; }, get now() { return clock; },
    get mutations() { return calls.filter(call => ['create', 'stop'].includes(call.method)); },
    get creates() { return calls.filter(call => call.method === 'create'); },
  };
}

test('execution HTTP routes require a session, same Origin and CSRF; state GET performs no exchange calls', async t => {
  const f = await fixture(t), job = randomUUID();
  const mutations = [[`${PREFIX}/accounts/binance`, 'PUT'], [`${PREFIX}/accounts/bybit`, 'DELETE'],
    [`${PREFIX}/preview`, 'POST'], [`${PREFIX}/jobs`, 'POST'], [`${PREFIX}/jobs/${job}/stop`, 'POST'], [`${PREFIX}/jobs/${job}/reconcile`, 'POST']];
  for (const [route, method] of [[PREFIX, 'GET'], ...mutations]) {
    assert.equal((await f.request(route, { method, ...(method === 'GET' ? {} : { body: {} }) })).status, 401);
  }
  await f.login();
  for (const [route, method] of mutations) {
    assert.equal((await f.request(route, { method, body: {}, originHeader: 'https://other.example' })).status, 403);
    assert.equal((await f.request(route, { method, body: {}, originHeader: '' })).status, 403);
    assert.equal((await f.request(route, { method, body: {}, csrfHeader: '' })).status, 403);
    assert.equal((await f.request(route, { method, body: {}, csrfHeader: 'incorrect-token' })).status, 403);
  }
  const state = await f.request(PREFIX);
  assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.deepEqual(state.data.jobs, []);
  assert.ok(state.data.connections.every(row => !row.connected));
  assert.equal(f.calls.length, 0); assert.equal(f.readOnlyCalls.length, 0);
});

test('execution HTTP rejects market-order fields, injected internal options and malformed JSON before exchange reads', async t => {
  const f = await fixture(t); await f.login();
  for (const body of [{ ...intent(), orderType: 'MARKET' }, { ...intent(), type: 'MARKET' },
    { ...intent(), legs: intent().legs.map(row => ({ ...row, orderType: 'MARKET' })) },
    { ...intent(), beforeMutation: 'user-controlled' }]) {
    assert.equal((await f.request(`${PREFIX}/preview`, { method: 'POST', body })).status, 400);
  }
  const connection = { revision: 0, accountMode: 'standard', ...credentials('injection'), beforeMutation: 'user-controlled' };
  assert.equal((await f.request(`${PREFIX}/accounts/binance`, { method: 'PUT', body: connection })).status, 400);
  assert.equal((await f.request(`${PREFIX}/preview`, { method: 'POST', rawBody: '{}', contentType: 'text/plain' })).status, 415);
  assert.equal((await f.request(`${PREFIX}/preview`, { method: 'POST', rawBody: '{' })).status, 400);
  assert.equal((await f.request(`${PREFIX}/preview`, { method: 'POST', body: [] })).status, 400);
  assert.equal((await f.request(`${PREFIX}/order`, { method: 'POST', body: {} })).status, 404);
  assert.equal(f.calls.length, 0); assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0);
});

test('live HTTP credentials use AES-GCM, expose only the key suffix and leave read-only trading accounts unchanged', async t => {
  const f = await fixture(t); await f.login();
  const readOnly = credentials('readonly_OLD1'), live = credentials('execution_NEW2');
  const oldConnection = await f.request('/api/trading/accounts/binance', { method: 'PUT', body: { revision: 0, accountMode: 'standard', ...readOnly } });
  assert.equal(oldConnection.status, 202); await f.app.trading.refresh();
  const oldRows = f.rows('SELECT * FROM trading_accounts'), oldState = (await f.request('/api/trading')).data;
  const oldCalls = f.readOnlyCalls.length;
  const connected = await f.connect('binance', live);
  const liveConnection = connected.data.connections.find(row => row.exchange === 'binance');
  assert.equal(liveConnection.keyLabel, 'NEW2'); assert.equal(liveConnection.revision, 1); assert.equal(liveConnection.connected, true);
  const row = f.rows('SELECT * FROM execution_accounts WHERE exchange=?', 'binance')[0];
  const key = await readFile(path.join(f.dataDir, 'credentials.key')), encrypted = Buffer.from(row.credentials, 'base64');
  assert.equal(key.length, 32); assert.ok(encrypted.length > 28);
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  const decrypted = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString());
  assert.deepEqual(decrypted, { purpose: 'execution', exchange: 'binance', ...live });
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
  const invalid = createDecipheriv('aes-256-gcm', key, tampered.subarray(0, 12)); invalid.setAuthTag(tampered.subarray(12, 28));
  invalid.update(tampered.subarray(28)); assert.throws(() => invalid.final());
  const state = await f.request(PREFIX), unchanged = await f.request('/api/trading'), overview = await f.request('/api/overview');
  assert.equal(unchanged.data.mode, 'read-only'); assert.deepEqual(unchanged.data, oldState);
  assert.deepEqual(f.rows('SELECT * FROM trading_accounts'), oldRows); assert.equal(f.readOnlyCalls.length, oldCalls);
  for (const response of [connected, state, unchanged, overview]) {
    const serialized = JSON.stringify(response.data);
    for (const value of [...Object.values(live), ...Object.values(readOnly)]) assert.equal(serialized.includes(value), false);
  }
  for (const filename of (await readdir(f.dataDir)).filter(name => /^hub\.sqlite/.test(name))) {
    const bytes = await readFile(path.join(f.dataDir, filename));
    for (const value of [...Object.values(live), ...Object.values(readOnly)]) assert.equal(bytes.includes(Buffer.from(value)), false, filename);
  }
  const executionReads = f.calls.length;
  assert.equal((await f.request('/api/trading/accounts/binance', { method: 'DELETE', body: { revision: 1 } })).status, 200);
  assert.deepEqual(f.rows('SELECT * FROM execution_accounts WHERE exchange=?', 'binance')[0], row);
  assert.equal(f.calls.length, executionReads); assert.equal(f.mutations.length, 0);
});

test('HTTP previews support all three presets, expire after 30 seconds and never submit an order', async t => {
  const f = await fixture(t); await f.login(); await f.connectBoth();
  for (const preset of ['cross-exchange', 'same-exchange', 'four-leg']) {
    const value = await f.preview(intent(preset));
    assert.equal(value.preset, preset); assert.equal(value.legs.length, preset === 'four-leg' ? 4 : 2);
    assert.equal(value.expiresAt, stamp(f.now + 30_000)); assert.equal(value.batchCount, 2);
    assert.ok(value.legs.every(row => row.quantity === '2' && row.batchQuantities.join(',') === '1,1'));
  }
  assert.equal(f.rows('SELECT * FROM execution_previews').length, 3);
  assert.equal(f.mutations.length, 0); assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0);
  const preview = await f.preview(); f.advance(30_000);
  const before = f.calls.length;
  const response = await f.request(`${PREFIX}/jobs`, { method: 'POST', body: { previewId: preview.id, requestId: randomUUID(), confirmLive: true } });
  assert.equal(response.status, 409); assert.equal(f.calls.length, before);
  assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0);
  assert.equal(f.rows('SELECT consumed FROM execution_previews WHERE id=?', preview.id)[0].consumed, null);
});

test('HTTP confirmation is session-bound and one-use; duplicate requests enqueue only one job and reads never execute it', async t => {
  const f = await fixture(t), sessionA = await f.login(); await f.connectBoth();
  const preview = await f.preview(), another = await f.preview(), requestId = randomUUID();
  const body = { previewId: preview.id, requestId, confirmLive: true };
  const sessionB = await f.login(), before = f.calls.length;
  assert.equal((await f.request(`${PREFIX}/jobs`, { method: 'POST', body, session: sessionB })).status, 409);
  for (const invalid of [{ previewId: preview.id, requestId }, { ...body, confirmLive: false }, { ...body, confirmLive: 'true' },
    { ...body, requestId: 'invalid' }, { ...body, orderType: 'MARKET' }]) {
    assert.equal((await f.request(`${PREFIX}/jobs`, { method: 'POST', body: invalid, session: sessionA })).status, 400);
  }
  const submitted = await Promise.all([1, 2].map(() => f.request(`${PREFIX}/jobs`, { method: 'POST', body, session: sessionA })));
  assert.ok(submitted.every(response => response.status === 202 && response.data.jobs.length === 1));
  const jobId = submitted[0].data.jobs[0].id;
  assert.equal(submitted[1].data.jobs[0].id, jobId); assert.equal(f.rows('SELECT * FROM execution_jobs').length, 1);
  assert.equal(f.rows('SELECT * FROM execution_requests').length, 1);
  assert.equal((await f.request(`${PREFIX}/jobs`, { method: 'POST', body: { ...body, requestId: randomUUID() }, session: sessionA })).status, 409);
  assert.equal((await f.request(`${PREFIX}/jobs`, { method: 'POST', body: { ...body, previewId: another.id }, session: sessionA })).status, 409);
  for (const route of [PREFIX, '/api/trading', '/api/overview']) assert.equal((await f.request(route)).status, 200);
  assert.equal(f.calls.length, before); assert.equal(f.creates.length, 0);
  await f.app.execution.tick();
  assert.equal(f.creates.length, 2);
  const afterTick = f.calls.length;
  for (const route of [PREFIX, '/api/trading', '/api/overview', PREFIX]) assert.equal((await f.request(route)).status, 200);
  assert.equal(f.calls.length, afterTick); assert.equal(f.creates.length, 2);
  assert.equal(f.app.execution.state().jobs[0].status, 'running');
});

test('HTTP stop cancels only remaining orders and preserves filled quantities without issuing a close order', async t => {
  const f = await fixture(t); await f.login(); await f.connectBoth();
  const preview = await f.preview(), body = { previewId: preview.id, requestId: randomUUID(), confirmLive: true };
  const started = await f.request(`${PREFIX}/jobs`, { method: 'POST', body }); assert.equal(started.status, 202);
  const id = started.data.jobs[0].id; await f.app.execution.tick();
  const remote = [...f.records.values()]; assert.equal(remote.length, 2);
  remote[0].filledQuantity = '0.375'; remote[1].filledQuantity = '0.125';
  const before = f.calls.length;
  assert.equal((await f.request(`${PREFIX}/jobs/${id}/stop`, { method: 'POST', body: { orderType: 'MARKET' } })).status, 400);
  const stopped = await f.request(`${PREFIX}/jobs/${id}/stop`, { method: 'POST', body: {} });
  assert.equal(stopped.status, 200); assert.equal(stopped.data.jobs[0].status, 'stopping'); assert.equal(f.calls.length, before);
  await f.app.execution.tick();
  const state = await f.request(PREFIX), job = state.data.jobs[0];
  assert.equal(job.status, 'stopped'); assert.equal(f.creates.length, 2);
  assert.deepEqual(job.legs.map(row => row.filledQuantity), ['0.375', '0.125']);
  assert.deepEqual(job.legs.map(row => row.remainingQuantity), ['1.625', '1.875']);
  assert.ok(remote.every(row => row.terminal && row.childrenSettled));
  assert.equal(f.calls.filter(call => call.method === 'stop').length, 2);
  assert.ok(f.creates.every(call => call.args[1].reduceOnly === false));
  const after = f.calls.length;
  assert.equal((await f.request(`${PREFIX}/jobs/${id}/stop`, { method: 'POST', body: {} })).status, 200);
  await f.app.execution.tick(); assert.equal(f.calls.length, after);
});

test('existing bodyless POST logout invalidates later live confirmation without submitting a job', async t => {
  const f = await fixture(t), session = await f.login(); await f.connectBoth();
  const preview = await f.preview(), before = f.calls.length;
  const logout = await f.request('/api/logout', { method: 'POST' });
  assert.equal(logout.status, 200); assert.deepEqual(logout.data, { ok: true });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const response = await f.request(`${PREFIX}/jobs`, { method: 'POST', session,
    body: { previewId: preview.id, requestId: randomUUID(), confirmLive: true } });
  assert.equal(response.status, 401); assert.equal((await f.request(PREFIX, { session })).status, 401);
  assert.equal(f.calls.length, before); assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0);
  assert.equal(f.rows('SELECT consumed FROM execution_previews WHERE id=?', preview.id)[0].consumed, null);
});

test('logout while preview awaits an exchange read returns 401 and stores no preview', async t => {
  const f = await fixture(t); await f.login(); await f.connectBoth();
  const entered = deferred(), release = deferred();
  f.handlers['bybit:account'] = async () => { entered.resolve(); await release.promise; return structuredClone(f.accounts.bybit); };
  const pending = f.request(`${PREFIX}/preview`, { method: 'POST', body: intent() });
  try {
    await entered.promise;
    assert.equal((await f.request('/api/logout', { method: 'POST' })).status, 200);
  } finally { release.resolve(); }
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(f.rows('SELECT * FROM execution_previews').length, 0);
  assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0); assert.equal(f.mutations.length, 0);
});

test('logout while connection verification is pending prevents credential persistence', async t => {
  const f = await fixture(t); await f.login();
  const entered = deferred(), release = deferred(), secret = credentials('pending_save');
  const before = f.rows('SELECT * FROM execution_accounts WHERE exchange=?', 'binance')[0];
  f.handlers['binance:account'] = async () => { entered.resolve(); await release.promise; return structuredClone(f.accounts.binance); };
  const pending = f.request(`${PREFIX}/accounts/binance`, { method: 'PUT', body: { revision: 0, accountMode: 'standard', ...secret } });
  try {
    await entered.promise;
    assert.equal((await f.request('/api/logout', { method: 'POST' })).status, 200);
  } finally { release.resolve(); }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.deepEqual(f.rows('SELECT * FROM execution_accounts WHERE exchange=?', 'binance')[0], before);
  assert.equal(f.mutations.length, 0);
  for (const value of Object.values(secret)) assert.equal(JSON.stringify(response.data).includes(value), false);
});
