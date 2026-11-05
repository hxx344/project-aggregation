#!/usr/bin/env node
// 生成 Safe 部署批次：读取策略配置，逐项在链上核对 Safe、池子与 gauge，输出 Safe{Wallet} Transaction Builder 可导入的 JSON。
// 用法：node tools/aero-roles/cli.mjs plan --config <config.json> --safe <Safe 地址> --bot <bot 地址> --out <batch.json> [--salt <整数>] [--rpc <url>]
// 本命令只读链，不签名、不发送；批次由管理钱包在 Safe 界面核对后签名执行。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider, Network, formatUnits, getAddress } from 'ethers';
import { AERO, BASE_CHAIN_ID, SAFE } from './addresses.mjs';
import { buildPermissions } from './permissions.mjs';
import { FALLBACK_HANDLER_SLOT, SAFE_ABI, buildSetupBatch, toTransactionBuilderJson } from './roles-calls.mjs';

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
export async function verifyOnChain(rpc, { permissions, safe, bot, roles }) {
  const problems = [];
  const lines = [];
  const chainId = Number(await read('chainId', () => rpc.send('eth_chainId', [])));
  if (chainId !== BASE_CHAIN_ID) throw new Error(`rpc chainId ${chainId} is not Base`);
  const safeContract = new Contract(safe, SAFE_ABI, rpc);
  const [version, owners, threshold, handlerWord, rolesCode, botCode] = await read('safe', () => Promise.all([
    safeContract.VERSION(), safeContract.getOwners(), safeContract.getThreshold(), rpc.getStorage(safe, FALLBACK_HANDLER_SLOT), rpc.getCode(roles), rpc.getCode(bot),
  ]));
  const handler = getAddress('0x' + handlerWord.slice(-40));
  lines.push(`Safe ${safe} v${version}，owners ${owners.join(', ')}，阈值 ${threshold}`);
  if (!/^1\.(3|4)\./.test(version)) problems.push(`Safe 版本 ${version} 未经验证`);
  if (owners.some((o) => getAddress(o) === bot)) problems.push('bot 是 Safe owner');
  // gauge 解押时用 safeTransferFrom 把 NFT 退回 Safe，Safe 必须有处理 onERC721Received 的 fallback handler。
  if (handler !== getAddress(SAFE.fallbackHandler)) problems.push(`Safe fallback handler 是 ${handler}，需要 CompatibilityFallbackHandler ${SAFE.fallbackHandler}`);
  if (rolesCode !== '0x') problems.push(`Roles 代理地址 ${roles} 已有合约（换一个 --salt）`);
  if (botCode !== '0x') problems.push(`bot ${bot} 不是普通钱包地址`);

  for (const pool of permissions.pools) {
    const gauge = new Contract(pool.gauge, GAUGE_ABI, rpc);
    const [poolAddress, nft, voter, gaugeCode] = await read(`gauge ${pool.name}`, () => Promise.all([gauge.pool(), gauge.nft(), gauge.voter(), rpc.getCode(pool.gauge)]));
    const p = new Contract(poolAddress, POOL_ABI, rpc);
    const [t0, t1, spacing, poolGauge, factory] = await read(`pool ${pool.name}`, () => Promise.all([p.token0(), p.token1(), p.tickSpacing(), p.gauge(), p.factory()]));
    const expectedClone = `0x363d3d373d3d3d363d73${AERO.gaugeImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    if (gaugeCode.toLowerCase() !== expectedClone) problems.push(`${pool.name}: gauge 不是已审实现 ${AERO.gaugeImplementation} 的克隆`);
    if (getAddress(nft) !== AERO.nft || getAddress(voter) !== AERO.voter) problems.push(`${pool.name}: gauge 的 nft/voter 与固定地址不符`);
    if (getAddress(poolGauge) !== pool.gauge || getAddress(factory) !== AERO.clFactory) problems.push(`${pool.name}: pool.gauge/factory 不符`);
    if (getAddress(t0) !== pool.token0 || getAddress(t1) !== pool.token1 || Number(spacing) !== pool.tickSpacing) problems.push(`${pool.name}: 池子代币或 tickSpacing 与配置不符`);
    lines.push(`做市池 ${pool.name}：${poolAddress}（tickSpacing ${pool.tickSpacing}），gauge ${pool.gauge}`);
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
  if (command !== 'plan') throw new Error('usage: cli.mjs plan --config <file> --safe <addr> --bot <addr> --out <file> [--salt <n>] [--rpc <url>]');
  const opts = args(rest);
  for (const k of ['config', 'safe', 'bot', 'out']) if (!opts[k]) throw new Error(`--${k} is required`);
  const permissions = buildPermissions(JSON.parse(readFileSync(opts.config, 'utf8')));
  const safe = getAddress(opts.safe), bot = getAddress(opts.bot);
  const saltNonce = BigInt(opts.salt ?? Date.now());
  const { roles, transactions } = buildSetupBatch({ permissions, safe, bot, saltNonce });
  const rpc = provider(opts.rpc ?? 'https://mainnet.base.org');
  try {
    const lines = await verifyOnChain(rpc, { permissions, safe, bot, roles });
    const batch = toTransactionBuilderJson({ safe, transactions, name: `Aero Roles ${permissions.roleKey}`, description: `Roles ${roles}，bot ${bot}，salt ${saltNonce}` });
    writeFileSync(opts.out, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
    console.log([`Roles 代理（预测）：${roles}，salt ${saltNonce}`, `bot：${bot}`, ...lines, '', `批次共 ${transactions.length} 笔：`, ...transactions.map((t, i) => `${String(i + 1).padStart(2)}. ${t.description}`), '', `已写入 ${opts.out}`].join('\n'));
  } finally {
    rpc.destroy();
  }
}

// 路径含非 ASCII 字符时 import.meta.url 会被百分号编码，按文件路径比较。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
