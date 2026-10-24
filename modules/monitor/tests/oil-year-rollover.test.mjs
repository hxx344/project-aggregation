import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateOilHistory } from '../lib/market-validation.ts';
import { validateRows } from '../modules/oil/data-utils.mjs';
import { ASSETS, DAY, pairDailyCandles } from '../modules/oil/hyperliquid.mjs';
import { HOUR, analyzeFundingRange, analyzeFundingWindow, createFundingSnapshot, fetchFundingSnapshot, validateFundingRows } from '../modules/oil/funding-history.mjs';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector, marketJobs, seedMarketDatabase } from '../server/market-collector.mjs';

const NEW_YEAR = Date.UTC(2027, 0, 1), NOW = NEW_YEAR + DAY;
const stamp = time => new Date(time).toISOString();
const daily = date => ({ date, brent: 105, wti: 100 });
const market = fetchedAt => ({ source: 'Binance', currency: 'USDT', fetchedAt,
  brent: { coin: 'BZUSDT', markPx: 105, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null },
  wti: { coin: 'CLUSDT', markPx: 100, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null },
});
const history = (data, fetchedAt = stamp(NOW)) => {
  const paired = data.filter(row => row.brent !== null && row.wti !== null);
  return { data, market: market(fetchedAt), status: 'live', metadata: {
    source: 'Binance', currency: 'USDT', interval: '1d', timezone: 'UTC', fetchedAt,
    firstCommonObservation: paired[0]?.date, lastCommonObservation: paired.at(-1)?.date, pairedObservationRows: paired.length,
  } };
};
const candle = (coin, time, price) => ({ s: coin, i: '1d', t: time, T: time + DAY - 1, c: String(price) });

test('completed daily history accepts consecutive years and a real leap day', () => {
  const data = [daily('2026-12-31'), daily('2027-01-01')];
  assert.deepEqual(validateOilHistory(history(data)).data, data);
  assert.deepEqual(validateRows(data).map(row => row.date), ['2026-12-31', '2027-01-01']);
  const leapDay = [daily('2028-02-29')];
  assert.deepEqual(validateOilHistory(history(leapDay, '2028-03-01T00:00:00Z')).data, leapDay);
});

test('daily guards reject malformed and impossible dates, including unpaired rows', () => {
  for (const date of ['2027-1-01', '2027/01/01', '2027-01-01T00:00:00Z', '2027-13-01', '2027-02-29', '2026-02-30', null]) {
    assert.throws(() => validateRows([daily(date)]), /Invalid daily observation/);
    assert.throws(() => validateOilHistory(history([daily('2026-01-01'), { ...daily(date), brent: null }], '2028-03-01T00:00:00Z')), /Invalid oil candle date/);
  }
});

test('cross-year daily history still rejects duplicates, reverse order and incomplete or future days', () => {
  for (const data of [
    [daily('2027-01-01'), daily('2026-12-31')],
    [daily('2026-12-31'), daily('2026-12-31')],
  ]) {
    assert.throws(() => validateRows(data), /Invalid daily observation/);
    assert.throws(() => validateOilHistory(history(data)), /Invalid oil candle date/);
  }
  for (const date of ['2027-01-02', '2027-01-03']) assert.throws(() => validateOilHistory(history([daily(date)])), /Invalid oil candle date/);
  assert.throws(() => validateOilHistory(history([daily('2027-01-01')], stamp(NEW_YEAR + HOUR))), /Invalid oil candle date/);
});

test('Hyperliquid daily pairing keeps both years and excludes the unfinished day', () => {
  const times = [NEW_YEAR - DAY, NEW_YEAR, NEW_YEAR + DAY];
  const paired = pairDailyCandles(times.map(time => candle(ASSETS.brent.coin, time, 105)),
    times.map(time => candle(ASSETS.wti.coin, time, 100)), NOW + HOUR);
  assert.deepEqual(paired.data, [daily('2026-12-31'), daily('2027-01-01')]);
  assert.equal(validateRows(paired.data).length, 2);
});

test('Hyperliquid funding refresh merges new-year settlements with retained history and analyzes across the boundary', async () => {
  const old = { time: NEW_YEAR - HOUR, brent: 0.003, wti: 0.001 };
  const existing = createFundingSnapshot([old], stamp(NEW_YEAR - 1));
  const before = structuredClone(existing);
  const refreshed = await fetchFundingSnapshot(existing, { now: NEW_YEAR + HOUR, fetcher: async (_url, init) => {
    const request = JSON.parse(init.body), time = NEW_YEAR + 11;
    return Response.json(time >= request.startTime && time <= request.endTime
      ? [{ coin: request.coin, time, fundingRate: request.coin === ASSETS.brent.coin ? '0.005' : '0.001' }] : []);
  } });
  assert.deepEqual(existing, before);
  assert.deepEqual(refreshed.data, [old, { time: NEW_YEAR, brent: 0.005, wti: 0.001 }]);
  assert.equal(refreshed.metadata.fetchedAt, stamp(NEW_YEAR + HOUR));
  const result = analyzeFundingRange(refreshed.data, '2026-12-31', '2027-01-01');
  assert.deepEqual(result.points.map(row => row.date), ['2026-12-31', '2027-01-01']);
  assert.equal(result.count, 2);
  assert.equal(result.expectedHours, 48);
  assert.ok(Math.abs(result.shortCumulative - 0.003) < 1e-12);
  assert.equal(analyzeFundingWindow(refreshed.data, NEW_YEAR - HOUR, NEW_YEAR + HOUR).count, 2);
});

