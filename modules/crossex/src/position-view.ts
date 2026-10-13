import Decimal from 'decimal.js';
import type { LivePosition, PositionFundingRate } from './live-types';
import type { FundingLeg, FundingOpportunity } from './funding-opportunities';
import { exact, formatDecimal, netBaseQuantity } from './live-display';
const D = Decimal.clone({ precision: 100 });

export function fractionQuantity(quantity: string | null, percent: number, step?: string | null): string | null {
  if (exact(quantity) === '—' || !quantity || !Number.isInteger(percent) || percent <= 0 || percent > 100) return null;
  const amount = new D(quantity).abs();
  if (percent === 100) return amount.gt(0) ? amount.toFixed() : null;
  if (exact(step) === '—' || !step || new D(step).lte(0)) return null;
  const rounded = amount.mul(percent).div(100).div(step).floor().mul(step);
  return rounded.gt(0) ? rounded.toFixed() : null;
}

export type CurrencyAmount = { currency: string; value: string | null };
export function sumNative(legs: LivePosition[], value: (p: LivePosition) => string | null | undefined, currency: (p: LivePosition) => string): CurrencyAmount[] {
  const sums = new Map<string, { total: Decimal; complete: boolean }>();
  for (const leg of legs) {
    const coin = currency(leg) || '币种未知', amount = value(leg), previous = sums.get(coin) || { total: new D(0), complete: true };
    if (exact(amount) === '—') previous.complete = false;
    else previous.total = previous.total.add(amount!);
    sums.set(coin, previous);
  }
  return Array.from(sums, ([currency, amount]) => ({ currency, value: amount.complete ? amount.total.toFixed() : null }));
}

export function weightedPrice(legs: LivePosition[], field: 'entryPrice' | 'markPrice'): CurrencyAmount | null {
  const coins = new Set(legs.map(p => p.quoteCurrency));
  if (coins.size !== 1 || !legs.length || !legs[0].quoteCurrency) return null;
  let total = new D(0), size = new D(0);
  for (const p of legs) {
    if (exact(p[field]) === '—' || exact(p.baseQuantity) === '—') return null;
    const quantity = new D(p.baseQuantity!).abs(); total = total.add(quantity.mul(p[field]!)); size = size.add(quantity);
  }
  return size.gt(0) ? { currency: legs[0].quoteCurrency, value: total.div(size).toSignificantDigits(18).toFixed() } : null;
}

export type PositionMetrics = {
  applicable: boolean; currency: string | null;
  /** Earliest leg opening, only when every leg has a valid opening time. */
  openedAt: number | null; holdingMs: number | null;
  /** Ratios, not percentages or basis points. Amounts stay in currency. */
  entrySpread: string | null; currentSpread: string | null; spreadNarrowingRatio: string | null;
  spreadReturn: string | null; spreadReturnRatio: string | null;
  margin: string | null; fundingFee: string | null; totalReturn: string | null;
  roi: string | null; annualizedReturn: string | null;
  fundingRate8h: string | null; expectedFundingAnnualized: string | null; realizedFundingAnnualized: string | null;
  nextFundingAt: number | null; fundingAsOf: number | null;
  healthScore: number | null; health: 'good' | 'watch' | 'risk' | 'unknown';
  healthDeductions: { code: 'spread_narrowing' | 'holding_age' | 'funding_reversal'; points: number; reason: string }[];
  healthMissing: string[]; reasons: string[];
};
export type PositionGroup = {
  base: string; legs: LivePosition[]; net: string | null;
  entry: CurrencyAmount | null; mark: CurrencyAmount | null;
  notional: CurrencyAmount[]; pnl: CurrencyAmount[]; realized: CurrencyAmount[]; funding: CurrencyAmount[];
  metrics: PositionMetrics;
};
export type PositionMetricsOptions = {
  now?: number; fundingOpportunities?: FundingOpportunity[]; positionFundingRates?: PositionFundingRate[];
  marketStale?: boolean; stale?: boolean; partial?: boolean;
};

const DAY_MS = 86400000, FUNDING_TTL_MS = 300000;
const timestamp = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
// The client clock adds a performance.now() delta to the server epoch, so it can
// contain fractions of a millisecond even though source timestamps are integers.
const validClock = (value: number) => Number.isFinite(value) && value > 0;
function decimal(value: string | number | null | undefined): Decimal | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null;
  try { const amount = new D(value); return amount.isFinite() ? amount : null; } catch { return null; }
}

