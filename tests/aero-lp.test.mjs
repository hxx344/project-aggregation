import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { belowTwap, emissionApr, emissionPerDay, feeApr, feeRate, nearestUsableTick, parseLedger, planCycle, positionAmounts, rangeState, summarizeLedger, targetRange, tickToPrice } from '../tools/aero-lp/core.mjs';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { connect, execute, readRewards, reconcileLedger } from '../tools/aero-lp/chain.mjs';
import { validateSettings } from '../tools/aero-lp/core.mjs';

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

const sqrtAt = (tick) => 1.0001 ** (tick / 2);
const close = (actual, expected, message) => assert.ok(Math.abs(actual / expected - 1) < 1e-9, `${message}: ${actual} != ${expected}`);

test('position amounts: all token0 below the range, all token1 above, both inside', () => {
  const p = { liquidity: 10n ** 18n, tickLower: -337000, tickUpper: UPPER };
  const below = positionAmounts(p, sqrtAt(-337100), 18, 6);
  assert.equal(below.amount1, 0);
  close(below.amount0, 1e18 * (sqrtAt(UPPER) - sqrtAt(-337000)) / (sqrtAt(-337000) * sqrtAt(UPPER)) / 1e18, 'below amount0');
  const above = positionAmounts(p, sqrtAt(UPPER + 100), 18, 6);
  assert.equal(above.amount0, 0);
  close(above.amount1, 1e18 * (sqrtAt(UPPER) - sqrtAt(-337000)) / 1e6, 'above amount1');
  const inside = positionAmounts(p, sqrtAt(-333000), 18, 6);
  assert.ok(inside.amount0 > 0 && inside.amount1 > 0);
});

test('emission APR: live share in range, entry estimate below, zero above, unknown without a price', () => {
  const position = { liquidity: 10n ** 18n, tickLower: -337000, tickUpper: UPPER };
  const common = { rewardPerSecond: 0.1, rewardPrice: 0.5, stakedLiquidity: 9n * 10n ** 18n, position, decimals0: 18, decimals1: 6 };
  const year = 0.1 * 365 * 86_400 * 0.5;
  const inTick = -333000, inSqrt = sqrtAt(inTick);
  const inside = emissionApr({ ...common, price: { tick: inTick, sqrt: inSqrt } });
  const held = positionAmounts(position, inSqrt, 18, 6);
  assert.equal(inside.estimated, false);
  close(inside.apr, (year / 9) / (held.amount0 * tickToPrice(inTick, 18, 6) + held.amount1), 'in-range APR uses L / stakedLiquidity');
  const below = emissionApr({ ...common, price: { tick: -337100, sqrt: sqrtAt(-337100) } });
  const entry = positionAmounts(position, sqrtAt(-337000), 18, 6);
  assert.equal(below.estimated, true);
  close(below.apr, (year / 10) / (entry.amount0 * tickToPrice(-337000, 18, 6)), 'below adds own liquidity and values at the lower bound');
  assert.deepEqual(emissionApr({ ...common, price: { tick: UPPER, sqrt: sqrtAt(UPPER) } }), { apr: 0, estimated: false });
  assert.equal(emissionApr({ ...common, rewardPrice: null, price: { tick: inTick, sqrt: inSqrt } }), null);
});

const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const WALLET = '0x00000000000000000000000000000000000000AA';

test('ledger summary dedupes by hash, skips corrupt lines and other wallets, counts failures', () => {
  const lines = [
    { hash: hash(1), wallet: WALLET, status: 'ok', fee: '100', reward: '5', at: '2026-10-29T10:00:00.000Z' },
    { hash: hash(1).toUpperCase().replace('0X', '0x'), wallet: WALLET, status: 'ok', fee: '100', reward: '5', at: '2026-10-29T10:00:00.000Z' },
    { hash: hash(2), wallet: WALLET.toLowerCase(), status: 'reverted', fee: '40', reward: '0', at: '2026-10-29T09:00:00.000Z' },
    { hash: hash(3), wallet: '0x00000000000000000000000000000000000000bb', status: 'ok', fee: '999', reward: '999' },
    { hash: hash(4), wallet: null, status: 'ok', fee: '7', reward: '7' },
    { hash: hash(6), wallet: WALLET, status: 'missing', fee: '0', reward: '0', at: '2026-10-28T09:00:00.000Z' },
    { hash: hash(5), wallet: WALLET, status: 'ok', fee: '-3', reward: 'x' },
  ].map((e) => JSON.stringify(e));
  const sum = summarizeLedger(parseLedger([...lines, '{broken', ''].join('\n')), WALLET);
  assert.deepEqual(sum, { txs: 4, failed: 2, fee: 140n, reward: 5n, since: '2026-10-28T09:00:00.000Z' });
});

