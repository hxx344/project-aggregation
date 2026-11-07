import type { LiveQuote } from "./market";
import { createTrend, type MonitorTrend, type TrendHistory } from "./monitor-trend.ts";
import { hynixExchangeQuote, type ExchangeQuote } from "./exchange-quotes.ts";
import { getQuoteStaleAfterMs } from './market-freshness.ts';
import { ANTHROPIC_COMPARISON_LEGS, ANTHROPIC_LEGS } from '../modules/anthropic/market.mjs';
import type { AnthropicComparisonLeg } from './anthropic-history.ts';

export type SummaryStatus = "loading" | "live" | "snapshot" | "stale" | "error";
export type SummaryMetric = { label: string; value: string; tone?: "positive" | "negative" };
export type MonitorSummary = { status: SummaryStatus; fetchedAt: string | null; staleAfterMs?: number; metrics: SummaryMetric[]; note?: string; trend?: MonitorTrend; comparison?: ExchangeQuote };
export type SummaryProps = { onSummary?: (summary: MonitorSummary) => void };
export type OilSummaryUpdate = {
  status: SummaryStatus;
  /** (Brent - WTI) / WTI * 100, already expressed as a percentage. */
  spread: number | null;
  fundingHourlyRate: number | null;
  fundingBasis: "quantity" | "notional";
  fetchedAt: string | null;
  staleAfterMs?: number;
  history?: TrendHistory;
  comparison?: ExchangeQuote;
};

function metric(label: string, value: number | null | undefined, digits: number, unit: string): SummaryMetric {
  if (value == null || !Number.isFinite(value)) return { label, value: "—" };
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return { label, value: `${sign}${Math.abs(rounded).toFixed(digits)}${unit}`, tone: rounded > 0 ? "positive" : rounded < 0 ? "negative" : undefined };
}

export const hynixTrendOptions = { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" };

export function hynixSummary(quote: LiveQuote | null, error = "", trend?: MonitorTrend): MonitorSummary {
  const funding = quote?.funding;
  return {
    status: quote ? error ? "stale" : quote.status === "snapshot" ? "snapshot" : "live" : error ? "error" : "loading",
    fetchedAt: funding && quote && Date.parse(funding.fetchedAt) < Date.parse(quote.fetchedAt) ? funding.fetchedAt : quote?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs(quote, 35_000),
    metrics: [metric("ADR 溢价率", quote?.premium, 2, "%"), metric("净资金费 / 年化", funding?.annualizedRate == null ? null : funding.annualizedRate * 100, 2, "%")],
    note: `空 10 份 ADR、多 1 股正股${quote && !funding ? " · 资金费暂不可用" : ""}`,
    trend: trend ?? createTrend(undefined, hynixTrendOptions),
    comparison: quote ? hynixExchangeQuote(quote, Boolean(error)) : undefined,
  };
}

export const oilTrendOptions = { days: 7, intervalMs: 900_000, label: "7 天 · 15 分钟线", shortLabel: "7天", unit: " USDT/桶" };

export function oilSummary(update?: OilSummaryUpdate, trend?: MonitorTrend): MonitorSummary {
  return {
    status: update?.status ?? "loading",
    fetchedAt: update?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs({ collection: { maxAgeMs: update?.staleAfterMs } }, 75_000),
    metrics: [
      metric("价差 · USDT/桶", update?.spread, 3, ""),
      metric("净资金费 / 年化", update?.fundingHourlyRate == null ? null : update.fundingHourlyRate * 24 * 365 * 100, 2, "%"),
    ],
    note: `空布伦特、多 WTI · ${update?.fundingBasis === "notional" ? "等名义" : "等桶数"}`,
    trend: trend ?? createTrend(update?.history, oilTrendOptions, update?.status === "error"),
    comparison: update?.comparison,
  };
}

/** Each mounted panel owns its cache; quote changes never rebuild historical geometry. */
export function createOilSummaryReader() {
  let previousHistory: TrendHistory | undefined, previousTrend: MonitorTrend | undefined;
  return (update: OilSummaryUpdate) => {
    const history = update.history, error = update.status === "error";
    if (!previousTrend || history?.points !== previousHistory?.points) previousTrend = createTrend(history, oilTrendOptions, error);
    else {
      const status = history ? error ? "stale" : history.status : error ? "error" : "loading";
      const fetchedAt = history?.fetchedAt ?? null;
      if (status !== previousTrend.status || fetchedAt !== previousTrend.fetchedAt) previousTrend = { ...previousTrend, status, fetchedAt };
    }
    previousHistory = history;
    return oilSummary(update, previousTrend);
  };
}

const timestamps = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function summaryTimestamp(fetchedAt: string | null) {
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return null;
  return timestamps.format(new Date(fetchedAt));
}

export const summaryStatusLabels: Record<SummaryStatus, string> = {
  loading: "正在获取行情", live: "实时", snapshot: "备用快照", stale: "更新中断 · 保留数据", error: "行情暂不可用",
};

export function summaryExpired(summary: MonitorSummary, intervalMs: number, now: number) {
  const maxAgeMs = getQuoteStaleAfterMs({ collection: { maxAgeMs: summary.staleAfterMs } }, intervalMs + 15_000);
  return summary.status === "live" && summary.fetchedAt !== null && now - Date.parse(summary.fetchedAt) > maxAgeMs;
}

export const anthropicTrendOptions = { days: 7, intervalMs: 900_000, label: "7 天 · 15 分钟线", shortLabel: "7天", unit: "%" };
export type AnthropicSummaryUpdate = {
  status: SummaryStatus;
  /** Binance per-share premium over each comparison contract, in percent. */
  premiums: Partial<Record<AnthropicComparisonLeg, number | null>>;
  /** Comparison contract the trend follows. */
  trendLeg: string;
  fetchedAt: string | null;
  staleAfterMs?: number;
  history?: TrendHistory;
};

export function anthropicSummary(update?: AnthropicSummaryUpdate, trend?: MonitorTrend): MonitorSummary {
  return {
    status: update?.status ?? "loading",
    fetchedAt: update?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs({ collection: { maxAgeMs: update?.staleAfterMs } }, 35_000),
    metrics: ANTHROPIC_COMPARISON_LEGS.map(leg => metric(`溢价 · ${ANTHROPIC_LEGS[leg].name}`, update?.premiums[leg], 2, "%")),
    note: `Binance 每股价格相对 Hyperliquid / Lighter RH · 走势取 ${update?.trendLeg ?? ANTHROPIC_LEGS[ANTHROPIC_COMPARISON_LEGS[0]].name}`,
    trend: trend ?? createTrend(update?.history, anthropicTrendOptions, update?.status === "error"),
  };
}

/** Same caching as the oil reader: quote changes never rebuild the trend geometry. */
export function createAnthropicSummaryReader() {
  let previousHistory: TrendHistory | undefined, previousTrend: MonitorTrend | undefined;
  return (update: AnthropicSummaryUpdate) => {
    const history = update.history, error = update.status === "error";
    if (!previousTrend || history?.points !== previousHistory?.points) previousTrend = createTrend(history, anthropicTrendOptions, error);
    else {
      const status = history ? error ? "stale" : history.status : error ? "error" : "loading";
      const fetchedAt = history?.fetchedAt ?? null;
      if (status !== previousTrend.status || fetchedAt !== previousTrend.fetchedAt) previousTrend = { ...previousTrend, status, fetchedAt };
    }
    previousHistory = history;
    return anthropicSummary(update, previousTrend);
  };
}
