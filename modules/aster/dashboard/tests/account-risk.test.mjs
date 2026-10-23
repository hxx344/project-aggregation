import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountRiskView } from '../lib/account-risk.ts';
import { submitConfiguration } from '../lib/configuration-submit.ts';
import { marginLimitFromPercent } from '../lib/policy.ts';

test('missing and invalid account risk limits remain unknown without a savable draft', () => {
  for (const value of [undefined, null, '', ' ', '0', '1.1', '-1', 'NaN']) {
    const view = accountRiskView({ policy: { margin_limit: value } }, 0.52);
    assert.equal(view.marginLimit, null);
    assert.equal(view.marginPercent, null);
    assert.equal(view.marginDraft, '');
    assert.equal(view.highMarginPercent, null);
    assert.equal(view.highMarginLimit, null);
    assert.equal(view.riskAccent, 'muted');
    assert.throws(() => marginLimitFromPercent(view.marginDraft), /风险约束/);
  }
});

test('reported derived limits remain visible but cannot replace a missing base risk limit', () => {
  const view = accountRiskView(
    {
      policy: {},
      risk_limits: { high_leverage: '0.55' },
    },
    0.52,
  );
  assert.equal(view.marginPercent, null);
  assert.equal(view.marginDraft, '');
  assert.equal(view.highMarginPercent, '55');
  assert.equal(view.riskAccent, 'muted');
});

test('confirmed limits preserve exact drafts and existing risk colors', () => {
  const account = {
    policy: { margin_limit: '0.5' },
    risk_limits: { high_leverage: '0.55' },
  };
  for (const [ratio, accent] of [
    [0.49, 'mint'],
    [0.52, 'amber'],
    [0.56, 'danger'],
    [null, 'muted'],
  ]) {
    assert.equal(accountRiskView(account, ratio).riskAccent, accent);
  }
  assert.equal(
    accountRiskView({ policy: { margin_limit: '0.333000000000000001' } }, 0)
      .marginDraft,
    '33.3000000000000001',
  );
});

test('an unknown account risk limit sends no save until the user supplies a value', async () => {
  const view = accountRiskView({ policy: {} }, 0.52);
  const requests = [];
  const errors = [];
  const settings = {
    account: { id: 'one' },
    locked: false,
    changes: () => ({ margin_limit: marginLimitFromPercent(view.marginDraft) }),
    action: async (...args) => {
      requests.push(args);
      return true;
    },
    clearDraft: () => {},
    setNotice: () => {},
    setError: (value) => errors.push(value),
    success: '已保存',
    errorFallback: '无效',
  };
  await submitConfiguration(settings);
  assert.deepEqual(requests, []);
  assert.equal(errors.length, 1);
  await submitConfiguration({
    ...settings,
    changes: () => ({ margin_limit: marginLimitFromPercent('60') }),
  });
  assert.deepEqual(requests, [
    ['/api/accounts/one', { margin_limit: '0.6' }, 'PATCH'],
  ]);
});
