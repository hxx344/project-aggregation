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
// gauge 排放到账的是合并后的新 AERO（xAERO 经转换器销毁后 1:1 铸给领取地址）。
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
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16, bool)',
  'function fee() view returns (uint24)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
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
  throw new ExecError(`读取 ${label} 失败：${errorText(last)}`, { code: 'rpc' });
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
// Base 出块间隔会随网络升级变化（已由 2 秒降到 0.2 秒），时长一律按区块时间戳算，不用固定出块常数。
// 区块时间戳确定后不再变化，按区块号缓存，避免每次刷新为每个已质押头寸重读。
const BLOCK_TIME_CACHE_MAX = 1024;
const blockTimes = new Map();
// 只用于展示的区块读取：单次、最多等 5 秒，失败返回 null，不按 read() 重试拖慢 readState（自动调仓也依赖它）。
const DISPLAY_READ_MS = 5_000;
async function displayBlock(ctx, number) {
  let timer;
  try {
    return await Promise.race([ctx.rpc.getBlock(number), new Promise((resolve) => { timer = setTimeout(() => resolve(null), DISPLAY_READ_MS); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}
async function blockTimestamp(ctx, number) {
  const key = BigInt(number);
  if (blockTimes.has(key)) return blockTimes.get(key);
  const block = await displayBlock(ctx, key);
  if (!block) return null;
  const timestamp = Number(block.timestamp);
  if (blockTimes.size >= BLOCK_TIME_CACHE_MAX) blockTimes.delete(blockTimes.keys().next().value);
  blockTimes.set(key, timestamp);
  return timestamp;
}
// 最近这么多块的平均出块秒数，用来把罚没期剩余块数折成时间。
const BLOCK_SAMPLE = 3000;

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

const CL_POOL_I = new Interface(['function token0() view returns (address)', 'function token1() view returns (address)', 'function tickSpacing() view returns (int24)', 'function gauge() view returns (address)', 'function factory() view returns (address)']);
const GAUGE_META_I = new Interface(['function pool() view returns (address)', 'function nft() view returns (address)', 'function voter() view returns (address)']);
const GAUGE_PROBE_I = new Interface(['function deposit(uint256)', 'function withdraw(uint256)', 'function emergencyWithdraw(uint256)', 'function claimEmissions(address,address)', 'function claimEmissions(address,address,uint256[])']);
const NPM_INDEX_I = new Interface(['function tokenByIndex(uint256) view returns (uint256)']);
const GAUGE_CLONE = `0x363d3d373d3d3d363d73${AERO.gaugeImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SYMBOL_MAX = 24;

// 加入白名单前核验任意池子（与 cli.mjs plan 的池子核对相同）：池子由 Aero CL 工厂按 (token0, token1, tickSpacing) 登记，
// 有 gauge，gauge 是已审实现的 EIP-1167 克隆、与池子互相指向，且 NFT 与 voter 是固定地址。任何一项不符都拒绝。
export async function inspectPool(rpc, address) {
  address = getAddress(address);
  const chainId = await read('chainId', () => rpc.send('eth_chainId', []));
  if (Number(chainId) !== BASE_CHAIN_ID) throw new ExecError(`RPC 不是 Base 主网（chainId ${Number(chainId)}）`);
  if ((await read('池子字节码', () => rpc.getCode(address))) === '0x') throw new ExecError(`${address} 不是合约`);
  const [[t0], [t1], [spacing], [gauge], [factory]] = await read('池子', () => Promise.all(['token0', 'token1', 'tickSpacing', 'gauge', 'factory'].map((m) => call(rpc, CL_POOL_I, address, m))));
  if (getAddress(factory) !== AERO.clFactory) throw new ExecError('不是 Aero Slipstream（CL 工厂）的池子');
  const token0 = getAddress(t0), token1 = getAddress(t1), tickSpacing = Number(spacing);
  const [registered] = await read('getPool', () => call(rpc, FACTORY_I, AERO.clFactory, 'getPool', [token0, token1, tickSpacing]));
  if (getAddress(registered) !== address) throw new ExecError('CL 工厂没有登记这个池子');
  if (getAddress(gauge) === ZERO_ADDRESS) throw new ExecError('这个池子没有 gauge（没有排放），不能加入白名单');
  const gaugeAddress = getAddress(gauge);
  const [code, [gaugePool], [nft], [voter]] = await read('gauge', () => Promise.all([rpc.getCode(gaugeAddress), ...['pool', 'nft', 'voter'].map((m) => call(rpc, GAUGE_META_I, gaugeAddress, m))]));
  if (code.toLowerCase() !== GAUGE_CLONE) throw new ExecError(`gauge ${gaugeAddress} 不是已审实现 ${AERO.gaugeImplementation} 的克隆`);
  if (getAddress(gaugePool) !== address) throw new ExecError(`gauge ${gaugeAddress} 不指向这个池子`);
  if (getAddress(nft) !== AERO.nft || getAddress(voter) !== AERO.voter) throw new ExecError(`gauge ${gaugeAddress} 的 NFT / voter 与固定地址不符`);
  const gaugeStatus = await gaugeLiveness(rpc, gaugeAddress);
  if (gaugeStatus.state === 'killed') throw new ExecError(`gauge ${gaugeAddress} 不能加入白名单：${gaugeStatus.note}`);
  const token = async (a) => {
    const [[decimals], [symbol]] = await read(`代币 ${a}`, () => Promise.all([call(rpc, ERC20_I, a, 'decimals'), call(rpc, ERC20_I, a, 'symbol')]));
    return { address: a, decimals: Number(decimals), symbol: String(symbol).replace(/[^\x20-\x7e]/g, '').trim().slice(0, SYMBOL_MAX) || a.slice(0, 8) };
  };
  return { address, gauge: gaugeAddress, tickSpacing, gaugeStatus, token0: await token(token0), token1: await token(token1) };
}

const GAUGE_STATUS_I = new Interface([
  'function isGauge(address gauge) view returns (bool)',
  'function emissionCap(address gauge) view returns (uint128)',
  'function isActivated(address gauge) view returns (bool)',
]);
const GAUGE_STATUS_READS = [
  { fn: 'isGauge', label: 'CLGaugeFactory.isGauge', to: AERO.gaugeFactory, max: 1n },
  { fn: 'emissionCap', label: 'CLGaugeFactory.emissionCap', to: AERO.gaugeFactory, max: MAX_UINT128 },
  { fn: 'isActivated', label: 'Voter.isActivated', to: AERO.voter, max: 1n },
];
// gauge 是否已停用。固定 Voter 0x3824… 是 LeafVoter，没有 isAlive / isGauge / killGauge，停用信号是两项读数：
// - Voter.isActivated(gauge) = false：投票路由到 ZERO_GAUGE，gauge 拿不到排放（源码没有取消激活的路径）；
// - CLGaugeFactory.emissionCap(gauge) = 0：紧急委员会 / CAP_ADMIN 清零后排放全部转入 surplus，等价旧版 killGauge（CAP_OPERATOR 不能设为 0）。
// 未登记的地址读 emissionCap 也是 0，所以排放上限只在 CLGaugeFactory.isGauge 确认登记后才算停用信号；未激活则不论登记与否都拒绝。
// 上限不为 0 只说明没有被清零，不代表本期一定有排放；零排放（本周期没有投票）不拿来推断停用。
// 三项读数并行读 latest、不钉区块：isGauge 只会置 true、isActivated 是单向的，钉区块带不来一致性，反而多一次串行往返，
// 负载均衡的公共 RPC 上还会因节点落后报 block not found。每次读取单次、受 provider 20 秒超时约束，不重试。
// 其余情况下回滚、返回值不合规或读取失败都报 unknown（不当作正常，也不拒绝）。
// 返回值须恰好是一个 32 字节字，bool 只认 0 / 1，uint128 高 128 位须为 0：ethers 解码会把非零字当 true、也不管多出的字节，不按它解码。
export async function gaugeLiveness(rpc, gauge) {
  gauge = getAddress(gauge);
  const unknown = (why) => ({ state: 'unknown', note: `${why}，无法确认 gauge 是否已被停用` });
  const results = await Promise.allSettled(GAUGE_STATUS_READS.map(({ fn, to }) => rpc.call({ to, data: GAUGE_STATUS_I.encodeFunctionData(fn, [gauge]), blockTag: 'latest' })));
  // 每项读数要么是合规的字，要么是失败原因；一项明确的停用读数足以拒绝，不因另一项读不到而降为 unknown。
  const [registered, cap, activated] = results.map((result, i) => {
    const { label, max } = GAUGE_STATUS_READS[i];
    if (result.status === 'rejected') return { failure: result.reason?.code === 'CALL_EXCEPTION' ? `${label} 调用回滚` : `读取 ${label} 失败（${errorText(result.reason)}）` };
    const word = typeof result.value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result.value) ? BigInt(result.value) : null;
    return word === null || word > max ? { failure: `${label} 的返回值不是 32 字节的${max === 1n ? ' 0 或 1' : ' uint128'}` } : { word };
  });
  const capCleared = registered.word === 1n && cap.word === 0n;
  if (activated.word === 0n) return { state: 'killed', note: `尚未在 Voter 激活，投票不会路由到它${capCleared ? '，排放上限也为 0' : '，激活后可重新加入'}（Voter.isActivated = false${capCleared ? '，CLGaugeFactory.emissionCap = 0' : ''}）` };
  if (capCleared) return { state: 'killed', note: '排放上限已被清零，排放全部转入 surplus（CLGaugeFactory.emissionCap = 0）' };
  const failed = [registered, cap, activated].find((r) => r.failure);
  if (failed) return unknown(failed.failure);
  if (registered.word === 0n) return unknown(`gauge 不在 CLGaugeFactory ${AERO.gaugeFactory} 登记，读不到它的排放上限`);
  return { state: 'alive', note: `Voter.isActivated = true，CLGaugeFactory.emissionCap = ${cap.word}（上限不为 0 不代表本期一定有排放）` };
}

// 生成调额度批次用的链上额度：同一区块的 Roles.allowances(key) 与该区块时间（bigint 秒）。
// 每步单次 20 秒超时、最多 2 次；任一读数失败即抛出（调用方拒绝生成批次，不按满额猜）。
export async function readAllowances(rpc, roles, keys) {
  roles = getAddress(roles);
  const chainId = await read('chainId', () => rpc.send('eth_chainId', []));
  if (Number(chainId) !== BASE_CHAIN_ID) throw new ExecError(`RPC 不是 Base 主网（chainId ${Number(chainId)}）`);
  const block = await read('最新区块', () => rpc.getBlock('latest'));
  if (!block) throw new ExecError('读取最新区块失败：节点没有返回区块', { code: 'rpc' });
  const raws = await read('Roles 额度', () => Promise.all(keys.map(async (key) => ROLES_VIEW_I.decodeFunctionResult('allowances',
    await rpc.call({ to: roles, data: ROLES_VIEW_I.encodeFunctionData('allowances', [key]), blockTag: block.number })))));
  const allowances = new Map(keys.map((key, i) => {
    const r = raws[i];
    return [key, { refill: r.refill, maxRefill: r.maxRefill, period: r.period, balance: r.balance, timestamp: r.timestamp }];
  }));
  return { blockNumber: block.number, now: BigInt(block.timestamp), allowances };
}

// 以 bot 身份 eth_call Roles.execTransactionWithRole（shouldRevert）只判权限：返回 Roles 的结论名。
// 'Ok' 表示内层调用也成功；'ModuleTransactionFailed' 表示权限已放行、内层调用自身失败；其余为 Roles 拒绝的原因。
// 节点或网络错误重试一次后抛出；不是 Roles 错误的回滚原样抛出，不当作通过。
async function rolesProbe(rpc, { roles, bot, roleKeyBytes }, transaction) {
  const data = encodeRoleExecution(roleKeyBytes, [transaction]);
  let last;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try { await rpc.call({ from: bot, to: roles, data }); return 'Ok'; } catch (error) {
      const raw = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
      if (typeof raw === 'string' && raw.length >= 10) {
        let parsed = null;
        try { parsed = ROLES_ERRORS.parseError(raw); } catch {}
        if (parsed?.name === 'ConditionViolation') return STATUS[Number(parsed.args.status)] ?? `status ${parsed.args.status}`;
        if (parsed) return parsed.name;
      }
      if (error?.code === 'CALL_EXCEPTION') throw new ExecError(`模拟调用回滚，原因不是 Roles 权限：${errorText(error)}`);
      last = error;
      if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new ExecError(`模拟调用失败：${errorText(last)}`);
}

// 加池、调额度批次执行后的生效核对：current / next 为 buildPermissions 的结果。对新增的池子、兑换路径与代币授权逐项以 bot 身份模拟，
// Roles 放行才算生效（金额一律为 0，不会动资产）；新增或数量变化的额度直接读 Roles.allowances，须与计划完全一致。
// 返回 { ok, checks: [{ label, ok, status }] }。
export async function verifyActive({ rpc, safe, roles, bot, current, next, now = Date.now }) {
  safe = getAddress(safe); roles = getAddress(roles); bot = getAddress(bot);
  const probe = { roles, bot, roleKeyBytes: next.roleKeyBytes };
  const known = (list, keyOf) => new Set(list.map(keyOf));
  const poolKey = (p) => p.gauge, swapKey = (s) => `${s.tokenIn}/${s.tokenOut}/${s.tickSpacing}`;
  const oldPools = known(current.pools, poolKey), oldSwaps = known(current.swaps, swapKey), oldAllowances = new Map(current.allowances.map((a) => [a.key, a.perDay]));
  const pools = next.pools.filter((p) => !oldPools.has(poolKey(p))), swaps = next.swaps.filter((s) => !oldSwaps.has(swapKey(s)));
  const end = BigInt(Math.floor(now() / 1000) + 3600);
  // NFT 授权的条件含"头寸归 Safe 所有"：用链上第一个已存在的 tokenId 模拟，gauge 参数通过而归属不符时 Roles 报 CustomConditionViolation。
  const [sample] = pools.length ? await read('NPM tokenByIndex', () => call(rpc, NPM_INDEX_I, AERO.nft, 'tokenByIndex', [0n])) : [0n];
  const symbolOf = (token) => next.allowances.find((a) => a.token === token)?.symbol ?? token.slice(0, 8);
  const cases = [];
  const spenders = new Map();
  const approveOf = (token, spender) => { const key = `${token}/${spender}`; if (!spenders.has(key)) spenders.set(key, { token, spender }); };
  for (const p of pools) {
    cases.push({ label: `NPM.mint ${p.name}`, tx: tx(AERO.nft, NPM_I, 'mint', [{ token0: p.token0, token1: p.token1, tickSpacing: p.tickSpacing, tickLower: 0, tickUpper: p.tickSpacing,
      amount0Desired: 0n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, recipient: safe, deadline: end, sqrtPriceX96: 0n }]) });
    cases.push({ label: `NPM.approve → gauge ${p.name}`, tx: tx(AERO.nft, NPM_I, 'approve', [p.gauge, sample]), accept: ['CustomConditionViolation'] });
    for (const [label, method, args] of [['deposit', 'deposit', [0n]], ['withdraw', 'withdraw', [0n]], ['emergencyWithdraw', 'emergencyWithdraw', [0n]],
      ['claimEmissions', 'claimEmissions(address,address)', [safe, safe]], ['claimEmissions(tokenIds)', 'claimEmissions(address,address,uint256[])', [safe, safe, []]]]) {
      cases.push({ label: `gauge ${p.name}.${label}`, tx: tx(p.gauge, GAUGE_PROBE_I, method, args) });
    }
    approveOf(p.token0, AERO.nft); approveOf(p.token1, AERO.nft);
  }
  for (const s of swaps) {
    cases.push({ label: `Router 兑换 ${symbolOf(s.tokenIn)} → ${symbolOf(s.tokenOut)} ts${s.tickSpacing}`, tx: tx(AERO.swapRouter, ROUTER_I, 'exactInputSingle', [{ tokenIn: s.tokenIn, tokenOut: s.tokenOut,
      tickSpacing: s.tickSpacing, recipient: safe, deadline: end, amountIn: 0n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }]) });
    approveOf(s.tokenIn, AERO.swapRouter);
  }
  for (const { token, spender } of spenders.values()) {
    cases.push({ label: `${symbolOf(token)}.approve → ${spender === AERO.nft ? 'NPM' : 'Router'}`, tx: tx(token, ERC20_I, 'approve', [spender, 0n]) });
  }
  const checks = [];
  for (const item of cases) {
    const status = await rolesProbe(rpc, probe, item.tx);
    checks.push({ label: item.label, status, ok: status === 'Ok' || status === 'ModuleTransactionFailed' || (item.accept ?? []).includes(status) });
  }
  for (const a of next.allowances.filter((x) => oldAllowances.get(x.key) !== x.perDay)) {
    const r = await read(`额度 ${a.symbol}`, () => call(rpc, ROLES_VIEW_I, roles, 'allowances', [a.key]));
    const ok = r.refill === a.perDay && r.maxRefill === a.perDay && r.period === BigInt(next.allowancePeriod);
    checks.push({ label: `额度 ${a.symbol}`, status: ok ? 'Ok' : `链上为每 ${r.period} 秒补 ${r.refill}、上限 ${r.maxRefill}`, ok });
  }
  return { ok: checks.every((c) => c.ok), checks };
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
// ethers 把节点返回的任何 JSON-RPC 错误（含限流）都报成 CALL_EXCEPTION，只有带 revert 数据的才是合约拒绝（NFT 已销毁）；
// 其余错误按读取失败重试并抛出，不让头寸静默消失。
export const isRevert = (error) => error?.code === 'CALL_EXCEPTION' && typeof error.data === 'string' && error.data.length > 2;
export const ownerOrBurned = (ctx, tokenId) => read(`头寸 #${tokenId} 归属`, async () => {
  try { return getAddress((await call(ctx.rpc, NPM_I, AERO.nft, 'ownerOf', [tokenId]))[0]); } catch (error) { if (isRevert(error)) return null; throw error; }
});

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
  // 每 10 个并发一组；owner 为 null 表示合约 revert（已销毁）。
  const burnedIds = [];
  const known = knownIds.map((id) => BigInt(id)).filter((id) => !ownedIds.includes(id));
  for (let i = 0; i < known.length; i += 10) {
    const owners = await Promise.all(known.slice(i, i + 10).map((tokenId) => ownerOrBurned(ctx, tokenId)));
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
      const depositTime = depositBlock ? await blockTimestamp(ctx, depositBlock) : null;
      const position = { tokenId, staked, tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity, tokensOwed0: p.tokensOwed0, tokensOwed1: p.tokensOwed1, depositBlock, depositTime };
      positions.push({ ...position, ...positionAmounts(position, slot0.sqrtPriceX96), penaltyUntilBlock: staked && penalty.penaltyRate > 0n ? depositBlock + penalty.minStakeBlocks : null });
    };
    for (const id of stakedIds) await add(id, true);
    for (const id of ownedIds) await add(id, false);
    let earned = null;
    if (stakedIds.length) { try { earned = (await call(ctx.rpc, GAUGE_I, pool.gauge, 'earned', [ctx.safe, [...stakedIds]]))[0]; } catch {} }
    pools.push({ ...pool, sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), feePips: Number(feePips), penalty: { minStakeBlocks: penalty.minStakeBlocks, penaltyRate: penalty.penaltyRate }, positions, earned });
  }
  const sample = Math.min(BLOCK_SAMPLE, blockNumber - 1);
  const sampled = sample > 0 ? await displayBlock(ctx, blockNumber - sample) : null;
  const blockSeconds = sampled ? (timestamp - Number(sampled.timestamp)) / sample : null;
  return { blockNumber, timestamp, blockSeconds: Number.isFinite(blockSeconds) && blockSeconds > 0 ? blockSeconds : null, bot, botEth, latestNonce, pendingNonce, balances, allowances: [...allowances.values()], pools, ownedNfts: owned, ownedScanned: scanned, burnedIds };
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
//   可选：moving(stage) 在兑换/开仓那一笔签名前调用；swapped({ amount0, amount1 }) 开仓前配平兑换确认后调用；minted(tokenId) 开仓确认后调用。
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
export const safeBalances = (ctx, tokens) => Promise.all(tokens.map((token) => balanceOf(ctx, token)));

// 现价 tick 与过去 seconds 秒的时间加权 tick（向负无穷取整）。观测槽只有 1 个时 observe 会用现价外推，TWAP 等于现价、没有意义，按不可用处理；
// 历史不足 seconds 秒时 observe 回滚（OLD），同样不可用。
export async function poolTwap(ctx, poolAddress, seconds) {
  const pool = poolOf(ctx, poolAddress);
  const slot0 = await read(`池子 ${pool.name}`, () => call(ctx.rpc, POOL_I, pool.address, 'slot0'));
  const cardinality = Number(slot0.observationCardinality);
  if (cardinality < 2) return { tick: Number(slot0.tick), sqrtPriceX96: slot0.sqrtPriceX96, twap: null, cardinality, reason: `池子只有 ${cardinality} 个价格观测槽，无法核对 TWAP` };
  let cumulatives;
  try { [cumulatives] = await call(ctx.rpc, POOL_I, pool.address, 'observe', [[seconds, 0]]); } catch (error) {
    if (isRevert(error)) return { tick: Number(slot0.tick), sqrtPriceX96: slot0.sqrtPriceX96, twap: null, cardinality, reason: `池子的价格观测不足 ${seconds} 秒，无法核对 TWAP` };
    throw new ExecError(`读取 TWAP 失败：${errorText(error)}`);
  }
  const delta = BigInt(cumulatives[1]) - BigInt(cumulatives[0]), span = BigInt(seconds);
  let twap = delta / span;
  if (delta < 0n && delta % span !== 0n) twap -= 1n;
  return { tick: Number(slot0.tick), sqrtPriceX96: slot0.sqrtPriceX96, twap: Number(twap), cardinality, reason: null };
}

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

// 价格冲击：同一路径上千分之一数量的报价作为参考价，整笔报价比参考价少多少（基点）。参考量报价为 0（数量太小）时无法判断，返回 null。
export async function swapImpactBps(ctx, route, amountIn, amountOut) {
  const ref = amountIn / 1000n;
  if (ref === 0n) return null;
  const { amountOut: refOut } = await quoteSwap(ctx, route, ref);
  if (refOut === 0n) return null;
  const ratio = (amountOut * ref * 10_000n) / (refOut * amountIn);
  return ratio >= 10_000n ? 0 : Number(10_000n - ratio);
}

// maxImpactBps 给出时，价格冲击超过它就不发送（code 'impact'）：滑点只防报价之后的价格变动，防不住在浅池里一次卖太多。
export async function swap(ctx, hooks, { tokenIn, tokenOut, amountIn, slippageBps, maxImpactBps = null }) {
  const route = swapRoute(ctx, tokenIn, tokenOut);
  if (amountIn <= 0n) throw new ExecError('兑换数量须大于 0');
  const held = await balanceOf(ctx, route.tokenIn);
  if (held < amountIn) throw new ExecError(`Safe 的 ${ctx.tokens.get(route.tokenIn)?.symbol ?? route.tokenIn} 余额不足：需要 ${amountIn}，现有 ${held}`);
  await ensureApprovals(ctx, hooks, [{ token: route.tokenIn, spender: AERO.swapRouter, amount: amountIn }]);
  const { params, amountOut } = await quoteSwap(ctx, route, amountIn);
  if (amountOut === 0n) throw new ExecError('兑换报价为 0，未发送');
  if (maxImpactBps !== null) {
    const impact = await swapImpactBps(ctx, route, amountIn, amountOut);
    if (impact !== null && impact > maxImpactBps) throw new ExecError(`价格冲击约 ${impact / 100}%，超过上限 ${maxImpactBps / 100}%，未兑换`, { code: 'impact' });
  }
  const before = await balanceOf(ctx, route.tokenOut);
  const symbol = (t) => ctx.tokens.get(t)?.symbol ?? t;
  hooks.moving?.('swap'); // 下一笔签名的是会挪动资金的兑换（自动调仓据此记录"已签名、结果未落定"）
  await sendRoleTx(ctx, hooks, `兑换 ${symbol(route.tokenIn)} → ${symbol(route.tokenOut)}`, [tx(AERO.swapRouter, ROUTER_I, 'exactInputSingle', [{ ...params, amountOutMinimum: minusBps(amountOut, slippageBps) }])]);
  const received = (await balanceOf(ctx, route.tokenOut)) - before;
  return { amountIn, quoted: amountOut, received: received > 0n ? received : 0n };
}

function checkRange(pool, tickLower, tickUpper) {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) throw new ExecError('区间下沿须小于上沿');
  if (tickLower % pool.tickSpacing !== 0 || tickUpper % pool.tickSpacing !== 0) throw new ExecError(`区间边界须是 tickSpacing ${pool.tickSpacing} 的整数倍`);
  if (tickLower < -887272 || tickUpper > 887272) throw new ExecError('区间超出 tick 范围');
}

