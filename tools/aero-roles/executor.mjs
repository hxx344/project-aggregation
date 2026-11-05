// bot 经 Roles 以 Safe 名义执行 Aero Slipstream 操作（docs/aero-safe-roles-permissions-2026-11-04.md 第 9 节）。
// 交易目标与参数只取自配置和 addresses.mjs，RPC 只提供读数与报价；每笔先过本地校验（policy.mjs），再由链上 Roles 校验。
// 报价一律以 Safe 身份 eth_call 目标合约（NPM / Router），最小成交量 = 报价 × (1 − 滑点)。
import { FetchRequest, Interface, JsonRpcProvider, MaxUint256, Network, Transaction, getAddress, keccak256 } from 'ethers';
import { AERO, BASE_CHAIN_ID } from './addresses.mjs';
import { buildPermissions } from './permissions.mjs';
import { accruedAllowance, checkTransactions } from './policy.mjs';
import { ROLES_ABI, SAFE_ABI, encodeRoleExecution } from './roles-calls.mjs';

const RPC_TIMEOUT_MS = 20_000;
const READ_ATTEMPTS = 2;
export const RECEIPT_TIMEOUT_MS = 180_000;
const DEADLINE_SEC = 600;
// 分叉验收发现：经 Roles 执行兑换时按 gas 估算值原样发送会 revert，加 30% 通过（文档第 8 节）。
const GAS_MARGIN_PCT = 130n;
// 同一 nonce 重发须把费用提高至少 10% 才会替换内存池里的旧交易，这里取 25%。
const REPLACE_BUMP_PCT = 125n;
const MAX_UINT128 = (1n << 128n) - 1n;
// gauge 排放到账的是合并后的新 AERO（与 tools/aero-lp/chain.mjs 一致）。
export const REWARD_TOKEN = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';

export const NPM_I = new Interface([
  'function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function approve(address to, uint256 tokenId)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
export const GAUGE_I = new Interface([
  'function deposit(uint256 tokenId)',
  'function withdraw(uint256 tokenId)',
  'function claimEmissions(address account, address recipient)',
  'function stakedValues(address depositor) view returns (uint256[])',
  'function depositBlock(uint256 tokenId) view returns (uint256)',
  'function earned(address account, uint256[] tokenIds) view returns (uint256)',
  'function pool() view returns (address)',
  'function nft() view returns (address)',
  'function gaugeFactory() view returns (address)',
]);
export const ROUTER_I = new Interface(['function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)']);
export const ERC20_I = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
export const POOL_I = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
  'function fee() view returns (uint24)',
  'function gauge() view returns (address)',
]);
const FACTORY_I = new Interface(['function getPool(address, address, int24) view returns (address)']);
const GAUGE_FACTORY_I = new Interface(['function effectivePenaltyConfig(address gauge) view returns (uint256 minStakeBlocks, uint256 penaltyRate)']);
const ROLES_VIEW_I = new Interface(['function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)']);
const ROLES_ERRORS = new Interface(['error ConditionViolation(uint8 status, bytes32 info)', 'error NoMembership()', 'error ModuleTransactionFailed()', 'error NotAuthorized(address sender)', 'error FunctionSignatureTooShort()', 'error MalformedMultiEntrypoint()']);
const STATUS = ['Ok', 'DelegateCallNotAllowed', 'TargetAddressNotAllowed', 'FunctionNotAllowed', 'SendNotAllowed', 'OrViolation', 'NorViolation', 'ParameterNotAllowed', 'ParameterLessThanAllowed', 'ParameterGreaterThanAllowed', 'ParameterNotAMatch', 'NotEveryArrayElementPasses', 'NoArrayElementPasses', 'ParameterNotSubsetOfAllowed', 'BitmaskOverflow', 'BitmaskNotAllowed', 'CustomConditionViolation', 'AllowanceExceeded', 'CallAllowanceExceeded', 'EtherAllowanceExceeded'];

// 本模块抛出的错误都带 signed：false 表示交易没有签名发出（可直接重试）；true 表示已签名，结果以链上为准。
export class ExecError extends Error {
  constructor(message, { signed = false, code = null } = {}) { super(message); this.signed = signed; this.code = code; }
}

export function provider(rpcUrl) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = RPC_TIMEOUT_MS;
  return new JsonRpcProvider(request, Network.from(BASE_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
}

export function errorText(error) {
  const base = error?.shortMessage || error?.message || String(error);
  const inner = error?.info?.error?.message;
  return inner && !base.includes(inner) ? `${base} (${inner})` : base;
}

// 读请求：单次 20 秒超时（provider），最多 2 次，间隔 1 秒；仍失败则抛出。
async function read(label, fn) {
  let last;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try { return await fn(); } catch (error) {
      last = error;
      if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new ExecError(`读取 ${label} 失败：${errorText(last)}`);
}

// 把 Roles 的拒绝原因还原成可读文字；不是 Roles 错误时返回节点原文。
export function rolesReason(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const parsed = ROLES_ERRORS.parseError(data);
      if (parsed?.name === 'ConditionViolation') return `Roles 拒绝：${STATUS[Number(parsed.args.status)] ?? `status ${parsed.args.status}`}`;
      if (parsed) return `Roles 拒绝：${parsed.name}`;
    } catch {}
  }
  return errorText(error);
}

