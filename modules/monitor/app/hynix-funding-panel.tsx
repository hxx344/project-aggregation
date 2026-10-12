"use client";

import { memo, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ranges } from "../lib/chart-ranges";
import { analyzeHynixFunding, type FundingChartPoint } from "../lib/hynix-funding-analysis";
import { FUNDING_HOUR, type SettledFundingRow } from "../lib/hynix-funding-history";
import { useFundingHistory } from "../hooks/use-funding-history";

const emptyRows: SettledFundingRow[] = [];
const modes = [{ id: "rate", label: "小时费率", short: "shortRate", long: "longRate" }, { id: "cumulative", label: "累计资金费", short: "shortCumulative", long: "longCumulative" }, { id: "annualized", label: "累计年化", short: "shortAnnualized", long: "longAnnualized" }] as const;
type Mode = typeof modes[number]["id"];
const percent = (value: number | null, digits = 2) => value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(digits)}%`;
const stamp = (value: number | string | null) => value === null ? "尚无记录" : `${new Date(value).toISOString().replace("T", " ").slice(0, 16)} UTC`;
const shortDate = (value: number) => new Date(value).toISOString().slice(5, 10).replace("-", "/");
function FundingTooltip({ active, payload }: { active?: boolean; payload?: { payload: FundingChartPoint }[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return <div className="chart-tooltip funding-tooltip"><strong>{stamp(point.time)} · 结算</strong>
    {point.shortRate === null ? <p>该小时缺少共同结算数据</p> : <>
      <div><span>做空 · 小时费率</span><b>{percent(point.shortRate, 5)}</b></div><div><span>做多 · 小时费率</span><b>{percent(point.longRate, 5)}</b></div>
      <div><span>做空 / 做多累计</span><b>{percent(point.shortCumulative, 4)} / {percent(point.longCumulative, 4)}</b></div>
      <div><span>做空 / 做多年化</span><b>{percent(point.shortAnnualized)} / {percent(point.longAnnualized)}</b></div>
      <p>从所选区间起点累计 · {point.count} 个有效小时</p>
    </>}
  </div>;
}

function HynixFundingPanel({ range, onRangeChange }: { range: number | null; onRangeChange: (range: number | null) => void }) {
  const { data, error, loading, refresh } = useFundingHistory();
  const [mode, setMode] = useState<Mode>("rate");
  const [details, setDetails] = useState(false);
  const rows = data?.rows ?? emptyRows;
  // Allow settlement blocks one minute to arrive; include an already received newer hour.
  const end = data ? Math.max(rows.at(-1)!.time, Math.floor((Date.parse(data.metadata.fetchedAt) - 60_000) / FUNDING_HOUR) * FUNDING_HOUR) : undefined;
  const summary = useMemo(() => analyzeHynixFunding(rows, range, end), [rows, range, end]);
  const selectedMode = modes.find(item => item.id === mode)!;
  const unit = mode === "rate" ? "% / 小时" : mode === "annualized" ? "% / 年 · 简单年化" : "% · 区间累计";
  const stale = Boolean(error) || data?.status === "snapshot";
  const readings = [{ key: "short", name: "做空价差", position: "空 ADR、多正股", annualized: summary.shortAnnualized, cumulative: summary.shortCumulative }, { key: "long", name: "做多价差", position: "多 ADR、空正股", annualized: summary.longAnnualized, cumulative: summary.longCumulative }];
  const status = error || data?.error || (data?.status === "snapshot" ? "历史资金费使用备用快照。" : "");
  return <section className="chart-panel hynix-funding-panel" aria-label="海力士历史多空资金费">
    <div className="chart-heading"><div><div className="section-kicker">SETTLED FUNDING</div><h2>多空价差资金费</h2><p className="history-timestamp">已结算小时费率 · 两腿等名义金额</p></div><div className="segmented range-control" aria-label="资金费时间范围">{ranges.map(item => <button type="button" key={item.label} aria-pressed={range === item.days} className={range === item.days ? "active" : ""} onClick={() => onRangeChange(item.days)}>{item.label}</button>)}</div></div>
    <div className="funding-return-readings" aria-label="区间累计资金费与年化">{readings.map(item => <article key={item.key}><div className="funding-return-label"><span><i className={`funding-sample ${item.key}`}/>{item.name}</span><small>{item.position}</small></div><span className="funding-return-caption">区间累计年化</span><strong className={item.annualized === null ? "" : item.annualized >= 0 ? "positive" : "negative"}>{percent(item.annualized)}</strong><p>区间累计资金费 <b>{percent(item.cumulative, 4)}</b></p></article>)}</div>
    <div className="chart-toolbar"><div className="chart-tabs" aria-label="资金费图表指标">{modes.map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}>{item.label}</button>)}</div><span className="chart-unit">{unit}</span></div>
    <div className="funding-chart-key"><span><i className="funding-sample short"/>做空价差</span><span><i className="funding-sample long"/>做多价差</span><small>正值收款 · 负值付款</small><span className="funding-mobile-unit">{unit}</span></div>
    <div className="chart-container funding-curve" aria-label={`${selectedMode.label}曲线`}>
      {!summary.count ? <div className="empty-chart" role="status"><p>{loading ? "正在载入历史结算费率…" : "所选区间没有共同结算数据"}</p><span>{error || "仅计算双方都有费率的结算小时"}</span></div> : <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 800, height: 280 }}><LineChart data={summary.chart} margin={{ top: 15, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="time" type="number" domain={[summary.firstTime! - (summary.expectedHours === 1 ? FUNDING_HOUR / 2 : 0), summary.lastTime! + (summary.expectedHours === 1 ? FUNDING_HOUR / 2 : 0)]} tickFormatter={shortDate} minTickGap={65} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{ fontSize: 12 }}/>
        <YAxis orientation="right" width={76} tickFormatter={value => `${Number((value * 100).toPrecision(3))}%`} domain={[(min: number) => Math.min(-0.00001, min), (max: number) => Math.max(0.00001, max)]} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{ fontSize: 12 }}/>
        <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4"/><Tooltip content={<FundingTooltip/>} cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3" }} wrapperStyle={{ maxWidth: "100%" }}/>
        <Line dataKey={selectedMode.short} name="做空价差" type="linear" stroke="var(--positive)" strokeWidth={1.8} dot={summary.missingHours ? { r: 1.5 } : summary.count === 1} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false}/><Line dataKey={selectedMode.long} name="做多价差" type="linear" stroke="var(--chart-2)" strokeDasharray="5 3" strokeWidth={1.8} dot={summary.missingHours ? { r: 1.5 } : summary.count === 1} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false}/>
      </LineChart></ResponsiveContainer>}
    </div>
    <div className="funding-coverage"><span>{!data ? "正在检查数据覆盖范围…" : <>{summary.count.toLocaleString()} / {summary.expectedHours.toLocaleString()} 个共同结算小时{summary.missingHours > 0 ? ` · 缺少 ${summary.missingHours} 小时，累计仅含已覆盖数据` : " · 覆盖完整"}</>}</span><span>{stamp(summary.firstTime)} — {stamp(summary.lastTime)}</span></div>
    <div className="funding-history-status"><p className={stale ? "funding-stale" : ""} role="status">{status || (data ? "历史费率已同步" : "正在连接历史资金费接口…")}{data && <span> · 获取于 {stamp(data.metadata.fetchedAt)}</span>}</p><button type="button" className="refresh-button" disabled={loading} onClick={refresh}><RefreshCw size={14} className={loading ? "spinning" : ""}/>{loading ? "更新中" : "刷新资金费"}</button></div>
    <p className="funding-method">区间累计年化 = 净小时费率之和 ÷ 有效小时数 × 8,760，不复利。历史图按两腿等名义计算；顶部卡片按固定 10 份 ADR 对 1 股正股计算当前预估年化。</p>
    <button type="button" className="funding-method-toggle" aria-expanded={details} aria-controls="hynix-funding-method" onClick={() => setDetails(!details)}>计算口径与数据来源</button>
    {details && <div id="hynix-funding-method" className="funding-method-detail"><p>做空净小时率 = (SKHY 费率 − SKHX 费率) ÷ 2；做多取相反数。分母是双腿总名义金额，每小时按等名义权重计算。累计曲线从所选区间重新求和，累计年化曲线使用截至各时点的有效小时数。只统计资金费，不含价差盈亏。</p><p>从 2026-07-10 15:00 UTC 的结算开始，与价差图首个完整价格小时结束时间对应。缺少任一腿或整个小时均保留断点，不补零；缺失时的累计值只代表已覆盖部分。历史数据每 5 分钟检查更新。</p><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 资金费规则 ↗</a><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals" target="_blank" rel="noreferrer">历史结算费率接口 ↗</a></div>}
  </section>;
}

export default memo(HynixFundingPanel);
