import { TRADE_PAIRS, groupTradeEvents } from "../modules/oil/trades.mjs";
import type { Point } from "./market.ts";
import type { HubFillsView } from "./hub-fills-contract.ts";

export const HOUR_MS = 3_600_000;
const ADR_PER_SHARE = 10;
export type TradeEvent = ReturnType<typeof groupTradeEvents>[number];
/** value/usd are chart y values; value/chartSpread feed the shared detail text in `unit`. */
export type SpreadTradeMarker = {
  event: TradeEvent;
  value: number | null;
  chartSpread: number | null;
  basis: string;
  usd: number | null;
  /** `percent` for a premium market (Hynix), `absolute` for a quote-currency spread (oil). */
  unit: "percent" | "absolute";
  /** Explicit native venue/contract for single-leg markers. */
  venueLabel?: string;
};
export type HynixTradeMarker = SpreadTradeMarker;

export const oilTradeEvents = (items: HubFillsView["items"]): TradeEvent[] => groupTradeEvents(items, TRADE_PAIRS.oil);
export const hynixTradeEvents = (items: HubFillsView["items"]): TradeEvent[] => groupTradeEvents(items, TRADE_PAIRS.hynix);

/** Index of the bar containing time, or -1 when it starts before every bar. */
function containingIndex(points: Point[], time: number) {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle].time <= time) low = middle + 1; else high = middle; }
  return low - 1;
}

export type SpreadTradeOptions = {
  /** Bar length; bars start at `time` and only closed bars are charted. */
  intervalMs: number;
  /** Leg B units per leg A unit (10 ordinary-share tenths per Hynix ADR, 1 barrel per barrel). */
  rightPerUnit: number;
  tradedBasis: string;
  chartBasis: string;
  /** The chart point field the market's trade spread matches; defaults to `premium`. */
  metric?: "premium" | "spread";
};

/**
 * A fill belongs to the bar that contains it. Fills after the last closed bar stay listed
 * with their own prices and no chart value.
 */
export function spreadTradeMarkers(events: TradeEvent[], points: Point[], { intervalMs, rightPerUnit, tradedBasis, chartBasis, metric = "premium" }: SpreadTradeOptions): HynixTradeMarker[] {
  if (!points.length) return [];
  const start = points[0].time;
  return events.filter(event => event.time >= start).map(event => {
    const bar = points[containingIndex(points, event.time)];
    const covered = bar && event.time - bar.time < intervalMs ? bar : null;
    const chartSpread = covered && Number.isFinite(covered[metric]) ? covered[metric] : null;
    const prices = event.spreadVenue?.prices;
    const usd = prices ? prices.left - prices.right / rightPerUnit : covered && Number.isFinite(covered.spread) ? covered.spread : null;
    return { event, chartSpread, value: event.spread ?? chartSpread, basis: event.spread === null ? chartBasis : tradedBasis, usd, unit: metric === "spread" ? "absolute" : "percent" };
  });
}

export const hynixTradeMarkers = (events: TradeEvent[], points: Point[]): HynixTradeMarker[] =>
  spreadTradeMarkers(events, points, { intervalMs: HOUR_MS, rightPerUnit: ADR_PER_SHARE, tradedBasis: "成交溢价率", chartBasis: "图表溢价率" });
