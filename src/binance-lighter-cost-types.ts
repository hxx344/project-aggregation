export type CostSymbol = 'BTC' | 'ETH';
export type CostVenue = 'binance' | 'lighter';
export type CostConfig = {
  schema: 1; symbols: CostSymbol[]; latencyScenarios: number[];
  notionalPerLeg: number; makerWaitMs: number; holdMs: number; hedgeWaitMs: number; cooldownMs: number;
  maxBookAgeMs: number; maxSourceAgeMs: number; maxPairSkewMs: number; maxHedgeSlippageBps: number;
  queueMultiplier: number; binanceMakerFeeBps: number; lighterTakerFeeBps: number; fundingCostBpsPerHour: number | null;
};
export type CostBook = {
  venue: CostVenue; symbol: CostSymbol; nativeSymbol: string; bid: number | null; ask: number | null;
  sourceAt: number | null; receivedAt: number | null; ageMs: number | null; valid: boolean;
  sourceClockDeltaMs?: number; sourceClockUncertain?: boolean;
};
export type CostFill = {
  id: string; venue: CostVenue; side: 'buy' | 'sell'; phase: string; quantity: number; price: number;
  notional: number; fee: number; at: number; sourceAt: number | null; model: string;
};
export type CostRound = {
  id: string; startedAt: number; endedAt: number | null; outcome: string; reason: string | null; quantity: number;
  binanceTurnover: number; fees: number; tradingPnl: number | null; tradingCost: number | null;
  costPer10000: number | null; fundingScenarioCost: number | null; modeledCostPer10000: number | null; fills: CostFill[];
};
export type CostScenario = {
  id: string; symbol: CostSymbol; direction: 'buy' | 'sell'; latencyMs: number; status: string; reason: string | null;
  task: null | {
    id: string; startedAt: number; phase: string; targetQuantity: number; binanceQuantity: number;
    lighterQuantity: number; residualQuantity: number;
    maker: null | { side: 'buy' | 'sell'; price: number; remainingQuantity: number; queueAhead: number };
    pendingHedges: { id: string; phase: string; side: 'buy' | 'sell'; quantity: number; dueAt: number }[];
  };
  stats: {
    attempts: number; completed: number; unfilled: number; unresolved: number;
    binanceTurnover: number; closedBinanceTurnover: number; fees: number; closedFees: number;
    tradingPnl: number; tradingCost: number; costPer10000: number | null;
    fundingScenarioCost: number | null; modeledCostPer10000: number | null;
  };
  recentRounds: CostRound[];
  history: { at: number; costPer10000: number | null; modeledCostPer10000: number | null }[];
};
export type CostReport = {
  schema: 1; sessionId: string; startedAt: number; updatedAt: number; stopped: boolean; interrupted: boolean;
  detailLevel?: 'summary';
  mode: 'paper'; sessionConfig: CostConfig; markets: unknown; books: CostBook[];
  channels: { venue: CostVenue; channel: string; symbol?: CostSymbol; state: string; reason?: string; at: number }[];
  scenarios: CostScenario[]; diagnostics: { at: number; level: string; event: string; venue: CostVenue | null; message: string; reason?: string }[]; assumptions: string[];
};
export type CostScenarioDetail = { sessionId: string; updatedAt: number; scenario: CostScenario };
export type CostArchive = { sessionId: string; startedAt: number; endedAt: number; unresolved: number; completed: number; interrupted?: boolean };
export type CostSnapshot = {
  schema: 1; state: 'stopped' | 'starting' | 'running' | 'fault'; enabled: boolean; error: string | null;
  serverNow: number; config: CostConfig; report: CostReport | null; archives: CostArchive[];
  execution: { mode: 'paper'; liveAvailable: false; version: 1 };
};
