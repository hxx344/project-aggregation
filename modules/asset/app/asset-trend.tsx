'use client';
import { memo, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { assetTrend } from '@/lib/withdrawals';
import { calculateMonthlyPerformance, calculateAnnualizedReturns, formatGain, formatReturnRate, performanceTone, MIN_MONTHLY_SPAN_DAYS } from '@/lib/performance-metrics';
import type { Ledger } from '@/lib/types';
import { DailyChanges } from './daily-changes';

const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (value: number) => (value > 0 ? '+' : '') + money(value);

export const AssetTrend = memo(function AssetTrend({ ledger, today, onHistory }: { ledger: Ledger; today: string; onHistory: () => void }) {
  const history = useMemo(() => assetTrend(ledger, today), [ledger, today]);
  const monthly = useMemo(() => calculateMonthlyPerformance(history), [history]);
  const annualized = useMemo(() => calculateAnnualizedReturns(history, monthly, today), [history, monthly, today]);
  const first = history[0], last = history.at(-1);
  // Daily snapshots only change for today's refresh, withdrawal edits or an import. A refresh rewrites balance details and holdings even when the total is unchanged.
  const refreshed = useMemo(() => ledger.assets.map(asset => asset.id + ':' + asset.updatedAt).join(','), [ledger.assets]);
  const changesVersion = useMemo(() => [history.length, last?.date, last?.total, last?.withdrawn, last?.partial, last?.missingValues, ledger.baselineDate, JSON.stringify(ledger.withdrawals), refreshed].join('|'), [history, last, ledger.baselineDate, ledger.withdrawals, refreshed]);
  const change = first && last && !first.missingValues && !last.missingValues ? last.adjusted - first.adjusted : null;
  const incomplete = [first && { label: '起点', point: first }, last !== first && last && { label: '终点', point: last }]
    .flatMap(item => item && item.point.missingValues ? [`${item.label} ${item.point.date} 有 ${item.point.missingValues} 项估值缺失`] : []).join('，');
  const month = annualized.monthlyPeriod;
  const monthlyHint = !month ? '上个自然月没有快照'
    : month.snapshotCount < 2 || month.daysSpan < MIN_MONTHLY_SPAN_DAYS ? `需要两个不同日期，首末快照间隔至少 ${MIN_MONTHLY_SPAN_DAYS} 天`
    : month.returnRate === null ? '首末快照估值须完整，起始调整后资产须大于 0，收益率需为有效数值'
    : `${month.startDate} — ${month.endDate} · ${month.daysSpan} 天`;
  return <section className="panel trend-panel">
    <div className="panel-h"><h2>资产变化</h2><span className="panel-h-right">北京时间 · USD</span></div>
    <div className="trend-summary">
      <span>剔除出金影响的区间变化</span>
      <strong className={change === null ? undefined : performanceTone(change)}>{change === null ? '—' : '$ ' + signed(change)}</strong>
      <p>{first && last ? first.date + ' — ' + last.date : '等待首条快照'}{change === null && incomplete && '；' + incomplete}</p>
    </div>
    <div className="trend-key"><span><i className="adjusted-line"/>剔除出金影响</span><span><i className="held-line"/>实际持有资产</span></div>
    {history.length ? <div className="chart" aria-label="资产变化折线图：实线为剔除出金影响后的资产，虚线为实际持有资产。详细数值见历史记录。">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 340, height: 170 }}><LineChart accessibilityLayer data={history} margin={{ top: 10, right: 14, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4"/>
        <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' })} axisLine={false} tickLine={false} minTickGap={40} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}/>
        <YAxis domain={['auto', 'auto']} tickFormatter={value => Math.abs(value) >= 1000 ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 'k' : String(value)} axisLine={false} tickLine={false} width={48} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}/>
        <Tooltip content={({ active, payload }) => {
          const point = payload?.[0]?.payload as typeof first | undefined;
          return active && point ? <div className="trend-tooltip"><strong>{point.date}</strong>{!!point.missingValues && <p>部分估值：仅汇总已知金额</p>}<div>实际持有：$ {money(point.held)}</div><div>累计出金：$ {money(point.withdrawn)}</div><div>剔除出金影响：$ {money(point.adjusted)}</div>{!!point.difference && <p>原表合计差异：$ {money(point.difference)}</p>}</div> : null;
        }}/>
        <Line type="monotoneX" strokeLinecap="round" strokeLinejoin="round" name="剔除出金影响" dataKey="adjusted" stroke="var(--chart-1)" strokeWidth={2} dot={history.length === 1 ? { r: 4 } : false} activeDot={{ r: 4 }} isAnimationActive={false}/>
        <Line type="monotoneX" strokeLinecap="round" strokeLinejoin="round" name="实际持有资产" dataKey="held" stroke="var(--chart-2)" strokeWidth={1.5} strokeDasharray="5 4" dot={history.length === 1 ? { r: 3 } : false} isAnimationActive={false}/>
      </LineChart></ResponsiveContainer>
    </div> : <div className="empty-state">刷新资产后生成第一条日快照</div>}
    {history.length >= 2 && <section className="performance-metrics" aria-label="收益指标">
      <div className="performance-annualized">
        <div className="performance-card">
          <span className="performance-label">月收益年化 <small>{annualized.referenceMonth}</small></span>
          <strong className={performanceTone(annualized.monthlyAnnualized, 100)}>{formatReturnRate(annualized.monthlyAnnualized)}</strong>
          <p>{monthlyHint}</p>
        </div>
        <div className="performance-card">
          <span className="performance-label">总体年化</span>
          <strong className={performanceTone(annualized.overallAnnualized, 100)}>{formatReturnRate(annualized.overallAnnualized)}</strong>
          <p>{first?.date} — {last?.date} · {annualized.daysSpan} 天{annualized.overallAnnualized === null && '；' + (incomplete ? incomplete + '，不计算收益' : '首末快照估值须完整，起始调整后资产须大于 0，收益率需为有效数值')}</p>
        </div>
      </div>
      <details className="performance-monthly">
        <summary>每月表现 <span>（{monthly.length} 个月）</span>与收益口径</summary>
        <div className="performance-monthly-body">
          <div className="performance-heading"><h3>收益指标</h3><span>全历史 · 单利年化</span></div>
          <p className="performance-note">基于调整后资产，入金未剔除。上月首末快照间隔至少 {MIN_MONTHLY_SPAN_DAYS} 天才计算月年化；按实际相隔天数及各年 365 / 366 天折算，不计复利。</p>
          <div className="performance-table-scroll" role="region" aria-label="每月表现明细，可横向滚动" tabIndex={0}>
            <table className="performance-table">
              <caption>各月按月内首末已有快照计算，不补齐缺失日期。金额单位：USD。</caption>
              <thead><tr><th scope="col">月份 / 快照区间</th><th scope="col">收益金额</th><th scope="col">收益率</th><th scope="col">期末调整后资产</th></tr></thead>
              <tbody>{monthly.map(period => <tr key={period.month}>
                <th scope="row">{period.month}{period.month === today.slice(0, 7) && <span className="performance-month-state">进行中</span>}
                  <small>{period.startDate.slice(5)} — {period.endDate.slice(5)} · {period.snapshotCount} 日快照</small>
                  {period.snapshotCount < 2 && <small>仅一个日期，无法计算收益</small>}
                  {period.snapshotCount >= 2 && period.gain === null && <small>首末快照估值不完整或超出计算范围</small>}
                  {period.snapshotCount >= 2 && period.startValue <= 0 && <small>起始资产不大于 0，收益率不可用</small>}
                </th>
                <td className={performanceTone(period.gain)}>{period.gain === null ? '—' : '$ ' + formatGain(period.gain)}</td>
                <td className={performanceTone(period.returnRate, 100)}>{formatReturnRate(period.returnRate)}</td>
                <td>$ {money(period.endValue)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section>}
    {history.length >= 2 && <DailyChanges version={changesVersion}/>}
    <p className="panel-foot chart-note">调整后资产 = 实际持有资产 + 累计出金；仅计已登记出金，入金未剔除。缺失估值的快照仅含已知金额，首末快照估值不完整时不计算收益。连线仅连接已有记录，不代表缺失日期的估值。<button className="text-button" onClick={onHistory}>查看记录</button></p>
  </section>;
});
