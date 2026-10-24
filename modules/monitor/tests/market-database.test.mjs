import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { openMarketStore, MARKET_OBSERVATION_RETENTION_MS } from '../server/market-store.mjs';
import { createMarketCollector, seedMarketDatabase } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';
import { createFundingSnapshot, fetchFundingSnapshot } from '../modules/oil/funding-history.mjs';
import { createFundingSnapshot as createBinanceFundingSnapshot } from '../modules/oil/binance-funding-history.mjs';
import { loadMarket, getMarketSnapshot } from '../lib/market-service.ts';
import { createExchangeReader } from '../lib/exchange-service.ts';
import { marketFromExchangeQuote } from '../modules/oil/binance.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';

const NOW = Date.UTC(2026, 8, 16), HOUR = 3_600_000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const quote = (time = NOW, adr = 22) => ({ ordinary: 200, adr, equivalent: 20, spread: adr - 20, premium: (adr / 20 - 1) * 100, fetchedAt: new Date(time).toISOString() });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'market-database-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function database(t, now = () => NOW) {
  const filename = join(await temporary(t), 'market.sqlite');
  const store = await openMarketStore(filename, { clock: now });
  // Test hooks run in registration order, so always close before deleting the directory.
  return { filename, store, async close() { store.close(); } };
}

test('SQLite retains legacy history and 15-minute candles, sample keys and original timestamps across restart; seeding is idempotent', async t => {
  const fixture = await database(t), { store, filename } = fixture;
  try {
    seedMarketDatabase(store);
    store.write('hynix', 'quote', quote());
    store.write('hynix', 'quote', quote());
    assert.equal(store.count('hynix', 'quote'), 1);
    assert.ok(store.count('hynix', 'funding') >= 1512);
    assert.ok(store.count('oil', 'funding') >= 1000);
    assert.ok(store.count('oil', 'candles/15m') >= 5000);
    assert.ok(store.raw('oil', 'history').data[0].date.length === 10);
    assert.equal(store.raw('oil', 'candles/15m').metadata.interval, '15m');
    const before = store.status();
    seedMarketDatabase(store);
    assert.deepEqual(store.status(), before);
    assert.equal(store.read('oil', 'quote').collection.stale, true);
    assert.throws(() => store.read('oil', 'quote', { fresh: true }));
    store.close();
    const reopened = await openMarketStore(filename, { clock: () => NOW + 60_000 });
    try {
      assert.deepEqual(reopened.status(), before);
      const retained = reopened.read('hynix', 'quote');
      assert.equal(retained.fetchedAt, new Date(NOW).toISOString());
      assert.equal(retained.status, 'snapshot');
      assert.equal(retained.collection.lastSuccessAt, new Date(NOW).toISOString());
      assert.equal(reopened.count('hynix', 'quote'), 1);
      assert.throws(() => reopened.read('__proto__', 'quote'));
    } finally { reopened.close(); }
  } finally { store.close(); }
});

test('observation pruning removes rows last confirmed before the retention window across rowid ranges and stops on abort', async t => {
  let clock = NOW;
  const { store, filename } = await database(t, () => clock);
  try {
    assert.equal(await store.pruneObservations(), 0);
    store.write('hynix', 'quote', quote(NOW));
    const day = 86_400_000, retention = MARKET_OBSERVATION_RETENTION_MS;
    assert.equal(retention, 360 * day);
    const direct = new DatabaseSync(filename);
    try {
      const insert = direct.prepare('INSERT INTO market_observations(rowid,dataset,time,payload,source_ms) VALUES (?,?,?,?,?)');
      // Spread rows over several delete ranges; each row's source_ms decides retention, never its time unit.
      insert.run(12_000, 'hynix/quote', 1, '{}', NOW - retention - day);
      insert.run(20_000, 'hynix/quote', 2, '{}', NOW - retention + day);
      insert.run(30_000, 'hynix/quote', 3, '{}', NOW - retention - 2 * day);
    } finally { direct.close(); }
    assert.equal(store.count('hynix', 'quote'), 4);
    const control = new AbortController();
    let pauses = 0;
    assert.equal(await store.pruneObservations({ signal: control.signal, pause: async () => { if (++pauses === 3) control.abort(); } }), 1);
    assert.equal(store.count('hynix', 'quote'), 3);
    assert.equal(await store.pruneObservations({ signal: control.signal }), 0);
    assert.equal(await store.pruneObservations(), 1);
    assert.equal(store.count('hynix', 'quote'), 2);
    assert.equal(store.raw('hynix', 'quote').fetchedAt, new Date(NOW).toISOString());
    clock = NOW + 2 * day;
    assert.equal(await store.pruneObservations(), 1);
    assert.equal(store.count('hynix', 'quote'), 1);
    store.close();
    assert.equal(await store.pruneObservations(), 0);
  } finally { store.close(); }
});

