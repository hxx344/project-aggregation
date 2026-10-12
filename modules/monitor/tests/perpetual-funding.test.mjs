import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, perpetualSpreadKey, rankBestPerpetualSpreads, rankPerpetualSpreads } from "../lib/perpetual-spreads.ts";
import { estimatePerpetualHoldingScenario } from "../lib/perpetual-opportunity.ts";

const now = 1_800_000_000_000;
const venue = (id, kind = "cex", status = "live") => ({ id, name: id, kind, status, marketCount: 1, quoteCount: 1, lastMessageAt: now, error: null });
const quote = (exchange, overrides = {}) => ({ exchange, symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0, fundingIntervalHours: 8, nextFundingAt: now + 3_600_000, sourceTime: now, receivedAt: now, transport: "ws", bidAskAt: now, markAt: now, fundingAt: now, ...overrides });
const snapshot = (quotes, exchanges = [venue("a"), venue("b"), venue("c", "dex")]) => ({ schemaVersion: 1, monitorId: "perpetual", status: "live", generatedAt: now, staleAfterMs: 30_000, exchanges, quotes });
const fundingFilters = { ...defaultPerpetualFilters, sortBy: "funding" };
const budget = { takerOverrides: { binance: 0.05, gate: 0.05, hyperliquid: 0.05 }, slippagePercent: 0.1 };
const rank = (data, filters = {}, fx = null) => rankPerpetualSpreads(data, { ...fundingFilters, ...filters }, now, budget, fx);
const directions = rows => rows.map(row => `${row.base}:${row.long.exchange}>${row.short.exchange}`);

test("funding ranking captures every positive carry direction despite adverse entry prices and normalizes 1/4/8h periods", () => {
  const data = snapshot([
    quote("a", { fundingRate: 0.000125, fundingIntervalHours: 1 }),
    quote("b", { bid: 104, ask: 105, fundingRate: 0.000125, fundingIntervalHours: 4 }),
    quote("c", { bid: 102, ask: 103, fundingRate: 0.0005, fundingIntervalHours: 8 }),
  ]);
  const rows = rank(data, { minSpreadPercent: 1000 });
  assert.deepEqual(directions(rows), ["BTC:b>a", "BTC:c>a", "BTC:b>c"]);
  assert.deepEqual(rows.map(row => row.fundingSpread8h), [0.00075, 0.0005, 0.00025]);
  assert.ok(rows.every(row => row.spreadPercent < 0));
  assert.equal(rows[0].buyPrice, 105); assert.equal(rows[0].sellPrice, 99);
  assert.deepEqual(directions(rank(data, { minFundingSpreadPercent: 0.05, minSpreadPercent: 1000 })), ["BTC:b>a", "BTC:c>a"]);
  assert.deepEqual(rank(data, { minFundingSpreadPercent: 0.076, minSpreadPercent: -100 }), []);
  assert.deepEqual(rankBestPerpetualSpreads(data, fundingFilters, now, budget), [rows[0]]);
  const venueIds = { a: "binance", b: "gate", c: "hyperliquid" };
  const knownFees = snapshot(data.quotes.map(q => ({ ...q, exchange: venueIds[q.exchange] })), data.exchanges.map(v => ({ ...v, id: venueIds[v.id] })));
  assert.ok(rank(knownFees).every(row => row.netSpreadPercent < 0));
  for (const sortBy of ["gross", "net"]) {
    assert.deepEqual(rank(knownFees, { sortBy, minFundingSpreadPercent: 1000 }), rank(knownFees, { sortBy }));
    assert.deepEqual(directions(rank(knownFees, { sortBy })).sort(), ["BTC:binance>gate", "BTC:binance>hyperliquid", "BTC:hyperliquid>gate"]);
  }
  const missingFees = rankPerpetualSpreads(data, fundingFilters, now);
  assert.deepEqual(directions(missingFees), directions(rows));
  assert.ok(missingFees.every(row => row.netSpreadPercent === null && row.netUnavailableReason === "fees"));
});

