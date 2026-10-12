import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPerpetualQuote, createPerpetualQuoteSelector, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, perpetualSpreadIsFavorite, perpetualSpreadKey, quoteIsFresh, rankBestPerpetualSpreads, rankPerpetualSpreads, visiblePerpetualSnapshot } from "../lib/perpetual-spreads.ts";
import { defaultQualityBudget } from "../lib/perpetual-fees.ts";

const now = 1_800_000_000_000;
const venue = (id, kind = "cex", status = "live") => ({ id, name: id, kind, status, marketCount: 1, quoteCount: 1, lastMessageAt: now, error: null });
const quote = (exchange, overrides = {}) => ({ exchange, symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: now + 3600000, sourceTime: now, receivedAt: now, transport: "ws", bidAskAt: now, markAt: now, fundingAt: now, ...overrides });
const snapshot = (quotes, exchanges = [venue("a"), venue("b"), venue("c", "dex")]) => ({ schemaVersion: 1, monitorId: "perpetual", status: "live", generatedAt: now, staleAfterMs: 30000, exchanges, quotes });
const fx = { baseCurrency: "USDT", generatedAt: now, staleAfterMs: 180000, rates: { USDC: { bid: 1, ask: 1, at: now, source: "fixture" } } };
const rank = (data, filters = {}, fxSnapshot = fx) => rankPerpetualSpreads(data, { ...defaultPerpetualFilters, ...filters }, now, defaultQualityBudget, fxSnapshot);

test("scanner discovery disables hidden numeric bounds while legacy ranking retains its thresholds", () => {
  const data = snapshot([quote("a", { bid: 100, ask: 100, fundingRate: 0 }), quote("b", { bid: 101, ask: 101, fundingRate: 0.001 }), quote("c", { bid: 100, ask: 100, fundingRate: null })]);
  assert.equal(rank(data).length, 4);
  assert.equal(rank(data, { sortBy: "funding" }).length, 1);
  assert.equal(rank(data, { sortBy: "net" }).length, 0);
  const unrestricted = { applyNumericThresholds: false, minSpreadPercent: 999, minFundingSpreadPercent: 999 };
  for (const sortBy of ["gross", "funding", "net"]) {
    const rows = rank(data, { ...unrestricted, sortBy });
    assert.equal(rows.length, 6, sortBy);
    assert.ok(rows.some(row => row.spreadPercent < 0));
    assert.ok(rows.some(row => row.spreadPercent === 0));
    assert.deepEqual(createPerpetualRankingSelector()(data, { ...defaultPerpetualFilters, ...unrestricted, sortBy }, now), rows);
    assert.deepEqual(rankBestPerpetualSpreads(data, { ...defaultPerpetualFilters, ...unrestricted, sortBy }, now), [rows[0]]);
  }
  const funding = rank(data, { ...unrestricted, sortBy: "funding" });
  assert.deepEqual(funding.map(row => row.fundingSpread8h), [0.001, -0.001, null, null, null, null]);
  assert.equal(rank(snapshot([quote("a"), quote("b")]), { ...unrestricted, sortBy: "funding" }).length, 2);
  assert.equal(rank(snapshot([quote("a"), quote("b")]), { sortBy: "funding" }).length, 0);
  assert.equal(rank({ ...data, status: "unavailable" }, unrestricted).length, 0);
  assert.equal(rank({ ...data, quotes: data.quotes.map(q => ({ ...q, comparable: false })) }, unrestricted).length, 0);
  assert.equal(rank({ ...data, quotes: data.quotes.map(q => ({ ...q, bidAskAt: now - 30001 })) }, unrestricted).length, 0);
});

