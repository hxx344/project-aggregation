import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decimalDifference, oilSpread } from '../modules/oil/spread.mjs';
import { intradayChartRows, recentIntradayChartRows, createIntradaySnapshot, OIL_CANDLE_MS } from '../modules/oil/intraday.mjs';
import { oilHistory } from '../lib/oil-history.ts';
import { initialSummaries } from '../lib/initial-market.ts';
import { oilSummary } from '../lib/monitor-summary.ts';
import { oilTrend } from '../server/initial-market.mjs';

test('oil spread is Brent − WTI on decimal quotes and unavailable for invalid legs', () => {
  for (const [brent, wti, expected] of [[80, 75, 5], [75, 80, -5], [80, 80, 0], [75.3, 75, 0.3], [70.1, 66.2, 3.9]]) {
    assert.equal(oilSpread(brent, wti), expected);
  }
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '75']) {
    assert.equal(oilSpread(80, bad), null);
    assert.equal(oilSpread(bad, 75), null);
  }
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
  assert.deepEqual(rows.map(row => row.spread), [5, 5, -5]);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'date')), 'chart rows carry no unused per-row date strings');
  assert.equal(rows[2].time - rows[1].time, 2 * OIL_CANDLE_MS);
  assert.deepEqual(oilHistory(candles).points.map(point => point.spread), [5, 5, -5], 'the shared chart reads the recalculated per-bar spread');
  const quote = { source: 'Binance', currency: 'USDT', fetchedAt, status: 'snapshot', brent: { coin: 'BZUSDT', markPx: 75, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null }, wti: { coin: 'CLUSDT', markPx: 80, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null } };
  const initial = initialSummaries({ renderedAt: Date.parse(fetchedAt), oil: { quote, trend: oilTrend(candles) }, hynix: { quote: null, trend: null } }).oil;
  const live = oilSummary({ status: 'stale', spread: oilSpread(75, 80), fundingHourlyRate: null, fundingBasis: 'quantity', fetchedAt, history: { points: rows.map(row => ({ time: row.time, value: row.spread })), fetchedAt, status: candles.status } });
  assert.equal(initial.metrics[0].value, '−5.000');
  assert.equal(initial.metrics[0].label, '价差 · USDT/桶');
  assert.deepEqual(initial.metrics, live.metrics);
  assert.deepEqual(initial.trend, live.trend);
  assert.equal(initial.trend.unit, ' USDT/桶');
  assert.deepEqual(candles, saved);
});

test('absolute spread is Brent − WTI per bar with decimal precision and drives the shared chart', () => {
  const start = Date.UTC(2026, 8, 20), fetchedAt = new Date(start + 3 * OIL_CANDLE_MS).toISOString();
  const snapshot = createIntradaySnapshot([
    { time: start, brent: 70.1, wti: 66.2 },
    { time: start + OIL_CANDLE_MS, brent: 65.3, wti: 65.3 },
    { time: start + 2 * OIL_CANDLE_MS, brent: 64.9, wti: 66.4 },
  ], fetchedAt);
  const rows = intradayChartRows(snapshot), { points } = oilHistory(snapshot);
  assert.deepEqual(rows.map(row => row.spread), [3.9, 0, -1.5]);
  assert.deepEqual(points.map(point => point.spread), [3.9, 0, -1.5], 'chart USDT spread is the decimal Brent − WTI difference');
  assert.deepEqual(points.map(point => [point.adr, point.equivalent]), [[70.1, 66.2], [65.3, 65.3], [64.9, 66.4]]);
  assert.ok(points.every(point => Number.isNaN(point.premium)), 'oil no longer computes a percentage premium');
});

