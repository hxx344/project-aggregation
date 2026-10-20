import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket, registerInitialMarket } from '../server/initial-market.mjs';
import { readInitialMarket as readServerInitialMarket } from '../lib/server-initial-market.ts';
import { goldOilOverviewTrend, initialGoldOilMarket, initialSummaries } from '../lib/initial-market.ts';
import { GOLD_OIL_INTERVAL_MS, GOLD_OIL_VARIANTS, goldOilAction, goldOilUnits } from '../lib/gold-oil.ts';
import { goldOilTrend } from '../lib/monitor-summary.ts';
import { trendExpired, trendGeometry } from '../lib/monitor-trend.ts';

test('first render reads persisted history immediately with collection stopped and preserves missing quotes and source dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'market-initial-test-'));
  let services;
  try {
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
    const before = services.market.status();
    const data = await readInitialMarket(services);
    assert.equal(data.hynix.quote, null, 'Do not disguise a candle close as a current quote');
    assert.deepEqual(data['cl-xau'], { quote: null, history: null, funding: null, bz: { quote: null, history: null, funding: null }, bybit: { quote: null, history: null, funding: null, bz: { quote: null, history: null, funding: null } } });
    assert.ok(data.hynix.history.points.length > 1000);
    assert.equal(data.oil.quote.status, 'snapshot');
    assert.equal(data.oil.quote.collection.source, 'database');
    assert.deepEqual(services.market.status(), before, 'First render must not collect or write');
    const summaries = initialSummaries(data);
    assert.equal(summaries.oil.status, 'stale');
    assert.equal(summaries.oil.fetchedAt, data.oil.quote.fetchedAt);
    assert.notEqual(summaries.oil.metrics[0].value, '—');
    assert.equal(summaries.hynix.metrics[0].value, '—');
    assert.equal(summaries.hynix.trend.points.length, 168);
    assert.equal(summaries.oil.trend.points.length, 672);
    assert.equal(summaries.oil.trend.intervalMs, 900_000);
    assert.equal(data.oil.candles.metadata.interval, '15m');
    assert.equal(data.oil.candles.collection.source, 'database');
  } finally { if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); } await rm(directory, { recursive: true, force: true }); }
});

