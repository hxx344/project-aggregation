import type { AnthropicShares, AnthropicSymbol, ExecutionConnection, ExecutionExchange, ExecutionJob, ExecutionSide } from './trading-execution-types';

export type AnthropicReductionLeg = { exchange: ExecutionExchange; symbol: AnthropicSymbol; side: ExecutionSide };
export type AnthropicReductionConfig = {
  enabled: boolean; legs: [AnthropicReductionLeg, AnthropicReductionLeg]; shares: AnthropicShares;
  thresholdPercent: string; reducePercent: string; batchCount: number; batchIntervalMs: number; timeoutMs: number;
};
export type AnthropicReductionState = {
  generatedAt: string; revision: number; config: AnthropicReductionConfig | null;
  state: {
    phase: 'disabled' | 'armed' | 'reducing' | 'completed' | 'review'; jobId: string | null;
    reason: string | null; events: { time: string; message: string }[]; triggeredAt: string | null;
    failures?: number; retryAt?: string | null;
  };
  live: null | { checkedAt: string; legs: (AnthropicReductionLeg & { quantity: string; distancePercent: string | null })[]; met: boolean; warning?: string | null };
  job: ExecutionJob | null; connections: ExecutionConnection[]; maintenance: boolean;
};
