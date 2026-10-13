import { useMemo } from 'react';
import Decimal from 'decimal.js';
import { Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PositionSample } from './position-history';
import { POSITION_HISTORY_GAP_MS } from './position-history';
import { percentage } from './position-view';

const chartTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const D = Decimal.clone({ precision: 100 });

function SpreadTrend({ samples }: { samples: PositionSample[] }) {
  const data = useMemo(() => samples.flatMap((sample, index) => {
    const parsed = sample.spread === null ? null : new D(sample.spread).mul(100).toNumber();
    const point = { at: sample.at, value: parsed !== null && Number.isFinite(parsed) ? parsed : null };
    return index && sample.at - samples[index - 1].at > POSITION_HISTORY_GAP_MS
      ? [{ at: samples[index - 1].at + 1, value: null }, point] : [point];
  }), [samples]);
  const valid = data.filter(point => point.value !== null);
  if (valid.length < 2) return <figure className="position-trend"><figcaption>价差趋势 · 最近 24h</figcaption><div className="position-trend-empty">等待至少两个有效采样点<small>仅记录本次页面会话，不补填历史数据</small></div></figure>;
  const first = valid[0], last = valid[valid.length - 1], minutes = Math.floor((last.at - first.at) / 60_000);
  return <figure className="position-trend" aria-label={`本会话价差趋势，${valid.length}个采样点，覆盖${minutes}分钟`}>
    <figcaption><span>价差趋势 · 最近 24h</span><span>本会话覆盖 {minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`}</span></figcaption>
    <div className="position-trend-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 300, height: 125 }}>
      <LineChart data={data} margin={{ top: 8, bottom: 0, left: 0, right: 8 }} accessibilityLayer>
        <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={chartTime} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={30}/>
        <YAxis width={54} domain={['auto', 'auto']} tickFormatter={value => `${Number(value.toPrecision(4))}%`} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} axisLine={false} tickLine={false}/>
        <Tooltip labelFormatter={label => chartTime(Number(label))} formatter={value => [`${Number(value).toPrecision(4)}%`, '价差']} contentStyle={{ background: 'var(--surface-2)', borderColor: 'var(--surface-4)', color: 'var(--text-primary)', fontSize: 12 }}/>
        <Line type="linear" dataKey="value" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>
      </LineChart>
    </ResponsiveContainer></div>
    <p className="metrics-note">{chartTime(first.at)} {percentage(new D(first.value!).div(100).toString())} → {chartTime(last.at)} {percentage(new D(last.value!).div(100).toString())}；超过 5 分钟的采样间隔显示断线。</p>
  </figure>;
}

function Composition({ values }: { values: [string, string] }) {
  const total = new D(values[0]).plus(values[1]);
  const share = new D(values[0]).div(total).toNumber();
  const data = [{ name: '价差收益', value: share, fill: 'var(--accent)' }, { name: '资金费收益', value: 1 - share, fill: 'var(--emerald)' }];
  return <div className="position-composition-chart" role="img" aria-label={`收益构成：价差 ${(share * 100).toFixed(1)}%，资金费 ${((1 - share) * 100).toFixed(1)}%`}>
    <PieChart width={100} height={100}><Pie data={data} dataKey="value" cx={45} cy={45} outerRadius={43} innerRadius={29} stroke="var(--surface-1)" isAnimationActive={false}/></PieChart>
  </div>;
}

export default function PositionCharts(props: { kind: 'spread'; samples: PositionSample[] } | { kind: 'composition'; values: [string, string] }) {
  return props.kind === 'spread' ? <SpreadTrend samples={props.samples}/> : <Composition values={props.values}/>;
}
