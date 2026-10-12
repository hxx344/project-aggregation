import { PERPETUAL_FUNDING_REFRESH_MS, type PerpetualFundingHistoryReport, type PerpetualFundingLeg } from "./perpetual-funding-history.ts";
import { createPerpetualContractDataCache, perpetualContractRequestKey, startPerpetualContractDataFeed, type PerpetualContractFeedOptions } from "./perpetual-contract-data-feed.ts";

export const fundingHistoryRequestKey = perpetualContractRequestKey;

export function isFundingHistoryReport(value: unknown): value is PerpetualFundingHistoryReport {
  if (!value || typeof value !== "object") return false;
  const report = value as PerpetualFundingHistoryReport;
  const timestamp = (time: unknown) => typeof time === "number" && Number.isSafeInteger(time) && time >= 0;
  if (report.schemaVersion !== 1 || !timestamp(report.generatedAt) || (report.storageError !== undefined && typeof report.storageError !== "string") || !report.legs || typeof report.legs !== "object" || Array.isArray(report.legs) || Object.keys(report.legs).length > 60) return false;
  return Object.entries(report.legs).every(([key, leg]) => {
    if (!leg || leg.key !== key || typeof leg.exchange !== "string" || typeof leg.symbol !== "string" || typeof leg.identity !== "string" || !leg.identity
      || key !== `${leg.exchange}:${leg.symbol}` || !["pending", "ready", "error", "unsupported"].includes(leg.status)
      || (leg.fetchedAt !== null && !timestamp(leg.fetchedAt)) || typeof leg.error !== "string"
      || (leg.backfillComplete !== undefined && typeof leg.backfillComplete !== "boolean")
      || (leg.nextRefreshAt !== undefined && !timestamp(leg.nextRefreshAt)) || (leg.cacheUpdatedAt !== undefined && !timestamp(leg.cacheUpdatedAt))
      || (leg.coverage !== null && (!timestamp(leg.coverage?.from) || !timestamp(leg.coverage?.to) || leg.coverage.from > leg.coverage.to))
      || !Array.isArray(leg.records) || leg.records.length > 2000 || (!leg.coverage && (leg.records.length > 0 || leg.status === "ready"))) return false;
    const times = new Set<number>();
    return leg.records.every(record => {
      if (!record || !timestamp(record.time) || !Number.isFinite(record.rate) || Math.abs(record.rate) > 1 || !leg.coverage
        || record.time < leg.coverage.from || record.time > leg.coverage.to || times.has(record.time)) return false;
      times.add(record.time); return true;
    });
  });
}

export const createPerpetualFundingHistoryCache = () => createPerpetualContractDataCache<PerpetualFundingLeg>();
let browserCache: ReturnType<typeof createPerpetualFundingHistoryCache> | undefined;
function defaultCache() {
  if (typeof window === "undefined") return createPerpetualFundingHistoryCache();
  return browserCache ??= createPerpetualFundingHistoryCache();
}

export function startPerpetualFundingHistoryFeed(options: PerpetualContractFeedOptions<PerpetualFundingLeg>) {
  return startPerpetualContractDataFeed({ ...options, cache: options.cache ?? defaultCache() }, {
    validate: isFundingHistoryReport,
    merge(previous, incoming) {
      if (!previous?.coverage || previous.identity !== incoming.identity || incoming.status === "unsupported") return incoming;
      // Backfill can extend `from` without advancing `to`. Preserve an older full
      // range only when the incoming snapshot loses coverage, not when it adds it.
      if (!incoming.coverage || incoming.coverage.to < previous.coverage.to
        || (incoming.coverage.to === previous.coverage.to && incoming.coverage.from > previous.coverage.from)) {
        return { ...previous, status: incoming.status, error: incoming.error, backfillComplete: incoming.backfillComplete ?? previous.backfillComplete };
      }
      return incoming;
    },
    refreshAfter: leg => leg.status !== "unsupported" && (leg.status === "pending" || leg.backfillComplete === false) ? 3_000 : PERPETUAL_FUNDING_REFRESH_MS,
    missingMessage: "历史结算接口未返回该合约",
    failureMessage: "历史结算暂时无法更新，保留上次记录，稍后自动重试。",
  });
}
