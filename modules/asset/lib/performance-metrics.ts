/** Performance of Beijing daily snapshots, using held assets plus withdrawals. */
export type PerformancePoint = { date: string; adjusted: number; partial?: boolean };

export type MonthlyPerformance = {
  month: string;
  startValue: number;
  endValue: number;
  gain: number | null;
  returnRate: number | null;
  snapshotCount: number;
  startDate: string;
  endDate: string;
  daysSpan: number;
  /** The first or last snapshot used for this month's gain is partial. */
  partial: boolean;
};

export type AnnualizedMetrics = {
  monthlyAnnualized: number | null;
  overallAnnualized: number | null;
  referenceMonth: string;
  monthlyPeriod: MonthlyPerformance | null;
  daysSpan: number;
  hasData: boolean;
  /** A snapshot used by a displayed annualized value is partial. */
  partial: boolean;
};

const DAY_MS = 86_400_000;
export const MIN_MONTHLY_SPAN_DAYS = 25;

// These are civil dates from assetTrend(), not timestamps in the browser zone.
function dayTime(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const time = Date.parse(date + 'T00:00:00+08:00');
  return Number.isFinite(time) && new Date(time + 8 * 3_600_000).toISOString().slice(0, 10) === date ? time : NaN;
}

function normalizedDays(points: readonly PerformancePoint[]): PerformancePoint[] {
  const days = new Map<string, PerformancePoint>();
  for (const point of points) {
    if (Number.isFinite(point.adjusted) && Number.isFinite(dayTime(point.date))) days.set(point.date, point);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const finite = (value: number) => Number.isFinite(value) ? value : null;
const daysBetween = (start: string, end: string) => (dayTime(end) - dayTime(start)) / DAY_MS;

/** Actual/Actual year fraction: split elapsed days at each Beijing New Year. */
function yearFraction(start: string, end: string): number {
  let cursor = dayTime(start);
  const finish = dayTime(end);
  let years = 0;
  for (let year = Number(start.slice(0, 4)); cursor < finish; year++) {
    const yearStart = dayTime(String(year).padStart(4, '0') + '-01-01');
    const yearEnd = dayTime(String(year + 1).padStart(4, '0') + '-01-01');
    const until = Math.min(finish, yearEnd);
    years += (until - cursor) / (yearEnd - yearStart);
    cursor = until;
  }
  return years;
}

/** Latest month first; only observed first/last values are used, without interpolation. */
export function calculateMonthlyPerformance(trendData: readonly PerformancePoint[]): MonthlyPerformance[] {
  const days = normalizedDays(trendData);
  if (days.length < 2) return [];
  const byMonth = new Map<string, PerformancePoint[]>();
  for (const point of days) {
    const month = point.date.slice(0, 7);
    const points = byMonth.get(month);
    if (points) points.push(point);
    else byMonth.set(month, [point]);
  }
  return [...byMonth].reverse().map(([month, points]) => {
    const first = points[0], last = points[points.length - 1];
    const gain = points.length >= 2 ? finite(last.adjusted - first.adjusted) : null;
    return {
      month, startValue: first.adjusted, endValue: last.adjusted, gain,
      returnRate: gain !== null && first.adjusted > 0 ? finite(gain / first.adjusted) : null,
      snapshotCount: points.length, startDate: first.date, endDate: last.date,
      daysSpan: daysBetween(first.date, last.date), partial: !!(first.partial || last.partial),
    };
  });
}

/** Simple annualization; the reference month is always the month before today. */
export function calculateAnnualizedReturns(
  trendData: readonly PerformancePoint[],
  monthlyPerformance: readonly MonthlyPerformance[],
  today: string,
): AnnualizedMetrics {
  const days = normalizedDays(trendData);
  const referenceMonth = Number.isFinite(dayTime(today))
    ? new Date(dayTime(today.slice(0, 7) + '-01') - DAY_MS + 8 * 3_600_000).toISOString().slice(0, 7) : '';
  const monthlyPeriod = monthlyPerformance.find(period => period.month === referenceMonth) ?? null;
  const first = days[0], last = days.at(-1);
  const daysSpan = first && last ? daysBetween(first.date, last.date) : 0;
  const hasData = days.length >= 2 && daysSpan > 0;
  const overallAnnualized = hasData && first.adjusted > 0
    ? finite(((last!.adjusted - first.adjusted) / first.adjusted) / yearFraction(first.date, last!.date)) : null;
  const monthlyAnnualized = monthlyPeriod && monthlyPeriod.snapshotCount >= 2 &&
    monthlyPeriod.daysSpan >= MIN_MONTHLY_SPAN_DAYS && monthlyPeriod.returnRate !== null
    ? finite(monthlyPeriod.returnRate / yearFraction(monthlyPeriod.startDate, monthlyPeriod.endDate)) : null;
  const partial = (overallAnnualized !== null && !!(first.partial || last!.partial))
    || (monthlyAnnualized !== null && monthlyPeriod!.partial);
  return { monthlyAnnualized, overallAnnualized, referenceMonth, monthlyPeriod, daysSpan, hasData, partial };
}

export function performanceTone(value: number | null, scale = 1) {
  const rounded = value === null ? 0 : Number((value * scale).toFixed(2));
  return !Number.isFinite(rounded) || rounded === 0 ? 'performance-neutral' : rounded > 0 ? 'performance-positive' : 'performance-negative';
}

/** Unknown values remain unknown, and values rounding to zero never show -0.00. */
export function formatGain(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(decimals));
  return (rounded < 0 ? '-' : '+') + Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
}

export function formatReturnRate(rate: number | null, decimals = 2): string {
  if (rate === null || !Number.isFinite(rate * 100)) return '—';
  return formatGain(rate * 100, decimals) + '%';
}
