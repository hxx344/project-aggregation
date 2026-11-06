import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Interface, Transaction, Wallet, getAddress } from 'ethers';
import { AERO } from '../tools/aero-roles/addresses.mjs';
import { buildPermissions } from '../tools/aero-roles/permissions.mjs';
import * as executor from '../tools/aero-roles/executor.mjs';
import { ROLES_ABI } from '../tools/aero-roles/roles-calls.mjs';
import { CHANGE_BUDGET_MS, CHANGE_DEADLINE_MARGIN_MS, PENDING_STALE_MS, PREVIEW_TTL_MS, createAeroSafe, strictAeroSafeConfig } from '../server/automation/aero-safe.mjs';
import { createApp } from '../server/app.mjs';
import { FORWARD_BUDGET } from '../server/runtime/data-client.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const permissionsConfig = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
const permissions = buildPermissions(permissionsConfig);
const KEY = '0x' + '55'.repeat(32);
const BOT = new Wallet(KEY);
const SAFE = new Wallet('0x' + '66'.repeat(32)).address;
const ROLES = new Wallet('0x' + '77'.repeat(32)).address;
const OTHER = new Wallet('0x' + '88'.repeat(32)).address;
const USDC = getAddress(permissionsConfig.allowances[0].token);
const ERC20_I = new Interface(['function approve(address,uint256)']);
const approve = (spender) => ({ to: USDC, value: 0n, data: ERC20_I.encodeFunctionData('approve', [spender, 1n]) });
const baseConfig = { rpcUrl: 'https://rpc.example', safe: SAFE, roles: ROLES, permissions: permissionsConfig };
const fixtureDir = () => mkdtempSync(join(tmpdir(), 'aero-safe-'));
async function until(predicate, message = 'Expected Aero Safe state did not arrive', rounds = 150) {
  for (let i = 0; i < rounds; i++) { const value = predicate(); if (value) return value; await delay(20); }
  throw new Error(message);
}

test('balanceSwap trades toward the range ratio and skips a balanced or tiny gap', () => {
  const sqrtPriceX96 = 2n ** 96n; // price 1
  const half = executor.balanceSwap({ sqrtPriceX96, tickLower: -1000, tickUpper: 1000, amount0: 1_000_000n, amount1: 0n, feePips: 0 });
  assert.equal(half.zeroForOne, true);
  assert.ok(half.amountIn > 490_000n && half.amountIn < 510_000n, String(half.amountIn)); // a symmetric range needs about half of each
  assert.equal(executor.balanceSwap({ sqrtPriceX96, tickLower: -1000, tickUpper: 1000, amount0: 500_000n, amount1: 500_000n, feePips: 0 }), null);
  // Range above the price takes only token0: every token1 is sold.
  assert.deepEqual(executor.balanceSwap({ sqrtPriceX96, tickLower: 100, tickUpper: 200, amount0: 0n, amount1: 7_000n, feePips: 500 }), { zeroForOne: false, amountIn: 7_000n });
  assert.equal(executor.balanceSwap({ sqrtPriceX96, tickLower: 100, tickUpper: 200, amount0: 10_000n, amount1: 1n, feePips: 500 }), null);
});

test('rolesReason names the Roles condition that failed', () => {
  const errors = new Interface(['error ConditionViolation(uint8 status, bytes32 info)', 'error NoMembership()']);
  const violation = errors.encodeErrorResult('ConditionViolation', [17, '0x' + '00'.repeat(32)]);
  assert.equal(executor.rolesReason({ data: violation }), 'Roles 拒绝：AllowanceExceeded');
  assert.equal(executor.rolesReason({ info: { error: { data: errors.encodeErrorResult('NoMembership', []) } } }), 'Roles 拒绝：NoMembership');
  assert.match(executor.rolesReason(new Error('boom')), /boom/);
});

// A JSON-RPC stand-in that records the order of the calls the signer makes.
function fakeRpc({ nonce = 3, receipt = { status: 1, blockNumber: 9, gasUsed: 21_000n, fee: 1n }, receipts = {}, wait } = {}) {
  const calls = [];
  const rpc = {
    calls, broadcasts: [],
    estimateGas: async () => { calls.push('estimate'); return 100_000n; },
    getFeeData: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
    getTransactionCount: async () => rpc.nonce,
    getBalance: async () => 10n ** 18n,
    broadcastTransaction: async (raw) => { calls.push('broadcast'); rpc.broadcasts.push(raw); },
    waitForTransaction: async (hash) => { calls.push('wait'); return wait ? wait(hash) : receipt; },
    getTransactionReceipt: async (hash) => receipts[hash] ?? null,
    nonce,
  };
  return rpc;
}
const ctxWith = (rpc) => ({ rpc, signer: BOT, safe: SAFE, roles: ROLES, permissions, now: () => 1_000 });
function hookSet(overrides = {}) {
  const seen = { persisted: [], settled: [], order: [] };
  return { seen, hooks: { halted: () => false, pending: () => null, persistPending: (entry) => { seen.order.push('persist'); seen.persisted.push(entry); },
    settle: (entry, receipt) => { seen.settled.push({ entry, receipt }); }, log() {}, ...overrides } };
}

test('a signed transaction is persisted before broadcast and never broadcast when that write fails', async () => {
  const rpc = fakeRpc(), { seen, hooks } = hookSet();
  const persist = hooks.persistPending;
  hooks.persistPending = (entry) => { seen.order.push([...rpc.calls]); persist(entry); };
  await executor.sendRoleTx(ctxWith(rpc), hooks, '授权', [approve(AERO.nft)]);
  assert.deepEqual(seen.order, [['estimate'], 'persist']); // nothing went out before the record was written
  assert.deepEqual(rpc.calls, ['estimate', 'broadcast', 'wait']);
  assert.equal(seen.persisted[0].nonce, 3); assert.deepEqual(seen.persisted[0].replaces, []);
  assert.equal(Transaction.from(seen.persisted[0].raw).from, BOT.address);
  assert.equal(seen.settled.length, 1);

  const failing = fakeRpc(), denied = hookSet({ persistPending: () => { throw new Error('disk full'); } });
  await assert.rejects(executor.sendRoleTx(ctxWith(failing), denied.hooks, '授权', [approve(AERO.nft)]), (error) => error.signed === false && /未广播/.test(error.message));
  assert.equal(failing.broadcasts.length, 0);
});

test('local policy and the maintenance hold stop a transaction before it is signed', async () => {
  const rpc = fakeRpc(), { seen, hooks } = hookSet();
  await assert.rejects(executor.sendRoleTx(ctxWith(rpc), hooks, '授权', [approve(OTHER)]), (error) => error.signed === false && /本地权限校验拒绝/.test(error.message));
  assert.deepEqual(rpc.calls, []);
  const held = hookSet({ halted: () => true });
  await assert.rejects(executor.sendRoleTx(ctxWith(rpc), held.hooks, '授权', [approve(AERO.nft)]), (error) => error.code === 'halted' && error.signed === false);
  assert.equal(seen.persisted.length + held.seen.persisted.length, 0); assert.equal(rpc.broadcasts.length, 0);
});

test('a stuck transaction is replaced at the same nonce with a fee bump, and a consumed nonce is settled first', async () => {
  const prior = { hash: '0x' + 'aa'.repeat(32), nonce: 3, label: '旧', maxFeePerGas: '2000', maxPriorityFeePerGas: '400' };
  const rpc = fakeRpc(), { seen, hooks } = hookSet({ pending: () => prior });
  await executor.sendRoleTx(ctxWith(rpc), hooks, '新', [approve(AERO.nft)]);
  const sent = Transaction.from(seen.persisted[0].raw);
  assert.equal(sent.nonce, 3); assert.equal(sent.maxFeePerGas, 2_500n); assert.equal(sent.maxPriorityFeePerGas, 500n);
  assert.deepEqual(seen.persisted[0].replaces, [{ hash: prior.hash, label: '旧' }]);
  // A second replacement keeps the whole same-nonce chain, newest first.
  const again = hookSet({ pending: () => seen.persisted[0] });
  await executor.sendRoleTx(ctxWith(fakeRpc()), again.hooks, '再新', [approve(AERO.nft)]);
  assert.deepEqual(again.seen.persisted[0].replaces.map((r) => r.label), ['新', '旧']);

  // The prior was mined meanwhile (nonce moved on): it is settled from the chain, not replaced.
  let current = { ...prior, nonce: 2 }; let resolved = 0;
  const moved = hookSet({ pending: () => current, resolvePrior: async () => { resolved++; current = null; } });
  await executor.sendRoleTx(ctxWith(fakeRpc()), moved.hooks, '新', [approve(AERO.nft)]);
  assert.equal(resolved, 1); assert.deepEqual(moved.seen.persisted[0].replaces, []);
  const stuck = hookSet({ pending: () => ({ ...prior, nonce: 2 }), resolvePrior: async () => {} });
  await assert.rejects(executor.sendRoleTx(ctxWith(fakeRpc()), stuck.hooks, '新', [approve(AERO.nft)]), (error) => error.signed === false && /尚未结清/.test(error.message));
});

test('a broadcast whose receipt never arrives is reported as signed with an unknown result', async () => {
  const rpc = fakeRpc({ wait: () => null }), { seen, hooks } = hookSet();
  await assert.rejects(executor.sendRoleTx(ctxWith(rpc), hooks, '授权', [approve(AERO.nft)]), (error) => error.signed === true && error.code === 'unknown');
  assert.equal(seen.settled.length, 0); // the pending record stays for resolvePending
});

test('resolvePending confirms by hash, rebroadcasts while the nonce is open and finds a replaced original', async () => {
  const first = { hash: '0x' + 'dd'.repeat(32), label: '最早' };
  const pending = { hash: '0x' + 'bb'.repeat(32), raw: '0x01', from: BOT.address, nonce: 5, replaces: [{ hash: '0x' + 'cc'.repeat(32), label: '旧' }, first] };
  const mined = { status: 1, blockNumber: 1 };
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ receipts: { [pending.hash]: mined } })), pending), { state: 'confirmed', receipt: mined });
  const open = fakeRpc({ nonce: 5 });
  assert.deepEqual(await executor.resolvePending(ctxWith(open), pending), { state: 'waiting' });
  assert.deepEqual(open.broadcasts, ['0x01']);
  const original = { status: 1, blockNumber: 2 };
  // After two replacements the earliest one can still be the one that was mined.
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ nonce: 6, receipts: { [first.hash]: original } })), pending), { state: 'dropped', replaced: first, replacedReceipt: original });
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ nonce: 6 })), { ...pending, replaces: [] }), { state: 'dropped', replaced: null, replacedReceipt: null });
  // A record written before the chain format (a single object) still resolves.
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ nonce: 6, receipts: { [first.hash]: original } })), { ...pending, replaces: first }), { state: 'dropped', replaced: first, replacedReceipt: original });
});