test("scanner net sorting puts unavailable values after negative known values and cache settings stay independent", () => {
  const data = snapshot([quote("binance", { bid: 100, ask: 100 }), quote("gate", { bid: 99, ask: 101 }), quote("unknown", { bid: 100, ask: 100 })], [venue("binance"), venue("gate"), venue("unknown")]);
  const filters = { ...defaultPerpetualFilters, sortBy: "net", applyNumericThresholds: false };
  const rows = rank(data, filters);
  assert.equal(rows.length, 6);
  assert.ok(rows[0].netSpreadPercent < 0);
  assert.ok(rows[1].netSpreadPercent < 0);
  assert.ok(rows.slice(2).every(row => row.netSpreadPercent === null));
  const select = createPerpetualRankingSelector();
  assert.deepEqual(select(data, filters, now), rows);
  assert.deepEqual(select(data, { ...filters, applyNumericThresholds: true }, now), []);
  assert.deepEqual(select(data, filters, now), rows);
  const missing = snapshot([quote("a", { fundingRate: null }), quote("b", { fundingRate: null })]);
  const fundingFilters = { ...defaultPerpetualFilters, sortBy: "funding", applyNumericThresholds: false };
  const unknownFunding = rank(missing, fundingFilters);
  assert.equal(unknownFunding.length, 2);
  assert.deepEqual(rankBestPerpetualSpreads(missing, fundingFilters, now), [unknownFunding[0]]);
});

test("saved coin blocks update ranking and quote caches without mutating the source snapshot", () => {
  const data = snapshot(['BTC', 'ETH', 'BTC2'].flatMap(base => [quote('a', { base, symbol: `${base}USDT`, displayBase: 'BTC' }), quote('b', { base, symbol: `${base}USDT`, bid: 102, ask: 103 })]));
  const sourceQuotes = [...data.quotes], selectRank = createPerpetualRankingSelector(), selectQuotes = createPerpetualQuoteSelector();
  const initial = selectRank(data, defaultPerpetualFilters, now);
  assert.equal(initial.length, 3);
  assert.equal(selectQuotes(data.quotes, defaultPerpetualFilters).baseCount, 3);
  const visible = visiblePerpetualSnapshot(data, new Set(['BTC']));
  assert.deepEqual(selectRank(visible, defaultPerpetualFilters, now).map(row => row.base), ['BTC2', 'ETH']);
  const selected = selectQuotes(visible.quotes, defaultPerpetualFilters);
  assert.equal(selected.keys.length, 4); assert.equal(selected.baseCount, 2);
  assert.ok(selected.keys.every(key => selected.byKey.get(key).base !== 'BTC'));
  assert.equal(visible.generatedAt, data.generatedAt); assert.equal(visible.exchanges, data.exchanges);
  assert.deepEqual(data.quotes, sourceQuotes, 'Complete quotes remain available for holdings and manual pairs');
  assert.equal(visible.quotes[0], data.quotes[2], 'Retained quotes keep their identity and original times');
  const restored = visiblePerpetualSnapshot(data, new Set());
  assert.equal(restored, data);
  assert.deepEqual(selectRank(restored, defaultPerpetualFilters, now), initial);
  assert.equal(selectQuotes(restored.quotes, defaultPerpetualFilters).keys.length, 6);
});

test("search and favorites cannot reveal blocked bases, including unavailable quotes", () => {
  const data = snapshot([quote('a'), quote('b', { bid: 102, ask: 103 }), quote('c', { symbol: 'BTCUSDC', quoteCurrency: 'USDC', bidAskAt: now - 60000 }), quote('a', { base: 'ETH', symbol: 'ETHUSDT' })]);
  const visible = visiblePerpetualSnapshot(data, new Set(['BTC']));
  const filters = { ...defaultPerpetualFilters, search: 'BTC', favoritesOnly: true, favorites: ['BTC'], favoritePairs: [perpetualSpreadKey(rank(data)[0])] };
  assert.deepEqual(rankPerpetualSpreads(visible, filters, now), []);
  assert.equal(createPerpetualQuoteSelector()(visible.quotes, filters).keys.length, 0);
  const allBlocked = visiblePerpetualSnapshot(data, new Set(['BTC', 'ETH']));
  assert.deepEqual(rank(allBlocked), []);
  assert.equal(createPerpetualQuoteSelector()(allBlocked.quotes, defaultPerpetualFilters).baseCount, 0);
});

test("page waits for the saved block list and preserves snapshots when nothing is hidden", () => {
  const data = snapshot([quote('a')]);
  assert.equal(visiblePerpetualSnapshot(data, null), null);
  assert.equal(visiblePerpetualSnapshot(null, new Set(['BTC'])), null);
  assert.equal(visiblePerpetualSnapshot(data, new Set(['ETH'])), data);
});

