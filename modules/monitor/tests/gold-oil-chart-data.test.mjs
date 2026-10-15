import test from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_OIL_EXCHANGES, GOLD_OIL_INTERVAL_MS as STEP, GOLD_OIL_VARIANTS, goldOilAction, goldOilChartPoints, validateGoldOilHistory } from '../lib/gold-oil.ts';
import { analyzeAvailableGoldOilFunding, validateGoldOilFunding } from '../lib/gold-oil-funding.ts';
import { goldOilStatistics } from '../lib/gold-oil-analysis.ts';
import { parseGoldOilChartRange, projectGoldOilChartData, readGoldOilChartData, validateGoldOilChartData } from '../lib/gold-oil-chart-data.ts';

const END = Date.UTC(2026, 2, 31, 12, 30), HOUR = 3600000;
function fixture({ oilType = 'cl', exchange = 'binance', count = 20000, end = END } = {}) {
  const start = end - count * STEP, fetchedAt = new Date(end + 12345).toISOString(), source = GOLD_OIL_EXCHANGES[exchange].name;
  const history = validateGoldOilHistory({ oilType, source, fetchedAt, status: 'snapshot', interval: '15m', currency: 'USDT', priceBasis: 'mark', coverageStart: start,
    points: Array.from({ length: count }, (_, i) => ({ time: start + i * STEP, oil: i % 11 ? 80 + i % 10 : null, xau: i % 13 ? 2800 + i % 1000 : null })).filter((_, i) => i % 17 !== 5) }, oilType, exchange);
  const funding = validateGoldOilFunding({ oilType, source, fetchedAt, status: 'snapshot', coverageStart: start + 1, coverageEnd: end - HOUR,
    points: Array.from({ length: Math.ceil(count / 4) }, (_, i) => ({ time: start + i * HOUR, oil: i % 3 ? i % 5 / 10000 : null, xau: i % 3 ? null : 0.0001 })).filter(row => row.time >= start + 1 && row.time < end - HOUR) }, oilType, exchange);
  return { history, funding };
}

for (const variant of GOLD_OIL_VARIANTS) test(`selected chart windows match full-history references for ${variant.exchange}/${variant.oilType}`, () => {
  const { history, funding } = fixture(variant), before = JSON.stringify({ history, funding });
  for (const [range, days] of [['1d', 1], ['7d', 7], ['1m', '1m'], ['all', 0]]) {
    const data = projectGoldOilChartData(history, funding, range, variant.oilType, variant.exchange), fullPoints = goldOilChartPoints(history, days);
    assert.deepEqual(data.history.points, fullPoints);
    assert.deepEqual(data.window, { start: fullPoints[0].time, end: fullPoints.at(-1).time + STEP });
    assert.deepEqual(analyzeAvailableGoldOilFunding(data.funding, data.window.start, data.window.end), analyzeAvailableGoldOilFunding(funding, data.window.start, data.window.end));
    const stats = goldOilStatistics(history.points);
    assert.deepEqual(data.fullHistory, { first: { time: stats.first.time, ratio: stats.first.ratio }, last: { time: stats.last.time, ratio: stats.last.ratio }, change: stats.change, percentChange: stats.percentChange });
    assert.equal(data.history.fetchedAt, history.fetchedAt); assert.equal(data.funding.fetchedAt, funding.fetchedAt);
    assert.equal(data.history.status, 'snapshot'); assert.equal(data.funding.status, 'snapshot');
    assert.deepEqual(data.fundingSourceCoverage, { start: funding.coverageStart, end: funding.coverageEnd });
    assert.deepEqual(validateGoldOilChartData(data, range, variant.oilType, variant.exchange), data);
    if (range === '7d') { assert.equal(data.history.points.length, 672); assert.ok(data.funding.points.length <= 168); assert.ok(JSON.stringify(data).length < 115000); }
  }
  assert.equal(JSON.stringify({ history, funding }), before);
});

test('one calendar month clamps UTC month ends including leap years', () => {
  for (const [end, expected] of [[Date.UTC(2026, 2, 31, 12, 30), Date.UTC(2026, 1, 28, 12, 30)], [Date.UTC(2024, 2, 31, 12, 30), Date.UTC(2024, 1, 29, 12, 30)], [Date.UTC(2026, 0, 31, 12, 30), Date.UTC(2025, 11, 31, 12, 30)]]) {
    const { history, funding } = fixture({ count: 10000, end });
    const data = projectGoldOilChartData(history, funding, '1m');
    assert.equal(data.window.start, expected); assert.equal(data.window.end, end);
  }
});

