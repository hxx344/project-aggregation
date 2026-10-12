import { test } from "node:test";
import assert from "node:assert/strict";
import { SCANNER_RANGE_IDS, defaultScannerRangeInputs, parseScannerRangeInputs, compileScannerRanges, evaluateScannerRanges, scannerHistoryPairKey } from "../lib/perpetual-scanner-filters.ts";
import { PERPETUAL_MARKET_METRICS_STALE_MS } from "../lib/perpetual-market-metrics.ts";
import { PERPETUAL_FUNDING_STALE_MS } from "../lib/perpetual-funding-history.ts";

const NOW = 1_800_000_000_000;
const quote = (exchange, patch = {}) => ({ exchange, symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", fundingRate: 0, fundingIntervalHours: 8, fundingAt: NOW, ...patch });
const row = (patch = {}) => ({ base: "BTC", long: quote("a"), short: quote("z"), spreadPercent: 0, fundingSpread8h: 0, updatedAt: NOW, ...patch });
const metric = (value = 0, patch = {}) => ({ value, currency: "USD", observedAt: NOW, source: "fixture", error: "", ...patch });
const leg = (exchange, patch = {}) => ({ key: `${exchange}:BTCUSDT`, exchange, symbol: "BTCUSDT", identity: "fixture", status: "ready", fetchedAt: NOW, volume24h: metric(), openInterest: metric(), error: "", ...patch });
const total = (hours, patch = {}) => ({ hours, asOf: NOW, longPercent: 0, shortPercent: 0, netPercent: 0, longCount: 3, shortCount: 3, status: "ready", reason: "", ...patch });
const fxRate = (mid, patch = {}) => ({ bid: mid, ask: mid, at: NOW, source: "fixture", ...patch });
const fx = { baseCurrency: "USDT", generatedAt: NOW, staleAfterMs: 180_000, rates: { USD: fxRate(2), USDC: fxRate(1.5), USDG: fxRate(3) } };
const compile = inputs => compileScannerRanges(parseScannerRangeInputs(inputs));
const evaluate = (inputs, data = {}, spread = row()) => evaluateScannerRanges(spread, compile(inputs), { now: NOW, ...data });
const history = (values, spread = row()) => ({ [scannerHistoryPairKey(spread)]: values });

test("ten ranges default to unrestricted inputs with independent restored objects", () => {
  assert.equal(SCANNER_RANGE_IDS.length, 10);
  assert.deepEqual(compile(null).active, []);
  assert.deepEqual(compile(null).historyHours, []);
  assert.equal(compile(null).needsMetrics, false);
  assert.equal(compile(null).needsFx, false);
  assert.equal(compile(null).valid, true);
  assert.equal(evaluate(null, { now: NaN }, row({ spreadPercent: NaN, long: quote("a", { fundingRate: null }) })), "match");
  const restored = parseScannerRangeInputs(null);
  restored.longVolume.min = "1M";
  assert.equal(defaultScannerRangeInputs.longVolume.min, "");
  assert.equal(parseScannerRangeInputs(null).longVolume.min, "");
});

test("stored preferences restore exact text, ignore malformed structures, and preserve invalid text as an error", () => {
  const saved = { longVolume: { min: " 1.5m ", max: "2B" }, spread: { min: "-0.1", max: "0%" }, unknown: { min: "7" } };
  assert.deepEqual(parseScannerRangeInputs(saved), parseScannerRangeInputs(JSON.stringify(saved)));
  assert.equal(parseScannerRangeInputs(saved).longVolume.min, " 1.5m ");
  for (const broken of [null, undefined, "broken", "null", "[]", "3", 2, false, []]) assert.deepEqual(parseScannerRangeInputs(broken), defaultScannerRangeInputs);
  const malformed = parseScannerRangeInputs({ longVolume: 4, shortVolume: { min: 0, max: [] }, spread: { min: "oops", max: null }, fundingSpread: ["1", "2"] });
  assert.deepEqual(malformed.longVolume, { min: "", max: "" });
  assert.deepEqual(malformed.shortVolume, { min: "", max: "" });
  assert.deepEqual(malformed.spread, { min: "oops", max: "" });
  assert.equal(compileScannerRanges(malformed).valid, false);
  assert.equal(evaluateScannerRanges(row(), compileScannerRanges(malformed), { now: NOW }), "reject");
  assert.deepEqual(parseScannerRangeInputs(Object.create({ longVolume: { min: "4" } })), defaultScannerRangeInputs);
});

test("amounts accept case-insensitive K/M/B and signed percentage bounds stay in percentage points", () => {
  for (const [input, expected] of [["1k", 1e3], ["1.25K", 1250], [".5m", 500_000], ["2 M", 2e6], ["3b", 3e9], ["+4B", 4e9], ["0", 0], [" 5. ", 5]]) {
    assert.equal(compile({ longVolume: { min: input } }).ranges.longVolume.min, expected);
  }
  const compiled = compile({ spread: { min: "-1.25%", max: "+.5" }, fundingSpread: { max: "-0.01" }, annualized: { min: "-100" }, history24h: { max: "-2" }, history7d: { min: "0" }, history30d: { max: "5" } });
  assert.deepEqual(compiled.ranges.spread, { min: -1.25, max: 0.5 });
  assert.deepEqual(compiled.historyHours, [24, 168, 720]);
  assert.equal(compiled.needsMetrics, false);
  assert.equal(compiled.needsFx, false);
  assert.equal(compile({ longOpenInterest: { max: " 1m " } }).needsFx, true);
  assert.equal(compile({ shortOpenInterest: { max: " 1m " } }).needsMetrics, true);
  assert.deepEqual(compile({ shortVolume: { min: " \t ", max: "\n" } }).active, []);
});

test("invalid, non-finite and reversed bounds have explicit errors and never become zero", () => {
  for (const input of ["oops", "1,000", "1e3", "NaN", "Infinity", "0x10", "--1", ".", "1 2", "1Kx", "9".repeat(400)]) {
    const compiled = compile({ longVolume: { min: input } });
    assert.equal(compiled.valid, false, input);
    assert.ok(compiled.errors.longVolume);
    assert.equal(compiled.ranges.longVolume, undefined);
  }
  for (const input of ["-1", "1%", "-0.1M"]) assert.equal(compile({ longVolume: { min: input } }).valid, false);
  for (const input of ["1M", "1e-2", "1%%", "--1", "Infinity"]) assert.equal(compile({ spread: { min: input } }).valid, false);
  for (const id of SCANNER_RANGE_IDS) {
    const compiled = compile({ [id]: { min: "2", max: "1" } });
    assert.equal(compiled.errors[id], "最小值不能大于最大值");
    assert.equal(evaluateScannerRanges(row(), compiled, { now: NOW }), "reject");
  }
});

test("all ten inclusive ranges match their own field and reject values outside either bound", () => {
  const spread = row({ spreadPercent: -0.5, short: quote("z", { fundingRate: -0.0002 }), fundingSpread8h: -0.0002 });
  const data = {
    now: NOW,
    metrics: { "a:BTCUSDT": leg("a", { volume24h: metric(1000), openInterest: metric(3000) }), "z:BTCUSDT": leg("z", { volume24h: metric(2000), openInterest: metric(4000) }) },
    history: history({ 24: total(24, { netPercent: -1 }), 168: total(168, { netPercent: -2 }), 720: total(720, { netPercent: -3 }) }),
  };
  const values = { longVolume: 1000, shortVolume: 2000, longOpenInterest: 3000, shortOpenInterest: 4000, spread: -.5, fundingSpread: -.02, annualized: -21.9, history24h: -1, history7d: -2, history30d: -3 };
  for (const [id, value] of Object.entries(values)) {
    // Decimal funding normalization may round at the last binary digit.
    assert.equal(evaluate({ [id]: { min: String(value - 1e-10), max: String(value + 1e-10) } }, data, spread), "match", id);
    assert.equal(evaluate({ [id]: { min: String(value + 1) } }, data, spread), "reject", id);
    assert.equal(evaluate({ [id]: { max: String(value - 1) } }, data, spread), "reject", id);
  }
  assert.equal(evaluate({ longVolume: { min: "1K", max: "1k" } }, data, spread), "match");
  assert.equal(evaluate({ history30d: { min: "-3", max: "-3" } }, data, spread), "match");
  assert.equal(evaluate(Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { min: String(value - 1e-10), max: String(value + 1e-10) }])), data, spread), "match");
});

