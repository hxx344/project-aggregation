'use client';
import { memo, useEffect, useState } from 'react';
import { requestJson } from '@/lib/client-request';
import { formatGain, formatReturnRate, performanceTone } from '@/lib/performance-metrics';
import { DAILY_CHANGE_DAYS, type DailyChange, type DailyChangeReport } from '@/lib/daily-changes';

const money = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
type Item = { key: string; label: string; change: number; detail: string };

function items(day: DailyChange): Item[] {
  return [
    ...day.sources.map(source => ({ key: 'row:' + source.id, label: source.project + (source.kind ? ' · ' + source.kind : ''), change: source.change,
      detail: source.previous === null && source.current === null ? '估值缺失' : `${money(source.previous)} → ${money(source.current)}` })),
    ...(day.withdrawnChange ? [{ key: 'withdrawn', label: '出金（加回）', change: day.withdrawnChange, detail: '累计出金变化' }] : []),
    ...(day.unattributed ? [{ key: 'unattributed', label: '原表合计差异', change: day.unattributed, detail: '原表总额与行估值之和的差额变化' }] : []),
  ].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
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
      <p className="performance-note">逐日对比上一份已有快照，缺失日期不补造。来源为各资产行估值变化；出金单列并加回，与“剔除出金影响”口径一致。入金未剔除，资产变化不等于投资收益。</p>
      {status?.error && <p className="error-text" role="alert">{status.error}{report && '，当前显示上次读取结果'} <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
      {!report ? (loading ? <p className="help" role="status">读取每日波动…</p> : null)
        : !days.length ? <p className="help">近 {DAILY_CHANGE_DAYS} 天不足两份快照，暂无逐日变化。</p>
        : <ol className="daily-change-list" aria-label="每日波动明细，按日期从新到旧" aria-busy={loading}>{days.map(day => {
          const all = items(day), isOpen = expanded === day.date, shown = isOpen ? all : all.slice(0, 3);
          const rate = day.previousAdjusted > 0 ? day.change / day.previousAdjusted : null;
          return <li key={day.date}>
            <div className="daily-change-head">
              <span><strong>{day.date.slice(5)}</strong><small>较 {day.previousDate.slice(5)}{day.gapDays > 1 && ' · 间隔 ' + day.gapDays + ' 天'}</small>{day.partial && <small className="performance-warning">含旧值</small>}</span>
              <span className={performanceTone(day.change)}>$ {formatGain(day.change)}<small>{formatReturnRate(rate)}</small></span>
            </div>
            {all.length ? <ul className={isOpen ? 'daily-sources expanded' : 'daily-sources'}>{shown.map(item => <li key={item.key}>
              <span className="daily-source-label">{item.label}</span>
              {isOpen && <small>{item.detail}</small>}
              <b className={performanceTone(item.change)}>{formatGain(item.change)}</b>
            </li>)}</ul> : <p className="daily-sources">各来源无变化</p>}
            {all.length > 3 && <button type="button" className="text-button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : day.date)}>{isOpen ? '收起' : '全部 ' + all.length + ' 项'}</button>}
          </li>;
        })}</ol>}
    </div>
  </details>;
});
