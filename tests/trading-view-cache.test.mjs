import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTrading } from '../server/trading.mjs';

const DAY = 86400000, INITIAL = Date.UTC(2025, 1, 7, 16);
async function fixture(t, count = 63) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-trading-view-'));
  let db, trading, clock = INITIAL;
  const queries = [], calls = [];
  const events = Array.from({ length: count }, (_, i) => ({ id: `ledger-${i}`, exchange: 'binance', symbol: i % 2 ? 'CLUSDT' : 'BZUSDT', currency: 'USDT', amount: '0.1', time: new Date(INITIAL - 1000 - i * 1000).toISOString() }));
  const clientFactory = exchange => Object.fromEntries(['positions', 'verify', 'funding'].map(method => [method, async (_, options) => {
    calls.push({ exchange, method });
    return method === 'funding' ? { fetchedAt: new Date(clock).toISOString(), events: exchange === 'binance' ? events.filter(row => Date.parse(row.time) >= options.start && Date.parse(row.time) < options.end) : [], coverage: [{ start: options.start, end: options.end }], complete: true }
      : { positions: [], fetchedAt: new Date(clock).toISOString() };
  }]));
  function open() {
    db = new DatabaseSync(path.join(directory, 'fixture.sqlite'));
    const traced = { exec(sql) { queries.push(sql); return db.exec(sql); }, prepare(sql) { queries.push(sql); return db.prepare(sql); } };
    trading = createTrading({ db: traced, encrypt: JSON.stringify, decrypt: JSON.parse, now: () => clock, intervalMs: 0, clientFactory });
  }
  open();
  t.after(async () => { await trading.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { get trading() { return trading; }, get db() { return db; }, get now() { return clock; }, queries, calls, events,
    advance(ms) { clock += ms; },
    async connect() { for (const exchange of ['binance', 'bybit']) await trading.connect(exchange, { revision: 0, apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' }); await trading.refresh(); },
    async reopen() { await trading.close(); db.close(); open(); },
  };
}

test('paged cached reads do not scan histories, calculate PnL, write storage or contact exchanges', async t => {
  const f = await fixture(t); await f.connect();
  const reads = f.calls.length, stored = f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all();
  f.queries.length = 0;
  for (let i = 0; i < 5; i++) {
    const first = f.trading.state(7, { page: 0 }), second = f.trading.state(7, { page: 1 }), last = f.trading.state(7, { page: 1999 });
    assert.deepEqual(first.funding.pagination, { page: 0, pageSize: 50, pages: 2, total: 63 });
    assert.equal(first.funding.events.length, 50); assert.equal(second.funding.events.length, 13);
    assert.equal(first.funding.net, '6.3'); assert.equal(second.funding.net, '6.3');
    assert.equal(last.funding.pagination.page, 1);
    assert.equal(new Set([...first.funding.events, ...second.funding.events].map(row => row.id)).size, 63);
  }
  assert.equal(f.calls.length, reads);
  assert.ok(f.queries.every(sql => /^SELECT exchange,revision,credentials,verified_at,account_mode FROM trading_accounts/.test(sql)), f.queries.join('\n'));
  assert.deepEqual(f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all(), stored);
  for (const page of [-1, 2000, 1.2, '1', NaN]) assert.throws(() => f.trading.state(7, { page }), error => error.status === 400);
});

test('disk views restore without rebuilding or waiting for exchange data', async t => {
  const f = await fixture(t); await f.connect();
  const before = f.trading.state(30, { page: 1 }), reads = f.calls.length;
  const persisted = f.db.prepare('SELECT json FROM trading_views_v2 WHERE days=30').get().json;
  assert.equal(persisted.includes('fixture_only'), false);
  assert.equal(persisted.includes('ledger-'), false, 'large ledger remains only in its original persisted snapshot');
  f.queries.length = 0; await f.reopen();
  assert.equal(f.calls.length, reads);
  assert.equal(f.queries.some(sql => /INSERT INTO trading_views_v2/.test(sql)), false, 'matching view must be loaded rather than rebuilt');
  assert.equal(f.queries.some(sql => /SELECT \* FROM trading_pnl_samples.*time>=/.test(sql)), false, 'restart does not rescan historical PnL');
  assert.deepEqual(f.trading.state(30, { page: 1 }), before);
});

test('invalid, older-version or source-mismatched disk views rebuild from local snapshots', async t => {
  const f = await fixture(t); await f.connect();
  for (const damage of ["UPDATE trading_views_v2 SET json='broken'", 'UPDATE trading_views_v2 SET version=999', "UPDATE trading_views_v2 SET source_key='wrong-account'"]) {
    f.db.exec(damage); f.queries.length = 0; const reads = f.calls.length;
    await f.reopen();
    assert.equal(f.calls.length, reads);
    assert.ok(f.queries.some(sql => /INSERT INTO trading_views_v2/.test(sql)));
    assert.equal(f.trading.state(7, { page: 0 }).funding.net, '6.3');
  }
});

test('cached values keep their original time and degrade freshness without rebuilding', async t => {
  const f = await fixture(t, 0); await f.connect();
  const before = f.trading.state();
  f.advance(76000); f.queries.length = 0;
  const stale = f.trading.state();
  assert.equal(stale.generatedAt, before.generatedAt);
  assert.equal(stale.cache.builtAt, before.cache.builtAt);
  assert.equal(stale.cache.servedAt, new Date(f.now).toISOString());
  assert.ok(stale.accounts.filter(account => stale.exchanges.includes(account.exchange)).every(account => account.positions.state === 'stale'));
  assert.equal(stale.pnl.latest.totalPnl, null);
  f.advance(900000);
  const expired = f.trading.state();
  assert.equal(expired.funding.complete, false);
  assert.equal(expired.funding.net, null);
  assert.ok(expired.funding.daily.every(day => !day.complete && day.net === null));
  assert.ok(f.queries.every(sql => sql.startsWith('SELECT exchange,revision,')));
});

test('account replacement and disconnect immediately discard both cached ranges and old ledger pages', async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.trading.state(30, { page: 1 }).funding.events.length, 13);
  f.trading.disconnect('binance', 1);
  for (const days of [7, 30]) {
    const state = f.trading.state(days, { page: 1 });
    assert.equal(state.funding.pagination.total, 0); assert.deepEqual(state.funding.events, []);
    assert.deepEqual(state.pnl.points, []);
    assert.equal(state.accounts[0].connected, false);
  }
  await f.reopen();
  assert.deepEqual(f.trading.state(30, { page: 1 }).funding.events, []);
});

test('position-only refresh reuses derived history until a new minute sample is recorded', async t => {
  const f = await fixture(t); await f.connect();
  const stored = f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all();
  f.advance(31000); await f.trading.refresh();
  assert.deepEqual(f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all(), stored);
  assert.equal(f.trading.state().accounts[0].positions.fetchedAt, new Date(f.now).toISOString());
  f.queries.length = 0; await f.reopen();
  assert.equal(f.queries.some(sql => /INSERT INTO trading_views_v2/.test(sql)), false);
  f.advance(31000); await f.trading.refresh();
  assert.notEqual(f.trading.state().cache.builtAt, JSON.parse(stored[0].json).generatedAt);
  assert.equal(f.trading.state().pnl.pointCount, 2);
});
