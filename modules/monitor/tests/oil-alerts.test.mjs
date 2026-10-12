import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, evaluateRule, marketValues, validateConfig } from '../server/oil/config.mjs';
import { createFeishuPayload, createNotifier, validateWebhook } from '../server/oil/feishu.mjs';
import { Monitor } from '../server/oil/monitor.mjs';
import { FileStore, emptyStore } from '../server/oil/store.mjs';


const rule = (overrides = {}) => ({ id: 'test-rule', label: '价差一级', metric: 'spread', operator: 'gte', threshold: 5, cooldownMinutes: 30, hysteresis: 0.2, enabled: true, ...overrides });
function fixture({ rules = [rule()], data, send, write, fetcher } = {}) {
  let now = Date.UTC(2026, 8, 11), prices = [85, 80], persisted;
  const messages = [];
  const store = { async write(value) { if (write) await write(value); persisted = structuredClone(value); } };
  const monitor = new Monitor({ store, data: data || { ...emptyStore(), config: { enabled: true, rules } }, webhookConfigured: true,
    clock: () => now, fetchMarket: fetcher || (async () => ({ fetchedAt: new Date(now).toISOString(), brent: { markPx: prices[0] }, wti: { markPx: prices[1] } })),
    notify: async message => { messages.push(message); if (send) await send(message); } });
  return { monitor, messages, get persisted() { return persisted; }, advance(ms) { now += ms; }, prices(brent, wti = 80) { prices = [brent, wti]; } };
}

test('configuration validates all gradients and rejects malformed numeric values and duplicate triggers', () => {
  assert.equal(defaultConfig().enabled, false);
  assert.equal(validateConfig({ enabled: true, rules: [rule(), rule({ id: 'wti-low', metric: 'wti', operator: 'lte', threshold: 80 })] }).rules.length, 2);
  for (const override of [{ threshold: '' }, { threshold: NaN }, { cooldownMinutes: -1 }, { hysteresis: -1 }, { metric: 'funding' }, { metric: 'brent', threshold: 0 }, { id: '__proto__' }]) {
    assert.throws(() => validateConfig({ enabled: true, rules: [rule(override)] }));
  }
  assert.throws(() => validateConfig({ enabled: true, rules: [rule(), rule({ id: 'copy' })] }), /重复/);
  assert.equal(validateConfig({ enabled: true, rules: [rule({ threshold: -2 })] }).rules[0].threshold, -2);
});

test('percentage alerts use percentage-point hysteresis while legacy amount rules keep their meaning', async () => {
  assert.ok(defaultConfig().rules.every(item => item.metric === 'spreadPercent' && item.label.endsWith('%')));
  const percentage = rule({ id: 'percent', metric: 'spreadPercent', threshold: 5, hysteresis: 0.1, cooldownMinutes: 0 });
  const legacy = rule({ id: 'amount', threshold: 5 });
  assert.equal(validateConfig({ enabled: true, rules: [percentage, legacy] }).rules.length, 2);
  assert.equal(validateConfig({ enabled: true, rules: [{ ...percentage, threshold: -5 }] }).rules[0].threshold, -5);
  const f = fixture({ rules: [percentage, legacy] });
  f.prices(42, 40); await f.monitor.tick();
  assert.equal(f.persisted.events[0].rules.length, 1);
  assert.equal(f.persisted.events[0].rules[0].metric, 'spreadPercent');
  assert.equal(f.persisted.events[0].rules[0].value, 5);
  assert.match(f.messages[0], /≥ 5 %/);
  assert.match(f.messages[0], /价差 5.0000%/);
  f.prices(41.96, 40); await f.monitor.tick();
  assert.equal(f.monitor.data.states.percent.active, true, 'Equality at 4.9% does not rearm');
  f.prices(41.95, 40); await f.monitor.tick();
  assert.equal(f.monitor.data.states.percent.active, false);
  f.prices(84, 80); await f.monitor.tick();
  assert.equal(f.messages.length, 2);
  const restart = fixture({ data: f.persisted }); restart.prices(84, 80); await restart.monitor.tick();
  assert.equal(restart.messages.length, 0);
  const exact = marketValues({ fetchedAt: new Date(0).toISOString(), brent: { markPx: 75.3 }, wti: { markPx: 75 } }, 0);
  assert.equal(evaluateRule({ ...percentage, threshold: 0.4 }, {}, exact.spreadPercent, 0).shouldSend, true);
});

