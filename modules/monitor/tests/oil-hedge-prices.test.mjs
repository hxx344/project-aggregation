import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { OIL_HEDGE_PRICES_ACTION, HEDGE_HOUR_MS as HOUR, HEDGE_WINDOW_MS, HEDGE_PRICE_LEGS, HEDGE_PRICES_REFRESH_MS, HEDGE_PRICES_STALE_MS, hedgePriceRange, validateOilHedgePrices } from '../lib/oil-hedge-prices.ts';
import { parseBybitMarkPrices, parseBinanceMarkPrices, createOilHedgePricesReader } from '../lib/oil-hedge-price-service.ts';
import { createDataReader } from '../lib/monitor-service.ts';
import { openMarketStore, storageKey } from '../server/market-store.mjs';
import { createMarketCollector, marketJobs } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';

const NOW = Date.UTC(2026, 9, 1, 10), ACTION = OIL_HEDGE_PRICES_ACTION;
const iso = time => new Date(time).toISOString();
function prices(now = NOW) {
  const range = hedgePriceRange(now);
  return validateOilHedgePrices({ monitorId: 'oil', currency: 'USDT', intervalMs: HOUR, priceBasis: 'hour-open-mark', fetchedAt: iso(now), status: 'live',
    legs: HEDGE_PRICE_LEGS.map((leg, index) => ({ ...leg, fetchedAt: iso(now), error: '', coverage: range, rows: [{ time: range.to - HOUR, price: 70 + index }, { time: range.to, price: 80 + index }] })),
  });
}
function requestInfo(input) {
  const url = new URL(input), bybit = url.hostname === 'api.bybit.com';
  assert.ok(bybit || url.hostname === 'fapi.binance.com');
  assert.equal(url.pathname, bybit ? '/v5/market/mark-price-kline' : '/fapi/v1/markPriceKlines');
  assert.equal(url.searchParams.get('interval'), bybit ? '60' : '1h');
  assert.equal(url.searchParams.get('limit'), '1000');
  if (bybit) assert.equal(url.searchParams.get('category'), 'linear');
  return { exchange: bybit ? 'bybit' : 'binance', symbol: url.searchParams.get('symbol'), from: Number(url.searchParams.get(bybit ? 'start' : 'startTime')), to: Number(url.searchParams.get(bybit ? 'end' : 'endTime')) };
}
function candleResponse(request, rows) {
  const list = rows.map(row => [String(row.time), String(row.price), '999', '1', '9999']);
  return Response.json(request.exchange === 'bybit' ? { retCode: 0, result: { category: 'linear', symbol: request.symbol, list: list.reverse() } } : list);
}
function allHours(range, price = 80) {
  return Array.from({ length: Math.floor((range.to - range.from) / HOUR) + 1 }, (_, index) => ({ time: range.from + index * HOUR, price }));
}

test('price boundary fixes the exact four USDT legs, hour-open mark basis and unique positive finite hourly samples', () => {
  const initial = prices(), newest = NOW;
  assert.deepEqual(initial.legs.map(({ exchange, symbol }) => ({ exchange, symbol })), HEDGE_PRICE_LEGS);
  for (const patch of [{ monitorId: 'hynix' }, { currency: 'USD' }, { intervalMs: 60_000 }, { priceBasis: 'close' }, { fetchedAt: 'invalid' }, { legs: initial.legs.slice(1) }, { legs: [initial.legs[0], ...initial.legs.slice(0, 3)] }]) assert.throws(() => validateOilHedgePrices({ ...initial, ...patch }));
  for (const price of [0, -1, NaN, Infinity, null, '', '80']) {
    const changed = structuredClone(initial); changed.legs[0].rows[0].price = price;
    assert.throws(() => validateOilHedgePrices(changed));
  }
  for (const time of [newest + HOUR, newest + 1, newest - HEDGE_WINDOW_MS - HOUR, NaN]) {
    const changed = structuredClone(initial); changed.legs[0].rows[0].time = time;
    assert.throws(() => validateOilHedgePrices(changed));
  }
  const duplicated = structuredClone(initial); duplicated.legs[0].rows.push(duplicated.legs[0].rows[0]);
  assert.throws(() => validateOilHedgePrices(duplicated));
  for (const patch of [{ exchange: 'okx' }, { symbol: 'BZUSD' }, { fetchedAt: null }, { fetchedAt: iso(NOW + 1) }, { coverage: { from: NOW - HOUR, to: NOW + 1 } }, { coverage: { from: NOW, to: NOW - HOUR } }, { coverage: { from: NOW, to: NOW } }]) {
    const changed = structuredClone(initial); Object.assign(changed.legs[0], patch);
    assert.throws(() => validateOilHedgePrices(changed));
  }
  const missing = structuredClone(initial); Object.assign(missing.legs[0], { rows: [], fetchedAt: null, coverage: null, error: 'Unavailable' });
  assert.deepEqual(validateOilHedgePrices(missing).legs[0].rows, []);
  assert.deepEqual(hedgePriceRange(NOW + 123), { from: NOW - HEDGE_WINDOW_MS + HOUR, to: NOW });
});

