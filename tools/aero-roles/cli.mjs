#!/usr/bin/env node
// 生成 Safe 部署批次：读取策略配置，逐项在链上核对 Safe、池子与 gauge，输出 Safe{Wallet} Transaction Builder 可导入的 JSON。
// 用法：node tools/aero-roles/cli.mjs plan --config <config.json> --safe <Safe 地址> --owner <硬件钱包地址> --bot <bot 地址> --out <batch.json> [--salt <整数>] [--rpc <可信 RPC>]
// 本命令只读链，不签名、不发送；批次由管理钱包在 Safe 界面核对后签名执行。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider, Network, ZeroAddress, formatUnits, getAddress, keccak256 } from 'ethers';
import { AERO, BASE_CHAIN_ID, CODEHASH, SAFE, SAFE_PROXY_CODEHASH } from './addresses.mjs';
import { buildPermissions } from './permissions.mjs';
import { gaugeLiveness } from './executor.mjs';
import { FALLBACK_HANDLER_SLOT, GUARD_SLOT, MODULE_GUARD_SLOT, MODULES_SENTINEL, SAFE_ABI, buildSetupBatch, toTransactionBuilderJson } from './roles-calls.mjs';

const RPC_TIMEOUT_MS = 20_000;
const READ_ATTEMPTS = 3;

// 读请求：单次 20 秒超时，最多 3 次，间隔 2s/4s；仍失败则整条命令失败退出，不输出批次。
async function read(label, fn) {
  let last;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try { return await fn(); } catch (error) {
      last = error;
      if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`read ${label} failed after ${READ_ATTEMPTS} attempts: ${last?.shortMessage || last?.message}`);
}

export function provider(rpcUrl) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = RPC_TIMEOUT_MS;
  return new JsonRpcProvider(request, Network.from(BASE_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
}

const POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function tickSpacing() view returns (int24)', 'function gauge() view returns (address)', 'function factory() view returns (address)'];
const GAUGE_ABI = ['function pool() view returns (address)', 'function nft() view returns (address)', 'function voter() view returns (address)'];
const FACTORY_ABI = ['function getPool(address, address, int24) view returns (address)'];
const ERC20_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];

