import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goldOilRatio, validateGoldOilQuote, goldOilChartPoints, GOLD_OIL_INTERVAL_MS as STEP } from '../lib/gold-oil.ts';
import { parseGoldOilQuote, parseGoldOilHistory, validateGoldOilContracts, createGoldOilReader } from '../lib/gold-oil-service.ts';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector } from '../server/market-collector.mjs';
import { openMonitorControlStore } from '../server/monitor-control.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createDataReader } from '../lib/monitor-service.ts';
import { goldOilSummary, goldOilTrend } from '../lib/monitor-summary.ts';
import { currentGoldOilFunding, parseGoldOilFunding, analyzeGoldOilFunding } from '../lib/gold-oil-funding.ts';
import { goldOilStatistics, sampleGoldOilPoints, adjacentRatioChange } from '../lib/gold-oil-analysis.ts';
import { chartDomain, chartPath } from '../lib/gold-oil-chart.ts';

const now = Date.UTC(2026, 8, 30, 12), stamp = new Date(now).toISOString();
const ticker = (symbol, markPrice, time = now) => ({ symbol, markPrice: String(markPrice), time });
const quote = () => parseGoldOilQuote(ticker('CLUSDT', 80), ticker('XAUUSDT', 4000), now);
const candle = (time, price) => [time, String(price), String(price), String(price), String(price), '0', time + STEP - 1];

