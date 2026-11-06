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
// 调仓（假设自动调仓）：出区间后撤出、把半个仓位换成另一种币、重新居中添加并质押，单次成本见 rebalanceCostOf。
// 一个周期 = 期望在区间天数 T = x(A−x)/σ² + 停摆 delayDays（出区间到新仓位质押生效，期间没有排放也没有无常损失），
// 排放与无常损失只在 T/(T+停摆) 的时间里发生，差额记为停摆损失；调仓年化 = 365/(T+停摆) × 单次成本占投入比例。
export type NetYield = { net: number; emission: number; impermanent: number; downtime: number; rebalance: number; days: number };
export function netYield({ apr, tick, lower, upper, dailyVol, costFraction, delayDays = 0 }: { apr: number | null; tick: number; lower: number; upper: number; dailyVol: number | null | undefined; costFraction: number; delayDays?: number }): NetYield | null {
  if (apr === null || !Number.isFinite(apr) || !(costFraction >= 0) || !(delayDays >= 0)) return null;
  const days = expectedDaysInRange(tick, lower, upper, dailyVol);
  if (days === null || dailyVol === null || dailyVol === undefined) return null;
  const w = 2 - Math.exp(-((tick - lower) * LOG_TICK) / 2) - Math.exp(-((upper - tick) * LOG_TICK) / 2);
  if (!(w > 0)) return null;
  const impermanent = (365 * dailyVol * dailyVol) / (4 * w);
  const cycle = days + delayDays;
  const downtime = days === Infinity || !(cycle > 0) ? 0 : (apr - impermanent) * (delayDays / cycle);
  const rebalance = days === Infinity ? 0 : cycle > 0 ? (365 / cycle) * costFraction : Infinity;
  return { net: apr - impermanent - downtime - rebalance, emission: apr, impermanent, downtime, rebalance, days };
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

// 池子当前价位的深度 D（美元）：在恒定流动性 L 下把 √P 推高 r 倍需要 (r−1)·D 的 token1，D = L·√P 折成美元
// （token1 没有美元价时用 token0 一侧 L/√P 折算）。当前价位没有流动性（落在空档）时深度未知，返回空。
export function swapDepthUsd(pool: Pick<MarketPool, 'liquidity' | 'sqrtPriceX96' | 'token0' | 'token1'>): number | null {
  const l = Number(pool.liquidity), s = Number(pool.sqrtPriceX96) / Q96;
  if (!(l > 0) || !(s > 0)) return null;
  if (pool.token1.usd !== null) return finite(((l * s) / 10 ** pool.token1.decimals) * pool.token1.usd);
  if (pool.token0.usd !== null) return finite(((l / s) / 10 ** pool.token0.decimals) * pool.token0.usd);
  return null;
}
// 单次调仓成本占投入比例：gas / 投入 + 换币金额（半个仓位，居中区间按价值正好一半是另一种币）×（池子费率 + 价格冲击）。
// 价格冲击按在本池成交、当前价位流动性 L 近似：恒定 L 下换入 X 美元后 √P 变为 (1 + X/D) 倍，成交均价相对中间价差 X/(D+X)。
// 跨 tick 后流动性的变化未计入（集中流动性通常越远越薄，会低估），也未走聚合器拆单（会高估），方向不定。深度未知时不计冲击。
export type RebalanceCost = { gas: number; fee: number; slippage: number; total: number; swapUsd: number; gasUsd: number; depthKnown: boolean };
export function rebalanceCostOf(pool: Pick<MarketPool, 'fee' | 'chain' | 'liquidity' | 'sqrtPriceX96' | 'token0' | 'token1'>, deposit: number): RebalanceCost {
  const gasUsd = rebalanceGasUsd(pool.chain), swapUsd = deposit > 0 ? deposit / 2 : 0, depth = swapDepthUsd(pool);
  const gas = deposit > 0 ? gasUsd / deposit : 0;
  const fee = pool.fee === null ? 0 : (0.5 * pool.fee) / 1e6;
  const slippage = depth === null || !(swapUsd > 0) ? 0 : 0.5 * (swapUsd / (depth + swapUsd));
  return { gas, fee, slippage, total: gas + fee + slippage, swapUsd, gasUsd, depthKnown: depth !== null };
}
export const rebalanceCost = (pool: Parameters<typeof rebalanceCostOf>[0], deposit: number) => rebalanceCostOf(pool, deposit).total;
// 自动调仓的假设：出区间到新仓位质押生效的停摆天数（界面上限 1 天：停摆比在区间还长时模型会偏向几乎一直空仓的窄区间）；推荐区间只在预计至少待 minDays 天的区间中选
// （σ 由小时样本估计，更短的尺度上首次离开时间不可靠）。
export type RebalancePlan = { delayDays: number; minDays: number };
export const DEFAULT_PLAN: RebalancePlan = { delayDays: 5 / 1440, minDays: 1 / 24 };

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

// 推荐区间：在 tickSpacing 粒度上搜索以当前价居中的区间中净年化最高者，只在预计至少能在区间内待 plan.minDays 天的区间中选；
// 调仓成本（gas、手续费、价格冲击）与停摆已计入净年化，越窄调仓越频繁，最优宽度由成本自然决定。每个宽度只取最居中的摆放：模型假设价格无漂移，把当前价放到
// 靠近一侧边沿能用同样的钱换到更多流动性，按公式净年化可再高几个百分点，但那是押注价格不往近的一侧走，且离开区间后
// 重新调仓也是居中摆放，所以不采用。宽度先逐格试到 64 格，再按 1% 的几何步长试到当前价 ÷4 至 ×4，另外试全范围
// （排放抵不过无常损失时越宽越好）；最后在最优宽度附近逐格细搜。
export type RangeChoice = { range: [number, number]; result: NetYield };
const SEARCH_EXACT_CELLS = 64;
const SEARCH_STEP = 1.01;
const SEARCH_SPAN_TICKS = 13_864;
export function bestRange(pool: MarketPool, aeroUsd: number | null, deposit: number, plan: RebalancePlan = DEFAULT_PLAN): RangeChoice | null {
  const vol = riskVolOf(pool);
  if (vol === null || !pool.gauge || pool.emissionPerSec === null || aeroUsd === null || !(deposit > 0)) return null;
  const s = pool.tickSpacing, tick = pool.tick, full = fullRange(s);
  const costFraction = rebalanceCost(pool, deposit);
  const maxCells = Math.max(1, Math.ceil((2 * SEARCH_SPAN_TICKS) / s));
  let best: RangeChoice | null = null, bestCells = 0;
  const tryRange = (lower: number, upper: number) => {
    if (lower < full[0] || upper > full[1] || tick < lower || tick >= upper) return false;
    const result = netYield({ apr: rangeApr(pool, aeroUsd, [lower, upper], deposit), tick, lower, upper, dailyVol: vol, costFraction, delayDays: plan.delayDays });
    if (!result || result.days < plan.minDays || (best && result.net <= best.result.net)) return false;
    best = { range: [lower, upper], result }; return true;
  };
  const tryCells = (cells: number) => {
    const [lower, upper] = centeredRange(tick, s, cells);
    if (tryRange(lower, upper)) bestCells = cells;
  };
  for (let cells = 1; cells <= maxCells; cells = cells < SEARCH_EXACT_CELLS ? cells + 1 : Math.ceil(cells * SEARCH_STEP)) tryCells(cells);
  if (bestCells > SEARCH_EXACT_CELLS) {
    const around = bestCells;
    for (let cells = Math.floor(around / SEARCH_STEP); cells <= Math.ceil(around * SEARCH_STEP); cells++) tryCells(cells);
  }
  tryRange(full[0], full[1]);
  return best;
}

// cells 格宽、对齐 tickSpacing 的区间：当前 tick 所在格之下包含 below 格，使当前价两侧的 tick 距离最接近。
export function centeredRange(tick: number, tickSpacing: number, cells: number): [number, number] {
  const s = tickSpacing, cell = Math.floor(tick / s);
  const below = Math.min(Math.max(Math.round((cell * s - tick + (cells * s) / 2) / s), 0), cells - 1);
  return [(cell - below) * s, (cell - below + cells) * s];
}

// 区间上下沿相对当前价的涨跌幅（按页面报价方向，flip 与 quoteOf 相同），近似对称时显示 ±x%。
export function rangeLabel(pool: MarketPool, range: [number, number], flip = false): string {
  const q = quoteOf(pool, flip), now = q.price(pool.tick);
  const [a, b] = [q.price(range[0]) / now - 1, q.price(range[1]) / now - 1].sort((x, y) => x - y);
  const abs = (v: number) => { const x = Math.abs(v) * 100; return x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2); };
  const fmt = (v: number) => `${v < 0 ? '−' : '+'}${abs(v)}`;
  if (range[0] <= fullRange(pool.tickSpacing)[0] && range[1] >= fullRange(pool.tickSpacing)[1]) return '全范围';
  return a < 0 && b > 0 && Math.abs(a + b) <= 0.1 * (b - a) ? `±${abs((b - a) / 2)}%` : `${fmt(a)}%/${fmt(b)}%`;
}

