import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ordinaryAddBlock,
  ordinaryCapacityReady,
} from '../lib/ordinary-add.ts';

test('ordinary selection follows account switches and reset and blocks capacity readiness', () => {
  const selected = { policy: { ordinary_symbol: 'CLUSD1' } };
  assert.equal(ordinaryAddBlock(selected, 'CLUSD1'), null);
  assert.match(ordinaryAddBlock(selected, 'XAUUSD1'), /仅限 CLUSD1/);
  assert.match(ordinaryAddBlock(selected, 'SPCXUSD1'), /禁止 SPCXUSD1/);
  assert.equal(
    ordinaryCapacityReady(
      '999999',
      '10000',
      true,
      ordinaryAddBlock(selected, 'XAUUSD1'),
    ),
    false,
  );
  assert.equal(
    ordinaryAddBlock({ policy: { ordinary_symbol: 'XAUUSD1' } }, 'XAUUSD1'),
    null,
  );
  selected.policy.ordinary_symbol = 'all';
  assert.equal(ordinaryAddBlock(selected, 'XAUUSD1'), null);
  assert.equal(ordinaryAddBlock({ policy: {} }, 'XAUUSD1'), null);
});

test('server ordinary-add restrictions stay with the selected account and symbol', () => {
  const blockedAccount = {
    ordinary_add_blocks: { XAUUSD1: '当前账户有未完成订单，普通加仓已禁用' },
  };
  const ordinaryAccount = {
    ordinary_add_blocks: {},
  };
  assert.equal(
    ordinaryAddBlock(blockedAccount, 'XAUUSD1'),
    blockedAccount.ordinary_add_blocks.XAUUSD1,
  );
  assert.equal(ordinaryAddBlock(blockedAccount, 'CLUSD1'), null);
  assert.equal(ordinaryAddBlock(ordinaryAccount, 'XAUUSD1'), null);
  assert.ok(ordinaryAddBlock(blockedAccount, 'XAUUSD1'));
  assert.equal(ordinaryAddBlock(undefined, 'XAUUSD1'), null);
});

test('sufficient 5x, 10x and 20x public capacities never override an account block', () => {
  const capacities = { 5: '100001', 10: '200002', 20: '300003' };
  for (const capacity of Object.values(capacities)) {
    assert.equal(
      ordinaryCapacityReady(capacity, '10000', true, '账户限制'),
      false,
    );
    assert.equal(ordinaryCapacityReady(capacity, '10000', true, null), true);
    assert.equal(ordinaryCapacityReady(capacity, '10000', false, null), false);
  }
  assert.deepEqual(capacities, { 5: '100001', 10: '200002', 20: '300003' });
  assert.equal(ordinaryCapacityReady('10000', '10000', true, null), false);
  assert.equal(ordinaryCapacityReady(undefined, '10000', true, null), false);
});