test("perpetual ranking uses buy ask / sell bid on different venues, not mark or last", () => {
  const rows = rank(snapshot([quote("a", { mark: 200 }), quote("b", { bid: 102, ask: 103, mark: 90 }), quote("a", { symbol: "BTCUSDC", quoteCurrency: "USDC", bid: 150, ask: 151 })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].long.exchange, "a"); assert.equal(rows[0].short.exchange, "b");
  assert.ok(Math.abs(rows[0].spreadPercent - 2) < 1e-10);
  assert.equal(rank(snapshot([quote("a"), quote("a", { bid: 102, ask: 103 })])).length, 0);
});

test("quote currencies stay separate by default; cross-currency comparison requires a fresh conversion", () => {
  const data = snapshot([quote("a"), quote("c", { quoteCurrency: "USDC", bid: 102, ask: 103 })]);
  assert.equal(rank(data).length, 0);
  assert.equal(rank(data, { crossCurrency: true })[0].crossCurrency, true);
  assert.equal(rank(data, { crossCurrency: true }, null).length, 0);
  assert.equal(rank(snapshot([quote("a"), quote("c", { quoteCurrency: "BTC", bid: 102, ask: 103 })]), { crossCurrency: true }).length, 0);
});

test("stale books, unavailable venues, future timestamps and crossed books cannot enter ranking", () => {
  for (const overrides of [{ bidAskAt: now - 30001 }, { bidAskAt: undefined }, { bidAskAt: now - 5001 }, { bidAskAt: now + 10000, receivedAt: now + 10000 }, { bid: 110, ask: 109 }, { bid: Infinity }, { bid: -1 }, { comparable: false }]) {
    assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, ...overrides })])).length, 0);
  }
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })], [venue("a"), venue("b", "cex", "error")])).length, 0);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })], [venue("a"), venue("b", "cex", "connecting")])).length, 0);
  assert.equal(quoteIsFresh(quote("a", { markAt: now - 30001 }), "mark", now, 30000), false);
  assert.equal(quoteIsFresh(quote("a", { bidAskAt: now - 30000 }), "book", now, 30000), true);
});

test("funding carry converts each leg by its actual period and leaves missing data unknown", () => {
  const rows = rank(snapshot([quote("a", { fundingRate: 0.0001, fundingIntervalHours: 1 }), quote("b", { bid: 102, ask: 103, fundingRate: 0.0004, fundingIntervalHours: 4 })]));
  assert.equal(rows[0].fundingSpread8h, 0);
  assert.equal(normalizedFunding8h(quote("a", { fundingIntervalHours: null })), null);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: null })), null);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: -0.0001, fundingIntervalHours: 1 })), -0.0008);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, fundingRate: null })]))[0].fundingSpread8h, null);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, fundingAt: now - 300001 })]))[0].fundingSpread8h, null);
});

test("pair filters keep every compatible combination, and selecting no exchange shows no rows", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 110, ask: 111 }), quote("c", { bid: 105, ask: 106 })]);
  assert.equal(rank(data).length, 3);
  assert.equal(rank(data, { pairMode: "cex-dex" }).length, 2);
  assert.equal(rank(data, { pairMode: "cex-dex" })[0].short.exchange, "c");
  assert.equal(rank(data, { pairMode: "cex-dex" })[0].long.exchange, "a");
  assert.equal(rank(data, { pairMode: "cex-cex" }).length, 1);
  assert.equal(rank(data, { pairMode: "dex-dex" }).length, 0);
  assert.equal(rank(data, { exchanges: [] }).length, 0);
  assert.equal(rank(data, { exchanges: ["a", "c"] })[0].short.exchange, "c");
  assert.equal(rank(data, { minSpreadPercent: 11 }).length, 0);
  assert.equal(rank(data, { search: " eth " }).length, 0);
  assert.equal(rank(data, { favoritesOnly: true, favorites: ["ETH"] }).length, 0);
});

