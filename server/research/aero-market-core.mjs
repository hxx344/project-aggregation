// Aero 市场扫描端的纯计算：价格图定价、TVL、排放速率、波动率与价格变化。
// 区间年化与在区间时间按页面输入计算，见 src/aero-market-math.ts。
// 输入都是链上原始整数（字符串），这里只做浮点换算；所有结果用于看盘判断，不参与签名或下单。
const Q96 = 2 ** 96;
const LOG_TICK = Math.log(1.0001);

const num = (value) => (value === null || value === undefined ? NaN : Number(value));

// token1/token0 的人类单位价格。
export function poolPrice(sqrtPriceX96, decimals0, decimals1) {
  const s = num(sqrtPriceX96) / Q96;
  return s * s * 10 ** (decimals0 - decimals1);
}

// 当前价附近 ±band 价格变动所需的一侧代币数量（人类单位）：衡量池子的有效深度，
// 比池子余额更难被区间外的流动性伪造。
export function depthAround(liquidity, sqrtPriceX96, band = 0.02) {
  const L = num(liquidity), s = num(sqrtPriceX96) / Q96;
  if (!(L > 0 && s > 0)) return { amount0: 0, amount1: 0 };
  const down = s * Math.sqrt(1 - band), up = s * Math.sqrt(1 + band);
  return { amount0: L * (1 / s - 1 / up), amount1: L * (s - down) };
}

// 从稳定币出发逐轮定价：每轮每个未定价代币取「已定价一侧 ±2% 深度」最大的池子报价，
// 深度低于 minDepthUsd 的池子不用于定价。轮次越早路径越短，先定的价格不再被覆盖。
export function solvePrices({ pools, tokens, stables, minDepthUsd = 2000, rounds = 6 }) {
  const prices = new Map(stables.map((address) => [address.toLowerCase(), { usd: 1, via: null }]));
  for (let round = 0; round < rounds; round++) {
    const best = new Map();
    for (const pool of pools) {
      const t0 = tokens.get(pool.token0), t1 = tokens.get(pool.token1), state = pool.state;
      if (!t0 || !t1 || !state || !(num(state.liquidity) > 0)) continue;
      const p0 = prices.get(pool.token0), p1 = prices.get(pool.token1);
      if (Boolean(p0) === Boolean(p1)) continue;
      const price = poolPrice(state.sqrtPriceX96, t0.decimals, t1.decimals);
      if (!(price > 0 && Number.isFinite(price))) continue;
      const depth = depthAround(state.liquidity, state.sqrtPriceX96);
      const candidate = p0
        ? { token: pool.token1, usd: p0.usd / price, weight: (depth.amount0 / 10 ** t0.decimals) * p0.usd }
        : { token: pool.token0, usd: p1.usd * price, weight: (depth.amount1 / 10 ** t1.decimals) * p1.usd };
      if (!(candidate.weight >= minDepthUsd) || !Number.isFinite(candidate.usd)) continue;
      const prior = best.get(candidate.token);
      if (!prior || candidate.weight > prior.weight) best.set(candidate.token, { ...candidate, via: pool.address });
    }
    if (!best.size) break;
    for (const [token, c] of best) prices.set(token, { usd: c.usd, via: c.via });
  }
  return prices;
}

export function tvlUsd(state, t0, t1, p0, p1) {
  if (!state || !t0 || !t1) return null;
  const b0 = num(state.balance0) / 10 ** t0.decimals, b1 = num(state.balance1) / 10 ** t1.decimals;
  if (!Number.isFinite(b0) || !Number.isFinite(b1)) return null;
  if ((b0 > 0 && !p0) || (b1 > 0 && !p1)) return null;
  return b0 * (p0?.usd ?? 0) + b1 * (p1?.usd ?? 0);
}

const big = (value) => { try { return value === null || value === undefined ? null : BigInt(value); } catch { return null; } };

// 两点之间的排放速率（AERO/秒）。累计份额单调递增；倒退视为数据异常。
export function emissionRate(from, to) {
  const a = big(from?.rewardShare), b = big(to?.rewardShare), dt = (to?.t ?? 0) - (from?.t ?? 0);
  if (a === null || b === null || !(dt > 0) || b < a) return null;
  return Number(b - a) / 1e18 / dt;
}

// 小时级已实现波动率（对数收益，按实际间隔归一到 1 小时；间隔超过 3 小时的样本对不计入）。
export function realizedVol(points, windowSec, nowSec) {
  const rows = points.filter((p) => p.t >= nowSec - windowSec - 1800 && Number.isFinite(p.tick)).sort((a, b) => a.t - b.t);
  let sum = 0, n = 0;
  for (let i = 1; i < rows.length; i++) {
    const hours = (rows[i].t - rows[i - 1].t) / 3600;
    if (!(hours > 0.25) || hours > 3) continue;
    const r = ((rows[i].tick - rows[i - 1].tick) * LOG_TICK) / Math.sqrt(hours);
    sum += r * r; n++;
  }
  const need = Math.max(6, Math.floor((windowSec / 3600) * 0.6));
  if (n < need) return null;
  const hourly = Math.sqrt(sum / n);
  return { daily: hourly * Math.sqrt(24), annual: hourly * Math.sqrt(24 * 365), samples: n };
}

export function priceChange(fromTick, toTick) {
  return Number.isFinite(fromTick) && Number.isFinite(toTick) ? Math.exp((toTick - fromTick) * LOG_TICK) - 1 : null;
}
