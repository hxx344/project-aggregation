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

// Roles v2 AllowanceTracker 的额度行为（与 _accruedAllowance / consumeAllowance 相同的规则），用来按周期累计核对批次的效果。
function rolesAllowances() {
  const store = new Map();
  const at = (key) => store.get(key) ?? { ...UNSET };
  return {
    read: (key) => ({ ...at(key) }),
    exec(tx) {
      const call = ROLES_ABI.parseTransaction({ data: tx.data });
      assert.equal(call.name, 'setAllowance');
      const [key, balance, maxRefill, refill, period, timestamp] = call.args;
      store.set(key, { refill, maxRefill: maxRefill === 0n ? (1n << 128n) - 1n : maxRefill, period, balance, timestamp });
    },
    consume(key, amount, now) {
      const a = at(key), { balance, timestamp } = accrue(a, now);
      if (amount > balance) return false;
      store.set(key, { ...a, balance: balance - amount, timestamp });
      return true;
    },
  };
}
const spendable = (roles, key, now) => accrue(roles.read(key), now).balance;
const withFirstPerDay = (perDay) => buildPermissions({ ...config, allowances: config.allowances.map((a, i) => (i === 0 ? { ...a, perDay } : a)) });

test('adjusting an allowance after spending keeps the period total within the new budget', () => {
  const ROLES_ADDR = new Wallet('0x' + '56'.repeat(32)).address;
  const DAY = 86_400n, day0 = 20_000n * DAY;
  const current = withFirstPerDay('100'), key = current.allowances[0].key;
  // Setup batch: 100 per day, timestamp 0 (periods start at UTC midnight).
  const setup = buildSetupBatch({ permissions: current, safe: SAFE_ADDR, bot: BOT, saltNonce: 1n });
  const setupAllowance = setup.transactions.find((t) => { const c = ROLES_ABI.parseTransaction({ data: t.data }); return c?.name === 'setAllowance' && c.args[0] === key; });
  const fresh = () => { const r = rolesAllowances(); r.exec(setupAllowance); return r; };
  const batchAt = (roles, next, now) => {
    const txs = buildUpdateBatch({ current, next, roles: ROLES_ADDR, allowanceState: { now, allowances: new Map(next.allowances.map((a) => [a.key, roles.read(a.key)])) } });
    assert.equal(txs.length, 1);
    return txs[0];
  };

  // 10:00 the bot spends 30; lowering to 50 leaves 20 for the rest of the day (period total 50, not 30 + 50).
  const roles = fresh();
  const t1 = day0 + 10n * 3600n, t2 = t1 + 3600n;
  assert.equal(roles.consume(key, 30n, t1), true);
  const lower = batchAt(roles, withFirstPerDay('50'), t1);
  assert.deepEqual([lower.allowance.used, lower.allowance.balance, lower.allowance.first], ['30', '20', false]);
  assert.equal(lower.allowance.nextRefill, Number(day0 + DAY));
  assert.match(lower.description, /^调整额度 .*100 → 50.*本期已用 30.*本期剩余 20/);
  roles.exec(lower);
  assert.equal(spendable(roles, key, t2), 20n);
  assert.equal(roles.consume(key, 21n, t2), false);
  assert.equal(roles.consume(key, 20n, t2), true, 'period total 30 + 20 = the new 50');
  // Next UTC day: the full new budget.
  assert.equal(spendable(roles, key, day0 + DAY), 50n);

  // Replay in the same period after spending the remainder re-opens exactly replay.samePeriod (20).
  assert.equal(lower.allowance.replay.samePeriod, '20');
  roles.exec(lower);
  assert.equal(spendable(roles, key, t2 + 1n), 20n);
  // Replay in a later period after that period's budget was spent refills it to replay.laterPeriod (50).
  const t3 = day0 + DAY + 5n * 3600n;
  assert.equal(roles.consume(key, 50n, t3), true);
  assert.equal(spendable(roles, key, t3), 0n);
  roles.exec(lower);
  assert.equal(spendable(roles, key, t3 + 1n), BigInt(lower.allowance.replay.laterPeriod));

  // Raising after spending 30: 150 − 30 = 120 left today, period total 150.
  const roles2 = fresh();
  assert.equal(roles2.consume(key, 30n, t1), true);
  roles2.exec(batchAt(roles2, withFirstPerDay('150'), t1));
  assert.equal(spendable(roles2, key, t2), 120n);

  // Generated today but executed tomorrow: tomorrow simply gets the new full budget.
  const roles3 = fresh();
  assert.equal(roles3.consume(key, 30n, t1), true);
  const late = batchAt(roles3, withFirstPerDay('50'), t1);
  roles3.exec(late);
  assert.equal(spendable(roles3, key, day0 + DAY + 1n), 50n);
});

