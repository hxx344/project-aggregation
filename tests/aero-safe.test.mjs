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
import { PENDING_STALE_MS, PREVIEW_TTL_MS, createAeroSafe, strictAeroSafeConfig } from '../server/automation/aero-safe.mjs';
import { createApp } from '../server/app.mjs';

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

test('a saved single add-pool plan from the previous version becomes pending changes with its batch', async () => {
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
  const { manager } = managerWith(directory);
  try {
    await manager.initialize();
    const { changes } = manager.state();
    assert.deepEqual(changes.pools.map((p) => p.name), ['WETH/USDC ts100']);
    assert.equal(changes.allowances[0].perDay, '1000000000000000000');
    assert.deepEqual([changes.batch.transactions, changes.batch.stale, changes.batch.behind], [9, false, false]);
    assert.equal(existsSync(join(directory, 'aero-safe/pool-plan.json')), false);
    assert.equal(existsSync(join(directory, 'aero-safe/changes.json')), true);
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
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
