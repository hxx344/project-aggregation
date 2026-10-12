"use client";

import { Activity as ChartActivity, useEffect, useMemo, useState } from "react";
import { lazyComponent } from "../lib/lazy-component";
import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Clock3, Info, RefreshCw, MoveRight, BarChart3 } from "lucide-react";
import { ranges } from "../lib/chart-ranges";
import { dailyPoints, selectRange } from "../lib/market";
import { useMarketFeed } from "../hooks/use-market-feed";
import { hynixSummary, type SummaryProps } from "../lib/monitor-summary";
import { createTrend } from "../lib/monitor-trend";
import type { InitialMarketData } from "../lib/initial-market";

const EMPTY_POINTS: never[] = [];
const SpreadChart = lazyComponent(() => import("./spread-chart"), {
  clientOnly: true,
  loading: () => <section className="chart-panel"><div className="chart-container"><div className="empty-chart" role="status"><p>正在载入价差图表…</p></div></div></section>,
});
const HynixFundingPanel = lazyComponent(() => import("./hynix-funding-panel"), {
  clientOnly: true,
  loading: () => <section className="chart-panel hynix-funding-panel"><div className="chart-container"><div className="empty-chart" role="status"><p>正在载入多空资金费图表…</p></div></div></section>,
});
const money = (v: number | undefined) => v === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const percent = (v: number | undefined) => v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const signedMoney = (v: number | undefined) => v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v))}`;
const date = (t: number | string, full=false) => new Intl.DateTimeFormat("zh-CN", { timeZone:"UTC", month:"2-digit", day:"2-digit", ...(full ? {year:"numeric"} : {}) }).format(new Date(t));
const stamp = (t: number | string) => `${date(t,true)} ${new Date(t).toISOString().slice(11,16)} UTC`;

export default function Dashboard({ onSummary, active = true, summaryActive = active, initial = null }: SummaryProps & { active?: boolean; summaryActive?: boolean; initial?: InitialMarketData | null }) {
  const [hasOpened, setHasOpened] = useState(active);
  // Mount the heavy chart only on its first visit, then preserve its controls.
  if (active && !hasOpened) setHasOpened(true);
  // The overview card stays visible while another market's detail is selected.
  // Share its feed with the detail without activating hidden charts or funding history.
  const { data, quote, loading, error, quoteError, refresh } = useMarketFeed(initial?.hynix, initial?.renderedAt, active || summaryActive);
  const trend = useMemo(() => createTrend(data ? { points: data.points.map(point => ({ time: point.time, value: point.premium })), status: data.status, fetchedAt: data.fetchedAt } : undefined, { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" }, Boolean(error)), [data, error]);
  useEffect(() => { onSummary?.(hynixSummary(quote, quoteError, trend)); }, [onSummary, quote, quoteError, trend]);
  const [range,setRange] = useState<number | null>(null);
  const [details,setDetails] = useState(false);
  const points = useMemo(() => selectRange(data?.points ?? EMPTY_POINTS,range),[data?.points,range]);
  // Current metrics must never silently substitute an hourly close for a quote.
  const current = quote;
  const stats = useMemo(() => {
    if(!points.length) return null;
    const values = points.map(p=>p.premium);
    return { mean: values.reduce((a,b)=>a+b,0)/values.length, min: Math.min(...values), max:Math.max(...values) };
  },[points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(),[points]);
  const direction = !current || current.premium >= 0 ? "positive" : "negative";
  return <div className="site-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Hynix Spread 首页"><span className="brand-mark"><BarChart3 size={23}/></span><span>HYNIX<span className="brand-light"> / SPREAD</span></span></a><div className="top-meta"><span>跨市场观察</span><span className="vertical-rule"/><span className="source-dot"/>Hyperliquid</div></header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">SK HYNIX <span>/</span> 000660 · SKHY</div><h1>海力士 ADR 价差<span className="small-tag">上市以来</span></h1><p>正股与 ADR 同口径比较 · Hyperliquid 永续合约</p></div><div className="refresh-area"><button className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""}/>{loading ? "加载行情" : "刷新行情"}</button><span>每 10 秒自动刷新</span></div></div>
      <div className="data-status" role="status"><span className="status-left"><Clock3 size={14}/>{quote ? `${quoteError ? "实时更新中断 · 上次获取" : "实时报价 · 获取于"} ${date(quote.fetchedAt,true)} ${new Date(quote.fetchedAt).toISOString().slice(11,19)} UTC` : quoteError ? "实时报价暂不可用 · 每 10 秒自动重试" : "正在获取实时报价 · 每 10 秒自动刷新"}</span><span className="status-right">USD · 1 股正股 = 10 份 ADR</span></div>
      {quoteError && <div className="notice error" role="alert"><Info size={16}/>{quoteError}</div>}
      {error && <div className="notice error" role="alert"><Info size={16}/>历史行情：{error}{data ? " 当前保留上次成功加载的数据。" : ""}</div>}
      {data?.status === "snapshot" && <div className="notice"><Info size={16}/>历史行情接口暂不可用，图表展示 {stamp(data.fetchedAt)} 获取的真实行情快照。</div>}
      {data?.warnings.map(w=><div className="notice" key={w}><Info size={16}/>{w}</div>)}
      <section className="metrics" aria-label="最新价差概览">
        <article className="metric primary-metric"><div className="metric-label">当前 ADR 溢价率<Activity size={16}/></div><div className={`metric-value ${direction}`}>{percent(current?.premium)}</div><div className="metric-foot">每份价差 <b className={direction}>{signedMoney(current?.spread)}</b></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot adr"/>ADR 价格<span className="ticker">SKHY</span></div><div className="metric-value">{money(current?.adr)}</div><div className="metric-foot">1 份 ADR <span>· xyz:SKHY</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot ordinary"/>正股折算价格<span className="ticker">SKHX</span></div><div className="metric-value">{money(current?.equivalent)}</div><div className="metric-foot">正股 {money(current?.ordinary)} <span>÷ 10</span></div></article>
        <article className="metric"><div className="metric-label">区间平均溢价<span className="ticker">{ranges.find(r=>r.days===range)?.label}</span></div><div className="metric-value">{percent(stats?.mean)}</div><div className="metric-foot">{stats ? `${percent(stats.min)} 至 ${percent(stats.max)}` : "等待行情数据"}</div></article>
      </section>
      {hasOpened && <ChartActivity mode={active ? "visible" : "hidden"}><SpreadChart data={data?.points ?? EMPTY_POINTS} loading={loading} range={range} onRangeChange={setRange} /><HynixFundingPanel range={range} onRangeChange={setRange}/></ChartActivity>}
      <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同小时 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>ADR</th><th>正股 ÷ 10</th><th>每份价差</th><th>溢价率</th></tr></thead><tbody>{recent.map(p=><tr key={p.time}><td>{date(p.time,true)}<small>{new Date(p.time).toISOString().slice(11,16)}</small></td><td>{money(p.adr)}</td><td>{money(p.equivalent)}</td><td>{signedMoney(p.spread)}</td><td><span className={`premium-pill ${p.premium>=0 ? "positive" : "negative"}`}>{p.premium>=0 ? <ArrowUpRight size={13}/> : <ArrowDownRight size={13}/>}{percent(p.premium)}</span></td></tr>)}{!recent.length && <tr><td colSpan={5} className="empty-table">{loading ? "正在加载记录…" : "暂无记录"}</td></tr>}</tbody></table></div></section>
      <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17}/></span></div><div className="conversion"><div><span className="instrument-label">韩国正股</span><strong>1 <small>股</small></strong><span>000660 · KRX</span></div><MoveRight size={22}/><div><span className="instrument-label">美国 ADR</span><strong>10 <small>份</small></strong><span>SKHY · NASDAQ</span></div></div><div className="formula"><span>ADR 溢价率</span><code>(ADR ÷ (正股美元价 ÷ 10) − 1) × 100%</code></div><p className="method-note">正数表示 ADR 溢价，负数表示折价。两条行情均来自 Hyperliquid 永续合约；价差包含合约基差，并非交易所现货价差。</p><div className="listing-note"><span>ADR 首次交易</span><b>2026.07.10</b></div></aside></div>
      <section className="source-panel"><button className="source-toggle" aria-expanded={details} onClick={()=>setDetails(!details)}><span><Info size={16}/>数据来源与覆盖范围</span><ChevronDown size={17} className={details ? "rotated" : ""}/></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Hyperliquid HIP-3 / XYZ：xyz:SKHX（正股美元代理）与 xyz:SKHY（ADR 代理）。SKHX 已包含韩元兑美元换算。顶部实时报价每 10 秒刷新，使用 allMids 中间价（空盘口时为最近成交价），时间标注为成功获取时间。入口卡片的净资金费取自 metaAndAssetCtxs：空 10 份 SKHY、多 1 份 SKHX，以两腿预言机价格对应的总名义金额为分母，净小时费率 × 24 × 365 换算为简单年化；正数净收款，负数净付款。资金费与价格并行获取，资金费缺失时显示“—”。历史图每 60 秒检查更新，使用已结束的 1 小时 K 线收盘价，仅匹配双方都有报价的时段；不补齐缺失报价。图中时间为该小时起点。</p><a href="https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index" target="_blank" rel="noreferrer">XYZ 合约说明 <ArrowUpRight size={13}/></a><a className="second-source" href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">资金费计算口径 <ArrowUpRight size={13}/></a></div><div><h3>历史覆盖</h3><p>ADR 于 2026 年 7 月 10 日以 SKHYV 首次交易。小时图从当日 14:00 UTC 开始，排除上市前的合约交易。{data ? `当前共同可用行情始于 ${stamp(data.firstAvailable)}。取数时间：${stamp(data.fetchedAt)}。` : "正在检查历史覆盖范围。"} 接口保留最近 5,000 根小时线，已保存的历史与新行情合并展示。休市时永续合约仍可交易。</p><a href="https://depositaryreceipts.citi.com/adr/guides/pgm_dispabook.aspx?cusip=78392B206&pageId=15&subpageID=111" target="_blank" rel="noreferrer">Citi ADR 换算比例 <ArrowUpRight size={13}/></a><a className="second-source" href="https://news.skhynix.com/en/skhynix-lists-adrs-on-nasdaq/" target="_blank" rel="noreferrer">上市公告 <ArrowUpRight size={13}/></a></div></div>}</section>
      <footer><span>HYNIX / SPREAD<span className="footer-divider">·</span>同口径，看价差。</span><span>Hyperliquid 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
    </main>
  </div>;
}
