import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from "./perpetual-types.ts";
import { contractFeeMaxAgeMs, defaultQualityBudget, resolveTakerFee, validFeePercent, type QualityBudget } from "./perpetual-fees.ts";
import { quoteCurrencyFx, type PerpetualFxSnapshot } from "./perpetual-fx.ts";

export interface PerpetualFilters {
  search: string;
  exchanges: string[] | null;
  pairMode: PerpetualPairMode;
  priceMode: PerpetualPriceMode;
  crossCurrency: boolean;
  minSpreadPercent: number;
  /** Minimum positive short-minus-long funding carry, in percentage points per eight hours. */
  minFundingSpreadPercent?: number;
  /** Scanner range inputs apply numeric bounds after discovery; other consumers keep legacy thresholds. */
  applyNumericThresholds?: boolean;
  favoritesOnly: boolean;
  favorites: string[];
  /** Gross/net use minSpreadPercent; funding uses its independent eight-hour threshold. */
  sortBy?: "gross" | "net" | "funding";
  favoritePairs?: string[];
  blockedPairs?: string[];
}

export interface PerpetualSpread {
  base: string;
  long: PerpetualQuote;
  short: PerpetualQuote;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  /** Short funding income minus long funding expense, normalized to eight hours. */
  fundingSpread8h: number | null;
  updatedAt: number;
  crossCurrency: boolean;
  /** Estimated convergence edge after four taker fills and the configured slippage budget. */
  netSpreadPercent?: number | null;
  roundTripFeePercent?: number | null;
  netUnavailableReason?: "mark" | "cross-currency" | "fees" | "budget" | null;
  fxAdjusted?: boolean;
  fxAt?: number | null;
  rawSpreadPercent?: number;
  referenceBuyPrice?: number;
  referenceSellPrice?: number;
}

/** A direction and both contracts identify an opportunity, even within the same base. */
export const perpetualSpreadKey = (row: Pick<PerpetualSpread, "base" | "long" | "short">): string =>
  JSON.stringify([row.base, `${row.long.exchange}:${row.long.symbol}`, `${row.short.exchange}:${row.short.symbol}`]);

/** Legacy asset favorites remain active until the user removes them explicitly. */
export const perpetualSpreadIsFavorite = (row: Pick<PerpetualSpread, "base" | "long" | "short">, filters: PerpetualFilters): boolean =>
  filters.favorites.includes(row.base) || (filters.favoritePairs?.includes(perpetualSpreadKey(row)) ?? false);

const stableQuotes = new Set(["USD", "USDT", "USDC", "USD1", "USDG"]);
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareLegs = (leftLong: PerpetualQuote, leftShort: PerpetualQuote, rightLong: PerpetualQuote, rightShort: PerpetualQuote): number =>
  compareText(leftLong.exchange, rightLong.exchange) || compareText(leftLong.symbol, rightLong.symbol)
  || compareText(leftShort.exchange, rightShort.exchange) || compareText(leftShort.symbol, rightShort.symbol);

export function quotePriceTime(quote: PerpetualQuote, mode: PerpetualPriceMode): number {
  const priceTime = mode === "book" ? quote.bidAskAt : quote.markAt;
  // A recent funding or ticker message must never make an older order book fresh.
  return typeof priceTime === "number" ? Math.min(priceTime, quote.receivedAt) : NaN;
}

export function quoteIsFresh(quote: PerpetualQuote, mode: PerpetualPriceMode, now: number, staleAfterMs: number): boolean {
  const timestamp = quotePriceTime(quote, mode);
  return Number.isFinite(timestamp) && Number.isFinite(now) && staleAfterMs > 0 && timestamp > 0 && timestamp <= now + 5_000 && now - timestamp <= staleAfterMs;
}

export function normalizedFunding8h(quote: PerpetualQuote, now?: number): number | null {
  if (quote.fundingRate === null || !Number.isFinite(quote.fundingRate) || !positive(quote.fundingIntervalHours) || quote.fundingIntervalHours > 168) return null;
  if (now !== undefined && (!Number.isFinite(now) || typeof quote.fundingAt !== "number" || !Number.isFinite(quote.fundingAt) || quote.fundingAt <= 0 || now - quote.fundingAt > 300_000 || quote.fundingAt > now + 5_000)) return null;
  const normalized = quote.fundingRate * 8 / quote.fundingIntervalHours;
  return Number.isFinite(normalized) ? normalized : null;
}

