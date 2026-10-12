import test from 'node:test';
import assert from 'node:assert/strict';
import { oilSpreadPercent } from '../modules/oil/spread.mjs';
import { intradayChartRows, createIntradaySnapshot, OIL_CANDLE_MS } from '../modules/oil/intraday.mjs';
import { summarize, monthlyAverages } from '../modules/oil/data-utils.mjs';
import { initialSummaries } from '../lib/initial-market.ts';
import { oilSummary } from '../lib/monitor-summary.ts';

test('oil percentage uses WTI as the base and preserves decimal equality and unavailable values', () => {
  for (const [brent, wti, expected] of [[80, 75, 20 / 3], [75, 80, -6.25], [80, 80, 0], [105, 100, 5], [75.3, 75, 0.4]]) {
    assert.ok(Math.abs(oilSpreadPercent(brent, wti) - expected) < 1e-12);
  }
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '75']) {
    assert.equal(oilSpreadPercent(80, bad), null);
    assert.equal(oilSpreadPercent(bad, 75), null);
  }
  assert.equal(oilSpreadPercent(Number.MAX_VALUE, Number.MIN_VALUE), null);
});

test('saved prices are recalculated per bar before averaging and SSR matches the live summary', () => {
  const start = Date.UTC(2026, 8, 20), fetchedAt = new Date(start + 4 * OIL_CANDLE_MS).toISOString();
  const candles = createIntradaySnapshot([
    { time: start, brent: 105, wti: 100 },
    { time: start + OIL_CANDLE_MS, brent: 55, wti: 50 },
    { time: start + 2 * OIL_CANDLE_MS, brent: 70, wti: null },
    { time: start + 3 * OIL_CANDLE_MS, brent: 75, wti: 80 },
  ], fetchedAt);
  const saved = structuredClone(candles), rows = intradayChartRows(candles);
  assert.deepEqual(rows.map(row => row.spread), [5, 10, -6.25]);
  assert.equal(rows[2].time - rows[1].time, 2 * OIL_CANDLE_MS);
  assert.equal(summarize(rows).average, 8.75 / 3);
  assert.equal(monthlyAverages(rows)[0].average, 8.75 / 3);
  const quote = { source: 'Binance', currency: 'USDT', fetchedAt, status: 'snapshot', brent: { coin: 'BZUSDT', markPx: 75, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null }, wti: { coin: 'CLUSDT', markPx: 80, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null } };
  const initial = initialSummaries({ renderedAt: Date.parse(fetchedAt), oil: { quote, candles }, hynix: { quote: null, history: null } }).oil;
  const live = oilSummary({ status: 'stale', spread: oilSpreadPercent(75, 80), fundingHourlyRate: null, fundingBasis: 'quantity', fetchedAt, history: { points: rows.map(row => ({ time: row.time, value: row.spread })), fetchedAt, status: candles.status } });
  assert.equal(initial.metrics[0].value, '−6.250%');
  assert.deepEqual(initial.metrics, live.metrics);
  assert.deepEqual(initial.trend, live.trend);
  assert.equal(initial.trend.unit, '%');
  assert.deepEqual(candles, saved);
});
