import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const password = 'test-password-lockout';
const LOCKOUT_MS = 60000;

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lockout-test-'));
  const app = await createApp({ dataDir, initialPassword: password, refreshInterval: 0, assetSyncIntervalMs: 0, accountLockoutMs: LOCKOUT_MS, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = async value => {
    const response = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: value }) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { login };
}

test('account lockout triggers after 5 failed attempts and also rejects the correct password', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) {
    const res = await f.login('wrong');
    assert.equal(res.status, 401, `attempt ${i}`);
    assert.match(res.data.error, /密码不正确/);
  }
  const fifth = await f.login('wrong');
  assert.equal(fifth.status, 429);
  assert.match(fifth.data.error, /已被锁定/);
  assert.equal((await f.login('wrong')).status, 429);
  const correct = await f.login(password);
  assert.equal(correct.status, 429);
  assert.match(correct.data.error, /已被锁定/);
});

test('successful login clears failed attempt counter', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 3; i++) assert.equal((await f.login('wrong')).status, 401);
  assert.equal((await f.login(password)).status, 200);
  for (let i = 1; i <= 4; i++) assert.equal((await f.login('wrong')).status, 401, `after reset, attempt ${i}`);
  assert.equal((await f.login('wrong')).status, 429);
});

test('concurrent failures are each counted and cannot exceed the failure budget', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.login('wrong')));
  const statuses = results.map(res => res.status);
  assert.equal(statuses.filter(status => status === 401).length, 4, statuses.join(','));
  assert.ok(statuses.every(status => status === 401 || status === 429), statuses.join(','));
  assert.ok(results.some(res => /已被锁定/.test(res.data.error)), JSON.stringify(results.map(res => res.data.error)));
  // The fifth failure locks the account; late concurrent results must not overwrite the lock.
  assert.equal((await f.login(password)).status, 429);
});

test('failures below the threshold expire one lockout period after the first failure', async t => {
  const f = await fixture(t);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (let i = 1; i <= 4; i++) assert.equal((await f.login('wrong')).status, 401);
  now += LOCKOUT_MS;
  for (let i = 1; i <= 4; i++) assert.equal((await f.login('wrong')).status, 401, `after expiry, attempt ${i}`);
  assert.equal((await f.login(password)).status, 200);
});

test('invalid lockout durations are rejected at startup', async () => {
  for (const accountLockoutMs of [NaN, 0, -1, 999, 1.5, 86400001]) {
    await assert.rejects(createApp({ dataDir: path.join(os.tmpdir(), 'lockout-invalid-unused'), initialPassword: password, refreshInterval: 0, assetSyncIntervalMs: 0, accountLockoutMs, logger: () => {} }), RangeError);
  }
});

test('a lock expires at its deadline', async t => {
  const f = await fixture(t);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (let i = 1; i <= 4; i++) assert.equal((await f.login('wrong')).status, 401);
  assert.equal((await f.login('wrong')).status, 429);
  now += LOCKOUT_MS - 1;
  assert.equal((await f.login(password)).status, 429);
  now += 1;
  assert.equal((await f.login(password)).status, 200);
});
