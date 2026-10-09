import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTradingPnl } from '../server/trading-pnl.mjs';

const BASE = Date.UTC(2026, 9, 7), DAY = 86_400_000;
const LEGACY_SCHEMA = 'CREATE TABLE trading_pnl_samples (time INTEGER NOT NULL, binance_revision INTEGER NOT NULL, bybit_revision INTEGER NOT NULL, binance_at INTEGER, bybit_at INTEGER, unrealized_pnl TEXT, PRIMARY KEY (binance_revision, bybit_revision, time))';
const PAIR_SCHEMA = 'CREATE TABLE trading_pnl_samples_v2 (pair_key TEXT NOT NULL, revision_key TEXT NOT NULL, time INTEGER NOT NULL, first_at INTEGER, second_at INTEGER, unrealized_pnl TEXT, PRIMARY KEY (pair_key, revision_key, time))';
const iso = time => new Date(time).toISOString();
const entry = (exchange, amount, { revision = 1, time = BASE, funding = '0' } = {}) => ({
  row: { exchange, credentials: 'fixture', revision },
  snapshot: {
    positions: { fetchedAt: iso(time), error: null, rows: [{ unrealizedPnl: amount }] },
    funding: { events: [{ time: iso(BASE - 1000), amount: funding }], coverage: [{ start: BASE - DAY, end: BASE + 40 * DAY }] },
  },
});
const advance = (entries, time) => {
  for (const source of entries) source.snapshot.positions.fetchedAt = iso(time);
};
const count = (db, pairKey) => db.prepare('SELECT COUNT(*) AS count FROM trading_pnl_samples_v2 WHERE pair_key=?').get(pairKey).count;

