import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, MaxUint256, Wallet, getAddress } from 'ethers';
import { AERO, ROLES, SAFE } from '../tools/aero-roles/addresses.mjs';
import { AbiType, Operator, c, evaluate, flatten } from '../tools/aero-roles/conditions.mjs';
import { buildPermissions, normalizeConfig } from '../tools/aero-roles/permissions.mjs';
import { accrue, accruedAllowance, checkTransactions } from '../tools/aero-roles/policy.mjs';
import { gaugeLiveness, readAllowances } from '../tools/aero-roles/executor.mjs';
import { ROLES_ABI, allowancePlan, buildSetupBatch, buildUpdateBatch, conditionUsage, encodeMultiSend, encodeRoleExecution, predictRolesAddress, updateBatchSize } from '../tools/aero-roles/roles-calls.mjs';

const config = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const SAFE_ADDR = new Wallet('0x' + '22'.repeat(32)).address;
const BOT = new Wallet('0x' + '33'.repeat(32)).address;
const OTHER = new Wallet('0x' + '44'.repeat(32)).address;
const [USDC, RSGP, AERO_TOKEN] = config.allowances.map((a) => getAddress(a.token));
const GAUGE = getAddress(config.pools[0].gauge);
const permissions = buildPermissions(config);
const UNSET = Object.freeze({ refill: 0n, maxRefill: 0n, period: 0n, balance: 0n, timestamp: 0n });
// 生成批次时的链上额度读数：默认全部尚未设置。
const unsetState = (perms, now = 1_800_000_000n) => ({ now, allowances: new Map(perms.allowances.map((a) => [a.key, UNSET])) });

const NPM_I = new Interface([
  'function mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160))',
  'function collect((uint256,address,uint128,uint128))',
  'function burn(uint256)', 'function transferFrom(address,address,uint256)', 'function approve(address,uint256)',
]);
const ERC20_I = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']);
const GAUGE_I = new Interface(['function deposit(uint256)', 'function claimEmissions(address,address)']);

const ownedBySafe = new Set([7n]);
const ctx = (remaining = 10n ** 30n) => ({ avatar: SAFE_ADDR, ownerOf: async (_to, id) => (ownedBySafe.has(BigInt(id)) ? SAFE_ADDR : OTHER), allowance: async () => remaining });
const mint = (o = {}) => {
  const p = { token0: RSGP, token1: USDC, ts: 100, lo: -1000, hi: 1000, a0: 10n, a1: 10n, recipient: SAFE_ADDR, sqrt: 0n, ...o };
  return { to: AERO.nft, data: NPM_I.encodeFunctionData('mint', [[p.token0, p.token1, p.ts, p.lo, p.hi, p.a0, p.a1, 0, 0, p.recipient, 1n << 40n, p.sqrt]]) };
};

test('flatten emits BFS order with parent indexes and rejects a non-Calldata root', () => {
  const tree = c.calldata(c.tuple(c.avatar(), c.pass()), c.oneOf([c.address(USDC), c.address(RSGP)]));
  const flat = flatten(tree);
  assert.deepEqual(flat.map((n) => [n.parent, n.paramType, n.operator]), [
    [0, AbiType.Calldata, Operator.Matches],
    [0, AbiType.Tuple, Operator.Matches], [0, AbiType.None, Operator.Or],
    [1, AbiType.Static, Operator.EqualToAvatar], [1, AbiType.Static, Operator.Pass],
    [2, AbiType.Static, Operator.EqualTo], [2, AbiType.Static, Operator.EqualTo],
  ]);
  for (let i = 1; i < flat.length; i++) assert.ok(flat[i].parent >= flat[i - 1].parent, 'parents must be non-decreasing');
  assert.throws(() => flatten(c.tuple(c.pass())), /Calldata/);
  assert.equal(c.oneOf([c.pass()]).operator, Operator.Pass, 'single option is not wrapped in Or');
});

test('normalizeConfig rejects configs that would widen or break the role', () => {
  const variant = (patch) => ({ ...structuredClone(config), ...patch });
  assert.throws(() => normalizeConfig(variant({ roleKey: 'x'.repeat(32) })), /roleKey/);
  assert.throws(() => normalizeConfig(variant({ pools: [{ ...config.pools[0], token0: USDC, token1: RSGP }] })), /token0 must sort below token1/);
  assert.throws(() => normalizeConfig(variant({ allowances: config.allowances.filter((a) => a.symbol !== 'AERO') })), /no allowance/);
  assert.throws(() => normalizeConfig(variant({ allowances: [...config.allowances, config.allowances[0]] })), /duplicate token/);
  assert.throws(() => normalizeConfig(variant({ allowances: config.allowances.map((a, i) => (i ? a : { ...a, perDay: '1e9' })) })), /positive integer/);
  // JSON 数字超过 2^53 会丢精度，必须写成字符串。
  assert.throws(() => normalizeConfig(variant({ allowances: config.allowances.map((a, i) => (i ? a : { ...a, perDay: 1000000000 })) })), /positive integer string/);
  assert.throws(() => normalizeConfig(variant({ pools: [config.pools[0], { ...config.pools[0], name: 'dup' }] })), /duplicate gauge/);
  assert.throws(() => normalizeConfig(variant({ swaps: [{ tokenIn: USDC, tokenOut: USDC, tickSpacing: 100 }] })), /tokenIn equals tokenOut/);
  // Safe v1.5.0 的 MultiSendCallOnly 把 to = 0 改写为 Safe 自身，任何指向零地址的授权都不允许。
  assert.throws(() => normalizeConfig(variant({ pools: [{ ...config.pools[0], gauge: '0x0000000000000000000000000000000000000000' }] })), /zero address/);
  assert.throws(() => normalizeConfig(variant({ allowances: [...config.allowances, { token: '0x0000000000000000000000000000000000000000', symbol: 'Z', perDay: '1' }] })), /zero address/);
  for (const [field, patch] of [['token0', { token0: ZERO }], ['token1', { token1: ZERO }]]) assert.throws(() => normalizeConfig(variant({ pools: [{ ...config.pools[0], ...patch }] })), new RegExp(`pools\\[0\\]\\.${field}: zero address`));
  for (const field of ['tokenIn', 'tokenOut']) assert.throws(() => normalizeConfig(variant({ swaps: [{ ...config.swaps[0], [field]: ZERO }] })), new RegExp(`swaps\\[0\\]\\.${field}: zero address`));
});

