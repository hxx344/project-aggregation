import type { SpreadChartConfig } from "../app/spread-chart";
import { oilTradeEvents, spreadTradeMarkers, type TradeEvent } from "./hynix-trades";
import type { Point } from "./market";

export const OIL_BAR_MS = 900_000;
const BARS_PER_DAY = 86_400_000 / OIL_BAR_MS;
const usdt = (v: number) => `${v.toFixed(3)} USDT`;

/** Brent (`adr`) against WTI (`equivalent`) on completed 15-minute Binance candles. */
export const OIL_SPREAD_CHART: SpreadChartConfig = {
  intervalMs: OIL_BAR_MS, periods: { sma: 7 * BARS_PER_DAY, bands: 20 * BARS_PER_DAY }, kicker: "SPREAD MONITOR", bar: "15 分钟",
  span: count => `${(count / 4).toLocaleString()} 小时`, bars: count => `${count.toLocaleString()} 根连续 15 分钟 K 线`, checkCadence: "每分钟检查更新",
  tabs: { premium: "百分比价差", spread: "绝对价差", price: "价格对比" }, units: { premium: "% · 布伦特相对 WTI", spread: "USDT / 桶", price: "USDT / 桶" },
  premiumName: "百分比价差", spreadName: "绝对价差", legs: ["布伦特", "WTI"], zeroLabel: "0 = 同价", domainStep: 1, digits: 3, price: usdt,
  tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `${Number(v.toFixed(2))}`, price: v => `${Number(v.toFixed(1))}` },
  tradeEvents: oilTradeEvents,
  tradeMarkers: (events: TradeEvent[], points: Point[]) => spreadTradeMarkers(events, points, { intervalMs: OIL_BAR_MS, rightPerUnit: 1, tradedBasis: "成交价差", chartBasis: "图表价差" }),
  trade: { priceUnit: "/桶", chartLabel: "图表同时刻价差", chartNote: "15 分钟 K 线收盘，未收盘 K 线为未知", metricName: "价差" },
  emptyText: { loading: "正在载入 15 分钟 K 线", hint: "Binance BZUSDT / CLUSDT 同一时段已收盘 K 线" },
};