// Safe 已有头寸的价格区间、价值、预计收益与在区间时间（Aero 仓位标签）：用行情快照的排放、质押流动性、波动率与美元价估算，
// 现价由调用方用 Safe 链上读到的 tick 覆盖（比行情快照新）。只用于展示，不参与签名或下单。
// 质押时长按质押区块与当前区块的链上时间戳相减：Base 出块间隔会随网络升级变化，不能用块数乘固定秒数。
export type PositionInput = { tickLower: number; tickUpper: number; liquidity: string; staked: boolean; amount0: number | null; amount1: number | null; depositTime?: number | null };
export type PositionMetrics = {
  pair: string; quoteLabel: string;
  low: number; high: number; now: number;
  // 现价到区间下沿、上沿的涨跌幅（按报价方向）；出区间时一侧为同号。
  toLow: number; toHigh: number;
  width: string; inRange: boolean;
  valueUsd: number | null;
  // 占当前价位质押流动性的份额；未质押时为质押后的预计份额（加上自身后稀释）。
  share: number | null; projected: boolean;
  aeroPerDay: number | null; usdPerDay: number | null; apr: number | null;
  daysIn: number | null; vol: number | null;
  yield: NetYield | null;
  stakedSeconds: number | null;
};

// live 为用 Safe 链上现价覆盖 tick/sqrtPriceX96 后的行情池子。
// chainTime 为 Safe 链上快照的区块时间（秒），snapshotAt 为行情快照的扫描时间（毫秒），用来判断质押流动性里是否已含本头寸。
export type PositionContext = { aeroUsd: number | null; chainTime: number | null; snapshotAt: number | null };
export function positionMetrics(live: MarketPool, position: PositionInput, { aeroUsd, chainTime, snapshotAt }: PositionContext, plan: RebalancePlan = DEFAULT_PLAN): PositionMetrics {
  const q = quoteOf(live);
  const edges = [q.price(position.tickLower), q.price(position.tickUpper)].sort((a, b) => a - b);
  const now = q.price(live.tick);
  const inRange = live.tick >= position.tickLower && live.tick < position.tickUpper;
  const p0 = live.token0.usd, p1 = live.token1.usd;
  const valueUsd = position.amount0 === null || position.amount1 === null || p0 === null || p1 === null ? null
    : (position.amount0 / 10 ** live.token0.decimals) * p0 + (position.amount1 / 10 ** live.token1.decimals) * p1;
  const mine = Number(position.liquidity) || 0, staked = Math.max(Number(live.stakedLiquidity) || 0, 0);
  const depositTime = position.staked && typeof position.depositTime === 'number' ? position.depositTime : null;
  const stakedSeconds = depositTime !== null && chainTime !== null ? Math.max(chainTime - depositTime, 0) : null;
  // 行情快照晚于本次质押时，质押流动性已含本头寸：份额 = mine / staked（按 mine 封顶，不超过 1）；
  // 快照早于质押、或时间无法判断时按未计入处理：mine / (staked + mine)，偏保守。未质押头寸按质押后加入计算。
  const stakedAt = depositTime !== null ? depositTime * 1000 : null;
  const included = position.staked && snapshotAt !== null && stakedAt !== null && snapshotAt >= stakedAt;
  const share = !live.gauge || !(mine > 0) ? null : included ? mine / Math.max(staked, mine) : mine / (staked + mine);
  const emitting = inRange && share !== null && live.emissionPerSec !== null;
  const aeroPerDay = !inRange ? 0 : emitting ? live.emissionPerSec! * 86_400 * share! : null;
  const usdPerDay = aeroPerDay === null || aeroUsd === null ? null : aeroPerDay * aeroUsd;
  const apr = usdPerDay === null || valueUsd === null || !(valueUsd > 0) ? null : (usdPerDay * 365) / valueUsd;
  const vol = riskVolOf(live);
  const daysIn = expectedDaysInRange(live.tick, position.tickLower, position.tickUpper, vol);
  const yieldOf = inRange && apr !== null && valueUsd !== null
    ? netYield({ apr, tick: live.tick, lower: position.tickLower, upper: position.tickUpper, dailyVol: vol, costFraction: rebalanceCostOf(live, valueUsd).total, delayDays: plan.delayDays })
    : null;
  return {
    pair: q.pair, quoteLabel: q.label, low: edges[0], high: edges[1], now,
    toLow: edges[0] / now - 1, toHigh: edges[1] / now - 1,
    width: rangeLabel(live, [position.tickLower, position.tickUpper]), inRange,
    valueUsd, share, projected: !position.staked, aeroPerDay, usdPerDay, apr, daysIn, vol, yield: yieldOf, stakedSeconds,
  };
}
