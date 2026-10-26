import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createLoginGuard, ACCOUNT_LOCKOUT_THRESHOLD, IP_ATTEMPT_LIMIT } from '../server/control/login-guard.mjs';

const limits = { loginWindowMs: 15 * 60000, accountLockoutMs: 60000 };

// Two API instances: separate connections to one hub.sqlite.
async function instances(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'login-guard-'));
  const dbs = [0, 1].map(() => openHubDatabase(path.join(dir, 'hub.sqlite')));
  t.after(async () => { for (const db of dbs) db.close(); await rm(dir, { recursive: true, force: true }); });
  return dbs.map(db => createLoginGuard(createControlStore(db), limits));
}

test('failures alternating between instances lock the account on both', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  for (let i = 1; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) {
    const guard = i % 2 ? a : b;
    const result = guard.failure(guard.reserveAccount('global', now), now);
    assert.deepEqual(result, { failed: i, lockedUntil: 0, lockedNow: false });
  }
  const last = b.failure(b.reserveAccount('global', now), now);
  assert.deepEqual(last, { failed: ACCOUNT_LOCKOUT_THRESHOLD, lockedUntil: now + limits.accountLockoutMs, lockedNow: true });
  assert.equal(a.lockedUntil('global', now), now + limits.accountLockoutMs);
  assert.deepEqual(a.reserveAccount('global', now), { locked: now + limits.accountLockoutMs });
  assert.equal(b.lockedUntil('global', now + limits.accountLockoutMs), 0);
});

test('checks in flight on either instance share the failure budget', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const held = [];
  for (let i = 0; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) held.push((i % 2 ? a : b).reserveAccount('global', now));
  assert.ok(held.every(item => item.id));
  assert.deepEqual(a.reserveAccount('global', now), { exhausted: true });
  // A failure that lands after another instance's success is still counted against the same record.
  assert.equal(a.success(held[0], now), 0);
  assert.equal(b.failure(held[1], now).failed, 1);
  b.release(held[2]);
  assert.ok(a.reserveAccount('global', now).id);
});

test('a success is refused when another instance locked the account during its check', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const checking = a.reserveAccount('global', now);
  for (let i = 1; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) assert.equal(b.failure(b.reserveAccount('global', now), now).lockedNow, false);
  // The slow check outlives its lease, so the other instance may count a fifth failure.
  const later = now + 30_000;
  assert.equal(b.failure(b.reserveAccount('global', later), later).lockedNow, true);
  assert.equal(a.success(checking, later + 1), later + limits.accountLockoutMs);
  assert.equal(b.lockedUntil('global', later + 1), later + limits.accountLockoutMs);
});

test('a check its process never finished stops counting after its lease', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  for (let i = 0; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) a.reserveAccount('global', now);
  assert.deepEqual(b.reserveAccount('global', now + 29_999), { exhausted: true });
  assert.ok(b.reserveAccount('global', now + 30_000).id);
});

test('the IP quota is shared and a refund only applies within its window', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const attempts = Array.from({ length: IP_ATTEMPT_LIMIT }, (_, i) => (i % 2 ? a : b).reserveIp('10.0.0.1', now));
  assert.ok(attempts.every(Boolean));
  assert.equal(a.reserveIp('10.0.0.1', now), null);
  assert.ok(a.reserveIp('10.0.0.2', now));
  b.refundIp(attempts[0]);
  assert.ok(a.reserveIp('10.0.0.1', now));
  // A new window after expiry: an old attempt's refund does not reduce it.
  const later = now + limits.loginWindowMs + 1;
  const fresh = b.reserveIp('10.0.0.1', later);
  assert.deepEqual(fresh, { ip: '10.0.0.1', until: later + limits.loginWindowMs });
  a.refundIp(attempts[1]);
  for (let i = 1; i < IP_ATTEMPT_LIMIT; i++) assert.ok(a.reserveIp('10.0.0.1', later));
  assert.equal(a.reserveIp('10.0.0.1', later), null);
});
