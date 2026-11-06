import type { Point } from "./market.ts";
import { validatedIntradayChartRows, validateIntradaySnapshot } from "../modules/oil/intraday.mjs";

type OilSnapshot = ReturnType<typeof validateIntradaySnapshot>;
/** Paired 15-minute closes on the shared spread-chart shape: leg A = Brent, leg B = WTI. */
export type OilHistory = { points: Point[]; status: "live" | "snapshot"; fetchedAt: string; metadata: OilSnapshot["metadata"] };

/**
 * `spread` = Brent − WTI in USDT per barrel. Oil charts only the absolute spread, so
 * `premium` is NaN and the oil chart config leaves out the percentage tab.
 */
export function oilHistory(input: unknown): OilHistory {
  const snapshot = validateIntradaySnapshot(input);
  const points = validatedIntradayChartRows(snapshot).flatMap(({ time, brent, wti, spread }) => brent === null || wti === null ? [] : [{ time: time as number, adr: brent, ordinary: wti, equivalent: wti, spread, premium: NaN }]);
  return { points, status: snapshot.status === "snapshot" ? "snapshot" : "live", fetchedAt: snapshot.metadata.fetchedAt, metadata: snapshot.metadata };
}

/** Keep the previous point array when a refresh returns the same closes, so charts skip rebuilding. */
export function retainOilHistory(previous: OilHistory | null, next: OilHistory): OilHistory {
  if (!previous) return next;
  if (Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt)) return previous;
  const same = previous.points.length === next.points.length && next.points.every((point, index) => point.time === previous.points[index].time && point.adr === previous.points[index].adr && point.ordinary === previous.points[index].ordinary);
  return same ? { ...next, points: previous.points } : next;
}
