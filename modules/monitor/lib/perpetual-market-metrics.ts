import { MARKET_METRICS_POLL_MS } from '../modules/perpetual/collection-policy.mjs';

export const PERPETUAL_MARKET_METRICS_REFRESH_MS = MARKET_METRICS_POLL_MS;
// Observation cadence does not change five-minute source publications.
export const PERPETUAL_MARKET_METRICS_STALE_MS = 615_000;

/** Amounts retain the source denomination; stablecoins are not silently USD. */
export interface PerpetualMarketMetric {
  value: number | null;
  currency: string | null;
  observedAt: number | null;
  source: string;
  error: string;
}
export interface PerpetualMarketMetricsLeg {
  key: string;
  exchange: string;
  symbol: string;
  identity: string;
  status: 'pending' | 'ready' | 'error' | 'unsupported';
  fetchedAt: number | null;
  volume24h: PerpetualMarketMetric;
  openInterest: PerpetualMarketMetric;
  error: string;
}
export interface PerpetualMarketMetricsReport {
  schemaVersion: 1;
  generatedAt: number;
  legs: Record<string, PerpetualMarketMetricsLeg>;
  storageError?: string;
}
export interface PerpetualMarketMetricsPairRequest { base: string; longKey: string; shortKey: string }
