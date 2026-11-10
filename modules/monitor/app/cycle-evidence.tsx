"use client";
import { useState } from 'react';
import type { CycleEvidence } from '../../../server/cycle-evidence.mjs';

export default function CycleEvidenceView({ evidence }: { evidence: CycleEvidence }) {
  const [page, setPage] = useState(0), size = 20;
  const lastPage = Math.max(0, Math.ceil(evidence.rows.length / size) - 1), current = Math.min(page, lastPage);
  return <details className="related-cycle-note">
    <summary>本轮纳入记录与核对明细（{evidence.totalRows} 条）</summary>
    <p>覆盖 {evidence.coverageStart} — {evidence.coverageEnd} · {evidence.openingFound ? '已找到本轮开仓' : '未找到起点，覆盖不完整'}</p>
    <p>金额是实际纳入汇总的原币分项；排除记录与缺项保持未知。翻仓数量与手续费只含本轮份额。</p>
    <ol start={current * size + 1}>{evidence.rows.slice(current * size, (current + 1) * size).map((row, index) => <li key={`${row.kind}:${row.id}:${index}`}>
      <strong>{row.kind === 'fill' ? '成交' : row.kind === 'funding' ? '资金费' : '结算'} {row.id}</strong> · {row.time} · {row.status === 'included' ? '纳入' : row.status === 'partial' ? '部分纳入' : '排除'}
      {row.kind === 'fill' ? <p>{row.side === 'buy' ? '买入' : row.side === 'sell' ? '卖出' : '买卖方向未知'} · 数量 {row.quantity ?? '—'} @ {row.price ?? '—'} · 本轮平仓量 {row.closingQuantity ?? '未知/未纳入'} · 已实现 {row.realizedPnl ?? '未纳入'} {row.currency ?? ''} · 手续费 {row.fee ?? '未知/未纳入'} {row.feeCurrency ?? ''}{row.fraction ? ` · 本轮比例 ${row.fraction}` : ''}</p> : <p>金额 {row.amount ?? '未纳入'} {row.currency ?? ''}</p>}
      {row.reason ? <p>{row.reason}</p> : null}
    </li>)}</ol>
    {lastPage > 0 ? <div><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button> {current + 1} / {lastPage + 1} <button type="button" disabled={current === lastPage} onClick={() => setPage(current + 1)}>下一页</button></div> : null}
    {evidence.truncated ? <p>当前响应附带 {evidence.rows.length} / {evidence.totalRows} 条证据（受单仓或全局明细预算限制）；汇总使用全部已读取记录，当前明细不足以独立复算全部净额。</p> : null}
  </details>;
}
