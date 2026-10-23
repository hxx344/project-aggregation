import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountConfigurationLock } from '../lib/account-config.ts';

test('account configuration keeps pair ownership, reconciliation and activation locks', () => {
  const paused = { enabled: false, status: 'paused' };
  assert.equal(accountConfigurationLock(paused), '');
  assert.match(
    accountConfigurationLock({ ...paused, pair_id: 'gold' }),
    /配对组「gold」统一管理/,
  );
  assert.match(
    accountConfigurationLock({ ...paused, status: 'reconciling' }),
    /批次核对完成/,
  );
  assert.match(
    accountConfigurationLock({ ...paused, enabled: true }),
    /暂停账户后/,
  );
});