test('ledger reconcile records fees with the L1 fee and reward transfers into the wallet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-lp-ledger-'));
  const XAERO = '0x6CdDa0E730744DC6fF67654B35350Adad05EceE7';
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  const signed = (n, at) => JSON.stringify({ at, event: 'tx_signed', label: `tx ${n}`, hash: hash(n) });
  writeFileSync(join(dir, 'events.1.jsonl'), signed(1, '2026-10-29T11:00:00.000Z') + '\n');
  writeFileSync(join(dir, 'events.jsonl'), [signed(2, '2026-10-29T11:30:00.000Z'), signed(3, '2026-10-27T00:00:00.000Z'), signed(4, '2026-10-29T11:59:00.000Z'), signed(5, '2026-10-29T11:59:00.000Z')].join('\n') + '\n');
  writeFileSync(join(dir, 'txs.jsonl'), JSON.stringify({ hash: hash(5), wallet: WALLET, status: 'ok', fee: '1', reward: '0' }) + '\n');
  const receipts = {
    [hash(1)]: { from: WALLET, status: '0x1', blockNumber: '0x10', gasUsed: '0x64', effectiveGasPrice: '0x2', l1Fee: '0x7', logs: [
      { address: XAERO.toLowerCase(), topics: [topic, pad('0x0000000000000000000000000000000000000001'), pad(WALLET)], data: '0x' + (25n).toString(16).padStart(64, '0') },
      { address: XAERO, topics: [topic, pad(WALLET), pad('0x0000000000000000000000000000000000000002')], data: '0x' + (9n).toString(16).padStart(64, '0') },
      { address: '0x0000000000000000000000000000000000000003', topics: [topic, pad('0x0000000000000000000000000000000000000001'), pad(WALLET)], data: '0x' + (8n).toString(16).padStart(64, '0') },
    ] },
    [hash(2)]: { from: WALLET, status: '0x0', blockNumber: '0x11', gasUsed: '0x10', effectiveGasPrice: '0x3', logs: [] },
  };
  const queried = [];
  const ctx = { rewardTokens: [XAERO], rpc: { send: async (method, [h]) => { assert.equal(method, 'eth_getTransactionReceipt'); queried.push(h); return receipts[h] ?? null; } } };
  const written = [];
  await reconcileLedger(ctx, dir, WALLET, (e) => written.push(e), { now });
  assert.ok(!queried.includes(hash(5)), 'already recorded hashes are not re-read');
  assert.deepEqual(written, [
    { hash: hash(3), at: '2026-10-27T00:00:00.000Z', label: 'tx 3', wallet: WALLET, status: 'missing', fee: '0', reward: '0' },
    { hash: hash(2), at: '2026-10-29T11:30:00.000Z', label: 'tx 2', wallet: WALLET, block: 17, status: 'reverted', fee: '48', reward: '0' },
    { hash: hash(1), at: '2026-10-29T11:00:00.000Z', label: 'tx 1', wallet: WALLET, block: 16, status: 'ok', fee: String(100 * 2 + 7), reward: '25' },
  ], 'newest signatures first; a recent tx without a receipt waits for the next cycle');
});

