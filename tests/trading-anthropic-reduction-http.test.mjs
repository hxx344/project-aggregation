import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { subtract } from '../server/trading-execution-plan.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';

const TIME = Date.UTC(2026, 10, 7, 3), SYMBOL = 'ANTHROPICUSDT';
const PASSWORD = 'anthropic-reduction-http-fixture';
const PREFIX = '/api/trading/execution', ROUTE = `${PREFIX}/anthropic-reduction`;
const config = (overrides = {}) => ({ enabled: false,
  legs: [{ exchange: 'binance', symbol: SYMBOL, side: 'long' }, { exchange: 'okx', symbol: SYMBOL, side: 'short' }],
  shares: { outstanding: '3', diluted: '4' }, thresholdPercent: '5', reducePercent: '50', batchCount: 1, batchIntervalMs: 1000, timeoutMs: 60_000, ...overrides });
const credentials = exchange => ({ accountMode: exchange === 'okx' ? 'cross' : 'standard', apiKey: `fixture_${exchange}_key`, apiSecret: `fixture_${exchange}_secret`, ...(exchange === 'okx' ? { passphrase: 'fixture_passphrase' } : {}) });

async function fixture(t, { timers = false } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['setInterval'] });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hub-reduction-http-'));
  let session = null, serial = 0;
  const calls = [], readOnlyCalls = [], records = new Map();
  const accounts = Object.fromEntries(['binance', 'okx'].map((exchange, index) => [exchange, {
    identity: `fixture-${exchange}`, modes: { [SYMBOL]: 'hedge' }, openOrders: [], strategies: [],
    positions: [{ symbol: SYMBOL, side: index ? 'short' : 'long', quantity: index ? '30' : '10',
      risk: { markPrice: '100', liquidationPrice: index ? '150' : '95', at: new Date(TIME).toISOString() } }],
  }]));
  const executionClientFactory = exchange => ({
    verify: async () => { calls.push({ exchange, method: 'verify' }); return { identity: accounts[exchange].identity }; },
    account: async () => { calls.push({ exchange, method: 'account' }); return structuredClone(accounts[exchange]); },
    market: async symbol => ({ symbol, bid: '100', ask: '100.01', at: new Date(TIME).toISOString(), rule: {
      tickSize: '0.01', quantityStep: '0.1', minQuantity: '0.1', maxQuantity: '1000', maxMarketQuantity: '1000', minNotional: '5', maxNotional: null, contractSize: '1',
    } }),
    create: async (_secret, spec, options) => {
      options.beforeMutation(); calls.push({ exchange, method: 'create', spec });
      const id = String(++serial);
      records.set(id, { ...spec, exchange, id, kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '100', createdAt: new Date(TIME).toISOString() });
      return { id, kind: 'order' };
    },
    inspect: async (_secret, spec) => {
      const record = spec.id ? records.get(spec.id) : [...records.values()].find(row => row.clientId === spec.clientId);
      if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
      return structuredClone(record);
    },
    stop: async (_secret, spec, options) => {
      options.beforeMutation(); calls.push({ exchange, method: 'stop' });
      Object.assign(records.get(spec.id), { status: 'terminal', terminal: true, childrenSettled: true });
    },
  });
  const tradingClientFactory = exchange => Object.fromEntries(['verify', 'positions', 'funding'].map(method => [method, async (_secret, options) => {
    readOnlyCalls.push({ exchange, method });
    return method === 'funding' ? { fetchedAt: new Date(TIME).toISOString(), events: [], coverage: [{ start: options.start, end: options.end }], complete: true, error: null }
      : { fetchedAt: new Date(TIME).toISOString(), positions: [] };
  }]));
  const app = await createApp({ dataDir, initialPassword: PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: timers ? 1000 : 0, executionNow: () => TIME, tradingNow: () => TIME,
    executionClientFactory, tradingClientFactory, secureCookies: false, publicOrigin: '',
    summaryReader: async () => ({ updatedAt: new Date(TIME).toISOString(), metrics: [], message: 'fixture' }),
    assetSyncReader: async () => { throw new Error('Unexpected fixture asset read'); }, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    if (timers) t.mock.timers.reset();
    const target = path.resolve(dataDir);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('hub-reduction-http-'));
    await rm(target, { recursive: true, force: true });
  });
  async function request(route = ROUTE, { method = 'GET', body, auth = true, originHeader = origin, csrfHeader = session?.csrf } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(auth && session ? { Cookie: session.cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}),
      ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const result = await request('/api/login', { method: 'POST', body: { password: PASSWORD }, auth: false });
    assert.equal(result.status, 200); session = { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.data.csrfToken };
  }
  async function connect(prefix = PREFIX) {
    for (const exchange of ['binance', 'okx']) {
      const result = await request(`${prefix}/accounts/${exchange}`, { method: 'PUT', body: { revision: 0, ...credentials(exchange), ...(prefix !== PREFIX && exchange === 'okx' ? { accountMode: 'unified' } : {}) } });
      assert.equal(result.status, prefix === PREFIX ? 200 : 202, JSON.stringify(result.data));
    }
    if (prefix !== PREFIX) await app.trading.refresh();
  }
  function rows(sql) {
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  }
  return { app, request, login, connect, calls, readOnlyCalls, records, rows,
    get creates() { return calls.filter(row => row.method === 'create'); },
    async save(overrides = {}, extra = {}) {
      const state = await request();
      return request(ROUTE, { method: 'PUT', body: { revision: state.data.revision, config: config(overrides), ...extra } });
    },
    fill() {
      for (const record of records.values()) {
        accounts[record.exchange].positions[0].quantity = subtract(accounts[record.exchange].positions[0].quantity, subtract(record.quantity, record.filledQuantity));
        Object.assign(record, { filledQuantity: record.quantity, status: 'terminal', terminal: true, childrenSettled: true });
      }
    },
    async pulse() { t.mock.timers.tick(15_000); await new Promise(resolve => setImmediate(resolve)); return request(); },
  };
}

