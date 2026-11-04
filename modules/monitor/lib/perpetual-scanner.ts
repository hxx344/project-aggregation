import type { PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualQuote } from "./perpetual-types.ts";

export const SCANNER_COLUMNS = [
  { id: "type", label: "类型", defaultVisible: true },
  { id: "pair", label: "组合", defaultVisible: true },
  { id: "funding", label: "资金费率", defaultVisible: true },
  { id: "fundingSpread", label: "资金费差", defaultVisible: true },
  { id: "fundingStability", label: "费差 24h", defaultVisible: true },
  { id: "annualized", label: "年化", defaultVisible: true },
  { id: "volume", label: "24h 成交额", defaultVisible: true },
  { id: "openInterest", label: "持仓量", defaultVisible: true },
  { id: "quote", label: "报价", defaultVisible: true },
  { id: "spread", label: "开仓价差", defaultVisible: true },
  { id: "capital", label: "所需资本", defaultVisible: true },
  { id: "roc", label: "ROC", defaultVisible: true },
  { id: "breakEven", label: "回本 / 收益", defaultVisible: true },
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
/** `groupByBase` shows one row per asset with its other combinations behind a toggle. */
export interface ScannerPreferences { version: 3; columns: ScannerColumnId[]; categories: ScannerCategoryId[]; groupByBase: boolean }

export const defaultScannerPreferences: ScannerPreferences = {
  version: 3,
  columns: SCANNER_COLUMNS.filter(column => column.defaultVisible).map(column => column.id),
  categories: SCANNER_CATEGORIES.map(category => category.id),
  groupByBase: true,
};

/** Columns introduced after each saved version; explicitly hidden older columns stay hidden. */
const addedColumns: Record<number, ScannerColumnId[]> = { 1: ["capital", "roc", "fundingStability", "breakEven"], 2: ["fundingStability", "breakEven"] };

const columnIds = new Set<string>(SCANNER_COLUMNS.map(column => column.id));
const categoryIds = new Set<string>(SCANNER_CATEGORIES.map(category => category.id));

/** Display preferences are independent of trading filters; an explicit empty list stays empty. */
export function parseScannerPreferences(raw: string | null): ScannerPreferences {
  const defaults = (): ScannerPreferences => ({ version: 3, columns: [...defaultScannerPreferences.columns], categories: [...defaultScannerPreferences.categories], groupByBase: true });
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults();
    const saved = value as Record<string, unknown>;
    const columns: ScannerColumnId[] = Array.isArray(saved.columns)
      ? [...new Set(saved.columns.filter((id): id is ScannerColumnId => typeof id === "string" && columnIds.has(id)))]
      : [...defaultScannerPreferences.columns];
    // Older versions saved a smaller default list. Keep explicitly hidden columns
    // hidden, but make new first-class metrics visible to existing users.
    const added = saved.version === 3 || columns.length === 0 ? [] : addedColumns[saved.version === 2 ? 2 : 1];
    const migrated = [...new Set<ScannerColumnId>([...columns, ...added])];
    return {
      version: 3,
      columns: migrated,
      groupByBase: typeof saved.groupByBase === "boolean" ? saved.groupByBase : true,
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

export interface ScannerRowGroup<T> { base: string; lead: T; others: T[] }

/**
 * One group per asset in ranking order: the lead is the first (best-ranked)
 * combination of that asset and `others` keep their relative order.
 */
export function groupScannerRows<T extends Pick<PerpetualSpread, "base">>(rows: readonly T[]): ScannerRowGroup<T>[] {
  const groups = new Map<string, ScannerRowGroup<T>>();
  for (const row of rows) {
    const group = groups.get(row.base);
    if (group) group.others.push(row);
    else groups.set(row.base, { base: row.base, lead: row, others: [] });
  }
  return [...groups.values()];
}

/** Rows fetched per page share the 30-pair budget of the quality, history and metric feeds. */
export const SCANNER_ROW_BUDGET = 30;
export const SCANNER_GROUP_PAGE_SIZE = 20;

export interface FundingStabilityView {
  /** 8h-normalized percentage points over the last 24h. */
  mean: number; max: number | null;
  /** Trailing consecutive positive run; `capped` means it reaches the oldest retained sample. */
  positiveRunMs: number | null; positiveRunCapped: boolean;
  samples: number; coverage: number;
}

type FundingStabilityInput = {
  samples: number; coverage: number; lastAt: number | null; mean: number | null;
  max?: number | null; positiveRunMs?: number | null; positiveRunCapped?: boolean;
};

/** Same readiness rule as the quality rubric: at least 12 real five-minute samples, the latest within 10 minutes. */
export function fundingStabilityView(funding: FundingStabilityInput | undefined, now: number): FundingStabilityView | null {
  if (!funding || funding.samples < 12 || funding.mean === null || !Number.isFinite(funding.mean)) return null;
  const lastAt = funding.lastAt;
  if (lastAt === null || !Number.isFinite(lastAt) || lastAt > now + 5_000 || now - lastAt > 600_000) return null;
  const max = typeof funding.max === "number" && Number.isFinite(funding.max) ? funding.max : null;
  const run = typeof funding.positiveRunMs === "number" && Number.isFinite(funding.positiveRunMs) && funding.positiveRunMs >= 0 ? funding.positiveRunMs : null;
  return { mean: funding.mean, max, positiveRunMs: run, positiveRunCapped: run !== null && run > 0 && funding.positiveRunCapped === true, samples: funding.samples, coverage: funding.coverage };
}

/** Compact duration for list cells: minutes under an hour, hours under two days, then days. */
export function formatRunDuration(ms: number): string {
  // Floor everywhere so a run just under an hour never reads as "0h".
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)} 天`;
}

/** Break-even hours as shown in the list; very long periods are not worth a precise number. */
export function formatBreakEvenHours(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  if (hours <= 720) return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} 天`;
  return ">30 天";
}

/** Principal used to turn ROC into an amount; browser storage is untrusted and clamped. */
export const DEFAULT_SCANNER_PRINCIPAL = 1000;
export function parseScannerPrincipal(raw: string | null): number {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    const principal = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).principal : undefined;
    return normalizeScannerPrincipal(principal);
  } catch { return DEFAULT_SCANNER_PRINCIPAL; }
}
export function normalizeScannerPrincipal(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(10_000_000, Math.max(1, value)) : DEFAULT_SCANNER_PRINCIPAL;
}
