// Aero 市场页面按区间宽度与投入金额估算的指标；输入为扫描端给出的链上原始整数（字符串）与美元价。
// 只用于看盘比较，不参与签名或下单。
import type { MarketPool } from './aero-market-types';
const Q96 = 2 ** 96;
const LOG_TICK = Math.log(1.0001);
const SECONDS_PER_YEAR = 365 * 86400;
type TokenMeta = { decimals: number };
type TokenPrice = { usd: number } | null;
const finite = (value: number) => (Number.isFinite(value) ? value : null);

// 以当前 tick 为中心、价格 ±width 对齐到 tickSpacing 的区间；width 为 0 时取当前所在的单个 tickSpacing（最窄）。
export function rangeTicks(tick: number, tickSpacing: number, width: number): [number, number] {
  if (!(width > 0)) { const lower = Math.floor(tick / tickSpacing) * tickSpacing; return [lower, lower + tickSpacing]; }
  let lower = Math.floor((tick + Math.log(1 - Math.min(width, 0.99)) / LOG_TICK) / tickSpacing) * tickSpacing;
  let upper = Math.ceil((tick + Math.log(1 + width) / LOG_TICK) / tickSpacing) * tickSpacing;
  if (upper <= tick) upper = (Math.floor(tick / tickSpacing) + 1) * tickSpacing;
  if (lower > tick) lower = Math.floor(tick / tickSpacing) * tickSpacing;
  return [lower, upper];
}

// 一单位原始流动性在 [tickLower, tickUpper] 内按当前价折合的美元价值。
export function liquidityUnitUsd(sqrtPriceX96: string, tickLower: number, tickUpper: number, t0: TokenMeta, t1: TokenMeta, p0: TokenPrice, p1: TokenPrice): number | null {
  const s = Number(sqrtPriceX96) / Q96, sa = Math.sqrt(1.0001 ** tickLower), sb = Math.sqrt(1.0001 ** tickUpper);
  if (!(s > 0) || !p0 || !p1) return null;
  const a0 = s <= sa ? 1 / sa - 1 / sb : s >= sb ? 0 : 1 / s - 1 / sb;
  const a1 = s <= sa ? 0 : s >= sb ? sb - sa : s - sa;
  const value = (a0 / 10 ** t0.decimals) * p0.usd + (a1 / 10 ** t1.decimals) * p1.usd;
  return value > 0 ? value : null;
}

// 按投入 deposit 美元、区间内全程有效计算年化：总收益速率按「你的流动性 /（现有同类流动性 + 你的）」分配。
export function dilutedApr({ usdPerSecond, competingLiquidity, unitUsd, deposit }: { usdPerSecond: number; competingLiquidity: string | number | null; unitUsd: number | null; deposit: number }): number | null {
  if (!(usdPerSecond >= 0) || !unitUsd || !(unitUsd > 0) || !(deposit > 0)) return null;
  const mine = deposit / unitUsd, others = Math.max(Number(competingLiquidity) || 0, 0);
  return finite((usdPerSecond * SECONDS_PER_YEAR * (mine / (others + mine))) / deposit);
}

// 无漂移布朗运动在 [lower, upper] 内从当前 tick 出发的期望首次离开时间：x(A−x)/σ²（对数价格单位，σ 为日波动）。
// 日波动为 0（如稳定币对在样本期内没动）时视为一直在区间内。
export function expectedDaysInRange(tick: number, lower: number, upper: number, dailyVol: number | null | undefined): number | null {
  if (dailyVol === null || dailyVol === undefined || !(dailyVol >= 0) || !(upper > lower) || tick < lower || tick >= upper) return null;
  if (dailyVol === 0) return Infinity;
  const x = (tick - lower) * LOG_TICK, A = (upper - lower) * LOG_TICK;
  return finite((x * (A - x)) / (dailyVol * dailyVol));
}

// 质押仓位的净年化 = 排放年化 − 无常损失年化 − 调仓成本年化（手续费归投票者，不计入）。
// 无常损失：区间内仓位价值 V = L·√P·w，w = 2 − e^(−d₁/2) − e^(−d₂/2)（d₁、d₂ 为当前价到下沿、上沿的对数距离，窄区间时 w ≈ 半宽 h），
// Γ = −L/(2P^1.5)，套利损耗速率 σ²P²|Γ|/2 ÷ V = σ²/(4w)，窄区间即全区间 v2 的 σ²/8 乘以集中倍数 2/h；按日波动 σ 折成年化 365·σ²/(4w)。
// 调仓：出区间后重新居中，每次约把半个仓位换成另一种币（0.5×池子费率）加上 gas；
// 次数按期望在区间天数 x(A−x)/σ² 计，年化 = 365 / 天数 × 单次成本占投入比例。
export type NetYield = { net: number; emission: number; impermanent: number; rebalance: number; days: number };
export function netYield({ apr, tick, lower, upper, dailyVol, costFraction }: { apr: number | null; tick: number; lower: number; upper: number; dailyVol: number | null | undefined; costFraction: number }): NetYield | null {
  if (apr === null || !Number.isFinite(apr) || !(costFraction >= 0)) return null;
  const days = expectedDaysInRange(tick, lower, upper, dailyVol);
  if (days === null || dailyVol === null || dailyVol === undefined) return null;
  const w = 2 - Math.exp(-((tick - lower) * LOG_TICK) / 2) - Math.exp(-((upper - tick) * LOG_TICK) / 2);
  if (!(w > 0)) return null;
  const impermanent = (365 * dailyVol * dailyVol) / (4 * w);
  const rebalance = days === Infinity ? 0 : (365 / days) * costFraction;
  return { net: apr - impermanent - rebalance, emission: apr, impermanent, rebalance, days };
}

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
// 全范围：对齐到 tickSpacing 的最小、最大可用 tick。
export const fullRange = (tickSpacing: number): [number, number] => [Math.ceil(MIN_TICK / tickSpacing) * tickSpacing, Math.floor(MAX_TICK / tickSpacing) * tickSpacing];

