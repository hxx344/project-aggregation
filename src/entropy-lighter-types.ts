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
}
export interface LabReport {
  sessionConfig?: LabConfig;
  configHash?: string;
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
  config: LabConfig;
  report: LabReport | null;
}
