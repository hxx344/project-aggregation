import { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import { format, time } from './display';
import type { Analytics } from './types';

const date = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const margin = { top: 12, right: 20, left: 8, bottom: 8 };
type TooltipEntry = { value?: unknown; name?: string; color?: string; payload?: { sourceAt?: number | null } };
function SampleTooltip({ active, payload, label, unit }: { active?: boolean; payload?: readonly TooltipEntry[]; label?: string | number; unit: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{time(Number(label))}</strong>{payload.map((item, index) => <p key={`${item.name}:${index}`}><span style={{ color: item.color }}>{item.name}</span> {format(item.value == null ? null : Number(item.value), 4)} {unit}</p>)}<small>行情源时间 {time(payload[0]?.payload?.sourceAt)}</small></div>;
}

export default function ProfitChart({ analytics }: { analytics: Analytics }) {
  const [positionId, setPositionId] = useState('');
  const data = useMemo(() => [...analytics.samples].sort((a, b) => a.at - b.at), [analytics.samples]);
  const position = analytics.positions.find(item => item.positionId === positionId) || analytics.positions[0];
  const spread = useMemo(() => [...(position?.samples || [])].sort((a, b) => a.at - b.at), [position?.samples]);
  const latest = data.at(-1), lastSpread = spread.at(-1);
  return <>
    <section className="panel analytics-panel">
      <div className="section-heading"><div><h2>持续模拟净值</h2><p>累计已实现盈亏 + 持仓浮盈 · USDT · 北京时间</p></div><span className="tag">每 {analytics.sampleSeconds} 秒采样</span></div>
      <div className="chart-summary">
        <span><small>含确认资金费</small><strong>{format(latest?.equity, 4)} <small>USDT</small></strong></span>
        <span><small>不含资金费参考值</small><strong>{format(latest?.priceOnlyEquity, 4)} <small>USDT</small></strong></span>
        <span><small>累计最大回撤</small><strong>{format(analytics.maxDrawdown, 4)} <small>USDT</small></strong></span>
      </div>
      <div className="chart-key"><span className="key-equity">含确认资金费</span><span className="key-price">不含资金费</span><span className="key-realized">已实现价差盈亏</span></div>
      <div className="profit-chart" aria-label={`模拟净值时间序列，最新 ${format(latest?.equity, 4)} USDT；缺失值保留为空。下方可展开采样表。`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 260 }}>
          <LineChart data={data} margin={margin} accessibilityLayer>
            <CartesianGrid stroke="#e0e7ef" vertical={false}/>
            <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={date} minTickGap={65}/>
            <YAxis width={70} tickFormatter={n => format(Number(n))}/>
            <Tooltip content={<SampleTooltip unit="USDT"/>} filterNull={false}/>
            <ReferenceLine y={0} stroke="#9ca9b8" strokeDasharray="3 3"/>
            <Line type="linear" dataKey="equity" name="含确认资金费净值" stroke="#087f83" strokeWidth={2} dot={data.length === 1} connectNulls={false} isAnimationActive={false}/>
            <Line type="linear" dataKey="priceOnlyEquity" name="不含资金费净值" stroke="#596da8" strokeDasharray="5 4" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false}/>
            <Line type="stepAfter" dataKey="realized" name="已实现价差盈亏" stroke="#8b969f" strokeDasharray="2 4" strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-subheading"><h3>从历史高点回撤</h3><span>USDT 金额，不换算本金百分比</span></div>
      <div className="profit-chart drawdown-chart" aria-label={`净值回撤，最大 ${format(analytics.maxDrawdown, 4)} USDT。`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 180 }}>
          <LineChart data={data} margin={margin} accessibilityLayer>
            <CartesianGrid stroke="#e0e7ef" vertical={false}/>
            <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={date} minTickGap={65}/>
            <YAxis width={70} tickFormatter={n => format(Number(n))}/>
            <Tooltip content={<SampleTooltip unit="USDT"/>} filterNull={false}/>
            <ReferenceLine y={0} stroke="#9ca9b8"/>
            <Line type="linear" dataKey="drawdown" name="回撤" stroke="#ad4f5e" strokeWidth={2} dot={data.length === 1} connectNulls={false} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="footnote">采样区间 {time(analytics.retainedFrom)} 至 {time(analytics.latestAt)} · 最新行情源 {time(latest?.sourceAt)}。净值以累计模拟盈亏为基准，不包含虚构初始本金。行情或资金费未完整确认时断线，缺口不插值；不含资金费的参考线仍可独立显示。</div>
      <details className="sample-table"><summary>查看最近 50 个采样点</summary><div className="table-wrap"><table>
        <thead><tr><th>采样时间</th><th>行情源时间</th><th>含资金费净值</th><th>不含资金费净值</th><th>回撤 USDT</th></tr></thead>
        <tbody>{data.slice(-50).reverse().map((sample, index) => <tr key={`${sample.at}:${index}`}><td>{time(sample.at)}</td><td>{time(sample.sourceAt)}</td><td>{format(sample.equity, 4)}</td><td>{format(sample.priceOnlyEquity, 4)}</td><td>{format(sample.drawdown, 4)}</td></tr>)}</tbody>
      </table></div></details>
    </section>
    <section className="panel analytics-panel">
      <div className="section-heading"><div><h2>持仓价差路径</h2><p>检查持有过程中的价差变化，单位 bp；1 bp = 0.01%</p></div>{position && <label className="chart-select">持仓<select value={position.positionId} onChange={e => setPositionId(e.target.value)}>{analytics.positions.map(item => <option key={item.positionId} value={item.positionId}>{item.base} · {item.positionId.slice(0, 8)}</option>)}</select></label>}</div>
      {!position ? <div className="empty">持仓采样后显示价差路径</div> : <>
        <div className="chart-summary"><span><small>最大不利价差变化</small><strong>{format(position.maxAdverseSpreadBps)} <small>bp</small></strong></span><span><small>最新价差</small><strong>{format(lastSpread?.spreadBps)} <small>bp</small></strong></span><span><small>最新采样盈亏</small><strong>{format(lastSpread?.net, 4)} <small>USDT</small></strong></span></div>
        <div className="profit-chart" aria-label={`${position.base} 持仓价差路径，相对入场的最大不利价差变化 ${format(position.maxAdverseSpreadBps)} bp。`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 260 }}>
            <LineChart data={spread} margin={margin} accessibilityLayer>
              <CartesianGrid stroke="#e0e7ef" vertical={false}/>
              <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tickFormatter={date} minTickGap={65}/>
              <YAxis width={70} tickFormatter={n => format(Number(n))}/>
              <Tooltip content={<SampleTooltip unit="bp"/>} filterNull={false}/>
              <ReferenceLine y={0} stroke="#9ca9b8" strokeDasharray="3 3"/>
              <Line type="linear" dataKey="spreadBps" name="持仓价差" stroke="#596da8" strokeWidth={2} dot={spread.length === 1} connectNulls={false} isAnimationActive={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="footnote">最新采样 {time(lastSpread?.at)} · 行情源 {time(lastSpread?.sourceAt)}。最大不利变化为退出价差相对入场价差扩大的最大正值。缺失或过期估值保留缺口；价差轨迹来自后台采样，不代表每个时点都具备足够退出深度。</div>
        <details className="sample-table"><summary>查看最近 50 个持仓采样点</summary><div className="table-wrap"><table>
          <thead><tr><th>采样时间</th><th>行情源时间</th><th>价差 bp</th><th>采样盈亏 USDT</th></tr></thead>
          <tbody>{spread.slice(-50).reverse().map((sample, index) => <tr key={`${sample.at}:${index}`}><td>{time(sample.at)}</td><td>{time(sample.sourceAt)}</td><td>{format(sample.spreadBps)}</td><td>{format(sample.net, 4)}</td></tr>)}</tbody>
        </table></div></details>
      </>}
    </section>
  </>;
}
