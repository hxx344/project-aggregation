export type LabSymbol = 'SNDK' | 'ANTH';
export type LabTime = number | string;
export interface LabConfig {
  schema: 1;
  region: string;
  recordRaw: boolean;
  maxDataMb: number;
  retentionDays: number;
  maxBookAgeMs: number;
  maxSourceAgeMs: number;
  maxPairSkewMs: number;
  sampleIntervalMs: number;
  simulation: {
    enabled: boolean;
    verifiedSymbols: LabSymbol[];
    entropyTakerFeeBps: number | null;
    lighterTakerFeeBps: number | null;
    notionalPerLeg: number;
    minEntryEdgeBps: number;
    slippageBpsPerFill: number;
    fundingReserveBpsPerRoundTrip: number;
    holdMs: number;
    fillWaitMs: number;
    cooldownMs: number;
    rebateRatios: number[];
    latencyScenarios: { name: string; entropyMs: number; lighterMs: number }[];
  };
}
export interface LabSpread {
  at: LabTime;
  midBasisBps: number | null;
  takerEdgeBps: number | null;
  buy: string | null;
  sell: string | null;
  sourceClockUncertain: boolean;
  quality?: string;
}
export interface LabQuote {
  venue: string;
  symbol: LabSymbol;
  nativeSymbol: string;
  bid: number | null;
  ask: number | null;
  receivedAt: LabTime;
  sourceAt: LabTime | null;
  sourceClockUncertain: boolean;
  receiveAgeMs?: number | null;
  executionQuality?: string | null;
}
export interface LabFeeFact {
  status: 'available' | 'unavailable';
  takerFeeBps: number | null;
  baseTakerBps: number | null;
  growthMultiplier: number | null;
  deployerFeeScale: number | null;
  scope: 'public_default_tier_no_builder';
  accountTier: 'default' | 'standard';
  sourceUrls: string[];
  fetchedAt: number;
  expiresAt: number;
  revision: string | null;
  reason: string | null;
  assumptions: string[];
}
export interface LabFeeSnapshot {
  mode: 'auto';
  symbol: LabSymbol;
  status: 'available' | 'unavailable' | 'expired';
  revision: string | null;
  entropy: LabFeeFact | null;
  lighter: LabFeeFact | null;
  takerBps: { entropy: number | null; lighter: number | null };
  fetchedAt: number | null;
  expiresAt: number | null;
  rebateBasis: 'total_entropy_fees';
  rebateRatios: [1.1, 1.2];
}
export interface LabEvaluation {
  at: number;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  buyNotional: number;
  sellNotional: number;
  grossCash: number;
  grossBps: number;
  costs: { feesRoundTripCash: number | null; exitSlippageReserveCash: number; fundingReserveCash: number; totalReserveCash: number | null };
  surplusBeforeRebateCash: number | null;
  surplusBeforeRebateBps: number | null;
  entropyRoundTripFeesCash?: number | null;
  rebates?: { ratio: number; contingentRebateCash: number | null; surplusCash: number | null }[];
  feeSnapshot?: LabFeeSnapshot;
  gatePassed: boolean;
  sourceTimeUncertain: boolean;
}
export interface LabInsightMetrics {
  name?: string;
  feeRevision?: string | null;
  buy: string;
  sell: string;
  scenario: { name: string; entropyMs: number; lighterMs: number } | null;
  attempts: number;
  completed: number;
  failed: number;
  costed: number;
  passedAfterCosts: number;
  spanMs: number;
  qualitySpanMs?: number;
  qualityFirstAt?: number | null;
  qualityLastAt?: number | null;
  latest: LabEvaluation | null;
  completionRate?: number | null;
  passRate?: number | null;
  meanSurplusBps?: number | null;
  sampleReady?: boolean;
}
export interface LabSymbolInsight {
  status: 'paper_candidate' | 'no_edge' | 'latency_erases_edge' | 'insufficient_samples' | 'unknown_costs' | 'verify_equivalence' | 'waiting' | 'stale' | 'stopped' | 'blocked';
  title: string;
  reason: string;
  direction: { buy: string; sell: string } | null;
  raw: LabEvaluation | null;
  rawMetrics: LabInsightMetrics | null;
  delayed: LabInsightMetrics[];
  bestDelayed: LabInsightMetrics | null;
  notional: { buyCash: number | null; sellCash: number | null; approxRoundTripTurnoverCash: number | null };
  blockers: string[];
  nextSteps: string[];
  caveat: string;
}
export interface LabInsights {
  asOf: number | null;
  reportAgeMs: number | null;
  reportCurrent: boolean;
  evidenceMaxAgeMs: number;
  summary: { status: string; title: string; reason: string };
  bySymbol: Partial<Record<LabSymbol, LabSymbolInsight>>;
  leader: { status: string; title: string; reason: string; samples: number; nextSteps: string[] };
  paper: { scope: 'all_symbols'; unresolved: boolean; openTasks: number };
}
export interface LabReport {
  binanceScalper?: LabBinanceScalper;
  observedAt?: number;
  observation?: { asOf: number; silenceAfterMs: number };
  sessionConfig?: LabConfig;
  configHash?: string;
  automaticFees?: {
    mode: 'auto';
    rebateBasis: 'total_entropy_fees';
    rebateRatios: [1.1, 1.2];
    bySymbol: Partial<Record<LabSymbol, LabFeeSnapshot>>;
  };
  session: string;
  mode: 'research' | 'paper';
  startedAt: string;
  heartbeatAt: string;
  stopped: boolean;
  paperSuspendedReason: string | null;
  counts: { books: number; candidates: number; invalidated: number; rejected: Record<string, number> };
  basis: Partial<Record<LabSymbol, { samples: number; meanBps: number; minBps: number; maxBps: number }>>;
  paper: Record<string, {
    completed: number;
    failedLegs: number;
    unresolved: number;
    openTasks: number;
    lossesBeforeRebate: number;
    grossPnl: number | null;
    fees: number;
    costReserve: number;
    netBeforeRebate: number | null;
    turnover: { entropy: number; lighter: number };
    rebateScenarios: { ratio: number; contingentRebate: number; net: number | null }[];
  }>;
  leaderMarkouts: Record<string, { samples: number; directionHitRate: number; meanSignedMoveBps: number }>;
  diagnostics: {
    counts: Record<string, number>;
    last: Record<string, { at?: LabTime; message?: string; reason?: string; details?: { reason?: string } }>;
    rttMs: Record<string, number[]>;
  };
  eventLoopDelayMs: { p50: number; p95: number; p99: number };
  assumptions: Record<string, string>;
  latestQuotes: LabQuote[];
  recentSpreads: Partial<Record<LabSymbol, LabSpread[]>>;
}
export interface LabScalperRebate {
  ratio: number;
  contingentRebate: number;
  net: number | null;
}
export interface LabScalperFeeSnapshot {
  mode: 'auto_entropy';
  symbol: LabSymbol;
  status: 'available' | 'unavailable' | 'expired';
  revision: string | null;
  takerBps: number | null;
  entropy: LabFeeFact | null;
  fetchedAt: number | null;
  expiresAt: number | null;
  rebateBasis: 'total_entropy_fees';
  rebateRatios: [1.1, 1.2];
}
export interface LabScalperTrade {
  id: string;
  at: number;
  direction: 'long' | 'short';
  outcome: 'completed' | 'failed_entry' | 'unresolved';
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  durationMs: number | null;
  grossPnl: number | null;
  fees: number;
  costReserve: number;
  netBeforeRebate: number | null;
  turnover: number;
  rebateScenarios: LabScalperRebate[];
  feeSnapshot?: LabScalperFeeSnapshot;
}
export interface LabScalperScenario {
  name: string;
  entropyMs: number;
  state: 'waiting' | 'armed' | 'entry_pending' | 'holding' | 'exit_pending' | 'cooldown' | 'unresolved';
  reason: string | null;
  armed: { at: number; upper: number; lower: number; sequence: number | string } | null;
  position: {
    direction: 'long' | 'short';
    triggerPrice: number;
    signalAt: number;
    entryAt: number | null;
    entryPrice: number | null;
    quantity: number;
    entryCash: number | null;
    entryDueAt?: number;
    exitDueAt?: number | null;
    exitIntent?: { reason: string; [key: string]: unknown } | null;
    feeSnapshot?: LabScalperFeeSnapshot;
  } | null;
  stats: {
    signals: number;
    completed: number;
    failedEntries: number;
    unresolved: number;
    lossesBeforeRebate: number;
    turnover: number;
    fees: number;
    costReserve: number;
    settledGrossPnl?: number;
    settledNetBeforeRebate?: number;
    grossPnl: number | null;
    netBeforeRebate: number | null;
    hasOpenExposure: boolean;
    nonLossRateBeforeRebate?: number | null;
    rebateScenarios: LabScalperRebate[];
  };
  recentTrades: LabScalperTrade[];
  lastEventAt: number | null;
}
export interface LabBinanceScalper {
  schema: 1;
  strategy: 'binance_depth4_entropy_taker';
  mode: 'directional_research';
  enabled: boolean;
  suspendedReason: string | null;
  observedAt: number;
  previousSession?: { session: string; stopped: boolean; heartbeatAt: string | null };
  policy: {
    level: 4;
    maxHoldMs: number;
    cooldownMs: number;
    notionalPerTrade: number;
    slippageBpsPerFill: number;
    fundingReserveBpsPerRoundTrip: number;
    latency: 'assumed';
    entry: string;
    exit: string;
  };
  bySymbol: Partial<Record<LabSymbol, {
    leader?: { status: 'available' | 'unavailable'; nativeSymbol: string | null; identityVerified: boolean; settlementEquivalence: string | boolean; reason: string | null };
    scenarios: Record<string, LabScalperScenario>;
  }>>;
  openTasks: unknown[];
  assumptions: Record<string, unknown>;
}
export interface LabSnapshot {
  schema: 1;
  enabled: boolean;
  state: 'starting' | 'running' | 'stopped' | 'fault';
  error: string | null;
  heartbeatAt: string | null;
  stale: boolean;
  serverNow?: number;
  reportAgeMs?: number | null;
  insights?: LabInsights;
  config: LabConfig;
  report: LabReport | null;
}
