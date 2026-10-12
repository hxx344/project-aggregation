import { FIRST_FUNDING_SETTLEMENT, FUNDING_HOUR, type SettledFundingRow } from "./hynix-funding-history.ts";

export type FundingChartPoint = { time: number; shortRate: number | null; longRate: number | null; shortCumulative: number | null; longCumulative: number | null; shortAnnualized: number | null; longAnnualized: number | null; adr: number | null; ordinary: number | null; count: number };
export function analyzeHynixFunding(rows: SettledFundingRow[], days: number | null, endTime = rows.at(-1)?.time ?? FIRST_FUNDING_SETTLEMENT - FUNDING_HOUR) {
  const end = Math.floor(endTime / FUNDING_HOUR) * FUNDING_HOUR;
  // N days contain exactly N*24 settlement hours, not an extra boundary hour.
  const start = days === null ? FIRST_FUNDING_SETTLEMENT : Math.max(FIRST_FUNDING_SETTLEMENT, end - (days * 24 - 1) * FUNDING_HOUR);
  const selected = rows.filter(row => row.time >= start && row.time <= end);
  const chart: FundingChartPoint[] = [];
  let cumulative = 0, count = 0;
  const gap = (time: number): FundingChartPoint => ({ time, shortRate: null, longRate: null, shortCumulative: null, longCumulative: null, shortAnnualized: null, longAnnualized: null, adr: null, ordinary: null, count });
  if (selected.length && selected[0].time > start) chart.push(gap(start));
  for (const [index, row] of selected.entries()) {
    if (index && row.time - selected[index - 1].time > FUNDING_HOUR) chart.push(gap(selected[index - 1].time + FUNDING_HOUR));
    const rate = row.adr === null || row.ordinary === null ? null : (row.adr - row.ordinary) / 2;
    if (rate !== null) { cumulative += rate; count++; }
    const annualized = count ? cumulative / count * 24 * 365 : null;
    if ((rate !== null && !Number.isFinite(rate)) || !Number.isFinite(cumulative) || (annualized !== null && !Number.isFinite(annualized))) throw new Error("Historical funding calculation overflow");
    chart.push({ time: row.time, shortRate: rate, longRate: rate === null ? null : -rate, shortCumulative: rate === null ? null : cumulative, longCumulative: rate === null ? null : -cumulative, shortAnnualized: rate === null ? null : annualized, longAnnualized: rate === null ? null : -annualized!, adr: row.adr, ordinary: row.ordinary, count });
  }
  if (selected.length && selected.at(-1)!.time < end) chart.push(gap(selected.at(-1)!.time + FUNDING_HOUR));
  const expectedHours = Math.max(0, Math.round((end - start) / FUNDING_HOUR) + 1);
  const last = chart.findLast(point => point.shortRate !== null);
  return { chart, count, expectedHours, missingHours: expectedHours - count,
    firstTime: expectedHours ? start : null, lastTime: expectedHours ? end : null,
    shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null,
    shortAnnualized: count ? cumulative / count * 24 * 365 : null, longAnnualized: count ? -cumulative / count * 24 * 365 : null,
    latestShortRate: last?.shortRate ?? null, latestLongRate: last?.longRate ?? null,
  };
}

export function retainFundingRows(previous: SettledFundingRow[] | undefined, next: SettledFundingRow[]): SettledFundingRow[] {
  return previous?.length === next.length && next.every((row, index) => row.time === previous[index].time && row.adr === previous[index].adr && row.ordinary === previous[index].ordinary) ? previous : next;
}