export function quotePrice(quote: PerpetualQuote, mode: PerpetualPriceMode, side: "buy" | "sell"): number | null {
  if (mode === "mark") return positive(quote.mark) ? quote.mark : null;
  // Crossed books indicate an incomplete or invalid upstream update.
  if (positive(quote.bid) && positive(quote.ask) && quote.bid > quote.ask) return null;
  const price = side === "buy" ? quote.ask : quote.bid;
  return positive(price) ? price : null;
}

function compatiblePair(long: PerpetualExchange, short: PerpetualExchange, mode: PerpetualPairMode): boolean {
  if (long.id === short.id) return false;
  if (mode === "cex-dex") return long.kind !== short.kind;
  if (mode === "cex-cex") return long.kind === "cex" && short.kind === "cex";
  if (mode === "dex-dex") return long.kind === "dex" && short.kind === "dex";
  return true;
}

export function rankPerpetualSpreads(snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number, budget: QualityBudget = defaultQualityBudget, fx: PerpetualFxSnapshot | null = null): PerpetualSpread[] {
  return collectPerpetualSpreads(snapshot, filters, now, false, budget, fx);
}

/** Bounded background discovery: watched pairs are sampled separately by the history service. */
export function rankBestPerpetualSpreads(snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number, budget: QualityBudget = defaultQualityBudget, fx: PerpetualFxSnapshot | null = null): PerpetualSpread[] {
  return collectPerpetualSpreads(snapshot, filters, now, true, budget, fx);
}

