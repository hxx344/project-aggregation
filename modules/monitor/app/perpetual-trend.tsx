"use client";

import { memo, useMemo } from "react";
import type { PairQualityHistory } from "../lib/perpetual-quality";

const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(3)}%`;

function PerpetualTrend({ history, now, crossCurrency }: { history: PairQualityHistory | undefined; now: number; crossCurrency: boolean }) {
  const points = history?.priceSeries;
  const chart = useMemo(() => {
    const valid = (points ?? []).filter(([at, value]) => Number.isFinite(at) && at > now - 3_600_000 && at <= now && Number.isFinite(value)).slice(-60);
    if (valid.length < 2) return null;
    const end = Math.floor(now / 60_000) * 60_000, start = end - 59 * 60_000;
    const values = valid.map(([, value]) => value);
    const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max((hi - lo) * .16, .005);
    const min = lo - pad, max = hi + pad;
    const x = (at: number) => 54 + (at - start) / (end - start) * 658;
    const y = (value: number) => 18 + (max - value) / (max - min) * 114;
    const path = valid.map(([at, value], index) => `${index && at - valid[index - 1][0] <= 60_000 ? "L" : "M"}${x(at).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
    return { path, valid, min, max, start, end, x, y };
  }, [points, now]);
  const stale = Boolean(history?.spread.lastAt && now - history.spread.lastAt > 180_000);
  return <section className="perp-trend" aria-label="该组合近一小时价差走势">
    <div className="perp-detail-section-title"><h3>价差走势 <small>近 1 小时 · 毛价差</small></h3><span>{history?.spread.samples ?? 0} / 60 个分钟样本{stale ? " · 已过期" : ""}</span></div>
    {crossCurrency ? <p className="perp-detail-muted">跨计价币暂不绘制历史，避免混用换汇前后的口径。</p> : chart ? <>
      <svg viewBox="0 0 740 165" role="img" aria-label={`分钟采样毛价差，最低 ${pct(Math.min(...chart.valid.map(p => p[1])))}，最高 ${pct(Math.max(...chart.valid.map(p => p[1])))}，缺失分钟断线`}>
        {[chart.min, (chart.min + chart.max) / 2, chart.max].map(value => <g key={value}><line x1="54" x2="712" y1={chart.y(value)} y2={chart.y(value)} stroke="var(--border)"/><text x="47" y={chart.y(value) + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">{value.toFixed(2)}%</text></g>)}
        <path d={chart.path} fill="none" stroke={stale ? "var(--muted-foreground)" : "var(--chart-2)"} strokeWidth="2"/>
        {chart.valid.map(([at, value]) => <circle key={at} cx={chart.x(at)} cy={chart.y(value)} r="1.8" fill="var(--chart-2)"><title>{time.format(at)} · {pct(value)}</title></circle>)}
        <text x="54" y="154" fill="var(--muted-foreground)" fontSize="10">{time.format(chart.start)}</text><text x="712" y="154" textAnchor="end" fill="var(--muted-foreground)" fontSize="10">{time.format(chart.end)} 北京时间</text>
      </svg><p className="perp-detail-muted">每分钟记录一次有效盘口；缺口断线，无回填。历史采样不随本页暂停而停止。</p>
    </> : <p className="perp-detail-muted">{points ? "尚不足两个有效分钟样本，观察后自动积累。" : "正在读取该组合的分钟记录…"}</p>}
  </section>;
}

export default memo(PerpetualTrend);
