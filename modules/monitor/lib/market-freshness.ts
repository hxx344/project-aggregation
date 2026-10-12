export type QuoteFreshness = { collection?: { maxAgeMs?: number } };

/** Use the collector's source-age budget, with bounded fallbacks for older APIs. */
export function getQuoteStaleAfterMs(quote: QuoteFreshness | null | undefined, fallbackMs: number): number {
  const maxAgeMs = quote?.collection?.maxAgeMs;
  return typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 7_215_000 ? maxAgeMs : fallbackMs;
}