function pairProblem(legs: LivePosition[]): string | null {
  if (legs.length !== 2) return legs.length < 2 ? '单腿持仓，无法计算双腿组合指标' : '超过两条持仓腿，无法确定唯一配对';
  if (!legs.some(p => p.side.toUpperCase() === 'LONG') || !legs.some(p => p.side.toUpperCase() === 'SHORT')) return '组合需要恰好一条多仓和一条空仓';
  if (!legs[0].exchange || !legs[1].exchange || legs[0].exchange === legs[1].exchange) return '组合需要来自不同交易所';
  const currency = legs[0].quoteCurrency;
  if (!currency || legs.some(p => p.quoteCurrency !== currency)) return '双腿计价币种不同或缺失，无法合并收益';
  // The live projection exposes settlement as pnlCurrency. Do not apply linear
  // price × base quantity arithmetic to coin-settled or unrelated instruments.
  if (!['USDT', 'USDC', 'USD'].includes(currency) || legs.some(p => !/^[A-Z]+_(FUTURE|PERP)_[A-Z0-9.-]+_[A-Z0-9.-]+$/.test(p.symbol)
    || !p.symbol.endsWith('_' + currency) || p.pnlCurrency !== currency)) return '缺少同币种线性合约依据，无法计算组合收益';
  const quantities = legs.map(p => decimal(p.baseQuantity)?.abs());
  if (quantities.some(q => !q?.gt(0))) return '持仓基础币数量缺失或无效';
  if (!quantities[0]!.eq(quantities[1]!)) return '双腿基础币数量不等，无法按对冲组合计算';
  return null;
}

function currentFunding(long: LivePosition, short: LivePosition, options: PositionMetricsOptions, now: number) {
  const unavailable = (reason: string) => ({ rate: null, asOf: null, nextAt: null, reason });
  if (!validClock(now)) return unavailable('当前时钟无效，无法判断资金费时效');
  const matches = (leg: FundingLeg, position: LivePosition) => leg.symbol === position.symbol
    && leg.exchange === position.exchange && leg.quoteCurrency === position.quoteCurrency;
  const fresh = (at: number) => timestamp(at) && at <= now + 1000 && now - at < FUNDING_TTL_MS;
  const normalize = (leg: FundingLeg) => {
    const rate = decimal(leg.rate), interval = decimal(leg.intervalHours);
    return rate && interval?.gt(0) && interval.lte(168) ? rate.mul(8).div(interval) : null;
  };
  const combine = (longLeg: FundingLeg, shortLeg: FundingLeg, asOf: number) => {
    const longRate = normalize(longLeg), shortRate = normalize(shortLeg);
    if (!longRate || !shortRate) return unavailable('资金费率或结算周期缺失');
    return { rate: shortRate.sub(longRate), asOf,
      nextAt: timestamp(longLeg.nextFundingAt) && timestamp(shortLeg.nextFundingAt)
        ? Math.min(longLeg.nextFundingAt, shortLeg.nextFundingAt) : null, reason: null };
  };
  if (options.positionFundingRates !== undefined) {
    // A supplied empty list is authoritative. Do not substitute the opportunity
    // ranking, which intentionally omits zero spreads and may truncate positions.
    if (!Array.isArray(options.positionFundingRates)) return unavailable('持仓资金费数据无效');
    const forPosition = (position: LivePosition) => options.positionFundingRates!.filter(leg => matches(leg, position))
      .sort((a, b) => b.fundingAt - a.fundingAt)
      .find(leg => fresh(leg.fundingAt) && timestamp(leg.expiresAt) && leg.expiresAt > now && normalize(leg) !== null);
    const longLeg = forPosition(long), shortLeg = forPosition(short);
    if (!longLeg || !shortLeg) return unavailable('持仓资金费缺少完全匹配的新鲜双腿数据');
    return combine(longLeg, shortLeg, Math.min(longLeg.fundingAt, shortLeg.fundingAt));
  }
  if (options.marketStale) return unavailable('Monitor 行情待更新，当前资金费差未知');
  const rows = (options.fundingOpportunities ?? []).filter(row => (matches(row.long, long) && matches(row.short, short))
    || (matches(row.long, short) && matches(row.short, long))).sort((a, b) => b.asOf - a.asOf);
  if (!rows.length) return unavailable('缺少与持仓合约完全匹配的当前资金费');
  for (const row of rows) {
    if (!timestamp(row.expiresAt) || row.expiresAt <= now || !fresh(row.asOf)
      || !fresh(row.long.fundingAt) || !fresh(row.short.fundingAt)) continue;
    const longLeg = matches(row.long, long) ? row.long : row.short, shortLeg = longLeg === row.long ? row.short : row.long;
    const result = combine(longLeg, shortLeg, Math.min(row.asOf, longLeg.fundingAt, shortLeg.fundingAt));
    if (result.rate) return result;
  }
  return unavailable('资金费数据过期、时间无效或费率周期缺失');
}

