export type CostSymbol = 'BTC' | 'ETH';
export type CostVenue = 'binance' | 'lighter';
export type CostConfig = {
  schema: 2; symbols: CostSymbol[]; latencyScenarios: number[];
  orderNotional: number; maxInventoryNotional: number; maxUnhedgedNotional: number;
  quoteOffsetBps: number; inventorySkewBps: number; quoteRefreshMs: number; quoteMaxAgeMs: number; hedgeWaitMs: number;
  maxBookAgeMs: number; maxSourceAgeMs: number; maxPairSkewMs: number; maxHedgeSlippageBps: number;
  queueMultiplier: number; binanceMakerFeeBps: number; lighterTakerFeeBps: number; fundingCostBpsPerHour: number | null;
};
export type CostBook = {
  venue: CostVenue; symbol: CostSymbol; nativeSymbol: string; bid: number | null; ask: number | null;
  sourceAt: number | null; receivedAt: number | null; ageMs: number | null; valid: boolean;
  sourceClockDeltaMs?: number; sourceClockUncertain?: boolean;
};
export type CostFill = {
  id: string; venue: CostVenue; side: 'buy' | 'sell'; phase: 'quote' | 'hedge'; quantity: number; price: number;
  notional: number; fee: number; at: number; sourceAt: number | null; model: string;
};
export type CostQuote = {
  id: string; side: 'buy' | 'sell'; price: number; quantity: number; remainingQuantity: number; queueAhead: number; submittedAt: number;
};
export type CostScenario = {
  id: string; symbol: CostSymbol; latencyMs: number;
  status: 'waiting' | 'quoting' | 'hedging' | 'recovering' | 'blocked' | 'stopped'; reason: string | null;
  inventory: {
    binanceQuantity: number; lighterQuantity: number; residualQuantity: number; projectedResidualQuantity: number;
    binanceAveragePrice: number | null; lighterAveragePrice: number | null; binanceNotional: number | null; utilization: number | null; limitNotional: number;
  };
  quotes: { buy: CostQuote | null; sell: CostQuote | null };
  hedge: null | { id: string; side: 'buy' | 'sell'; quantity: number; dueAt: number; attempt: number };
  stats: {
    quoteUpdates: number; makerFills: number; hedgeFills: number; hedgeFailures: number;
    binanceTurnover: number; lighterTurnover: number; fees: number; realizedPnl: number; unrealizedPnl: number | null;
    netPnl: number | null; markedCost: number | null; costPer10000: number | null;
    fundingScenarioCost: number | null; modeledCostPer10000: number | null;
  };
  valuation: { at: number | null; valid: boolean; reason: string | null; binanceMark: number | null; lighterMark: number | null };
  recentFills: CostFill[];
  history: { at: number; costPer10000: number | null; modeledCostPer10000: number | null; binanceQuantity: number; residualQuantity: number }[];
  events: { at: number; type: string; reason: string | null }[];
};
export type CostReport = {
  schema: 2; strategy: 'inventory_quotes'; sessionId: string; startedAt: number; updatedAt: number; stopped: boolean; interrupted: boolean;
  detailLevel?: 'summary' | 'full' | 'scenario';
  mode: 'paper'; sessionConfig: CostConfig; markets: unknown; books: CostBook[];
  channels: { venue: CostVenue; channel: string; symbol?: CostSymbol; state: string; reason?: string; at: number }[];
  scenarios: CostScenario[]; diagnostics: { at: number; level: string; event: string; venue: CostVenue | null; message: string; reason?: string }[]; assumptions: string[];
};
export type CostScenarioDetail = { sessionId: string; updatedAt: number; scenario: CostScenario };
export type CostArchive = { sessionId: string; startedAt: number; endedAt: number; interrupted?: boolean } &
  ({ schema: 1; unresolved: number; completed: number } | { schema: 2; makerFills: number; hasExposure: boolean });
export type CostLegacySession = {
  schema: 1; sessionId: string; startedAt: number; updatedAt: number; stopped: boolean; interrupted: boolean; completed: number; unresolved: number;
  exposures: { id: string; symbol: CostSymbol; binanceQuantity: number; lighterQuantity: number; residualQuantity: number }[];
};
export type CostSnapshot = {
  schema: 2; state: 'stopped' | 'starting' | 'running' | 'fault'; enabled: boolean; error: string | null;
  serverNow: number; config: CostConfig; report: CostReport | null; archives: CostArchive[]; legacySession: CostLegacySession | null;
  execution: { mode: 'paper'; liveAvailable: false; version: 2 };
};