test('every permitted function uses plain call options and fits the Roles condition limit', () => {
  for (const target of permissions.targets) {
    for (const f of target.functions) {
      assert.equal(f.options, 0, `${target.label}.${f.label} must not allow send or delegatecall`);
      if (f.condition) assert.ok(flatten(f.condition).length <= 255);
    }
  }
  const labels = Object.fromEntries(permissions.targets.map((t) => [t.target, t.functions.map((f) => f.label)]));
  assert.deepEqual(labels[AERO.nft], ['mint', 'decreaseLiquidity', 'collect', 'burn', 'approve']);
  assert.deepEqual(labels[AERO_TOKEN], ['approve']);
  assert.ok(!labels[SAFE_ADDR], 'the Safe itself is never a target');
});

test('local policy accepts the intended flow and rejects outflow paths', async () => {
  const ok = async (txs, x = ctx()) => assert.deepEqual(await checkTransactions(permissions, txs, x), { ok: true });
  const bad = async (txs, pattern, x = ctx()) => {
    const result = await checkTransactions(permissions, txs, x);
    assert.equal(result.ok, false);
    assert.match(result.reason, pattern);
  };
  await ok([{ to: RSGP, data: ERC20_I.encodeFunctionData('approve', [AERO.nft, MaxUint256]) }, mint()]);
  await ok([{ to: AERO.nft, data: NPM_I.encodeFunctionData('approve', [GAUGE, 7n]) }, { to: GAUGE, data: GAUGE_I.encodeFunctionData('deposit', [7n]) }]);
  await ok([{ to: GAUGE, data: GAUGE_I.encodeFunctionData('claimEmissions', [SAFE_ADDR, SAFE_ADDR]) }]);

  await bad([mint({ recipient: OTHER })], /not the Safe/);
  await bad([mint({ sqrt: 1n })], /not allowed/);
  await bad([mint({ ts: 200 })], /not allowed/);
  await bad([mint({ a1: 11n })], /exceeds remaining allowance 10/, ctx(10n));
  await bad([{ ...mint(), value: 1n }], /sending ETH/);
  await bad([{ to: USDC, data: ERC20_I.encodeFunctionData('transfer', [OTHER, 1n]) }], /not allowed on ERC20 USDC/);
  await bad([{ to: AERO_TOKEN, data: ERC20_I.encodeFunctionData('approve', [AERO.nft, 1n]) }], /not allowed/);
  await bad([{ to: AERO.nft, data: NPM_I.encodeFunctionData('transferFrom', [SAFE_ADDR, OTHER, 7n]) }], /not allowed on NonfungiblePositionManager/);
  await bad([{ to: AERO.nft, data: NPM_I.encodeFunctionData('collect', [[7n, OTHER, 1n, 1n]]) }], /not the Safe/);
  await bad([{ to: AERO.nft, data: NPM_I.encodeFunctionData('burn', [8n]) }], /not the Safe/);
  await bad([{ to: GAUGE, data: GAUGE_I.encodeFunctionData('claimEmissions', [SAFE_ADDR, OTHER]) }], /not the Safe/);
  await bad([{ to: SAFE_ADDR, data: '0x610b5925' + '00'.repeat(32) }], /is not allowed/);
  // 一批里只要有一笔不合规就整体拒绝，并指出第几笔。
  const mixed = await checkTransactions(permissions, [mint(), { to: USDC, data: ERC20_I.encodeFunctionData('transfer', [OTHER, 1n]) }], ctx());
  assert.equal(mixed.index, 1);
});

test('allowance is required and consumption accumulates across a batch', async () => {
  // 桩里每个代币额度都是 10；USDC 单笔 6 在额度内，同批两笔合计 12 超额：第二笔被拒。
  const twice = await checkTransactions(permissions, [mint({ a0: 1n, a1: 6n }), mint({ a0: 1n, a1: 6n })], ctx(10n));
  assert.equal(twice.ok, false);
  assert.equal(twice.index, 1);
  assert.match(twice.reason, /exceeds remaining allowance 4/);
  assert.equal((await checkTransactions(permissions, [mint({ a0: 1n, a1: 5n }), mint({ a0: 1n, a1: 5n })], ctx(10n))).ok, true);
  // 没有额度读数时不能静默放行。
  for (const x of [{ ...ctx(), allowance: undefined }, ctx(null)]) {
    const result = await checkTransactions(permissions, [mint()], x);
    assert.equal(result.ok, false);
    assert.match(result.reason, /allowance unknown/);
  }
});

test('allowance consumption: Or keeps only the matching branch, one key used twice adds up, nested Matches add up', async () => {
  const key = '0x' + 'ab'.repeat(32);
  const ctx = { allowance: async () => 10n };
  // 第一个分支先扣 6 再因第二个字段失败：扣减随分支丢弃，第二个分支看到完整额度，只计 6。
  const branchy = c.oneOf([c.tuple(c.allowance(key), c.equal('uint256', 1n)), c.tuple(c.allowance(key), c.pass())]);
  assert.deepEqual(await evaluate(branchy, [6n, 2n], ctx), { ok: true, consumed: [[key, 6n]] });
  // 同一笔交易里两个字段用同一个额度：第二个字段只剩 4。
  const twice = await evaluate(c.calldata(c.allowance(key), c.allowance(key)), [6n, 6n], ctx);
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /exceeds remaining allowance 4/);
  // 三层嵌套：内层的消耗对外层后面的字段可见，且不重复计数。
  const nested = c.calldata(c.tuple(c.tuple(c.allowance(key)), c.allowance(key)), c.allowance(key));
  assert.deepEqual(await evaluate(nested, [[[3n], 3n], 4n], ctx), { ok: true, consumed: [[key, 3n], [key, 3n], [key, 4n]] });
  const over = await evaluate(nested, [[[3n], 3n], 5n], ctx);
  assert.equal(over.ok, false);
  assert.match(over.reason, /exceeds remaining allowance 4/);
});