// cap（{ usd, usd0, usd1 }）给出时，按比例取出的数量按两币美元价估值，超过 usd 则两币等比缩小到上限内。
export function capAmounts(ctx, pool, amount0, amount1, cap) {
  if (!cap) return { amount0, amount1, capped: false };
  const decimals = (token) => { const d = ctx.tokens.get(token)?.decimals; if (d == null) throw new ExecError('代币精度未知，无法按美元上限计算'); return d; };
  const value = (Number(amount0) / 10 ** decimals(pool.token0)) * cap.usd0 + (Number(amount1) / 10 ** decimals(pool.token1)) * cap.usd1;
  if (!(value > cap.usd)) return { amount0, amount1, capped: false };
  const scale = BigInt(Math.floor((cap.usd / value) * 1e9));
  return { amount0: (amount0 * scale) / 1_000_000_000n, amount1: (amount1 * scale) / 1_000_000_000n, capped: true };
}

// 开仓前预览：按比例取 Safe 余额，算出配平兑换并报价，不签名。
// amounts（原始单位）给出时按它投入（不超过 Safe 余额），不再按 shareBps 取比例：自动调仓只投入本次平仓收回的币，不动 Safe 里的其他余额。
export async function previewOpen(ctx, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance, amounts = null, cap = null }) {
  const pool = poolOf(ctx, poolAddress);
  checkRange(pool, tickLower, tickUpper);
  const [slot0, [feePips], b0, b1] = await read('池子与余额', () => Promise.all([
    call(ctx.rpc, POOL_I, pool.address, 'slot0'), call(ctx.rpc, POOL_I, pool.address, 'fee'), balanceOf(ctx, pool.token0), balanceOf(ctx, pool.token1),
  ]));
  const capped = (want, held) => (want > held ? held : want < 0n ? 0n : want);
  const shared = amounts ? { amount0: capped(amounts.amount0, b0), amount1: capped(amounts.amount1, b1), capped: false }
    : capAmounts(ctx, pool, (b0 * BigInt(shareBps)) / 10_000n, (b1 * BigInt(shareBps)) / 10_000n, cap);
  const { amount0, amount1 } = shared;
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
  return { pool: pool.address, tick: Number(slot0.tick), sqrtPriceX96: slot0.sqrtPriceX96, tickLower, tickUpper, amount0, amount1, capped: shared.capped, swap: swapPlan, deposit0: after0, deposit1: after1 };
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
export async function openPosition(ctx, hooks, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance, slippageBps, stake = true, expect = null, amounts = null, cap = null }) {
  const pool = poolOf(ctx, poolAddress);
  const preview = await previewOpen(ctx, { pool: poolAddress, tickLower, tickUpper, shareBps, rebalance, amounts, cap });
  if (preview.amount0 === 0n && preview.amount1 === 0n) throw new ExecError('可投入的数量为 0，未发送');
  if (expect) checkExpectation(preview, expect);
  let amount0 = preview.amount0, amount1 = preview.amount1;
  if (preview.swap) {
    hooks.step?.('配平兑换');
    const result = await swap(ctx, hooks, { tokenIn: preview.swap.tokenIn, tokenOut: preview.swap.tokenOut, amountIn: preview.swap.amountIn, slippageBps });
    if (preview.swap.tokenIn === pool.token0) { amount0 -= result.amountIn; amount1 += result.received; } else { amount1 -= result.amountIn; amount0 += result.received; }
    hooks.swapped?.({ amount0, amount1 });
  }
  hooks.step?.('开仓');
  await ensureApprovals(ctx, hooks, [{ token: pool.token0, spender: AERO.nft, amount: amount0 }, { token: pool.token1, spender: AERO.nft, amount: amount1 }]);
  const params = { token0: pool.token0, token1: pool.token1, tickSpacing: pool.tickSpacing, tickLower, tickUpper, amount0Desired: amount0, amount1Desired: amount1, amount0Min: 0n, amount1Min: 0n, recipient: ctx.safe, deadline: await deadline(ctx), sqrtPriceX96: 0n };
  let quote;
  try { quote = await call(ctx.rpc, NPM_I, AERO.nft, 'mint', [params], ctx.safe); } catch (error) { throw new ExecError(`开仓报价失败：${errorText(error)}`); }
  if (quote.liquidity === 0n) throw new ExecError('开仓报价的流动性为 0，未发送');
  hooks.moving?.('mint');
  const receipt = await sendRoleTx(ctx, hooks, `开仓 ${pool.name} [${tickLower}, ${tickUpper}]`, [tx(AERO.nft, NPM_I, 'mint', [{ ...params, amount0Min: minusBps(quote.amount0, slippageBps), amount1Min: minusBps(quote.amount1, slippageBps) }])]);
  const minted = receipt.logs.filter((l) => getAddress(l.address) === AERO.nft).map((l) => { try { return NPM_I.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === 'Transfer' && BigInt(e.args.from) === 0n && getAddress(e.args.to) === ctx.safe);
  if (!minted) throw new ExecError(`开仓已确认，但回执里没有 NFT 转入 Safe（${receipt.hash}）`, { signed: true });
  const tokenId = minted.args.tokenId;
  // 质押前先上报：质押失败时头寸留在 Safe，仍要能在页面找到。
  try { hooks.minted?.(tokenId); } catch {} // 只是记录，不能挡住质押
  if (stake) { hooks.step?.('质押'); await stakePosition(ctx, hooks, { tokenId }); }
  return { tokenId, amount0: quote.amount0, amount1: quote.amount1 };
}

export async function locate(ctx, tokenId) {
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

// 减仓：解押（如已质押）→ 按比例 decreaseLiquidity + collect（不销毁 NFT）→ 原来已质押的重新质押（罚没期从重新质押起算）。
// shareBps 为 10000 时等同平仓，请用 closePosition。收回的币与本头寸未领的手续费一起回到 Safe。
export async function reducePosition(ctx, hooks, { tokenId, shareBps, slippageBps, acceptPenalty = false }) {
  if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps >= 10_000) throw new ExecError('减仓比例须在 0.01% 到 99.99% 之间；全部撤出请用平仓');
  const { position, staked } = await locate(ctx, tokenId);
  const liquidity = (position.liquidity * BigInt(shareBps)) / 10_000n;
  if (liquidity === 0n) throw new ExecError(`头寸 #${tokenId} 按 ${shareBps / 100}% 撤出的流动性为 0，未发送`);
  if (staked) { hooks.step?.('解押'); await unstakePosition(ctx, hooks, { tokenId, acceptPenalty }); }
  hooks.step?.('撤出部分流动性');
  const params = { tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: await deadline(ctx) };
  let quote;
  try { quote = await call(ctx.rpc, NPM_I, AERO.nft, 'decreaseLiquidity', [params], ctx.safe); } catch (error) { throw new ExecError(`撤出报价失败：${errorText(error)}`, { signed: staked }); }
  await sendRoleTx(ctx, hooks, `减仓 #${tokenId} ${shareBps / 100}%`, [
    tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ ...params, amount0Min: minusBps(quote.amount0, slippageBps), amount1Min: minusBps(quote.amount1, slippageBps) }]),
    tx(AERO.nft, NPM_I, 'collect', [{ tokenId, recipient: ctx.safe, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]),
  ]);
  if (staked) {
    hooks.step?.('重新质押');
    try { await stakePosition(ctx, hooks, { tokenId }); } catch (error) {
      throw new ExecError(`减仓已完成，但头寸 #${tokenId} 重新质押失败：${error.message}。头寸未质押、不领排放，自动调仓也不管它，请在「仓位」手动质押`, { signed: true, code: error.code });
    }
  }
  return { reduced: true, tokenId, liquidity, restaked: staked };
}

