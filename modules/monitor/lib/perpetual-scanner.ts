import type { PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualQuote } from "./perpetual-types.ts";

export const SCANNER_COLUMNS = [
  { id: "type", label: "类型", defaultVisible: true },
  { id: "pair", label: "组合", defaultVisible: true },
  { id: "funding", label: "资金费率", defaultVisible: true },
  { id: "fundingSpread", label: "资金费差", defaultVisible: true },
  { id: "annualized", label: "年化", defaultVisible: true },
  { id: "volume", label: "24h 成交额", defaultVisible: true },
  { id: "openInterest", label: "持仓量", defaultVisible: true },
  { id: "quote", label: "报价", defaultVisible: true },
  { id: "spread", label: "开仓价差", defaultVisible: true },
  { id: "history24h", label: "24h · 实际", defaultVisible: true },
  { id: "history7d", label: "7天 · 实际", defaultVisible: true },
  { id: "history30d", label: "30天 · 实际", defaultVisible: true },
  { id: "time", label: "报价时间", defaultVisible: false },
  { id: "quality", label: "质量", defaultVisible: false },
] as const;

export type ScannerColumnId = typeof SCANNER_COLUMNS[number]["id"];

export const SCANNER_CATEGORIES = [
  { id: "crypto", label: "加密资产" },
  { id: "equity", label: "股票" },
  { id: "commodity", label: "商品" },
  { id: "forex", label: "外汇" },
  { id: "index", label: "指数" },
  { id: "unknown", label: "未分类" },
] as const;

export type ScannerCategoryId = typeof SCANNER_CATEGORIES[number]["id"];
export interface ScannerPreferences { columns: ScannerColumnId[]; categories: ScannerCategoryId[] }

export const defaultScannerPreferences: ScannerPreferences = {
  columns: SCANNER_COLUMNS.filter(column => column.defaultVisible).map(column => column.id),
  categories: SCANNER_CATEGORIES.map(category => category.id),
};

const columnIds = new Set<string>(SCANNER_COLUMNS.map(column => column.id));
const categoryIds = new Set<string>(SCANNER_CATEGORIES.map(category => category.id));

/** Display preferences are independent of trading filters; an explicit empty list stays empty. */
export function parseScannerPreferences(raw: string | null): ScannerPreferences {
  const defaults = (): ScannerPreferences => ({ columns: [...defaultScannerPreferences.columns], categories: [...defaultScannerPreferences.categories] });
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults();
    const saved = value as Record<string, unknown>;
    return {
      columns: Array.isArray(saved.columns)
        ? [...new Set(saved.columns.filter((id): id is ScannerColumnId => typeof id === "string" && columnIds.has(id)))]
        : [...defaultScannerPreferences.columns],
      categories: Array.isArray(saved.categories)
        ? [...new Set(saved.categories.filter((id): id is ScannerCategoryId => typeof id === "string" && categoryIds.has(id)))]
        : [...defaultScannerPreferences.categories],
    };
  } catch { return defaults(); }
}

type ScannerQuoteIdentity = Pick<PerpetualQuote, "assetClass" | "identitySource" | "identityVerified">;

/** Only explicit official directory categories count; symbols and price similarity never do. */
export function scannerQuoteCategory(quote: ScannerQuoteIdentity): ScannerCategoryId {
  if (typeof quote.identitySource !== "string" || !quote.identitySource.trim() || typeof quote.assetClass !== "string") return "unknown";
  const assetClass = quote.assetClass.trim().toLowerCase();
  // Several adapters default missing metadata to crypto. Require separate positive evidence.
  if (assetClass === "crypto") return quote.identityVerified === true ? "crypto" : "unknown";
  // These are the explicit category names in the existing official venue directories.
  if (["equity", "stock", "stocks"].includes(assetClass)) return "equity";
  if (["commodity", "commodities", "metals"].includes(assetClass)) return "commodity";
  if (assetClass === "forex") return "forex";
  if (["index", "indices"].includes(assetClass)) return "index";
  // RWA, ETFs and pre-market labels alone do not establish one of the above categories.
  return "unknown";
}

export function scannerPairCategory(row: Pick<PerpetualSpread, "long" | "short">): ScannerCategoryId {
  const long = scannerQuoteCategory(row.long), short = scannerQuoteCategory(row.short);
  return long === short ? long : "unknown";
}

/** Simple annual extrapolation of short-minus-long eight-hour carry, in percentage points. */
export function annualizedFundingPercent(spread8h: number | null): number | null {
  if (spread8h === null || !Number.isFinite(spread8h)) return null;
  const annualized = spread8h * 3 * 365 * 100;
  return Number.isFinite(annualized) ? annualized : null;
}
