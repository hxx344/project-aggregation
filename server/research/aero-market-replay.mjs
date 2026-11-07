// Aero 市场历史回放：用样本库每小时的真实价格、排放、质押流动性与代币美元价，把「按给定格数居中添加并质押，
// 出区间后撤出、把半个仓位换成另一种币、重新居中添加」的自动调仓策略重放一遍，得到投入 deposit 美元相对一直持有初始两币多赚的美元。
// 净年化是公式推算（无漂移随机游走的期望），回放是同一策略在真实路径上的结果，两者对照才能看出模型是否可信。
// 只用于看盘比较，不参与签名或下单。
const LOG_TICK = Math.log(1.0001);
const MIN_TICK = -887272, MAX_TICK = 887272;
const Q96 = 2 ** 96;
const DAY = 86400;
const HOUR = 3600;
// 与 src/aero-market-math.ts 的 VOL_FLOOR、REBALANCE_GAS_USD 相同。
export const VOL_FLOOR = 0.001;
const REBALANCE_GAS_USD = { ethereum: 10 };
const DEFAULT_REBALANCE_GAS_USD = 0.2;
// 样本覆盖不足这么多小时不给结果：几个小时的路径说明不了什么。
export const MIN_REPLAY_HOURS = 6;

export const fullRange = (s) => [Math.ceil(MIN_TICK / s) * s, Math.floor(MAX_TICK / s) * s];
// 与 src/aero-market-math.ts centeredRange 相同（测试比对）。
export function centeredRange(tick, tickSpacing, cells) {
  const s = tickSpacing, cell = Math.floor(tick / s);
  const below = Math.min(Math.max(Math.round((cell * s - tick + (cells * s) / 2) / s), 0), cells - 1);
  return [(cell - below) * s, (cell - below + cells) * s];
}

// 与 src/aero-market-math.ts rebalanceCostOf 相同（测试比对）：单次调仓成本占投入比例 = gas/投入 + 0.5 ×（费率 + 价格冲击）。
export function rebalanceCostFraction(pool, deposit) {
  const gasUsd = REBALANCE_GAS_USD[pool.chain] ?? DEFAULT_REBALANCE_GAS_USD, swapUsd = deposit > 0 ? deposit / 2 : 0;
  const l = Number(pool.liquidity), s = Number(pool.sqrtPriceX96) / Q96;
  let depth = null;
  if (l > 0 && s > 0) {
    if (pool.token1.usd !== null) depth = ((l * s) / 10 ** pool.token1.decimals) * pool.token1.usd;
    else if (pool.token0.usd !== null) depth = ((l / s) / 10 ** pool.token0.decimals) * pool.token0.usd;
    if (!Number.isFinite(depth)) depth = null;
  }
  const gas = deposit > 0 ? gasUsd / deposit : 0;
  const fee = pool.fee === null ? 0 : (0.5 * pool.fee) / 1e6;
  const slippage = depth === null || !(swapUsd > 0) ? 0 : 0.5 * (swapUsd / (depth + swapUsd));
  return gas + fee + slippage;
}

// 原始单位：价格 P = 1.0001^tick（每单位原始 token0 折合原始 token1），流动性 L 与链上一致。
const priceOf = (tick) => 1.0001 ** tick;
// 缺失读数：库里为 NULL，内存序列里为 NaN（保持数组为紧凑的双精度存储）。
const known = (v) => typeof v === 'number' && Number.isFinite(v);
function amountsOf(l, lower, upper, tick) {
  const sa = Math.sqrt(priceOf(lower)), sb = Math.sqrt(priceOf(upper)), sp = Math.min(Math.max(Math.sqrt(priceOf(tick)), sa), sb);
  return [l * (1 / sp - 1 / sb), l * (sp - sa)];
}
// 仓位按 token1 原始单位计的价值。
const valueOf = (l, lower, upper, tick) => { const [a0, a1] = amountsOf(l, lower, upper, tick); return a0 * priceOf(tick) + a1; };

