import type { PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from './perpetual-types.ts';
import { PERPETUAL_FUNDING_MAX_AGE_MS, PERPETUAL_LEG_SKEW_MS, normalizedFunding8h, quoteIsFresh, quotePrice, quotePriceTime } from './perpetual-spreads.ts';

export const PERPETUAL_DISPLAY_INTERVAL_MS = 20_000;
// Publish before the one-second display clock can render a held-back expiry.
const EXPIRY_MARGIN_MS = 1_000;
// A strictly periodic waiting pair is due again exactly one observed realignment gap after its last
// realignment; one display tick lets that frame arrive before the budget timer serves a newer pair.
const RESERVATION_GRACE_MS = 1_000;
// Six baseline intervals: covers realignment periods up to two minutes, and bounds how long one pair
// that stops realigning after a long skew can hold the shared recovery budget against newer pairs.
const RESERVATION_GAP_MAX_MS = 6 * PERPETUAL_DISPLAY_INTERVAL_MS;
const PRICE_MODES: PerpetualPriceMode[] = ['book', 'mark'];

type SkewedPair = { mode: PerpetualPriceMode; base: string; first: string; second: string };
const quoteKey = (quote: PerpetualQuote) => `${quote.exchange}:${quote.symbol}`;
const pairKey = ({ mode, base, first, second }: SkewedPair) => JSON.stringify([mode, base, ...[first, second].sort()]);
const liveVenues = (snapshot: PerpetualSnapshot) => new Set(snapshot.exchanges.filter(venue => venue.status === 'live').map(venue => venue.id));
// Per-leg ranking gates without user filters: candidates can only be over-approximated, never missed.
const rankable = (quote: PerpetualQuote, live: Set<string>, mode: PerpetualPriceMode, at: number, staleAfterMs: number) =>
  live.has(quote.exchange) && quote.comparable !== false && quoteIsFresh(quote, mode, at, staleAfterMs)
  && (quotePrice(quote, mode, 'buy') !== null || quotePrice(quote, mode, 'sell') !== null);
const aligned = (first: PerpetualQuote, second: PerpetualQuote, mode: PerpetualPriceMode) =>
  Math.abs(quotePriceTime(first, mode) - quotePriceTime(second, mode)) <= PERPETUAL_LEG_SKEW_MS;

/** Rankable quotes of one price mode grouped by base. */
function rankableGroups(snapshot: PerpetualSnapshot, live: Set<string>, mode: PerpetualPriceMode, at: number) {
  const groups = new Map<string, PerpetualQuote[]>();
  for (const quote of snapshot.quotes) {
    if (!rankable(quote, live, mode, at, snapshot.staleAfterMs)) continue;
    const group = groups.get(quote.base);
    if (group) group.push(quote); else groups.set(quote.base, [quote]);
  }
  return groups.values();
}

/** Pairs that were rankable and aligned when `before` was shown and only the leg time skew removes from `after`. */
function skewDroppedPairs(before: PerpetualSnapshot, beforeAt: number, after: PerpetualSnapshot, afterAt: number): SkewedPair[] {
  if (before.status === 'unavailable' || after.status === 'unavailable') return [];
  const previous = new Map(before.quotes.map(quote => [quoteKey(quote), quote]));
  const liveBefore = liveVenues(before), liveAfter = liveVenues(after), dropped: SkewedPair[] = [];
  for (const mode of PRICE_MODES) {
    for (const group of rankableGroups(after, liveAfter, mode, afterAt)) for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
      const first = group[left], second = group[right];
      if (first.exchange === second.exchange || aligned(first, second, mode)) continue;
      const shownFirst = previous.get(quoteKey(first)), shownSecond = previous.get(quoteKey(second));
      if (shownFirst && shownSecond && shownFirst.base === first.base && shownSecond.base === second.base && aligned(shownFirst, shownSecond, mode)
        && rankable(shownFirst, liveBefore, mode, beforeAt, before.staleAfterMs) && rankable(shownSecond, liveBefore, mode, beforeAt, before.staleAfterMs)) {
        dropped.push({ mode, base: first.base, first: quoteKey(first), second: quoteKey(second) });
      }
    }
  }
  return dropped;
}