test("mark ranking requires fresh mark prices and never falls back to last or book", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 99, ask: 100, mark: 105 })]);
  assert.equal(rank(data).length, 0);
  assert.equal(rank(data, { priceMode: "mark" })[0].sellPrice, 105);
  assert.equal(rank(snapshot([quote("a"), quote("b", { mark: null, last: 120 })]), { priceMode: "mark" }).length, 0);
});

test("each base retains combinations from separate quote currencies without mixing their prices", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 102, ask: 103 }), quote("a", { symbol: "BTCUSDC", quoteCurrency: "USDC" }), quote("c", { symbol: "BTCUSDC", quoteCurrency: "USDC", bid: 104, ask: 105 })]);
  const rows = rank(data);
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.short.exchange), ["c", "b"]);
  assert.ok(rows.every(row => row.long.quoteCurrency === row.short.quoteCurrency && !row.crossCurrency));
});

test("all independent combinations rank globally by spread rather than being grouped by base", () => {
  const data = snapshot([
    quote("a", { bid: 100, ask: 100 }), quote("b", { bid: 102, ask: 102 }),
    quote("c", { bid: 104, ask: 104 }), quote("d", { bid: 108, ask: 108 }),
    quote("a", { base: "ETH", symbol: "ETHUSDT", bid: 100, ask: 100 }),
    quote("b", { base: "ETH", symbol: "ETHUSDT", bid: 106, ask: 106 }),
  ], [venue("a"), venue("b"), venue("c", "dex"), venue("d", "dex")]);
  const rows = rank(data);
  assert.deepEqual(rows.map(row => `${row.base}:${row.long.exchange}>${row.short.exchange}`), [
    "BTC:a>d", "ETH:a>b", "BTC:b>d", "BTC:a>c", "BTC:c>d", "BTC:a>b", "BTC:b>c",
  ]);
  assert.equal(rank(data, { search: "btc" }).length, 6);
  assert.equal(rank(data, { favoritesOnly: true, favorites: ["BTC"] }).length, 6);
  assert.equal(rank(data, { minSpreadPercent: 5 }).length, 3);
  assert.deepEqual(rank(data, { pairMode: "dex-dex" }).map(row => [row.long.exchange, row.short.exchange]), [["c", "d"]]);
});

test("opportunity identity includes direction and both contracts on a venue", () => {
  const data = snapshot([
    quote("a", { bid: 100, ask: 100 }),
    quote("a", { symbol: "BTCUSDC", quoteCurrency: "USDC", bid: 100, ask: 100 }),
    quote("b", { bid: 102, ask: 102 }),
  ]);
  const rows = rank(data, { crossCurrency: true, minSpreadPercent: -100 });
  assert.deepEqual(rows.map(perpetualSpreadKey), [
    '["BTC","a:BTCUSDC","b:BTCUSDT"]', '["BTC","a:BTCUSDT","b:BTCUSDT"]',
    '["BTC","b:BTCUSDT","a:BTCUSDC"]', '["BTC","b:BTCUSDT","a:BTCUSDT"]',
  ]);
  assert.equal(new Set(rows.map(perpetualSpreadKey)).size, 4);
  assert.equal(rows.filter(row => row.crossCurrency).length, 2);
  assert.equal(rank(data, { crossCurrency: true }).length, 2);
});

