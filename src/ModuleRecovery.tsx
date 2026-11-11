import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { api, ApiError } from './api';
import { useLiveResource } from './use-live-resource';

type ModuleRow = {
  moduleId: string;
  state: 'starting' | 'ready' | 'draining' | 'backoff' | 'fault' | 'stopping' | 'stopped';
  consecutiveFailures: number;
  faultReason: 'failures' | 'process-tree' | null;
  waitingFor: string[] | null;
  maintenanceConfirmed: boolean | null;
};

// Status reads are cheap and local; poll faster only while the module recovers.
const IDLE_MS = 15_000;
const RECOVERING_MS = 2_000;
const RECOVERING = new Set(['starting', 'draining', 'backoff']);
// Same display names as server/modules/catalog.mjs.
const names: Record<string, string> = { monitor: 'Market Monitor', asset: 'Asset Ledger', crossex: 'Gate CrossEx', greeks: 'Greeks', aster: 'Aster 5x' };

/** Supervisor state of one built-in module, with the operator restart for a faulted module. */
export default function ModuleRecovery({ moduleId, name, active, onRecovered, onExpired }: { moduleId: string; name: string; active: boolean; onRecovered: () => void; onExpired: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Set by an operator restart; the page reloads once that instance is ready.
  const awaitingReady = useRef(false);
  const latest = useRef(onRecovered);
  latest.current = onRecovered;
  // The interval follows the last read row; read failures stay silent and retry on that interval.
  const [recovering, setRecovering] = useState(false);
  const status = useLiveResource<{ enabled: boolean; modules: ModuleRow[] }>('/api/system/modules', { intervalMs: recovering ? RECOVERING_MS : IDLE_MS, timeoutMs: 15_000, enabled: active, onExpired });
  const rows = status.data?.enabled ? status.data.modules : [];
  const row = rows.find(item => item.moduleId === moduleId);
  const nextRecovering = !!row && (RECOVERING.has(row.state) || row.maintenanceConfirmed === false);
  useEffect(() => { setRecovering(nextRecovering); }, [nextRecovering]);
  // Every successful read publishes a new object, so this runs once per read.
  useEffect(() => {
    if (awaitingReady.current && row?.state === 'ready') { awaitingReady.current = false; latest.current(); }
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function restart() {
    setPending(true); setError('');
    try {
      await api(`/api/system/modules/${encodeURIComponent(moduleId)}/restart`, { method: 'POST' });
      awaitingReady.current = true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) { setPending(false); onExpired(); return; }
      // 409 means the module already left fault; the next read shows where it is.
      if (!(reason instanceof ApiError && reason.status === 409)) setError(reason instanceof Error ? reason.message : '恢复请求未完成，请稍后重试');
    }
    setPending(false); void status.refresh();
  }

  if (!row) return null;
  if (row.state === 'fault') {
    const cause = row.faultReason === 'process-tree' ? '旧进程未能结束，为避免与新实例同时运行，已停止自动重启。' : `连续 ${row.consecutiveFailures} 次启动失败或运行不足 10 分钟即退出，已停止自动重启。`;
    return <div className="error-box original-page-error module-recovery" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <div><strong>{name} 已停止运行</strong><p>{cause}其他模块不受影响。确认原因后可以重新启动；如果仍然失败，请查看服务器日志。</p>{error ? <p>{error}</p> : null}</div>
      <button className="button secondary" disabled={pending} onClick={() => void restart()}>{pending ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}重新启动模块</button>
    </div>;
  }
  if (RECOVERING.has(row.state)) {
    const stopped = (row.waitingFor || []).filter(id => rows.find(item => item.moduleId === id)?.state === 'fault').map(id => names[id] || id);
    if (stopped.length) return <div className="module-recovery notice" role="status"><CircleAlert size={15} aria-hidden="true" /><p>{name} 需要 {stopped.join('、')} 才能恢复，但 {stopped.join('、')} 已停止运行，请先在 {stopped.join('、')} 页面重新启动。</p></div>;
    const waiting = row.waitingFor?.length ? `，等待 ${row.waitingFor.map(id => names[id] || id).join('、')} 恢复` : '';
    return <div className="module-recovery notice" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /><p>{name} 正在自动恢复{waiting}，恢复后即可继续使用。</p></div>;
  }
  if (row.state === 'ready' && row.maintenanceConfirmed === false) {
    return <div className="module-recovery notice" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /><p>{name} 已恢复运行，正在确认交易功能，确认前暂不能交易。</p></div>;
  }
  return null;
}
