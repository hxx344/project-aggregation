import { quoteCurrencyFx, type PerpetualFxSnapshot } from "./perpetual-fx.ts";
import { PERPETUAL_FUNDING_STALE_MS, type FundingWindowHours, type FundingWindowTotal } from "./perpetual-funding-history.ts";
import { PERPETUAL_MARKET_METRICS_STALE_MS, type PerpetualMarketMetricsLeg } from "./perpetual-market-metrics.ts";
import { annualizedFundingPercent } from "./perpetual-scanner.ts";
import { normalizedFunding8h, type PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualQuote } from "./perpetual-types.ts";

export const SCANNER_RANGE_IDS = [
  "longVolume", "shortVolume", "longOpenInterest", "shortOpenInterest", "spread",
  "fundingSpread", "annualized", "history24h", "history7d", "history30d",
] as const;
export type ScannerRangeId = typeof SCANNER_RANGE_IDS[number];
export type ScannerRangeInputs = Record<ScannerRangeId, { min: string; max: string }>;
export interface ScannerNumericRange { min: number | null; max: number | null }
export interface CompiledScannerRanges {
  ranges: Partial<Record<ScannerRangeId, ScannerNumericRange>>;
  errors: Partial<Record<ScannerRangeId, string>>;
  active: ScannerRangeId[];
  valid: boolean;
  needsMetrics: boolean;
  needsFx: boolean;
  historyHours: FundingWindowHours[];
}
export type ScannerRangeStatus = "match" | "pending" | "missing" | "reject";
export type ScannerHistoryTotals = Record<string, Partial<Record<FundingWindowHours, FundingWindowTotal>>>;
export interface ScannerRangeData {
  metrics?: Record<string, PerpetualMarketMetricsLeg>;
  history?: ScannerHistoryTotals;
  fx?: PerpetualFxSnapshot | null;
  now: number;
}

export const defaultScannerRangeInputs: ScannerRangeInputs = {
  longVolume: { min: "", max: "" }, shortVolume: { min: "", max: "" },
  longOpenInterest: { min: "", max: "" }, shortOpenInterest: { min: "", max: "" },
  spread: { min: "", max: "" }, fundingSpread: { min: "", max: "" }, annualized: { min: "", max: "" },
  history24h: { min: "", max: "" }, history7d: { min: "", max: "" }, history30d: { min: "", max: "" },
};

const amountIds = new Set<ScannerRangeId>(["longVolume", "shortVolume", "longOpenInterest", "shortOpenInterest"]);
const historyWindows: Partial<Record<ScannerRangeId, FundingWindowHours>> = { history24h: 24, history7d: 168, history30d: 720 };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Restore only input strings; invalid text remains visible for validation rather than becoming zero. */
export function parseScannerRangeInputs(raw: unknown): ScannerRangeInputs {
  let saved: unknown = raw;
  if (typeof raw === "string") {
    try { saved = JSON.parse(raw); } catch { saved = null; }
  }
  return Object.fromEntries(SCANNER_RANGE_IDS.map(id => {
    const input = record(saved) && Object.hasOwn(saved, id) ? saved[id] : null;
    return [id, {
      min: record(input) && typeof input.min === "string" ? input.min : "",
      max: record(input) && typeof input.max === "string" ? input.max : "",
    }];
  })) as ScannerRangeInputs;
}

function parseBound(raw: string, amount: boolean): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  const matched = (amount ? /^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*([kmb])?$/i : /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*%?$/).exec(text);
  if (!matched) return "invalid";
  const multiplier = amount ? ({ k: 1e3, m: 1e6, b: 1e9 }[matched[2]?.toLowerCase()] ?? 1) : 1;
  const value = Number(matched[1]) * multiplier;
  return Number.isFinite(value) ? value : "invalid";
}

/** Bounds are inclusive. Percent inputs are percentage points, not decimal fractions. */
export function compileScannerRanges(inputs: ScannerRangeInputs): CompiledScannerRanges {
  const ranges: CompiledScannerRanges["ranges"] = {}, errors: CompiledScannerRanges["errors"] = {}, active: ScannerRangeId[] = [];
  for (const id of SCANNER_RANGE_IDS) {
    const input = inputs[id], amount = amountIds.has(id);
    if (!input.min.trim() && !input.max.trim()) continue;
    active.push(id);
    const min = parseBound(input.min, amount), max = parseBound(input.max, amount);
    if (min === "invalid" || max === "invalid") {
      errors[id] = amount ? "请输入非负金额，可使用 K、M、B" : "请输入有效百分数，可为负数";
    } else if (min !== null && max !== null && min > max) {
      errors[id] = "最小值不能大于最大值";
    } else ranges[id] = { min, max };
  }
  const needsMetrics = active.some(id => amountIds.has(id));
  return { ranges, errors, active, valid: Object.keys(errors).length === 0, needsMetrics, needsFx: needsMetrics,
    historyHours: active.flatMap(id => historyWindows[id] === undefined ? [] : [historyWindows[id]!]) };
}

