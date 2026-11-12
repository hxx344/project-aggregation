import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTradingPnl, reducePnlPoints } from '../server/trading-pnl.mjs';

test('normal thirty-second refresh jitter keeps minute samples without synthetic gaps', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  const base = Date.UTC(2026, 9, 7);
  const entries = ['binance', 'bybit'].map(exchange => ({ row: { exchange, credentials: 'fixture', revision: 1 }, snapshot: { positions: { rows: [], error: null }, funding: { events: [], coverage: [{ start: base - 100000, end: base + 200000 }] }, trades: { events: [], coverage: [{ start: base - 100000, end: base + 200000 }] } } }));
  try {
    for (const offset of [200, 30200, 60100, 90300, 120050]) {
      for (const entry of entries) entry.snapshot.positions.fetchedAt = new Date(base + offset).toISOString();
      pnl.record(entries, base + offset);
    }
    const state = pnl.read(entries, base - 100000, base + 120050);
    assert.equal(state.pointCount, 3);
    assert.ok(state.points.every(point => point.totalPnl === '0'));
  } finally { db.close(); }
});

test('reducing a month of points retains valid extrema and does not expand short gaps', () => {
  const points = Array.from({ length: 42000 }, (_, time) => ({ time, unrealizedPnl: time % 210 === 0 ? null : String(time % 1000 - 500), fundingPnl: '0', totalPnl: time % 210 === 0 ? null : String(time % 1000 - 500) }));
  points[155].totalPnl = '-99999'; points[39000].totalPnl = '99999';
  const reduced = reducePnlPoints(points);
  assert.ok(reduced.length < 2500);
  assert.ok(reduced.some(point => point.totalPnl === '-99999'));
  assert.ok(reduced.some(point => point.totalPnl === '99999'));
  assert.equal(reduced.filter(point => point.totalPnl === null).length, 200);
  assert.ok(reduced.every(point => points[point.time].totalPnl === point.totalPnl));
  for (const point of points.filter(point => point.totalPnl === null)) {
    const index = reduced.findIndex(row => row.time === point.time);
    if (index > 0) assert.equal(reduced[index - 1].time, point.time - 1);
    assert.equal(reduced[index + 1].time, point.time + 1);
  }
});

test('repeated reads pick up new samples and notice rows removed outside record()', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  const base = Date.UTC(2026, 10, 1), coverage = [{ start: base - 100000, end: base + 10 * 60000 }];
  const entries = ['binance', 'bybit'].map(exchange => ({ row: { exchange, credentials: 'fixture', revision: 1 },
    snapshot: { positions: { rows: [{ unrealizedPnl: '1.5' }], error: null }, funding: { events: [], coverage }, trades: { events: [], coverage } } }));
  const sample = offset => {
    for (const entry of entries) entry.snapshot.positions.fetchedAt = new Date(base + offset).toISOString();
    assert.equal(pnl.record(entries, base + offset), true);
  };
  try {
    sample(0); sample(60000);
    assert.deepEqual(pnl.read(entries, base - 100000, base + 60000).points.map(point => point.totalPnl), ['3', '3']);
    entries[0].snapshot.positions.rows = [{ unrealizedPnl: '-0.25' }];
    sample(120000);
    let state = pnl.read(entries, base - 100000, base + 120000);
    assert.deepEqual(state.points.map(point => point.totalPnl), ['3', '3', '1.25']);
    assert.equal(state.latest.unrealizedPnl, '1.25');
    db.prepare('DELETE FROM trading_pnl_samples_v2 WHERE time = ?').run(base + 60000);
    state = pnl.read(entries, base - 100000, base + 120000);
    assert.equal(state.pointCount, 2);
    assert.deepEqual(state.points.map(point => point.time), [base, base + 120000]);
    // A narrower or older window is served from the same samples.
    assert.deepEqual(pnl.read(entries, base + 60000, base + 120000).points.map(point => point.time), [base + 120000]);
    assert.deepEqual(pnl.read(entries, base - 100000, base + 30000).points.map(point => point.time), [base]);
  } finally { db.close(); }
});

test('cached reads downsample like the string reducer and reload on a new revision or earlier window', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  const base = Date.UTC(2026, 10, 1), minute = 60000, count = 1500, coverage = [{ start: base - 100000, end: base + 2 * count * minute }];
  const entries = ['binance', 'bybit'].map(exchange => ({ row: { exchange, credentials: 'fixture', revision: 1 },
    snapshot: { positions: { rows: [], error: null }, funding: { events: [], coverage }, trades: { events: [], coverage } } }));
  const sample = (index, value) => {
    entries[0].snapshot.positions.rows = [{ unrealizedPnl: value }]; entries[1].snapshot.positions.rows = [{ unrealizedPnl: '0' }];
    for (const entry of entries) entry.snapshot.positions.fetchedAt = new Date(base + index * minute).toISOString();
    assert.equal(pnl.record(entries, base + index * minute), true);
  };
  const value = index => `${(index * 37) % 101 - 50}.${index % 7}`;
  try {
    for (let index = 0; index < count; index++) sample(index, value(index));
    const end = base + (count - 1) * minute;
    const expected = Array.from({ length: count }, (_, index) => {
      const pnlValue = value(index).replace(/\.0$/, '');
      return { time: base + index * minute, unrealizedPnl: pnlValue, fundingPnl: '0', realizedPnl: '0', feePnl: '0', totalPnl: pnlValue };
    });
    assert.equal(JSON.stringify(pnl.read(entries, base + 200 * minute, end).points), JSON.stringify(reducePnlPoints(expected.slice(200))));
    // An earlier window than the cached one adds the older samples.
    const state = pnl.read(entries, base - 100000, end);
    assert.equal(state.pointCount, count);
    assert.equal(JSON.stringify(state.points), JSON.stringify(reducePnlPoints(expected)));
    // A new account revision starts a fresh series.
    for (const entry of entries) entry.row.revision = 2;
    sample(count, '4.5');
    const fresh = pnl.read(entries, base - 100000, base + count * minute);
    assert.equal(fresh.pointCount, 1);
    assert.equal(fresh.latest.totalPnl, '4.5');
  } finally { db.close(); }
});
