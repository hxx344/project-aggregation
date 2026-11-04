import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionRate, poolPrice, priceChange, realizedVol, solvePrices, tvlUsd } from '../server/research/aero-market-core.mjs';
import { dilutedApr, expectedDaysInRange, liquidityUnitUsd, netYield, rangeTicks } from '../src/aero-market-math.ts';

const Q96 = 2 ** 96;
const sqrtX96 = (rawPrice) => BigInt(Math.round(Math.sqrt(rawPrice) * Q96)).toString();
const WETH = '0xweth', USDC = '0xusdc', AERO = '0xaero';
const tokens = new Map([[WETH, { decimals: 18 }], [USDC, { decimals: 6 }], [AERO, { decimals: 18 }]]);

test('pool price converts raw sqrtPriceX96 into human token1 per token0', () => {
  assert.ok(Math.abs(poolPrice(sqrtX96(3000 * 1e6 / 1e18), 18, 6) - 3000) < 1e-6);
});

test('prices walk from stables through deep pools and ignore shallow ones', () => {
  const pools = [
    { address: 'p1', token0: WETH, token1: USDC, state: { sqrtPriceX96: sqrtX96(3000e-12), liquidity: '1000000000000000000' } },
    { address: 'p2', token0: AERO, token1: WETH, state: { sqrtPriceX96: sqrtX96(0.0002), liquidity: '100000000000000000000000' } },
    // 价格离谱但深度不足 2000 美元，不能覆盖 WETH 的报价。
    { address: 'p3', token0: WETH, token1: USDC, state: { sqrtPriceX96: sqrtX96(1e-12), liquidity: '1000' } },
  ];
  const prices = solvePrices({ pools, tokens, stables: [USDC] });
  assert.ok(Math.abs(prices.get(WETH).usd - 3000) < 1e-6);
  assert.equal(prices.get(WETH).via, 'p1');
  assert.ok(Math.abs(prices.get(AERO).usd - 0.6) < 1e-9);
  assert.equal(solvePrices({ pools: [pools[2]], tokens, stables: [USDC] }).has(WETH), false);
});

test('TVL refuses to guess when a held token has no price', () => {
  const state = { balance0: String(2e18), balance1: String(1000e6) };
  assert.equal(tvlUsd(state, { decimals: 18 }, { decimals: 6 }, { usd: 3000 }, { usd: 1 }), 7000);
  assert.equal(tvlUsd(state, { decimals: 18 }, { decimals: 6 }, null, { usd: 1 }), null);
  assert.equal(tvlUsd({ balance0: '0', balance1: String(5e6) }, { decimals: 18 }, { decimals: 6 }, null, { usd: 1 }), 5);
});

test('range ticks align to spacing and always contain the current tick', () => {
  assert.deepEqual(rangeTicks(-195_343, 100, 0), [-195_400, -195_300]);
  const [lower, upper] = rangeTicks(-195_343, 100, 0.05);
  assert.ok(Number.isInteger(lower / 100) && Number.isInteger(upper / 100));
  assert.ok(lower < -195_343 && upper > -195_343);
  assert.ok(Math.abs(1.0001 ** (upper + 195_343) - 1.05) < 0.02);
  assert.ok(Math.abs(1.0001 ** (lower + 195_343) - 0.95) < 0.02);
});

test('emission APR dilutes against existing staked liquidity and shrinks with deposit size', () => {
  const s = sqrtX96(3000e-12), tick = Math.floor(Math.log(3000e-12) / Math.log(1.0001));
  const [lower, upper] = rangeTicks(tick, 100, 0.05);
  const unit = liquidityUnitUsd(s, lower, upper, { decimals: 18 }, { decimals: 6 }, { usd: 3000 }, { usd: 1 });
  assert.ok(unit > 0);
  const others = 1000 / unit; // 现有质押流动性正好等于 1000 美元的量
  const small = dilutedApr({ usdPerSecond: 1e-3, competingLiquidity: String(Math.round(others)), unitUsd: unit, deposit: 1000 });
  assert.ok(Math.abs(small - (1e-3 * 365 * 86400 * 0.5) / 1000) / small < 1e-6);
  const big = dilutedApr({ usdPerSecond: 1e-3, competingLiquidity: String(Math.round(others)), unitUsd: unit, deposit: 1_000_000 });
  assert.ok(big < small);
  // 区间越宽同样美元买到的流动性越少。
  const wide = rangeTicks(tick, 100, 0.2);
  assert.ok(liquidityUnitUsd(s, wide[0], wide[1], { decimals: 18 }, { decimals: 6 }, { usd: 3000 }, { usd: 1 }) > unit);
  assert.equal(dilutedApr({ usdPerSecond: 1, competingLiquidity: '0', unitUsd: unit, deposit: 0 }), null);
});

