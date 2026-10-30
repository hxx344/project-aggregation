import test from 'node:test';
import assert from 'node:assert/strict';
import { aeroLpValuation } from '../server/automation/aero-lp-valuation.mjs';

const WALLET = '0x' + 'ab'.repeat(20);
const cycle = (extra = {}) => ({
  at: '2026-10-30T02:00:00.000Z', event: 'cycle', symbols: ['RSGP', 'USDC'], price: 0.002,
  positions: [{ id: '7', staked: true, value: 400 }, { id: '8', staked: false, value: 100 }],
  wallet: { RSGP: '10000.0', USDC: '25.5', ETH: '0.01', AERO: '3.0' },
  rewards: { price: 0.5, pending: '4.0', deferred: '0.0' }, ...extra,
});
const state = (lastCycle, extra = {}) => ({ wallet: WALLET, state: 'running', lastCycle, ...extra });

test('values positions, wallet tokens and unclaimed AERO in USDC, leaving gas ETH out', () => {
  const result = aeroLpValuation(state(cycle()));
  assert.equal(result.error, null);
  assert.equal(result.at, '2026-10-30T02:00:00.000Z');
  // 400 + 100 + 10000 × 0.002 + 25.5 + 3 × 0.5 + 4 × 0.5
  assert.equal(result.total, 549);
  assert.deepEqual(result.details.map(row => [row.account, row.coin]), [
    ['头寸 #7（质押）', 'USDC'], ['头寸 #8', 'USDC'], ['钱包', 'RSGP'], ['钱包', 'USDC'], ['钱包', 'AERO'], ['待领取奖励', 'AERO'],
  ]);
});

test('no wallet is null; anything the cycle could not value yields an error instead of a partial total', () => {
  assert.equal(aeroLpValuation({ wallet: null, state: 'stopped', lastCycle: null }), null);
  const failures = [
    [state(null, { state: 'stopped' }), 'Aero LP 未运行，尚无链上估值'],
    [state(null), 'Aero LP 尚未完成首轮检查'],
    [state(cycle({ rewards: null, rewardsError: 'timeout' })), 'Aero LP 本轮头寸估值读取失败'],
    [state(cycle({ positions: [{ id: '7', staked: true }] })), 'Aero LP 头寸 #7 估值缺失'],
    [state(cycle({ wallet: { RSGP: '1', ETH: '0', AERO: '0' } })), 'Aero LP 钱包 USDC 余额缺失'],
    [state(cycle({ rewards: { price: null, pending: '1.0' } })), 'Aero LP 的 AERO 报价不可用'],
    [state(cycle({ symbols: ['RSGP', 'WETH'] })), 'Aero LP 计价代币不是 USDC，暂不计入'],
  ];
  for (const [input, error] of failures) {
    const result = aeroLpValuation(input);
    assert.equal(result.error, error);
    assert.equal(result.total, null);
  }
  // No AERO held or pending: a missing AERO quote does not block the valuation.
  const quiet = aeroLpValuation(state(cycle({ wallet: { RSGP: '0', USDC: '1', ETH: '0', AERO: '0' }, rewards: { price: null, pending: '0' } })));
  assert.equal(quiet.total, 501);
});
