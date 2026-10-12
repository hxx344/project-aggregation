import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FIRST_FUNDING_SETTLEMENT as start, FUNDING_HOUR as hour, FUNDING_COINS as coins, pairHynixFunding, createHynixFundingSnapshot, fetchHynixFundingRecords, fetchHynixFundingSnapshot } from "../lib/hynix-funding-history.ts";
import { analyzeHynixFunding, retainFundingRows } from "../lib/hynix-funding-analysis.ts";
import { createHynixFundingLoader } from "../lib/hynix-funding-service.ts";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const record = (coin, time, fundingRate) => ({ coin, time, fundingRate: String(fundingRate) });
const row = (index, adr = .003, ordinary = .001) => ({ time: start + index * hour, adr, ordinary });
const snapshot = rows => createHynixFundingSnapshot(rows, new Date(rows.at(-1).time + hour).toISOString());
const paged = source => async (_url, options) => {
  const request = JSON.parse(options.body);
  return Response.json(source.filter(record => record.coin === request.coin && record.time >= request.startTime && record.time <= request.endTime).slice(0, 500));
};

test("archived Hynix funding preserves the independently verified first 1512 settlements", async () => {
  const stored = JSON.parse(await readFile(new URL("../data/hynix-funding.json", import.meta.url), "utf8"));
  const validated = createHynixFundingSnapshot(stored.rows, stored.metadata.fetchedAt);
  assert.ok(validated.metadata.pairedHours >= 1512); assert.equal(validated.metadata.firstSettlementTime, start);
  const analysis = analyzeHynixFunding(validated.rows.filter(row => row.time <= Date.UTC(2026, 8, 11, 14)), null);
  assert.equal(analysis.count, 1512); assert.equal(analysis.missingHours, 0); near(analysis.shortCumulative, -.0275163809); near(analysis.shortAnnualized, -.1594203020396824);
  near(analysis.longAnnualized, -analysis.shortAnnualized);
});

test("settlement pairing aligns delayed blocks and never substitutes a missing leg", () => {
  const paired = pairHynixFunding([record(coins.adr, start - hour, .1), record(coins.adr, start + 11, .003), record(coins.adr, start + hour + 11, .004)], [record(coins.ordinary, start + 34, .001), record(coins.ordinary, start + 2 * hour + 34, .005)], start + 3 * hour);
  assert.deepEqual(paired, [row(0), row(1, .004, null), row(2, null, .005)]);
  const analysis = analyzeHynixFunding(paired, null);
  assert.equal(analysis.count, 1); assert.equal(analysis.missingHours, 2); near(analysis.shortAnnualized, .001 * 8760);
  assert.equal(analysis.chart[1].shortCumulative, null); assert.equal(analysis.chart[2].longRate, null);
});

test("range cumulative and annualized curves reset and use each observed hour once", () => {
  const rows = Array.from({ length: 200 }, (_, index) => row(index, index < 32 ? .1 : .003, .001));
  const analysis = analyzeHynixFunding(rows, 7);
  assert.equal(analysis.count, 168); assert.equal(analysis.expectedHours, 168); assert.equal(analysis.chart[0].time, start + 32 * hour);
  near(analysis.chart[0].shortCumulative, .001); near(analysis.shortCumulative, .168); near(analysis.shortAnnualized, 8.76);
  for (const point of analysis.chart) { near(point.longRate, -point.shortRate); near(point.longCumulative, -point.shortCumulative); near(point.longAnnualized, -point.shortAnnualized); }
  assert.ok(analyzeHynixFunding(rows, null).shortCumulative > analysis.shortCumulative);
});