const call = async (rpc, iface, to, method, args = [], from) => iface.decodeFunctionResult(method, await rpc.call({ to, from, data: iface.encodeFunctionData(method, args) }));
const tx = (to, iface, method, args) => ({ to, value: 0n, data: iface.encodeFunctionData(method, args) });
const MAX_REPLACES = 16;
// 任何人都能把头寸 NFT 转给 Safe：未质押头寸只看最新的这么多个，避免粉尘 NFT 拖垮读取。
export const MAX_OWNED_SCAN = 40;
// 同 nonce 替换链；兼容开发期写下的单个对象格式。
const replacedChain = (value) => (Array.isArray(value) ? value : value ? [value] : []);
export const minusBps = (amount, bps) => (amount * BigInt(10_000 - bps)) / 10_000n;
// 截止时间取链上最新区块时间与本机时间的较晚者，服务器时钟偏慢时交易也不会一发出就过期。
async function deadline(ctx) {
  const block = await read('最新区块', () => ctx.rpc.getBlock('latest'));
  return BigInt(Math.max(Math.floor(ctx.now() / 1000), Number(block.timestamp)) + DEADLINE_SEC);
}

// 把 Safe 里两种代币配平到区间所需比例。返回 { zeroForOne, amountIn }（原始单位），差额小于总值 minShareBps 时返回 null。
// 只决定兑换数量，不参与最小成交量：忽略价格冲击，配平后的零头留在 Safe。sqrtPriceX96 为池子当前价，feePips 为池子手续费（百万分之一）。
export function balanceSwap({ sqrtPriceX96, tickLower, tickUpper, amount0, amount1, feePips, minShareBps = 50 }) {
  const sp = Number(sqrtPriceX96) / 2 ** 96, sa = 1.0001 ** (tickLower / 2), sb = 1.0001 ** (tickUpper / 2);
  const p = sp * sp, b0 = Number(amount0), b1 = Number(amount1), keep = 1 - Number(feePips) / 1e6;
  const total = b0 * p + b1;
  if (!(total > 0) || !(sa < sb)) return null;
  let zeroForOne, size;
  if (sp <= sa) { zeroForOne = false; size = b1; } // 区间在价格上方：只需要 token0
  else if (sp >= sb) { zeroForOne = true; size = b0; } // 区间在价格下方：只需要 token1
  else {
    const a0 = (sb - sp) / (sp * sb), a1 = sp - sa; // 单位流动性所需的 token0 / token1
    const sell0 = (b0 * a1 - b1 * a0) / (a1 + p * keep * a0);
    if (sell0 >= 0) { zeroForOne = true; size = sell0; }
    else { zeroForOne = false; size = (b1 * a0 - b0 * a1) / ((keep * a1) / p + a0); }
  }
  const value = zeroForOne ? size * p : size;
  if (!(value > 0) || value * 10_000 < total * minShareBps) return null;
  const cap = zeroForOne ? BigInt(amount0) : BigInt(amount1);
  const amountIn = BigInt(Math.floor(size)) > cap ? cap : BigInt(Math.floor(size));
  return amountIn > 0n ? { zeroForOne, amountIn } : null;
}

// 头寸按当前价折算的两种代币数量（原始单位浮点，仅展示）。
export function positionAmounts({ liquidity, tickLower, tickUpper }, sqrtPriceX96) {
  const L = Number(liquidity), sa = 1.0001 ** (tickLower / 2), sb = 1.0001 ** (tickUpper / 2);
  const sp = Math.min(Math.max(Number(sqrtPriceX96) / 2 ** 96, sa), sb);
  return { amount0: (L * (sb - sp)) / (sp * sb), amount1: L * (sp - sa) };
}