test('SVG paths break on nulls and retain isolated values; domains handle flat, negative and absent series', () => {
  const rows = [4, null, -2, -1, null, 0].map((value, time) => ({ time, value }));
  const path = chartPath(rows, row => row.value, time => time * 10, value => value * 2);
  assert.equal(path, 'M0.00,8.00L0.00,8.00M20.00,-4.00L20.00,-4.00L30.00,-2.00M50.00,0.00L50.00,0.00');
  assert.deepEqual(chartDomain([null]), { min: -1, max: 1 });
  for (const values of [[0], [50, 50], [-0.0001, 0.0002]]) {
    const domain = chartDomain(values, 0);
    assert.ok(domain.min < Math.min(0, ...values) && domain.max > Math.max(0, ...values));
  }
});
const metadata = () => ({ symbols: ['CL', 'XAU'].map(baseAsset => ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', onboardDate: now - 2000 * STEP })) });
async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'gold-oil-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test('XAU divided by CL recomputes derived ratios and rejects invalid prices', () => {
  assert.equal(goldOilRatio(80, 4000), 50); assert.equal(goldOilRatio(100, 4000), 40);
  for (const invalid of [null, 0, -1, Infinity, NaN]) { assert.equal(goldOilRatio(invalid, 4000), null); assert.equal(goldOilRatio(80, invalid), null); }
  assert.equal(goldOilRatio(Number.MIN_VALUE, Number.MAX_VALUE), null);
  assert.equal(validateGoldOilQuote({ ...quote(), ratio: 999 }).ratio, 50);
  assert.equal(goldOilSummary(quote()).metrics[0].value, '50.000');
  assert.equal(goldOilSummary(quote(), true).status, 'stale'); assert.equal(goldOilSummary(quote(), true).fetchedAt, stamp);
});

test('exact contracts, positive marks and synchronized source times are required', () => {
  validateGoldOilContracts(metadata());
  for (const [field, value] of [['baseAsset', 'XAUT'], ['quoteAsset', 'USDC'], ['marginAsset', 'USDC'], ['status', 'SETTLING'], ['contractType', 'CURRENT_QUARTER']]) {
    const input = metadata(); input.symbols[1][field] = value; assert.throws(() => validateGoldOilContracts(input));
  }
  const duplicate = metadata(); duplicate.symbols.push(duplicate.symbols[1]); assert.throws(() => validateGoldOilContracts(duplicate));
  for (const leg of [ticker('PAXGUSDT', 4000), ticker('XAUUSDT', 0), ticker('XAUUSDT', -1), ticker('XAUUSDT', ''), ticker('XAUUSDT', 4000, now + 2000), ticker('XAUUSDT', 4000, now - 16_000), ticker('XAUUSDT', 4000, now - 100_000)]) assert.throws(() => parseGoldOilQuote(ticker('CLUSDT', 80), leg, now));
  assert.equal(parseGoldOilQuote(ticker('CLUSDT', 80, now - 1000), ticker('XAUUSDT', 4000), now).fetchedAt, new Date(now - 1000).toISOString());
});

test('history pairs completed periods, preserves missing legs and breaks chart gaps', () => {
  const history = parseGoldOilHistory([candle(now - 4 * STEP, 80), candle(now - 2 * STEP, 100), candle(now - STEP, 100), candle(now, 100)], [candle(now - 4 * STEP, 4000), candle(now - 2 * STEP, 4100), candle(now, 4100)], now);
  assert.deepEqual(history.points.map(row => row.ratio), [50, 41, null]);
  assert.deepEqual(goldOilChartPoints(history, 7).map(row => row.ratio), [50, null, 41, null]);
  assert.equal(history.points.at(-1).xau, null);
  const trend = goldOilTrend(history, true);
  assert.equal(trend.status, 'stale'); assert.equal(trend.unit, '桶/盎司');
  assert.deepEqual(trend.points.map(row => row.value), [50, 41]);
  assert.deepEqual(trend.points.map(row => row.time), [now - 4 * STEP, now - 2 * STEP]);
  assert.deepEqual(parseGoldOilHistory([candle(now - STEP, 100)], [candle(now - STEP, 4200)], now, history).points.map(row => row.ratio), [50, 41, 42]);
  for (const input of [[candle(now - STEP, 0)], [candle(now - STEP, 80), candle(now - STEP, 80)], [candle(now - STEP + 1, 80)], [candle(now, 80)], []]) assert.throws(() => parseGoldOilHistory(input, [candle(now - STEP, 4000)], now));
  assert.throws(() => parseGoldOilHistory([], [], now, history), 'Empty response cannot relabel retained history live');
});

test('Binance reader shares metadata, uses mark-price history and retries errors', async () => {
  const paths = [], fetcher = async input => {
    const url = new URL(input); paths.push(url);
    if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
    if (url.pathname.endsWith('fundingInfo')) return Response.json([]);
    const price = url.searchParams.get('symbol') === 'CLUSDT' ? 80 : 4000;
    if (url.pathname.endsWith('premiumIndex')) return Response.json(ticker(url.searchParams.get('symbol'), price));
    assert.equal(url.pathname, '/fapi/v1/markPriceKlines'); assert.equal(url.searchParams.get('interval'), '15m'); assert.equal(Number(url.searchParams.get('endTime')), now - 1);
    return Response.json([candle(now - STEP, price)]);
  };
  const reader = createGoldOilReader({ fetcher, clock: () => now });
  const [live, history] = await Promise.all([reader.quote(), reader.history()]);
  assert.equal(live.ratio, 50); assert.equal(history.points[0].ratio, 50); assert.equal(paths.filter(url => url.pathname.endsWith('exchangeInfo')).length, 1);
  let fail = true;
  const retry = createGoldOilReader({ clock: () => now, fetcher: async input => fail ? new Response('', { status: 503 }) : fetcher(input) });
  await assert.rejects(retry.quote()); fail = false; assert.equal((await retry.quote()).ratio, 50);
});

test('resident storage retains values and source time through outage and reopen', async t => {
  const directory = await temporary(t); let clock = now, fail = false;
  let store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => clock });
  const job = { id: 'cl-xau', action: 'quote', intervalMs: 30_000, load: async () => { if (fail) throw Error('offline'); return quote(); } };
  const collector = createMarketCollector(store, { jobs: [job] });
  try {
    await collector.collect(job); assert.equal(store.read('cl-xau', 'quote').ratio, 50);
    clock += 31_000; fail = true; await collector.collect(job);
    const retained = store.read('cl-xau', 'quote'); assert.equal(retained.status, 'snapshot'); assert.equal(retained.fetchedAt, stamp); assert.equal(retained.ratio, 50);
    assert.throws(() => store.read('cl-xau', 'quote', { fresh: true })); assert.equal(store.count('cl-xau', 'quote'), 1);
    store.close(); store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => clock }); assert.equal(store.read('cl-xau', 'quote').fetchedAt, stamp);
    assert.throws(() => store.write('cl-xau', 'quote', { ...quote(), fetchedAt: new Date(now + 5000).toISOString() }));
  } finally { await collector.stop(); store.close(); }
});

