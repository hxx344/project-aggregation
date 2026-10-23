import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountRunScope } from '../lib/account-scope.ts';

const policy = { symbols: ['XAUUSD1', 'SPCXUSD1', 'CLUSD1'], ordinary_symbol: 'all' };
test('account execution scope follows saved ordinary selection', () => {
  assert.equal(accountRunScope({ policy }), '普通开仓 XAUUSD1 / SPCXUSD1 / CLUSD1');
  assert.equal(accountRunScope({ policy: { ...policy, ordinary_symbol: 'CLUSD1' } }), '普通开仓 CLUSD1');
  assert.equal(accountRunScope({ policy: { symbols: [] } }), '没有可执行品种');
});