test('a failed multi-row write rolls back samples and latest snapshot together', async t => {
  const { store, filename } = await database(t);
  try {
    const rows = [{ time: NOW - 12 * HOUR, brent: 0.001, wti: 0 }];
    store.write('oil', 'funding', createBinanceFundingSnapshot(rows, new Date(NOW - 4 * HOUR).toISOString()));
    const before = store.raw('oil', 'funding');
    const probe = new DatabaseSync(filename);
    try { probe.exec(`CREATE TRIGGER reject_sample BEFORE INSERT ON market_observations WHEN NEW.time=${NOW - 4 * HOUR} BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;`); }
    finally { probe.close(); }
    assert.throws(() => store.write('oil', 'funding', createBinanceFundingSnapshot([...rows, { time: NOW - 8 * HOUR, brent: 0.002, wti: 0 }, { time: NOW - 4 * HOUR, brent: 0.003, wti: 0 }], new Date(NOW).toISOString())));
    assert.equal(store.count('oil', 'funding'), 1);
    assert.deepEqual(store.raw('oil', 'funding'), before);
  } finally { store.close(); }
});

test('older, future and malformed quotes cannot overwrite the last persisted success', async t => {
  const { store } = await database(t);
  try {
    store.write('hynix', 'quote', quote());
    const before = store.status();
    for (const invalid of [quote(NOW - 1), quote(NOW + 61_000), { ...quote(), ordinary: 0 }, { ...quote(), adr: NaN }]) assert.throws(() => store.write('hynix', 'quote', invalid));
    assert.deepEqual(store.status(), before);
    assert.equal(store.count('hynix', 'quote'), 1);
    assert.equal(store.raw('hynix', 'quote').adr, 22);
  } finally { store.close(); }
});

test('database reads expose the actual source-age budget without renewing the quote or clearing failures', async t => {
  let now = NOW;
  const { store } = await database(t, () => now);
  try {
    store.write('hynix', 'quote', quote());
    assert.equal(store.read('hynix', 'quote').collection.maxAgeMs, 45_000);
    for (const maxAgeMs of [35_000, 75_000]) {
      now = NOW + maxAgeMs;
      const current = store.read('hynix', 'quote', { maxAgeMs });
      assert.equal(current.collection.maxAgeMs, maxAgeMs);
      assert.equal(current.status, 'live');
      assert.equal(current.fetchedAt, new Date(NOW).toISOString());
      assert.equal(current.collection.lastSuccessAt, new Date(NOW).toISOString());
      now++;
      const expired = store.read('hynix', 'quote', { maxAgeMs });
      assert.equal(expired.status, 'snapshot');
      assert.equal(expired.collection.stale, true);
      assert.equal(expired.collection.maxAgeMs, maxAgeMs);
      assert.throws(() => store.read('hynix', 'quote', { maxAgeMs, fresh: true }));
    }
    now = NOW + 1000;
    store.fail('hynix', 'quote', 'offline');
    const failed = store.read('hynix', 'quote', { maxAgeMs: 75_000 });
    assert.equal(failed.status, 'snapshot');
    assert.equal(failed.collection.error, 'offline');
    assert.equal(failed.fetchedAt, new Date(NOW).toISOString());
  } finally { store.close(); }
});

