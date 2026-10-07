import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';

const DAY = 86_400_000;
const INITIAL_TIME = Date.UTC(2025, 1, 7, 16);
const PASSWORD = 'runtime-fixture-password';
const credentials = (suffix = 'original') => ({ apiKey: `fixture_api_key_${suffix}`, apiSecret: `fixture_api_secret_${suffix}` });
const stamp = time => new Date(time).toISOString();
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function position(exchange, symbol = 'CLUSDT', side = 'long', overrides = {}) {
  return { id: `${exchange}:${symbol}:${side}`, exchange, symbol, side, mode: 'one-way', quantity: '2',
    entryPrice: '70', markPrice: '71', notional: '142', unrealizedPnl: side === 'long' ? '2' : '-2',
    leverage: '2', liquidationPrice: null, sourceUpdatedAt: stamp(INITIAL_TIME - DAY), ...overrides };
}
function receipt(exchange, id, amount, time, symbol = 'CLUSDT') {
  return { exchange, id, amount, time: stamp(time), symbol, currency: 'USDT' };
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-trading-runtime-'));
  let clock = INITIAL_TIME, cookie = '', csrf = '', app, origin, closed = false;
  const calls = [], handlers = { binance: {}, bybit: {} };
  const rows = {
    binance: [position('binance', 'CLUSDT', 'long'), position('binance', 'BZUSDT', 'short')],
    bybit: [position('bybit', 'CLUSDT', 'short'), position('bybit', 'BZUSDT', 'long')],
  };
  const clientFactory = exchange => Object.fromEntries(['verify', 'positions', 'funding'].map(method => [method, async (secret, options) => {
    calls.push({ exchange, method, secret, ...options });
    if (handlers[exchange][method]) return handlers[exchange][method](secret, options);
    return method === 'funding'
      ? { fetchedAt: stamp(clock), events: [], coverage: [{ start: options.start, end: options.end }], complete: true, error: null }
      : { fetchedAt: stamp(clock), positions: rows[exchange] };
  }]));
  const options = { dataDir, initialPassword: PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, tradingClientFactory: clientFactory, tradingNow: () => clock,
    summaryReader: async () => ({ updatedAt: stamp(clock), metrics: [], message: 'fixture' }), logger: () => {}, ...overrides };
  async function open() {
    app = await createApp(options);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
    closed = false;
  }
  await open();
  t.after(async () => { if (!closed) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, rawBody, auth = true, originHeader = origin, csrfHeader = csrf, contentType = 'application/json' } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': contentType } : {}),
        ...(auth && cookie ? { Cookie: cookie } : {}), ...(originHeader ? { Origin: originHeader } : {}),
        ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}) },
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = response.data.csrfToken;
  }
  async function connect(exchange, secret = credentials(exchange)) {
    await app.trading.connect(exchange, { revision: app.trading.state().accounts.find(row => row.exchange === exchange).revision, ...secret });
    await app.trading.refresh();
  }
  function stored(exchange) {
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM trading_accounts WHERE exchange=?').get(exchange); } finally { db.close(); }
  }
  return { get app() { return app; }, get now() { return clock; }, get origin() { return origin; },
    advance: amount => { clock += amount; }, rows, handlers, calls, request, login, connect, stored, dataDir,
    async reopen() { if (!closed) await app.close(); closed = true; await open(); },
    async close() { await app.close(); closed = true; },
  };
}

