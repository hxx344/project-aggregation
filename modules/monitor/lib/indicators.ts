import type { Point } from "./market";

export const INDICATOR_PERIODS = { sma: 7 * 24, bands: 20 * 24 };
export type SpreadMetric = "premium" | "spread";
export type IndicatorPoint = Point & {
  sma: number | null;
  basis: number | null;
  upper: number | null;
  lower: number | null;
  band: [number, number] | null;
  zscore: number | null;
  deviation: number | null;
  consecutiveHours: number;
};

/** Includes the current closed hour; requires complete, consecutive windows. */
export function calculateIndicators(
  points: Point[],
  metric: SpreadMetric,
  periods = INDICATOR_PERIODS,
): IndicatorPoint[] {
  if (![periods.sma, periods.bands].every(p => Number.isInteger(p) && p >= 2)) {
    throw new Error("Indicator periods must be integers of at least two hours");
  }
  let window: number[] = [];
  let previous: number | undefined;
  const maxPeriod = Math.max(periods.sma, periods.bands);

  return points.map(point => {
    const result: IndicatorPoint = {
      ...point, sma: null, basis: null, upper: null, lower: null,
      band: null, zscore: null, deviation: null, consecutiveHours: 0,
    };
    if (!Number.isFinite(point.time) || !Number.isFinite(point[metric])) {
      window = []; previous = undefined;
      return result;
    }
    if (previous !== undefined && point.time - previous !== 3_600_000) window = [];
    previous = point.time;
    window.push(point[metric]);
    if (window.length > maxPeriod) window.shift();
    result.consecutiveHours = window.length;

    // Two-pass variance avoids cancellation from E[x²] − E[x]².
    const mean = (values: number[]) => values[0] + values.reduce((sum, x) => sum + (x - values[0]), 0) / values.length;
    if (window.length >= periods.sma) result.sma = mean(window.slice(-periods.sma));
    if (window.length >= periods.bands) {
      const values = window.slice(-periods.bands);
      const basis = mean(values);
      const deviation = Math.sqrt(values.reduce((sum, x) => sum + (x - basis) ** 2, 0) / values.length);
      result.basis = basis;
      result.deviation = deviation;
      result.lower = basis - 2 * deviation;
      result.upper = basis + 2 * deviation;
      result.band = [result.lower, result.upper];
      result.zscore = deviation > 0 ? (point[metric] - basis) / deviation : null;
    }
    return result;
  });
}
