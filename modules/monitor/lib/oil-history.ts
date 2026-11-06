import type { Point } from "./market.ts";
import { validatedIntradayChartRows, validateIntradaySnapshot } from "../modules/oil/intraday.mjs";

/** The widest oil indicator window (Bollinger bands and Z-score). */
export const OIL_BANDS_DAYS = 20;
/** Days read before a selected range so its first bar has the full indicator window, plus one day of margin. */
export const OIL_WARMUP_DAYS = OIL_BANDS_DAYS + 1;

type OilSnapshot = ReturnType<typeof validateIntradaySnapshot>;
type Coverage = Pick<OilSnapshot["metadata"], "firstCommonObservation" | "lastCommonObservation" | "pairedObservationRows">;
/**
 * Paired 15-minute closes on the shared spread-chart shape: leg A = Brent, leg B = WTI.
 * A windowed read keeps only the last `windowDays` days in `points`/`metadata`; `coverage` is always the complete history's range.
 */
export type OilHistory = { points: Point[]; status: "live" | "snapshot"; fetchedAt: string; metadata: OilSnapshot["metadata"]; windowDays: number | null; coverage: Coverage };

function readCoverage(input: unknown, metadata: OilSnapshot["metadata"]): Coverage {
  const { firstCommonObservation, lastCommonObservation, pairedObservationRows } = (input ?? {}) as Partial<Coverage>;
  if (typeof firstCommonObservation !== "string" || lastCommonObservation !== metadata.lastCommonObservation
    || !(Date.parse(firstCommonObservation) <= Date.parse(metadata.firstCommonObservation))
    || !Number.isSafeInteger(pairedObservationRows) || pairedObservationRows! < metadata.pairedObservationRows) throw new Error("Invalid oil candle coverage");
  return { firstCommonObservation, lastCommonObservation, pairedObservationRows: pairedObservationRows! };
}

/**
 * `spread` = Brent − WTI in USDT per barrel. Oil charts only the absolute spread, so
 * `premium` is NaN and the oil chart config leaves out the percentage tab.
 */
export function oilHistory(input: unknown): OilHistory {
  const snapshot = validateIntradaySnapshot(input);
  const points = validatedIntradayChartRows(snapshot).flatMap(({ time, brent, wti, spread }) => brent === null || wti === null ? [] : [{ time: time as number, adr: brent, ordinary: wti, equivalent: wti, spread, premium: NaN }]);
  const raw = input as { windowDays?: unknown; coverage?: unknown };
  const windowDays = raw.windowDays === undefined ? null : Number.isSafeInteger(raw.windowDays) && (raw.windowDays as number) > 0 ? raw.windowDays as number : NaN;
  if (Number.isNaN(windowDays)) throw new Error("Invalid oil candle window");
  const { firstCommonObservation, lastCommonObservation, pairedObservationRows } = snapshot.metadata;
  const coverage = windowDays === null ? { firstCommonObservation, lastCommonObservation, pairedObservationRows } : readCoverage(raw.coverage, snapshot.metadata);
  return { points, status: snapshot.status === "snapshot" ? "snapshot" : "live", fetchedAt: snapshot.metadata.fetchedAt, metadata: snapshot.metadata, windowDays, coverage };
}

/** Whether loaded history holds every bar a `range`-day chart (null = all) and its indicator warmup need. */
export function coversOilRange(history: OilHistory, range: number | null, warmupDays: number): boolean {
  return history.windowDays === null || (range !== null && history.windowDays >= range + warmupDays);
}

/** Keep the previous point array when a refresh returns the same closes, so charts skip rebuilding. */
export function retainOilHistory(previous: OilHistory | null, next: OilHistory): OilHistory {
  if (!previous) return next;
  if (Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt)) return previous;
  const same = previous.points.length === next.points.length && next.points.every((point, index) => point.time === previous.points[index].time && point.adr === previous.points[index].adr && point.ordinary === previous.points[index].ordinary);
  return same ? { ...next, points: previous.points } : next;
}