test('ledger counts a gauge withdraw reward once: xAERO minted and burned elsewhere, new AERO minted to the wallet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-lp-reward-'));
  const NEW = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee', XAERO = '0x6CdDa0E730744DC6fF67654B35350Adad05EceE7', CONVERTER = '0x8c37000000000000000000000000000000000000';
  const now = Date.parse('2026-10-29T12:00:00Z');
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: '2026-10-29T11:00:00.000Z', event: 'tx_signed', label: 'withdraw', hash: hash(7) }) + '\n');
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const amount = '0x' + (59n).toString(16).padStart(64, '0');
  const receipt = { from: WALLET, status: '0x1', blockNumber: '0x20', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [
    { address: XAERO, topics: [topic, pad(ZeroAddress), pad(CONVERTER)], data: amount },
    { address: XAERO, topics: [topic, pad(CONVERTER), pad(ZeroAddress)], data: amount },
    { address: NEW, topics: [topic, pad(ZeroAddress), pad(WALLET)], data: amount },
  ] };
  const ctx = { rewardTokens: [NEW, XAERO], rpc: { send: async () => receipt } };
  const written = [];
  await reconcileLedger(ctx, dir, WALLET, (e) => written.push(e), { now });
  assert.equal(written.length, 1);
  assert.equal(written[0].reward, '59');
});

test('reward reads give up after the time budget instead of delaying the cycle', async () => {
  const never = () => new Promise(() => {});
  const ctx = { pool: { rewardGrowthGlobalX128: never, lastUpdated: never, stakedLiquidity: never, liquidity: never, feeGrowthGlobal0X128: never, feeGrowthGlobal1X128: never }, gauge: { deferredEmissions: never }, aero: { balanceOf: never }, xaero: null, routerFactory: null };
  const started = Date.now();
  await assert.rejects(readRewards(ctx, WALLET, [], 50), /exceeded 50 ms/);
  assert.ok(Date.now() - started < 1000);
});

test('range state follows the pool: lower tick inclusive, upper tick exclusive', () => {
  const p = { tickLower: -337000, tickUpper: -330000 };
  assert.equal(rangeState(p, -337001), 'below', 'a swap landing exactly on the lower bound leaves tick = lower - 1');
  assert.equal(rangeState(p, -337000), 'in');
  assert.equal(rangeState(p, -330001), 'in');
  assert.equal(rangeState(p, -330000), 'above');
});

test('daily AERO estimate: live share in range, entry estimate below, zero above, no price needed', () => {
  const position = { liquidity: 10n ** 18n, tickLower: -337000, tickUpper: UPPER };
  const common = { rewardPerSecond: 0.1, stakedLiquidity: 9n * 10n ** 18n, position };
  const day = 0.1 * 86_400;
  const inside = emissionPerDay({ ...common, price: { tick: -333000 } });
  close(inside.perDay, day / 9, 'in range: L / stakedLiquidity');
  assert.equal(inside.estimated, false);
  const below = emissionPerDay({ ...common, price: { tick: -337100 } });
  close(below.perDay, day / 10, 'below adds own liquidity');
  assert.equal(below.estimated, true);
  assert.deepEqual(emissionPerDay({ ...common, price: { tick: UPPER } }), { perDay: 0, estimated: false });
  assert.equal(emissionPerDay({ ...common, rewardPerSecond: null, price: { tick: -333000 } }), null);
});

test('fee APR if unstaked: share of current active liquidity in range, entry estimate below, zero above', () => {
  const position = { liquidity: 10n ** 18n, tickLower: -337000, tickUpper: UPPER };
  const common = { feesPerSecond0: 2e18, feesPerSecond1: 3e6, activeLiquidity: 10n * 10n ** 18n, position, decimals0: 18, decimals1: 6 };
  const inTick = -333000, inSqrt = sqrtAt(inTick), px = tickToPrice(inTick, 18, 6);
  const inside = feeApr({ ...common, price: { tick: inTick, sqrt: inSqrt } });
  const held = positionAmounts(position, inSqrt, 18, 6);
  close(inside.apr, (2 * px + 3) / 10 * 365 * 86_400 / (held.amount0 * px + held.amount1), 'in range: L / active liquidity of the pool fees');
  assert.equal(inside.estimated, false);
  const below = feeApr({ ...common, price: { tick: -337100, sqrt: sqrtAt(-337100) } });
  const lowPx = tickToPrice(-337000, 18, 6), entry = positionAmounts(position, sqrtAt(-337000), 18, 6);
  close(below.apr, (2 * lowPx + 3) / 11 * 365 * 86_400 / (entry.amount0 * lowPx), 'below: own liquidity added, valued at the lower bound');
  assert.equal(below.estimated, true);
  assert.deepEqual(feeApr({ ...common, price: { tick: UPPER, sqrt: sqrtAt(UPPER) } }), { apr: 0, estimated: false });
  assert.equal(feeApr({ ...common, feesPerSecond0: null, price: { tick: inTick, sqrt: inSqrt } }), null);
  assert.equal(feeApr({ ...common, activeLiquidity: 0n, price: { tick: inTick, sqrt: inSqrt } }), null, 'no active liquidity: share unknown');
});

