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
  // Consecutive values of the current run; `start` trims it to the longest window
  // without per-hour slices or shifts. Sums keep the original element order.
  const window: number[] = [];
  let start = 0;
  let previous: number | undefined;
  const maxPeriod = Math.max(periods.sma, periods.bands);
  // Two-pass variance avoids cancellation from E[x²] − E[x]².
  const mean = (from: number) => {
    const first = window[from];
    let sum = 0;
    for (let i = from; i < window.length; i++) sum += window[i] - first;
    return first + sum / (window.length - from);
  };

  return points.map(point => {
    const result: IndicatorPoint = {
      ...point, sma: null, basis: null, upper: null, lower: null,
      band: null, zscore: null, deviation: null, consecutiveHours: 0,
    };
    if (!Number.isFinite(point.time) || !Number.isFinite(point[metric])) {
      window.length = 0; start = 0; previous = undefined;
      return result;
    }
    if (previous !== undefined && point.time - previous !== 3_600_000) { window.length = 0; start = 0; }
    previous = point.time;
    window.push(point[metric]);
    if (window.length - start > maxPeriod) start++;
    const count = window.length - start;
    result.consecutiveHours = count;

    if (count >= periods.sma) result.sma = mean(window.length - periods.sma);
    if (count >= periods.bands) {
      const from = window.length - periods.bands;
      const basis = mean(from);
      let squares = 0;
      for (let i = from; i < window.length; i++) squares += (window[i] - basis) ** 2;
      const deviation = Math.sqrt(squares / periods.bands);
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