/** Keep the latest accumulated frame without delaying first paint or explicit refreshes. */
export function createPerpetualDisplay({ onData, now = () => performance.now(), sourceNow, schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }: {
  onData: (snapshot: PerpetualSnapshot) => void;
  now?: () => number;
  /** Estimated source time; enables early publication before displayed quotes expire. */
  sourceNow?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  // The original regular/expiry cadence owns this baseline. Recovery publications must not
  // reset its clock, discard its pending frame, or erase a fresh-at-publication expiry obligation.
  let latest: PerpetualSnapshot | null = null, published: PerpetualSnapshot | null = null, publishedAt: number | null = null, publishedSource = 0;
  let displayed = new Map<string, PerpetualQuote>();
  // Actual publications own recovery history; the HEAD baseline above owns only its cadence.
  let recoveredAt = -Infinity, recoveryUsed = false;
  // Pairs any publication has shown rankable and aligned. A seen pair that a later publication shows
  // rankable but skewed waits for recovery, however it lost the row: a drop that coincided with an
  // offline venue or a stale leg must not hide it from recovery forever (#220).
  const seen = new Set<string>();
  // A waiting pair stays queued, and keeps its priority, while it is briefly unrankable; it is only
  // ready while rankable and aligned, and leaves the queue once a publication shows it.
  // lastReadyAt and gap (the longest wait between two such realignments, 0 until observed) count
  // only realignments in frames that pass every recovery safety check.
  const skewed = new Map<string, SkewedPair & { since: number; lastReadyAt: number; gap: number }>();
  let timer: unknown, dueAt = Infinity, stopped = false;
  let recoveryTimer: unknown, recoveryDueAt = Infinity;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; dueAt = Infinity; };
  const clearRecovery = () => { if (recoveryTimer !== undefined) cancel(recoveryTimer); recoveryTimer = undefined; recoveryDueAt = Infinity; };
  const candidatesIn = (snapshot: PerpetualSnapshot) => {
    const ready = new Set<string>();
    if (!skewed.size || snapshot.status === 'unavailable') return ready;
    const at = sourceNow?.() ?? 0, live = liveVenues(snapshot), quotes = new Map(snapshot.quotes.map(quote => [quoteKey(quote), quote]));
    for (const [key, pair] of skewed) {
      const left = quotes.get(pair.first), right = quotes.get(pair.second);
      if (left && right && left.base === pair.base && right.base === pair.base && aligned(left, right, pair.mode)
        && rankable(left, live, pair.mode, at, snapshot.staleAfterMs) && rankable(right, live, pair.mode, at, snapshot.staleAfterMs)) ready.add(key);
    }
    return ready;
  };
  const noteSafeRealignment = (ready: Set<string>) => {
    const checkedAt = now();
    for (const key of ready) {
      const pair = skewed.get(key)!;
      // Keeping the longest gap means consecutive ready frames of one realignment cannot shorten it.
      if (Number.isFinite(pair.lastReadyAt)) pair.gap = Math.max(pair.gap, checkedAt - pair.lastReadyAt);
      pair.lastReadyAt = checkedAt;
    }
  };
  const show = (snapshot: PerpetualSnapshot) => {
    if (sourceNow && snapshot.status !== 'unavailable') {
      const at = sourceNow(), since = now(), live = liveVenues(snapshot);
      for (const mode of PRICE_MODES) for (const group of rankableGroups(snapshot, live, mode, at)) {
        for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
          const first = group[left], second = group[right];
          if (first.exchange === second.exchange) continue;
          const pair = { mode, base: first.base, first: quoteKey(first), second: quoteKey(second) }, key = pairKey(pair);
          if (aligned(first, second, mode)) { seen.add(key); skewed.delete(key); }
          else if (seen.has(key) && !skewed.has(key)) skewed.set(key, { ...pair, since, lastReadyAt: -Infinity, gap: 0 });
        }
      }
    }
    onData(snapshot);
  };
  const flush = () => {
    clear(); clearRecovery();
    if (stopped || !latest) return;
    const snapshot = latest;
    latest = null; published = snapshot; publishedAt = now(); publishedSource = sourceNow?.() ?? 0;
    displayed = new Map(snapshot.quotes.map(quote => [quoteKey(quote), quote]));
    recoveryUsed = false;
    show(snapshot);
  };
  const reset = () => {
    clear(); clearRecovery(); latest = null; published = null; publishedAt = null; displayed = new Map();
    seen.clear(); skewed.clear(); recoveredAt = -Infinity; recoveryUsed = false;
  };
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
      const shown = displayed.get(quoteKey(quote));
      if (!shown || shown === quote || quote.comparable === false || !live.has(quote.exchange)) continue;
      rescue(quotePriceTime(shown, 'book'), quotePriceTime(quote, 'book'), staleAfterMs);
      rescue(quotePriceTime(shown, 'mark'), quotePriceTime(quote, 'mark'), staleAfterMs);
      rescue(shown.fundingAt, quote.fundingAt, PERPETUAL_FUNDING_MAX_AGE_MS);
    }
    return deadline - EXPIRY_MARGIN_MS - sourceNow();
  };
  /**
   * Coalesce a recovery with an imminent expiry rescue where possible. Eligibility is deliberately
   * ignored: an offline or incomparable quote can become eligible again before the regular deadline.
   */
  const expiryPending = (next: PerpetualSnapshot, at: number) => {
    const regularAt = publishedSource + PERPETUAL_DISPLAY_INTERVAL_MS;
    const due = (time: number | undefined, maxAge: number) => typeof time === 'number' && Number.isFinite(time)
      && at - time <= maxAge && time + maxAge - EXPIRY_MARGIN_MS < regularAt;
    return next.quotes.some(quote => due(quotePriceTime(quote, 'book'), next.staleAfterMs)
      || due(quotePriceTime(quote, 'mark'), next.staleAfterMs) || due(quote.fundingAt, PERPETUAL_FUNDING_MAX_AGE_MS));
  };
  /**
   * Recover skew without rotating which pairs are excluded or advancing another quote's expiry.
   * This is an additional whole-frame publication; the baseline timer and expiry protection remain
   * intact. At most one recovery is allowed between baseline publications and in any rolling 20s.
   * The longest-waiting candidate goes first: an older candidate that missed its last realignment
   * reserves the next slot until one realignment gap (its longest observed gap, at least 20s and at
   * most RESERVATION_GAP_MAX_MS) plus one display tick after that observation. A pair whose
   * realignments recur within its longest gap so far, such as a strictly periodic one within that
   * limit, is therefore ready again before its reservation lapses (#187), while a pair that stops
   * realigning blocks newer pairs for at most one such gap. Only realignments in frames that pass
   * every safety check count, so a pair whose frames are always refused, or that was never seen
   * realigned, reserves nothing.
   * One whole frame serves all currently ready pairs.
   */
  const recoveryWait = (next: PerpetualSnapshot) => {
    const ready = candidatesIn(next);
    if (!sourceNow || !ready.size || !published || next.quotes === published.quotes) return Infinity;
    const at = sourceNow(), live = liveVenues(next), quotes = new Map(next.quotes.map(quote => [quoteKey(quote), quote]));
    if (expiryPending(next, at)) return Infinity;
    const previousLive = liveVenues(published);
    for (const shown of published.quotes) {
      if (!previousLive.has(shown.exchange) || shown.comparable === false) continue;
      const quote = quotes.get(quoteKey(shown));
      for (const mode of PRICE_MODES) {
        if (!rankable(shown, previousLive, mode, at, published.staleAfterMs)) continue;
        if (!quote || quote.base !== shown.base || quote.quoteCurrency !== shown.quoteCurrency
          || !rankable(quote, live, mode, at, next.staleAfterMs)
          || quotePriceTime(quote, mode) + next.staleAfterMs < quotePriceTime(shown, mode) + published.staleAfterMs
          || (quotePrice(shown, mode, 'buy') !== null && quotePrice(quote, mode, 'buy') === null)
          || (quotePrice(shown, mode, 'sell') !== null && quotePrice(quote, mode, 'sell') === null)) return Infinity;
      }
      if (normalizedFunding8h(shown, at) !== null && (!quote || normalizedFunding8h(quote, at) === null
        || quote.fundingAt! < shown.fundingAt!)) return Infinity;
    }
    if (skewDroppedPairs(published, at, next, at).length) return Infinity;
    noteSafeRealignment(ready);
    if (recoveryUsed) return Infinity;
    const checkedAt = now();
    let oldestReady = Infinity, wait = Math.max(0, recoveredAt + PERPETUAL_DISPLAY_INTERVAL_MS - checkedAt);
    for (const key of ready) oldestReady = Math.min(oldestReady, skewed.get(key)!.since);
    for (const pair of skewed.values()) if (pair.since < oldestReady) {
      const gap = Math.min(RESERVATION_GAP_MAX_MS, Math.max(PERPETUAL_DISPLAY_INTERVAL_MS, pair.gap));
      wait = Math.max(wait, pair.lastReadyAt + gap + RESERVATION_GRACE_MS - checkedAt);
    }
    return wait;
  };
  const recover = () => {
    // An overdue recovery must not duplicate or move the already-due baseline publication.
    if (publishedAt !== null && now() >= publishedAt + PERPETUAL_DISPLAY_INTERVAL_MS) { clearRecovery(); return; }
    if (stopped || !latest) { clearRecovery(); return; }
    const wait = recoveryWait(latest);
    if (!Number.isFinite(wait)) { clearRecovery(); return; }
    if (wait > 0) {
      // Keep the original baseline timer untouched; a held realignment also wakes at its budget
      // or reservation boundary without a new frame. Recheck freshness when it executes.
      if (now() + wait < recoveryDueAt) {
        clearRecovery(); recoveryDueAt = now() + wait;
        recoveryTimer = schedule(() => { recoveryTimer = undefined; recoveryDueAt = Infinity; recover(); }, wait);
      }
      return;
    }
    clearRecovery(); recoveredAt = now(); recoveryUsed = true;
    show(latest);
  };
  return {
    accept(snapshot: PerpetualSnapshot) {
      if (stopped) return;
      latest = snapshot;
      const wait = publishedAt === null ? 0 : Math.min(PERPETUAL_DISPLAY_INTERVAL_MS - (now() - publishedAt), expiryWait(snapshot));
      if (wait <= 0) { flush(); return; }
      if (now() + wait < dueAt) { clear(); dueAt = now() + wait; timer = schedule(flush, wait); }
      recover();
    },
    flush,
    reset,
    stop() { stopped = true; reset(); },
  };
}
