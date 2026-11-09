import type { OilSymbol, TradingAccountMode, TradingExchange } from './trading-types';

export type ExecutionMarket = 'oil' | 'hynix' | 'anthropic';
/** Anthropic pre-IPO contracts: Binance/OKX ANTHROPICUSDT, Hyperliquid HIP-3 io:ANTH (Entropy) and xyz:ANT (trade.xyz), Lighter RH ANTHROPIC. */
export type AnthropicSymbol = 'ANTHROPICUSDT' | 'io:ANTH' | 'xyz:ANT' | 'ANTHROPIC';
export type ExecutionSymbol = OilSymbol | 'SKHYUSDT' | 'SKHYNIXUSDT' | AnthropicSymbol;
/** Live trading venues: the read-only venues plus Hyperliquid (API wallet) and Lighter on Robinhood Chain (API key). */
export type ExecutionExchange = TradingExchange | 'hyperliquid' | 'rh-lighter';
/** Hyperliquid connects an API (agent) wallet, Lighter RH an account API key; the other venues keep their account modes. */
export type ExecutionAccountMode = TradingAccountMode | 'agent' | 'api-key';
/** Share-count assumptions in billions; editable, they are estimates until the listing documents fix them. */
export type AnthropicShares = { outstanding: string; diluted: string };
export type ExecutionLeverage = { type: 'cross' | 'isolated'; value: number };
export type ExecutionPreset = 'four-leg' | 'same-exchange' | 'cross-exchange';
export type ExecutionAction = 'open' | 'close';
export type ExecutionSide = 'long' | 'short';
export type ExecutionConnection = {
  exchange: ExecutionExchange; connected: boolean; revision: number; accountMode: ExecutionAccountMode;
  identity: string | null; keyLabel: string | null; verifiedAt: string | null; locked: boolean;
};
export type ExecutionPosition = {
  exchange: ExecutionExchange; symbol: ExecutionSymbol; side: ExecutionSide; quantity: string; fetchedAt: string;
};
/** chase: passive limit order that follows the book; market: one taker order per batch. */
export type ExecutionOrderType = 'chase' | 'market';
export type ExecutionLegInput = {
  exchange: ExecutionExchange; symbol: ExecutionSymbol; side: ExecutionSide; quantity: string;
  orderType: ExecutionOrderType;
  /** Chase limit; null = follow the book without a limit. Always null for market legs. */
  stopPrice: string | null;
};
/** With equalSize the server sizes every leg: oil in barrels, SK hynix in USDT notional, Anthropic in estimated shares. */
export type ExecutionPlanInput = {
  market: ExecutionMarket; preset: ExecutionPreset; action: ExecutionAction;
  legs: (Omit<ExecutionLegInput, 'quantity' | 'stopPrice'> & { quantity?: string; stopPrice?: string })[]; equalSize?: string;
  /** Required for Anthropic, refused for every other market. */
  shares?: AnthropicShares;
  batchCount: number; batchIntervalMs: number; repriceIntervalMs: number; timeoutMs: number;
};
export type ExecutionPreviewLeg = ExecutionLegInput & {
  id: string; orderSide: 'buy' | 'sell'; positionMode: 'one-way' | 'hedge'; accountRevision: number;
  currentQuantity: string; batchQuantities: string[]; estimatedNotional: string;
  bid: string; ask: string; quoteAt: string;
  rule?: { instrumentId?: string; quantityUnit?: string; contractSize?: string; quoteAsset?: string };
  /** Hyperliquid only: the account's current margin mode and leverage, which this hub never changes. */
  leverage?: ExecutionLeverage;
};
export type ExecutionPreview = {
  id: string; expiresAt: string; market: ExecutionMarket; equalSize: string | null; preset: ExecutionPreset; action: ExecutionAction; resumeJobId?: string | null;
  shares?: AnthropicShares;
  batchCount: number; batchIntervalMs: number; repriceIntervalMs: number; timeoutMs: number;
  connections: ExecutionConnection[]; legs: ExecutionPreviewLeg[]; notes: string[];
};
export type ExecutionOrder = {
  id: string | null; clientId: string | null; kind: 'order' | 'strategy'; state: string;
  lastCheckedAt: string | null; price: string | null; filledQuantity: string; unknown: boolean;
  /** Bybit strategy without an ID: earliest time it can be confirmed as not created. */
  confirmAfter?: string;
};
export type ExecutionJob = {
  id: string; market: ExecutionMarket; preset: ExecutionPreset; action: ExecutionAction;
  status: 'queued' | 'running' | 'stopping' | 'paused' | 'attention' | 'completed' | 'stopped';
  createdAt: string; updatedAt: string; deadlineAt: string; batchIndex: number; batchCount: number;
  reason: string | null; canResume: boolean;
  /** Set when an automatic threshold rule created the job. */
  auto?: { ruleId: string; action: ExecutionAction; unsent?: true };
  legs: (ExecutionLegInput & {
    id: string; orderSide: 'buy' | 'sell'; filledQuantity: string; remainingQuantity: string;
    currentOrder: ExecutionOrder | null;
  })[];
  events: { time: string; message: string }[];
};
export type ExecutionState = {
  generatedAt: string; connections: ExecutionConnection[]; positions: ExecutionPosition[]; jobs: ExecutionJob[];
};
/** The exact submission, including idempotent retries outside the recent history page. */
export type ExecutionSubmission = ExecutionState & { acceptedJob: ExecutionJob };

