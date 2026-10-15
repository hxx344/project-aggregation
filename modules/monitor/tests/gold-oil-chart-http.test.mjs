import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { openMarketStore } from '../server/market-store.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';
import { GOLD_OIL_VARIANTS, GOLD_OIL_EXCHANGES, goldOilAction, GOLD_OIL_INTERVAL_MS as STEP } from '../lib/gold-oil.ts';
import { validateGoldOilChartData } from '../lib/gold-oil-chart-data.ts';

const headers = { Authorization: `Basic ${Buffer.from('chart:chart-fixture-password').toString('base64')}` };
function snapshots(variant, now) {
  const { oilType, exchange } = variant, source = GOLD_OIL_EXCHANGES[exchange].name, end = Math.floor(now / STEP) * STEP, start = end - 1000 * STEP;
  const base = { oilType, source, fetchedAt: new Date(now).toISOString(), status: 'live' };
  return {
    history: { ...base, currency: 'USDT', priceBasis: 'mark', interval: '15m', coverageStart: start, points: Array.from({ length: 1000 }, (_, i) => ({ time: start + i * STEP, oil: 80, xau: 2800 + i, ratio: (2800 + i) / 80 })) },
    funding: { ...base, coverageStart: start, coverageEnd: end, points: Array.from({ length: 250 }, (_, i) => ({ time: start + i * 4 * STEP, oil: 0, xau: 0.0001 })) },
  };
}
async function setup(t, seed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'gold-oil-chart-http-')), now = Date.now();
  let calls = 0;
  const store = await openMarketStore(join(directory, 'market.sqlite'));
  if (seed) for (const variant of GOLD_OIL_VARIANTS) for (const [action, value] of Object.entries(snapshots(variant, now))) store.write('cl-xau', goldOilAction(action, variant.oilType, variant.exchange), value);
  store.close();
  const services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => ({ id: 'cl-xau', action: goldOilAction('history', oilType, exchange), intervalMs: 60000, load: async () => { calls++; throw Error('GET must not start a collector'); } })) } });
  const server = createServer(createHandler({ services, username: 'chart', password: 'chart-fixture-password', nextHandler: (_req, response) => { response.statusCode = 404; response.end(); } }));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise(done => server.close(done));
    await Promise.all([...services.values()].map(service => service.stop()));
    await services.notifications.stop(); await services.market.stop();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'gold-oil-chart-http-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, services, now, calls: () => calls, base: `http://127.0.0.1:${server.address().port}/api/monitors/cl-xau/` };
}
function compressedRead(url, encoding) {
  return new Promise((resolve, reject) => get(url, { headers: { ...headers, 'Accept-Encoding': encoding } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject));
}

test('four chart routes return bounded persisted windows with gzip and keep full history/funding APIs unchanged', async t => {
  const runtime = await setup(t), before = runtime.services.market.status();
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
    const url = runtime.base + goldOilAction('chart', oilType, exchange);
    const zipped = await compressedRead(url, 'gzip');
    assert.equal(zipped.status, 200); assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.equal(zipped.headers.vary, 'Accept-Encoding');
    assert.equal(zipped.headers['cache-control'], 'no-store'); assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
    const data = validateGoldOilChartData(JSON.parse(gunzipSync(zipped.body)), '7d', oilType, exchange);
    assert.equal(data.history.points.length, 672); assert.equal(data.funding.points.length, 168); assert.equal(data.history.fetchedAt, new Date(runtime.now).toISOString());
    assert.equal(data.fullHistory.first.time, Math.floor(runtime.now / STEP) * STEP - 1000 * STEP);
    const plain = await compressedRead(url, 'gzip;q=0, identity'); assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(JSON.parse(plain.body), data);
    assert.ok(zipped.body.length < plain.body.length / 3);
    for (const [range, count] of [['1d', 96], ['1m', 1000], ['all', 1000]]) {
      const response = await fetch(url + '?range=' + range, { headers }); assert.equal(response.status, 200);
      assert.equal(validateGoldOilChartData(await response.json(), range, oilType, exchange).history.points.length, count);
    }
    for (const [action, count] of [['history', 1000], ['funding', 250]]) {
      const response = await fetch(runtime.base + goldOilAction(action, oilType, exchange) + '?range=garbage&unrelated=1', { headers }); assert.equal(response.status, 200);
      const legacy = await response.json(); assert.equal(legacy.points.length, count); assert.equal(legacy.scope, undefined);
    }
  }
  assert.equal(runtime.calls(), 0); assert.deepEqual(runtime.services.market.status(), before, 'GET cannot write success/error/attempt metadata');
});