test("negative and zero funding rates retain correct long/short signs and never admit zero carry", () => {
  const data = snapshot([
    quote("a", { fundingRate: -0.0004 }), quote("b", { fundingRate: -0.0001 }),
    quote("c"), quote("d"),
  ], [venue("a"), venue("b"), venue("c"), venue("d")]);
  const rows = rank(data, { minFundingSpreadPercent: 0, minSpreadPercent: -100 });
  assert.deepEqual(directions(rows), ["BTC:a>c", "BTC:a>d", "BTC:a>b", "BTC:b>c", "BTC:b>d"]);
  assert.ok(rows.every(row => row.short.fundingRate > row.long.fundingRate && row.fundingSpread8h > 0));
  assert.deepEqual(rank(snapshot([quote("a"), quote("b")]), { minSpreadPercent: -100 }), []);
});

test("equal funding carry keeps the stable base and contract order for full and best-per-base ranking", () => {
  const quotes = [
    quote("c", { fundingRate: 0.001 }), quote("a", { symbol: "BTCUSDT-Z" }),
    quote("b", { fundingRate: 0.001 }), quote("a"),
    quote("b", { base: "ETH", symbol: "ETHUSDT", fundingRate: 0.001 }),
    quote("a", { base: "ETH", symbol: "ETHUSDT" }),
  ];
  const expected = [
    '["BTC","a:BTCUSDT","b:BTCUSDT"]', '["BTC","a:BTCUSDT","c:BTCUSDT"]',
    '["BTC","a:BTCUSDT-Z","b:BTCUSDT"]', '["BTC","a:BTCUSDT-Z","c:BTCUSDT"]',
    '["ETH","a:ETHUSDT","b:ETHUSDT"]',
  ];
  for (const source of [quotes, [...quotes].reverse()]) {
    const data = snapshot(source);
    assert.deepEqual(rank(data).map(perpetualSpreadKey), expected);
    assert.deepEqual(rankBestPerpetualSpreads(data, fundingFilters, now, budget).map(perpetualSpreadKey), [expected[0], expected[4]]);
  }
});

test("funding normalization rejects invalid observations and periods without treating zero rates as missing", () => {
  const invalid = [
    { fundingRate: null }, { fundingRate: NaN }, { fundingRate: Infinity }, { fundingRate: Number.MAX_VALUE },
    { fundingIntervalHours: null }, { fundingIntervalHours: 0 }, { fundingIntervalHours: -1 },
    { fundingIntervalHours: 169 }, { fundingIntervalHours: NaN }, { fundingIntervalHours: Infinity },
    { fundingIntervalHours: Number.MIN_VALUE, fundingRate: 1 },
    { fundingAt: undefined }, { fundingAt: null }, { fundingAt: NaN }, { fundingAt: Infinity },
    { fundingAt: 0 }, { fundingAt: -1 }, { fundingAt: now - 300_001 }, { fundingAt: now + 5_001 },
  ];
  for (const patch of invalid) {
    const invalidQuote = quote("a", { fundingRate: -0.001, ...patch });
    assert.equal(normalizedFunding8h(invalidQuote, now), null, String(Object.keys(patch)));
    assert.deepEqual(rank(snapshot([invalidQuote, quote("b", { bid: 102, ask: 103 })])), []);
  }
  assert.equal(normalizedFunding8h(quote("a"), now), 0);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: 0.0001, fundingIntervalHours: 168 }), now), 0.0001 * 8 / 168);
  assert.equal(normalizedFunding8h(quote("a", { fundingAt: now - 300_000 }), now), 0);
  assert.equal(normalizedFunding8h(quote("a", { fundingAt: now + 5_000 }), now), 0);
  assert.equal(normalizedFunding8h(quote("a"), NaN), null);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: -0.0001, fundingIntervalHours: 4 })), -0.0002);
});