test('corrupt or newer-version databases fail visibly without being overwritten', async t => {
  const filename = join(await temporary(t), 'market.sqlite');
  await writeFile(filename, 'not a database');
  await assert.rejects(openMarketStore(filename));
  assert.equal(await readFile(filename, 'utf8'), 'not a database');
  await rm(filename);
  const db = new DatabaseSync(filename); db.exec('PRAGMA user_version=999'); db.close();
  await assert.rejects(openMarketStore(filename), /version/);
  const check = new DatabaseSync(filename);
  try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999); } finally { check.close(); }
});

test('resident schedules collect without GETs, isolate slow histories, deduplicate and stop after draining writes', async t => {
  let now = NOW;
  const { store } = await database(t, () => now);
  const historyGate = deferred(), timers = new Map(); let timerId = 0, quotes = 0, histories = 0;
  const jobs = [
    { id: 'hynix', action: 'quote', intervalMs: 10_000, load: async () => { quotes++; return quote(now); } },
    { id: 'hynix', action: 'history', intervalMs: 60_000, load: () => { histories++; return historyGate.promise; } },
  ];
  const collector = createMarketCollector(store, { jobs, clock: () => now, timers: { setTimeout(fn, delay) { timers.set(++timerId, { fn, at: now + delay }); return timerId; }, clearTimeout(id) { timers.delete(id); } } });
  try {
    collector.start(); collector.start(); await flush();
    assert.equal(quotes, 1); assert.equal(histories, 1);
    assert.equal(store.raw('hynix', 'quote').fetchedAt, new Date(NOW).toISOString());
    const pending1 = collector.collect(jobs[1]), pending2 = collector.collect(jobs[1]);
    assert.strictEqual(pending1, pending2);
    now += 10_000;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); void timer.fn(); }
    await flush();
    assert.equal(quotes, 2); assert.equal(histories, 1); assert.equal(store.count('hynix', 'quote'), 2);
    let stopped = false; const stopping = collector.stop().then(() => { stopped = true; });
    await flush(); assert.equal(stopped, false);
    historyGate.resolve({ ...getMarketSnapshot(), status: 'live' });
    await stopping;
    assert.equal(timers.size, 0); assert.equal(store.read('hynix', 'history').collection.source, 'database');
    assert.equal(collector.healthy(), true);
  } finally { historyGate.resolve({ ...getMarketSnapshot(), status: 'live' }); await collector.stop(); store.close(); }
});

test('outages retain persisted data and receipt time, prohibit alerts, and recover on the next collection', async t => {
  let now = NOW;
  const { store } = await database(t, () => now);
  const collector = createMarketCollector(store, { jobs: [] });
  try {
    store.write('hynix', 'quote', quote());
    now += 1000;
    assert.equal(await collector.collect({ id: 'hynix', action: 'quote', load: async () => { throw Error('offline'); } }), false);
    const retained = store.read('hynix', 'quote');
    assert.equal(retained.status, 'snapshot'); assert.equal(retained.fetchedAt, new Date(NOW).toISOString());
    assert.equal(retained.collection.lastAttemptAt, new Date(now).toISOString());
    assert.throws(() => store.read('hynix', 'quote', { fresh: true }));
    assert.equal(collector.healthy(), true, 'upstream outages are distinct from database failures');
    assert.equal(await collector.collect({ id: 'hynix', action: 'quote', load: async () => ({ ...quote(now), ordinary: 0 }) }), false);
    assert.equal(collector.healthy(), true); assert.equal(store.raw('hynix', 'quote').adr, 22);
    assert.equal(await collector.collect({ id: 'hynix', action: 'quote', load: async previous => { assert.equal(previous.adr, 22); return quote(now, 23); } }), true);
    assert.equal(store.read('hynix', 'quote', { fresh: true }).adr, 23);
    assert.equal(store.read('hynix', 'quote').collection.error, null);
  } finally { await collector.stop(); store.close(); }
});

