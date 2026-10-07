import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTradingPnl, reducePnlPoints } from '../server/trading-pnl.mjs';

test('normal thirty-second refresh jitter keeps minute samples without synthetic gaps', () => {
  const db = new DatabaseSync(':memory:'), pnl = createTradingPnl(db);
  const base = Date.UTC(2026, 9, 7);
  const entries = ['binance', 'bybit'].map(exchange => ({ row: { exchange, credentials: 'fixture', revision: 1 }, snapshot: { positions: { rows: [], error: null }, funding: { events: [], coverage: [{ start: base - 100000, end: base + 200000 }] } } }));
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