test('selected windows preserve missing and unpaired prices, actual zero fees and empty observations', () => {
  const { history, funding } = fixture({ count: 1000 });
  const emptyTail = { ...history, points: history.points.filter(point => point.time < END - 7 * 86400000) };
  const data = projectGoldOilChartData(emptyTail, funding, '7d');
  assert.equal(data.history.points.length, 672); assert.ok(data.history.points.every(point => point.ratio === null && point.oil === null && point.xau === null));
  assert.ok(data.fullHistory.first.ratio > 0); assert.deepEqual(validateGoldOilChartData(data), data);
  assert.deepEqual(validateGoldOilChartData({ ...data, history: { ...data.history, points: [] } }).history.points, []);
  const unpaired = projectGoldOilChartData({ ...history, points: history.points.map(point => point.time >= END - 86400000 ? { ...point, oil: null, cl: null } : point) }, funding, '1d');
  assert.ok(unpaired.history.points.some(point => point.xau > 0)); assert.ok(unpaired.history.points.every(point => point.ratio === null));
  const zeroFees = { ...funding, points: [{ time: END - 3 * HOUR, oil: 0, cl: 0, xau: 0 }] };
  const zero = projectGoldOilChartData(history, zeroFees);
  assert.equal(analyzeAvailableGoldOilFunding(zero.funding, zero.window.start, zero.window.end).shortAnnualized, 0);
  const noFees = projectGoldOilChartData(history, { ...funding, points: [] });
  assert.equal(analyzeAvailableGoldOilFunding(noFees.funding, noFees.window.start, noFees.window.end).shortAnnualized, null);
});

test('missing funding prefixes stay uncovered and disjoint funding is distinct from zero settlements', () => {
  const { history, funding } = fixture();
  const late = { ...funding, coverageStart: END - 86400000, points: funding.points.filter(row => row.time >= END - 86400000) };
  const data = projectGoldOilChartData(history, late);
  assert.equal(data.funding.coverageStart, late.coverageStart);
  assert.equal(analyzeAvailableGoldOilFunding(data.funding, data.window.start, data.window.end).covered, false);
  const early = { ...funding, coverageEnd: END - 8 * 86400000, points: funding.points.filter(row => row.time < END - 8 * 86400000) };
  const disjoint = projectGoldOilChartData(history, early);
  assert.equal(disjoint.funding, null); assert.match(disjoint.fundingError, /尚未覆盖/); assert.equal(disjoint.state, 'partial');
  assert.deepEqual(disjoint.fundingSourceCoverage, { start: early.coverageStart, end: early.coverageEnd });
  assert.deepEqual(validateGoldOilChartData(disjoint), disjoint);
});

test('sources fail independently and pending recovers on the next read without cached failure', async () => {
  const { history, funding } = fixture({ oilType: 'bz', exchange: 'bybit' }), calls = [];
  let historyReady = false, fundingReady = false;
  const read = action => { calls.push(action); if (action.endsWith('history') && historyReady) return history; if (action.endsWith('funding') && fundingReady) return funding; throw Error('数据库正在采集'); };
  const load = () => readGoldOilChartData(read, '7d', 'bz', 'bybit');
  assert.equal((await load()).state, 'pending');
  historyReady = true;
  const priceOnly = await load(); assert.equal(priceOnly.state, 'partial'); assert.equal(priceOnly.history.points.length, 672); assert.equal(priceOnly.funding, null);
  historyReady = false; fundingReady = true;
  const fundingOnly = await load(); assert.equal(fundingOnly.state, 'partial'); assert.equal(fundingOnly.history, null); assert.ok(fundingOnly.funding.points.length); assert.deepEqual(validateGoldOilChartData(fundingOnly, '7d', 'bz', 'bybit'), fundingOnly);
  historyReady = true;
  assert.equal((await load()).state, 'ready'); assert.equal(calls.length, 8);
  assert.ok(calls.every(action => action === goldOilAction('history', 'bz', 'bybit') || action === goldOilAction('funding', 'bz', 'bybit')));
  const malformed = projectGoldOilChartData({ ...history, source: 'Binance' }, funding, '7d', 'bz', 'bybit'); assert.equal(malformed.history, null); assert.ok(malformed.funding);
  const stale = projectGoldOilChartData({ ...history, collection: { error: '原价格读取失败' } }, funding, '7d', 'bz', 'bybit'); assert.equal(stale.historyError, '原价格读取失败'); assert.equal(stale.history.fetchedAt, history.fetchedAt);
});

test('chart validation rejects wrong identities, forged coverage, unsafe ranges and unsorted candles', () => {
  const { history, funding } = fixture(), data = projectGoldOilChartData(history, funding);
  for (const range of ['', '30d', '7', 7, {}, ['7d']]) assert.throws(() => parseGoldOilChartRange(range), { status: 400 });
  assert.equal(parseGoldOilChartRange(null), '7d');
  for (const change of [{ range: '1d' }, { scope: 'history' }, { exchange: 'bybit' }, { oilType: 'bz' }, { source: 'Bybit' }, { state: 'pending' }, { window: { start: END - 8 * 86400000, end: END } }, { history: { ...data.history, points: [...data.history.points].reverse() } }, { funding: { ...data.funding, coverageStart: data.funding.coverageStart - 1 } }, { fullHistory: { ...data.fullHistory, change: 999 } }]) assert.throws(() => validateGoldOilChartData({ ...data, ...change }));
});
