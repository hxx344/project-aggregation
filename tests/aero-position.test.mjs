import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PLAN, expectedDaysInRange, positionMetrics, riskVolOf } from '../src/aero-market-math.ts';

// WETH(18)/USDC(6) 池，价格约 3000 USDC/WETH：tick = ln(3000e-12)/ln(1.0001)。
const tick = Math.round(Math.log(3000e-12) / Math.log(1.0001));
const sqrt = (t) => BigInt(Math.round(Math.sqrt(1.0001 ** t) * 2 ** 96)).toString();
const pool = (patch = {}) => ({
  chain: 'base', address: '0xpool', gauge: '0xgauge', tickSpacing: 100,
  token0: { address: '0xweth', symbol: 'WETH', decimals: 18, usd: 3000 }, token1: { address: '0xusdc', symbol: 'USDC', decimals: 6, usd: 1 },
  fee: 500, unstakedFee: null, tick, sqrtPriceX96: sqrt(tick), liquidity: '1000000000000000', stakedLiquidity: '4000000000000000',
  tvlUsd: 1e6, emissionPerSec: 0.01, emissionWindowSec: 604800, vol24h: { daily: 0.02, annual: 0.38, samples: 24 }, vol7d: { daily: 0.03, annual: 0.57, samples: 168 }, change24h: 0.01, ...patch,
});
// 1 WETH + 3000 USDC 的原始单位。
const position = (patch = {}) => ({ tickLower: tick - 500, tickUpper: tick + 500, liquidity: '1000000000000000', staked: true, amount0: 1e18, amount1: 3000e6, depositTime: 1_000_000 - 7200, ...patch });

test('staked in-range position earns its share of staked liquidity', () => {
  const m = positionMetrics(pool(), position(), { aeroUsd: 1.2, chainTime: 1_000_000, snapshotAt: 1_000_000_000 });
  assert.equal(m.inRange, true);
  assert.equal(m.valueUsd, 6000);
  assert.equal(m.share, 0.25);
  assert.ok(Math.abs(m.aeroPerDay - 0.01 * 86400 * 0.25) < 1e-9);
  assert.ok(Math.abs(m.usdPerDay - m.aeroPerDay * 1.2) < 1e-9);
  assert.ok(Math.abs(m.apr - (m.usdPerDay * 365) / 6000) < 1e-9);
  assert.equal(m.daysIn, expectedDaysInRange(tick, tick - 500, tick + 500, riskVolOf(pool())));
  assert.ok(m.yield && m.yield.net < m.apr, 'net yield deducts impermanent loss and rebalancing');
  assert.equal(m.stakedSeconds, 7200);
  // 报价按美元价高的一侧为基准：每 WETH 折合 USDC，下沿低于现价、上沿高于现价。
  assert.ok(Math.abs(m.now - 3000) / 3000 < 1e-3);
  assert.ok(m.low < m.now && m.now < m.high && m.toLow < 0 && m.toHigh > 0);
});

const ctx = { aeroUsd: 1, chainTime: 1_000_000, snapshotAt: 1_000_000_000 };

test('staked duration comes from block timestamps, not a fixed block interval', () => {
  // 0.2 秒出块下 21600 块只有 1.2 小时；按块数乘 2 秒会算成 12 小时。
  const m = positionMetrics(pool(), position({ depositTime: 1_000_000 - 4320 }), ctx);
  assert.equal(m.stakedSeconds, 4320);
  // 质押时间晚于链上快照时间（快照是质押前读的）时不显示负数。
  assert.equal(positionMetrics(pool(), position({ depositTime: 1_000_100 }), ctx).stakedSeconds, 0);
  // 服务端没给质押时间（旧版本或读取失败）时不估算。
  assert.equal(positionMetrics(pool(), position({ depositTime: undefined }), ctx).stakedSeconds, null);
});

test('a market snapshot taken before the stake does not yet include it', () => {
  // 质押时刻 = 1_000_000 − 7200 秒；快照早于它。
  const early = positionMetrics(pool(), position(), { aeroUsd: 1, chainTime: 1_000_000, snapshotAt: (1_000_000 - 7300) * 1000 });
  assert.equal(early.share, 0.2, 'mine / (staked + mine)');
  // 快照里的质押流动性还小于自身时（不含自身），份额不超过 100%。
  const empty = positionMetrics(pool({ stakedLiquidity: '0' }), position(), { aeroUsd: 1, chainTime: null, snapshotAt: null });
  assert.equal(empty.share, 1);
  assert.equal(empty.stakedSeconds, null);
  const capped = positionMetrics(pool({ stakedLiquidity: '1' }), position(), ctx);
  assert.equal(capped.share, 1);
});

test('unstaked position shows the projected share after staking', () => {
  const m = positionMetrics(pool(), position({ staked: false }), { aeroUsd: 1, chainTime: 1_000_000, snapshotAt: 1_000_000_000 }, DEFAULT_PLAN);
  assert.equal(m.projected, true);
  assert.equal(m.share, 0.2);
  assert.equal(m.stakedSeconds, null);
});

test('out-of-range position earns nothing and has no expected stay', () => {
  const m = positionMetrics(pool(), position({ tickLower: tick + 100, tickUpper: tick + 600 }), ctx);
  assert.equal(m.inRange, false);
  assert.equal(m.aeroPerDay, 0);
  assert.equal(m.apr, 0);
  assert.equal(m.daysIn, null);
  assert.equal(m.yield, null);
  assert.ok(m.toLow > 0, 'price must rise to re-enter');
});

test('missing prices or gauge leave estimates empty', () => {
  const m = positionMetrics(pool({ gauge: null }), position(), { ...ctx, aeroUsd: null });
  assert.equal(m.share, null);
  assert.equal(m.aeroPerDay, null);
  assert.equal(m.apr, null);
  const n = positionMetrics(pool({ token1: { address: '0xusdc', symbol: 'USDC', decimals: 6, usd: null } }), position(), ctx);
  assert.equal(n.valueUsd, null);
  assert.equal(n.apr, null);
});