test('chart GET validates only its range query before dispatch and preserves authenticated route restrictions', async t => {
  let calls = 0;
  const services = new Map([['cl-xau', { actions: { chart: ['GET'], history: ['GET'] }, handle: async (_action, _method, input) => { calls++; return { range: input?.range }; } }]]);
  const server = createServer(createHandler({ services, username: 'chart', password: 'chart-fixture-password', nextHandler: (_req, response) => response.end() }));
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/api/monitors/cl-xau/`;
  assert.equal((await fetch(base + 'chart')).status, 401);
  for (const query of ['?range=', '?range=30d', '?range=7', '?range=all&range=7d', '?unexpected=1', '?range=7d&unexpected=1']) assert.equal((await fetch(base + 'chart' + query, { headers })).status, 400);
  assert.equal(calls, 0);
  for (const [query, expected] of [['', '7d'], ['?range=1d', '1d'], ['?range=7d', '7d'], ['?range=1m', '1m'], ['?range=all', 'all']]) assert.deepEqual(await (await fetch(base + 'chart' + query, { headers })).json(), { range: expected });
  assert.equal((await fetch(base + 'chart', { headers, method: 'POST' })).status, 405);
  assert.equal((await fetch(base + 'other/chart', { headers })).status, 404);
  assert.equal((await fetch(base + 'history?range=invalid', { headers })).status, 200);
});

test('cold chart GET stays read-only, returns partial sources immediately and recovers after persisted collection', async t => {
  const runtime = await setup(t, false), variant = { oilType: 'bz', exchange: 'bybit' }, action = goldOilAction('chart', 'bz', 'bybit');
  const read = async () => {
    const response = await fetch(runtime.base + action, { headers }); assert.equal(response.status, 200);
    return validateGoldOilChartData(await response.json(), '7d', 'bz', 'bybit');
  };
  const before = runtime.services.market.status(), missing = await read();
  assert.equal(missing.state, 'pending'); assert.equal(missing.history, null); assert.equal(missing.funding, null);
  assert.deepEqual(runtime.services.market.status(), before); assert.equal(runtime.calls(), 0);
  const store = await openMarketStore(join(runtime.directory, 'market.sqlite'));
  try {
    const values = snapshots(variant, runtime.now);
    store.write('cl-xau', goldOilAction('funding', 'bz', 'bybit'), values.funding);
    const fundingOnly = await read(); assert.equal(fundingOnly.state, 'partial'); assert.equal(fundingOnly.history, null); assert.ok(fundingOnly.funding);
    store.write('cl-xau', goldOilAction('history', 'bz', 'bybit'), values.history);
    const complete = await read(); assert.equal(complete.state, 'ready'); assert.equal(complete.history.points.length, 672);
    store.fail('cl-xau', goldOilAction('funding', 'bz', 'bybit'), '持久资金费错误');
    const stale = await read(); assert.equal(stale.state, 'partial'); assert.equal(stale.funding.status, 'snapshot'); assert.equal(stale.fundingError, '持久资金费错误'); assert.equal(stale.history.status, 'live');
  } finally { store.close(); }
  assert.equal(runtime.calls(), 0);
});
