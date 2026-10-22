'use client';
import { memo, useEffect, useState } from 'react';
import { requestJson } from '@/lib/client-request';
import { formatGain, formatReturnRate, performanceTone } from '@/lib/performance-metrics';
import { DAILY_CHANGE_DAYS, type DailyChange, type DailyChangeReport } from '@/lib/daily-changes';
import type { PositionAnalysis, PositionChange } from '@/lib/daily-positions';

const money = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gain = (value: number | null) => value === null ? '—' : formatGain(value);
type Line = { key: string; label: string; change: number; detail: string };
type Item = Line & { sub: Line[] };

function items(day: DailyChange): Item[] {
  return [
    ...day.sources.map(source => ({ key: 'row:' + source.id, label: source.project + (source.kind ? ' · ' + source.kind : ''), change: source.change,
      detail: source.previous === null && source.current === null ? '估值缺失' : `${money(source.previous)} → ${money(source.current)}`,
      sub: source.details.map(detail => ({ key: detail.label, label: detail.label, change: detail.change, detail: `${money(detail.previous)} → ${money(detail.current)}` })) })),
    ...(day.withdrawnChange ? [{ key: 'withdrawn', label: '出金（加回）', change: day.withdrawnChange, detail: '累计出金变化', sub: [] }] : []),
    ...(day.unattributed ? [{ key: 'unattributed', label: '原表合计差异', change: day.unattributed, detail: '原表总额与行估值之和的差额变化', sub: [] }] : []),
  ].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

const SIDE = { long: '多', short: '空' } as const;
function quantity(item: PositionChange) {
  if (item.previousQuantity === item.quantity) return item.quantity + ' ' + item.quantityUnit;
  return `${item.previousQuantity ?? '0'} → ${item.quantity ?? '0'} ${item.quantityUnit}`;
}

function Combos({ positions }: { positions: PositionAnalysis }) {
  if (!positions.compared) return positions.exchanges.length ? <p className="daily-combos-note">持仓从这天开始记录，下一份快照起计算组合影响</p> : null;
  if (!positions.combos.length) return null;
  return <ul className="daily-combos" aria-label="套利组合影响">{positions.combos.map(combo => <li key={combo.id}>
    <span>{combo.label}</span><b className={combo.change === null ? undefined : performanceTone(combo.change)}>{gain(combo.change)}</b>
    {!combo.complete && <small className="daily-partial">部分</small>}
  </li>)}</ul>;
}

function Holdings({ positions }: { positions: PositionAnalysis }) {
  return <div className="daily-holdings">{positions.exchanges.map(exchange => <section key={exchange.exchange}>
    <h4>{exchange.name} 持仓
      <small>余额 {gain(exchange.balanceChange)} · 持仓 {gain(exchange.positionsChange)}{!exchange.complete && '（部分）'}{exchange.other !== null && ' · 其他 ' + formatGain(exchange.other)}</small>
    </h4>
    {!exchange.readable && <p className="daily-sources">部分持仓范围未在两份快照中都成功读取，持仓可能不全</p>}
    {exchange.positions.length ? <ul className="daily-sources expanded">{exchange.positions.map(item => <li key={item.key}>
      <span className="daily-source-label">{item.symbol} · {SIDE[item.side]}{item.combo && <small> · {item.combo === 'oil' ? '原油' : '海力士'}</small>}</span>
      <small>{quantity(item)}{item.note && ' · ' + item.note}</small>
      <b className={item.change === null ? undefined : performanceTone(item.change)}>{gain(item.change)}</b>
    </li>)}</ul> : exchange.readable ? <p className="daily-sources">无持仓</p> : null}
  </section>)}</div>;
}

/** Loaded only while expanded; reloads when the ledger version changes. */
export const DailyChanges = memo(function DailyChanges({ version }: { version: string }) {
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<DailyChangeReport | null>(null);
  const [status, setStatus] = useState<{ key: string; error: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const key = version + '#' + attempt, loading = open && status?.key !== key;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<DailyChangeReport>('/api/daily-changes', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setReport(data); setStatus({ key, error: '' }); } })
      .catch(error => { if (!controller.signal.aborted) setStatus({ key, error: error instanceof Error ? error.message : '无法读取每日波动' }); });
    return () => controller.abort();
  }, [open, key]);
  const days = report?.days ?? [];
  return <details className="performance-monthly daily-changes" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>每日波动 <span>（近 {DAILY_CHANGE_DAYS} 天{report ? ' · ' + days.length + ' 日' : ''}）</span>与来源</summary>
    <div className="performance-monthly-body">
      <p className="performance-note">逐日对比上一份已有快照，缺失日期不补造。来源为各资产行估值变化，展开可看交易所分项与持仓；出金单列并加回，与“剔除出金影响”口径一致。入金未剔除，资产变化不等于投资收益。</p>
      <p className="performance-note">组合影响 = 两份快照间的浮盈亏变化 + 本轮已实现盈亏、手续费、资金费的变化，按快照内的稳定币价格折成 USD。持仓随快照记录，此前的日期没有持仓数据；当天已平仓、本轮统计不可比或只有浮盈亏的仓位标为“部分”。</p>
      {status?.error && <p className="error-text" role="alert">{status.error}{report && '，当前显示上次读取结果'} <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
      {!report ? (loading ? <p className="help" role="status">读取每日波动…</p> : null)
        : !days.length ? <p className="help">近 {DAILY_CHANGE_DAYS} 天不足两份快照，暂无逐日变化。</p>
        : <ol className="daily-change-list" aria-label="每日波动明细，按日期从新到旧" aria-busy={loading}>{days.map(day => {
          const all = items(day), isOpen = expanded === day.date, shown = isOpen ? all : all.slice(0, 3);
          const extra = all.some(item => item.sub.length) || !!day.positions?.exchanges.length;
          const rate = day.previousAdjusted > 0 ? day.change / day.previousAdjusted : null;
          return <li key={day.date}>
            <div className="daily-change-head">
              <span><strong>{day.date.slice(5)}</strong><small>较 {day.previousDate.slice(5)}{day.gapDays > 1 && ' · 间隔 ' + day.gapDays + ' 天'}</small></span>
              <span className={performanceTone(day.change)}>$ {formatGain(day.change)}<small>{formatReturnRate(rate)}</small></span>
            </div>
            {day.positions && <Combos positions={day.positions}/>}
            {all.length ? <ul className={isOpen ? 'daily-sources expanded' : 'daily-sources'}>{shown.map(item => <li key={item.key}>
              <span className="daily-source-label">{item.label}</span>
              {isOpen && <small>{item.detail}</small>}
              <b className={performanceTone(item.change)}>{formatGain(item.change)}</b>
              {isOpen && !!item.sub.length && <ul className="daily-sources expanded daily-details">{item.sub.map(line => <li key={line.key}>
                <span className="daily-source-label">{line.label}</span><small>{line.detail}</small><b className={performanceTone(line.change)}>{formatGain(line.change)}</b>
              </li>)}</ul>}
            </li>)}</ul> : <p className="daily-sources">各来源无变化</p>}
            {isOpen && day.positions && <Holdings positions={day.positions}/>}
            {(all.length > 3 || extra) && <button type="button" className="text-button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : day.date)}>{isOpen ? '收起' : extra ? '明细与持仓' : '全部 ' + all.length + ' 项'}</button>}
          </li>;
        })}</ol>}
    </div>
  </details>;
});
