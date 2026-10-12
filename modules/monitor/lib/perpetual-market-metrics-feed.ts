import { PERPETUAL_MARKET_METRICS_REFRESH_MS, type PerpetualMarketMetric, type PerpetualMarketMetricsLeg, type PerpetualMarketMetricsReport } from "./perpetual-market-metrics.ts";
import { createPerpetualContractDataCache, perpetualContractRequestKey, startPerpetualContractDataFeed, type PerpetualContractFeedOptions } from "./perpetual-contract-data-feed.ts";

export const marketMetricsRequestKey = perpetualContractRequestKey;
export const createPerpetualMarketMetricsCache = () => createPerpetualContractDataCache<PerpetualMarketMetricsLeg>();
let browserCache: ReturnType<typeof createPerpetualMarketMetricsCache> | undefined;
function defaultCache() {
  if (typeof window === "undefined") return createPerpetualMarketMetricsCache();
  return browserCache ??= createPerpetualMarketMetricsCache();
}

const timestamp = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function isMetric(value: unknown): value is PerpetualMarketMetric {
  if (!value || typeof value !== "object") return false;
  const metric = value as PerpetualMarketMetric;
  return (metric.value === null || (Number.isFinite(metric.value) && metric.value >= 0))
    && (metric.currency === null || (typeof metric.currency === "string" && /^[A-Z0-9]{1,12}$/.test(metric.currency)))
    && (metric.observedAt === null || timestamp(metric.observedAt))
    && (metric.value === null || (metric.currency !== null && metric.observedAt !== null))
    && typeof metric.source === "string" && typeof metric.error === "string";
}

export function isPerpetualMarketMetricsReport(value: unknown): value is PerpetualMarketMetricsReport {
  if (!value || typeof value !== "object") return false;
  const report = value as PerpetualMarketMetricsReport;
  if (report.schemaVersion !== 1 || !timestamp(report.generatedAt) || (report.storageError !== undefined && typeof report.storageError !== "string") || !report.legs || typeof report.legs !== "object" || Array.isArray(report.legs) || Object.keys(report.legs).length > 60) return false;
  return Object.entries(report.legs).every(([key, leg]) => leg && leg.key === key
    && typeof leg.exchange === "string" && typeof leg.symbol === "string" && key === `${leg.exchange}:${leg.symbol}`
    && typeof leg.identity === "string" && Boolean(leg.identity) && ["pending", "ready", "error", "unsupported"].includes(leg.status)
    && (leg.fetchedAt === null || timestamp(leg.fetchedAt)) && typeof leg.error === "string"
    && isMetric(leg.volume24h) && isMetric(leg.openInterest));
}

function mergeMetric(previous: PerpetualMarketMetric, incoming: PerpetualMarketMetric) {
  return previous.value !== null && (incoming.value === null || (incoming.observedAt ?? 0) < (previous.observedAt ?? 0))
    ? { ...previous, error: incoming.error } : incoming;
}

export function startPerpetualMarketMetricsFeed(options: PerpetualContractFeedOptions<PerpetualMarketMetricsLeg>) {
  return startPerpetualContractDataFeed({ ...options, cache: options.cache ?? defaultCache() }, {
    validate: isPerpetualMarketMetricsReport,
    merge(previous, incoming) {
      if (!previous || previous.identity !== incoming.identity || incoming.status === "unsupported") return incoming;
      const volume24h = mergeMetric(previous.volume24h, incoming.volume24h), openInterest = mergeMetric(previous.openInterest, incoming.openInterest);
      const retainedBoth = volume24h.observedAt === previous.volume24h.observedAt && openInterest.observedAt === previous.openInterest.observedAt;
      return { ...incoming, volume24h, openInterest, fetchedAt: retainedBoth ? previous.fetchedAt : incoming.fetchedAt };
    },
    refreshAfter: leg => leg.status === "pending" ? 3_000 : PERPETUAL_MARKET_METRICS_REFRESH_MS,
    missingMessage: "市场指标接口未返回该合约",
    failureMessage: "成交额与持仓量暂时无法更新，保留上次数值，稍后自动重试。",
  });
}