// 链上核对，返回人工核对用的摘要行；任何不一致直接抛错。
export async function verifyOnChain(rpc, { permissions, ...input }) {
  // 导出函数：调用方可能传入小写地址，统一 checksum 后再做相等比较。
  const [safe, owner, bot, roles] = [input.safe, input.owner, input.bot, input.roles].map((a) => getAddress(a));
  const problems = [];
  const lines = [];
  const chainId = Number(await read('chainId', () => rpc.send('eth_chainId', [])));
  if (chainId !== BASE_CHAIN_ID) throw new Error(`rpc chainId ${chainId} is not Base`);
  const word = (w) => getAddress('0x' + w.slice(-40));
  const safeContract = new Contract(safe, SAFE_ABI, rpc);
  const [safeCode, version, owners, threshold, singletonWord, handlerWord, guardWord, moduleGuardWord, [modules], rolesCode, botCode] = await read('safe', () => Promise.all([
    rpc.getCode(safe), safeContract.VERSION(), safeContract.getOwners(), safeContract.getThreshold(), rpc.getStorage(safe, 0), rpc.getStorage(safe, FALLBACK_HANDLER_SLOT),
    rpc.getStorage(safe, GUARD_SLOT), rpc.getStorage(safe, MODULE_GUARD_SLOT), safeContract.getModulesPaginated(MODULES_SENTINEL, 10), rpc.getCode(roles), rpc.getCode(bot),
  ]));
  lines.push(`Safe ${safe} v${version}，owners ${owners.join(', ')}，阈值 ${threshold}`);
  // 权限模型的前提：只有硬件钱包能签 Safe 交易，Safe 上没有别的模块（模块可绕过 Roles 直接转账），没有能拦住紧急停止的 guard。
  // 以下读数都假定 --safe 是标准 SafeProxy（只转发给槽 0 的 singleton），先核对代理自身的字节码。
  if (keccak256(safeCode) !== SAFE_PROXY_CODEHASH) problems.push(`${safe} 的字节码不是标准 SafeProxy ${SAFE.version}`);
  if (version !== SAFE.version || word(singletonWord) !== getAddress(SAFE.singletonL2)) problems.push(`Safe 不是 v${SAFE.version} SafeL2（singleton ${word(singletonWord)}，VERSION ${version}）`);
  if (owners.length !== 1 || getAddress(owners[0]) !== owner || Number(threshold) !== 1) problems.push(`Safe 必须是 1/1 且唯一 owner 为 ${owner}`);
  if (modules.length) problems.push(`Safe 已启用模块 ${modules.join(', ')}，需先移除`);
  if (word(guardWord) !== ZeroAddress) problems.push(`Safe 设置了 guard ${word(guardWord)}`);
  if (word(moduleGuardWord) !== ZeroAddress) problems.push(`Safe 设置了 module guard ${word(moduleGuardWord)}`);
  // gauge 解押时用 safeTransferFrom 把 NFT 退回 Safe，Safe 必须有处理 onERC721Received 的 fallback handler。
  if (word(handlerWord) !== getAddress(SAFE.fallbackHandler)) problems.push(`Safe fallback handler 是 ${word(handlerWord)}，需要 CompatibilityFallbackHandler ${SAFE.fallbackHandler}`);
  if (rolesCode !== '0x') problems.push(`Roles 代理地址 ${roles} 已有合约（换一个 --salt）`);
  if (bot === owner) problems.push('bot 不能是 Safe owner');
  if (botCode !== '0x') problems.push(`bot ${bot} 不是普通钱包地址`);
  const codes = await read('fixed contracts', () => Promise.all(Object.keys(CODEHASH).map((a) => rpc.getCode(a))));
  Object.entries(CODEHASH).forEach(([address, hash], i) => { if (keccak256(codes[i]) !== hash) problems.push(`${address} 的字节码与固定哈希不符`); });

  for (const pool of permissions.pools) {
    const gauge = new Contract(pool.gauge, GAUGE_ABI, rpc);
    const [poolAddress, nft, voter, gaugeCode] = await read(`gauge ${pool.name}`, () => Promise.all([gauge.pool(), gauge.nft(), gauge.voter(), rpc.getCode(pool.gauge)]));
    const p = new Contract(poolAddress, POOL_ABI, rpc);
    const [t0, t1, spacing, poolGauge, factory] = await read(`pool ${pool.name}`, () => Promise.all([p.token0(), p.token1(), p.tickSpacing(), p.gauge(), p.factory()]));
    const expectedClone = `0x363d3d373d3d3d363d73${AERO.gaugeImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    if (gaugeCode.toLowerCase() !== expectedClone) problems.push(`${pool.name}: gauge 不是已审实现 ${AERO.gaugeImplementation} 的克隆`);
    if (getAddress(nft) !== AERO.nft || getAddress(voter) !== AERO.voter) problems.push(`${pool.name}: gauge 的 nft/voter 与固定地址不符`);
    const registered = await read(`getPool ${pool.name}`, () => new Contract(AERO.clFactory, FACTORY_ABI, rpc).getPool(pool.token0, pool.token1, pool.tickSpacing));
    if (getAddress(poolGauge) !== pool.gauge || getAddress(factory) !== AERO.clFactory || getAddress(registered) !== getAddress(poolAddress)) problems.push(`${pool.name}: pool.gauge/factory/getPool 不符`);
    if (getAddress(t0) !== pool.token0 || getAddress(t1) !== pool.token1 || Number(spacing) !== pool.tickSpacing) problems.push(`${pool.name}: 池子代币或 tickSpacing 与配置不符`);
    const liveness = await gaugeLiveness(rpc, pool.gauge);
    if (liveness.state === 'killed') problems.push(`${pool.name}: gauge 已停用（${liveness.note}）`);
    lines.push(`做市池 ${pool.name}：${poolAddress}（tickSpacing ${pool.tickSpacing}），gauge ${pool.gauge}${liveness.state === 'alive' ? '' : `（gauge 状态未知：${liveness.note}）`}`);
  }
  const factory = new Contract(AERO.clFactory, FACTORY_ABI, rpc);
  for (const swap of permissions.swaps) {
    const pool = await read('getPool', () => factory.getPool(swap.tokenIn, swap.tokenOut, swap.tickSpacing));
    if (/^0x0{40}$/i.test(pool)) problems.push(`兑换 ${swap.tokenIn}→${swap.tokenOut} tickSpacing ${swap.tickSpacing} 没有池子`);
    lines.push(`兑换 ${swap.tokenIn} → ${swap.tokenOut}，tickSpacing ${swap.tickSpacing}，池 ${pool}`);
  }
  for (const a of permissions.allowances) {
    const token = new Contract(a.token, ERC20_ABI, rpc);
    const [symbol, decimals] = await read(`token ${a.token}`, () => Promise.all([token.symbol(), token.decimals()]));
    if (symbol !== a.symbol) problems.push(`代币 ${a.token} 链上 symbol 是 ${symbol}，配置写的是 ${a.symbol}`);
    lines.push(`额度 ${symbol}：每 24 小时 ${formatUnits(a.perDay, decimals)}`);
  }
  if (problems.length) throw new Error(`链上核对未通过：\n- ${problems.join('\n- ')}`);
  return lines;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'plan') throw new Error('usage: cli.mjs plan --config <file> --safe <addr> --owner <addr> --bot <addr> --out <file> [--salt <n>] [--rpc <url>]');
  const opts = args(rest);
  for (const k of ['config', 'safe', 'owner', 'bot', 'out']) if (!opts[k]) throw new Error(`--${k} is required`);
  const permissions = buildPermissions(JSON.parse(readFileSync(opts.config, 'utf8')));
  const safe = getAddress(opts.safe), owner = getAddress(opts.owner), bot = getAddress(opts.bot);
  const saltNonce = BigInt(opts.salt ?? Date.now());
  const { roles, transactions } = buildSetupBatch({ permissions, safe, bot, saltNonce });
  const rpc = provider(opts.rpc ?? 'https://mainnet.base.org');
  try {
    const lines = await verifyOnChain(rpc, { permissions, safe, owner, bot, roles });
    const batch = toTransactionBuilderJson({ safe, transactions, name: `Aero Roles ${permissions.roleKey}`, description: `Roles ${roles}，bot ${bot}，salt ${saltNonce}` });
    writeFileSync(opts.out, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
    console.log([`Roles 代理（预测）：${roles}，salt ${saltNonce}`, `bot：${bot}`, ...lines, '', `批次共 ${transactions.length} 笔：`, ...transactions.map((t, i) => `${String(i + 1).padStart(2)}. ${t.description}`), '', `已写入 ${opts.out}`].join('\n'));
  } finally {
    rpc.destroy();
  }
}

// 路径含非 ASCII 字符时 import.meta.url 会被百分号编码，按文件路径比较。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