test("unknown next settlement preserves normalized discovery while the 24h cashflow scenario stays unknown", () => {
  for (const nextFundingAt of [null, NaN, now, now + 20 * 3_600_000]) {
    const rows = rank(snapshot([quote("a", { nextFundingAt }), quote("b", { fundingRate: 0.001 })]));
    assert.equal(rows.length, 1); assert.equal(rows[0].fundingSpread8h, 0.001);
    const scenario = estimatePerpetualHoldingScenario(rows[0], budget, { holdingHours: 24, exitSpreadPercent: rows[0].spreadPercent }, now);
    assert.equal(scenario.long.cashflowPercent, null);
    assert.equal(scenario.fundingPercent, null); assert.equal(scenario.estimatedNetPercent, null);
  }
});

test("funding opportunities retain market validity, venue, search, pair, favorite and block filters", () => {
  const data = snapshot([quote("a"), quote("b", { fundingRate: 0.001 }), quote("c", { fundingRate: 0.002 })]);
  const all = rank(data), favoriteKey = perpetualSpreadKey(all[0]);
  assert.deepEqual(directions(rank(data, { exchanges: ["a", "c"] })), ["BTC:a>c"]);
  assert.deepEqual(rank(data, { exchanges: [] }), []);
  assert.deepEqual(directions(rank(data, { pairMode: "cex-cex" })), ["BTC:a>b"]);
  assert.equal(rank(data, { pairMode: "cex-dex" }).length, 2);
  assert.deepEqual(rank(data, { search: "ETH" }), []);
  assert.deepEqual(rank(data, { favoritesOnly: true, favorites: ["ETH"] }), []);
  assert.deepEqual(rank(data, { favoritesOnly: true, favoritePairs: [favoriteKey] }), [all[0]]);
  assert.deepEqual(rank(data, { favoritesOnly: true, favoritePairs: [favoriteKey], blockedPairs: [favoriteKey] }), []);
  assert.equal(rank(data, { favoritesOnly: true, favorites: ["BTC"] }).length, 3);
  assert.equal(rank(data, { blockedPairs: [favoriteKey] }).length, 2);
  for (const patch of [{ bidAskAt: now - 30_001 }, { bidAskAt: now - 5_001 }, { bidAskAt: now + 5_001, receivedAt: now + 5_001 }, { bidAskAt: undefined }, { bid: null }, { bid: 110, ask: 109 }, { comparable: false }]) {
    assert.deepEqual(rank(snapshot([quote("a"), quote("b", { fundingRate: 0.001, ...patch })])), []);
  }
  assert.deepEqual(rank(snapshot([quote("a"), quote("b", { fundingRate: 0.001 })], [venue("a"), venue("b", "cex", "error")])), []);
  assert.deepEqual(rank({ ...data, status: "unavailable" }), []);
  const markRows = rank(data, { priceMode: "mark" });
  assert.equal(markRows.length, 3); assert.ok(markRows.every(row => row.netUnavailableReason === "mark"));
  assert.deepEqual(rank(snapshot([quote("a"), quote("b", { fundingRate: 0.001, markAt: now - 30_001 })]), { priceMode: "mark" }), []);
});

test("cross-currency funding opportunities require valid FX and retain converted entry prices", () => {
  const data = snapshot([quote("a"), quote("b", { quoteCurrency: "USDC", fundingRate: 0.001 })]);
  const fx = { baseCurrency: "USDT", generatedAt: now, staleAfterMs: 180_000, rates: { USDC: { bid: 0.98, ask: 0.99, at: now, source: "fixture" } } };
  assert.deepEqual(rank(data), []);
  assert.deepEqual(rank(data, { crossCurrency: true }), []);
  const rows = rank(data, { crossCurrency: true }, fx);
  assert.equal(rows.length, 1); assert.equal(rows[0].fundingSpread8h, 0.001);
  assert.equal(rows[0].sellPrice, 99); assert.equal(rows[0].referenceSellPrice, 99 * 0.98);
  assert.equal(rows[0].fxAdjusted, true); assert.ok(rows[0].spreadPercent < 0);
  assert.deepEqual(rank(data, { crossCurrency: true }, { ...fx, rates: { USDC: { ...fx.rates.USDC, at: now - 180_001 } } }), []);
  assert.deepEqual(rank({ ...data, quotes: data.quotes.map(q => q.exchange === "b" ? { ...q, quoteCurrency: "BTC" } : q) }, { crossCurrency: true }, fx), []);
});

