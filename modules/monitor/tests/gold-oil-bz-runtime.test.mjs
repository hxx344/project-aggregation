import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector, marketJobs } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createHandler } from '../server/http.mjs';
import { createGoldOilAlertDefinition, confirmGoldOilTriggers } from '../server/gold-oil/alerts.mjs';

const rule = threshold => ({ id: 'same-tier', label: '上沿', metric: 'ratio', operator: 'gte', threshold, cooldownMinutes: 1, hysteresis: 0.5, enabled: true });
const snapshots = (now, oilType = 'cl', price = oilType === 'cl' ? 80 : 100) => {
  const fetchedAt = new Date(now).toISOString(), end = Math.floor(now / 900000) * 900000, start = end - 1800000;
  const oil = { symbol: oilType === 'cl' ? 'CLUSDT' : 'BZUSDT', price, updatedAt: fetchedAt };
  const leg = oilType === 'cl' ? { cl: oil } : { oilType, oil };
  const base = { source: 'Binance', currency: 'USDT', priceBasis: 'mark', fetchedAt, status: 'live' };
  return {
    quote: { ...base, ...leg, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: fetchedAt }, ratio: 4000 / price, funding: null },
    history: { ...base, ...(oilType === 'bz' ? { oilType } : {}), interval: '15m', coverageStart: start, points: [start, start + 900000].map(time => ({ time, [oilType === 'cl' ? 'cl' : 'oil']: price, xau: 4000, ratio: 4000 / price })) },
    funding: { source: 'Binance', fetchedAt, status: 'live', ...(oilType === 'bz' ? { oilType } : {}), coverageStart: start, coverageEnd: end,
      points: [{ time: start, [oilType === 'cl' ? 'cl' : 'oil']: oilType === 'cl' ? 0.0001 : 0.0002, xau: 0.0003 }] },
  };
};
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gold-oil-bz-runtime-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'gold-oil-bz-runtime-')); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function eventually(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(10); }
  assert.fail('Condition did not become true');
}
async function closeServices(services) { await Promise.all([...services.values()].map(service => service.stop())); await services.notifications.stop(); await services.market.stop(); }

test('legacy CL rows normalize on read without rewriting, while BZ storage and stale state remain separate', async t => {
  const directory = await temporary(t), path = join(directory, 'market.sqlite'), now = Date.now();
  let store = await openMarketStore(path, { clock: () => now });
  const cl = snapshots(now), bz = snapshots(now, 'bz');
  try {
    for (const action of ['quote', 'history', 'funding']) {
      store.write('cl-xau', action, cl[action]); store.write('cl-xau', `bz/${action}`, bz[action]);
      assert.throws(() => store.write('cl-xau', action, bz[action]), { code: 'MARKET_DATA_INVALID' });
      assert.throws(() => store.write('cl-xau', `bz/${action}`, cl[action]), { code: 'MARKET_DATA_INVALID' });
    }
    const database = new DatabaseSync(path);
    try {
      for (const [action, payload] of Object.entries(cl)) database.prepare('UPDATE market_datasets SET payload=? WHERE key=?').run(JSON.stringify(payload), `cl-xau/${action}`);
      const before = database.prepare('SELECT key,payload FROM market_datasets ORDER BY key').all();
      for (const action of ['quote', 'history', 'funding']) {
        const legacy = store.raw('cl-xau', action), other = store.read('cl-xau', `bz/${action}`);
        assert.equal(legacy.oilType, 'cl'); assert.equal(other.oilType, 'bz');
        assert.equal(other.collection.source, 'database'); assert.equal(other.collection.stale, false);
        if (action === 'quote') { assert.equal(legacy.oil.price, 80); assert.equal(other.oil.price, 100); assert.equal(Object.hasOwn(other, 'cl'), false); }
        else { assert.equal(legacy.points[0].oil, legacy.points[0].cl); assert.equal(Object.hasOwn(other.points[0], 'cl'), false); }
      }
      assert.deepEqual(database.prepare('SELECT key,payload FROM market_datasets ORDER BY key').all(), before, 'GET does not migrate or stamp legacy observations');
    } finally { database.close(); }
    store.fail('cl-xau', 'bz/quote', 'BZ outage');
    assert.equal(store.read('cl-xau', 'quote').status, 'live'); assert.equal(store.read('cl-xau', 'bz/quote').status, 'snapshot');
    store.close(); store = await openMarketStore(path, { clock: () => now });
    assert.equal(store.read('cl-xau', 'quote').ratio, 50); assert.equal(store.read('cl-xau', 'bz/quote').ratio, 40);
    assert.equal(store.count('cl-xau', 'history'), 2); assert.equal(store.count('cl-xau', 'bz/history'), 2);
  } finally { store.close(); }
});

