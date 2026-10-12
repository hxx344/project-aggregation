import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HISTORY_START, fetchCandles } from '../modules/oil/binance.mjs';
import { OIL_CANDLE_MS as BAR, pairIntradayCandles, createIntradaySnapshot, validateIntradaySnapshot, fetchIntradaySnapshot, intradayChartRows } from '../modules/oil/intraday.mjs';
import { filterRows } from '../modules/oil/data-utils.mjs';

const START = HISTORY_START;
const saved = JSON.parse(await readFile(new URL('../public/oil/data/binance-15m.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(await readFile(new URL('../public/oil/data/hyperliquid-15m.json', import.meta.url), 'utf8'));
const candle = (time, close) => [time, String(close), String(close), String(close), String(close), '1', time + BAR - 1];

test('real Binance archive starts April 1, exceeds 5,000 complete paired bars, and retains exact daily/weekly windows', () => {
  const snapshot = validateIntradaySnapshot(saved), rows = intradayChartRows(snapshot);
  assert.equal(snapshot.metadata.source, 'Binance');
  assert.equal(snapshot.metadata.currency, 'USDT');
  assert.equal(rows[0].time, Date.UTC(2026, 3, 1, 9));
  assert.ok(rows.length > 16000);
  assert.equal(snapshot.metadata.missingObservationRows, 0);
  rows.forEach((row, index) => {
    if (index) assert.equal(row.time - rows[index - 1].time, BAR);
    assert.ok(row.time + BAR <= Date.parse(snapshot.metadata.fetchedAt));
    assert.ok(Math.abs(row.spread - (row.brent - row.wti) / row.wti * 100) < 1e-12);
  });
  assert.equal(filterRows(rows, '1d', BAR).length, 96);
  assert.equal(filterRows(rows, '1w', BAR).length, 672);
  assert.equal(filterRows(rows, 'all', BAR).length, rows.length);
});

test('pairs completed trade closes at matching times, preserving missing legs and real gaps', () => {
  const rows = pairIntradayCandles([0, 1, 3, 4].map(i => candle(START + i * BAR, 80 + i)), [0, 3, 4].map(i => candle(START + i * BAR, 70 + i)), START + 4 * BAR);
  assert.deepEqual(rows.map(row => [row.time - START, row.wti]), [[0, 70], [BAR, null], [3 * BAR, 73]]);
  const snapshot = createIntradaySnapshot(rows, new Date(START + 4 * BAR).toISOString());
  assert.equal(snapshot.metadata.pairedObservationRows, 2);
  assert.equal(snapshot.metadata.missingObservationRows, 2);
  assert.deepEqual(intradayChartRows(snapshot).map(row => row.time), [START, START + 3 * BAR]);
});

test('wrong source, currency, symbols, cadence, incomplete bars and falsified coverage are rejected', () => {
  assert.throws(() => validateIntradaySnapshot(legacy));
  for (const metadata of [{ source: 'Hyperliquid / XYZ' }, { currency: 'USD' }, { symbols: ['BZUSDT', 'BTCUSDT'] }, { interval: '1d' }, { pairedObservationRows: 1 }]) assert.throws(() => validateIntradaySnapshot({ ...saved, metadata: { ...saved.metadata, ...metadata } }));
  for (const [index, value] of [[0, START + 1], [6, START + BAR], [4, ''], [4, 0], [4, 'Infinity']]) {
    const bad = candle(START, 80); bad[index] = value;
    assert.throws(() => pairIntradayCandles([bad], [candle(START, 70)], START + BAR + 1));
  }
  assert.throws(() => pairIntradayCandles([candle(START, 80), candle(START, 80)], [candle(START, 70)], START + BAR));
  assert.throws(() => createIntradaySnapshot([{time: START, brent: 80, wti: 70}], new Date(START + BAR - 1).toISOString()));
});

test('ascending K-line pagination advances using actual open times and rejects repeated pages', async () => {
  const all = Array.from({ length: 5 }, (_, i) => candle(START + i * BAR, 80 + i)), requests = [];
  const result = await fetchCandles('BZUSDT', '15m', START, START + 5 * BAR, { pageSize: 2, fetcher: async url => {
    const params = new URL(url).searchParams; requests.push(Number(params.get('startTime')));
    return Response.json(all.filter(row => row[0] >= Number(params.get('startTime'))).slice(0, 2));
  } });
  assert.deepEqual(requests, [START, START + 2 * BAR, START + 4 * BAR]);
  assert.deepEqual(result, all);
  await assert.rejects(fetchCandles('BZUSDT', '15m', START, START + 5 * BAR, { pageSize: 2, fetcher: async () => Response.json(all.slice(0, 2)) }), /pagination/);
});

test('incremental refresh repairs old missing records, preserves old observations, and excludes the open candle', async () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({ time: START + i * BAR, brent: i === 11 ? null : 80, wti: 70 })).filter((_, i) => i !== 10);
  const existing = createIntradaySnapshot(rows, new Date(START + 160 * BAR).toISOString()), before = JSON.stringify(existing), requests = [];
  const result = await fetchIntradaySnapshot(existing, { now: START + 161 * BAR, fetcher: async url => {
    const params = new URL(url).searchParams; requests.push(params);
    return Response.json([10, 11, 160, 161].map(i => candle(START + i * BAR, params.get('symbol') === 'BZUSDT' ? 81 : 71)));
  } });
  assert.ok(requests.every(params => params.get('interval') === '15m' && Number(params.get('startTime')) === START + 10 * BAR));
  assert.equal(result.data.length, 161);
  assert.deepEqual(result.data[0], existing.data[0]);
  assert.deepEqual(result.data[11], { time: START + 11 * BAR, brent: 81, wti: 71 });
  assert.equal(result.metadata.missingObservationRows, 0);
  assert.equal(JSON.stringify(existing), before);
});

test('Binance backfills gaps older than 5,000 bars rather than carrying over the Hyperliquid cutoff', async () => {
  const now = START + 7000 * BAR;
  const existing = createIntradaySnapshot([0, 2, 6999].map(i => ({ time: START + i * BAR, brent: 80, wti: 70 })), new Date(now).toISOString()), requests = [];
  const next = await fetchIntradaySnapshot(existing, { now, fetcher: async url => {
    const params = new URL(url).searchParams; requests.push(Number(params.get('startTime')));
    return Response.json([1, 6999].map(i => candle(START + i * BAR, params.get('symbol') === 'BZUSDT' ? 80 : 70)));
  } });
  assert.deepEqual(requests, [START + BAR, START + BAR]);
  assert.equal(next.data[0].time, START);
  assert.equal(next.data[1].time, START + BAR);
});

test('failure of either candle leg cannot mutate or retimestamp retained data', async () => {
  const existing = createIntradaySnapshot([{time: START, brent: 80, wti: 70}], new Date(START + BAR).toISOString()), before = JSON.stringify(existing);
  await assert.rejects(fetchIntradaySnapshot(existing, { now: START + 2 * BAR, fetcher: async url => new URL(url).searchParams.get('symbol') === 'BZUSDT' ? Response.json([candle(START + BAR, 81)]) : new Response('', { status: 503 }) }));
  assert.equal(JSON.stringify(existing), before);
});

test('calendar month windows preserve intraday time and clamp month end', () => {
  const timestamps = ['2026-02-28T10:00Z', '2026-02-28T10:15Z', '2026-03-31T10:00Z'];
  assert.deepEqual(filterRows(timestamps.map(date => ({ date })), '1m', BAR).map(row => row.date), timestamps.slice(1));
});