test("known zero is valid for every field and absent data is never treated as zero", () => {
  const data = { metrics: { "a:BTCUSDT": leg("a"), "z:BTCUSDT": leg("z") }, history: history({ 24: total(24), 168: total(168), 720: total(720) }) };
  for (const id of SCANNER_RANGE_IDS) assert.equal(evaluate({ [id]: { min: "0", max: "0" } }, data), "match", id);
  assert.equal(evaluate({ longVolume: { min: "0" } }), "pending");
  assert.equal(evaluate({ longVolume: { min: "0" } }, { metrics: { "a:BTCUSDT": leg("a", { volume24h: metric(null) }) } }), "missing");
  assert.equal(evaluate({ spread: { min: "0" } }, {}, row({ spreadPercent: NaN })), "missing");
  assert.equal(evaluate({ fundingSpread: { max: "0" } }, {}, row({ long: quote("a", { fundingRate: null }) })), "missing");
  assert.equal(evaluate({ history24h: { min: "0" } }), "pending");
});

test("only selected metric fields are required, with field errors and leg status respected", () => {
  const inputs = { longVolume: { min: "0" } };
  const check = patch => evaluate(inputs, { metrics: { "a:BTCUSDT": leg("a", patch) } });
  assert.equal(check({ openInterest: metric(null, { error: "unavailable", observedAt: 0 }) }), "match");
  assert.equal(check({ fetchedAt: 0 }), "match", "observation age is measured on the selected metric");
  assert.equal(check({ status: "pending" }), "pending");
  assert.equal(check({ status: "pending", error: "指标缓存队列繁忙，稍后重试" }), "missing");
  for (const status of ["error", "unsupported"]) assert.equal(check({ status }), "missing");
  for (const patch of [{ error: "retained failed value" }, { value: null }, { value: -1 }, { value: NaN }, { value: Infinity }, { currency: null }]) assert.equal(check({ volume24h: metric(0, patch) }), "missing");
  for (const patch of [{ key: "wrong" }, { symbol: "ETHUSDT" }, { exchange: "other" }]) assert.equal(check(patch), "missing");
  assert.equal(evaluate({ longVolume: { min: "0" }, shortVolume: { min: "0" } }, { metrics: { "a:BTCUSDT": leg("a") } }), "pending");
});

