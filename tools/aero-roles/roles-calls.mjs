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
const UINT128_MAX = (1n << 128n) - 1n;
// 链上已有额度的批次须在本期结束前这么久上链，给硬件钱包签名与打包留出时间。
export const EXECUTE_MARGIN_SECONDS = 600n;

// 一个额度的 setAllowance 参数与执行效果。onchain 为生成批次时 Roles.allowances(key) 的读数，now 为读数所在区块时间（秒），均为 bigint。
// - 链上尚未设置：首次设置，balance = refill = maxRefill = perDay、timestamp 0（Roles v2 setAllowance 把 0 换成执行区块时间，
//   周期从执行时刻起算），任何时刻执行本期都只有 perDay；没有执行期限。
// - 链上已有：按 Roles 规则折算到 now，本期已用 = 本期上限 cap（refill 与 maxRefill 取大，偏保守）− 折算余额；
//   新 balance = max(0, perDay − 已用)，timestamp 为本期起点，不在本期重新计满，下一个补充时刻 nextRefill 起按 perDay 补满。
//   setAllowance 覆盖余额、忘掉执行前已花的量，且 Roles 不提供"读数未变才执行"的前置条件，所以本期累计取决于执行时刻：
//   · executeBefore（nextRefill 前 EXECUTE_MARGIN_SECONDS）前执行：生成后 bot 不再花时 = 已用 + balance（limits.idle）；
//     生成后到执行前 bot 再花的部分另计，最多 cap + balance（limits.inTime）。
//   · 超过 nextRefill 才执行：timestamp 已过一整期，首次消费即补满 perDay，执行前当期按旧额度已花的不计入，最多 cap + perDay（limits.late）。
//   · 同一周期内重复执行每次再放出 balance（replay.samePeriod）；之后周期再执行当期重新计满 perDay（replay.laterPeriod）。
//   旧周期不是新周期整数倍时 inTime / late 为 null（期限内旧额度还可能补充）。
// - 旧额度 maxRefill 为 uint128 上限（setAllowance 传 0 即无上限，余额可跨期累积）时无法折算本期已用：used 与 limits 为 null，balance 按 0。
export function allowancePlan({ perDay, period, onchain, now }) {
  perDay = BigInt(perDay); period = BigInt(period);
  if (!onchain || typeof now !== 'bigint') throw new Error('allowance state required');
  if (isUnset(onchain)) return { first: true, balance: perDay, timestamp: 0n, used: 0n, nextRefill: null, executeBefore: null, limits: { idle: perDay, inTime: perDay, late: perDay },
    replay: { samePeriod: perDay, laterPeriod: perDay } };
  const { balance: accrued, timestamp: accruedStart } = accrue(onchain, now);
  let start = onchain.period > 0n ? accruedStart : now;
  // 新周期长度与链上不同时，前进到包含 now 的那一期；旧周期为新周期整数倍时已用仍按链上本期起点算，覆盖的区间更长，偏保守。
  if (now >= start + period) start += ((now - start) / period) * period;
  const nextRefill = start + period, executeBefore = nextRefill - EXECUTE_MARGIN_SECONDS;
  const uncapped = onchain.maxRefill === UINT128_MAX;
  const cap = onchain.refill > onchain.maxRefill ? onchain.refill : onchain.maxRefill;
  const used = uncapped ? null : cap > accrued ? cap - accrued : 0n;
  const balance = used === null ? 0n : perDay > used ? perDay - used : 0n;
  // 旧周期不是新周期整数倍时（更短，或如 36 小时对 24 小时），旧额度的补充时刻可能落在 [start, nextRefill) 内，
  // 生成后再花的量不受 cap 约束，inTime / late 给不出上限。
  const refillsSooner = onchain.period > 0n && onchain.period % period !== 0n;
  const limits = used === null ? { idle: null, inTime: null, late: null }
    : { idle: used + balance, inTime: refillsSooner ? null : cap + balance, late: refillsSooner ? null : cap + perDay };
  return { first: false, balance, timestamp: start, used, nextRefill, executeBefore, limits, replay: { samePeriod: balance, laterPeriod: perDay } };
}