// 连接并核对：Roles 的 avatar / target 必须是 Safe，Safe 必须启用了这个 Roles；每个池子由 CL 工厂按 (token0, token1, tickSpacing) 定位，
// 且池子与 gauge 互相指向、gauge 的 NFT 是 NPM。任何一项不符都拒绝，不会把调用发往配置以外的合约。
export async function connect({ rpc, signer = null, safe, roles, config, now = Date.now }) {
  const permissions = buildPermissions(config);
  safe = getAddress(safe); roles = getAddress(roles);
  const chainId = await read('chainId', () => rpc.send('eth_chainId', []));
  if (Number(chainId) !== BASE_CHAIN_ID) throw new ExecError(`RPC 不是 Base 主网（chainId ${Number(chainId)}）`);
  const [avatar, target, enabled] = await read('Roles / Safe', () => Promise.all([
    call(rpc, ROLES_ABI, roles, 'avatar'), call(rpc, ROLES_ABI, roles, 'target'), call(rpc, SAFE_ABI, safe, 'isModuleEnabled', [roles]),
  ]));
  if (getAddress(avatar[0]) !== safe || getAddress(target[0]) !== safe) throw new ExecError(`Roles ${roles} 的 avatar / target 不是 Safe ${safe}`);
  if (!enabled[0]) throw new ExecError(`Safe ${safe} 没有启用 Roles ${roles}`);
  const tokens = new Map();
  for (const token of new Set([...permissions.pools.flatMap((p) => [p.token0, p.token1]), ...permissions.swaps.flatMap((s) => [s.tokenIn, s.tokenOut]), REWARD_TOKEN])) {
    const [[decimals], [symbol]] = await read(`代币 ${token}`, () => Promise.all([call(rpc, ERC20_I, token, 'decimals'), call(rpc, ERC20_I, token, 'symbol')]));
    tokens.set(token, { address: token, decimals: Number(decimals), symbol: String(symbol) });
  }
  const pools = [];
  for (const p of permissions.pools) {
    const [address] = await read(`getPool ${p.name}`, () => call(rpc, FACTORY_I, AERO.clFactory, 'getPool', [p.token0, p.token1, p.tickSpacing]));
    if (getAddress(address) === '0x0000000000000000000000000000000000000000') throw new ExecError(`CL 工厂里没有池子 ${p.name}`);
    const [[gauge], [gaugePool], [nft], [gaugeFactory]] = await read(`gauge ${p.name}`, () => Promise.all([
      call(rpc, POOL_I, address, 'gauge'), call(rpc, GAUGE_I, p.gauge, 'pool'), call(rpc, GAUGE_I, p.gauge, 'nft'), call(rpc, GAUGE_I, p.gauge, 'gaugeFactory'),
    ]));
    if (getAddress(gauge) !== p.gauge || getAddress(gaugePool) !== getAddress(address)) throw new ExecError(`池子 ${p.name} 与 gauge ${p.gauge} 不互相指向`);
    if (getAddress(nft) !== AERO.nft) throw new ExecError(`gauge ${p.gauge} 的 NFT 不是 Aero NPM`);
    pools.push({ ...p, address: getAddress(address), gaugeFactory: getAddress(gaugeFactory) });
  }
  return { rpc, signer, safe, roles, permissions, pools, tokens, now };
}

const poolOf = (ctx, address) => {
  const pool = ctx.pools.find((p) => p.address === getAddress(address));
  if (!pool) throw new ExecError(`池子 ${address} 不在 Safe 白名单里`);
  return pool;
};
const allowanceFor = (ctx, token) => ctx.permissions.allowances.find((a) => a.token === getAddress(token));

async function remainingAllowances(ctx) {
  const block = await read('最新区块', () => ctx.rpc.getBlock('latest'));
  const now = BigInt(block.timestamp);
  const out = new Map();
  for (const a of ctx.permissions.allowances) {
    const raw = await read(`额度 ${a.symbol}`, () => call(ctx.rpc, ROLES_VIEW_I, ctx.roles, 'allowances', [a.key]));
    out.set(a.key, { ...a, remaining: accruedAllowance({ refill: raw.refill, maxRefill: raw.maxRefill, period: raw.period, balance: raw.balance, timestamp: raw.timestamp }, now), maxRefill: raw.maxRefill, refillAt: raw.period > 0n ? raw.timestamp + raw.period : null });
  }
  return { blockNumber: block.number, timestamp: Number(block.timestamp), allowances: out };
}

// 本地校验用的链上读数：NFT 归属与当前可用额度。
function policyContext(ctx) {
  let allowances = null;
  return {
    avatar: ctx.safe,
    ownerOf: async (to, tokenId) => { try { return getAddress((await call(ctx.rpc, NPM_I, to, 'ownerOf', [tokenId]))[0]); } catch { return null; } },
    allowance: async (key) => { allowances ??= (await remainingAllowances(ctx)).allowances; return allowances.get(key)?.remaining ?? null; },
  };
}

