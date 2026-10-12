'use client';
import { memo, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { assetTrend } from '@/lib/withdrawals';
import type { Ledger } from '@/lib/types';

const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (value: number) => (value > 0 ? '+' : '') + money(value);

export const AssetTrend = memo(function AssetTrend({ ledger, today, onHistory }: { ledger: Ledger; today: string; onHistory: () => void }) {
  const history = useMemo(() => assetTrend(ledger, today), [ledger, today]);
  const first = history[0], last = history.at(-1);
  const change = first && last ? last.adjusted - first.adjusted : null;
  return <section className="panel trend-panel">
    <div className="panel-title"><h2>资产变化</h2><span>北京时间 · USD</span></div>
    <div className="trend-summary">
      <div><span>剔除出金影响的区间变化</span><strong>{change === null ? '—' : '$ ' + signed(change)}</strong></div>
      <p>{first && last ? first.date + ' — ' + last.date : '等待首条快照'}</p>
    </div>
    <div className="trend-key"><span><i className="adjusted-line"/>剔除出金影响</span><span><i className="held-line"/>实际持有资产</span></div>
    {history.length ? <div className="chart" aria-label="资产变化折线图：实线为剔除出金影响后的资产，虚线为实际持有资产。详细数值见历史记录。">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 600, height: 235 }}><LineChart accessibilityLayer data={history} margin={{ top: 15, right: 20, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4"/>
        <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' })} axisLine={false} tickLine={false} minTickGap={50} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}/>
        <YAxis domain={['auto', 'auto']} tickFormatter={value => Math.abs(value) >= 1000 ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 'k' : String(value)} axisLine={false} tickLine={false} width={60} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}/>
        <Tooltip content={({ active, payload }) => {
          const point = payload?.[0]?.payload as typeof first | undefined;
          return active && point ? <div className="trend-tooltip"><strong>{point.date}</strong><div>实际持有：$ {money(point.held)}</div><div>累计出金：$ {money(point.withdrawn)}</div><div>剔除出金影响：$ {money(point.adjusted)}</div>{point.partial && <p>此快照含旧值或缺失行情</p>}{!!point.difference && <p>原表合计差异：$ {money(point.difference)}</p>}</div> : null;
        }}/>
        <Line type="linear" name="剔除出金影响" dataKey="adjusted" stroke="var(--chart-1)" strokeWidth={2.5} dot={history.length === 1 ? { r: 4 } : false} activeDot={{ r: 5 }} isAnimationActive={false}/>
        <Line type="linear" name="实际持有资产" dataKey="held" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="6 4" dot={history.length === 1 ? { r: 3 } : false} isAnimationActive={false}/>
      </LineChart></ResponsiveContainer>
    </div> : <div className="empty-state">刷新资产后生成第一条日快照</div>}
    <p className="chart-note">调整后资产 = 实际持有资产 + 累计出金；仅计已登记出金，入金未剔除。连线仅连接已有记录，不代表缺失日期的估值。{history.some(point => point.partial) && <strong> 含旧值快照，详见历史记录。</strong>}<button className="text-button" onClick={onHistory}>查看记录</button></p>
  </section>;
});
