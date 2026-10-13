export type PositionSample = { at: number; spread: string | null };

type PositionHistoryLeg = {
  id: string; symbol: string; side: string; openedAt?: string | number | null;
  baseQuantity: string | null; entryPrice: string | null;
};
export type PositionHistoryGroup = {
  base: string; legs: readonly PositionHistoryLeg[]; metrics: { currentSpread: string | null };
};
export type PositionHistorySeries = {
  identity: string; samples: PositionSample[]; lastAt: number | null;
};
export type PositionHistoryState = { scope: string; series: Record<string, PositionHistorySeries> };
export type PositionHistoryUpdate = {
  /** Include both account identity and connection.version; changing either starts a new session. */
  scope: string; at: number | null; now: number; stale: boolean; partial: boolean;
};

export const POSITION_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const POSITION_HISTORY_BUCKET_MS = 60 * 1000;
export const POSITION_HISTORY_GAP_MS = 5 * 60 * 1000;
export const POSITION_HISTORY_MAX_POINTS = 1440;

/** Stable across API ordering, but never shared by a replacement or resized position. */
export function positionHistoryIdentity(group: Pick<PositionHistoryGroup, 'base' | 'legs'>): string {
  const legs = group.legs.map(leg => JSON.stringify([
    leg.id, leg.symbol, leg.side, leg.openedAt ?? null, leg.baseQuantity, leg.entryPrice,
  ])).sort();
  return JSON.stringify([group.base, legs]);
}

/** Safe during the render before an effect has cleared an old account or position. */
export function positionHistorySamples(state: PositionHistoryState | null, group: PositionHistoryGroup, scope: string): PositionSample[] {
  const series = state?.scope === scope ? state.series[group.base] : undefined;
  return series?.identity === positionHistoryIdentity(group) ? series.samples : [];
}

export function positionHistoryHasGap(previous: PositionSample, next: PositionSample): boolean {
  return previous.spread === null || next.spread === null || next.at - previous.at > POSITION_HISTORY_GAP_MS;
}

function validSpread(value: string | null): string | null {
  return typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    && Number.isFinite(Number(value)) ? value : null;
}

/** Session-only observations: no backfill, persistence, or interpolation of missing data. */
export function updatePositionHistory(previous: PositionHistoryState | null, groups: readonly PositionHistoryGroup[], update: PositionHistoryUpdate): PositionHistoryState {
  const sameScope = previous?.scope === update.scope;
  const validNow = Number.isFinite(update.now) && update.now >= 0;
  const cutoff = update.now - POSITION_HISTORY_WINDOW_MS;
  const at = update.at;
  const canSample = validNow && !update.stale && !update.partial && at !== null && Number.isFinite(at)
    && at >= 0 && at <= update.now && at >= cutoff;
  const series: Record<string, PositionHistorySeries> = Object.create(null);
  let unchanged = sameScope && Object.keys(previous.series).length === groups.length;

  for (const group of groups) {
    const identity = positionHistoryIdentity(group);
    const candidate = sameScope ? previous.series[group.base] : undefined;
    const retained = candidate?.identity === identity ? candidate : undefined;
    let samples = retained?.samples ?? [];
    if (validNow) {
      const trimmed = samples.filter(sample => sample.at >= cutoff && sample.at <= update.now);
      if (trimmed.length !== samples.length) samples = trimmed;
    }
    let lastAt = retained?.lastAt ?? null;

    if (canSample && (lastAt === null || at > lastAt)) {
      lastAt = at;
      const sample = { at, spread: validSpread(group.metrics.currentSpread) };
      const last = samples.at(-1);
      if (last && Math.floor(last.at / POSITION_HISTORY_BUCKET_MS) === Math.floor(at / POSITION_HISTORY_BUCKET_MS)) {
        // Once a minute contains an unavailable value, keep its gap visible until the next bucket.
        if (last.spread !== null) samples = [...samples.slice(0, -1), sample];
      } else {
        samples = [...samples, sample];
      }
    }
    if (samples.length > POSITION_HISTORY_MAX_POINTS) samples = samples.slice(-POSITION_HISTORY_MAX_POINTS);

    const current = retained && retained.samples === samples && retained.lastAt === lastAt
      ? retained : { identity, samples, lastAt };
    series[group.base] = current;
    if (current !== candidate) unchanged = false;
  }

  return unchanged && previous ? previous : { scope: update.scope, series };
}