test('opening stops when the balances or the rebalance swap moved away from the confirmed preview', () => {
  const preview = { amount0: 10_000n, amount1: 5_000n, swap: { tokenIn: USDC, amountIn: 1_000n } };
  assert.doesNotThrow(() => executor.checkExpectation(preview, { amount0: 10_050n, amount1: 5_000n, swapIn: 950n, swapTokenIn: USDC }));
  assert.throws(() => executor.checkExpectation(preview, { amount0: 9_800n, amount1: 5_000n, swapIn: 1_000n, swapTokenIn: USDC }), /余额自预览后变化/);
  assert.throws(() => executor.checkExpectation(preview, { amount0: 10_000n, amount1: 5_000n, swapIn: 800n, swapTokenIn: USDC }), /配平兑换量超出预览/);
  assert.throws(() => executor.checkExpectation(preview, { amount0: 10_000n, amount1: 5_000n, swapIn: 0n }), /配平兑换量超出预览/);
  assert.doesNotThrow(() => executor.checkExpectation({ ...preview, swap: null }, { amount0: 10_000n, amount1: 5_000n, swapIn: 1_000n, swapTokenIn: USDC }));
  // The price moved enough to flip the rebalance: amounts of different tokens are not comparable.
  const flipped = { ...preview, swap: { tokenIn: OTHER, amountIn: 900n } };
  assert.throws(() => executor.checkExpectation(flipped, { amount0: 10_000n, amount1: 5_000n, swapIn: 1_000n, swapTokenIn: USDC }), /方向已改变/);
  assert.doesNotThrow(() => executor.checkExpectation(flipped, { amount0: 10_000n, amount1: 5_000n, swapIn: 1_000n, swapTokenIn: OTHER }));
  assert.throws(() => executor.checkExpectation(flipped, { amount0: 10_000n, amount1: 5_000n, swapIn: 1_000n, swapTokenIn: null }), /缺少配平兑换代币/);
});

test('openPosition checks the confirmed preview before anything is estimated or signed', async () => {
  const POOL = new Wallet('0x' + '99'.repeat(32)).address;
  const balances = { [USDC]: 10_000n, [OTHER]: 5_000n };
  const rpc = fakeRpc();
  rpc.call = async ({ to, data }) => {
    const selector = data.slice(0, 10);
    if (to === POOL && selector === executor.POOL_I.getFunction('slot0').selector) return executor.POOL_I.encodeFunctionResult('slot0', [2n ** 96n, 0, 0, 0, 0, true]);
    if (to === POOL && selector === executor.POOL_I.getFunction('fee').selector) return executor.POOL_I.encodeFunctionResult('fee', [500]);
    if (selector === executor.ERC20_I.getFunction('balanceOf').selector) return executor.ERC20_I.encodeFunctionResult('balanceOf', [balances[getAddress(to)]]);
    throw new Error(`unexpected call ${to} ${selector}`);
  };
  const ctx = { ...ctxWith(rpc), pools: [{ name: 'USDC/OTHER', address: POOL, token0: USDC, token1: OTHER, tickSpacing: 10 }] };
  const { seen, hooks } = hookSet();
  const params = { pool: POOL, tickLower: -100, tickUpper: 100, shareBps: 10_000, rebalance: false, slippageBps: 50 };
  balances[USDC] = 12_000n; // someone moved funds into the Safe after the preview
  await assert.rejects(executor.openPosition(ctx, hooks, { ...params, expect: { amount0: 10_000n, amount1: 5_000n, swapIn: 0n, swapTokenIn: null } }), /余额自预览后变化/);
  assert.deepEqual(rpc.calls, []); assert.equal(seen.persisted.length, 0);
});

test('configuration accepts only the page fields with their ranges', () => {
  const saved = strictAeroSafeConfig(baseConfig);
  assert.deepEqual({ slippageBps: saved.slippageBps, autoSellRewards: saved.autoSellRewards, minRewardSell: saved.minRewardSell, schema: saved.schema }, { slippageBps: 50, autoSellRewards: true, minRewardSell: '1', schema: 1 });
  assert.deepEqual(strictAeroSafeConfig(saved), saved); // a saved file re-validates
  for (const bad of [{ privateKey: KEY }, { rpcUrl: 'https://user:pass@rpc.example' }, { rpcUrl: 'ws://rpc.example' }, { safe: 'safe' }, { slippageBps: 0 }, { slippageBps: 501 },
    { minRewardSell: '-1' }, { permissions: { ...permissionsConfig, swaps: [{ tokenIn: OTHER, tokenOut: USDC, tickSpacing: 1 }] } }]) {
    assert.throws(() => strictAeroSafeConfig({ ...baseConfig, ...bad }), (error) => error.status === 400, JSON.stringify(bad));
  }
});

// A chain stand-in: every action signs one transaction through the manager's hooks.
function fakeChain(overrides = {}) {
  const calls = [];
  let counter = 0;
  const sign = async (ctx, hooks, label) => {
    const entry = { hash: `0x${(++counter).toString(16).padStart(64, '0')}`, raw: '0x00', from: BOT.address, nonce: 0, label, maxFeePerGas: '1', maxPriorityFeePerGas: '1', at: ctx.now() };
    await hooks.persistPending(entry);
    if (overrides.hang) await overrides.hang;
    await hooks.settle(entry, { status: 1, blockNumber: counter, gasUsed: 1n, fee: 1n });
    return entry;
  };
  return {
    calls, ExecError: executor.ExecError, REWARD_TOKEN: executor.REWARD_TOKEN,
    connect: async ({ signer }) => ({ signer, tokens: new Map([[USDC, { address: USDC, symbol: 'USDC', decimals: 6 }]]), now: Date.now }),
    readState: overrides.readState ?? (async () => ({ blockNumber: 1, timestamp: 1, bot: BOT.address, botEth: 1n, latestNonce: 0, pendingNonce: 0, balances: {}, allowances: [], pools: [] })),
    resolvePending: overrides.resolvePending ?? (async () => ({ state: 'waiting' })),
    claimRewards: async (ctx, hooks) => { calls.push('claim'); await sign(ctx, hooks, '领取排放'); return { claimed: true }; },
    sellRewards: overrides.sellRewards ?? (async (_ctx, _hooks, options) => { calls.push(['sell', options.minAmount]); return { sold: false }; }),
    openPosition: overrides.openPosition ?? (async (_ctx, _hooks, params) => { calls.push(['open', params.expect]); return {}; }),
    swap: async (ctx, hooks, params) => { calls.push(['swap', params.amountIn]); await sign(ctx, hooks, '兑换'); return {}; },
    previewOpen: async () => ({ amount0: 1n }),
    // 生成批次前的链上额度读数：默认全部尚未设置（首次设置）。
    readAllowances: overrides.readAllowances ?? (async (_rpc, _roles, keys) => ({ blockNumber: 1, now: 1_800_000_000n,
      allowances: new Map(keys.map((key) => [key, { refill: 0n, maxRefill: 0n, period: 0n, balance: 0n, timestamp: 0n }])) })),
  };
}
function managerWith(directory, options = {}) {
  const chain = options.chain ?? fakeChain();
  const manager = createAeroSafe({ dataDir: directory, encrypt: (value) => `enc:${Buffer.from(value).toString('base64')}`, decrypt: (value) => Buffer.from(value.slice(4), 'base64').toString(),
    log: silent, chain, makeProvider: () => ({}), ...options.manager });
  return { manager, chain };
}

test('the bot key is stored encrypted, never returned, and gates execution with the other holds', async () => {
  const directory = fixtureDir();
  let maintenance = false, admitted = true;
  const { manager, chain } = managerWith(directory, { manager: { readMaintenance: () => maintenance, readAdmission: () => admitted } });
  try {
    await manager.initialize();
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 409 && /Safe 配置/.test(error.message));
    await manager.save(baseConfig);
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 409 && /私钥/.test(error.message));
    await assert.rejects(manager.setKey('nope'), (error) => error.status === 400);
    const state = await manager.setKey(KEY);
    assert.equal(state.wallet, BOT.address);
    assert.ok(!JSON.stringify(state).includes(KEY.slice(2)));
    assert.ok(!readFileSync(join(directory, 'aero-safe/wallet.json'), 'utf8').includes(KEY.slice(2)));
    maintenance = true;
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 503 && /维护/.test(error.message));
    maintenance = false; admitted = false;
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 503 && /隔离/.test(error.message));
    admitted = true;
    await assert.rejects(manager.execute('drain', {}), (error) => error.status === 404);
    await manager.execute('claim', {});
    const done = await until(() => manager.state().job?.status === 'done' && manager.state());
    assert.deepEqual(chain.calls, ['claim', ['sell', 10n ** 18n]]); // rewards are sold after a claim, above the 1 AERO minimum
    assert.equal(done.pending, null);
    assert.deepEqual(done.ledger.map((e) => [e.label, e.status]), [['领取排放', 'confirmed']]);
    assert.equal(existsSync(join(directory, 'aero-safe/pending.json')), false);
    await manager.clearKey();
    assert.equal(manager.state().wallet, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('an unsettled transaction blocks new work until it is stale, then is replaced; a corrupted record blocks for good', async () => {
  const directory = fixtureDir();
  let clock = 1_000_000;
  const { manager } = managerWith(directory, { manager: { now: () => clock } });
  try {
    mkdirSync(join(directory, 'aero-safe'), { recursive: true });
    writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: '0x' + 'ab'.repeat(32), raw: '0x00', from: BOT.address, nonce: 0, label: '旧兑换', at: clock }));
    await manager.initialize();
    await assert.rejects(manager.save(baseConfig), (error) => error.status === 409 && /尚未结清/.test(error.message));
    rmSync(join(directory, 'aero-safe/pending.json'));
    await manager.close();
  } finally { rmSync(directory, { recursive: true }); }

  const second = fixtureDir();
  const { manager: fresh } = managerWith(second, { manager: { now: () => clock } });
  try {
    await fresh.initialize(); await fresh.save(baseConfig); await fresh.setKey(KEY); await fresh.close();
    writeFileSync(join(second, 'aero-safe/pending.json'), JSON.stringify({ hash: '0x' + 'ab'.repeat(32), raw: '0x00', from: BOT.address, nonce: 0, label: '旧兑换', at: clock }));
    const { manager } = managerWith(second, { manager: { now: () => clock } });
    try {
      await manager.initialize();
      await assert.rejects(manager.execute('swap', { tokenIn: USDC, tokenOut: OTHER, amount: '1' }), (error) => error.status === 409 && /仍在等待上链/.test(error.message));
      await assert.rejects(manager.setKey(KEY), (error) => error.status === 409 && /尚未结清/.test(error.message));
      clock += PENDING_STALE_MS;
      assert.equal(manager.state().pending.stale, true);
      await manager.execute('swap', { tokenIn: USDC, tokenOut: OTHER, amount: '1.5' });
      const done = await until(() => manager.state().job?.status === 'done' && manager.state());
      assert.deepEqual(done.ledger.map((e) => [e.label, e.status]), [['兑换', 'confirmed'], ['旧兑换', 'replaced']]);
    } finally { await manager.close(); }

    writeFileSync(join(second, 'aero-safe/pending.json'), '{broken');
    const { manager: broken } = managerWith(second, { manager: { now: () => clock } });
    try {
      await broken.initialize();
      await assert.rejects(broken.execute('claim', {}), (error) => error.status === 409 && /记录损坏/.test(error.message));
      assert.equal(readFileSync(join(second, 'aero-safe/pending.json'), 'utf8'), '{broken'); // kept for a manual check
    } finally { await broken.close(); }
  } finally { rmSync(second, { recursive: true }); }
});