test('emission rate uses the cumulative share delta and rejects a decrease', () => {
  assert.equal(emissionRate({ t: 0, rewardShare: '0' }, { t: 100, rewardShare: String(5n * 10n ** 18n) }), 0.05);
  assert.equal(emissionRate({ t: 0, rewardShare: '10' }, { t: 100, rewardShare: '5' }), null);
  assert.equal(emissionRate({ t: 100, rewardShare: '0' }, { t: 100, rewardShare: '5' }), null);
  assert.equal(emissionRate(null, { t: 100, rewardShare: '5' }), null);
});

test('realized volatility normalizes by actual gaps, skips long gaps and needs enough samples', () => {
  const now = 100 * 3600;
  // 每小时 tick 交替 ±100：对数收益 100·ln(1.0001) ≈ 1%。
  const points = Array.from({ length: 25 }, (_, i) => ({ t: now - (24 - i) * 3600, tick: i % 2 ? 100 : 0 }));
  const vol = realizedVol(points, 86400, now);
  assert.ok(Math.abs(vol.daily - 100 * Math.log(1.0001) * Math.sqrt(24)) < 1e-9);
  assert.equal(vol.samples, 24);
  assert.equal(realizedVol(points.slice(-5), 86400, now), null);
  const gapped = points.filter((_, i) => i < 10 || i > 14);
  assert.equal(realizedVol(gapped, 86400, now).samples, 18);
});

test('expected time in range is largest in the middle and zero at the edge', () => {
  const mid = expectedDaysInRange(0, -500, 500, 0.02), edge = expectedDaysInRange(-450, -500, 500, 0.02);
  const half = 500 * Math.log(1.0001);
  assert.ok(Math.abs(mid - (half * half) / 0.0004) < 1e-9);
  assert.ok(edge < mid);
  assert.equal(expectedDaysInRange(600, -500, 500, 0.02), null);
  assert.equal(expectedDaysInRange(0, -500, 500, null), null);
  assert.ok(Math.abs(priceChange(0, 100) - (1.0001 ** 100 - 1)) < 1e-12);
});

test('net yield: impermanent loss matches the CL position gamma, rebalance follows exit frequency', () => {
  const tick = 0, lower = -500, upper = 500, vol = 0.02;
  // 独立推导：CL 仓位价值 V(P) = L(2√P − √Pa − P/√Pb)，套利损耗速率 = σ²P²|V''|/2 ÷ V（每天）。
  const pa = 1.0001 ** lower, pb = 1.0001 ** upper, V = (P) => 2 * Math.sqrt(P) - Math.sqrt(pa) - P / Math.sqrt(pb);
  const e = 1e-4, gamma = (V(1 + e) - 2 * V(1) + V(1 - e)) / (e * e);
  const daily = (vol * vol * Math.abs(gamma)) / 2 / V(1);
  const result = netYield({ apr: 2, tick, lower, upper, dailyVol: vol, costFraction: 0.001 });
  assert.ok(Math.abs(result.impermanent - 365 * daily) / (365 * daily) < 0.01);
  // 调仓次数 = 365 / 期望在区间天数。
  const days = expectedDaysInRange(tick, lower, upper, vol);
  assert.ok(Math.abs(result.rebalance - (365 / days) * 0.001) < 1e-12);
  assert.ok(Math.abs(result.net - (2 - result.impermanent - result.rebalance)) < 1e-12);
  // 不动的池子没有损耗也不用调仓；缺波动率时不给结果。
  const flat = netYield({ apr: 0.3, tick, lower, upper, dailyVol: 0, costFraction: 0.01 });
  assert.equal(flat.net, 0.3); assert.equal(flat.days, Infinity);
  assert.equal(netYield({ apr: 0.3, tick, lower, upper, dailyVol: null, costFraction: 0 }), null);
  // 排放随区间收窄按 1/宽度 增长：排放强度高于损耗系数时，调仓成本让最佳宽度落在中间而不是越窄越好；
  // 低于损耗系数时各宽度都亏，越宽亏得越少。
  const sweep = (k) => [50, 200, 1000, 5000].map((half) => netYield({ apr: k / half, tick: 0, lower: -half, upper: half, dailyVol: 0.02, costFraction: 0.002 }).net);
  const strong = sweep(1000), weak = sweep(50);
  const best = strong.indexOf(Math.max(...strong));
  assert.ok(best > 0 && best < strong.length - 1 && strong[best] > 0, `interior optimum, got ${strong}`);
  assert.ok(weak.every((v) => v < 0) && weak.indexOf(Math.max(...weak)) === weak.length - 1, `weak emission loses everywhere, got ${weak}`);
});
