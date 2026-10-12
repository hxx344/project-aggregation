import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualAlertService } from '../server/perpetual-alert-service.mjs';
import { createPerpetualConditionTracker, initialPerpetualAlertState } from '../server/perpetual-alert-engine.mjs';

const NOW = 1_800_000_000_000;
const rule = (id, patch = {}) => ({ id, name: id, enabled: true, base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT',
  thresholdPercent: 0.3, durationSeconds: 2, windowSeconds: 5, minHitRatio: 0.6, cooldownSeconds: 30, maxAgeSeconds: 10,
  budget: { slippagePercent: 0.1, takerOverrides: {} }, ...patch });
const yieldTasks = () => new Promise(resolve => setImmediate(resolve));

test('non-aligned observations must cover the actual requested duration, not just cross second buckets', () => {
  const tracker = createPerpetualConditionTracker(rule('timing', { durationSeconds: 30, windowSeconds: 60, minHitRatio: 0 }));
  const hit = { valid: true, hit: true };
  tracker.observe(hit, NOW + 999);
  for (let second = 1; second <= 29; second++) tracker.observe(hit, NOW + second * 1000 + 999);
  const early = tracker.observe(hit, NOW + 30_000);
  assert.equal(early.ready, false, '29.001 seconds of observation cannot satisfy a 30-second condition');
  assert.ok(early.continuousSeconds < 30);
  const complete = tracker.observe(hit, NOW + 30_999);
  assert.equal(complete.ready, true);
  assert.equal(complete.continuousSeconds, 30);
});

test('slow notification delivery does not stall observation of other rules or queue duplicate sends', async t => {
  let now = NOW, saved = initialPerpetualAlertState(), release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [], pendingChecks = [];
  const service = createPerpetualAlertService({
    store: { get: () => structuredClone(saved), save: async state => { saved = structuredClone(state); } },
    clock: () => now,
    getQuote: key => {
      const exchange = key.split(':')[0], price = exchange === 'gate' ? 102 : 100;
      return { exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: price, ask: price, receivedAt: now, bidAskAt: now };
    },
    isVenueLive: () => true,
    notifications: {
      configured: () => true,
      send: async (text, beforeSend) => { beforeSend?.(); sent.push(text); if (sent.length === 1) await gate; },
    },
  });
  t.after(async () => { release(); await Promise.allSettled(pendingChecks); await service.stop(); });
  service.start();
  await service.update({ revision: 0, enabled: true, rules: [rule('first'), rule('second')] });
  await service.check(); now += 1000; await service.check();
  now += 1000; pendingChecks.push(service.check()); await yieldTasks();
  assert.equal(sent.length, 1, 'First delivery is deliberately waiting');
  now += 1000; pendingChecks.push(service.check()); await yieldTasks();
  const progress = service.view().progress;
  assert.equal(progress.first.checkedAt, now);
  assert.equal(progress.second.checkedAt, now, 'The second rule must still observe each market second');
  assert.equal(progress.second.continuousSeconds, 3);
  assert.equal(progress.second.state, 'triggered');
  for (let index = 0; index < 10; index++) pendingChecks.push(service.check());
  await yieldTasks();
  release(); await Promise.all(pendingChecks); await yieldTasks(); await service.stop();
  assert.equal(sent.length, 2, 'One send per rule despite repeated checks while a delivery is in flight');
  assert.equal(service.view().history.filter(item => item.status === 'sent').length, 2);
});

test('disabling notifications while a message waits for the shared sender cancels all old candidates', async t => {
  let now = NOW, saved = initialPerpetualAlertState(), release, waiting = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const service = createPerpetualAlertService({
    store: { get: () => structuredClone(saved), save: async state => { saved = structuredClone(state); } },
    clock: () => now,
    getQuote: key => {
      const exchange = key.split(':')[0], price = exchange === 'gate' ? 102 : 100;
      return { exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: price, ask: price, receivedAt: now, bidAskAt: now };
    },
    isVenueLive: () => true,
    notifications: { configured: () => true, send: async (text, beforeSend) => { waiting++; await gate; beforeSend?.(); sent.push(text); } },
  });
  t.after(async () => { release(); await service.stop(); });
  service.start();
  await service.update({ revision: 0, enabled: true, rules: [rule('first'), rule('second')] });
  await service.check(); now += 1000; await service.check();
  now += 1000; const pending = service.check(); await yieldTasks();
  assert.equal(waiting, 1);
  let updated = false;
  const update = service.update({ revision: service.view().revision, enabled: false, rules: [rule('first'), rule('second')] }).then(() => { updated = true; });
  await yieldTasks();
  assert.equal(updated, true, 'Turning off reminders must not wait behind a blocked network delivery');
  release(); await Promise.all([pending, update]); await yieldTasks();
  assert.equal(sent.length, 0);
  assert.equal(waiting, 1, 'The second candidate is discarded before entering the shared sender');
  assert.equal(service.view().config.enabled, false);
  assert.equal(service.view().history[0].status, 'failed');
  assert.match(service.view().history[0].error, /取消/);
});