test('both collectors share one runtime switch but keep independent identities and schedules', async t => {
  const jobs = marketJobs().filter(job => job.id === 'cl-xau' && !job.action.startsWith('bybit/'));
  assert.deepEqual(jobs.map(job => [job.action, job.intervalMs]), [['quote', 30000], ['history', 60000], ['funding', 300000], ['bz/quote', 30000], ['bz/history', 60000], ['bz/funding', 300000]]);
  const directory = await temporary(t), now = Date.now(), store = await openMarketStore(join(directory, 'market.sqlite'));
  let reads = 0;
  const fixtureJobs = ['cl', 'bz'].map(oilType => ({ id: 'cl-xau', action: oilType === 'cl' ? 'quote' : 'bz/quote', load: async () => { reads++; return snapshots(now, oilType).quote; } }));
  const collector = createMarketCollector(store, { jobs: [] });
  try {
    await Promise.all(fixtureJobs.map(job => collector.collect(job))); assert.equal(reads, 2);
    await collector.pause('cl-xau'); await Promise.all(fixtureJobs.map(job => collector.collect(job))); assert.equal(reads, 2);
    collector.resume('cl-xau'); await Promise.all(fixtureJobs.map(job => collector.collect(job))); assert.equal(reads, 4);
  } finally { await collector.stop(); store.close(); }
});