// Safe 的完整状态：余额、额度、各白名单池的头寸（已质押与未质押）、待领排放、bot 的 gas 与 nonce。
// knownIds：本系统开出的头寸，不论在 Safe 的 NFT 索引里排第几都读取（粉尘 NFT 挤不掉）。
export async function readState(ctx, { knownIds = [] } = {}) {
  const bot = ctx.signer?.address ?? null;
  const [{ blockNumber, timestamp, allowances }, botEth, latestNonce, pendingNonce] = await Promise.all([
    remainingAllowances(ctx),
    bot ? read('bot 余额', () => ctx.rpc.getBalance(bot)) : null,
    bot ? read('bot nonce', () => ctx.rpc.getTransactionCount(bot, 'latest')) : null,
    bot ? read('bot pending nonce', () => ctx.rpc.getTransactionCount(bot, 'pending')) : null,
  ]);
  const balances = {};
  for (const token of ctx.tokens.values()) balances[token.address] = (await read(`${token.symbol} 余额`, () => call(ctx.rpc, ERC20_I, token.address, 'balanceOf', [ctx.safe])))[0];
  const [owned] = await read('Safe 持有的 NFT', () => call(ctx.rpc, NPM_I, AERO.nft, 'balanceOf', [ctx.safe]));
  const ownedIds = [];
  const scanFrom = owned > BigInt(MAX_OWNED_SCAN) ? owned - BigInt(MAX_OWNED_SCAN) : 0n;
  for (let i = owned - 1n; i >= scanFrom; i--) ownedIds.push((await read('tokenOfOwnerByIndex', () => call(ctx.rpc, NPM_I, AERO.nft, 'tokenOfOwnerByIndex', [ctx.safe, i])))[0]);
  const scanned = ownedIds.length;
  // 只有合约 revert 才算已销毁；RPC 故障照常重试并报错，不让头寸静默消失。每 10 个并发一组。
  const burnedIds = [];
  const known = knownIds.map((id) => BigInt(id)).filter((id) => !ownedIds.includes(id));
  for (let i = 0; i < known.length; i += 10) {
    const owners = await Promise.all(known.slice(i, i + 10).map((tokenId) => read(`头寸 #${tokenId} 归属`, async () => {
      try { return getAddress((await call(ctx.rpc, NPM_I, AERO.nft, 'ownerOf', [tokenId]))[0]); } catch (error) { if (error?.code === 'CALL_EXCEPTION') return null; throw error; }
    })));
    owners.forEach((owner, j) => { if (owner === ctx.safe) ownedIds.push(known[i + j]); else if (owner === null) burnedIds.push(known[i + j]); });
  }
  const ownedInfo = new Map();
  const positionOf = async (tokenId) => {
    if (!ownedInfo.has(tokenId)) ownedInfo.set(tokenId, await read(`头寸 #${tokenId}`, () => call(ctx.rpc, NPM_I, AERO.nft, 'positions', [tokenId])));
    return ownedInfo.get(tokenId);
  };
  const pools = [];
  for (const pool of ctx.pools) {
    const [slot0, [feePips], [stakedIds], penalty] = await read(`池子 ${pool.name}`, () => Promise.all([
      call(ctx.rpc, POOL_I, pool.address, 'slot0'), call(ctx.rpc, POOL_I, pool.address, 'fee'),
      call(ctx.rpc, GAUGE_I, pool.gauge, 'stakedValues', [ctx.safe]), call(ctx.rpc, GAUGE_FACTORY_I, pool.gaugeFactory, 'effectivePenaltyConfig', [pool.gauge]),
    ]));
    const positions = [];
    const add = async (tokenId, staked) => {
      const p = await positionOf(tokenId);
      if (getAddress(p.token0) !== pool.token0 || getAddress(p.token1) !== pool.token1 || Number(p.tickSpacing) !== pool.tickSpacing) return;
      const depositBlock = staked ? (await read(`质押区块 #${tokenId}`, () => call(ctx.rpc, GAUGE_I, pool.gauge, 'depositBlock', [tokenId])))[0] : null;
      const position = { tokenId, staked, tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity, tokensOwed0: p.tokensOwed0, tokensOwed1: p.tokensOwed1, depositBlock };
      positions.push({ ...position, ...positionAmounts(position, slot0.sqrtPriceX96), penaltyUntilBlock: staked && penalty.penaltyRate > 0n ? depositBlock + penalty.minStakeBlocks : null });
    };
    for (const id of stakedIds) await add(id, true);
    for (const id of ownedIds) await add(id, false);
    let earned = null;
    if (stakedIds.length) { try { earned = (await call(ctx.rpc, GAUGE_I, pool.gauge, 'earned', [ctx.safe, [...stakedIds]]))[0]; } catch {} }
    pools.push({ ...pool, sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), feePips: Number(feePips), penalty: { minStakeBlocks: penalty.minStakeBlocks, penaltyRate: penalty.penaltyRate }, positions, earned });
  }
  return { blockNumber, timestamp, bot, botEth, latestNonce, pendingNonce, balances, allowances: [...allowances.values()], pools, ownedNfts: owned, ownedScanned: scanned, burnedIds };
}

// 已签名交易的去向：confirmed / reverted（已上链）、dropped（同一 nonce 已被其他交易占用，这笔不会再上链）、waiting（仍可能上链，重新广播一次）。
export async function resolvePending(ctx, pending) {
  const receipt = await read('交易回执', () => ctx.rpc.getTransactionReceipt(pending.hash));
  if (receipt) return { state: receipt.status === 1 ? 'confirmed' : 'reverted', receipt };
  const nonce = await read('bot nonce', () => ctx.rpc.getTransactionCount(pending.from, 'latest'));
  if (nonce > pending.nonce) {
    const late = await read('交易回执', () => ctx.rpc.getTransactionReceipt(pending.hash)); // nonce 读之前刚上链的情况
    if (late) return { state: late.status === 1 ? 'confirmed' : 'reverted', receipt: late };
    // 同 nonce 提价替换后，上链的可能是被替换的旧交易。
    // 连续替换时逐个查，最多一笔上链。
    for (const replaced of replacedChain(pending.replaces)) {
      const original = await read('被替换交易回执', () => ctx.rpc.getTransactionReceipt(replaced.hash));
      if (original) return { state: 'dropped', replaced, replacedReceipt: original };
    }
    return { state: 'dropped', replaced: null, replacedReceipt: null };
  }
  try { await ctx.rpc.broadcastTransaction(pending.raw); } catch {}
  return { state: 'waiting' };
}