test("equal spreads have a complete stable base and contract tie order independent of input order", () => {
  const quotes = [
    quote("c", { bid: 100 }), quote("a", { symbol: "BTCUSDT-Z", bid: 100 }),
    quote("b", { bid: 100 }), quote("a", { bid: 100 }),
    quote("b", { base: "ETH", symbol: "ETHUSDT", bid: 100 }),
    quote("a", { base: "ETH", symbol: "ETHUSDT", bid: 100 }),
  ];
  const expected = [
    '["BTC","a:BTCUSDT","b:BTCUSDT"]', '["BTC","a:BTCUSDT","c:BTCUSDT"]',
    '["BTC","a:BTCUSDT-Z","b:BTCUSDT"]', '["BTC","a:BTCUSDT-Z","c:BTCUSDT"]',
    '["BTC","b:BTCUSDT","a:BTCUSDT"]', '["BTC","b:BTCUSDT","a:BTCUSDT-Z"]', '["BTC","b:BTCUSDT","c:BTCUSDT"]',
    '["BTC","c:BTCUSDT","a:BTCUSDT"]', '["BTC","c:BTCUSDT","a:BTCUSDT-Z"]', '["BTC","c:BTCUSDT","b:BTCUSDT"]',
    '["ETH","a:ETHUSDT","b:ETHUSDT"]', '["ETH","b:ETHUSDT","a:ETHUSDT"]',
  ];
  for (let shift = 0; shift < quotes.length; shift++) {
    const shifted = [...quotes.slice(shift), ...quotes.slice(0, shift)];
    assert.deepEqual(rank(snapshot(shifted)).map(perpetualSpreadKey), expected);
    assert.deepEqual(rank(snapshot(shifted.reverse())).map(perpetualSpreadKey), expected);
  }
});

test("background discovery retains only the best combination per base and the same stable ties", () => {
  const data = snapshot([
    quote("a"), quote("b", { bid: 102, ask: 103 }), quote("c", { bid: 104, ask: 105 }),
    quote("a", { base: "ETH", symbol: "ETHUSDT", bid: 100 }), quote("c", { base: "ETH", symbol: "ETHUSDT", bid: 100 }),
  ]);
  for (const filters of [defaultPerpetualFilters, { ...defaultPerpetualFilters, minSpreadPercent: -100 }, { ...defaultPerpetualFilters, pairMode: "cex-dex" }]) {
    const all = rankPerpetualSpreads(data, filters, now);
    const best = rankBestPerpetualSpreads(data, filters, now);
    const seen = new Set();
    assert.deepEqual(best, all.filter(row => { if (seen.has(row.base)) return false; seen.add(row.base); return true; }));
    assert.deepEqual(rankBestPerpetualSpreads({ ...data, quotes: [...data.quotes].reverse() }, filters, now), best);
    assert.equal(best.length, 2);
  }
});

test("ranking returns the full combination count for pagination while background candidates stay bounded by bases", () => {
  const exchanges = Array.from({ length: 10 }, (_, i) => venue(`venue${i}`, i < 5 ? "cex" : "dex"));
  const quotes = Array.from({ length: 50 }, (_, i) => exchanges.map(exchange =>
    quote(exchange.id, { base: `BASE${i}`, symbol: `BASE${i}USDT`, bid: 100, ask: 100 }),
  )).flat();
  const data = snapshot(quotes, exchanges);
  const rows = rank(data);
  assert.equal(rows.length, 50 * 10 * 9);
  assert.equal(new Set(rows.map(perpetualSpreadKey)).size, rows.length);
  assert.equal(rankBestPerpetualSpreads(data, defaultPerpetualFilters, now).length, 50);
});

test("persisted filters reject malformed preferences and normalize exchange selections", () => {
  assert.deepEqual(parsePerpetualPreferences("not json"), defaultPerpetualFilters);
  assert.deepEqual(parsePerpetualPreferences('{"version":1,"exchanges":["a","a",null],"crossCurrency":"true","minSpreadPercent":5000}').exchanges, ["a"]);
  assert.equal(parsePerpetualPreferences('{"version":1,"crossCurrency":"true"}').crossCurrency, false);
});

test("ranking cache ignores metadata frames but invalidates at price expiry and venue outages", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })]);
  const first = select(data, defaultPerpetualFilters, now);
  assert.equal(select({ ...data, generatedAt: now + 1000 }, defaultPerpetualFilters, now + 1000), first);
  assert.equal(select(data, defaultPerpetualFilters, now + 30000), first);
  assert.equal(select(data, defaultPerpetualFilters, now + 30001).length, 0);
  const offline = { ...data, exchanges: [venue("a"), venue("b", "cex", "error")] };
  assert.equal(select(offline, defaultPerpetualFilters, now).length, 0);
});

test("ranking cache expires funding independently without removing valid price opportunities", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([quote("a", { fundingAt: now - 300000 }), quote("b", { bid: 102, ask: 103 })]);
  assert.equal(select(data, defaultPerpetualFilters, now)[0].fundingSpread8h, 0);
  const next = select(data, defaultPerpetualFilters, now + 1);
  assert.equal(next.length, 1); assert.equal(next[0].fundingSpread8h, null);
});

