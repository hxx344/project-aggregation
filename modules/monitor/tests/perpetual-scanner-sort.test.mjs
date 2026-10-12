import { test } from "node:test";
import assert from "node:assert/strict";
import { nextScannerSort, parseScannerSort, scannerSortRequirements, sortScannerRows } from "../lib/perpetual-scanner-sort.ts";
import { scannerHistoryPairKey } from "../lib/perpetual-scanner-filters.ts";
import { PERPETUAL_MARKET_METRICS_STALE_MS } from "../lib/perpetual-market-metrics.ts";
import { PERPETUAL_FUNDING_STALE_MS } from "../lib/perpetual-funding-history.ts";

const NOW = 1_800_000_000_000;
const columns = ["fundingSpread", "annualized", "volume", "openInterest", "quote", "spread", "history24h", "history7d", "history30d"];
const histories = [["history24h", 24], ["history7d", 168], ["history30d", 720]];
const quote = (base, exchange, patch = {}) => ({
  exchange, symbol: `${base}USDT`, base, quoteCurrency: "USDT", multiplier: 1,
  bid: 1, ask: 1, mark: 1, last: 1, fundingRate: 0, fundingIntervalHours: 8,
  nextFundingAt: NOW + 3_600_000, receivedAt: NOW, sourceTime: NOW,
  transport: "websocket", bidAskAt: NOW, markAt: NOW, fundingAt: NOW, ...patch,
});
const row = (base, patch = {}) => ({ base, long: quote(base, "a"), short: quote(base, "z"), buyPrice: 1, sellPrice: 1,
  spreadPercent: 0, netSpreadPercent: 0, fundingSpread8h: 0, updatedAt: NOW, crossCurrency: false, ...patch });
const metric = (value = 0, patch = {}) => ({ value, currency: "USDT", observedAt: NOW, source: "fixture", error: "", ...patch });
const legKey = q => `${q.exchange}:${q.symbol}`;
const metricsLeg = (q, patch = {}) => ({ key: legKey(q), exchange: q.exchange, symbol: q.symbol, identity: "fixture",
  status: "ready", fetchedAt: NOW, volume24h: metric(), openInterest: metric(), error: "", ...patch });
const total = (hours, netPercent = 0, patch = {}) => ({ hours, asOf: NOW, longPercent: 0, shortPercent: netPercent, netPercent,
  longCount: 3, shortCount: 3, status: "ready", reason: "", ...patch });
const rate = (bid, ask = bid, patch = {}) => ({ bid, ask, at: NOW, source: "fixture", ...patch });
const fx = { baseCurrency: "USDT", generatedAt: NOW, staleAfterMs: 180_000, rates: { USD: rate(1.5, 2.5), USDC: rate(.5, 2.5), USDG: rate(2, 4) } };
const data = patch => ({ now: NOW, net: false, priceMode: "book", staleAfterMs: 30_000, ...patch });
const sort = (rows, column, direction = "desc", patch = {}, leg) => sortScannerRows(rows, { column, direction, ...(leg ? { leg } : {}) }, data(patch));
const ids = rows => rows.map(entry => entry.base);
const assertBoth = (rows, column, ascending, patch = {}, leg) => {
  assert.deepEqual(ids(sort(rows, column, "asc", patch, leg)), ascending, `${column}/${leg ?? "single"} asc`);
  assert.deepEqual(ids(sort(rows, column, "desc", patch, leg)), [...ascending].reverse(), `${column}/${leg ?? "single"} desc`);
};