test("leading, interior, trailing and one-sided gaps remain visible and excluded from totals", () => {
  const analysis = analyzeHynixFunding([row(2), row(3, null, .001), row(5)], null, start + 7 * hour);
  assert.equal(analysis.count, 2); assert.equal(analysis.expectedHours, 8); assert.equal(analysis.missingHours, 6);
  assert.deepEqual(analysis.chart.filter(point => point.shortRate === null).map(point => point.time), [start, start + 3 * hour, start + 4 * hour, start + 6 * hour]);
  near(analysis.shortCumulative, .002); near(analysis.shortAnnualized, 8.76);
  assert.equal(analyzeHynixFunding([], null).shortAnnualized, null);
  const zero = analyzeHynixFunding([row(0, 0, 0)], null); assert.equal(zero.shortAnnualized, 0); assert.equal(zero.count, 1);
  assert.throws(() => analyzeHynixFunding([row(0, 1e308, -1e308)], null), /overflow/);
});

test("malformed, future, duplicate and conflicting funding records cannot enter a snapshot", () => {
  for (const value of ["", null, undefined, NaN, Infinity]) assert.throws(() => pairHynixFunding([{ coin: coins.adr, time: start, fundingRate: value }], [], start + hour));
  assert.throws(() => pairHynixFunding([record("xyz:WRONG", start, .01)], [], start + hour));
  assert.throws(() => pairHynixFunding([record(coins.adr, start + 1, .01), record(coins.adr, start + 2, .02)], [], start + hour));
  assert.deepEqual(pairHynixFunding([record(coins.adr, start + hour, .01)], [], start), []);
  assert.throws(() => snapshot([row(0), row(0)]));
  assert.throws(() => snapshot([row(0, null, null)]));
  assert.throws(() => createHynixFundingSnapshot([row(1)], new Date(start).toISOString()));
});

test("funding pagination continues through short pages until empty and rejects loops", async () => {
  const source = Array.from({ length: 1105 }, (_, i) => record(coins.adr, start + i * hour + 11, .001));
  let calls = 0;
  const result = await fetchHynixFundingRecords(coins.adr, start, start + 1106 * hour, async (_url, options) => {
    const body = JSON.parse(options.body); calls++;
    return Response.json(source.filter(record => record.time >= body.startTime).slice(0, calls === 2 ? 250 : 500));
  });
  assert.equal(result.length, 1105); assert.equal(calls, 4);
  await assert.rejects(fetchHynixFundingRecords(coins.adr, start, start + hour, async () => Response.json([source[0]])), /did not advance/);
});

test("refresh backfills old missing blocks and absent legs beyond the recent overlap", async () => {
  const full = Array.from({ length: 101 }, (_, i) => row(i));
  const source = full.flatMap(row => [record(coins.adr, row.time + 11, row.adr), record(coins.ordinary, row.time + 34, row.ordinary)]);
  const partial = full.filter((_, i) => i > 1 && !(i >= 10 && i <= 20)).map((row, i) => i === 4 ? { ...row, adr: null } : row);
  const existing = snapshot(partial), before = JSON.stringify(existing);
  const next = await fetchHynixFundingSnapshot(existing, { fetcher: paged(source), now: start + 102 * hour });
  assert.deepEqual(next.rows, full); assert.equal(JSON.stringify(existing), before);
});

test("loader retains the latest successful rows and their timestamp when either leg fails", async () => {
  const seed = snapshot([row(0)]), full = [row(0), row(1)];
  const source = full.flatMap(row => [record(coins.adr, row.time + 11, row.adr), record(coins.ordinary, row.time + 34, row.ordinary)]);
  let fail = false, now = start + 2 * hour;
  const load = createHynixFundingLoader(seed, async (...args) => fail ? Response.json({}, { status: 503 }) : paged(source)(...args), () => now);
  const good = await load(); assert.equal(good.status, "live"); assert.equal(good.rows.length, 2);
  fail = true; now += hour;
  const retained = await load(); assert.equal(retained.status, "snapshot"); assert.equal(retained.metadata.fetchedAt, good.metadata.fetchedAt); assert.deepEqual(retained.rows, good.rows);
  assert.equal(retainFundingRows(good.rows, structuredClone(good.rows)), good.rows);
  assert.notEqual(retainFundingRows(good.rows, [row(0), row(1, .009)]), good.rows);
});
