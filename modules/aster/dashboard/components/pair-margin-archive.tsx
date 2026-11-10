'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type Entry = { request_id: string; original: { amount: string | null; source: string | null; destination: string | null; created_at: number | null }; basis: string; shared_outcome: string; settled_at: number | null; receipts: { side: string; kind: string; transaction_id: string }[]; notes: { id: string; at: number; actor: string; note: string; source: string }[] };
type Archive = { items: Entry[]; next: string | null; notice: string; unavailable?: number };
const when = (at: number | null) => at ? new Date(at * 1000).toLocaleString('zh-CN') : '未知';

export function PairMarginArchive({ pairId }: { pairId: string }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Archive | null>(null), [cursor, setCursor] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [target, setTarget] = useState(''), [note, setNote] = useState(''), [source, setSource] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setData(null); setError('');
    void fetch(`/api/pairs/${encodeURIComponent(pairId)}/margin-archive?before=${encodeURIComponent(cursor)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => { if (!response.ok) throw new Error('归档读取失败，到账结果未知'); return response.json() as Promise<Archive>; })
      .then(value => { if (!controller.signal.aborted) setData(value); }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message)); });
    return () => controller.abort();
  }, [pairId, cursor, open, revision]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/pairs/${encodeURIComponent(pairId)}/margin-archive/${encodeURIComponent(target)}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, source }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('备注保存失败，请重新读取核对');
      setNote(''); setSource(''); setTarget(''); setRevision(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>划转归档核对</summary>
    <p>只读原请求与已存证据；人工备注不修改回执、不解除保护、不重发划转。</p>
    {error ? <p role="alert">{error}</p> : null}
    {data ? <><p>{data.notice}</p>{data.unavailable ? <p>本页另有 {data.unavailable} 条归档无法核实当前账户绑定或超过读取上限，证据未知，不展示原账户内容。</p> : null}{data.items.length ? data.items.map(item => <article key={item.request_id}>
      <strong>{item.request_id}</strong><p>{when(item.original.created_at)} · {item.original.source ?? '未知'} → {item.original.destination ?? '未知'} · {item.original.amount ?? '未知'} USD1</p>
      <p>{item.basis} · 共享结果：{item.shared_outcome} · 证据时间：{when(item.settled_at)}</p>
      <p>{item.receipts.length ? item.receipts.map(receipt => `${receipt.side} ${receipt.kind} ${receipt.transaction_id}`).join('；') : '未取得可展示回执，结果未知'}</p>
      {item.notes.map(entry => <p key={entry.id}>人工核对 · {entry.actor} · {when(entry.at)}：{entry.note}（来源：{entry.source}）</p>)}
      <Button variant="outline" onClick={() => { setTarget(item.request_id); setNote(''); setSource(''); }}>记录核对备注</Button>
    </article>) : <p>本页没有当前配对的归档记录。</p>}
      {data.next ? <Button variant="outline" onClick={() => setCursor(data.next!)}>下一页</Button> : null}
      {cursor ? <Button variant="outline" onClick={() => setCursor('')}>返回第一页</Button> : null}</> : open && !error ? <p>正在读取归档…</p> : null}
    {target ? <form onSubmit={event => { event.preventDefault(); void save(); }}><p>原请求：{target}</p>
      <label>核对说明<input required maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
      <label>证据来源（勿填写凭据）<input required maxLength={200} value={source} onChange={event => setSource(event.target.value)} /></label>
      <Button disabled={busy} type="submit">保存人工备注</Button></form> : null}
  </details>;
}