test('a missing dataset cannot block other first-render data; the server provider is current on every request and releases cleanly', async () => {
  let revision = 0;
  const calls = [];
  const services = new Map(['hynix', 'oil'].map(id => [id, { async handle(action, method) {
    calls.push([id, action, method]);
    if (id === 'hynix' && action === 'quote') throw new Error('No quote yet');
    return { revision };
  } }]));
  assert.equal(await readServerInitialMarket(), null);
  const release = registerInitialMarket(services);
  try {
    assert.throws(() => registerInitialMarket(services));
    const first = await readServerInitialMarket();
    assert.equal(first.hynix.quote, null);
    assert.equal(first.oil.quote.revision, 0);
    revision++;
    assert.equal((await readServerInitialMarket()).oil.quote.revision, 1);
    assert.equal(calls.length, 32);
    assert.ok(!calls.some(([id, action]) => id === 'oil' && action === 'history'), 'Unused daily history is not serialized into the first render');
    assert.ok(calls.every(([, action, method]) => ['quote', 'history', 'candles/15m', 'exchanges/bybit/quote', 'exchanges/binance/quote', 'exchanges/hyperliquid/quote', 'exchanges/lighter/quote', 'exchanges/variational/quote', 'exchanges/okx/quote', 'exchanges/bitget/quote', 'exchanges/gate/quote'].includes(action) && method === 'GET'));
    assert.ok(calls.filter(([, action]) => /exchanges\/(lighter|variational)\//.test(action)).every(([id]) => id === 'oil'));
    assert.ok(calls.filter(([, action]) => action === 'exchanges/gate/quote').every(([id]) => id === 'hynix'));
  } finally { release(); }
  assert.equal(await readServerInitialMarket(), null, 'A stopped runtime cannot leak its provider into another instance');
});

test('first-render summaries retain valid zero quotes and stale status without changing the funding basis', () => {
  const fetchedAt = '2026-09-11T16:00:00Z';
  const leg = { markPx: 100, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: '2026-09-11T20:00:00Z' };
  const summaries = initialSummaries({ renderedAt: Date.parse(fetchedAt), hynix: { quote: { fetchedAt, status: 'snapshot', adr: 20, ordinary: 200, equivalent: 20, spread: 0, premium: 0 }, history: null }, oil: { quote: { source: 'Binance', currency: 'USDT', fetchedAt, status: 'live', brent: { ...leg, coin: 'BZUSDT' }, wti: { ...leg, coin: 'CLUSDT' } }, history: null } });
  assert.equal(summaries.hynix.metrics[0].value, '0.00%');
  assert.equal(summaries.hynix.status, 'stale');
  assert.equal(summaries.oil.metrics[0].value, '0.000%');
  assert.equal(summaries.oil.metrics[1].value, '0.00%');
  assert.match(summaries.oil.note, /等桶数/);
});

test('gold/oil first render projects four bounded overview trends without reading or embedding complete detail datasets', async () => {
  const end = Date.parse('2026-10-15T00:00:00Z'), days = 7 * 86_400_000, count = 20_000, firstVisible = count - 672;
  const source = new Map(), calls = [];
  for (const [index, { oilType, exchange }] of GOLD_OIL_VARIANTS.entries()) {
    const fetchedAt = new Date(end).toISOString();
    const points = Array.from({ length: count }, (_, offset) => ({ time: end - (count - offset) * GOLD_OIL_INTERVAL_MS,
      oil: 100, xau: 4000 + index, ratio: offset === firstVisible ? 0 : 40 + index + offset / 1000 }));
    points[firstVisible + 10] = { ...points[firstVisible + 10], oil: null, ratio: null };
    points.splice(firstVisible + 20, 1);
    const history = { oilType, source: exchange === 'bybit' ? 'Bybit' : 'Binance', currency: 'USDT', priceBasis: 'mark',
      fetchedAt, status: index === 1 ? 'snapshot' : 'live', interval: '15m', points };
    source.set(goldOilAction('quote', oilType, exchange), { oilType, source: history.source, fetchedAt, ratio: 40 + index });
    source.set(goldOilAction('history', oilType, exchange), history);
  }
  const before = structuredClone(source);
  const services = new Map([['cl-xau', { async handle(action, method) { calls.push([action, method]); return source.get(action); } }]]);
  const initial = await readInitialMarket(services);
  assert.deepEqual(calls.map(([action]) => action).sort(), GOLD_OIL_VARIANTS.flatMap(({ oilType, exchange }) =>
    ['quote', 'history'].map(action => goldOilAction(action, oilType, exchange))).sort());
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.ok(!calls.some(([action]) => action.endsWith('funding')), 'Funding is fetched only by the detail API');
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
    const seed = initialGoldOilMarket(initial, oilType, exchange), history = source.get(goldOilAction('history', oilType, exchange));
    assert.equal(seed.history, null);
    assert.equal(seed.funding, null);
    assert.strictEqual(seed.quote, source.get(goldOilAction('quote', oilType, exchange)));
    assert.equal(seed.trend.points.length, 670, 'Seven days contain at most 672 samples; missing periods are not filled');
    assert.equal(seed.trend.points[0].time, end - days, 'The first completed period at the seven-day boundary is retained');
    assert.equal(seed.trend.points[0].value, 0, 'Valid zero trend values are not missing samples');
    assert.equal(seed.trend.points.at(-1).time, end - GOLD_OIL_INTERVAL_MS);
    assert.ok(seed.trend.points.every(point => Object.keys(point).sort().join(',') === 'time,value'));
    assert.equal(trendGeometry(seed.trend.points, GOLD_OIL_INTERVAL_MS).segments.length, 3, 'Explicit null and missing periods both break the sparkline');
    assert.equal(seed.trend.intervalMs, GOLD_OIL_INTERVAL_MS);
    assert.equal(seed.trend.unit, goldOilUnits(oilType, exchange).ratio);
    assert.equal(seed.trend.status, history.status);
    assert.equal(seed.trend.fetchedAt, history.fetchedAt, 'Rendering does not freshen the source timestamp');
    if (history.status === 'live') {
      assert.equal(trendExpired(seed.trend, end + 150_000), false);
      assert.equal(trendExpired(seed.trend, end + 150_001), true);
    }
  }
  assert.deepEqual(source, before, 'Projection must not rewrite or trim the saved source history');
  const detailBytes = Buffer.byteLength(JSON.stringify([...source.values()]));
  const initialBytes = Buffer.byteLength(JSON.stringify(initial['cl-xau']));
  assert.ok(initialBytes < detailBytes * 0.03, `The four 20,000-point markets must stay out of the first-render payload: ${initialBytes}/${detailBytes} bytes`);
});

test('gold/oil overview seeds survive initial detail loading and failure, then yield to recovered complete history', () => {
  const end = Date.parse('2026-10-15T00:00:00Z');
  const seeds = GOLD_OIL_VARIANTS.map(({ oilType, exchange }, index) => ({
    quote: null, history: null, funding: null,
    trend: goldOilTrend({ oilType, source: exchange === 'bybit' ? 'Bybit' : 'Binance', status: 'live', fetchedAt: new Date(end).toISOString(),
      points: [{ time: end - GOLD_OIL_INTERVAL_MS, oil: 100, xau: 4000 + index, ratio: 40 + index }] }, false, oilType, exchange),
  }));
  const initial = { 'cl-xau': { ...seeds[0], bz: seeds[1], bybit: { ...seeds[2], bz: seeds[3] } } };
  const before = structuredClone(initial);
  for (const [index, { oilType, exchange }] of GOLD_OIL_VARIANTS.entries()) {
    const seed = initialGoldOilMarket(initial, oilType, exchange);
    const loading = goldOilOverviewTrend(null, false, seed.trend, oilType, exchange);
    assert.strictEqual(loading, seed.trend);
    assert.equal(loading.points[0].value, 40 + index, 'Each exchange and oil variant retains its own seed');
    const failed = goldOilOverviewTrend(null, true, seed.trend, oilType, exchange);
    assert.equal(failed.status, 'stale');
    assert.deepEqual(failed.points, seed.trend.points);
    assert.equal(failed.fetchedAt, seed.trend.fetchedAt);
    assert.equal(goldOilOverviewTrend(null, false, undefined, oilType, exchange).status, 'loading');
    assert.equal(goldOilOverviewTrend(null, true, undefined, oilType, exchange).status, 'error');
    const history = { oilType, source: exchange === 'bybit' ? 'Bybit' : 'Binance', status: 'live', fetchedAt: new Date(end + GOLD_OIL_INTERVAL_MS).toISOString(),
      points: [{ time: end, oil: 100, xau: 5000 + index, ratio: 50 + index }] };
    const recovered = goldOilOverviewTrend(history, false, seed.trend, oilType, exchange);
    assert.equal(recovered.status, 'live');
    assert.equal(recovered.points[0].value, 50 + index);
    assert.equal(recovered.fetchedAt, history.fetchedAt);
    assert.equal(goldOilOverviewTrend(history, true, seed.trend, oilType, exchange).status, 'stale');
    assert.equal(seed.history, null, 'An overview seed cannot suppress the first complete detail fetch');
    assert.equal(seed.funding, null);
  }
  assert.deepEqual(initial, before, 'Loading and failed detail reads cannot mutate the seed or its original source time');
});
