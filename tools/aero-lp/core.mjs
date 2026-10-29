// 纯计算与决策：不访问链，不依赖 ethers，便于单测。
// 价格单位一律为「token1 / token0」（本池即 USDC / RSGP），tick 与 Uniswap V3 / Slipstream 相同。

const LN_TICK = Math.log(1.0001);

export function tickToPrice(tick, decimals0, decimals1) {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

export const alignUp = (tick, spacing) => Math.ceil(tick / spacing) * spacing;

// 价格对应的最近可用 tick（对数距离最近），用于固定上沿。
export function nearestUsableTick(price, decimals0, decimals1, spacing) {
  if (!(price > 0)) throw new Error(`price must be positive: ${price}`);
  return Math.round(Math.log(price * 10 ** (decimals1 - decimals0)) / LN_TICK / spacing) * spacing;
}

// 当前价格上方 gapBps 处取第一个可用 tick 作下沿，上沿固定。
// 下沿必须严格高于当前 tick，头寸才全部是 token0（单边）。
export function targetRange({ currentTick, spacing, gapBps, upperTick }) {
  const gapTicks = Math.ceil(Math.log(1 + gapBps / 10_000) / LN_TICK);
  let tickLower = alignUp(currentTick + gapTicks, spacing);
  if (tickLower <= currentTick) tickLower += spacing;
  if (tickLower >= upperTick) return null;
  return { tickLower, tickUpper: upperTick };
}

// 现价比 TWAP 低超过 maxDeviationBps 时视为异常下跌（可能是被砸盘），本轮不下移区间、不新开仓。
export function belowTwap(currentTick, twapTick, maxDeviationBps) {
  if (twapTick === null || twapTick === undefined) return false;
  const deviationTicks = Math.ceil(Math.log(1 + maxDeviationBps / 10_000) / LN_TICK);
  return currentTick < twapTick - deviationTicks;
}

export function rangeState(position, currentTick) {
  if (currentTick < position.tickLower) return 'below';
  if (currentTick >= position.tickUpper) return 'above';
  return 'in';
}

export function penaltyActive(position, penalty, blockNumber) {
  if (!position.staked || !penalty || penalty.penaltyRate <= 0n) return false;
  return BigInt(blockNumber) < BigInt(position.depositBlock) + penalty.minStakeBlocks;
}

// 一轮决策。positions 只含本钱包在本池的头寸（已质押和未质押）。
// 只管理上沿等于配置上沿的头寸，其余原样保留并在 notes 中列出。
// twapTick 为 null 表示不做 TWAP 保护；twapUnavailable 表示开了保护但本轮读不到 TWAP，按保护触发处理。
export function planCycle({ currentTick, twapTick = null, twapUnavailable = false, maxTwapDeviationBps = 0, spacing, gapBps, upperTick, positions, walletToken0, keepInWallet, minDeploy, penalty, blockNumber }) {
  const notes = [];
  const actions = [];
  const managed = positions.filter((p) => p.tickUpper === upperTick);
  for (const p of positions) if (p.tickUpper !== upperTick) notes.push(`ignore #${p.tokenId}: tickUpper ${p.tickUpper} != ${upperTick}`);
  const target = targetRange({ currentTick, spacing, gapBps, upperTick });
  if (!target) notes.push('price at or above upper bound: no new single-sided range possible');
  const guarded = twapUnavailable || belowTwap(currentTick, twapTick, maxTwapDeviationBps);
  if (twapUnavailable) notes.push('TWAP unavailable: rebalance and new deploy deferred');
  else if (guarded) notes.push(`tick ${currentTick} more than ${maxTwapDeviationBps}bps below TWAP tick ${twapTick}: rebalance and new deploy deferred`);

  for (const p of managed.filter((x) => x.liquidity === 0n)) actions.push({ type: 'cleanup', tokenId: p.tokenId, staked: p.staked });

  const live = managed.filter((x) => x.liquidity > 0n);
  const closing = [];
  for (const p of live) {
    const state = rangeState(p, currentTick);
    if (state === 'below' && target && target.tickLower < p.tickLower && !guarded) {
      if (penaltyActive(p, penalty, blockNumber)) notes.push(`#${p.tokenId} inside early-unstake penalty window, rebalance deferred`);
      else { closing.push(p); continue; }
    }
    if (!p.staked) actions.push({ type: 'stake', tokenId: p.tokenId });
  }
  for (const p of closing) actions.push({ type: 'close', tokenId: p.tokenId, staked: p.staked });

  const idle = walletToken0 > keepInWallet ? walletToken0 - keepInWallet : 0n;
  if (target && !guarded && (closing.length > 0 || idle >= minDeploy)) actions.push({ type: 'mint', ...target });

  const status = live.length === 0 ? 'none' : live.map((p) => `#${p.tokenId}:${rangeState(p, currentTick)}${p.staked ? '' : ':unstaked'}`).join(',');
  return { target, actions, notes, status };
}

// 以下为展示用浮点估算，不参与交易数量计算。
const SECONDS_PER_YEAR = 365 * 86_400;

// 头寸按当前价格折算的两种代币数量（已除以精度）。sqrtPrice 为 sqrt(token1 原始单位 / token0 原始单位)。
export function positionAmounts({ liquidity, tickLower, tickUpper }, sqrtPrice, decimals0, decimals1) {
  const L = Number(liquidity), sa = 1.0001 ** (tickLower / 2), sb = 1.0001 ** (tickUpper / 2);
  const sp = Math.min(Math.max(sqrtPrice, sa), sb);
  return { amount0: (L * (sb - sp)) / (sp * sb) / 10 ** decimals0, amount1: (L * (sp - sa)) / 10 ** decimals1 };
}

// 质押头寸的 AERO 排放年化：头寸按流动性占活跃质押流动性的比例分得排放。
// 价格低于区间时头寸不在活跃流动性里，按「价格刚进入下沿」估算：分母加上本头寸，价值按下沿价格折算。
export function emissionApr({ rewardPerSecond, rewardPrice, stakedLiquidity, position, price, decimals0, decimals1 }) {
  const L = Number(position.liquidity);
  if (!(rewardPerSecond > 0) || !(rewardPrice > 0) || !(L > 0)) return null;
  const sqrtLower = 1.0001 ** (position.tickLower / 2);
  if (price.tick >= position.tickUpper) return { apr: 0, estimated: false };
  const entering = price.tick < position.tickLower;
  const share = L / (Number(stakedLiquidity) + (entering ? L : 0));
  const sqrt = entering ? sqrtLower : price.sqrt;
  const { amount0, amount1 } = positionAmounts(position, sqrt, decimals0, decimals1);
  const value = amount0 * sqrt * sqrt * 10 ** (decimals0 - decimals1) + amount1;
  if (!(value > 0) || !(share > 0) || share > 1) return null;
  return { apr: (rewardPerSecond * SECONDS_PER_YEAR * rewardPrice * share) / value, estimated: entering };
}

// 可配置参数（工作台页面与 CLI 共用同一套校验）。连接类参数变化时需要重连链上合约。
export const SETTING_KEYS = ['rpcUrl', 'pool', 'factory', 'nft', 'token', 'upperPrice', 'gapBps', 'intervalSec', 'twapSec', 'maxTwapDeviationBps', 'slippageBps', 'keepInWallet', 'minDeploy', 'minEthForGas'];
export const CONNECTION_KEYS = ['rpcUrl', 'pool', 'factory', 'nft', 'token'];
export const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d{1,30}(\.\d{1,18})?$/;
const SETTING_RULES = {
  rpcUrl: (v) => typeof v === 'string' && v.length <= 512 && /^https:\/\/[^\s/?#]+[^\s]*$/.test(v),
  pool: (v) => typeof v === 'string' && ADDRESS.test(v),
  factory: (v) => typeof v === 'string' && ADDRESS.test(v),
  nft: (v) => typeof v === 'string' && ADDRESS.test(v),
  token: (v) => typeof v === 'string' && ADDRESS.test(v),
  upperPrice: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12,
  gapBps: (v) => Number.isInteger(v) && v >= 0 && v <= 10_000,
  intervalSec: (v) => Number.isInteger(v) && v >= 60 && v <= 86_400,
  // 池子每块最多一条观测（本池容量 900，Base 约 2 秒一块），窗口过长时 observe 会回滚。
  twapSec: (v) => Number.isInteger(v) && v >= 0 && v <= 3_600,
  maxTwapDeviationBps: (v) => Number.isInteger(v) && v >= 1 && v <= 5_000,
  slippageBps: (v) => Number.isInteger(v) && v >= 1 && v <= 500,
  keepInWallet: (v) => typeof v === 'string' && DECIMAL.test(v),
  minDeploy: (v) => typeof v === 'string' && DECIMAL.test(v),
  minEthForGas: (v) => typeof v === 'string' && DECIMAL.test(v),
};

// 返回只含 SETTING_KEYS 的新对象；extra 列出调用方允许额外出现、由调用方自行处理的键。
export function validateSettings(value, { extra = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object');
  for (const k of Object.keys(value)) if (!SETTING_KEYS.includes(k) && !extra.includes(k)) throw new Error(`config.${k} is not supported`);
  for (const k of SETTING_KEYS) if (!SETTING_RULES[k](value[k])) throw new Error(`config.${k} is invalid: ${JSON.stringify(value[k])}`);
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, value[k]]));
}

// 交易账本 txs.jsonl：每行一笔已签名交易的回执摘要（fee/reward 为 wei 十进制字符串）。
// 同一哈希可能被并发进程重复写入，按哈希去重；损坏的行跳过。
export function parseLedger(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(e.hash)) continue;
    entries.set(e.hash.toLowerCase(), e);
  }
  return [...entries.values()];
}

const wei = (v) => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : 0n);

export function summarizeLedger(entries, wallet) {
  const sum = { txs: 0, failed: 0, fee: 0n, reward: 0n, since: null };
  const owner = wallet?.toLowerCase();
  for (const e of entries) {
    if (typeof e.wallet !== 'string' || e.wallet.toLowerCase() !== owner) continue;
    sum.txs++;
    if (e.status !== 'ok') sum.failed++;
    sum.fee += wei(e.fee); sum.reward += wei(e.reward);
    if (typeof e.at === 'string' && (!sum.since || e.at < sum.since)) sum.since = e.at;
  }
  return sum;
}
