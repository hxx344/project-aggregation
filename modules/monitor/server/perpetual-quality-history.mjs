import { defaultPerpetualFilters, rankBestPerpetualSpreads, quoteIsFresh, normalizedFunding8h } from '../lib/perpetual-spreads.ts';
import { qualityHistoryIdentity } from '../lib/perpetual-quality.ts';

export const QUALITY_SAMPLE_MS = 60_000;
export const QUALITY_PRICE_WINDOW_MS = 3_600_000;
export const QUALITY_FUNDING_WINDOW_MS = 86_400_000;
const FUNDING_STEP = 300_000;
const keyOf = (base, longKey, shortKey) => JSON.stringify([base, longKey, shortKey]);
const qkey = quote => `${quote.exchange}:${quote.symbol}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const signature = qualityHistoryIdentity;
function convergenceStats(points, now) {
  const byTime = new Map(points.map(point => [point[0], point[1]]));
  const horizons = [1, 4, 8].map(hours => {
    const duration = hours * QUALITY_PRICE_WINDOW_MS;
    const observedWindows = new Set(points.map(point => Math.floor(point[0] / duration) * duration));
    let completed = 0, successful = 0, incomplete = 0, pending = 0, worst = null;
    const waits = [];
    // Each horizon uses disjoint UTC windows. A successful early observation does not
    // promote a still-open or incomplete window into the completed denominator.
    for (let start = Math.ceil((now - QUALITY_FUNDING_WINDOW_MS + 1) / duration) * duration; start <= now; start += duration) {
      const initial = byTime.get(start);
      if (!finite(initial)) {
        // A missing boundary quote is a visible gap, not evidence that the window
        // began with a non-positive spread. Entirely unobserved windows stay absent.
        if (observedWindows.has(start)) { if (start + duration > now) pending++; else incomplete++; }
        continue;
      }
      if (initial < 0.05) continue;
      if (start + duration > now) { pending++; continue; }
      let missing = false, firstTarget = null, peak = initial;
      for (let at = start + FUNDING_STEP; at <= start + duration; at += FUNDING_STEP) {
        const spread = byTime.get(at);
        if (!finite(spread)) { missing = true; break; }
        peak = Math.max(peak, spread);
        if (firstTarget === null && spread <= initial * 0.5) firstTarget = (at - start) / QUALITY_SAMPLE_MS;
      }
      if (missing) { incomplete++; continue; }
      completed++;
      worst = Math.max(worst ?? 0, peak - initial);
      if (firstTarget !== null) { successful++; waits.push(firstTarget); }
    }
    waits.sort((a, b) => a - b);
    const middle = Math.floor(waits.length / 2);
    const median = waits.length ? waits.length % 2 ? waits[middle] : (waits[middle - 1] + waits[middle]) / 2 : null;
    return { hours, completed, successful, incomplete, pending, successRatio: completed ? successful / completed : null, medianMinutesToTarget: median, maxAdverseExpansionPercent: worst };
  });
  return { method: 'non-overlapping-quoted-halving-v1', windowMs: QUALITY_FUNDING_WINDOW_MS, sampleIntervalMs: FUNDING_STEP, targetFraction: 0.5, minEntrySpreadPercent: 0.05, samples: points.length, lastAt: points.at(-1)?.[0] ?? null, horizons };
}
function stats(points, expected, index = 1) {
  const count = points.length;
  if (!count) return { samples: 0, expectedSamples: expected, coverage: 0, firstAt: null, lastAt: null, mean: null, stddev: null, positiveRatio: null, signChanges: 0 };
  const mean = points.reduce((sum, point) => sum + point[index], 0) / count;
  let variance = 0, positives = 0, signChanges = 0, previous = 0;
  for (const point of points) {
    variance += (point[index] - mean) ** 2;
    if (point[index] > 0) positives++;
    const sign = Math.sign(point[index]);
    if (sign && previous && sign !== previous) signChanges++;
    if (sign) previous = sign;
  }
  return { samples: count, expectedSamples: expected, coverage: Math.min(1, count / expected), firstAt: points[0][0], lastAt: points[count - 1][0], mean, stddev: Math.sqrt(variance / count), positiveRatio: positives / count, signChanges };
}

/** Bounded per-pair rings. Never splice different venues, directions, units or missing minutes together. */
export function createQualityHistory({ maxPairs = 1000 } = {}) {
  const pairs = new Map();
  let lastBucket = 0;
  function ensure(base, longKey, shortKey, identity, now, protectedKeys = new Set()) {
    const key = keyOf(base, longKey, shortKey);
    let item = pairs.get(key);
    if (!item || item.identity !== identity) {
      if (!item && pairs.size >= maxPairs) {
        let oldest;
        for (const [id, candidate] of pairs) if (!protectedKeys.has(id) && (!oldest || candidate.selectedAt < oldest[1].selectedAt)) oldest = [id, candidate];
        if (!oldest) return null;
        pairs.delete(oldest[0]);
      }
      item = { base, longKey, shortKey, identity, selectedAt: now, spread: [], funding: [], convergence: [], convergenceCache: null };
      pairs.set(key, item);
    }
    return item;
  }
  function ingest(bucket, rows, now = bucket) {
    if (!Number.isSafeInteger(bucket) || bucket % QUALITY_SAMPLE_MS !== 0 || bucket > now || bucket <= now - QUALITY_FUNDING_WINDOW_MS || !Array.isArray(rows)) return;
    lastBucket = Math.max(lastBucket, bucket);
    for (const row of rows.slice(0, maxPairs)) {
      if (!Array.isArray(row) || row.length !== 7) continue;
      const [base, longKey, shortKey, identity, spread, longFunding, shortFunding] = row;
      if ([base, longKey, shortKey, identity].some(value => typeof value !== 'string' || value.length > 500)) continue;
      const item = ensure(base, longKey, shortKey, identity, bucket);
      if (!item) continue;
      if (finite(spread) && bucket > now - QUALITY_PRICE_WINDOW_MS && (!item.spread.length || item.spread.at(-1)[0] < bucket)) item.spread.push([bucket, spread]);
      if (bucket % FUNDING_STEP === 0 && finite(spread) && (!item.convergence.length || item.convergence.at(-1)[0] < bucket)) { item.convergence.push([bucket, spread]); item.convergenceCache = null; }
      if (bucket % FUNDING_STEP === 0 && finite(longFunding) && finite(shortFunding) && (!item.funding.length || item.funding.at(-1)[0] < bucket)) item.funding.push([bucket, shortFunding - longFunding, longFunding, shortFunding]);
      item.spread = item.spread.filter(point => point[0] > now - QUALITY_PRICE_WINDOW_MS).slice(-60);
      item.funding = item.funding.filter(point => point[0] > now - QUALITY_FUNDING_WINDOW_MS).slice(-288);
      item.convergence = item.convergence.filter(point => point[0] > now - QUALITY_FUNDING_WINDOW_MS).slice(-288);
    }
  }
  function sample(snapshot, now, watched = []) {
    const bucket = Math.floor(now / QUALITY_SAMPLE_MS) * QUALITY_SAMPLE_MS;
    if (bucket <= lastBucket) return null;
    const byKey = new Map(snapshot.quotes.map(quote => [qkey(quote), quote]));
    // Visible combinations share the existing cap with one background candidate per asset.
    const candidates = rankBestPerpetualSpreads(snapshot, { ...defaultPerpetualFilters, minSpreadPercent: -100 }, now);
    const desired = [], protectedKeys = new Set();
    for (const row of [...watched, ...candidates.map(row => ({ base: row.base, longKey: qkey(row.long), shortKey: qkey(row.short) }))]) {
      const key = keyOf(row.base, row.longKey, row.shortKey);
      if (protectedKeys.has(key)) continue;
      if (desired.length >= maxPairs) break;
      desired.push(row); protectedKeys.add(key);
    }
    for (const row of desired) {
      const long = byKey.get(row.longKey), short = byKey.get(row.shortKey);
      if (!long || !short || long.base !== row.base || short.base !== row.base || long.comparable === false || short.comparable === false || long.quoteCurrency !== short.quoteCurrency || long.exchange === short.exchange) continue;
      const item = ensure(row.base, row.longKey, row.shortKey, signature(long, short), now, protectedKeys);
      if (item) item.selectedAt = now;
    }
    const live = new Set(snapshot.exchanges.filter(venue => venue.status === 'live').map(venue => venue.id));
    const rows = [];
    for (const [key, item] of pairs) {
      if (item.selectedAt <= now - QUALITY_FUNDING_WINDOW_MS && !protectedKeys.has(key)) { pairs.delete(key); continue; }
      const long = byKey.get(item.longKey), short = byKey.get(item.shortKey);
      if (!long || !short) continue;
      if (signature(long, short) !== item.identity || long.comparable === false || short.comparable === false) { pairs.delete(key); continue; }
      const bookValid = live.has(long.exchange) && live.has(short.exchange) && quoteIsFresh(long, 'book', now, snapshot.staleAfterMs) && quoteIsFresh(short, 'book', now, snapshot.staleAfterMs)
        && Math.abs(long.bidAskAt - short.bidAskAt) <= 5000 && finite(long.ask) && finite(long.bid) && finite(short.bid) && finite(short.ask) && long.bid > 0 && short.bid > 0 && long.ask >= long.bid && short.ask >= short.bid;
      const spread = bookValid ? (short.bid / long.ask - 1) * 100 : null;
      const lf = normalizedFunding8h(long, now), sf = normalizedFunding8h(short, now);
      rows.push([item.base, item.longKey, item.shortKey, item.identity, spread, lf === null ? null : lf * 100, sf === null ? null : sf * 100]);
    }
    ingest(bucket, rows, now);
    lastBucket = bucket;
    return { bucket, rows };
  }
  return {
    sample, ingest,
    get(base, longKey, shortKey, now, includeSeries = false, expectedIdentity) {
      const candidate = pairs.get(keyOf(base, longKey, shortKey));
      const item = expectedIdentity && candidate?.identity !== expectedIdentity ? undefined : candidate;
      const prices = item?.spread.filter(point => point[0] > now - QUALITY_PRICE_WINDOW_MS && point[0] <= now) ?? [];
      const funding = item?.funding.filter(point => point[0] > now - QUALITY_FUNDING_WINDOW_MS && point[0] <= now) ?? [];
      const convergenceAt = Math.floor(now / FUNDING_STEP) * FUNDING_STEP;
      if (item && item.convergenceCache?.at !== convergenceAt) item.convergenceCache = { at: convergenceAt, value: convergenceStats(item.convergence.filter(point => point[0] > convergenceAt - QUALITY_FUNDING_WINDOW_MS && point[0] <= convergenceAt), convergenceAt) };
      const convergence = item?.convergenceCache?.value ?? convergenceStats([], convergenceAt);
      return { base, longKey, shortKey, identity: expectedIdentity ?? item?.identity, spread: stats(prices, 60), funding: { ...stats(funding, 288), longStddev: stats(funding, 288, 2).stddev, shortStddev: stats(funding, 288, 3).stddev }, convergence, ...(includeSeries ? { priceSeries: prices.map(point => [...point]) } : {}) };
    },
    metrics: () => ({ trackedPairs: pairs.size, pricePoints: [...pairs.values()].reduce((sum, pair) => sum + pair.spread.length, 0), fundingPoints: [...pairs.values()].reduce((sum, pair) => sum + pair.funding.length, 0), convergencePoints: [...pairs.values()].reduce((sum, pair) => sum + pair.convergence.length, 0) }),
  };
}