/** One top-of-book read; a failed read carries only `error`. */
export type ExecutionQuoteBook = { exchange: ExecutionExchange; symbol: ExecutionSymbol; bid?: string; ask?: string; at?: string; error?: string };
export type ExecutionQuotes = { generatedAt: string; maxAgeMs: number; books: ExecutionQuoteBook[] };

/** Automatic rules cover the fixed-pair markets only; Anthropic is manual. */
export type AutoMarket = Exclude<ExecutionMarket, 'anthropic'>;
export type AutoDirection = 'short' | 'long';
export type AutoPhase = 'idle' | 'opening' | 'holding' | 'closing' | 'review';
export type AutoRuleConfig = {
  name: string; market: AutoMarket; exchange: TradingExchange; direction: AutoDirection;
  /** Oil: BZ − CL in USDT per barrel. SK hynix: ADR premium over ordinary ÷ 10 in percent. */
  openThreshold: string; closeThreshold: string; equalSize: string; orderType: ExecutionOrderType;
  confirmSamples: number; maxOpensPerDay: number; batchCount: number; batchIntervalMs: number; repriceIntervalMs: number; timeoutMs: number;
};
export type AutoRule = {
  id: string; revision: number; enabled: boolean; mode: 'live' | 'observe'; observing: boolean; createdAt: string; title: string; config: AutoRuleConfig;
  spread: { label: string; unit: string };
  state: {
    phase: AutoPhase; jobId: string | null; held: { exchange: TradingExchange; symbol: ExecutionSymbol; side: ExecutionSide; quantity: string }[] | null;
    opensToday: number; failures: number; retryAt: string | null; reason: string | null; events: { time: string; message: string }[];
  };
  /** In-memory reading of the next action's executable spread; null until the rule is checked. */
  live: { hits: number; value: number | null; met: boolean; side: 'sell' | 'buy' | null; at: string | null; note: string | null } | null;
  observation: { open: AutoRule['live']; close: AutoRule['live']; note: string | null; events: { time: string; message: string; kind: 'reset' | 'signal'; action?: 'open' | 'close'; value?: number; hits?: number; threshold?: string; revision?: number; inputs?: { premiumAt: string; baseAt: string } }[] };
};
export type AutoState = { generatedAt: string; exposureVersion: string; maintenance: boolean; rules: AutoRule[] };