test('old switches gain only the new module and still reject corrupt entries', async t => {
  const directory = await temporary(t), file = join(directory, 'monitor-control.json');
  const old = { version: 1, monitors: { oil: { enabled: false, revision: 8 }, hynix: { enabled: true, revision: 2 }, perpetual: { enabled: false, revision: 3 } } };
  await writeFile(file, JSON.stringify(old)); const store = await openMonitorControlStore(directory);
  for (const id of Object.keys(old.monitors)) assert.deepEqual(store.get().monitors[id], old.monitors[id]);
  assert.deepEqual(store.get().monitors['cl-xau'], { enabled: true, revision: 0 }); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), old);
  const next = store.get(); next.monitors['cl-xau'] = { enabled: false, revision: 1 }; await store.save(next); assert.deepEqual((await openMonitorControlStore(directory)).get(), next);
  for (const invalid of [null, { enabled: 'false', revision: 0 }]) { await writeFile(file, JSON.stringify({ ...old, monitors: { ...old.monitors, 'cl-xau': invalid } })); await assert.rejects(openMonitorControlStore(directory)); }
  const missing = structuredClone(old); delete missing.monitors.oil; await writeFile(file, JSON.stringify(missing)); await assert.rejects(openMonitorControlStore(directory));
});

test('resident APIs read only caches, expose ratio summary and pause independently', async t => {
  const directory = await temporary(t);
  const savedFunding = parseGoldOilFunding([event('CLUSDT', now - STEP, 0.0001)], [event('XAUUSDT', now - STEP + 1, 0.0002)], now - 86400000, now, now);
  const preload = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => now });
  preload.write('cl-xau', 'funding', savedFunding); preload.close();
  const services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
  try {
    const before = services.market.status(); await assert.rejects(services.get('cl-xau').handle('quote', 'GET'), /尚未收到/);
    const initial = (await readInitialMarket(services))['cl-xau'];
    assert.equal(initial.quote, null); assert.equal(initial.history, null);
    assert.deepEqual(initial.funding.points, savedFunding.points, 'Funding comes from persisted data before any browser read');
    assert.deepEqual(services.market.status(), before);
    assert.equal((await readHubSummary(services, now, 'cl-xau')).health.state, 'offline');
    assert.deepEqual((await services.get('cl-xau').handle('funding', 'GET')).points, savedFunding.points);
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: false, revision: 0 }); await assert.rejects(services.get('cl-xau').handle('history', 'GET'), { status: 423 });
    await assert.rejects(services.get('cl-xau').handle('funding', 'GET'), { status: 423 });
    assert.equal(services.get('oil').runtime().enabled, true);
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: true, revision: 1 }); assert.equal(services.get('cl-xau').runtime().enabled, true);
  } finally { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
  const cached = new Map([['cl-xau', { handle: async () => quote() }]]), summary = await readHubSummary(cached, now, 'cl-xau');
  assert.equal(summary.health.state, 'online'); assert.deepEqual(summary.metrics[0], { key: 'ratio', label: '金油比 XAU / CL', value: 50, unit: '桶/盎司' });
  assert.equal((await readHubSummary(cached, now + 76_000, 'cl-xau')).health.state, 'stale'); assert.equal((await readInitialMarket(cached))['cl-xau'].quote.ratio, 50);
});

test('preview cache and capabilities remain separate from oil', async () => {
  let calls = 0;
  const read = createDataReader({ 'cl-xau': { quote: async () => { calls++; return quote(); }, funding: async () => ({ points: [], status: 'live' }) }, oil: { quote: async () => ({ brent: 80 }) } });
  const pair = await Promise.all([read('cl-xau', 'quote'), read('cl-xau', 'quote')]);
  assert.equal(calls, 1); assert.equal(pair[0].ratio, 50); assert.deepEqual(await read('oil', 'quote'), { brent: 80 });
  assert.deepEqual((await read('cl-xau', 'funding')).points, []); await assert.rejects(read('cl-xau', 'exchanges/binance/quote'));
});

