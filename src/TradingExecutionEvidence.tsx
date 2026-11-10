import { useEffect, useState } from 'react';
import { api } from './api';

type FillEvidence = { id: string | null; orderId: string | null; time: string | null; quantity: string | null; price: string | null; priceCurrency: string | null; fee: string | null; feeCurrency: string | null };
type CostLeg = { exchange: string | null; symbol: string | null; quantity: string | null; averagePrice: string | null; priceCurrency: string | null;
  fees: { currency: string; value: string }[]; feesComplete: boolean; coverageComplete: boolean; fillCount: number; fills: FillEvidence[]; evidenceTruncated: boolean;
  slippageReason: string; coverage: { start: string | null; end: string | null; status: string | null; truncated: boolean } };
type Evidence = { version: number; exportedAt: string; job: { id: string }; gaps: string[]; orders: unknown[]; events: unknown[];
  costs: null | { note: string; gaps: string[]; truncated: boolean; batches: { phase: number; batch: number; legs: CostLeg[]; completionGapMs: number | null }[] } };

/** This panel only reads a local evidence projection; opening or exporting never sends a trading write. */
export default function TradingExecutionEvidence({ jobId, updatedAt }: { jobId: string; updatedAt?: string | null }) {
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: Evidence; error?: string } | null>(null);
  const key = `${jobId}:${updatedAt}:${attempt}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api<Evidence>(`/api/trading/execution/jobs/${encodeURIComponent(jobId)}/evidence`, { signal: controller.signal, timeoutMs: 12_000 })
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : '证据读取失败' }); });
    return () => controller.abort();
  }, [open, jobId, key]);
  const data = result?.key === key ? result.data : undefined;
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `execution-evidence-${jobId}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="execution-events" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>只读执行证据与逐批成本</summary>
    {open ? <div>
      {!result || result.key !== key ? <p role="status">读取本地证据…</p> : result.error ? <p role="alert">{result.error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p> : null}
      {data ? <>
        <p>任务 {data.job.id} · 证据版本 {data.version} · {data.orders.length} 张委托 · {data.events.length} 条事件</p>
        <button type="button" className="button secondary" onClick={download}>下载脱敏证据 JSON</button>
        <ul>{data.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        {data.costs ? <>
          <p>{data.costs.note}</p><ul>{data.costs.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
          {data.costs.batches.map(batch => <section key={`${batch.phase}:${batch.batch}`}>
            <h4>阶段 {batch.phase + 1} · 第 {batch.batch + 1} 批</h4>
            <p>双腿最后可见成交时差：{batch.completionGapMs === null ? '不可计算' : `${batch.completionGapMs} ms`}</p>
            {batch.legs.map((leg, index) => <details key={index}>
              <summary>{leg.exchange} {leg.symbol} · 实际均价 {leg.averagePrice ?? '不可计算'} {leg.priceCurrency ?? ''} · {leg.fillCount} 笔成交</summary>
              <p>数量 {leg.quantity ?? '不可计算'} · 手续费：{leg.fees.map(fee => `${fee.value} ${fee.currency}`).join(' / ') || '不可计算'}{!leg.feesComplete ? '（费用证据不完整）' : ''}</p>
              <p>{leg.coverageComplete ? '已读取成交量与本批全部已结算委托一致。' : '尚不能证明覆盖本批全部成交，均价和费用仅代表已读取部分。'}</p>
              <p>{leg.slippageReason}。覆盖 {leg.coverage.start ?? '未知'} 至 {leg.coverage.end ?? '未知'}{leg.coverage.truncated ? '（历史截断）' : ''} · {leg.coverage.status ?? '未知'}</p>
              <ul>{leg.fills.map((fill, fillIndex) => <li key={fill.id ?? fillIndex}>成交 {fill.id ?? '编号未知'} · 原订单 {fill.orderId ?? '未知'} · {fill.time ?? '时间未知'} · {fill.quantity ?? '—'} @ {fill.price ?? '—'} {fill.priceCurrency ?? ''} · 费用 {fill.fee ?? '未知'} {fill.feeCurrency ?? ''}</li>)}</ul>
              {leg.evidenceTruncated ? <p>仅展示前 200 笔证据，汇总按全部已读取成交计算。</p> : null}
            </details>)}
          </section>)}
          {data.costs.truncated ? <p>仅展示前 200 个阶段/批次。</p> : null}
        </> : <p>逐批成本仅适用于已结束的 ANT 平仓任务。</p>}
      </> : null}
    </div> : null}
  </details>;
}