test('both exchange parsers take only candle open and reject wrong Bybit identity, repeated pages and out-of-window rows', () => {
  const range = { from: NOW - HOUR, to: NOW }, list = [[String(NOW), '80', '90', '70', '999'], [String(NOW - HOUR), '79', '89', '69', '999']];
  const input = { retCode: 0, result: { category: 'linear', symbol: 'BZUSDT', list } };
  const expected = [{ time: NOW - HOUR, price: 79 }, { time: NOW, price: 80 }];
  assert.deepEqual(parseBybitMarkPrices(input, 'BZUSDT', range), expected);
  assert.deepEqual(parseBinanceMarkPrices(list, range), expected);
  for (const patch of [{ retCode: 10001 }, { result: { ...input.result, category: 'inverse' } }, { result: { ...input.result, symbol: 'CLUSDT' } }]) assert.throws(() => parseBybitMarkPrices({ ...input, ...patch }, 'BZUSDT', range));
  for (const rows of [[list[0], list[0]], [[NOW + HOUR, '80']], [[NOW + 1, '80']], [[NOW, null]], [[NOW, '']], [[NOW, '-1']], Array(1001).fill(list[0]), { code: -1 }]) assert.throws(() => parseBinanceMarkPrices(rows, range));
});

test('initial backfill requests all sixty days without cap truncation, then refresh overlaps one day per leg and prunes expired hours', async () => {
  let now = NOW;
  const calls = [];
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async (url, init) => {
    assert.equal(init.cache, 'no-store'); assert.ok(init.signal);
    const request = requestInfo(url); calls.push(request);
    assert.ok(request.to - request.from <= 999 * HOUR);
    return candleResponse(request, allHours(request, now === NOW ? 80 : 81));
  } });
  const initial = await read();
  assert.equal(calls.length, 8);
  for (const leg of initial.legs) {
    assert.equal(leg.rows.length, 1441); assert.equal(leg.rows[0].time, NOW - HEDGE_WINDOW_MS); assert.equal(leg.rows.at(-1).time, NOW);
    const pages = calls.filter(call => call.exchange === leg.exchange && call.symbol === leg.symbol);
    assert.equal(pages[1].from, pages[0].to + HOUR);
  }
  calls.length = 0; now += HOUR;
  const updated = await read(initial);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.from === NOW - 24 * HOUR && call.to === now));
  assert.ok(updated.legs.every(leg => leg.rows.length === 1441 && leg.rows[0].time === now - HEDGE_WINDOW_MS));
  assert.equal(updated.legs[0].rows.at(-1).price, 81);
  assert.equal(updated.legs[0].rows.find(row => row.time === NOW - 25 * HOUR).price, 80);
  assert.equal(updated.legs[0].rows.find(row => row.time === NOW - 24 * HOUR).price, 81);
  assert.deepEqual(updated.legs[0].coverage, hedgePriceRange(now));
});

