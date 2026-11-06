import type { LiveQuote } from "./market";
import type { MonitorRuntimeMap } from './monitor-control';
import type { validateOilHistory, validateOilQuote } from "./market-validation";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { hynixSummary, hynixTrendOptions, oilSummary } from "./monitor-summary.ts";
import { createTrend, type TrendHistory } from "./monitor-trend.ts";
import { binanceOilExchangeQuote, type ExternalQuoteSet } from "./exchange-quotes.ts";
import { oilSpread } from "../modules/oil/spread.mjs";
import { getQuoteStaleAfterMs, type QuoteFreshness } from './market-freshness.ts';

export type InitialMarketData = {
  renderedAt: number;
  runtime?: MonitorRuntimeMap;
  /** Only the overview's seven-day premium trend; the detail chart reads the full history API. */
  hynix: { quote: LiveQuote | null; trend?: TrendHistory | null; exchanges?: ExternalQuoteSet };
  /** Only the overview's seven-day Brent − WTI trend; the detail chart reads the full 15-minute candles API. */
  oil: { quote: (ReturnType<typeof validateOilQuote> & QuoteFreshness & { status: "live" | "snapshot" }) | null; history?: ReturnType<typeof validateOilHistory> | null; trend?: TrendHistory | null; exchanges?: ExternalQuoteSet };
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
      // The server embeds only the trend window; the detail chart reads its full rows separately.
      history: oil.trend ?? undefined,
    } : undefined),
  };
}
