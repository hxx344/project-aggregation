import type { FundingWindowHours } from "./perpetual-funding-history.ts";
import { scannerAmountValue, scannerCurrencyValue, scannerHistoryValue, type ScannerRangeData, type ScannerRangeValue } from "./perpetual-scanner-filters.ts";
import { annualizedFundingPercent } from "./perpetual-scanner.ts";
import { normalizedFunding8h, perpetualSpreadKey, quoteIsFresh, type PerpetualFilters, type PerpetualSpread } from "./perpetual-spreads.ts";

export type ScannerSortColumn = "fundingSpread" | "annualized" | "volume" | "openInterest" | "quote" | "spread" | "history24h" | "history7d" | "history30d";
export interface ScannerSort { column: ScannerSortColumn; direction: "asc" | "desc"; leg?: "long" | "short" }

const columns = new Set<string>(["fundingSpread", "annualized", "volume", "openInterest", "quote", "spread", "history24h", "history7d", "history30d"]);
const legColumns = new Set<ScannerSortColumn>(["volume", "openInterest", "quote"]);
const historyWindows: Partial<Record<ScannerSortColumn, FundingWindowHours>> = { history24h: 24, history7d: 168, history30d: 720 };

/** Stored preferences are independent of current rates, list positions and formatting. */
export function parseScannerSort(raw: unknown): ScannerSort | null {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  if (!Object.hasOwn(saved, "column") || !Object.hasOwn(saved, "direction") || typeof saved.column !== "string" || !columns.has(saved.column)
    || (saved.direction !== "asc" && saved.direction !== "desc")) return null;
  const column = saved.column as ScannerSortColumn, direction = saved.direction;
  if (!legColumns.has(column)) return { column, direction };
  const leg = Object.hasOwn(saved, "leg") ? saved.leg : undefined;
  return leg === undefined || leg === "long" || leg === "short" ? { column, direction, leg: leg ?? "long" } : null;
}

export function nextScannerSort(current: ScannerSort | null, column: ScannerSortColumn, leg?: "long" | "short"): ScannerSort {
  const previous = parseScannerSort(current), selectedLeg = legColumns.has(column) ? leg ?? "long" : undefined;
  const direction = previous?.column === column && previous.leg === selectedLeg && previous.direction === "desc" ? "asc" : "desc";
  return { column, direction, ...(selectedLeg === undefined ? {} : { leg: selectedLeg }) };
}

export function scannerSortRequirements(sort: ScannerSort | null): { metrics: boolean; historyHours: FundingWindowHours[]; needsFx: boolean } {
  const metrics = sort?.column === "volume" || sort?.column === "openInterest", hours = sort ? historyWindows[sort.column] : undefined;
  return { metrics, historyHours: hours === undefined ? [] : [hours], needsFx: metrics || sort?.column === "quote" };
}

type SortData = ScannerRangeData & { net: boolean; priceMode: PerpetualFilters["priceMode"]; staleAfterMs: number };
const finite = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const numeric = (value: ScannerRangeValue): number | null => typeof value === "number" ? finite(value) : null;

function sortValue(row: PerpetualSpread, sort: ScannerSort, data: SortData): number | null {
  const hours = historyWindows[sort.column];
  if (hours !== undefined) return numeric(scannerHistoryValue(row, hours, data));
  if (sort.column === "volume" || sort.column === "openInterest") {
    return numeric(scannerAmountValue(row[sort.leg ?? "long"], sort.column === "volume" ? "volume24h" : "openInterest", data, "USDT"));
  }
  if (sort.column === "quote") {
    const leg = sort.leg ?? "long", quote = row[leg], price = finite(leg === "long" ? row.buyPrice : row.sellPrice);
    if (price === null || price <= 0 || !quoteIsFresh(quote, data.priceMode, data.now, data.staleAfterMs)) return null;
    // Public prices are already normalized per asset; do not apply multiplier again.
    return numeric(scannerCurrencyValue(price, quote.quoteCurrency, "USDT", data));
  }
  if (sort.column === "spread") {
    if (!quoteIsFresh(row.long, data.priceMode, data.now, data.staleAfterMs) || !quoteIsFresh(row.short, data.priceMode, data.now, data.staleAfterMs)) return null;
    return finite(data.net ? row.netSpreadPercent : row.spreadPercent);
  }
  const long = normalizedFunding8h(row.long, data.now), short = normalizedFunding8h(row.short, data.now);
  if (long === null || short === null) return null;
  const carry = short - long;
  return finite(sort.column === "annualized" ? annualizedFundingPercent(carry) : carry * 100);
}

/** Sort all matched rows before pagination. Missing evidence stays last in both directions. */
export function sortScannerRows(rows: readonly PerpetualSpread[], sort: ScannerSort, data: SortData): PerpetualSpread[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.map(row => ({ row, key: perpetualSpreadKey(row), value: sortValue(row, sort, data) })).sort((left, right) => {
    if (left.value === null && right.value !== null) return 1;
    if (left.value !== null && right.value === null) return -1;
    if (left.value !== null && right.value !== null && left.value !== right.value) return (left.value < right.value ? -1 : 1) * direction;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  }).map(entry => entry.row);
}
