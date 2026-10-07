import type { OilSymbol, TradingAccountMode, TradingExchange } from './trading-types';

export type ExecutionPreset = 'four-leg' | 'same-exchange' | 'cross-exchange';
export type ExecutionAction = 'open' | 'close';
export type ExecutionSide = 'long' | 'short';
export type ExecutionConnection = {
  exchange: TradingExchange; connected: boolean; revision: number; accountMode: TradingAccountMode;
  identity: string | null; keyLabel: string | null; verifiedAt: string | null; locked: boolean;
};
export type ExecutionPosition = {
  exchange: TradingExchange; symbol: OilSymbol; side: ExecutionSide; quantity: string; fetchedAt: string;
};
export type ExecutionLegInput = {
  exchange: TradingExchange; symbol: OilSymbol; side: ExecutionSide; quantity: string; stopPrice: string;
};
export type ExecutionPlanInput = {
  preset: ExecutionPreset; action: ExecutionAction; legs: ExecutionLegInput[];
  batchCount: number; batchIntervalMs: number; repriceIntervalMs: number; timeoutMs: number;
};
export type ExecutionPreviewLeg = ExecutionLegInput & {
  id: string; orderSide: 'buy' | 'sell'; positionMode: 'one-way' | 'hedge'; accountRevision: number;
  currentQuantity: string; batchQuantities: string[]; estimatedNotional: string;
  bid: string; ask: string; quoteAt: string;
};
export type ExecutionPreview = {
  id: string; expiresAt: string; preset: ExecutionPreset; action: ExecutionAction; resumeJobId?: string | null;
  batchCount: number; batchIntervalMs: number; repriceIntervalMs: number; timeoutMs: number;
  connections: ExecutionConnection[]; legs: ExecutionPreviewLeg[]; notes: string[];
};
export type ExecutionOrder = {
  id: string | null; clientId: string | null; kind: 'order' | 'strategy'; state: string;
  lastCheckedAt: string | null; price: string | null; filledQuantity: string; unknown: boolean;
};
export type ExecutionJob = {
  id: string; preset: ExecutionPreset; action: ExecutionAction;
  status: 'queued' | 'running' | 'stopping' | 'paused' | 'attention' | 'completed' | 'stopped';
  createdAt: string; updatedAt: string; deadlineAt: string; batchIndex: number; batchCount: number;
  reason: string | null; canResume: boolean;
  legs: (ExecutionLegInput & {
    id: string; orderSide: 'buy' | 'sell'; filledQuantity: string; remainingQuantity: string;
    currentOrder: ExecutionOrder | null;
  })[];
  events: { time: string; message: string }[];
};
export type ExecutionState = {
  generatedAt: string; connections: ExecutionConnection[]; positions: ExecutionPosition[]; jobs: ExecutionJob[];
};