test('accruedAllowance follows the Roles refill rule', () => {
  const a = { refill: 100n, maxRefill: 100n, period: 86400n, balance: 30n, timestamp: 1000n };
  assert.equal(accruedAllowance(a, 1000n + 86399n), 30n);
  assert.equal(accruedAllowance(a, 1000n + 86400n), 100n, 'full refill, capped at maxRefill');
  assert.equal(accruedAllowance({ ...a, maxRefill: 1000n }, 1000n + 86400n * 3n), 330n, 'one refill per elapsed period');
  assert.equal(accruedAllowance({ ...a, period: 0n }, 10n ** 12n), 30n, 'period 0 never refills');
  assert.equal(accruedAllowance({ ...a, balance: 150n }, 1000n + 86400n), 150n, 'above maxRefill stays unchanged');
});

test('setup batch deploys, enables, scopes and assigns in order', () => {
  const { roles, transactions } = buildSetupBatch({ permissions, safe: SAFE_ADDR, bot: BOT, saltNonce: 5n });
  assert.equal(roles, predictRolesAddress(SAFE_ADDR, 5n));
  assert.notEqual(roles, predictRolesAddress(SAFE_ADDR, 6n));
  assert.equal(transactions[0].to, ROLES.moduleProxyFactory);
  assert.equal(transactions[1].to, SAFE_ADDR);
  const last = ROLES_ABI.parseTransaction({ data: transactions.at(-1).data });
  assert.equal(last.name, 'assignRoles');
  assert.deepEqual([last.args[0], [...last.args[2]]], [BOT, [true]]);
  assert.ok(transactions.slice(2).every((t) => t.to === roles && t.value === '0'));
  assert.throws(() => buildSetupBatch({ permissions, safe: SAFE_ADDR, bot: SAFE_ADDR, saltNonce: 1n }), /bot must not be the Safe/);
  // 第二道防线：即使 permissions 绕过 normalizeConfig 带入零地址目标，也不生成 scopeTarget(0x0)。
  assert.throws(() => buildSetupBatch({ permissions: { ...permissions, targets: [{ ...permissions.targets[0], target: ZERO }] }, safe: SAFE_ADDR, bot: BOT, saltNonce: 1n }), /refusing to scope the zero address/);
});

test('MultiSend packing and role execution encoding', () => {
  const data = '0xdeadbeef';
  const packed = new Interface(['function multiSend(bytes)']).decodeFunctionData('multiSend', encodeMultiSend([{ to: USDC, data }, { to: RSGP, value: 3n, data: '0x' }]))[0];
  // 每笔 1 + 20 + 32 + 32 + len(data) 字节
  assert.equal((packed.length - 2) / 2, (85 + 4) + 85);
  assert.equal(packed.slice(2, 4), '00');
  assert.equal(getAddress('0x' + packed.slice(4, 44)), USDC);
  assert.equal(BigInt('0x' + packed.slice(108, 172)), 4n);
  const single = ROLES_ABI.parseTransaction({ data: encodeRoleExecution(permissions.roleKeyBytes, [{ to: USDC, data }]) });
  assert.deepEqual([single.args[0], single.args[3]], [USDC, 0n]);
  const multi = ROLES_ABI.parseTransaction({ data: encodeRoleExecution(permissions.roleKeyBytes, [{ to: USDC, data }, { to: RSGP, data }]) });
  assert.deepEqual([multi.args[0], multi.args[1], multi.args[3]], [SAFE.multiSendCallOnly, 0n, 1n]);
});

test('a token or gauge cannot collide with another Roles target or a protocol contract', () => {
  const withPool = (a, b, gauge) => {
    const [token0, token1] = [getAddress(a), getAddress(b)].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    return { ...config, pools: [...config.pools, { name: 'x', token0, token1, tickSpacing: 100, gauge }],
    allowances: [...config.allowances, ...[token0, token1].filter((t) => !config.allowances.some((a) => getAddress(a.token) === getAddress(t))).map((token) => ({ token, symbol: 'X', perDay: '1' }))] };
  };
  const OTHER_TOKEN = new Wallet('0x' + '77'.repeat(32)).address, GAUGE = new Wallet('0x' + '78'.repeat(32)).address;
  assert.throws(() => buildPermissions(withPool(AERO.nft, USDC, GAUGE)), /duplicate Roles target|protocol contract/);
  assert.throws(() => buildPermissions(withPool(OTHER_TOKEN, USDC, AERO.voter)), /protocol contract/);
  assert.throws(() => buildPermissions(withPool(OTHER_TOKEN, USDC, SAFE.multiSendCallOnly)), /protocol contract/);
  assert.throws(() => buildPermissions(withPool(config.pools[0].gauge, USDC, GAUGE)), /duplicate Roles target/);
  assert.ok(buildPermissions(withPool(OTHER_TOKEN, USDC, GAUGE)).targets.length > permissions.targets.length);
});

