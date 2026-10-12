import { normalizeCrossExBlockedBases, type CrossExFilterConfig } from "./perpetual-crossex-config.ts";
import type { PerpetualSpread } from "./perpetual-spreads.ts";

export interface SpotTransferPair {
  base: string;
  exchanges: [string, string];
  networks: string[];
  checkedAt: number;
  expiresAt: number;
}
export interface CrossExSettings {
  available: boolean; generatedAt: number; revision: number; metadataRevision: number; config: CrossExFilterConfig; error: string;
  spotTransferPairs: SpotTransferPair[];
  venues: { exchange: string; state: string; checkedAt: number | null; error: string }[];
}
const venues = new Set(["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"]);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
export const spotTransferPairKey = (base: string, exchanges: readonly string[]) => JSON.stringify([base, ...[...exchanges].sort()]);

/** Reject partial/ambiguous qualification payloads before using them to admit rows. */
export function parseCrossExSettings(input: unknown): CrossExSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("CrossEx 筛选响应无效，请升级 Monitor 后重试");
  const data = input as CrossExSettings;
  const invalid = () => { throw new Error("CrossEx 筛选响应无效，请升级 Monitor 后重试"); };
  if (typeof data.available !== "boolean" || !timestamp(data.generatedAt) || !Number.isSafeInteger(data.revision) || data.revision < 0
    || !Number.isSafeInteger(data.metadataRevision) || data.metadataRevision < 0 || typeof data.error !== "string"
    || typeof data.config?.requireSpotTransfer !== "boolean" || !Array.isArray(data.venues)
    || !Array.isArray(data.spotTransferPairs) || data.spotTransferPairs.length > 30_000) invalid();
  const blockedBases = normalizeCrossExBlockedBases(data.config.blockedBases), keys = new Set<string>();
  for (const pair of data.spotTransferPairs) {
    if (!pair || typeof pair.base !== "string" || !/^[A-Z0-9]{1,30}$/.test(pair.base)
      || !Array.isArray(pair.exchanges) || pair.exchanges.length !== 2 || pair.exchanges.some(exchange => !venues.has(exchange)) || pair.exchanges[0] === pair.exchanges[1]
      || !Array.isArray(pair.networks) || !pair.networks.length || pair.networks.length > 100 || pair.networks.some(network => typeof network !== "string" || !/^[A-Z0-9_]{1,40}$/.test(network))
      || new Set(pair.networks).size !== pair.networks.length || !timestamp(pair.checkedAt) || !timestamp(pair.expiresAt)
      || pair.checkedAt > data.generatedAt || pair.expiresAt <= pair.checkedAt || pair.expiresAt - pair.checkedAt > 180_000) invalid();
    const key = spotTransferPairKey(pair.base, pair.exchanges);
    if (keys.has(key)) invalid();
    keys.add(key);
  }
  for (const venue of data.venues) if (!venue || !venues.has(venue.exchange) || !["live", "pending", "stale", "error", "unsupported"].includes(venue.state)
    || (venue.checkedAt !== null && !timestamp(venue.checkedAt)) || typeof venue.error !== "string") invalid();
  if (!data.config.requireSpotTransfer && data.spotTransferPairs.length) invalid();
  return { ...data, config: { ...data.config, blockedBases } };
}

export function indexSpotTransferPairs(pairs: readonly SpotTransferPair[] = []): ReadonlyMap<string, SpotTransferPair> {
  return new Map(pairs.map(pair => [spotTransferPairKey(pair.base, pair.exchanges), pair]));
}
type Pair = Pick<PerpetualSpread, "base" | "long" | "short">;
export function spotTransferPairEvidence(row: Pair, pairs: ReadonlyMap<string, SpotTransferPair>): SpotTransferPair | undefined {
  if (row.long.base !== row.base || row.short.base !== row.base || row.long.multiplier !== 1 || row.short.multiplier !== 1) return undefined;
  return pairs.get(spotTransferPairKey(row.base, [row.long.exchange, row.short.exchange]));
}
export function spotTransferPairState(row: Pair, settings: CrossExSettings | null, pairs: ReadonlyMap<string, SpotTransferPair>, now: number): "disabled" | "unknown" | "expired" | "verified" {
  if (!settings) return "unknown";
  if (!settings.config.requireSpotTransfer) return "disabled";
  if (settings.error) return "unknown";
  const evidence = spotTransferPairEvidence(row, pairs);
  if (!evidence || !Number.isFinite(now) || now < evidence.checkedAt) return "unknown";
  return now < evidence.expiresAt ? "verified" : "expired";
}

/** Apply to the full ranking (also frozen inspection rows) before counts or pagination. */
export function filterCrossExRanking(rows: PerpetualSpread[], settings: CrossExSettings | null, pairs: ReadonlyMap<string, SpotTransferPair>, now: number): PerpetualSpread[] {
  if (!settings) return [];
  const blocked = new Set(settings.config.blockedBases);
  return rows.filter(row => !blocked.has(row.base) && (!settings.config.requireSpotTransfer || spotTransferPairState(row, settings, pairs, now) === "verified"));
}
