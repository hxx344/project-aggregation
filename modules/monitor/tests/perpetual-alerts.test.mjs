import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createPerpetualAlertService } from '../server/perpetual-alert-service.mjs';
import { initialPerpetualAlertState, validatePerpetualAlertConfig, evaluatePerpetualAlertQuote, createPerpetualConditionTracker } from '../server/perpetual-alert-engine.mjs';
import { openPerpetualAlertStore } from '../server/perpetual-alert-store.mjs';
import { createHandler } from '../server/http.mjs';

const NOW = 1_800_000_000_000;
const rule = (patch = {}) => ({ id: 'btc-bg', name: 'BTC Binance to Gate', enabled: true, base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT', thresholdPercent: 0.3, durationSeconds: 2, windowSeconds: 5, minHitRatio: 0.6, cooldownSeconds: 30, maxAgeSeconds: 10, budget: { slippagePercent: 0.1, takerOverrides: {} }, ...patch });
function quotes(now = NOW, patch = {}) { return new Map([
  ['binance:BTCUSDT', { exchange: 'binance', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', comparable: true, bid: 100, ask: 100.01, receivedAt: now, bidAskAt: now }],
  ['gate:BTCUSDT', { exchange: 'gate', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', comparable: true, bid: 102, ask: 102.01, receivedAt: now, bidAskAt: now, ...patch }],
]); }
function fixture(options = {}) {
  let now = NOW, values = quotes(), saved = options.state ?? initialPerpetualAlertState(), writes = 0, failWrite = false, healthy = true;
  const sent = [];
  const store = { get: () => structuredClone(saved), save: async state => { writes++; if (failWrite) throw Error('disk'); saved = structuredClone(state); } };
  const service = createPerpetualAlertService({ store, clock: () => now, getQuote: key => values.get(key), isVenueLive: () => true, marketHealthy: () => healthy,
    notifications: { configured: () => options.configured !== false, send: async (text, beforeSend) => { beforeSend?.(); sent.push(text); await options.send?.(text); } },
  });
  service.start();
  return { service, sent, state: () => structuredClone(saved), writes: () => writes, setFail: value => { failWrite = value; }, setHealthy: value => { healthy = value; },
    async configure(enabled = true, rules = [rule()]) { return service.update({ revision: service.view().revision, enabled, rules }); },
    async tick(second, patch = {}) { now = NOW + second * 1000; values = quotes(now, patch); await service.check(); },
  };
}

test('opportunity alert configuration starts disabled and validates bounded complete pair conditions', () => {
  assert.deepEqual(initialPerpetualAlertState().config, { enabled: false, rules: [] });
  assert.equal(validatePerpetualAlertConfig({ enabled: true, rules: [rule()] }).rules.length, 1);
  for (const patch of [{ id: '__proto__' }, { durationSeconds: 0 }, { durationSeconds: 6 }, { windowSeconds: 3601 }, { maxAgeSeconds: 31 }, { cooldownSeconds: 0 }, { minHitRatio: NaN }, { shortKey: 'binance:BTCUSDC' }, { budget: { slippagePercent: 0, takerOverrides: { fake: 0 } } }]) assert.throws(() => validatePerpetualAlertConfig({ enabled: true, rules: [rule(patch)] }));
  assert.throws(() => validatePerpetualAlertConfig({ enabled: true, rules: [rule(), rule()] }));
  assert.throws(() => validatePerpetualAlertConfig({ enabled: true, rules: Array.from({ length: 21 }, (_, index) => rule({ id: `r${index}` })) }));
});

test('alert evaluation excludes unavailable fees, mismatched identity, stale books and offline venues', () => {
  const valid = quotes();
  assert.equal(evaluatePerpetualAlertQuote(rule(), key => valid.get(key), NOW).hit, true);
  for (const patch of [{ bidAskAt: NOW - 10_001 }, { bidAskAt: NOW - 5_001 }, { bid: 105, ask: 104 }, { comparable: false }, { quoteCurrency: 'USDC' }, { base: 'OTHER' }, { bid: null }]) {
    const value = quotes(NOW, patch);
    assert.equal(evaluatePerpetualAlertQuote(rule(), key => value.get(key), NOW).valid, false);
  }
  assert.equal(evaluatePerpetualAlertQuote(rule(), key => valid.get(key), NOW, venue => venue !== 'gate').valid, false);
  const unknown = quotes(); unknown.set('gate:BTCUSDT', { ...unknown.get('gate:BTCUSDT'), exchange: 'bybit' });
  assert.match(evaluatePerpetualAlertQuote(rule(), key => unknown.get(key), NOW).reason, /费率/);
});

test('continuous time uses elapsed seconds and window ratio includes missing startup and outage seconds', () => {
  const tracker = createPerpetualConditionTracker(rule()), hit = { valid: true, hit: true };
  assert.deepEqual(tracker.observe(hit, NOW), { continuousSeconds: 0, hitRatio: 0.2, coverage: 0.2, ready: false });
  assert.equal(tracker.observe(hit, NOW + 500).continuousSeconds, 0);
  assert.equal(tracker.observe(hit, NOW + 1000).ready, false);
  assert.equal(tracker.observe(hit, NOW + 2000).ready, true);
  const gap = tracker.observe(hit, NOW + 5000);
  assert.equal(gap.continuousSeconds, 0); assert.equal(gap.hitRatio, 0.6);
  tracker.observe({ valid: false, hit: false }, NOW + 5001);
  assert.equal(tracker.observe(hit, NOW + 6000).continuousSeconds, 0);
  for (let second = 7; second < 100; second++) tracker.observe(hit, NOW + second * 1000);
  assert.equal(tracker.size(), 5);
  assert.equal(tracker.observe(hit, NOW).continuousSeconds, 0, 'Clock rollback never creates fictitious duration');
});

test('saved observation continues with notifications off and does not write each tick', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.configure(false);
  for (let second = 0; second < 10; second++) await f.tick(second);
  const view = f.service.view();
  assert.equal(view.progress['btc-bg'].state, 'triggered');
  assert.equal(view.progress['btc-bg'].continuousSeconds, 9);
  assert.equal(view.progress['btc-bg'].hitRatio, 1);
  assert.equal(f.sent.length, 0); assert.equal(f.writes(), 1);
  await f.configure(true); await f.tick(10);
  assert.equal(f.sent.length, 1);
});

test('background reminders require persistence and re-entry after cooldown, and survive restart without replay', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.configure();
  for (let second = 0; second < 4; second++) await f.tick(second);
  assert.equal(f.sent.length, 1); assert.equal(f.service.view().history[0].status, 'sent');
  await f.tick(40); await f.tick(41); await f.tick(42);
  assert.equal(f.sent.length, 1, 'Remaining above threshold does not produce repeated reminders');
  const restarted = fixture({ state: f.state() }); t.after(() => restarted.service.stop());
  restarted.setHealthy(false); await restarted.tick(43); restarted.setHealthy(true);
  for (let second = 44; second <= 48; second++) await restarted.tick(second);
  assert.equal(restarted.sent.length, 0, 'Persisted disarmed state prevents replay after restart');
  assert.equal(restarted.state().ruleStates['btc-bg'].armed, false, 'A missing or invalid observation cannot re-arm a previously sent rule');
  await restarted.tick(49, { bid: 100, ask: 100.01 });
  for (let second = 50; second <= 53; second++) await restarted.tick(second);
  assert.equal(restarted.sent.length, 1);
});

test('disk failure prevents delivery, retains pending attempt, and recovers without duplicate sending', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.configure();
  await f.tick(0); await f.tick(1); f.setFail(true);
  await assert.rejects(f.tick(2), /保存失败/);
  assert.equal(f.sent.length, 0); assert.equal(f.service.healthy(), false);
  f.setFail(false); await f.tick(3);
  assert.equal(f.service.healthy(), true); assert.equal(f.sent.length, 0);
  assert.equal(f.service.view().history[0].status, 'sending', 'Uncertain attempts remain visible, not silently retried');
});

test('bad market persistence and missing shared webhook keep observation from sending', async t => {
  const f = fixture(); t.after(() => f.service.stop()); await f.configure(); f.setHealthy(false);
  for (let second = 0; second < 6; second++) await f.tick(second);
  assert.equal(f.sent.length, 0); assert.equal(f.service.view().progress['btc-bg'].coverage, 0);
  const withoutWebhook = fixture({ configured: false }); t.after(() => withoutWebhook.service.stop()); await withoutWebhook.configure();
  for (let second = 0; second < 6; second++) await withoutWebhook.tick(second);
  assert.equal(withoutWebhook.sent.length, 0); assert.equal(withoutWebhook.service.view().progress['btc-bg'].state, 'triggered');
});

test('concurrent checks join the active delivery and status reads never send', async t => {
  let release;
  const f = fixture({ send: () => new Promise(resolve => { release = resolve; }) }); t.after(() => f.service.stop());
  await f.configure(); await f.tick(0); await f.tick(1);
  const sending = f.tick(2); await new Promise(resolve => setImmediate(resolve));
  const second = f.service.check();
  for (let i = 0; i < 20; i++) f.service.view();
  assert.equal(f.sent.length, 1); release(); await Promise.all([sending, second]);
  assert.equal(f.sent.length, 1);
});

test('same-base different pair directions retain separate condition windows', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  await f.configure(false, [rule(), rule({ id: 'reverse', longKey: 'gate:BTCUSDT', shortKey: 'binance:BTCUSDT' })]);
  for (let second = 0; second < 5; second++) await f.tick(second);
  const progress = f.service.view().progress;
  assert.equal(progress['btc-bg'].state, 'triggered'); assert.equal(progress.reverse.hitRatio, 0);
  assert.equal(f.service.metrics().observationPoints, 10);
});

test('event records are capped and expire after one day even when notification rules are disabled', async t => {
  const state = initialPerpetualAlertState();
  state.history = Array.from({ length: 105 }, (_, index) => ({ id: String(index), time: NOW - index * 1000, status: 'sent' }));
  const f = fixture({ state }); t.after(() => f.service.stop());
  await f.tick(0); assert.equal(f.service.metrics().events, 100); assert.equal(f.state().history.length, 100);
  await f.tick(86_401); assert.equal(f.service.metrics().events, 0); assert.equal(f.state().history.length, 0);
  assert.equal(f.sent.length, 0);
});

test('opportunity state remains small, atomic and independent of market history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-opportunity-'));
  try {
    const store = await openPerpetualAlertStore(directory), state = initialPerpetualAlertState();
    state.config = { enabled: true, rules: [rule()] }; state.revision = 1;
    state.ruleStates = { 'btc-bg': { armed: false, lastAttemptAt: NOW, lastSentAt: NOW } };
    await store.save(state);
    const restored = await openPerpetualAlertStore(directory);
    assert.deepEqual(restored.get(), state);
    assert.ok((await stat(join(directory, 'opportunity-alerts.json'))).size < 5000);
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-opportunity-')); await rm(directory, { recursive: true, force: true }); }
});

test('new opportunity configuration keeps authentication, same-origin, JSON and revision guards', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const backend = { actions: { alerts: ['GET', 'PUT'] }, handle: (_action, method, input) => method === 'PUT' ? f.service.update(input) : f.service.view() };
  const server = createServer(createHandler({ services: new Map([['perpetual', backend]]), username: 'u', password: 'test-password-only', nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/alerts`;
  const headers = { authorization: `Basic ${Buffer.from('u:test-password-only').toString('base64')}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, origin: 'https://other.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await fetch(url, { method: 'PUT', headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  const config = { revision: 0, enabled: false, rules: [rule()] };
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(config) })).status, 200);
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(config) })).status, 409);
  assert.equal(f.sent.length, 0);
});