test("preferences validate every column and direction, default dual legs, and strip irrelevant fields", () => {
  for (const column of columns) for (const direction of ["asc", "desc"]) {
    const saved = { column, direction, extra: "ignored" };
    const expected = { column, direction, ...(["volume", "openInterest", "quote"].includes(column) ? { leg: "long" } : {}) };
    assert.deepEqual(parseScannerSort(saved), expected);
    assert.deepEqual(parseScannerSort(JSON.stringify(saved)), expected);
  }
  for (const column of ["volume", "openInterest", "quote"]) {
    assert.deepEqual(parseScannerSort({ column, direction: "asc", leg: "short" }), { column, direction: "asc", leg: "short" });
    for (const leg of [null, "both", "", 1]) assert.equal(parseScannerSort({ column, direction: "desc", leg }), null);
  }
  assert.deepEqual(parseScannerSort({ column: "spread", direction: "asc", leg: "invalid" }), { column: "spread", direction: "asc" });
  for (const saved of [null, undefined, false, 2, [], "invalid", "null", "[]", "3", {}, { column: "time", direction: "desc" }, { column: "spread", direction: "descending" }, { column: "spread" }, Object.create({ column: "spread", direction: "desc" })]) {
    assert.equal(parseScannerSort(saved), null);
  }
});

test("new columns and legs begin descending, repeated clicks toggle, and single columns carry no leg", () => {
  for (const column of columns) {
    const initial = nextScannerSort(null, column), asc = nextScannerSort(initial, column), desc = nextScannerSort(asc, column);
    assert.equal(initial.direction, "desc");
    assert.equal(asc.direction, "asc");
    assert.deepEqual(desc, initial);
  }
  assert.deepEqual(nextScannerSort({ column: "volume", direction: "asc", leg: "long" }, "volume", "short"), { column: "volume", direction: "desc", leg: "short" });
  assert.deepEqual(nextScannerSort({ column: "quote", direction: "desc", leg: "short" }, "quote"), { column: "quote", direction: "desc", leg: "long" });
  assert.deepEqual(nextScannerSort({ column: "spread", direction: "desc" }, "annualized", "short"), { column: "annualized", direction: "desc" });
});

test("requirements request only each sort's supporting dataset", () => {
  assert.deepEqual(scannerSortRequirements(null), { metrics: false, historyHours: [], needsFx: false });
  for (const column of columns) assert.deepEqual(scannerSortRequirements({ column, direction: "desc" }), {
    metrics: ["volume", "openInterest"].includes(column),
    historyHours: histories.filter(([name]) => name === column).map(([, hours]) => hours),
    needsFx: ["volume", "openInterest", "quote"].includes(column),
  });
});

test("funding and annualized sorts normalize intervals and use signed current rates in both directions", () => {
  const low = row("A", { long: quote("A", "a", { fundingRate: .00015, fundingIntervalHours: 4 }), short: quote("A", "z", { fundingRate: .0001 }), fundingSpread8h: 100 });
  const high = row("B", { short: quote("B", "z", { fundingRate: .0002, fundingIntervalHours: 4 }), fundingSpread8h: -100 });
  const zero = row("C");
  for (const column of ["fundingSpread", "annualized"]) assertBoth([high, zero, low], column, ["A", "C", "B"]);
});

test("volume and open interest sort each selected leg independently and preserve real zero", () => {
  const a = row("A"), b = row("B"), rows = [b, a];
  const metrics = {
    [legKey(a.long)]: metricsLeg(a.long, { volume24h: metric(0), openInterest: metric(20) }),
    [legKey(b.long)]: metricsLeg(b.long, { volume24h: metric(10), openInterest: metric(1) }),
    [legKey(a.short)]: metricsLeg(a.short, { volume24h: metric(20), openInterest: metric(0) }),
    [legKey(b.short)]: metricsLeg(b.short, { volume24h: metric(0), openInterest: metric(30) }),
  };
  assertBoth(rows, "volume", ["A", "B"], { metrics }, "long");
  assertBoth(rows, "volume", ["B", "A"], { metrics }, "short");
  assertBoth(rows, "openInterest", ["B", "A"], { metrics }, "long");
  assertBoth(rows, "openInterest", ["A", "B"], { metrics }, "short");
});