test('fee rate weights each growth step by the thinner of its two liquidity readings, averaged over samples 5 minutes apart', () => {
  const memory = {}, Q = 2n ** 128n, min = 60_000, L = 10n ** 18n;
  assert.equal(feeRate(memory, 0n, 0n, L, 0n, 0), null, 'first sample has no window yet');
  // A big per-unit jump next to thin liquidity counts at the thin side, not the deeper reading.
  assert.equal(feeRate(memory, 600n * Q, 0n, 100n * L, 0n, 4 * min), null, 'under 5 minutes');
  assert.equal(memory.feeSamples.length, 1, 'samples closer than 5 minutes are not kept');
  const r = feeRate(memory, 606n * Q, 1n * Q, 100n * L, 0n, 10 * min);
  assert.equal(r.seconds, 600);
  close(r.perSecond0, (600 * 1e18 + 6 * 100e18) / 600, 'step growth × min(liquidity before, after)');
  close(r.perSecond1, 100e18 / 600, 'token1');
  assert.equal(feeRate(memory, 605n * Q, 1n * Q, 100n * L, 0n, 11 * min), r, 'a lagging read is skipped and the last result kept');
  assert.equal(memory.feeLast.g0, 606n * Q);
  for (let t = 15; t <= 26 * 60; t += 5) feeRate(memory, 606n * Q, 1n * Q, L, 0n, t * min);
  assert.ok(memory.feeSamples[0].at >= 2 * 60 * min && 26 * 60 * min - memory.feeSamples[1].at < 24 * 60 * min, 'window trimmed to about 24 hours');
  const thinning = {};
  feeRate(thinning, 0n, 0n, 100n * L, 0n, 0);
  close(feeRate(thinning, 6n * Q, 0n, L, 0n, 5 * min).perSecond0, 6e18 / 300, 'liquidity thinned during the step: weighted by the thin reading');
});

test('fee rate leaves out time when all active liquidity is staked: fees then go to the gauge only', () => {
  const memory = {}, Q = 2n ** 128n, min = 60_000, L = 10n ** 18n;
  feeRate(memory, 0n, 0n, L, 0n, 0);
  feeRate(memory, 0n, 0n, L, L, 10 * min);
  feeRate(memory, 0n, 0n, L, L, 20 * min);
  assert.equal(feeRate(memory, 0n, 0n, L, 0n, 25 * min), null, 'only fully staked steps so far: nothing measurable');
  const r = feeRate(memory, 3n * Q, 0n, L, 0n, 30 * min);
  assert.equal(r.seconds, 300, 'only the step with unstaked liquidity at both ends counts');
  close(r.perSecond0, 3e18 / 300, 'rate over the measurable time');
});

test('AERO is priced from the deeper legacy token; the new token only when the legacy one has no route', async () => {
  const NEW = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee', LEGACY = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
  const quotes = { [NEW]: 900_000n, [LEGACY]: 661_459n };
  const ctx = {
    pool: { rewardGrowthGlobalX128: async () => 0n, lastUpdated: async () => 1n, stakedLiquidity: async () => 0n, liquidity: async () => 0n, feeGrowthGlobal0X128: async () => 0n, feeGrowthGlobal1X128: async () => 0n },
    gauge: { deferredEmissions: async () => 0n }, aero: { balanceOf: async () => 5n }, xaero: null,
    routerFactory: '0x' + '55'.repeat(20), token1: '0x' + '66'.repeat(20), decimals1: 6,
    router: { getAmountsOut: async (amount, [route]) => [amount, quotes[route.from]] },
  };
  assert.equal((await readRewards(ctx, WALLET, [])).price, 0.661459, 'a thin new-token pool does not override the 1:1 legacy quote');
  quotes[LEGACY] = 0n;
  assert.equal((await readRewards(ctx, WALLET, [])).price, 0.9);
  ctx.pool.feeGrowthGlobal0X128 = async () => { throw new Error('rate limited'); };
  const partial = await readRewards(ctx, WALLET, []);
  assert.equal(partial.feeGrowth0, null, 'a failed fee read only blanks the fee data');
  assert.equal(partial.aero, 5n);
});