test('add-pool update batch only scopes what changed and never resets an existing allowance', () => {
  const ROLES_ADDR = new Wallet('0x' + '55'.repeat(32)).address;
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const NEW_GAUGE = new Wallet('0x' + '66'.repeat(32)).address;
  const next = buildPermissions({ ...config,
    pools: [...config.pools, { name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: 100, gauge: NEW_GAUGE }],
    swaps: [...config.swaps, { tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }, { tokenIn: USDC, tokenOut: WETH, tickSpacing: 100 }],
    allowances: [...config.allowances, { token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }] });
  const txs = buildUpdateBatch({ current: permissions, next, roles: ROLES_ADDR, allowanceState: unsetState(next) });
  assert.equal(updateBatchSize({ current: permissions, next, roles: ROLES_ADDR }), txs.length);
  assert.ok(txs.every((t) => t.to === ROLES_ADDR && t.value === '0'));
  const calls = txs.map((t) => ROLES_ABI.parseTransaction({ data: t.data }));
  const scoped = (name) => calls.filter((c) => c.name === name).map((c) => (name === 'scopeTarget' ? c.args[1] : `${c.args[1]}:${c.args[2]}`));
  // New targets: the gauge and WETH; NPM, Router and USDC already exist and are not re-scoped.
  assert.deepEqual(scoped('scopeTarget').sort(), [NEW_GAUGE, WETH].sort());
  const selector = (sig) => Interface.from([`function ${sig}`]).getFunction(sig.slice(0, sig.indexOf('('))).selector;
  const changed = scoped('scopeFunction');
  // NPM mint gains a branch and NPM approve a gauge; Router gains two routes; USDC approve is unchanged (NPM + Router already).
  assert.ok(changed.includes(`${AERO.nft}:${selector('mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160))')}`));
  assert.ok(changed.includes(`${AERO.nft}:${selector('approve(address,uint256)')}`));
  assert.ok(changed.includes(`${AERO.swapRouter}:${selector('exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))')}`));
  assert.ok(!changed.some((c) => c.startsWith(`${USDC}:`)));
  assert.ok(!changed.some((c) => c.startsWith(`${AERO.nft}:${selector('collect((uint256,address,uint128,uint128))')}`)));
  assert.equal(scoped('allowFunction').filter((c) => c.startsWith(NEW_GAUGE)).length, 3); // deposit, withdraw, emergencyWithdraw
  const allowances = calls.filter((c) => c.name === 'setAllowance');
  assert.equal(allowances.length, 1);
  assert.equal(allowances[0].args[0], next.allowances.find((a) => a.token === WETH).key);
  assert.ok(!calls.some((c) => c.name === 'assignRoles' || c.name === 'setTransactionUnwrapper'));
  // Nothing changed → nothing to sign; dropping a pool is refused.
  assert.deepEqual(buildUpdateBatch({ current: permissions, next: permissions, roles: ROLES_ADDR }), []);
  assert.throws(() => buildUpdateBatch({ current: next, next: permissions, roles: ROLES_ADDR }), /drop/);
  // Changing one daily amount re-issues only that allowance; with no allowance on chain yet it is a first setting (balance = refill = maxRefill).
  const bumped = buildPermissions({ ...config, allowances: config.allowances.map((a, i) => (i === 0 ? { ...a, perDay: '1' } : a)) });
  assert.throws(() => buildUpdateBatch({ current: permissions, next: bumped, roles: ROLES_ADDR }), /allowance state required/);
  const adjust = buildUpdateBatch({ current: permissions, next: bumped, roles: ROLES_ADDR, allowanceState: unsetState(bumped) }).map((t) => ROLES_ABI.parseTransaction({ data: t.data }));
  assert.deepEqual(adjust.map((c) => c.name), ['setAllowance']);
  assert.equal(adjust[0].args[0], permissions.allowances[0].key);
  assert.deepEqual([adjust[0].args[1], adjust[0].args[2], adjust[0].args[3], adjust[0].args[4], adjust[0].args[5]], [1n, 1n, 1n, 86400n, 0n]);
});

test('the whitelist fills up at the Roles 255-node limit with about 13 pools', () => {
  let current = permissions, cfg = config, added = 0;
  for (let i = 1; i < 40; i++) {
    const [a, b] = [new Wallet('0x' + (1000 + 2 * i).toString(16).padStart(64, '0')).address, new Wallet('0x' + (1001 + 2 * i).toString(16).padStart(64, '0')).address].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    const gauge = new Wallet('0x' + (5000 + i).toString(16).padStart(64, '0')).address;
    const candidate = { ...cfg, pools: [...cfg.pools, { name: `p${i}`, token0: a, token1: b, tickSpacing: 100, gauge }],
      swaps: [...cfg.swaps, { tokenIn: a, tokenOut: b, tickSpacing: 100 }, { tokenIn: b, tokenOut: a, tickSpacing: 100 }],
      allowances: [...cfg.allowances, { token: a, symbol: 'A', perDay: '1' }, { token: b, symbol: 'B', perDay: '1' }] };
    const next = buildPermissions(candidate);
    try { updateBatchSize({ current, next, roles: OTHER }); } catch (error) { assert.match(error.message, /condition tree has \d+ nodes/); break; }
    current = next; cfg = candidate; added++;
  }
  assert.equal(added, 12); // the swap Or tree (2 + 9 per route) runs out first: 3 existing routes + 2 per pool
  assert.ok(conditionUsage(current).every((u) => u.nodes <= 255));
});

// 已部署的 Roles v2 mastercopy（ROLES.mastercopy，Base 上 Sourcify 已验证源码）的额度规则，按 Solidity 逐行重写，不引用被测代码：
// AllowanceTracker._accruedAllowance、_flushPrepare（消费后写回折算余额与时间戳），PermissionBuilder.setAllowance
// （maxRefill 传 0 记为 uint128 上限，timestamp 传 0 记为执行区块时间）。
const U128_MAX = (1n << 128n) - 1n;
function solidityAccrued(allowance, blockTimestamp) {
  if (allowance.period === 0n || blockTimestamp < allowance.timestamp + allowance.period) return [allowance.balance, allowance.timestamp];
  const elapsedIntervals = (blockTimestamp - allowance.timestamp) / allowance.period;
  let balance;
  if (allowance.balance < allowance.maxRefill) {
    balance = allowance.balance + allowance.refill * elapsedIntervals;
    balance = balance < allowance.maxRefill ? balance : allowance.maxRefill;
  } else {
    balance = allowance.balance;
  }
  return [balance, allowance.timestamp + elapsedIntervals * allowance.period];
}
function referenceRoles() {
  const store = new Map(), spent = [];
  const at = (key) => store.get(key) ?? { ...UNSET };
  return {
    read: (key) => ({ ...at(key) }),
    setAllowance(tx, blockTimestamp) {
      const call = ROLES_ABI.parseTransaction({ data: tx.data });
      assert.equal(call.name, 'setAllowance');
      const [key, balance, maxRefill, refill, period, timestamp] = call.args;
      store.set(key, { refill, maxRefill: maxRefill !== 0n ? maxRefill : U128_MAX, period, timestamp: timestamp !== 0n ? timestamp : blockTimestamp, balance });
    },
    consume(key, consumed, blockTimestamp) {
      const a = at(key), [balance, timestamp] = solidityAccrued(a, blockTimestamp);
      if (consumed > balance) return false;
      store.set(key, { ...a, balance: balance - consumed, timestamp });
      spent.push({ key, at: blockTimestamp, amount: consumed });
      return true;
    },
    spendable: (key, blockTimestamp) => solidityAccrued(at(key), blockTimestamp)[0],
    // bot 私钥泄露时的最坏情况：把当前可用全部花掉。
    drain(key, blockTimestamp) {
      const value = solidityAccrued(at(key), blockTimestamp)[0];
      if (value) assert.equal(this.consume(key, value, blockTimestamp), true);
      return value;
    },
    spentBetween: (key, from, to) => spent.filter((s) => s.key === key && s.at >= from && s.at < to).reduce((sum, s) => sum + s.amount, 0n),
  };
}
const withFirstPerDay = (perDay) => buildPermissions({ ...config, allowances: config.allowances.map((a, i) => (i === 0 ? { ...a, perDay } : a)) });

