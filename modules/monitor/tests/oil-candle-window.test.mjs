import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { OIL_CANDLE_MS as BAR, createIntradaySnapshot, intradayWindow, parseCandleWindowDays, validateIntradaySnapshot } from '../modules/oil/intraday.mjs';
import { oilHistory, coversOilRange, OIL_BANDS_DAYS, OIL_WARMUP_DAYS } from '../lib/oil-history.ts';
import { calculateIndicators } from '../lib/indicators.ts';
import { selectRange } from '../lib/market.ts';
import { createHandler } from '../server/http.mjs';

const DAY = 86_400_000;
const saved = JSON.parse(await readFile(new URL('../public/oil/data/binance-15m.json', import.meta.url), 'utf8'));
const archive = { ...saved, status: 'live', collection: { source: 'database', stale: false } };

test('a window read keeps the last days before the last paired bar and the complete coverage', () => {
  const full = validateIntradaySnapshot(archive), last = Date.parse(full.metadata.lastCommonObservation);
  const window = intradayWindow(archive, 28);
  assert.equal(window.windowDays, 28);
  assert.equal(window.data[0].time, Math.ceil((last - 28 * DAY) / BAR) * BAR);
  assert.equal(window.data.at(-1).time, full.data.at(-1).time);
  assert.ok(window.data.every(row => row.time >= last - 28 * DAY));
  assert.deepEqual(window.collection, archive.collection);
  assert.equal(window.status, 'live');
  // The window is a valid snapshot on its own; coverage still describes the complete history.
  assert.deepEqual(validateIntradaySnapshot(window).metadata, window.metadata);
  assert.equal(window.metadata.pairedObservationRows, 28 * 96 + 1);
  assert.deepEqual(window.coverage, { firstCommonObservation: full.metadata.firstCommonObservation, lastCommonObservation: full.metadata.lastCommonObservation, pairedObservationRows: full.metadata.pairedObservationRows });
  assert.equal(archive.data.length, saved.data.length, 'The source snapshot is not modified');
  // A window wider than the history returns the complete snapshot unchanged.
  assert.equal(intradayWindow(archive, 400), archive);
});

test('a window starting inside a gap or behind unpaired bars stays valid and counts its own gaps', () => {
  const start = Date.UTC(2026, 3, 1, 9), rows = [];
  for (let i = 0; i < 10 * 96; i++) if ((i < 250 || i > 300) && (i < 500 || i > 509)) rows.push({ time: start + i * BAR, brent: 90 + (i % 7) / 10, wti: i >= 955 ? null : 85 });
  const snapshot = { ...createIntradaySnapshot(rows, new Date(start + 10 * DAY).toISOString()), status: 'snapshot' };
  const window = intradayWindow(snapshot, 7);
  const lastPaired = start + 954 * BAR;
  // Bar 282 opens 7 days before the last paired bar 954, inside the 250–300 gap.
  assert.equal(lastPaired - 7 * DAY, start + 282 * BAR);
  assert.equal(window.data[0].time, start + 301 * BAR);
  assert.equal(window.data.at(-1).wti, null, 'Trailing unpaired bars remain');
  assert.equal(window.status, 'snapshot');
  assert.equal(window.metadata.missingObservationRows, 10);
  assert.equal(window.coverage.pairedObservationRows, snapshot.metadata.pairedObservationRows);
});

test('window days accept only whole days up to 400', () => {
  assert.equal(parseCandleWindowDays(null), null);
  assert.equal(parseCandleWindowDays('28'), 28);
  for (const value of ['', '0', '401', '7.5', '-1', '1e2', ' 7', 'abc', '0028']) assert.throws(() => parseCandleWindowDays(value), { status: 400 }, value);
});