test('current funding uses each leg interval and gross notional; missing terms do not erase quotes', () => {
  const cl = { ...ticker('CLUSDT', 80), lastFundingRate: '0.0004', nextFundingTime: now + 4 * 3600000 };
  const xau = { ...ticker('XAUUSDT', 4000), lastFundingRate: '0.0016', nextFundingTime: now + 8 * 3600000 };
  const info = [{ symbol: 'CLUSDT', fundingIntervalHours: 4 }, { symbol: 'XAUUSDT', fundingIntervalHours: 8 }];
  const value = parseGoldOilQuote(cl, xau, now, info), funding = currentGoldOilFunding(value);
  assert.equal(funding.hourlyRate, 0.00005); assert.equal(funding.cashPerHour, 0.5); assert.equal(funding.annualized, 0.438);
  assert.equal(goldOilSummary(value).metrics[1].value, '+43.80%');
  assert.equal(parseGoldOilQuote(cl, xau, now, []).funding, null); assert.equal(parseGoldOilQuote(cl, xau, now, []).ratio, 50);
  assert.equal(currentGoldOilFunding(parseGoldOilQuote({ ...cl, lastFundingRate: '0' }, { ...xau, lastFundingRate: '0' }, now, info)).hourlyRate, 0);
  assert.equal(parseGoldOilQuote(cl, { ...xau, nextFundingTime: now - 120000 }, now, info).funding, null);
});

const event = (symbol, fundingTime, fundingRate) => ({ symbol, fundingTime, fundingRate: String(fundingRate), rateType: 'Regular' });
test('historical fees sum asynchronous actual events, use calendar hours, and withhold uncovered annualization', () => {
  const start = now - 24 * 3600000;
  const cl = [4, 8, 12, 16, 20].map(hour => event('CLUSDT', start + hour * 3600000 + 1, 0.0004));
  const xau = [8, 16].map(hour => event('XAUUSDT', start + hour * 3600000 + 2, 0.0016));
  const history = parseGoldOilFunding(cl, xau, start, now, now), result = analyzeGoldOilFunding(history, start, now);
  assert.equal(result.clCount, 5); assert.equal(result.xauCount, 2); assert.equal(result.covered, true);
  assert.ok(Math.abs(result.shortCumulative - 0.0006) < 1e-12);
  assert.ok(Math.abs(result.shortAnnualized - 0.0006 / 24 * 8760) < 1e-12);
  assert.equal(result.longCumulative, -result.shortCumulative);
  assert.equal(analyzeGoldOilFunding(history, start - 1, now).shortAnnualized, null);
  assert.equal(analyzeGoldOilFunding(history, start, now + 1).shortAnnualized, null);
  const partial = analyzeGoldOilFunding(parseGoldOilFunding(cl, [], start, now, now), start, now);
  assert.equal(partial.shortAnnualized, null); assert.ok(partial.points.every(row => row.shortAnnualized === null));
  assert.throws(() => parseGoldOilFunding([cl[0], cl[0]], xau, start, now, now));
  assert.throws(() => parseGoldOilFunding([event('XAUUSDT', cl[0].fundingTime, 0)], xau, start, now, now));
  assert.throws(() => parseGoldOilFunding([event('CLUSDT', now, 0)], xau, start, now, now));
});

test('price history backfills past seven days with pagination, then requests only overlap', async () => {
  const start = now - 2000 * STEP, requests = [];
  const reader = createGoldOilReader({ clock: () => now, fetcher: async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
    const from = Number(url.searchParams.get('startTime')), symbol = url.searchParams.get('symbol'); requests.push(from);
    const count = Math.min(1000, Math.max(0, (now - from) / STEP));
    return Response.json(Array.from({ length: count }, (_, index) => candle(from + index * STEP, symbol === 'CLUSDT' ? 80 : 4000)));
  } });
  const old = parseGoldOilHistory([candle(now - STEP, 80)], [candle(now - STEP, 4000)], now);
  const first = await reader.history(old);
  assert.equal(first.points.length, 2000); assert.equal(first.points[0].time, start); assert.equal(first.coverageStart, start);
  assert.equal(requests.length, 4);
  requests.length = 0; const second = await reader.history(first);
  assert.equal(second.points.length, 2000); assert.equal(requests.length, 2); assert.ok(requests.every(value => value > now - 2 * 86400000));
  assert.equal(goldOilChartPoints(second, 7).length, 672); assert.equal(goldOilChartPoints(second, 0).length, 2000);
  requests.length = 0;
  const missingLeading = { ...first, points: first.points.slice(1) };
  assert.equal(goldOilChartPoints(missingLeading, 0)[0].ratio, null);
  assert.equal((await reader.history(missingLeading)).points.length, 2000);
  assert.equal(requests[0], start, 'Leading missing candles are retried from the common start');
  for (const bad of ['duplicate', 'reverse', 'out-of-window']) {
    const broken = createGoldOilReader({ clock: () => now, fetcher: async input => {
      const url = new URL(input); if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
      return Response.json(bad === 'duplicate' ? [candle(start, 80), candle(start, 80)] : bad === 'reverse' ? [candle(start + STEP, 80), candle(start, 80)] : [candle(start - STEP, 80)]);
    } });
    await assert.rejects(broken.history());
  }
});