test('empty and sparse pages remain empty, while later windows are still queried and bounds exclude partial starting hours', async () => {
  const now = NOW + 123_456, range = hedgePriceRange(now), calls = [];
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async url => {
    const request = requestInfo(url); calls.push(request);
    return candleResponse(request, request.symbol === 'BZUSDT' || request.from === range.from ? [] : [{ time: request.to, price: 80 }]);
  } });
  const value = await read();
  assert.equal(calls.length, 8); assert.ok(calls.every(call => call.from >= range.from && call.to <= range.to));
  for (const leg of value.legs) {
    assert.deepEqual(leg.coverage, range); assert.equal(leg.rows.length, leg.symbol === 'BZUSDT' ? 0 : 1);
  }
});

test('incremental refresh repairs an old internal gap with at most one bounded window per leg and stops after recovery', async () => {
  let now = NOW, sparse = true;
  const gap = NOW - 48 * HOUR, calls = [];
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async url => {
    const request = requestInfo(url); calls.push(request);
    const rows = allHours(request).filter(row => !(sparse && request.exchange === 'bybit' && request.symbol === 'BZUSDT' && row.time === gap));
    return candleResponse(request, rows);
  } });
  const initial = await read(); assert.equal(initial.legs[0].rows.some(row => row.time === gap), false);
  calls.length = 0; sparse = false; now += HEDGE_PRICES_REFRESH_MS;
  const repaired = await read(initial);
  assert.equal(calls.length, 5);
  const repair = calls.find(call => call.from === gap);
  assert.ok(repair); assert.ok(repair.to - repair.from <= 23 * HOUR); assert.ok(repair.to < NOW - 24 * HOUR);
  assert.equal(repaired.legs[0].rows.find(row => row.time === gap).price, 80);
  assert.ok(calls.filter(call => call.from === NOW - 24 * HOUR).length === 4, 'Normal one-day overlap remains unchanged');
  calls.length = 0; now += HEDGE_PRICES_REFRESH_MS; await read(repaired);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.from === NOW - 24 * HOUR));
});

test('successful empty gap repairs remain missing and retry; repair failure keeps the old leg source time and error state', async () => {
  const gap = NOW - 48 * HOUR, initial = prices();
  initial.legs.forEach(leg => { leg.rows = allHours(hedgePriceRange(NOW)).filter(row => row.time !== gap); });
  let now = NOW + HEDGE_PRICES_REFRESH_MS, failRepair = false;
  const calls = [];
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async url => {
    const request = requestInfo(url); calls.push(request);
    if (request.from === gap) {
      if (failRepair && request.exchange === 'bybit') return new Response('', { status: 503 });
      return candleResponse(request, []);
    }
    return candleResponse(request, allHours(request));
  } });
  const empty = await read(initial);
  assert.equal(calls.length, 8); assert.ok(empty.legs.every(leg => !leg.rows.some(row => row.time === gap)));
  calls.length = 0; now += HEDGE_PRICES_REFRESH_MS; failRepair = true;
  const partial = await read(empty);
  assert.equal(calls.length, 8); assert.equal(calls.filter(call => call.from === gap).length, 4);
  for (const index of [0, 1]) {
    assert.equal(partial.legs[index].fetchedAt, empty.legs[index].fetchedAt); assert.ok(partial.legs[index].error);
    assert.deepEqual(partial.legs[index].rows, empty.legs[index].rows);
  }
  assert.equal(partial.legs[2].fetchedAt, iso(now)); assert.equal(partial.legs[2].error, '');
});

