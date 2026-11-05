import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, MaxUint256, Wallet, getAddress } from 'ethers';
import { AERO, ROLES, SAFE } from '../tools/aero-roles/addresses.mjs';
import { AbiType, Operator, c, flatten } from '../tools/aero-roles/conditions.mjs';
import { buildPermissions, normalizeConfig } from '../tools/aero-roles/permissions.mjs';
import { accruedAllowance, checkTransactions } from '../tools/aero-roles/policy.mjs';
import { ROLES_ABI, buildSetupBatch, encodeMultiSend, encodeRoleExecution, predictRolesAddress } from '../tools/aero-roles/roles-calls.mjs';

const config = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
const SAFE_ADDR = new Wallet('0x' + '22'.repeat(32)).address;
const BOT = new Wallet('0x' + '33'.repeat(32)).address;
const OTHER = new Wallet('0x' + '44'.repeat(32)).address;
const [USDC, RSGP, AERO_TOKEN] = config.allowances.map((a) => getAddress(a.token));
const GAUGE = getAddress(config.pools[0].gauge);
const permissions = buildPermissions(config);

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