function positionMetrics(legs: LivePosition[], options: PositionMetricsOptions): PositionMetrics {
  const now = options.now ?? Date.now(), reasons: string[] = [], healthMissing: string[] = [];
  const metrics: PositionMetrics = {
    applicable: false, currency: null, openedAt: null, holdingMs: null,
    entrySpread: null, currentSpread: null, spreadNarrowingRatio: null, spreadReturn: null, spreadReturnRatio: null,
    margin: null, fundingFee: null, totalReturn: null, roi: null, annualizedReturn: null,
    fundingRate8h: null, expectedFundingAnnualized: null, realizedFundingAnnualized: null, nextFundingAt: null, fundingAsOf: null,
    healthScore: null, health: 'unknown', healthDeductions: [], healthMissing, reasons,
  };
  if (validClock(now) && legs.every(p => timestamp(p.openedAt) && p.openedAt <= now)) {
    metrics.openedAt = Math.min(...legs.map(p => p.openedAt!));
    metrics.holdingMs = now - metrics.openedAt;
  } else { reasons.push('持仓开仓时间缺失或无效'); healthMissing.push('持仓时长未知'); }
  if (options.stale) healthMissing.push('账户持仓数据已过期');
  if (options.partial) healthMissing.push('账户持仓数据不完整');
  const problem = pairProblem(legs);
  if (problem) { reasons.push(problem); healthMissing.push(problem); return metrics; }
  metrics.applicable = true; metrics.currency = legs[0].quoteCurrency;
  const long = legs.find(p => p.side.toUpperCase() === 'LONG')!, short = legs.find(p => p.side.toUpperCase() === 'SHORT')!;
  const quantity = decimal(long.baseQuantity)!.abs();
  const longEntry = decimal(long.entryPrice), shortEntry = decimal(short.entryPrice);
  const longMark = decimal(long.markPrice), shortMark = decimal(short.markPrice);
  const validEntries = longEntry?.gt(0) && shortEntry?.gt(0), validMarks = longMark?.gt(0) && shortMark?.gt(0);
  const entrySpread = validEntries ? shortEntry!.sub(longEntry!).div(longEntry!) : null;
  const currentSpread = validMarks ? shortMark!.sub(longMark!).div(longMark!) : null;
  metrics.entrySpread = entrySpread?.toFixed() ?? null; metrics.currentSpread = currentSpread?.toFixed() ?? null;
  if (!validEntries) reasons.push('开仓均价缺失或无效');
  if (!validMarks) reasons.push('当前标记价缺失或无效');
  if (entrySpread && currentSpread && !entrySpread.isZero()) {
    const narrowing = entrySpread.abs().sub(currentSpread.abs()).div(entrySpread.abs());
    metrics.spreadNarrowingRatio = narrowing.toFixed();
    if (narrowing.gt('0.3')) metrics.healthDeductions.push({ code: 'spread_narrowing', points: 30, reason: '价差绝对幅度较开仓收窄超过 30%，扣 30 分' });
  } else healthMissing.push(entrySpread?.isZero() ? '开仓价差为零，无法判断收窄比例' : '开仓或当前价差未知');
  // Calculate the open legs directly. closed_pnl may already contain realized
  // funding and closed fills, so it must never be added to this return again.
  const spreadReturn = validEntries && validMarks ? longMark!.sub(longEntry!).add(shortEntry!.sub(shortMark!)).mul(quantity) : null;
  metrics.spreadReturn = spreadReturn?.toFixed() ?? null;
  metrics.spreadReturnRatio = spreadReturn ? spreadReturn.div(longEntry!.mul(quantity)).toFixed() : null;
  const margins = legs.map(p => decimal(p.margin));
  const margin = legs.every((p, i) => p.marginCurrency === metrics.currency && margins[i]?.gt(0)) ? margins[0]!.add(margins[1]!) : null;
  metrics.margin = margin?.toFixed() ?? null;
  if (!margin) reasons.push('双腿保证金缺失、非正值或币种不一致');
  const fees = legs.map(p => decimal(p.fundingFee));
  const fundingFee = fees.every(value => value !== null) ? fees[0]!.add(fees[1]!) : null;
  metrics.fundingFee = fundingFee?.toFixed() ?? null;
  if (!fundingFee) reasons.push('持仓累计资金费缺失');
  const totalReturn = spreadReturn && fundingFee ? spreadReturn.add(fundingFee) : null;
  metrics.totalReturn = totalReturn?.toFixed() ?? null;
  const roi = totalReturn && margin ? totalReturn.div(margin) : null;
  metrics.roi = roi?.toFixed() ?? null;
  const annualize = (value: Decimal | null) => value && metrics.holdingMs !== null && metrics.holdingMs > 0
    ? value.mul(DAY_MS).div(metrics.holdingMs).mul(365).toFixed() : null;
  metrics.annualizedReturn = annualize(roi);
  metrics.realizedFundingAnnualized = annualize(fundingFee && margin ? fundingFee.div(margin) : null);
  if (metrics.holdingMs === 0) reasons.push('持仓时长为零，暂无法计算实际年化');
  if (metrics.holdingMs !== null && metrics.holdingMs > 7 * DAY_MS) metrics.healthDeductions.push({ code: 'holding_age', points: 20, reason: '持仓超过 7 天，扣 20 分' });
  const funding = currentFunding(long, short, options, now);
  metrics.fundingRate8h = funding.rate?.toFixed() ?? null;
  metrics.expectedFundingAnnualized = funding.rate?.mul(3).mul(365).toFixed() ?? null;
  metrics.nextFundingAt = funding.nextAt; metrics.fundingAsOf = funding.asOf;
  if (funding.reason) { reasons.push(funding.reason); healthMissing.push(funding.reason); }
  if (funding.rate?.lt(0)) metrics.healthDeductions.push({ code: 'funding_reversal', points: 25, reason: '当前持仓方向的净资金费率为负，扣 25 分' });
  if (!healthMissing.length) {
    metrics.healthScore = 100 - metrics.healthDeductions.reduce((sum, item) => sum + item.points, 0);
    metrics.health = metrics.healthScore >= 70 ? 'good' : metrics.healthScore >= 40 ? 'watch' : 'risk';
  }
  return metrics;
}