test('failed funding pagination cannot extend durable query coverage', async t => {
  const directory = await temporary(t), start = now - 2000 * STEP;
  let fail = false;
  const reader = createGoldOilReader({ clock: () => now, fetcher: async input => {
    const url = new URL(input); if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
    const cursor = Number(url.searchParams.get('startTime'));
    if (fail && cursor > start) return new Response('', { status: 503 });
    return Response.json(fail ? Array.from({ length: 1000 }, (_, index) => event(url.searchParams.get('symbol'), start + index * 1000, 0.0001)) : [event(url.searchParams.get('symbol'), now - 1000, 0.0001)]);
  } });
  const saved = await reader.funding(); fail = true;
  // No previous snapshot forces a full query, whose second page fails.
  const store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => now });
  try {
    store.write('cl-xau', 'funding', saved);
    const job = { id: 'cl-xau', action: 'funding', intervalMs: 300000, load: async () => { const fresh = createGoldOilReader({ clock: () => now, fetcher: async input => {
      const url = new URL(input); if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
      const cursor = Number(url.searchParams.get('startTime')); if (cursor > start) return new Response('', { status: 503 });
      return Response.json(Array.from({ length: 1000 }, (_, index) => event(url.searchParams.get('symbol'), start + index * 1000, 0.0001)));
    } }); return fresh.funding(); } };
    const collector = createMarketCollector(store, { jobs: [job] }); await collector.collect(job); await collector.stop();
    const retained = store.read('cl-xau', 'funding'); assert.equal(retained.status, 'snapshot'); assert.equal(retained.coverageEnd, saved.coverageEnd); assert.deepEqual(retained.points, saved.points);
  } finally { store.close(); }
});

test('statistics, monthly means and sampling keep full-data extrema and real gaps', () => {
  const points = Array.from({ length: 4000 }, (_, index) => ({ time: now - (4000 - index) * STEP, oil: 80, cl: 80, xau: 4000, ratio: 50 + index / 10000 }));
  points[123].ratio = 100; points[456].ratio = 1; points[789].ratio = null;
  const stats = goldOilStatistics(points), sampled = sampleGoldOilPoints(points);
  assert.equal(stats.max.ratio, 100); assert.equal(stats.min.ratio, 1); assert.equal(stats.count, 3999);
  assert.equal(stats.months.reduce((sum, month) => sum + month.count, 0), 3999);
  assert.ok(sampled.includes(points[123]) && sampled.includes(points[456]) && sampled.includes(points[789]));
  assert.ok(sampled.length < points.length / 2); assert.equal(adjacentRatioChange(points, 790), null);
  assert.equal(adjacentRatioChange(points, 0), null);
});

test('one-month range clamps month ends while keeping full fifteen-minute periods', () => {
  const end = Date.UTC(2026, 2, 31, 12), start = Date.UTC(2026, 0, 1);
  const history = parseGoldOilHistory([candle(start, 80), candle(end - STEP, 80)], [candle(start, 4000), candle(end - STEP, 4000)], end);
  const points = goldOilChartPoints(history, '1m');
  assert.equal(points[0].time, Date.UTC(2026, 1, 28, 12));
  assert.equal(points.at(-1).time, end - STEP); assert.equal(points.length, 31 * 96);
});
