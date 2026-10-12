import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openMonitorControlStore, attachMonitorControl } from '../server/monitor-control.mjs';
import { createMarketCollector } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); } assert.fail('Condition did not become true'); }
const fresh = () => ({ version: 1, monitors: Object.fromEntries(['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => [id, { enabled: true, revision: 0 }])) });
const change = (services, id, enabled) => services.get(id).handle('runtime', 'PUT', { enabled, revision: services.get(id).runtime().revision });
const shutdown = async services => { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); };

test('module switches default on, persist independently and reject corrupt saved state without overwriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-controls-'));
  try {
    const store = await openMonitorControlStore(directory);
    assert.deepEqual(store.get(), fresh());
    const next = store.get(); next.monitors.oil = { enabled: false, revision: 1 }; await store.save(next);
    assert.deepEqual((await openMonitorControlStore(directory)).get(), next);
    const file = join(directory, 'monitor-control.json');
    await writeFile(file, 'broken');
    await assert.rejects(openMonitorControlStore(directory), /monitor-control.json/);
    assert.equal(await readFile(file, 'utf8'), 'broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('writes serialize per-module revisions, reject invalid input and do not stop a service when persistence fails', async () => {
  let state = fresh(), fail = false;
  const stopped = [], started = [];
  const services = attachMonitorControl(new Map(['oil', 'hynix', 'perpetual'].map(id => [id, { actions: { quote: ['GET'] }, start() { started.push(id); }, stop() { stopped.push(id); }, handle() { return id; } }])), {
    get: () => structuredClone(state), save: async next => { if (fail) throw Error('disk full'); state = next; },
  });
  fail = true; await assert.rejects(change(services, 'oil', false), /disk full/);
  assert.equal(services.get('oil').runtime().enabled, true); assert.deepEqual(stopped, []);
  fail = false;
  for (const input of [{ enabled: 'false', revision: 0 }, { enabled: false }, { enabled: false, revision: -1 }, { enabled: false, revision: 0, extra: true }]) await assert.rejects(services.get('oil').handle('runtime', 'PUT', input));
  const writes = await Promise.allSettled([change(services, 'oil', false), change(services, 'oil', false), change(services, 'hynix', false)]);
  assert.equal(writes[0].status, 'fulfilled'); assert.equal(writes[1].reason.status, 409); assert.equal(writes[2].status, 'fulfilled');
  assert.deepEqual(stopped, ['oil', 'hynix']);
  await assert.rejects(services.get('oil').handle('quote', 'GET'), { status: 423 });
  assert.equal(await services.get('perpetual').handle('quote', 'GET'), 'perpetual');
  await change(services, 'oil', true); assert.deepEqual(started, ['oil']);
  await change(services, 'oil', true); assert.deepEqual(started, ['oil']);
});

test('pausing one collector cancels its timers and late results without affecting another market; resuming collects once', async () => {
  const tasks = new Map(), reads = [], writes = [], alerts = []; let sequence = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = ['oil', 'hynix'].map(id => ({ id, action: 'quote', intervalMs: 10_000, load: async () => { reads.push(id); return id === 'oil' && reads.filter(x => x === 'oil').length === 1 ? gate : {}; } }));
  const collector = createMarketCollector({ raw() {}, write(id) { writes.push(id); }, fail() {} }, { jobs, onStored: job => alerts.push(job.id), timers: { setTimeout(fn) { tasks.set(++sequence, fn); return sequence; }, clearTimeout(id) { tasks.delete(id); } } });
  try {
    collector.start(); await flush();
    const pause = collector.pause('oil'); release({}); await pause; await flush();
    assert.deepEqual(writes, ['hynix']); assert.deepEqual(alerts, ['hynix']); assert.equal(tasks.size, 1);
    assert.equal(await collector.collect(jobs[0]), false);
    collector.resume('oil'); collector.resume('oil'); await flush();
    assert.equal(reads.filter(id => id === 'oil').length, 2); assert.equal(tasks.size, 2);
    await collector.pause('oil'); assert.equal(tasks.size, 1);
    for (const fn of tasks.values()) { void fn(); break; } await flush();
    assert.equal(reads.filter(id => id === 'hynix').length, 2);
  } finally { release({}); await collector.stop(); }
});

test('resident switches close streams and sockets, reopen durable perpetual storage, restore Hynix checks and survive process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-runtime-'));
  const sockets = []; let hynixChecks = 0, services, server;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const options = { env: {}, marketOptions: { jobs: [] }, hynixOptions: { getQuote: async () => { hynixChecks++; throw Error('fixture'); } }, perpetualOptions: {
    exchanges: [{ id: 'test', name: 'Test', kind: 'cex' }], discover: async () => [{ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT' }],
    subscriptions: (_id, markets) => [{ url: 'wss://example.invalid', markets, subscribe: [] }], parse: (_id, value) => value, control: () => null,
    WebSocketImpl: Socket, broadcastIntervalMs: 10, qualityOptions: { fundamentals: { refresh: async () => {} } },
  } };
  try {
    services = await createMonitorServices(directory, options); services.market.start();
    for (const service of services.values()) await service.start();
    await until(() => sockets.length === 1 && hynixChecks === 1);
    const headers = { Authorization: `Basic ${Buffer.from('admin:fixture-password').toString('base64')}`, 'Content-Type': 'application/json' };
    let fallbacks = 0;
    server = createServer(createHandler({ services, username: 'admin', password: 'fixture-password', nextHandler: (_q, r) => { fallbacks++; r.end('fallback'); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, url = `${base}/api/monitors/oil/runtime`;
    const put = { method: 'PUT', headers, body: JSON.stringify({ enabled: false, revision: 0 }) };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { ...put, headers: { ...headers, Origin: 'https://wrong.invalid' } })).status, 403);
    assert.equal((await fetch(url, { ...put, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(url, put)).status, 200);
    assert.equal((await fetch(url, put)).status, 409);
    assert.equal((await fetch(`${base}/api/monitors/oil/quote`, { headers })).status, 423);
    assert.equal((await fetch(`${base}/api/monitors/oil/not-real`, { headers })).status, 404); assert.equal(fallbacks, 0);
    const listing = await (await fetch(`${base}/api/monitors`, { headers })).json();
    assert.equal(listing.monitors.find(m => m.id === 'oil').runtime.enabled, false);
    assert.match((await readHubSummary(services)).health.message, /已关闭/);
    assert.equal((await readInitialMarket(services)).runtime.oil.enabled, false);
    await change(services, 'hynix', false); await change(services, 'hynix', true);
    await until(() => hynixChecks === 2);
    for (let cycle = 0; cycle < 2; cycle++) {
      const socket = sockets.at(-1); socket.open();
      const at = Date.now(); socket.message([{ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100 + cycle, ask: 102 + cycle, sourceTime: at }]);
      const stream = await fetch(`${base}/api/monitors/perpetual/stream`, { headers });
      const reader = stream.body.getReader(); await reader.read();
      await change(services, 'perpetual', false);
      while (!(await reader.read()).done) { /* Drain frames written before close. */ }
      assert.equal(socket.readyState, 3);
      assert.equal((await fetch(`${base}/api/monitors/perpetual/stream`, { headers })).status, 423);
      await change(services, 'perpetual', true);
      await until(() => sockets.length === cycle + 2);
      const quote = await services.get('perpetual').handle('quote', 'GET');
      assert.equal(quote.quotes[0].bid, 100 + cycle, 'Fresh service restores saved prices without deleting history');
    }
    await change(services, 'perpetual', false); await change(services, 'hynix', false); await change(services, 'cl-xau', false);
    await new Promise(resolve => server.close(resolve)); server = null;
    await shutdown(services); services = null;
    const previousSockets = sockets.length, previousChecks = hynixChecks;
    services = await createMonitorServices(directory, options); services.market.start();
    for (const service of services.values()) await service.start();
    await delay(25);
    assert.equal(sockets.length, previousSockets); assert.equal(hynixChecks, previousChecks);
    for (const runtime of Object.values(services.controls.view())) { assert.equal(runtime.enabled, false); assert.equal(runtime.running, false); }
    await change(services, 'perpetual', true); await until(() => sockets.length === previousSockets + 1);
    assert.equal((await services.get('perpetual').handle('quote', 'GET')).quotes[0].bid, 101);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (services) await shutdown(services);
    await rm(directory, { recursive: true, force: true });
  }
});