test("missing order books are unavailable, while only genuinely aged price observations are stale", () => {
  assert.equal(classifyPerpetualQuote(quote("a", { bidAskAt: undefined, bid: null, ask: null }), "book", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a", { bidAskAt: now - 30001 }), "book", now, 30000), "stale");
  assert.equal(classifyPerpetualQuote(quote("a", { bid: 102, ask: 101 }), "book", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a", { mark: null }), "mark", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a"), "book", now, 30000), "fresh");
});

test("price changes preserve alphabetical selection keys; catalog, search and exchange changes invalidate membership", () => {
  const select = createPerpetualQuoteSelector();
  const data = [quote("b"), quote("a", { base: "ETH", symbol: "ETHUSDT" }), quote("c")];
  const first = select(data, defaultPerpetualFilters);
  assert.deepEqual(first.keys, ["b:BTCUSDT", "c:BTCUSDT", "a:ETHUSDT"]); assert.equal(first.baseCount, 2);
  const changed = select(data.map(item => ({ ...item, bid: 200, receivedAt: now + 1 })), defaultPerpetualFilters);
  assert.equal(changed.keys, first.keys); assert.equal(changed.byKey.get("b:BTCUSDT").bid, 200);
  const filtered = select(data, { ...defaultPerpetualFilters, search: "btc", exchanges: ["b"] });
  assert.deepEqual(filtered.keys, ["b:BTCUSDT"]);
  const added = select([...data, quote("a", { base: "AAA", symbol: "AAAUSDT" })], defaultPerpetualFilters);
  assert.equal(added.keys[0], "a:AAAUSDT"); assert.equal(added.baseCount, 3);
  assert.equal(select([], defaultPerpetualFilters).keys.length, 0);
});

test("net ranking uses both legs' taker fees and its threshold, with unavailable estimates excluded", () => {
  const data = snapshot([
    quote("binance", { bid: 100, ask: 100 }), quote("gate", { bid: 103, ask: 103 }),
    quote("bybit", { bid: 103.05, ask: 103.05, takerFeeRate: 0.0011, takerFeeAt: now, takerFeeSource: "bybit-standard" }),
  ], [venue("binance"), venue("gate"), venue("bybit")]);
  assert.equal(rank(data)[0].short.exchange, "bybit");
  const net = rank(data, { sortBy: "net" });
  assert.deepEqual(net.map(row => row.short.exchange), ["gate", "bybit"]);
  assert.ok(Math.abs(net[0].netSpreadPercent - 2.7) < 1e-10);
  assert.equal(net[0].roundTripFeePercent, 0.2);
  assert.equal(rank(data, { sortBy: "net", minSpreadPercent: 2.65 }).length, 1);
  assert.equal(rank({ ...data, quotes: data.quotes.map(q => ({ ...q, mark: q.ask })) }, { sortBy: "net", priceMode: "mark" }).length, 0);
  const missing = { ...data, quotes: data.quotes.map(q => q.exchange === "bybit" ? { ...q, takerFeeRate: null } : q) };
  assert.equal(rank(missing, { sortBy: "net" }).length, 1);
  const manual = rankPerpetualSpreads(missing, { ...defaultPerpetualFilters, sortBy: "net" }, now, { takerOverrides: { bybit: 0 }, slippagePercent: 0 });
  assert.equal(manual[0].short.exchange, "bybit");
  assert.ok(Math.abs(manual[0].netSpreadPercent - 2.95) < 1e-10);
  assert.equal(rankPerpetualSpreads(data, { ...defaultPerpetualFilters, sortBy: "net" }, now, { takerOverrides: {}, slippagePercent: NaN }).length, 0);
  assert.deepEqual(rankBestPerpetualSpreads(data, { ...defaultPerpetualFilters, sortBy: "net" }, now), [net[0]]);
});

test("cross-currency ranking converts buy at FX ask and sell at FX bid while retaining original leg prices", () => {
  const data = snapshot([quote("binance", { bid: 100, ask: 100 }), quote("gate", { bid: 103, ask: 103, quoteCurrency: "USDC" })], [venue("binance"), venue("gate")]);
  const depeg = { ...fx, rates: { USDC: { bid: 0.98, ask: 0.99, at: now, source: "fixture" } } };
  const rows = rank(data, { crossCurrency: true }, depeg);
  assert.equal(rows[0].buyPrice, 100); assert.equal(rows[0].sellPrice, 103);
  assert.equal(rows[0].referenceSellPrice, 100.94);
  assert.ok(Math.abs(rows[0].spreadPercent - 0.94) < 1e-10);
  assert.ok(Math.abs(rows[0].rawSpreadPercent - 3) < 1e-10);
  assert.equal(rows[0].fxAdjusted, true);
  assert.equal(rank(data, { crossCurrency: true }, { ...depeg, rates: { USDC: { ...depeg.rates.USDC, at: now - 180001 } } }).length, 0);
  const reverse = rank({ ...data, quotes: [quote("gate", { bid: 100, ask: 100, quoteCurrency: "USDC" }), quote("binance", { bid: 100, ask: 100 })] }, { crossCurrency: true }, depeg);
  assert.equal(reverse[0].referenceBuyPrice, 99);
  assert.ok(Math.abs(reverse[0].spreadPercent - (100 / 99 - 1) * 100) < 1e-10);
  assert.equal(rank({ ...data, quotes: data.quotes.map(q => ({ ...q, quoteCurrency: q.exchange === "gate" ? "USD" : "USDT" })) }, { crossCurrency: true }).length, 0);
});

test("pair favorites preserve direction and contract, coexist with old asset favorites, and blocking wins", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 103, ask: 104 }), quote("c", { bid: 106, ask: 107 })]);
  const all = rank(data), favoriteKey = perpetualSpreadKey(all[1]);
  const filters = { ...defaultPerpetualFilters, favoritesOnly: true, favoritePairs: [favoriteKey] };
  assert.deepEqual(rank(data, filters), [all[1]]);
  assert.equal(perpetualSpreadIsFavorite(all[1], filters), true);
  assert.equal(perpetualSpreadIsFavorite(all[0], filters), false);
  assert.equal(rank(data, { ...filters, favorites: ["BTC"] }).length, 3);
  assert.equal(rank(data, { ...filters, blockedPairs: [favoriteKey] }).length, 0);
  assert.equal(rank(data, { blockedPairs: [favoriteKey] }).length, 2);
  const parsed = parsePerpetualPreferences(JSON.stringify({ version: 1, favorites: ["ETH"], favoritePairs: [favoriteKey, favoriteKey, "oops", "[1,2,3]"], blockedPairs: [favoriteKey], sortBy: "net" }));
  assert.deepEqual(parsed.favoritePairs, [favoriteKey]); assert.deepEqual(parsed.favorites, ["ETH"]); assert.equal(parsed.sortBy, "net");
  assert.equal(parsePerpetualPreferences(JSON.stringify({ version: 2, favoritePairs: [favoriteKey] })).favoritePairs.length, 1);
  const quotes = createPerpetualQuoteSelector()(data.quotes, filters);
  assert.deepEqual(new Set(quotes.keys), new Set([`${all[1].long.exchange}:${all[1].long.symbol}`, `${all[1].short.exchange}:${all[1].short.symbol}`]));
});

