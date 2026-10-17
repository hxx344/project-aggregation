import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAPITAL_ASSUMPTIONS,
  estimatePairCapital,
  estimatePairCapitalFromRatio,
  estimatePairRoc,
  normalizeCapitalAssumptions,
  parseCapitalAssumptions,
} from "../server/capital-metrics.mjs";

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const rocInput = { longFunding8h: 0, shortFunding8h: 0.0001, shortNotionalPercent: 100 };

test("capital assumptions clamp untrusted values and parse stored preferences", () => {
  assert.deepEqual(DEFAULT_CAPITAL_ASSUMPTIONS, { longLeverage: 3, shortLeverage: 3, marginBufferPercent: 20, holdingHours: 24 });
  assert.deepEqual(normalizeCapitalAssumptions({ longLeverage: 0, shortLeverage: 99, marginBufferPercent: -5, holdingHours: 0 }), {
    longLeverage: 1, shortLeverage: 20, marginBufferPercent: 0, holdingHours: 1,
  });
  assert.deepEqual(normalizeCapitalAssumptions({ longLeverage: "5", shortLeverage: null, marginBufferPercent: "12.5", holdingHours: "8" }), {
    longLeverage: 5, shortLeverage: 3, marginBufferPercent: 12.5, holdingHours: 8,
  });
  assert.deepEqual(parseCapitalAssumptions("not json"), DEFAULT_CAPITAL_ASSUMPTIONS);
  assert.deepEqual(parseCapitalAssumptions("[]"), DEFAULT_CAPITAL_ASSUMPTIONS);
  assert.deepEqual(parseCapitalAssumptions(JSON.stringify({ longLeverage: 5, marginBufferPercent: 10 })), {
    longLeverage: 5, shortLeverage: 3, marginBufferPercent: 10, holdingHours: 24,
  });
});

test("pair capital uses each leg's notional and leverage relative to the long leg", () => {
  const threeX = estimatePairCapital({ longPrice: 100, shortPrice: 101, longLeverage: 3, shortLeverage: 3, marginBufferPercent: 20 });
  close(threeX.longMarginPercent, 100 / 3);
  close(threeX.shortNotionalPercent, 101);
  close(threeX.shortMarginPercent, 101 / 3);
  close(threeX.capitalPercent, (100 / 3 + 101 / 3) * 1.2);
  assert.equal(threeX.reason, "");

  const fiveX = estimatePairCapital({ longPrice: 100, shortPrice: 100, longLeverage: 5, shortLeverage: 5, marginBufferPercent: 20 });
  close(fiveX.capitalPercent, 48);

  const ratio = estimatePairCapitalFromRatio({ shortToLongRatio: 1.01, longLeverage: 3, shortLeverage: 3, marginBufferPercent: 20 });
  close(ratio.capitalPercent, threeX.capitalPercent);
});

test("pair capital rejects missing or invalid prices instead of using zero", () => {
  for (const input of [
    { longPrice: null, shortPrice: 100 },
    { longPrice: 0, shortPrice: 100 },
    { longPrice: -1, shortPrice: 100 },
    { longPrice: 100, shortPrice: null },
    { longPrice: 100, shortPrice: 0 },
    { longPrice: 100, shortPrice: Number.NaN },
    { longPrice: 100, shortPrice: Infinity },
  ]) {
    const result = estimatePairCapital({ ...input, longLeverage: 3, shortLeverage: 3, marginBufferPercent: 20 });
    assert.equal(result.capitalPercent, null);
    assert.notEqual(result.reason, "");
  }
  assert.equal(estimatePairCapitalFromRatio({ shortToLongRatio: 0, longLeverage: 3, shortLeverage: 3, marginBufferPercent: 20 }).capitalPercent, null);
});

test("ROC combines net convergence and holding-period funding on the same capital base", () => {
  const roc = estimatePairRoc({ ...rocInput, netSpreadPercent: 1, capitalPercent: 48, holdingHours: 24 });
  close(roc.fundingPercent, 0.03);
  close(roc.expectedNetPercent, 1.03);
  close(roc.rocPercent, 1.03 / 48 * 100);
  close(roc.annualizedRocPercent, (1.03 / 48 * 100) * 365);
  close(roc.fundingRocAnnualizedPercent, 10.95 / 48 * 100);
  assert.equal(roc.fundingAvailable, true);
  assert.equal(roc.reason, "");
});

test("missing funding remains a convergence-only ROC with an explicit reason", () => {
  const roc = estimatePairRoc({ ...rocInput, netSpreadPercent: 1, shortFunding8h: null, capitalPercent: 48, holdingHours: 24 });
  close(roc.expectedNetPercent, 1);
  close(roc.rocPercent, 1 / 48 * 100);
  assert.equal(roc.fundingRocAnnualizedPercent, null);
  assert.equal(roc.fundingAvailable, false);
  assert.match(roc.reason, /资金费缺失/);
});

test("ROC preserves real zero and negative results, and rejects missing inputs", () => {
  const zero = estimatePairRoc({ ...rocInput, netSpreadPercent: 0, shortFunding8h: 0, capitalPercent: 48, holdingHours: 24 });
  assert.equal(zero.expectedNetPercent, 0);
  assert.equal(zero.rocPercent, 0);
  const negative = estimatePairRoc({ ...rocInput, netSpreadPercent: -1, shortFunding8h: -0.0001, capitalPercent: 48, holdingHours: 24 });
  assert.ok(negative.rocPercent < 0);
  assert.ok(negative.expectedNetPercent < 0);

  for (const capitalPercent of [null, 0, -1, Number.NaN, Infinity]) {
    const result = estimatePairRoc({ ...rocInput, netSpreadPercent: 1, capitalPercent, holdingHours: 24 });
    assert.equal(result.rocPercent, null);
  }
  for (const netSpreadPercent of [null, undefined, Number.NaN, Infinity]) {
    const result = estimatePairRoc({ ...rocInput, netSpreadPercent, capitalPercent: 48, holdingHours: 24 });
    assert.equal(result.rocPercent, null);
  }
});

test("funding cash flow and capital describe the same equal-quantity hedge", () => {
  for (const rate of [0.01, -0.01, 0]) {
    const capital = estimatePairCapital({ longPrice: 100, shortPrice: 110, ...DEFAULT_CAPITAL_ASSUMPTIONS });
    const roc = estimatePairRoc({ netSpreadPercent: 0, longFunding8h: rate, shortFunding8h: rate,
      shortNotionalPercent: capital.shortNotionalPercent, capitalPercent: capital.capitalPercent, holdingHours: 24 });
    const cashPerEightHours = 110 * rate - 100 * rate;
    close(roc.fundingPercent, cashPerEightHours * 3);
    close(roc.rocPercent, cashPerEightHours * 3 / 84 * 100);
    close(roc.fundingRocAnnualizedPercent, cashPerEightHours * 3 * 365 / 84 * 100);
  }
  for (const missing of [{ longFunding8h: null }, { shortFunding8h: NaN }, { shortNotionalPercent: null }]) {
    const roc = estimatePairRoc({ ...rocInput, ...missing, netSpreadPercent: 1, capitalPercent: 48, holdingHours: 24 });
    assert.equal(roc.fundingAvailable, false);
    assert.equal(roc.fundingRocAnnualizedPercent, null);
    assert.match(roc.reason, /资金费缺失/);
  }
});
