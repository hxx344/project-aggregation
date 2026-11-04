import { FIRST_FUNDING_SETTLEMENT, FUNDING_HOUR, type SettledFundingRow } from "./hynix-funding-history.ts";

export type FundingChartPoint = { time: number; shortRate: number | null; longRate: number | null; shortCumulative: number | null; longCumulative: number | null; shortAnnualized: number | null; longAnnualized: number | null; adr: number | null; ordinary: number | null; count: number };
/**
 * Settled two-leg funding over equal notionals. Each row holds the per-settlement rate of
 * leg A (`adr`) and leg B (`ordinary`); "short" is short A / long B. Rates are shown per hour
 * and annualized over the covered settlement hours, never compounded and never zero-filled.
 */
export function analyzeSettledFunding(rows: SettledFundingRow[], days: number | null, endTime: number, { intervalMs, firstSettlement }: { intervalMs: number; firstSettlement: number }) {
  const hours = intervalMs / 3_600_000;
  const end = Math.floor(endTime / intervalMs) * intervalMs;
  // N days contain exactly N*24/hours settlements, not an extra boundary settlement.
  const start = days === null ? firstSettlement : Math.max(firstSettlement, end - (days * 24 / hours - 1) * intervalMs);
  const selected = rows.filter(row => row.time >= start && row.time <= end);
  const chart: FundingChartPoint[] = [];
  let cumulative = 0, count = 0;
  const yearly = (sum: number, settlements: number) => sum / (settlements * hours) * 24 * 365;
  const gap = (time: number): FundingChartPoint => ({ time, shortRate: null, longRate: null, shortCumulative: null, longCumulative: null, shortAnnualized: null, longAnnualized: null, adr: null, ordinary: null, count });
  if (selected.length && selected[0].time > start) chart.push(gap(start));
  for (const [index, row] of selected.entries()) {
    if (index && row.time - selected[index - 1].time > intervalMs) chart.push(gap(selected[index - 1].time + intervalMs));
    const rate = row.adr === null || row.ordinary === null ? null : (row.adr - row.ordinary) / 2;
    if (rate !== null) { cumulative += rate; count++; }
    const annualized = count ? yearly(cumulative, count) : null;
    if ((rate !== null && !Number.isFinite(rate)) || !Number.isFinite(cumulative) || (annualized !== null && !Number.isFinite(annualized))) throw new Error("Historical funding calculation overflow");
    const hourly = rate === null ? null : rate / hours;
    chart.push({ time: row.time, shortRate: hourly, longRate: hourly === null ? null : -hourly, shortCumulative: rate === null ? null : cumulative, longCumulative: rate === null ? null : -cumulative, shortAnnualized: rate === null ? null : annualized, longAnnualized: rate === null ? null : -annualized!, adr: row.adr, ordinary: row.ordinary, count });
  }
  if (selected.length && selected.at(-1)!.time < end) chart.push(gap(selected.at(-1)!.time + intervalMs));
  const expectedHours = end < start ? 0 : Math.round((end - start) / intervalMs) + 1;
  const last = chart.findLast(point => point.shortRate !== null);
  return { chart, count, expectedHours, missingHours: expectedHours - count,
    firstTime: expectedHours ? start : null, lastTime: expectedHours ? end : null,
    shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null,
    shortAnnualized: count ? yearly(cumulative, count) : null, longAnnualized: count ? -yearly(cumulative, count) : null,
    latestShortRate: last?.shortRate ?? null, latestLongRate: last?.longRate ?? null,
  };
}
export type SettledFundingAnalysis = ReturnType<typeof analyzeSettledFunding>;

export function analyzeHynixFunding(rows: SettledFundingRow[], days: number | null, endTime = rows.at(-1)?.time ?? FIRST_FUNDING_SETTLEMENT - FUNDING_HOUR) {
  return analyzeSettledFunding(rows, days, endTime, { intervalMs: FUNDING_HOUR, firstSettlement: FIRST_FUNDING_SETTLEMENT });
}

export function retainFundingRows(previous: SettledFundingRow[] | undefined, next: SettledFundingRow[]): SettledFundingRow[] {
  return previous?.length === next.length && next.every((row, index) => row.time === previous[index].time && row.adr === previous[index].adr && row.ordinary === previous[index].ordinary) ? previous : next;
}
