import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Monitor } from '../server/oil/monitor.mjs';
import { FileStore, emptyStore } from '../server/oil/store.mjs';
import { goldOilAlertDefaults, goldOilAlertDefinition, validateGoldOilAlerts, goldOilAlertValues, confirmGoldOilTriggers } from '../server/gold-oil/alerts.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { openMarketStore } from '../server/market-store.mjs';
import { createHandler } from '../server/http.mjs';

const rule = (overrides = {}) => ({ id: 'ratio-50', label: '金油比上沿', metric: 'ratio', operator: 'gte', threshold: 50, cooldownMinutes: 1, hysteresis: 0.5, enabled: true, ...overrides });
const quote = (now, ratio = 50) => ({ source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString(), funding: null, ratio: 999,
  cl: { symbol: 'CLUSDT', price: 80, updatedAt: new Date(now).toISOString() }, xau: { symbol: 'XAUUSDT', price: ratio * 80, updatedAt: new Date(now).toISOString() } });
function fixture({ rules = [rule()], data, write, notify, market, beforeSend } = {}) {
  let now = Date.now(), ratio = 50, running = true, saved;
  const messages = [], store = { async write(value) { await write?.(value); saved = structuredClone(value); } };
  const monitor = new Monitor({ store, data: data ?? { ...emptyStore(goldOilAlertDefaults), config: { enabled: true, rules } }, definition: goldOilAlertDefinition,
    clock: () => now, canRun: () => running, webhookConfigured: true, fetchMarket: async () => market ? market(now) : quote(now, ratio), beforeSend,
    notify: async (text, check) => { await notify?.(); check(); messages.push(text); },
  });
  return { monitor, messages, get saved() { return saved; }, advance(ms) { now += ms; }, ratio(value) { ratio = value; }, pause() { running = false; } };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gold-oil-alerts-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'gold-oil-alerts-')); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('ratio rules have explicit units, positive thresholds, strict identifiers and no pre-enabled alerts', () => {
  assert.deepEqual(goldOilAlertDefaults(), { enabled: false, rules: [] });
  assert.equal(validateGoldOilAlerts({ enabled: true, rules: [rule()] }).rules[0].metric, 'ratio');
  for (const change of [{ threshold: 0 }, { threshold: -1 }, { threshold: NaN }, { threshold: 1e6 + 1 }, { id: '__proto__' }, { id: 'constructor' }, { metric: 'spreadPercent' }, { label: 'fake\nmessage' }, { cooldownMinutes: -1 }, { hysteresis: Infinity }]) assert.throws(() => validateGoldOilAlerts({ enabled: true, rules: [rule(change)] }));
  assert.throws(() => validateGoldOilAlerts({ enabled: true, rules: [rule(), rule({ id: 'copy' })] }), /重复/);
  const now = Date.now(); assert.deepEqual(goldOilAlertValues(quote(now), now), { ratio: 50, xau: 4000, oil: 80 });
  assert.equal(goldOilAlertValues({ ...quote(now), funding: { unavailable: true } }, now).ratio, 50);
});

test('gold/oil batches tiers, rearms beyond the full margin and preserves cooldown across episodes', async () => {
  const f = fixture({ rules: [rule(), rule({ id: 'ratio-49', threshold: 49, hysteresis: 0.5 })] });
  await f.monitor.tick(); assert.equal(f.messages.length, 1); assert.equal(f.saved.events[0].rules.length, 2);
  assert.match(f.messages[0], /金油比阈值告警 · Binance CL-XAU/); assert.match(f.messages[0], /50.0000 ≥ 50 桶\/盎司/);
  assert.match(f.messages[0], /黄金 4000.0000 USDT\/盎司 · 原油 80.0000 USDT\/桶/); assert.doesNotMatch(f.messages[0], /布伦特|百分比价差/);
  f.advance(60000); await f.monitor.tick(); assert.equal(f.messages.length, 1);
  f.ratio(49.5); await f.monitor.tick(); assert.equal(f.saved.states['ratio-50'].active, true);
  f.ratio(49.49); await f.monitor.tick(); assert.equal(f.saved.states['ratio-50'].active, false);
  f.ratio(50); await f.monitor.tick(); assert.equal(f.messages.length, 2); assert.equal(f.saved.events[0].rules.length, 1);
  f.ratio(49); await f.monitor.tick(); f.ratio(50); f.advance(59000); await f.monitor.tick(); assert.equal(f.messages.length, 2);
  f.advance(1000); await f.monitor.tick(); assert.equal(f.messages.length, 3);
  const restarted = fixture({ data: f.saved }); await restarted.monitor.tick(); assert.equal(restarted.messages.length, 0);
});