test("metric observation timestamps include the exact stale boundary and reject invalid or future evidence", () => {
  const check = (observedAt, now = NOW) => evaluate({ longVolume: { min: "0" } }, { now, metrics: { "a:BTCUSDT": leg("a", { volume24h: metric(0, { observedAt }) }) } });
  assert.equal(check(NOW - PERPETUAL_MARKET_METRICS_STALE_MS), "match");
  assert.equal(check(NOW - PERPETUAL_MARKET_METRICS_STALE_MS - 1), "missing");
  assert.equal(check(NOW + 5000), "match");
  for (const timestamp of [NOW + 5001, 0, -1, null, NaN, Infinity]) assert.equal(check(timestamp), "missing");
  assert.equal(check(NOW, NaN), "missing");
});

test("USD is native while USDT, USDC and USDG use both current conversion midpoints", () => {
  const check = (currency, expected, fxValue = fx) => evaluate({ longVolume: { min: String(expected), max: String(expected) } }, { fx: fxValue, metrics: { "a:BTCUSDT": leg("a", { volume24h: metric(100, { currency }) }) } });
  assert.equal(check("USD", 100, null), "match");
  assert.equal(check("USDT", 50), "match");
  assert.equal(check("USDC", 75), "match");
  assert.equal(check("USDG", 150), "match");
  const spreadFx = { ...fx, rates: { USD: fxRate(2, { bid: 1, ask: 3 }), USDC: fxRate(1.5, { bid: 1, ask: 2 }) } };
  assert.equal(check("USDC", 75, spreadFx), "match");
  assert.equal(check("USDT", 100), "reject", "USDT must not silently be treated as USD");
  assert.equal(check("USDC", 75, null), "pending");
  assert.equal(check("USDG", 0, { ...fx, rates: {} }), "missing");
  assert.equal(check("USDT", 0, { ...fx, rates: {} }), "missing", "USDT still requires the USD rate");
  assert.equal(check("USDC", 0, { ...fx, rates: { USD: fx.rates.USD } }), "missing");
  assert.equal(check("UNKNOWN", 0), "missing");
  for (const currency of ["USD", "USDC"]) {
    assert.equal(check("USDC", 75, { ...fx, rates: { ...fx.rates, [currency]: { ...fx.rates[currency], at: NOW - 180_001 } } }), "missing");
    assert.equal(check("USDC", 75, { ...fx, rates: { ...fx.rates, [currency]: { ...fx.rates[currency], at: NOW + 5001 } } }), "missing");
  }
  assert.equal(check("USDC", 75, { ...fx, rates: Object.fromEntries(Object.entries(fx.rates).map(([key, rate]) => [key, { ...rate, at: NOW - 180_000 }])) }), "match");
});

