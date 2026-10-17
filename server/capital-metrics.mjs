/**
 * Pure capital and return-on-capital helpers shared by Monitor and CrossEx.
 *
 * Percentages are percentage points (1 = 1%), never decimal fractions.
 * Capital is expressed relative to the long leg's entry notional so callers can
 * compare a two-leg position with the same unit used by `netSpreadPercent`.
 */
export const DEFAULT_CAPITAL_ASSUMPTIONS = Object.freeze({
  longLeverage: 3,
  shortLeverage: 3,
  marginBufferPercent: 20,
  holdingHours: 24,
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const readNumber = (value, fallback, min, max) => {
  if (value === null || value === undefined || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  return finite(number) ? clamp(number, min, max) : fallback;
};

/** Browser storage is untrusted; every field is clamped to a documented range. */
export function normalizeCapitalAssumptions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    longLeverage: readNumber(source.longLeverage, DEFAULT_CAPITAL_ASSUMPTIONS.longLeverage, 1, 20),
    shortLeverage: readNumber(source.shortLeverage, DEFAULT_CAPITAL_ASSUMPTIONS.shortLeverage, 1, 20),
    marginBufferPercent: readNumber(source.marginBufferPercent, DEFAULT_CAPITAL_ASSUMPTIONS.marginBufferPercent, 0, 100),
    holdingHours: readNumber(source.holdingHours, DEFAULT_CAPITAL_ASSUMPTIONS.holdingHours, 1, 168),
  };
}

export function parseCapitalAssumptions(raw) {
  if (raw === null || raw === undefined || raw === "") return { ...DEFAULT_CAPITAL_ASSUMPTIONS };
  try {
    return normalizeCapitalAssumptions(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return { ...DEFAULT_CAPITAL_ASSUMPTIONS };
  }
}

/**
 * Capital as a percentage of the long leg's notional.
 * `shortToLongRatio` should be the short entry price divided by the long entry
 * price (or 1 + gross spread for quote-only callers). Each leg's margin is
 * `notional / leverage`; the buffer is applied to the sum.
 */
export function estimatePairCapitalFromRatio({ shortToLongRatio, longLeverage, shortLeverage, marginBufferPercent }) {
  const ratio = finite(shortToLongRatio) && shortToLongRatio > 0 ? shortToLongRatio : null;
  if (ratio === null) return { capitalPercent: null, longMarginPercent: null, shortNotionalPercent: null, shortMarginPercent: null, reason: "空腿/多腿价格比无效" };
  const longL = readNumber(longLeverage, DEFAULT_CAPITAL_ASSUMPTIONS.longLeverage, 1, 20);
  const shortL = readNumber(shortLeverage, DEFAULT_CAPITAL_ASSUMPTIONS.shortLeverage, 1, 20);
  const buffer = readNumber(marginBufferPercent, DEFAULT_CAPITAL_ASSUMPTIONS.marginBufferPercent, 0, 100);
  const longMarginPercent = 100 / longL;
  const shortNotionalPercent = ratio * 100;
  const shortMarginPercent = shortNotionalPercent / shortL;
  const capitalPercent = (longMarginPercent + shortMarginPercent) * (1 + buffer / 100);
  if (!finite(capitalPercent) || capitalPercent <= 0) return { capitalPercent: null, longMarginPercent: null, shortNotionalPercent: null, shortMarginPercent: null, reason: "所需资本无效" };
  return { capitalPercent, longMarginPercent, shortNotionalPercent, shortMarginPercent, reason: "" };
}

export function estimatePairCapital({ longPrice, shortPrice, longLeverage, shortLeverage, marginBufferPercent }) {
  if (!finite(longPrice) || longPrice <= 0) return { capitalPercent: null, longMarginPercent: null, shortNotionalPercent: null, shortMarginPercent: null, reason: "做多腿价格无效" };
  if (!finite(shortPrice) || shortPrice <= 0) return { capitalPercent: null, longMarginPercent: null, shortNotionalPercent: null, shortMarginPercent: null, reason: "做空腿价格无效" };
  return estimatePairCapitalFromRatio({ shortToLongRatio: shortPrice / longPrice, longLeverage, shortLeverage, marginBufferPercent });
}

/**
 * Scenario ROC for a fixed holding period. `netSpreadPercent` already includes
 * round-trip fees and slippage and assumes convergence to the exit spread.
 * Each leg's funding is a decimal fraction (0.0001 = 0.01% per 8h).
 * Weight the short leg by its own notional, as in the capital denominator.
 *
 * `annualizedRocPercent` repeats the whole scenario every holding period; it is
 * shown in detail only. `fundingRocAnnualizedPercent` annualizes the funding
 * carry alone and is the safer headline when comparing carry strategies.
 */
export function estimatePairRoc({ netSpreadPercent, longFunding8h, shortFunding8h, shortNotionalPercent, capitalPercent, holdingHours }) {
  const capital = finite(capitalPercent) && capitalPercent > 0 ? capitalPercent : null;
  if (capital === null) return { expectedNetPercent: null, rocPercent: null, annualizedRocPercent: null, fundingRocAnnualizedPercent: null, fundingPercent: null, fundingAvailable: false, reason: "所需资本缺失" };
  if (!finite(netSpreadPercent)) return { expectedNetPercent: null, rocPercent: null, annualizedRocPercent: null, fundingRocAnnualizedPercent: null, fundingPercent: null, fundingAvailable: false, reason: "净价差缺失" };
  const hours = readNumber(holdingHours, DEFAULT_CAPITAL_ASSUMPTIONS.holdingHours, 1, 168);
  const fundingAvailable = finite(longFunding8h) && finite(shortFunding8h) && finite(shortNotionalPercent) && shortNotionalPercent > 0;
  const fundingPercent8h = fundingAvailable ? shortFunding8h * shortNotionalPercent - longFunding8h * 100 : null;
  const fundingPercent = fundingAvailable ? fundingPercent8h * (hours / 8) : null;
  const expectedNetPercent = netSpreadPercent + (fundingPercent ?? 0);
  const rocPercent = expectedNetPercent / capital * 100;
  if (!finite(expectedNetPercent) || !finite(rocPercent)) return { expectedNetPercent: null, rocPercent: null, annualizedRocPercent: null, fundingRocAnnualizedPercent: null, fundingPercent, fundingAvailable, reason: "ROC 超出可计算范围" };
  const annualizedRocPercent = rocPercent * (365 * 24 / hours);
  const fundingRocAnnualizedPercent = fundingAvailable ? (fundingPercent8h * 3 * 365) / capital * 100 : null;
  return {
    expectedNetPercent,
    rocPercent,
    annualizedRocPercent: finite(annualizedRocPercent) ? annualizedRocPercent : null,
    fundingRocAnnualizedPercent: finite(fundingRocAnnualizedPercent) ? fundingRocAnnualizedPercent : null,
    fundingPercent,
    fundingAvailable,
    reason: fundingAvailable ? "" : "资金费缺失，仅按价差收敛估算",
  };
}