test('private trading routes require login, Origin, CSRF and JSON; disconnected state performs no account reads', async t => {
  const f = await fixture(t);
  for (const [route, method] of [['/api/trading', 'GET'], ['/api/trading/refresh', 'POST'], ['/api/trading/accounts/binance', 'PUT'], ['/api/trading/accounts/binance', 'DELETE']]) {
    assert.equal((await f.request(route, { method, ...(method !== 'GET' ? { body: {} } : {}) })).status, 401);
  }
  await f.login();
  for (const [route, method] of [['/api/trading/refresh', 'POST'], ['/api/trading/accounts/binance', 'PUT'], ['/api/trading/accounts/binance', 'DELETE']]) {
    assert.equal((await f.request(route, { method, body: {}, originHeader: 'https://other.example' })).status, 403);
    assert.equal((await f.request(route, { method, body: {}, csrfHeader: '' })).status, 403);
  }
  assert.equal((await f.request('/api/trading/refresh', { method: 'POST', rawBody: '{}', contentType: 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/trading/refresh', { method: 'POST', rawBody: '{' })).status, 400);
  assert.equal((await f.request('/api/trading/refresh', { method: 'POST', body: [] })).status, 400);
  assert.equal((await f.request('/api/trading/refresh', { method: 'POST', body: { oversized: 'x'.repeat(33000) } })).status, 413);
  for (const route of ['/api/trading/order', '/api/trading/leverage', '/api/trading/transfer', '/api/trading/accounts/unknown']) {
    assert.equal((await f.request(route, { method: 'POST', body: {} })).status, 404);
  }
  assert.equal((await f.request('/api/trading?days=8')).status, 400);
  assert.equal((await f.request('/api/trading/refresh', { method: 'POST', body: {} })).status, 202);
  await f.app.trading.refresh();
  const response = await f.request('/api/trading');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.data.mode, 'read-only');
  assert.equal(response.data.legs.length, 4);
  assert.ok(response.data.legs.every(row => row.state === 'unconfigured' && row.grossNotional === null && row.fundingNet === null));
  assert.equal(response.data.structure.state, 'unknown');
  assert.equal(response.data.funding.net, null);
  assert.equal(response.data.funding.complete, false);
  assert.deepEqual(response.data.accounts.map(row => [row.exchange, row.accountMode]), [['binance', 'standard'], ['bybit', 'unified']]);
  assert.equal(f.calls.length, 0);
});

test('connection API encrypts credentials and a failed mode switch preserves the verified account and funding ledger', async t => {
  const f = await fixture(t); await f.login();
  const secret = credentials('sensitive_original');
  f.handlers.binance.funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [receipt('binance', 'original-ledger', '0.1', end - 1)], coverage: [{ start, end }], complete: true });
  const response = await f.request('/api/trading/accounts/binance', { method: 'PUT', body: { revision: 0, ...secret } });
  assert.equal(response.status, 202); await f.app.trading.refresh();
  const previous = f.stored('binance');
  assert.equal(previous.revision, 1); assert.ok(previous.credentials);
  f.handlers.binance.verify = async () => { throw new Error(`transport exposed ${secret.apiSecret} ${secret.apiKey}`); };
  const failed = await f.request('/api/trading/accounts/binance', { method: 'PUT', body: { revision: 1, accountMode: 'portfolio-margin', ...credentials('replacement') } });
  assert.equal(failed.status, 400);
  assert.deepEqual(f.stored('binance'), previous);
  assert.equal(f.app.trading.state().accounts[0].accountMode, 'standard');
  assert.equal(f.app.trading.state().funding.events[0].id, 'original-ledger');
  assert.equal(f.calls.filter(row => row.method === 'verify').at(-1).accountMode, 'portfolio-margin');
  assert.equal((await f.request('/api/trading/accounts/binance', { method: 'DELETE', body: { revision: 0 } })).status, 409);
  for (const data of [response.data, failed.data, (await f.request('/api/trading')).data, (await f.request('/api/overview')).data]) {
    const serialized = JSON.stringify(data);
    for (const value of Object.values(secret)) assert.equal(serialized.includes(value), false);
  }
  for (const filename of (await readdir(f.dataDir)).filter(name => /^hub\.sqlite/.test(name))) {
    const file = await readFile(path.join(f.dataDir, filename));
    for (const value of Object.values(secret)) assert.equal(file.includes(Buffer.from(value)), false, filename);
  }
  const before = f.app.trading.state(); await f.reopen();
  const after = (await f.request('/api/trading')).data;
  assert.deepEqual(after.legs, before.legs);
  assert.deepEqual(after.funding, before.funding);
  assert.equal(after.accounts[0].connected, true);
  assert.equal(after.accounts[0].revision, 1);
  assert.equal((await f.request('/api/trading/accounts/binance', { method: 'DELETE', body: { revision: 1 } })).status, 200);
  assert.equal(f.stored('binance').credentials, null);
  await f.reopen(); assert.equal(f.app.trading.state().accounts[0].connected, false);
});

test('invalid explicit account modes are rejected before credentials or exchange reads', async t => {
  const f = await fixture(t); await f.login();
  for (const [exchange, modes] of [['binance', [null, '', 'unified', 'Portfolio-Margin', true, {}]], ['bybit', [null, 'standard', 'portfolio-margin', []]]]) {
    const previous = f.stored(exchange);
    for (const accountMode of modes) {
      const response = await f.request(`/api/trading/accounts/${exchange}`, { method: 'PUT', body: { revision: 0, ...credentials(), accountMode } });
      assert.equal(response.status, 400);
      let read = false;
      await assert.rejects(f.app.trading.connect(exchange, { revision: 0, accountMode }, {
        credentialReader: async () => { read = true; return credentials(); },
      }), error => error.status === 400);
      assert.equal(read, false);
    }
    assert.deepEqual(f.stored(exchange), previous);
  }
  assert.equal(f.calls.length, 0);
});

test('portfolio margin mode persists across restart and governs every verification and refresh', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.request('/api/trading/accounts/binance', { method: 'PUT', body: { revision: 0, ...credentials(), accountMode: 'portfolio-margin' } });
  assert.equal(response.status, 202);
  assert.equal(response.data.accounts[0].accountMode, 'portfolio-margin');
  await f.app.trading.refresh();
  const previous = f.stored('binance');
  await f.reopen();
  assert.deepEqual(f.stored('binance'), previous);
  assert.equal(f.app.trading.state().accounts[0].accountMode, 'portfolio-margin');
  f.advance(6000); await f.app.trading.refresh({ force: true });
  assert.deepEqual([...new Set(f.calls.map(row => row.method))].sort(), ['funding', 'positions', 'verify']);
  assert.ok(f.calls.every(row => row.accountMode === 'portfolio-margin'));
});

test('legacy account migration preserves encrypted connections and snapshots with exchange-specific mode defaults', async t => {
  const f = await fixture(t);
  for (const exchange of ['binance', 'bybit']) {
    f.handlers[exchange].funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [receipt(exchange, 'legacy-ledger', '0.2', end - 1)], coverage: [{ start, end }], complete: true });
    await f.connect(exchange);
  }
  const before = f.app.trading.state(), stored = ['binance', 'bybit'].map(f.stored), reads = f.calls.length;
  await f.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'hub.sqlite'));
  try {
    db.exec('ALTER TABLE trading_accounts DROP COLUMN account_mode');
    assert.equal(db.prepare('PRAGMA table_info(trading_accounts)').all().some(column => column.name === 'account_mode'), false);
  } finally { db.close(); }
  await f.reopen();
  assert.deepEqual(f.app.trading.state(), before);
  assert.deepEqual(['binance', 'bybit'].map(f.stored), stored);
  await f.reopen();
  assert.deepEqual(['binance', 'bybit'].map(f.stored), stored);
  assert.equal(f.calls.length, reads);
  f.advance(6000); await f.app.trading.refresh({ force: true });
  assert.ok(f.calls.slice(reads).every(row => row.accountMode === (row.exchange === 'binance' ? 'standard' : 'unified')));
});