// 撤出后换成本池的某一种代币：卖出另一种，必须有白名单兑换路径。执行前先校验，免得撤出后才发现换不了。
export function exitRoute(ctx, pool, exitToken) {
  let out;
  try { out = getAddress(exitToken); } catch { throw new ExecError('要换成的代币地址无效'); }
  if (out !== pool.token0 && out !== pool.token1) throw new ExecError('只能换成本池的两种代币之一');
  const tokenIn = out === pool.token0 ? pool.token1 : pool.token0;
  const symbol = (t) => ctx.tokens.get(t)?.symbol ?? t;
  const route = ctx.permissions.swaps.find((s) => s.tokenIn === tokenIn && s.tokenOut === out);
  if (!route) throw new ExecError(`白名单里没有 ${symbol(tokenIn)} → ${symbol(out)} 的兑换路径，不能换成 ${symbol(out)}`);
  return route;
}

// 某代币今日剩余的 Roles 额度（没有额度键时为 0）。
export async function remainingAllowance(ctx, token) {
  const key = allowanceFor(ctx, token)?.key;
  return key ? (await remainingAllowances(ctx)).allowances.get(key)?.remaining ?? 0n : 0n;
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
// maxAmount 给出时最多卖这么多（自动调仓只卖本次平仓领到的 AERO）。
export async function sellRewards(ctx, hooks, { slippageBps, minAmount, maxAmount = null }) {
  const route = ctx.permissions.swaps.find((s) => s.tokenIn === REWARD_TOKEN);
  if (!route) return { sold: false, reason: 'no_route' };
  let amount = await balanceOf(ctx, REWARD_TOKEN);
  const key = allowanceFor(ctx, REWARD_TOKEN)?.key;
  const remaining = key ? (await remainingAllowances(ctx)).allowances.get(key)?.remaining ?? 0n : 0n;
  if (amount > remaining) amount = remaining;
  if (maxAmount !== null && amount > maxAmount) amount = maxAmount;
  if (amount < minAmount || amount === 0n) return { sold: false, reason: 'below_min', amount };
  return { sold: true, ...(await swap(ctx, hooks, { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn: amount, slippageBps })) };
}