// The original string + BigInt implementation; the integer-scaled fast path must match it bit for bit.
function referenceDecimalDifference(left, right) {
  const parts = value => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { integer: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right), scale = Math.max(0, a.scale, b.scale);
  const difference = a.integer * 10n ** BigInt(scale - a.scale) - b.integer * 10n ** BigInt(scale - b.scale);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  return Number((difference < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

test('integer-scaled decimal difference is bit-identical to the BigInt reference on saved candles and precision edges', async () => {
  const saved = JSON.parse(await readFile(new URL('../public/oil/data/binance-15m.json', import.meta.url), 'utf8'));
  const pairs = saved.data.filter(row => row.brent !== null && row.wti !== null).map(row => [row.brent, row.wti]);
  assert.ok(pairs.length > 10_000);
  let seed = 141;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let i = 0; i < 20_000; i++) {
    const digits = Math.floor(random() * 9);
    pairs.push([Number((random() * 200).toFixed(digits)), Number((random() * 200).toFixed(8 - digits))], [random() * 1e3, random() * 1e3]);
  }
  pairs.push([0.1, 0.2], [0.3, 0.1], [1e-7, 3e-8], [1e21, 1], [1.5e300, 2], [Number.MAX_SAFE_INTEGER, 0.5], [Number('9007199254740.993'), 0.001], [Number('123456789.12345678'), 0.00000001], [5e-324, 1], [Number.MIN_VALUE, Number.MAX_VALUE], [80, 80], [-1.25, 0.75], [0, 0]);
  for (const [left, right] of pairs) {
    assert.ok(Object.is(decimalDifference(left, right), referenceDecimalDifference(left, right)), `${left} - ${right}`);
  }
  const rows = intradayChartRows(saved);
  assert.deepEqual(rows.map(row => row.spread), saved.data.filter(row => row.brent !== null && row.wti !== null).map(row => referenceDecimalDifference(row.brent, row.wti)));
});

test('the first-render oil trend only builds its window yet matches the trend from all chart rows', async () => {
  const saved = JSON.parse(await readFile(new URL('../public/oil/data/binance-15m.json', import.meta.url), 'utf8'));
  const start = Date.UTC(2026, 8, 1), day = 86_400_000;
  const rows = Array.from({ length: 9 * 96 }, (_, index) => ({ time: start + index * OIL_CANDLE_MS, brent: 70 + (index % 7) / 10, wti: 66 + (index % 5) / 100 }))
    .filter((_, index) => index < 300 || index > 340);
  rows.push({ time: rows.at(-1).time + OIL_CANDLE_MS, brent: 71.2, wti: null }, { time: rows.at(-1).time + 3 * OIL_CANDLE_MS, brent: null, wti: 65.5 });
  const gapped = createIntradaySnapshot(rows, new Date(rows.at(-1).time + 2 * OIL_CANDLE_MS).toISOString());
  const short = createIntradaySnapshot(rows.slice(0, 20), new Date(rows[20].time).toISOString());
  for (const candles of [saved, gapped, short]) {
    const before = structuredClone(candles);
    const full = intradayChartRows(candles);
    assert.deepEqual(recentIntradayChartRows(candles, 7 * day), full.filter(row => row.time >= full.at(-1).time + OIL_CANDLE_MS - 7 * day));
    const history = { points: full.map(row => ({ time: row.time, value: row.spread })), status: candles.status, fetchedAt: candles.metadata.fetchedAt };
    const initial = initialSummaries({ renderedAt: Date.parse(candles.metadata.fetchedAt), oil: { quote: null, trend: oilTrend(candles) }, hynix: { quote: null } }).oil;
    assert.deepEqual(initial.trend, oilSummary({ status: 'loading', spread: null, fundingHourlyRate: null, fundingBasis: 'quantity', fetchedAt: null, history }).trend);
    assert.deepEqual(candles, before);
  }
  assert.throws(() => recentIntradayChartRows({ ...gapped, metadata: { ...gapped.metadata, pairedObservationRows: 1 } }, 7 * day), /mismatch/, 'the whole snapshot is still validated');
  assert.equal(oilTrend({ ...gapped, metadata: { ...gapped.metadata, pairedObservationRows: 1 } }), null, 'an invalid snapshot embeds no trend');
  assert.equal(oilTrend(null), null);
  assert.deepEqual(oilTrend({ ...gapped, status: 'snapshot' }).status, 'snapshot', 'the embedded trend keeps the source status');
});
