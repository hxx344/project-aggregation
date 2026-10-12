import { test } from "node:test";
import assert from "node:assert/strict";
import { goldOilSummary, hynixSummary, oilSummary, summaryExpired, summaryTimestamp } from "../lib/monitor-summary.ts";
import { initialSummaries } from "../lib/initial-market.ts";

const fetchedAt = "2026-09-11T07:00:00.000Z";
const quote = { ordinary: 1500, adr: 180, equivalent: 150, spread: 30, premium: 20, fetchedAt, funding: { annualizedRate: 0.1752, fetchedAt } };

test("Hynix card retains last quote and its time when updates fail, then recovers", () => {
  const live = hynixSummary(quote);
  const stale = hynixSummary(quote, "offline");
  assert.equal(live.status, "live");
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.metrics, live.metrics);
  assert.equal(stale.fetchedAt, fetchedAt);
  assert.equal(hynixSummary(null).status, "loading");
  const failed = hynixSummary(null, "offline");
  assert.equal(failed.status, "error");
  assert.ok(failed.metrics.every(metric => metric.value === "—"));
  assert.equal(failed.fetchedAt, null);
  assert.equal(hynixSummary(quote).status, "live");
});

test("oil card shows simple annualized funding percent and labels the selected basis", () => {
  const update = { status: "snapshot", spread: 5.4321, fundingHourlyRate: -0.00003125, fundingBasis: "quantity", fetchedAt };
  const snapshot = oilSummary(update);
  assert.equal(snapshot.status, "snapshot");
  assert.equal(snapshot.metrics[0].value, "+5.432%");
  assert.equal(snapshot.metrics[1].label, "净资金费 / 年化");
  assert.equal(snapshot.metrics[1].value, "−27.38%");
  assert.equal(snapshot.metrics[1].tone, "negative");
  assert.match(snapshot.note, /等桶数/);
  const switched = oilSummary({ ...update, fundingBasis: "notional", fundingHourlyRate: 0.00002 });
  assert.equal(switched.metrics[1].value, "+17.52%");
  assert.match(switched.note, /等名义/);
  assert.equal(switched.fetchedAt, fetchedAt);
  assert.equal(oilSummary({ ...update, status: "stale" }).status, "stale");
});

test("Hynix card shows net annual funding for short ADR and clears missing funding", () => {
  const live = hynixSummary(quote);
  assert.equal(live.metrics[1].label, "净资金费 / 年化");
  assert.equal(live.metrics[1].value, "+17.52%");
  assert.equal(live.metrics[1].tone, "positive");
  assert.match(live.note, /空 10 份 ADR、多 1 股正股/);
  const negative = hynixSummary({ ...quote, funding: { ...quote.funding, annualizedRate: -0.2 } });
  assert.equal(negative.metrics[1].value, "−20.00%");
  assert.equal(negative.metrics[1].tone, "negative");
  for (const funding of [null, undefined]) {
    const missing = hynixSummary({ ...quote, funding, fundingError: "offline" });
    assert.equal(missing.status, "live");
    assert.equal(missing.metrics[0].value, "+20.00%");
    assert.equal(missing.metrics[1].value, "—");
    assert.match(missing.note, /资金费暂不可用/);
  }
  assert.equal(hynixSummary(quote).metrics[1].value, "+17.52%");
});

test("newer mids cannot mark retained older funding as freshly updated", () => {
  const oldTime = "2026-09-11T06:59:00.000Z";
  const summary = hynixSummary({ ...quote, funding: { ...quote.funding, fetchedAt: oldTime } });
  assert.equal(summary.fetchedAt, oldTime);
  assert.equal(summaryExpired(summary, 10_000, Date.parse(fetchedAt)), true);
});

test("missing values stay empty and rounded zero never appears negative", () => {
  assert.ok(oilSummary().metrics.every(metric => metric.value === "—"));
  const nearZero = hynixSummary({ ...quote, premium: -0.00001, funding: { ...quote.funding, annualizedRate: -0.0000001 } });
  assert.deepEqual(nearZero.metrics.map(metric => metric.value), ["0.00%", "0.00%"]);
  assert.ok(nearZero.metrics.every(metric => !metric.tone));
});

test("summary timestamps include the date and use Beijing time for old retained quotes", () => {
  assert.equal(summaryTimestamp(fetchedAt), "2026/09/11 15:00:00");
  assert.equal(summaryTimestamp(null), null);
  assert.equal(summaryTimestamp("invalid"), null);
});