test('allowancePlan: lowering below the spent amount, stale timestamps, first setting and conservative reads', () => {
  const DAY = 86_400n, day0 = 20_000n * DAY, now = day0 + 7_200n;
  const spent30 = { refill: 100n, maxRefill: 100n, period: DAY, balance: 70n, timestamp: day0 };
  assert.deepEqual(allowancePlan({ perDay: '150', period: 86400, onchain: spent30, now }), { first: false, balance: 120n, timestamp: day0, used: 30n, nextRefill: day0 + DAY, replay: { samePeriod: 120n, laterPeriod: 150n } });
  assert.equal(allowancePlan({ perDay: '20', period: 86400, onchain: spent30, now }).balance, 0n, 'lowering below the spent amount leaves nothing this period');
  // No spending for days: the reading accrues to today's period start, so nothing counts as spent today.
  const idle = allowancePlan({ perDay: '50', period: 86400, onchain: { refill: 100n, maxRefill: 100n, period: DAY, balance: 70n, timestamp: 0n }, now });
  assert.deepEqual([idle.balance, idle.timestamp, idle.used], [50n, day0, 0n]);
  // Unset on chain → first setting with timestamp 0.
  assert.deepEqual(allowancePlan({ perDay: '5', period: 86400, onchain: UNSET, now }), { first: true, balance: 5n, timestamp: 0n, used: 0n, nextRefill: null, replay: { samePeriod: 5n, laterPeriod: 5n } });
  // An allowance set elsewhere with maxRefill = max is treated as fully spent (balance 0), never as a fresh budget.
  assert.equal(allowancePlan({ perDay: '50', period: 86400, onchain: { refill: 100n, maxRefill: (1n << 128n) - 1n, period: DAY, balance: 70n, timestamp: day0 }, now }).balance, 0n);
  assert.throws(() => allowancePlan({ perDay: '5', period: 86400, onchain: null, now }), /allowance state required/);
  assert.throws(() => allowancePlan({ perDay: '5', period: 86400, onchain: UNSET, now: 1 }), /allowance state required/);
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

test('gauge liveness: only an explicit Voter.isAlive reading counts; anything else is unknown', async () => {
  const VOTER_I = new Interface(['function isAlive(address) view returns (bool)']);
  const rpcWith = (behaviour) => ({ call: async ({ to, data }) => { assert.equal(to, AERO.voter); assert.equal(VOTER_I.parseTransaction({ data }).args[0], GAUGE); return behaviour(); } });
  assert.equal((await gaugeLiveness(rpcWith(() => VOTER_I.encodeFunctionResult('isAlive', [true])), GAUGE)).state, 'alive');
  assert.equal((await gaugeLiveness(rpcWith(() => VOTER_I.encodeFunctionResult('isAlive', [false])), GAUGE)).state, 'killed');
  const reverted = await gaugeLiveness(rpcWith(() => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); }), GAUGE);
  assert.deepEqual([reverted.state, /不提供 isAlive/.test(reverted.note)], ['unknown', true]);
  assert.equal((await gaugeLiveness(rpcWith(() => '0x'), GAUGE)).state, 'unknown', 'an empty return is not read as false');
  const offline = await gaugeLiveness(rpcWith(() => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); }), GAUGE);
  assert.deepEqual([offline.state, /读取 Voter.isAlive 失败/.test(offline.note)], ['unknown', true]);
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