test("incremental ranking retains untouched asset rows and tracks removal, base moves and timer-only expiry", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([
    quote("a", { bidAskAt: now - 5000 }), quote("b", { bid: 102, ask: 103, bidAskAt: now - 5000 }),
    quote("a", { base: "ETH", symbol: "ETHUSDT" }), quote("b", { base: "ETH", symbol: "ETHUSDT", bid: 105, ask: 106 }),
  ]);
  const first = select(data, defaultPerpetualFilters, now), oldBtc = first.find(row => row.base === "BTC"), oldEth = first.find(row => row.base === "ETH");
  const update = { ...data, quotes: data.quotes.map(q => q.base === "BTC" && q.exchange === "b" ? { ...q, bid: 103 } : q) };
  const second = select(update, defaultPerpetualFilters, now + 1);
  assert.equal(second.find(row => row.base === "ETH"), oldEth);
  assert.notEqual(second.find(row => row.base === "BTC"), oldBtc);
  assert.equal(select({ ...update, quotes: [...update.quotes] }, { ...defaultPerpetualFilters }, now + 2), second);
  const expired = select(update, defaultPerpetualFilters, now + 25001);
  assert.equal(expired.length, 1); assert.equal(expired[0], oldEth);
  const moved = { ...data, quotes: data.quotes.map(q => q.base === "BTC" ? { ...q, base: "WBTC" } : q) };
  assert.ok(select(moved, defaultPerpetualFilters, now).some(row => row.base === "WBTC"));
  assert.equal(select({ ...data, quotes: data.quotes.filter(q => q.base === "ETH") }, defaultPerpetualFilters, now).length, 1);
  assert.equal(select({ ...data, quotes: [] }, defaultPerpetualFilters, now).length, 0);
});

