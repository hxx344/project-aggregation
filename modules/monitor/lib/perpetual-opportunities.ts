import type { PerpetualExchange, PerpetualQuote, PerpetualStatus } from "./perpetual-types.ts";
import type { PerpetualFxSnapshot } from "./perpetual-fx.ts";

export const CROSS_EX_STALE_MS = 10_000;
export const CROSS_EX_MAX_SIGNALS = 200;
export const CROSS_EX_MAX_QUOTES = 5_000;

export interface PerpetualOpportunitySignal {
  id: string;
  pairKey: string;
  base: string;
  quoteCurrency: "USDT";
  long: PerpetualQuote;
  short: PerpetualQuote;
  grossSpreadPercent: number;
  observedAt: number;
  expiresAt: number;
  spotTransfer?: { networks: string[]; checkedAt: number; expiresAt: number };
}

export interface PerpetualOpportunities {
  schemaVersion: 1;
  mode: "paper";
  source: "market-monitor";
  monitorId: "perpetual";
  generatedAt: number;
  status: PerpetualStatus;
  staleAfterMs: number;
  exchanges: PerpetualExchange[];
  quotes: PerpetualQuote[];
  signals: PerpetualOpportunitySignal[];
  crossexFilter?: { requireSpotTransfer: boolean; blockedBases: string[]; excluded: number; revision: number };
  error?: string;
  errorCode?: "NO_RESIDENT_FEED" | "QUOTE_LIMIT_EXCEEDED" | "DUPLICATE_QUOTES";
}

export interface PerpetualOpportunitiesV2 extends Omit<PerpetualOpportunities, "schemaVersion"> {
  schemaVersion: 2;
  fx: PerpetualFxSnapshot | null;
  storageError?: string;
}

/** Stateless previews have no collector and must not manufacture fresh signals. */
export function unavailablePerpetualOpportunities(now = Date.now()): PerpetualOpportunities {
  return {
    schemaVersion: 1, mode: "paper", source: "market-monitor", monitorId: "perpetual",
    generatedAt: now, status: "unavailable", staleAfterMs: CROSS_EX_STALE_MS,
    exchanges: [], quotes: [], signals: [], errorCode: "NO_RESIDENT_FEED",
    error: "当前网页预览没有常驻行情采集，请连接已部署的行情监控后台。",
  };
}
