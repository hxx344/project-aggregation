import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuDigest } from '../server/automation/feishu-digest.mjs';
import { createPerpetualAlertService } from '../modules/monitor/server/perpetual-alert-service.mjs';
import { initialPerpetualAlertState } from '../modules/monitor/server/perpetual-alert-engine.mjs';

test('digest review persists independently, preserves unknown channel facts and cannot request a resend', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'delivery-review-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let calls = 0;
  const options = { dataDir, encrypt: value => value, decrypt: value => value, log: { warn() {} }, tickMs: 0,
    readSections: async () => [], fetcher: async () => { calls++; throw new Error('network'); } };
  const digest = createFeishuDigest(options); digest.initialize(); digest.setChannel({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-review', signingSecret: '' });
  await digest.send(); const entry = digest.state().history[0]; assert.equal(entry.status, 'uncertain');
  const before = readFileSync(join(dataDir, 'feishu-digest/state.json'), 'utf8');
  digest.reviewDelivery({ id: entry.id, note: '已在群内人工看到消息', source: '群消息时间 10:00' });
  assert.equal(readFileSync(join(dataDir, 'feishu-digest/state.json'), 'utf8'), before);
  assert.equal(digest.state().history[0].status, 'uncertain'); assert.equal(digest.state().history[0].reviews.length, 1); assert.equal(calls, 1);
  assert.throws(() => digest.reviewDelivery({ id: entry.id, note: 'sent', source: 'operator', status: 'sent' }));
  assert.throws(() => digest.reviewDelivery({ id: 'missing', note: 'n', source: 's' }), /不存在/);
  assert.throws(() => digest.reviewDelivery({ id: entry.id, note: 'private_key=bad', source: 's' }), /凭据/);
  await digest.close(); const next = createFeishuDigest(options); next.initialize();
  assert.equal(next.state().history[0].reviews[0].actor, 'authenticated_admin'); assert.equal(next.state().history[0].status, 'uncertain'); await next.close();
});

test('digest restart preserves the original sending stage and describes missing acknowledgement as unknown', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'delivery-stage-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, encrypt: x => x, decrypt: x => x, log: { warn() {} }, tickMs: 0, readSections: async () => [] };
  let digest = createFeishuDigest(options); digest.initialize(); await digest.close();
  writeFileSync(join(dataDir, 'feishu-digest/state.json'), JSON.stringify({ lastSlot: 1, history: [{ id: 'event', at: new Date().toISOString(), kind: 'schedule', status: 'sending', attention: 0, error: null, stages: [{ status: 'generated', at: 'original' }, { status: 'sending', at: 'original' }] }] }));
  digest = createFeishuDigest(options); digest.initialize(); const entry = digest.state().history[0];
  assert.equal(entry.status, 'uncertain'); assert.equal(entry.stages[1].status, 'sending'); await digest.close();
});

test('Monitor review keeps original event untouched and survives late channel results and restart', async () => {
  const now = Date.now(), original = { id: 'delivery', ruleId: 'r', name: 'rule', time: now, status: 'sending', base: 'BTC', longKey: 'a', shortKey: 'b', netSpreadPercent: 1, error: '' };
  let saved = { ...initialPerpetualAlertState(), history: [original] }, sends = 0;
  const store = { get: () => structuredClone(saved), save: async next => { saved = structuredClone(next); } };
  const service = createPerpetualAlertService({ store, clock: () => now, notifications: { configured: () => true, send: () => { sends++; } } });
  await service.review({ id: 'delivery', note: '等待渠道确认', source: '工单123' });
  assert.deepEqual(saved.history[0], original); assert.equal(service.view().history[0].deliveryStage, 'unknown'); assert.equal(sends, 0);
  saved.history[0].status = 'sent'; const restarted = createPerpetualAlertService({ store, clock: () => now });
  assert.equal(restarted.view().history[0].deliveryStage, 'confirmed'); assert.equal(restarted.view().history[0].reviews.length, 1);
  await assert.rejects(restarted.review({ id: 'missing', note: 'n', source: 's' }), /不存在/);
  await service.stop(); await restarted.stop();
});
