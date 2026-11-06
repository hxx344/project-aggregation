import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet, getAddress } from 'ethers';
import * as executor from '../tools/aero-roles/executor.mjs';
import { AUTO_DEFAULTS, centeredRange, deviationBps, evaluateAuto, fitToRoom, poolRoom, readAutoState, reopenBudget, roomFullText, strictAutoConfig } from '../server/automation/aero-auto.mjs';
import { addBlockedReason, policyOf, readPolicy, strictPoolPolicy, withPoolPolicy } from '../server/automation/aero-policy.mjs';
import { createAeroSafe } from '../server/automation/aero-safe.mjs';
import { centeredRange as pageCenteredRange } from '../src/aero-market-math.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const permissionsConfig = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
const KEY = '0x' + '55'.repeat(32);
const BOT = new Wallet(KEY);
const SAFE = new Wallet('0x' + '66'.repeat(32)).address;
const ROLES = new Wallet('0x' + '77'.repeat(32)).address;
const POOL = getAddress('0x' + '11'.repeat(20)), T0 = getAddress('0x' + '21'.repeat(20)), T1 = getAddress('0x' + '22'.repeat(20));
const sqrt = (t) => BigInt(Math.round(Math.sqrt(1.0001 ** t) * 2 ** 96));
const MIN = 60_000;

const position = (patch = {}) => ({ tokenId: '7', staked: true, tickLower: -500, tickUpper: 500, liquidity: '1000', amount0: 0, amount1: 2_000_000, tokensOwed0: '0', tokensOwed1: '5', depositBlock: '1', penaltyUntilBlock: null, ...patch });
const snapshot = ({ tick = 1000, positions = [position()], remaining = '1000000000000', blockNumber = 100 } = {}) => ({
  blockNumber,
  allowances: [{ token: T0, symbol: 'T0', remaining }, { token: T1, symbol: 'T1', remaining }],
  pools: [{ address: POOL, token0: T0, token1: T1, tickSpacing: 100, tick, sqrtPriceX96: String(sqrt(tick)), feePips: 500, positions }],
});
const run = (patch = {}) => evaluateAuto({ config: { ...AUTO_DEFAULTS, enabled: true }, chain: snapshot(), outSince: new Map(), history: [], reopen: null, now: 10 * MIN, ...patch });

test('auto config has safe defaults and rejects unknown or out-of-range fields', () => {
  assert.deepEqual(strictAutoConfig({}), { ...AUTO_DEFAULTS });
  assert.equal(AUTO_DEFAULTS.enabled, false);
  assert.equal(AUTO_DEFAULTS.acceptPenalty, false);
  assert.throws(() => strictAutoConfig({ triggerMinutes: 0 }), /出区间等待/);
  assert.throws(() => strictAutoConfig({ maxTwapDeviationBps: 5000 }), /TWAP/);
  assert.throws(() => strictAutoConfig({ enabled: 'yes' }), /布尔/);
  assert.throws(() => strictAutoConfig({ shareBps: 100 }), /未知/);
});

test('the server re-centres a range exactly as the page does', () => {
  for (const s of [1, 10, 50, 200]) for (const tick of [-100_003, -1, 0, 7, 49, 12_345]) for (const cells of [1, 2, 5, 40]) {
    assert.deepEqual(centeredRange(tick, s, cells), pageCenteredRange(tick, s, cells), `${tick}/${s}/${cells}`);
  }
});

test('a staked position is rebalanced only after staying out of range for the trigger time', () => {
  const inside = run({ chain: snapshot({ tick: 0 }) });
  assert.equal(inside.due, null);
  assert.equal(inside.outSince.size, 0);
  const first = run();
  assert.equal(first.due, null); // first sighting starts the clock
  assert.equal(first.watch[0].dueAt, 10 * MIN + 5 * MIN);
  const later = run({ outSince: first.outSince, now: 15 * MIN });
  assert.deepEqual(later.due, { kind: 'rebalance', pool: POOL, tokenId: '7', cells: 10 });
  // back in range resets the clock
  assert.equal(run({ outSince: first.outSince, chain: snapshot({ tick: 0 }), now: 15 * MIN }).outSince.size, 0);
  // the upper edge belongs outside the range
  assert.equal(run({ outSince: new Map([['7', 0]]), chain: snapshot({ tick: 500 }) }).due?.tokenId, '7');
});

test('unstaked or empty positions are left alone', () => {
  const r = run({ outSince: new Map([['7', 0], ['8', 0]]), chain: snapshot({ positions: [position({ staked: false }), position({ tokenId: '8', liquidity: '0' })] }) });
  assert.equal(r.due, null);
  assert.equal(r.watch.length, 0);
  assert.equal(r.note, '没有已质押的头寸');
});

test('penalty, cooldown, daily cap and allowance each hold a due rebalance with a reason', () => {
  const since = new Map([['7', 0]]);
  const penalty = run({ outSince: since, chain: snapshot({ positions: [position({ penaltyUntilBlock: '200' })] }) });
  assert.equal(penalty.due, null);
  assert.match(penalty.note, /罚没期/);
  assert.equal(run({ outSince: since, chain: snapshot({ positions: [position({ penaltyUntilBlock: '200' })] }), config: { ...AUTO_DEFAULTS, enabled: true, acceptPenalty: true } }).due?.tokenId, '7');
  const cooling = run({ outSince: since, history: [{ at: 10 * MIN - 29 * MIN, pool: POOL }] });
  assert.match(cooling.note, /冷却/);
  assert.equal(run({ outSince: since, history: [{ at: 10 * MIN - 31 * MIN, pool: POOL }] }).due?.tokenId, '7');
  const capped = run({ outSince: since, now: 2000 * MIN, history: Array.from({ length: 6 }, (_, i) => ({ at: 2000 * MIN - (100 + i) * MIN, pool: '0xother' })) });
  assert.match(capped.note, /达到上限 6/);
  const short = run({ outSince: since, chain: snapshot({ remaining: '1000' }) });
  assert.match(short.note, /额度不足/);
});

test('a pending reopen comes first and ignores cooldown and the daily cap', () => {
  const r = run({ reopen: { pool: POOL, cells: 10, amount0: '0', amount1: '1' }, history: Array.from({ length: 6 }, () => ({ at: 10 * MIN, pool: POOL })) });
  assert.deepEqual(r.due, { kind: 'reopen', pool: POOL });
});

test('reopen budget counts the swap on both sides and price deviation is symmetric', () => {
  const { need0, need1 } = reopenBudget({ sqrtPriceX96: sqrt(0), feePips: 500, tickLower: -500, tickUpper: 500, amount0: 0n, amount1: 2_000_000n });
  assert.ok(need1 >= 2_000_000n && need0 > 900_000n && need0 < 1_200_000n, `${need0}/${need1}`);
  assert.equal(deviationBps(100, 0), deviationBps(0, 100));
  assert.ok(deviationBps(100, 0) > 99 && deviationBps(100, 0) < 102);
});

