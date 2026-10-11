import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const password = 'test-password-lockout';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lockout-test-'));
  let app = await createApp({ dataDir, initialPassword: password, refreshInterval: 0, assetSyncIntervalMs: 0, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${app.server.address().port}`;

  async function request(route, { method = 'GET', body } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Origin': origin  // Add Origin header to pass CSRF check
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }

  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { request };
}

test('account lockout triggers after 5 failed attempts', async t => {
  const f = await fixture(t);

  // Attempts 1-4: should return 401
  for (let i = 1; i <= 4; i++) {
    const res = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
    assert.equal(res.status, 401, `Attempt ${i} should return 401, got ${res.status}`);
    if (res.data && res.data.message) {
      assert.match(res.data.message, /密码不正确/, `Attempt ${i} message: ${res.data.message}`);
    }
  }

  // Attempt 5: should trigger lockout and return 429
  const res5 = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
  assert.equal(res5.status, 429, `Attempt 5 should return 429 (lockout), got ${res5.status}. Response: ${JSON.stringify(res5.data)}`);
  if (res5.data && res5.data.message) {
    assert.match(res5.data.message, /已被锁定/, `Attempt 5 message: ${res5.data.message}`);
  }

  // Attempt 6: should still be locked
  const res6 = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
  assert.equal(res6.status, 429, `Attempt 6 should return 429 (still locked), got ${res6.status}`);

  // Correct password should also be locked
  const resCorrect = await f.request('/api/login', { method: 'POST', body: { password } });
  assert.equal(resCorrect.status, 429, `Correct password should also be locked, got ${resCorrect.status}`);
});

test('successful login clears failed attempt counter', async t => {
  const f = await fixture(t);

  // 3 failed attempts
  for (let i = 1; i <= 3; i++) {
    const res = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
    assert.equal(res.status, 401);
  }

  // Successful login should clear counter
  const resSuccess = await f.request('/api/login', { method: 'POST', body: { password } });
  assert.equal(resSuccess.status, 200);

  // Should be able to fail 4 more times before lockout
  for (let i = 1; i <= 4; i++) {
    const res = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
    assert.equal(res.status, 401, `After reset, attempt ${i} should return 401`);
  }

  // 5th attempt should trigger lockout again
  const res5 = await f.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
  assert.equal(res5.status, 429);
});
