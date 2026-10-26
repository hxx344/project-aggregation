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