// 经 Roles 发一笔（单笔 call 或 MultiSendCallOnly 批次）。hooks：
//   halted() 为真时不签名；pending() 返回尚未结清的上一笔（同 nonce 时按替换提价）；resolvePrior() 结清 nonce 已被消耗的上一笔；
//   persistPending(entry) 签名后、广播前持久化，抛错则不广播；settle(entry, receipt) 回执落定后调用；log(event)。
// 广播失败或回执超时都按结果未知抛出（signed: true），待确认记录保留，由 resolvePending 结清。
export async function sendRoleTx(ctx, hooks, label, transactions) {
  if (!ctx.signer) throw new ExecError('未配置 bot 私钥');
  const local = await checkTransactions(ctx.permissions, transactions, policyContext(ctx));
  if (!local.ok) throw new ExecError(`${label}：本地权限校验拒绝第 ${local.index + 1} 笔（${local.reason}），未签名`);
  const from = ctx.signer.address;
  const data = encodeRoleExecution(ctx.permissions.roleKeyBytes, transactions);
  let estimate;
  try { estimate = await ctx.rpc.estimateGas({ from, to: ctx.roles, data }); } catch (error) {
    throw new ExecError(`${label}：预估 gas 失败，交易会被拒绝（${rolesReason(error)}），未签名`);
  }
  const gasLimit = (estimate * GAS_MARGIN_PCT) / 100n;
  const [fee, nonce, balance] = await read('gas 价格与 nonce', () => Promise.all([ctx.rpc.getFeeData(), ctx.rpc.getTransactionCount(from, 'latest'), ctx.rpc.getBalance(from)]));
  let maxFeePerGas = fee.maxFeePerGas, maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
  if (maxFeePerGas == null || maxPriorityFeePerGas == null) throw new ExecError(`${label}：RPC 没有返回 EIP-1559 费用，未签名`);
  let prior = hooks.pending?.();
  if (prior && prior.nonce !== nonce) {
    // 上一笔在任务开始后上链或被丢弃，nonce 已前进：先按链上结果结清，不能当作被替换。
    await hooks.resolvePrior?.();
    prior = hooks.pending?.();
    if (prior && prior.nonce !== nonce) throw new ExecError(`${label}：上一笔交易（${prior.label}）尚未结清，未签名`);
  }
  if (prior) {
    const bump = (v) => (BigInt(v) * REPLACE_BUMP_PCT) / 100n;
    if (bump(prior.maxFeePerGas) > maxFeePerGas) maxFeePerGas = bump(prior.maxFeePerGas);
    if (bump(prior.maxPriorityFeePerGas) > maxPriorityFeePerGas) maxPriorityFeePerGas = bump(prior.maxPriorityFeePerGas);
  }
  if (maxPriorityFeePerGas > maxFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  if (balance < gasLimit * maxFeePerGas) throw new ExecError(`${label}：bot 的 ETH 不足以支付 gas（需要 ${gasLimit * maxFeePerGas} wei），未签名`, { code: 'gas' });
  // 取 nonce 与费用要访问 RPC，暂停可能在此期间到达，所以紧挨签名检查。
  if (hooks.halted?.()) throw new ExecError(`${label}：工作台正在维护或隔离恢复，未签名`, { code: 'halted' });
  const raw = await ctx.signer.signTransaction(Transaction.from({ type: 2, chainId: BASE_CHAIN_ID, to: ctx.roles, data, value: 0n, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas }));
  const hash = keccak256(raw);
  const entry = { hash, raw, from, nonce, label, maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas), at: ctx.now(),
    // 同一 nonce 上此前签过的全部交易（新的在前），结清时逐个核对哪一笔上了链。
    replaces: prior ? [{ hash: prior.hash, label: prior.label }, ...replacedChain(prior.replaces)].slice(0, MAX_REPLACES) : [] };
  // 没有持久记录的交易不广播：重启后无法按哈希核对，可能重复执行。
  try { await hooks.persistPending(entry); } catch (error) { throw new ExecError(`${label}：待确认记录保存失败，未广播（${errorText(error)}）`); }
  hooks.log?.({ event: 'tx_signed', label, hash, nonce });
  let receipt;
  try {
    try { await ctx.rpc.broadcastTransaction(raw); } catch (error) {
      // 节点已收到同一笔时会报 already known，其余错误也可能发生在已转发之后：一律等回执判定。
      hooks.log?.({ event: 'broadcast_error', label, hash, error: errorText(error) });
    }
    receipt = await ctx.rpc.waitForTransaction(hash, 1, RECEIPT_TIMEOUT_MS);
  } catch (error) {
    throw new ExecError(`${label}（${hash}）结果未知：${errorText(error)}；待链上确认后再继续`, { signed: true, code: 'unknown' });
  }
  if (!receipt) throw new ExecError(`${label}（${hash}）等待回执超时，结果未知；待链上确认后再继续`, { signed: true, code: 'unknown' });
  await hooks.settle(entry, receipt);
  if (receipt.status !== 1) throw new ExecError(`${label}（${hash}）在链上回滚`, { signed: true, code: 'reverted' });
  hooks.log?.({ event: 'tx_confirmed', label, hash, block: receipt.blockNumber });
  return receipt;
}

