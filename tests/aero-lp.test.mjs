import assert from 'node:assert/strict';
import test from 'node:test';
import { belowTwap, nearestUsableTick, planCycle, targetRange, tickToPrice } from '../tools/aero-lp/core.mjs';

// RSGP(18) / USDC(6)，tickSpacing 100，上沿 0.005 落在最近格点 -329300（≈0.005005）。
const SPACING = 100;
const UPPER = -329300;
const E18 = 10n ** 18n;
const base = {
  spacing: SPACING, gapBps: 40, upperTick: UPPER, positions: [],
  walletToken0: 0n, keepInWallet: 0n, minDeploy: 1000n * E18,
  penalty: { minStakeBlocks: 0n, penaltyRate: 1_000_000n }, blockNumber: 1000,
};
const pos = (over) => ({ tokenId: 1n, staked: true, tickLower: -337000, tickUpper: UPPER, liquidity: 10n ** 18n, depositBlock: 900n, ...over });
const types = (plan) => plan.actions.map((a) => a.type);

test('upper price 0.005 maps to the nearest usable tick', () => {
  assert.equal(nearestUsableTick(0.005, 18, 6, SPACING), UPPER);
  assert.ok(Math.abs(tickToPrice(UPPER, 18, 6) / 0.005 - 1) < 0.002);
});

test('target lower sits strictly above price, gap applied before rounding up to spacing', () => {
  assert.deepEqual(targetRange({ currentTick: -337050, spacing: SPACING, gapBps: 40, upperTick: UPPER }), { tickLower: -337000, tickUpper: UPPER });
  // 0.4% ≈ 40 ticks：-337030 + 40 越过 -337000，取下一格
  assert.equal(targetRange({ currentTick: -337030, spacing: SPACING, gapBps: 40, upperTick: UPPER }).tickLower, -336900);
  // gap 为 0 且价格正好在格点上时，仍取上方一格，保证单边
  assert.equal(targetRange({ currentTick: -337000, spacing: SPACING, gapBps: 0, upperTick: UPPER }).tickLower, -336900);
  assert.equal(targetRange({ currentTick: UPPER - 10, spacing: SPACING, gapBps: 40, upperTick: UPPER }), null);
});

test('no position: deploys wallet token0 into the target range', () => {
  const plan = planCycle({ ...base, currentTick: -337050, walletToken0: 1_000_000n * E18 });
  assert.deepEqual(plan.actions, [{ type: 'mint', tickLower: -337000, tickUpper: UPPER }]);
});

test('position just above price with unchanged target waits instead of churning', () => {
  const plan = planCycle({ ...base, currentTick: -337050, positions: [pos()] });
  assert.deepEqual(types(plan), []);
  assert.equal(plan.status, '#1:below');
});

test('price drop that lowers the target closes and re-mints', () => {
  const plan = planCycle({ ...base, currentTick: -337150, positions: [pos()] });
  assert.deepEqual(plan.actions, [{ type: 'close', tokenId: 1n, staked: true }, { type: 'mint', tickLower: -337100, tickUpper: UPPER }]);
});

test('in range or above upper holds the position', () => {
  assert.deepEqual(types(planCycle({ ...base, currentTick: -336000, positions: [pos()] })), []);
  const above = planCycle({ ...base, currentTick: UPPER + 50, positions: [pos()] });
  assert.deepEqual(types(above), []);
  assert.equal(above.target, null);
  assert.match(above.notes.join(), /upper bound/);
});

test('recovers interrupted runs: stakes unstaked live NFTs and burns empty ones', () => {
  const plan = planCycle({ ...base, currentTick: -337050, positions: [pos({ tokenId: 2n, staked: false }), pos({ tokenId: 3n, liquidity: 0n, staked: false })] });
  assert.deepEqual(plan.actions, [{ type: 'cleanup', tokenId: 3n, staked: false }, { type: 'stake', tokenId: 2n }]);
});

test('early-unstake penalty window defers the rebalance', () => {
  const penalty = { minStakeBlocks: 200n, penaltyRate: 1_000_000n };
  const deferred = planCycle({ ...base, currentTick: -337150, positions: [pos({ depositBlock: 900n })], penalty, blockNumber: 1000 });
  assert.deepEqual(types(deferred), []);
  assert.match(deferred.notes.join(), /penalty window/);
  const later = planCycle({ ...base, currentTick: -337150, positions: [pos({ depositBlock: 900n })], penalty, blockNumber: 1100 });
  assert.deepEqual(types(later), ['close', 'mint']);
  const zeroRate = planCycle({ ...base, currentTick: -337150, positions: [pos()], penalty: { minStakeBlocks: 200n, penaltyRate: 0n } });
  assert.deepEqual(types(zeroRate), ['close', 'mint']);
});

test('positions with a different upper bound are left alone', () => {
  const plan = planCycle({ ...base, currentTick: -337150, positions: [pos({ tickUpper: -315400 })] });
  assert.deepEqual(types(plan), []);
  assert.match(plan.notes.join(), /ignore #1/);
});

test('idle wallet balance below minDeploy or reserved by keepInWallet is not deployed', () => {
  assert.deepEqual(types(planCycle({ ...base, currentTick: -337050, walletToken0: 999n * E18 })), []);
  assert.deepEqual(types(planCycle({ ...base, currentTick: -337050, walletToken0: 5000n * E18, keepInWallet: 4500n * E18 })), []);
});

test('tick exactly at the lower bound counts as in range', () => {
  const plan = planCycle({ ...base, currentTick: -337000, positions: [pos()] });
  assert.deepEqual(types(plan), []);
  assert.equal(plan.status, '#1:in');
});

test('new wallet balance is deployed even while the existing position is in range', () => {
  const plan = planCycle({ ...base, currentTick: -336000, positions: [pos()], walletToken0: 2000n * E18 });
  assert.deepEqual(plan.actions, [{ type: 'mint', tickLower: -335900, tickUpper: UPPER }]);
});

test('sharp drop below TWAP defers rebalance and new deploys but still recovers staking', () => {
  // 3% ≈ 296 ticks：TWAP -336800 时，-337150 低于 -337096，判为异常下跌
  const guard = { twapTick: -336800, maxTwapDeviationBps: 300 };
  const plan = planCycle({ ...base, ...guard, currentTick: -337150, walletToken0: 5000n * E18, positions: [pos(), pos({ tokenId: 2n, staked: false })] });
  assert.deepEqual(plan.actions, [{ type: 'stake', tokenId: 2n }]);
  assert.match(plan.notes.join(), /below TWAP/);
  // 跌幅在阈值内照常调仓
  assert.deepEqual(types(planCycle({ ...base, ...guard, currentTick: -337050, positions: [pos({ tickLower: -336900 })] })), ['close', 'mint']);
  assert.equal(belowTwap(-337150, null, 300), false);
});

test('unreadable TWAP defers rebalance like a tripped guard', () => {
  const plan = planCycle({ ...base, twapUnavailable: true, maxTwapDeviationBps: 300, currentTick: -337150, walletToken0: 5000n * E18, positions: [pos()] });
  assert.deepEqual(types(plan), []);
  assert.match(plan.notes.join(), /TWAP unavailable/);
});
