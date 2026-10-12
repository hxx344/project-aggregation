import { ADR_PER_SHARE, FIRST_FULL_HOUR, type LiveQuote, type MarketData } from "./market.ts";
import { parseHynixFunding } from "./hynix-funding.ts";
import { createHynixFundingSnapshot, type FundingHistoryData } from "./hynix-funding-history.ts";
import { validateFundingSnapshot } from "../modules/oil/binance-funding-history.mjs";
import { SOURCE, validateMarket } from "../modules/oil/binance.mjs";
import { validateRows } from "../modules/oil/data-utils.mjs";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid market object");
  return value as Record<string, unknown>;
}
function finite(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) throw new Error("Invalid market number");
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid market timestamp");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 100_000) throw new Error("Invalid market series");
  return value;
}
function status(value: unknown): "live" | "snapshot" {
  if (value !== "live" && value !== "snapshot") throw new Error("Invalid market status");
  return value;
}
function prices(input: unknown) {
  const row = object(input), adr = finite(row.adr, true), ordinary = finite(row.ordinary, true);
  const equivalent = ordinary / ADR_PER_SHARE, spread = adr - equivalent, premium = (adr / equivalent - 1) * 100;
  if (![equivalent, spread, premium].every(Number.isFinite) || equivalent <= 0) throw new Error("Invalid market conversion");
  return { adr, ordinary, equivalent, spread, premium };
}
export function validateHynixQuote(input: unknown): LiveQuote {
  const quote = object(input), fetchedAt = stamp(quote.fetchedAt);
  let funding: LiveQuote["funding"] = null;
  if (quote.funding) {
    const item = object(quote.funding), ordinary = object(item.ordinary), adr = object(item.adr);
    const fundingAt = stamp(item.fetchedAt);
    if (Date.parse(fundingAt) > Date.parse(fetchedAt) + 60_000) throw new Error("Future funding quote");
    funding = parseHynixFunding([{ universe: [{ name: ordinary.coin }, { name: adr.coin }] }, [
      { oraclePx: finite(ordinary.oraclePx, true), funding: finite(ordinary.hourlyRate) },
      { oraclePx: finite(adr.oraclePx, true), funding: finite(adr.hourlyRate) },
    ]], fundingAt);
  }
  return { ...prices(quote), fetchedAt, funding, fundingError: funding ? "" : "资金费暂不可用，下一轮自动重试。" };
}
export function validateHynixHistory(input: unknown): MarketData {
  const history = object(input), fetchedAt = stamp(history.fetchedAt), received = Date.parse(fetchedAt);
  let previous = -Infinity;
  const points = list(history.points).map(item => {
    const row = object(item), time = finite(row.time);
    if (!Number.isSafeInteger(time) || time < FIRST_FULL_HOUR || time % 3_600_000 || time + 3_600_000 > received || time <= previous) throw new Error("Invalid historical hour");
    previous = time;
    return { time, ...prices(row) };
  });
  return { points, fetchedAt, status: status(history.status), interval: "1h", firstAvailable: new Date(points[0].time).toISOString(), warnings: Array.isArray(history.warnings) ? history.warnings.filter((item): item is string => typeof item === "string") : [] };
}
export function validateHynixFunding(input: unknown): FundingHistoryData {
  const history = object(input), metadata = object(history.metadata);
  const snapshot = createHynixFundingSnapshot(list(history.rows) as FundingHistoryData["rows"], stamp(metadata.fetchedAt));
  return { ...snapshot, status: status(history.status), ...(typeof history.error === "string" ? { error: history.error } : {}) };
}
export function validateOilQuote(input: unknown) {
  return validateMarket(input);
}
export function validateOilHistory(input: unknown) {
  const history = object(input), metadata = object(history.metadata), fetchedAt = stamp(metadata.fetchedAt);
  if (metadata.source !== SOURCE || metadata.currency !== 'USDT' || metadata.interval !== '1d' || metadata.timezone !== 'UTC') throw new Error('Expected Binance daily history');
  let previous = "";
  const data = list(history.data).map(item => {
    const row = object(item);
    if (typeof row.date !== "string" || !/^2026-\d{2}-\d{2}$/.test(row.date) || row.date <= previous || !Number.isFinite(Date.parse(row.date)) || Date.parse(row.date) + 86_400_000 > Date.parse(fetchedAt)) throw new Error("Invalid oil candle date");
    previous = row.date;
    return { date: row.date, brent: row.brent === null ? null : finite(row.brent, true), wti: row.wti === null ? null : finite(row.wti, true) };
  });
  const paired = validateRows(data.filter(row => row.brent !== null && row.wti !== null));
  if (paired.length !== metadata.pairedObservationRows || paired[0].date !== metadata.firstCommonObservation || paired.at(-1)!.date !== metadata.lastCommonObservation) throw new Error("Oil history metadata mismatch");
  return { data, market: validateOilQuote(history.market), status: status(history.status), metadata: { fetchedAt, firstCommonObservation: paired[0].date, lastCommonObservation: paired.at(-1)!.date, pairedObservationRows: paired.length, source: SOURCE, currency: 'USDT', interval: "1d", timezone: "UTC" } };
}
export function validateOilFunding(input: unknown) {
  const history = object(input);
  return { ...validateFundingSnapshot(history), status: status(history.status) };
}