function rankingContext(snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number, budget: QualityBudget, fx: PerpetualFxSnapshot | null) {
  const venues = new Map(snapshot.exchanges.map(exchange => [exchange.id, exchange]));
  const selected = filters.exchanges === null ? null : new Set(filters.exchanges);
  const favorites = new Set(filters.favorites);
  const favoritePairs = new Set(filters.favoritePairs);
  const blockedPairs = new Set(filters.blockedPairs);
  const search = filters.search.trim().toUpperCase();
  const netSort = filters.sortBy === "net";
  const fundingSort = filters.sortBy === "funding";
  const applyNumericThresholds = filters.applyNumericThresholds !== false;
  const comparableMetric = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : -Infinity;
  const compare = (a: PerpetualSpread, b: PerpetualSpread) =>
    (fundingSort ? comparableMetric(b.fundingSpread8h) - comparableMetric(a.fundingSpread8h) : netSort ? comparableMetric(b.netSpreadPercent) - comparableMetric(a.netSpreadPercent) : b.spreadPercent - a.spreadPercent)
    || compareText(a.base, b.base) || compareLegs(a.long, a.short, b.long, b.short);
  return { compare, collect(base: string, source: Iterable<PerpetualQuote>, bestPerBase: boolean): PerpetualSpread[] {
    if (snapshot.status === "unavailable" || (search && !base.includes(search))) return [];
    if (filters.favoritesOnly && !favorites.has(base) && favoritePairs.size === 0) return [];
    const quotes = [];
    for (const quote of source) {
      const venue = venues.get(quote.exchange);
      if (!venue || venue.status !== "live" || quote.comparable === false || (selected && !selected.has(quote.exchange))) continue;
      if (!quoteIsFresh(quote, filters.priceMode, now, snapshot.staleAfterMs)) continue;
      // Resolve each contract once; a venue can participate in many combinations.
      quotes.push({ quote, venue, time: quotePriceTime(quote, filters.priceMode), buy: quotePrice(quote, filters.priceMode, "buy"), sell: quotePrice(quote, filters.priceMode, "sell"), funding: normalizedFunding8h(quote, now), fee: resolveTakerFee(quote, budget.takerOverrides, now).percent, fx: filters.crossCurrency ? quoteCurrencyFx(quote.quoteCurrency, fx, now) : null });
    }
    const rows: PerpetualSpread[] = [];
    if (quotes.length < 2) return rows;
    let best: PerpetualSpread | null = null;
    let bestMetric = -Infinity;
    for (const longLeg of quotes) {
      const long = longLeg.quote;
      const buyPrice = longLeg.buy;
      if (buyPrice === null) continue;
      for (const shortLeg of quotes) {
        const short = shortLeg.quote;
        if (!compatiblePair(longLeg.venue, shortLeg.venue, filters.pairMode)) continue;
        if (Math.abs(longLeg.time - shortLeg.time) > 5_000) continue;
        const crossCurrency = long.quoteCurrency !== short.quoteCurrency;
        if (crossCurrency && (!filters.crossCurrency || !stableQuotes.has(long.quoteCurrency) || !stableQuotes.has(short.quoteCurrency))) continue;
        const sellPrice = shortLeg.sell;
        if (sellPrice === null) continue;
        // Never compare unlike currency units directly or silently assume a stablecoin peg.
        if (crossCurrency && (!longLeg.fx || !shortLeg.fx)) continue;
        const referenceBuyPrice = crossCurrency ? buyPrice * longLeg.fx!.ask : buyPrice;
        const referenceSellPrice = crossCurrency ? sellPrice * shortLeg.fx!.bid : sellPrice;
        const spreadPercent = (referenceSellPrice / referenceBuyPrice - 1) * 100;
        if (!Number.isFinite(spreadPercent)) continue;
        const roundTripFeePercent = longLeg.fee === null || shortLeg.fee === null ? null : 2 * (longLeg.fee + shortLeg.fee);
        const netUnavailableReason = filters.priceMode === "mark" ? "mark" : roundTripFeePercent === null ? "fees" : !validFeePercent(budget.slippagePercent) ? "budget" : null;
        const netSpreadPercent = netUnavailableReason === null ? spreadPercent - roundTripFeePercent! - budget.slippagePercent : null;
        const longFunding = longLeg.funding, shortFunding = shortLeg.funding;
        const fundingSpread8h = longFunding === null || shortFunding === null ? null : shortFunding - longFunding;
        const metric = fundingSort ? fundingSpread8h === null ? null : fundingSpread8h * 100 : netSort ? netSpreadPercent : spreadPercent;
        if (applyNumericThresholds) {
          if (metric === null) continue;
          if (fundingSort ? !Number.isFinite(metric) || metric <= 0 || metric < (filters.minFundingSpreadPercent ?? 0) : metric < filters.minSpreadPercent) continue;
        }
        if (blockedPairs.size || (filters.favoritesOnly && !favorites.has(base))) {
          const key = perpetualSpreadKey({ base, long, short });
          if (blockedPairs.has(key) || (filters.favoritesOnly && !favorites.has(base) && !favoritePairs.has(key))) continue;
        }
        const orderingMetric = comparableMetric(metric);
        if (best && (orderingMetric < bestMetric || (orderingMetric === bestMetric && compareLegs(long, short, best.long, best.short) >= 0))) continue;
        const row: PerpetualSpread = { base, long, short, buyPrice, sellPrice, spreadPercent, fundingSpread8h,
          updatedAt: Math.min(longLeg.time, shortLeg.time), crossCurrency, roundTripFeePercent, netSpreadPercent, netUnavailableReason,
          fxAdjusted: crossCurrency, fxAt: crossCurrency ? Math.min(longLeg.fx!.at, shortLeg.fx!.at) : null,
          rawSpreadPercent: (sellPrice / buyPrice - 1) * 100, referenceBuyPrice, referenceSellPrice };
        if (bestPerBase) { best = row; bestMetric = orderingMetric; } else rows.push(row);
      }
    }
    if (best) rows.push(best);
    return rows;
  } };
}

function collectPerpetualSpreads(snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number, bestPerBase: boolean, budget: QualityBudget, fx: PerpetualFxSnapshot | null): PerpetualSpread[] {
  if (snapshot.status === "unavailable") return [];
  const context = rankingContext(snapshot, filters, now, budget, fx);
  const groups = new Map<string, PerpetualQuote[]>();
  for (const quote of snapshot.quotes) {
    const group = groups.get(quote.base);
    if (group) group.push(quote); else groups.set(quote.base, [quote]);
  }
  const rows: PerpetualSpread[] = [];
  for (const [base, quotes] of groups) rows.push(...context.collect(base, quotes, bestPerBase));
  // Compare fields directly: no per-comparison key allocation or locale-dependent ties.
  return rows.sort(context.compare);
}

