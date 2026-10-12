import { ADR_PER_SHARE, type FundingLeg, type HynixFunding } from "./market.ts";

function number(value: unknown, positive = false) {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) throw new Error("Invalid funding context value");
  return Number(value);
}

export function parseHynixFunding(response: unknown, fetchedAt: string): HynixFunding {
  if (!Array.isArray(response) || !Array.isArray(response[0]?.universe) || !Array.isArray(response[1]) || response[0].universe.length !== response[1].length) throw new Error("Invalid funding context response");
  const universe = response[0].universe as { name?: string; isDelisted?: boolean }[];
  const contexts = response[1] as Record<string, unknown>[];
  const leg = (coin: string): FundingLeg => {
    const matches = universe.flatMap((asset, index) => asset?.name === coin ? [index] : []);
    if (matches.length !== 1 || universe[matches[0]].isDelisted || !contexts[matches[0]]) throw new Error("Missing active funding leg");
    const context = contexts[matches[0]];
    return { coin, oraclePx: number(context.oraclePx, true), hourlyRate: number(context.funding) };
  };
  const ordinary = leg("xyz:SKHX"), adr = leg("xyz:SKHY");
  // Short 10 ADR contracts and long 1 ordinary-share contract. Positive funding
  // pays the short and charges the long; each notional uses its oracle price.
  const adrNotional = ADR_PER_SHARE * adr.oraclePx;
  const grossNotional = adrNotional + ordinary.oraclePx;
  const hourlyCashflow = adrNotional * adr.hourlyRate - ordinary.oraclePx * ordinary.hourlyRate;
  const hourlyRate = hourlyCashflow / grossNotional;
  const annualizedRate = hourlyRate * 24 * 365;
  if (![grossNotional, hourlyCashflow, hourlyRate, annualizedRate].every(Number.isFinite) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("Invalid net funding result");
  return { ordinary, adr, grossNotional, hourlyCashflow, hourlyRate, annualizedRate, fetchedAt };
}
