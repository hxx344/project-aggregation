import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet, getAddress } from 'ethers';
import * as executor from '../tools/aero-roles/executor.mjs';
import { AUTO_DEFAULTS, POOL_CAP_NONE, centeredRange, deviationBps, evaluateAuto, fitToRoom, poolCapOf, poolRoom, readAutoState, reopenBudget, roomFullText, storedAutoConfig, strictAutoConfig } from '../server/automation/aero-auto.mjs';
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
    connect: async ({ signer }) => ({ signer, pools: [{ address: POOL, token0: T0, token1: T1, tickSpacing: 100, name: 'T0/T1' }], tokens: priced ? new Map([[T0, { address: T0, symbol: 'T0', decimals: 0 }], [T1, { address: T1, symbol: 'T1', decimals: 0 }]]) : new Map(), now: Date.now }),
    readState: async () => ({ blockNumber: 100, timestamp: 1, bot: BOT.address, botEth: 1n, latestNonce: 0, pendingNonce: 0, balances: priced ? { [T0]: state.balances[0], [T1]: state.balances[1] } : {},
      allowances: [{ token: T0, symbol: 'T0', perDay: 1n, remaining: 10n ** 15n, maxRefill: 1n, refillAt: null }, { token: T1, symbol: 'T1', perDay: 1n, remaining: 10n ** 15n, maxRefill: 1n, refillAt: null }],
      pools: [{ name: 'T0/T1', address: POOL, gauge: POOL, token0: T0, token1: T1, tickSpacing: 100, sqrtPriceX96: sqrt(state.tick), tick: state.tick, feePips: 500, earned: 0n,
        penalty: { minStakeBlocks: 0n, penaltyRate: 0n }, positions: state.positions.map((p) => ({ ...p, tokenId: BigInt(p.tokenId), liquidity: BigInt(p.liquidity), tokensOwed0: 0n, tokensOwed1: 0n, depositBlock: 1n, penaltyUntilBlock: null })) }] }),
    resolvePending: async () => ({ state: 'waiting' }),
    poolTwap: async () => { calls.push('twap'); return { tick: state.tick, sqrtPriceX96: sqrt(state.tick), twap: state.cardinality < 2 ? null : state.twap, cardinality: state.cardinality, reason: state.cardinality < 2 ? '池子只有 1 个价格观测槽，无法核对 TWAP' : null }; },
    safeBalances: async () => { calls.push('balances'); return state.balances; },
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
      hooks.minted(9n);
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

// ---- 单池上限（按总资产比例）----
const USD1 = (at) => ({ at, usd: { [T0.toLowerCase()]: 1, [T1.toLowerCase()]: 1 } });
const withTokens = (chain, balances = ['10', '20']) => ({ ...chain, tokens: [{ address: T0, symbol: 'T0', decimals: 0, balance: balances[0] }, { address: T1, symbol: 'T1', decimals: 0, balance: balances[1] }] });
const outOfRange = new Map([['7', 0]]);
const capped = (bps, patch = {}) => run({ config: { ...AUTO_DEFAULTS, enabled: true, poolCapBps: bps }, chain: withTokens(snapshot()), prices: USD1(10 * MIN), outSince: outOfRange, ...patch });

test('pool caps are validated, keyed by lower-case address, and left out of auto.json at their defaults', () => {
  assert.equal(AUTO_DEFAULTS.poolCapBps, POOL_CAP_NONE);
  assert.throws(() => strictAutoConfig({ poolCapBps: 0 }), /单池上限/);
  assert.throws(() => strictAutoConfig({ poolCapBps: 10_001 }), /单池上限/);
  assert.throws(() => strictAutoConfig({ poolCaps: [] }), /单池上限/);
  assert.throws(() => strictAutoConfig({ poolCaps: { '0x12': 100 } }), /地址无效/);
  assert.throws(() => strictAutoConfig({ poolCaps: { [POOL]: 0 } }), /上限/);
  assert.throws(() => strictAutoConfig({ poolCaps: { [POOL]: 1.5 } }), /上限/);
  assert.throws(() => strictAutoConfig({ poolCaps: { [getAddress('0x' + 'ab'.repeat(20))]: 100, ['0x' + 'ab'.repeat(20)]: 200 } }), /重复/);
  assert.throws(() => strictAutoConfig({ poolCaps: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, 100])) }), /最多/);
  const c = strictAutoConfig({ poolCapBps: 2500, poolCaps: { [POOL]: 4000 } });
  assert.deepEqual(c.poolCaps, { [POOL.toLowerCase()]: 4000 });
  assert.equal(poolCapOf(c, POOL), 4000);
  assert.equal(poolCapOf(c, T0), 2500);
  // 回滚兼容：没用上限时写出的记录与旧版本一致（旧版本拒绝未知配置项）
  assert.deepEqual(Object.keys(storedAutoConfig(strictAutoConfig({}))).sort(), ['acceptPenalty', 'cooldownMinutes', 'enabled', 'maxPerDay', 'maxTwapDeviationBps', 'triggerMinutes', 'twapSeconds']);
  assert.deepEqual(storedAutoConfig(c).poolCaps, { [POOL.toLowerCase()]: 4000 });
  assert.equal(storedAutoConfig(c).poolCapBps, 2500);
  assert.deepEqual(readAutoState({ config: storedAutoConfig(c) }).config, c);
});