test('four-leg structure follows observed positions, preserves both hedge sides and marks old data unknown', async t => {
  const f = await fixture(t); await f.connect('binance'); await f.connect('bybit');
  assert.equal(f.app.trading.state().structure.state, 'opposed');
  assert.equal(f.app.trading.state().legs[0].positions[0].side, 'long');
  f.rows.bybit = [position('bybit', 'CLUSDT', 'long'), position('bybit', 'BZUSDT', 'long')];
  f.advance(31000); await f.app.trading.refresh();
  assert.equal(f.app.trading.state().structure.state, 'same-direction');
  f.rows.bybit = [position('bybit', 'CLUSDT', 'long', { mode: 'hedge', notional: '100' }), position('bybit', 'CLUSDT', 'short', { mode: 'hedge', notional: '100' }), position('bybit', 'BZUSDT', 'long')];
  f.advance(31000); await f.app.trading.refresh();
  const mixed = f.app.trading.state();
  assert.equal(mixed.structure.state, 'mixed');
  assert.equal(mixed.legs[2].positions.length, 2);
  assert.equal(mixed.legs[2].grossNotional, '200');
  assert.equal(mixed.legs[2].netNotional, '0');
  f.rows.bybit = []; f.advance(31000); await f.app.trading.refresh();
  const empty = f.app.trading.state();
  assert.equal(empty.structure.state, 'incomplete');
  assert.equal(empty.legs[2].grossNotional, '0');
  assert.equal(empty.legs[2].fundingNet, '0');
  f.advance(76000);
  assert.equal(f.app.trading.state().structure.state, 'unknown');
  assert.equal(f.app.trading.state().legs[0].state, 'stale');
  assert.equal(f.app.trading.state().legs[0].fetchedAt, empty.legs[0].fetchedAt);
});