test("incremental ranking refreshes contract fee and FX validity without a price tick", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([quote("binance"), quote("bybit", { bid: 102, ask: 103, takerFeeRate: 0.00055, takerFeeAt: now - 900000, takerFeeSource: "bybit-standard" })], [venue("binance"), venue("bybit")]);
  const filters = { ...defaultPerpetualFilters, sortBy: "net" };
  assert.equal(select(data, filters, now).length, 1);
  assert.equal(select(data, filters, now + 1).length, 0);
  const zeroFees = { takerOverrides: { binance: 0, bybit: 0 }, slippagePercent: 0 };
  assert.equal(select(data, filters, now + 1, zeroFees).length, 1);
  const cross = { ...data, quotes: data.quotes.map(q => q.exchange === "bybit" ? { ...q, quoteCurrency: "USDC" } : q) };
  const crossFilters = { ...filters, crossCurrency: true };
  const almostStale = { ...fx, rates: { USDC: { ...fx.rates.USDC, at: now - 180000 } } };
  assert.equal(select(cross, crossFilters, now, zeroFees, almostStale).length, 1);
  assert.equal(select(cross, crossFilters, now + 1, zeroFees, almostStale).length, 0);
  assert.equal(select(cross, crossFilters, now + 1, zeroFees, fx).length, 1);
});

test("incremental merge matches a full ranking through mixed updates, removals, outages and settings changes", () => {
  const select = createPerpetualRankingSelector();
  const venues = [venue("binance"), venue("gate"), venue("hyperliquid", "dex")];
  let data = snapshot(Array.from({ length: 8 }, (_, index) => venues.map((venue, leg) => quote(venue.id, { base: `COIN${index}`, symbol: `COIN${index}USDT`, bid: 100 + leg, ask: 100 + leg }))).flat(), venues);
  let filters = { ...defaultPerpetualFilters }, clock = now;
  let seed = 37;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let step = 0; step < 100; step++) {
    clock += 1000;
    const editedBase = `COIN${random() % 8}`;
    data = { ...data, quotes: data.quotes.map(q => q.base === editedBase ? { ...q, bid: 90 + random() % 20, ask: 110 + random() % 3, bidAskAt: clock, receivedAt: clock } : q) };
    if (step === 9) data = { ...data, quotes: data.quotes.filter(q => q.base !== "COIN0") };
    if (step === 10) data = { ...data, quotes: data.quotes.filter(q => q.base !== "COIN1").map(q => q.base === "COIN2" ? { ...q, bid: 109 } : q) };
    if (step % 11 === 0) filters = { ...filters, minSpreadPercent: step % 22 ? -20 : -100 };
    if (step % 13 === 0) filters = { ...filters, sortBy: filters.sortBy === "net" ? "gross" : "net" };
    if (step % 17 === 0) data = { ...data, exchanges: venues.map(v => v.id === "gate" ? { ...v, status: step % 34 ? "live" : "error" } : v) };
    const actual = select(data, filters, clock);
    assert.deepEqual(actual, rankPerpetualSpreads(data, filters, clock), `step ${step}`);
  }
});
