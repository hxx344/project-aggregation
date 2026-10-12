'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { Ledger } from '@/lib/types';

type Summary = { source: string; rows: number; periods: number; baselineDate: string; baselineTotal: number; resultingRows: number; retained: string[] };
type Result = { ledger?: Ledger; summary?: Summary; error?: string; alreadyImported?: boolean };
export function ImportLedgerDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (ledger: Ledger) => void }) {
  const [source, setSource] = useState<unknown>(), [summary, setSummary] = useState<Summary>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function send(data: unknown, apply: boolean) {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: data, apply }) });
    const result: Result = await response.json();
    if (!response.ok) throw new Error(result.error || '导入失败，已有数据保持不变');
    return result;
  }
  async function preview(file?: File) {
    setSource(undefined); setSummary(undefined); setError('');
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5 MB');
      const data: unknown = JSON.parse(await file.text());
      const result = await send(data, false);
      if (result.alreadyImported && result.ledger) { onImported(result.ledger); onOpenChange(false); toast.success('这份原表已导入，保留当前修改'); return; }
      setSource(data); setSummary(result.summary);
    } catch (cause) { setError(cause instanceof SyntaxError ? '请选择从原表生成的 JSON 导入文件' : cause instanceof Error ? cause.message : '无法读取导入文件'); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const result = await send(source, true);
      if (!result.ledger) throw new Error('未收到导入结果，请重新打开账本核实');
      onImported(result.ledger); onOpenChange(false); toast.success('原表已导入，旧数据已自动备份');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败，请重试'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent><DialogHeader><DialogTitle>导入原表数据</DialogTitle><DialogDescription>选择从《资产统计.xlsx》生成的 JSON 文件，先核对内容，再导入到当前账本。</DialogDescription></DialogHeader>
    <div className="form-grid"><label>原表导入文件（JSON）<input type="file" accept=".json,application/json" disabled={busy} onChange={event => void preview(event.target.files?.[0])}/></label>
      {summary && <div className="import-summary"><strong>{summary.source}</strong><p>{summary.rows} 条资产 · {summary.periods} 期原表记录</p><p>起始持仓：{summary.baselineDate}</p><p>原表合计：$ {summary.baselineTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p><p>导入后共 {summary.resultingRows} 条资产</p>{summary.retained.length > 0 && <p>保留：{summary.retained.join('、')}</p>}</div>}
      <p className="help">已有手动修改、只读 API 连接及同步余额会保留。导入前自动备份；旧示例快照保留在历史记录，不参与真实资产曲线。当前估值会随实时行情变化。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="form-actions"><button className="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</button><button className="button primary" disabled={busy || !summary} onClick={() => void apply()}>{busy ? '正在处理…' : '导入并保留已有修改'}</button></div>
    </div></DialogContent></Dialog>;
}