test('settled funding is exact, deduplicated per exchange, clipped to 7/30 days and grouped at Beijing midnight', async t => {
  const f = await fixture(t), end = f.now, start7 = end - 7 * DAY;
  const inputs = {
    binance: [receipt('binance', 'older', '5', start7 - 1), receipt('binance', 'shared-id', '0.1', start7),
      receipt('binance', 'same-day', '0.2', end - DAY - 1), receipt('binance', 'last-day', '-0.3', end - DAY),
      receipt('binance', 'excluded-end', '999', end)],
    bybit: [receipt('bybit', 'shared-id', '0.000000000000000001', end - 1, 'BZUSDT')],
  };
  for (const exchange of ['binance', 'bybit']) f.handlers[exchange].funding = async (_secret, { start, end: to }) => {
    const events = inputs[exchange].filter(row => Date.parse(row.time) >= start && Date.parse(row.time) < to);
    return { fetchedAt: stamp(f.now), events: [...events, ...events], coverage: [{ start, end: to }], complete: true };
  };
  await f.connect('binance'); await f.connect('bybit');
  const seven = f.app.trading.state(7), thirty = f.app.trading.state(30);
  assert.equal(seven.funding.complete, true);
  assert.equal(seven.funding.income, '0.300000000000000001');
  assert.equal(seven.funding.expense, '0.3');
  assert.equal(seven.funding.net, '0.000000000000000001');
  assert.equal(seven.funding.events.length, 4);
  assert.equal(thirty.funding.net, '5.000000000000000001');
  assert.equal(thirty.funding.events.length, 5);
  assert.equal(seven.funding.daily.length, 7);
  assert.equal(seven.funding.daily.at(-2).date, '2025-02-06');
  assert.equal(seven.funding.daily.at(-2).net, '0.2');
  assert.equal(seven.funding.daily.at(-1).date, '2025-02-07');
  assert.equal(seven.funding.daily.at(-1).net, '-0.299999999999999999');
  assert.equal(seven.legs[0].fundingNet, '0');
  assert.equal(seven.legs[3].fundingNet, '0.000000000000000001');
  const previous = seven.funding; await f.reopen(); assert.deepEqual(f.app.trading.state(7).funding, previous);
});

test('partial funding retains known receipts without reporting completeness, then fills coverage without double counting', async t => {
  const f = await fixture(t), original = f.now;
  const firstReceipt = receipt('binance', 'known', '0.1', original - 3600000);
  f.handlers.binance.funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [firstReceipt], coverage: [{ start, end: end - DAY }], complete: false, error: 'upstream failed' });
  await f.connect('binance'); await f.connect('bybit');
  const partial = f.app.trading.state();
  assert.equal(partial.funding.complete, false);
  assert.equal(partial.funding.net, '0.1');
  assert.equal(partial.accounts[0].funding.complete, false);
  assert.equal(partial.legs[0].fundingComplete, false);
  assert.ok(partial.accounts[0].funding.error);
  f.handlers.binance.funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [firstReceipt, receipt('binance', 'later', '-0.2', original + 1000)], coverage: [{ start, end }], complete: true });
  f.advance(6000); await f.app.trading.refresh({ force: true });
  const completed = f.app.trading.state();
  assert.equal(completed.funding.complete, true);
  assert.equal(completed.funding.events.length, 2);
  assert.equal(completed.funding.net, '-0.1');
  assert.equal(completed.accounts[0].funding.error, null);
  f.handlers.binance.funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [{ ...firstReceipt, amount: '999' }], coverage: [{ start, end }], complete: true });
  f.advance(6000); await f.app.trading.refresh({ force: true });
  assert.equal(f.app.trading.state().funding.net, '-0.1');
  assert.equal(f.app.trading.state().funding.complete, false);
  assert.ok(f.app.trading.state().accounts[0].funding.error);
});