test('reduction HTTP reads and writes require a session; writes require same Origin and CSRF', async t => {
  const f = await fixture(t), mutations = [[ROUTE, 'PUT'], [`${ROUTE}/disable`, 'POST']];
  for (const [route, method] of [[ROUTE, 'GET'], ...mutations]) {
    assert.equal((await f.request(route, { method, ...(method === 'GET' ? {} : { body: {} }) })).status, 401);
  }
  await f.login();
  for (const [route, method] of mutations) for (const options of [{ originHeader: 'https://other.example' }, { originHeader: '' }, { csrfHeader: '' }, { csrfHeader: 'incorrect' }]) {
    assert.equal((await f.request(route, { method, body: {}, ...options })).status, 403);
  }
  const result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.state.phase, 'disabled'); assert.equal(result.data.config, null);
  assert.equal(f.calls.length, 0); assert.equal(f.readOnlyCalls.length, 0);
});

test('HTTP rejects invalid parameters and injected account risk without altering the durable revision', async t => {
  const f = await fixture(t); await f.login();
  for (const patch of [{ thresholdPercent: '0' }, { thresholdPercent: '100.0001' }, { reducePercent: '101' }, { reducePercent: 50 },
    { batchCount: 0 }, { batchCount: 1.5 }, { batchIntervalMs: -1 }, { batchCount: 3, batchIntervalMs: 30_000, timeoutMs: 60_000 },
    { legs: [config().legs[0]] }, { risk: { markPrice: '100', liquidationPrice: '100' } },
    { legs: config().legs.map(leg => ({ ...leg, risk: { markPrice: '100', liquidationPrice: '100' } })) }]) {
    const response = await f.save(patch);
    assert.equal(response.status, 400, JSON.stringify(patch));
  }
  for (const extra of [{ snapshot: { positions: [] } }, { accounts: { binance: { identity: 'injected', revision: 0 } } }, { live: { met: true } }]) {
    assert.equal((await f.save({}, extra)).status, 400);
  }
  assert.equal((await f.request(`${ROUTE}?risk=0`)).status, 400);
  assert.equal((await f.request(ROUTE, { method: 'POST', body: {} })).status, 405);
  assert.equal((await f.request(`${ROUTE}/disable`, { method: 'POST', body: { revision: 0, snapshot: {} } })).status, 400);
  assert.equal((await f.request()).data.revision, 0); assert.equal(f.rows('SELECT * FROM execution_jobs').length, 0);
  assert.equal(f.calls.length, 0);
});

