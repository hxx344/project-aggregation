import { GOLD_OIL_INTERVAL_MS, goldOilRatio, type GoldOilHistory, type GoldOilPoint } from './gold-oil.ts';

const WINDOW_MS = 86_400_000, SWEEP_COOLDOWN_MS = 6 * 3_600_000;

function firstGap(points: GoldOilPoint[], from: number, to: number): number | null {
  let expected = from;
  for (const point of points) {
    if (point.time < from) continue;
    if (point.time >= to) break;
    if (point.time > expected) return expected;
    if (point.oil === null || point.xau === null) return point.time;
    expected = point.time + GOLD_OIL_INTERVAL_MS;
  }
  return expected < to ? expected : null;
}

/** Repair one old day after a successful recent refresh. A durable cursor moves
 * past missing or failed windows; only a completed sweep waits before retrying.
 * Old records are fill-only, while the caller's recent overlap may be revised. */
export async function repairGoldOilHistory(
  history: GoldOilHistory,
  commonStart: number,
  recentStart: number,
  now: number,
  read: (from: number, to: number) => Promise<GoldOilHistory>,
): Promise<GoldOilHistory> {
  const state = history.historyRepair;
  if (state && now < state.nextCheckAt) return history;
  const cursor = state ? Math.max(commonStart, Math.min(state.cursor, recentStart)) : commonStart;
  const from = firstGap(history.points, cursor, recentStart);
  if (from === null) return { ...history, historyRepair: { cursor: commonStart, nextCheckAt: now + SWEEP_COOLDOWN_MS } };
  const to = Math.min(from + WINDOW_MS, recentStart);
  const complete = firstGap(history.points, to, recentStart) === null;
  const result: GoldOilHistory = { ...history, historyRepair: { cursor: complete ? commonStart : to, nextCheckAt: complete ? now + SWEEP_COOLDOWN_MS : now } };
  try {
    const repaired = await read(from, to), points = new Map(history.points.map(point => [point.time, point]));
    for (const point of repaired.points) {
      if (point.time < from || point.time >= to) continue;
      const previous = points.get(point.time), oil = previous?.oil ?? point.oil, xau = previous?.xau ?? point.xau;
      points.set(point.time, { time: point.time, oil, ...(history.oilType === 'cl' ? { cl: oil } : {}), xau, ratio: goldOilRatio(oil, xau) });
    }
    return { ...result, points: [...points.values()].sort((a, b) => a.time - b.time) };
  } catch {
    // The recent request already succeeded. A failed optional repair must not
    // discard it, change its source time, or erase the cached historical points.
    return result;
  }
}