test('downward equality, zero cooldown and strict recovery also apply to ratio units', async () => {
  const f = fixture({ rules: [rule({ operator: 'lte', threshold: 45, hysteresis: 0, cooldownMinutes: 0 })] });
  f.ratio(45); await f.monitor.tick(); assert.equal(f.messages.length, 1);
  await f.monitor.tick(); assert.equal(f.messages.length, 1);
  f.ratio(45.01); await f.monitor.tick(); f.ratio(45); await f.monitor.tick(); assert.equal(f.messages.length, 2);
});

test('failed delivery retries with stable IDs only while the latest ratio still qualifies', async () => {
  let fail = true;
  const f = fixture({ notify: async () => { if (fail) throw Error('mock failure'); } });
  await f.monitor.tick(); const id = f.saved.states['ratio-50'].eventId;
  assert.equal(f.saved.events[0].status, 'failed'); assert.equal(f.saved.states['ratio-50'].alerted, false);
  fail = false; f.advance(30000); await f.monitor.tick(); assert.equal(f.messages.length, 0);
  f.advance(30000); f.ratio(49.8); await f.monitor.tick(); assert.equal(f.messages.length, 0);
  f.ratio(51); await f.monitor.tick(); assert.equal(f.messages.length, 1); assert.equal(f.saved.states['ratio-50'].eventId, id);
});

test('snapshot, source mismatch, missing legs, expired or asynchronous quotes never send', async () => {
  const bad = [q => ({ ...q, status: 'snapshot' }), q => ({ ...q, collection: { stale: true } }),
    q => ({ ...q, cl: { ...q.cl, symbol: 'BZUSDT' } }), q => ({ ...q, xau: null }),
    (q, now) => quote(now - 75001), (q, now) => quote(now + 2000),
    (q, now) => ({ ...q, xau: { ...q.xau, updatedAt: new Date(now - 16000).toISOString() } })];
  for (const change of bad) { const f = fixture({ market: now => change(quote(now), now) }); await f.monitor.tick(); assert.equal(f.messages.length, 0); assert.ok(f.monitor.status().error); }
});

test('notification queue rechecks freshness, running switch and latest threshold before external I/O', async () => {
  let f = fixture({ notify: async () => f.advance(75001) });
  await f.monitor.tick(); assert.equal(f.messages.length, 0); assert.equal(f.saved.events[0].status, 'failed');
  f = fixture({ notify: async () => f.pause() });
  await f.monitor.tick(); assert.equal(f.messages.length, 0); assert.match(f.saved.events[0].error, /关闭/);
  const now = Date.now();
  f = fixture({ beforeSend: (_market, due) => confirmGoldOilTriggers(quote(now, 49.9), due, now) });
  await f.monitor.tick(); assert.equal(f.messages.length, 0); assert.match(f.saved.events[0].error, /离开触发阈值/);
});

test('storage failure blocks sending, and domain stores preserve state and reject oil rules', async t => {
  const f = fixture({ write: async () => { throw Error('disk full'); } });
  await assert.rejects(f.monitor.tick(), /写入失败/); assert.equal(f.messages.length, 0);
  const directory = await temporary(t), options = { defaults: goldOilAlertDefaults, validate: validateGoldOilAlerts };
  let store = new FileStore(directory, false, options); await store.acquire();
  try {
    assert.deepEqual((await store.read()).config, goldOilAlertDefaults());
    const good = fixture(); await good.monitor.tick(); await store.write(good.saved);
  } finally { await store.release(); }
  store = new FileStore(directory, false, options); await store.acquire();
  try {
    assert.equal((await store.read()).states['ratio-50'].alerted, true);
    const data = await store.read(); data.config.rules[0].metric = 'spread'; await store.write(data);
    await assert.rejects(store.read(), /监控指标/);
  } finally { await store.release(); }
});

