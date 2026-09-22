import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { memo } from 'react';

export default memo(function TrendChart({ points, label = '记录值', unit }: { points: { at: string; value: number }[]; label?: string; unit?: string }) {
  const data = points.map(p => ({ ...p, date: new Date(p.at).getTime() })).filter(p => Number.isFinite(p.date) && Number.isFinite(p.value));
  const tickDates = [...new Set(Array.from({ length: Math.min(5, data.length) }, (_, i) => data[Math.round(i * (data.length - 1) / Math.max(1, Math.min(5, data.length) - 1))].date))];
  const dayLabel = (date: number) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(date));
  const needsTime = new Set(tickDates.map(dayLabel)).size < tickDates.length;
  const dateLabel = (date: number) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', ...(needsTime ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(new Date(date));
  return <figure className="trend-figure" aria-label={`历史记录，共 ${data.length} 个数据点。可展开查看数值。`}>
    <figcaption className="chart-caption">{label}{unit ? ` · ${unit}` : ''}</figcaption><div className="trend-chart"><ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 280 }} minWidth={0}><AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="#e8edf4" /><XAxis dataKey="date" type="number" domain={['dataMin', 'dataMax']} ticks={tickDates} tickFormatter={dateLabel} tickLine={false} axisLine={false} minTickGap={36} tick={{ fontSize: 12, fill: '#68758b' }} /><YAxis width={65} tickFormatter={v => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(v)} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#68758b' }} domain={['auto', 'auto']} /><Tooltip labelFormatter={v => new Date(Number(v)).toLocaleString('zh-CN')} formatter={v => [new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(v)), `${label}${unit ? ` (${unit})` : ''}`]} contentStyle={{ border: '1px solid #dce3ee', borderRadius: 8, fontSize: 14 }} /><Area type="linear" dataKey="value" stroke="#336ce6" fill="#edf3ff" strokeWidth={2} isAnimationActive={false} connectNulls={false} /></AreaChart></ResponsiveContainer></div>
    <details className="chart-data"><summary>查看历史数值</summary><div><table><thead><tr><th>日期</th><th>{label}{unit ? ` (${unit})` : ''}</th></tr></thead><tbody>{data.map((p, i) => <tr key={`${p.at}-${i}`}><td>{new Date(p.at).toLocaleString('zh-CN')}</td><td>{p.value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}</td></tr>)}</tbody></table></div></details>
  </figure>;
});