test('legacy history preserves original amounts and timestamps across restarts and never resurrects expired samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trading-pnl-migration-'));
  const path = join(directory, 'history.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(LEGACY_SCHEMA);
    const insert = db.prepare('INSERT INTO trading_pnl_samples VALUES (?,?,?,?,?,?)');
    insert.run(BASE, 2, 5, BASE - 1000, BASE, '123.4500');
    insert.run(BASE + 60000, 2, 5, null, BASE + 60000, null);
    db.close();
    db = new DatabaseSync(path);
    let pnl = createTradingPnl(db);
    const entries = [entry('binance', '20', { revision: 2 }), entry('bybit', '-5', { revision: 5 })];
    assert.deepEqual(db.prepare('SELECT time,first_at,second_at,unrealized_pnl FROM trading_pnl_samples_v2 ORDER BY time').all().map(row => ({ ...row })), [
      { time: BASE, first_at: BASE - 1000, second_at: BASE, unrealized_pnl: '123.4500' },
      { time: BASE + 60000, first_at: null, second_at: BASE + 60000, unrealized_pnl: null },
    ]);
    let state = pnl.read(entries, BASE - DAY, BASE + 60000);
    assert.equal(state.recordingStartedAt, BASE);
    assert.equal(state.points[0].unrealizedPnl, '123.45');
    assert.equal(state.points[1].unrealizedPnl, null);
    db.close();
    db = new DatabaseSync(path);
    pnl = createTradingPnl(db);
    assert.equal(count(db, 'binance:bybit'), 2);
    const now = BASE + 32 * DAY;
    advance(entries, now);
    assert.equal(pnl.record(entries, now), true);
    assert.equal(count(db, 'binance:bybit'), 1);
    db.close();
    db = new DatabaseSync(path);
    pnl = createTradingPnl(db);
    assert.equal(count(db, 'binance:bybit'), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trading_pnl_samples').get().count, 2);
    state = pnl.read(entries, BASE - DAY, now);
    assert.equal(state.recordingStartedAt, now);
    assert.equal(state.pointCount, 1);
  } finally {
    if (db?.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a migration error rolls back copied rows and the migration marker, so retry is complete', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    db.exec(PAIR_SCHEMA);
    const insert = db.prepare('INSERT INTO trading_pnl_samples VALUES (?,?,?,?,?,?)');
    insert.run(BASE, 1, 1, BASE, BASE, '10');
    insert.run(BASE + 60000, 1, 1, BASE + 60000, BASE + 60000, '20');
    db.exec(`CREATE TRIGGER fail_pnl_migration BEFORE INSERT ON trading_pnl_samples_v2 WHEN NEW.time=${BASE + 60000} BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END`);
    assert.throws(() => createTradingPnl(db), /migration interrupted/);
    assert.equal(count(db, 'binance:bybit'), 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trading_pnl_migrations'").get(), undefined);
    db.exec('DROP TRIGGER fail_pnl_migration');
    createTradingPnl(db);
    assert.equal(count(db, 'binance:bybit'), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trading_pnl_migrations').get().count, 1);
  } finally { db.close(); }
});

test('three exchange pairs isolate unrealized and funding amounts and normalize reversed inputs', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  try {
    const binance = entry('binance', '10', { funding: '1' });
    const bybit = entry('bybit', '-3', { funding: '2', time: BASE + 20000 });
    const okx = entry('okx', '7.5', { funding: '4', time: BASE + 30000 });
    const pairs = [[binance, bybit], [binance, okx], [bybit, okx]];
    const expected = [['7', '3', '10'], ['17.5', '5', '22.5'], ['4.5', '6', '10.5']];
    for (const [index, sources] of pairs.entries()) {
      assert.equal(pnl.record([...sources].reverse(), BASE + 30000), true);
      assert.equal(pnl.record(sources, BASE + 30000), false);
      const state = pnl.read(sources, BASE - DAY, BASE + 30000);
      assert.deepEqual([state.latest.unrealizedPnl, state.latest.fundingPnl, state.latest.totalPnl], expected[index]);
      assert.deepEqual(pnl.read([...sources].reverse(), BASE - DAY, BASE + 30000), state);
      assert.equal(pnl.sourceKey(sources), pnl.sourceKey([...sources].reverse()));
    }
    const stored = db.prepare('SELECT * FROM trading_pnl_samples_v2 WHERE pair_key=?').get('binance:okx');
    assert.equal(stored.first_at, BASE);
    assert.equal(stored.second_at, BASE + 30000);
    assert.equal(stored.revision_key, JSON.stringify([['binance', 1], ['okx', 1]]));
  } finally { db.close(); }
});

test('replacing an account only removes obsolete revisions in each recorded pair', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  try {
    const binance = entry('binance', '10'), bybit = entry('bybit', '20'), okx = entry('okx', '40');
    const originalPairs = [[binance, bybit], [binance, okx], [bybit, okx]];
    for (const pair of originalPairs) pnl.record(pair, BASE);
    const replacement = entry('binance', '100', { revision: 2, time: BASE + 60000 });
    advance([bybit, okx], BASE + 60000);
    const nextPair = [replacement, bybit];
    assert.equal(pnl.sourceKey(nextPair), null);
    pnl.record(nextPair, BASE + 60000);
    assert.equal(pnl.read(nextPair, BASE - DAY, BASE + 60000).latest.unrealizedPnl, '120');
    assert.equal(pnl.read(originalPairs[0], BASE - DAY, BASE + 60000).pointCount, 0);
    assert.equal(pnl.read(originalPairs[1], BASE - DAY, BASE + 60000).latest.unrealizedPnl, '50');
    assert.equal(pnl.read(originalPairs[2], BASE - DAY, BASE + 60000).latest.unrealizedPnl, '60');
    pnl.record([replacement, okx], BASE + 60000);
    assert.equal(pnl.read(originalPairs[1], BASE - DAY, BASE + 60000).pointCount, 0);
    assert.equal(pnl.read([replacement, okx], BASE - DAY, BASE + 60000).latest.unrealizedPnl, '140');
    assert.equal(pnl.sourceKey(originalPairs[2]), BASE);
    assert.equal(pnl.sourceKey(nextPair), BASE + 60000);
    assert.deepEqual(['binance:bybit', 'binance:okx', 'bybit:okx'].map(pair => count(db, pair)), [1, 1, 1]);
  } finally { db.close(); }
});

