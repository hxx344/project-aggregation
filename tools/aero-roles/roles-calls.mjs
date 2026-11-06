// Roles 模块的部署与配置调用（由 Safe owner 签名的批次），以及 bot 经 Roles 执行交易时的编码。
import { AbiCoder, Interface, ZeroAddress, concat, getAddress, getCreate2Address, keccak256, solidityPacked, toBeHex, zeroPadValue } from 'ethers';
import { BASE_CHAIN_ID, MULTISEND_SELECTOR, ROLES, SAFE } from './addresses.mjs';
import { flatten } from './conditions.mjs';
import { accrue } from './policy.mjs';

const coder = AbiCoder.defaultAbiCoder();
export const ROLES_ABI = new Interface([
  'function setUp(bytes initParams)',
  'function scopeTarget(bytes32 roleKey, address targetAddress)',
  'function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
  'function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)',
  'function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)',
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'function setTransactionUnwrapper(address to, bytes4 selector, address adapter)',
  'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)',
  'function owner() view returns (address)',
  'function avatar() view returns (address)',
  'function target() view returns (address)',
]);
export const SAFE_ABI = new Interface([
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getOwners() view returns (address[])',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const FACTORY_ABI = new Interface(['function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)']);
const MULTISEND_ABI = new Interface(['function multiSend(bytes transactions)']);
// Safe 的 fallback handler 存储槽：keccak256("fallback_manager.handler.address")。
export const FALLBACK_HANDLER_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
// Safe 的 guard 存储槽：keccak256("guard_manager.guard.address")。
export const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
// keccak256("module_manager.module_guard.address")：v1.5.0 新增，能拦截模块（Roles）发起的交易。
export const MODULE_GUARD_SLOT = '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947';
export const MODULES_SENTINEL = '0x0000000000000000000000000000000000000001';

export function rolesInitializer(safe) {
  const params = coder.encode(['address', 'address', 'address'], [safe, safe, safe]); // owner, avatar, target
  return ROLES_ABI.encodeFunctionData('setUp', [params]);
}

// 与 ModuleProxyFactory.deployModule 相同的 CREATE2 推导：salt = keccak256(keccak256(initializer) ‖ saltNonce)，
// 代码为指向 mastercopy 的 EIP-1167 最小代理。
export function predictRolesAddress(safe, saltNonce) {
  const salt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(rolesInitializer(safe)), saltNonce]));
  const initCode = concat(['0x602d8060093d393df3363d3d373d3d3d363d73', ROLES.mastercopy, '0x5af43d82803e903d91602b57fd5bf3']);
  return getCreate2Address(ROLES.moduleProxyFactory, salt, keccak256(initCode));
}

// Safe 批次：部署 Roles 代理 → 启用模块 → 注册 MultiSend 拆包器 → 下发权限与额度 → 给 bot 分配角色。
// 每项附带 description，供 CLI 打印与人工核对。
export function buildSetupBatch({ permissions, safe, bot, saltNonce }) {
  safe = getAddress(safe); bot = getAddress(bot);
  if (safe === bot) throw new Error('bot must not be the Safe');
  const roles = predictRolesAddress(safe, saltNonce);
  const roleKey = permissions.roleKeyBytes;
  const txs = [];
  const add = (to, data, description) => txs.push({ to: getAddress(to), value: '0', data, description });
  add(ROLES.moduleProxyFactory, FACTORY_ABI.encodeFunctionData('deployModule', [ROLES.mastercopy, rolesInitializer(safe), saltNonce]), `部署 Roles 代理 ${roles}（owner/avatar/target = Safe）`);
  add(safe, SAFE_ABI.encodeFunctionData('enableModule', [roles]), 'Safe 启用 Roles 模块');
  add(roles, ROLES_ABI.encodeFunctionData('setTransactionUnwrapper', [SAFE.multiSendCallOnly, MULTISEND_SELECTOR, ROLES.multiSendUnwrapper]), `注册 MultiSendCallOnly ${SAFE.multiSendCallOnly} 的拆包器 ${ROLES.multiSendUnwrapper}`);
  for (const target of permissions.targets) {
    if (getAddress(target.target) === ZeroAddress) throw new Error('refusing to scope the zero address');
    add(roles, ROLES_ABI.encodeFunctionData('scopeTarget', [roleKey, target.target]), `限定目标 ${target.label} ${target.target}`);
    for (const f of target.functions) {
      const data = f.condition
        ? ROLES_ABI.encodeFunctionData('scopeFunction', [roleKey, target.target, f.selector, flatten(f.condition), f.options])
        : ROLES_ABI.encodeFunctionData('allowFunction', [roleKey, target.target, f.selector, f.options]);
      add(roles, data, `${f.condition ? '按条件允许' : '允许'} ${target.label}.${f.label}`);
    }
  }
  for (const a of permissions.allowances) {
    add(roles, ROLES_ABI.encodeFunctionData('setAllowance', [a.key, a.perDay, a.perDay, a.perDay, permissions.allowancePeriod, 0]), `额度 ${a.symbol}：每 24 小时 ${a.perDay}（最小单位）`);
  }
  add(roles, ROLES_ABI.encodeFunctionData('assignRoles', [bot, [roleKey], [true]]), `把角色 ${permissions.roleKey} 分配给 bot ${bot}`);
  return { roles, transactions: txs };
}

