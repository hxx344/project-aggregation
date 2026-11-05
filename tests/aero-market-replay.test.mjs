import test from 'node:test';
import assert from 'node:assert/strict';
import { centeredRange, MIN_REPLAY_HOURS, rebalanceCostFraction, replayPool } from '../server/research/aero-market-replay.mjs';
import { centeredRange as pageCenteredRange, rebalanceCostOf } from '../src/aero-market-math.ts';

const HOUR = 3600, TICK = -197000;
// WETH/USDC 式池子：token1 每原始单位 1e-6 美元。
const POOL = { tickSpacing: 10, decimals0: 18, decimals1: 6 };
const series = (ticks, { emission = 0.01, staked = 0, vol = 0.02, usd1 = 1 } = {}) => ({
  slots: ticks.map((_, i) => i * HOUR), ticks, staked: ticks.map(() => staked), usd0: ticks.map(() => NaN), usd1: ticks.map(() => usd1),
  emission: ticks.map(() => emission), vol: ticks.map(() => vol),
});
const flat = (n, tick = TICK + 5) => Array.from({ length: n }, () => tick);
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
const run = (s, extra = {}) => replayPool(s, { ...POOL, cells: 20, costFraction: 0.002, deposit: 10_000, delaySec: 300, ...extra });

test('server copies of centeredRange and the rebalance cost match the page', () => {
  for (const [tick, s, cells] of [[TICK, 10, 1], [TICK + 3, 10, 7], [-5, 1, 2], [887, 200, 64], [-196256, 100, 3]]) assert.deepEqual(centeredRange(tick, s, cells), pageCenteredRange(tick, s, cells));
  const Q96 = 2 ** 96;
  const pool = { chain: 'base', fee: 500, liquidity: '5000000000000000', sqrtPriceX96: BigInt(Math.round(Math.sqrt(1.0001 ** -196256) * Q96)).toString(),
    token0: { decimals: 18, usd: 3000 }, token1: { decimals: 6, usd: 1 } };
  for (const p of [pool, { ...pool, chain: 'ethereum' }, { ...pool, fee: null }, { ...pool, liquidity: '0' }, { ...pool, token1: { decimals: 6, usd: null } }]) {
    for (const deposit of [100, 20_000, 1e6]) close(rebalanceCostFraction(p, deposit), rebalanceCostOf(p, deposit).total);
  }
});

test('a still price only earns emissions: the whole stream when alone, diluted by staked liquidity otherwise', () => {
  const alone = run(series(flat(25), { vol: 1e-6 }));
  assert.equal(alone.rebalances, 0);
  close(alone.hours, 24);
  close(alone.emission, 0.01 * 24 * HOUR, 1e-6);
  close(alone.net, alone.emission, 1e-6);
  assert.ok(Math.abs(alone.impermanent) < 1e-6 && alone.cost < 1e-6);
  close(alone.apr, (alone.net / 10_000) * 365);
  const crowded = run(series(flat(25), { vol: 1e-6, staked: 1e30 }));
  assert.ok(crowded.emission < alone.emission / 100, 'a huge staked liquidity takes nearly all of it');
});

test('leaving the range rebalances once at the hour, pays the cost and keeps net = emission − impermanent − cost', () => {
  const ticks = [...flat(10), ...flat(15, TICK + 400)];
  const r = run(series(ticks, { vol: 1e-6 }));
  assert.equal(r.rebalances, 1);
  assert.ok(r.cost > 0.002 * 9_000 && r.cost < 0.002 * 10_500, `cost about 0.2% of the position, got ${r.cost}`);
  assert.ok(r.impermanent > 0, 'selling into the move lags holding');
  close(r.net, r.emission - r.impermanent - r.cost, 1e-9);
  // 出区间那一小时只算一半时间与停摆后的时间。
  close(r.inRange, (24 * HOUR - HOUR / 2 - 300) / (24 * HOUR), 1e-6);
});

test('full range never rebalances and lags holding by the v2 loss', () => {
  // 价格 ×4：全范围仓位价值 / 持有价值 = 2√4 / (1 + 4) = 0.8。
  const up = Math.round(Math.log(4) / Math.log(1.0001));
  const r = run(series([TICK, TICK + up], { emission: 0 }), { cells: 0 });
  assert.equal(r.rebalances, 0); assert.equal(r.intraHour, 0);
  const hold = 10_000 / 2 * 4 + 10_000 / 2;
  close(r.impermanent, hold * 0.2, 1e-3);
});

test('touching an edge between two hourly samples is charged by the Brownian-bridge probability', () => {
  const calm = run(series(flat(25), { vol: 0.001 })), wild = run(series(flat(25), { vol: 0.2 }));
  assert.ok(calm.intraHour < 1e-6 && calm.cost < 1e-3, 'deep inside a ±1% range at 0.1%/day nothing happens');
  assert.ok(wild.intraHour > 5, `at 20%/day a ±1% range is touched most hours, got ${wild.intraHour}`);
  assert.ok(wild.cost > 0 && wild.net < calm.net && wild.inRange < calm.inRange);
});

test('missing emission hours are reported and the start waits for a price', () => {
  const s = series(flat(9));
  s.emission[2] = NaN; s.emission[3] = NaN;
  s.usd1[0] = NaN;
  const r = run(s);
  close(r.hours, 7); close(r.missingHours, 2);
  assert.equal(r.from, HOUR);
  assert.equal(run(series([TICK])), null, 'one sample is not a path');
  assert.equal(run(series(flat(3)), { deposit: 0 }), null);
  assert.ok(MIN_REPLAY_HOURS >= 1);
  const huge = run(series(flat(9)), { cells: 2 * 887272 });
  assert.ok(huge && Number.isFinite(huge.net) && huge.rebalances === 0, 'cells beyond the usable range are clamped to full range');
});