test("quote sort uses displayed normalized prices once, retains precision, and chooses the requested leg", () => {
  const a = row("A", { buyPrice: 1.0000002, sellPrice: 2.0000001, long: quote("A", "a", { ask: 1000, multiplier: 1000 }) });
  const b = row("B", { buyPrice: 1.0000001, sellPrice: 2.0000002, long: quote("B", "a", { ask: 100, multiplier: .01 }) });
  for (const priceMode of ["book", "mark"]) {
    assertBoth([a, b], "quote", ["B", "A"], { priceMode }, "long");
    assertBoth([a, b], "quote", ["A", "B"], { priceMode }, "short");
  }
});

test("spread sorts retain signed precision and switch between gross and net without gross fallback", () => {
  const a = row("A", { spreadPercent: -.000041, netSpreadPercent: .000002 });
  const b = row("B", { spreadPercent: .000041, netSpreadPercent: -.000002 });
  const zero = row("C"), missing = row("0", { spreadPercent: 100, netSpreadPercent: undefined });
  assertBoth([b, zero, a], "spread", ["A", "C", "B"]);
  assertBoth([b, zero, a], "spread", ["B", "C", "A"], { net: true });
  assert.deepEqual(ids(sort([missing, a, b, zero], "spread", "asc", { net: true })), ["B", "C", "A", "0"]);
  assert.deepEqual(ids(sort([missing, a, b, zero], "spread", "desc", { net: true })), ["A", "C", "B", "0"]);
});

test("all historical windows sort their own full signed totals, including the reverse pair direction", () => {
  const a = row("A"), b = row("B"), reverse = row("A", { long: a.short, short: a.long });
  const history = {
    [scannerHistoryPairKey(a)]: { 24: total(24, -2), 168: total(168, 3), 720: total(720, 0) },
    [scannerHistoryPairKey(b)]: { 24: total(24, 1), 168: total(168, -1), 720: total(720, .0000004) },
  };
  assertBoth([a, b], "history24h", ["A", "B"], { history });
  assertBoth([a, b], "history7d", ["B", "A"], { history });
  assertBoth([a, b], "history30d", ["A", "B"], { history });
  assert.deepEqual(sortScannerRows([reverse, a, b], { column: "history24h", direction: "asc" }, data({ history })), [a, b, reverse]);
  assert.deepEqual(sortScannerRows([a, b, reverse], { column: "history7d", direction: "desc" }, data({ history })), [a, b, reverse]);
});

test("monetary sorts compare USDT equivalents through current midpoints instead of assuming dollar pegs", () => {
  const specs = [["A", "USDT", 2.1], ["B", "USD", 1.1], ["C", "USDC", 1.5], ["D", "USDG", .76]];
  const rows = specs.map(([base, currency, value]) => row(base, { buyPrice: value, sellPrice: value, long: quote(base, "a", { quoteCurrency: currency }), short: quote(base, "z", { quoteCurrency: currency }) }));
  const metrics = Object.fromEntries(rows.flatMap((entry, index) => [entry.long, entry.short].map(q => [legKey(q), metricsLeg(q, {
    volume24h: metric(specs[index][2], { currency: specs[index][1] }), openInterest: metric(specs[index][2], { currency: specs[index][1] }),
  })])));
  for (const column of ["quote", "volume", "openInterest"]) for (const leg of ["long", "short"]) assertBoth([...rows].reverse(), column, ["A", "B", "C", "D"], { fx, metrics }, leg);
  // USDT values remain usable even before the FX dataset arrives.
  for (const column of ["quote", "volume", "openInterest"]) for (const direction of ["asc", "desc"]) {
    assert.equal(sort([...rows].reverse(), column, direction, { metrics })[0], rows[0]);
    assert.equal(sort([...rows].reverse(), column, direction, { metrics, fx: { ...fx, rates: {} } })[0], rows[0]);
  }
});