test('accounts connected seconds apart share a funding window and can both report complete coverage', async t => {
  const f = await fixture(t), batchEnd = f.now;
  await f.connect('binance'); f.advance(40000); await f.connect('bybit');
  const state = f.app.trading.state(30);
  assert.equal(state.funding.complete, true);
  assert.equal(state.period.end, stamp(batchEnd));
  assert.deepEqual(f.calls.filter(row => row.method === 'funding').map(row => [row.exchange, row.end]), [['binance', batchEnd], ['bybit', batchEnd]]);
});

test('disconnect cancels only that account and late funding or positions cannot recreate its state', async t => {
  const f = await fixture(t); await f.connect('binance'); await f.connect('bybit');
  const positions = deferred(), funding = deferred();
  f.handlers.binance.positions = () => positions.promise;
  f.handlers.binance.funding = () => funding.promise;
  f.rows.bybit = [position('bybit', 'CLUSDT', 'short', { quantity: '3' })];
  f.advance(6000); const refreshing = f.app.trading.refresh({ force: true }); await nextTurn();
  const active = f.calls.filter(row => row.exchange === 'binance' && row.method !== 'verify').slice(-2);
  f.app.trading.disconnect('binance', 1); await refreshing;
  assert.ok(active.every(row => row.signal.aborted));
  positions.resolve({ fetchedAt: stamp(f.now), positions: [position('binance')] });
  funding.resolve({ fetchedAt: stamp(f.now), events: [receipt('binance', 'late', '1000', f.now - 1)], coverage: [{ start: f.now - 30 * DAY, end: f.now }], complete: true });
  await nextTurn();
  const state = f.app.trading.state();
  assert.equal(state.accounts[0].connected, false);
  assert.equal(state.accounts[1].connected, true);
  assert.equal(state.legs[0].positions.length, 0);
  assert.equal(state.legs[2].positions[0].quantity, '3');
  assert.equal(state.funding.events.some(row => row.exchange === 'binance'), false);
  assert.equal(f.stored('binance').snapshot, null);
});

test('successful mode switch clears the old ledger and cancels older position and funding results', async t => {
  const f = await fixture(t);
  f.handlers.binance.funding = async (_secret, { start, end }) => ({ fetchedAt: stamp(f.now), events: [receipt('binance', 'old-ledger', '0.1', end - 1)], coverage: [{ start, end }], complete: true });
  await f.connect('binance');
  const late = deferred(), oldFunding = deferred(), newFunding = deferred();
  f.handlers.binance.positions = () => late.promise;
  f.handlers.binance.funding = (_secret, { accountMode }) => accountMode === 'standard' ? oldFunding.promise : newFunding.promise;
  f.advance(6000); const refreshing = f.app.trading.refresh({ force: true }); await nextTurn();
  const staleCalls = f.calls.filter(row => row.exchange === 'binance' && row.method !== 'verify').slice(-2);
  f.rows.binance = [position('binance', 'BZUSDT', 'long', { quantity: '9' })];
  await f.app.trading.connect('binance', { revision: 1, ...credentials('new_account'), accountMode: 'portfolio-margin' });
  await refreshing; await nextTurn();
  assert.ok(staleCalls.every(row => row.accountMode === 'standard' && row.signal.aborted));
  assert.equal(f.app.trading.state().funding.events.length, 0);
  assert.equal(f.app.trading.state().funding.net, null);
  assert.deepEqual(JSON.parse(f.stored('binance').snapshot).funding.coverage, []);
  late.resolve({ fetchedAt: stamp(f.now), positions: [position('binance', 'CLUSDT', 'short', { quantity: '999' })] });
  oldFunding.resolve({ fetchedAt: stamp(f.now), events: [receipt('binance', 'late-ledger', '999', f.now - 1)], coverage: [{ start: f.now - 30 * DAY, end: f.now }], complete: true });
  await nextTurn();
  const state = f.app.trading.state();
  assert.equal(state.accounts[0].revision, 2);
  assert.equal(state.accounts[0].accountMode, 'portfolio-margin');
  assert.equal(f.stored('binance').account_mode, 'portfolio-margin');
  assert.equal(state.legs[0].positions.length, 0);
  assert.equal(state.legs[1].positions[0].quantity, '9');
  assert.equal(state.funding.events.length, 0);
  const incoming = f.calls.filter(row => row.method === 'funding').at(-1);
  assert.equal(incoming.secret.apiKey, credentials('new_account').apiKey);
  assert.equal(incoming.accountMode, 'portfolio-margin');
  newFunding.resolve({ fetchedAt: stamp(f.now), events: [receipt('binance', 'new-ledger', '0.3', incoming.end - 1)], coverage: [{ start: incoming.start, end: incoming.end }], complete: true });
  await nextTurn();
  assert.deepEqual(f.app.trading.state().funding.events.map(row => row.id), ['new-ledger']);
});

