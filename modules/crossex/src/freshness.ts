import type { Opportunity, State, Valuation } from './types';

export const STATE_POLL_MS = 2000;
const expired = (at: number | null | undefined, now: number) => !Number.isFinite(at) || !at || now - at > 10000 || at > now + 1000;

/** Use server time plus monotonic elapsed time, independent of the user's clock.
 * Charging the entire request duration is conservative: slow responses never
 * make the data appear younger than it was when the server returned it. */
export function createServerClock(monotonic = () => performance.now()) {
  let serverAt = 0, sampledAt = monotonic();
  return {
    sample(now: number, requestStartedAt: number) {
      sampledAt = monotonic();
      serverAt = now + Math.max(0, sampledAt - requestStartedAt);
    },
    now: () => serverAt + Math.max(0, monotonic() - sampledAt),
  };
}

export function sourceIsStale(source: State['source'] | undefined, now: number, online: boolean) {
  return !online || !source || !['live', 'partial'].includes(source.state) || expired(source.updatedAt, now) || expired(source.generatedAt ?? source.updatedAt, now);
}

/** A still-live source must not keep an individual signal or its evidence alive. */
export function opportunityStaleReason(row: Opportunity, now: number) {
  if (row.transfer?.state === 'verified' && (!Number.isFinite(row.transfer.expiresAt) || now >= row.transfer.expiresAt!)) return '现货与充提证据已到期，等待重新核验';
  if (!Number.isFinite(row.expiresAt) || now >= row.expiresAt) return '机会已到期，等待新信号';
  return '';
}

export function valuationStaleReason(value: Valuation, now: number, sourceStale: boolean) {
  if (value.stale) return value.reason || '持仓报价暂不可用，等待更新';
  if (sourceStale) return '行情来源暂不可用，保留上次估值';
  if (expired(value.at, now)) return '持仓盘口超过 10 秒，等待新估值';
  return '';
}
