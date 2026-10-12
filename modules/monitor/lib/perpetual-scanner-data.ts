import type { FundingHistoryPairRequest, FundingWindowHours, FundingWindowTotal } from './perpetual-funding-history.ts';
import type { PerpetualMarketMetricsLeg } from './perpetual-market-metrics.ts';
import type { PerpetualSpread } from './perpetual-spreads.ts';
import type { PerpetualQuote } from './perpetual-types.ts';

export interface ScannerDataPair extends FundingHistoryPairRequest { identity?: string }
export interface ScannerDataRequirements { metrics: boolean; historyHours: FundingWindowHours[] }
export interface PerpetualScannerDataReport {
  schemaVersion: 1;
  generatedAt: number;
  metrics: Record<string, PerpetualMarketMetricsLeg>;
  /** The lexical first contract is the long leg in each canonical result. */
  history: Record<string, Partial<Record<FundingWindowHours, FundingWindowTotal>>>;
  storageError?: string;
  /** Browser queue progress for the entire subscribed candidate set. */
  progress?: { total: number; completed: number; pending: number; deferred: number };
}
export interface ScannerDataRequest extends ScannerDataRequirements { pairs: ScannerDataPair[] }

interface ScannerDataLegIdentity { key: string; quote: PerpetualQuote; identity: string; seen: number }
interface ScannerDataSelectionEntry {
  pair: ScannerDataPair;
  first: ScannerDataLegIdentity;
  second: ScannerDataLegIdentity;
  sortKey: string;
  seen: number;
}

function sameScannerDataLegIdentity(left: PerpetualQuote, right: PerpetualQuote): boolean {
  return left.base === right.base && left.quoteCurrency === right.quoteCurrency
    && (left.marketId ?? null) === (right.marketId ?? null) && (left.multiplier ?? 1) === (right.multiplier ?? 1)
    && (left.contractUnit ?? null) === (right.contractUnit ?? null)
    && (left.collateralCurrency ?? null) === (right.collateralCurrency ?? null)
    && (left.settlementCurrency ?? null) === (right.settlementCurrency ?? null);
}

/** Keep subscription membership independent of quote ticks, rank order and direction.
 * Only changed catalog identities are serialized; departed candidates are released. */
export function createScannerDataPairSelector() {
  const legs = new Map<string, ScannerDataLegIdentity>();
  const groups = new Map<string, Map<string, Map<string, ScannerDataSelectionEntry>>>();
  let entries: ScannerDataSelectionEntry[] = [], result: ScannerDataPair[] = [], revision = 0;
  const legIdentity = (quote: PerpetualQuote): ScannerDataLegIdentity => {
    const key = `${quote.exchange}:${quote.symbol}`, previous = legs.get(key);
    if (previous && (previous.quote === quote || sameScannerDataLegIdentity(previous.quote, quote))) {
      previous.quote = quote; previous.seen = revision;
      return previous;
    }
    const identity = JSON.stringify([key, quote.base, quote.quoteCurrency, quote.marketId ?? null, quote.multiplier ?? 1,
      quote.contractUnit ?? null, quote.collateralCurrency ?? null, quote.settlementCurrency ?? null]);
    const next = { key, quote, identity, seen: revision };
    legs.set(key, next);
    return next;
  };
  return (rows: readonly PerpetualSpread[]): ScannerDataPair[] => {
    revision++;
    const selected: ScannerDataSelectionEntry[] = [];
    let changed = false;
    for (const row of rows) {
      const long = legIdentity(row.long), short = legIdentity(row.short);
      const first = long.key < short.key ? long : short, second = long.key < short.key ? short : long;
      let base = groups.get(row.base);
      if (!base) { base = new Map(); groups.set(row.base, base); }
      let pairs = base.get(first.key);
      if (!pairs) { pairs = new Map(); base.set(first.key, pairs); }
      let entry = pairs.get(second.key);
      if (!entry) {
        entry = { pair: { base: row.base, longKey: first.key, shortKey: second.key }, first, second,
          sortKey: JSON.stringify([row.base, first.key, second.key]), seen: 0 };
        pairs.set(second.key, entry);
      }
      if (entry.pair.identity === undefined || entry.first !== first || entry.second !== second) {
        // Preserve the existing locale ordering inside catalog fingerprints.
        const identity = first.key.localeCompare(second.key) <= 0 ? `[${first.identity},${second.identity}]` : `[${second.identity},${first.identity}]`;
        entry.pair = { base: row.base, longKey: first.key, shortKey: second.key, identity };
        entry.first = first; entry.second = second; changed = true;
      }
      if (entry.seen !== revision) { entry.seen = revision; selected.push(entry); }
    }
    for (const entry of entries) if (entry.seen !== revision) {
      const base = groups.get(entry.pair.base)!, pairs = base.get(entry.pair.longKey)!;
      pairs.delete(entry.pair.shortKey);
      if (!pairs.size) base.delete(entry.pair.longKey);
      if (!base.size) groups.delete(entry.pair.base);
    }
    for (const [key, leg] of legs) if (leg.seen !== revision) legs.delete(key);
    if (changed || selected.length !== entries.length) {
      selected.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      entries = selected;
      result = entries.map(entry => entry.pair);
    }
    return result;
  };
}

export function canonicalScannerDataPair(pair: ScannerDataPair): ScannerDataPair {
  const [longKey, shortKey] = [pair.longKey, pair.shortKey].sort();
  return { base: pair.base, longKey, shortKey, ...(pair.identity === undefined ? {} : { identity: pair.identity }) };
}
export function scannerDataPairKey(pair: FundingHistoryPairRequest): string {
  const [first, second] = [pair.longKey, pair.shortKey].sort();
  return JSON.stringify([pair.base, first, second]);
}
export function scannerDataSelectionKey(pairs: ScannerDataPair[]): string {
  const unique = new Map(pairs.map(pair => [scannerDataPairKey(pair), canonicalScannerDataPair(pair)]));
  return JSON.stringify([...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair));
}
export function scannerDataRequirementsKey(requirements: ScannerDataRequirements): string {
  return JSON.stringify({ metrics: requirements.metrics, historyHours: [...new Set(requirements.historyHours)].sort((a, b) => a - b) });
}
/** Consumers never need to infer which direction a cached canonical sum uses. */
export function scannerDataHistoryForPair(report: PerpetualScannerDataReport | null | undefined, pair: FundingHistoryPairRequest, hours: FundingWindowHours): FundingWindowTotal | undefined {
  const value = report?.history[scannerDataPairKey(pair)]?.[hours];
  if (!value || pair.longKey < pair.shortKey) return value;
  return { ...value, longPercent: value.shortPercent, shortPercent: value.longPercent,
    longCount: value.shortCount, shortCount: value.longCount, netPercent: value.netPercent === null ? null : -value.netPercent };
}
