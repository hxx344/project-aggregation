import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTrading } from '../server/trading.mjs';

const INITIAL = Date.UTC(2026, 9, 7, 12, 15, 12);
const stamp = () => new Date().toISOString();

async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: INITIAL });
  const db = new DatabaseSync(':memory:');
  const calls = [], handlers = { binance: {}, bybit: {} };
  const result = (exchange, method, { start, end } = {}) => method === 'funding'
    ? { fetchedAt: stamp(), events: [{ id: `${exchange}:${end}`, exchange, symbol: 'CLUSDT', currency: 'USDT', amount: '0.1', time: new Date(end - 1).toISOString() }], coverage: [{ start, end }], complete: true }
    : { fetchedAt: stamp(), positions: ['CLUSDT', 'BZUSDT'].map(symbol => ({
      exchange, symbol, side: exchange === 'binance' ? 'long' : 'short', mode: 'one-way', quantity: '1',
      entryPrice: '100', markPrice: String(100 + (Date.now() - INITIAL) / 1000), notional: '100',
      unrealizedPnl: String((Date.now() - INITIAL) / 1000), leverage: '1', liquidationPrice: null, sourceUpdatedAt: null,
    })) };
  const clientFactory = exchange => Object.fromEntries(['verify', 'positions', 'funding'].map(method => [method, async (_credentials, request) => {
    calls.push({ exchange, method, time: Date.now(), signal: request.signal });
    return handlers[exchange][method] ? handlers[exchange][method](request) : result(exchange, method, request);
  }]));
  const open = () => createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, clientFactory, ...options });
  let trading = open();
  t.after(async () => { await trading.close(); db.close(); });
  return {
    get trading() { return trading; }, db, calls, handlers,
    reads: (exchange, method) => calls.filter(call => call.exchange === exchange && call.method === method),
    async connect() {
      for (const exchange of ['binance', 'bybit']) await trading.connect(exchange, { revision: 0, apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' });
      await nextTurn();
    },
    async advance(milliseconds) {
      // Drain each scheduler turn so a large clock jump does not fabricate a
      // backlog of overlapping network calls that cannot happen in normal time.
      for (let remaining = milliseconds; remaining > 0;) {
        const step = Math.min(1000, remaining);
        t.mock.timers.tick(step); remaining -= step; await nextTurn();
      }
    },
    async stop() { await trading.close(); },
    reopen() { trading = open(); },
  };
}

test('default automatic collection stays fresh for ten minutes without manual refresh or request flooding', async t => {
  const f = await fixture(t); await f.connect();
  const initial = f.trading.state();
  await f.advance(600_000);
  const current = f.trading.state();
  for (const exchange of ['binance', 'bybit']) {
    const positions = f.reads(exchange, 'positions'), funding = f.reads(exchange, 'funding');
    assert.equal(positions.length, 20, 'idle scheduler ticks do not issue extra position reads');
    assert.ok(positions.every((call, index) => call.time === INITIAL + (index + 1) * 30_000));
    assert.equal(funding.length, 3, 'initial funding plus two automatic batches, without extra backfills');
    assert.deepEqual(funding.map(call => call.time), [INITIAL, INITIAL + 300_000, INITIAL + 600_000]);
    const account = current.accounts.find(account => account.exchange === exchange);
    assert.equal(account.positions.fetchedAt, stamp()); assert.equal(account.positions.state, 'live');
    assert.equal(account.funding.fetchedAt, stamp()); assert.equal(account.funding.complete, true);
    assert.equal(account.refreshing, false);
  }
  assert.ok(current.legs.every(leg => leg.positions[0].markPrice === '700'), 'published positions use the latest automatic read');
  assert.ok(current.pnl.pointCount > initial.pnl.pointCount, 'automatic reads produce new persisted PnL samples');
  assert.equal(current.cache.builtAt, stamp()); assert.equal(current.cache.rebuilding, false);
  assert.ok(current.funding.events.length > initial.funding.events.length, 'later automatic funding batches reach the published ledger');
});

test('restarting the collector restores stored views and resumes automatic collection after downtime', async t => {
  const f = await fixture(t); await f.connect(); await f.advance(60_000);
  const before = f.trading.state(30), persisted = f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all();
  await f.stop(); const stoppedCalls = f.calls.length;
  await f.advance(360_000);
  assert.equal(f.calls.length, stoppedCalls, 'closing the collector stops all scheduled exchange calls');
  f.reopen();
  const restored = f.trading.state(30);
  assert.equal(f.calls.length, stoppedCalls, 'opening exposes persisted data before any exchange request');
  assert.equal(restored.cache.builtAt, before.cache.builtAt);
  assert.deepEqual(f.db.prepare('SELECT * FROM trading_views_v2 ORDER BY days').all(), persisted);
  assert.ok(restored.accounts.filter(account => account.exchange !== 'okx').every(account => account.positions.state === 'stale'));
  await f.advance(1000);
  const resumed = f.trading.state(30);
  assert.ok(resumed.accounts.filter(account => account.exchange !== 'okx').every(account => account.positions.state === 'live' && account.positions.fetchedAt === stamp()));
  assert.ok(resumed.accounts.filter(account => account.exchange !== 'okx').every(account => account.funding.fetchedAt === stamp()));
  assert.notEqual(resumed.cache.builtAt, before.cache.builtAt);
  assert.ok(resumed.pnl.pointCount > before.pnl.pointCount);
  const afterResume = f.calls.length;
  await f.advance(29_000);
  assert.equal(f.calls.length, afterResume, 'restart does not bypass the normal per-account cooldown');
  await f.advance(1000);
  assert.ok(f.trading.state().accounts.filter(account => account.exchange !== 'okx').every(account => account.positions.fetchedAt === stamp()));
});

test('automatic collection isolates a timeout and failure, then recovers without a manual refresh', async t => {
  const f = await fixture(t, { taskTimeoutMs: 80 }); await f.connect();
  let attempts = 0;
  f.handlers.binance.positions = () => {
    attempts++;
    if (attempts === 1) return new Promise(() => {});
    if (attempts === 2) throw new Error('Synthetic exchange read failure');
    return { fetchedAt: stamp(), positions: [] };
  };
  await f.advance(30_000);
  let current = f.trading.state();
  assert.equal(current.accounts[0].refreshing, true);
  assert.equal(current.accounts[0].positions.fetchedAt, new Date(INITIAL).toISOString());
  assert.equal(current.accounts[1].positions.fetchedAt, stamp(), 'the healthy exchange finishes while the other hangs');
  assert.equal(current.accounts[1].refreshing, false);
  await f.advance(1000);
  current = f.trading.state();
  assert.equal(f.reads('binance', 'positions')[0].signal.aborted, true);
  assert.match(current.accounts[0].positions.error, /超时/);
  assert.equal(current.accounts[0].refreshing, false);
  await f.advance(29_000);
  current = f.trading.state();
  assert.equal(attempts, 2); assert.ok(current.accounts[0].positions.error);
  assert.equal(current.accounts[1].positions.state, 'live');
  assert.equal(current.accounts[1].positions.fetchedAt, stamp());
  await f.advance(30_000);
  current = f.trading.state();
  assert.equal(attempts, 3, 'failed requests retry on schedule rather than on every scheduler tick');
  assert.ok(current.accounts.filter(account => account.exchange !== 'okx').every(account => account.positions.state === 'live' && account.positions.fetchedAt === stamp()));
  assert.equal(current.accounts[0].positions.error, null);
  assert.ok(current.legs.filter(leg => leg.exchange === 'binance').every(leg => leg.positions.length === 0), 'recovered snapshots replace the retained positions');
  assert.equal(current.cache.builtAt, stamp());
  assert.equal(current.pnl.latest.time, Date.now());
  assert.equal(f.reads('bybit', 'positions').length, 3);
});