test('the pool room counts Safe balances and every position, and shrinking never adds coins', () => {
  const chain = withTokens(snapshot({ positions: [position(), position({ tokenId: '8', tickLower: 900, tickUpper: 1100, amount0: 100, amount1: 200, tokensOwed0: '1', tokensOwed1: '0' })] }));
  const room = poolRoom({ chain, prices: USD1(0), pool: POOL, capBps: 5000, exclude: '7', now: 0 });
  assert.equal(room.error, null);
  assert.equal(room.totalUsd, 30 + 2_000_005 + 301);
  assert.equal(room.inPoolUsd, 301);
  assert.equal(room.roomUsd, room.totalUsd / 2 - 301);
  const fit = fitToRoom({ amount0: 300n, amount1: 4000n, token0: T0, token1: T1, room: { roomUsd: 1000 }, valueOf: room.valueOf });
  assert.deepEqual([fit.amount0, fit.amount1, fit.capped], [69n, 930n, true]); // 1000/4300，向下取整
  const kept = fitToRoom({ amount0: 300n, amount1: 4000n, token0: T0, token1: T1, room: { roomUsd: 5000 }, valueOf: room.valueOf });
  assert.deepEqual([kept.amount0, kept.amount1, kept.capped], [300n, 4000n, false]);
  // 余额或头寸数量未读到时不猜
  assert.match(poolRoom({ chain: withTokens(snapshot(), [null, '20']), prices: USD1(0), pool: POOL, capBps: 5000, now: 0 }).error, /T0 余额未读到/);
  assert.match(poolRoom({ chain: withTokens(snapshot({ positions: [position({ amount0: null })] })), prices: USD1(0), pool: POOL, capBps: 5000, now: 0 }).error, /数量未读到/);
});

test('a capped pool waits without prices, with stale or missing prices, or when its other positions already fill the cap', () => {
  assert.equal(run({ outSince: outOfRange }).due?.kind, 'rebalance'); // 不限时不需要价格
  for (const [patch, reason] of [
    [{ prices: null }, /没有 Aero 行情价格/],
    [{ prices: USD1(10 * MIN - 61 * MIN) }, /61 分钟未更新/],
    [{ prices: { at: 10 * MIN, usd: { [T0.toLowerCase()]: 1 } } }, /没有 T1 的美元价/],
  ]) {
    const r = capped(5000, patch);
    assert.equal(r.due, null);
    assert.match(r.watch[0].blocked, reason);
  }
  const full = capped(5000, { chain: withTokens(snapshot({ positions: [position(), position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0: 3_000_000, amount1: 0 })] })) });
  assert.equal(full.due, null);
  assert.match(full.watch[0].blocked, /已达上限.*50%.*不调仓/);
  // 别的地址设了不限，本池仍按默认上限
  const perPool = run({ config: { ...AUTO_DEFAULTS, enabled: true, poolCapBps: 5000, poolCaps: { [T0.toLowerCase()]: POOL_CAP_NONE } }, chain: withTokens(snapshot()), prices: null, outSince: outOfRange });
  assert.match(perPool.watch[0].blocked, /没有 Aero 行情价格/);
});

test('the allowance check uses the amounts already shrunk to the cap', () => {
  const [tickLower, tickUpper] = centeredRange(1000, 100, 10);
  const full = reopenBudget({ sqrtPriceX96: sqrt(1000), feePips: 500, tickLower, tickUpper, amount0: 0n, amount1: 2_000_005n });
  const remaining = String((full.need0 > full.need1 ? full.need0 : full.need1) - 1n);
  const chain = withTokens(snapshot({ remaining }));
  assert.match(run({ chain, outSince: outOfRange }).watch[0].blocked, /额度不足/);
  assert.equal(capped(1000, { chain }).due?.kind, 'rebalance');
});