test('resident ratio alerts use shared credentials, protected independent config and persisted shutdown controls', async t => {
  const directory = await temporary(t), messages = [], now = Date.now();
  const database = await openMarketStore(join(directory, 'market.sqlite'));
  database.write('cl-xau', 'quote', quote(now)); database.close();
  let services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] }, notificationOptions: { deliver: async (_config, text) => messages.push(text) } });
  const close = async () => { await Promise.all([...services.values()].map(service => service.stop())); await services.notifications.stop(); await services.market.stop(); };
  const server = createServer(createHandler({ services, username: 'admin', password: 'test-password', nextHandler: (_q, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, path = '/api/monitors/cl-xau/config';
    const headers = { Authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}`, 'Content-Type': 'application/json', Origin: base };
    const input = { revision: 0, config: { enabled: true, rules: [rule()] } }, put = { method: 'PUT', headers, body: JSON.stringify(input) };
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { ...put, headers: { ...headers, Origin: 'https://wrong.invalid' } })).status, 403);
    assert.equal((await fetch(base + path, { ...put, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(base + path, { ...put, body: JSON.stringify({ ...input, config: { enabled: true, rules: [rule({ id: '__proto__' })] } }) })).status, 400);
    assert.equal((await fetch(base + path, put)).status, 200);
    assert.equal((await fetch(base + path, put)).status, 409);
    assert.equal((await services.get('oil').handle('config', 'GET')).revision, 0);
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-gold', signingSecret: 'test-gold-secret' });
    await services.get('cl-xau').start();
    for (let i = 0; i < 100 && !(await services.get('cl-xau').handle('events', 'GET')).events.some(event => event.status === 'sent'); i++) await delay(10);
    assert.equal(messages.length, 1); assert.match(messages[0], /金油比阈值告警/);
    for (const action of ['status', 'config', 'events']) {
      const response = await fetch(`${base}/api/monitors/cl-xau/${action}`, { headers });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await response.text(), /test-gold-secret|test-only-gold/);
    }
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: false, revision: 0 });
    assert.equal((await fetch(base + path, { headers })).status, 423);
    assert.equal(services.get('oil').runtime().enabled, true);
    const saved = JSON.parse(await readFile(join(directory, 'cl-xau', 'monitor.json'), 'utf8'));
    assert.equal(saved.revision, 1); assert.equal(saved.states['ratio-50'].alerted, true);
    await close();
    await assert.rejects(access(join(directory, 'cl-xau', 'monitor.lock')), { code: 'ENOENT' });
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] }, notificationOptions: { deliver: async (_config, text) => messages.push(text) } });
    assert.equal(services.get('cl-xau').runtime().enabled, false);
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: true, revision: 1 });
    await delay(30); assert.equal(messages.length, 1, 'Restart does not duplicate a delivered threshold episode');
    assert.equal((await services.get('cl-xau').handle('config', 'GET')).revision, 1);
  } finally { await new Promise(accept => server.close(accept)); await close(); }
});

test('startup failure releases both module locks without replacing corrupt ratio configuration', async t => {
  const directory = await temporary(t), store = new FileStore(join(directory, 'cl-xau'));
  await store.acquire(); await store.release();
  const file = join(directory, 'cl-xau', 'monitor.json'); await writeFile(file, 'corrupt');
  await assert.rejects(createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } }));
  assert.equal(await readFile(file, 'utf8'), 'corrupt');
  for (const id of ['oil', 'cl-xau']) await assert.rejects(access(join(directory, id, 'monitor.lock')), { code: 'ENOENT' });
});

test('collector wakes ratio alerts without a page, and runtime pause cancels delivery in the shared queue', async t => {
  const directory = await temporary(t), delivered = [];
  let release;
  const blocked = new Promise(accept => { release = accept; });
  const services = await createMonitorServices(directory, { env: {},
    marketOptions: { jobs: [{ id: 'cl-xau', action: 'quote', intervalMs: 30000, load: async () => quote(Date.now()) }] },
    notificationOptions: { deliver: async (_config, text) => { delivered.push(text); if (text === 'mock-blocker') await blocked; } },
  });
  const gold = services.get('cl-xau');
  try {
    await services.notifications.update({ revision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-queue' });
    await gold.handle('config', 'PUT', { revision: 0, config: { enabled: true, rules: [rule()] } });
    const blocker = services.notifications.send('mock-blocker');
    await gold.start(); services.market.start();
    let waiting;
    for (let i = 0; i < 100; i++) {
      waiting = (await gold.handle('events', 'GET')).events[0];
      if (waiting?.status === 'sending') break;
      await delay(10);
    }
    assert.equal(waiting?.status, 'sending', 'Committed quote immediately wakes the alert service');
    const stopping = gold.handle('runtime', 'PUT', { enabled: false, revision: 0 });
    for (let i = 0; i < 100 && gold.runtime().enabled; i++) await delay(10);
    assert.equal(gold.runtime().enabled, false);
    release(); await blocker; await stopping;
    assert.deepEqual(delivered, ['mock-blocker']);
    const saved = JSON.parse(await readFile(join(directory, 'cl-xau', 'monitor.json'), 'utf8'));
    assert.equal(saved.events[0].status, 'failed'); assert.match(saved.events[0].error, /关闭/);
    assert.equal(saved.states['ratio-50'].alerted, false);
  } finally {
    release(); await Promise.all([...services.values()].map(service => service.stop())); await services.notifications.stop(); await services.market.stop();
  }
});