// 只读调用按函数名应答的假 RPC：可以伪造任意只读结果，用来确认签名目标只取自配置。
function fakeRpc(answers) {
  const iface = new Interface([
    'function token0() view returns (address)', 'function token1() view returns (address)', 'function tickSpacing() view returns (int24)',
    'function gauge() view returns (address)', 'function factory() view returns (address)', 'function getPool(address, address, int24) view returns (address)',
    'function nft() view returns (address)', 'function pool() view returns (address)', 'function gaugeFactory() view returns (address)',
    'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  ]);
  return {
    send: async () => '0x2105',
    call: async (tx) => {
      const fn = iface.getFunction(tx.data.slice(0, 10));
      if (!fn || !(fn.name in answers)) throw new Error(`unexpected call ${tx.data.slice(0, 10)}`);
      return iface.encodeFunctionResult(fn, [answers[fn.name]]);
    },
  };
}

test('approve target comes from config: an RPC that reports another gauge is refused', async () => {
  const config = validateSettings(JSON.parse(readFileSync(new URL('../tools/aero-lp/config.example.json', import.meta.url), 'utf8')), { extra: ['keyFile', 'address', 'dataDir'] });
  const answers = {
    token0: config.token, token1: config.token1, tickSpacing: config.tickSpacing, gauge: config.gauge, factory: config.factory,
    getPool: config.pool, nft: config.nft, pool: config.pool, gaugeFactory: '0x' + '33'.repeat(20), decimals: 18, symbol: 'X',
  };
  const ctx = await connect(config, { provider: fakeRpc(answers) });
  assert.equal(ctx.addresses.gauge, getAddress(config.gauge));
  assert.equal(ctx.gauge.target, getAddress(config.gauge));
  assert.equal(ctx.nft.target, getAddress(config.nft));
  assert.ok(ctx.rewardTokens.includes('0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee'), 'rewards minted as the new AERO count in the ledger');
  const forged = '0x' + '44'.repeat(20);
  // 伪造的 gauge 自报的 pool/nft 也全部「匹配」，仍然拒绝连接。
  await assert.rejects(connect(config, { provider: fakeRpc({ ...answers, gauge: forged }) }), /config\.gauge/);
  // mint 按 (token0, token1, tickSpacing) 定位池子：RPC 自报的另一组（连同伪造的 getPool）同样拒绝。
  assert.equal(ctx.token1, getAddress(config.token1)); assert.equal(ctx.spacing, config.tickSpacing);
  await assert.rejects(connect(config, { provider: fakeRpc({ ...answers, token1: forged }) }), /config\.token1/);
  await assert.rejects(connect(config, { provider: fakeRpc({ ...answers, tickSpacing: 200 }) }), /config\.tickSpacing/);
});

test('a hold arriving before signing stops the cycle without signing or logging a stake failure', async () => {
  let signed = 0;
  const events = [];
  const tx = { populateTransaction: async () => ({}) };
  const ctx = {
    runner: { populateTransaction: async (t) => t, signTransaction: async () => { signed++; return '0x'; } },
    nft: { getApproved: async () => ZeroAddress, approve: tx },
    gauge: { deposit: tx, withdraw: tx },
    addresses: { gauge: '0x' + '55'.repeat(20) },
  };
  const plan = { actions: [{ type: 'stake', tokenId: 7n }, { type: 'close', tokenId: 8n, staked: true }] };
  await assert.rejects(execute(ctx, (e) => events.push(e), ZeroAddress, plan, { halted: () => true }), (error) => error.halted === true && error.signed === false);
  assert.equal(signed, 0);
  assert.deepEqual(events, []);
});
