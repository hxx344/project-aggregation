import type { LiveQuote, MarketData } from "./market";
import type { MonitorRuntimeMap } from './monitor-control';
import type { validateOilHistory, validateOilQuote } from "./market-validation";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { hynixSummary, oilSummary } from "./monitor-summary.ts";
import { createTrend } from "./monitor-trend.ts";
import { binanceOilExchangeQuote, type ExternalQuoteSet } from "./exchange-quotes.ts";
import { intradayChartRows, type createIntradaySnapshot } from "../modules/oil/intraday.mjs";
import { oilSpreadPercent } from "../modules/oil/spread.mjs";
import type { GoldOilQuote, GoldOilHistory, GoldOilType, GoldOilExchange } from './gold-oil';
import type { GoldOilFundingHistory } from './gold-oil-funding';
import { getQuoteStaleAfterMs, type QuoteFreshness } from './market-freshness.ts';

export type InitialGoldOilMarket = { quote: GoldOilQuote | null; history: GoldOilHistory | null; funding?: GoldOilFundingHistory | null };
export type InitialMarketData = {
  renderedAt: number;
  runtime?: MonitorRuntimeMap;
  'cl-xau'?: InitialGoldOilMarket & { bz?: InitialGoldOilMarket; bybit?: InitialGoldOilMarket & { bz?: InitialGoldOilMarket } };
  hynix: { quote: LiveQuote | null; history: MarketData | null; exchanges?: ExternalQuoteSet };
  oil: { quote: (ReturnType<typeof validateOilQuote> & QuoteFreshness & { status: "live" | "snapshot" }) | null; history?: ReturnType<typeof validateOilHistory> | null; candles?: ReturnType<typeof createIntradaySnapshot> | null; exchanges?: ExternalQuoteSet };
};

export function initialGoldOilMarket(initial: InitialMarketData | null | undefined, oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') {
  const market = exchange === 'bybit' ? initial?.['cl-xau']?.bybit : initial?.['cl-xau'];
  return oilType === 'bz' ? market?.bz : market;
}

export function initialSummaries(initial: InitialMarketData | null) {
  const hynix = initial?.hynix, oil = initial?.oil;
  return {
    hynix: hynixSummary(hynix?.quote ?? null, hynix?.quote?.status === "snapshot" ? "行情待更新" : "", createTrend(hynix?.history ? {
      points: hynix.history.points.map(point => ({ time: point.time, value: point.premium })), status: hynix.history.status, fetchedAt: hynix.history.fetchedAt,
    } : undefined, { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" })),
    oil: oilSummary(oil ? {
      status: oil.quote ? oil.quote.status === "snapshot" ? "stale" : "live" : "loading",
      spread: oil.quote ? oilSpreadPercent(oil.quote.brent.markPx, oil.quote.wti.markPx) : null,
      fundingHourlyRate: oil.quote ? calculateShortSpreadFunding(oil.quote).hourlyRate : null,
      fundingBasis: "quantity", fetchedAt: oil.quote?.fetchedAt ?? null,
      staleAfterMs: getQuoteStaleAfterMs(oil.quote, 75_000),
      comparison: oil.quote ? binanceOilExchangeQuote(oil.quote, oil.quote.status === "snapshot") : undefined,
      history: oil.candles ? { points: intradayChartRows(oil.candles).map(row => ({ time: row.time, value: row.spread })), status: oil.candles.status, fetchedAt: oil.candles.metadata.fetchedAt } : undefined,
    } : undefined),
  };
}