/** Page-only projection. A missing saved list must not briefly reveal blocked assets. */
export function visiblePerpetualSnapshot(snapshot: PerpetualSnapshot | null, blockedBases: ReadonlySet<string> | null): PerpetualSnapshot | null {
  if (!snapshot || !blockedBases) return null;
  if (!blockedBases.size) return snapshot;
  const quotes = snapshot.quotes.filter(quote => !blockedBases.has(quote.base));
  return quotes.length === snapshot.quotes.length ? snapshot : { ...snapshot, quotes };
}

export interface PerpetualQuoteSelection {
  byKey: Map<string, PerpetualQuote>;
  keys: string[];
  baseCount: number;
}

/** Price updates replace values, not the alphabetical market ordering or filter membership. */
export function createPerpetualQuoteSelector() {
  let previousQuotes: PerpetualQuote[] | null = null;
  let byKey = new Map<string, PerpetualQuote>();
  let order: string[] = [];
  let baseCount = 0;
  let search = "", exchanges: string[] | null | undefined, favorites: string[] | undefined, favoritePairs: string[] | undefined, favoritesOnly = false;
  let keys: string[] = [];
  return (quotes: PerpetualQuote[], filters: PerpetualFilters): PerpetualQuoteSelection => {
    let catalogChanged = previousQuotes === null;
    if (quotes !== previousQuotes) {
      const next = new Map<string, PerpetualQuote>();
      for (const quote of quotes) {
        const key = `${quote.exchange}:${quote.symbol}`, previous = byKey.get(key);
        if (!previous || previous.base !== quote.base || previous.displayBase !== quote.displayBase) catalogChanged = true;
        next.set(key, quote);
      }
      if (next.size !== byKey.size) catalogChanged = true;
      byKey = next;
      previousQuotes = quotes;
      if (catalogChanged) {
        order = [...next.keys()].sort((a, b) => { const left = next.get(a)!, right = next.get(b)!; return left.base.localeCompare(right.base) || left.exchange.localeCompare(right.exchange) || left.symbol.localeCompare(right.symbol); });
        baseCount = new Set(quotes.map(quote => quote.base)).size;
      }
    }
    const nextSearch = filters.search.trim().toUpperCase();
    if (catalogChanged || search !== nextSearch || exchanges !== filters.exchanges || favorites !== filters.favorites || favoritePairs !== filters.favoritePairs || favoritesOnly !== filters.favoritesOnly) {
      search = nextSearch; exchanges = filters.exchanges; favorites = filters.favorites; favoritePairs = filters.favoritePairs; favoritesOnly = filters.favoritesOnly;
      const selected = exchanges === null ? null : new Set(exchanges);
      const starred = new Set(favorites);
      const starredContracts = new Set<string>();
      for (const key of favoritePairs ?? []) {
        try { const tuple = JSON.parse(key); if (Array.isArray(tuple) && tuple.length === 3) { starredContracts.add(tuple[1]); starredContracts.add(tuple[2]); } } catch { /* Invalid saved key. */ }
      }
      keys = order.filter(key => {
        const quote = byKey.get(key)!;
        return (!selected || selected.has(quote.exchange)) && (!favoritesOnly || starred.has(quote.base) || starredContracts.has(key))
          && (!search || `${quote.base} ${quote.displayBase ?? ""} ${quote.symbol}`.toUpperCase().includes(search));
      });
    }
    return { byKey, keys, baseCount };
  };
}

/** Missing prices are unavailable, not stale; both stay out of executable rankings. */
export function classifyPerpetualQuote(quote: PerpetualQuote, mode: PerpetualPriceMode, now: number, staleAfterMs: number): "fresh" | "stale" | "unavailable" {
  const time = quotePriceTime(quote, mode);
  if (!Number.isFinite(time) || time <= 0 || time > now + 5_000 || (quotePrice(quote, mode, "buy") === null && quotePrice(quote, mode, "sell") === null)) return "unavailable";
  return now - time > staleAfterMs ? "stale" : "fresh";
}

