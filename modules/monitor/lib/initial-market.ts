import type { LiveQuote } from "./market";
import type { MonitorRuntimeMap } from './monitor-control';
import type { validateOilHistory, validateOilQuote } from "./market-validation";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { hynixSummary, hynixTrendOptions, oilSummary, oilTrendOptions } from "./monitor-summary.ts";
import { createTrend, type TrendHistory } from "./monitor-trend.ts";
import { binanceOilExchangeQuote, type ExternalQuoteSet } from "./exchange-quotes.ts";
import { recentIntradayChartRows, type createIntradaySnapshot } from "../modules/oil/intraday.mjs";
import { oilSpread } from "../modules/oil/spread.mjs";
import { getQuoteStaleAfterMs, type QuoteFreshness } from './market-freshness.ts';

export type InitialMarketData = {
  renderedAt: number;
  runtime?: MonitorRuntimeMap;
  /** Only the overview's seven-day premium trend; the detail chart reads the full history API. */
  hynix: { quote: LiveQuote | null; trend?: TrendHistory | null; exchanges?: ExternalQuoteSet };
  oil: { quote: (ReturnType<typeof validateOilQuote> & QuoteFreshness & { status: "live" | "snapshot" }) | null; history?: ReturnType<typeof validateOilHistory> | null; candles?: ReturnType<typeof createIntradaySnapshot> | null; exchanges?: ExternalQuoteSet };
};

export function initialSummaries(initial: InitialMarketData | null) {
  const hynix = initial?.hynix, oil = initial?.oil;
  return {
    hynix: hynixSummary(hynix?.quote ?? null, hynix?.quote?.status === "snapshot" ? "行情待更新" : "", createTrend(hynix?.trend ?? undefined, hynixTrendOptions)),
    oil: oilSummary(oil ? {
      status: oil.quote ? oil.quote.status === "snapshot" ? "stale" : "live" : "loading",
      spread: oil.quote ? oilSpread(oil.quote.brent.markPx, oil.quote.wti.markPx) : null,
      fundingHourlyRate: oil.quote ? calculateShortSpreadFunding(oil.quote).hourlyRate : null,
      fundingBasis: "quantity", fetchedAt: oil.quote?.fetchedAt ?? null,
      staleAfterMs: getQuoteStaleAfterMs(oil.quote, 75_000),
      comparison: oil.quote ? binanceOilExchangeQuote(oil.quote, oil.quote.status === "snapshot") : undefined,
      // The overview only shows the trend window; the detail chart builds its full rows separately.
      history: oil.candles ? { points: recentIntradayChartRows(oil.candles, oilTrendOptions.days * 86_400_000).map(row => ({ time: row.time, value: row.spread })), status: oil.candles.status, fetchedAt: oil.candles.metadata.fetchedAt } : undefined,
    } : undefined),
  };
}