test('policy.accrue matches the reference Roles v2 rule', () => {
  const values = [0n, 1n, 30n, 100n, 150n];
  for (const refill of [0n, 50n, 100n]) for (const maxRefill of [1n, 100n, U128_MAX]) for (const period of [0n, 3600n, 86400n]) for (const balance of values) {
    for (const timestamp of [0n, 1000n]) for (const dt of [0n, 3599n, 3600n, 86399n, 86400n, 3n * 86400n + 7n]) {
      const allowance = { refill, maxRefill, period, balance, timestamp }, now = timestamp + dt;
      const [b, t] = solidityAccrued(allowance, now);
      assert.deepEqual(accrue(allowance, now), { balance: b, timestamp: t }, JSON.stringify({ ...allowance, now }, (_, v) => String(v)));
    }
  }
});

test('an allowance adjustment stays within the stated period limits at every execution time (reference Roles v2 model)', () => {
  const ROLES_ADDR = new Wallet('0x' + '56'.repeat(32)).address;
  const DAY = 86_400n, H = 3_600n;
  // Setup at 21:00 UTC: timestamp 0 becomes the setup block time, so periods follow the setup, not UTC midnight.
  const setupAt = 20_000n * DAY - 3n * H, p1 = setupAt + DAY;
  const current = withFirstPerDay('100'), key = current.allowances[0].key;
  const setup = buildSetupBatch({ permissions: current, safe: SAFE_ADDR, bot: BOT, saltNonce: 1n });
  const setupAllowance = setup.transactions.find((t) => { const c = ROLES_ABI.parseTransaction({ data: t.data }); return c?.name === 'setAllowance' && c.args[0] === key; });
  const fresh = () => { const r = referenceRoles(); r.setAllowance(setupAllowance, setupAt); return r; };
  const batchAt = (roles, next, now) => {
    const txs = buildUpdateBatch({ current, next, roles: ROLES_ADDR, allowanceState: { now, allowances: new Map(next.allowances.map((a) => [a.key, roles.read(a.key)])) } });
    assert.equal(txs.length, 1);
    return txs[0];
  };
  assert.equal(fresh().read(key).timestamp, setupAt);
  const t1 = setupAt + 10n * H;

  // 1. Spent 30, lowered to 50 and executed an hour later; draining afterwards stops at a period total of 50 (limits.idle).
  const r1 = fresh();
  assert.equal(r1.consume(key, 30n, t1), true);
  const lower = batchAt(r1, withFirstPerDay('50'), t1);
  assert.deepEqual([lower.allowance.used, lower.allowance.balance, lower.allowance.first], ['30', '20', false]);
  assert.deepEqual([lower.allowance.nextRefill, lower.allowance.executeBefore], [Number(p1), Number(p1 - 600n)]);
  assert.deepEqual(lower.allowance.limits, { idle: '50', inTime: '120', late: '150' });
  assert.match(lower.description, /本期已用 30，执行后本期剩余 20.*须在 .+ UTC 前执行，期限前执行本期累计最多 120（生成后 bot 不再花时 50）.*执行当期累计最多 150/);
  r1.setAllowance(lower, t1 + H);
  assert.equal(r1.drain(key, t1 + H), 20n);
  assert.equal(r1.spentBetween(key, setupAt, p1), 50n);
  assert.equal(r1.spendable(key, p1), 50n, 'the next period gets the new full budget');

  // 2. Spend first, then execute in the same period: the bot drains the old remaining 70 after generation, so 30 + 70 + 20 = limits.inTime.
  const r2 = fresh();
  assert.equal(r2.consume(key, 30n, t1), true);
  const b2 = batchAt(r2, withFirstPerDay('50'), t1);
  assert.equal(r2.drain(key, t1 + H), 70n);
  r2.setAllowance(b2, BigInt(b2.allowance.executeBefore) - 1n);
  r2.drain(key, BigInt(b2.allowance.executeBefore) - 1n);
  assert.equal(r2.spentBetween(key, setupAt, p1), BigInt(b2.allowance.limits.inTime));

  // 3. Cross-period, spend first, then execute: generated on day 1 with nothing spent; on day 2 the bot spends the old 100 and only then the batch runs.
  const r3 = fresh(), g3 = setupAt + 20n * H;
  const b3 = batchAt(r3, withFirstPerDay('50'), g3);
  assert.deepEqual(b3.allowance.limits, { idle: '50', inTime: '150', late: '150' });
  const day2 = p1 + 2n * H;
  assert.ok(day2 > BigInt(b3.allowance.nextRefill));
  assert.equal(r3.drain(key, day2), 100n);
  r3.setAllowance(b3, day2 + H);
  assert.equal(r3.drain(key, day2 + H), 50n, 'executed after the deadline the first spend refills to the new budget');
  assert.equal(r3.spentBetween(key, p1, p1 + DAY), BigInt(b3.allowance.limits.late));
  assert.ok(BigInt(b3.allowance.limits.late) > 50n, 'a late execution exceeds the new daily amount, which is why the batch carries a deadline');

  // 4. Sweep every execution hour across two period boundaries with a bot that drains before and after the execution:
  //    the execution period stays within inTime (before nextRefill) or late (after), the periods before within the old cap, later ones within the new budget.
  let lateExceeded = false;
  for (let execAt = t1 + 1n; execAt < t1 + 2n * DAY + 6n * H; execAt += H) {
    const r = fresh();
    assert.equal(r.consume(key, 30n, t1), true);
    const b = batchAt(r, withFirstPerDay('50'), t1);
    const periodOf = (t) => setupAt + ((t - setupAt) / DAY) * DAY;
    for (const t of [t1, ...[p1, p1 + DAY, p1 + 2n * DAY].filter((ps) => ps < execAt), execAt - 1n]) if (t >= t1 && t < execAt) r.drain(key, t);
    r.setAllowance(b, execAt);
    for (const t of [execAt, ...[p1, p1 + DAY, p1 + 2n * DAY, p1 + 3n * DAY].filter((ps) => ps > execAt)]) r.drain(key, t);
    const execPeriod = periodOf(execAt);
    const bound = execAt < BigInt(b.allowance.nextRefill) ? BigInt(b.allowance.limits.inTime) : BigInt(b.allowance.limits.late);
    const total = r.spentBetween(key, execPeriod, execPeriod + DAY);
    assert.ok(total <= bound, `executed at +${execAt - t1}s: period total ${total} exceeds the stated ${bound}`);
    if (execAt >= BigInt(b.allowance.nextRefill) && total > 50n) lateExceeded = true;
    for (let ps = setupAt; ps < execPeriod; ps += DAY) assert.ok(r.spentBetween(key, ps, ps + DAY) <= 100n);
    for (let ps = execPeriod + DAY; ps <= p1 + 3n * DAY; ps += DAY) assert.ok(r.spentBetween(key, ps, ps + DAY) <= 50n);
  }
  assert.ok(lateExceeded);

  // 5. Replays: the same period re-opens replay.samePeriod; a later period refills to replay.laterPeriod.
  assert.equal(lower.allowance.replay.samePeriod, '20');
  r1.setAllowance(lower, t1 + 2n * H);
  assert.equal(r1.spendable(key, t1 + 2n * H), 20n);
  const t3 = p1 + 5n * H;
  assert.equal(r1.drain(key, t3), 50n);
  r1.setAllowance(lower, t3 + 1n);
  assert.equal(r1.spendable(key, t3 + 1n), BigInt(lower.allowance.replay.laterPeriod));

  // 6. Raising after spending 30: 150 − 30 = 120 left this period.
  const r6 = fresh();
  assert.equal(r6.consume(key, 30n, t1), true);
  r6.setAllowance(batchAt(r6, withFirstPerDay('150'), t1), t1 + H);
  assert.equal(r6.spendable(key, t1 + H), 120n);

  // 7. A first setting has no deadline: whenever it runs, its period starts at the execution block and holds perDay.
  const next = buildPermissions({ ...config, allowances: [...config.allowances, { token: getAddress('0x4200000000000000000000000000000000000006'), symbol: 'WETH', perDay: '7' }] });
  const [firstTx] = buildUpdateBatch({ current: permissions, next, roles: ROLES_ADDR, allowanceState: unsetState(next, t1) });
  assert.deepEqual([firstTx.allowance.first, firstTx.allowance.executeBefore], [true, null]);
  const wethKey = next.allowances.at(-1).key, r7 = referenceRoles(), runAt = t1 + 5n * DAY + 123n;
  r7.setAllowance(firstTx, runAt);
  assert.equal(r7.drain(wethKey, runAt), 7n);
  assert.equal(r7.spendable(wethKey, runAt + DAY - 1n), 0n);
  assert.equal(r7.spendable(wethKey, runAt + DAY), 7n);
});