test("amount sorting rejects pending, stale, erroneous or mismatched evidence while keeping zero ahead", () => {
  const valid = row("Z"), absent = row("A"), rows = [absent, valid];
  for (const column of ["volume", "openInterest"]) for (const side of ["long", "short"]) {
    const field = column === "volume" ? "volume24h" : "openInterest", q = absent[side];
    const selected = metricsLeg(valid[side], { [field === "volume24h" ? "openInterest" : "volume24h"]: metric(null, { error: "other field unavailable" }), fetchedAt: 0 });
    const patches = [null, { status: "pending" }, { status: "error" }, { status: "unsupported" }, { key: "wrong" }, { exchange: "other" }, { symbol: "wrong" },
      ...[{ value: null }, { value: NaN }, { value: Infinity }, { value: -1 }, { error: "retained failed value" }, { currency: null }, { observedAt: NOW - PERPETUAL_MARKET_METRICS_STALE_MS - 1 }, { observedAt: NOW + 5001 }].map(patch => ({ [field]: metric(100, patch) }))];
    for (const patch of patches) for (const direction of ["asc", "desc"]) {
      const metrics = { [legKey(valid[side])]: selected, ...(patch ? { [legKey(q)]: metricsLeg(q, patch) } : {}) };
      assert.deepEqual(ids(sort(rows, column, direction, { metrics }, side)), ["Z", "A"]);
    }
  }
});

test("non-USDT amount and quote evidence with stale, missing, or unknown FX always ranks last", () => {
  const valid = row("Z"), unavailable = row("A", { buyPrice: 100, long: quote("A", "a", { quoteCurrency: "USD" }) });
  const metrics = { [legKey(valid.long)]: metricsLeg(valid.long), [legKey(unavailable.long)]: metricsLeg(unavailable.long, { volume24h: metric(100, { currency: "USD" }), openInterest: metric(100, { currency: "USD" }) }) };
  for (const column of ["quote", "volume", "openInterest"]) for (const direction of ["asc", "desc"]) for (const currentFx of [null, { ...fx, rates: {} }, { ...fx, rates: { USD: rate(2, 2, { at: NOW - 180_001 }) } }, { ...fx, rates: { USD: rate(2, 2, { at: NOW + 5001 }) } }]) {
    assert.deepEqual(ids(sort([unavailable, valid], column, direction, { metrics, fx: currentFx })), ["Z", "A"]);
  }
  const unknown = { ...unavailable, long: { ...unavailable.long, quoteCurrency: "UNKNOWN" } };
  assert.deepEqual(ids(sort([unknown, valid], "quote", "desc", { fx })), ["Z", "A"]);
});

test("historical pending, partial, stale and invalid totals always follow known zero in either direction", () => {
  const valid = row("Z"), unavailable = row("A");
  for (const [column, hours] of histories) {
    const patches = [null, ...["pending", "partial", "stale", "error", "unsupported"].map(status => ({ status })), { hours: 72 }, { netPercent: null }, { netPercent: NaN }, { netPercent: Infinity }, { asOf: NOW - PERPETUAL_FUNDING_STALE_MS - 1 }, { asOf: NOW + 5001 }, { asOf: null }];
    for (const patch of patches) for (const direction of ["asc", "desc"]) {
      const history = { [scannerHistoryPairKey(valid)]: { [hours]: total(hours) }, ...(patch ? { [scannerHistoryPairKey(unavailable)]: { [hours]: total(hours, 100, patch) } } : {}) };
      assert.deepEqual(ids(sort([unavailable, valid], column, direction, { history })), ["Z", "A"]);
    }
  }
});

test("funding missing, invalid and expired data never becomes zero or outranks valid negative carry", () => {
  const valid = row("Z", { short: quote("Z", "z", { fundingRate: -.0001 }) });
  const patches = [{ fundingRate: null }, { fundingRate: NaN }, { fundingRate: Infinity }, { fundingIntervalHours: 0 }, { fundingIntervalHours: 169 }, { fundingAt: null }, { fundingAt: NOW - 300_001 }, { fundingAt: NOW + 5001 }];
  for (const patch of patches) for (const column of ["fundingSpread", "annualized"]) for (const direction of ["asc", "desc"]) {
    const unavailable = row("A", { long: quote("A", "a", patch) });
    assert.deepEqual(ids(sort([unavailable, valid], column, direction)), ["Z", "A"]);
  }
});

