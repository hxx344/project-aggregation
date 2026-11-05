// Roles 模块的部署与配置调用（由 Safe owner 签名的批次），以及 bot 经 Roles 执行交易时的编码。
import { AbiCoder, Interface, ZeroAddress, concat, getAddress, getCreate2Address, keccak256, solidityPacked, toBeHex, zeroPadValue } from 'ethers';
import { BASE_CHAIN_ID, MULTISEND_SELECTOR, ROLES, SAFE } from './addresses.mjs';
import { flatten } from './conditions.mjs';

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