async function ensureApprovals(ctx, hooks, pairs) {
  const missing = [];
  for (const { token, spender, amount } of pairs) {
    if (amount === 0n) continue;
    const [current] = await read('代币授权', () => call(ctx.rpc, ERC20_I, token, 'allowance', [ctx.safe, spender]));
    if (current < amount) missing.push(tx(token, ERC20_I, 'approve', [spender, MaxUint256]));
  }
  if (missing.length) await sendRoleTx(ctx, hooks, `授权 ${missing.length} 个代币`, missing);
}

const balanceOf = async (ctx, token) => (await read('Safe 余额', () => call(ctx.rpc, ERC20_I, token, 'balanceOf', [ctx.safe])))[0];

function swapRoute(ctx, tokenIn, tokenOut) {
  const route = ctx.permissions.swaps.find((s) => s.tokenIn === getAddress(tokenIn) && s.tokenOut === getAddress(tokenOut));
  if (!route) throw new ExecError(`兑换 ${tokenIn} → ${tokenOut} 不在白名单里`);
  return route;
}

// 以 Safe 身份询价：需要 Safe 已授权 Router。
async function quoteSwap(ctx, route, amountIn) {
  const params = { tokenIn: route.tokenIn, tokenOut: route.tokenOut, tickSpacing: route.tickSpacing, recipient: ctx.safe, deadline: await deadline(ctx), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  try { return { params, amountOut: (await call(ctx.rpc, ROUTER_I, AERO.swapRouter, 'exactInputSingle', [params], ctx.safe))[0] }; } catch (error) {
    throw new ExecError(`兑换报价失败：${errorText(error)}`);
  }
}

export async function swap(ctx, hooks, { tokenIn, tokenOut, amountIn, slippageBps }) {
  const route = swapRoute(ctx, tokenIn, tokenOut);
  if (amountIn <= 0n) throw new ExecError('兑换数量须大于 0');
  const held = await balanceOf(ctx, route.tokenIn);
  if (held < amountIn) throw new ExecError(`Safe 的 ${ctx.tokens.get(route.tokenIn)?.symbol ?? route.tokenIn} 余额不足：需要 ${amountIn}，现有 ${held}`);
  await ensureApprovals(ctx, hooks, [{ token: route.tokenIn, spender: AERO.swapRouter, amount: amountIn }]);
  const { params, amountOut } = await quoteSwap(ctx, route, amountIn);
  if (amountOut === 0n) throw new ExecError('兑换报价为 0，未发送');
  const before = await balanceOf(ctx, route.tokenOut);
  const symbol = (t) => ctx.tokens.get(t)?.symbol ?? t;
  await sendRoleTx(ctx, hooks, `兑换 ${symbol(route.tokenIn)} → ${symbol(route.tokenOut)}`, [tx(AERO.swapRouter, ROUTER_I, 'exactInputSingle', [{ ...params, amountOutMinimum: minusBps(amountOut, slippageBps) }])]);
  const received = (await balanceOf(ctx, route.tokenOut)) - before;
  return { amountIn, quoted: amountOut, received: received > 0n ? received : 0n };
}

function checkRange(pool, tickLower, tickUpper) {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) throw new ExecError('区间下沿须小于上沿');
  if (tickLower % pool.tickSpacing !== 0 || tickUpper % pool.tickSpacing !== 0) throw new ExecError(`区间边界须是 tickSpacing ${pool.tickSpacing} 的整数倍`);
  if (tickLower < -887272 || tickUpper > 887272) throw new ExecError('区间超出 tick 范围');
}

// 开仓前预览：按比例取 Safe 余额，算出配平兑换并报价，不签名。
export async function previewOpen(ctx, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance }) {
  const pool = poolOf(ctx, poolAddress);
  checkRange(pool, tickLower, tickUpper);
  const [slot0, [feePips], b0, b1] = await read('池子与余额', () => Promise.all([
    call(ctx.rpc, POOL_I, pool.address, 'slot0'), call(ctx.rpc, POOL_I, pool.address, 'fee'), balanceOf(ctx, pool.token0), balanceOf(ctx, pool.token1),
  ]));
  const amount0 = (b0 * BigInt(shareBps)) / 10_000n, amount1 = (b1 * BigInt(shareBps)) / 10_000n;
  const plan = rebalance ? balanceSwap({ sqrtPriceX96: slot0.sqrtPriceX96, tickLower, tickUpper, amount0, amount1, feePips }) : null;
  let swapPlan = null;
  if (plan) {
    const route = swapRoute(ctx, plan.zeroForOne ? pool.token0 : pool.token1, plan.zeroForOne ? pool.token1 : pool.token0);
    let quoted = null;
    try { quoted = (await quoteSwap(ctx, route, plan.amountIn)).amountOut; } catch {} // 尚未授权 Router 时询价会失败，执行时授权后再报价
    swapPlan = { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn: plan.amountIn, quoted };
  }
  const after0 = swapPlan ? (plan.zeroForOne ? amount0 - plan.amountIn : amount0 + (swapPlan.quoted ?? 0n)) : amount0;
  const after1 = swapPlan ? (plan.zeroForOne ? amount1 + (swapPlan.quoted ?? 0n) : amount1 - plan.amountIn) : amount1;
  return { pool: pool.address, tick: Number(slot0.tick), sqrtPriceX96: slot0.sqrtPriceX96, tickLower, tickUpper, amount0, amount1, swap: swapPlan, deposit0: after0, deposit1: after1 };
}

