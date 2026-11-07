import type { Point } from "./market.ts";
import type { SpreadChartConfig } from "../app/spread-chart";
import { ANTHROPIC_CANDLE_MS, ANTHROPIC_LEGS, ANTHROPIC_LEG_KEYS, anthropicChartRows, validateAnthropicCandles, validateAnthropicQuote } from "../modules/anthropic/market.mjs";
import type { QuoteFreshness } from "./market-freshness.ts";
import { anthropicTradeEvents, anthropicTradeMarkers } from "./anthropic-trades.ts";

/** Contracts compared against Binance. */
export type AnthropicComparisonLeg = "xyz" | "io" | "rh";
type Snapshot = ReturnType<typeof validateAnthropicCandles>;
export type AnthropicRow = Snapshot["data"][number];
type Coverage = Pick<Snapshot["metadata"], "firstObservation" | "lastObservation" | "rows">;
export type AnthropicQuote = ReturnType<typeof validateAnthropicQuote> & QuoteFreshness & { status?: "live" | "snapshot" };
/** A windowed read keeps only its last `windowDays` days in `rows`; `coverage` is always the complete history's range. */
export type AnthropicHistory = { rows: AnthropicRow[]; status: "live" | "snapshot"; fetchedAt: string; windowDays: number | null; coverage: Coverage; errors: Snapshot["metadata"]["errors"] };

/** Widest indicator window (Bollinger bands and Z-score), and the warmup read before a selected range. */
export const ANTHROPIC_BANDS_DAYS = 20;
export const ANTHROPIC_WARMUP_DAYS = ANTHROPIC_BANDS_DAYS + 1;

export function anthropicHistory(input: unknown): AnthropicHistory {
  const snapshot = validateAnthropicCandles(input), raw = input as { windowDays?: unknown; coverage?: Partial<Coverage> };
  const windowDays = raw.windowDays === undefined ? null : Number.isSafeInteger(raw.windowDays) && (raw.windowDays as number) > 0 ? raw.windowDays as number : NaN;
  if (Number.isNaN(windowDays)) throw new Error("Invalid Anthropic candle window");
  const { firstObservation, lastObservation, rows } = snapshot.metadata;
  let coverage: Coverage = { firstObservation, lastObservation, rows };
  if (windowDays !== null) {
    const value = raw.coverage ?? {};
    if (typeof value.firstObservation !== "string" || value.lastObservation !== lastObservation || !(Date.parse(value.firstObservation) <= Date.parse(firstObservation))
      || !Number.isSafeInteger(value.rows) || value.rows! < rows) throw new Error("Invalid Anthropic candle coverage");
    coverage = { firstObservation: value.firstObservation, lastObservation, rows: value.rows! };
  }
  return { rows: snapshot.data, status: snapshot.status === "snapshot" ? "snapshot" : "live", fetchedAt: snapshot.metadata.fetchedAt, windowDays, coverage, errors: snapshot.metadata.errors };
}

export const coversAnthropicRange = (history: AnthropicHistory, range: number | null) =>
  history.windowDays === null || (range !== null && history.windowDays >= range + ANTHROPIC_WARMUP_DAYS);

/** Keep the previous rows when a refresh returns the same closes, so charts skip rebuilding. */
export function retainAnthropicHistory(previous: AnthropicHistory | null, next: AnthropicHistory): AnthropicHistory {
  if (!previous) return next;
  if (Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt)) return previous;
  const same = previous.rows.length === next.rows.length && next.rows.every((row, index) => {
    const old = previous.rows[index];
    return row.time === old.time && ANTHROPIC_LEG_KEYS.every(key => row[key] === old[key]);
  });
  return same ? { ...next, rows: previous.rows } : next;
}

/** Binance (`adr`) against one comparison leg (`equivalent`), both per share. */
export const anthropicPoints = (rows: AnthropicRow[], leg: AnthropicComparisonLeg): Point[] => anthropicChartRows(rows, leg);

const BARS_PER_DAY = 86_400_000 / ANTHROPIC_CANDLE_MS;
const usd = (v: number) => `$${v.toFixed(2)}`;
/** Per-share premium chart of Binance against the selected comparison contract. */
export function anthropicChartConfig(leg: AnthropicComparisonLeg): SpreadChartConfig {
  const { name, label } = ANTHROPIC_LEGS[leg];
  return {
    intervalMs: ANTHROPIC_CANDLE_MS, periods: { sma: 7 * BARS_PER_DAY, bands: ANTHROPIC_BANDS_DAYS * BARS_PER_DAY }, kicker: "PREMIUM MONITOR", bar: "15 分钟",
    span: count => `${(count / 4).toLocaleString()} 小时`, bars: count => `${count.toLocaleString()} 根连续 15 分钟 K 线`, checkCadence: "每分钟检查更新",
    tabs: { premium: "溢价率", spread: "每股价差", price: "每股价格" }, units: { premium: `% · Binance 相对 ${name}`, spread: "USD / 股", price: "USD / 股" },
    premiumName: "Binance 溢价率", spreadName: "每股价差", legs: ["Binance", name], zeroLabel: "0 = 同价", domainStep: 1, digits: 2, price: usd,
    tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `$${Number(v.toFixed(2))}`, price: v => `$${Number(v.toFixed(1))}` },
    tradeEvents: items => anthropicTradeEvents(items, leg), tradeMarkers: (events, points) => anthropicTradeMarkers(events, points, leg), tradeMarket: "anthropic",
    trade: { priceUnit: "", chartLabel: "图表同 15 分钟溢价率", chartNote: "已收盘 K 线，非双腿成交价差", metricName: "溢价率",
      sources: "CEX 来源为资产账本；Hyperliquid、Lighter RH 来源为当前实盘连接账户，手动成交同样读取",
      note: `图上标记 ${name} 的真实成交，以及按账户和订单编号核实属于本组合的 Binance、OKX 成交。关联未知的成交仅保留明细，不代表没有组合下单。纵坐标取同一根已收盘 15 分钟 K 线，不代表双腿成交价差；缺失或未收盘时仅列出成交。` },
    emptyText: { loading: "正在载入 15 分钟 K 线", hint: `Binance ANTHROPICUSDT / ${label} 同一时段已收盘 K 线` },
  };
}
