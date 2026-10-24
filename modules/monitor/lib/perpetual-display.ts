import type { PerpetualQuote, PerpetualSnapshot } from './perpetual-types.ts';
import { PERPETUAL_FUNDING_MAX_AGE_MS, quotePriceTime } from './perpetual-spreads.ts';

export const PERPETUAL_DISPLAY_INTERVAL_MS = 20_000;
// Publish before the one-second display clock can render a held-back expiry.
const EXPIRY_MARGIN_MS = 1_000;

/** Keep the latest accumulated frame without delaying first paint or explicit refreshes. */
export function createPerpetualDisplay({ onData, now = () => performance.now(), sourceNow, schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }: {
  onData: (snapshot: PerpetualSnapshot) => void;
  now?: () => number;
  /** Estimated source time; enables early publication before displayed quotes expire. */
  sourceNow?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  let latest: PerpetualSnapshot | null = null, published: PerpetualSnapshot | null = null, publishedAt: number | null = null, publishedSource = 0;
  let displayed = new Map<string, PerpetualQuote>();
  let timer: unknown, dueAt = Infinity, stopped = false;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; dueAt = Infinity; };
  const flush = () => {
    clear();
    if (stopped || !latest) return;
    const snapshot = latest;
    latest = null; published = snapshot; publishedAt = now(); publishedSource = sourceNow?.() ?? 0;
    displayed = new Map(snapshot.quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]));
    onData(snapshot);
  };
  const reset = () => { clear(); latest = null; published = null; publishedAt = null; displayed = new Map(); };
  /** Sampling must not expire a displayed quote whose newer observation is already held back. */
  const expiryWait = (next: PerpetualSnapshot) => {
    if (!sourceNow || !published || next.quotes === published.quotes) return Infinity;
    const staleAfterMs = published.staleAfterMs, regularAt = publishedSource + PERPETUAL_DISPLAY_INTERVAL_MS;
    const live = new Set(next.exchanges.filter(venue => venue.status === 'live').map(venue => venue.id));
    let deadline = Infinity;
    const rescue = (time: number | undefined, newer: number | undefined, maxAge: number) => {
      // Only quotes fresh when published count, and only observations that survive
      // the regular interval; publishing a nearly expired confirmation keeps nothing visible.
      if (typeof time === 'number' && Number.isFinite(time) && typeof newer === 'number' && Number.isFinite(newer)
        && publishedSource - time <= maxAge && newer + maxAge > regularAt) deadline = Math.min(deadline, time + maxAge);
    };
    for (const quote of next.quotes) {
      const shown = displayed.get(`${quote.exchange}:${quote.symbol}`);
      if (!shown || shown === quote || quote.comparable === false || !live.has(quote.exchange)) continue;
      rescue(quotePriceTime(shown, 'book'), quotePriceTime(quote, 'book'), staleAfterMs);
      rescue(quotePriceTime(shown, 'mark'), quotePriceTime(quote, 'mark'), staleAfterMs);
      rescue(shown.fundingAt, quote.fundingAt, PERPETUAL_FUNDING_MAX_AGE_MS);
    }
    return deadline - EXPIRY_MARGIN_MS - sourceNow();
  };
  return {
    accept(snapshot: PerpetualSnapshot) {
      if (stopped) return;
      latest = snapshot;
      const wait = publishedAt === null ? 0 : Math.min(PERPETUAL_DISPLAY_INTERVAL_MS - (now() - publishedAt), expiryWait(snapshot));
      if (wait <= 0) flush();
      else if (now() + wait < dueAt) { clear(); dueAt = now() + wait; timer = schedule(flush, wait); }
    },
    flush,
    reset,
    stop() { stopped = true; reset(); },
  };
}
