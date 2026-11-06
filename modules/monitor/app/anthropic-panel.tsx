"use client";

import { Activity as ChartActivity, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from "lucide-react";
import { lazyComponent } from "../lib/lazy-component";
import { useHydrated } from "../lib/use-hydrated";
import { ranges } from "../lib/chart-ranges";
import { dailyPoints, selectRange } from "../lib/market";
import { useAnthropicFeed } from "../hooks/use-anthropic-feed";
import { createAnthropicSummaryReader, type SummaryProps, type SummaryStatus } from "../lib/monitor-summary";
import { getQuoteStaleAfterMs } from "../lib/market-freshness";
import { anthropicChartConfig, anthropicPoints, coversAnthropicRange, ANTHROPIC_WARMUP_DAYS, type HyperliquidLeg } from "../lib/anthropic-history";
import { ANTHROPIC_LEGS, ANTHROPIC_SHARES, HYPERLIQUID_LEGS, anthropicPremium, perShare } from "../modules/anthropic/market.mjs";

const EMPTY_POINTS: never[] = [];
const SpreadChart = lazyComponent(() => import("./spread-chart"), {
  clientOnly: true,
  loading: () => <section className="chart-panel"><div className="chart-container"><div className="empty-chart" role="status"><p>正在载入价差图表…</p></div></div></section>,
});
const usd = (v: number | null | undefined) => v == null ? "—" : `$${v.toFixed(2)}`;
const native = (v: number | null | undefined) => v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 3 });
const signed = (v: number | null | undefined, suffix = "%") => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}${suffix}`;
const fundingText = (v: number | null | undefined) => v == null ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v * 100).toFixed(4)}%`;
const date = (t: number | string, full = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit", ...(full ? { year: "numeric" } : {}) }).format(new Date(t));
const stamp = (t: number | string) => `${date(t, true)} ${new Date(t).toISOString().slice(11, 16)} UTC`;
const legNames = { binance: "Binance", xyz: "xyz:ANT", io: "io:ANTH" } as const;

export default function AnthropicPanel({ onSummary, active = true, selected = active, summaryActive = active, children }: SummaryProps & { active?: boolean; selected?: boolean; summaryActive?: boolean; children?: ReactNode }) {
  const shown = useHydrated() ? active : selected;
  const [hasOpened, setHasOpened] = useState(active);
  if (active && !hasOpened) setHasOpened(true);
  const charts = hasOpened || shown;
  const [range, setRange] = useState<number | null>(7);
  const [leg, setLeg] = useState<HyperliquidLeg>("xyz");
  const [details, setDetails] = useState(false);
  const windowDays = range === null ? null : range + ANTHROPIC_WARMUP_DAYS;
  const { data, quote, loading, error, errorWindow, quoteError, refresh } = useAnthropicFeed(active, summaryActive, windowDays);
  const config = useMemo(() => anthropicChartConfig(leg), [leg]);
  const readSummary = useMemo(() => createAnthropicSummaryReader(), []);
  const allPoints = useMemo(() => data ? anthropicPoints(data.rows, leg) : EMPTY_POINTS, [data, leg]);
  const trendPoints = useMemo(() => allPoints.map(point => ({ time: point.time, value: point.premium })), [allPoints]);
  const status: SummaryStatus = quote ? quote.status === "snapshot" || quoteError ? "stale" : "live" : quoteError ? "error" : "loading";
  const binance = quote?.binance ?? null, other = quote?.[leg] ?? null;
  const premiumXyz = anthropicPremium(binance?.markPx, quote?.xyz?.markPx, "xyz"), premiumIo = anthropicPremium(binance?.markPx, quote?.io?.markPx, "io");
  const premium = leg === "xyz" ? premiumXyz : premiumIo;
  useEffect(() => {
    onSummary?.(readSummary({
      status, premiumXyz, premiumIo, trendLeg: legNames[leg],
      fetchedAt: quote?.fetchedAt ?? null, staleAfterMs: getQuoteStaleAfterMs(quote, 35_000),
      history: data && trendPoints.length ? { points: trendPoints, status: error ? "stale" : data.status, fetchedAt: data.fetchedAt } : undefined,
    }));
  }, [onSummary, readSummary, status, premiumXyz, premiumIo, quote, leg, data, trendPoints, error]);
  const covered = data ? coversAnthropicRange(data, range) : false;
  const failed = Boolean(error) && errorWindow === windowDays;
  const chartPoints = covered ? allPoints : EMPTY_POINTS;
  const points = useMemo(() => selectRange(chartPoints, range), [chartPoints, range]);
  const stats = useMemo(() => {
    if (!points.length) return null;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const { premium: value } of points) { sum += value; min = Math.min(min, value); max = Math.max(max, value); }
    return { mean: sum / points.length, min, max };
  }, [points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(), [points]);
  const direction = premium === null || premium >= 0 ? "positive" : "negative";
  const legErrors = quote ? Object.entries(quote.errors).map(([key, message]) => `${legNames[key as keyof typeof legNames]}：${message}`) : [];
  const historyPending = loading || !data || (!covered && !failed);
  const symbol = ANTHROPIC_LEGS[leg].symbol;
  return <div className="site-shell" data-monitor="anthropic">
    <header className="topbar"><a className="brand" href="/" aria-label="Anthropic Spread 首页"><span className="brand-mark"><BarChart3 size={23}/></span><span>ANTHROPIC<span className="brand-light"> / SPREAD</span></span></a><div className="top-meta"><span>盘前股权</span><span className="vertical-rule"/><span className="source-dot"/>Binance · Hyperliquid</div></header>
    <main>
      <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">ANTHROPIC <span>/</span> ANTHROPICUSDT · {symbol}</div><h1>Anthropic 价差<span className="small-tag">每股口径</span></h1><p>Binance 相对 Hyperliquid 的每股溢价 · 15 分钟 K 线</p></div><div className="refresh-area"><div className="segmented" aria-label="对比的 Hyperliquid 合约">{HYPERLIQUID_LEGS.map(key => <button type="button" key={key} aria-pressed={leg === key} className={leg === key ? "active" : ""} onClick={() => setLeg(key)}>{ANTHROPIC_LEGS[key].symbol}</button>)}</div><button className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""}/>{loading ? "加载行情" : "刷新行情"}</button><span>每 10 秒自动刷新</span></div></div>
      <div className="data-status" role="status"><span className="status-left"><Clock3 size={14}/>{quote ? `${quoteError ? "实时更新中断 · 上次获取" : "实时报价 · 获取于"} ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC` : quoteError ? "实时报价暂不可用 · 每 10 秒自动重试" : "正在获取实时报价 · 每 10 秒自动刷新"}</span><span className="status-right">USD · 每股标记价格</span></div>
      {quoteError && <div className="notice error" role="alert"><Info size={16}/>{quoteError}</div>}
      {legErrors.length > 0 && <div className="notice error" role="alert"><Info size={16}/>部分行情缺失：{legErrors.join("；")}。缺失一侧时不计算溢价。</div>}
      {error && <div className="notice error" role="alert"><Info size={16}/>历史更新中断：{error}{covered ? " 当前保留上次成功加载的数据。" : ""}</div>}
      {data?.status === "snapshot" && <div className="notice"><Info size={16}/>K 线采集暂停，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
      <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新溢价概览">
        <article className="metric primary-metric"><div className="metric-label">当前溢价<Activity size={16}/></div><div className={`metric-value ${direction}`}>{signed(premium)}</div><div className="metric-foot">Binance ÷ {symbol} − 1 <span>· 每股</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot adr"/>Binance<span className="ticker">ANTHROPICUSDT</span></div><div className="metric-value">{usd(binance ? perShare("binance", binance.markPx) : null)}</div><div className="metric-foot">标记价 {native(binance?.markPx)} USDT ÷ {ANTHROPIC_SHARES.outstanding} <span>· 资金费 {fundingText(binance?.fundingRate)} / 期</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot ordinary"/>Hyperliquid<span className="ticker">{symbol}</span></div><div className="metric-value">{usd(other ? perShare(leg, other.markPx) : null)}</div><div className="metric-foot">标记价 {native(other?.markPx)}{ANTHROPIC_LEGS[leg].sharesPerUnit === 1 ? "" : ` ÷ ${ANTHROPIC_LEGS[leg].sharesPerUnit}`} <span>· 资金费 {fundingText(other?.fundingRate)} / 小时</span></div></article>
        <article className="metric"><div className="metric-label">区间平均溢价<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{signed(stats?.mean)}</div><div className="metric-foot">{stats ? `${signed(stats.min)} 至 ${signed(stats.max)}` : "等待行情数据"}</div></article>
      </section>
      {charts && <ChartActivity mode={shown ? "visible" : "hidden"}><SpreadChart key={leg} data={chartPoints} loading={historyPending} range={range} onRangeChange={setRange} config={config}/></ChartActivity>}
      <p className="chart-footnote"><Info size={13} aria-hidden="true"/>缺失时段曲线断开，不补 0 · 采样 15 分钟 · 每股价格依赖股数假设</p></div>
      {children}
      <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同 15 分钟 K 线 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>Binance / 股</th><th>{symbol} / 股</th><th>溢价</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{usd(p.adr)}</td><td>{usd(p.equivalent)}</td><td><span className={`premium-pill ${p.premium >= 0 ? "positive" : "negative"}`}>{p.premium >= 0 ? <ArrowUpRight size={13}/> : <ArrowDownRight size={13}/>}{signed(p.premium)}</span></td></tr>)}{!recent.length && <tr><td colSpan={4} className="empty-table">{historyPending ? "正在加载记录…" : "暂无记录"}</td></tr>}</tbody></table></div></section>
      <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17}/></span></div><div className="conversion"><div><span className="instrument-label">Binance</span><strong>{ANTHROPIC_SHARES.outstanding} <small>股 / 单位</small></strong><span>ANTHROPICUSDT · {ANTHROPIC_LEGS.binance.basis}</span></div><MoveRight size={22}/><div><span className="instrument-label">Hyperliquid</span><strong>{ANTHROPIC_LEGS[leg].sharesPerUnit} <small>股 / 单位</small></strong><span>{symbol} · {ANTHROPIC_LEGS[leg].basis}</span></div></div><div className="formula"><span>溢价</span><code>Binance 每股 ÷ {symbol} 每股 − 1</code></div><p className="method-note">两所合约按不同口径报价：Binance 以每 10 亿流通股估值报价，io:ANTH 以每 10 亿完全稀释股估值报价，xyz:ANT 为每股价格。本页按套利交易页默认股数（流通 127 亿、完全稀释 167 亿）换算为每股价格；股数假设变化会整体平移溢价，换算基于估算，收敛不保证。正数表示 Binance 较贵。Binance 以 USDT、Hyperliquid 以 USDC 等稳定币结算，未做稳定币汇率调整。</p><div className="listing-note"><span>历史起点</span><b>{data ? date(data.coverage.firstObservation, true) : "—"}</b></div></aside></div>
      <section className="source-panel"><button className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16}/>数据来源与覆盖范围</span><ChevronDown size={17} className={details ? "rotated" : ""}/></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续合约 ANTHROPICUSDT 与 Hyperliquid 的 xyz:ANT（trade.xyz）、io:ANTH（Entropy）。顶部实时报价每 10 秒刷新，使用标记价格，时间标注为成功获取时间；某一所读取失败时保留另一所报价并标明缺失原因。Binance 资金费为当期费率，Hyperliquid 为每小时费率。历史图每 60 秒检查更新，使用同一 UTC 时段已收盘的 15 分钟 K 线收盘价，只匹配双方都有报价的时段，不补齐缺失报价；图中时间为该 K 线起点。</p><a href="https://www.binance.com/en/futures/ANTHROPICUSDT" target="_blank" rel="noreferrer">ANTHROPICUSDT <ArrowUpRight size={13}/></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/xyz:ANT" target="_blank" rel="noreferrer">xyz:ANT <ArrowUpRight size={13}/></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/io:ANTH" target="_blank" rel="noreferrer">io:ANTH <ArrowUpRight size={13}/></a></div><div><h3>历史覆盖</h3><p>Hyperliquid 只提供最近约 5000 根 15 分钟 K 线，首次采集从 50 天前开始，之后后台持续保存并与新 K 线合并，最多保留 400 天。{data ? `当前已保存 ${stamp(data.coverage.firstObservation)} 至 ${stamp(data.coverage.lastObservation)}，共 ${data.coverage.rows.toLocaleString()} 个时段；取数时间：${stamp(data.fetchedAt)}。` : "正在检查历史覆盖范围。"}</p></div></div>}</section>
      <footer><span>ANTHROPIC / SPREAD<span className="footer-divider">·</span>同口径，看溢价。</span><span>Binance · Hyperliquid 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
    </main>
  </div>;
}