test('the client reads window and complete responses and knows which ranges they cover', () => {
  const window = oilHistory(intradayWindow(archive, 7 + OIL_WARMUP_DAYS)), full = oilHistory(archive);
  assert.equal(full.windowDays, null);
  assert.deepEqual(full.coverage, { firstCommonObservation: saved.metadata.firstCommonObservation, lastCommonObservation: saved.metadata.lastCommonObservation, pairedObservationRows: saved.metadata.pairedObservationRows });
  assert.equal(window.windowDays, 28);
  assert.deepEqual(window.coverage, full.coverage);
  assert.equal(window.points.length, 28 * 96 + 1);
  assert.ok(coversOilRange(window, 7, OIL_WARMUP_DAYS));
  assert.ok(!coversOilRange(window, 30, OIL_WARMUP_DAYS));
  assert.ok(!coversOilRange(window, null, OIL_WARMUP_DAYS));
  assert.ok(coversOilRange(full, null, OIL_WARMUP_DAYS) && coversOilRange(full, 30, OIL_WARMUP_DAYS));
  const raw = intradayWindow(archive, 28);
  assert.throws(() => oilHistory({ ...raw, windowDays: 0 }));
  assert.throws(() => oilHistory({ ...raw, coverage: undefined }));
  assert.throws(() => oilHistory({ ...raw, coverage: { ...raw.coverage, pairedObservationRows: 10 } }));
  assert.throws(() => oilHistory({ ...raw, coverage: { ...raw.coverage, lastCommonObservation: raw.coverage.firstCommonObservation } }));
  assert.throws(() => oilHistory({ ...raw, coverage: { ...raw.coverage, firstCommonObservation: 'not a time' } }));
});

test('indicators on each selected range are identical whether computed from the window or the complete history', () => {
  // The oil chart config's 7-day SMA and bands on 15-minute bars.
  const intervalMs = BAR, periods = { sma: 7 * 96, bands: OIL_BANDS_DAYS * 96 };
  const full = oilHistory(archive).points;
  const fullIndicators = calculateIndicators(full, 'spread', periods, intervalMs);
  for (const range of [7, 30]) {
    const window = oilHistory(intradayWindow(archive, range + OIL_WARMUP_DAYS)).points;
    const expected = selectRange(fullIndicators, range), actual = selectRange(calculateIndicators(window, 'spread', periods, intervalMs), range);
    assert.equal(actual.length, expected.length);
    assert.ok(expected[0].zscore !== null, 'The first visible bar has its full warmup');
    actual.forEach((point, index) => {
      for (const key of ['time', 'spread', 'sma', 'basis', 'upper', 'lower', 'zscore', 'deviation', 'consecutiveHours']) assert.ok(Object.is(point[key], expected[index][key]), `${range}d ${key} at ${index}`);
    });
  }
});

test('the candles API windows only with a valid days query and still negotiates gzip', async t => {
  const calls = [];
  const services = new Map([['oil', { actions: { 'candles/15m': ['GET'], history: ['GET'] }, async handle(action, method) { calls.push([action, method]); return archive; } }]]);
  const password = 'candle-window-password';
  const server = createServer(createHandler({ services, username: 'admin', password, nextHandler: (_q, r) => r.writeHead(404).end() }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: server.address().port, path, headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, json: JSON.parse((response.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8')), bytes: body.length });
      });
    }).on('error', reject).end();
  });
  const full = await get('/api/monitors/oil/candles/15m', { 'Accept-Encoding': 'gzip' });
  const window = await get('/api/monitors/oil/candles/15m?days=28', { 'Accept-Encoding': 'gzip' });
  assert.equal(full.status, 200);
  assert.equal(full.json.windowDays, undefined);
  assert.equal(full.json.data.length, saved.data.length);
  assert.equal(window.status, 200);
  assert.equal(window.headers['content-encoding'], 'gzip');
  assert.deepEqual(window.json, JSON.parse(JSON.stringify(intradayWindow(archive, 28))));
  assert.ok(window.bytes * 4 < full.bytes, `window ${window.bytes} B vs full ${full.bytes} B`);
  const before = calls.length;
  for (const days of ['0', 'x', '401']) assert.equal((await get(`/api/monitors/oil/candles/15m?days=${days}`)).status, 400);
  assert.equal(calls.length, before, 'An invalid window never reads the dataset');
  // Other actions ignore the query.
  assert.equal((await get('/api/monitors/oil/history?days=x')).status, 200);
});
