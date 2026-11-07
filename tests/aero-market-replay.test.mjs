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
  const r = run(series([TICK, ...flat(6, TICK + up)], { emission: 0 }), { cells: 0 });
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
  assert.equal(run(series([TICK])).status, 'insufficient_history', 'one sample is not a path');
  assert.equal(run(series(flat(3)), { deposit: 0 }), null);
  assert.ok(MIN_REPLAY_HOURS >= 1);
  const huge = run(series(flat(9)), { cells: 2 * 887272 });
  assert.ok(huge && Number.isFinite(huge.net) && huge.rebalances === 0, 'cells beyond the usable range are clamped to full range');
});

test('only adjacent valid hourly intervals count, and a gap starts a new position in the latest segment', () => {
  const sparse = series(flat(2)); sparse.slots = [0, 8 * HOUR];
  const a = run(sparse);
  assert.equal(a.status, 'insufficient_history'); assert.equal(a.net, null);
  assert.equal(a.naturalHours, 8); assert.equal(a.validHours, 0); assert.equal(a.gapHours, 8); assert.equal(a.hours, 0);
  const interrupted = series([...flat(7), ...flat(7, TICK + 900)]);
  interrupted.slots = [...Array.from({ length: 7 }, (_, i) => i * HOUR), ...Array.from({ length: 7 }, (_, i) => (10 + i) * HOUR)];
  const b = run(interrupted), latest = run(series(flat(7, TICK + 900)));
  assert.equal(b.status, 'complete'); assert.equal(b.from, 10 * HOUR); assert.equal(b.to, 16 * HOUR);
  assert.equal(b.naturalHours, 16); assert.equal(b.validHours, 12); assert.equal(b.gapHours, 4); assert.equal(b.hours, 6);
  close(b.net, latest.net); close(b.cost, latest.cost); assert.equal(b.rebalances, 0, 'no guessed exit across the missing path');
  interrupted.slots.pop(); for (const field of ['ticks', 'staked', 'usd0', 'usd1', 'emission', 'vol']) interrupted[field].pop();
  assert.equal(run(interrupted).status, 'insufficient_history', 'an older long segment cannot hide the latest short segment');
  assert.equal(run(series(flat(6))).net, null, 'six points only cover five intervals');
  assert.equal(run(series(flat(7))).hours, MIN_REPLAY_HOURS, 'seven points cover six intervals');
  const noPrice = series(flat(9)); noPrice.usd1[4] = NaN;
  assert.equal(run(noPrice).status, 'insufficient_history'); assert.equal(run(noPrice).gapHours, 2);
  const offHour = series(flat(9)); offHour.slots[4] += 1;
  assert.equal(run(offHour).status, 'insufficient_history');
});

test('rebalance costs below, at and above equity never create negative liquidity or later emissions', () => {
  for (const intra of [false, true]) {
    const s = series(intra ? flat(9) : [TICK + 5, ...flat(8, TICK + 400)], { vol: intra ? 0.2 : 1e-6 });
    for (const fraction of [0.5, 1, 2]) {
      const r = run(s, { cells: intra ? 1 : 20, costFraction: fraction, delaySec: 0 });
      assert.ok(r.cost >= 0 && r.emission >= 0);
      close(r.net, r.emission - r.impermanent - r.cost);
      if (fraction < 1) {
        assert.equal(r.status, 'complete'); assert.equal(r.hours, 8); assert.notEqual(r.apr, null);
      } else {
        assert.equal(r.status, 'cost_exhausted'); assert.equal(r.hours, 1); assert.equal(r.to, HOUR); assert.equal(r.apr, null);
        close(r.emission, intra ? 36 : 18);
        assert.equal(r.rebalances, intra ? 0 : 1); assert.equal(r.intraHour, intra ? 1 : 0);
        const atLimit = run(s, { cells: intra ? 1 : 20, costFraction: 1, delaySec: 0 });
        close(r.cost, atLimit.cost); close(r.net, atLimit.net, 1e-12);
        if (intra) close(r.net + 10_000, r.emission, 1e-12);
      }
    }
  }
  const tiny = run(series(flat(9), { vol: 0.2 }), { cells: 1, deposit: 1e-9, costFraction: 0.2 / 1e-9, delaySec: 0 });
  assert.equal(tiny.status, 'cost_exhausted'); close(tiny.cost, 1e-9, 1e-15);
  assert.equal(tiny.hours, 1); assert.ok(Number.isFinite(tiny.net));
  const dust = run(series(flat(9), { vol: 0.2 }), { cells: 1, deposit: Number.MIN_VALUE, costFraction: Infinity, delaySec: 0 });
  assert.equal(dust.status, 'cost_exhausted'); assert.equal(dust.hours, 1); assert.ok(dust.cost >= 0 && Number.isFinite(dust.net));
});
