import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openMarketStore } from '../server/market-store.mjs';
import { marketJobs } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createHandler } from '../server/http.mjs';
import { FileStore } from '../server/oil/store.mjs';
import { createGoldOilAlertDefinition, confirmGoldOilTriggers } from '../server/gold-oil/alerts.mjs';
import { GOLD_OIL_VARIANTS, GOLD_OIL_EXCHANGES, goldOilAction } from '../lib/gold-oil.ts';

const rule = threshold => ({ id: 'shared-id', label: '独立上沿', metric: 'ratio', operator: 'gte', threshold, cooldownMinutes: 1, hysteresis: 0.5, enabled: true });
function snapshot(now, { oilType, exchange }, offset = 0) {
  const ratio = (exchange === 'bybit' ? 60 : 40) + (oilType === 'bz' ? 5 : 0) + offset;
  const fetchedAt = new Date(now).toISOString(), oil = { symbol: oilType === 'bz' ? 'BZUSDT' : 'CLUSDT', price: 100, updatedAt: fetchedAt };
  const base = { oilType, source: GOLD_OIL_EXCHANGES[exchange].name, fetchedAt, status: 'live', currency: 'USDT', priceBasis: 'mark' };
  const end = Math.floor(now / 900000) * 900000, start = end - 1800000;
  return {
    quote: { ...base, oil, xau: { symbol: 'XAUUSDT', price: ratio * 100, updatedAt: fetchedAt }, ratio, funding: null },
    history: { ...base, interval: '15m', coverageStart: start, points: [start, start + 900000].map(time => ({ time, oil: oil.price, xau: ratio * 100, ratio })) },
    funding: { oilType, source: base.source, fetchedAt, status: 'live', coverageStart: start, coverageEnd: end, points: [{ time: start, oil: ratio / 1e6, xau: 0.0001 }] },
  };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gold-oil-bybit-runtime-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'gold-oil-bybit-runtime-')); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function closeServices(services) { await Promise.all([...services.values()].map(service => service.stop())); await services.notifications.stop(); await services.market.stop(); }
async function eventually(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); } assert.fail('Expected state was not reached'); }
const pathFor = ({ oilType, exchange }) => ['cl-xau', ...(exchange === 'bybit' ? ['bybit'] : []), ...(oilType === 'bz' ? ['bz'] : [])];

test('Bybit alert files require their own source while legacy Binance files retain compatibility', async t => {
  const directory = await temporary(t), store = new FileStore(join(directory, 'bybit'), false, { marketSource: 'bybit' });
  await store.acquire();
  try {
    const data = await store.read(); assert.equal(data.marketSource, 'bybit');
    await store.write({ ...data, marketSource: 'binance' }); await assert.rejects(store.read(), /交易所不匹配/);
    const legacy = { ...data }; delete legacy.marketSource;
    await store.write(legacy); await assert.rejects(store.read(), /交易所不匹配/);
    const binance = new FileStore(join(directory, 'bybit'), true, { marketSource: 'binance' });
    assert.equal((await binance.read()).revision, 0);
  } finally { await store.release(); }
});

test('four combinations persist separately and reject every cross-source or cross-oil write', async t => {
  const directory = await temporary(t), now = Date.now(), filename = join(directory, 'market.sqlite');
  let store = await openMarketStore(filename);
  try {
    for (const variant of GOLD_OIL_VARIANTS) for (const action of ['quote', 'history', 'funding']) {
      const route = goldOilAction(action, variant.oilType, variant.exchange), expected = snapshot(now, variant)[action];
      store.write('cl-xau', route, expected);
      for (const other of GOLD_OIL_VARIANTS.filter(item => item !== variant)) assert.throws(() => store.write('cl-xau', route, snapshot(now, other)[action]), { code: 'MARKET_DATA_INVALID' });
      assert.equal(store.read('cl-xau', route).source, expected.source);
    }
    store.fail('cl-xau', 'bybit/bz/quote', 'Bybit BZ unavailable');
    assert.equal(store.read('cl-xau', 'bybit/bz/quote').status, 'snapshot');
    for (const route of ['quote', 'bz/quote', 'bybit/quote']) assert.equal(store.read('cl-xau', route).status, 'live');
    store.close(); store = await openMarketStore(filename);
    for (const variant of GOLD_OIL_VARIANTS) {
      const route = goldOilAction('quote', variant.oilType, variant.exchange);
      assert.equal(store.read('cl-xau', route).ratio, snapshot(now, variant).quote.ratio);
      assert.equal(store.count('cl-xau', goldOilAction('history', variant.oilType, variant.exchange)), 2);
    }
  } finally { store.close(); }
});

