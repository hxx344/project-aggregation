import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAeroNotifications } from '../server/automation/aero-notifications.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-notify-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1000, sent = 0, failure = options.failure;
  const channel = { alertChannel: () => ({ configured: true, title: 'Test' }), postAlert: async card => { sent++; assert.equal(JSON.stringify(card).includes('0x'), false); if (failure) throw failure; options.afterPost?.(directory); } };
  const make = () => { const service = createAeroNotifications({ directory, channel: () => channel, now: () => clock }); service.initialize(); return service; };
  const input = { binding: [8453, 'safe', 'roles'], enabled: true, halted: true, needsReview: false, at: 1000, healthy: false, observedAt: 1001 };
  return { directory, input, make, sent: () => sent, advance: () => { clock += 60001; }, failure: value => { failure = value; } };
}

test('persistent incident and recovery identities survive restart and repeated samples without duplicates', async t => {
  const f = fixture(t), first = f.make();
  first.configure({ interrupted: true, needs_review: true, recovered: true }); first.observe(f.input); await first.tick();
  assert.equal(f.sent(), 1); await first.close();
  const next = f.make(); next.observe(f.input); await next.tick(); assert.equal(f.sent(), 1);
  next.observe({ ...f.input, halted: false, healthy: true }); await next.tick(); assert.equal(f.sent(), 2);
  for (let i = 0; i < 4; i++) { next.observe({ ...f.input, halted: false, healthy: true }); await next.tick(); }
  assert.equal(f.sent(), 2); assert.deepEqual(next.view().history.map(item => item.kind), ['recovered', 'interrupted']);
  await next.close();
});

test('definite failures get at most three persistent attempts, uncertain delivery is never retried', async t => {
  const f = fixture(t, { failure: Object.assign(new Error('refused'), { uncertain: false }) }); let service = f.make();
  service.configure({ interrupted: true, needs_review: true, recovered: true }); service.observe(f.input);
  for (let i = 0; i < 5; i++) { service.observe(f.input); await service.tick(); await service.close(); f.advance(); service = f.make(); }
  assert.equal(f.sent(), 3); assert.equal(service.view().history[0].attempts, 3); await service.close();
  const unknown = fixture(t, { failure: Object.assign(new Error('timeout'), { uncertain: true }) });
  let other = unknown.make(); other.configure({ interrupted: true, needs_review: true, recovered: true }); other.observe(unknown.input); await other.tick(); await other.close(); unknown.advance();
  other = unknown.make(); other.observe(unknown.input); await other.tick(); assert.equal(unknown.sent(), 1); assert.equal(other.view().history[0].status, 'unknown'); await other.close();
});

test('manual disable is not recovery; changing Safe isolates queued notifications; reading views never sends', async t => {
  const f = fixture(t), service = f.make(); service.configure({ interrupted: true, needs_review: true, recovered: true });
  service.observe({ ...f.input, halted: false, enabled: false }); assert.equal(service.view().history.length, 0);
  service.observe({ ...f.input, halted: false, needsReview: true, running: true }); assert.equal(service.view().history.length, 0, 'a running close is not an interruption');
  service.observe(f.input); service.observe({ ...f.input, halted: false, enabled: false });
  assert.equal(service.view().history.length, 1);
  service.observe({ binding: null }); await service.tick(); assert.equal(f.sent(), 0, 'missing current Safe configuration never dispatches an old queued event');
  service.observe({ ...f.input, binding: ['new-safe'], halted: false, enabled: false }); await service.tick();
  assert.equal(f.sent(), 0); assert.equal(service.view().history.length, 0); await service.close();
});

test('failed persistence after channel ACK remains an unknown occupied send after restart, never a retryable refusal', async t => {
  let restore;
  const f = fixture(t, { afterPost(directory) {
    const file = join(directory, 'notifications.json'), backup = join(directory, 'ack-backup.json');
    renameSync(file, backup); mkdirSync(file); restore = () => { rmSync(file, { recursive: true }); renameSync(backup, file); };
  } });
  const service = f.make(); service.configure({ interrupted: true, needs_review: true, recovered: true }); service.observe(f.input);
  await assert.rejects(service.tick(), /保存失败/); assert.equal(f.sent(), 1); restore(); await service.close(); f.advance();
  const restarted = f.make(); restarted.observe(f.input); await restarted.tick(); assert.equal(f.sent(), 1); assert.equal(restarted.view().history[0].status, 'unknown'); await restarted.close();
});

test('a failed durable sending claim sends nothing; a pre-incident cached snapshot cannot announce recovery', async t => {
  const f = fixture(t), service = f.make(); service.configure({ interrupted: true, needs_review: true, recovered: true }); service.observe(f.input);
  service.observe({ ...f.input, halted: false, healthy: true, observedAt: 999 }); assert.equal(service.view().history.length, 1);
  const file = join(f.directory, 'notifications.json'), backup = join(f.directory, 'notifications-backup.json');
  renameSync(file, backup); mkdirSync(file);
  await assert.rejects(service.tick(), /保存失败/); assert.equal(f.sent(), 0); assert.match(service.view().error, /暂停/);
  rmSync(file, { recursive: true }); renameSync(backup, file); await service.close();
  const restarted = f.make(); restarted.observe(f.input); await restarted.tick(); assert.equal(f.sent(), 1); await restarted.close();
});

test('restart after durable sending claim reports unknown and corrupt state refuses sending', async t => {
  const f = fixture(t); let service = f.make(); service.configure({ interrupted: true, needs_review: true, recovered: true }); service.observe(f.input); await service.close();
  const file = join(f.directory, 'notifications.json'), saved = JSON.parse(readFileSync(file, 'utf8')); saved.history[0].status = 'sending'; saved.history[0].attempts = 1; writeFileSync(file, JSON.stringify(saved));
  service = f.make(); await service.tick(); assert.equal(service.view().history[0].status, 'unknown'); assert.equal(f.sent(), 0); await service.close();
  writeFileSync(file, '{'); service = f.make(); service.observe(f.input); await service.tick(); assert.match(service.view().error, /读取失败/); assert.equal(f.sent(), 0); await service.close();
});
