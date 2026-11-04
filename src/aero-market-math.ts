// Aero 市场页面按区间宽度与投入金额估算的指标；输入为扫描端给出的链上原始整数（字符串）与美元价。
// 只用于看盘比较，不参与签名或下单。
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
export function expectedDaysInRange(tick: number, lower: number, upper: number, dailyVol: number | null | undefined): number | null {
  if (!dailyVol || !(dailyVol > 0) || !(upper > lower) || tick < lower || tick >= upper) return null;
  const x = (tick - lower) * LOG_TICK, A = (upper - lower) * LOG_TICK;
  return finite((x * (A - x)) / (dailyVol * dailyVol));
}
