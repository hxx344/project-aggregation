import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../tools/aero-lp/core.mjs';

const position = (overrides = {}) => ({ staked: true, liquidity: 200n, tickLower: 100, tickUpper: 200, ...overrides });
const input = { rewardPerSecond: 1, stakedLiquidity: 100n, price: { tick: 0, sqrt: 1 }, positions: [position(), position()] };

test('two same-lower positions share one entry denominator and cannot exceed pool emissions', () => {
  const total = core.emissionTotalPerDay(input);
  assert.deepEqual(total, { perDay: 69120, scenario: 'same-lower', reason: null });
  assert.ok(total.perDay <= 86400);
  assert.equal(core.emissionPerDay({ ...input, position: input.positions[0] }).perDay, 57600);
});

test('all active positions use existing pool liquidity without adding themselves again', () => {
  const total = core.emissionTotalPerDay({ ...input, stakedLiquidity: 500n, price: { tick: 100, sqrt: 1 } });
  assert.deepEqual(total, { perDay: 69120, scenario: 'current', reason: null });
  assert.equal(core.emissionTotalPerDay({ ...input, stakedLiquidity: 399n, price: { tick: 100 } }).reason, 'invalid-liquidity');
});

test('large BigInt liquidity is summed and compared exactly before computing a display share', () => {
  const positions = [9007199254740995n, 2n].map(liquidity => position({ liquidity, tickLower: 0, tickUpper: 100 }));
  const large = { ...input, positions, stakedLiquidity: 9007199254740997n, price: { tick: 1 } };
  assert.deepEqual(core.emissionTotalPerDay(large), { perDay: 86400, scenario: 'current', reason: null });
  assert.equal(core.emissionTotalPerDay({ ...large, stakedLiquidity: large.stakedLiquidity - 1n }).reason, 'invalid-liquidity', 'one raw liquidity unit above the pool total still fails');
  const entering = core.emissionTotalPerDay({ ...large, price: { tick: -1 } });
  assert.deepEqual(entering, { perDay: 43200, scenario: 'same-lower', reason: null }, 'the entry denominator also sums exact BigInt totals');
});

test('different lower bounds and mixed in/out ranges do not manufacture a common total', () => {
  const different = core.emissionTotalPerDay({ ...input, positions: [position(), position({ tickLower: 110 })] });
  assert.deepEqual(different, { perDay: null, scenario: null, reason: 'different-lower' });
  for (const positions of [[position({ tickLower: -10 }), position()], [position({ tickUpper: -1, tickLower: -20 }), position()]]) {
    assert.deepEqual(core.emissionTotalPerDay({ ...input, positions }), { perDay: null, scenario: null, reason: 'mixed-ranges' });
  }
});

test('zero emissions, missing rate, empty liquidity, above-range and missing price remain distinct', () => {
  assert.deepEqual(core.emissionTotalPerDay({ ...input, rewardPerSecond: 0 }), { perDay: 0, scenario: 'no-emissions', reason: null });
  for (const rewardPerSecond of [null, undefined, NaN, Infinity, -1]) assert.equal(core.emissionTotalPerDay({ ...input, rewardPerSecond }).reason, 'unavailable-rate');
  assert.equal(core.emissionTotalPerDay({ ...input, positions: [position({ liquidity: 0n }), position({ staked: false })] }).reason, 'no-staked');
  assert.deepEqual(core.emissionTotalPerDay({ ...input, price: { tick: 200 } }), { perDay: 0, scenario: 'current', reason: null });
  assert.equal(core.emissionTotalPerDay({ ...input, price: null }).reason, 'unavailable-price');
  assert.equal(core.emissionTotalPerDay({ ...input, rewardPrice: null }).perDay, 69120, 'AERO quantity does not require a fiat quote');
  assert.deepEqual(core.emissionPerDay({ ...input, rewardPerSecond: 0, position: position() }), { perDay: 0, estimated: true });
});
