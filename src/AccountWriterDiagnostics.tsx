import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { api, ApiError } from './api';
import { parseWriterDiagnostics, type WriterDiagnostics, type WriterModule } from './account-writer-diagnostics';

const moduleNames: Record<WriterModule, string> = { hub: '工作台', aster: 'ASTER', greeks: 'Greeks', crossex: 'CrossEx', other: '其他模块' };
const reasons: Record<string, string> = { 'recovery-quarantine': '恢复隔离', 'authority-retired': '写入权威已退役', 'writer-retired': '当前读取方已退役', 'account-isolated': '账户隔离', 'owner-missing': 'Owner 记录缺失', 'owner-closed': 'Owner 已关闭', 'owner-unknown': 'Owner 状态未知', 'lease-missing': '未观测到租约', 'lease-expired': '租约已过期', 'lease-unknown': '租约状态未知', 'lease-conflict': '其他模块持有租约记录', sending: '请求发送中', 'unknown-result': '写入结果未知' };
const ownerNames = { active: '记录为 active', closed: '已关闭', missing: '记录缺失', unknown: '未知' };
const leaseNames = { active: '采样时截止未到', expired: '已过期', missing: '未观测到', unknown: '未知' };
const isolationNames = { 'legacy-conflict': '历史写入冲突', 'identity-conflict': '身份冲突', 'manual-isolation': '人工隔离', unknown: '原因未知' };
const registryErrors: Record<string, string> = { REGISTRY_MISSING: '注册库或保护标记缺失', REGISTRY_REPLACED: '注册库身份不一致', REGISTRY_BUSY: '注册库忙，请等待下次读取', WRITER_CLOSED: '当前读取方已关闭', INVALID_CLOCK: '诊断时钟异常', INVALID_RECOVERY_STATE: '恢复状态无法校验', UNSUPPORTED_RECOVERY_SCHEMA: '恢复状态版本不受支持', REGISTRY_UNAVAILABLE: '注册库无法读取' };
const formatTime = (value: number | null) => value === null ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
type ReadPhase = 'loading' | 'ready' | 'error' | 'offline' | 'paused';