test('allowancePlan: lowering below the spent amount, stale timestamps, other periods, first setting and an uncapped allowance', () => {
  const DAY = 86_400n, day0 = 20_000n * DAY, now = day0 + 7_200n;
  const spent30 = { refill: 100n, maxRefill: 100n, period: DAY, balance: 70n, timestamp: day0 };
  assert.deepEqual(allowancePlan({ perDay: '150', period: 86400, onchain: spent30, now }), { first: false, balance: 120n, timestamp: day0, used: 30n, nextRefill: day0 + DAY,
    executeBefore: day0 + DAY - 600n, limits: { idle: 150n, inTime: 220n, late: 250n }, replay: { samePeriod: 120n, laterPeriod: 150n } });
  const below = allowancePlan({ perDay: '20', period: 86400, onchain: spent30, now });
  assert.deepEqual([below.balance, below.limits.idle], [0n, 30n], 'lowering below the spent amount leaves nothing; the period total is what was already spent');
  // No spending for days: the reading accrues to the current period start, so nothing counts as spent.
  const idle = allowancePlan({ perDay: '50', period: 86400, onchain: { refill: 100n, maxRefill: 100n, period: DAY, balance: 70n, timestamp: 0n }, now });
  assert.deepEqual([idle.balance, idle.timestamp, idle.used], [50n, day0, 0n]);
  // A longer on-chain period moves the start forward to the 24-hour period holding now; a shorter one cannot bound spending before the deadline.
  const weekly = allowancePlan({ perDay: '50', period: 86400, onchain: { ...spent30, period: 7n * DAY, timestamp: day0 - 3n * DAY }, now });
  assert.deepEqual([weekly.timestamp, weekly.used, weekly.nextRefill], [day0, 30n, day0 + DAY]);
  const hourly = allowancePlan({ perDay: '50', period: 86400, onchain: { ...spent30, period: 3_600n, timestamp: now - 60n }, now });
  assert.deepEqual([hourly.timestamp, hourly.limits], [now - 60n, { idle: 50n, inTime: null, late: null }]);
  // A longer period that is not a whole number of days refills inside the 24-hour period (36 h: at now + 6 h, before nextRefill at now + 18 h).
  const odd = allowancePlan({ perDay: '50', period: 86400, onchain: { ...spent30, period: 36n * 3_600n, timestamp: now - 30n * 3_600n }, now });
  assert.deepEqual([odd.timestamp, odd.nextRefill, odd.limits], [now - 6n * 3_600n, now + 18n * 3_600n, { idle: 50n, inTime: null, late: null }]);
  assert.deepEqual(weekly.limits, { idle: 50n, inTime: 120n, late: 150n });
  // Unset on chain → first setting with timestamp 0 and no deadline.
  assert.deepEqual(allowancePlan({ perDay: '5', period: 86400, onchain: UNSET, now }), { first: true, balance: 5n, timestamp: 0n, used: 0n, nextRefill: null, executeBefore: null,
    limits: { idle: 5n, inTime: 5n, late: 5n }, replay: { samePeriod: 5n, laterPeriod: 5n } });
  // maxRefill = uint128 max (set elsewhere with 0): the spent amount cannot be derived; it shows as unknown and leaves nothing this period.
  const uncapped = allowancePlan({ perDay: '50', period: 86400, onchain: { refill: 100n, maxRefill: U128_MAX, period: DAY, balance: 70n, timestamp: day0 }, now });
  assert.deepEqual([uncapped.used, uncapped.balance, uncapped.limits], [null, 0n, { idle: null, inTime: null, late: null }]);
  assert.throws(() => allowancePlan({ perDay: '5', period: 86400, onchain: null, now }), /allowance state required/);
  assert.throws(() => allowancePlan({ perDay: '5', period: 86400, onchain: UNSET, now: 1 }), /allowance state required/);
});