test('oil retries a transient public quote read; persistent errors retain source time and reach the hub until a real recovery', async t => {
  let now = NOW, priceCalls = 0, stored = 0, phase = 'initial';
  const { store } = await database(t, () => now);
  const sleeps = [];
  const read = createExchangeReader({ clock: () => now, sleep: async ms => { sleeps.push(ms); }, fetcher: async input => {
    const path = new URL(input).pathname;
    if (path.endsWith('/exchangeInfo')) return Response.json({ symbols: ['BZ', 'CL'].map(baseAsset => ({
      symbol: baseAsset + 'USDT', baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL',
    })) });
    if (path.endsWith('/fundingInfo')) return Response.json([]);
    priceCalls++;
    if (phase === 'failed' || phase === 'transient' && priceCalls === 2) return new Response('PRIVATE_UPSTREAM_BODY', { status: 502 });
    return Response.json(['BZ', 'CL'].map((base, index) => ({ symbol: base + 'USDT', markPrice: String(100 - index * 5),
      lastFundingRate: '0', nextFundingTime: now + HOUR, time: phase === 'old' ? now - 121_000 : now - 2000 })));
  } });
  const job = { id: 'oil', action: 'quote', load: async () => marketFromExchangeQuote(await read('binance', 'oil')) };
  const collector = createMarketCollector(store, { jobs: [], onStored: () => { stored++; } });
  try {
    assert.equal(await collector.collect(job), true);
    await flush();
    now += 30_000; phase = 'transient';
    assert.equal(await collector.collect(job), true);
    await flush();
    assert.equal(priceCalls, 3, 'The one failed request was retried inside the same collection');
    assert.deepEqual(sleeps, [300]);
    const good = store.read('oil', 'quote', { fresh: true });
    assert.equal(good.fetchedAt, new Date(now - 2000).toISOString());
    assert.equal(stored, 2);

    now += 30_000; phase = 'failed';
    assert.equal(await collector.collect(job), false);
    await flush();
    assert.equal(priceCalls, 5, 'Persistent transport failures stop after two attempts');
    assert.equal(stored, 2, 'Failed reads never notify alert consumers');
    const retained = store.read('oil', 'quote');
    assert.equal(retained.fetchedAt, good.fetchedAt);
    assert.equal(retained.collection.lastSuccessAt, good.collection.lastSuccessAt);
    assert.equal(retained.collection.lastAttemptAt, new Date(now).toISOString());
    assert.match(retained.collection.error, /Binance 标记价格.*HTTP 502/);
    assert.doesNotMatch(retained.collection.error, /PRIVATE_UPSTREAM_BODY/);
    assert.throws(() => store.read('oil', 'quote', { fresh: true }));
    const summary = await readHubSummary(new Map([['oil', { handle: () => retained }]]), now);
    assert.equal(summary.health.state, 'stale');
    assert.equal(summary.updatedAt, good.fetchedAt);
    assert.match(summary.health.message, /Binance 标记价格.*HTTP 502/);

    now += 30_000; phase = 'old';
    assert.equal(await collector.collect(job), false);
    assert.equal(priceCalls, 6, 'An old source timestamp is a validation error, not retryable transport');
    assert.match(store.read('oil', 'quote').collection.error, /报价校验.*时间无效/);
    assert.equal(store.raw('oil', 'quote').fetchedAt, good.fetchedAt);
    assert.equal(stored, 2);

    now += 30_000; phase = 'recovered';
    assert.equal(await collector.collect(job), true);
    await flush();
    const recovered = store.read('oil', 'quote', { fresh: true });
    assert.equal(recovered.collection.error, null);
    assert.equal(recovered.fetchedAt, new Date(now - 2000).toISOString());
    assert.equal(stored, 3);
  } finally { await collector.stop(); store.close(); }
});

test('write failures mark the collector unhealthy until durable recovery', async t => {
  const { store } = await database(t); let broken = true, notified = 0;
  const collector = createMarketCollector({ ...store, write(...args) { if (broken) throw Error('disk full'); return store.write(...args); } }, { jobs: [], onStored() { assert.equal(store.read('hynix', 'quote', { fresh: true }).adr, 22); notified++; } });
  const job = { id: 'hynix', action: 'quote', load: async () => quote() };
  try {
    assert.equal(await collector.collect(job), false); assert.equal(collector.healthy(), false);
    await flush(); assert.equal(notified, 0, 'Failed writes cannot notify alert consumers');
    assert.equal(store.raw('hynix', 'quote'), null);
    broken = false;
    assert.equal(await collector.collect(job), true); assert.equal(collector.healthy(), true);
    assert.equal(store.count('hynix', 'quote'), 1);
    await flush(); assert.equal(notified, 1, 'Alert consumers run only after the database commit');
  } finally { await collector.stop(); store.close(); }
});

