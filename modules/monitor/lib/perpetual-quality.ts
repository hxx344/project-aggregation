import { normalizedFunding8h, perpetualSpreadKey, type PerpetualSpread } from './perpetual-spreads.ts';
import type { PerpetualQuote } from './perpetual-types.ts';
import { defaultQualityBudget, pairTakerFees, validFeePercent, type PairTakerFees, type QualityBudget } from './perpetual-fees.ts';
export { defaultQualityBudget, parseQualityBudget, type QualityBudget } from './perpetual-fees.ts';

export interface TokenFundamentals {
  coinId: string; name: string; marketCapUsd: number | null; fdvUsd: number | null;
  circulatingSupply: number | null; totalSupply: number | null; maxSupply: number | null;
  updatedAt: number | null; source: string;
}
export interface PositioningRatio {
  exchange: string; symbol: string; longRatio: number; shortRatio: number;
  kind: 'accounts' | 'positions'; scope: string; source: string; observedAt: number;
}
export interface PositioningOverview {
  kind: 'accounts'; method: 'equal-exchange'; periodMs: 300000;
  longRatio: number | null; shortRatio: number | null;
  availableExchanges: number; eligibleExchanges: number; totalExchanges: number;
  observedAt: number | null;
  constituents: Array<{
    exchange: string; key: string | null; symbol: string | null;
    status: 'fresh' | 'stale' | 'pending' | 'unsupported' | 'unavailable' | 'error' | 'rate-limited';
    reason: string | null;
  }>;
}
export interface StabilityStats {
  samples: number; expectedSamples: number; coverage: number; firstAt: number | null; lastAt: number | null;
  mean: number | null; stddev: number | null; positiveRatio: number | null; signChanges: number;
}
export interface ConvergenceHorizon {
  hours: 1 | 4 | 8; completed: number; successful: number; incomplete: number; pending: number;
  successRatio: number | null; medianMinutesToTarget: number | null; maxAdverseExpansionPercent: number | null;
}
export interface QuoteConvergenceHistory {
  method: 'non-overlapping-quoted-halving-v1'; windowMs: 86400000; sampleIntervalMs: 300000;
  targetFraction: 0.5; minEntrySpreadPercent: 0.05; samples: number; lastAt: number | null;
  /** Independent UTC-aligned windows; completed windows require every real five-minute observation. */
  horizons: ConvergenceHorizon[];
}
export interface OpportunityProfile {
  status: 'positive' | 'negative' | 'mixed' | 'insufficient'; label: string; detail: string;
}
export interface PairQualityHistory {
  base: string; longKey: string; shortKey: string;
  identity?: string;
  /** All history values are percentage points. Funding is normalized to 8h. */
  spread: StabilityStats;
  funding: StabilityStats & { longStddev: number | null; shortStddev: number | null };
  /** A quoted entry-spread narrowing study, not observed exits, trades or realised returns. */
  convergence?: QuoteConvergenceHistory;
  /** Requested for one inspected pair only; real minute observations, never interpolated. */
  priceSeries?: Array<[number, number]>;
}
export interface PerpetualQualityReport {
  schemaVersion: 1; generatedAt: number; sampleIntervalMs: number; priceWindowMs: number; fundingWindowMs: number;
  pairs: Record<string, PairQualityHistory>;
  assets: Record<string, TokenFundamentals>;
  assetErrors: Record<string, string>;
  positioning: Record<string, PositioningRatio>;
  positioningErrors: Record<string, string>;
  positioningOverview?: Record<string, PositioningOverview>;
  error?: string | null;
}
export interface QualityDimension { id: string; label: string; weight: number; score: number | null; detail: string }
export interface OpportunityQuality {
  grade: 'strong' | 'watch' | 'weak' | 'insufficient' | 'reference'; label: string;
  score: number | null; coverage: number; dimensions: QualityDimension[]; reasons: string[];
  netSpreadPercent: number | null;
  fees: PairTakerFees;
  profiles: { persistence: OpportunityProfile; convergence: OpportunityProfile; funding: OpportunityProfile };
}
export const qualityPairKey = perpetualSpreadKey;
export const qualityHistoryIdentity = (long: PerpetualQuote, short: PerpetualQuote): string => JSON.stringify([long.base, long.quoteCurrency, long.collateralCurrency ?? '', long.multiplier ?? 1, long.contractUnit ?? '', short.base, short.quoteCurrency, short.collateralCurrency ?? '', short.multiplier ?? 1, short.contractUnit ?? '']);
/** Existing history is in one common quote currency; never apply it to an FX-adjusted pair. */
export function pairQualityHistory(row: PerpetualSpread, report: PerpetualQualityReport | null | undefined): PairQualityHistory | undefined {
  const history = report?.pairs[qualityPairKey(row)];
  return !row.crossCurrency && history && (!history.identity || history.identity === qualityHistoryIdentity(row.long, row.short)) ? history : undefined;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fresh = (at: unknown, now: number, age: number) => finite(at) && at > 0 && at <= now + 5_000 && now - at <= age;
const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** A transparent screening rubric, not a probability of profit. Missing evidence stays unscored. */
export function evaluateOpportunityQuality(row: PerpetualSpread, report: PerpetualQualityReport | null | undefined, now: number, budget: QualityBudget = defaultQualityBudget, mode: 'book' | 'mark' = 'book'): OpportunityQuality {
  const reasons: string[] = [];
  // Switching away pauses reads, not the lifetime of each independent source observation.
  const currentReport = report && finite(report.generatedAt) && report.generatedAt > 0 && report.generatedAt <= now + 5_000 ? report : undefined;
  const evidenceFresh = (at: unknown, age: number) => currentReport && finite(at) && at <= currentReport.generatedAt + 5_000 && fresh(at, now, age);
  const asset = currentReport?.assets[row.base];
  const assetFresh = asset && evidenceFresh(asset.updatedAt, 3_600_000);
  const cap = assetFresh && finite(asset.marketCapUsd) && asset.marketCapUsd > 0 ? asset.marketCapUsd : null;
  const fdv = assetFresh && finite(asset.fdvUsd) && asset.fdvUsd > 0 ? asset.fdvUsd : null;
  const dilution = cap !== null && fdv !== null && fdv >= cap * 0.95 ? Math.min(1, cap / fdv) : null;
  const capScore = cap === null ? null : cap >= 10e9 ? 100 : cap >= 1e9 ? 80 : cap >= 100e6 ? 60 : cap >= 10e6 ? 35 : 10;
  const history = pairQualityHistory(row, currentReport);
  const spread = history?.spread, funding = history?.funding;
  const spreadReady = spread && spread.samples >= 30 && spread.coverage >= 0.5 && evidenceFresh(spread.lastAt, 180_000) && finite(spread.mean) && finite(spread.stddev) && finite(spread.positiveRatio);
  const fundingReady = funding && funding.samples >= 12 && funding.coverage >= 1 / 24 && evidenceFresh(funding.lastAt, 600_000) && finite(funding.mean) && finite(funding.positiveRatio) && finite(funding.longStddev) && finite(funding.shortStddev);
  const convergence = history?.convergence, oneHour = convergence?.horizons.find(item => item.hours === 1);
  const convergenceReady = convergence?.method === 'non-overlapping-quoted-halving-v1' && convergence.samples >= 145 && evidenceFresh(convergence.lastAt, 600_000) && oneHour && oneHour.completed >= 6 && oneHour.completed / Math.max(1, oneHour.completed + oneHour.incomplete) >= 0.75 && finite(oneHour.successRatio) && oneHour.successRatio >= 0 && oneHour.successRatio <= 1;
  const spreadScore = spreadReady ? clamp(spread.mean! <= 0 ? 0 : 100 * spread.positiveRatio! / (1 + spread.stddev! / Math.max(Math.abs(spread.mean!), 0.05))) : null;
  // Low variance of a persistent funding expense is not evidence of profitable carry.
  const fundingScore = fundingReady ? funding.mean! <= 0 ? 0 : clamp(100 * funding.positiveRatio! / (1 + Math.max(funding.longStddev!, funding.shortStddev!) / 0.05) * (1 - Math.min(0.5, funding.signChanges / Math.max(1, funding.samples - 1)))) : null;
  const longFunding = normalizedFunding8h(row.long, now), shortFunding = normalizedFunding8h(row.short, now);
  const currentFunding = longFunding === null || shortFunding === null ? null : (shortFunding - longFunding) * 100;
  const long = currentReport?.positioning[`${row.long.exchange}:${row.long.symbol}`], short = currentReport?.positioning[`${row.short.exchange}:${row.short.symbol}`];
  const validRatio = (item: PositioningRatio | undefined) => item && evidenceFresh(item.observedAt, 900_000) && finite(item.longRatio) && finite(item.shortRatio) && item.longRatio >= 0 && item.shortRatio >= 0 && item.longRatio <= 1 && item.shortRatio <= 1 && Math.abs(item.longRatio + item.shortRatio - 1) < 0.02;
  const positioningReady = validRatio(long) && validRatio(short) && long!.kind === short!.kind;
  // Only crowding in the proposed directions is measured; account counts are never treated as position size.
  const positioningScore = positioningReady ? clamp(100 - 200 * Math.max(0, Math.max(long!.longRatio, short!.shortRatio) - 0.5)) : null;
  const dimensions: QualityDimension[] = [
    { id: 'marketCap', label: '市值规模 · 辅助', weight: 10, score: capScore, detail: cap === null ? currentReport?.assetErrors[row.base] || '暂无新鲜市值数据' : '≥100亿 / 10亿 / 1亿 / 1000万美元对应100 / 80 / 60 / 35分，更小为10分' },
    { id: 'fdv', label: '市值 / FDV · 辅助', weight: 10, score: dilution === null ? null : Math.round(dilution * 100), detail: dilution === null ? 'FDV缺失、过期或与市值不一致' : '市值÷FDV；衡量估值摊薄程度，不等于流通量÷最大供应量' },
    { id: 'positioning', label: '多空拥挤度 · 辅助', weight: 10, score: positioningScore, detail: positioningReady ? '做多侧多头占比与做空侧空头占比，较拥挤一侧超过50%的部分扣分；不预测涨跌' : '两腿需有新鲜且同类的官方多空比；账户人数与持仓量不混算' },
    { id: 'spread', label: '价差持续性 · 1h', weight: 10, score: spreadScore, detail: spreadReady ? '正价差占比 × 波动折扣；只描述持续性，长期不收窄的价差不能据此获高等级' : `每分钟采样，至少30个有效点；当前${spread?.samples ?? 0}/60点` },
    { id: 'convergence', label: '报价收窄证据 · 24h', weight: 40, score: convergenceReady ? oneHour.successRatio! * 100 : null, detail: convergenceReady ? '1h独立完整窗口内报价价差至少减半的占比；并非平仓价差或已成交盈利概率，4h/8h小样本仅展示' : `需至少145个5分钟点（跨度至少12h）、6个已结束的1h完整窗口，且窗口完整率≥75%；当前${convergence?.samples ?? 0}点 / ${oneHour?.completed ?? 0}个完整窗口` },
    { id: 'funding', label: '资金费收入方向 · 24h', weight: 20, score: fundingScore, detail: fundingReady ? '净收入占比 × 双腿波动折扣 × 变号折扣；历史平均净支出或为零不获收入分，按8h折算并非已结算收益' : `每5分钟采样，至少12个有效点；当前${funding?.samples ?? 0}/288点` },
  ];
  for (const item of dimensions) if (item.score !== null) item.score = Math.round(item.score);
  const coverage = dimensions.reduce((sum, item) => sum + (item.score === null ? 0 : item.weight), 0);
  const rawScore = coverage ? Math.round(dimensions.reduce((sum, item) => sum + (item.score ?? 0) * item.weight, 0) / coverage) : null;
  const fees = pairTakerFees(row, budget.takerOverrides, now);
  const validBudget = fees.roundTripPercent !== null && validFeePercent(budget.slippagePercent);
  const fxReady = !row.crossCurrency || (row.fxAdjusted === true && fresh(row.fxAt, now, 180_000));
  const reference = mode === 'mark' || !fxReady || !fresh(row.updatedAt, now, 30_000);
  const netSpreadPercent = !reference && validBudget ? row.spreadPercent - fees.roundTripPercent! - budget.slippagePercent : null;
  if (fees.roundTripPercent === null) reasons.push('两腿 taker 费率尚未齐全，暂不计算扣费价差，等级不评为证据较全');
  if (!validFeePercent(budget.slippagePercent)) reasons.push('滑点预算无效，暂不计算扣费价差');
  if (reference) reasons.push(mode === 'mark' ? '标记价不能用于判断可成交套利质量' : !fxReady ? '跨计价币汇率缺失或已过期，仅供参考' : '当前两腿价格已过期');
  if (row.fxAdjusted) reasons.push('跨计价币已按现货买卖价换算，未计额外换汇手续费；尚无相同换算口径的历史，不套用原币种历史评分');
  if (!spreadReady || !fundingReady) reasons.push('历史正在积累，未用回填或模拟数据补齐');
  if (!convergenceReady) reasons.push('报价收窄证据不足，稳定正价差不能替代退出或收敛证据');
  if (fundingReady && funding.coverage < 0.5) reasons.push('资金费历史不足12小时，等级暂不评为证据较全');
  if (coverage < 100) reasons.push(`可评分数据覆盖${coverage}%，缺失项未计为零分`);
  const constrained = row.long.delisting === true || row.short.delisting === true || (netSpreadPercent !== null && netSpreadPercent <= 0) || (fundingReady && funding.mean! < 0 && netSpreadPercent !== null && -funding.mean! >= Math.max(0, netSpreadPercent));
  if (row.long.delisting || row.short.delisting) reasons.push('组合含已公告下架的合约');
  if (netSpreadPercent !== null && netSpreadPercent <= 0) reasons.push('当前毛价差不足覆盖双腿 taker 往返手续费与滑点预算');
  if (fundingReady && funding.mean! < 0) reasons.push('历史平均资金费差为净支出，需结合持有时间判断');
  if (currentFunding !== null && currentFunding < 0) reasons.push('当前预估资金费差为净支出，历史收入方向不代表下一次结算');
  const score = reference || coverage < 60 || !spreadReady || !convergenceReady ? null : rawScore;
  const grade = reference ? 'reference' : score === null ? 'insufficient' : constrained || score < 50 ? 'weak' : score >= 75 && coverage === 100 && spreadReady && spread.mean! > 0 && fundingReady && funding.coverage >= 0.5 && funding.mean! > 0 && currentFunding !== null && currentFunding >= 0 && oneHour!.successRatio! >= 2 / 3 && validBudget ? 'strong' : 'watch';
  const profiles: OpportunityQuality['profiles'] = {
    persistence: !spreadReady ? { status: 'insufficient', label: '持续性待积累', detail: '需要近1小时至少30个真实分钟点' } : { status: spread.mean! > 0 && spread.positiveRatio! >= 0.8 ? 'positive' : spread.mean! <= 0 ? 'negative' : 'mixed', label: spread.mean! > 0 && spread.positiveRatio! >= 0.8 ? '正价差持续' : spread.mean! <= 0 ? '平均价差非正' : '价差方向变化', detail: `正价差占比${(spread.positiveRatio! * 100).toFixed(0)}%；持续存在不代表之后会收窄` },
    convergence: !convergenceReady ? { status: 'insufficient', label: '收窄证据不足', detail: '完整窗口、样本量或新鲜度不足；未结束和有缺口的窗口不计成功或失败' } : { status: oneHour.successRatio! >= 2 / 3 ? 'positive' : oneHour.successRatio! < 1 / 3 ? 'negative' : 'mixed', label: oneHour.successRatio! >= 2 / 3 ? '较多窗口曾收窄' : oneHour.successRatio! < 1 / 3 ? '较少窗口曾收窄' : '收窄表现不一', detail: `${oneHour.successful}/${oneHour.completed}个完整1h窗口出现报价减半；固定UTC窗口，初始价差至少0.05%，不表示当前偏离的盈利概率` },
    funding: !fundingReady ? { status: 'insufficient', label: '费差方向待积累', detail: '需要至少12个真实5分钟样本；不同结算周期仅按8h折算比较' } : { status: funding.mean! < 0 ? 'negative' : funding.mean! > 0 && funding.positiveRatio! >= 0.8 && currentFunding !== null && currentFunding >= 0 ? 'positive' : 'mixed', label: funding.mean! < 0 ? '历史平均净支出' : funding.mean! === 0 ? '历史平均持平' : currentFunding !== null && currentFunding < 0 ? '历史收入／当前支出' : '历史平均净收入', detail: `历史平均${funding.mean!.toFixed(4)}% / 8h，净收入占比${(funding.positiveRatio! * 100).toFixed(0)}%；当前预估${currentFunding === null ? '缺失或过期' : `${currentFunding.toFixed(4)}% / 8h`}，非实际结算记录` },
  };
  return { grade, label: ({ strong: '证据较全', watch: '待验证', weak: '条件偏弱', insufficient: '资料不足', reference: '仅供参考' })[grade], score, coverage, dimensions, reasons, netSpreadPercent, fees, profiles };
}
