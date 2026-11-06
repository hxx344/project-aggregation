"use client";

import { Activity as ChartActivity, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from "lucide-react";
import { lazyComponent } from "../lib/lazy-component";
import { useHydrated } from "../lib/use-hydrated";
import { ranges } from "../lib/chart-ranges";
import { dailyPoints, selectRange } from "../lib/market";
import { useOilFeed } from "../hooks/use-oil-feed";
import { createOilSummaryReader, type SummaryProps, type SummaryStatus } from "../lib/monitor-summary";
import { getQuoteStaleAfterMs } from "../lib/market-freshness";
import { binanceOilExchangeQuote } from "../lib/exchange-quotes";
import { OIL_SPREAD_CHART } from "../lib/oil-chart-config";
import { coversOilRange, OIL_WARMUP_DAYS } from "../lib/oil-history";
import type { InitialMarketData } from "../lib/initial-market";
import { useHubFills } from "../lib/hub-fills";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { oilSpread } from "../modules/oil/spread.mjs";
import type { FundingBasis } from "./oil-funding-panel";

const EMPTY_POINTS: never[] = [];
const SpreadChart = lazyComponent(() => import("./spread-chart"), {
  clientOnly: true,
  loading: () => <section className="chart-panel"><div className="chart-container"><div className="empty-chart" role="status"><p>正在载入价差图表…</p></div></div></section>,
});
const OilFundingPanel = lazyComponent(() => import("./oil-funding-panel"), {
  clientOnly: true,
  loading: () => <section className="chart-panel hynix-funding-panel"><div className="chart-container"><div className="empty-chart" role="status"><p>正在载入多空资金费图表…</p></div></div></section>,
});
const usdt = (v: number | null | undefined) => v == null ? "—" : v.toFixed(3);
const signedUsdt = (v: number | null | undefined) => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(3)}`;
const date = (t: number | string, full = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit", ...(full ? { year: "numeric" } : {}) }).format(new Date(t));
const stamp = (t: number | string) => `${date(t, true)} ${new Date(t).toISOString().slice(11, 16)} UTC`;
const observation = (value: string) => value.length > 10 ? stamp(value) : value.replaceAll("-", ".");

export default function OilPanel({ onSummary, initial = null, active = true, selected = active, summaryActive = active, tradesActive = false, children }: SummaryProps & { initial?: InitialMarketData | null; active?: boolean; selected?: boolean; summaryActive?: boolean; tradesActive?: boolean; children?: ReactNode }) {
  // The server renders the selected panel as readable; an embedded client only becomes active after the host
  // replies. Hydrate the server's chart placeholders first, then follow the real activity.
  const shown = useHydrated() ? active : selected;
  const [hasOpened, setHasOpened] = useState(active);
  // Mount the heavy charts only on the first visit, then preserve their controls.
  if (active && !hasOpened) setHasOpened(true);
  const charts = hasOpened || shown;
  const [range, setRange] = useState<number | null>(7);
  // Read only the selected range plus indicator warmup; "全部" reads the complete history.
  const windowDays = range === null ? null : range + OIL_WARMUP_DAYS;
  const { data, quote, loading, error, errorWindow, quoteError, refresh } = useOilFeed(initial?.oil, active, summaryActive, windowDays);
  const initialTrend = initial?.oil?.trend ?? undefined;
  const [basis, setBasis] = useState<FundingBasis>("quantity");
  const [details, setDetails] = useState(false);
  const trades = useHubFills("oil", tradesActive);
  const readSummary = useMemo(() => createOilSummaryReader(), []);
  const trendPoints = useMemo(() => data?.points.map(point => ({ time: point.time, value: point.spread })), [data?.points]);
  const status: SummaryStatus = quote ? quote.status === "snapshot" || quoteError ? "stale" : "live" : quoteError ? "error" : "loading";
  useEffect(() => {
    onSummary?.(readSummary({
      status,
      spread: quote ? oilSpread(quote.brent.markPx, quote.wti.markPx) : null,
      fundingHourlyRate: quote ? calculateShortSpreadFunding(quote, basis).hourlyRate : null,
      fundingBasis: basis,
      fetchedAt: quote?.fetchedAt ?? null,
      staleAfterMs: getQuoteStaleAfterMs(quote, 75_000),
      comparison: quote ? binanceOilExchangeQuote(quote, status !== "live") : undefined,
      // Until the full candles arrive, keep the embedded overview trend and its real source time.
      history: data && trendPoints ? { points: trendPoints, status: error ? "stale" : data.status, fetchedAt: data.fetchedAt }
        : initialTrend ? { ...initialTrend, status: error ? "stale" : initialTrend.status } : undefined,
    }));
  }, [onSummary, readSummary, status, quote, basis, data, trendPoints, error, initialTrend]);
  // A window read for a shorter range never stands in for a wider one: it stays hidden while that range loads or after its read fails.
  const covered = data ? coversOilRange(data, range, OIL_WARMUP_DAYS) : false;
  const failed = Boolean(error) && errorWindow === windowDays;
  const chartPoints = data && covered ? data.points : EMPTY_POINTS;
  const points = useMemo(() => selectRange(chartPoints, range), [chartPoints, range]);
  const stats = useMemo(() => {
    if (!points.length) return null;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const { spread } of points) { sum += spread; min = Math.min(min, spread); max = Math.max(max, spread); }
    return { mean: sum / points.length, min, max };
  }, [points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(), [points]);
  // Current metrics always come from the live quote, never from the last candle close.
  const spread = quote ? oilSpread(quote.brent.markPx, quote.wti.markPx) : null;
  const direction = spread === null || spread >= 0 ? "positive" : "negative";
  const missing = data?.metadata.missingObservationRows ?? 0;
  // Candles are never embedded in the page, so before their first successful read an empty chart means pending, not absent.
  const historyPending = loading || !data || (!covered && !failed);
  return <div className="site-shell" data-monitor="oil">
    <header className="topbar"><a className="brand" href="/" aria-label="Oil Spread 首页"><span className="brand-mark"><BarChart3 size={23}/></span><span>OIL<span className="brand-light"> / SPREAD</span></span></a><div className="top-meta"><span>跨品种观察</span><span className="vertical-rule"/><span className="source-dot"/>Binance</div></header>
    <main>
      <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">BRENT / WTI <span>/</span> BZUSDT · CLUSDT</div><h1>原油价差<span className="small-tag">4 月 1 日以来</span></h1><p>布伦特 − WTI · Binance 永续合约 15 分钟 K 线</p></div><div className="refresh-area"><button className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""}/>{loading ? "加载行情" : "刷新行情"}</button><span>每 10 秒自动刷新</span></div></div>
      <div className="data-status" role="status"><span className="status-left"><Clock3 size={14}/>{quote ? `${quoteError ? "实时更新中断 · 上次获取" : "实时报价 · 获取于"} ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC` : quoteError ? "实时报价暂不可用 · 每 10 秒自动重试" : "正在获取实时报价 · 每 10 秒自动刷新"}</span><span className="status-right">USDT · 每桶标记价格</span></div>
      {quoteError && <div className="notice error" role="alert"><Info size={16}/>{quoteError}</div>}
      {error && <div className="notice error" role="alert"><Info size={16}/>历史更新中断：{error}{covered ? " 当前保留上次成功加载的数据。" : ""}</div>}
      {data?.status === "snapshot" && <div className="notice"><Info size={16}/>K 线接口暂不可用，图表展示 {stamp(data.fetchedAt)} 保存的真实行情快照。</div>}
      {missing > 0 && <div className="notice"><Info size={16}/>缺少 {missing.toLocaleString()} 根共同 15 分钟 K 线，缺口处曲线断开。</div>}
      <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新价差概览">
        <article className="metric primary-metric"><div className="metric-label">当前价差<Activity size={16}/></div><div className={`metric-value ${direction}`}>{signedUsdt(spread)}</div><div className="metric-foot">布伦特 − WTI <span>· USDT / 桶</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot adr"/>布伦特<span className="ticker">BZUSDT</span></div><div className="metric-value">{usdt(quote?.brent.markPx)}</div><div className="metric-foot">标记价格 <span>· USDT / 桶</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot ordinary"/>WTI<span className="ticker">CLUSDT</span></div><div className="metric-value">{usdt(quote?.wti.markPx)}</div><div className="metric-foot">标记价格 <span>· USDT / 桶</span></div></article>
        <article className="metric"><div className="metric-label">区间平均价差<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{signedUsdt(stats?.mean)}</div><div className="metric-foot">{stats ? `${signedUsdt(stats.min)} 至 ${signedUsdt(stats.max)} USDT / 桶` : "等待行情数据"}</div></article>
      </section>
      {charts && <ChartActivity mode={shown ? "visible" : "hidden"}><SpreadChart data={chartPoints} loading={historyPending} range={range} onRangeChange={setRange} trades={trades} config={OIL_SPREAD_CHART}/></ChartActivity>}
      <p className="chart-footnote"><Info size={13} aria-hidden="true"/>缺失时段曲线断开，不补 0 · 采样 15 分钟</p></div>
      {children}
      {charts && <ChartActivity mode={shown ? "visible" : "hidden"}><OilFundingPanel range={range} onRangeChange={setRange} quote={quote} basis={basis} onBasisChange={setBasis}/></ChartActivity>}
      <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同 15 分钟 K 线 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>布伦特</th><th>WTI</th><th>价差</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{usdt(p.adr)}</td><td>{usdt(p.equivalent)}</td><td><span className={`premium-pill ${p.spread >= 0 ? "positive" : "negative"}`}>{p.spread >= 0 ? <ArrowUpRight size={13}/> : <ArrowDownRight size={13}/>}{signedUsdt(p.spread)}</span></td></tr>)}{!recent.length && <tr><td colSpan={4} className="empty-table">{historyPending ? "正在加载记录…" : "暂无记录"}</td></tr>}</tbody></table></div></section>
      <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17}/></span></div><div className="conversion"><div><span className="instrument-label">布伦特原油</span><strong>1 <small>桶</small></strong><span>BZUSDT · Binance</span></div><MoveRight size={22}/><div><span className="instrument-label">WTI 原油</span><strong>1 <small>桶</small></strong><span>CLUSDT · Binance</span></div></div><div className="formula"><span>价差</span><code>布伦特 − WTI（USDT / 桶）</code></div><p className="method-note">正数表示布伦特较贵。做空价差对应空布伦特、多 WTI；等桶数配仓时，每桶价格损益等于价差变化，资金费另行计算。两条行情均为 USDT 计价的永续合约，价差包含合约基差。</p><div className="listing-note"><span>历史起点</span><b>2026.04.01</b></div></aside></div>
      <section className="source-panel"><button className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16}/>数据来源与覆盖范围</span><ChevronDown size={17} className={details ? "rotated" : ""}/></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续合约 BZUSDT（布伦特）与 CLUSDT（WTI），按 USDT/桶报价。顶部实时报价每 10 秒刷新，使用标记价格，时间标注为成功获取时间。入口卡片的净资金费按所选口径（默认等数量：空 1 桶布伦特、多 1 桶 WTI）以实时费率计算，净小时费率 × 8,760 换算为简单年化；正数净收款，负数净付款。历史图每 60 秒检查更新，使用两合约同一 UTC 时段已收盘的 15 分钟 K 线收盘价，仅匹配双方都有报价的时段；不补齐缺失报价。图中时间为该 K 线起点。</p><a href="https://www.binance.com/en/futures/BZUSDT" target="_blank" rel="noreferrer">BZUSDT <ArrowUpRight size={13}/></a><a className="second-source" href="https://www.binance.com/en/futures/CLUSDT" target="_blank" rel="noreferrer">CLUSDT <ArrowUpRight size={13}/></a><a className="second-source" href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">资金费规则 <ArrowUpRight size={13}/></a></div><div><h3>历史覆盖</h3><p>从 2026 年 4 月 1 日回补，后台持续保存并与新 K 线合并展示。{data ? `当前共同可用行情 ${observation(data.coverage.firstCommonObservation)} 至 ${observation(data.coverage.lastCommonObservation)}，共 ${data.coverage.pairedObservationRows.toLocaleString()} 根；取数时间：${stamp(data.fetchedAt)}。` : "正在检查历史覆盖范围。"} 合约换月按 Binance 展期规则处理。</p><a href="https://www.binance.com/en/support/faq/detail/0675298e133640f48aab7e3bb4ae1d38" target="_blank" rel="noreferrer">展期规则 <ArrowUpRight size={13}/></a><a className="second-source" href="https://www.binance.com/en/support/announcement/detail/e7a10ca855524655ab3dea73add40ef4" target="_blank" rel="noreferrer">合约规格 <ArrowUpRight size={13}/></a></div></div>}</section>
      <footer><span>OIL / SPREAD<span className="footer-divider">·</span>同口径，看价差。</span><span>Binance 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
    </main>
  </div>;
}
