import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { api, ApiError } from './api';

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
const names: Record<string, string> = { monitor: 'Monitor' };

/** Supervisor state of one built-in module, with the operator restart for a faulted module. */
export default function ModuleRecovery({ moduleId, name, active, onRecovered, onExpired }: { moduleId: string; name: string; active: boolean; onRecovered: () => void; onExpired: () => void }) {
  const [row, setRow] = useState<ModuleRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  // Set by an operator restart; the page reloads once that instance is ready.
  const awaitingReady = useRef(false);
  const latest = useRef({ onRecovered, onExpired });
  latest.current = { onRecovered, onExpired };

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => { timer = setTimeout(() => void read(), delay); };
    async function read() {
      if (document.visibilityState !== 'visible') { schedule(IDLE_MS); return; }
      try {
        const data = await api<{ enabled: boolean; modules: ModuleRow[] }>('/api/system/modules', { signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = data.enabled ? data.modules.find(item => item.moduleId === moduleId) ?? null : null;
        setRow(next);
        if (awaitingReady.current && next?.state === 'ready') { awaitingReady.current = false; latest.current.onRecovered(); }
        schedule(next && (RECOVERING.has(next.state) || next.maintenanceConfirmed === false) ? RECOVERING_MS : IDLE_MS);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) { latest.current.onExpired(); return; }
        schedule(IDLE_MS);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, moduleId, revision]);

  async function restart() {
    setPending(true); setError('');
    try {
      await api(`/api/system/modules/${encodeURIComponent(moduleId)}/restart`, { method: 'POST' });
      awaitingReady.current = true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) { onExpired(); return; }
      // 409 means the module already left fault; the next read shows where it is.
      if (!(reason instanceof ApiError && reason.status === 409)) setError(reason instanceof Error ? reason.message : '恢复请求未完成，请稍后重试');
    } finally {
      setPending(false); setRevision(value => value + 1);
    }
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
    const waiting = row.waitingFor?.length ? `，等待 ${row.waitingFor.map(id => names[id] || id).join('、')} 恢复` : '';
    return <div className="module-recovery notice" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /><p>{name} 正在自动恢复{waiting}，恢复后即可继续使用。</p></div>;
  }
  if (row.state === 'ready' && row.maintenanceConfirmed === false) {
    return <div className="module-recovery notice" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /><p>{name} 已恢复运行，正在确认交易功能，确认前暂不能交易。</p></div>;
  }
  return null;
}
