import type { PerpetualQualityReport } from './perpetual-quality.ts';
import type { QualityPairRequest } from './perpetual-quality-feed.ts';

const pairKey = (pair: QualityPairRequest) => JSON.stringify([pair.base, pair.longKey, pair.shortKey]);

/** Retain four visited pages in memory. Source timestamps are never refreshed by cache hits. */
export function createPerpetualQualityCache(limit = 120) {
  const capacity = Number.isFinite(limit) ? Math.max(1, Math.min(120, Math.trunc(limit))) : 120;
  const tracked = new Map<string, QualityPairRequest>();
  let previous: PerpetualQualityReport | null = null;
  return {
    accept(report: PerpetualQualityReport, requested: QualityPairRequest[], now = Date.now()): PerpetualQualityReport {
      const validReportTime = typeof report.generatedAt === 'number' && Number.isFinite(report.generatedAt) && report.generatedAt > 0 && report.generatedAt <= now + 5_000;
      // Quarantine invalid source times when first received; another page's newer
      // report timestamp must never make those old observations trustworthy.
      const aheadOfReport = (at: number | null) => !validReportTime || at !== null && at > report.generatedAt + 5_000;
      const next: PerpetualQualityReport = {
        ...report,
        pairs: { ...previous?.pairs }, assets: { ...previous?.assets }, assetErrors: { ...previous?.assetErrors },
        positioning: { ...previous?.positioning }, positioningErrors: { ...previous?.positioningErrors },
        positioningOverview: { ...previous?.positioningOverview },
      };
      const bases = new Set<string>(), positions = new Set<string>();
      for (const pair of requested.slice(0, 30)) {
        const key = pairKey(pair);
        tracked.delete(key); tracked.set(key, pair);
        bases.add(pair.base); positions.add(pair.longKey); positions.add(pair.shortKey);
        delete next.pairs[key];
        const history = report.pairs[key];
        if (history) {
          const badSpread = aheadOfReport(history.spread.lastAt), badFunding = aheadOfReport(history.funding.lastAt);
          const badConvergence = history.convergence && aheadOfReport(history.convergence.lastAt);
          next.pairs[key] = badSpread || badFunding || badConvergence ? {
            ...history,
            spread: badSpread ? { ...history.spread, lastAt: null } : history.spread,
            funding: badFunding ? { ...history.funding, lastAt: null } : history.funding,
            ...(badConvergence ? { convergence: { ...history.convergence!, lastAt: null } } : {}),
            ...(badSpread ? { priceSeries: undefined } : {}),
          } : history;
        }
      }
      for (const base of bases) {
        for (const overview of [previous?.positioningOverview?.[base], report.positioningOverview?.[base]]) {
          for (const item of overview?.constituents ?? []) if (item.key) positions.add(item.key);
        }
        delete next.assets[base]; delete next.assetErrors[base]; delete next.positioningOverview![base];
        const asset = report.assets[base];
        if (asset) next.assets[base] = aheadOfReport(asset.updatedAt) ? { ...asset, updatedAt: null } : asset;
        if (report.assetErrors[base]) next.assetErrors[base] = report.assetErrors[base];
        const overview = report.positioningOverview?.[base];
        if (overview && !aheadOfReport(overview.observedAt)) next.positioningOverview![base] = overview;
      }
      for (const key of positions) {
        delete next.positioning[key]; delete next.positioningErrors[key];
        const ratio = report.positioning[key];
        if (ratio) next.positioning[key] = aheadOfReport(ratio.observedAt) ? { ...ratio, observedAt: 0 } : ratio;
        if (report.positioningErrors[key]) next.positioningErrors[key] = report.positioningErrors[key];
      }
      while (tracked.size > capacity) tracked.delete(tracked.keys().next().value!);
      const keptBases = new Set<string>(), keptPositions = new Set<string>();
      for (const pair of tracked.values()) {
        keptBases.add(pair.base); keptPositions.add(pair.longKey); keptPositions.add(pair.shortKey);
        for (const item of next.positioningOverview?.[pair.base]?.constituents ?? []) if (item.key) keptPositions.add(item.key);
      }
      const prune = (record: object, keep: Set<string>) => {
        for (const key of Object.keys(record)) if (!keep.has(key)) delete (record as Record<string, unknown>)[key];
      };
      prune(next.pairs, new Set(tracked.keys()));
      for (const record of [next.assets, next.assetErrors, next.positioningOverview!]) prune(record, keptBases);
      for (const record of [next.positioning, next.positioningErrors]) prune(record, keptPositions);
      previous = next;
      return next;
    },
  };
}