test('disconnect during verification cancels its save and concurrent verification cannot overwrite it', async t => {
  const f = await fixture(t), verifying = deferred();
  f.handlers.binance.verify = () => verifying.promise;
  const pending = f.app.trading.connect('binance', { revision: 0, ...credentials() });
  const cancelled = assert.rejects(pending, error => error.status === 400 && /取消/.test(error.message));
  await nextTurn();
  await assert.rejects(f.app.trading.connect('binance', { revision: 0, ...credentials('second') }), error => error.status === 409);
  f.app.trading.disconnect('binance', 0); await cancelled;
  verifying.resolve({ fetchedAt: stamp(f.now), positions: [position('binance')] }); await nextTurn();
  assert.equal(f.app.trading.state().accounts[0].connected, false);
  assert.equal(f.stored('binance').credentials, null);
  assert.equal(f.calls.filter(row => row.method === 'funding').length, 0);
});

test('overlapping refresh requests share work and enforce the manual refresh cooldown', async t => {
  const f = await fixture(t); await f.connect('binance'); await f.connect('bybit');
  const waiting = deferred();
  f.handlers.binance.positions = () => waiting.promise;
  const before = f.calls.length;
  await f.app.trading.refresh({ force: true }); assert.equal(f.calls.length, before);
  f.advance(6000);
  const first = f.app.trading.refresh({ force: true }), second = f.app.trading.refresh({ force: true });
  await nextTurn();
  assert.equal(f.calls.slice(before).filter(row => row.exchange === 'binance' && row.method === 'positions').length, 1);
  assert.equal(f.calls.slice(before).filter(row => row.exchange === 'binance' && row.method === 'funding').length, 1);
  waiting.resolve({ fetchedAt: stamp(f.now), positions: f.rows.binance }); await Promise.all([first, second]);
  const completedCount = f.calls.length; await f.app.trading.refresh({ force: true }); assert.equal(f.calls.length, completedCount);
  f.advance(31000); await f.app.trading.refresh();
  assert.ok(f.calls.slice(completedCount).every(row => row.method === 'positions'));
});

test('one timed-out exchange preserves its old timestamp while the other completes, and close aborts outstanding reads', async t => {
  const f = await fixture(t, { tradingTaskTimeoutMs: 80 }); await f.connect('binance'); await f.connect('bybit');
  const oldStamp = f.app.trading.state().accounts[0].positions.fetchedAt;
  f.handlers.binance.positions = () => new Promise(() => {});
  f.advance(31000); const refreshing = f.app.trading.refresh(); await nextTurn();
  const waitingState = f.app.trading.state();
  assert.equal(waitingState.accounts[1].positions.fetchedAt, stamp(f.now));
  assert.equal(waitingState.accounts[1].refreshing, false);
  await refreshing;
  assert.equal(f.app.trading.state().accounts[0].positions.state, 'stale');
  assert.equal(f.app.trading.state().accounts[0].positions.fetchedAt, oldStamp);
  assert.match(f.app.trading.state().accounts[0].positions.error, /超时/);
  f.advance(31000); const nextRefresh = f.app.trading.refresh(); await nextTurn();
  const active = f.calls.filter(row => row.exchange === 'binance' && row.method === 'positions').at(-1);
  await f.close(); await nextRefresh;
  assert.equal(active.signal.aborted, true);
});