test('a dropped replacement whose original was mined records the original from its receipt', async () => {
  const directory = fixtureDir();
  const original = '0x' + 'cd'.repeat(32), replacement = '0x' + 'ef'.repeat(32);
  const chain = fakeChain({ resolvePending: async () => ({ state: 'dropped', replaced: { hash: original, label: '旧兑换' }, replacedReceipt: { status: 1, blockNumber: 7, gasUsed: 5n, fee: 2n } }) });
  const first = managerWith(directory, { chain });
  try { await first.manager.initialize(); await first.manager.save(baseConfig); await first.manager.setKey(KEY); } finally { await first.manager.close(); }
  writeFileSync(join(directory, 'aero-safe/txs.jsonl'), `${JSON.stringify({ hash: original, label: '旧兑换', status: 'replaced' })}\n`);
  writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: replacement, raw: '0x00', from: BOT.address, nonce: 4, label: '新兑换', at: 0, replaces: [{ hash: original, label: '旧兑换' }] }));
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    const state = await until(() => manager.state().ledger.length === 2 && !manager.state().refreshing && manager.state());
    assert.equal(state.pending, null);
    assert.deepEqual(state.ledger.map((e) => [e.hash, e.status]), [[replacement, 'dropped'], [original, 'confirmed']]);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('opening needs a fresh server-issued preview and passes the confirmed amounts to the executor', async () => {
  const directory = fixtureDir();
  let clock = 5_000_000;
  const { manager, chain } = managerWith(directory, { manager: { now: () => clock } });
  const open = { pool: OTHER, tickLower: -100, tickUpper: 100, shareBps: 5_000 };
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    const preview = await manager.preview(open);
    assert.equal(preview.previewedAt, clock);
    await assert.rejects(manager.execute('open', open), (error) => error.status === 400 && /先预览/.test(error.message));
    const expect = { previewedAt: preview.previewedAt, amount0: '1', amount1: '0', swapIn: null };
    clock += PREVIEW_TTL_MS + 1;
    await assert.rejects(manager.execute('open', { ...open, expect }), (error) => error.status === 409 && /重新预览/.test(error.message));
    await assert.rejects(manager.execute('open', { ...open, expect: { ...expect, previewedAt: clock, amount0: '-1' } }), (error) => error.status === 400);
    // A previewed swap must name the token it sells.
    await assert.rejects(manager.execute('open', { ...open, expect: { ...expect, previewedAt: clock, swapIn: '5' } }), (error) => error.status === 400);
    await manager.execute('open', { ...open, expect: { ...expect, previewedAt: clock - 1_000 } });
    await until(() => manager.state().job?.status === 'done');
    assert.deepEqual(chain.calls, [['open', { amount0: 1n, amount1: 0n, swapIn: 0n, swapTokenIn: null }]]);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a failed ledger write keeps the pending record, and a later failure after a signed step is not shown as unsigned', async () => {
  const directory = fixtureDir();
  let clock = 9_000_000;
  const chain = fakeChain({
    resolvePending: async () => ({ state: 'confirmed', receipt: { status: 1, blockNumber: 3, gasUsed: 1n, fee: 1n } }),
    sellRewards: async () => { throw new executor.ExecError('卖出报价失败'); },
  });
  const { manager } = managerWith(directory, { chain, manager: { now: () => clock } });
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    mkdirSync(join(directory, 'aero-safe/txs.jsonl')); // appending to a directory fails
    await manager.execute('claim', {});
    const failed = await until(() => manager.state().job?.status === 'failed' && !manager.state().refreshing && manager.state());
    assert.equal(failed.job.signed, true); // the claim went out before the sale failed
    assert.equal(failed.pending?.label, '领取排放');
    assert.ok(existsSync(join(directory, 'aero-safe/pending.json')));
    assert.ok(failed.events.some((e) => e.event === 'ledger_write_failed'));
    rmSync(join(directory, 'aero-safe/txs.jsonl'), { recursive: true });
    clock += 60_000;
    manager.refresh();
    const settled = await until(() => manager.state().pending === null && manager.state());
    assert.deepEqual(settled.ledger.map((e) => [e.label, e.status]), [['领取排放', 'confirmed']]);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a ledger failure while recording a mined original keeps the replacement pending and says why', async () => {
  const directory = fixtureDir();
  let clock = 9_000_000;
  const original = '0x' + 'cd'.repeat(32), replacement = '0x' + 'ef'.repeat(32);
  const chain = fakeChain({ resolvePending: async () => ({ state: 'dropped', replaced: { hash: original, label: '旧兑换' }, replacedReceipt: { status: 1, blockNumber: 7, gasUsed: 5n, fee: 2n } }) });
  const first = managerWith(directory, { chain });
  try { await first.manager.initialize(); await first.manager.save(baseConfig); await first.manager.setKey(KEY); } finally { await first.manager.close(); }
  mkdirSync(join(directory, 'aero-safe/txs.jsonl'));
  writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: replacement, raw: '0x00', from: BOT.address, nonce: 4, label: '新兑换', at: 0, replaces: [{ hash: original, label: '旧兑换' }] }));
  const { manager } = managerWith(directory, { chain, manager: { now: () => clock } });
  try {
    await manager.initialize();
    const held = await until(() => manager.state().ledgerError && !manager.state().refreshing && manager.state());
    assert.equal(held.pending?.hash, replacement); // not settled as dropped while the original's line is missing
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 409 && /交易记录写入失败/.test(error.message));
    rmSync(join(directory, 'aero-safe/txs.jsonl'), { recursive: true });
    clock += 60_000;
    manager.refresh();
    const settled = await until(() => manager.state().pending === null && manager.state());
    assert.equal(settled.ledgerError, null);
    assert.deepEqual(settled.ledger.map((e) => [e.hash, e.status]), [[replacement, 'dropped'], [original, 'confirmed']]);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a refresh that resolves the old transaction does not settle its same-nonce replacement', async () => {
  const directory = fixtureDir();
  const clock = 20_000_000;
  const old = '0x' + 'ab'.repeat(32);
  let releaseRefresh, releaseSign, calls = 0;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const hang = new Promise((resolve) => { releaseSign = resolve; });
  const chain = fakeChain({ hang, resolvePending: async () => {
    calls++;
    if (calls === 1) { await refreshGate; return { state: 'confirmed', receipt: { status: 1, blockNumber: 2, gasUsed: 1n, fee: 1n } }; }
    return { state: 'waiting' };
  } });
  const first = managerWith(directory, { chain });
  try { await first.manager.initialize(); await first.manager.save(baseConfig); await first.manager.setKey(KEY); } finally { await first.manager.close(); }
  writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: old, raw: '0x00', from: BOT.address, nonce: 0, label: '旧兑换', at: clock - PENDING_STALE_MS, maxFeePerGas: '1', maxPriorityFeePerGas: '1' }));
  const { manager } = managerWith(directory, { chain, manager: { now: () => clock } });
  try {
    await manager.initialize(); // the startup refresh is now waiting on the old transaction
    await until(() => calls === 1);
    await manager.execute('swap', { tokenIn: USDC, tokenOut: OTHER, amount: '1' });
    const replaced = await until(() => manager.state().pending?.label === '兑换' && manager.state());
    releaseRefresh(); // the old one turns out to be mined
    await until(() => manager.state().events.some((e) => e.event === 'tx_settled' && e.hash === old && e.status === 'confirmed'));
    assert.equal(manager.state().pending?.hash, replaced.pending.hash); // the replacement record is kept
  } finally { releaseRefresh(); releaseSign(); await manager.close(); rmSync(directory, { recursive: true }); }
});

test('only a contract revert counts as a burned position; node errors are retried and reported', async () => {
  const owner = (error) => {
    const rpc = fakeRpc(); let calls = 0;
    rpc.call = async () => { calls++; if (error) throw error; return new Interface(['function ownerOf(uint256) view returns (address)']).encodeFunctionResult('ownerOf', [SAFE]); };
    return { run: () => executor.ownerOrBurned(ctxWith(rpc), 7n), calls: () => calls };
  };
  const live = owner(null);
  assert.equal(await live.run(), SAFE);
  const reverted = Object.assign(new Error('execution reverted: ERC721: owner query for nonexistent token'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' + '00'.repeat(32) });
  assert.equal(await owner(reverted).run(), null);
  // A rate limit answered as a JSON-RPC error also surfaces as CALL_EXCEPTION, but without revert data.
  const limited = owner(Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null }));
  await assert.rejects(limited.run(), /读取 头寸 #7 归属 失败/);
  assert.ok(limited.calls() > 1); // retried before giving up
  await assert.rejects(owner(Object.assign(new Error('bad gateway'), { code: 'SERVER_ERROR' })).run(), /失败/);
});

test('a ledger failure on the replaced row of a same-nonce replacement does not raise the ledger alert for it', async () => {
  const directory = fixtureDir();
  const clock = 40_000_000;
  const { manager: first } = managerWith(directory);
  try { await first.initialize(); await first.save(baseConfig); await first.setKey(KEY); } finally { await first.close(); }
  let release; const hang = new Promise((resolve) => { release = resolve; });
  writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: '0x' + 'ab'.repeat(32), raw: '0x00', from: BOT.address, nonce: 0, label: '旧兑换', at: clock - PENDING_STALE_MS }));
  mkdirSync(join(directory, 'aero-safe/txs.jsonl'));
  const { manager } = managerWith(directory, { chain: fakeChain({ hang }), manager: { now: () => clock } });
  try {
    await manager.initialize();
    await until(() => !manager.state().refreshing);
    await manager.execute('swap', { tokenIn: USDC, tokenOut: OTHER, amount: '1' });
    const state = await until(() => manager.state().pending?.label === '兑换' && manager.state());
    assert.ok(state.events.some((e) => e.event === 'ledger_write_failed' && e.label === '旧兑换' && e.status === 'replaced'));
    assert.equal(state.ledgerError, null);
  } finally { release(); await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a minted position is remembered before staking, read on every refresh and dropped once burned', async () => {
  const directory = fixtureDir();
  const reads = [];
  let burned = [];
  const chain = fakeChain({
    openPosition: async (_ctx, hooks) => { hooks.minted(77n); throw new executor.ExecError('质押：bot 的 ETH 不足以支付 gas', { code: 'gas' }); },
    readState: async (_ctx, options) => { reads.push(options.knownIds.slice()); return { blockNumber: reads.length, timestamp: 1, bot: BOT.address, botEth: 1n, latestNonce: 0, pendingNonce: 0, balances: {}, allowances: [], pools: [], burnedIds: burned }; },
  });
  let clock = 30_000_000;
  const { manager } = managerWith(directory, { chain, manager: { now: () => clock } });
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    const preview = await manager.preview({ pool: OTHER, tickLower: -100, tickUpper: 100 });
    await manager.execute('open', { pool: OTHER, tickLower: -100, tickUpper: 100, expect: { previewedAt: preview.previewedAt, amount0: '1', amount1: '0' } });
    await until(() => manager.state().job?.status === 'failed' && !manager.state().refreshing);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'aero-safe/minted.json'), 'utf8')).ids, ['77']); // kept although staking failed
    assert.deepEqual(reads.at(-1), ['77']);
    burned = [77n];
    const mintedIds = () => JSON.parse(readFileSync(join(directory, 'aero-safe/minted.json'), 'utf8')).ids;
    clock += 60_000; manager.refresh();
    await until(() => reads.length >= 3 && !manager.state().refreshing);
    assert.deepEqual(mintedIds(), ['77']); // one burned reading is not enough
    clock += 10_000; manager.refresh();
    await until(() => reads.length >= 4 && !manager.state().refreshing);
    assert.deepEqual(mintedIds(), ['77']); // a second reading seconds later may come from the same lagging node
    clock += 50_000; manager.refresh();
    await until(() => JSON.parse(readFileSync(join(directory, 'aero-safe/minted.json'), 'utf8')).ids.length === 0);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('update stop check refuses only while a running job waits on a signed transaction', async () => {
  const directory = fixtureDir();
  let release; const hang = new Promise((resolve) => { release = resolve; });
  const { manager } = managerWith(directory, { chain: fakeChain({ hang }) });
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    await manager.prepareStop();
    await manager.execute('claim', {});
    await until(() => manager.state().pending);
    await assert.rejects(manager.prepareStop(), (error) => error.status === 409);
    await assert.rejects(manager.execute('claim', {}), (error) => error.status === 409 && /正在执行/.test(error.message));
    release();
    await until(() => manager.state().job?.status === 'done');
    await manager.prepareStop();
  } finally { release(); await manager.close(); rmSync(directory, { recursive: true }); }
});