test("funding difference and annualized use signed normalized rates with current funding timestamps", () => {
  const spread = row({ long: quote("a", { fundingRate: -.0001, fundingIntervalHours: 4 }), short: quote("z", { fundingRate: -.0003, fundingIntervalHours: 8 }) });
  assert.equal(evaluate({ fundingSpread: { min: "-.01001", max: "-.00999" }, annualized: { min: "-10.951", max: "-10.949" } }, {}, spread), "match");
  for (const fundingAt of [NOW - 300_000, NOW + 5000]) assert.equal(evaluate({ fundingSpread: { min: "0", max: "0" } }, {}, row({ long: quote("a", { fundingAt }) })), "match");
  for (const patch of [{ fundingAt: NOW - 300_001 }, { fundingAt: NOW + 5001 }, { fundingAt: null }, { fundingRate: NaN }, { fundingIntervalHours: 0 }, { fundingIntervalHours: null }]) {
    for (const id of ["fundingSpread", "annualized"]) assert.equal(evaluate({ [id]: { max: "100" } }, {}, row({ long: quote("a", patch) })), "missing");
  }
});

test("compact historical totals reverse sign while sharing the same canonical pair identity", () => {
  const forward = row(), reverse = row({ long: forward.short, short: forward.long });
  assert.equal(scannerHistoryPairKey(forward), '["BTC","a:BTCUSDT","z:BTCUSDT"]');
  assert.equal(scannerHistoryPairKey(reverse), scannerHistoryPairKey(forward));
  for (const [id, hours] of [["history24h", 24], ["history7d", 168], ["history30d", 720]]) {
    const data = { history: history({ [hours]: total(hours, { netPercent: 2 }) }) };
    assert.equal(evaluate({ [id]: { min: "2", max: "2" } }, data, forward), "match");
    assert.equal(evaluate({ [id]: { min: "-2", max: "-2" } }, data, reverse), "match");
    assert.equal(evaluate({ [id]: { min: "2" } }, data, reverse), "reject");
  }
  const namespaced = row({ long: quote("hyperliquid", { symbol: "xyz:BTC" }) });
  assert.equal(scannerHistoryPairKey(namespaced), '["BTC","hyperliquid:xyz:BTC","z:BTCUSDT"]');
  assert.notEqual(scannerHistoryPairKey(row({ base: "WBTC" })), scannerHistoryPairKey(forward));
});

test("historical filtering requires ready complete fresh totals even when a retained numeric total exists", () => {
  const check = patch => evaluate({ history24h: { min: "0" } }, { history: history({ 24: total(24, patch) }) });
  assert.equal(check({ status: "pending" }), "pending");
  for (const status of ["partial", "stale", "error", "unsupported"]) assert.equal(check({ status }), "missing");
  for (const patch of [{ hours: 168 }, { netPercent: null }, { netPercent: NaN }, { netPercent: Infinity }, { asOf: null }, { asOf: 0 }, { asOf: NOW + 5001 }, { asOf: NOW - PERPETUAL_FUNDING_STALE_MS - 1 }]) assert.equal(check(patch), "missing");
  assert.equal(check({ asOf: NOW - PERPETUAL_FUNDING_STALE_MS }), "match");
  assert.equal(check({ asOf: NOW + 5000 }), "match");
});

test("known rejection outranks unavailable fields and missing outranks pending for coverage", () => {
  const inputs = { longVolume: { min: "0" }, shortVolume: { min: "0" }, history24h: { min: "0" }, spread: { min: "1" } };
  assert.equal(evaluate(inputs), "reject");
  const allowedPrice = { ...inputs, spread: { min: "0" } };
  assert.equal(evaluate(allowedPrice), "pending");
  assert.equal(evaluate(allowedPrice, { metrics: { "a:BTCUSDT": leg("a", { status: "error" }) } }), "missing");
});