test('a batch is refused when the period ends before it could run, and an uncapped reading is described as unknown', () => {
  const ROLES_ADDR = new Wallet('0x' + '59'.repeat(32)).address;
  const DAY = 86_400n, day0 = 20_000n * DAY;
  const next = withFirstPerDay('50'), key = next.allowances[0].key;
  const state = (now, onchain) => ({ now, allowances: new Map([[key, onchain]]) });
  const reading = { refill: 100n, maxRefill: 100n, period: DAY, balance: 70n, timestamp: day0 };
  const current = withFirstPerDay('100');
  assert.throws(() => buildUpdateBatch({ current, next, roles: ROLES_ADDR, allowanceState: state(day0 + DAY - 600n, reading) }), (error) => error.code === 'period_ending' && /不到 10 分钟/.test(error.message));
  const [tx] = buildUpdateBatch({ current, next, roles: ROLES_ADDR, allowanceState: state(day0 + DAY - 601n, reading) });
  assert.equal(tx.allowance.executeBefore, Number(day0 + DAY - 600n));
  const [open] = buildUpdateBatch({ current, next, roles: ROLES_ADDR, allowanceState: state(day0 + 60n, { ...reading, maxRefill: U128_MAX }) });
  assert.equal(open.allowance.used, null);
  assert.match(open.description, /没有补充上限，无法折算本期已用，执行后本期剩余按 0/);
  assert.doesNotMatch(open.description, /累计最多/);
});
test('a new-token allowance that already ran on chain is not reset by a regenerated batch; missing reads refuse', () => {
  const ROLES_ADDR = new Wallet('0x' + '57'.repeat(32)).address;
  const WETH = getAddress('0x4200000000000000000000000000000000000006');
  const next = buildPermissions({ ...config, allowances: [...config.allowances, { token: WETH, symbol: 'WETH', perDay: '100' }] });
  const key = next.allowances.find((a) => a.token === WETH).key;
  const DAY = 86_400n, now = 20_000n * DAY + 3600n;
  const state = unsetState(next, now);
  state.allowances.set(key, { refill: 100n, maxRefill: 100n, period: DAY, balance: 40n, timestamp: 20_000n * DAY }); // 60 spent since today's UTC midnight
  const [tx] = buildUpdateBatch({ current: permissions, next, roles: ROLES_ADDR, allowanceState: state });
  assert.deepEqual(ROLES_ABI.parseTransaction({ data: tx.data }).args.slice(1).map(String), ['40', '100', '100', '86400', String(20_000n * DAY)]);
  assert.equal(tx.allowance.first, false);
  assert.match(tx.description, /^额度 WETH.*本期已用 60/);
  const missing = unsetState(next, now);
  missing.allowances.delete(key);
  assert.throws(() => buildUpdateBatch({ current: permissions, next, roles: ROLES_ADDR, allowanceState: missing }), /allowance state for WETH is missing/);
});

