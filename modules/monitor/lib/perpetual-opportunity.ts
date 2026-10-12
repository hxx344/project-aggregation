import { pairTakerFees, validFeePercent, type QualityBudget } from "./perpetual-fees.ts";
import { quoteIsFresh, quotePrice, type PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualQuote } from "./perpetual-types.ts";

export interface PerpetualHoldingInput {
  holdingHours: number;
  /** Residual short/long spread on exit, in percentage points; zero assumes convergence. */
  exitSpreadPercent: number;
  priceMode?: "book" | "mark";
  staleAfterMs?: number;
}
export interface PerpetualFundingScenarioLeg {
  settlements: number | null;
  nextFundingAt: number | null;
  lastFundingAt: number | null;
  cashflowPercent: number | null;
  reason: string | null;
}
export interface PerpetualHoldingScenario {
  holdingHours: number;
  exitAt: number | null;
  long: PerpetualFundingScenarioLeg;
  short: PerpetualFundingScenarioLeg;
  convergencePercent: number | null;
  fundingPercent: number | null;
  roundTripFeePercent: number | null;
  slippagePercent: number | null;
  estimatedNetPercent: number | null;
  reasons: string[];
  assumptions: string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fresh = (at: unknown, now: number, age: number) => finite(at) && at > 0 && at <= now + 5_000 && now - at <= age;

function fundingLeg(quote: PerpetualQuote, side: "long" | "short", now: number, exitAt: number | null): PerpetualFundingScenarioLeg {
  const unavailable = (reason: string): PerpetualFundingScenarioLeg => ({ settlements: null, nextFundingAt: finite(quote.nextFundingAt) ? quote.nextFundingAt : null, lastFundingAt: null, cashflowPercent: null, reason });
  if (exitAt === null) return unavailable("持有时间无效");
  if (!finite(quote.fundingRate) || !fresh(quote.fundingAt, now, 300_000)) return unavailable("资金费率缺失或超过 5 分钟未更新");
  if (!finite(quote.fundingIntervalHours) || quote.fundingIntervalHours <= 0 || quote.fundingIntervalHours > 168) return unavailable("资金费结算周期缺失或无效");
  // An old next-settlement timestamp does not prove that the next interval is unchanged.
  if (!finite(quote.nextFundingAt) || quote.nextFundingAt <= now) return unavailable("下次结算时间缺失或已过，等待交易所更新");
  const intervalMs = quote.fundingIntervalHours * 3_600_000;
  if (quote.nextFundingAt - now > intervalMs + 5_000) return unavailable("下次结算时间与当前周期不一致");
  const settlements = quote.nextFundingAt > exitAt ? 0 : Math.floor((exitAt - quote.nextFundingAt) / intervalMs) + 1;
  const cashflowPercent = (side === "long" ? -1 : 1) * quote.fundingRate * settlements * 100;
  return { settlements, nextFundingAt: quote.nextFundingAt, lastFundingAt: settlements ? quote.nextFundingAt + (settlements - 1) * intervalMs : null, cashflowPercent, reason: null };
}

/** A fixed-rate, fixed-notional scenario; this is not a promised or locked profit. */
export function estimatePerpetualHoldingScenario(row: PerpetualSpread, budget: QualityBudget, input: PerpetualHoldingInput, now: number): PerpetualHoldingScenario {
  const reasons: string[] = [];
  const validTime = finite(now) && finite(input.holdingHours) && input.holdingHours >= 0 && input.holdingHours <= 168;
  const validExit = finite(input.exitSpreadPercent) && input.exitSpreadPercent >= -100 && input.exitSpreadPercent <= 1000;
  const exitAt = validTime ? now + input.holdingHours * 3_600_000 : null;
  if (!validTime) reasons.push("持有时间需在 0 至 168 小时之间");
  if (!validExit) reasons.push("退出残余价差无效");
  const long = fundingLeg(row.long, "long", now, exitAt), short = fundingLeg(row.short, "short", now, exitAt);
  if (long.reason) reasons.push(`做多侧：${long.reason}`);
  if (short.reason) reasons.push(`做空侧：${short.reason}`);
  const fundingPercent = long.cashflowPercent === null || short.cashflowPercent === null ? null : long.cashflowPercent + short.cashflowPercent;
  const fees = pairTakerFees(row, budget.takerOverrides, now);
  if (fees.roundTripPercent === null) reasons.push("两腿 taker 费率未齐全");
  const slippagePercent = validFeePercent(budget.slippagePercent) ? budget.slippagePercent : null;
  if (slippagePercent === null) reasons.push("滑点预算无效");
  const mode = input.priceMode ?? "book";
  const validPrices = quoteIsFresh(row.long, "book", now, input.staleAfterMs ?? 30_000) && quoteIsFresh(row.short, "book", now, input.staleAfterMs ?? 30_000)
    && quotePrice(row.long, "book", "buy") !== null && quotePrice(row.short, "book", "sell") !== null
    && Math.abs(Math.min(row.long.bidAskAt!, row.long.receivedAt) - Math.min(row.short.bidAskAt!, row.short.receivedAt)) <= 5_000;
  if (mode !== "book" || row.netUnavailableReason === "mark") reasons.push("标记价仅供参考，无法估算成交情景");
  if (!validPrices) reasons.push("当前两腿盘口过期或时间不对齐");
  const fxReady = !row.crossCurrency || (row.fxAdjusted === true && fresh(row.fxAt, now, 180_000));
  if (!fxReady) reasons.push("跨计价币缺少有效换算汇率");
  const convergencePercent = validExit && finite(row.spreadPercent) ? row.spreadPercent - input.exitSpreadPercent : null;
  const estimatedNetPercent = reasons.length || convergencePercent === null || fundingPercent === null || fees.roundTripPercent === null || slippagePercent === null
    ? null : convergencePercent + fundingPercent - fees.roundTripPercent - slippagePercent;
  return {
    holdingHours: input.holdingHours, exitAt, long, short, convergencePercent, fundingPercent,
    roundTripFeePercent: fees.roundTripPercent, slippagePercent, estimatedNetPercent, reasons,
    assumptions: [
      "以单腿名义金额为基准作近似估算，两腿名义金额保持不变；非保证收益率。",
      "假设未来资金费率、结算周期和 taker 费率维持当前值；持有区间为当前时刻之后至退出时刻（含）。",
      "价差部分按入场价差减退出残余价差估算；未模拟平仓价格路径、清算或额外换汇手续费。",
    ],
  };
}