test('new-year funding still rejects invalid ranges, unordered hours and settlements later than fetchedAt', () => {
  const old = { time: NEW_YEAR - HOUR, brent: 0.003, wti: 0.001 }, next = { ...old, time: NEW_YEAR };
  for (const [from, to] of [['2027-1-01', '2027-01-02'], ['2027-02-29', '2027-03-01'], ['2027-01-02', '2027-01-01']]) {
    assert.throws(() => analyzeFundingRange([old, next], from, to), /Invalid funding date range/);
  }
  for (const rows of [[next, old], [next, next], [{ ...next, time: NEW_YEAR + 1 }], [{ ...next, time: 8_640_000_000_000_000 + HOUR }]]) {
    assert.throws(() => validateFundingRows(rows), /Invalid or unordered funding hour/);
  }
  assert.throws(() => createFundingSnapshot([old, next], stamp(NEW_YEAR - 1)), /future settlements/);
});

test('resident Binance collection persists both years, preserves seeds and survives a database restart', async t => {
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input), symbol = url.searchParams.get('symbol');
    if (url.pathname.endsWith('/exchangeInfo')) return Response.json({ symbols: ['BZ', 'CL'].map(baseAsset => ({
      symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL',
    })) });
    if (url.pathname.endsWith('/premiumIndex')) return Response.json(['BZ', 'CL'].map(base => ({
      symbol: `${base}USDT`, markPrice: base === 'BZ' ? '105' : '100', lastFundingRate: '0', nextFundingTime: NOW + 4 * HOUR, time: NOW,
    })));
    if (url.pathname.endsWith('/fundingInfo')) return Response.json([]);
    if (url.pathname.endsWith('/klines')) return Response.json([NEW_YEAR, NOW].map(time => [time, '0', '0', '0', symbol === 'BZUSDT' ? '105' : '100', '0', time + DAY - 1]));
    if (url.pathname.endsWith('/fundingRate')) return Response.json([{ symbol, fundingTime: NEW_YEAR + 11, fundingRate: symbol === 'BZUSDT' ? '0.003' : '0.001', rateType: 'Regular' }]);
    throw Error(`Unexpected test endpoint ${url.pathname}`);
  });
  const directory = await mkdtemp(join(tmpdir(), 'oil-year-rollover-')), filename = join(directory, 'market.sqlite');
  let store = await openMarketStore(filename, { clock: () => NOW });
  const jobs = marketJobs().filter(job => job.id === 'oil' && ['history', 'funding'].includes(job.action));
  const collector = createMarketCollector(store, { jobs, clock: () => NOW });
  try {
    seedMarketDatabase(store);
    const previousDaily = store.raw('oil', 'history'), previousFunding = store.raw('oil', 'funding');
    for (const job of jobs) assert.equal(await collector.collect(job), true, job.action);
    const savedDaily = store.read('oil', 'history', { fresh: true }), savedFunding = store.read('oil', 'funding', { fresh: true });
    assert.equal(savedDaily.status, 'live');
    assert.deepEqual(savedDaily.data.slice(0, -1), previousDaily.data);
    assert.deepEqual(savedDaily.data.at(-1), daily('2027-01-01'));
    assert.equal(savedDaily.metadata.lastCommonObservation, '2027-01-01');
    assert.equal(store.count('oil', 'history'), previousDaily.data.length + 1);
    assert.deepEqual(savedFunding.data.slice(0, -1), previousFunding.data);
    assert.deepEqual(savedFunding.data.at(-1), { time: NEW_YEAR, brent: 0.003, wti: 0.001 });
    seedMarketDatabase(store);
    assert.deepEqual(store.read('oil', 'history', { fresh: true }), savedDaily);
    assert.deepEqual(store.read('oil', 'funding', { fresh: true }), savedFunding);
    await collector.stop();
    store.close();
    store = await openMarketStore(filename, { clock: () => NOW });
    assert.deepEqual(store.read('oil', 'history', { fresh: true }), savedDaily);
    assert.deepEqual(store.read('oil', 'funding', { fresh: true }), savedFunding);
  } finally { await collector.stop(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
