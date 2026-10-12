export interface PerpetualDepthLeg {
  exchange: string;
  symbol: string;
  quoteCurrency: string;
  sourceTime: number;
  receivedAt: number;
  transport: "ws" | "rest";
  source: string;
  levels: number;
  complete: boolean;
  filledQuantity: number;
  filledNotional: number;
  vwap: number | null;
  capacityQuantity: number;
  capacityNotional: number;
}
export interface PerpetualDepthEstimate {
  notional: number;
  notionalCurrency: "USDT";
  generatedAt: number;
  staleAfterMs: number;
  complete: boolean;
  estimatedSpreadPct: number | null;
  entrySlippagePct: number | null;
  quantity: number | null;
  long: PerpetualDepthLeg | null;
  short: PerpetualDepthLeg | null;
  reasons: string[];
}

/** A frozen estimate still ages from the older source snapshot, not the UI click. */
export function depthEstimateExpired(result: PerpetualDepthEstimate, now: number): boolean {
  const times = [result.generatedAt, result.long?.sourceTime, result.short?.sourceTime].filter((time): time is number => typeof time === "number");
  const maxAge = Math.min(10_000, result.staleAfterMs);
  return !Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge <= 0 || times.some(time => !Number.isFinite(time) || time > now + 5_000 || now - time > maxAge);
}
