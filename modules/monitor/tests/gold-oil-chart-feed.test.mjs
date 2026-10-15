import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_OIL_INTERVAL_MS as STEP } from '../lib/gold-oil.ts';
import { projectGoldOilChartData } from '../lib/gold-oil-chart-data.ts';
import { mergeGoldOilChartData, goldOilChartOverviewTrend } from '../lib/gold-oil-chart-feed.ts';
import { analyzeAvailableGoldOilFunding } from '../lib/gold-oil-funding.ts';

const now = Date.UTC(2026, 9, 16), count = 1000, start = now - count * STEP;
function sources(end = now) {
  const fetchedAt = new Date(end).toISOString();
  return {
    history: { oilType: 'cl', source: 'Binance', currency: 'USDT', priceBasis: 'mark', interval: '15m', status: 'live', fetchedAt, coverageStart: start,
      points: Array.from({ length: (end - start) / STEP }, (_, i) => ({ time: start + i * STEP, oil: 80, xau: 4000 + i, ratio: (4000 + i) / 80 })) },
    funding: { oilType: 'cl', source: 'Binance', fetchedAt, status: 'live', coverageStart: start, coverageEnd: end,
      points: Array.from({ length: Math.floor((end - start) / (4 * STEP)) }, (_, i) => ({ time: start + i * 4 * STEP, oil: 0, xau: 0.0001 })) },
  };
}
function report(range = '7d', end = now) { const source = sources(end); return projectGoldOilChartData(source.history, source.funding, range); }

test('failed sections retain the selected range data, original times, and complete-history summary', () => {
  const previous = report(), before = structuredClone(previous);
  const missing = projectGoldOilChartData(null, null, '7d', 'cl', 'binance', { historyError: 'offline', fundingError: 'offline' });
  const merged = mergeGoldOilChartData(previous, missing);
  assert.strictEqual(merged.history, previous.history);
  assert.strictEqual(merged.funding, previous.funding);
  assert.strictEqual(merged.window, previous.window);
  assert.strictEqual(merged.fullHistory, previous.fullHistory);
  assert.equal(merged.history.fetchedAt, new Date(now).toISOString());
  assert.equal(merged.state, 'partial');
  assert.equal(merged.historyError, 'offline');
  assert.deepEqual(previous, before);
});

test('a failed range or another market cannot borrow points, coverage, or summary from the previous selection', () => {
  const previous = report();
  for (const [range, oilType, exchange] of [['1d', 'cl', 'binance'], ['7d', 'bz', 'binance'], ['7d', 'cl', 'bybit']]) {
    const missing = projectGoldOilChartData(null, null, range, oilType, exchange);
    assert.strictEqual(mergeGoldOilChartData(previous, missing), missing);
    assert.equal(missing.history, null); assert.equal(missing.funding, null); assert.equal(missing.fullHistory, null);
  }
});

test('new prices do not renew retained funding coverage or fabricate settlement at the new tail', () => {
  const previous = report(), source = sources(now + STEP);
  const incoming = projectGoldOilChartData(source.history, null, '7d', 'cl', 'binance', { fundingError: 'funding offline' });
  const merged = mergeGoldOilChartData(previous, incoming);
  assert.strictEqual(merged.history, incoming.history);
  assert.strictEqual(merged.fullHistory, incoming.fullHistory);
  assert.strictEqual(merged.funding, previous.funding);
  assert.equal(merged.funding.coverageEnd, now);
  assert.equal(merged.funding.fetchedAt, new Date(now).toISOString());
  const fees = analyzeAvailableGoldOilFunding(merged.funding, merged.window.start, merged.window.end);
  assert.equal(fees.covered, true); assert.equal(fees.selectedCovered, false); assert.equal(fees.end, now);
  const recovered = report('7d', now + STEP);
  assert.deepEqual(mergeGoldOilChartData(merged, recovered), recovered);
});

test('new funding remains usable while prices are absent, then recovers without losing its source window', () => {
  const pending = projectGoldOilChartData(null, null), source = sources();
  const fundingOnly = projectGoldOilChartData(null, source.funding);
  const merged = mergeGoldOilChartData(pending, fundingOnly);
  assert.deepEqual(merged.window, fundingOnly.window);
  assert.deepEqual(merged.funding, fundingOnly.funding);
  assert.equal(merged.history, null);
  const failed = mergeGoldOilChartData(merged, pending);
  assert.deepEqual(failed.window, merged.window);
  assert.deepEqual(failed.funding, merged.funding);
  assert.equal(failed.state, 'partial');
  assert.ok(failed.fundingError);
  assert.deepEqual(mergeGoldOilChartData(merged, report()), report());
});

test('one-day details never replace the seven-day overview; longer ranges preserve gaps and source time', () => {
  const source = sources(); source.history.points.at(-10).xau = null;
  const week = projectGoldOilChartData(source.history, source.funding), trend = goldOilChartOverviewTrend(week);
  assert.equal(trend.points.length, 671);
  assert.equal(trend.points[0].time, now - 672 * STEP);
  assert.equal(trend.fetchedAt, new Date(now).toISOString());
  assert.strictEqual(goldOilChartOverviewTrend(report('1d'), trend), trend);
  const all = projectGoldOilChartData(source.history, source.funding, 'all');
  assert.deepEqual(goldOilChartOverviewTrend(all), trend);
  const failed = mergeGoldOilChartData(week, projectGoldOilChartData(null, null));
  assert.equal(goldOilChartOverviewTrend(failed).status, 'stale');
  assert.equal(goldOilChartOverviewTrend(failed).fetchedAt, trend.fetchedAt);
});
