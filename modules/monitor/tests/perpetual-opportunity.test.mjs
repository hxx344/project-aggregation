import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePerpetualHoldingScenario } from "../lib/perpetual-opportunity.ts";

const now = 1_800_000_000_000, hour = 3_600_000;
const quote = (exchange, overrides = {}) => ({ exchange, symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", bid: 100, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 4, nextFundingAt: now + hour, sourceTime: now, receivedAt: now, transport: "ws", bidAskAt: now, fundingAt: now, ...overrides });
const row = (long = {}, short = {}, extra = {}) => ({ base: "BTC", long: quote("binance", long), short: quote("gate", short), buyPrice: 100, sellPrice: 102, spreadPercent: 2, fundingSpread8h: 0, updatedAt: now, crossCurrency: false, ...extra });
const budget = { takerOverrides: {}, slippagePercent: 0.1 };
const estimate = (value = row(), input = {}, time = now) => estimatePerpetualHoldingScenario(value, budget, { holdingHours: 8, exitSpreadPercent: 0.5, ...input }, time);

test("funding discovery's 24-hour flat-spread scenario does not count a negative entry spread as a loss", () => {
  const value = row({ fundingRate: 0, fundingIntervalHours: 1 }, { fundingRate: 0.0006, fundingIntervalHours: 8 }, { spreadPercent: -2 });
  const result = estimate(value, { holdingHours: 24, exitSpreadPercent: value.spreadPercent });
  assert.equal(result.long.settlements, 24);
  assert.equal(result.short.settlements, 3);
  assert.equal(result.convergencePercent, 0);
  assert.ok(Math.abs(result.fundingPercent - 0.18) < 1e-10);
  assert.ok(Math.abs(result.estimatedNetPercent + 0.12) < 1e-10, "Positive carry remains a loss after round-trip costs");
});

test("holding scenarios count actual settlement schedules separately and combine correctly signed cashflows", () => {
  const result = estimate(row({ fundingRate: 0.001, fundingIntervalHours: 4, nextFundingAt: now + hour }, { fundingRate: 0.002, fundingIntervalHours: 8, nextFundingAt: now + 7 * hour }));
  assert.equal(result.long.settlements, 2); assert.equal(result.short.settlements, 1);
  assert.equal(result.long.lastFundingAt, now + 5 * hour); assert.equal(result.short.lastFundingAt, now + 7 * hour);
  assert.equal(result.long.cashflowPercent, -0.2); assert.equal(result.short.cashflowPercent, 0.2);
  assert.equal(result.fundingPercent, 0);
  assert.equal(result.convergencePercent, 1.5);
  assert.equal(result.roundTripFeePercent, 0.2);
  assert.ok(Math.abs(result.estimatedNetPercent - 1.2) < 1e-10);
  assert.deepEqual(result.reasons, []);
});

test("settlement at the exit instant is included; elapsed next-settlement times are never rolled forward", () => {
  const ending = estimate(row(), { holdingHours: 1 });
  assert.equal(ending.long.settlements, 1);
  const before = estimate(row(), { holdingHours: 0.99 });
  assert.equal(before.long.settlements, 0); assert.equal(before.fundingPercent, 0);
  const old = estimate(row({ nextFundingAt: now }));
  assert.equal(old.long.settlements, null); assert.equal(old.estimatedNetPercent, null);
  assert.match(old.long.reason, /已过/);
  const negative = estimate(row({ fundingRate: -0.001 }, { fundingRate: -0.002 }));
  assert.equal(negative.long.cashflowPercent, 0.2); assert.equal(negative.short.cashflowPercent, -0.4);
});

test("missing or expired funding remains unknown, including invalid schedules and zero-vs-missing rates", () => {
  for (const patch of [{ fundingRate: null }, { fundingAt: now - 300001 }, { fundingAt: now + 5001 }, { fundingIntervalHours: 0 }, { nextFundingAt: null }, { nextFundingAt: now + 20 * hour }]) {
    const value = estimate(row(patch));
    assert.equal(value.long.cashflowPercent, null); assert.equal(value.fundingPercent, null); assert.equal(value.estimatedNetPercent, null);
  }
  assert.equal(estimate(row({ fundingRate: 0 }, { fundingRate: 0 })).fundingPercent, 0);
});

test("reference prices, stale books, unknown FX and invalid inputs do not produce a net scenario", () => {
  assert.equal(estimate(row(), { priceMode: "mark" }).estimatedNetPercent, null);
  assert.equal(estimate(row({ bidAskAt: now - 30001 })).estimatedNetPercent, null);
  assert.equal(estimate(row({ bidAskAt: now - 5001 })).estimatedNetPercent, null);
  assert.equal(estimate(row({}, {}, { crossCurrency: true })).estimatedNetPercent, null);
  assert.equal(estimate(row({}, {}, { crossCurrency: true, fxAdjusted: true, fxAt: now - 180001 })).estimatedNetPercent, null);
  assert.notEqual(estimate(row({}, {}, { crossCurrency: true, fxAdjusted: true, fxAt: now })).estimatedNetPercent, null);
  assert.equal(estimate(row(), { holdingHours: 169 }).estimatedNetPercent, null);
  assert.equal(estimate(row(), { holdingHours: NaN }).estimatedNetPercent, null);
  assert.equal(estimate(row(), { exitSpreadPercent: Infinity }).estimatedNetPercent, null);
});

test("wider residual exit spreads reduce the scenario and fee overrides use the same four-fill basis", () => {
  const losses = estimate(row(), { exitSpreadPercent: 3 });
  assert.equal(losses.convergencePercent, -1); assert.ok(losses.estimatedNetPercent < 0);
  const free = estimatePerpetualHoldingScenario(row(), { takerOverrides: { binance: 0, gate: 0 }, slippagePercent: 0 }, { holdingHours: 8, exitSpreadPercent: 0 }, now);
  assert.equal(free.roundTripFeePercent, 0); assert.equal(free.estimatedNetPercent, 2);
  const missingFees = estimate(row({ exchange: "unknown" }));
  assert.equal(missingFees.roundTripFeePercent, null); assert.equal(missingFees.estimatedNetPercent, null);
});