export default function AccountWriterDiagnostics({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<WriterDiagnostics | null>(null);
  const [phase, setPhase] = useState<ReadPhase>('paused');
  const [refresh, setRefresh] = useState(0);
  const expired = useRef(onExpired);
  expired.current = onExpired;

  useEffect(() => {
    let stopped = false;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const readable = () => active && !document.hidden && navigator.onLine;
    const suspend = () => {
      generation++; clearTimeout(timer); request?.abort(); request = null;
      setPhase(!navigator.onLine ? 'offline' : 'paused');
    };
    const read = async () => {
      if (stopped || !readable() || request) return;
      clearTimeout(timer);
      const controller = new AbortController(); request = controller;
      const version = ++generation;
      setPhase('loading');
      try {
        const result = parseWriterDiagnostics(await api<unknown>('/api/system/accounts', { signal: controller.signal, timeoutMs: 10_000 }));
        if (stopped || controller.signal.aborted || version !== generation) return;
        setSnapshot(result); setPhase('ready');
      } catch (error) {
        if (stopped || controller.signal.aborted || version !== generation) return;
        setPhase('error');
        if (error instanceof ApiError && error.status === 401) { stopped = true; expired.current(); }
      } finally {
        if (request === controller) request = null;
        if (!stopped && version === generation && readable()) timer = setTimeout(() => void read(), 15_000);
      }
    };
    const sync = () => { if (readable()) void read(); else suspend(); };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync); window.addEventListener('offline', sync);
    window.addEventListener('focus', sync); window.addEventListener('pageshow', sync);
    return () => { stopped = true; generation++; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', sync); window.removeEventListener('online', sync); window.removeEventListener('offline', sync); window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync); };
  }, [active, refresh]);

  const current = active && phase === 'ready';
  const status = phase === 'offline' ? '已离线，当前保护状态未知' : phase === 'error' ? '读取失败，当前保护状态未知' : phase === 'paused' ? '读取已暂停' : phase === 'loading' ? '正在读取，等待最新保护证据' : snapshot?.registry === 'disabled' ? '账户写入保护未启用，状态未知' : snapshot?.registry === 'unavailable' ? `${registryErrors[snapshot.errorCode ?? ''] ?? '注册库无法读取'}，状态未知` : '已读取注册库观测记录';
  return <section className="diagnostic-endpoints account-writer-diagnostics" aria-labelledby="account-writer-heading">
    <div className="diagnostic-controls"><h3 id="account-writer-heading"><Shield size={18} aria-hidden="true" /> 账户写入保护</h3><button className="button secondary" disabled={!active || phase === 'loading' || phase === 'offline'} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} />刷新保护诊断</button></div>
    <p role="status" data-writer-status={current ? snapshot?.registry : phase}>{status}</p>
    <p className="diagnostic-explanation">只读展示共享注册库已观测到的记录，不证明账户可写，也不代替模块私有日志与交易所核对。Owner 的 active 仅为持久记录，模块是否在线仍未知。未决数量按账户统计，同一账户的多模块行不能相加。</p>
    {snapshot ? <>
      <p className="diagnostic-explanation">{current ? '本次证据' : '上次证据（当前状态未知）'}：{formatTime(snapshot.generatedAt)} · 完整性：{snapshot.completeness === 'complete' ? '已完整读取注册库范围' : snapshot.completeness === 'truncated' ? '已截断' : '未知'} · 恢复保护：{snapshot.recovery.state === 'normal' ? '未记录全局恢复隔离' : snapshot.recovery.state === 'quarantine' ? '恢复隔离中（开始时间未记录）' : snapshot.recovery.state === 'retired' ? '已退役（时间未记录）' : '未知'}</p>
      {snapshot.truncated ? <p role="note">共 {snapshot.totalRows} 条账户/模块记录，仅显示前 {snapshot.rowLimit} 条；未展示部分的状态未知。</p> : null}
      <div style={{ overflowX: 'auto' }}><table className="diagnostic-table"><caption>模块保护证据</caption><thead><tr><th>模块</th><th>Owner 记录</th><th>最近记录时间</th><th>未验证绑定</th><th>在线状态</th></tr></thead><tbody>{snapshot.modules.map(module => <tr key={module.moduleId}><td>{moduleNames[module.moduleId]}</td><td>{module.ownerEvidence === 'unknown' ? '未知：未读到 Owner 记录' : `${module.activeOwners} active / ${module.closedOwners} 已关闭`}</td><td>{formatTime(module.lastSeenAt)}</td><td>{module.unverifiedBindings ?? '未知'}</td><td>未知</td></tr>)}</tbody></table></div>
      {snapshot.rows.length ? <div style={{ overflowX: 'auto' }}><table className="diagnostic-table"><caption>账户保护原因与观测时间</caption><thead><tr><th>脱敏账户 / 模块</th><th>已观测保护原因</th><th>租约 / Owner</th><th>未决记录</th><th>隔离</th></tr></thead><tbody>{snapshot.rows.map(row => <tr key={`${row.accountRef}:${row.moduleRef}`}><td><code>{row.accountRef}</code><br />{row.authority} / {row.environment}<br />{moduleNames[row.moduleId]}</td><td>{row.reasons.length ? row.reasons.map(reason => reason === 'unverified-binding' ? '同交易所环境未验证绑定：' + row.unverifiedModules.map(module => moduleNames[module]).join('、') : reasons[reason] ?? '未知保护原因').join('；') : '该快照未记录上述保护原因；可写状态未知'}</td><td>{leaseNames[row.lease.state]}<br />截止：{formatTime(row.lease.until)}<br />归属模块：{row.lease.moduleId ? moduleNames[row.lease.moduleId] : '未知'}<br /><code>{row.owner.ref ?? 'Owner 未知'}</code> · {ownerNames[row.owner.state]}<br />最近记录：{formatTime(row.owner.lastSeenAt)}</td><td>发送中 {row.pending.sending} · 结果未知 {row.pending.unknown}<br />最早创建：{formatTime(row.pending.oldestAt)}<br />最近更新：{formatTime(row.pending.latestAt)}</td><td>{row.isolation ? <>{isolationNames[row.isolation.reason]}<br />开始：{formatTime(row.isolation.since)}</> : '未记录账户隔离'}</td></tr>)}</tbody></table></div> : <p>{snapshot.registry === 'available' ? '注册库尚无可关联的账户记录；账户保护状态未知。' : '没有可读取的账户保护证据。'}</p>}
    </> : null}
  </section>;
}