test('upward equality triggers; hysteresis requires crossing the complete reset margin', () => {
  const r = rule({ cooldownMinutes: 0 });
  let result = evaluateRule(r, {}, 5, 1000); assert.equal(result.shouldSend, true);
  let state = { ...result.state, alerted: true, lastSentAt: 1000 };
  for (const price of [5.5, 4.9, 4.8, 5.1]) { result = evaluateRule(r, state, price, 2000); assert.equal(result.shouldSend, false); state = result.state; }
  result = evaluateRule(r, state, 4.79, 3000); assert.equal(result.state.active, false);
  assert.equal(evaluateRule(r, result.state, 5, 4000).shouldSend, true);
});

test('downward and negative thresholds, zero hysteresis, and inclusive equality work', () => {
  const r = rule({ operator: 'lte', threshold: -2, hysteresis: 0, cooldownMinutes: 0 });
  let result = evaluateRule(r, {}, -2, 1000); assert.equal(result.shouldSend, true);
  result = evaluateRule(r, { ...result.state, alerted: true }, -2, 2000); assert.equal(result.state.active, true);
  result = evaluateRule(r, result.state, -1.999, 3000); assert.equal(result.state.active, false);
  assert.equal(evaluateRule(r, result.state, -2.1, 4000).shouldSend, true);
});

test('cooldown spans separate episodes and a pending episode sends after cooldown', () => {
  const r = rule({ cooldownMinutes: 1 });
  let state = { ...evaluateRule(r, {}, 5, 1000).state, alerted: true, lastSentAt: 1000 };
  state = evaluateRule(r, state, 4, 2000).state;
  let result = evaluateRule(r, state, 6, 30_000); assert.equal(result.shouldSend, false);
  assert.equal(evaluateRule(r, result.state, 6, 61_000).shouldSend, true);
});

test('market freshness and finite positive marks are required; spread is Brent minus WTI', () => {
  const now = Date.UTC(2026, 8, 11), market = { fetchedAt: new Date(now).toISOString(), brent: { markPx: 81 }, wti: { markPx: 83 } };
  assert.deepEqual(marketValues(market, now), { brent: 81, wti: 83, spread: -2, spreadPercent: -2 / 83 * 100 });
  assert.throws(() => marketValues(market, now + 90_001), /过期/);
  assert.throws(() => marketValues({ ...market, wti: { markPx: null } }, now), /无效/);
  assert.throws(() => marketValues({ ...market, fetchedAt: new Date(now + 6000).toISOString() }, now), /过期/);
});

test('Feishu signing uses timestamp-newline-secret as key and an EMPTY message', () => {
  const now = 1_600_000_000_999, secret = 'example-signature-key';
  const payload = createFeishuPayload('原油阈值告警', secret, now);
  assert.equal(payload.timestamp, '1600000000');
  assert.equal(payload.sign, createHmac('sha256', '1600000000\nexample-signature-key').update('').digest('base64'));
  assert.notEqual(payload.sign, createHmac('sha256', secret).update(payload.timestamp).digest('base64'));
  assert.deepEqual(createFeishuPayload('test'), { msg_type: 'text', content: { text: 'test' } });
});