test('retention cleanup stays within the updated pair and retains its exact 31-day boundary', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  try {
    const binance = entry('binance', '10'), bybit = entry('bybit', '20'), okx = entry('okx', '40');
    const pair = [binance, okx], otherPair = [bybit, okx];
    pnl.record(pair, BASE);
    pnl.record(otherPair, BASE);
    advance(pair, BASE + 31 * DAY);
    pnl.record(pair, BASE + 31 * DAY);
    assert.equal(count(db, 'binance:okx'), 2);
    advance(pair, BASE + 31 * DAY + 60000);
    pnl.record(pair, BASE + 31 * DAY + 60000);
    assert.equal(count(db, 'binance:okx'), 2);
    assert.equal(pnl.read(pair, BASE - DAY, BASE + 31 * DAY + 60000).recordingStartedAt, BASE + 31 * DAY);
    assert.equal(count(db, 'bybit:okx'), 1);
  } finally { db.close(); }
});

test('pair reads recalculate late funding and retain stale, missing and disconnected states', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  try {
    const sources = [entry('bybit', '2'), entry('okx', '3')];
    sources[1].snapshot.funding.coverage = [];
    pnl.record(sources, BASE);
    let state = pnl.read(sources, BASE - DAY, BASE);
    assert.equal(state.latest.unrealizedPnl, '5');
    assert.equal(state.latest.fundingPnl, null);
    assert.equal(state.status, 'incomplete');
    sources[1].snapshot.funding.coverage = [{ start: BASE - DAY, end: BASE + DAY }];
    sources[1].snapshot.funding.events.push({ time: iso(BASE - 500), amount: '-1.25' });
    state = pnl.read(sources, BASE - DAY, BASE);
    assert.equal(state.latest.totalPnl, '3.75');
    assert.equal(state.status, 'ready');
    // A selected exchange with stale positions produces a gap, even though the
    // other selected exchange still has a fresh source timestamp.
    sources[0].snapshot.positions.fetchedAt = iso(BASE + 76000);
    pnl.record(sources, BASE + 76000);
    assert.equal(pnl.read(sources, BASE - DAY, BASE + 76000).latest.unrealizedPnl, null);
    advance(sources, BASE + 120000);
    sources[1].snapshot.positions.rows[0].unrealizedPnl = null;
    pnl.record(sources, BASE + 120000);
    assert.equal(pnl.read(sources, BASE - DAY, BASE + 120000).latest.unrealizedPnl, null);
    sources[1].row.credentials = null;
    assert.equal(pnl.record(sources, BASE + 180000), false);
    assert.equal(pnl.read(sources, BASE - DAY, BASE + 180000).pointCount, 0);
  } finally { db.close(); }
});

test('legacy two-entry fixtures remain supported but unsupported pair shapes cannot aggregate a third exchange', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  try {
    const sources = [entry(undefined, '10'), entry(undefined, '-2')];
    pnl.record(sources, BASE);
    assert.equal(pnl.read(sources, BASE - DAY, BASE).latest.unrealizedPnl, '8');
    assert.equal(count(db, 'binance:bybit'), 1);
    const invalid = [[sources[0]], [...sources, entry('okx', '100000')], [entry('okx', '1'), entry('okx', '2')], [entry('unknown', '1'), entry('bybit', '2')]];
    for (const pair of invalid) {
      assert.throws(() => pnl.record(pair, BASE), TypeError);
      assert.throws(() => pnl.read(pair, BASE - DAY, BASE), TypeError);
      assert.throws(() => pnl.sourceKey(pair), TypeError);
    }
  } finally { db.close(); }
});

test('pair samples preserve the 75-second freshness and 45-second source skew boundaries', () => {
  const current = BASE + 100000;
  for (const { ages, good } of [
    { ages: [75000, 75000], good: true },
    { ages: [75001, 75001], good: false },
    { ages: [0, 45000], good: true },
    { ages: [0, 45001], good: false },
  ]) {
    const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
    try {
      const sources = [entry('binance', '2', { time: current - ages[0] }), entry('okx', '3', { time: current - ages[1] })];
      pnl.record(sources, current);
      const state = pnl.read(sources, BASE - DAY, current);
      assert.equal(state.latest.unrealizedPnl, good ? '5' : null, `source ages ${ages.join(', ')}`);
    } finally { db.close(); }
  }
});
