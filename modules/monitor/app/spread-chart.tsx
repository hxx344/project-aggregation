"use client";

import { memo, useId, useMemo, useState } from "react";
import { Activity, Check, Info } from "lucide-react";
import { SvgPlot, createHoverStore, type PlotLayer } from "./svg-plot";
import { fixedAxis, niceAxis } from "../lib/svg-plot";
import { selectRange, type Point } from "../lib/market";
import { sampleChartPoints } from "../lib/chart-sampling";
import { calculateIndicators, type IndicatorPoint, type SpreadMetric } from "../lib/indicators";
import { ranges } from "../lib/chart-ranges";
import { hynixTradeEvents, hynixTradeMarkers, type SpreadTradeMarker, type TradeEvent } from "../lib/hynix-trades";
import type { HubFillsView } from "../lib/hub-fills";
import { TRADE_TYPES } from "../modules/oil/trades.mjs";
import { fillsStatusText, tradeDetailLines } from "../modules/oil/trade-markers.mjs";

type Mode = SpreadMetric | "price";
type Toggles = { sma: boolean; bands: boolean; zscore: boolean };
/**
 * One spread market on the shared chart: leg A (`adr`) against leg B (`equivalent`),
 * `premium` = (A ÷ B − 1) × 100 and `spread` = A − B, sampled every `intervalMs`.
 */