test("saved funding preferences have an independent finite percent threshold and preserve older defaults", () => {
  for (const version of [1, 2]) {
    const restored = parsePerpetualPreferences(JSON.stringify({ version, sortBy: "funding", minSpreadPercent: 8, minFundingSpreadPercent: 0.025 }));
    assert.equal(restored.sortBy, "funding"); assert.equal(restored.minFundingSpreadPercent, 0.025); assert.equal(restored.minSpreadPercent, 8);
    const legacy = parsePerpetualPreferences(JSON.stringify({ version, minSpreadPercent: 2 }));
    assert.equal(legacy.sortBy, "gross"); assert.equal(legacy.minFundingSpreadPercent, 0);
  }
  for (const [input, expected] of [[-1, 0], [1001, 1000], ["0.5", 0], [null, 0]]) {
    assert.equal(parsePerpetualPreferences(JSON.stringify({ version: 2, minFundingSpreadPercent: input })).minFundingSpreadPercent, expected);
  }
  assert.equal(parsePerpetualPreferences('{"version":2,"minFundingSpreadPercent":1e999}').minFundingSpreadPercent, 0);
  assert.equal(parsePerpetualPreferences('{"version":2,"sortBy":"unknown"}').sortBy, "gross");
  assert.equal(defaultPerpetualFilters.minFundingSpreadPercent, 0);
});

test("funding cache expires old rates and admits future observations at their validity boundary without price ticks", () => {
  const select = createPerpetualRankingSelector();
  const expiring = snapshot([quote("a", { fundingAt: now - 300_000 }), quote("b", { fundingRate: 0.001 })]);
  const first = select(expiring, fundingFilters, now, budget);
  assert.equal(first.length, 1);
  assert.equal(select({ ...expiring, generatedAt: now + 1 }, fundingFilters, now, budget), first);
  assert.deepEqual(select(expiring, fundingFilters, now + 1, budget), []);
  const future = snapshot([quote("a", { fundingAt: now + 5_001 }), quote("b", { fundingRate: 0.001 })]);
  assert.deepEqual(select(future, fundingFilters, now, budget), []);
  assert.equal(select(future, fundingFilters, now + 1, budget).length, 1);
  assert.deepEqual(select(future, { ...fundingFilters, minFundingSpreadPercent: 0.2 }, now + 1, budget), []);
  assert.equal(select(future, fundingFilters, now + 1, budget).length, 1);
});

test("incremental funding changes match full ranking while preserving untouched assets", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot(["BTC", "ETH"].flatMap(base => [quote("a", { base, symbol: `${base}USDT` }), quote("b", { base, symbol: `${base}USDT`, fundingRate: 0.001 })]));
  const initial = select(data, fundingFilters, now, budget), eth = initial.find(row => row.base === "ETH");
  const update = { ...data, quotes: data.quotes.map(q => q.base === "BTC" && q.exchange === "a" ? { ...q, fundingRate: 0.002 } : q) };
  const changed = select(update, fundingFilters, now + 1, budget);
  assert.equal(changed.find(row => row.base === "ETH"), eth);
  assert.deepEqual(directions(changed), ["BTC:b>a", "ETH:a>b"]);
  assert.deepEqual(changed, rankPerpetualSpreads(update, fundingFilters, now + 1, budget));
  const higherThreshold = { ...fundingFilters, minFundingSpreadPercent: 0.2 };
  assert.deepEqual(select(update, higherThreshold, now + 1, budget), []);
  assert.deepEqual(select(update, { ...fundingFilters, sortBy: "gross" }, now + 1, budget), rankPerpetualSpreads(update, { ...fundingFilters, sortBy: "gross" }, now + 1, budget));
});