// 用户确认的是预览数字：执行时重算的投入量偏离超过 1%、或配平兑换超出预览 10% 时不执行。
export function checkExpectation(preview, expect) {
  const off = (actual, expected, bps) => (actual > expected ? actual - expected : expected - actual) * 10_000n > expected * BigInt(bps);
  if (off(preview.amount0, expect.amount0, 100) || off(preview.amount1, expect.amount1, 100)) throw new ExecError('Safe 余额自预览后变化超过 1%，请重新预览后再确认，未签名');
  // 价格移动可能让配平方向翻转：卖出的币与预览不同时，数量没有可比性，一律拒绝。
  if (preview.swap && expect.swapTokenIn && getAddress(preview.swap.tokenIn) !== getAddress(expect.swapTokenIn)) throw new ExecError('池子价格自预览后变化，配平兑换方向已改变，请重新预览后再确认，未签名');
  const swapIn = preview.swap?.amountIn ?? 0n;
  if (expect.swapIn > 0n && !expect.swapTokenIn) throw new ExecError('预览缺少配平兑换代币，请重新预览后再确认，未签名');
  if (swapIn * 10_000n > expect.swapIn * 11_000n) throw new ExecError('池子价格自预览后变化，配平兑换量超出预览 10%，请重新预览后再确认，未签名');
}

// 开仓：配平兑换（可选）→ 授权 NPM → 以 Safe 身份报价后 mint（最小量 = 报价 × (1 − 滑点)）→ NPM.approve + gauge.deposit 一批质押。
// 中途失败时已完成的步骤保留在链上（例如已兑换未开仓），页面按 Safe 现状显示，可再次开仓或手动处理。
export async function openPosition(ctx, hooks, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance, slippageBps, stake = true, expect = null }) {
  const pool = poolOf(ctx, poolAddress);
  const preview = await previewOpen(ctx, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance });
  if (expect) checkExpectation(preview, expect);
  let amount0 = preview.amount0, amount1 = preview.amount1;
  if (preview.swap) {
    hooks.step?.('配平兑换');
    const result = await swap(ctx, hooks, { tokenIn: preview.swap.tokenIn, tokenOut: preview.swap.tokenOut, amountIn: preview.swap.amountIn, slippageBps });
    if (preview.swap.tokenIn === pool.token0) { amount0 -= result.amountIn; amount1 += result.received; } else { amount1 -= result.amountIn; amount0 += result.received; }
  }
  hooks.step?.('开仓');
  await ensureApprovals(ctx, hooks, [{ token: pool.token0, spender: AERO.nft, amount: amount0 }, { token: pool.token1, spender: AERO.nft, amount: amount1 }]);
  const params = { token0: pool.token0, token1: pool.token1, tickSpacing: pool.tickSpacing, tickLower, tickUpper, amount0Desired: amount0, amount1Desired: amount1, amount0Min: 0n, amount1Min: 0n, recipient: ctx.safe, deadline: await deadline(ctx), sqrtPriceX96: 0n };
  let quote;
  try { quote = await call(ctx.rpc, NPM_I, AERO.nft, 'mint', [params], ctx.safe); } catch (error) { throw new ExecError(`开仓报价失败：${errorText(error)}`); }
  if (quote.liquidity === 0n) throw new ExecError('开仓报价的流动性为 0，未发送');
  const receipt = await sendRoleTx(ctx, hooks, `开仓 ${pool.name} [${tickLower}, ${tickUpper}]`, [tx(AERO.nft, NPM_I, 'mint', [{ ...params, amount0Min: minusBps(quote.amount0, slippageBps), amount1Min: minusBps(quote.amount1, slippageBps) }])]);
  const minted = receipt.logs.filter((l) => getAddress(l.address) === AERO.nft).map((l) => { try { return NPM_I.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === 'Transfer' && BigInt(e.args.from) === 0n && getAddress(e.args.to) === ctx.safe);
  if (!minted) throw new ExecError(`开仓已确认，但回执里没有 NFT 转入 Safe（${receipt.hash}）`, { signed: true });
  const tokenId = minted.args.tokenId;
  // 质押前先上报：质押失败时头寸留在 Safe，仍要能在页面找到。
  hooks.minted?.(tokenId);
  if (stake) { hooks.step?.('质押'); await stakePosition(ctx, hooks, { tokenId }); }
  return { tokenId, amount0: quote.amount0, amount1: quote.amount1 };
}

async function locate(ctx, tokenId) {
  const p = await read(`头寸 #${tokenId}`, () => call(ctx.rpc, NPM_I, AERO.nft, 'positions', [tokenId]));
  const pool = ctx.pools.find((x) => x.token0 === getAddress(p.token0) && x.token1 === getAddress(p.token1) && x.tickSpacing === Number(p.tickSpacing));
  if (!pool) throw new ExecError(`头寸 #${tokenId} 不属于白名单池子`);
  const [[owner], [staked]] = await read(`头寸 #${tokenId} 归属`, () => Promise.all([call(ctx.rpc, NPM_I, AERO.nft, 'ownerOf', [tokenId]), call(ctx.rpc, GAUGE_I, pool.gauge, 'stakedValues', [ctx.safe])]));
  const isStaked = staked.some((id) => id === tokenId);
  if (!isStaked && getAddress(owner) !== ctx.safe) throw new ExecError(`头寸 #${tokenId} 不归 Safe 所有`);
  return { pool, position: p, staked: isStaked };
}

export async function stakePosition(ctx, hooks, { tokenId }) {
  const { pool, staked } = await locate(ctx, tokenId);
  if (staked) return { already: true };
  await sendRoleTx(ctx, hooks, `质押 #${tokenId}`, [tx(AERO.nft, NPM_I, 'approve', [pool.gauge, tokenId]), tx(pool.gauge, GAUGE_I, 'deposit', [tokenId])]);
  return { staked: true };
}

// 提前解押会被 gauge 按 penaltyRate 罚没部分排放：acceptPenalty 为假且仍在罚没期时拒绝。
export async function unstakePosition(ctx, hooks, { tokenId, acceptPenalty = false }) {
  const { pool, staked } = await locate(ctx, tokenId);
  if (!staked) return { already: true };
  const [[depositBlock], penalty, blockNumber] = await read('罚没期', () => Promise.all([
    call(ctx.rpc, GAUGE_I, pool.gauge, 'depositBlock', [tokenId]), call(ctx.rpc, GAUGE_FACTORY_I, pool.gaugeFactory, 'effectivePenaltyConfig', [pool.gauge]), ctx.rpc.getBlockNumber(),
  ]));
  if (!acceptPenalty && penalty.penaltyRate > 0n && BigInt(blockNumber) < depositBlock + penalty.minStakeBlocks) {
    throw new ExecError(`头寸 #${tokenId} 仍在提前解押罚没期（到区块 ${depositBlock + penalty.minStakeBlocks}），确认接受罚没后再解押`, { code: 'penalty' });
  }
  await sendRoleTx(ctx, hooks, `解押 #${tokenId}`, [tx(pool.gauge, GAUGE_I, 'withdraw', [tokenId])]);
  return { unstaked: true };
}

// 平仓：解押（如已质押）→ 以 Safe 身份报价 decreaseLiquidity → decrease + collect + burn 一批。
// 解押必须单独一笔：Roles 在执行批次前逐笔校验，此时 NFT 仍在 gauge 名下，decrease 的 OwnedByAvatar 不会通过。
export async function closePosition(ctx, hooks, { tokenId, slippageBps, acceptPenalty = false }) {
  const { staked } = await locate(ctx, tokenId);
  if (staked) { hooks.step?.('解押'); await unstakePosition(ctx, hooks, { tokenId, acceptPenalty }); }
  hooks.step?.('撤出流动性');
  const p = await read(`头寸 #${tokenId}`, () => call(ctx.rpc, NPM_I, AERO.nft, 'positions', [tokenId]));
  const calls = [];
  if (p.liquidity > 0n) {
    const params = { tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx) };
    let quote;
    try { quote = await call(ctx.rpc, NPM_I, AERO.nft, 'decreaseLiquidity', [params], ctx.safe); } catch (error) { throw new ExecError(`撤出报价失败：${errorText(error)}`); }
    calls.push(tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ ...params, amount0Min: minusBps(quote.amount0, slippageBps), amount1Min: minusBps(quote.amount1, slippageBps) }]));
  }
  calls.push(tx(AERO.nft, NPM_I, 'collect', [{ tokenId, recipient: ctx.safe, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]));
  calls.push(tx(AERO.nft, NPM_I, 'burn', [tokenId]));
  await sendRoleTx(ctx, hooks, `平仓 #${tokenId}`, calls);
  return { closed: true };
}

