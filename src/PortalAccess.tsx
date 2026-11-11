import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, ApiError } from './api';
import { Callout } from './StateViews';

type Access = { id: string; projectId: string; projectName: string; scope: 'persistent' | 'instance'; expiresAt: string; status: 'active' | 'revoking' };
type AccessState = { schemaVersion: 1; observedAt: string; instanceId: string; externalScope: 'current-api-instance'; truncated: boolean; grants: Access[] };

export default function PortalAccess({ onExpired }: { onExpired: () => void }) {
  const [data, setData] = useState<AccessState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(onExpired); latest.current = onExpired;
  async function load() {
    const current = ++generation.current;
    setBusy('read'); setError('');
    try {
      const result = await api<AccessState>('/api/portal/grants');
      if (mounted.current && current === generation.current) setData(result);
    } catch (reason) {
      if (!mounted.current || current !== generation.current) return;
      if (reason instanceof ApiError && reason.status === 401) latest.current();
      else setError(reason instanceof Error ? reason.message : '模块授权读取失败');
    } finally { if (mounted.current && current === generation.current) setBusy(null); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, []);
  async function revoke(row: Access) {
    const current = ++generation.current;
    setBusy(row.id); setError(''); setNotice('');
    try {
      await api(`/api/portal/grants/${row.id}`, { method: 'DELETE' });
      if (!mounted.current || current !== generation.current) return;
      setData(value => value ? { ...value, grants: value.grants.filter(item => item.id !== row.id) } : value);
      setNotice(`${row.projectName} 的这条授权已撤销；已有连接会关闭，重新打开模块会创建新授权。`);
    } catch (reason) {
      if (!mounted.current || current !== generation.current) return;
      if (reason instanceof ApiError && reason.status === 401) latest.current();
      else setError(reason instanceof Error ? reason.message : '授权撤销未完成，请刷新核对');
    } finally { if (mounted.current && current === generation.current) setBusy(null); }
  }
  return <section className="panel management-panel" aria-label="当前会话模块授权">
    <div className="panel-heading"><h2><ShieldCheck size={18} aria-hidden="true" /> 当前会话模块授权</h2><button className="button secondary" disabled={busy !== null} onClick={() => void load()}>{busy === 'read' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}刷新</button></div>
    <p className="muted">撤销单条授权会关闭对应访问，其余模块授权继续有效。外部自动登录授权仅列出当前 API 实例持有的部分。</p>
    {error ? <Callout tone="error">{error}</Callout> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {data?.grants.map(row => <div className="project-table-row" key={row.id}>
      <div><strong>{row.projectName}</strong><small className="table-time">授权 {row.id.slice(0, 10)}</small></div>
      <div>{row.scope === 'persistent' ? '跨实例有效' : '当前实例有效'}</div>
      <div><span>{row.status === 'revoking' ? '撤销结果待确认' : '有效'}</span><small className="table-time">到期 {new Date(row.expiresAt).toLocaleString('zh-CN')}</small></div>
      <div className="row-actions"><button className="button secondary" disabled={busy !== null} onClick={() => void revoke(row)}>{busy === row.id ? <LoaderCircle size={15} className="spin" /> : null}撤销此授权</button></div>
    </div>)}
    {data && !data.grants.length ? <p className="muted">当前会话没有可管理的模块授权。</p> : null}
    {data?.truncated ? <p className="muted">仅展示前 300 条授权，请处理后刷新。</p> : null}
  </section>;
}