test('decimal price subtraction and hysteresis equality do not miss or prematurely rearm alerts', () => {
  const now = Date.UTC(2026, 8, 11), market = { fetchedAt: new Date(now).toISOString(), brent: { markPx: 75.3 }, wti: { markPx: 75 } };
  const values = marketValues(market, now);
  assert.equal(values.spread, 0.3);
  assert.equal(evaluateRule(rule({ threshold: 0.3 }), {}, values.spread, now).shouldSend, true);
  for (const [brent, wti, spread] of [[32.001, 32, 0.001], [32, 32.001, -0.001], [1.000001e-7, 1e-7, 1e-13], [1e21, 9e20, 1e20]]) {
    const exact = marketValues({ ...market, brent: { markPx: brent }, wti: { markPx: wti } }, now);
    assert.equal(exact.spread, spread);
    assert.equal(evaluateRule(rule({ threshold: spread }), {}, exact.spread, now).shouldSend, true);
  }
  assert.equal(evaluateRule(rule({ operator: 'lte', threshold: 0.3, hysteresis: 0.6 }), { active: true, alerted: true }, 0.9, now).state.active, true);
});

test('paused monitor still observes recovery while suppressing delivery, then rearms on resume', async () => {
  const f = fixture({ rules: [rule({ cooldownMinutes: 0 })] });
  await f.monitor.tick(); assert.equal(f.messages.length, 1);
  await f.monitor.configure({ enabled: false, rules: [rule({ cooldownMinutes: 0 })] }, 0);
  f.prices(80); await f.monitor.tick(); assert.equal(f.messages.length, 1); assert.equal(f.monitor.data.states['test-rule'].active, false);
  await f.monitor.configure({ enabled: true, rules: [rule({ cooldownMinutes: 0 })] }, 1);
  f.prices(85); await f.monitor.tick(); assert.equal(f.messages.length, 2);
});

test('Feishu rejects unsafe endpoints and treats HTTP 200 with nonzero code as failure', async () => {
  const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/example-id';
  for (const url of ['http://open.feishu.cn/open-apis/bot/v2/hook/abc', 'https://evil.test/open-apis/bot/v2/hook/abc', webhook + '?leak=1']) assert.throws(() => validateWebhook(url));
  const seen = [];
  await createNotifier({ webhook, fetcher: async (url, options) => { seen.push({ url, options }); return { ok: true, json: async () => ({ code: 0 }) }; } })('hello');
  assert.equal(seen[0].options.redirect, 'error'); assert.equal(JSON.parse(seen[0].options.body).content.text, 'hello');
  await assert.rejects(createNotifier({ webhook, fetcher: async () => ({ ok: true, json: async () => ({ code: 19021 }) }) })('hello'), /19021/);
  await assert.rejects(createNotifier({ webhook, fetcher: async () => { throw new Error(webhook); } })('hello'), error => !error.message.includes('example-id'));
});

test('multiple crossed gradients are batched, asset prices use their own values, and sustained levels do not repeat', async () => {
  const f = fixture({ rules: [rule({ id: 's3', threshold: 3 }), rule(), rule({ id: 'brent85', metric: 'brent', threshold: 85 }), rule({ id: 'wti80', metric: 'wti', operator: 'lte', threshold: 80 })] });
  await f.monitor.tick();
  assert.equal(f.messages.length, 1); assert.equal(f.persisted.events[0].rules.length, 4); assert.equal(f.persisted.events[0].status, 'sent');
  f.advance(31 * 60_000); await f.monitor.tick(); assert.equal(f.messages.length, 1);
  const restarted = fixture({ data: f.persisted }); await restarted.monitor.tick(); assert.equal(restarted.messages.length, 0);
});

test('failed deliveries retry after 60 seconds with stable event IDs, and success ends retries', async () => {
  let attempts = 0;
  const f = fixture({ send: async () => { if (++attempts === 1) throw new Error('飞书 HTTP 503'); } });
  await f.monitor.tick(); const eventId = f.persisted.states['test-rule'].eventId;
  assert.equal(f.persisted.events[0].status, 'failed'); assert.equal(f.persisted.states['test-rule'].alerted, false);
  f.advance(30_000); await f.monitor.tick(); assert.equal(f.messages.length, 1);
  f.advance(30_000); await f.monitor.tick(); assert.equal(f.messages.length, 2); assert.equal(f.persisted.states['test-rule'].eventId, eventId);
  assert.equal(f.persisted.events[0].status, 'sent'); assert.equal(f.persisted.states['test-rule'].alerted, true);
});