test('Bybit native API, SSR, summaries and four alert configurations preserve identity through restart', async t => {
  const directory = await temporary(t), now = Date.now(), messages = [];
  const store = await openMarketStore(join(directory, 'market.sqlite'));
  for (const variant of GOLD_OIL_VARIANTS) for (const [action, value] of Object.entries(snapshot(now, variant))) store.write('cl-xau', goldOilAction(action, variant.oilType, variant.exchange), value);
  store.close();
  const options = { env: {}, marketOptions: { jobs: [] }, notificationOptions: { deliver: async (_config, text) => messages.push(text) } };
  let services = await createMonitorServices(directory, options);
  const server = createServer((req, res) => createHandler({ services, username: 'fixture', password: 'fixture-password', nextHandler: (_req, response) => { response.statusCode = 404; response.end(); } })(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`, Origin: base, 'Content-Type': 'application/json' };
    const initial = await readInitialMarket(services);
    assert.equal(initial['cl-xau'].quote.ratio, 40); assert.equal(initial['cl-xau'].bz.quote.ratio, 45);
    assert.equal(initial['cl-xau'].bybit.quote.ratio, 60); assert.equal(initial['cl-xau'].bybit.bz.quote.ratio, 65);
    for (const variant of GOLD_OIL_VARIANTS) {
      const { oilType, exchange } = variant, ratio = snapshot(now, variant).quote.ratio;
      const summary = await readHubSummary(services, now, 'cl-xau', oilType, exchange);
      assert.equal(summary.metrics[0].value, ratio); assert.match(summary.health.message, new RegExp(GOLD_OIL_EXCHANGES[exchange].name));
      const action = goldOilAction('config', oilType, exchange), url = `${base}/api/monitors/cl-xau/${action}`;
      const body = JSON.stringify({ revision: 0, config: { enabled: true, rules: [rule(ratio)] } });
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, Origin: 'https://wrong.invalid' }, body })).status, 403);
      assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body })).status, 415);
      const response = await fetch(url, { method: 'PUT', headers, body }); assert.equal(response.status, 200);
      assert.equal((await response.json()).exchange, exchange);
      assert.equal((await fetch(url, { method: 'PUT', headers, body })).status, 409);
    }
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/bybit-fixture-only', signingSecret: 'not-a-real-secret' });
    await services.get('cl-xau').start();
    await eventually(() => messages.length === 4);
    for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
      const source = GOLD_OIL_EXCHANGES[exchange].name;
      const message = messages.find(text => text.includes(`${source} ${oilType.toUpperCase()}-XAU`));
      assert.ok(message);
      if (exchange === 'bybit' && oilType === 'bz') { assert.match(message, /报价比/); assert.match(message, /USDT\/BZ/); assert.doesNotMatch(message, /桶\/盎司|USDT\/桶/); }
      for (const action of ['quote', 'history', 'funding', 'status', 'config', 'events']) {
        const response = await fetch(`${base}/api/monitors/cl-xau/${goldOilAction(action, oilType, exchange)}`, { headers }); assert.equal(response.status, 200);
        const text = await response.text(), result = JSON.parse(text); assert.doesNotMatch(text, /not-a-real-secret|bybit-fixture-only/);
        assert.equal(result.source, source); assert.equal(result.oilType, oilType);
      }
    }
    const hub = await (await fetch(`${base}/api/hub/summary?monitor=cl-xau&goldOil=bz&goldOilExchange=bybit&schemaVersion=2`, { headers })).json();
    assert.equal(hub.data.metrics[0].value, 65); assert.match(hub.data.health.message, /Bybit/);
    await assert.rejects(readHubSummary(services, now, 'cl-xau', 'bz', 'unknown'), /交易所/);
    for (const action of ['bybit/runtime', 'bybit/test-notification', 'bybit/bybit/quote', 'bybit/cl/quote', 'bybit/bz/config/more']) assert.equal((await fetch(`${base}/api/monitors/cl-xau/${action}`, { headers })).status, 404);
    await services.get('cl-xau').handle('runtime', 'PUT', { revision: 0, enabled: false });
    for (const { oilType, exchange } of GOLD_OIL_VARIANTS) await assert.rejects(services.get('cl-xau').handle(goldOilAction('quote', oilType, exchange), 'GET'), { status: 423 });
    await closeServices(services); services = await createMonitorServices(directory, options);
    assert.equal(services.get('cl-xau').runtime().enabled, false);
    await services.get('cl-xau').handle('runtime', 'PUT', { revision: 1, enabled: true });
    await eventually(async () => (await services.get('cl-xau').handle('bybit/bz/status', 'GET')).lastSuccessAt);
    assert.equal(messages.length, 4, 'Delivered state must survive separately without duplicate notifications');
    for (const variant of GOLD_OIL_VARIANTS) {
      const saved = JSON.parse(await readFile(join(directory, ...pathFor(variant), 'monitor.json'), 'utf8'));
      assert.equal(saved.revision, 1); assert.equal(saved.config.rules[0].threshold, snapshot(now, variant).quote.ratio); assert.equal(saved.states['shared-id'].alerted, true);
      assert.equal(saved.marketSource, variant.exchange); assert.equal(saved.events[0].source, variant.exchange);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await closeServices(services); }
});

test('send-time checks bind both source and oil and recheck freshness and threshold', () => {
  const now = Date.now();
  for (const variant of GOLD_OIL_VARIANTS) {
    const { oilType, exchange } = variant, quote = snapshot(now, variant).quote, due = [{ rule: rule(quote.ratio), value: quote.ratio }];
    assert.equal(createGoldOilAlertDefinition(oilType, exchange).marketValues(quote, now).ratio, quote.ratio);
    confirmGoldOilTriggers(quote, due, now, oilType, exchange);
    for (const other of GOLD_OIL_VARIANTS.filter(item => item !== variant)) assert.throws(() => confirmGoldOilTriggers(snapshot(now, other).quote, due, now, oilType, exchange));
    assert.throws(() => confirmGoldOilTriggers(snapshot(now - 76000, variant).quote, due, now, oilType, exchange), /过期/);
    assert.throws(() => confirmGoldOilTriggers(snapshot(now, variant, -1).quote, due, now, oilType, exchange), /离开/);
  }
});

test('one runtime pause stops all four collectors and cancels queued notifications', async t => {
  const jobs = marketJobs().filter(job => job.id === 'cl-xau');
  assert.equal(jobs.length, 12);
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) for (const [action, interval] of [['quote', 30000], ['history', 60000], ['funding', 300000]]) assert.equal(jobs.find(job => job.action === goldOilAction(action, oilType, exchange)).intervalMs, interval);
  const directory = await temporary(t), delivered = [];
  let release, reads = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const services = await createMonitorServices(directory, { env: {},
    marketOptions: { jobs: GOLD_OIL_VARIANTS.map(variant => ({ id: 'cl-xau', action: goldOilAction('quote', variant.oilType, variant.exchange), intervalMs: 30000, load: async () => { reads++; return snapshot(Date.now(), variant).quote; } })) },
    notificationOptions: { deliver: async (_config, text) => { delivered.push(text); if (text === 'fixture-blocker') await blocked; } },
  });
  const gold = services.get('cl-xau');
  try {
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/bybit-queue-fixture' });
    for (const variant of GOLD_OIL_VARIANTS) await gold.handle(goldOilAction('config', variant.oilType, variant.exchange), 'PUT', { revision: 0, config: { enabled: true, rules: [rule(snapshot(Date.now(), variant).quote.ratio)] } });
    const blocker = services.notifications.send('fixture-blocker'); await gold.start(); services.market.start();
    await eventually(async () => (await Promise.all(GOLD_OIL_VARIANTS.map(async ({ oilType, exchange }) => (await gold.handle(goldOilAction('events', oilType, exchange), 'GET')).events[0]?.status))).every(status => status === 'sending'));
    assert.equal(reads, 4);
    const stopping = gold.handle('runtime', 'PUT', { revision: 0, enabled: false }); await eventually(() => !gold.runtime().enabled);
    release(); await blocker; await stopping;
    assert.deepEqual(delivered, ['fixture-blocker']);
    for (const variant of GOLD_OIL_VARIANTS) {
      const saved = JSON.parse(await readFile(join(directory, ...pathFor(variant), 'monitor.json'), 'utf8'));
      assert.equal(saved.events[0].status, 'failed'); assert.match(saved.events[0].error, /关闭/); assert.equal(saved.states['shared-id'].alerted, false);
    }
  } finally { release(); await closeServices(services); }
});