const functionCall = (roleKey, target, f) => (f.condition
  ? ROLES_ABI.encodeFunctionData('scopeFunction', [roleKey, target, f.selector, flatten(f.condition), f.options])
  : ROLES_ABI.encodeFunctionData('allowFunction', [roleKey, target, f.selector, f.options]));

// 已部署 Roles 的增量批次（加池、调额度）：current / next 均为 buildPermissions 的结果，权限只允许增加。
// 新目标 scopeTarget 加全部函数；已有目标上条件变化或新增的函数重下 scopeFunction / allowFunction（整体替换该函数的条件）；
// 新代币与每日数量变化的代币 setAllowance（见 allowancePlan）。数量未变的额度不重下。
function permissionCalls({ current, next, roles }) {
  roles = getAddress(roles);
  if (current.roleKeyBytes !== next.roleKeyBytes) throw new Error('roleKey must not change');
  const roleKey = next.roleKeyBytes;
  const before = new Map(current.targets.map((t) => [t.target, new Map(t.functions.map((f) => [f.selector, functionCall(roleKey, t.target, f)]))]));
  for (const t of current.targets) {
    const after = next.targets.find((x) => x.target === t.target);
    if (!after || t.functions.some((f) => !after.functions.some((g) => g.selector === f.selector))) throw new Error(`update would drop permissions on ${t.label}`);
  }
  const txs = [];
  const add = (data, description) => txs.push({ to: roles, value: '0', data, description });
  for (const target of next.targets) {
    if (getAddress(target.target) === ZeroAddress) throw new Error('refusing to scope the zero address');
    const old = before.get(target.target);
    if (!old) add(ROLES_ABI.encodeFunctionData('scopeTarget', [roleKey, target.target]), `限定目标 ${target.label} ${target.target}`);
    for (const f of target.functions) {
      const data = functionCall(roleKey, target.target, f);
      if (old?.get(f.selector) === data) continue;
      add(data, `${old?.has(f.selector) ? '更新条件' : f.condition ? '按条件允许' : '允许'} ${target.label}.${f.label}`);
    }
  }
  return txs;
}

// 需要 setAllowance 的额度：新代币与每日数量变化的代币。previous 为配置里的旧每日数量（新代币为 null）。
export function allowanceChanges({ current, next }) {
  for (const a of current.allowances) if (!next.allowances.some((x) => x.key === a.key)) throw new Error(`update would drop the allowance for ${a.symbol}`);
  const out = [];
  for (const a of next.allowances) {
    const old = current.allowances.find((x) => x.key === a.key);
    if (!old || old.perDay !== a.perDay) out.push({ allowance: a, previous: old ? old.perDay : null });
  }
  return out;
}

// 批次笔数（不读链）：供待变更预览显示。
export function updateBatchSize({ current, next, roles }) {
  return permissionCalls({ current, next, roles }).length + allowanceChanges({ current, next }).length;
}

const isUnset = (r) => r.refill === 0n && r.maxRefill === 0n && r.period === 0n && r.balance === 0n && r.timestamp === 0n;

// 一个额度的 setAllowance 参数与执行效果。onchain 为生成批次时 Roles.allowances(key) 的读数，now 为读数所在区块时间（秒），均为 bigint。
// - 链上尚未设置：首次设置，balance = refill = maxRefill = perDay、timestamp 0（补充时刻对齐 UTC 0 点），本期可用 perDay。
// - 链上已有：按 Roles 规则折算到 now，本期已用 = 本期上限（refill 与 maxRefill 取大，偏保守）− 折算余额；
//   新 balance = max(0, perDay − 已用)，timestamp 保持本期起点，执行后本期累计不超过新额度、不在本期重新计满，下一个补充时刻起按 perDay 补满。
//   批次在之后的周期才执行时，Roles 从这个起点补一次即到 perDay，与正常换期相同。
// 链上 Roles 不提供"读数未变才执行"的前置条件：生成后到执行前 bot 又有消耗、或同一批次被重复签名执行，每执行一次本期最多可再花 balance，
// 在之后的周期执行则当期重新计满为 perDay；replay 字段列出这两个上限，供界面单列。
export function allowancePlan({ perDay, period, onchain, now }) {
  perDay = BigInt(perDay); period = BigInt(period);
  if (!onchain || typeof now !== 'bigint') throw new Error('allowance state required');
  if (isUnset(onchain)) return { first: true, balance: perDay, timestamp: 0n, used: 0n, nextRefill: null, replay: { samePeriod: perDay, laterPeriod: perDay } };
  const { balance: accrued, timestamp: start } = accrue(onchain, now);
  const cap = onchain.refill > onchain.maxRefill ? onchain.refill : onchain.maxRefill;
  const used = cap > accrued ? cap - accrued : 0n;
  const balance = perDay > used ? perDay - used : 0n;
  const timestamp = onchain.period > 0n ? start : now;
  return { first: false, balance, timestamp, used, nextRefill: timestamp + period, replay: { samePeriod: balance, laterPeriod: perDay } };
}

