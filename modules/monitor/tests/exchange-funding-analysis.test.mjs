import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFundingRange, fundingRangeInput, parseFundingRangeInput } from '../lib/exchange-funding-analysis.ts';
import { validateExchangeFundingHistory, HISTORY_PAGE_SIZE, HISTORY_WINDOW_MS } from '../lib/exchange-funding-history.ts';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000;
function history(rows, patch = {}) {
  const fetchedAt = new Date(NOW).toISOString(), coverage = { from: NOW - HISTORY_WINDOW_MS, to: NOW };
  return validateExchangeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', currency: 'USD', fetchedAt, status: 'live', availability: 'supported', reason: '',
    left: { symbol: 'xyz:BRENTOIL', fetchedAt, error: '', coverage }, right: { symbol: 'xyz:CL', fetchedAt, error: '', coverage }, rows, ...patch,
  }, 'hyperliquid');
}

test('Beijing range inputs parse independently of local timezone and reject impossible calendar dates', () => {
  assert.equal(fundingRangeInput(NOW), '2026-10-01T18:00');
  assert.equal(parseFundingRangeInput('2026-10-01T18:00'), NOW);
  assert.equal(parseFundingRangeInput('2026-10-02T00:00'), Date.UTC(2026, 9, 1, 16));
  for (const input of ['', '2026-02-30T12:00', '2026-10-01T24:00', '2026-10-01T18:00Z', '2026-10-01']) assert.equal(parseFundingRangeInput(input), null);
});

test('all settlements in the interval contribute beyond the 200-row page, with simple sums instead of compounding', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ time: NOW - (index + 1) * HOUR, leftRate: 0.0001, rightRate: index % 4 === 0 ? -0.0004 : null }));
  const selected = analyzeFundingRange(history(rows), { from: NOW - HISTORY_WINDOW_MS, to: NOW }, 'short');
  assert.equal(selected.left.count, 1000); assert.equal(selected.right.count, 250);
  assert.equal(selected.left.rawRate, 0.1); assert.equal(selected.right.rawRate, -0.1);
  assert.equal(selected.left.positionRate, 0.1); assert.equal(selected.right.positionRate, 0.1);
  assert.equal(selected.left.records.slice(0, HISTORY_PAGE_SIZE).length, 200);
  assert.equal(selected.left.coverage, 'queried');
  const opposite = analyzeFundingRange(history(rows), { from: NOW - HISTORY_WINDOW_MS, to: NOW }, 'long');
  assert.equal(opposite.left.rawRate, selected.left.rawRate); assert.equal(opposite.left.positionRate, -0.1); assert.equal(opposite.right.positionRate, -0.1);
});

test('range includes its exact start and excludes end, while keeping independent asynchronous settlements', () => {
  const from = NOW - HOUR, to = NOW;
  const input = history([{ time: from - 1, leftRate: 0.1, rightRate: null }, { time: from, leftRate: 0, rightRate: null }, { time: from + 21, leftRate: null, rightRate: -0.0002 }, { time: to - 1, leftRate: 0.0001, rightRate: null }, { time: to, leftRate: 0.1, rightRate: 0.1 }]);
  const selected = analyzeFundingRange(input, { from, to }, 'short');
  assert.equal(selected.left.count, 2); assert.equal(selected.right.count, 1);
  assert.equal(selected.left.rawRate, 0.0001); assert.equal(selected.right.rawRate, -0.0002);
  assert.deepEqual(selected.left.records.map(row => row.time), [to - 1, from]);
});

test('no records is not a zero rate; true zeros remain zero; stale or unknown coverage is explicit', () => {
  const input = history([{ time: NOW - HOUR, leftRate: 0, rightRate: null }]);
  input.right.coverage = null;
  const range = { from: NOW - 2 * HOUR, to: NOW };
  let selected = analyzeFundingRange(input, range, 'long');
  assert.equal(selected.left.rawRate, 0); assert.equal(selected.left.positionRate, 0);
  assert.equal(selected.right.rawRate, null); assert.equal(selected.right.positionRate, null); assert.equal(selected.right.coverage, 'unknown');
  input.left.coverage.to = NOW - 2 * HOUR; input.left.error = 'retained';
  selected = analyzeFundingRange(input, range, 'short');
  assert.equal(selected.left.coverage, 'partial'); assert.equal(selected.left.error, 'retained');
  const outside = analyzeFundingRange(input, { from: NOW + HOUR, to: NOW + 2 * HOUR }, 'short');
  assert.equal(outside.left.count, 0); assert.equal(outside.left.rawRate, null); assert.equal(outside.left.coverage, 'partial');
});

test('invalid or overly long ranges are rejected without producing cumulative values', () => {
  const input = history([]);
  for (const range of [{ from: NOW, to: NOW }, { from: NOW, to: NOW - 1 }, { from: NOW - HISTORY_WINDOW_MS - 1, to: NOW }, { from: NaN, to: NOW }, { from: NOW - 0.5, to: NOW }]) assert.throws(() => analyzeFundingRange(input, range, 'short'));
});