test('a failed pending alert is not sent when the fresh price no longer meets the threshold', async () => {
  const f = fixture({ send: async () => { throw new Error('offline'); } });
  await f.monitor.tick(); f.prices(84.9); f.advance(60_000); await f.monitor.tick(); assert.equal(f.messages.length, 1);
  f.prices(86); await f.monitor.tick(); assert.equal(f.messages.length, 2);
});

test('snapshot or failed market reads never produce alerts; master switch and missing webhook suppress sends', async () => {
  const stale = fixture({ fetcher: async () => ({ fetchedAt: '2026-01-01T00:00:00Z', brent: { markPx: 90 }, wti: { markPx: 80 } }) });
  await stale.monitor.tick(); assert.equal(stale.messages.length, 0); assert.match(stale.monitor.status().error, /过期/);
  const off = fixture(); off.monitor.data.config.enabled = false; await off.monitor.tick(); assert.equal(off.messages.length, 0);
  off.monitor.data.config.enabled = true; off.monitor.webhookConfigured = false; await off.monitor.tick(); assert.equal(off.messages.length, 0);
});

test('storage must succeed before a notification can leave the service', async () => {
  const f = fixture({ write: async () => { throw new Error('disk full'); } });
  await assert.rejects(f.monitor.tick(), /数据写入失败/); assert.equal(f.messages.length, 0);
  await f.monitor.tick(); assert.equal(f.messages.length, 0); assert.match(f.monitor.status().error, /暂停/);
});

test('uncertain post-send persistence failure pauses processing to avoid uncontrolled repeats', async () => {
  let writes = 0;
  const f = fixture({ write: async () => { if (++writes === 2) throw new Error('disk full'); } });
  await assert.rejects(f.monitor.tick(), /数据写入失败/); assert.equal(f.messages.length, 1);
  f.advance(120_000); await f.monitor.tick(); assert.equal(f.messages.length, 1);
});

test('configuration revisions prevent lost updates and preserve delivered state on label edits', async () => {
  const f = fixture(); await f.monitor.tick();
  await f.monitor.configure({ enabled: true, rules: [rule({ label: '改名', cooldownMinutes: 10 })] }, 0);
  assert.equal(f.monitor.data.states['test-rule'].alerted, true);
  await assert.rejects(f.monitor.configure({ enabled: false, rules: [] }, 0), error => error.status === 409);
  await f.monitor.configure({ enabled: true, rules: [rule({ threshold: 4 })] }, 1);
  assert.deepEqual(f.monitor.data.states, {}); await f.monitor.tick(); assert.equal(f.messages.length, 2);
});

test('concurrent ticks serialize, send only once, and test messages are rate limited', async () => {
  const f = fixture(); await Promise.all([f.monitor.tick(), f.monitor.tick(), f.monitor.tick()]); assert.equal(f.messages.length, 1);
  await f.monitor.testNotification(); await assert.rejects(f.monitor.testNotification(), error => error.status === 429);
  assert.equal(f.messages.length, 2);
});

test('file persistence survives reopen; overlapping writers and corrupt files fail visibly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oil-store-'));
  const store = new FileStore(directory), other = new FileStore(directory);
  try {
    await store.acquire(); await assert.rejects(other.acquire(), /锁定/);
    const data = emptyStore(); data.revision = 7; data.config.rules[0].threshold = 9;
    await store.write(data); await store.release();
    await other.acquire(); assert.equal((await other.read()).revision, 7); assert.equal((await other.read()).config.rules[0].threshold, 9);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'monitor.json'), 'utf8')).revision, 7);
    await writeFile(path.join(directory, 'monitor.json'), '{bad'); await assert.rejects(other.read());
  } finally { await store.release(); await other.release(); await rm(directory, { recursive: true, force: true }); }
});