test("Hynix tolerates normal collection and polling phase differences but expires after its 35-second source budget", () => {
  const live = hynixSummary(quote);
  const now = Date.parse(fetchedAt);
  assert.equal(live.staleAfterMs, 35_000);
  assert.equal(summaryExpired(live, 10_000, now + 29_000), false);
  assert.equal(summaryExpired(live, 10_000, now + 35_000), false);
  assert.equal(summaryExpired(live, 10_000, now + 35_001), true);
  assert.equal(summaryExpired({ ...live, status: "snapshot" }, 10_000, now + 60_000), false);
  assert.equal(summaryExpired(hynixSummary(null), 10_000, now), false);
});

test("gold/oil stays live at a normal 49-second source age and expires only beyond the 75-second collection budget", () => {
  const summary = goldOilSummary({ oilType: 'cl', source: 'Binance', status: 'live', fetchedAt, ratio: 50, funding: null });
  const now = Date.parse(fetchedAt);
  assert.equal(summary.staleAfterMs, 75_000);
  assert.equal(summaryExpired(summary, 30_000, now + 49_000), false);
  assert.equal(summaryExpired(summary, 30_000, now + 75_000), false);
  assert.equal(summaryExpired(summary, 30_000, now + 75_001), true);
});

test("server source-age metadata wins over page intervals without refreshing the source timestamp", () => {
  const gold = goldOilSummary({ oilType: 'cl', source: 'Binance', status: 'live', fetchedAt, ratio: 50, funding: null, collection: { maxAgeMs: 55_000 } });
  const hynix = hynixSummary({ ...quote, collection: { maxAgeMs: 55_000 } });
  const oil = oilSummary({ status: 'live', fetchedAt, staleAfterMs: 35_000 });
  const now = Date.parse(fetchedAt);
  for (const summary of [gold, hynix, oil]) {
    assert.equal(summary.fetchedAt, fetchedAt);
    assert.equal(summaryExpired(summary, 1000, now + summary.staleAfterMs), false);
    assert.equal(summaryExpired(summary, 300_000, now + summary.staleAfterMs + 1), true);
  }
  assert.equal(oilSummary({ status: 'live', fetchedAt }).staleAfterMs, 75_000);
  const oldFunding = hynixSummary({ ...quote, collection: { maxAgeMs: 55_000 }, funding: { ...quote.funding, fetchedAt: new Date(now - 56_000).toISOString() } });
  assert.equal(summaryExpired(oldFunding, 10_000, now), true, 'A newer price cannot refresh retained funding');
});

test("real snapshot and failed summaries retain their status regardless of age budget", () => {
  const retained = { ...quote, status: 'snapshot', collection: { maxAgeMs: 75_000 } };
  assert.equal(hynixSummary(retained).status, 'snapshot');
  assert.equal(hynixSummary(retained, 'offline').status, 'stale');
  const gold = { oilType: 'cl', source: 'Binance', status: 'snapshot', fetchedAt, ratio: 50, funding: null, collection: { maxAgeMs: 75_000 } };
  assert.equal(goldOilSummary(gold).status, 'snapshot');
  assert.equal(goldOilSummary(gold, true).status, 'stale');
  assert.equal(goldOilSummary(null, true).status, 'error');
  for (const status of ['snapshot', 'stale', 'error']) {
    const summary = oilSummary({ status, fetchedAt, staleAfterMs: 75_000 });
    assert.equal(summary.status, status);
    assert.equal(summaryExpired(summary, 10_000, Date.parse(fetchedAt) + 100_000), false);
  }
});

test("summaries without freshness metadata retain the generic interval fallback", () => {
  const summary = { status: 'live', fetchedAt, metrics: [] }, now = Date.parse(fetchedAt);
  assert.equal(summaryExpired(summary, 10_000, now + 25_000), false);
  assert.equal(summaryExpired(summary, 10_000, now + 25_001), true);
  for (const staleAfterMs of [0, -1, NaN, Infinity, '75000', 7_215_001]) {
    assert.equal(summaryExpired({ ...summary, staleAfterMs }, 10_000, now + 25_001), true);
  }
});

test("first-render oil summary uses the persisted quote source-age budget", () => {
  const leg = { markPx: 100, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: '2026-09-11T08:00:00Z' };
  const oil = { source: 'Binance', currency: 'USDT', fetchedAt, status: 'live', brent: { ...leg, coin: 'BZUSDT' }, wti: { ...leg, coin: 'CLUSDT' }, collection: { maxAgeMs: 35_000 } };
  const summary = initialSummaries({ renderedAt: Date.parse(fetchedAt) + 29_000, hynix: { quote: null, history: null }, oil: { quote: oil } }).oil;
  assert.equal(summary.staleAfterMs, 35_000);
  assert.equal(summary.fetchedAt, fetchedAt);
  assert.equal(summaryExpired(summary, 30_000, Date.parse(fetchedAt) + 35_001), true);
});