test("quotes and spread enforce selected price-clock freshness and reject nonfinite comparison values", () => {
  const valid = row("Z");
  for (const mode of ["book", "mark"]) {
    const clock = mode === "book" ? "bidAskAt" : "markAt";
    for (const side of ["long", "short"]) for (const patch of [{ [clock]: NOW - 30_001 }, { receivedAt: NOW - 30_001 }, { [clock]: NOW + 5001, receivedAt: NOW + 5001 }]) {
      const unavailable = row("A", { [side]: quote("A", side === "long" ? "a" : "z", patch) });
      for (const direction of ["asc", "desc"]) for (const column of ["quote", "spread"]) assert.deepEqual(ids(sort([unavailable, valid], column, direction, { priceMode: mode }, side)), ["Z", "A"]);
    }
    // Freshness is tied to the selected field; a stale unused price must not disqualify it.
    const boundary = row("A", { long: quote("A", "a", { [clock]: NOW - 30_000, [mode === "book" ? "markAt" : "bidAskAt"]: 0 }) });
    assert.deepEqual(ids(sort([valid, boundary], "quote", "asc", { priceMode: mode })), ["A", "Z"]);
  }
  for (const value of [null, undefined, NaN, Infinity, 0, -1]) for (const direction of ["asc", "desc"]) {
    assert.deepEqual(ids(sort([row("A", { buyPrice: value }), valid], "quote", direction)), ["Z", "A"]);
  }
  for (const value of [null, undefined, NaN, Infinity]) for (const direction of ["asc", "desc"]) {
    assert.deepEqual(ids(sort([row("A", { spreadPercent: value }), valid], "spread", direction)), ["Z", "A"]);
  }
});

test("freshness boundaries remain inclusive for metric, history, and funding sorts", () => {
  const a = row("A", { short: quote("A", "z", { fundingRate: .0001, fundingAt: NOW - 300_000 }) }), b = row("B");
  const metrics = { [legKey(a.long)]: metricsLeg(a.long, { volume24h: metric(1, { observedAt: NOW - PERPETUAL_MARKET_METRICS_STALE_MS }) }), [legKey(b.long)]: metricsLeg(b.long) };
  const history = { [scannerHistoryPairKey(a)]: { 24: total(24, 1, { asOf: NOW - PERPETUAL_FUNDING_STALE_MS }) }, [scannerHistoryPairKey(b)]: { 24: total(24) } };
  for (const column of ["fundingSpread", "annualized", "volume", "history24h"]) assertBoth([a, b], column, ["B", "A"], { metrics, history });
});

test("ties use stable pair identity in both directions across different input orders without mutation", () => {
  const a = row("A"), b = row("B"), c = row("A", { short: quote("A", "y") }), rows = Object.freeze([b, a, c]);
  const snapshot = structuredClone(rows);
  for (const column of columns) for (const direction of ["asc", "desc"]) {
    const result = sort(rows, column, direction);
    assert.deepEqual(result, [c, a, b], `${column} ${direction}`);
    assert.deepEqual(sort([...rows].reverse(), column, direction), result);
    assert.notEqual(result, rows);
    assert.equal(result[0], c);
  }
  assert.deepEqual(rows, snapshot);
});

test("sorting covers the full result set before a caller selects its page", () => {
  const rows = Array.from({ length: 65 }, (_, index) => row(`ASSET${String(index).padStart(2, "0")}`, { spreadPercent: index }));
  const sorted = sort(rows, "spread");
  assert.deepEqual(ids(sorted.slice(0, 30)), rows.slice(35).reverse().map(entry => entry.base));
  assert.equal(sorted[30], rows[34]);
  assert.equal(sorted[64], rows[0]);
  assert.equal(rows[0].base, "ASSET00");
});