test('workbench Aero Safe API requires login, same origin and CSRF, and accepts only strict bodies', async () => {
  const directory = fixtureDir(); let app;
  try {
    app = await createApp({ dataDir: directory, initialPassword: 'aero-safe-fixture-password', refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/automation/aero-safe';
    for (const suffix of ['', '/config', '/wallet', '/execute']) assert.equal((await fetch(origin + route + suffix)).status, 401);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'aero-safe-fixture-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
    const request = (suffix = '', method = 'GET', body, overrides = {}) => fetch(origin + route + suffix, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...overrides }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('/wallet', 'PUT', { privateKey: KEY }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/wallet', 'PUT', { privateKey: KEY }, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request('?file=/tmp')).status, 400);
    assert.equal((await request('/execute', 'POST', { action: 'claim', params: {}, to: OTHER })).status, 400);
    assert.equal((await request('/execute', 'POST', { action: 'claim', params: {} })).status, 409); // no configuration yet
    assert.equal((await request('/config', 'PUT', { config: { ...baseConfig, keyFile: '/tmp/key' } })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: { ...baseConfig, rpcUrl: 'http://127.0.0.1:9', slippageBps: 80 } })).status, 200);
    const stored = await request('/wallet', 'PUT', { privateKey: KEY });
    assert.equal(stored.status, 200);
    const storedText = await stored.text();
    assert.ok(!storedText.includes(KEY.slice(2))); assert.equal(JSON.parse(storedText).wallet, BOT.address);
    const state = JSON.parse(await (await request()).text());
    assert.equal(state.config.slippageBps, 80); assert.equal(state.wallet, BOT.address);
    assert.equal((await request('/refresh', 'POST', { force: true })).status, 400);
    assert.equal((await request('/wallet/clear', 'POST', {})).status, 200);
    assert.equal((await request('/nope', 'POST', {})).status, 404);
  } finally { await app?.close(); rmSync(directory, { recursive: true }); }
});

test('pending changes: several pools and an allowance change share one frozen Safe batch, applied only once the chain shows it', async () => {
  const directory = fixtureDir();
  const WETH = getAddress('0x4200000000000000000000000000000000000006'), CBBTC = getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
  const POOL = new Wallet('0x' + '99'.repeat(32)).address, GAUGE = new Wallet('0x' + 'aa'.repeat(32)).address;
  const POOL2 = new Wallet('0x' + '9a'.repeat(32)).address, GAUGE2 = new Wallet('0x' + 'ab'.repeat(32)).address;
  const POOL3 = new Wallet('0x' + '9b'.repeat(32)).address, GAUGE3 = new Wallet('0x' + 'ac'.repeat(32)).address;
  const weth = { address: WETH, symbol: 'WETH', decimals: 18 }, usdc = { address: USDC, symbol: 'USDC', decimals: 6 }, cbbtc = { address: CBBTC, symbol: 'cbBTC', decimals: 8 };
  const infos = { [POOL]: { address: POOL, gauge: GAUGE, tickSpacing: 100, token0: weth, token1: usdc },
    [POOL2]: { address: POOL2, gauge: GAUGE2, tickSpacing: 1, token0: weth, token1: cbbtc },
    [POOL3]: { address: POOL3, gauge: GAUGE3, tickSpacing: 1, token0: usdc, token1: cbbtc } };
  let active = false;
  const probes = [];
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => infos[address],
    verifyActive: async (args) => { probes.push(args); return { ok: active, checks: [{ label: 'NPM.mint WETH/USDC ts100', ok: active, status: active ? 'ModuleTransactionFailed' : 'OrViolation' }] }; } };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    await assert.rejects(manager.addPoolChange({ pool: POOL }), (error) => error.status === 409 && /Safe 配置/.test(error.message));
    await manager.save(baseConfig);
    await until(() => manager.state().chain);
    await assert.rejects(manager.addPoolChange({ pool: POOL }), (error) => error.status === 400 && /WETH 的每日额度/.test(error.message));
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1', [CBBTC]: '1' } }), (error) => error.status === 400 && /不属于这个池子/.test(error.message));
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '0.0000000000000000001' } }), (error) => error.status === 400);
    await assert.rejects(manager.buildChangeBatch(), (error) => error.status === 409 && /没有待变更/.test(error.message));

    // Two pools wait in parallel: the second one reuses the WETH allowance queued by the first and only needs cbBTC.
    let state = await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '2.5' } });
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['WETH/USDC ts100']);
    assert.deepEqual(state.changes.allowances, [{ token: WETH, symbol: 'WETH', decimals: 18, perDay: '2500000000000000000', current: null }]);
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '2.5' } }), (error) => error.status === 409 && /已在待加池/.test(error.message));
    await assert.rejects(manager.addPoolChange({ pool: POOL2 }), (error) => error.status === 400 && /cbBTC 的每日额度/.test(error.message));
    state = await manager.addPoolChange({ pool: POOL2, allowances: { [CBBTC]: '0.01' } });
    assert.equal(state.changes.pools.length, 2);
    assert.equal(state.config.permissions.pools.length, 1); // the config is untouched until apply
    // Adjusting an existing allowance; setting it back to the configured value withdraws the change.
    await assert.rejects(manager.setAllowanceChanges({ [OTHER]: '1' }), (error) => error.status === 400 && /不在白名单额度/.test(error.message));
    await assert.rejects(manager.setAllowanceChanges({ [WETH]: null }), (error) => error.status === 400 && /移出对应的待加池/.test(error.message));
    await assert.rejects(manager.setAllowanceChanges({ [USDC]: '0' }), (error) => error.status === 400);
    state = await manager.setAllowanceChanges({ [USDC]: '1000' });
    assert.equal(state.changes.allowances.length, 2);
    state = await manager.setAllowanceChanges({ [USDC]: '500.5' });
    assert.deepEqual(state.changes.allowances.find((a) => a.token === USDC), { token: USDC, symbol: 'USDC', decimals: 6, perDay: '500500000', current: '1000000000' });
    assert.ok(state.changes.preview.transactions > 0 && !state.changes.preview.error);

    const batch = await manager.buildChangeBatch();
    assert.equal(batch.builder.transactions.length, batch.transactions.length);
    assert.ok(batch.builder.transactions.every((t) => t.to === ROLES));
    assert.equal(batch.builder.meta.createdFromSafeAddress, SAFE);
    assert.ok(batch.transactions.some((t) => /调整额度 USDC/.test(t.description)));
    assert.deepEqual(batch.state.changes.batch.pools, ['WETH/USDC ts100', 'WETH/cbBTC ts1']);
    assert.equal(batch.state.changes.batch.behind, false);
    const saved = JSON.parse(readFileSync(join(directory, 'aero-safe/changes.json'), 'utf8'));
    // Both directions are added for each new pair; the USDC allowance is replaced, new tokens are appended.
    assert.deepEqual(saved.batch.permissions.swaps.slice(-4), [{ tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }, { tokenIn: USDC, tokenOut: WETH, tickSpacing: 100 },
      { tokenIn: WETH, tokenOut: CBBTC, tickSpacing: 1 }, { tokenIn: CBBTC, tokenOut: WETH, tickSpacing: 1 }]);
    assert.deepEqual(saved.batch.permissions.allowances.map((a) => [a.symbol, a.perDay]).filter(([s]) => ['USDC', 'WETH', 'cbBTC'].includes(s)),
      [['USDC', '500500000'], ['WETH', '2500000000000000000'], ['cbBTC', '1000000']]);

    // A third pool queued after the batch is not part of it and stays pending after apply.
    state = await manager.addPoolChange({ pool: POOL3 });
    assert.equal(state.changes.batch.behind, true);

    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /私钥/.test(error.message));
    await manager.setKey(KEY);
    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /尚未在链上生效.*OrViolation/.test(error.message));
    assert.equal(manager.state().config.permissions.pools.length, 1);
    assert.equal(probes.at(-1).bot, BOT.address);
    assert.equal(probes.at(-1).next.pools.length, 3); // the frozen batch: config + the first two pools

    // The pending changes and the frozen batch survive a restart.
    await manager.close();
    const restarted = managerWith(directory, { chain }).manager;
    await restarted.initialize();
    assert.equal(restarted.state().changes.pools.length, 3);
    active = true;
    state = await restarted.applyChangeBatch();
    assert.deepEqual(state.config.permissions.pools.map((p) => p.gauge).slice(1), [GAUGE, GAUGE2]);
    assert.equal(state.config.permissions.allowances.find((a) => a.token === USDC).perDay, '500500000');
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['USDC/cbBTC ts1']);
    assert.deepEqual(state.changes.allowances, []); // cbBTC is configured now, so the third pool needs no new allowance
    assert.equal(state.changes.batch, null);
    assert.equal(JSON.parse(readFileSync(join(directory, 'aero-safe/config.json'), 'utf8')).permissions.pools.length, 3);
    await assert.rejects(restarted.applyChangeBatch(), (error) => error.status === 409 && /还没有生成/.test(error.message));
    await assert.rejects(restarted.addPoolChange({ pool: POOL }), (error) => error.status === 409 && /已在白名单/.test(error.message));
    state = await restarted.removePoolChange({ pool: POOL3 });
    assert.equal(state.changes.pools.length, 0);
    assert.equal(existsSync(join(directory, 'aero-safe/changes.json')), false);
    await restarted.close();
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a batch goes stale when the config changes; removing a pool drops its new-token allowance; clear and failures', async () => {
  const directory = fixtureDir();
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const POOL = new Wallet('0x' + '99'.repeat(32)).address;
  const info = { address: POOL, gauge: new Wallet('0x' + 'aa'.repeat(32)).address, tickSpacing: 100, token0: { address: WETH, symbol: 'WETH', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 } };
  const chain = { ...fakeChain(), inspectPool: async () => info, verifyActive: async () => ({ ok: true, checks: [] }) };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await manager.setKey(KEY);
    let state = await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    state = await manager.removePoolChange({ pool: POOL });
    assert.deepEqual([state.changes.pools.length, state.changes.allowances.length], [0, 0]);
    await assert.rejects(manager.removePoolChange({ pool: POOL }), (error) => error.status === 404);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.buildChangeBatch();
    await manager.save({ ...baseConfig, slippageBps: 80 }); // execution settings only: permissions unchanged, batch still valid
    assert.equal(manager.state().changes.batch.stale, false);
    // 换 Roles：旧批次失效，重新生成的每笔都发往新 Roles（预览缓存不能沿用旧地址）。
    const ROLES2 = new Wallet('0x' + 'bb'.repeat(32)).address;
    await manager.save({ ...baseConfig, roles: ROLES2 });
    assert.equal(manager.state().changes.batch.stale, true);
    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /重新生成/.test(error.message));
    const rebuilt = await manager.buildChangeBatch();
    assert.ok(rebuilt.transactions.length && rebuilt.transactions.every((t) => getAddress(t.to) === ROLES2), 'rebuilt batch targets the new Roles');
    assert.equal(manager.state().changes.batch.stale, false);
    await manager.save({ ...baseConfig, permissions: { ...permissionsConfig, allowances: permissionsConfig.allowances.map((a, i) => (i === 0 ? { ...a, perDay: '7' } : a)) } });
    assert.equal(manager.state().changes.batch.stale, true);
    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /重新生成/.test(error.message));
    state = await manager.clearChanges();
    assert.equal(state.changes.batch, null);
    assert.equal(existsSync(join(directory, 'aero-safe/changes.json')), false);
    chain.inspectPool = async () => { throw new executor.ExecError('这个池子没有 gauge（没有排放），不能加入白名单'); };
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } }), (error) => error.status === 400 && /没有 gauge/.test(error.message));
    chain.inspectPool = async () => ({ address: POOL, gauge: ROLES, tickSpacing: 1, token0: { address: WETH, symbol: 'WETH', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 } });
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } }), (error) => error.status === 400 && /Safe 或 Roles/.test(error.message));
    chain.inspectPool = async () => { throw new executor.ExecError('读取 池子 factory 失败：timeout', { code: 'rpc' }); };
    await assert.rejects(manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } }), (error) => error.status === 502 && /timeout/.test(error.message));
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a saved single add-pool plan from the previous version becomes pending changes, but its untargeted batch must be regenerated', async () => {
  const directory = fixtureDir();
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const POOL = new Wallet('0x' + '99'.repeat(32)).address, GAUGE = new Wallet('0x' + 'aa'.repeat(32)).address;
  const pool = { address: POOL, name: 'WETH/USDC ts100', gauge: GAUGE, tickSpacing: 100, token0: { address: WETH, symbol: 'WETH', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
    allowances: [{ token: WETH, symbol: 'WETH', perDay: '1000000000000000000', decimals: 18 }], transactions: 9 };
  const next = { ...permissionsConfig, pools: [...permissionsConfig.pools, { name: pool.name, token0: WETH, token1: USDC, tickSpacing: 100, gauge: GAUGE }],
    swaps: [...permissionsConfig.swaps, { tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }, { tokenIn: USDC, tokenOut: WETH, tickSpacing: 100 }],
    allowances: [...permissionsConfig.allowances, { token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }] };
  mkdirSync(join(directory, 'aero-safe'), { recursive: true });
  writeFileSync(join(directory, 'aero-safe/config.json'), JSON.stringify({ schema: 1, ...baseConfig, slippageBps: 50, autoSellRewards: true, minRewardSell: '1' }));
  writeFileSync(join(directory, 'aero-safe/pool-plan.json'), JSON.stringify({ schema: 1, createdAt: 1, pool, baseline: JSON.stringify(permissionsConfig), permissions: next }));
  const chain = { ...fakeChain(), verifyActive: async () => ({ ok: true, checks: [] }) };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    const { changes } = manager.state();
    assert.deepEqual(changes.pools.map((p) => p.name), ['WETH/USDC ts100']);
    assert.equal(changes.allowances[0].perDay, '1000000000000000000');
    // 旧计划没有记录 Safe/Roles：即使权限基线相同也不能核对，须重新生成。
    assert.deepEqual([changes.batch.transactions, changes.batch.stale, changes.batch.behind], [9, true, false]);
    assert.match(changes.batch.staleReason, /旧版本.*Safe 与 Roles/);
    assert.equal(existsSync(join(directory, 'aero-safe/pool-plan.json')), false);
    assert.equal(existsSync(join(directory, 'aero-safe/changes.json')), true);
    await manager.setKey(KEY);
    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /旧版本.*重新生成/.test(error.message));
    // 重启后读回仍拒绝；重新生成的批次带目标，正常核对。
    await manager.close();
    const restarted = managerWith(directory, { chain }).manager;
    await restarted.initialize();
    assert.equal(restarted.state().changes.batch.stale, true);
    await assert.rejects(restarted.applyChangeBatch(), (error) => error.status === 409 && /旧版本/.test(error.message));
    await restarted.buildChangeBatch();
    assert.equal(restarted.state().changes.batch.stale, false);
    const state = await restarted.applyChangeBatch();
    assert.equal(state.config.permissions.pools.length, 2);
    await restarted.close();
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

