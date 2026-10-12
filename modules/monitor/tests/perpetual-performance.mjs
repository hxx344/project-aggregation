import { performance } from "node:perf_hooks";
import { createPerpetualRankingSelector, defaultPerpetualFilters, rankPerpetualSpreads } from "../lib/perpetual-spreads.ts";
import { createPerpetualSnapshotAccumulator } from "../lib/perpetual-feed.ts";
import { createPerpetualService, createPerpetualDelta } from '../server/perpetual-service.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

// Deterministic browser-compute proxy. No network calls and no timing assertions.
const now = 1800000000000;
const exchanges = Array.from({ length: 5 }, (_, i) => ({ id: `venue${i}`, name: `Venue ${i}`, kind: i < 3 ? "cex" : "dex", status: "live", marketCount: 1000, quoteCount: 1000, lastMessageAt: now, error: null }));
let quotes = Array.from({ length: 5000 }, (_, i) => ({ exchange: `venue${i % 5}`, symbol: `ASSET${Math.floor(i / 5)}USDT`, base: `ASSET${Math.floor(i / 5)}`, quoteCurrency: "USDT", bid: 100 + i % 5, ask: 100.1 + i % 5, mark: 100.05 + i % 5, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: now + 3600000, fundingAt: now, sourceTime: now, receivedAt: now, bidAskAt: now, markAt: now, transport: "ws" }));
const base = { schemaVersion: 1, monitorId: "perpetual", status: "live", generatedAt: now, staleAfterMs: 30000, exchanges, quotes };
const frames = Array.from({ length: 100 }, (_, i) => {
  if (i % 10 === 0) quotes = quotes.map((quote, index) => index < 50 ? { ...quote, bid: quote.bid + 0.001, ask: quote.ask + 0.001, bidAskAt: now + i * 50, receivedAt: now + i * 50 } : quote);
  return { ...base, quotes, generatedAt: now + i * 50 };
});
for (let warm = 0; warm < 10; warm++) rankPerpetualSpreads(base, defaultPerpetualFilters, now);
function measure(work) { const started = performance.now(); work(); return performance.now() - started; }
const baselineMs = measure(() => { for (const frame of frames) { rankPerpetualSpreads(frame, defaultPerpetualFilters, frame.generatedAt); rankPerpetualSpreads(frame, defaultPerpetualFilters, frame.generatedAt + 1); } });
const select = createPerpetualRankingSelector();
let previous = null, recalculations = 0;
const optimizedMs = measure(() => { for (const frame of frames) for (const timestamp of [frame.generatedAt, frame.generatedAt + 1]) { const result = select(frame, defaultPerpetualFilters, timestamp); if (result !== previous) recalculations++; previous = result; } });
const delta = { type: "delta", schemaVersion: 1, monitorId: "perpetual", status: "live", generatedAt: now + 1, staleAfterMs: 30000, exchanges, storageError: null, updates: quotes.slice(0, 50), removed: [] };
const fullBytes = Buffer.byteLength(JSON.stringify({ ...base, quotes }));
const deltaBytes = Buffer.byteLength(JSON.stringify(delta));
const merge = createPerpetualSnapshotAccumulator(); const first = merge(base); let preservedFrames = 0;
for (let i = 0; i < 100; i++) if (merge({ ...delta, generatedAt: now + i + 1, updates: [] }).quotes === first.quotes) preservedFrames++;
const service = createPerpetualService({ exchanges, clock: () => now, store: { load: () => quotes } });
const snapshotMs = measure(() => { for (let i = 0; i < 100; i++) service.snapshot(); }) / 100;
const wireState = new Map(quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]));
const deltaMs = measure(() => { for (let i = 0; i < 100; i++) createPerpetualDelta({ ...base, quotes }, wireState); }) / 100;
const compressedBytes = gzipSync(JSON.stringify(delta), { level: 1 }).length;
const directory = await mkdtemp(join(tmpdir(), 'perpetual-benchmark-'));
let store, initialWriteMs, incrementalWriteMs;
try {
  store = await openPerpetualStore(join(directory, 'market.sqlite'));
  initialWriteMs = measure(() => store.save(quotes));
  incrementalWriteMs = measure(() => { for (let i = 0; i < 10; i++) store.save(quotes.slice(0, 50).map(quote => ({ ...quote, receivedAt: now + i }))); }) / 10;
} finally {
  store?.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-benchmark-'));
  await rm(directory, { recursive: true, force: true });
}
const rounded = value => +value.toFixed(2);
console.log(JSON.stringify({ scenario: "5000 quotes / 1000 assets / 5 venues; 100 frames, 1% quotes change every 10 frames", baseline: { recalculations: 200, elapsedMs: rounded(baselineMs), fullFrameBytes: fullBytes }, optimized: { recalculations, elapsedMs: rounded(optimizedMs), deltaFrameBytes: deltaBytes, unchangedFramesPreservingQuoteArray: preservedFrames }, backend: { snapshotMs: rounded(snapshotMs), deltaMs: rounded(deltaMs), compressedDeltaBytes: compressedBytes, initial5000QuoteWriteMs: rounded(initialWriteMs), incremental50QuoteWriteMs: rounded(incrementalWriteMs) }, ratio: { computeReductionPercent: +((1 - optimizedMs / baselineMs) * 100).toFixed(1), frameSizeReductionPercent: +((1 - deltaBytes / fullBytes) * 100).toFixed(1) } }, null, 2));
