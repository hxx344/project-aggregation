import type { LiveQuote } from "./market";
import { createTrend, type MonitorTrend, type TrendHistory } from "./monitor-trend.ts";
import { hynixExchangeQuote, type ExchangeQuote } from "./exchange-quotes.ts";
import { goldOilChartPoints, GOLD_OIL_INTERVAL_MS, GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, goldOilUnits, type GoldOilExchange, type GoldOilType, type GoldOilQuote, type GoldOilHistory } from './gold-oil.ts';
import { currentGoldOilFunding } from './gold-oil-funding.ts';
import { getQuoteStaleAfterMs } from './market-freshness.ts';

export type SummaryStatus = "loading" | "live" | "snapshot" | "stale" | "error";
export type SummaryMetric = { label: string; value: string; tone?: "positive" | "negative" };
export type MonitorSummary = { status: SummaryStatus; fetchedAt: string | null; staleAfterMs?: number; metrics: SummaryMetric[]; note?: string; trend?: MonitorTrend; comparison?: ExchangeQuote };
export type SummaryProps = { onSummary?: (summary: MonitorSummary) => void };
export function goldOilTrend(history: GoldOilHistory | null = null, error = false, oilType: GoldOilType = history?.oilType ?? 'cl', exchange: GoldOilExchange = history?.source === 'Bybit' ? 'bybit' : 'binance'): MonitorTrend {
  return createTrend(history ? { fetchedAt: history.fetchedAt, status: history.status,
    points: goldOilChartPoints(history, 7).flatMap(point => point.ratio === null ? [] : [{ time: point.time, value: point.ratio }]),
  } : undefined, { days: 7, intervalMs: GOLD_OIL_INTERVAL_MS, label: '7 天 · 15 分钟线', shortLabel: '7天', unit: goldOilUnits(oilType, exchange).ratio }, error);
}
export function goldOilSummary(quote: GoldOilQuote | null, error = false, trend?: MonitorTrend, oilType: GoldOilType = quote?.oilType ?? 'cl', exchange: GoldOilExchange = quote?.source === 'Bybit' ? 'bybit' : 'binance'): MonitorSummary {
  const funding = currentGoldOilFunding(quote);
  return { status: quote ? error ? 'stale' : quote.status === 'snapshot' ? 'snapshot' : 'live' : error ? 'error' : 'loading',
    fetchedAt: quote?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs(quote, 75_000),
    metrics: [{ label: `金油比 · ${goldOilUnits(oilType, exchange).ratio}`, value: quote ? quote.ratio.toFixed(3) : '—' }, metric('净资金费 / 年化', funding ? funding.annualized * 100 : null, 2, '%')],
    note: `${GOLD_OIL_EXCHANGES[exchange].name} · 空黄金、多${GOLD_OIL_INSTRUMENTS[oilType].name} · 等 USDT 名义`, trend: trend ?? goldOilTrend(null, false, oilType, exchange) };
}
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

export function hynixSummary(quote: LiveQuote | null, error = "", trend?: MonitorTrend): MonitorSummary {
  const funding = quote?.funding;
  return {
    status: quote ? error ? "stale" : quote.status === "snapshot" ? "snapshot" : "live" : error ? "error" : "loading",
    fetchedAt: funding && quote && Date.parse(funding.fetchedAt) < Date.parse(quote.fetchedAt) ? funding.fetchedAt : quote?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs(quote, 35_000),
    metrics: [metric("ADR 溢价率", quote?.premium, 2, "%"), metric("净资金费 / 年化", funding?.annualizedRate == null ? null : funding.annualizedRate * 100, 2, "%")],
    note: `空 10 份 ADR、多 1 股正股${quote && !funding ? " · 资金费暂不可用" : ""}`,
    trend: trend ?? createTrend(undefined, { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" }),
    comparison: quote ? hynixExchangeQuote(quote, Boolean(error)) : undefined,
  };
}

const oilTrendOptions = { days: 7, intervalMs: 900_000, label: "7 天 · 15 分钟线", shortLabel: "7天", unit: "%" };

export function oilSummary(update?: OilSummaryUpdate, trend?: MonitorTrend): MonitorSummary {
  return {
    status: update?.status ?? "loading",
    fetchedAt: update?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs({ collection: { maxAgeMs: update?.staleAfterMs } }, 75_000),
    metrics: [
      metric("价差 · 相对 WTI", update?.spread, 3, "%"),
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
