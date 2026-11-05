import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decimalDifference, oilSpreadPercent } from '../modules/oil/spread.mjs';
import { intradayChartRows, recentIntradayChartRows, createIntradaySnapshot, OIL_CANDLE_MS } from '../modules/oil/intraday.mjs';
import { oilHistory } from '../lib/oil-history.ts';
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
  assert.deepEqual(oilHistory(candles).points.map(point => point.premium), [5, 10, -6.25], 'the shared chart reads the recalculated per-bar spread');
  const quote = { source: 'Binance', currency: 'USDT', fetchedAt, status: 'snapshot', brent: { coin: 'BZUSDT', markPx: 75, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null }, wti: { coin: 'CLUSDT', markPx: 80, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null } };
  const initial = initialSummaries({ renderedAt: Date.parse(fetchedAt), oil: { quote, candles }, hynix: { quote: null, trend: null } }).oil;
  const live = oilSummary({ status: 'stale', spread: oilSpreadPercent(75, 80), fundingHourlyRate: null, fundingBasis: 'quantity', fetchedAt, history: { points: rows.map(row => ({ time: row.time, value: row.spread })), fetchedAt, status: candles.status } });
  assert.equal(initial.metrics[0].value, '−6.250%');
  assert.deepEqual(initial.metrics, live.metrics);
  assert.deepEqual(initial.trend, live.trend);
  assert.equal(initial.trend.unit, '%');
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
  assert.deepEqual(rows.map(row => row.absolute), [3.9, 0, -1.5]);
  assert.deepEqual(points.map(point => point.spread), [3.9, 0, -1.5], 'chart USDT spread is the decimal Brent − WTI difference');
  assert.deepEqual(points.map(point => [point.adr, point.equivalent]), [[70.1, 66.2], [65.3, 65.3], [64.9, 66.4]]);
  assert.deepEqual(points.map(point => point.premium), rows.map(row => row.spread));
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
const referenceSpreadPercent = (brent, wti) => {
  if (![brent, wti].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
  const value = referenceDecimalDifference(brent, wti) / wti * 100;
  return Number.isFinite(value) ? value : null;
};

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
    assert.ok(Object.is(oilSpreadPercent(left, right), referenceSpreadPercent(left, right)), `${left} / ${right}`);
  }
  const rows = intradayChartRows(saved);
  assert.deepEqual(rows.map(row => [row.spread, row.absolute]), saved.data.filter(row => row.brent !== null && row.wti !== null).map(row => [referenceSpreadPercent(row.brent, row.wti), referenceDecimalDifference(row.brent, row.wti)]));
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
    const initial = initialSummaries({ renderedAt: Date.parse(candles.metadata.fetchedAt), oil: { quote: null, candles }, hynix: { quote: null } }).oil;
    assert.deepEqual(initial.trend, oilSummary({ status: 'loading', spread: null, fundingHourlyRate: null, fundingBasis: 'quantity', fetchedAt: null, history }).trend);
    assert.deepEqual(candles, before);
  }
  assert.throws(() => recentIntradayChartRows({ ...gapped, metadata: { ...gapped.metadata, pairedObservationRows: 1 } }, 7 * day), /mismatch/, 'the whole snapshot is still validated');
});
