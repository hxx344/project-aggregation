import type { QuoteFreshness } from './market-freshness';

export const LISTING_DATE = "2026-07-10";
export const FIRST_FULL_HOUR = Date.parse("2026-07-10T14:00:00Z");
export const ADR_PER_SHARE = 10;
export type Candle = { t: number; T: number; c: string; o: string; h: string; l: string; v: string; s: string; i: string };
export type Point = { time: number; adr: number; ordinary: number; equivalent: number; spread: number; premium: number };
export type FundingLeg = { coin: string; oraclePx: number; hourlyRate: number };
export type HynixFunding = {
  ordinary: FundingLeg;
  adr: FundingLeg;
  grossNotional: number;
  hourlyCashflow: number;
  hourlyRate: number;
  annualizedRate: number;
  fetchedAt: string;
};
export type LiveQuote = Omit<Point, "time"> & QuoteFreshness & { fetchedAt: string; funding?: HynixFunding | null; fundingError?: string; status?: "live" | "snapshot" };
export type MarketData = {
  points: Point[];
  fetchedAt: string;
  status: "live" | "snapshot";
  interval: "1h";
  firstAvailable: string;
  warnings: string[];
};

/** Keep chart inputs stable when a poll changes only metadata, without hiding corrections. */
export function retainHistoryPoints(previous: MarketData | null, next: MarketData): MarketData {
  if (!previous || previous.points.length !== next.points.length) return next;
  const fields = ["time", "adr", "ordinary", "equivalent", "spread", "premium"] as const;
  if (!next.points.every((point, index) => fields.every(field => point[field] === previous.points[index][field]))) return next;
  return { ...next, points: previous.points };
}

// Align identical, completed UTC buckets. Never forward-fill a missing quote.
export function alignCandles(ordinary: Candle[], adr: Candle[], now = Date.now()): Point[] {
  const valid = (c: Candle) => Number.isFinite(c.t) && c.t >= FIRST_FULL_HOUR && c.T < now && Number.isFinite(Number(c.c)) && Number(c.c) > 0;
  const byTime = new Map(ordinary.filter(valid).map(c => [c.t, Number(c.c)]));
  return [...new Map(adr.filter(valid).flatMap(c => {
    const base = byTime.get(c.t);
    if (base === undefined) return [];
    const price = Number(c.c), equivalent = base / ADR_PER_SHARE;
    return [[c.t, { time: c.t, adr: price, ordinary: base, equivalent, spread: price - equivalent, premium: (price / equivalent - 1) * 100 }] as const];
  })).values()].sort((a,b) => a.time - b.time);
}

export function selectRange<T extends Point>(points: T[], days: number | null): T[] {
  if (!days || !points.length) return points;
  const start = points.at(-1)!.time - days * 86_400_000;
  return points.filter(p => p.time >= start);
}

export function dailyPoints(points: Point[]): Point[] {
  const days = new Map<string, Point>();
  for (const p of points) days.set(new Date(p.time).toISOString().slice(0,10), p);
  return [...days.values()];
}