test('saved auto state is validated and a malformed reopen record is refused', () => {
  assert.deepEqual(readAutoState({}).config, { ...AUTO_DEFAULTS });
  assert.throws(() => readAutoState({ reopen: { pool: POOL, cells: 0, amount0: '1', amount1: '1' } }), /待重开/);
  assert.throws(() => readAutoState({ reopen: { pool: POOL, cells: 1, amount0: '1', amount1: '1', inflight: 'burn' } }), /待重开/);
  assert.throws(() => readAutoState({ closing: { pool: POOL, tokenId: 'x', cells: 1 } }), /平仓中/);
  assert.throws(() => readAutoState({ halted: { at: 1 } }), /停用记录/); // a halt must not silently disappear
});

test('an interrupted close holds everything until a person looks', () => {
  const r = run({ closing: { pool: POOL, tokenId: '7', cells: 10, at: 0 }, reopen: null });
  assert.equal(r.due, null);
  assert.match(r.note, /#7/);
});

test('the TWAP rounds toward negative infinity like the pool oracle library', async () => {
  const rpc = (tickCumulatives, cardinality = 10, revert = false) => ({
    call: async ({ data }) => {
      const fn = executor.POOL_I.parseTransaction({ data }).name;
      if (fn === 'slot0') return executor.POOL_I.encodeFunctionResult('slot0', [sqrt(-7), -7, 0, cardinality, cardinality, true]);
      if (revert) throw Object.assign(new Error('OLD'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' });
      return executor.POOL_I.encodeFunctionResult('observe', [tickCumulatives, [0, 0]]);
    },
  });
  const ctx = (r) => ({ rpc: r, pools: [{ address: POOL, name: 'T0/T1' }] });
  assert.equal((await executor.poolTwap(ctx(rpc([0, -2101])), POOL, 300)).twap, -8); // -7.003 → -8
  assert.equal((await executor.poolTwap(ctx(rpc([0, -2100])), POOL, 300)).twap, -7);
  assert.equal((await executor.poolTwap(ctx(rpc([0, 2101])), POOL, 300)).twap, 7);
  assert.equal((await executor.poolTwap(ctx(rpc([0, 0], 1)), POOL, 300)).twap, null);
  assert.match((await executor.poolTwap(ctx(rpc([0, 0], 10, true)), POOL, 300)).reason, /不足 300 秒/);
});

// ---- 服务端流程（假链）----
// priced：Safe 余额与代币信息按 state.balances 返回（单池上限要估总资产）；默认与旧测试一样不带代币。
function autoChain({ tick = 1000, twap = 1000, cardinality = 900, openError = null, priced = false } = {}) {
  const calls = [];
  const state = { tick, twap, cardinality, openError, positions: [position()], balances: [10n, 20n, 7n] };
  let counter = 0;
  const sign = async (ctx, hooks, label) => {
    const entry = { hash: `0x${(++counter).toString(16).padStart(64, '0')}`, raw: '0x00', from: BOT.address, nonce: 0, label, maxFeePerGas: '1', maxPriorityFeePerGas: '1', at: ctx.now() };
    await hooks.persistPending(entry);
    await hooks.settle(entry, { status: 1, blockNumber: counter, gasUsed: 1n, fee: 1n });
  };
  const chain = {
    calls, state, ExecError: executor.ExecError, REWARD_TOKEN: executor.REWARD_TOKEN,
    connect: async ({ signer }) => ({ signer, pools: [{ address: POOL, token0: T0, token1: T1, tickSpacing: 100, name: 'T0/T1' }], tokens: priced ? new Map([[T0, { address: T0, symbol: 'T0', decimals: 0 }], [T1, { address: T1, symbol: 'T1', decimals: 0 }]]) : new Map(), now: Date.now,
      permissions: { swaps: [{ tokenIn: T1, tokenOut: T0, tickSpacing: 100 }] } }),
    readState: async () => ({ blockNumber: 100, timestamp: 1, bot: BOT.address, botEth: 1n, latestNonce: 0, pendingNonce: 0, balances: priced ? { [T0]: state.balances[0], [T1]: state.balances[1] } : {},
      allowances: [{ token: T0, symbol: 'T0', perDay: 1n, remaining: 10n ** 15n, maxRefill: 1n, refillAt: null }, { token: T1, symbol: 'T1', perDay: 1n, remaining: 10n ** 15n, maxRefill: 1n, refillAt: null }],
      pools: [{ name: 'T0/T1', address: POOL, gauge: POOL, token0: T0, token1: T1, tickSpacing: 100, sqrtPriceX96: sqrt(state.tick), tick: state.tick, feePips: 500, earned: 0n,
        penalty: { minStakeBlocks: 0n, penaltyRate: 0n }, positions: state.positions.map((p) => ({ ...p, tokenId: BigInt(p.tokenId), liquidity: BigInt(p.liquidity), tokensOwed0: 0n, tokensOwed1: 0n, depositBlock: 1n, penaltyUntilBlock: p.penaltyUntilBlock == null ? null : BigInt(p.penaltyUntilBlock) })) }] }),
    resolvePending: async () => ({ state: 'waiting' }),
    poolTwap: async () => { calls.push('twap'); return { tick: state.tick, sqrtPriceX96: sqrt(state.tick), twap: state.cardinality < 2 ? null : state.twap, cardinality: state.cardinality, reason: state.cardinality < 2 ? '池子只有 1 个价格观测槽，无法核对 TWAP' : null }; },
    // 只问一种代币时按代币返回（撤出换币用），否则按 [T0, T1, AERO]。
    safeBalances: async (ctx, tokens) => { calls.push('balances'); return tokens?.length === 1 ? [tokens[0] === T0 ? state.balances[0] : tokens[0] === T1 ? state.balances[1] : state.balances[2]] : state.balances; },
    locate: async (ctx, tokenId) => ({ pool: ctx.pools[0], position: state.positions.find((p) => p.tokenId === String(tokenId)), staked: true }),
    exitRoute: executor.exitRoute,
    remainingAllowance: async () => state.remaining ?? 10n ** 15n,
    reducePosition: async (ctx, hooks, params) => {
      calls.push(['reduce', params.tokenId, params.shareBps]); await sign(ctx, hooks, '减仓');
      state.balances = [state.balances[0] + 30n, state.balances[1] + 400n, state.balances[2]]; return { reduced: true, restaked: true };
    },
    swap: async (ctx, hooks, params) => {
      calls.push(['swap', params.tokenIn, params.tokenOut, params.amountIn, params.maxImpactBps]);
      if (state.swapError) throw state.swapError;
      await sign(ctx, hooks, '兑换'); return { received: params.amountIn / 2n };
    },
    previewOpen: async (ctx, params) => { calls.push(['preview', params.cap]); return { pool: POOL, tick: state.tick, sqrtPriceX96: sqrt(state.tick), tickLower: params.tickLower, tickUpper: params.tickUpper, amount0: 1n, amount1: 1n, capped: false, swap: null, deposit0: 1n, deposit1: 1n }; },
    closePosition: async (ctx, hooks, params) => {
      calls.push(['close', params.tokenId, params.acceptPenalty]); await sign(ctx, hooks, '平仓');
      state.positions = []; state.balances = [state.balances[0] + 300n, state.balances[1] + 4000n, state.balances[2] + 50n]; return { closed: true };
    },
    sellRewards: async (ctx, hooks, params) => { calls.push(['sell', params.maxAmount]); return { sold: false }; },
    stakePosition: async (ctx, hooks, params) => { calls.push(['stake', params.tokenId]); await sign(ctx, hooks, '质押'); return { staked: true }; },
    openPosition: async (ctx, hooks, params) => {
      calls.push(['open', params.tickLower, params.tickUpper, params.amounts, params.stake]);
      if (state.openError) throw state.openError;
      if (state.swap) {
        hooks.moving?.('swap'); state.beforeSwapSign?.();
        await sign(ctx, hooks, '兑换');
        hooks.swapped?.({ amount0: params.amounts.amount0 - 100n, amount1: params.amounts.amount1 + 250n });
        if (state.afterSwapError) throw state.afterSwapError;
      }
      hooks.moving?.('mint');
      await sign(ctx, hooks, '开仓');
      if (state.afterMintError) throw state.afterMintError;
      state.lastOpen = params;
      hooks.minted?.(9n);
      if (state.stakeError) throw state.stakeError;
      state.positions = [position({ tokenId: '9', tickLower: params.tickLower, tickUpper: params.tickUpper })]; return { tokenId: 9n };
    },
  };
  return chain;
}
async function managed(chain, clock, { readPrices } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-auto-'));
  const manager = createAeroSafe({ dataDir: directory, encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`, decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString(),
    log: silent, chain, makeProvider: () => ({}), now: () => clock.at, ...(readPrices ? { readPrices } : {}) });
  await manager.initialize();
  await manager.save({ rpcUrl: 'https://rpc.example', safe: SAFE, roles: ROLES, permissions: permissionsConfig });
  await manager.setKey(KEY);
  return { manager, directory, saved: () => JSON.parse(readFileSync(join(directory, 'aero-safe/auto.json'), 'utf8')) };
}
async function settled(manager) {
  for (let i = 0; i < 200; i++) { const s = manager.state(); if (s.job?.status !== 'running' && !s.refreshing) return s; await delay(5); }
  throw new Error('job did not finish');
}

test('an out-of-range position is closed and only the withdrawn coins are reopened, centred with the same width and staked', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await manager.tickAuto();
    assert.equal(manager.state().job, null); // disabled by default
    await manager.setAuto({ enabled: true });
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job, null);
    assert.equal(manager.state().auto.watch[0].dueAt, clock.at + 5 * MIN);
    clock.at += 5 * MIN;
    await manager.tickAuto(); await settled(manager);
    const s = manager.state();
    assert.equal(s.job.action, 'rebalance');
    assert.equal(s.job.status, 'done', s.job.error);
    const open = chain.calls.find((c) => c[0] === 'open');
    assert.deepEqual(open, ['open', 500, 1500, { amount0: 300n, amount1: 4000n }, true]);
    assert.deepEqual(chain.calls.filter((c) => typeof c === 'string' || c[0] !== 'open').map((c) => (typeof c === 'string' ? c : c[0])), ['twap', 'twap', 'balances', 'close', 'balances', 'sell', 'twap']);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'sell'), ['sell', 50n]); // only the AERO this close claimed, not the 7 already in the Safe
    const record = saved();
    assert.equal(record.reopen, null);
    assert.equal(record.history.length, 1);
    assert.deepEqual({ closed: record.history[0].closed, opened: record.history[0].opened, tickLower: record.history[0].tickLower }, { closed: '7', opened: '9', tickLower: 500 });
    // the new position is in range: nothing more to do
    chain.calls.length = 0;
    clock.at += 60 * MIN;
    await manager.tickAuto(); await settled(manager);
    assert.equal(chain.calls.length, 0);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a price away from its TWAP or a pool without observations starts nothing and counts nothing', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ twap: 800 });
  const { manager, directory } = await managed(chain, clock);
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job, null);
    assert.match(manager.state().auto.note, /偏离 5 分钟 TWAP/);
    chain.state.cardinality = 1;
    await manager.tickAuto(); await settled(manager);
    assert.match(manager.state().auto.note, /观测槽/);
    assert.equal(manager.state().auto.history.length, 0);
    assert.equal(manager.state().auto.halted, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a failed reopen stops auto with the coins recorded; re-enabling retries only the reopen', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ openError: new executor.ExecError('开仓：本地权限校验拒绝第 1 笔（超额度），未签名') });
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().auto.halted.reason, /超额度/);
    assert.deepEqual(saved().reopen, { pool: POOL, cells: 10, amount0: '300', amount1: '4000', closed: '7', at: clock.at, minted: null, inflight: null });
    chain.calls.length = 0;
    await manager.tickAuto(); await settled(manager);
    assert.equal(chain.calls.length, 0); // halted until a person re-enables it
    chain.state.openError = null;
    await manager.setAuto({ enabled: true });
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.equal(chain.calls.some((c) => c[0] === 'close'), false);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 300n, amount1: 4000n });
    assert.equal(saved().reopen, null);
    assert.equal(saved().history.length, 1); // the retry is the same rebalance
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a TWAP miss after closing keeps auto on and the reopen pending', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  const { manager, directory, saved } = await managed(chain, clock);
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.twap = 0; return r; };
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.equal(manager.state().auto.halted, null);
    assert.ok(saved().reopen);
    chain.state.twap = 1000;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.equal(saved().reopen, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('an unreadable auto record halts auto and cannot be switched back on from the page', async () => {
  const clock = { at: 1_000_000 };
  const directory = mkdtempSync(join(tmpdir(), 'aero-auto-'));
  mkdirSync(join(directory, 'aero-safe'), { recursive: true });
  writeFileSync(join(directory, 'aero-safe/auto.json'), '{"reopen":{"pool":"x","cells":0}}');
  const manager = createAeroSafe({ dataDir: directory, encrypt: (v) => v, decrypt: (v) => v, log: silent, chain: autoChain(), makeProvider: () => ({}), now: () => clock.at });
  try {
    await manager.initialize();
    assert.match(manager.state().auto.halted.reason, /无法读取/);
    await assert.rejects(manager.setAuto({ enabled: true }), /无法读取/);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

const due = async (manager, clock) => { await manager.setAuto({ enabled: true }); await settled(manager); await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager); };

test('a close stopped by maintenance before anything was signed is rolled back and retried later', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.closePosition = async () => { chain.calls.push('close'); throw new executor.ExecError('解押：工作台正在维护或隔离恢复，未签名', { code: 'halted' }); };
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.equal(manager.state().job.status, 'failed');
    assert.equal(manager.state().auto.halted, null);
    assert.equal(saved().closing, null);
    assert.equal(saved().history.length, 0); // no cooldown or daily count for a no-op
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a close interrupted after unstaking halts auto, cannot be re-enabled until discarded, and survives a restart', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.closePosition = async (ctx, hooks) => {
    chain.calls.push('close');
    const entry = { hash: '0x' + 'ab'.repeat(32), raw: '0x00', from: BOT.address, nonce: 0, label: '解押', maxFeePerGas: '1', maxPriorityFeePerGas: '1', at: ctx.now() };
    await hooks.persistPending(entry); await hooks.settle(entry, { status: 1, blockNumber: 1, gasUsed: 1n, fee: 1n });
    throw new executor.ExecError('平仓：工作台正在维护或隔离恢复，未签名', { code: 'halted' });
  };
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.match(manager.state().auto.halted.reason, /平仓 #7 时中断/);
    assert.deepEqual(saved().closing, { pool: POOL, tokenId: '7', cells: 10, at: clock.at });
    await assert.rejects(manager.setAuto({ enabled: true }), /平仓 #7 时中断/);
    // a restart keeps it held
    await manager.close();
    const again = createAeroSafe({ dataDir: directory, encrypt: (v) => v, decrypt: (v) => v, log: silent, chain, makeProvider: () => ({}), now: () => clock.at });
    await again.initialize();
    assert.match(again.state().auto.halted.reason, /平仓 #7 时中断/);
    await again.discardAuto();
    assert.equal(saved().closing, null);
    await again.setAuto({ enabled: true });
    assert.equal(again.state().auto.halted, null);
    await again.close();
  } finally { rmSync(directory, { recursive: true }); }
});

test('a new position minted but not staked is only staked on retry, never opened twice', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.stakeError = new executor.ExecError('质押：工作台正在维护或隔离恢复，未签名', { code: 'halted' });
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.equal(manager.state().job.status, 'failed');
    assert.equal(manager.state().auto.halted, null);
    assert.equal(saved().reopen.minted, '9');
    assert.equal(saved().reopen.inflight, null);
    chain.state.stakeError = null; chain.calls.length = 0;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'stake'), ['stake', 9n]);
    assert.equal(saved().reopen, null);
    assert.equal(saved().history[0].opened, '9');
    assert.equal(saved().history[0].tickLower, 500);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a mint signed with an unknown result halts auto and blocks re-enabling', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.afterMintError = new executor.ExecError('开仓（0x…）等待回执超时，结果未知；待链上确认后再继续', { signed: true, code: 'unknown' });
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.equal(saved().reopen.inflight, 'mint');
    assert.match(manager.state().auto.halted.reason, /开仓交易已签名但结果未确认/);
    await assert.rejects(manager.setAuto({ enabled: true }), /结果未确认/);
    await manager.discardAuto();
    assert.equal(saved().reopen, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a reward sale signed with an unknown result halts auto with the pre-sale amounts kept', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.sellRewards = async () => { throw new executor.ExecError('兑换 AERO → T1（0x…）结果未知', { signed: true, code: 'unknown' }); };
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.match(manager.state().auto.halted.reason, /结果未知/);
    assert.deepEqual({ a0: saved().reopen.amount0, a1: saved().reopen.amount1, inflight: saved().reopen.inflight }, { a0: '300', a1: '4000', inflight: null });
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('an update cannot stop the workbench while a rebalance is running', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  let release;
  const gate = new Promise((r) => { release = r; });
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { await gate; return close(...args); };
  const { manager, directory } = await managed(chain, clock);
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto();
    assert.equal(manager.state().job.status, 'running');
    await assert.rejects(manager.prepareStop(), /自动调仓正在执行/);
    release(); await settled(manager);
    await manager.prepareStop();
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('after a confirmed balancing swap the reopen keeps the swapped amounts and a retry never swaps the old amounts again', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.swap = true;
  chain.state.afterSwapError = new executor.ExecError('开仓：工作台正在维护或隔离恢复，未签名', { code: 'halted' });
  const { manager, directory, saved } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.equal(manager.state().auto.halted, null);
    assert.deepEqual({ a0: saved().reopen.amount0, a1: saved().reopen.amount1, inflight: saved().reopen.inflight }, { a0: '200', a1: '4250', inflight: null });
    chain.state.afterSwapError = null; chain.state.swap = false; chain.calls.length = 0;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 200n, amount1: 4250n });
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a swap signed with an unknown result is recorded before broadcast and halts auto', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.swap = true;
  const { manager, directory, saved } = await managed(chain, clock);
  chain.state.beforeSwapSign = () => { chain.state.inflightAtSign = saved().reopen?.inflight ?? null; };
  const sign = chain.openPosition;
  chain.openPosition = async (ctx, hooks, params) => {
    const wrapped = { ...hooks, swapped: () => { throw new executor.ExecError('兑换（0x…）结果未知', { signed: true, code: 'unknown' }); } };
    return sign(ctx, wrapped, params);
  };
  try {
    await due(manager, clock);
    assert.equal(saved().reopen.inflight, 'swap');
    assert.match(manager.state().auto.halted.reason, /配平兑换交易已签名但结果未确认/);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a reward sale adds what it bought to the reopen amounts', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.sellRewards = async (ctx, hooks, params) => { chain.calls.push(['sell', params.maxAmount]); chain.state.balances = [chain.state.balances[0], chain.state.balances[1] + 60n, chain.state.balances[2] - params.maxAmount]; return { sold: true }; };
  const { manager, directory } = await managed(chain, clock);
  try {
    await due(manager, clock);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 300n, amount1: 4060n });
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('if the auto record cannot be written nothing is closed or broadcast', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  const { manager, directory } = await managed(chain, clock);
  const file = join(directory, 'aero-safe/auto.json');
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN;
    rmSync(file); mkdirSync(file); // rename onto a directory fails
    await manager.tickAuto(); await settled(manager);
    assert.equal(chain.calls.some((c) => c[0] === 'close'), false);
    assert.match(manager.state().auto.halted.reason, /写入失败/);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('an inflight mark that cannot be written stops the transaction before broadcast', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.swap = true;
  const { manager, directory, saved } = await managed(chain, clock);
  const file = join(directory, 'aero-safe/auto.json');
  let persisted = 0;
  chain.state.beforeSwapSign = () => { rmSync(file); mkdirSync(file); };
  const open = chain.openPosition;
  chain.openPosition = async (ctx, hooks, params) => open(ctx, { ...hooks, persistPending: (e) => { const r = hooks.persistPending(e); persisted++; return r; } }, params);
  try {
    await due(manager, clock);
    assert.equal(persisted, 0); // the swap was never handed to the pending record, so never broadcast
    assert.equal(manager.state().job.signed, true); // the close before it was
    assert.equal(manager.state().auto.reopen.inflight, null);
    assert.match(manager.state().auto.halted.reason, /写入失败/);
    rmSync(file, { recursive: true });
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
  void saved;
});

test('a reopen record cannot be discarded while its transaction is still unsettled', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain();
  chain.state.afterMintError = new executor.ExecError('开仓（0x…）等待回执超时，结果未知；待链上确认后再继续', { signed: true, code: 'unknown' });
  const { manager, directory } = await managed(chain, clock);
  const open = chain.openPosition;
  // leave the mint pending: persist but never settle
  chain.openPosition = async (ctx, hooks, params) => open(ctx, { ...hooks, settle: () => {} }, params);
  try {
    await due(manager, clock);
    assert.ok(manager.state().pending);
    await assert.rejects(manager.discardAuto(), /尚未结清/);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

// ---- 仓位策略与单池美元上限 ----
const USD1 = (at) => ({ at, usd: { [T0.toLowerCase()]: 1, [T1.toLowerCase()]: 1 } });
const withTokens = (chain, balances = ['10', '20']) => ({ ...chain, tokens: [{ address: T0, symbol: 'T0', decimals: 0, balance: balances[0] }, { address: T1, symbol: 'T1', decimals: 0, balance: balances[1] }] });
const outOfRange = new Map([['7', 0]]);
const policyFor = (capUsd, patch = {}) => ({ pools: { [POOL.toLowerCase()]: { state: 'active', capUsd, auto: true, ...patch } } });
const capped = (capUsd, patch = {}) => run({ policy: policyFor(capUsd), chain: withTokens(snapshot()), prices: USD1(10 * MIN), outSince: outOfRange, ...patch });
const setCap = (manager, capUsd, patch = {}) => manager.setPolicy({ pool: POOL, state: 'active', capUsd, auto: true, ...patch });

test('pool policies are validated, keyed by lower-case address, and defaults are not stored', () => {
  assert.deepEqual(strictPoolPolicy({ pool: POOL, state: 'reduce', capUsd: 1234.5, auto: false }), { pool: POOL.toLowerCase(), state: 'reduce', capUsd: 1234.5, auto: false });
  for (const [patch, reason] of [
    [{ state: 'paused' }, /状态/], [{ auto: 'yes' }, /布尔/], [{ capUsd: 0 }, /单池上限/], [{ capUsd: -1 }, /单池上限/], [{ capUsd: 1.234 }, /两位小数/],
    [{ capUsd: '100' }, /单池上限/], [{ capUsd: 2e12 }, /单池上限/], [{ pool: '0x12' }, /池子地址/], [{ extra: 1 }, /未知/],
  ]) assert.throws(() => strictPoolPolicy({ pool: POOL, state: 'active', capUsd: null, auto: true, ...patch }), reason);
  const one = withPoolPolicy({ pools: {} }, strictPoolPolicy({ pool: POOL, state: 'stopped', capUsd: null, auto: true }));
  assert.deepEqual(Object.keys(one.pools), [POOL.toLowerCase()]);
  assert.deepEqual(withPoolPolicy(one, strictPoolPolicy({ pool: POOL, state: 'active', capUsd: null, auto: true })).pools, {}); // 改回默认即删除
  assert.deepEqual(policyOf(one, POOL.toUpperCase().replace('0X', '0x')), { state: 'stopped', capUsd: null, auto: true });
  assert.deepEqual(policyOf(one, T0), { state: 'active', capUsd: null, auto: true });
  assert.match(addBlockedReason(one, POOL), /已停止.*不能开仓或加仓/);
  assert.equal(addBlockedReason(one, T0), null);
  assert.match(addBlockedReason({ pools: {}, corrupt: '坏了' }, T0), /坏了/);
  // 读文件时任何一条不合规都整体报错，不能当作不限
  assert.deepEqual(readPolicy({ schema: 1, pools: one.pools }), one);
  assert.throws(() => readPolicy({ pools: {} }), /格式/);
  assert.throws(() => readPolicy({ schema: 1, pools: { [getAddress('0x' + 'ab'.repeat(20))]: { state: 'active', capUsd: null, auto: true } } }), /地址无效/); // 必须小写
  assert.throws(() => readPolicy({ schema: 1, pools: { [POOL.toLowerCase()]: { state: 'active', capUsd: 0, auto: true } } }), /单池上限/);
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, { state: 'stopped', capUsd: null, auto: true }]));
  assert.throws(() => readPolicy({ schema: 1, pools: many }), /超过 100/);
  // 旧的按比例上限项不再是自动调仓配置
  assert.throws(() => strictAutoConfig({ poolCapBps: 5000 }), /未知/);
});

test('the pool room is the cap minus this pool\'s other positions, and shrinking never adds coins', () => {
  const chain = withTokens(snapshot({ positions: [position(), position({ tokenId: '8', tickLower: 900, tickUpper: 1100, amount0: 100, amount1: 200, tokensOwed0: '1', tokensOwed1: '0' })] }));
  const room = poolRoom({ chain, prices: USD1(0), pool: POOL, capUsd: 1000, exclude: '7', now: 0 });
  assert.equal(room.error, null);
  assert.equal(room.inPoolUsd, 301);
  assert.equal(room.roomUsd, 1000 - 301);
  assert.deepEqual([room.usd0, room.usd1], [1, 1]);
  assert.equal(poolRoom({ chain, prices: USD1(0), pool: POOL, capUsd: 1000, now: 0 }).inPoolUsd, 301 + 2_000_005);
  const fit = fitToRoom({ amount0: 300n, amount1: 4000n, token0: T0, token1: T1, room: { roomUsd: 1000 }, valueOf: room.valueOf });
  assert.deepEqual([fit.amount0, fit.amount1, fit.capped], [69n, 930n, true]); // 1000/4300，向下取整
  const kept = fitToRoom({ amount0: 300n, amount1: 4000n, token0: T0, token1: T1, room: { roomUsd: 5000 }, valueOf: room.valueOf });
  assert.deepEqual([kept.amount0, kept.amount1, kept.capped], [300n, 4000n, false]);
  // Safe 余额读不到不影响；头寸数量未读到时不猜
  assert.equal(poolRoom({ chain: withTokens(snapshot(), [null, '20']), prices: USD1(0), pool: POOL, capUsd: 10, now: 0 }).error, null);
  assert.match(poolRoom({ chain: withTokens(snapshot({ positions: [position({ amount0: null })] })), prices: USD1(0), pool: POOL, capUsd: 10, now: 0 }).error, /数量未读到/);
  assert.match(poolRoom({ chain: withTokens(snapshot()), prices: USD1(0), pool: T0, capUsd: 10, now: 0 }).error, /没有这个池子/);
  assert.equal(roomFullText({ inPoolUsd: 1234.4, capUsd: 1000 }), '本池其他头寸约 $1,234，已达上限 $1,000');
});

test('a capped pool waits without prices, with stale or missing prices, or when its other positions already fill the cap', () => {
  assert.equal(run({ outSince: outOfRange }).due?.kind, 'rebalance'); // 不限时不需要价格
  for (const [patch, reason] of [
    [{ prices: null }, /没有 Aero 行情价格/],
    [{ prices: USD1(10 * MIN - 61 * MIN) }, /61 分钟未更新/],
    [{ prices: { at: 10 * MIN, usd: { [T0.toLowerCase()]: 1 } } }, /没有 T1 的美元价/],
  ]) {
    const r = capped(5_000_000, patch);
    assert.equal(r.due, null);
    assert.match(r.watch[0].blocked, reason);
  }
  const full = capped(2_000_000, { chain: withTokens(snapshot({ positions: [position(), position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0: 3_000_000, amount1: 0 })] })) });
  assert.equal(full.due, null);
  assert.match(full.watch[0].blocked, /已达上限 \$2,000,000.*不调仓/);
  // 别的池子设了上限，本池仍不限
  const other = run({ policy: { pools: { [T0.toLowerCase()]: { state: 'active', capUsd: 1, auto: true } } }, chain: withTokens(snapshot()), prices: null, outSince: outOfRange });
  assert.equal(other.due?.kind, 'rebalance');
});

test('a stopped pool or one with auto off is never rebalanced and its out-of-range clock does not run', () => {
  for (const [rule, reason] of [[{ state: 'stopped' }, /已停止/], [{ auto: false }, /关闭了自动调仓/]]) {
    const r = run({ policy: policyFor(null, rule), outSince: outOfRange });
    assert.equal(r.due, null);
    assert.match(r.watch[0].blocked, reason);
    assert.equal(r.watch[0].dueAt, null);
    assert.equal(r.outSince.size, 0); // 恢复后重新计时，不会一恢复就立刻调仓
  }
  // 只减不加的池子照常调仓
  assert.equal(run({ policy: policyFor(null, { state: 'reduce' }), outSince: outOfRange }).due?.kind, 'rebalance');
  // 待重开的池子被停止：不重开，等恢复或放弃记录
  const reopen = { pool: POOL, cells: 10, amount0: '300', amount1: '4000', closed: '7', at: 0, minted: null, inflight: null };
  const held = run({ policy: policyFor(null, { state: 'stopped' }), chain: withTokens(snapshot({ positions: [] })), reopen });
  assert.equal(held.due, null);
  assert.match(held.note, /已停止.*收回的币留在 Safe/);
  // 策略文件损坏时什么都不做
  const corrupt = run({ policy: { pools: {}, corrupt: '仓位策略无法读取' }, outSince: outOfRange });
  assert.equal(corrupt.due, null);
  assert.equal(corrupt.note, '仓位策略无法读取');
});

test('the allowance check uses the amounts already shrunk to the cap', () => {
  const [tickLower, tickUpper] = centeredRange(1000, 100, 10);
  const full = reopenBudget({ sqrtPriceX96: sqrt(1000), feePips: 500, tickLower, tickUpper, amount0: 0n, amount1: 2_000_005n });
  const remaining = String((full.need0 > full.need1 ? full.need0 : full.need1) - 1n);
  const chain = withTokens(snapshot({ remaining }));
  assert.match(run({ chain, outSince: outOfRange }).watch[0].blocked, /额度不足/);
  assert.equal(capped(250_000, { chain }).due?.kind, 'rebalance');
});

test('a pool with only a sliver of room is not closed', () => {
  const other = (amount0) => withTokens(snapshot({ positions: [position(), position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0, amount1: 0 })] }));
  // 上限 1,900,020 减去本池其他头寸约 1,800,005，剩约 100,015，不到可重开 2,000,005 的 10%
  const sliver = capped(1_900_020, { chain: other(1_800_000) });
  assert.equal(sliver.due, null);
  assert.match(sliver.watch[0].blocked, /剩余空间约 \$100,015，不到.*\$2,000,005 的 10%（本池上限 \$1,900,020）.*不调仓/);
  assert.equal(capped(1_900_020, { chain: other(1_500_000) }).due?.kind, 'rebalance');
});

test('a pending reopen of a capped pool waits for prices instead of starting a job', () => {
  const reopen = { pool: POOL, cells: 10, amount0: '300', amount1: '4000', closed: '7', at: 0, minted: null, inflight: null };
  const chain = withTokens(snapshot({ positions: [] }));
  const waiting = capped(5000, { chain, reopen, prices: null });
  assert.equal(waiting.due, null);
  assert.match(waiting.note, /没有 Aero 行情价格.*暂不重开/);
  assert.equal(capped(5000, { chain, reopen }).due?.kind, 'reopen');
  assert.equal(capped(5000, { chain, reopen: { ...reopen, minted: '9' }, prices: null }).due?.kind, 'reopen'); // 已开出，只差质押
  assert.equal(run({ chain, reopen, prices: null }).due?.kind, 'reopen'); // 不限时不需要价格
  assert.equal(capped(5000, { chain, reopen: { ...reopen, pool: T0 }, prices: null }).due?.kind, 'reopen'); // 池子已移出白名单：交给执行停用
  assert.equal(readAutoState({ reopen: { ...reopen, capped: true } }).reopen.capped, true);
  assert.equal('capped' in readAutoState({ reopen }).reopen, false);
});

test('a capped reopen invests only up to the pool cap and leaves the rest in the Safe', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  const { manager, directory } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await setCap(manager, 2165);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'aero-safe/policy.json'), 'utf8')), { schema: 1, pools: { [POOL.toLowerCase()]: { state: 'active', capUsd: 2165, auto: true } } });
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    const s = manager.state();
    assert.equal(s.job.status, 'done', s.job.error);
    // 收回的 300 + 4000 按 2165/4300 缩减
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')[3], { amount0: 151n, amount1: 2013n });
    assert.equal(s.job.result.capped, true);
    assert.ok(s.events.some((e) => e.event === 'auto_pool_capped'));
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a capped reopen retried after its balancing swap is still recorded as capped', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  chain.state.swap = true;
  chain.state.afterSwapError = new executor.ExecError('开仓：工作台正在维护或隔离恢复，未签名', { code: 'halted' });
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await setCap(manager, 2165);
    // 等启用时排队的那一轮检查跑完，免得它在失败后立刻重试一次
    await manager.setAuto({ enabled: true }); await settled(manager); await delay(30);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().auto.halted, null);
    assert.deepEqual([saved().reopen.amount0, saved().reopen.amount1, saved().reopen.capped], ['51', '2263', true]);
    // 重试前调高了上限，兑换后的数量已在上限内，不会再被缩减，但这次调仓仍记为缩减过
    await setCap(manager, 3000);
    chain.state.afterSwapError = null; chain.state.swap = false; chain.calls.length = 0;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 51n, amount1: 2263n });
    assert.equal(manager.state().job.result.capped, true);
    assert.equal(saved().history[0].capped, true);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a capped reopen that never swapped is not marked capped once the cap is lifted', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.twap = 0; return r; };
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await setCap(manager, 2165);
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.match(manager.state().job.error, /TWAP/);
    assert.ok(manager.state().events.some((e) => e.event === 'auto_pool_capped')); // 第一轮确实缩减过
    assert.equal('capped' in saved().reopen, false);
    chain.state.twap = 1000; chain.calls.length = 0;
    await setCap(manager, null);
    assert.equal(manager.state().policy.pools[POOL.toLowerCase()], undefined);
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 300n, amount1: 4000n });
    assert.equal(manager.state().job.result.capped, false);
    assert.equal(saved().history[0].capped, undefined);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a reopen left with only a sliver of room halts with the coins kept in the Safe', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  const close = chain.closePosition;
  // 平仓后同池有人手动开了 3,600 的头寸：上限 3,965 − 3,600 = 365，不到可重开 4,300 的 10%
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.positions = [position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0: 3600, amount1: 0 })]; return r; };
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await setCap(manager, 3965);
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().auto.halted.reason, /剩余空间约 \$365，不到.*未重开，收回的币留在 Safe/);
    assert.ok(saved().reopen);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a missing price after closing keeps auto on and the reopen pending; a full pool halts with the coins left in the Safe', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  let prices = true;
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => (prices ? USD1(clock.at) : null) });
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { const r = await close(...args); prices = false; return r; };
  try {
    await setCap(manager, 2165);
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().job.error, /没有 Aero 行情价格.*暂不重开/);
    assert.equal(manager.state().auto.halted, null);
    assert.equal(manager.state().job.signed, true); // 平仓已签名，重开缺价仍只是等待
    assert.deepEqual([saved().reopen.amount0, saved().reopen.amount1], ['300', '4000']);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
    // 价格没恢复时只更新状态说明，不再启动注定失败的任务
    const events = manager.state().events.length;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().events.length, events);
    assert.match(manager.state().auto.note, /没有 Aero 行情价格.*暂不重开/);
    // 价格恢复前有人在同池手动开了大头寸：本池已满，停用等人工处理，币留在 Safe
    prices = true;
    chain.state.positions = [position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0: 100_000, amount1: 0 })];
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().auto.halted.reason, /已达上限.*收回的币留在 Safe/);
    assert.ok(saved().reopen);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('stopping a pool after a close holds its reopen without halting; resuming reopens', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.twap = 0; return r; };
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await manager.setAuto({ enabled: true }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.ok(saved().reopen); // TWAP 不过，平仓后待重开
    chain.state.twap = 1000; chain.calls.length = 0;
    await setCap(manager, null, { state: 'stopped' });
    await manager.tickAuto(); await settled(manager);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
    assert.equal(manager.state().auto.halted, null);
    assert.match(manager.state().auto.note, /已停止.*收回的币留在 Safe/);
    await setCap(manager, null);
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.equal(saved().reopen, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('an old ratio cap halts a running auto on upgrade and is dropped from auto.json; an unreadable policy blocks adds and auto', async () => {
  const clock = { at: 1_000_000 };
  const directory = mkdtempSync(join(tmpdir(), 'aero-auto-'));
  const make = () => createAeroSafe({ dataDir: directory, encrypt: (v) => v, decrypt: (v) => v, log: silent, chain: autoChain(), makeProvider: () => ({}), now: () => clock.at });
  const file = join(directory, 'aero-safe/auto.json');
  mkdirSync(join(directory, 'aero-safe'), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify({ schema: 1, config: { ...AUTO_DEFAULTS, enabled: true, poolCapBps: 5000, poolCaps: {} }, history: [], halted: null, reopen: null, closing: null }));
    let manager = make(); await manager.initialize();
    assert.match(manager.state().auto.halted.reason, /按池子设置美元上限/);
    assert.equal('poolCapBps' in JSON.parse(readFileSync(file, 'utf8')).config, false);
    await manager.close();
    // 旧版本的「不限」不算设过上限：照常运行
    writeFileSync(file, JSON.stringify({ schema: 1, config: { ...AUTO_DEFAULTS, enabled: true, poolCapBps: 10_000, poolCaps: {} }, history: [], halted: null, reopen: null, closing: null }));
    manager = make(); await manager.initialize();
    assert.equal(manager.state().auto.halted, null);
    await manager.close();
    // 策略文件损坏：保留文件，不能保存策略，开仓预览被拒
    writeFileSync(join(directory, 'aero-safe/policy.json'), '{"schema":1,"pools":{"x":1}}');
    manager = make(); await manager.initialize();
    assert.match(manager.state().policy.corrupt, /policy\.json 无法读取/);
    await assert.rejects(setCap(manager, 10), /policy\.json/);
    await manager.save({ rpcUrl: 'https://rpc.example', safe: SAFE, roles: ROLES, permissions: permissionsConfig });
    await assert.rejects(manager.preview({ pool: POOL, tickLower: -500, tickUpper: 500 }), /policy\.json/);
    assert.equal(readFileSync(join(directory, 'aero-safe/policy.json'), 'utf8'), '{"schema":1,"pools":{"x":1}}');
    await manager.close();
  } finally { rmSync(directory, { recursive: true }); }
});

// ---- 手动开仓、加仓按仓位策略核对 ----
test('opening is refused in a stopped or reduce-only pool and is shrunk to the room left under the cap', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  let prices = USD1(clock.at);
  const { manager, directory } = await managed(chain, clock, { readPrices: () => prices });
  const params = { pool: POOL, tickLower: -500, tickUpper: 500 };
  try {
    await setCap(manager, null, { state: 'reduce' });
    await assert.rejects(manager.preview(params), /只减不加.*不能开仓或加仓/);
    await setCap(manager, null, { state: 'stopped' });
    await assert.rejects(manager.preview(params), /已停止/);
    // 本池已有 2,000,000（假链不带未领手续费）：上限 2,000,000 时已满
    await setCap(manager, 2_000_000);
    await assert.rejects(manager.preview(params), /已达上限 \$2,000,000/);
    await setCap(manager, 2_000_100);
    const preview = await manager.preview(params);
    assert.deepEqual(preview.limit, { capUsd: 2_000_100, inPoolUsd: 2_000_000, roomUsd: 100 });
    assert.deepEqual(chain.calls.at(-1), ['preview', { usd: 100, usd0: 1, usd1: 1 }]);
    // 页面填的投入上限更小时用它
    await manager.preview({ ...params, cap: { usd: 40, usd0: 2, usd1: 3 } });
    assert.deepEqual(chain.calls.at(-1), ['preview', { usd: 40, usd0: 1, usd1: 1 }]);
    // 缺价时不开
    prices = null;
    await assert.rejects(manager.preview(params), /没有 Aero 行情价格.*未开仓/);
    // 执行时也按最新状态核对：预览之后改成只减不加，开仓不签名
    prices = USD1(clock.at);
    await setCap(manager, null, { state: 'reduce' });
    await manager.execute('open', { ...params, expect: { previewedAt: clock.at, amount0: '1', amount1: '1' } }); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().job.error, /只减不加/);
    assert.equal(manager.state().job.signed, false);
    assert.equal(chain.state.lastOpen, undefined);
    // 不限、运行时照常开，投入不额外缩减
    await setCap(manager, null);
    await manager.execute('open', { ...params, expect: { previewedAt: clock.at, amount0: '1', amount1: '1' } }); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.equal(chain.state.lastOpen.cap, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

// ---- 减仓、平仓换币、整池平仓 ----
test('a partial reduce keeps the NFT and swaps only the coins it brought back, up to the remaining allowance', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  const { manager, directory } = await managed(chain, clock);
  try {
    await manager.execute('reduce', { tokenId: '7', shareBps: 2500, exitToken: T0 }); await settled(manager);
    let job = manager.state().job;
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'reduce'), ['reduce', 7n, 2500]);
    // 减仓收回 400 个 T1，全部换成 T0；价格冲击上限默认 1%
    assert.deepEqual(chain.calls.find((c) => c[0] === 'swap'), ['swap', T1, T0, 400n, 100]);
    assert.deepEqual([job.result.exit.amountIn, job.result.exit.received, job.result.exit.reason], ['400', '200', null]);
    // 额度只剩 150：只换 150，其余留在 Safe
    chain.state.remaining = 150n; chain.calls.length = 0;
    await manager.execute('reduce', { tokenId: '7', shareBps: 2500, exitToken: T0 }); await settled(manager);
    job = manager.state().job;
    assert.deepEqual(chain.calls.find((c) => c[0] === 'swap'), ['swap', T1, T0, 150n, 100]);
    assert.equal(job.result.exit.left, '250');
    assert.match(job.result.exit.reason, /额度只够兑换一部分/);
    // 额度用完：不兑换，任务仍算完成
    chain.state.remaining = 0n; chain.calls.length = 0;
    await manager.execute('reduce', { tokenId: '7', shareBps: 2500, exitToken: T0 }); await settled(manager);
    assert.equal(manager.state().job.status, 'done');
    assert.equal(chain.calls.some((c) => c[0] === 'swap'), false);
    assert.match(manager.state().job.result.exit.reason, /额度已用完/);
    // 价格冲击过大（未签名）：撤出已完成，币留在 Safe
    chain.state.remaining = null; chain.state.swapError = new executor.ExecError('价格冲击约 3%，超过上限 1%，未兑换', { code: 'impact' });
    await manager.execute('reduce', { tokenId: '7', shareBps: 2500, exitToken: T0 }); await settled(manager);
    job = manager.state().job;
    assert.equal(job.status, 'done');
    assert.match(job.result.exit.reason, /T1 → T0 未兑换：价格冲击约 3%.*留在 Safe/);
    assert.equal(job.result.exit.left, '400');
    // 兑换签名后结果未知：照常报错
    chain.state.swapError = new executor.ExecError('兑换回执超时', { signed: true });
    await manager.execute('reduce', { tokenId: '7', shareBps: 2500, exitToken: T0 }); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.equal(manager.state().job.signed, true);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a missing exit route is refused before anything is signed; 100% reduce closes', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  const { manager, directory } = await managed(chain, clock);
  try {
    await manager.execute('close', { tokenId: '7', exitToken: T1 }); await settled(manager);
    const job = manager.state().job;
    assert.equal(job.status, 'failed');
    assert.match(job.error, /白名单里没有 T0 → T1 的兑换路径/);
    assert.equal(job.signed, false);
    assert.equal(chain.calls.some((c) => c[0] === 'close'), false);
    await assert.rejects(manager.execute('close', { tokenId: '7', exitToken: '0x12' }), /要换成的代币/);
    await manager.execute('reduce', { tokenId: '7', shareBps: 10_000 }); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'close'), ['close', 7n, false]);
    assert.equal(chain.calls.some((c) => c[0] === 'reduce'), false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('exiting a whole pool checks every penalty before signing, then closes each position and swaps once', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position(), position({ tokenId: '8', penaltyUntilBlock: '200' })];
  const close = chain.closePosition;
  chain.closePosition = async (ctx, hooks, params) => { const left = chain.state.positions.filter((p) => p.tokenId !== String(params.tokenId)); const r = await close(ctx, hooks, params); chain.state.positions = left; return r; };
  const { manager, directory } = await managed(chain, clock);
  try {
    await manager.execute('exitPool', { pool: POOL, exitToken: T0 }); await settled(manager);
    let job = manager.state().job;
    assert.equal(job.status, 'failed');
    assert.match(job.error, /#8 仍在提前解押罚没期内/);
    assert.equal(job.signed, false);
    assert.equal(chain.calls.some((c) => c[0] === 'close'), false);
    await manager.execute('exitPool', { pool: POOL, exitToken: T0, acceptPenalty: true }); await settled(manager);
    job = manager.state().job;
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(chain.calls.filter((c) => c[0] === 'close'), [['close', 7n, true], ['close', 8n, true]]);
    assert.deepEqual(job.result.closed, ['7', '8']);
    assert.deepEqual(chain.calls.filter((c) => c[0] === 'swap'), [['swap', T1, T0, 8000n, 100]]);
    await manager.execute('exitPool', { pool: POOL }); await settled(manager);
    assert.match(manager.state().job.error, /没有头寸/);
    await manager.execute('exitPool', { pool: T0 }); await settled(manager);
    assert.match(manager.state().job.error, /不在白名单/);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});