function quoteRankingExpiry(quote: PerpetualQuote, mode: PerpetualPriceMode, staleAfterMs: number, now: number): number {
  let expiry = Infinity;
  const deadline = (timestamp: number | null | undefined, maxAge: number) => {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return;
    if (timestamp > now + 5_000) expiry = Math.min(expiry, timestamp - 5_000);
    if (timestamp + maxAge + 1 > now) expiry = Math.min(expiry, timestamp + maxAge + 1);
  };
  deadline(quotePriceTime(quote, mode), staleAfterMs);
  deadline(quote.fundingAt, 300_000);
  deadline(quote.takerFeeAt, contractFeeMaxAgeMs);
  return expiry;
}

/** Rebuild only changed/expired assets; retained rows preserve identity across other assets' ticks. */
export function createPerpetualRankingSelector() {
  let previousQuotes: PerpetualQuote[] | null = null;
  let previousByKey = new Map<string, PerpetualQuote>();
  const groups = new Map<string, { quotes: Map<string, PerpetualQuote>; rows: PerpetualSpread[]; nextExpiry: number }>();
  let previousSettings = "";
  let settingsKey = "";
  let previousFilters: PerpetualFilters | null = null;
  let previousBudget: QualityBudget | null = null;
  let previousFx: PerpetualFxSnapshot | null = null;
  let nextFxExpiry = Infinity;
  let previousVenues = "";
  let previousStatus = "";
  let previousStaleAfter = 0;
  let previousNow = 0;
  let result: PerpetualSpread[] = [];
  return (snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number, budget: QualityBudget = defaultQualityBudget, fx: PerpetualFxSnapshot | null = null): PerpetualSpread[] => {
    const venueKey = snapshot.exchanges.map(exchange => `${exchange.id}:${exchange.kind}:${exchange.status}`).join("|");
    const statusKey = snapshot.status === "unavailable" ? "unavailable" : "available";
    if (filters !== previousFilters || budget !== previousBudget) settingsKey = JSON.stringify([filters, budget]);
    const allChanged = previousQuotes === null || settingsKey !== previousSettings || venueKey !== previousVenues || statusKey !== previousStatus || snapshot.staleAfterMs !== previousStaleAfter || now < previousNow
      || (filters.crossCurrency && (fx !== previousFx || now >= nextFxExpiry));
    const dirty = new Set<string>();
    if (snapshot.quotes !== previousQuotes) {
      const nextByKey = new Map<string, PerpetualQuote>();
      for (const quote of snapshot.quotes) {
        const key = `${quote.exchange}:${quote.symbol}`;
        const previous = previousByKey.get(key);
        nextByKey.set(key, quote);
        if (previous === quote) continue;
        if (previous && previous.base !== quote.base) {
          groups.get(previous.base)?.quotes.delete(key);
          dirty.add(previous.base);
        }
        let group = groups.get(quote.base);
        if (!group) { group = { quotes: new Map(), rows: [], nextExpiry: Infinity }; groups.set(quote.base, group); }
        group.quotes.set(key, quote);
        dirty.add(quote.base);
      }
      for (const [key, quote] of previousByKey) {
        if (nextByKey.has(key)) continue;
        groups.get(quote.base)?.quotes.delete(key);
        dirty.add(quote.base);
      }
      previousByKey = nextByKey;
    }
    for (const [base, group] of groups) {
      if (!group.quotes.size) { groups.delete(base); dirty.add(base); }
      else if (allChanged || now >= group.nextExpiry) dirty.add(base);
    }
    if (dirty.size) {
      const context = rankingContext(snapshot, filters, now, budget, fx);
      const changedRows: PerpetualSpread[] = [];
      let changedGroupCount = 0;
      for (const base of dirty) {
        const group = groups.get(base);
        if (!group) continue;
        changedGroupCount++;
        group.rows = context.collect(base, group.quotes.values(), false);
        changedRows.push(...group.rows);
        group.nextExpiry = Infinity;
        for (const quote of group.quotes.values()) group.nextExpiry = Math.min(group.nextExpiry, quoteRankingExpiry(quote, filters.priceMode, snapshot.staleAfterMs, now));
      }
      changedRows.sort(context.compare);
      if (allChanged || changedGroupCount === groups.size) result = changedRows;
      else {
        // The unaffected part is already sorted. Merge new rows without sorting the whole market.
        const merged: PerpetualSpread[] = [];
        let oldIndex = 0, changedIndex = 0;
        while (oldIndex < result.length || changedIndex < changedRows.length) {
          while (oldIndex < result.length && dirty.has(result[oldIndex].base)) oldIndex++;
          if (oldIndex >= result.length) { while (changedIndex < changedRows.length) merged.push(changedRows[changedIndex++]); break; }
          if (changedIndex >= changedRows.length || context.compare(result[oldIndex], changedRows[changedIndex]) <= 0) merged.push(result[oldIndex++]);
          else merged.push(changedRows[changedIndex++]);
        }
        result = merged;
      }
    }
    previousQuotes = snapshot.quotes; previousSettings = settingsKey; previousVenues = venueKey;
    previousFilters = filters; previousBudget = budget;
    previousFx = fx;
    nextFxExpiry = Infinity;
    if (filters.crossCurrency && fx) {
      for (const rate of Object.values(fx.rates)) {
        const deadline = rate.at + Math.min(180_000, fx.staleAfterMs) + 1;
        if (deadline > now) nextFxExpiry = Math.min(nextFxExpiry, deadline);
        if (rate.at > now + 5_000) nextFxExpiry = Math.min(nextFxExpiry, rate.at - 5_000);
      }
    }
    previousStatus = statusKey; previousStaleAfter = snapshot.staleAfterMs; previousNow = now;
    return result;
  };
}

