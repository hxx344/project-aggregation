import type { HubPositionItem } from './hub-bridge.ts';
import { exchangeContracts, type SpreadMarket } from './exchange-quotes.ts';

/** Current same-venue spread in percent, keyed by exchange id (for example `binance`). */
export type VenueSpreads = Record<string, { premium: number | null; stale: boolean }>;
/** Hyperliquid names the ordinary-share leg SKHX; the CEX contracts use SKHYNIX. */
export const RELATED_SYMBOLS: Record<string, readonly string[]> = { oil: ['CL', 'BZ'], 'cl-xau': ['XAU', 'CL', 'BZ'], hynix: ['SKHY', 'SKHX', 'SKHYNIX'] };
export type UnpairedReason = 'same-side' | 'multiple' | 'missing-leg';
export type SpreadPair =
  | { key: string; label: string; status: 'paired'; opening: number | null; current: number | null; currentStale: boolean }
  | { key: string; label: string; status: 'unpaired'; reason: UnpairedReason };

const HYNIX_UNITS = exchangeContracts.hynix.leftUnits;
/**
 * Each market pairs a base leg with a quote leg; the opening spread uses the same
 * formula as the live exchange comparison so the two columns are comparable.
 */
const PAIRS: Record<SpreadMarket, { base: readonly string[]; quote: readonly string[]; spread: (base: number, quote: number) => number }> = {
  oil: { base: ['CL'], quote: ['BZ'], spread: (cl, bz) => (bz - cl) / cl * 100 },
  hynix: { base: ['SKHY'], quote: ['SKHX', 'SKHYNIX'], spread: (adr, ordinary) => (adr / (ordinary / HYNIX_UNITS) - 1) * 100 },
};
export const pairedMarket = (market: string): market is SpreadMarket => market === 'oil' || market === 'hynix';

/**
 * Venues are keyed by the host's stable `exchangeId`; replies from older hosts fall back
 * to the display name lower-cased with spaces and punctuation removed, which matches
 * Monitor exchange ids (Binance -> binance).
 */
export function venueKey(item: Pick<HubPositionItem, 'exchange'> & { exchangeId?: string }) {
  return item.exchangeId ?? item.exchange.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const price = (value: string | null) => { if (value === null || value.trim() === '') return null; const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; };

/**
 * A spread is shown only for a venue holding exactly one position of each leg in
 * opposite directions; any other mix is reported as unpaired instead of guessing.
 */
export function relatedSpreadPairs(market: SpreadMarket, items: readonly HubPositionItem[], spreads: VenueSpreads | undefined): SpreadPair[] {
  const spec = PAIRS[market];
  const venues = new Map<string, { label: string; venue: string; base: HubPositionItem[]; quote: HubPositionItem[] }>();
  for (const item of items) {
    const leg = spec.base.includes(item.base) ? 'base' : spec.quote.includes(item.base) ? 'quote' : null;
    if (!leg) continue;
    const venue = venueKey(item), key = `${item.source}|${venue}`;
    const group = venues.get(key) ?? { label: `${item.source} · ${item.exchange}`, venue, base: [], quote: [] };
    group[leg].push(item);
    venues.set(key, group);
  }
  return [...venues.entries()].map(([key, group]): SpreadPair => {
    if (!group.base.length || !group.quote.length) return { key, label: group.label, status: 'unpaired', reason: 'missing-leg' };
    if (group.base.length > 1 || group.quote.length > 1) return { key, label: group.label, status: 'unpaired', reason: 'multiple' };
    const [base] = group.base, [quote] = group.quote;
    if (base.side === quote.side) return { key, label: group.label, status: 'unpaired', reason: 'same-side' };
    const baseEntry = price(base.entryPrice), quoteEntry = price(quote.entryPrice), current = spreads?.[group.venue];
    return { key, label: group.label, status: 'paired', opening: baseEntry !== null && quoteEntry !== null ? spec.spread(baseEntry, quoteEntry) : null, current: current?.premium ?? null, currentStale: current?.stale ?? false };
  });
}