export const utc = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const str = (v) => (v === null ? null : String(v));

// allowanceState：{ now: 区块时间（bigint 秒）, allowances: Map<key, Roles.allowances 读数> }，有额度要设时必填；缺任何一个读数即拒绝生成，
// 不按满额猜。额度那几笔另带 allowance（执行效果），供界面单列；toTransactionBuilderJson 只取 to / value / data。
// 本期离结束不足 EXECUTE_MARGIN_SECONDS 时拒绝生成（code period_ending）：来不及在补满前执行，等换期后再生成。
export function buildUpdateBatch({ current, next, roles, allowanceState }) {
  const txs = permissionCalls({ current, next, roles });
  const changes = allowanceChanges({ current, next });
  if (changes.length && (!allowanceState || typeof allowanceState.now !== 'bigint')) throw new Error('allowance state required: read Roles.allowances before building the batch');
  const to = getAddress(roles);
  for (const { allowance: a, previous } of changes) {
    const onchain = allowanceState.allowances.get(a.key);
    if (!onchain) throw new Error(`allowance state for ${a.symbol} is missing`);
    const plan = allowancePlan({ perDay: a.perDay, period: next.allowancePeriod, onchain, now: allowanceState.now });
    if (plan.executeBefore !== null && plan.executeBefore <= allowanceState.now) {
      throw Object.assign(new Error(`${a.symbol} 本期额度 ${utc(plan.nextRefill)} 补满，离现在不到 ${EXECUTE_MARGIN_SECONDS / 60n} 分钟，来不及在补满前执行；请在补满后重新生成`), { code: 'period_ending' });
    }
    const head = previous === null ? `额度 ${a.symbol}：每 24 小时 ${a.perDay}（最小单位）` : `调整额度 ${a.symbol}：每 24 小时 ${previous} → ${a.perDay}（最小单位）`;
    const effect = plan.first ? `链上尚无此额度，执行后本期可用 ${a.perDay}`
      : `${plan.used === null ? '链上旧额度没有补充上限，无法折算本期已用，执行后本期剩余按 0' : `按生成时链上读数本期已用 ${plan.used}，执行后本期剩余 ${plan.balance}`}（不在本期重新计满），${utc(plan.nextRefill)} 起按 ${a.perDay} 补满；`
        + `须在 ${utc(plan.executeBefore)} 前执行，${plan.limits.inTime === null ? '' : `期限前执行本期累计最多 ${plan.limits.inTime}（生成后 bot 不再花时 ${plan.limits.idle}），`}`
        + `超过 ${utc(plan.nextRefill)} 才执行会当期补满${plan.limits.late === null ? '' : `，执行当期累计最多 ${plan.limits.late}`}`;
    txs.push({ to, value: '0', data: ROLES_ABI.encodeFunctionData('setAllowance', [a.key, plan.balance, BigInt(a.perDay), BigInt(a.perDay), next.allowancePeriod, plan.timestamp]),
      description: `${head}；${effect}`,
      allowance: { key: a.key, token: a.token, symbol: a.symbol, previous: str(previous), perDay: String(a.perDay), first: plan.first, used: str(plan.used), balance: String(plan.balance),
        nextRefill: plan.nextRefill === null ? null : Number(plan.nextRefill), executeBefore: plan.executeBefore === null ? null : Number(plan.executeBefore), readAt: Number(allowanceState.now),
        limits: { idle: str(plan.limits.idle), inTime: str(plan.limits.inTime), late: str(plan.limits.late) },
        replay: { samePeriod: String(plan.replay.samePeriod), laterPeriod: String(plan.replay.laterPeriod) } } });
  }
  return txs;
}

// 批次的执行期限（秒）：链上已有额度那几笔里最早的 executeBefore；只有首次设置或不调额度时为 null。
export function batchExecuteBefore(transactions) {
  const times = transactions.map((t) => t.allowance?.executeBefore).filter((v) => typeof v === 'number');
  return times.length ? Math.min(...times) : null;
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