export type SpreadChartConfig = {
  intervalMs: number;
  /** Indicator windows in bars: 7 days and 20 days of `intervalMs`. */
  periods: { sma: number; bands: number };
  kicker: string;
  /** "小时" or "15 分钟": names one bar. */
  bar: string;
  /** Reads a bar count, e.g. "168 小时". */
  span: (count: number) => string;
  /** Reads a consecutive bar count, e.g. "480 个连续小时". */
  bars: (count: number) => string;
  checkCadence: string;
  tabs: Record<Mode, string>;
  units: Record<Mode, string>;
  premiumName: string;
  spreadName: string;
  legs: readonly [string, string];
  zeroLabel: string;
  /** Premium/spread axes include zero and round outward to this step. */
  domainStep: number;
  digits: number;
  price: (value: number) => string;
  tick: Record<Mode, (value: number) => string>;
  tradeEvents: (items: HubFillsView["items"]) => TradeEvent[];
  tradeMarkers: (events: TradeEvent[], points: Point[]) => SpreadTradeMarker[];
  trade: { priceUnit: string; chartLabel: string; chartNote: string; metricName: string };
  emptyText: { loading: string; hint: string };
};
const hynixMoney = (v: number) => `$${v.toFixed(2)}`;
export const HYNIX_SPREAD_CHART: SpreadChartConfig = {
  intervalMs: 3_600_000, periods: { sma: 7 * 24, bands: 20 * 24 }, kicker: "PREMIUM MONITOR", bar: "小时", span: count => `${count.toLocaleString()} 小时`, bars: count => `${count.toLocaleString()} 个连续小时`, checkCadence: "每分钟检查更新",
  tabs: { premium: "溢价率", spread: "美元价差", price: "价格对比" }, units: { premium: "% · ADR 相对正股", spread: "USD / 份 ADR", price: "USD / 份 ADR" },
  premiumName: "ADR 溢价率", spreadName: "每份价差", legs: ["ADR", "正股 ÷ 10"], zeroLabel: "0 = 平价", domainStep: 5, digits: 2, price: hynixMoney,
  tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `$${Number(v.toFixed(2))}`, price: v => `$${Number(v.toFixed(2))}` },
  tradeEvents: hynixTradeEvents, tradeMarkers: hynixTradeMarkers,
  trade: { priceUnit: "", chartLabel: "图表同小时溢价率", chartNote: "小时收盘，未收盘小时为未知", metricName: "溢价率" },
  emptyText: { loading: "正在载入上市以来的历史行情", hint: "统一美元口径，对齐小时收盘时间" },
};
const options = [
  { key: "sma", label: "7 日均线", color: "var(--warning)" },
  { key: "bands", label: "布林带 · 20 日", color: "var(--chart-5)" },
  { key: "zscore", label: "Z-score · 20 日", color: "var(--chart-2)" },
] as const;
const metricValue = (v: number | null | undefined, mode: Mode, config: SpreadChartConfig) => v == null ? "—" : mode === "premium" ? `${v.toFixed(config.digits)}%` : `${v < 0 ? "−" : ""}${config.price(Math.abs(v))}`;
const zValue = (v: number | null | undefined) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}σ`;
const date = (time: number, full = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit", ...(full ? { year: "numeric" } : {}) }).format(time);
const stamp = (time: number) => `${date(time,true)} ${new Date(time).toISOString().slice(11,16)} UTC`;
const beijingFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const beijing = (time: number | string) => beijingFormatter.format(new Date(time));
const premiumText = (v: number | null) => v === null ? "未知" : `${v.toFixed(3)}%`;
const tradeDetails = (marker: SpreadTradeMarker, config: SpreadChartConfig) => tradeDetailLines(marker, beijing, config.trade).join("\n");
type TradeType = keyof typeof TRADE_TYPES;
const zLayers: PlotLayer[] = [{ kind: "line", key: "zscore", color: "var(--chart-2)", width: 1.7, active: true }];
const zZones = [{ from: -2, to: 2, fill: "var(--chart-2)", opacity: 0.035 }];
const zeroLine = [{ y: 0, color: "var(--muted-foreground)", dash: "4 4" }];
const premiumFill = <linearGradient id="premiumFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.21}/><stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01}/></linearGradient>;
const zReferences = [{ y: 0, color: "var(--muted-foreground)" }, { y: 2, color: "var(--warning)", dash: "4 4" }, { y: -2, color: "var(--warning)", dash: "4 4" }];

/** Drawn at the marker's chart value; labels stay React text, never markup. */
function TradeMark({ cx, cy, marker, selected, onSelect }: { cx?: number | null; cy?: number | null; marker: SpreadTradeMarker; selected: boolean; onSelect: (key: string) => void }) {
  if (cx == null || cy == null || !Number.isFinite(cx) || !Number.isFinite(cy)) return <g/>;
  const type = TRADE_TYPES[marker.event.type as TradeType], select = () => onSelect(marker.event.key);
  return <g className="trade-marker" data-trade-type={marker.event.type} data-selected={selected || undefined} transform={`translate(${cx},${cy})`} tabIndex={0} role="button"
    aria-label={`${type.label} · ${beijing(marker.event.time)} 北京时间 · ${marker.basis} ${premiumText(marker.value)}，查看成交明细`}
    onClick={select} onMouseEnter={select} onFocus={select} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }}>
    <circle r={12} fill="transparent"/>
    <text textAnchor="middle" dy=".35em" aria-hidden="true">{type.symbol}</text>
  </g>;
}

function TradePanel({ trades, markers, selected, onSelect, chartMarkers, config }: { trades: HubFillsView; markers: SpreadTradeMarker[]; selected: SpreadTradeMarker | null; onSelect: (key: string) => void; chartMarkers: boolean; config: SpreadChartConfig }) {
  const titleId = useId();
  return <section className="trade-panel" aria-labelledby={titleId}>
    <h3 id={titleId}>套利成交</h3>
    <p className="trade-status" role="status">{fillsStatusText(trades, beijing)}</p>
    <p className="trade-legend">{(Object.keys(TRADE_TYPES) as TradeType[]).map(key => <span key={key} data-trade-type={key}>{TRADE_TYPES[key].symbol} {key === "trade" ? "成交（开平未知）" : TRADE_TYPES[key].label}</span>)}<span className="trade-legend-note">{chartMarkers ? "颜色只区分类型，不表示盈亏" : `切换到${config.tabs.premium}或${config.tabs.spread}可在图上查看标记`}</span></p>
    <div className="trade-list" aria-label="当前区间套利成交">
      {!markers.length && <p>{trades.status === "ok" && !trades.pending && !trades.incomplete ? "当前图表区间暂无套利成交" : "当前图表区间暂无可展示成交"}</p>}
      {[...markers].reverse().map(marker => { const type = TRADE_TYPES[marker.event.type as TradeType]; return <button type="button" key={marker.event.key} className="trade-list-item" data-trade-type={marker.event.type} aria-pressed={selected?.event.key === marker.event.key} onClick={() => onSelect(marker.event.key)}>
        {`${type.symbol} ${beijing(marker.event.time)} · ${type.label} · ${marker.event.fills.length} 笔 · ${marker.basis} ${premiumText(marker.value)}`}
      </button>; })}
    </div>
    {selected && <div className="trade-details" tabIndex={0} aria-label="套利成交明细">{tradeDetails(selected, config)}</div>}
  </section>;
}

/** Gap rows carry null prices and show no tooltip. */
function indicatorTooltip(p: IndicatorPoint, mode: Mode, enabled: Toggles, config: SpreadChartConfig, zOnly = false) {
  if (p.premium == null) return null;
  const value = (v: number | null | undefined, as: Mode = mode) => metricValue(v, as, config);
  return <div className="chart-tooltip">
    <strong>{stamp(p.time)}</strong>
    {zOnly ? <>
      <div><span>Z-score · 20 日</span><b>{zValue(p.zscore)}</b></div>
      <div><span>20 日均值</span><b>{value(p.basis)}</b></div>
      <div><span>{mode === "premium" ? config.premiumName : config.spreadName}</span><b>{value(p[mode === "spread" ? "spread" : "premium"])}</b></div>
    </> : <>
      <div><span>{config.premiumName}</span><b className={p.premium >= 0 ? "positive" : "negative"}>{value(p.premium,"premium")}</b></div>
      <div><span>{config.legs.join(" / ")}</span><b>{config.price(p.adr)} / {config.price(p.equivalent)}</b></div>
      <div><span>{config.spreadName}</span><b>{value(p.spread,"spread")}</b></div>
      {mode !== "price" && <div className="tooltip-indicators">
        {enabled.sma && <div><span>7 日均线</span><b>{value(p.sma)}</b></div>}
        {enabled.bands && <>
          <div><span>布林上轨</span><b>{value(p.upper)}</b></div>
          <div><span>20 日中轨</span><b>{value(p.basis)}</b></div>
          <div><span>布林下轨</span><b>{value(p.lower)}</b></div>
        </>}
        {enabled.zscore && <div><span>Z-score</span><b>{zValue(p.zscore)}</b></div>}
      </div>}
    </>}
  </div>;
}

function SpreadChart({ data, loading, range, onRangeChange, trades, config = HYNIX_SPREAD_CHART }: {
  data: Point[];
  loading: boolean;
  range: number | null;
  onRangeChange: (range: number | null) => void;
  trades?: HubFillsView;
  config?: SpreadChartConfig;
}) {
  const { intervalMs, periods } = config;
  const [mode,setMode] = useState<Mode>("premium");
  const [enabled,setEnabled] = useState<Toggles>({ sma: true, bands: true, zscore: true });
  const metric: SpreadMetric = mode === "spread" ? "spread" : "premium";
  // Calculate on ALL history first so selecting one week retains the 20-day warmup.
  const fullHistory = useMemo(() => calculateIndicators(data,metric,periods,intervalMs),[data,metric,periods,intervalMs]);
  const points = useMemo(() => selectRange(fullHistory,range),[fullHistory,range]);
  const latest = points.at(-1);
  const tradeItems = trades?.items;
  const { tradeEvents, tradeMarkers } = config;
  const events = useMemo(() => tradeItems ? tradeEvents(tradeItems) : [],[tradeItems,tradeEvents]);
  const markers = useMemo(() => tradeMarkers(events,points),[events,points,tradeMarkers]);
  const [selectedKey,setSelectedKey] = useState<string | null>(null);
  const selected = markers.find(marker => marker.event.key === selectedKey) ?? null;
  // Fill premiums use trade prices, so the price chart has no matching axis.
  const plotted = useMemo(() => mode === "price" ? [] : markers.flatMap(marker => { const y = mode === "premium" ? marker.value : marker.usd; return y !== null && Number.isFinite(y) ? [{ marker, y }] : []; }),[markers,mode]);
  const lastTradeTime = plotted.reduce((max,item) => Math.max(max,item.marker.event.time),-Infinity);
  const chartPoints = useMemo(() => points.flatMap((p,i) => i && p.time-points[i-1].time > intervalMs ? [
    { time: points[i-1].time+intervalMs, adr: null, equivalent: null, spread: null, premium: null, sma: null, basis: null, upper: null, lower: null, band: null, zscore: null }, p,
  ] : [p]),[points,intervalMs]);
  // Long ranges plot bucket extrema only; readings, stats and trade markers keep every hour.
  const sampled = useMemo(() => sampleChartPoints(chartPoints, mode === "price" ? ["adr","equivalent"] : [
    metric, ...(enabled.sma ? ["sma"] as const : []), ...(enabled.bands ? ["basis","upper","lower"] as const : []), ...(enabled.zscore ? ["zscore"] as const : []),
  ]),[chartPoints,mode,metric,enabled]);
  const step = config.domainStep;
  const domain = useMemo((): [number,number] => {
    let low = 0, high = 0, any = false;
    const add = (value: number) => { if (Number.isFinite(value)) { any = true; low = Math.min(low,value); high = Math.max(high,value); } };
    for (const p of points) { add(p[metric]); if (enabled.sma && p.sma !== null) add(p.sma); if (enabled.bands && p.band) { add(p.band[0]); add(p.band[1]); } }
    for (const item of plotted) add(item.y);
    if (!any) return [0,step];
    return [Math.floor(low/step)*step, Math.ceil(high/step)*step || step];
  },[points,metric,enabled.sma,enabled.bands,plotted,step]);
  const zDomain = useMemo(() => {
    let low = 0, high = 0;
    for (const p of points) if (p.zscore !== null) { low = Math.min(low,p.zscore); high = Math.max(high,p.zscore); }
    return [Math.min(-3,Math.floor(low)),Math.max(3,Math.ceil(high))] as const;
  },[points]);
  const priceDomain = useMemo(() => {
    let low = Infinity, high = -Infinity;
    for (const p of points) for (const value of [p.adr,p.equivalent]) if (Number.isFinite(value)) { low = Math.min(low,value); high = Math.max(high,value); }
    return [low,high] as const;
  },[points]);
  // Premium/spread and z keep their explicit domains; only the price axis widens to round ticks.
  const mainAxis = useMemo(() => mode === "price" ? niceAxis(priceDomain[0],priceDomain[1]) : fixedAxis(domain[0],domain[1]),[mode,priceDomain,domain]);
  const zAxis = useMemo(() => fixedAxis(zDomain[0],zDomain[1]),[zDomain]);
  // Fills in the still-open hour extend both synced charts past the last closed bar.
  const xRange = useMemo(() => points.length ? [points[0].time,Math.max(points.at(-1)!.time,lastTradeTime)] as const : [0,1] as const,[points,lastTradeTime]);
  const layers = useMemo((): PlotLayer[] => mode === "price" ? [
    { kind: "line", key: "adr", color: "var(--chart-2)", width: 2, active: true },
    { kind: "line", key: "equivalent", color: "var(--warning)", width: 2, active: true },
  ] : [
    ...(enabled.bands ? [
      { kind: "area", key: "upper", lower: "lower", fill: "var(--chart-5)", opacity: 0.09 },
      { kind: "line", key: "upper", color: "var(--chart-5)", width: 1, dash: "4 4" },
      { kind: "line", key: "lower", color: "var(--chart-5)", width: 1, dash: "4 4" },
      { kind: "line", key: "basis", color: "var(--chart-5)", width: 1, dash: "2 5", opacity: 0.6 },
    ] as const : []),
    { kind: "area", key: metric, lower: 0, fill: "url(#premiumFill)" },
    { kind: "line", key: metric, color: "var(--primary)", width: 2, active: true },
    ...(enabled.sma ? [{ kind: "line", key: "sma", color: "var(--warning)", width: 1.8 }] as const : []),
  ],[mode,metric,enabled.bands,enabled.sma]);
  const [hover] = useState(createHoverStore);
  const zState = !latest || latest.zscore === null ? (latest?.deviation === 0 ? "窗口无波动" : `等待 ${config.bars(periods.bands)}`) : latest.zscore > 2 ? "高于 +2σ" : latest.zscore < -2 ? "低于 −2σ" : "位于 ±2σ 内";

  const metricName = mode === "premium" ? config.premiumName : config.spreadName;
  return <section className="chart-panel" aria-label="历史价差图表">
    <div className="chart-heading">
      <div><div className="section-kicker">{config.kicker}</div><h2>{mode === "price" ? "同口径价格走势" : "价差走势"}</h2><p className="history-timestamp">{config.bar}收盘图 · {config.checkCadence}{latest ? ` · 最近收盘 ${stamp(latest.time + intervalMs)}` : ""}</p></div>
      <div className="segmented range-control" aria-label="时间范围">{ranges.map(r => <button key={r.label} aria-pressed={range === r.days} className={range === r.days ? "active" : ""} onClick={() => onRangeChange(r.days)}>{r.label}</button>)}</div>
    </div>
    <div className="chart-toolbar">
      <div className="chart-tabs" aria-label="图表指标">{(["premium","spread","price"] as const).map(id => <button key={id} aria-pressed={mode === id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{config.tabs[id]}</button>)}</div>
      <span className="chart-unit">{config.units[mode]}</span>
    </div>
    {mode !== "price" && <>
      <div className="indicator-controls" aria-label="技术指标开关">
        <span className="indicator-label">技术指标</span>
        {options.map(option => <button key={option.key} aria-pressed={enabled[option.key]} className={`indicator-toggle ${enabled[option.key] ? "selected" : ""}`} onClick={() => setEnabled(previous => ({...previous,[option.key]:!previous[option.key]}))}>
          <span className="indicator-check" style={{borderColor:enabled[option.key] ? option.color : undefined,color:option.color}}>{enabled[option.key] && <Check size={12}/>}</span>{option.label}
        </button>)}
        <span className="indicator-period">{config.bar}线 · 布林带 ±2σ</span>
      </div>
      <div className="indicator-readings" aria-label={`最新${config.bar}技术指标`}>
        {enabled.sma && <div><span className="reading-label"><i className="sample-line sma-line"/>7 日均线</span><strong>{metricValue(latest?.sma,mode,config)}</strong><small>{config.span(periods.sma)} · 平滑短期波动</small></div>}
        {enabled.bands && <div><span className="reading-label"><i className="sample-line band-line"/>20 日布林带</span><strong>{latest?.band ? `${metricValue(latest.lower,mode,config)} — ${metricValue(latest.upper,mode,config)}` : "—"}</strong><small>{config.span(periods.bands)}均值 ± 2 倍标准差</small></div>}
        {enabled.zscore && <div><span className="reading-label"><i className="sample-line z-line"/>20 日 Z-score</span><strong>{zValue(latest?.zscore)}<span className="z-state">{zState}</span></strong><small>与 20 日均值相差多少个标准差</small></div>}
      </div>
    </>}
    <div className="chart-container">
      {!points.length ? <div className="empty-chart"><Activity size={28}/><p>{loading ? config.emptyText.loading : "暂无可用行情"}</p><span>{loading ? config.emptyText.hint : "点击刷新行情重试"}</span></div> :
        <SvgPlot rows={sampled} hoverRows={chartPoints} xDomain={xRange} yDomain={mainAxis.domain} yTicks={mainAxis.ticks} yTick={config.tick[mode]}
          layers={layers} references={mode === "price" ? [] : zeroLine} margin={{top:25,right:82,bottom:36}} height={300} hover={hover}
          label={mode === "price" ? `${config.legs.join(" 与 ")} ${config.bar}收盘价格走势` : `${metricName}${config.bar}走势`}
          defs={premiumFill}
          tooltip={row => indicatorTooltip(row as IndicatorPoint,mode,enabled,config)}
          overlay={({ x, y }) => plotted.map(({ marker, y: value }) => <TradeMark key={marker.event.key} cx={x(marker.event.time)} cy={y(value)} marker={marker} selected={selectedKey === marker.event.key} onSelect={setSelectedKey}/>)}/>}
    </div>
    <div className="chart-caption"><span>{mode === "price" ? <><i className="legend-dot adr"/>{config.legs[0]} <i className="legend-dot ordinary"/>{config.legs[1]}</> : <><i className="legend-dot premium"/>{metricName}<span className="zero-line"/>{config.zeroLabel}</>}</span><span>{points.length ? `${date(points[0].time,true)} — ${date(points.at(-1)!.time,true)} · ${config.span(points.length)}${sampled.length < chartPoints.length ? ` · 绘图保留极值与缺口共 ${sampled.length.toLocaleString()} 点，读数与统计使用全部记录` : ""}` : `${config.bar}收盘 · UTC`}</span></div>
    {trades && <TradePanel trades={trades} markers={markers} selected={selected} onSelect={setSelectedKey} chartMarkers={mode !== "price"} config={config}/>}
    {mode !== "price" && enabled.zscore && <div className="zscore-panel" aria-label="Z-score 历史走势">
      <div className="zscore-heading"><h3><span className="sample-line z-line"/>Z-score <span>20 日</span></h3><span>0 = 近期均值 · 虚线 = ±2σ</span></div>
      <div className="zscore-chart">
        {points.some(p => p.zscore !== null) ? <SvgPlot rows={sampled} hoverRows={chartPoints} xDomain={xRange} yDomain={zAxis.domain} yTicks={zAxis.ticks} yTick={v => `${v}σ`}
          layers={zLayers} zones={zZones} references={zReferences} margin={{top:12,right:82,bottom:36}} height={160} hover={hover} label={`20 日 Z-score ${config.bar}走势`}
          tooltip={row => indicatorTooltip(row as IndicatorPoint,mode,enabled,config,true)}/> : <div className="indicator-empty">{latest?.deviation === 0 ? "窗口内价差无波动，Z-score 无法定义。" : `累计 ${config.bars(periods.bands)}后显示 Z-score。`}</div>}
      </div>
    </div>}
    {mode !== "price" && <details className="indicator-help"><summary><Info size={14}/>指标怎么看</summary><div>
      <p><b>7 日均线</b>平滑最近 {config.span(periods.sma)}的价差。<b>布林带</b>以 {config.span(periods.bands)}均值为中轨，上下轨为均值 ± 2 倍总体标准差；带宽反映这段时间的波动幅度。</p>
      <p><b>Z-score =（当前价差 − {config.span(periods.bands)}均值）÷ 标准差。</b>正值表示高于近期均值，负值表示低于近期均值；±2σ 是偏离参考线，不代表价差必然回归。</p>
      <p>7 / 20 日均为自然日{config.bar}窗口，包含当前已收盘的{config.bar}线。先使用完整历史计算，再按所选时间范围显示；窗口不足或跨数据缺口时留空，零波动时 Z-score 留空。切换{config.tabs.premium}或{config.tabs.spread}时，所有指标同步换算口径。</p>
      <a href="https://www.bollingerbands.com/bollinger-band-rules" target="_blank" rel="noreferrer">布林带官方说明 ↗</a><a href="https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/standard.htm" target="_blank" rel="noreferrer">NIST 标准化定义 ↗</a>
    </div></details>}
  </section>;
}

export default memo(SpreadChart);
