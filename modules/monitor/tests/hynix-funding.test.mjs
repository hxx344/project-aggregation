import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHynixFunding } from "../lib/hynix-funding.ts";
import { loadQuote } from "../lib/quote-service.ts";

const fetchedAt = "2026-09-11T07:00:00.000Z";
const fixture = (ordinaryRate = "0.0001", adrRate = "0.0003") => [
  { universe: [{ name: "xyz:SKHY" }, { name: "xyz:OTHER" }, { name: "xyz:SKHX" }] },
  [{ oraclePx: "180", markPx: "200", funding: adrRate }, {}, { oraclePx: "1500", markPx: "1000", funding: ordinaryRate }],
];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("funding maps exact symbols and weights short 10 ADR / long 1 ordinary by oracle notionals", () => {
  const funding = parseHynixFunding(fixture(), fetchedAt);
  assert.equal(funding.ordinary.coin, "xyz:SKHX");
  assert.equal(funding.adr.coin, "xyz:SKHY");
  assert.equal(funding.grossNotional, 3300);
  close(funding.hourlyCashflow, 0.39);
  close(funding.hourlyRate, 0.39 / 3300);
  close(funding.annualizedRate, (0.39 / 3300) * 8760);
  assert.equal(funding.fetchedAt, fetchedAt);
});

test("positive, negative and zero leg rates retain the short-premium cashflow sign", () => {
  for (const [ordinary, adr] of [[0, 0], [0.0001, 0], [-0.0001, 0], [0, -0.0001], [-0.0002, -0.00001]]) {
    const funding = parseHynixFunding(fixture(ordinary, adr), fetchedAt);
    close(funding.hourlyCashflow, 1800 * adr - 1500 * ordinary);
    close(funding.annualizedRate, (1800 * adr - 1500 * ordinary) / 3300 * 8760);
  }
});

test("missing, delisted, duplicated or misaligned funding legs are rejected", () => {
  const invalid = [null, {}, [[], []], [{ universe: [] }, []]];
  for (const mutate of [
    value => value[0].universe[0].name = "xyz:SKHYY",
    value => value[0].universe[1].name = "xyz:SKHY",
    value => value[0].universe[0].isDelisted = true,
    value => value[1].pop(),
    value => value[1][0] = null,
  ]) {
    const value = fixture(); mutate(value); invalid.push(value);
  }
  for (const value of invalid) assert.throws(() => parseHynixFunding(value, fetchedAt));
});

test("invalid rates and nonpositive oracle prices never masquerade as zero funding", () => {
  for (const key of ["funding", "oraclePx"]) {
    for (const invalid of [null, undefined, "", " ", true, false, "NaN", "Infinity", {}, []]) {
      const value = fixture(); value[1][0][key] = invalid;
      assert.throws(() => parseHynixFunding(value, fetchedAt));
    }
  }
  for (const oraclePx of [0, -1, "0", 1e308]) {
    const value = fixture(); value[1][0].oraclePx = oraclePx;
    assert.throws(() => parseHynixFunding(value, fetchedAt));
  }
  assert.throws(() => parseHynixFunding(fixture(), "invalid"));
});

test("funding errors preserve current premium quotes and the next successful load recovers", async () => {
  let failure = true;
  const fetcher = async (_url, init) => JSON.parse(init.body).type === "allMids"
    ? Response.json({ "xyz:SKHX": "1500", "xyz:SKHY": "180" })
    : failure ? Response.json({ error: "limited" }, { status: 429 }) : Response.json(fixture());
  const missing = await loadQuote(fetcher, () => Date.parse(fetchedAt));
  assert.equal(missing.funding, null);
  assert.match(missing.fundingError, /资金费暂不可用/);
  close(missing.premium, 20);
  failure = false;
  const recovered = await loadQuote(fetcher, () => Date.parse(fetchedAt));
  assert.ok(recovered.funding.annualizedRate > 0);
  assert.equal(recovered.fundingError, "");
  failure = true;
  assert.equal((await loadQuote(fetcher)).funding, null);
});

test("quotes and funding start concurrently and retain separate receipt times", async () => {
  let now = Date.parse(fetchedAt);
  const pending = new Map();
  const loading = loadQuote((_url, init) => new Promise(resolve => pending.set(JSON.parse(init.body).type, resolve)), () => now);
  assert.equal(pending.size, 2);
  pending.get("metaAndAssetCtxs")(Response.json(fixture()));
  await new Promise(resolve => setImmediate(resolve));
  now += 2000;
  pending.get("allMids")(Response.json({ "xyz:SKHX": "1500", "xyz:SKHY": "180" }));
  const quote = await loading;
  assert.equal(quote.funding.fetchedAt, fetchedAt);
  assert.equal(quote.fetchedAt, "2026-09-11T07:00:02.000Z");
});