// 池子 WETH/USDC（WETH 为新代币）与 WETH/cbBTC 的夹具。
function twoPools() {
  const WETH = getAddress('0x4200000000000000000000000000000000000006'), CBBTC = getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
  const POOL = new Wallet('0x' + '99'.repeat(32)).address, POOL2 = new Wallet('0x' + '9a'.repeat(32)).address;
  const weth = { address: WETH, symbol: 'WETH', decimals: 18 }, usdc = { address: USDC, symbol: 'USDC', decimals: 6 }, cbbtc = { address: CBBTC, symbol: 'cbBTC', decimals: 8 };
  const infos = { [POOL]: { address: POOL, gauge: new Wallet('0x' + 'aa'.repeat(32)).address, tickSpacing: 100, token0: weth, token1: usdc },
    [POOL2]: { address: POOL2, gauge: new Wallet('0x' + 'ab'.repeat(32)).address, tickSpacing: 1, token0: weth, token1: cbbtc } };
  return { WETH, CBBTC, POOL, POOL2, infos };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
// 串行队列没被占住：排在后面的写操作应在短时间内完成。
const settlesWithin = (promise, ms = 500) => Promise.race([promise.then(() => true), delay(ms).then(() => false)]);

test('a batch is refused after only the Safe or only the Roles changes, also after a restart; an unchanged batch applies', async () => {
  const directory = fixtureDir();
  const { WETH, POOL, infos } = twoPools();
  const SAFE2 = new Wallet('0x' + 'cc'.repeat(32)).address, ROLES2 = new Wallet('0x' + 'bb'.repeat(32)).address;
  const probes = [];
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => infos[address], verifyActive: async (args) => { probes.push(args); return { ok: true, checks: [] }; } };
  let { manager } = managerWith(directory, { chain });
  const restart = async () => { await manager.close(); ({ manager } = managerWith(directory, { chain })); await manager.initialize(); };
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await manager.setKey(KEY);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.buildChangeBatch();
    for (const [label, changed] of [['Safe', { safe: SAFE2 }], ['Roles', { roles: ROLES2 }]]) {
      await manager.save({ ...baseConfig, ...changed });
      assert.equal(manager.state().changes.batch.stale, true, `${label} change makes the batch stale`);
      assert.match(manager.state().changes.batch.staleReason, /Safe 或 Roles 地址/);
      await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /Safe 或 Roles 地址.*重新生成/.test(error.message));
      await restart();
      assert.equal(manager.state().changes.batch.stale, true, `${label} change is still refused after a restart`);
      await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /重新生成/.test(error.message));
      // 地址改回生成时的值：权限与目标都相同，批次可以核对。
      await manager.save(baseConfig);
      assert.equal(manager.state().changes.batch.stale, false);
    }
    assert.equal(probes.length, 0, 'a stale batch never reaches the chain check');
    await restart();
    const state = await manager.applyChangeBatch();
    assert.equal(probes.length, 1);
    assert.deepEqual([probes[0].safe, probes[0].roles], [SAFE, ROLES]);
    assert.equal(state.config.permissions.pools.length, 2);
    assert.equal(state.changes.batch, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed pending-changes write after apply is reported, and a restart recognises the applied batch and keeps newer changes', async () => {
  const directory = fixtureDir();
  const { WETH, CBBTC, POOL, POOL2, infos } = twoPools();
  let verified = 0;
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => infos[address], verifyActive: async () => { verified += 1; return { ok: true, checks: [] }; } };
  let { manager } = managerWith(directory, { chain });
  const restart = async () => { await manager.close(); ({ manager } = managerWith(directory, { chain })); await manager.initialize(); };
  const blocker = join(directory, 'aero-safe/changes.json.tmp');
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await manager.setKey(KEY);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.buildChangeBatch();
    // 批次之后排队的变更：不在批次里，启用后须保留。
    await manager.addPoolChange({ pool: POOL2, allowances: { [CBBTC]: '0.5' } });
    // 第一次写（config.json）成功，第二次写（changes.json）失败。
    mkdirSync(blocker);
    let state = await manager.applyChangeBatch();
    assert.equal(state.config.permissions.pools.length, 2);
    assert.equal(state.changes.batch, null);
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['WETH/cbBTC ts1']);
    assert.match(state.changes.persistError, /已核对启用并写入配置.*changes\.json 写入失败.*不需要重新签名/);
    assert.ok(state.events.some((e) => e.event === 'changes_write_failed'));
    assert.ok(JSON.parse(readFileSync(join(directory, 'aero-safe/changes.json'), 'utf8')).batch, 'the old batch is still on disk');

    // 写入仍失败时重启：按配置认出已启用的批次，新排队的变更保留，页面继续报告。
    await restart();
    state = manager.state();
    assert.equal(state.changes.batch, null);
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['WETH/cbBTC ts1']);
    assert.deepEqual(state.changes.allowances.map((a) => [a.symbol, a.perDay]), [['cbBTC', '50000000']]);
    assert.match(state.changes.persistError, /changes\.json 写入失败/);

    // 数据目录恢复后重启：落盘为整理后的内容，不再报告，也不需要再核对或签名。
    rmSync(blocker, { recursive: true });
    await restart();
    state = manager.state();
    assert.equal(state.changes.batch, null);
    assert.equal(state.changes.persistError, null);
    assert.ok(state.events.some((e) => e.event === 'changes_batch_recognized'));
    const saved = JSON.parse(readFileSync(join(directory, 'aero-safe/changes.json'), 'utf8'));
    assert.deepEqual([saved.batch, saved.pools.map((p) => p.name)], [null, ['WETH/cbBTC ts1']]);
    assert.equal(state.config.permissions.pools.length, 2);
    await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /还没有生成/.test(error.message));
    assert.equal(verified, 1, 'the applied batch is not checked or signed again');
    // 下一份批次只含新排队的池子。
    const next = await manager.buildChangeBatch();
    assert.deepEqual(next.state.changes.batch.pools, ['WETH/cbBTC ts1']);
  } finally { rmSync(blocker, { recursive: true, force: true }); await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a runtime save that matches the batch permissions does not mark the unexecuted batch as applied', async () => {
  const directory = fixtureDir();
  const { WETH, POOL, infos } = twoPools();
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => infos[address], verifyActive: async () => ({ ok: true, checks: [] }) };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await manager.setKey(KEY);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.buildChangeBatch();
    const { permissions } = JSON.parse(readFileSync(join(directory, 'aero-safe/changes.json'), 'utf8')).batch;
    // 手动保存出与批次相同的权限：批次未必已在 Safe 执行，不能静默丢弃，仍作失效保留提示。
    const state = await manager.save({ ...baseConfig, permissions });
    assert.ok(state.changes.batch, 'the batch is kept');
    assert.equal(state.changes.batch.stale, true);
    assert.ok(!state.events.some((e) => e.event === 'changes_batch_recognized'));
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the batch view separates frozen items from draft additions and withdrawals, for pools and allowances', async () => {
  const directory = fixtureDir();
  const { WETH, CBBTC, POOL, POOL2, infos } = twoPools();
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => infos[address], verifyActive: async () => ({ ok: true, checks: [] }) };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await until(() => manager.state().chain);
    await manager.setKey(KEY);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.setAllowanceChanges({ [USDC]: '500' });
    let { batch } = (await manager.buildChangeBatch()).state.changes;
    assert.deepEqual([batch.added, batch.withdrawn], [{ pools: [], allowances: [] }, { pools: [], allowances: [] }]);
    // 撤回冻结批次里的池子（连带它的新代币额度）、改掉冻结的 USDC 额度、再加一个池子。
    await manager.removePoolChange({ pool: POOL });
    await manager.setAllowanceChanges({ [USDC]: '600' });
    await manager.addPoolChange({ pool: POOL2, allowances: { [WETH]: '2', [CBBTC]: '0.5' } });
    batch = manager.state().changes.batch;
    assert.equal(batch.stale, false);
    assert.equal(batch.behind, true);
    assert.deepEqual(batch.pools, ['WETH/USDC ts100']); // frozen content is unchanged
    assert.deepEqual(batch.withdrawn, { pools: ['WETH/USDC ts100'], allowances: [
      { symbol: 'WETH', perDay: '1000000000000000000', decimals: 18 }, { symbol: 'USDC', perDay: '500000000', decimals: 6 }] });
    assert.deepEqual(batch.added, { pools: ['WETH/cbBTC ts1'], allowances: [
      { symbol: 'USDC', perDay: '600000000', decimals: 6 }, { symbol: 'WETH', perDay: '2000000000000000000', decimals: 18 }, { symbol: 'cbBTC', perDay: '50000000', decimals: 8 }] });
    // 只撤回额度也算撤回：撤回 USDC 调整后草稿里没有它，冻结批次仍会设为 500。
    await manager.setAllowanceChanges({ [USDC]: null });
    assert.deepEqual(manager.state().changes.batch.withdrawn.allowances.map((a) => a.symbol), ['WETH', 'USDC']);
    // 旧批次已在 Safe 执行时核对启用：撤回的池子与额度照样并入配置（链上已生效），新增的继续待变更。
    const state = await manager.applyChangeBatch();
    assert.ok(state.config.permissions.pools.some((p) => p.name === 'WETH/USDC ts100'));
    assert.equal(state.config.permissions.allowances.find((a) => a.token === USDC).perDay, '500000000');
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['WETH/cbBTC ts1']);
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('slow RPC reads for add-pool and apply wait outside the serial queue and recheck config, login, maintenance and jobs before committing', async () => {
  const directory = fixtureDir();
  const { WETH, CBBTC, POOL, POOL2, infos } = twoPools();
  const ROLES2 = new Wallet('0x' + 'bb'.repeat(32)).address;
  let maintenance = false, inspectGate = null, verifyGate = null, release;
  const hang = new Promise((resolve) => { release = resolve; });
  const chain = { ...fakeChain({ hang }),
    inspectPool: async (_rpc, address) => { if (inspectGate) await inspectGate.promise; return infos[address]; },
    verifyActive: async () => { if (verifyGate) await verifyGate.promise; return { ok: true, checks: [] }; } };
  const { manager } = managerWith(directory, { chain, manager: { readMaintenance: () => maintenance } });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await until(() => manager.state().chain);
    await manager.setKey(KEY);

    // 加池：核验池子期间队列可用；配置换了，核验结果不能写入。
    inspectGate = deferred();
    const adding = manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    assert.equal(await settlesWithin(manager.setAllowanceChanges({ [USDC]: '700' })), true, 'queue is free while the pool is inspected');
    await manager.save({ ...baseConfig, roles: ROLES2 });
    inspectGate.resolve();
    await assert.rejects(adding, (error) => error.status === 409 && /核验池子期间已变化/.test(error.message));
    assert.equal(manager.state().changes.pools.length, 0);
    await manager.save(baseConfig);
    inspectGate = null;
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    await manager.buildChangeBatch();

    const applyWhile = async (during, check, authorize) => {
      verifyGate = deferred();
      const applying = manager.applyChangeBatch(authorize);
      await delay(10);
      await during();
      verifyGate.resolve();
      await assert.rejects(applying, check);
      verifyGate = null;
      assert.ok(manager.state().changes.batch, 'the batch is kept for a later apply');
      assert.equal(manager.state().config.permissions.pools.length, 1);
    };
    // 核对期间：队列可用，第二次核对被拒；维护开始则不提交。
    await applyWhile(async () => {
      assert.equal(await settlesWithin(manager.addPoolChange({ pool: POOL2, allowances: { [CBBTC]: '0.5' } })), true, 'queue is free while the batch is verified');
      await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /正在核对/.test(error.message));
      maintenance = true;
    }, (error) => error.status === 503 && /维护/.test(error.message));
    maintenance = false;
    // 核对期间登录失效：提交前重新验证。
    let loggedIn = true;
    await applyWhile(() => { loggedIn = false; }, (error) => error.status === 401,
      () => { if (!loggedIn) throw Object.assign(new Error('登录已失效'), { status: 401 }); });
    // 核对期间配置换了 Roles。
    await applyWhile(() => manager.save({ ...baseConfig, roles: ROLES2 }), (error) => error.status === 409 && /重新生成/.test(error.message));
    await manager.save(baseConfig);
    // 核对期间只改执行参数：配置代际变了，要求重新核对。
    await applyWhile(() => manager.save({ ...baseConfig, slippageBps: 80 }), (error) => error.status === 409 && /核对期间已变化/.test(error.message));
    // 核对期间启动了任务并签出一笔待确认交易。
    await applyWhile(async () => { await manager.execute('claim', {}); await until(() => manager.state().pending); },
      (error) => error.status === 409 && /正在执行/.test(error.message));
    release();
    await until(() => manager.state().job?.status === 'done' && !manager.state().pending);
    // 条件都满足时正常提交；核对期间新排的池子保留。
    const state = await manager.applyChangeBatch();
    assert.equal(state.config.permissions.pools.length, 2);
    assert.deepEqual(state.changes.pools.map((p) => p.name), ['WETH/cbBTC ts1']);
  } finally { release(); await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the open USD cap only shrinks the share-based amounts, proportionally, and reaches the executor unchanged', async () => {
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const ctx = { tokens: new Map([[WETH, { decimals: 18 }], [USDC, { decimals: 6 }]]) }, pool = { token0: WETH, token1: USDC };
  const e18 = 10n ** 18n, e6 = 10n ** 6n;
  // 2 WETH at $3000 + 4000 USDC = $10,000; a $5,000 cap halves both.
  assert.deepEqual(executor.capAmounts(ctx, pool, 2n * e18, 4000n * e6, { usd: 5000, usd0: 3000, usd1: 1 }), { amount0: e18, amount1: 2000n * e6, capped: true });
  assert.deepEqual(executor.capAmounts(ctx, pool, 2n * e18, 4000n * e6, { usd: 20000, usd0: 3000, usd1: 1 }), { amount0: 2n * e18, amount1: 4000n * e6, capped: false });
  assert.deepEqual(executor.capAmounts(ctx, pool, 5n, 6n, null), { amount0: 5n, amount1: 6n, capped: false });
  assert.throws(() => executor.capAmounts({ tokens: new Map() }, pool, 1n, 1n, { usd: 1, usd0: 1, usd1: 1 }), /精度未知/);

  const directory = fixtureDir();
  const seen = [];
  const chain = { ...fakeChain({ openPosition: async (_ctx, _hooks, params) => { seen.push(['open', params.cap]); return {}; } }), previewOpen: async (_ctx, params) => { seen.push(['preview', params.cap]); return { amount0: 1n, amount1: 0n }; } };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    const cap = { usd: 500, usd0: 3000, usd1: 1 };
    for (const bad of [{ usd: 0, usd0: 1, usd1: 1 }, { usd: 5, usd0: 1 }, { usd: 5, usd0: 1, usd1: 1, extra: 1 }, 'x']) {
      await assert.rejects(manager.preview({ pool: OTHER, tickLower: -100, tickUpper: 100, cap: bad }), (error) => error.status === 400 && /投入上限/.test(error.message));
    }
    const preview = await manager.preview({ pool: OTHER, tickLower: -100, tickUpper: 100, cap });
    await manager.preview({ pool: OTHER, tickLower: -100, tickUpper: 100 });
    await manager.execute('open', { pool: OTHER, tickLower: -100, tickUpper: 100, cap, expect: { previewedAt: preview.previewedAt, amount0: '1', amount1: '0' } });
    await until(() => manager.state().job?.status === 'done');
    assert.deepEqual(seen, [['preview', cap], ['preview', null], ['open', cap]]);
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('verifyActive passes only what Roles lets through and reads new allowances exactly', async () => {
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const GAUGE = new Wallet('0x' + 'aa'.repeat(32)).address;
  const next = buildPermissions({ ...permissionsConfig,
    pools: [...permissionsConfig.pools, { name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: 100, gauge: GAUGE }],
    swaps: [...permissionsConfig.swaps, { tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }],
    allowances: [...permissionsConfig.allowances, { token: WETH, symbol: 'WETH', perDay: '1000' }] });
  const errors = new Interface(['error ConditionViolation(uint8 status, bytes32 info)', 'error ModuleTransactionFailed()']);
  const rolesI = new Interface(['function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)',
    'function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)']);
  const npmIndex = new Interface(['function tokenByIndex(uint256) view returns (uint256)']);
  const revert = (data) => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data });
  const violation = (status) => revert(errors.encodeErrorResult('ConditionViolation', [status, '0x' + '00'.repeat(32)]));
  const run = async (decide, period = 86400n) => executor.verifyActive({ safe: SAFE, roles: ROLES, bot: BOT.address, current: permissions, next, now: () => 1e12, rpc: { call: async ({ from, to, data }) => {
    if (to === AERO.nft && data.startsWith(npmIndex.getFunction('tokenByIndex').selector)) return npmIndex.encodeFunctionResult('tokenByIndex', [5n]);
    assert.equal(to, ROLES);
    if (data.startsWith(rolesI.getFunction('allowances').selector)) return rolesI.encodeFunctionResult('allowances', [1000n, 1000n, period, 1000n, 0n]);
    assert.equal(from, BOT.address);
    const inner = rolesI.decodeFunctionData('execTransactionWithRole', data);
    assert.equal(inner.shouldRevert, true);
    return decide(getAddress(inner.to), inner.data);
  } } });
  const ok = () => '0x' + '00'.repeat(31) + '01';
  // Everything let through: the inner call failing (zero amounts) still proves the permission; NFT approve may stop at the ownership check.
  let result = await run((to, data) => {
    if (to === GAUGE) throw revert(errors.encodeErrorResult('ModuleTransactionFailed', []));
    if (to === AERO.nft && data.startsWith('0x095ea7b3')) throw violation(16); // CustomConditionViolation
    return ok();
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  const labels = result.checks.map((c) => c.label);
  assert.ok(labels.includes('NPM.mint WETH/USDC ts100') && labels.includes('额度 WETH') && labels.some((l) => l.startsWith('Router 兑换 WETH → USDC')));
  assert.ok(labels.includes('WETH.approve → NPM') && labels.includes('WETH.approve → Router'));
  // Not active yet: the gauge is not a scoped target, and a custom-condition failure on anything but the NFT approve is a failure.
  result = await run((to, data) => { if (to === GAUGE) throw violation(2); if (to === WETH) throw violation(16); return ok(); });
  assert.equal(result.ok, false);
  assert.ok(result.checks.filter((c) => !c.ok).every((c) => c.label.includes('gauge') || c.label.startsWith('WETH.')));
  // An allowance with the wrong period is not the planned one.
  result = await run(() => ok(), 3600n);
  assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.label), ['额度 WETH']);
  // A revert that is not a Roles error is never read as a pass.
  await assert.rejects(run(() => { throw revert('0x08c379a0'); }), /原因不是 Roles 权限/);
});

