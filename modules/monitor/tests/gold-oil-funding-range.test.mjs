import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAvailableGoldOilFunding, analyzeGoldOilFunding, HOUR } from '../lib/gold-oil-funding.ts';

const end = Date.UTC(2026, 9, 7, 17, 15), start = end - 30 * 24 * HOUR;
const funding = (coverageEnd = end - 127_000) => ({
  oilType: 'bz', source: 'Binance', status: 'live', fetchedAt: new Date(coverageEnd).toISOString(),
  coverageStart: Date.UTC(2026, 3, 1, 9, 15), coverageEnd,
  points: Array.from({ length: 180 }, (_, index) => ({ time: Date.UTC(2026, 8, 7, 20) + index * 4 * HOUR + 1, oil: -0.0003, xau: 0.00002 })),
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('a 127-second funding lag retains 180 settlements and annualizes the actual queried period', () => {
  const history = funding(), result = analyzeAvailableGoldOilFunding(history, start, end);
  assert.equal(analyzeGoldOilFunding(history, start, end).shortAnnualized, null, 'Full-period analysis still requires full coverage');
  assert.equal(result.covered, true); assert.equal(result.selectedCovered, false);
  assert.equal(result.start, start); assert.equal(result.end, history.coverageEnd);
  assert.equal(result.oilCount, 180); assert.equal(result.xauCount, 180);
  close(result.shortCumulative, 180 * 0.00016); close(result.longCumulative, -180 * 0.00016);
  close(result.shortAnnualized, result.shortCumulative / ((history.coverageEnd - start) / HOUR) * 8760);
  assert.equal(result.longAnnualized, -result.shortAnnualized);
  assert.ok(result.points.every(row => Number.isFinite(row.shortAnnualized) && Number.isFinite(row.shortRate)));
  close(result.points.at(-1).shortAnnualized, result.shortAnnualized);
  const lastDayStart = Date.UTC(2026, 9, 7);
  close(result.points.at(-1).shortRate, 5 * 0.00016 / ((history.coverageEnd - lastDayStart) / HOUR));
});

test('coverage catch-up restores full-period labels without duplicating settlements', () => {
  for (const oilType of ['cl', 'bz']) for (const source of ['Binance', 'Bybit']) {
    const history = { ...funding(), oilType, source }, before = analyzeAvailableGoldOilFunding(history, start, end);
    const after = analyzeAvailableGoldOilFunding({ ...history, coverageEnd: end + HOUR }, start, end);
    assert.equal(after.selectedCovered, true); assert.equal(after.end, end);
    assert.deepEqual(after.events, before.events); assert.equal(after.shortCumulative, before.shortCumulative);
    close(after.shortAnnualized, before.shortCumulative / 720 * 8760);
  }
});

test('partial-period analysis never fills a missing prefix, missing leg or non-overlapping range', () => {
  const history = funding();
  const prefix = analyzeAvailableGoldOilFunding({ ...history, coverageStart: start + HOUR }, start, end);
  assert.equal(prefix.covered, false); assert.equal(prefix.selectedCovered, false); assert.equal(prefix.shortAnnualized, null);
  assert.ok(prefix.points.every(row => row.shortAnnualized === null && row.shortRate === null));
  for (const points of [[], history.points.map(row => ({ ...row, oil: null })), history.points.map(row => ({ ...row, xau: null }))]) {
    const result = analyzeAvailableGoldOilFunding({ ...history, points }, start, end);
    assert.equal(result.shortAnnualized, null); assert.ok(result.points.every(row => row.shortAnnualized === null));
  }
  for (const [from, to] of [[end, end + HOUR], [start, start], [history.coverageStart - 2 * HOUR, history.coverageStart - HOUR]]) {
    const result = analyzeAvailableGoldOilFunding(history, from, to);
    assert.equal(result.covered, false); assert.equal(result.shortCumulative, null); assert.equal(result.shortAnnualized, null); assert.deepEqual(result.points, []);
  }
  assert.equal(analyzeAvailableGoldOilFunding(null, start, end).shortAnnualized, null);
});

test('actual statistics retain start-inclusive and end-exclusive settlement boundaries and snapshot times', () => {
  const history = funding(), cutoff = history.coverageEnd;
  const snapshot = { ...history, status: 'snapshot', points: [start - 1, start, cutoff - 1].map(time => ({ time, oil: 0, xau: 0.0002 })) };
  const result = analyzeAvailableGoldOilFunding(snapshot, start, end);
  assert.deepEqual(result.events.map(row => row.time), [start, cutoff - 1]); assert.equal(result.end, cutoff);
  close(result.shortCumulative, 0.0002);
  const earlierEnd = analyzeAvailableGoldOilFunding(snapshot, start, cutoff - 1);
  assert.equal(earlierEnd.selectedCovered, true); assert.deepEqual(earlierEnd.events.map(row => row.time), [start]);
});
