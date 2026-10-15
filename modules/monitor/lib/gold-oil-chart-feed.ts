import type { GoldOilChartData } from './gold-oil-chart-data.ts';
import { GOLD_OIL_INTERVAL_MS, goldOilUnits } from './gold-oil.ts';
import { createTrend, type MonitorTrend } from './monitor-trend.ts';

/** Retain successful pieces only within the same exchange, oil and range. */
export function mergeGoldOilChartData(previous: GoldOilChartData | null | undefined, incoming: GoldOilChartData): GoldOilChartData {
  if (!previous || previous.oilType !== incoming.oilType || previous.exchange !== incoming.exchange || previous.range !== incoming.range) return incoming;
  const history = incoming.history ?? previous.history, funding = incoming.funding ?? previous.funding;
  const retainWindow = !incoming.history && (previous.history || !incoming.funding && previous.funding);
  const historyError = incoming.history ? incoming.historyError : incoming.historyError ?? (previous.history ? '历史行情待更新' : null);
  const fundingError = incoming.funding ? incoming.fundingError : incoming.fundingError ?? (previous.funding ? '资金费历史待更新' : null);
  return { ...incoming, history, funding,
    window: retainWindow ? previous.window : incoming.window,
    fullHistory: !incoming.history && previous.history ? previous.fullHistory : incoming.fullHistory,
    fundingSourceCoverage: !incoming.funding && previous.funding ? previous.fundingSourceCoverage : incoming.fundingSourceCoverage,
    historyError, fundingError,
    state: history && funding && !historyError && !fundingError ? 'ready' : history || funding ? 'partial' : incoming.state,
  };
}

/** A one-day detail slice cannot shorten the independent seven-day overview. */
export function goldOilChartOverviewTrend(data: GoldOilChartData, previous?: MonitorTrend): MonitorTrend | undefined {
  if (data.range === '1d') return previous;
  if (!data.history) return previous && data.historyError ? { ...previous, status: 'stale' } : previous;
  const end = data.window?.end ?? 0;
  return createTrend({ status: data.history.status, fetchedAt: data.history.fetchedAt,
    points: data.history.points.flatMap(point => point.time >= end - 7 * 86_400_000 && point.ratio !== null ? [{ time: point.time, value: point.ratio }] : []),
  }, { days: 7, intervalMs: GOLD_OIL_INTERVAL_MS, label: '7 天 · 15 分钟线', shortLabel: '7天', unit: goldOilUnits(data.oilType, data.exchange).ratio }, Boolean(data.historyError));
}
