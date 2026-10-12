// Reproducible bounded-history workload; synthetic inputs, no network or production files.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { createQualityHistory } from '../server/perpetual-quality-history.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'perpetual-quality-bench-'));
const filename = join(directory, 'quotes.sqlite'), history = createQualityHistory();
const store = await openPerpetualStore(filename);
const start = Math.floor(Date.now() / 300_000) * 300_000 - 86_400_000;
const exchanges = Array.from({ length: 5 }, (_, id) => ({ id: `v${id}`, kind: 'cex', status: 'live' }));
const templates = Array.from({ length: 1000 }, (_, base) => exchanges.map((exchange, leg) => ({ exchange: exchange.id, symbol: `ASSET${base}USDT`, base: `ASSET${base}`, quoteCurrency: 'USDT', bid: 100 + leg * 0.2, ask: 100.01 + leg * 0.2, fundingRate: leg * 0.00001, fundingIntervalHours: 8 }))).flat();
const times = [], writes = [];
let peakRss = process.memoryUsage.rss();
try {
  for (let minute = 0; minute <= 1440; minute++) {
    const now = start + minute * 60_000;
    const quotes = templates.map(quote => ({ ...quote, bidAskAt: now, fundingAt: now, receivedAt: now }));
    const before = performance.now();
    const sample = history.sample({ status: 'live', quotes, exchanges, staleAfterMs: 30_000 }, now);
    times.push(performance.now() - before);
    const diskAt = performance.now();
    store.saveQualitySample(sample.bucket, sample.rows);
    writes.push(performance.now() - diskAt);
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }
  assert.equal(history.metrics().trackedPairs, 1000);
  assert.equal(history.metrics().pricePoints, 60_000);
  assert.equal(history.metrics().fundingPoints, 288_000);
  let restoredBuckets = 0;
  for (const sample of store.loadQualitySamples(start + 86_400_000)) if (Number.isFinite(sample.bucket)) restoredBuckets++;
  assert.equal(restoredBuckets, 1440);
  times.sort((a, b) => a - b); writes.sort((a, b) => a - b);
  const diskBytes = (await stat(filename)).size + (await stat(`${filename}-wal`)).size;
  console.log(JSON.stringify({ inputQuotes: 5000, minutes: 1441, ...history.metrics(), restoredBuckets, sampleP50Ms: times[Math.floor(times.length / 2)], sampleP99Ms: times[Math.floor(times.length * .99)], writeP99Ms: writes[Math.floor(writes.length * .99)], peakRssMb: peakRss / 1048576, databaseAndWalMb: diskBytes / 1048576 }));
} finally {
  store.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-quality-bench-'));
  await rm(directory, { recursive: true, force: true });
}
