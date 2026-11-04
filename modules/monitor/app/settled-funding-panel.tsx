"use client";

import { memo, useId, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { SvgPlot, type PlotLayer } from "./svg-plot";
import { niceAxis, plotValue } from "../lib/svg-plot";
import { ranges } from "../lib/chart-ranges";
import { sampleChartPoints } from "../lib/chart-sampling";
import { analyzeSettledFunding, type FundingChartPoint } from "../lib/hynix-funding-analysis";
import type { SettledFundingRow } from "../lib/hynix-funding-history";

const emptyRows: SettledFundingRow[] = [];
const modes = [{ id: "rate", label: "小时费率", short: "shortRate", long: "longRate" }, { id: "cumulative", label: "累计资金费", short: "shortCumulative", long: "longCumulative" }, { id: "annualized", label: "累计年化", short: "shortAnnualized", long: "longAnnualized" }] as const;
type Mode = typeof modes[number]["id"];
const percent = (value: number | null, digits = 2) => value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(digits)}%`;
const stamp = (value: number | string | null) => value === null ? "尚无记录" : `${new Date(value).toISOString().replace("T", " ").slice(0, 16)} UTC`;
const fundingTick = (value: number) => `${Number((value * 100).toPrecision(3))}%`;
const zeroLine = [{ y: 0, color: "var(--muted-foreground)", dash: "4 4" }];
/** Settled funding of one two-leg market. Rows hold per-settlement rates of leg A (`adr`) and leg B (`ordinary`). */
export type SettledFundingFeed = { rows: readonly SettledFundingRow[] | null; fetchedAt: string | null; snapshot: boolean; error: string; /** Payload-level note shown in the status line only. */ notice?: string; loading: boolean; refresh: () => void };
export type SettledFundingConfig = {
  label: string;
  intervalMs: number;
  firstSettlement: number;
  short: string;
  long: string;
  /** "个共同结算小时" / "次共同结算" and the matching missing unit. */
  coverage: { count: string; missing: string; valid: string };
  method: string;
  details: ReactNode;
};
function fundingTooltip(point: FundingChartPoint, config: SettledFundingConfig) {
  return <div className="chart-tooltip funding-tooltip"><strong>{stamp(point.time)} · 结算</strong>
    {point.shortRate === null ? <p>该时点缺少共同结算数据</p> : <>
      <div><span>做空 · 小时费率</span><b>{percent(point.shortRate, 5)}</b></div><div><span>做多 · 小时费率</span><b>{percent(point.longRate, 5)}</b></div>
      <div><span>做空 / 做多累计</span><b>{percent(point.shortCumulative, 4)} / {percent(point.longCumulative, 4)}</b></div>
      <div><span>做空 / 做多年化</span><b>{percent(point.shortAnnualized)} / {percent(point.longAnnualized)}</b></div>
      <p>从所选区间起点累计 · {point.count} {config.coverage.valid}</p>
    </>}
  </div>;
}

function SettledFundingPanel({ range, onRangeChange, feed, config, current }: { range: number | null; onRangeChange: (range: number | null) => void; feed: SettledFundingFeed; config: SettledFundingConfig; current?: ReactNode }) {
  const { error, loading, refresh, fetchedAt } = feed;
  const { intervalMs, firstSettlement } = config;
  const [mode, setMode] = useState<Mode>("rate");
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const rows = feed.rows ?? emptyRows;
  const loaded = Boolean(feed.rows?.length && fetchedAt);
  // Allow settlement blocks one minute to arrive; include an already received newer settlement.
  const end = loaded ? Math.max(rows.at(-1)!.time, Math.floor((Date.parse(fetchedAt!) - 60_000) / intervalMs) * intervalMs) : firstSettlement - intervalMs;
  const summary = useMemo(() => analyzeSettledFunding(rows as SettledFundingRow[], range, end, { intervalMs, firstSettlement }), [rows, range, end, intervalMs, firstSettlement]);
  const selectedMode = modes.find(item => item.id === mode)!;
  // Long ranges plot bucket extrema and gap edges only; readings and coverage keep every hour.
  const plotted = useMemo(() => sampleChartPoints(summary.chart, [selectedMode.short, selectedMode.long]), [summary.chart, selectedMode]);
  const dots = summary.missingHours ? 1.5 : summary.count === 1 ? 3 : 0;
  const layers = useMemo((): PlotLayer[] => [
    { kind: "line", key: selectedMode.short, color: "var(--positive)", width: 1.8, active: true, dots },
    { kind: "line", key: selectedMode.long, color: "var(--chart-2)", width: 1.8, dash: "5 3", active: true, dots },
  ], [selectedMode, dots]);
  const pad = summary.expectedHours === 1 ? intervalMs / 2 : 0;
  const xDomain = useMemo(() => [(summary.firstTime ?? 0) - pad, (summary.lastTime ?? 0) + pad] as const, [summary.firstTime, summary.lastTime, pad]);
  const yAxis = useMemo(() => {
    let low = -0.00001, high = 0.00001;
    for (const row of summary.chart) for (const key of [selectedMode.short, selectedMode.long]) { const value = plotValue(row, key); if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); } }
    return niceAxis(low, high);
  }, [summary.chart, selectedMode]);
  const unit = mode === "rate" ? "% / 小时" : mode === "annualized" ? "% / 年 · 简单年化" : "% · 区间累计";
  const stale = Boolean(error) || feed.snapshot;
  const readings = [{ key: "short", name: "做空价差", position: config.short, annualized: summary.shortAnnualized, cumulative: summary.shortCumulative }, { key: "long", name: "做多价差", position: config.long, annualized: summary.longAnnualized, cumulative: summary.longCumulative }];
  const status = error || feed.notice || (feed.snapshot ? "历史资金费使用备用快照。" : "");
  return <section className="chart-panel hynix-funding-panel" aria-label={config.label}>
    <div className="chart-heading"><div><div className="section-kicker">SETTLED FUNDING</div><h2>多空价差资金费</h2><p className="history-timestamp">已结算资金费 · 按小时折算 · 两腿等名义金额</p></div><div className="segmented range-control" aria-label="资金费时间范围">{ranges.map(item => <button type="button" key={item.label} aria-pressed={range === item.days} className={range === item.days ? "active" : ""} onClick={() => onRangeChange(item.days)}>{item.label}</button>)}</div></div>
    <div className="funding-return-readings" aria-label="区间累计资金费与年化">{readings.map(item => <article key={item.key}><div className="funding-return-label"><span><i className={`funding-sample ${item.key}`}/>{item.name}</span><small>{item.position}</small></div><span className="funding-return-caption">区间累计年化</span><strong className={item.annualized === null ? "" : item.annualized >= 0 ? "positive" : "negative"}>{percent(item.annualized)}</strong><p>区间累计资金费 <b>{percent(item.cumulative, 4)}</b></p></article>)}</div>
    <div className="chart-toolbar"><div className="chart-tabs" aria-label="资金费图表指标">{modes.map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}>{item.label}</button>)}</div><span className="chart-unit">{unit}</span></div>
    <div className="funding-chart-key"><span><i className="funding-sample short"/>做空价差</span><span><i className="funding-sample long"/>做多价差</span><small>正值收款 · 负值付款</small><span className="funding-mobile-unit">{unit}</span></div>
    <div className="chart-container funding-curve" aria-label={`${selectedMode.label}曲线`}>
      {!summary.count ? <div className="empty-chart" role="status"><p>{loading ? "正在载入历史结算费率…" : "所选区间没有共同结算数据"}</p><span>{error || "仅计算双方都有费率的结算时点"}</span></div> : <SvgPlot rows={plotted} hoverRows={summary.chart} xDomain={xDomain} yDomain={yAxis.domain} yTicks={yAxis.ticks} yTick={fundingTick} layers={layers} references={zeroLine}
        margin={{ top: 15, right: 88, bottom: 38 }} height={280} label={`${selectedMode.label} · 做空与做多价差资金费曲线`} tooltip={row => fundingTooltip(row as FundingChartPoint, config)}/>}
    </div>
    <div className="funding-coverage"><span>{!loaded ? "正在检查数据覆盖范围…" : <>{summary.count.toLocaleString()} / {summary.expectedHours.toLocaleString()} {config.coverage.count}{summary.missingHours > 0 ? ` · 缺少 ${summary.missingHours} ${config.coverage.missing}，累计仅含已覆盖数据` : " · 覆盖完整"}{plotted.length < summary.chart.length ? ` · 绘图保留极值与缺口共 ${plotted.length.toLocaleString()} 点` : ""}</>}</span><span>{stamp(summary.firstTime)} — {stamp(summary.lastTime)}</span></div>
    <div className="funding-history-status"><p className={stale ? "funding-stale" : ""} role="status">{status || (loaded ? "历史费率已同步" : "正在连接历史资金费接口…")}{loaded && <span> · 获取于 {stamp(fetchedAt)}</span>}</p><button type="button" className="refresh-button" disabled={loading} onClick={refresh}><RefreshCw size={14} className={loading ? "spinning" : ""}/>{loading ? "更新中" : "刷新资金费"}</button></div>
    {current}
    <p className="funding-method">{config.method}</p>
    <button type="button" className="funding-method-toggle" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>计算口径与数据来源</button>
    {details && <div id={detailsId} className="funding-method-detail">{config.details}</div>}
  </section>;
}

export default memo(SettledFundingPanel);
