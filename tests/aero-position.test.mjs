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
const position = (patch = {}) => ({ tickLower: tick - 500, tickUpper: tick + 500, liquidity: '1000000000000000', staked: true, amount0: 1e18, amount1: 3000e6, depositBlock: '100', ...patch });

test('staked in-range position earns its share of staked liquidity', () => {
  const m = positionMetrics(pool(), position(), 1.2, 100 + 3600);
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

test('a snapshot older than the stake caps the share at 100%', () => {
  const m = positionMetrics(pool({ stakedLiquidity: '0' }), position(), 1, null);
  assert.equal(m.share, 1);
  assert.equal(m.stakedSeconds, null);
});

test('unstaked position shows the projected share after staking', () => {
  const m = positionMetrics(pool(), position({ staked: false }), 1, 200, DEFAULT_PLAN);
  assert.equal(m.projected, true);
  assert.equal(m.share, 0.2);
  assert.equal(m.stakedSeconds, null);
});

test('out-of-range position earns nothing and has no expected stay', () => {
  const m = positionMetrics(pool(), position({ tickLower: tick + 100, tickUpper: tick + 600 }), 1, 200);
  assert.equal(m.inRange, false);
  assert.equal(m.aeroPerDay, 0);
  assert.equal(m.apr, 0);
  assert.equal(m.daysIn, null);
  assert.equal(m.yield, null);
  assert.ok(m.toLow > 0, 'price must rise to re-enter');
});

test('missing prices or gauge leave estimates empty', () => {
  const m = positionMetrics(pool({ gauge: null }), position(), null, 200);
  assert.equal(m.share, null);
  assert.equal(m.aeroPerDay, null);
  assert.equal(m.apr, null);
  const n = positionMetrics(pool({ token1: { address: '0xusdc', symbol: 'USDC', decimals: 6, usd: null } }), position(), 1, 200);
  assert.equal(n.valueUsd, null);
  assert.equal(n.apr, null);
});
