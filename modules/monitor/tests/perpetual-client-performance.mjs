import { performance } from "node:perf_hooks";
import { createPerpetualQuoteSelector, defaultPerpetualFilters } from "../lib/perpetual-spreads.ts";
import { createPerpetualSnapshotAccumulator } from "../lib/perpetual-feed.ts";

// High-churn client benchmark: all 5,000 quotes receive a real timestamp update per frame.
const startedAt = 1800000000000;
const market = Array.from({ length: 5000 }, (_, index) => {
  const base = `ASSET${index % 1000}`, exchange = `venue${Math.floor(index / 1000)}`;
  return { exchange, symbol: `${base}USDT`, base, quoteCurrency: "USDT", bid: 100, ask: 101, mark: 100.5, last: 100,
    fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: startedAt + 3600000, sourceTime: startedAt, receivedAt: startedAt,
    bidAskAt: startedAt, markAt: startedAt, fundingAt: startedAt, transport: "ws" };
});
const frames = Array.from({ length: 50 }, (_, index) => market.map(quote => ({ ...quote, receivedAt: startedAt + index * 1000, bidAskAt: startedAt + index * 1000 })));
const before = quotes => ({ rows: quotes.filter(() => true).sort((a, b) => a.base.localeCompare(b.base) || a.exchange.localeCompare(b.exchange) || a.symbol.localeCompare(b.symbol)), baseCount: new Set(quotes.map(quote => quote.base)).size });
const measure = work => { const start = performance.now(); work(); return +(performance.now() - start).toFixed(2); };
for (let i = 0; i < 10; i++) before(market);
const beforeMs = measure(() => { for (const frame of frames) before(frame); });
const select = createPerpetualQuoteSelector();
select(market, defaultPerpetualFilters);
let reusedKeys = 0, previous = select(market, defaultPerpetualFilters).keys;
const afterMs = measure(() => { for (const frame of frames) { const next = select(frame, defaultPerpetualFilters); if (next.keys === previous) reusedKeys++; previous = next.keys; } });
const metadata = { schemaVersion: 1, monitorId: "perpetual", generatedAt: startedAt, staleAfterMs: 30000, status: "live", exchanges: [], streamId: "benchmark", sequence: 0 };
const fullQuoteDelta = { ...metadata, type: "delta", updates: frames.at(-1), removed: [] };
const fieldPatch = { ...metadata, type: "patch", sequence: 1, baseSequence: 0, patches: frames.at(-1).map(quote => [`${quote.exchange}:${quote.symbol}`, { receivedAt: quote.receivedAt, bidAskAt: quote.bidAskAt }]), removed: [] };
const merge = createPerpetualSnapshotAccumulator(); merge({ ...metadata, quotes: market });
const patchMergeMs = measure(() => { for (let index = 1; index <= 50; index++) merge({ ...fieldPatch, sequence: index, baseSequence: index - 1 }); });
const oldBytes = Buffer.byteLength(JSON.stringify(fullQuoteDelta)), patchBytes = Buffer.byteLength(JSON.stringify(fieldPatch));
const values = market.slice(0, 90).map((_, index) => 1234.567 + index);
const oldFormattingMs = measure(() => { for (let frame = 0; frame < 50; frame++) for (const value of values) value.toLocaleString("en-US", { maximumFractionDigits: 2 }); });
const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const reusedFormattingMs = measure(() => { for (let frame = 0; frame < 50; frame++) for (const value of values) formatter.format(value); });
console.log(JSON.stringify({ scenario: "50 frames; 5000 quotes / 1000 assets; every quote timestamp changes each frame", quoteSelection: { beforeMs, afterMs, alphabeticSortsBefore: 50, alphabeticSortsAfter: 0, retainedFilterKeyArrays: reusedKeys }, compactUpdates: { fullQuoteDeltaBytes: oldBytes, fieldPatchBytes: patchBytes, sizeReductionPercent: +((1 - patchBytes / oldBytes) * 100).toFixed(1), merge50FramesMs: patchMergeMs }, visiblePriceFormatting: { valuesPerFrame: 90, beforeMs: oldFormattingMs, afterMs: reusedFormattingMs } }, null, 2));