test('a capped reopen invests only up to the pool cap and leaves the rest in the Safe', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await manager.setAuto({ enabled: true, poolCapBps: 2000, poolCaps: { [POOL]: 5000 } }); await settled(manager);
    assert.deepEqual(saved().config.poolCaps, { [POOL.toLowerCase()]: 5000 });
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    const s = manager.state();
    assert.equal(s.job.status, 'done', s.job.error);
    // 平仓后总资产 310 + 4020 = 4330，本池上限 50% 即 2165；收回的 300 + 4000 按 2165/4300 缩减
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')[3], { amount0: 151n, amount1: 2013n });
    assert.equal(s.job.result.capped, true);
    assert.equal(saved().history[0].capped, true);
    assert.equal(saved().reopen, null);
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
    await manager.setAuto({ enabled: true, poolCapBps: 5000 }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().auto.halted, null);
    assert.deepEqual([saved().reopen.amount0, saved().reopen.amount1, saved().reopen.capped], ['51', '2263', true]);
    // 重试时总资产变多，兑换后的数量已在上限内，不会再被判为缩减
    chain.state.balances = [chain.state.balances[0], chain.state.balances[1] + 1000n, chain.state.balances[2]];
    chain.state.afterSwapError = null; chain.state.swap = false; chain.calls.length = 0;
    await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'done', manager.state().job.error);
    assert.deepEqual(chain.calls.find((c) => c[0] === 'open')?.[3], { amount0: 51n, amount1: 2263n });
    assert.equal(manager.state().job.result.capped, true);
    assert.equal(saved().history[0].capped, true);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a pool with only a sliver of room is not closed; other unpriced tokens count as zero', () => {
  const other = (amount0) => withTokens(snapshot({ positions: [position(), position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0, amount1: 0 })] }));
  // 总资产约 3,800,040 的 50% 减去本池其他头寸约 1,800,005，剩约 100,015，不到可重开 2,000,005 的 10%
  const sliver = capped(5000, { chain: other(1_800_000) });
  assert.equal(sliver.due, null);
  assert.match(sliver.watch[0].blocked, /剩余空间约 \$100,015，不到.*\$2,000,005 的 10%.*不调仓/);
  assert.equal(capped(5000, { chain: other(1_500_000) }).due?.kind, 'rebalance');
  const X = getAddress('0x' + 'cd'.repeat(20));
  const chain = withTokens(snapshot());
  chain.tokens = [...chain.tokens, { address: X, symbol: 'X', decimals: 0, balance: '1000' }];
  const room = poolRoom({ chain, prices: USD1(0), pool: POOL, capBps: 5000, now: 0 });
  assert.equal(room.error, null);
  assert.equal(room.totalUsd, 30 + 2_000_005);
  assert.deepEqual(room.unpriced, ['X']);
  assert.match(roomFullText({ ...room, inPoolUsd: room.capUsd }), /X 无行情价，按 0 计入总资产/);
});

test('a capped reopen that never swapped is not marked capped once the cap is lifted', async () => {
  const clock = { at: 1_000_000 };
  const chain = autoChain({ priced: true });
  chain.state.positions = [position({ amount0: 300, amount1: 4000 })];
  const close = chain.closePosition;
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.twap = 0; return r; };
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await manager.setAuto({ enabled: true, poolCapBps: 5000 }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.match(manager.state().job.error, /TWAP/);
    assert.ok(manager.state().events.some((e) => e.event === 'auto_pool_capped')); // 第一轮确实缩减过
    assert.equal('capped' in saved().reopen, false);
    chain.state.twap = 1000; chain.calls.length = 0;
    await manager.setAuto({ enabled: true, poolCapBps: POOL_CAP_NONE }); await settled(manager);
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
  // 平仓后同池有人手动开了 3,600 的头寸：上限 (4330 + 3600) × 50% − 3600 ≈ 365，不到可重开 4300 的 10%
  chain.closePosition = async (...args) => { const r = await close(...args); chain.state.positions = [position({ tokenId: '8', staked: false, tickLower: 900, tickUpper: 1100, amount0: 3600, amount1: 0 })]; return r; };
  const { manager, directory, saved } = await managed(chain, clock, { readPrices: () => USD1(clock.at) });
  try {
    await manager.setAuto({ enabled: true, poolCapBps: 5000 }); await settled(manager);
    await manager.tickAuto(); clock.at += 5 * MIN; await manager.tickAuto(); await settled(manager);
    assert.equal(manager.state().job.status, 'failed');
    assert.match(manager.state().auto.halted.reason, /剩余空间约 \$365，不到.*未重开，收回的币留在 Safe/);
    assert.ok(saved().reopen);
    assert.equal(chain.calls.some((c) => c[0] === 'open'), false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
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

test('without a cap the saved auto record keeps the old keys', async () => {
  const clock = { at: 1_000_000 };
  const { manager, directory, saved } = await managed(autoChain(), clock);
  try {
    await manager.setAuto({ enabled: false, poolCapBps: POOL_CAP_NONE, poolCaps: {} });
    assert.equal('poolCapBps' in saved().config, false);
    assert.equal('poolCaps' in saved().config, false);
    assert.equal(manager.state().auto.config.poolCapBps, POOL_CAP_NONE);
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
    await manager.setAuto({ enabled: true, poolCapBps: 5000 }); await settled(manager);
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