// series：同一池子按整点升序的读数 { slots（秒）, ticks, staked, usd0, usd1, emission（美元/秒，可空）, vol（日波动，可空） }。
// cells 为区间格数，0 表示全范围；costFraction 为单次调仓成本占仓位价值的比例；delaySec 为每次调仓的停摆。
// 每小时之间：起点总在区间内（出区间当点就调仓）。终点出区间时按一半时间在区间计排放，并在终点按当时价格撤出、扣成本、重新居中；
// 两点都在区间内时，小时内碰到边沿又回来的概率按布朗桥 e^(−2·d₀·d₁/(σ²Δt)) 估算（上下沿各算一次），按这个概率计入调仓成本与停摆，
// 区间不随之移动。小时样本看不到小时内的路径，不加这一项会让窄区间看起来几乎不用调仓。
// 排放按「你的流动性 /（当时价位质押流动性 + 你的）」分配，按到账时的美元价计（不计卖出 AERO 的滑点）；手续费归投票者，不计入。
// 结果：net 为期末（仓位价值 + 已得排放）相对一直持有初始两币的美元差；impermanent 为扣除调仓成本以外的价值落后（含无常损失），
// cost 为调仓成本（gas、换币手续费与冲击），三者满足 net = emission − impermanent − cost。
export function replayPool(series, { tickSpacing, decimals0, decimals1, cells, costFraction, deposit, delaySec }) {
  const { slots, ticks, staked, usd0, usd1, emission, vol } = series;
  const usdPerToken1 = (i) => known(usd1[i]) && usd1[i] > 0 ? usd1[i] / 10 ** decimals1
    : known(usd0[i]) && usd0[i] > 0 ? usd0[i] / 10 ** decimals0 / priceOf(ticks[i]) : null;
  // 极小的合法投入可能使 gas/本金溢出为 Infinity，仍按成本耗尽处理，不把它伪装成缺少样本。
  if (!slots.length || !known(deposit) || !(deposit > 0) || !(costFraction >= 0)) return null;
  // 缺口两侧的持仓路径未知，不能跨过去继续旧仓位。只重放最新连续有效整点段，
  // 同时保留整个窗口的自然跨度与有效区间数；缺排放与缺价格/整点是不同的问题。
  const valid = (i) => Number.isInteger(slots[i]) && slots[i] % HOUR === 0 && known(ticks[i])
    && ticks[i] >= MIN_TICK && ticks[i] <= MAX_TICK && usdPerToken1(i) > 0 && known(staked[i]) && staked[i] >= 0;
  let start = 0, validSec = 0;
  for (let i = 1; i < slots.length; i++) {
    if (valid(i - 1) && valid(i) && slots[i] - slots[i - 1] === HOUR) validSec += HOUR;
    else start = i;
  }
  const last = slots.length - 1;
  const naturalHours = Math.max(0, slots[last] - slots[0]) / HOUR;
  const hours = valid(last) ? (slots[last] - slots[start]) / HOUR : 0;
  const coverage = { naturalHours, validHours: validSec / HOUR, gapHours: Math.max(0, naturalHours - validSec / HOUR),
    from: slots[start], to: slots[last], hours };
  if (hours < MIN_REPLAY_HOURS) return { ...coverage, status: 'insufficient_history', net: null, emission: null, impermanent: null, cost: null,
    rebalances: 0, intraHour: 0, inRange: 0, missingHours: 0, apr: null };
  const full = cells === 0;
  // 格数超过可用范围时按全范围的边界截断。
  const [minTick, maxTick] = fullRange(tickSpacing);
  const rangeAt = (tick) => { if (full) return [minTick, maxTick]; const [a, b] = centeredRange(tick, tickSpacing, cells); return [Math.max(a, minTick), Math.min(b, maxTick)]; };
  let [lower, upper] = rangeAt(ticks[start]);
  let price = usdPerToken1(start);
  let l = deposit / price / valueOf(1, lower, upper, ticks[start]);
  if (!(l > 0) || !Number.isFinite(l)) return null;
  const [hold0, hold1] = amountsOf(l, lower, upper, ticks[start]);
  let earned = 0, costUsd = 0, rebalances = 0, intraHour = 0, liveSec = 0, totalSec = 0, missingSec = 0, downLeft = 0;
  let endIndex = start, status = 'complete';
  for (let i = start + 1; i < slots.length; i++) {
    const dt = slots[i] - slots[i - 1], from = ticks[i - 1], to = ticks[i];
    totalSec += dt;
    endIndex = i;
    price = usdPerToken1(i);
    const out = to < lower || to >= upper;
    let cross = 0;
    if (!out && !full) {
      const sigma = Math.max(known(vol[i - 1]) ? vol[i - 1] : 0, VOL_FLOOR), variance = sigma * sigma * (dt / DAY);
      const d0 = (from - lower) * LOG_TICK, d1 = (to - lower) * LOG_TICK, u0 = (upper - from) * LOG_TICK, u1 = (upper - to) * LOG_TICK;
      cross = Math.min(1, Math.exp((-2 * d0 * d1) / variance) + Math.exp((-2 * u0 * u1) / variance));
    }
    const span = out ? dt / 2 : dt, live = Math.max(span - downLeft, 0);
    downLeft = Math.max(downLeft - span, 0);
    const lost = cross * Math.min(delaySec, dt), rate = emission[i - 1], others = known(staked[i - 1]) ? Math.max(staked[i - 1], 0) : 0;
    liveSec += Math.max(live - lost, 0);
    if (!known(rate)) missingSec += dt;
    else earned += rate * (l / (others + l)) * Math.max(live - lost, 0);
    if (cross > 0) {
      const value = valueOf(l, lower, upper, to);
      const paidFraction = Math.min(cross * costFraction, 1);
      costUsd += paidFraction * value * price;
      l *= 1 - paidFraction;
      intraHour += cross;
      if (paidFraction === 1) { status = 'cost_exhausted'; break; }
    }
    if (out) {
      const value = valueOf(l, lower, upper, to);
      const paidFraction = Math.min(costFraction, 1);
      costUsd += value * paidFraction * price;
      [lower, upper] = rangeAt(to);
      l = (value * (1 - paidFraction)) / valueOf(1, lower, upper, to);
      rebalances++;
      if (paidFraction === 1) { status = 'cost_exhausted'; break; }
      downLeft = delaySec;
    }
  }
  if (!(totalSec > 0) || !Number.isFinite(l)) return null;
  const end = ticks[endIndex];
  const behind = (valueOf(l, lower, upper, end) - (hold0 * priceOf(end) + hold1)) * price;
  const net = behind + earned;
  if (!Number.isFinite(net)) return null;
  return {
    ...coverage, status, hours: totalSec / HOUR, to: slots[endIndex], net, emission: earned, impermanent: -behind - costUsd, cost: costUsd,
    rebalances, intraHour, inRange: liveSec / totalSec, missingHours: missingSec / 3600,
    apr: status === 'complete' ? (net / deposit) * ((365 * DAY) / totalSec) : null,
  };
}