export function groupPositions(positions: LivePosition[], options: PositionMetricsOptions = {}): PositionGroup[] {
  const groups = new Map<string, LivePosition[]>();
  for (const p of positions) { const key = p.baseCurrency || p.symbol, legs = groups.get(key) || []; legs.push(p); groups.set(key, legs); }
  return Array.from(groups, ([base, legs]) => ({ base, legs, net: netBaseQuantity(legs),
    entry: weightedPrice(legs, 'entryPrice'), mark: weightedPrice(legs, 'markPrice'),
    notional: sumNative(legs, p => p.notional, p => p.quoteCurrency),
    pnl: sumNative(legs, p => p.unrealizedPnl, p => p.pnlCurrency),
    realized: sumNative(legs, p => p.realizedPnl, p => p.pnlCurrency),
    funding: sumNative(legs, p => p.fundingFee, p => p.pnlCurrency),
    metrics: positionMetrics(legs, options),
  })).sort((a, b) => a.base.localeCompare(b.base));
}

export function decimalField(row: Record<string, unknown> | null | undefined, ...fields: string[]): string | null {
  for (const field of fields) { const value = row?.[field]; if (typeof value === 'string' && exact(value) !== '—') return value; }
  return null;
}
export function percentage(value: string | null | undefined): string { return exact(value) === '—' ? '—' : formatDecimal(new D(value!).mul(100).toFixed(), 'rate') + '%'; }

export function instrumentFees(fees: Record<string, unknown>[] | undefined, symbol: string | undefined) {
  const row = fees?.find(item => item.exchange_type === symbol?.split('_')[0]);
  const special = Array.isArray(row?.special_fee_list) ? (row.special_fee_list as Record<string, unknown>[]).find(item => item.symbol === symbol) : undefined;
  return { maker: decimalField(special, 'maker_fee_rate') ?? decimalField(row, 'future_maker_fee'), taker: decimalField(special, 'taker_fee_rate') ?? decimalField(row, 'future_taker_fee') };
}