test('authenticated APIs only read SQLite, including old URLs, with the collector stopped', async t => {
  const directory = await temporary(t);
  const seeded = await openMarketStore(join(directory, 'market.sqlite'));
  seeded.write('hynix', 'quote', quote(Date.now())); seeded.close();
  let loads = 0, fallthrough = 0;
  const services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [{ id: 'hynix', action: 'quote', intervalMs: 10_000, load() { loads++; throw Error('must not fetch'); } }] } });
  const server = createServer(createHandler({ services, username: 'admin', password: 'database-test-password', nextHandler(_request, response) { fallthrough++; response.writeHead(404); response.end(); } }));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Basic ${Buffer.from('admin:database-test-password').toString('base64')}` };
    const before = services.market.status();
    assert.equal((await fetch(`${base}/api/monitors/oil/history`)).status, 401);
    for (let repeat = 0; repeat < 3; repeat++) for (const path of ['/api/quote', '/api/market', '/api/monitors/oil/candles/15m', ...['oil', 'hynix'].flatMap(id => ['quote', 'history', 'funding'].map(action => `/api/monitors/${id}/${action}`))]) {
      const response = await fetch(base + path, { headers }); assert.equal(response.status, 200, path);
      assert.equal((await response.json()).collection.source, 'database');
    }
    assert.equal((await fetch(`${base}/api/monitors/oil/funding`, { method: 'POST', headers })).status, 405);
    assert.deepEqual(services.market.status(), before);
    assert.equal(loads, 0); assert.equal(fallthrough, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
});

test('resumed Hynix history only fetches the recent overlap, but backfills an older interior gap', async () => {
  const baseline = getMarketSnapshot(), now = Date.parse(baseline.fetchedAt) + HOUR;
  let starts = [];
  const fetcher = async (_url, init) => {
    const { req } = JSON.parse(init.body); starts.push(req.startTime);
    const point = baseline.points.at(-1);
    return Response.json([{ t: point.time, T: point.time + HOUR - 1, s: req.coin, i: '1h', c: String(req.coin === 'xyz:SKHX' ? point.ordinary : point.adr) }]);
  };
  const updated = await loadMarket(fetcher, now, baseline);
  assert.equal(updated.status, 'live'); assert.equal(updated.points.length, baseline.points.length);
  assert.ok(starts.every(time => time >= baseline.points.at(-1).time - 48 * HOUR));
  const missing = baseline.points[10].time;
  starts = [];
  await loadMarket(fetcher, now, { ...baseline, points: baseline.points.filter(point => point.time !== missing) });
  assert.ok(starts.every(time => time <= missing));
});

test('oil funding collection backfills old gaps and missing counterparts beyond the two-day overlap', async () => {
  const start = Date.UTC(2026, 2, 5), now = start + 110 * HOUR;
  const rows = Array.from({ length: 101 }, (_, index) => ({ time: start + index * HOUR, brent: index === 4 ? null : 0.001, wti: 0.0002 })).filter((_, index) => index !== 3);
  const starts = [];
  const result = await fetchFundingSnapshot(createFundingSnapshot(rows, new Date(now).toISOString()), { now, fetcher: async (_url, init) => {
    const request = JSON.parse(init.body); starts.push(request.startTime);
    return Response.json([3, 4].map(index => ({ coin: request.coin, time: start + index * HOUR, fundingRate: request.coin === 'xyz:CL' ? '0.0002' : '0.001' })).filter(row => row.time >= request.startTime));
  } });
  assert.ok(starts.some(time => time <= start + 3 * HOUR));
  assert.equal(result.metadata.pairedObservationRows, 101);
  assert.equal(result.data.find(row => row.time === start + 4 * HOUR).brent, 0.001);
});
