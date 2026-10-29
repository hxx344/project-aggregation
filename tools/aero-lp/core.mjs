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
