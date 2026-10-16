import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRows, rollingAverages } from '../modules/oil/data-utils.mjs';
import { OIL_CANDLE_MS as BAR } from '../modules/oil/intraday.mjs';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const near = (actual, expected, tolerance = 1e-12) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} != ${expected}`,
);
const observations = (count, spread = index => index + 1, start = START) => Array.from({ length: count }, (_, index) => {
  const time = start + index * BAR;
  return { time, date: new Date(time).toISOString(), spread: spread(index, time) };
});
const between = (start, end, spread) => observations((Date.parse(end) - Date.parse(start)) / BAR, spread, Date.parse(start));
const at = (rows, date) => {
  const row = rows.find(row => row.time === Date.parse(date));
  assert.ok(row, `Missing fixture row ${date}`);
  return row;
};

for (const [range, size] of [['1d', 96], ['1w', 672]]) {
  test(`${range} includes the current completed candle and evicts observations outside its time window`, () => {
    const result = rollingAverages(observations(size + 3), range, BAR);

    assert.equal(result[0].average, null);
    assert.equal(result[0].averageCount, 1);
    assert.equal(result[0].averageExpectedCount, size);
    assert.equal(result[size - 2].average, null);
    assert.equal(result[size - 2].averageCount, size - 1);
    near(result[size - 1].average, (size + 1) / 2);
    near(result[size].average, (size + 3) / 2);
    near(result.at(-1).average, (size + 7) / 2);
    assert.equal(result.at(-1).averageCount, size);
    assert.equal(result.at(-1).averageExpectedCount, size);
  });
}

test('calendar month averages clamp to the previous month end while preserving the UTC intraday cutoff', () => {
  const rows = between('2026-02-27T10:00Z', '2026-03-31T10:15Z', (_index, time) => {
    if (time === Date.parse('2026-02-28T10:00Z')) return 999;
    if (time === Date.parse('2026-02-28T10:15Z')) return 7;
    if (time === Date.parse('2026-03-31T10:00Z')) return 3;
    return 2;
  });
  const result = rollingAverages(rows, '1m', BAR).at(-1);

  assert.equal(filterRows(rows, '1m', BAR)[0].date, '2026-02-28T10:15:00.000Z');
  assert.equal(result.averageExpectedCount, 31 * 96);
  assert.equal(result.averageCount, 31 * 96);
  near(result.average, 2 + 6 / (31 * 96));
});

test('calendar month cutoff retreat restores samples that were outside the previous candle window', () => {
  const rows = between('2026-02-01T00:00Z', '2026-03-29T00:15Z', (_index, time) => (
    time >= Date.parse('2026-02-28T00:00Z') && time < Date.parse('2026-02-28T23:45Z') ? 3 : 1
  ));
  const result = rollingAverages(rows, '1m', BAR);
  const before = at(result, '2026-03-28T23:30Z');
  const after = at(result, '2026-03-28T23:45Z');

  near(before.average, 1);
  assert.equal(before.averageCount, 28 * 96);
  assert.equal(before.averageExpectedCount, 28 * 96);
  near(after.average, 1 + 95 * 2 / (29 * 96));
  assert.equal(after.averageCount, 29 * 96);
  assert.equal(after.averageExpectedCount, 29 * 96);
});

test('a calendar cutoff retreat exposes an old gap again and recovers when that gap leaves the window', () => {
  const missing = Date.parse('2026-02-28T12:00Z');
  const rows = between('2026-02-01T00:00Z', '2026-03-29T12:15Z', () => 4).filter(row => row.time !== missing);
  const result = rollingAverages(rows, '1m', BAR);

  near(at(result, '2026-03-28T23:30Z').average, 4);
  const reentered = at(result, '2026-03-28T23:45Z');
  assert.equal(reentered.average, null);
  assert.equal(reentered.averageCount, 29 * 96 - 1);
  assert.equal(reentered.averageExpectedCount, 29 * 96);
  assert.equal(at(result, '2026-03-29T11:45Z').average, null);
  near(at(result, '2026-03-29T12:00Z').average, 4);
});

test('missing candles remain gaps instead of zeroes or older observations pulled into a full-size window', () => {
  const rows = observations(197, () => 7).filter((_row, index) => index !== 100);
  const result = rollingAverages(rows, '1d', BAR);

  assert.equal(result.length, rows.length);
  assert.equal(result.some(row => row.time === START + 100 * BAR), false);
  near(result.find(row => row.time === START + 99 * BAR).average, 7);
  for (const index of [101, 195]) {
    const point = result.find(row => row.time === START + index * BAR);
    assert.equal(point.average, null);
    assert.equal(point.averageCount, 95);
    assert.equal(point.averageExpectedCount, 96);
  }
  const recovered = result.at(-1);
  near(recovered.average, 7);
  assert.equal(recovered.averageCount, 96);
  assert.equal(recovered.averageExpectedCount, 96);
});

test('appending future prices cannot change any already calculated historical average', () => {
  const prefixLength = 58 * DAY / BAR;
  const rows = observations(prefixLength + 192, index => index < prefixLength ? index % 31 - 15 : 100_000 + index, Date.UTC(2026, 1, 1));
  for (const range of ['1d', '1w', '1m', 'all']) {
    const prefix = rollingAverages(rows.slice(0, prefixLength), range, BAR);
    assert.deepEqual(rollingAverages(rows, range, BAR).slice(0, prefixLength), prefix, range);
  }
});

test('calculating full history before filtering keeps the first visible average fully warmed up', () => {
  const rows = observations(70 * 96, index => index + 1);
  for (const range of ['1d', '1w', '1m']) {
    const visible = filterRows(rollingAverages(rows, range, BAR), range, BAR);
    const first = visible[0];
    const historyToFirst = rows.filter(row => row.time <= first.time);
    const firstWindow = filterRows(historyToFirst, range, BAR);

    assert.equal(first.averageCount, firstWindow.length, range);
    assert.equal(first.averageExpectedCount, firstWindow.length, range);
    near(first.average, (firstWindow[0].spread + first.spread) / 2);
    assert.equal(rollingAverages(filterRows(rows, range, BAR), range, BAR)[0].average, null, range);
  }
});

test('all uses a growing average of available history and reports elapsed coverage without zero filling gaps', () => {
  const values = new Map([[0, 0], [1, -1.25], [4, 2.5], [10, -0.125]]);
  const rows = observations(11, index => values.get(index)).filter((_row, index) => values.has(index));
  const result = rollingAverages(rows, 'all', BAR);

  assert.deepEqual(result.map(row => row.averageCount), [1, 2, 3, 4]);
  assert.deepEqual(result.map(row => row.averageExpectedCount), [1, 2, 5, 11]);
  assert.equal(result[0].average, 0);
  near(result[1].average, -0.625);
  near(result[2].average, 1.25 / 3);
  near(result[3].average, 1.125 / 4);
});

test('complete windows retain true zero, negative spreads and precision below display rounding', () => {
  const value = 0.000123456789;
  const zero = rollingAverages(observations(96, index => [0, value, -value][index % 3]), '1d', BAR).at(-1);
  assert.equal(zero.average, 0);
  assert.equal(zero.averageCount, 96);
  const negative = rollingAverages(observations(96, () => -value), '1d', BAR).at(-1);
  near(negative.average, -value, 1e-15);
});

test('rolling results preserve observation fields without mutating input arrays or rows', () => {
  const rows = observations(100).map(row => ({ ...row, brent: 82.25, wti: 80.1, source: 'fixture' }));
  const original = structuredClone(rows);
  rows.forEach(Object.freeze);
  Object.freeze(rows);

  for (const range of ['1d', '1w', '1m', 'all']) {
    const result = rollingAverages(rows, range, BAR);
    assert.notEqual(result, rows);
    result.forEach((row, index) => {
      assert.notEqual(row, rows[index]);
      const { average, averageCount, averageExpectedCount, ...observation } = row;
      assert.deepEqual(observation, original[index]);
      assert.ok(average === null || Number.isFinite(average));
      assert.ok(Number.isInteger(averageCount));
      assert.ok(Number.isInteger(averageExpectedCount));
    });
  }
  assert.deepEqual(rows, original);
});

test('empty history has no synthetic average points', () => {
  for (const range of ['1d', '1w', '1m', 'all']) assert.deepEqual(rollingAverages([], range, BAR), []);
});