test('BZ endpoints and tier states stay separate from existing CL settings through refresh, shutdown and restart', async t => {
  const directory = await temporary(t), now = Date.now(), messages = [];
  const database = await openMarketStore(join(directory, 'market.sqlite'));
  for (const oilType of ['cl', 'bz']) for (const [action, data] of Object.entries(snapshots(now, oilType))) database.write('cl-xau', oilType === 'cl' ? action : `bz/${action}`, data);
  database.close();
  let services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] }, notificationOptions: { deliver: async (_config, text) => messages.push(text) } });
  const server = createServer((request, response) => createHandler({ services, username: 'test', password: 'test-password', nextHandler: (_q, reply) => { reply.statusCode = 404; reply.end(); } })(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, endpoint = `${base}/api/monitors/cl-xau/bz/config`;
    const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}`, 'Content-Type': 'application/json', Origin: base };
    const gold = services.get('cl-xau');
    const initial = await readInitialMarket(services); assert.equal(initial['cl-xau'].quote.ratio, 50); assert.equal(initial['cl-xau'].bz.quote.ratio, 40);
    assert.equal(initial['cl-xau'].bz.history.points[0].oil, 100); assert.equal(initial['cl-xau'].bz.funding.points[0].oil, 0.0002);
    assert.equal((await readHubSummary(services, now, 'cl-xau', 'bz')).metrics[0].value, 40);
    const hub = await (await fetch(`${base}/api/hub/summary?monitor=cl-xau&goldOil=bz&schemaVersion=2`, { headers })).json();
    assert.equal(hub.data.metrics[0].label, '金油比 XAU / BZ'); assert.equal(hub.data.metrics[0].value, 40);
    await gold.handle('config', 'PUT', { revision: 0, config: { enabled: true, rules: [rule(50)] } });
    assert.deepEqual((await gold.handle('bz/config', 'GET')).config, { enabled: false, rules: [] });
    const body = JSON.stringify({ revision: 0, config: { enabled: true, rules: [rule(40)] } }), put = { method: 'PUT', headers, body };
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { ...put, headers: { ...headers, Origin: 'https://wrong.invalid' } })).status, 403);
    assert.equal((await fetch(endpoint, { ...put, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(endpoint, put)).status, 200); assert.equal((await fetch(endpoint, put)).status, 409);
    assert.equal((await gold.handle('config', 'GET')).config.rules[0].threshold, 50);
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-only-bz', signingSecret: 'fixture-secret-bz' });
    await gold.start();
    await eventually(async () => (await gold.handle('bz/events', 'GET')).events[0]?.status === 'sent' && (await gold.handle('events', 'GET')).events[0]?.status === 'sent');
    assert.equal(messages.length, 2); assert.ok(messages.some(text => /CL-XAU/.test(text) && /50.0000/.test(text)));
    assert.ok(messages.some(text => /BZ-XAU/.test(text) && /XAUUSDT \/ BZUSDT/.test(text) && /40.0000/.test(text)));
    for (const action of ['status', 'config', 'events', 'quote', 'history', 'funding']) {
      const response = await fetch(`${base}/api/monitors/cl-xau/bz/${action}`, { headers });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = await response.text(); assert.doesNotMatch(text, /fixture-secret-bz|fixture-only-bz/); assert.equal(JSON.parse(text).oilType, 'bz');
    }
    for (const bad of ['bz/runtime', 'bz/test-notification', 'CL/quote', 'bz/bz/quote']) assert.equal((await fetch(`${base}/api/monitors/cl-xau/${bad}`, { headers })).status, 404);
    await gold.handle('runtime', 'PUT', { enabled: false, revision: 0 });
    for (const action of ['quote', 'bz/quote', 'config', 'bz/config']) await assert.rejects(gold.handle(action, 'GET'), { status: 423 });
    await closeServices(services);
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] }, notificationOptions: { deliver: async (_config, text) => messages.push(text) } });
    assert.equal(services.get('cl-xau').runtime().enabled, false);
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: true, revision: 1 });
    await eventually(async () => (await services.get('cl-xau').handle('bz/status', 'GET')).lastSuccessAt);
    assert.equal(messages.length, 2, 'Independent delivered states survive restart');
    for (const [path, threshold] of [['cl-xau', 50], ['cl-xau/bz', 40]]) {
      const saved = JSON.parse(await readFile(join(directory, path, 'monitor.json'), 'utf8'));
      assert.equal(saved.revision, 1); assert.equal(saved.config.rules[0].threshold, threshold); assert.equal(saved.states['same-tier'].alerted, true);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await closeServices(services); }
});

test('BZ delivery validates the same instrument and rechecks its own threshold at send time', () => {
  const now = Date.now(), due = [{ rule: rule(40), value: 40 }];
  assert.equal(createGoldOilAlertDefinition('bz').marketValues(snapshots(now, 'bz').quote, now).ratio, 40);
  assert.throws(() => createGoldOilAlertDefinition('bz').marketValues(snapshots(now).quote, now));
  assert.throws(() => createGoldOilAlertDefinition('cl').marketValues(snapshots(now, 'bz').quote, now));
  confirmGoldOilTriggers(snapshots(now, 'bz').quote, due, now, 'bz');
  assert.throws(() => confirmGoldOilTriggers(snapshots(now).quote, due, now, 'bz'));
  assert.throws(() => confirmGoldOilTriggers(snapshots(now, 'bz', 110).quote, due, now, 'bz'), /离开/);
  assert.throws(() => confirmGoldOilTriggers(snapshots(now - 76000, 'bz').quote, due, now, 'bz'), /过期/);
});

test('pausing the single monitor cancels queued CL and BZ notifications and both quote wakeups', async t => {
  const directory = await temporary(t), delivered = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const services = await createMonitorServices(directory, { env: {},
    marketOptions: { jobs: ['cl', 'bz'].map(oilType => ({ id: 'cl-xau', action: oilType === 'cl' ? 'quote' : 'bz/quote', intervalMs: 30000, load: async () => snapshots(Date.now(), oilType).quote })) },
    notificationOptions: { deliver: async (_config, text) => { delivered.push(text); if (text === 'fixture-blocker') await blocked; } },
  });
  const gold = services.get('cl-xau');
  try {
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-queue-only' });
    for (const [action, threshold] of [['config', 50], ['bz/config', 40]]) await gold.handle(action, 'PUT', { revision: 0, config: { enabled: true, rules: [rule(threshold)] } });
    const blocker = services.notifications.send('fixture-blocker');
    await gold.start(); services.market.start();
    await eventually(async () => (await gold.handle('events', 'GET')).events[0]?.status === 'sending' && (await gold.handle('bz/events', 'GET')).events[0]?.status === 'sending');
    const stopping = gold.handle('runtime', 'PUT', { enabled: false, revision: 0 });
    await eventually(() => !gold.runtime().enabled); release(); await blocker; await stopping;
    assert.deepEqual(delivered, ['fixture-blocker']);
    for (const path of ['cl-xau', 'cl-xau/bz']) {
      const saved = JSON.parse(await readFile(join(directory, path, 'monitor.json'), 'utf8'));
      assert.equal(saved.events[0].status, 'failed'); assert.match(saved.events[0].error, /关闭/); assert.equal(saved.states['same-tier'].alerted, false);
    }
  } finally { release(); await closeServices(services); }
});
