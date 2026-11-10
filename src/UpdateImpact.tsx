import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import type { UpdateDeployMode, UpdatePhase } from './update-types';

type Impact = { schemaVersion: 1; planId: string; deployMode: UpdateDeployMode; phase: UpdatePhase; scope: 'api' | 'full'; observedAt: string;
  effect: 'prepare-only' | 'api-reconnect' | 'module-restart'; evidence: null | { observedAt: string; modules: { moduleId: string; busy: boolean | null; observedAt: string;
    reasonCode: string; activeRequests: number | null; tasks: { id: string | null; status: string }[]; truncated: boolean }[] } };
const names: Record<string, string> = { hub: '原生执行任务', aero: 'Aero 自动调仓', crossex: 'Gate CrossEx', greeks: 'Greeks', aster: 'ASTER' };
const reasons: Record<string, string> = { 'module-busy': '有活动操作或停机条件待核对', 'module-idle': '本次读取未见阻塞', 'module-unavailable': '读取不可达，状态未知',
  'final-order-check-required': '当前在途请求已列出；完整挂单在正式切换时核查', 'native-tasks-active': '存在未结束任务或在途请求',
  'native-idle': '本次读取未见活动任务', 'native-evidence-unavailable': '执行证据不可读，状态未知', 'aero-task-active': 'Aero 任务正在执行', 'aero-idle': '本次读取未见活动任务' };

export default function UpdateImpact({ planId, deployMode, phase, onExpired }: { planId: string; deployMode: UpdateDeployMode; phase: UpdatePhase; onExpired: () => void }) {
  const [data, setData] = useState<Impact | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [clock, setClock] = useState(Date.now);
  const latest = useRef(onExpired); latest.current = onExpired;
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setBusy(true);
    const query = new URLSearchParams({ planId, deployMode, phase });
    void api<Impact>(`/api/system/updates/impact?${query}`, { signal: controller.signal, timeoutMs: 25_000 }).then(result => {
      if (controller.signal.aborted) return;
      if (result.schemaVersion !== 1 || result.planId !== planId || result.deployMode !== deployMode || result.phase !== phase) throw new Error('更新计划身份不一致，请重新核对');
      setData(result); setClock(Date.now());
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) latest.current();
      else setError(reason instanceof Error ? reason.message : '更新影响读取失败');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [planId, deployMode, phase, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setClock(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);
  const stale = (stamp: string) => !Number.isFinite(Date.parse(stamp)) || clock - Date.parse(stamp) > 15_000 || Date.parse(stamp) - clock > 5000;
  return <section className="update-review" aria-label="更新实时影响">
    <h3>实时影响与活动任务</h3>
    <button className="button secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}重新核对</button>
    {error ? <p role="alert">{error}；当前影响未知。</p> : null}
    {data?.effect === 'prepare-only' ? <p>本阶段仅准备版本，交易与行情继续运行，不进入维护。</p> : data?.effect === 'api-reconnect' ? <p>仅 API 连接短暂重连，运行时与交易任务继续运行。</p> : data ? <>
      {!data.evidence ? <p role="status">运行时不可达，活动任务与阻塞状态未知。</p> : <ul>{data.evidence.modules.map(row => <li key={row.moduleId}>
        <strong>{names[row.moduleId] ?? row.moduleId}：</strong>{stale(row.observedAt) ? '读取已过期，状态未知' : reasons[row.reasonCode] ?? '状态未知'}
        {row.activeRequests !== null ? ` · 在途 ${row.activeRequests}` : ''}
        {row.tasks.length ? <span> · 任务 {row.tasks.map(task => `${task.id?.slice(0, 8) ?? '未知编号'}（${task.status}）`).join('、')}{row.truncated ? '，其余任务未展开' : ''}</span> : null}
        <small> · {new Date(row.observedAt).toLocaleTimeString('zh-CN')}</small>
      </li>)}</ul>}
    </> : null}
    <p className="muted">这里只展示当前观察结果；正式切换仍会重新核查活动任务和完整委托。</p>
  </section>;
}
