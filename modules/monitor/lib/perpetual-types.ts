/** Public perpetual-market snapshot. Rates are decimal fractions; timestamps are epoch ms. */
export type PerpetualExchangeKind = "cex" | "dex";
export type PerpetualExchangeStatus = "connecting" | "live" | "stale" | "error" | "disabled";
export type PerpetualStatus = "live" | "partial" | "snapshot" | "connecting" | "unavailable";

export interface PerpetualExchange {
  id: string;
  name: string;
  kind: PerpetualExchangeKind;
  status: PerpetualExchangeStatus;
  marketCount: number;
  quoteCount: number;
  lastMessageAt: number | null;
  error: string | null;
  freshBookCount?: number;
  staleBookCount?: number;
  missingBookCount?: number;
}

export interface PerpetualQuote {
  exchange: string;
  symbol: string;
  base: string;
  quoteCurrency: string;
  /** Original contract multiplier; public prices are normalized per base asset. */
  multiplier?: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  last: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingAt: number | null;
  sourceTime: number | null;
  receivedAt: number;
  transport: "ws" | "rest";
  bidAskAt?: number;
  markAt?: number;
  fundingAt?: number;
  displayBase?: string;
  contractUnit?: string;
  collateralCurrency?: string;
  settlementCurrency?: string;
  rawBase?: string;
  contractKind?: "linear" | "quanto";
  counterCurrency?: string;
  crossexSymbol?: string;
  marketId?: number;
  /** Current directory fingerprint for funding/price history; null means unverified. */
  historyIdentity?: string | null;
  comparable?: boolean;
  /** Official directory classification; missing fields remain unverified. */
  assetClass?: string;
  identitySource?: string;
  /** Explicit crypto category evidence for the limited CrossEx paper feed. */
  identityVerified?: boolean;
  /** Official venue lifecycle metadata, independent of price freshness. */
  delisting?: boolean;
  delistingAt?: number | null;
  /** Public ordinary-account taker metadata; not personal commission rates. */
  takerFeeRate?: number | null;
  takerFeeAt?: number | null;
  takerFeeSource?: string | null;
}

export interface PerpetualSnapshot {
  schemaVersion: 1;
  monitorId: "perpetual";
  status: PerpetualStatus;
  generatedAt: number;
  staleAfterMs: number;
  exchanges: PerpetualExchange[];
  quotes: PerpetualQuote[];
  error?: string | null;
  note?: string | null;
  storageError?: string | null;
  streamId?: string;
  sequence?: number;
}

export interface PerpetualDelta extends Omit<PerpetualSnapshot, "quotes"> {
  type: "delta";
  updates: PerpetualQuote[];
  removed: string[];
}

export interface PerpetualPatch extends Omit<PerpetualSnapshot, "quotes"> {
  type: "patch";
  streamId: string;
  baseSequence: number;
  sequence: number;
  patches: [string, { [K in keyof PerpetualQuote]?: PerpetualQuote[K] | null }][];
  removed: string[];
}

export type PerpetualPriceMode = "book" | "mark";
export type PerpetualPairMode = "all" | "cex-dex" | "cex-cex" | "dex-dex";
