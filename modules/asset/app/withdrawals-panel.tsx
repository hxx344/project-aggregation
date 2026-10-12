'use client';
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { embeddedWithdrawals } from '@/lib/withdrawals';
import type { Ledger, Withdrawal } from '@/lib/types';

type Mutate = (path: string, method: string, body: unknown, onSuccess: () => void) => Promise<void>;
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function WithdrawalsPanel({ ledger, today, busy, error, mutate, clearError }: { ledger: Ledger; today: string; busy: boolean; error: string; mutate: Mutate; clearError: () => void }) {
  const [draft, setDraft] = useState<{ id: string; editing: boolean; date: string; amount: string; note: string } | null>(null);
  const [removing, setRemoving] = useState<Withdrawal | null>(null);
  const open = (row?: Withdrawal) => {
    clearError();
    setDraft({ id: row?.id ?? crypto.randomUUID(), editing: !!row, date: row?.date ?? today, amount: row ? String(row.amount) : '', note: row?.note ?? '' });
  };
  return <>
    <div className="notice">原表“出金”已作为累计出金计入，当前为 $ {money(embeddedWithdrawals(ledger.assets))}。这里只登记原表基准日 {ledger.baselineDate} 之后尚未计入的新增出金；同日新增也可登记。新增记录会自动加入总览表内总额及资产明细的出金数量和估值，请勿再手动加到原表“出金”行。</div>
    <section className="panel holdings">
      <div className="holdings-heading"><div><h2>新增出金记录 <span>{ledger.withdrawals.length}</span></h2><p className="help">金额使用出金时的美元价值；账户间内部转账不记出金。</p></div><button className="button primary" disabled={busy} onClick={() => open()}><Plus size={16}/>登记出金</button></div>
      {ledger.withdrawals.length ? <Table><TableHeader><TableRow><TableHead>日期（北京时间）</TableHead><TableHead className="numeric">金额 / USD</TableHead><TableHead>备注</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{[...ledger.withdrawals].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).map(row => <TableRow key={row.id}><TableCell>{row.date}</TableCell><TableCell className="numeric">{money(row.amount)}</TableCell><TableCell className="withdrawal-note">{row.note || '—'}</TableCell><TableCell><div className="row-actions"><button className="icon-button" disabled={busy} aria-label={'编辑 ' + row.date + ' 出金 ' + row.amount} onClick={() => open(row)}><Pencil size={16}/></button><button className="icon-button" disabled={busy} aria-label={'删除 ' + row.date + ' 出金 ' + row.amount} onClick={() => { clearError(); setRemoving(row); }}><Trash2 size={16}/></button></div></TableCell></TableRow>)}</TableBody></Table> : <div className="empty-state">尚未登记新增出金。原表中的累计出金已自动纳入统计。</div>}
    </section>
    <p className="help section-note">登记不会改动持仓或再次扣减账户余额。交易所余额由同步更新；手动资产需先更新实际剩余金额。补录、修改或删除出金后，对应日期起的调整曲线会重新计算，原始历史总额保持不变。</p>
    <Dialog open={!!draft} onOpenChange={open => { if (!open && !busy) setDraft(null); }}><DialogContent className="withdrawal-dialog"><DialogHeader><DialogTitle>{draft?.editing ? '修改出金记录' : '登记出金'}</DialogTitle><DialogDescription>仅调整统计口径。请先确认当前资产已反映这笔出金。</DialogDescription></DialogHeader>{draft && <form className="form-grid" onSubmit={event => {
      event.preventDefault();
      void mutate('/api/withdrawals', draft.editing ? 'PATCH' : 'POST', { id: draft.id, date: draft.date, amount: Number(draft.amount), note: draft.note }, () => setDraft(null));
    }}>
      <label>出金日期（北京时间）<input type="date" required min={ledger.baselineDate} max={today} value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })}/></label>
      <label>出金金额 / USD<input type="number" required min="0.01" max="1000000000000" step="0.01" inputMode="decimal" value={draft.amount} onChange={event => setDraft({ ...draft, amount: event.target.value })}/></label>
      <label>备注（可选）<input maxLength={200} placeholder="例如：转至个人银行账户" value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })}/></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存' : '保存出金'}</button></div>
    </form>}</DialogContent></Dialog>
    <Dialog open={!!removing} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>删除出金记录</DialogTitle><DialogDescription>删除 {removing?.date} 的 $ {money(removing?.amount ?? 0)} 出金后，相关调整曲线会重新计算，账户余额保持不变。</DialogDescription></DialogHeader>{error && <p className="error-text" role="alert">{error}</p>}<div className="form-actions"><button className="button" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => void mutate('/api/withdrawals', 'DELETE', { id: removing?.id }, () => setRemoving(null))}>确认删除</button></div></DialogContent></Dialog>
  </>;
}