// 日波动下限：样本期内不动的池子按此估算损耗、调仓与收益波动比，避免零损耗与比值无限大。
export const VOL_FLOOR = 0.001;
// 一次调仓（撤出、换币、重新添加并质押）的 gas 估算，美元。
const REBALANCE_GAS_USD: Record<string, number> = { ethereum: 10 };
const DEFAULT_REBALANCE_GAS_USD = 0.2;
export const rebalanceGasUsd = (chain: string) => REBALANCE_GAS_USD[chain] ?? DEFAULT_REBALANCE_GAS_USD;

// 净年化、在区间天数与收益波动比统一用 24h 与 7d 中较大的日波动，偏保守，并设下限：稳定币对短期一个 tick 都没动时
// 波动记为 0，不加下限会让最窄档零损耗、零调仓而排到最前。
export function riskVolOf(pool: Pick<MarketPool, 'vol24h' | 'vol7d'>): number | null {
  const vols = [pool.vol24h?.daily, pool.vol7d?.daily].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return vols.length ? Math.max(...vols, VOL_FLOOR) : null;
}

// 调仓成本占投入比例 = 半仓换币手续费 + gas / 投入。
export const rebalanceCost = (pool: Pick<MarketPool, 'fee' | 'chain'>, deposit: number) =>
  (pool.fee === null ? 0 : (0.5 * pool.fee) / 1e6) + (deposit > 0 ? rebalanceGasUsd(pool.chain) / deposit : 0);

const pricesOf = (pool: MarketPool) => [pool.token0.usd === null ? null : { usd: pool.token0.usd }, pool.token1.usd === null ? null : { usd: pool.token1.usd }] as const;

// 区间 [lower, upper] 的排放年化：按当前价位的质押流动性稀释；没有 gauge、排放或 AERO 价时为空。
// 当前价不在区间内时仓位不产生排放，同样为空，由调用方说明。
export function rangeApr(pool: MarketPool, aeroUsd: number | null, range: [number, number], deposit: number): number | null {
  if (!pool.gauge || pool.emissionPerSec === null || aeroUsd === null) return null;
  const [p0, p1] = pricesOf(pool);
  return dilutedApr({ usdPerSecond: pool.emissionPerSec * aeroUsd, competingLiquidity: pool.stakedLiquidity, unitUsd: liquidityUnitUsd(pool.sqrtPriceX96, range[0], range[1], pool.token0, pool.token1, p0, p1), deposit });
}

// 按当前价在区间内投入 deposit 美元时两种代币各需多少（按人类单位）及其美元价值。
export function rangeAmounts(pool: MarketPool, range: [number, number], deposit: number): { amount0: number; amount1: number; usd0: number; usd1: number } | null {
  const [p0, p1] = pricesOf(pool);
  const unit = liquidityUnitUsd(pool.sqrtPriceX96, range[0], range[1], pool.token0, pool.token1, p0, p1);
  if (!unit || !p0 || !p1 || !(deposit > 0)) return null;
  const s = Number(pool.sqrtPriceX96) / Q96, sa = Math.sqrt(1.0001 ** range[0]), sb = Math.sqrt(1.0001 ** range[1]);
  const a0 = s <= sa ? 1 / sa - 1 / sb : s >= sb ? 0 : 1 / s - 1 / sb;
  const a1 = s <= sa ? 0 : s >= sb ? sb - sa : s - sa;
  const l = deposit / unit, amount0 = (a0 * l) / 10 ** pool.token0.decimals, amount1 = (a1 * l) / 10 ** pool.token1.decimals;
  return { amount0, amount1, usd0: amount0 * p0.usd, usd1: amount1 * p1.usd };
}

// 默认以美元价较高的代币为基准报价，例如 WETH/USDC 显示每 WETH 多少 USDC；flip 时反过来。
// rising 表示报价随 tick 增大而升高；tickOf 为 price 的反函数（不取整）。
export function quoteOf(pool: Pick<MarketPool, 'token0' | 'token1'>, flip = false) {
  const invert = ((pool.token1.usd ?? 0) > (pool.token0.usd ?? 0)) !== flip;
  const scale = 10 ** (pool.token0.decimals - pool.token1.decimals);
  const price = (tick: number) => { const raw = 1.0001 ** tick * scale; return invert ? 1 / raw : raw; };
  const tickOf = (value: number) => Math.log((invert ? 1 / value : value) / scale) / LOG_TICK;
  const base = invert ? pool.token1.symbol : pool.token0.symbol, quote = invert ? pool.token0.symbol : pool.token1.symbol;
  return { price, tickOf, rising: !invert, label: `每 ${base} 折合 ${quote}`, pair: `${base} / ${quote}`, base, quote };
}
export const priceText = (v: number) => (!Number.isFinite(v) ? '—' : v >= 1e12 ? v.toExponential(3) : v >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : v >= 1 ? v.toPrecision(6) : v >= 1e-12 ? v.toPrecision(5) : v.toExponential(3));
