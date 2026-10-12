"use client";

import { memo, useMemo, useState } from "react";
import { Activity, Check, Info } from "lucide-react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { selectRange, type Point } from "../lib/market";
import { calculateIndicators, type IndicatorPoint, type SpreadMetric } from "../lib/indicators";
import { ranges } from "../lib/chart-ranges";

type Mode = SpreadMetric | "price";
type Toggles = { sma: boolean; bands: boolean; zscore: boolean };
const options = [
  { key: "sma", label: "7 日均线", color: "var(--warning)" },
  { key: "bands", label: "布林带 · 20 日", color: "var(--chart-5)" },
  { key: "zscore", label: "Z-score · 20 日", color: "var(--chart-2)" },
] as const;
const money = (v: number) => `$${v.toFixed(2)}`;
const metricValue = (v: number | null | undefined, mode: Mode) => v == null ? "—" : mode === "premium" ? `${v.toFixed(2)}%` : `${v < 0 ? "−" : ""}${money(Math.abs(v))}`;
const zValue = (v: number | null | undefined) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}σ`;
const date = (time: number, full = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit", ...(full ? { year: "numeric" } : {}) }).format(time);
const stamp = (time: number) => `${date(time,true)} ${new Date(time).toISOString().slice(11,16)} UTC`;

function IndicatorTooltip({ active, payload, mode, enabled, zOnly = false }: {
  active?: boolean;
  payload?: { payload: IndicatorPoint }[];
  mode: Mode;
  enabled: Toggles;
  zOnly?: boolean;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p || p.premium == null) return null;
  return <div className="chart-tooltip">
    <strong>{stamp(p.time)}</strong>
    {zOnly ? <>
      <div><span>Z-score · 20 日</span><b>{zValue(p.zscore)}</b></div>
      <div><span>20 日均值</span><b>{metricValue(p.basis,mode)}</b></div>
      <div><span>{mode === "premium" ? "ADR 溢价率" : "每份价差"}</span><b>{metricValue(p[mode === "spread" ? "spread" : "premium"],mode)}</b></div>
    </> : <>
      <div><span>ADR 溢价率</span><b className={p.premium >= 0 ? "positive" : "negative"}>{metricValue(p.premium,"premium")}</b></div>
      <div><span>ADR / 正股 ÷ 10</span><b>{money(p.adr)} / {money(p.equivalent)}</b></div>
      <div><span>每份价差</span><b>{metricValue(p.spread,"spread")}</b></div>
      {mode !== "price" && <div className="tooltip-indicators">
        {enabled.sma && <div><span>7 日均线</span><b>{metricValue(p.sma,mode)}</b></div>}
        {enabled.bands && <>
          <div><span>布林上轨</span><b>{metricValue(p.upper,mode)}</b></div>
          <div><span>20 日中轨</span><b>{metricValue(p.basis,mode)}</b></div>
          <div><span>布林下轨</span><b>{metricValue(p.lower,mode)}</b></div>
        </>}
        {enabled.zscore && <div><span>Z-score</span><b>{zValue(p.zscore)}</b></div>}
      </div>}
    </>}
  </div>;
}

function SpreadChart({ data, loading, range, onRangeChange }: {
  data: Point[];
  loading: boolean;
  range: number | null;
  onRangeChange: (range: number | null) => void;
}) {
  const [mode,setMode] = useState<Mode>("premium");
  const [enabled,setEnabled] = useState<Toggles>({ sma: true, bands: true, zscore: true });
  const metric: SpreadMetric = mode === "spread" ? "spread" : "premium";
  // Calculate on ALL history first so selecting one week retains the 20-day warmup.
  const fullHistory = useMemo(() => calculateIndicators(data,metric),[data,metric]);
  const points = useMemo(() => selectRange(fullHistory,range),[fullHistory,range]);
  const latest = points.at(-1);
  const chartPoints = useMemo(() => points.flatMap((p,i) => i && p.time-points[i-1].time > 3_600_000 ? [
    { time: points[i-1].time+3_600_000, adr: null, equivalent: null, spread: null, premium: null, sma: null, basis: null, upper: null, lower: null, band: null, zscore: null }, p,
  ] : [p]),[points]);
  const domain = useMemo(() => {
    const values = points.flatMap(p => [p[metric], ...(enabled.sma && p.sma !== null ? [p.sma] : []), ...(enabled.bands && p.band ? p.band : [])]);
    if (!values.length) return [0,5];
    return [Math.floor(Math.min(0,...values)/5)*5, Math.ceil(Math.max(0,...values)/5)*5 || 5];
  },[points,metric,enabled.sma,enabled.bands]);
  const zDomain = useMemo(() => {
    const values = points.flatMap(p => p.zscore === null ? [] : [p.zscore]);
    return [Math.min(-3,Math.floor(Math.min(0,...values))),Math.max(3,Math.ceil(Math.max(0,...values)))];
  },[points]);
  const zState = !latest || latest.zscore === null ? (latest?.deviation === 0 ? "窗口无波动" : "等待 480 个连续小时") : latest.zscore > 2 ? "高于 +2σ" : latest.zscore < -2 ? "低于 −2σ" : "位于 ±2σ 内";

  return <section className="chart-panel" aria-label="历史价差图表">
    <div className="chart-heading">
      <div><div className="section-kicker">PREMIUM MONITOR</div><h2>{mode === "price" ? "同口径价格走势" : "价差走势"}</h2><p className="history-timestamp">小时收盘图 · 每分钟检查更新{latest ? ` · 最近收盘 ${stamp(latest.time + 3_600_000)}` : ""}</p></div>
      <div className="segmented range-control" aria-label="时间范围">{ranges.map(r => <button key={r.label} aria-pressed={range === r.days} className={range === r.days ? "active" : ""} onClick={() => onRangeChange(r.days)}>{r.label}</button>)}</div>
    </div>
    <div className="chart-toolbar">
      <div className="chart-tabs" aria-label="图表指标">{([{id:"premium",label:"溢价率"},{id:"spread",label:"美元价差"},{id:"price",label:"价格对比"}] as const).map(tab => <button key={tab.id} aria-pressed={mode === tab.id} className={mode === tab.id ? "active" : ""} onClick={() => setMode(tab.id)}>{tab.label}</button>)}</div>
      <span className="chart-unit">{mode === "premium" ? "% · ADR 相对正股" : "USD / 份 ADR"}</span>
    </div>
    {mode !== "price" && <>
      <div className="indicator-controls" aria-label="技术指标开关">
        <span className="indicator-label">技术指标</span>
        {options.map(option => <button key={option.key} aria-pressed={enabled[option.key]} className={`indicator-toggle ${enabled[option.key] ? "selected" : ""}`} onClick={() => setEnabled(previous => ({...previous,[option.key]:!previous[option.key]}))}>
          <span className="indicator-check" style={{borderColor:enabled[option.key] ? option.color : undefined,color:option.color}}>{enabled[option.key] && <Check size={12}/>}</span>{option.label}
        </button>)}
        <span className="indicator-period">小时线 · 布林带 ±2σ</span>
      </div>
      <div className="indicator-readings" aria-label="最新小时技术指标">
        {enabled.sma && <div><span className="reading-label"><i className="sample-line sma-line"/>7 日均线</span><strong>{metricValue(latest?.sma,mode)}</strong><small>168 小时 · 平滑短期波动</small></div>}
        {enabled.bands && <div><span className="reading-label"><i className="sample-line band-line"/>20 日布林带</span><strong>{latest?.band ? `${metricValue(latest.lower,mode)} — ${metricValue(latest.upper,mode)}` : "—"}</strong><small>480 小时均值 ± 2 倍标准差</small></div>}
        {enabled.zscore && <div><span className="reading-label"><i className="sample-line z-line"/>20 日 Z-score</span><strong>{zValue(latest?.zscore)}<span className="z-state">{zState}</span></strong><small>与 20 日均值相差多少个标准差</small></div>}
      </div>
    </>}
    <div className="chart-container">
      {!points.length ? <div className="empty-chart"><Activity size={28}/><p>{loading ? "正在载入上市以来的历史行情" : "暂无可用行情"}</p><span>{loading ? "统一美元口径，对齐小时收盘时间" : "点击刷新行情重试"}</span></div> :
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:800,height:300}}>
          <ComposedChart data={chartPoints} syncId="hynix-spread-indicators" syncMethod="value" margin={{top:25,right:14,left:0,bottom:6}} accessibilityLayer>
            <defs><linearGradient id="premiumFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.21}/><stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01}/></linearGradient></defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/>
            <XAxis dataKey="time" type="number" domain={["dataMin","dataMax"]} tickFormatter={t => date(t)} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} minTickGap={65} tick={{fontSize:12}} dy={10}/>
            <YAxis orientation="right" width={68} domain={mode === "price" ? ["auto","auto"] : domain} tickFormatter={v => mode === "premium" ? `${v.toFixed(0)}%` : `$${v.toFixed(0)}`} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{fontSize:12}}/>
            <Tooltip content={<IndicatorTooltip mode={mode} enabled={enabled}/>} cursor={{stroke:"var(--muted-foreground)",strokeDasharray:"3 3"}}/>
            {mode === "price" ? <>
              <Line type="linear" dataKey="adr" stroke="var(--chart-2)" strokeWidth={2} dot={false} isAnimationActive={false}/>
              <Line type="linear" dataKey="equivalent" stroke="var(--warning)" strokeWidth={2} dot={false} isAnimationActive={false}/>
            </> : <>
              <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4"/>
              {enabled.bands && <>
                <Area type="linear" dataKey="band" fill="var(--chart-5)" fillOpacity={0.09} stroke="none" tooltipType="none" isAnimationActive={false}/>
                <Line type="linear" dataKey="upper" stroke="var(--chart-5)" strokeWidth={1} strokeDasharray="4 4" dot={false} activeDot={false} tooltipType="none" isAnimationActive={false}/>
                <Line type="linear" dataKey="lower" stroke="var(--chart-5)" strokeWidth={1} strokeDasharray="4 4" dot={false} activeDot={false} tooltipType="none" isAnimationActive={false}/>
                <Line type="linear" dataKey="basis" stroke="var(--chart-5)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 5" dot={false} activeDot={false} tooltipType="none" isAnimationActive={false}/>
              </>}
              <Area type="linear" dataKey={metric} stroke="var(--primary)" strokeWidth={2} fill="url(#premiumFill)" isAnimationActive={false}/>
              {enabled.sma && <Line type="linear" dataKey="sma" stroke="var(--warning)" strokeWidth={1.8} dot={false} activeDot={false} tooltipType="none" isAnimationActive={false}/>}
            </>}
          </ComposedChart>
        </ResponsiveContainer>}
    </div>
    <div className="chart-caption"><span>{mode === "price" ? <><i className="legend-dot adr"/>ADR <i className="legend-dot ordinary"/>正股 ÷ 10</> : <><i className="legend-dot premium"/>ADR {mode === "premium" ? "溢价率" : "每份美元价差"}<span className="zero-line"/>0 = 平价</>}</span><span>{points.length ? `${date(points[0].time,true)} — ${date(points.at(-1)!.time,true)} · ${points.length.toLocaleString()} 个小时` : "小时收盘 · UTC"}</span></div>
    {mode !== "price" && enabled.zscore && <div className="zscore-panel" aria-label="Z-score 历史走势">
      <div className="zscore-heading"><h3><span className="sample-line z-line"/>Z-score <span>20 日</span></h3><span>0 = 近期均值 · 虚线 = ±2σ</span></div>
      <div className="zscore-chart">
        {points.some(p => p.zscore !== null) ? <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:800,height:160}}>
          <ComposedChart data={chartPoints} syncId="hynix-spread-indicators" syncMethod="value" margin={{top:12,right:14,left:0,bottom:6}} accessibilityLayer>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/>
            <XAxis dataKey="time" type="number" domain={["dataMin","dataMax"]} tickFormatter={t => date(t)} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} minTickGap={65} tick={{fontSize:12}}/>
            <YAxis orientation="right" width={68} domain={zDomain} tickFormatter={v => `${v}σ`} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{fontSize:12}}/>
            <ReferenceArea y1={-2} y2={2} fill="var(--chart-2)" fillOpacity={0.035}/>
            <ReferenceLine y={0} stroke="var(--muted-foreground)"/>
            <ReferenceLine y={2} stroke="var(--warning)" strokeDasharray="4 4"/>
            <ReferenceLine y={-2} stroke="var(--warning)" strokeDasharray="4 4"/>
            <Tooltip content={<IndicatorTooltip mode={mode} enabled={enabled} zOnly/>} cursor={{stroke:"var(--muted-foreground)",strokeDasharray:"3 3"}}/>
            <Line type="linear" dataKey="zscore" stroke="var(--chart-2)" strokeWidth={1.7} dot={false} isAnimationActive={false}/>
          </ComposedChart>
        </ResponsiveContainer> : <div className="indicator-empty">{latest?.deviation === 0 ? "窗口内价差无波动，Z-score 无法定义。" : "累计 480 个连续小时后显示 Z-score。"}</div>}
      </div>
    </div>}
    {mode !== "price" && <details className="indicator-help"><summary><Info size={14}/>指标怎么看</summary><div>
      <p><b>7 日均线</b>平滑最近 168 个小时的价差。<b>布林带</b>以 480 小时均值为中轨，上下轨为均值 ± 2 倍总体标准差；带宽反映这段时间的波动幅度。</p>
      <p><b>Z-score =（当前价差 − 480 小时均值）÷ 标准差。</b>正值表示高于近期均值，负值表示低于近期均值；±2σ 是偏离参考线，不代表价差必然回归。</p>
      <p>7 / 20 日均为自然日小时窗口，包含当前已完成小时。先使用完整历史计算，再按所选时间范围显示；窗口不足或跨数据缺口时留空，零波动时 Z-score 留空。切换溢价率或美元价差时，所有指标同步换算口径。</p>
      <a href="https://www.bollingerbands.com/bollinger-band-rules" target="_blank" rel="noreferrer">布林带官方说明 ↗</a><a href="https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/standard.htm" target="_blank" rel="noreferrer">NIST 标准化定义 ↗</a>
    </div></details>}
  </section>;
}

export default memo(SpreadChart);
