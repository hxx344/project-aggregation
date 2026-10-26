import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createLoginGuard, ACCOUNT_LOCKOUT_THRESHOLD, IP_ATTEMPT_LIMIT } from '../server/control/login-guard.mjs';

const limits = { loginWindowMs: 15 * 60000, accountLockoutMs: 60000 };

let dbPath;
// Two API instances: separate connections to one hub.sqlite.
async function instances(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'login-guard-'));
  dbPath = path.join(dir, 'hub.sqlite');
  const dbs = [0, 1].map(() => openHubDatabase(dbPath));
  t.after(async () => { for (const db of dbs) db.close(); await rm(dir, { recursive: true, force: true }); });
  return dbs.map(db => createLoginGuard(createControlStore(db), limits));
}

const attempt = { ip: '10.0.0.9', until: 0 };

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
  assert.deepEqual(a.admit('global', '10.0.0.1', now), { locked: now + limits.accountLockoutMs, lockedNow: false });
  assert.deepEqual(a.reserveAccount('global', now), { locked: now + limits.accountLockoutMs, lockedNow: false });
  const after = now + limits.accountLockoutMs;
  assert.deepEqual(b.admit('global', '10.0.0.1', after), { ip: '10.0.0.1', until: after + limits.loginWindowMs });
});

test('checks in flight on either instance share the failure budget', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const held = [];
  for (let i = 0; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) held.push((i % 2 ? a : b).reserveAccount('global', now));
  assert.ok(held.every(item => item.id));
  assert.deepEqual(a.reserveAccount('global', now), { exhausted: true });
  // A failure that lands after another instance's success is still counted against the same record.
  assert.equal(a.success(held[0], attempt, now), 0);
  assert.equal(b.failure(held[1], now).failed, 1);
  b.release(held[2]);
  assert.ok(a.reserveAccount('global', now).id);
});

test('a success is refused when another instance locked the account during its check', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  for (let i = 1; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) b.failure(b.reserveAccount('global', now), now);
  const counted = a.admit('global', '10.0.0.1', now);
  const checking = a.reserveAccount('global', now);
  for (let i = 1; i < IP_ATTEMPT_LIMIT; i++) b.admit('other', '10.0.0.1', now);
  // The slow correct password outlives its lease: the other instance counts it as the fifth failure.
  const expiry = now + 30_000;
  assert.deepEqual(b.reserveAccount('global', expiry + 1), { locked: expiry + limits.accountLockoutMs, lockedNow: true });
  assert.equal(a.success(checking, counted, expiry + 2), expiry + limits.accountLockoutMs);
  // The refused success gave no IP attempt back.
  assert.deepEqual(b.admit('other', '10.0.0.1', expiry + 2), { limited: true });
});

test('a check that never finished counts as a failure once its lease expires, and only once', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const stuck = Array.from({ length: ACCOUNT_LOCKOUT_THRESHOLD - 1 }, () => a.reserveAccount('global', now));
  const last = b.reserveAccount('global', now + 29_999);
  assert.deepEqual(b.reserveAccount('global', now + 29_999), { exhausted: true });
  b.release(last);
  const expiry = now + 30_000;
  const next = b.reserveAccount('global', expiry);
  assert.ok(next.id);
  // The late result of a lapsed check is not counted again.
  assert.deepEqual(a.failure(stuck[0], expiry), { failed: ACCOUNT_LOCKOUT_THRESHOLD - 1, lockedUntil: 0, lockedNow: false });
  assert.deepEqual(b.failure(next, expiry), { failed: ACCOUNT_LOCKOUT_THRESHOLD, lockedUntil: expiry + limits.accountLockoutMs, lockedNow: true });
  assert.deepEqual(a.admit('global', '10.0.0.1', expiry + 1), { locked: expiry + limits.accountLockoutMs, lockedNow: false });
});

test('a check found lapsed long after its lease counts at its expiry, so an old lock does not apply', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  for (let i = 1; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) a.failure(a.reserveAccount('global', now), now);
  a.reserveAccount('global', now);
  const later = now + 30_000 + limits.accountLockoutMs;
  assert.deepEqual(b.admit('global', '10.0.0.1', later), { ip: '10.0.0.1', until: later + limits.loginWindowMs });
  assert.ok(b.reserveAccount('global', later).id);
});

test('refusals visible without the write lock do not wait for it', async t => {
  const [a] = await instances(t);
  const now = Date.now();
  for (let i = 0; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) a.failure(a.reserveAccount('global', now), now);
  for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) a.admit('other', '10.0.0.1', now);
  const holder = openHubDatabase(dbPath);
  holder.exec('BEGIN IMMEDIATE');
  t.after(() => { holder.exec('ROLLBACK'); holder.close(); });
  const started = Date.now();
  assert.deepEqual(a.admit('global', '10.0.0.2', now), { locked: now + limits.accountLockoutMs, lockedNow: false });
  assert.deepEqual(a.admit('other', '10.0.0.1', now), { limited: true });
  assert.ok(Date.now() - started < 1000);
});

test('the IP quota is shared and a success only refunds within its window', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  const attempts = Array.from({ length: IP_ATTEMPT_LIMIT }, (_, i) => (i % 2 ? a : b).admit('global', '10.0.0.1', now));
  assert.ok(attempts.every(item => item.ip));
  assert.deepEqual(a.admit('global', '10.0.0.1', now), { limited: true });
  assert.ok(a.admit('global', '10.0.0.2', now).ip);
  assert.equal(b.success(b.reserveAccount('global', now), attempts[0], now), 0);
  assert.ok(a.admit('global', '10.0.0.1', now).ip);
  // A new window after expiry: an old attempt's refund does not reduce it.
  const later = now + limits.loginWindowMs + 1;
  const fresh = b.admit('global', '10.0.0.1', later);
  assert.deepEqual(fresh, { ip: '10.0.0.1', until: later + limits.loginWindowMs });
  a.success(a.reserveAccount('global', later), attempts[1], later);
  for (let i = 1; i < IP_ATTEMPT_LIMIT; i++) assert.ok(a.admit('global', '10.0.0.1', later).ip);
  assert.deepEqual(a.admit('global', '10.0.0.1', later), { limited: true });
});
