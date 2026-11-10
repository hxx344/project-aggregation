import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { api, ApiError } from './api';

export default function UpdateDiagnostic({ jobId, onExpired }: { jobId: string; onExpired: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [jobId]);
  async function download() {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await api<{ schemaVersion: number; jobId: string }>(`/api/system/updates/jobs/${jobId}/diagnostic`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.schemaVersion !== 1 || result.jobId !== jobId) throw new Error('任务身份不一致，未导出诊断');
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `update-${jobId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) onExpired();
      else setError(reason instanceof Error ? reason.message : '诊断导出失败');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="update-footnote"><button className="button secondary" disabled={busy} onClick={() => void download()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}导出本次失败诊断</button><p>包含本任务的版本、阶段和已记录服务状态；未记录的健康或回滚结果标为未知。</p>{error ? <p role="alert">{error}</p> : null}</div>;
}
