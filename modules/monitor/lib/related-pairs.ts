import type { HubPositionItem } from './hub-bridge.ts';

/** Current same-venue spread in percent, keyed by exchange id (for example `binance`). */
export type VenueSpreads = Record<string, { premium: number | null; stale: boolean }>;
/** Hyperliquid names the ordinary-share leg SKHX; the CEX contracts use SKHYNIX. */
export const RELATED_SYMBOLS: Record<string, readonly string[]> = { oil: ['CL', 'BZ'], 'cl-xau': ['XAU', 'CL', 'BZ'], hynix: ['SKHY', 'SKHX', 'SKHYNIX'] };
export type UnpairedReason = 'same-side' | 'multiple' | 'missing-leg';
export type SpreadPair =
  | { key: string; label: string; status: 'paired'; opening: number | null; current: number | null; currentStale: boolean }
  | { key: string; label: string; status: 'unpaired'; reason: UnpairedReason };

/**
 * Venues are keyed by the host's stable `exchangeId`; replies from older hosts fall back
 * to the display name lower-cased with spaces and punctuation removed, which matches
 * Monitor exchange ids (Binance -> binance).
 */
export function venueKey(item: Pick<HubPositionItem, 'exchange'> & { exchangeId?: string }) {
  return item.exchangeId ?? item.exchange.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const finite = (value: string | null) => { if (value === null || value.trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; };

/**
 * A spread is shown only for a venue holding exactly one CL and one BZ position in
 * opposite directions; any other mix is reported as unpaired instead of guessing.
 */
export function oilSpreadPairs(items: readonly HubPositionItem[], spreads: VenueSpreads | undefined): SpreadPair[] {
  const venues = new Map<string, { label: string; venue: string; cl: HubPositionItem[]; bz: HubPositionItem[] }>();
  for (const item of items) {
    if (item.base !== 'CL' && item.base !== 'BZ') continue;
    const venue = venueKey(item), key = `${item.source}|${venue}`;
    const group = venues.get(key) ?? { label: `${item.source} · ${item.exchange}`, venue, cl: [], bz: [] };
    (item.base === 'CL' ? group.cl : group.bz).push(item);
    venues.set(key, group);
  }
  return [...venues.entries()].map(([key, group]): SpreadPair => {
    if (!group.cl.length || !group.bz.length) return { key, label: group.label, status: 'unpaired', reason: 'missing-leg' };
    if (group.cl.length > 1 || group.bz.length > 1) return { key, label: group.label, status: 'unpaired', reason: 'multiple' };
    const [cl] = group.cl, [bz] = group.bz;
    if (cl.side === bz.side) return { key, label: group.label, status: 'unpaired', reason: 'same-side' };
    const clEntry = finite(cl.entryPrice), bzEntry = finite(bz.entryPrice), current = spreads?.[group.venue];
    return { key, label: group.label, status: 'paired', opening: clEntry && bzEntry !== null ? (bzEntry - clEntry) / clEntry * 100 : null, current: current?.premium ?? null, currentStale: current?.stale ?? false };
  });
}
