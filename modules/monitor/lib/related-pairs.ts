import type { HubPositionCycle, HubPositionItem } from './hub-bridge.ts';
import { exchangeContracts, type SpreadMarket } from './exchange-quotes.ts';

/** Current same-venue spread in percent, keyed by exchange id (for example `binance`). */
export type VenueSpreads = Record<string, { premium: number | null; stale: boolean }>;
/** Hyperliquid names the ordinary-share leg SKHX; the CEX contracts use SKHYNIX. */
export const RELATED_SYMBOLS: Record<string, readonly string[]> = { oil: ['CL', 'BZ'], 'cl-xau': ['XAU', 'CL', 'BZ'], hynix: ['SKHY', 'SKHX', 'SKHYNIX'] };
export type UnpairedReason = 'same-side' | 'multiple' | 'missing-leg';
/** Why the realized half of a pair total is missing or qualified. */
export type RealizedStatus = 'complete' | 'partial' | 'loading' | 'unavailable' | 'mixed-currency';
/**
 * Both legs added together. Unrealized comes from the open positions, realized from each
 * leg's current cycle; amounts in different currencies are never added.
 */
export type PairTotals = {
  unrealized: number | null; unrealizedCurrency: string | null; unrealizedStale: boolean;
  realizedStatus: RealizedStatus; realizedCurrency: string | null;
  realized: number | null; fees: number | null; funding: number | null; net: number | null;
  /** Unrealized plus realized net, only when both are known in the same currency. */
  total: number | null;
};
export type SpreadPair =
  | { key: string; label: string; status: 'paired'; opening: number | null; current: number | null; currentStale: boolean;
    /** Current minus opening, in percentage points. */
    change: number | null;
    /** True when a falling spread profits this pair, i.e. the leg in the numerator is short. */
    narrowingFavors: boolean;
    /** Same formula applied to both legs' average close price this cycle. */
    closing: number | null; totals: PairTotals }
  | { key: string; label: string; status: 'unpaired'; reason: UnpairedReason };

const HYNIX_UNITS = exchangeContracts.hynix.leftUnits;
/**
 * Each market pairs a base leg with a quote leg; the opening spread uses the same
 * formula as the live exchange comparison so the two columns are comparable.
 */
const PAIRS: Record<SpreadMarket, { base: readonly string[]; quote: readonly string[]; spread: (base: number, quote: number) => number; numerator: 'base' | 'quote' }> = {
  oil: { base: ['CL'], quote: ['BZ'], spread: (cl, bz) => (bz - cl) / cl * 100, numerator: 'quote' },
  hynix: { base: ['SKHY'], quote: ['SKHX', 'SKHYNIX'], spread: (adr, ordinary) => (adr / (ordinary / HYNIX_UNITS) - 1) * 100, numerator: 'base' },
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

const amount = (value: string | null | undefined) => { if (value === null || value === undefined || value.trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const price = (value: string | null | undefined) => { const number = amount(value); return number !== null && number > 0 ? number : null; };
const sum = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;
const hasClosed = (cycle: HubPositionCycle | null | undefined) => !!cycle && (cycle.status === 'complete' || cycle.status === 'partial');

function realizedStatus(base: HubPositionItem, quote: HubPositionItem): RealizedStatus {
  const cycles = [base.cycle, quote.cycle];
  if (cycles.some(cycle => !cycle || cycle.status === 'unavailable')) return 'unavailable';
  if (cycles.some(cycle => cycle?.status === 'loading')) return 'loading';
  if (!base.cycle?.currency || base.cycle.currency !== quote.cycle?.currency) return 'mixed-currency';
  return cycles.some(cycle => cycle?.status === 'partial') ? 'partial' : 'complete';
}

export function pairTotals(base: HubPositionItem, quote: HubPositionItem): PairTotals {
  const unrealizedCurrency = base.pnlCurrency && base.pnlCurrency === quote.pnlCurrency ? base.pnlCurrency : null;
  const unrealized = unrealizedCurrency ? sum(amount(base.unrealizedPnl), amount(quote.unrealizedPnl)) : null;
  const status = realizedStatus(base, quote);
  const known = status === 'complete' || status === 'partial';
  const field = (key: 'realizedPnl' | 'fees' | 'funding' | 'net') => known ? sum(amount(base.cycle?.[key]), amount(quote.cycle?.[key])) : null;
  const realizedCurrency = known ? base.cycle?.currency ?? null : null;
  const net = field('net');
  return {
    unrealized, unrealizedCurrency, unrealizedStale: base.stale || quote.stale,
    realizedStatus: status, realizedCurrency, realized: field('realizedPnl'), fees: field('fees'), funding: field('funding'), net,
    total: unrealized !== null && net !== null && unrealizedCurrency === realizedCurrency ? unrealized + net : null,
  };
}

/**
 * A spread is shown only for a venue holding exactly one position of each leg in
 * opposite directions; incomplete lists cannot establish uniqueness and yield no pairs.
 */
export function relatedSpreadPairs(market: SpreadMarket, items: readonly HubPositionItem[], spreads: VenueSpreads | undefined, incomplete = false): SpreadPair[] {
  if (incomplete) return [];
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
    const baseEntry = price(base.entryPrice), quoteEntry = price(quote.entryPrice), live = spreads?.[group.venue];
    const opening = baseEntry !== null && quoteEntry !== null ? spec.spread(baseEntry, quoteEntry) : null, current = live?.premium ?? null;
    const closed = hasClosed(base.cycle) && hasClosed(quote.cycle) && (amount(base.cycle?.closedQuantity) ?? 0) > 0 && (amount(quote.cycle?.closedQuantity) ?? 0) > 0;
    const baseClose = closed ? price(base.cycle?.closePrice) : null, quoteClose = closed ? price(quote.cycle?.closePrice) : null;
    return {
      key, label: group.label, status: 'paired', opening, current, currentStale: live?.stale ?? false,
      change: opening !== null && current !== null ? current - opening : null, narrowingFavors: (spec.numerator === 'base' ? base : quote).side === 'short',
      closing: baseClose !== null && quoteClose !== null ? spec.spread(baseClose, quoteClose) : null, totals: pairTotals(base, quote),
    };
  });
}