test('empty pre-listing prefixes, sparse boundaries and empty histories do not trigger repeated full backfills', async () => {
  let now = NOW;
  const calls = [], listedAt = NOW - 72 * HOUR, last = NOW - 5 * HOUR;
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async url => {
    const request = requestInfo(url); calls.push(request);
    let rows = allHours(request).filter(row => row.time >= listedAt && row.time <= last);
    if (request.exchange === 'binance') rows = request.symbol === 'BZUSDT' ? [] : rows.filter(row => row.time === last);
    return candleResponse(request, rows);
  } });
  const initial = await read();
  assert.equal(initial.legs[0].rows[0].time, listedAt); assert.equal(initial.legs[0].rows.at(-1).time, last);
  assert.equal(initial.legs[2].rows.length, 0); assert.equal(initial.legs[3].rows.length, 1);
  calls.length = 0; now += HEDGE_PRICES_REFRESH_MS; await read(initial);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.from === NOW - 24 * HOUR));
});

test('partial failures retain the complete old leg and its source time; first failures stay empty and all-failed updates reject', async () => {
  let now = NOW, failed = new Set();
  const read = createOilHedgePricesReader({ clock: () => now, fetcher: async url => {
    const request = requestInfo(url);
    if (failed.has(`${request.exchange}/${request.symbol}`)) return new Response('', { status: 503 });
    return candleResponse(request, [{ time: request.to, price: 80 }]);
  } });
  const initial = await read(); now += HOUR; failed.add('bybit/CLUSDT');
  const partial = await read(initial), retained = partial.legs[1];
  assert.equal(retained.fetchedAt, initial.legs[1].fetchedAt); assert.ok(retained.error);
  assert.deepEqual(retained.rows, initial.legs[1].rows); assert.equal(retained.coverage.from, now - HEDGE_WINDOW_MS);
  assert.equal(partial.legs[0].fetchedAt, iso(now));
  const freshPartial = await read(); assert.equal(freshPartial.legs[1].fetchedAt, null); assert.equal(freshPartial.legs[1].coverage, null); assert.deepEqual(freshPartial.legs[1].rows, []);
  failed = new Set(HEDGE_PRICE_LEGS.map(leg => `${leg.exchange}/${leg.symbol}`));
  await assert.rejects(read(partial), /unavailable/);
});

test('a failed second page or repeated API window never publishes an incomplete replacement leg', async () => {
  const initial = prices(), first = hedgePriceRange(NOW).from;
  // Unknown coverage requires complete backfill, even with old samples present.
  initial.legs.forEach(leg => { leg.coverage = null; });
  const read = createOilHedgePricesReader({ clock: () => NOW, fetcher: async url => {
    const request = requestInfo(url);
    if (request.exchange === 'bybit' && request.from > first) return new Response('', { status: 503 });
    return candleResponse(request, allHours(request));
  } });
  const value = await read(initial);
  assert.deepEqual(value.legs[0].rows, initial.legs[0].rows); assert.equal(value.legs[0].coverage, null); assert.ok(value.legs[0].error);
  const repeated = createOilHedgePricesReader({ clock: () => NOW, fetcher: async url => {
    const request = requestInfo(url);
    return candleResponse(request, [{ time: first, price: 80 }]);
  } });
  await assert.rejects(repeated(), /unavailable/);
});

test('preview prices deduplicate independent requests, cache five minutes and keep timestamps through all-leg failure snapshots', async () => {
  let now = NOW, calls = 0, fail = false, passedPrevious;
  const read = createDataReader({ oil: { quote: async () => ({}) }, hynix: { quote: async () => ({}) } }, () => now, async () => { throw Error('quote path used'); }, async () => { throw Error('funding path used'); }, async previous => {
    calls++; passedPrevious = previous; if (fail) throw Error('offline'); return prices(now);
  });
  const initial = await Promise.all([read('oil', ACTION), read('oil', ACTION)]);
  assert.equal(calls, 1); assert.equal(passedPrevious, undefined); assert.deepEqual(initial[0], initial[1]);
  now += HEDGE_PRICES_REFRESH_MS - 1; await read('oil', ACTION); assert.equal(calls, 1);
  now += 2; fail = true;
  const retained = await read('oil', ACTION); assert.equal(calls, 2); assert.equal(retained.status, 'snapshot');
  assert.equal(retained.fetchedAt, initial[0].fetchedAt); assert.deepEqual(retained.legs, initial[0].legs); assert.deepEqual(passedPrevious, initial[0]);
  now += 14_999; await read('oil', ACTION); assert.equal(calls, 2);
  now += 2; await read('oil', ACTION); assert.equal(calls, 3);
  for (const id of ['hynix', 'perpetual', 'cl-xau']) await assert.rejects(read(id, ACTION), /Unsupported/);
  await assert.rejects(read('oil', `${ACTION}/extra`));
});