const utc = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// allowanceState：{ now: 区块时间（bigint 秒）, allowances: Map<key, Roles.allowances 读数> }，有额度要设时必填；缺任何一个读数即拒绝生成，
// 不按满额猜。额度那几笔另带 allowance（执行效果），供界面单列；toTransactionBuilderJson 只取 to / value / data。
export function buildUpdateBatch({ current, next, roles, allowanceState }) {
  const txs = permissionCalls({ current, next, roles });
  const changes = allowanceChanges({ current, next });
  if (changes.length && (!allowanceState || typeof allowanceState.now !== 'bigint')) throw new Error('allowance state required: read Roles.allowances before building the batch');
  const to = getAddress(roles);
  for (const { allowance: a, previous } of changes) {
    const onchain = allowanceState.allowances.get(a.key);
    if (!onchain) throw new Error(`allowance state for ${a.symbol} is missing`);
    const plan = allowancePlan({ perDay: a.perDay, period: next.allowancePeriod, onchain, now: allowanceState.now });
    const head = previous === null ? `额度 ${a.symbol}：每 24 小时 ${a.perDay}（最小单位）` : `调整额度 ${a.symbol}：每 24 小时 ${previous} → ${a.perDay}（最小单位）`;
    const effect = plan.first ? `链上尚无此额度，执行后本期可用 ${a.perDay}`
      : `按生成时链上读数本期已用 ${plan.used}，执行后本期剩余 ${plan.balance}（不在本期重新计满），${utc(plan.nextRefill)} 起按 ${a.perDay} 补满`;
    txs.push({ to, value: '0', data: ROLES_ABI.encodeFunctionData('setAllowance', [a.key, plan.balance, BigInt(a.perDay), BigInt(a.perDay), next.allowancePeriod, plan.timestamp]),
      description: `${head}；${effect}`,
      allowance: { key: a.key, token: a.token, symbol: a.symbol, previous: previous === null ? null : String(previous), perDay: String(a.perDay), first: plan.first, used: String(plan.used), balance: String(plan.balance),
        nextRefill: plan.nextRefill === null ? null : Number(plan.nextRefill), readAt: Number(allowanceState.now),
        replay: { samePeriod: String(plan.replay.samePeriod), laterPeriod: String(plan.replay.laterPeriod) } } });
  }
  return txs;
}

// 每个函数条件树的节点数（Roles 上限 255），用于提示白名单还能加多少。
export function conditionUsage(permissions) {
  return permissions.targets.flatMap((t) => t.functions.filter((f) => f.condition).map((f) => ({ label: `${t.label}.${f.label}`, nodes: flatten(f.condition).length })));
}

// Safe{Wallet} Transaction Builder 可导入的 JSON（未带 checksum，导入时界面会提示无法校验，属预期）。
export function toTransactionBuilderJson({ safe, transactions, name, description, createdAt = Date.now() }) {
  return {
    version: '1.0',
    chainId: String(BASE_CHAIN_ID),
    createdAt,
    meta: { name, description, txBuilderVersion: '1.18.0', createdFromSafeAddress: getAddress(safe), createdFromOwnerAddress: '' },
    transactions: transactions.map(({ to, value, data }) => ({ to, value, data, contractMethod: null, contractInputsValues: null })),
  };
}

// MultiSend 打包：每笔 operation(1) ‖ to(20) ‖ value(32) ‖ dataLength(32) ‖ data；内层只允许 call。
export function encodeMultiSend(transactions) {
  const packed = concat(transactions.map((tx) => {
    const data = tx.data ?? '0x';
    return solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, tx.to, BigInt(tx.value ?? 0), (data.length - 2) / 2, data]);
  }));
  return MULTISEND_ABI.encodeFunctionData('multiSend', [packed]);
}

// bot 经 Roles 执行：单笔为 call；多笔经 MultiSendCallOnly delegatecall，由拆包器逐笔校验。
export function encodeRoleExecution(roleKeyBytes, transactions) {
  if (transactions.length === 0) throw new Error('nothing to execute');
  if (transactions.length === 1) {
    const [tx] = transactions;
    return ROLES_ABI.encodeFunctionData('execTransactionWithRole', [tx.to, BigInt(tx.value ?? 0), tx.data, 0, roleKeyBytes, true]);
  }
  return ROLES_ABI.encodeFunctionData('execTransactionWithRole', [SAFE.multiSendCallOnly, 0n, encodeMultiSend(transactions), 1, roleKeyBytes, true]);
}

// 单 owner Safe 的"预先批准"签名：r = owner，s = 0，v = 1，要求交易由该 owner 直接发送。
export function prevalidatedSignature(owner) {
  return concat([zeroPadValue(getAddress(owner), 32), zeroPadValue('0x', 32), toBeHex(1, 1)]);
}