test('the batch reads the on-chain allowance first: an adjustment keeps this period\'s spending, a failed read refuses, a change during the read is rejected', async () => {
  const directory = fixtureDir();
  const usdcKey = permissions.allowances.find((a) => a.token === USDC).key;
  const DAY = 86_400n, day0 = 20_000n * DAY;
  const reads = [];
  let fail = false, gate = null, readAt = day0 + 3600n;
  let clock = Number(day0 + 3600n) * 1000;
  const chain = { ...fakeChain(), verifyActive: async () => ({ ok: true, checks: [] }),
    readAllowances: async (_rpc, roles, keys) => {
      reads.push({ roles, keys });
      if (gate) await gate;
      if (fail) throw new executor.ExecError('读取 Roles 额度 失败：boom', { code: 'rpc' });
      // 每日 1000 USDC，本期（day0 起）已用 300。
      return { blockNumber: 9, now: readAt, allowances: new Map(keys.map((key) => [key, { refill: 1_000_000_000n, maxRefill: 1_000_000_000n, period: DAY, balance: 700_000_000n, timestamp: day0 }])) };
    } };
  const { manager } = managerWith(directory, { chain, manager: { now: () => clock } });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await until(() => manager.state().chain);
    await manager.setAllowanceChanges({ [USDC]: '500' });
    fail = true;
    await assert.rejects(manager.buildChangeBatch(), (error) => error.status === 502 && /读取链上额度失败，未生成批次/.test(error.message));
    assert.equal(manager.state().changes.batch, null, 'nothing is frozen without the on-chain reading');
    fail = false;
    const out = await manager.buildChangeBatch();
    assert.deepEqual(reads.at(-1), { roles: ROLES, keys: [usdcKey] });
    const call = ROLES_ABI.parseTransaction({ data: out.builder.transactions[0].data });
    // 500 − 300 spent = 200 left today; refill/maxRefill = 500; timestamp stays at today's period start.
    assert.deepEqual(call.args.slice(1).map(String), ['200000000', '500000000', '500000000', '86400', String(day0)]);
    const [effect] = out.allowances;
    assert.deepEqual([effect.symbol, effect.decimals, effect.previous, effect.perDay, effect.used, effect.balance, effect.replay.samePeriod, effect.replay.laterPeriod],
      ['USDC', 6, '1000000000', '500000000', '300000000', '200000000', '200000000', '500000000']);
    assert.match(out.transactions[0].description, /本期已用 300000000，执行后本期剩余 200000000/);
    assert.match(out.builder.meta.description, /重复执行.*USDC 每次执行最多再花 200000000/);
    // The batch must run before this period's refill (minus 10 minutes); the deadline is frozen with it and survives a restart.
    const executeBefore = Number(day0 + DAY - 600n) * 1000;
    assert.deepEqual([out.executeBefore, effect.executeBefore, effect.limits.inTime, effect.limits.late], [executeBefore, executeBefore / 1000, '1200000000', '1500000000']);
    assert.match(out.builder.meta.description, /须在 .+ UTC 前执行；过了期限不要再执行，请重新生成/);
    assert.deepEqual([out.state.changes.batch.executeBefore, out.state.changes.batch.expired], [executeBefore, false]);
    await manager.close();
    let restarted = managerWith(directory, { chain, manager: { now: () => clock } }).manager;
    await restarted.initialize();
    assert.equal(restarted.state().changes.batch.executeBefore, executeBefore);
    // Past the deadline the batch is marked expired (an unexecuted file must not run any more), but one executed in time can still be applied.
    clock = executeBefore;
    assert.equal(restarted.state().changes.batch.expired, true);
    await restarted.setKey(KEY);
    const applied = await restarted.applyChangeBatch();
    assert.equal(applied.config.permissions.allowances.find((a) => a.token === USDC).perDay, '500000000');
    await restarted.close();
    restarted = managerWith(directory, { chain, manager: { now: () => clock } }).manager;
    await restarted.initialize();
    await until(() => restarted.state().chain);

    // Too close to the period end to run in time: refused, nothing frozen.
    await restarted.setAllowanceChanges({ [USDC]: '400' });
    readAt = day0 + DAY - 300n;
    await assert.rejects(restarted.buildChangeBatch(), (error) => error.status === 409 && /不到 10 分钟/.test(error.message));
    assert.equal(restarted.state().changes.batch, null);
    readAt = day0 + 3600n;

    // A draft change while the chain read is in flight is not frozen into a batch built from the old draft.
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    let building = restarted.buildChangeBatch();
    const seen = reads.length;
    await until(() => reads.length === seen + 1);
    await restarted.setAllowanceChanges({ [USDC]: '600' });
    release(); gate = null;
    await assert.rejects(building, (error) => error.status === 409 && /读取链上额度期间已变化/.test(error.message));

    // The whole request, queueing included, is bounded by CHANGE_BUDGET_MS from its arrival: past it nothing is frozen.
    gate = new Promise((resolve) => { release = resolve; });
    building = restarted.buildChangeBatch();
    await until(() => reads.length === seen + 2);
    clock += CHANGE_BUDGET_MS;
    release(); gate = null;
    await assert.rejects(building, (error) => error.status === 504 && /含排队等待/.test(error.message));
    assert.equal(restarted.state().changes.batch, null);
    await restarted.close();
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('waiting in the serial queue counts toward the batch budget, and a callback that runs after the timeout freezes nothing', async () => {
  const directory = fixtureDir();
  const DAY = 86_400n, day0 = 20_000n * DAY;
  let previewGate = null, readGate = null;
  const chain = { ...fakeChain(),
    previewOpen: async () => { await previewGate; return { amount0: 1n }; },
    readAllowances: async (_rpc, _roles, keys) => {
      await readGate;
      return { blockNumber: 9, now: day0 + 3600n, allowances: new Map(keys.map((key) => [key, { refill: 1_000_000_000n, maxRefill: 1_000_000_000n, period: DAY, balance: 700_000_000n, timestamp: day0 }])) };
    } };
  const { manager } = managerWith(directory, { chain, manager: { now: () => Number(day0 + 3600n) * 1000, changeBudgetMs: 300 } });
  const open = { pool: OTHER, tickLower: -100, tickUpper: 100, shareBps: 5_000 };
  const batched = () => manager.state().events.filter((e) => e.event === 'changes_batched').length;
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    await until(() => manager.state().chain);
    await manager.setAllowanceChanges({ [USDC]: '500' });

    // 1. A long preview holds the queue before the first step.
    let release;
    previewGate = new Promise((resolve) => { release = resolve; });
    let previewing = manager.preview(open);
    let started = Date.now();
    await assert.rejects(manager.buildChangeBatch(), (error) => error.status === 504 && /含排队等待其他操作/.test(error.message));
    assert.ok(Date.now() - started < 2_000, 'the queue wait is bounded by the budget');
    release(); await previewing; previewGate = null;

    // 2. The chain read returns, but the queue is held again before the batch is frozen.
    let releaseRead;
    readGate = new Promise((resolve) => { releaseRead = resolve; });
    previewGate = new Promise((resolve) => { release = resolve; });
    started = Date.now();
    const building = manager.buildChangeBatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    previewing = manager.preview(open);
    releaseRead();
    await assert.rejects(building, (error) => error.status === 504 && /含排队等待其他操作/.test(error.message));
    assert.ok(Date.now() - started < 2_000, 'the second queue wait is bounded too');
    release(); await previewing;
    await manager.setAllowanceChanges({ [USDC]: '500' }); // runs after the abandoned callback in queue order
    assert.deepEqual([manager.state().changes.batch, batched()], [null, 0], 'the abandoned callback froze nothing');

    // An idle queue still builds the batch within the budget.
    previewGate = null; readGate = null;
    const out = await manager.buildChangeBatch();
    assert.deepEqual([out.state.changes.batch.transactions, batched()], [1, 1]);
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});
// A regression that lets a late callback wait for the held queue deadlocks the hold/release steps: the timeout turns that into a failure.
test('add-pool and apply count queue waits and slow reads toward the change budget; a callback that runs after the timeout writes nothing', { timeout: 15_000 }, async () => {
  const directory = fixtureDir();
  const { WETH, POOL, infos } = twoPools();
  let previewGate = null, inspectGate = null, verifyGate = null;
  const inspected = [], verified = [];
  const chain = { ...fakeChain(),
    previewOpen: async () => { await previewGate?.promise; return { amount0: 1n }; },
    inspectPool: async (_rpc, address) => { inspected.push(address); await inspectGate?.promise; return infos[address]; },
    verifyActive: async () => { verified.push(1); await verifyGate?.promise; return { ok: true, checks: [] }; } };
  const { manager } = managerWith(directory, { chain, manager: { changeBudgetMs: 300 } });
  const open = { pool: OTHER, tickLower: -100, tickUpper: 100, shareBps: 5_000 };
  const file = (name) => join(directory, 'aero-safe', name);
  const queuedOnDisk = () => (existsSync(file('changes.json')) ? JSON.parse(readFileSync(file('changes.json'), 'utf8')).pools.length : 0);
  const listedOnDisk = () => JSON.parse(readFileSync(file('config.json'), 'utf8')).permissions.pools.length;
  const count = (name) => manager.state().events.filter((e) => e.event === name).length;
  const timedOut = (what) => (error) => error.status === 504 && new RegExp(`^${what}超过 0.3 秒（含排队等待其他操作）`).test(error.message);
  // A long preview holds the serial queue; the returned function lets it go.
  const hold = () => { previewGate = deferred(); const previewing = manager.preview(open); return () => { previewGate.resolve(); previewGate = null; return previewing; }; };
  // Any queued callback left behind has run once a later queued step completes.
  const drain = () => manager.preview(open);
  const add = () => manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    await until(() => manager.state().chain);

    // 加池 1：队列被占住，第一步排不上；之后轮到也不读链、不写入。
    let free = hold(), started = Date.now();
    await assert.rejects(add(), timedOut('加池'));
    assert.ok(Date.now() - started < 2_000, 'the first queue wait is bounded by the budget');
    await free(); await drain();
    assert.deepEqual([inspected.length, manager.state().changes.pools.length, queuedOnDisk()], [0, 0, 0]);

    // 加池 2：节点慢，核验池子超过剩余时间；核验结果晚到也不写入。
    inspectGate = deferred(); started = Date.now();
    await assert.rejects(add(), timedOut('加池'));
    assert.ok(Date.now() - started < 2_000, 'a slow inspection is bounded by the budget');
    inspectGate.resolve(); inspectGate = null; await drain();
    assert.deepEqual([manager.state().changes.pools.length, queuedOnDisk(), count('pool_queued')], [0, 0, 0]);

    // 加池 3：核验返回了，但回到队列前队列又被占住；超时后轮到的回调不写入。
    inspectGate = deferred();
    const adding = add();
    await until(() => inspected.length === 2);
    free = hold();
    inspectGate.resolve(); inspectGate = null;
    await assert.rejects(adding, timedOut('加池'));
    await free(); await drain();
    assert.deepEqual([manager.state().changes.pools.length, queuedOnDisk(), count('pool_queued')], [0, 0, 0], 'the abandoned callback queued nothing');

    // 队列空闲、节点正常时照常加入并生成批次。
    await add();
    await manager.buildChangeBatch();
    assert.equal(queuedOnDisk(), 1);
    const kept = () => [manager.state().config.permissions.pools.length, listedOnDisk(), !!manager.state().changes.batch, count('changes_applied')];

    // 启用 1：队列被占住，第一步排不上；之后轮到也不核对、不占用核对标记。
    free = hold(); started = Date.now();
    await assert.rejects(manager.applyChangeBatch(), timedOut('核对启用'));
    assert.ok(Date.now() - started < 2_000);
    await free(); await drain();
    assert.equal(verified.length, 0);
    assert.deepEqual(kept(), [1, 1, true, 0]);

    // 启用 2：节点慢，模拟核对超过剩余时间；核对结果晚到也不写配置。
    verifyGate = deferred(); started = Date.now();
    await assert.rejects(manager.applyChangeBatch(), timedOut('核对启用'));
    assert.ok(Date.now() - started < 2_000, 'a slow verification is bounded by the budget');
    verifyGate.resolve(); verifyGate = null; await drain();
    assert.deepEqual(kept(), [1, 1, true, 0]);

    // 启用 3：核对通过了，但回到队列前队列又被占住；超时后轮到的回调不写配置，批次保留。
    verifyGate = deferred();
    const applying = manager.applyChangeBatch();
    await until(() => verified.length === 2);
    free = hold();
    verifyGate.resolve(); verifyGate = null;
    await assert.rejects(applying, timedOut('核对启用'));
    await free(); await drain();
    assert.deepEqual(kept(), [1, 1, true, 0], 'the abandoned callback wrote no config');

    // 核对进行中再点两次都被拒：被拒的请求不清除进行中那一次的核对标记；队列空闲时这一次照常启用。
    verifyGate = deferred();
    const first = manager.applyChangeBatch();
    await until(() => verified.length === 3);
    for (let i = 0; i < 2; i++) await assert.rejects(manager.applyChangeBatch(), (error) => error.status === 409 && /正在核对/.test(error.message));
    verifyGate.resolve(); verifyGate = null;
    const state = await first;
    assert.deepEqual([state.config.permissions.pools.length, listedOnDisk(), state.changes.batch, count('changes_applied')], [2, 2, null, 1]);
  } finally { previewGate?.resolve(); inspectGate?.resolve(); verifyGate?.resolve(); await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('change requests answer before the API forward timeout, and the page waits longer than both', () => {
  const page = /export const CHANGE_TIMEOUT_MS = ([\d_]+);/.exec(readFileSync(new URL('../src/aero-safe-client.ts', import.meta.url), 'utf8'));
  assert.ok(page, 'the page timeout constant is declared');
  const pageMs = Number(page[1].replaceAll('_', ''));
  assert.ok(CHANGE_BUDGET_MS + 5_000 <= FORWARD_BUDGET, 'the server gives up and explains why before the API forward times out');
  assert.ok(pageMs >= FORWARD_BUDGET + 5_000, 'the page waits for the API reply, including its own timeout reply');
  assert.equal(FORWARD_BUDGET - CHANGE_DEADLINE_MARGIN_MS, CHANGE_BUDGET_MS, 'counted from the API receipt, the forwarded deadline gives the same budget');
});

// Each step gets only what is left of the one deadline: a slow read after a long queue wait, or a held queue after a slow read,
// still answers within the budget. A step that used the full budget again would answer about HELD ms later.
test('time spent queueing or reading shortens what is left for the next step of add-pool, batch and apply; nothing is written after the timeout', { timeout: 30_000 }, async () => {
  const BUDGET = 900, HELD = 600, SLACK = 250;
  const directory = fixtureDir();
  const { WETH, POOL, infos } = twoPools();
  const gates = { preview: null, inspect: null, read: null, verify: null }, calls = { inspect: 0, read: 0, verify: 0 };
  const wait = (name) => gates[name]?.promise;
  const chain = { ...fakeChain(),
    previewOpen: async () => { await wait('preview'); return { amount0: 1n }; },
    inspectPool: async (_rpc, address) => { calls.inspect++; await wait('inspect'); return infos[address]; },
    readAllowances: async (_rpc, _roles, keys) => { calls.read++; await wait('read');
      return { blockNumber: 1, now: 1_800_000_000n, allowances: new Map(keys.map((key) => [key, { refill: 0n, maxRefill: 0n, period: 0n, balance: 0n, timestamp: 0n }])) }; },
    verifyActive: async () => { calls.verify++; await wait('verify'); return { ok: true, checks: [] }; } };
  const { manager } = managerWith(directory, { chain, manager: { changeBudgetMs: BUDGET } });
  const open = { pool: OTHER, tickLower: -100, tickUpper: 100, shareBps: 5_000 };
  const file = (name) => join(directory, 'aero-safe', name);
  const count = (name) => manager.state().events.filter((e) => e.event === name).length;
  const onDisk = () => [readFileSync(file('config.json'), 'utf8'), existsSync(file('changes.json')) ? readFileSync(file('changes.json'), 'utf8') : null];
  const hold = () => { gates.preview = deferred(); const previewing = manager.preview(open); return () => { gates.preview.resolve(); gates.preview = null; return previewing; }; };
  const drain = () => manager.preview(open);
  // Late answers are collected and checked at the end, so one run reports every step that overran.
  const late = [];
  const ops = {
    add: { run: () => manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } }), gate: 'inspect', what: '加池', event: 'pool_queued' },
    batch: { run: () => manager.buildChangeBatch(), gate: 'read', what: '生成批次', event: 'changes_batched' },
    apply: { run: () => manager.applyChangeBatch(), gate: 'verify', what: '核对启用', event: 'changes_applied' },
  };
  async function scenario(op, queueFirst) {
    const { run, gate, what, event } = ops[op], label = `${op} ${queueFirst ? 'queue then slow read' : 'slow read then queue'}`;
    const reads = calls[gate], events = count(event), disk = onDisk(), state = JSON.stringify(manager.state().changes);
    gates[gate] = deferred();
    let free = queueFirst ? hold() : null;
    const started = Date.now();
    const pending = run();
    if (queueFirst) { await delay(HELD); await free(); } else {
      await until(() => calls[gate] === reads + 1);
      await delay(HELD);
      free = hold();
      gates[gate].resolve();
    }
    await assert.rejects(pending, (error) => error.status === 504 && new RegExp(`^${what}超过 ${BUDGET / 1000} 秒（含排队等待其他操作）`).test(error.message), label);
    const elapsed = Date.now() - started;
    if (elapsed > BUDGET + SLACK) late.push(`${label}: answered after ${elapsed}ms`);
    gates[gate].resolve(); gates[gate] = null;
    if (!queueFirst) await free();
    await drain();
    assert.equal(calls[gate], reads + 1, `${label}: one read`);
    assert.deepEqual([count(event), JSON.stringify(manager.state().changes), onDisk()], [events, state, disk], `${label}: nothing written`);
  }
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    await until(() => manager.state().chain);
    for (const op of ['add', 'batch', 'apply']) {
      await scenario(op, true);
      await scenario(op, false);
      await ops[op].run();
      assert.equal(count(ops[op].event), 1, `${op} completes on an idle queue`);
    }
    assert.equal(manager.state().config.permissions.pools.length, 2);
    assert.deepEqual(late, [], 'every step answered within the budget');
  } finally { for (const gate of Object.values(gates)) gate?.resolve(); await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the request deadline forwarded by the API, less the margin, caps the change budget; a missing or malformed one is ignored', { timeout: 15_000 }, async () => {
  const directory = fixtureDir();
  const { WETH, POOL, infos } = twoPools();
  let inspectGate = null, verifyGate = null;
  const chain = { ...fakeChain(),
    inspectPool: async (_rpc, address) => { await inspectGate?.promise; return infos[address]; },
    verifyActive: async () => { await verifyGate?.promise; return { ok: true, checks: [] }; } };
  const { manager } = managerWith(directory, { chain });
  const soon = () => Date.now() + CHANGE_DEADLINE_MARGIN_MS + 300;
  const add = (options) => manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } }, undefined, options);
  try {
    await manager.initialize(); await manager.save(baseConfig); await manager.setKey(KEY);
    await until(() => manager.state().chain);
    // The API gives up soon: the server answers first, well before its own 50 s budget, and queues nothing.
    inspectGate = deferred();
    let started = Date.now();
    await assert.rejects(add({ deadline: soon() }), (error) => error.status === 504 && /^加池超过 50 秒/.test(error.message));
    assert.ok(Date.now() - started < 2_000);
    inspectGate.resolve(); inspectGate = null;
    assert.equal(manager.state().changes.pools.length, 0);
    // A malformed deadline falls back to the server budget: a read slower than it would allow still completes.
    for (const deadline of ['soon', Number.NaN, 1.5]) {
      inspectGate = deferred();
      const adding = add({ deadline });
      await delay(400); inspectGate.resolve(); inspectGate = null;
      await adding;
      await manager.removePoolChange({ pool: POOL });
    }
    await add();
    await manager.buildChangeBatch(undefined, { deadline: Date.now() + 60_000 });
    verifyGate = deferred(); started = Date.now();
    await assert.rejects(manager.applyChangeBatch(undefined, { deadline: soon() }), (error) => error.status === 504 && /^核对启用超过 50 秒/.test(error.message));
    assert.ok(Date.now() - started < 2_000);
    verifyGate.resolve(); verifyGate = null;
    assert.equal(manager.state().config.permissions.pools.length, 1);
    const state = await manager.applyChangeBatch(undefined, { deadline: Date.now() + 60_000 });
    assert.equal(state.config.permissions.pools.length, 2);
  } finally { inspectGate?.resolve(); verifyGate?.resolve(); await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a queued pool records the gauge liveness reading; unknown survives a restart and old entries read as unknown', async () => {
  const directory = fixtureDir();
  const { POOL, POOL2, WETH, CBBTC, infos } = twoPools();
  const statuses = { [POOL]: { state: 'unknown', note: 'Voter 不提供 isAlive（调用回滚），无法确认 gauge 是否已被停用' }, [POOL2]: { state: 'alive', note: 'Voter.isAlive = true' } };
  const chain = { ...fakeChain(), inspectPool: async (_rpc, address) => ({ ...infos[address], gaugeStatus: statuses[address] }) };
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    await manager.save(baseConfig);
    await until(() => manager.state().chain);
    await manager.addPoolChange({ pool: POOL, allowances: { [WETH]: '1' } });
    const state = await manager.addPoolChange({ pool: POOL2, allowances: { [CBBTC]: '0.01' } });
    assert.deepEqual(state.changes.pools.map((p) => p.gaugeStatus.state), ['unknown', 'alive']);
    await manager.close();
    // Entries written by the previous version carry no reading at all.
    const file = join(directory, 'aero-safe/changes.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    delete saved.pools[1].gaugeStatus;
    writeFileSync(file, JSON.stringify(saved));
    const restarted = managerWith(directory, { chain }).manager;
    await restarted.initialize();
    const pools = restarted.state().changes.pools;
    assert.deepEqual(pools.map((p) => p.gaugeStatus.state), ['unknown', 'unknown']);
    assert.match(pools[0].gaugeStatus.note, /不提供 isAlive/);
    assert.match(pools[1].gaugeStatus.note, /未核对/);
    await restarted.close();
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
});