test('persistent collection keeps all legs at shared hours, isolates the dataset and serves read-only oil GETs on the resident runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oil-hedge-prices-'));
  let store, services, server;
  try {
    let now = Date.now(); store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => now });
    const initial = prices(now); store.write('oil', ACTION, initial); store.write('oil', ACTION, initial);
    assert.equal(store.count('oil', ACTION), 2); assert.deepEqual(store.raw('oil', ACTION).legs, initial.legs);
    assert.equal(storageKey(`oil/${ACTION}`), `oil/${ACTION}`);
    now += HEDGE_PRICES_STALE_MS + 1; assert.equal(store.read('oil', ACTION).status, 'snapshot');
    const collector = createMarketCollector(store, { jobs: [] });
    await collector.collect({ id: 'oil', action: ACTION, load(previous) { assert.equal(previous.fetchedAt, initial.fetchedAt); throw Error('offline'); } });
    assert.equal(store.read('oil', ACTION).fetchedAt, initial.fetchedAt); assert.equal(store.read('oil', ACTION).status, 'snapshot');
    await collector.stop(); store.close(); store = null;
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
    server = createServer(createHandler({ services, username: 'admin', password: 'hedge-test-password', nextHandler(_req, res) { res.writeHead(404).end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Basic ${Buffer.from('admin:hedge-test-password').toString('base64')}` }, before = services.market.status();
    const url = `${base}/api/monitors/oil/${ACTION}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers }); assert.equal(response.status, 200);
    const value = await response.json(); assert.deepEqual(value.legs, initial.legs); assert.equal(value.collection.source, 'database'); assert.equal(value.status, 'snapshot');
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    for (const id of ['hynix', 'perpetual', 'cl-xau']) assert.equal((await fetch(`${base}/api/monitors/${id}/${ACTION}`, { headers })).status, 404);
    assert.deepEqual(services.market.status(), before);
    const jobs = marketJobs().filter(job => job.action === ACTION);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].id, 'oil'); assert.equal(jobs[0].intervalMs, HEDGE_PRICES_REFRESH_MS);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
    store?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('Next/Sites route exposes only the oil price action and preserves no-store and unavailable responses', async () => {
  const routeURL = new URL('../app/api/monitors/[id]/[...action]/route.ts', import.meta.url);
  const original = await readFile(routeURL, 'utf8');
  async function loadRoute(fail = false) {
    // Exercise the actual route while replacing just the network-backed reader.
    const source = original.replace(/import \{ readMonitorData \} from [^;]+;/, `const readMonitorData = async (id, action) => { ${fail ? "throw Error('offline');" : `return { id, action, value: ${JSON.stringify(prices())} };`} };`)
      .replace(/from (["'])(\.\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(/\.(?:ts|mjs)$/.test(specifier) ? specifier : `${specifier}.ts`, routeURL).href)}`);
    return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  }
  const { GET } = await loadRoute();
  const request = new Request('http://localhost/api/monitors/oil/funding-hedge/prices');
  const context = (id, action = ACTION) => ({ params: Promise.resolve({ id, action: action.split('/') }) });
  const response = await GET(request, context('oil')); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json(); assert.equal(body.action, ACTION); assert.equal(body.value.priceBasis, 'hour-open-mark');
  for (const id of ['hynix', 'perpetual', 'cl-xau', 'unknown']) assert.equal((await GET(request, context(id))).status, 404);
  assert.equal((await GET(request, context('oil', `${ACTION}/extra`))).status, 404);
  assert.equal((await (await loadRoute(true)).GET(request, context('oil'))).status, 503);
});