test('gauge liveness: Voter.isActivated and CLGaugeFactory.emissionCap read in parallel at latest; anything unreadable is unknown', async () => {
  const STATUS_I = new Interface(['function isGauge(address) view returns (bool)', 'function emissionCap(address) view returns (uint128)', 'function isActivated(address) view returns (bool)']);
  const word = (v) => '0x' + v.toString(16).padStart(64, '0');
  const REAL_CAP = 0x02d8e952e562d20cn; // Base mainnet reading for a live gauge at block 53882083
  const healthy = { isGauge: word(1n), emissionCap: word(REAL_CAP), isActivated: word(1n) };
  // Each read answers from `answers[fn]` (a string or a function that throws); every call must hit the right contract at latest.
  const rpcWith = (answers) => ({
    getBlockNumber: async () => assert.fail('no separate block-number round trip'),
    call: async ({ to, data, blockTag }) => {
      const tx = STATUS_I.parseTransaction({ data });
      assert.equal(to, tx.name === 'isActivated' ? AERO.voter : AERO.gaugeFactory, tx.name);
      assert.equal(tx.args[0], GAUGE);
      assert.equal(blockTag, 'latest');
      const answer = { ...healthy, ...answers }[tx.name];
      return typeof answer === 'function' ? answer() : answer;
    },
  });
  const read = (answers) => gaugeLiveness(rpcWith(answers), GAUGE.toLowerCase());

  const alive = await read({});
  assert.equal(alive.state, 'alive');
  assert.match(alive.note, new RegExp(`emissionCap = ${REAL_CAP}.*不代表本期一定有排放`));
  assert.equal((await read({ emissionCap: word((1n << 128n) - 1n) })).state, 'alive', 'the largest uint128 is a valid cap');
  assert.equal((await read({ isActivated: word(1n).toUpperCase().replace('0X', '0x') })).state, 'alive');

  const capZero = await read({ emissionCap: word(0n) });
  assert.deepEqual([capZero.state, /已被清零.*emissionCap = 0/.test(capZero.note)], ['killed', true]);
  const inactive = await read({ isActivated: word(0n) });
  assert.deepEqual([inactive.state, /尚未在 Voter 激活.*激活后可重新加入.*isActivated = false/.test(inactive.note)], ['killed', true]);
  const both = await read({ isActivated: word(0n), emissionCap: word(0n) });
  assert.deepEqual([both.state, /尚未在 Voter 激活.*排放上限也为 0.*emissionCap = 0/.test(both.note)], ['killed', true]);
  // Not activated refuses whether or not the factory knows the address.
  const unknownInactive = await read({ isGauge: word(0n), emissionCap: word(0n), isActivated: word(0n) });
  assert.deepEqual([unknownInactive.state, /激活后可重新加入/.test(unknownInactive.note)], ['killed', true]);
  // An address the factory never created also reads cap 0; that says nothing about whether it was stopped.
  const unregistered = await read({ isGauge: word(0n), emissionCap: word(0n) });
  assert.deepEqual([unregistered.state, /不在 CLGaugeFactory .* 登记/.test(unregistered.note)], ['unknown', true]);

  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); };
  for (const [fn, label] of [['isGauge', 'CLGaugeFactory.isGauge'], ['emissionCap', 'CLGaugeFactory.emissionCap'], ['isActivated', 'Voter.isActivated']]) {
    const reverted = await read({ [fn]: revert });
    assert.deepEqual([reverted.state, reverted.note.startsWith(`${label} 调用回滚`)], ['unknown', true], fn);
    const offline = await read({ [fn]: () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
    assert.deepEqual([offline.state, offline.note.startsWith(`读取 ${label} 失败（timeout）`)], ['unknown', true], fn);
    // Only exactly one 32-byte word counts: ethers would ignore trailing bytes and accept a truncated or empty return.
    for (const raw of ['0x', word(1n) + '00'.repeat(32), word(1n).slice(0, -2), word(0n) + '00', '0x' + 'zz'.repeat(32), null]) {
      const odd = await read({ [fn]: raw });
      assert.deepEqual([odd.state, odd.note.startsWith(`${label} 的返回值不是 32 字节`)], ['unknown', true], `${fn} ${raw}`);
    }
  }
  // Booleans are 0 or 1 only (ethers would read any non-zero word as true).
  for (const fn of ['isGauge', 'isActivated']) {
    for (const raw of [word(2n), '0x' + 'ff'.repeat(32)]) {
      const odd = await read({ [fn]: raw });
      assert.deepEqual([odd.state, /不是 32 字节的 0 或 1/.test(odd.note)], ['unknown', true], `${fn} ${raw}`);
    }
  }
  // A uint128 word with any of its high 128 bits set is malformed, not a huge cap.
  for (const raw of [word(1n << 128n), word((1n << 255n) | REAL_CAP), '0x' + 'ff'.repeat(32)]) {
    const odd = await read({ emissionCap: raw });
    assert.deepEqual([odd.state, /不是 32 字节的 uint128/.test(odd.note)], ['unknown', true], raw);
  }
  // One explicit stop reading is enough to refuse, even when the other signal cannot be read.
  const inactiveCapUnreadable = await read({ isActivated: word(0n), emissionCap: revert });
  assert.deepEqual([inactiveCapUnreadable.state, /isActivated = false/.test(inactiveCapUnreadable.note)], ['killed', true]);
  const clearedVoterUnreadable = await read({ emissionCap: word(0n), isActivated: revert });
  assert.deepEqual([clearedVoterUnreadable.state, /emissionCap = 0/.test(clearedVoterUnreadable.note)], ['killed', true]);
  // A zero cap only counts once the factory confirms the gauge is registered.
  assert.equal((await read({ emissionCap: word(0n), isGauge: revert })).state, 'unknown');
});

test('readAllowances reads every key at one block and fails instead of guessing', async () => {
  const VIEW = new Interface(['function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)']);
  const ROLES_ADDR = new Wallet('0x' + '58'.repeat(32)).address;
  const keys = permissions.allowances.map((a) => a.key);
  const tags = [];
  const rpc = (chainId = '0x2105', fail = false) => ({
    send: async () => chainId,
    getBlock: async () => ({ number: 77, timestamp: 1_800_000_123 }),
    call: async ({ to, data, blockTag }) => {
      assert.equal(to, ROLES_ADDR);
      tags.push(blockTag);
      if (fail) throw Object.assign(new Error('boom'), { code: 'SERVER_ERROR' });
      const [key] = VIEW.decodeFunctionData('allowances', data);
      return VIEW.encodeFunctionResult('allowances', [100n, 100n, 86400n, BigInt(keys.indexOf(key) + 1), 0n]);
    },
  });
  const out = await readAllowances(rpc(), ROLES_ADDR, keys);
  assert.equal(out.now, 1_800_000_123n);
  assert.deepEqual(keys.map((k) => out.allowances.get(k).balance), keys.map((_, i) => BigInt(i + 1)));
  assert.ok(tags.length === keys.length && tags.every((t) => t === 77));
  await assert.rejects(readAllowances(rpc('0x1'), ROLES_ADDR, keys), /不是 Base 主网/);
  await assert.rejects(readAllowances(rpc('0x2105', true), ROLES_ADDR, keys), (error) => error.code === 'rpc' && /Roles 额度/.test(error.message));
});