// 领取全部白名单 gauge 上 Safe 的排放（只对有质押的 gauge 发）。
export async function claimRewards(ctx, hooks) {
  const calls = [];
  for (const pool of ctx.pools) {
    const [ids] = await read(`质押 ${pool.name}`, () => call(ctx.rpc, GAUGE_I, pool.gauge, 'stakedValues', [ctx.safe]));
    if (ids.length) calls.push(tx(pool.gauge, GAUGE_I, 'claimEmissions', [ctx.safe, ctx.safe]));
  }
  if (!calls.length) return { claimed: false };
  await sendRoleTx(ctx, hooks, '领取排放', calls);
  return { claimed: true };
}

// 把 Safe 里的 AERO 按白名单兑换路径卖出，数量不超过当日剩余额度；低于 minAmount 或没有卖出路径时跳过。
export async function sellRewards(ctx, hooks, { slippageBps, minAmount }) {
  const route = ctx.permissions.swaps.find((s) => s.tokenIn === REWARD_TOKEN);
  if (!route) return { sold: false, reason: 'no_route' };
  let amount = await balanceOf(ctx, REWARD_TOKEN);
  const key = allowanceFor(ctx, REWARD_TOKEN)?.key;
  const remaining = key ? (await remainingAllowances(ctx)).allowances.get(key)?.remaining ?? 0n : 0n;
  if (amount > remaining) amount = remaining;
  if (amount < minAmount || amount === 0n) return { sold: false, reason: 'below_min', amount };
  return { sold: true, ...(await swap(ctx, hooks, { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn: amount, slippageBps })) };
}
