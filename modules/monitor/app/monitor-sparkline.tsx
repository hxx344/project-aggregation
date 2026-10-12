"use client";

import { memo, useMemo } from "react";
import { summaryTimestamp } from "../lib/monitor-summary";
import { trendGeometry, type MonitorTrend } from "../lib/monitor-trend";

function MonitorSparkline({ trend, expired }: { trend: MonitorTrend; expired: boolean }) {
  const geometry = useMemo(() => trendGeometry(trend.points, trend.intervalMs), [trend.points, trend.intervalMs]);
  const last = trend.points.at(-1);
  const status = trend.status === "snapshot" ? "快照" : trend.status === "stale" ? "保留历史" : expired ? "待更新" : "";
  const ending = last ? summaryTimestamp(new Date(last.time + trend.intervalMs).toISOString()) : null;
  const description = `${trend.label}${status ? ` · ${status}` : ""}${ending ? `；最后收盘 ${ending} 北京时间，${last!.value.toFixed(3)}${trend.unit}` : ""}；历史收盘走势，与当前报价分别更新。`;
  return <span className={`hub-sparkline ${status ? "retained" : ""}`} title={description}>
    {geometry ? <svg className="size-spark" viewBox="0 0 120 42" role="img" aria-label={description} preserveAspectRatio="none">
      <path className="spark-baseline" d="M3,40 L117,40"/>
      {geometry.segments.map((segment, index) => <g key={index}><path className="spark-area" d={segment.area}/><path className="spark-line" d={segment.line}/></g>)}
      {geometry.isolated.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="1.6"/>)}
      <circle cx={geometry.end.x} cy={geometry.end.y} r="2.3"/>
    </svg> : <span className="spark-empty">{trend.status === "loading" ? "加载走势" : trend.status === "error" ? "暂无历史" : "历史不足"}</span>}
    <small><span className="spark-label-full">{trend.label}</span><span className="spark-label-short">{trend.shortLabel}</span>{status && <span className="spark-history-status"> · {status}</span>}</small>
  </span>;
}

export default memo(MonitorSparkline);
