import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialPerpetualAlertState } from '../server/perpetual-alert-engine.mjs';
import { createPerpetualAlertService } from '../server/perpetual-alert-service.mjs';
import { openPerpetualAlertStore } from '../server/perpetual-alert-store.mjs';
import { PERPETUAL_ALERT_FILE_BYTES, PERPETUAL_REVIEW_BYTES } from '../server/perpetual-alert-limits.mjs';

const NOW = 1_800_000_000_000;
const note = '核'.repeat(500), source = '据'.repeat(200);
const history = count => Array.from({ length: count }, (_, index) => ({ id: `event-${index}`, ruleId: 'fixture', name: '规'.repeat(80), time: NOW,
  status: 'failed', base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT', netSpreadPercent: 1, error: '错'.repeat(200) }));
async function fixture(t, count = 100) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-review-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openPerpetualAlertStore(directory), events = history(count);
  await store.save({ ...initialPerpetualAlertState(), history: events });
  return { directory, store, events, file: join(directory, 'opportunity-alerts.json') };
}
async function fillReviews(service) {
  let accepted = 0, rejected = 0;
  for (const event of service.view().history) for (let index = 0; index < 5; index++) {
    try { await service.review({ id: event.id, note, source }); accepted++; }
    catch (error) { assert.equal(error.status, 413); assert.match(error.message, /400 KB/); rejected++; }
  }
  return { accepted, rejected };
}

test('500 maximum Chinese review attempts cannot exceed restart budget or delete original delivery facts', async t => {
  const f = await fixture(t), service = createPerpetualAlertService({ store: f.store, clock: () => NOW }); t.after(() => service.stop());
  const { accepted, rejected } = await fillReviews(service);
  assert.ok(accepted > 0 && rejected > 0); assert.equal(accepted + rejected, 500);
  assert.equal(service.healthy(), true, 'a capacity refusal does not poison pending persistence');
  assert.ok((await stat(f.file)).size <= PERPETUAL_ALERT_FILE_BYTES);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.ok(Buffer.byteLength(`${JSON.stringify(saved.deliveryReviews)}\n`) <= PERPETUAL_REVIEW_BYTES);
  assert.deepEqual(saved.history, f.events, 'the notes limit never evicts original delivery facts');
  const restarted = await openPerpetualAlertStore(f.directory);
  assert.deepEqual(restarted.get().history, f.events);
  assert.equal(Object.values(restarted.get().deliveryReviews).reduce((sum, rows) => sum + rows.length, 0), accepted);
  await assert.rejects(restarted.save({ ...restarted.get(), extra: '界'.repeat(400_000) }), error => error.status === 413);
  assert.deepEqual((await openPerpetualAlertStore(f.directory)).get().history, f.events, 'all save paths reject oversized UTF-8 before replacing the durable file');
});

test('full review budget leaves room for an in-flight delivery to persist its later failure and restart', async t => {
  const f = await fixture(t, 99); let clock = NOW, entered, release;
  const began = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const quotes = new Map(['binance', 'gate'].map(exchange => [`${exchange}:BTCUSDT`, { exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', comparable: true,
    bid: exchange === 'binance' ? 100 : 102, ask: exchange === 'binance' ? 100.01 : 102.01, receivedAt: clock, bidAskAt: clock }]));
  const service = createPerpetualAlertService({ store: f.store, clock: () => clock, getQuote: key => quotes.get(key), isVenueLive: () => true,
    notifications: { configured: () => true, send: async () => { entered(); await gate; throw new Error('错'.repeat(200)); } } });
  t.after(async () => { release(); await service.stop(); });
  await service.update({ revision: 0, enabled: true, rules: [{ id: 'r', name: '规'.repeat(80), enabled: true, base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT', thresholdPercent: 0.3,
    durationSeconds: 2, windowSeconds: 5, minHitRatio: 0.6, cooldownSeconds: 30, maxAgeSeconds: 10, budget: { slippagePercent: 0.1, takerOverrides: {} } }] });
  service.start();
  for (let second = 0; second < 2; second++) { clock = NOW + second * 1000; for (const quote of quotes.values()) quote.receivedAt = quote.bidAskAt = clock; await service.check(); }
  clock += 1000; for (const quote of quotes.values()) quote.receivedAt = quote.bidAskAt = clock;
  const pending = service.check(); await began;
  const eventId = service.view().history[0].id;
  assert.equal(service.view().history[0].status, 'sending');
  const counts = await fillReviews(service); assert.ok(counts.rejected > 0);
  release(); await pending;
  const restarted = await openPerpetualAlertStore(f.directory), event = restarted.get().history.find(item => item.id === eventId);
  assert.equal(event.status, 'failed'); assert.equal(event.error, '错'.repeat(200)); assert.equal(event.stages.at(-1).status, 'failed');
  assert.equal(restarted.get().history.length, 100); assert.ok((await stat(f.file)).size <= PERPETUAL_ALERT_FILE_BYTES); assert.equal(service.healthy(), true);
});