const legKey = (quote: Pick<PerpetualQuote, "exchange" | "symbol">): string => `${quote.exchange}:${quote.symbol}`;

/** One shared historical total serves both directions; the canonical first leg is long. */
export function scannerHistoryPairKey(row: Pick<PerpetualSpread, "base" | "long" | "short">): string {
  const long = legKey(row.long), short = legKey(row.short);
  return JSON.stringify([row.base, ...(long < short ? [long, short] : [short, long])]);
}

function fresh(timestamp: number | null | undefined, now: number, staleAfterMs: number): boolean {
  return typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(now)
    && timestamp <= now + 5_000 && now - timestamp <= staleAfterMs;
}

export type ScannerRangeValue = number | "pending" | "missing";

/** Explicit reference units: range inputs remain USD; table sorting can use USDT. */
export function scannerCurrencyValue(value: number, currency: string, referenceCurrency: "USD" | "USDT", data: ScannerRangeData): ScannerRangeValue {
  if (!Number.isFinite(value)) return "missing";
  if (currency === referenceCurrency) return value;
  if (!data.fx) return "pending";
  const from = quoteCurrencyFx(currency, data.fx, data.now), reference = quoteCurrencyFx(referenceCurrency, data.fx, data.now);
  if (!from || !reference) return "missing";
  // Dividing both midpoints by two separately avoids an overflowing bid + ask sum.
  const converted = value * ((from.bid / 2 + from.ask / 2) / (reference.bid / 2 + reference.ask / 2));
  return Number.isFinite(converted) ? converted : "missing";
}

export function scannerAmountValue(quote: PerpetualQuote, field: "volume24h" | "openInterest", data: ScannerRangeData, referenceCurrency: "USD" | "USDT" = "USD"): ScannerRangeValue {
  const key = legKey(quote), leg = data.metrics?.[key];
  if (!leg) return "pending";
  if (leg.key !== key || leg.exchange !== quote.exchange || leg.symbol !== quote.symbol) return "missing";
  if (leg.status === "pending") return leg.error ? "missing" : "pending";
  if (leg.status !== "ready") return "missing";
  const metric = leg[field];
  if (!metric || metric.error || metric.value === null || !Number.isFinite(metric.value) || metric.value < 0
    || !metric.currency || !fresh(metric.observedAt, data.now, PERPETUAL_MARKET_METRICS_STALE_MS)) return "missing";
  return scannerCurrencyValue(metric.value, metric.currency, referenceCurrency, data);
}

export function scannerHistoryValue(row: PerpetualSpread, hours: FundingWindowHours, data: ScannerRangeData): ScannerRangeValue {
  const total = data.history?.[scannerHistoryPairKey(row)]?.[hours];
  if (!total || total.status === "pending") return "pending";
  if (total.status !== "ready" || total.hours !== hours || total.netPercent === null || !Number.isFinite(total.netPercent)
    || !fresh(total.asOf, data.now, PERPETUAL_FUNDING_STALE_MS)) return "missing";
  return legKey(row.long) < legKey(row.short) ? total.netPercent : -total.netPercent;
}

function rangeValue(row: PerpetualSpread, id: ScannerRangeId, data: ScannerRangeData): ScannerRangeValue {
  if (id === "longVolume") return scannerAmountValue(row.long, "volume24h", data);
  if (id === "shortVolume") return scannerAmountValue(row.short, "volume24h", data);
  if (id === "longOpenInterest") return scannerAmountValue(row.long, "openInterest", data);
  if (id === "shortOpenInterest") return scannerAmountValue(row.short, "openInterest", data);
  if (id === "spread") return Number.isFinite(row.spreadPercent) ? row.spreadPercent : "missing";
  const hours = historyWindows[id];
  if (hours !== undefined) return scannerHistoryValue(row, hours, data);
  const long = normalizedFunding8h(row.long, data.now), short = normalizedFunding8h(row.short, data.now);
  if (long === null || short === null) return "missing";
  const carry = short - long, value = id === "annualized" ? annualizedFundingPercent(carry) : carry * 100;
  return value !== null && Number.isFinite(value) ? value : "missing";
}

/** Evaluate ranked, price-eligible rows. Only enabled ranges require their supporting data. */
export function evaluateScannerRanges(row: PerpetualSpread, compiled: CompiledScannerRanges, data: ScannerRangeData): ScannerRangeStatus {
  if (!compiled.valid) return "reject";
  let status: ScannerRangeStatus = "match";
  for (const id of compiled.active) {
    const range = compiled.ranges[id]!;
    const value = rangeValue(row, id, data);
    if (value === "missing") { status = "missing"; continue; }
    if (value === "pending") { if (status === "match") status = "pending"; continue; }
    if ((range.min !== null && value < range.min) || (range.max !== null && value > range.max)) return "reject";
  }
  return status;
}