test('a read-only watch connection cannot enable live reduction, and saves never perform exchange reads', async t => {
  const f = await fixture(t); await f.login(); await f.connect('/api/trading');
  assert.ok(f.readOnlyCalls.length > 0);
  const before = f.readOnlyCalls.length;
  assert.equal((await f.save({ enabled: true })).status, 400, 'live confirmation is required');
  const rejected = await f.save({ enabled: true }, { confirmLive: true });
  assert.equal(rejected.status, 409); assert.match(rejected.data.error, /核验实盘账户/);
  const saved = await f.save(); assert.equal(saved.status, 200); assert.equal(saved.data.state.phase, 'disabled');
  assert.equal(f.calls.length, 0); assert.equal(f.readOnlyCalls.length, before);
});

test('HTTP saves and disables use optimistic revisions with verified execution connections', async t => {
  const f = await fixture(t); await f.login(); await f.connect(); const before = f.calls.length;
  const enabled = await f.save({ enabled: true }, { confirmLive: true });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.state.phase, 'armed');
  assert.equal(f.calls.length, before, 'save binds existing verified credentials without reading exchanges');
  assert.equal((await f.request(ROUTE, { method: 'PUT', body: { revision: 0, config: config() } })).status, 409);
  assert.equal((await f.request(`${ROUTE}/disable`, { method: 'POST', body: { revision: 0 } })).status, 409);
  const disabled = await f.request(`${ROUTE}/disable`, { method: 'POST', body: { revision: enabled.data.revision } });
  assert.equal(disabled.status, 200); assert.equal(disabled.data.state.phase, 'disabled'); assert.equal(disabled.data.config.enabled, false);
  assert.equal(disabled.data.revision, enabled.data.revision + 1); assert.equal(f.creates.length, 0);
});

test('the real app timer consumes HTTP configuration and completes one live reduction task', async t => {
  const f = await fixture(t, { timers: true }); await f.login(); await f.connect();
  const enabled = await f.save({ enabled: true }, { confirmLive: true }); assert.equal(enabled.status, 200);
  const triggered = await f.pulse();
  assert.equal(triggered.data.state.phase, 'reducing'); assert.equal(triggered.data.job.action, 'close');
  assert.equal(f.rows('SELECT * FROM execution_jobs').length, 1);
  assert.equal(f.rows('SELECT * FROM execution_entries').length, 0);
  assert.equal((await f.save()).status, 409, 'an unfinished linked task cannot be overwritten');
  await f.app.execution.tick(); assert.equal(f.creates.length, 2);
  assert.deepEqual(f.creates.map(row => [row.exchange, row.spec.quantity]), [['binance', '5'], ['okx', '15']]);
  f.fill(); await f.app.execution.tick(); const completed = await f.pulse();
  assert.equal(completed.data.state.phase, 'completed'); assert.equal(completed.data.config.enabled, false);
  assert.equal(completed.data.job.status, 'completed'); assert.equal(completed.data.job.id, triggered.data.job.id);
  await f.pulse(); assert.equal(f.creates.length, 2); assert.equal(f.readOnlyCalls.length, 0);
});
