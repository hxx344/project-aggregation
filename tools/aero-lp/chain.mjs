// 链上读取与交易执行。每轮都从链上重建状态，不依赖本地记录，交易结果未知时下一轮按现状继续。
import { Contract, FetchRequest, JsonRpcProvider, Network, formatUnits, getAddress, keccak256 } from 'ethers';

const BASE_CHAIN_ID = 8453;
const RPC_TIMEOUT_MS = 20_000;
const READ_ATTEMPTS = 3;
const RECEIPT_TIMEOUT_MS = 180_000;
const DEADLINE_SEC = 600;
const MAX_UINT128 = (1n << 128n) - 1n;

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function gauge() view returns (address)',
  'function factory() view returns (address)',
  'function observe(uint32[]) view returns (int56[] tickCumulatives, uint160[])',
];
const FACTORY_ABI = ['function getPool(address, address, int24) view returns (address)'];
const GAUGE_ABI = [
  'function nft() view returns (address)',
  'function pool() view returns (address)',
  'function gaugeFactory() view returns (address)',
  'function stakedValues(address) view returns (uint256[])',
  'function depositBlock(uint256) view returns (uint256)',
  'function deposit(uint256)',
  'function withdraw(uint256)',
];
const GAUGE_FACTORY_ABI = ['function effectivePenaltyConfig(address) view returns (uint256 minStakeBlocks, uint256 penaltyRate)'];
const NFT_ABI = [
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function getApproved(uint256) view returns (address)',
  'function approve(address, uint256)',
  'function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256) payable',
  'function multicall(bytes[]) payable returns (bytes[])',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ethers 的 shortMessage 对 RPC 错误常只剩概括，补上节点返回的原始原因。
export function errorText(error) {
  const base = error?.shortMessage || error?.message || String(error);
  const inner = error?.info?.error?.message;
  return inner && !base.includes(inner) ? `${base} (${inner})` : base;
}

// 读请求：单次 20 秒超时，最多 3 次，间隔 2s/4s；仍失败则抛出，由调用方跳过本轮。
async function read(label, fn) {
  let last;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try { return await fn(); } catch (error) {
      last = error;
      if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`read ${label} failed after ${READ_ATTEMPTS} attempts: ${errorText(last)}`);
}

export function provider(rpcUrl) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = RPC_TIMEOUT_MS;
  return new JsonRpcProvider(request, Network.from(BASE_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
}

// 从池地址出发解析 gauge 与 NFT 管理器，并与配置里固定的工厂、NFT 管理器地址逐项比对：
// 池地址写错或被替换时，不会把代币授权给池子自报的合约。
export async function connect({ rpcUrl, pool: poolAddress, token, factory: expectedFactory, nft: expectedNft }, runner) {
  const rpc = runner?.provider || provider(rpcUrl);
  const chainId = await read('chainId', () => rpc.send('eth_chainId', []));
  if (Number(chainId) !== BASE_CHAIN_ID) throw new Error(`rpc chainId ${Number(chainId)} is not Base (${BASE_CHAIN_ID})`);
  const pool = new Contract(poolAddress, POOL_ABI, rpc);
  const [token0, token1, spacing, gaugeAddress, factoryAddress] = await read('pool', () => Promise.all([pool.token0(), pool.token1(), pool.tickSpacing(), pool.gauge(), pool.factory()]));
  if (getAddress(token0) !== getAddress(token)) throw new Error(`pool token0 ${token0} is not configured token ${token}; single-sided range above price requires the asset to be token0`);
  if (getAddress(factoryAddress) !== getAddress(expectedFactory)) throw new Error(`pool factory ${factoryAddress} != config.factory ${expectedFactory}`);
  const factory = new Contract(factoryAddress, FACTORY_ABI, rpc);
  const registered = await read('factory.getPool', () => factory.getPool(token0, token1, spacing));
  if (getAddress(registered) !== getAddress(poolAddress)) throw new Error(`factory ${factoryAddress} does not list pool ${poolAddress}`);
  const gaugeRead = new Contract(gaugeAddress, GAUGE_ABI, rpc);
  const [nftAddress, gaugePool, gaugeFactoryAddress] = await read('gauge', () => Promise.all([gaugeRead.nft(), gaugeRead.pool(), gaugeRead.gaugeFactory()]));
  if (getAddress(gaugePool) !== getAddress(poolAddress)) throw new Error(`gauge ${gaugeAddress} points to pool ${gaugePool}`);
  if (getAddress(nftAddress) !== getAddress(expectedNft)) throw new Error(`gauge nft ${nftAddress} != config.nft ${expectedNft}`);
  const t0 = new Contract(token0, ERC20_ABI, rpc), t1 = new Contract(token1, ERC20_ABI, rpc);
  const [decimals0, decimals1, symbol0, symbol1] = await read('tokens', () => Promise.all([t0.decimals(), t1.decimals(), t0.symbol(), t1.symbol()]));
  const signerOrProvider = runner || rpc;
  return {
    rpc,
    runner,
    spacing: Number(spacing),
    token0, token1, decimals0: Number(decimals0), decimals1: Number(decimals1), symbol0, symbol1,
    pool,
    gauge: new Contract(gaugeAddress, GAUGE_ABI, signerOrProvider),
    gaugeFactory: new Contract(gaugeFactoryAddress, GAUGE_FACTORY_ABI, rpc),
    nft: new Contract(nftAddress, NFT_ABI, signerOrProvider),
    erc0: new Contract(token0, ERC20_ABI, signerOrProvider),
    addresses: { pool: getAddress(poolAddress), gauge: gaugeAddress, nft: nftAddress, factory: factoryAddress, gaugeFactory: gaugeFactoryAddress },
  };
}

async function positionOf(ctx, tokenId, staked) {
  const p = await read(`positions(${tokenId})`, () => ctx.nft.positions(tokenId));
  if (getAddress(p.token0) !== getAddress(ctx.token0) || getAddress(p.token1) !== getAddress(ctx.token1) || Number(p.tickSpacing) !== ctx.spacing) return null;
  const depositBlock = staked ? await read(`depositBlock(${tokenId})`, () => ctx.gauge.depositBlock(tokenId)) : 0n;
  return { tokenId, staked, tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity, depositBlock };
}

// twapSec 为 0 时不读 TWAP。TWAP 单独读取：观测记录不够覆盖窗口（observe 回滚 OLD）等失败
// 只让本轮不调仓（twapUnavailable），不影响补质押与清理。
export async function readState(ctx, wallet, twapSec) {
  let observed = null, twapError = null;
  if (twapSec > 0) {
    try { observed = await read('observe', () => ctx.pool.observe([twapSec, 0])); } catch (error) { twapError = error.message; }
  }
  const [slot0, blockNumber, walletToken0, walletEth, latestNonce, pendingNonce, stakedIds, ownedCount, penaltyRaw] = await read('state', () => Promise.all([
    ctx.pool.slot0(),
    ctx.rpc.getBlockNumber(),
    ctx.erc0.balanceOf(wallet),
    ctx.rpc.getBalance(wallet),
    ctx.rpc.getTransactionCount(wallet, 'latest'),
    ctx.rpc.getTransactionCount(wallet, 'pending'),
    ctx.gauge.stakedValues(wallet),
    ctx.nft.balanceOf(wallet),
    ctx.gaugeFactory.effectivePenaltyConfig(ctx.addresses.gauge),
  ]));
  const positions = [];
  for (const id of stakedIds) { const p = await positionOf(ctx, id, true); if (p) positions.push(p); }
  for (let i = 0n; i < ownedCount; i++) {
    const id = await read('tokenOfOwnerByIndex', () => ctx.nft.tokenOfOwnerByIndex(wallet, i));
    const p = await positionOf(ctx, id, false);
    if (p) positions.push(p);
  }
  return {
    blockNumber,
    tick: Number(slot0.tick),
    twapTick: observed ? Math.floor(Number(observed.tickCumulatives[1] - observed.tickCumulatives[0]) / twapSec) : null,
    twapError,
    walletToken0,
    walletEth,
    inflight: pendingNonce > latestNonce,
    positions,
    penalty: { minStakeBlocks: penaltyRaw.minStakeBlocks, penaltyRate: penaltyRaw.penaltyRate },
  };
}

// 写交易：本地签名后先记录哈希再广播，广播超时也能按哈希核对；只发送一次，
// 回执最多等 180 秒，超时或回滚都抛出，不在本轮重发（下一轮按链上状态继续）。
async function send(ctx, log, label, method, args) {
  let hash = null;
  try {
    const populated = await ctx.runner.populateTransaction(await method.populateTransaction(...args));
    const signed = await ctx.runner.signTransaction(populated);
    hash = keccak256(signed);
    log({ event: 'tx_signed', label, hash, nonce: populated.nonce });
    const tx = await ctx.rpc.broadcastTransaction(signed);
    const receipt = await tx.wait(1, RECEIPT_TIMEOUT_MS);
    if (!receipt || receipt.status !== 1) throw new Error('reverted');
    log({ event: 'tx_confirmed', label, hash, block: receipt.blockNumber });
    return receipt;
  } catch (error) {
    const wrapped = new Error(`${label} failed${hash ? ` (${hash})` : ''}: ${errorText(error)}`);
    wrapped.signed = hash !== null; // 已签名：交易可能已上链，结果未知
    throw wrapped;
  }
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
const minusBps = (amount, bps) => (amount * BigInt(10_000 - bps)) / 10_000n;

async function unstake(ctx, log, tokenId) {
  await send(ctx, log, `gauge.withdraw #${tokenId}`, ctx.gauge.withdraw, [tokenId]);
}

async function closePosition(ctx, log, wallet, tokenId, slippageBps) {
  const p = await read(`positions(${tokenId})`, () => ctx.nft.positions(tokenId));
  const nftIface = ctx.nft.interface;
  const calls = [];
  if (p.liquidity > 0n) {
    const params = { tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() };
    const [a0, a1] = await ctx.nft.decreaseLiquidity.staticCall(params);
    calls.push(nftIface.encodeFunctionData('decreaseLiquidity', [{ ...params, amount0Min: minusBps(a0, slippageBps), amount1Min: minusBps(a1, slippageBps) }]));
    log({ event: 'close_quote', tokenId: String(tokenId), amount0: formatUnits(a0, ctx.decimals0), amount1: formatUnits(a1, ctx.decimals1) });
  }
  calls.push(nftIface.encodeFunctionData('collect', [{ tokenId, recipient: wallet, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]));
  calls.push(nftIface.encodeFunctionData('burn', [tokenId]));
  await send(ctx, log, `close #${tokenId}`, ctx.nft.multicall, [calls]);
}

async function stake(ctx, log, tokenId) {
  const approved = await read(`getApproved(${tokenId})`, () => ctx.nft.getApproved(tokenId));
  if (getAddress(approved) !== getAddress(ctx.addresses.gauge)) await send(ctx, log, `nft.approve #${tokenId}`, ctx.nft.approve, [ctx.addresses.gauge, tokenId]);
  await send(ctx, log, `gauge.deposit #${tokenId}`, ctx.gauge.deposit, [tokenId]);
}

async function mint(ctx, log, wallet, { tickLower, tickUpper }, { keepInWallet, minDeploy, slippageBps }) {
  const balance = await read('balance', () => ctx.erc0.balanceOf(wallet));
  const amount = balance > keepInWallet ? balance - keepInWallet : 0n;
  if (amount < minDeploy) { log({ event: 'mint_skipped', reason: 'amount below minDeploy', amount: formatUnits(amount, ctx.decimals0) }); return null; }
  // mint 预演需要足额授权，所以授权在预演之前；授权只给 NFT 管理器且只到本次数量。
  const allowance = await read('allowance', () => ctx.erc0.allowance(wallet, ctx.addresses.nft));
  if (allowance < amount) await send(ctx, log, `${ctx.symbol0}.approve`, ctx.erc0.approve, [ctx.addresses.nft, amount]);
  const params = {
    token0: ctx.token0, token1: ctx.token1, tickSpacing: ctx.spacing, tickLower, tickUpper,
    amount0Desired: amount, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n,
    recipient: wallet, deadline: deadline(), sqrtPriceX96: 0n,
  };
  const quote = await ctx.nft.mint.staticCall(params);
  // 价格若已进入新区间，单边 token0 无法铸造足额流动性；放弃本次，下轮按新价格重算。
  if (quote.amount1 > 0n || quote.liquidity === 0n) throw new Error(`mint quote needs ${ctx.symbol1} or yields no liquidity; price moved into target range`);
  const receipt = await send(ctx, log, `mint [${tickLower}, ${tickUpper}]`, ctx.nft.mint, [{ ...params, amount0Min: minusBps(quote.amount0, slippageBps) }]);
  const minted = receipt.logs
    .filter((l) => getAddress(l.address) === getAddress(ctx.addresses.nft))
    .map((l) => { try { return ctx.nft.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === 'Transfer' && BigInt(e.args.from) === 0n && getAddress(e.args.to) === getAddress(wallet));
  if (!minted) throw new Error(`mint confirmed but no NFT Transfer to wallet in ${receipt.hash}`);
  log({ event: 'minted', tokenId: String(minted.args.tokenId), amount0: formatUnits(quote.amount0, ctx.decimals0) });
  return minted.args.tokenId;
}

// 签名前就失败的质押（如 gauge 已停用，预估 gas 即回滚）只记录，不阻断撤仓与开仓；头寸保持未质押，
// 下一轮再试。已签名的交易结果未知，照常抛出结束本轮，由下一轮按链上状态继续。
async function tryStake(ctx, log, tokenId) {
  try { await stake(ctx, log, tokenId); } catch (error) {
    if (error.signed) throw error;
    log({ event: 'stake_failed', tokenId: String(tokenId), error: errorText(error) });
  }
}

// 按计划顺序执行：清理 → 补质押 → 撤仓 → 用钱包余额建新仓并质押。除质押外任何一步失败即停止本轮。
export async function execute(ctx, log, wallet, plan, options) {
  for (const a of plan.actions) {
    if (a.type === 'cleanup') { if (a.staked) await unstake(ctx, log, a.tokenId); await closePosition(ctx, log, wallet, a.tokenId, options.slippageBps); }
    else if (a.type === 'stake') await tryStake(ctx, log, a.tokenId);
    else if (a.type === 'close') { if (a.staked) await unstake(ctx, log, a.tokenId); await closePosition(ctx, log, wallet, a.tokenId, options.slippageBps); }
  }
  const mintAction = plan.actions.find((a) => a.type === 'mint');
  if (!mintAction) return;
  // 撤仓期间价格可能变化：用最新 tick 重算目标区间（同样受上沿与 TWAP 保护约束）。
  const slot0 = await read('slot0', () => ctx.pool.slot0());
  const target = options.retarget(Number(slot0.tick));
  if (!target) { log({ event: 'mint_skipped', reason: 'latest price is at/above upper bound or below the TWAP guard' }); return; }
  const tokenId = await mint(ctx, log, wallet, target, options);
  if (tokenId !== null) await tryStake(ctx, log, tokenId);
}
