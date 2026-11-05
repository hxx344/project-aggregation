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
import { PENDING_STALE_MS, createAeroSafe, strictAeroSafeConfig } from '../server/automation/aero-safe.mjs';
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
  assert.equal(seen.persisted[0].nonce, 3); assert.equal(seen.persisted[0].replaces, null);
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
  assert.deepEqual(seen.persisted[0].replaces, { hash: prior.hash, label: '旧' });

  // The prior was mined meanwhile (nonce moved on): it is settled from the chain, not replaced.
  let current = { ...prior, nonce: 2 }; let resolved = 0;
  const moved = hookSet({ pending: () => current, resolvePrior: async () => { resolved++; current = null; } });
  await executor.sendRoleTx(ctxWith(fakeRpc()), moved.hooks, '新', [approve(AERO.nft)]);
  assert.equal(resolved, 1); assert.equal(moved.seen.persisted[0].replaces, null);
  const stuck = hookSet({ pending: () => ({ ...prior, nonce: 2 }), resolvePrior: async () => {} });
  await assert.rejects(executor.sendRoleTx(ctxWith(fakeRpc()), stuck.hooks, '新', [approve(AERO.nft)]), (error) => error.signed === false && /尚未结清/.test(error.message));
});

test('a broadcast whose receipt never arrives is reported as signed with an unknown result', async () => {
  const rpc = fakeRpc({ wait: () => null }), { seen, hooks } = hookSet();
  await assert.rejects(executor.sendRoleTx(ctxWith(rpc), hooks, '授权', [approve(AERO.nft)]), (error) => error.signed === true && error.code === 'unknown');
  assert.equal(seen.settled.length, 0); // the pending record stays for resolvePending
});

test('resolvePending confirms by hash, rebroadcasts while the nonce is open and finds a replaced original', async () => {
  const pending = { hash: '0x' + 'bb'.repeat(32), raw: '0x01', from: BOT.address, nonce: 5, replaces: { hash: '0x' + 'cc'.repeat(32), label: '旧' } };
  const mined = { status: 1, blockNumber: 1 };
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ receipts: { [pending.hash]: mined } })), pending), { state: 'confirmed', receipt: mined });
  const open = fakeRpc({ nonce: 5 });
  assert.deepEqual(await executor.resolvePending(ctxWith(open), pending), { state: 'waiting' });
  assert.deepEqual(open.broadcasts, ['0x01']);
  const original = { status: 1, blockNumber: 2 };
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ nonce: 6, receipts: { [pending.replaces.hash]: original } })), pending), { state: 'dropped', replacedReceipt: original });
  assert.deepEqual(await executor.resolvePending(ctxWith(fakeRpc({ nonce: 6 })), { ...pending, replaces: null }), { state: 'dropped', replacedReceipt: null });
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
    readState: async () => ({ blockNumber: 1, timestamp: 1, bot: BOT.address, botEth: 1n, latestNonce: 0, pendingNonce: 0, balances: {}, allowances: [], pools: [] }),
    resolvePending: overrides.resolvePending ?? (async () => ({ state: 'waiting' })),
    claimRewards: async (ctx, hooks) => { calls.push('claim'); await sign(ctx, hooks, '领取排放'); return { claimed: true }; },
    sellRewards: async (_ctx, _hooks, options) => { calls.push(['sell', options.minAmount]); return { sold: false }; },
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
  const chain = fakeChain({ resolvePending: async () => ({ state: 'dropped', replacedReceipt: { status: 1, blockNumber: 7, gasUsed: 5n, fee: 2n } }) });
  const first = managerWith(directory, { chain });
  try { await first.manager.initialize(); await first.manager.save(baseConfig); await first.manager.setKey(KEY); } finally { await first.manager.close(); }
  writeFileSync(join(directory, 'aero-safe/txs.jsonl'), `${JSON.stringify({ hash: original, label: '旧兑换', status: 'replaced' })}\n`);
  writeFileSync(join(directory, 'aero-safe/pending.json'), JSON.stringify({ hash: replacement, raw: '0x00', from: BOT.address, nonce: 4, label: '新兑换', at: 0, replaces: { hash: original, label: '旧兑换' } }));
  const { manager } = managerWith(directory, { chain });
  try {
    await manager.initialize();
    const state = await until(() => manager.state().ledger.length === 2 && !manager.state().refreshing && manager.state());
    assert.equal(state.pending, null);
    assert.deepEqual(state.ledger.map((e) => [e.hash, e.status]), [[replacement, 'dropped'], [original, 'confirmed']]);
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
