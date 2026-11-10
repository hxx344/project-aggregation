'use client';
import { useEffect, useRef, useState } from 'react';
import { requestJson } from '@/lib/client-request';
import { businessDay, cashFlowEvidence, type CashFlowInput, type CashFlowRecord } from '@/lib/cash-flows';

function AuditTrail({ id, audit }: { id: string; audit: CashFlowRecord[] }) {
  return <details><summary>完整审计历史</summary><ul>{audit.filter(item => item.id === id).map(item => <li key={item.revision}>v{item.revision} · {item.recordedAt} · {item.date} · {item.account} · {item.amount} {item.currency} · {item.kind} · {item.transferId ?? '无配对编号'} · USD 汇率 {item.usdRate ?? '未知'} / {item.rateAt ?? '无时间'} · {item.reference} · {item.reason}{item.void ? ' · 已作废' : ''}</li>)}</ul></details>;
}

export default function CashFlowsPanel({ onSaved }: { onSaved: () => void }) {
  const [audit, setAudit] = useState<CashFlowRecord[] | null>(null), [draft, setDraft] = useState<CashFlowInput | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0), [page, setPage] = useState(0);
  const generation = useRef(0), reading = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(), request = ++generation.current; reading.current = controller;
    requestJson<CashFlowRecord[]>('/api/cash-flows', { signal: controller.signal }).then(value => { if (!controller.signal.aborted && generation.current === request) { setAudit(value); setError(''); } })
      .catch(error => { if (!controller.signal.aborted && generation.current === request) setError(error instanceof Error ? error.message : '资金流读取失败'); });
    return () => controller.abort();
  }, [attempt]);
  const edit = (value: Partial<CashFlowInput>) => setDraft(previous => previous ? { ...previous, ...value } : previous);
  async function save() {
    if (!draft || busy) return;
    generation.current++; reading.current?.abort();
    setBusy(true); setError('');
    try {
      const value = await requestJson<CashFlowRecord[]>('/api/cash-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      setAudit(value); setDraft(null); onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : '保存未确认，请重新读取核对'); }
    finally { setBusy(false); }
  }
  const rows = audit ? cashFlowEvidence(audit).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const voided = [...new Map((audit ?? []).map(row => [row.id, row])).values()].filter(row => row.void);
  const lastPage = Math.max(0, Math.ceil(rows.length / 20) - 1), current = Math.min(page, lastPage);
  return <section aria-label="净资金流标注">
    <h4>净资金流标注</h4><p className="performance-note">账户用稳定、可辨认的标识；日期按北京时间。正数为流入、负数为流出。仅标注已有凭证，不会转账或修改余额。内部转账使用相同配对编号，单侧、重复候选或跨日保持待配对。旧出金登记独立保留。</p>
    {error ? <p role="alert" className="error-text">{error} <button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取</button></p> : null}
    <button type="button" disabled={busy || audit === null} onClick={() => setDraft({ id: crypto.randomUUID(), revision: 0, date: businessDay(Date.now()), account: '', currency: 'USD', amount: '', kind: 'external', transferId: null, usdRate: null, rateAt: null, reference: '', reason: '', void: false })}>登记资金流</button>
    {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <label>业务日期<input type="date" required value={draft.date} onChange={event => edit({ date: event.target.value })}/></label>
        <label>账户标识<input maxLength={80} required value={draft.account} onChange={event => edit({ account: event.target.value })}/></label>
        <label>币种<input maxLength={20} required value={draft.currency} onChange={event => edit({ currency: event.target.value.toUpperCase(), usdRate: null, rateAt: null })}/></label>
        <label>原币金额（流出为负）<input inputMode="decimal" maxLength={35} required value={draft.amount} onChange={event => edit({ amount: event.target.value })}/></label>
        <label>类型<select value={draft.kind} onChange={event => edit({ kind: event.target.value as CashFlowInput['kind'], transferId: event.target.value === 'internal' ? '' : null })}><option value="external">外部入出金</option><option value="internal">内部转账</option></select></label>
        {draft.kind === 'internal' ? <label>内部转账配对编号<input required maxLength={80} value={draft.transferId ?? ''} onChange={event => edit({ transferId: event.target.value })}/></label> : null}
        {draft.currency !== 'USD' ? <><label>每单位币种折 USD（未知留空）<input inputMode="decimal" value={draft.usdRate ?? ''} onChange={event => edit({ usdRate: event.target.value || null, rateAt: event.target.value ? draft.rateAt ?? new Date().toISOString() : null })}/></label><label>汇率证据时间（ISO，含时区）<input value={draft.rateAt ?? ''} onChange={event => edit({ rateAt: event.target.value || null })}/></label></> : null}
        <label>原始凭证引用<input required maxLength={200} value={draft.reference} onChange={event => edit({ reference: event.target.value })}/></label>
        <label>登记或修改原因<input required maxLength={200} value={draft.reason} onChange={event => edit({ reason: event.target.value })}/></label>
        {draft.revision > 0 ? <label><input type="checkbox" checked={draft.void} onChange={event => edit({ void: event.target.checked })}/>作废本条（保留历史）</label> : null}
        <button type="submit">{busy ? '保存中…' : '保存标注'}</button><button type="button" onClick={() => setDraft(null)}>取消</button>
      </fieldset>
    </form> : null}
    {audit === null && !error ? <p role="status">读取资金流标注…</p> : null}
    <ol start={current * 20 + 1}>{rows.slice(current * 20, (current + 1) * 20).map(row => <li key={row.id}>
      {row.date} · {row.account} · {row.amount} {row.currency} · {row.status === 'paired' ? '已配对，净贡献 0' : row.status === 'pending' ? '待配对' : `外部资金流 USD ${row.usdValue ?? '未知'}`} · {row.reference}
      {row.note ? <p>{row.note}</p> : null}
      <button type="button" disabled={busy} onClick={() => { const { status: _status, usdValue: _usd, note: _note, recordedAt: _at, ...input } = row; setDraft({ ...input, reason: '' }); }}>修改/作废</button>
      <AuditTrail id={row.id} audit={audit ?? []}/>
    </li>)}</ol>
    {lastPage ? <p><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button> {current + 1}/{lastPage + 1} <button type="button" disabled={current === lastPage} onClick={() => setPage(current + 1)}>下一页</button></p> : null}
    {voided.length ? <details><summary>作废审计记录</summary><ul>{voided.map(row => <li key={row.id}>{row.id} v{row.revision} · {row.recordedAt} · {row.account} {row.amount} {row.currency} · {row.reason}<AuditTrail id={row.id} audit={audit ?? []}/></li>)}</ul></details> : null}
  </section>;
}
