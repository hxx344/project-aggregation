export type Quote = {
  exchange: string; symbol: string; base: string; bid: number; ask: number;
  bidAskAt: number; quoteCurrency: string; settlementCurrency?: string; contractKind?: string;
};
export type FeeRule = { exchange: string; symbol: string; makerBps: number; takerBps: number; source: string; updatedAt: number | null };
export type ExecutionScenario = 'normal' | 'partial' | 'reject-short' | 'unknown-short' | 'cancel-delay' | 'cancel-reject';
export type Config = {
  enabled: boolean; entryPaused: boolean; monitorUrl: string; monitorUsername: string;
  hasMonitorPassword?: boolean; notionalPerLeg: number; maxOpen: number;
  maxTotalNotional: number; feeBps: number; feeSchedule: FeeRule[]; slippageBps: number;
  minNetBps: number; takeProfitBps: number; stopLossBps: number; maxHoldMinutes: number;
  cooldownSeconds: number; executionMode: 'atomic' | 'staged'; executionScenario: ExecutionScenario;
  executionSeed: number; executionDelayMs: number; clipNotional: number; partialFillPct: number;
  repairAttempts: number; fundingEnabled: boolean; depthRefreshSeconds: number; historySampleSeconds: number;
};
export type FeeRate = { bps: number; source: string; updatedAt: number | null };
export type FeeSnapshot = { long: { entry: FeeRate; exit: FeeRate }; short: { entry: FeeRate; exit: FeeRate } };
export type TransferEligibility = { state: 'verified' | 'blocked' | 'disabled' | 'unverified'; reason: string; networks: string[]; checkedAt: number | null; expiresAt: number | null };
export type Opportunity = {
  id: string; pairKey: string; base: string; long: Quote; short: Quote; grossBps: number | null;
  netBps: number | null; eligible: boolean; reason: string; observedAt: number; warnings?: string[];
  feeSnapshot?: FeeSnapshot;
  expiresAt: number; transfer: TransferEligibility;
};
export type Valuation = {
  at: number | null; stale: boolean; net: number | null; netWithFunding?: number | null;
  gross?: number; grossAtEntryFx?: number; fxImpact?: number; exitFees?: number; reason?: string; quoteTimes?: { long: number | null; short: number | null };
};
export type FundingRate = {
  rate: number | string | null; intervalHours: number | null; nextFundingAt: number | null; sourceAt: number | null;
  source?: string;
};
export type Funding = {
  status: 'complete' | 'partial' | 'unknown' | 'legacy'; confirmed: number | null;
  known: number; estimated: number | null; through: number | null;
  current: { long: FundingRate | null; short: FundingRate | null }; reason?: string;
};
export type ExitQuote = {
  at: number; sourceAt: number | null; stale: boolean; complete: boolean;
  net: number | null; priceOnlyNet: number | null; reason?: string;
  longQuantity: number; shortQuantity: number; slippageBps: { long: number; short: number };
};
export type Fill = { price: number | null; quantity: number; notional: number; notionalUSDT?: number; status?: string };
export type Position = {
  id: string; base: string; long: Quote; short: Quote; openedAt: number; closedAt?: number;
  quantity: number; longQuantity?: number | string; shortQuantity?: number | string; executionId?: string;
  longFill: Fill; shortFill: Fill; entryFees: number; feeBps: number; feeSnapshot?: FeeSnapshot;
  valuation: Valuation; funding?: Funding; exitQuote?: ExitQuote;
  result?: { net: number; gross: number; grossAtEntryFx?: number; fxImpact?: number; exitFees: number; netWithFunding?: number | null };
  reason?: string; unverifiedConstraints?: string[];
};
export type Execution = {
  id: string; kind: 'open' | 'close'; positionId: string; base: string;
  state: 'queued' | 'executing' | 'repairing' | 'completed' | 'blocked' | 'cancel_pending' | 'cancelled';
  scenario: ExecutionScenario; createdAt: number; updatedAt: number; nextAt: number | null;
  attempts: number; error?: string; longQuantity: number; shortQuantity: number; orderCount?: number; fillCount?: number;
  targetQuantity: number; reservedNotional: number; unhedgedSince?: number | null; repairCost: number; worstLoss?: number; maxUnhedgedMs?: number;
  orders: { id: string; leg: string; side: string; state: string; quantity: number; filledQuantity: number; price?: number; at: number }[];
  fills: { id: string; leg: string; side: string; quantity: number; price: number; notional: number; fee: number; at: number; kind: string }[];
};
export type EquitySample = {
  at: number; sourceAt: number | null; realized: number; unrealized: number | null;
  equity: number | null; priceOnlyEquity: number | null; drawdown: number | null;
};
export type PositionSeries = {
  positionId: string; base: string; maxAdverseSpreadBps: number | null; maxExitSpreadBps?: number | null;
  samples: { at: number; sourceAt: number | null; spreadBps: number | null; net: number | null }[];
};
export type Analytics = {
  samples: EquitySample[]; maxDrawdown: number | null; latestAt: number | null;
  retainedFrom: number | null; sampleSeconds: number; positions: PositionSeries[];
};
export type State = {
  now: number; csrfToken: string; venues: { id: string; state: string; quoteCount: number }[];
  fx: { currency: string; state: string; bid?: number; ask?: number; at?: number; error?: string }[];
  config: Config;
  source: { state: string; error: string | null; updatedAt: number | null; checkedAt: number | null; generatedAt?: number | null; receivedAt?: number | null; durationMs?: number | null; quoteCount: number; entryPolicy?: { requireSpotTransfer: boolean; blockedBases: string[]; excluded: number; revision?: number } | null };
  catalog: { state: string; count: number; updatedAt: number | null; error: string | null };
  totals: {
    openCount: number; closedCount: number; usedNotional: number; realizedPnl: number;
    unrealizedPnl: number | null; stalePositions: number; fundingKnown: number; fundingComplete: boolean;
    realizedWithFunding: number | null; unrealizedWithFunding: number | null; netWithFunding: number | null;
    reservedNotional: number; activeExecutions: number;
  };
  opportunities: Opportunity[]; positions: Position[]; executions: Execution[];
  history: Position[]; analytics?: Analytics; events: { at: number; message: string }[];
};