export const defaultPerpetualFilters: PerpetualFilters = {
  search: "", exchanges: null, pairMode: "all", priceMode: "book", crossCurrency: false,
  minSpreadPercent: 0, minFundingSpreadPercent: 0, favoritesOnly: false, favorites: [],
  sortBy: "gross", favoritePairs: [], blockedPairs: [],
};

/** Versioned browser preferences are untrusted and may have been written by an older release. */
export function parsePerpetualPreferences(value: string | null): PerpetualFilters {
  if (!value) return { ...defaultPerpetualFilters, favorites: [] };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || ![1, 2].includes(parsed.version)) return { ...defaultPerpetualFilters, favorites: [] };
    const strings = (items: unknown): string[] => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string" && item.length <= 80))].slice(0, 1000) : [];
    return {
      search: typeof parsed.search === "string" ? parsed.search.slice(0, 40) : "",
      exchanges: Array.isArray(parsed.exchanges) ? strings(parsed.exchanges) : null,
      pairMode: ["all", "cex-dex", "cex-cex", "dex-dex"].includes(parsed.pairMode) ? parsed.pairMode : "all",
      priceMode: parsed.priceMode === "mark" ? "mark" : "book",
      crossCurrency: parsed.crossCurrency === true,
      minSpreadPercent: typeof parsed.minSpreadPercent === "number" && Number.isFinite(parsed.minSpreadPercent) ? Math.min(1000, Math.max(-100, parsed.minSpreadPercent)) : 0,
      minFundingSpreadPercent: typeof parsed.minFundingSpreadPercent === "number" && Number.isFinite(parsed.minFundingSpreadPercent) ? Math.min(1000, Math.max(0, parsed.minFundingSpreadPercent)) : 0,
      favoritesOnly: parsed.favoritesOnly === true,
      favorites: strings(parsed.favorites),
      sortBy: parsed.sortBy === "funding" ? "funding" : parsed.sortBy === "net" ? "net" : "gross",
      favoritePairs: parsePairKeys(parsed.favoritePairs),
      blockedPairs: parsePairKeys(parsed.blockedPairs),
    };
  } catch { return { ...defaultPerpetualFilters, favorites: [] }; }
}

/** Pair keys can contain namespaced contracts, so validate the tuple rather than splitting on ':'. */
function parsePairKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string" || key.length > 512) continue;
    try {
      const tuple = JSON.parse(key);
      if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every(item => typeof item === "string" && item.length > 0 && item.length <= 160)) continue;
      if (!tuple[1].includes(":") || !tuple[2].includes(":") || tuple[1] === tuple[2]) continue;
      keys.add(JSON.stringify(tuple));
      if (keys.size >= 1000) break;
    } catch { /* Ignore malformed browser preferences. */ }
  }
  return [...keys];
}
