import { estimatePairCapital, estimatePairRoc, type CapitalAssumptions } from "../../../server/capital-metrics.mjs";
import { normalizedFunding8h, quoteIsFresh, type PerpetualFilters, type PerpetualSpread } from "./perpetual-spreads.ts";

/** Display and sorting share the same price, currency and funding-time checks. */
export function scannerCapitalMetrics(row: PerpetualSpread, assumptions: CapitalAssumptions, data: {
  now: number; priceMode: PerpetualFilters["priceMode"]; staleAfterMs: number;
}) {
  const reason = !quoteIsFresh(row.long, data.priceMode, data.now, data.staleAfterMs) || !quoteIsFresh(row.short, data.priceMode, data.now, data.staleAfterMs)
    ? "报价已过期，等待更新"
    : row.crossCurrency && !row.fxAdjusted ? "跨计价币缺少有效换算汇率" : "";
  // Cross-currency prices must already have been converted to the same unit.
  const longPrice = row.crossCurrency ? row.referenceBuyPrice : row.buyPrice;
  const shortPrice = row.crossCurrency ? row.referenceSellPrice : row.sellPrice;
  const capital = estimatePairCapital({ longPrice: reason ? null : longPrice, shortPrice, ...assumptions });
  if (reason) capital.reason = reason;
  const roc = estimatePairRoc({ netSpreadPercent: row.netSpreadPercent,
    longFunding8h: normalizedFunding8h(row.long, data.now), shortFunding8h: normalizedFunding8h(row.short, data.now),
    shortNotionalPercent: capital.shortNotionalPercent, capitalPercent: capital.capitalPercent, holdingHours: assumptions.holdingHours });
  return { capital, roc };
}
