import { TRADE_PAIRS, groupTradeEvents } from "../modules/oil/trades.mjs";
import type { Point } from "./market.ts";
import type { HubFillsView } from "./hub-fills-contract.ts";

export const HOUR_MS = 3_600_000;
const ADR_PER_SHARE = 10;
export type TradeEvent = ReturnType<typeof groupTradeEvents>[number];
/** premium/usd are chart y values; value/chartSpread feed the shared detail text in percent. */
export type HynixTradeMarker = {
  event: TradeEvent;
  value: number | null;
  chartSpread: number | null;
  basis: string;
  usd: number | null;
};

export const hynixTradeEvents = (items: HubFillsView["items"]): TradeEvent[] => groupTradeEvents(items, TRADE_PAIRS.hynix);

/** Index of the hour bar containing time, or -1 when it starts before every bar. */
function containingIndex(points: Point[], time: number) {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle].time <= time) low = middle + 1; else high = middle; }
  return low - 1;
}

/**
 * Bars start at their hour and only closed hours are charted, so a fill belongs to the bar that contains it.
 * Fills after the last closed bar stay listed with their own prices and no chart value.
 */
export function hynixTradeMarkers(events: TradeEvent[], points: Point[]): HynixTradeMarker[] {
  if (!points.length) return [];
  const start = points[0].time;
  return events.filter(event => event.time >= start).map(event => {
    const bar = points[containingIndex(points, event.time)];
    const covered = bar && event.time - bar.time < HOUR_MS ? bar : null;
    const chartSpread = covered && Number.isFinite(covered.premium) ? covered.premium : null;
    const prices = event.spreadVenue?.prices;
    const usd = prices ? prices.left - prices.right / ADR_PER_SHARE : covered && Number.isFinite(covered.spread) ? covered.spread : null;
    return { event, chartSpread, value: event.spread ?? chartSpread, basis: event.spread === null ? "图表溢价率" : "成交溢价率", usd };
  });
}
