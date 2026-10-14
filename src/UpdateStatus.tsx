import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, CircleAlert, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from './api';
import type { UpdateJob, UpdateModule, UpdateState, UpdateProgress, CombinedProgress } from './update-types';
import { calculateCombinedProgress } from './update-progress';
import './updates.css';

const STREAM_TIMEOUT = 45_000;
type RequestKind = 'read' | 'check' | 'apply' | 'token';
const moduleLabels = { current: '已是最新', available: '可更新', unavailable: '检查未完成', unmanaged: '需手动更新' };
const jobLabels = { queued: '更新已排队', running: '正在更新', succeeded: '更新已完成', failed: '上次更新未完成', interrupted: '上次更新已中断' };
const stepLabels = { pending: '等待', running: '进行中', succeeded: '已完成', failed: '失败', skipped: '已跳过' };
const running = (job: UpdateJob | null | undefined) => job?.status === 'queued' || job?.status === 'running';
const unfinished = (job: UpdateJob | null | undefined) => job?.status === 'failed' || job?.status === 'interrupted';
const validState = (value: UpdateState) => value && typeof value.enabled === 'boolean' && typeof value.checking === 'boolean' && Array.isArray(value.modules);
function matchesLatest(module: UpdateModule): boolean | null {
  if (module.currentCommit || module.latestCommit) {
    return module.currentCommit && module.latestCommit ? module.currentCommit === module.latestCommit : null;
  }
  return module.currentVersion && module.latestVersion ? module.currentVersion === module.latestVersion : null;
}
function dateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
function Version({ version, commit }: { version: string | null; commit: string | null }) {
  return <span className="update-version"><strong>{version || (commit ? commit.slice(0, 8) : '尚未识别')}</strong>{version && commit ? <small>{commit.slice(0, 8)}</small> : null}</span>;
}
function ModuleRow({ module, unfinishedJob }: { module: UpdateModule; unfinishedJob: boolean }) {
  const match = matchesLatest(module);
  const unconfirmed = module.state === 'current' && match !== true;
  const aligned = module.state === 'current' && match === true && unfinishedJob;
  const recovery = module.state === 'available' && module.recovery === true;
  const label = unconfirmed ? match === false ? '版本不同' : '版本待确认' : aligned ? '版本已对齐' : recovery ? '待完成更新' : moduleLabels[module.state];
  return <li className="update-module">
    <div className="update-module-heading"><h3>{module.name}</h3><span className={`update-tag ${unconfirmed ? 'unavailable' : aligned ? '' : module.state}`}>{label}</span></div>
    <div className="update-versions"><div><span>当前版本</span><Version version={module.currentVersion} commit={module.currentCommit} /></div>{module.latestVersion || module.latestCommit ? <><ArrowRight size={16} aria-hidden="true" /><div><span>最新正式版</span><Version version={module.latestVersion} commit={module.latestCommit} /></div></> : null}</div>
    {module.reason ? <p className="update-module-note">{module.reason}</p> : null}
    {module.latestVersion || module.latestCommit ? module.releaseNotes ? <details className="update-release-notes"><summary>该版本更新内容</summary><p>{module.releaseNotes}</p></details> : <p className="update-module-note">该版本未提供更新内容。</p> : null}
  </li>;
}
function JobProgress({ job, modules }: { job: UpdateJob; modules: UpdateModule[] }) {
  const activeName = modules.find(module => module.id === job.activeModule)?.name;
  const failedSteps = job.steps.filter(step => step.status === 'failed');
  const hasFailedSteps = failedSteps.length > 0;

  return <section className={`update-progress ${job.status}`} aria-labelledby="update-progress-title"><div className="update-progress-heading"><h3 id="update-progress-title">{running(job) ? <LoaderCircle size={18} className="spin" /> : job.status === 'succeeded' ? <Check size={18} /> : <CircleAlert size={18} />}{jobLabels[job.status]}</h3><span>{dateTime(job.finishedAt || job.startedAt)}</span></div><p role="status">{job.message || (running(job) && activeName ? `正在处理${activeName}` : unfinished(job) ? hasFailedSteps ? '上次任务有步骤未完成，请查看服务器部署日志。' : '上次任务未完成全部安装与检查。' : '进度会自动更新。')}</p>{unfinished(job) ? <p className="update-progress-note">此处保留上次更新结果，当前版本见下方“本机模块”。</p> : null}{job.steps.length ? <ol className="update-steps" aria-label="更新进度">{job.steps.map(step => <li className={step.status} key={step.id}><span className="update-step-mark" aria-hidden="true">{step.status === 'running' ? <LoaderCircle size={15} className="spin" /> : step.status === 'succeeded' ? <Check size={14} /> : step.status === 'failed' ? <X size={14} /> : <span />}</span><div><strong>{step.name}</strong>{step.message ? <p>{step.message}</p> : null}</div><span>{stepLabels[step.status]}</span></li>)}</ol> : null}{running(job) ? <small className="update-progress-note">可以关闭此面板；更新会继续，重新打开即可查看进度。</small> : null}</section>;
}

function DownloadProgress({ progress }: { progress: CombinedProgress }) {
  return (
    <div className="download-progress">
      <div className="download-progress-header">
        <span className="download-progress-message">{progress.message}</span>
        {progress.speed && (
          <span className="download-progress-speed">{progress.speed}</span>
        )}
      </div>

      <div className="download-progress-bar-container">
        <div
          className="download-progress-bar-fill"
          style={{ width: `${progress.overall * 100}%` }}
        />
      </div>

      <div className="download-progress-footer">
        <span className="download-progress-percent">
          {Math.round(progress.overall * 100)}%
        </span>
        {progress.eta && (
          <span className="download-progress-eta">剩余约 {progress.eta}</span>
        )}
      </div>
    </div>
  );
}

export default function UpdateStatus({ onExpired, onOpen }: { onExpired: () => void; onOpen?: () => void }) {
  const [snapshot, setSnapshot] = useState<UpdateState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [networkError, setNetworkError] = useState('');
  const [checkRequestFailed, setCheckRequestFailed] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const [pending, setPending] = useState<RequestKind | null>(null);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [tokenNotice, setTokenNotice] = useState('');
  const [tokenResultUncertain, setTokenResultUncertain] = useState(false);
  const [removeToken, setRemoveToken] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<{ planId: string; modules: UpdateModule[] } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<CombinedProgress | null>(null);
  const [, setClock] = useState(0);
  const snapshotRef = useRef<UpdateState | null>(null);
  const requestRef = useRef<{ controller: AbortController; kind: RequestKind } | null>(null);
  const stateVersion = useRef(0);
  const sessionExpired = useRef(false);
  const failedCheckAt = useRef<string | null | undefined>(undefined);
  const submittedPlan = useRef<string | null>(null);
  const uncertainRef = useRef<{ previousJobId: string | null; failed: boolean } | null>(null);
  const refreshFallback = useRef<() => void>(() => {});
  const reviewElement = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const progressSourceRef = useRef<EventSource | null>(null);

  const accept = useCallback((data: UpdateState, confirmMissingJob = false) => {
    stateVersion.current++;
    if (data.checking || (failedCheckAt.current !== undefined && data.checkedAt !== failedCheckAt.current)) {
      failedCheckAt.current = undefined;
      setCheckRequestFailed(false);
    }
    const attempt = uncertainRef.current;
    const foundJob = !!data.job && data.job.id !== attempt?.previousJobId;
    if (attempt && (foundJob || (attempt.failed && confirmMissingJob))) {
      if (!foundJob && !running(data.job)) setActionNotice('已恢复连接。未发现新的更新任务，请重新检查版本后再试。');
      uncertainRef.current = null;
      setUncertain(false);
    }
    snapshotRef.current = data;
    setSnapshot(data);
    setUnavailable(false);
    setNetworkError('');
  }, []);

  const request = useCallback(async (kind: RequestKind, value?: string, replaceRead = false) => {
    if (sessionExpired.current) return null;
    if (!navigator.onLine) {
      if (kind === 'token') setTokenError('当前处于离线状态，请恢复连接后再保存。');
      return null;
    }
    if (replaceRead && requestRef.current?.kind === 'read') {
      requestRef.current.controller.abort();
      requestRef.current = null;
    }
    if (requestRef.current) return null;
    const controller = new AbortController();
    requestRef.current = { controller, kind };
    const version = stateVersion.current;
    const previousJobId = snapshotRef.current?.job?.id || null;
    const previousCheckedAt = snapshotRef.current?.checkedAt;
    setPending(kind);
    if (kind === 'check') setActionNotice('');
    if (kind === 'apply') {
      submittedPlan.current = value || null;
      uncertainRef.current = { previousJobId, failed: false };
      setActionNotice('');
    }
    try {
      const data = await api<UpdateState>(`/api/system/updates${kind === 'read' ? '' : `/${kind}`}`, {
        signal: controller.signal,
        ...(kind === 'apply' ? { timeoutMs: 120_000 } : {}),
        ...(kind === 'read' ? {} : { method: 'POST', body: JSON.stringify(kind === 'apply' ? { planId: value } : kind === 'token' ? { token: value } : {}) }),
      });
      if (controller.signal.aborted) return null;
      if (!validState(data)) {
        if (kind === 'token') throw new Error('Token 配置响应无法确认');
        throw new ApiError('更新功能尚未安装', 404);
      }
      if (kind === 'check') {
        failedCheckAt.current = undefined;
        setCheckRequestFailed(false);
      }
      if (kind === 'apply') { uncertainRef.current = null; setUncertain(false); }
      if (kind === 'token') {
        // HTTP success confirms the write even when a newer stream snapshot wins.
        setToken('');
        setRemoveToken(false);
        setTokenError('');
        setTokenResultUncertain(false);
        setTokenNotice(value ? 'Token 已保存，下次检查时生效；已有重试等待会保留。' : 'Token 已移除，下次检查将使用公开访问；已有重试等待会保留。');
      }
      // A stream snapshot received after dispatch is newer than this HTTP response.
      if (version === stateVersion.current) accept(data, kind === 'read');
      return snapshotRef.current;
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (error instanceof ApiError && error.status === 401) { sessionExpired.current = true; onExpired(); return null; }
      if (kind === 'token') {
        const status = error instanceof ApiError ? error.status : 0;
        setTokenNotice('');
        setTokenError(status === 400 ? 'Token 格式不正确，请粘贴 20–255 位字母、数字或下划线。'
          : status === 403 ? '保存未获授权，请刷新页面后重试。'
          : status === 409 ? '正在检查版本或执行更新，请等待完成后再修改 Token。'
          : status === 404 || status === 501 ? '当前更新服务暂不支持 Token 配置，请在服务器上重新运行原一键部署命令升级。'
          : status >= 400 && status < 500 ? 'Token 配置未保存，请刷新页面后重试。'
          : '保存结果尚未确认，请先刷新配置状态核对，确认后再操作。');
        setTokenResultUncertain(!status || status >= 500 && status !== 501);
        return null;
      }
      if (kind === 'read' && version !== stateVersion.current) return snapshotRef.current;
      const latest = snapshotRef.current;
      if (kind === 'check' && version !== stateVersion.current && (latest?.checking || latest?.checkedAt !== previousCheckedAt)) return latest;
      if (kind === 'apply' && latest?.job && latest.job.id !== previousJobId) {
        uncertainRef.current = null; setUncertain(false); return latest;
      }
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        setUnavailable(true);
        setNetworkError('');
      } else if (kind === 'apply' && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // A definite rejection did not accept this attempt. Checks may reuse the
        // same valid plan, so only unresolved or accepted attempts stay locked.
        submittedPlan.current = null;
        uncertainRef.current = null;
        setUncertain(false);
        setActionNotice(error.message);
        setReview(null);
      } else {
        if (kind === 'check') { failedCheckAt.current = snapshotRef.current?.checkedAt || null; setCheckRequestFailed(true); }
        if (kind === 'apply') { uncertainRef.current = { previousJobId, failed: true }; setUncertain(true); setReview(null); }
        setNetworkError(kind === 'check' ? '检查失败，暂时无法连接更新服务。' : kind === 'apply' || running(snapshotRef.current?.job) ? '连接暂时中断，正在重连并核实更新进度。' : '暂时无法连接更新服务，正在重连。');
      }
      return null;
    } finally {
      if (requestRef.current?.controller === controller) { requestRef.current = null; if (!controller.signal.aborted) setPending(null); }
    }
  }, [accept, onExpired]);

  useEffect(() => () => { requestRef.current?.controller.abort(); requestRef.current = null; }, []);

  // Subscribe to download progress via SSE
  useEffect(() => {
    const shouldSubscribe = running(snapshot?.job);

    if (!shouldSubscribe) {
      if (progressSourceRef.current) {
        progressSourceRef.current.close();
        progressSourceRef.current = null;
      }
      setDownloadProgress(null);
      return;
    }

    // Don't resubscribe if already connected
    if (progressSourceRef.current) return;

    const eventSource = new EventSource('/api/system/updates/progress');
    progressSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const raw: UpdateProgress = JSON.parse(event.data);

        if (raw.error) {
          setDownloadProgress(null);
          return;
        }

        const combined = calculateCombinedProgress(raw);
        setDownloadProgress(combined);

        // Close stream on completion
        const isComplete = raw.stage === 'switch' && raw.progress >= 1.0;
        if (isComplete) {
          eventSource.close();
          progressSourceRef.current = null;
          // Clear progress after a brief delay to show 100%
          setTimeout(() => setDownloadProgress(null), 1000);
        }
      } catch (error) {
        // Invalid progress data, ignore
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      progressSourceRef.current = null;
      setDownloadProgress(null);
    };

    return () => {
      eventSource.close();
      progressSourceRef.current = null;
    };
  }, [snapshot?.job]);

  useEffect(() => {
    let disposed = false;
    let ticking = false;
    let stream: EventSource | null = null;
    let streamLive = false;
    let receivedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (disposed || ticking) return;
      ticking = true;
      clearTimeout(timer);
      try {
        if (navigator.onLine && (!streamLive || uncertainRef.current?.failed)) await request('read');
      } finally {
        ticking = false;
        const active = snapshotRef.current?.checking || running(snapshotRef.current?.job) || uncertainRef.current;
        if (!disposed) timer = setTimeout(() => void tick(), active ? 2_000 : 15_000);
      }
    };
    const disconnect = () => { stream?.close(); stream = null; streamLive = false; clearTimeout(retry); };
    const failed = () => {
      const wasLive = streamLive;
      disconnect();
      if (wasLive) void tick();
      if (!disposed && navigator.onLine && !sessionExpired.current) retry = setTimeout(connect, 10_000);
    };
    const connect = () => {
      disconnect();
      if (disposed || !navigator.onLine || sessionExpired.current) return;
      receivedAt = performance.now();
      try {
        const current = new EventSource('/api/system/updates/events');
        stream = current;
        current.onmessage = event => {
          if (disposed || stream !== current || sessionExpired.current) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'snapshot' && validState(message.state)) {
              accept(message.state);
              streamLive = true;
            } else if (message.type !== 'heartbeat') throw new Error('Invalid update event');
            receivedAt = performance.now();
          } catch { failed(); }
        };
        current.onerror = () => { if (!disposed && stream === current) failed(); };
      } catch { failed(); }
    };
    const resume = () => {
      if (!navigator.onLine || disposed) return;
      if (!stream || performance.now() - receivedAt >= STREAM_TIMEOUT) connect();
      if (resumeTimer !== undefined) return;
      const previousRead = requestRef.current;
      // Reuse reads started during the grace period; replace only the old read.
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined;
        if (!disposed && navigator.onLine && !streamLive) {
          void request('read', undefined, previousRead !== null && requestRef.current === previousRead);
        }
      }, 1000);
    };
    const visible = () => { if (!document.hidden) resume(); };
    const offline = () => {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
      disconnect();
      if (requestRef.current?.kind === 'read') { requestRef.current.controller.abort(); requestRef.current = null; setPending(null); }
      setNetworkError('暂时无法连接更新服务，正在重连。');
    };
    refreshFallback.current = () => void tick();
    void tick();
    connect();
    const health = setInterval(() => {
      if (navigator.onLine && stream && performance.now() - receivedAt >= STREAM_TIMEOUT) failed();
    }, 5_000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      disposed = true; disconnect(); clearTimeout(timer); clearTimeout(resumeTimer); clearInterval(health);
      refreshFallback.current = () => {};
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline); window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume);
    };
  }, [accept, request]);

  const active = !!snapshot?.checking || running(snapshot?.job) || uncertain;
  useEffect(() => { if (active) refreshFallback.current(); }, [active]);

  useEffect(() => {
    const expiresIn = snapshot?.expiresAt ? Date.parse(snapshot.expiresAt) - Date.now() : 0;
    if (expiresIn <= 0 || !Number.isFinite(expiresIn)) return;
    const timer = setTimeout(() => setClock(value => value + 1), Math.min(expiresIn, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [snapshot?.expiresAt]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, [open]);
  useEffect(() => {
    if (!review) return;
    reviewElement.current?.focus({ preventScroll: true });
    reviewElement.current?.scrollIntoView({ block: 'nearest' });
  }, [review]);

  const modules = snapshot?.modules || [];
  const changes = modules.filter(module => module.state === 'available');
  const recoveries = changes.filter(module => module.recovery === true);
  const unfinishedJob = unfinished(snapshot?.job);
  const lastUpdateIssue = unfinishedJob && snapshot?.job ? jobLabels[snapshot.job.status] : '';
  const incomplete = modules.some(module => module.state === 'unavailable' || module.state === 'unmanaged');
  const different = modules.some(module => module.state === 'current' && matchesLatest(module) === false);
  const unconfirmed = modules.some(module => module.state === 'current' && matchesLatest(module) === null);
  const checking = !!snapshot?.checking || pending === 'check';
  const updating = running(snapshot?.job) || pending === 'apply';
  const needsSetup = unavailable || snapshot?.enabled === false;
  const tokenSupported = typeof snapshot?.githubToken?.configured === 'boolean';
  const tokenConfigured = snapshot?.githubToken?.configured === true;
  const tokenBlocked = !tokenSupported || needsSetup || pending !== null || checking || updating || uncertain || tokenResultUncertain;
  const expired = !snapshot?.expiresAt || Date.parse(snapshot.expiresAt) <= Date.now();
  const reviewInvalid = !!review && (review.planId !== snapshot?.planId || expired);
  const blocked = !snapshot?.enabled || !snapshot.planId || expired || !!snapshot.checkError || checkRequestFailed || !!networkError || pending !== null || updating || checking || uncertain || !changes.length || snapshot.planId === submittedPlan.current;
  const summary = networkError ? '连接待恢复' : updating || uncertain ? '更新进行中' : checking ? '正在检查版本' : needsSetup ? '待启用' : snapshot?.checkError || checkRequestFailed ? '检查失败' : changes.length ? recoveries.length === changes.length ? `${changes.length} 个待完成更新` : `${changes.length} 个可用更新${recoveries.length ? `（含 ${recoveries.length} 个待完成）` : ''}` : incomplete ? '部分模块待处理' : different ? '当前版本与正式版不同' : unconfirmed ? '版本待确认' : snapshot?.checkedAt && modules.length ? lastUpdateIssue ? `版本已对齐，${lastUpdateIssue}` : '已是最新正式版' : lastUpdateIssue || (snapshot ? '尚无检查结果' : '正在读取状态');
  const tone = networkError || snapshot?.checkError || checkRequestFailed || needsSetup || incomplete || different || unconfirmed || unfinishedJob ? 'attention' : changes.length ? 'available' : '';
  const close = () => { setOpen(false); setReview(null); setToken(''); setTokenNotice(''); setRemoveToken(false); requestAnimationFrame(() => { const mobileMenu = document.querySelector<HTMLButtonElement>('.mobile-menu'); if (mobileMenu?.getClientRects().length) mobileMenu.focus(); else trigger.current?.focus(); }); };
  const show = () => { onOpen?.(); setOpen(true); void request('read'); };
  const prepare = () => {
    if (blocked || !snapshot?.planId) return;
    setReview({ planId: snapshot.planId, modules: changes });
  };
  const apply = async () => {
    if (!review) return;
    if (review.planId !== snapshot?.planId || !snapshot.expiresAt || Date.parse(snapshot.expiresAt) <= Date.now()) {
      setActionNotice('版本检查结果已变化或过期，请重新检查后确认。');
      setReview(null); return;
    }
    if (blocked) return;
    const data = await request('apply', review.planId);
    if (data) setReview(null);
  };
  const saveToken = async (remove = false) => {
    if (tokenBlocked) return;
    const value = remove ? '' : token.trim();
    setTokenNotice('');
    if (!remove && !/^[A-Za-z0-9_]{20,255}$/.test(value)) {
      setTokenError('请粘贴 20–255 位字母、数字或下划线组成的 Token。');
      return;
    }
    setTokenError('');
    await request('token', value);
  };
  const refreshToken = async () => {
    const data = await request('read');
    if (data) { setTokenResultUncertain(false); setTokenError(''); setTokenNotice('已刷新服务器上的 Token 配置状态。'); }
  };

  return <><button ref={trigger} className={`nav-item update-nav ${tone}`} aria-label={`系统更新：${summary}`} aria-haspopup="dialog" onClick={show}>{updating || checking || uncertain ? <LoaderCircle size={19} className="spin" /> : <Download size={19} />}<span>系统更新<small>{summary}</small></span><ChevronRight size={15} /></button>{open ? createPortal(<dialog ref={dialog} className="update-dialog" aria-labelledby="update-title" aria-describedby="update-description" onCancel={event => { event.preventDefault(); close(); }}><div className="update-dialog-content"><header className="update-header"><div><h2 id="update-title">系统更新</h2><p id="update-description">工作台与本机已安装模块 · 仅正式版本</p></div><button className="icon-button" aria-label="关闭系统更新" onClick={close}><X size={21} /></button></header><div className="update-body">
    {needsSetup ? <div className="update-message setup"><CircleAlert size={20} /><div><strong>先启用在线更新</strong><p>请在服务器上重新运行原一键部署命令，升级一次后即可在这里更新。</p>{snapshot?.reason ? <p>{snapshot.reason}</p> : null}</div></div> : <div className={`update-summary ${tone}`}><span className="update-summary-icon">{updating || checking || uncertain || !snapshot ? <LoaderCircle size={22} className="spin" /> : snapshot.checkError || checkRequestFailed || networkError || incomplete || different || unconfirmed || unfinishedJob ? <CircleAlert size={22} /> : changes.length ? <Download size={22} /> : <Check size={22} />}</span><div><strong>{summary}</strong><p>{snapshot?.checkedAt ? `上次检查 ${dateTime(snapshot.checkedAt)}` : '检查本机模块可用的正式版本'}</p></div></div>}
    {networkError ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>{networkError}</strong><p>恢复连接后会自动读取服务器记录。</p><button className="text-button" disabled={pending !== null} onClick={() => void request('read')}>重新连接</button></div></div> : null}
    {snapshot?.checkError || checkRequestFailed ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>版本检查未完成</strong><p>{snapshot?.checkError || '上次检查请求未完成，当前显示的是已有记录。'}</p><p>目前无法确认是否为最新正式版本，请稍后重新检查。</p></div></div> : null}
    {actionNotice ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><p>{actionNotice}</p></div> : null}
    {downloadProgress ? <DownloadProgress progress={downloadProgress} /> : null}
    {snapshot?.job ? <JobProgress job={snapshot.job} modules={modules} /> : null}
    {snapshot?.enabled && !needsSetup ? <section className="update-token" aria-labelledby="update-token-title"><div className="update-section-heading"><h3 id="update-token-title">GitHub Token</h3>{tokenSupported ? <span className={`update-token-status ${tokenConfigured ? 'configured' : ''}`}>{tokenConfigured ? '已配置' : '未配置（可选）'}</span> : <span>需升级更新服务</span>}</div>{tokenSupported ? <><p className="update-token-help" id="update-token-help">用于读取公开仓库的正式版本，只需公开仓库只读权限。<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建 GitHub Token</a></p><p className="update-token-help">Token 仅保存在服务器，不会回显。保存后下次检查生效，已有重试等待会保留。</p><form onSubmit={event => { event.preventDefault(); void saveToken(); }}><label htmlFor="update-github-token">{tokenConfigured ? '替换 Token' : '配置 Token'}</label><input id="update-github-token" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} disabled={tokenBlocked} aria-describedby="update-token-help" placeholder={tokenConfigured ? '粘贴新的 Token' : '粘贴 GitHub Token'} onChange={event => { setToken(event.target.value); setTokenError(''); setTokenNotice(''); }} /><div className="update-token-actions"><button type="submit" className="button secondary" disabled={tokenBlocked || !token.trim()}>{pending === 'token' ? <LoaderCircle size={15} className="spin" /> : null}{tokenConfigured ? '替换 Token' : '保存 Token'}</button>{tokenConfigured && !removeToken ? <button type="button" className="text-button" disabled={tokenBlocked} onClick={() => { setRemoveToken(true); setTokenNotice(''); }}>移除 Token</button> : null}</div></form>{removeToken && tokenConfigured ? <div className="update-token-remove"><p>确认移除已保存的 Token？后续检查将使用公开访问额度。</p><div className="update-token-actions"><button type="button" className="button secondary" disabled={tokenBlocked} onClick={() => void saveToken(true)}>确认移除</button><button type="button" className="text-button" disabled={pending === 'token'} onClick={() => setRemoveToken(false)}>取消移除</button></div></div> : null}{tokenError ? <p className="update-token-error" role="alert">{tokenError}</p> : null}{tokenResultUncertain ? <button className="text-button update-token-refresh" disabled={pending !== null || checking || updating || uncertain} onClick={() => void refreshToken()}>刷新配置状态</button> : null}{tokenNotice ? <p className="update-token-notice" role="status">{tokenNotice}</p> : null}</> : <p className="update-token-help">当前更新服务暂不支持 Token 配置。请在服务器上重新运行原一键部署命令升级，之后即可在这里配置。</p>}</section> : null}
    {modules.length ? <section aria-labelledby="update-modules-title"><div className="update-section-heading"><h3 id="update-modules-title">本机模块</h3><span>{modules.length} 个已安装</span></div><ul className="update-modules">{modules.map(module => <ModuleRow key={module.id} module={module} unfinishedJob={unfinishedJob} />)}</ul></section> : snapshot?.enabled && !checking ? <p className="update-empty">尚未识别到可更新的本机模块，请重新检查。</p> : null}
    {review ? <section ref={reviewElement} tabIndex={-1} className="update-review" aria-labelledby="update-review-title"><h3 id="update-review-title">确认本次更新</h3><p>将更新 {review.modules.map(module => module.name).join('、')}，共 {review.modules.length} 个模块。</p>{review.modules.some(module => module.recovery === true) ? <p>其中 {review.modules.filter(module => module.recovery === true).map(module => module.name).join('、')} 将恢复未完成的更新，重新完成安装与健康检查。</p> : null}<p>变更模块会短暂重启。请先完成这些模块中正在进行的操作。</p>{reviewInvalid ? <p role="alert">版本检查结果已变化或过期，请返回重新检查。</p> : null}</section> : changes.length && !updating ? <p className="update-footnote">{recoveries.length ? '本次包含未完成更新的恢复；相关模块会短暂重启。' : '仅更新有新正式版本的模块；变更模块会短暂重启。'}</p> : null}
  </div><footer className="update-footer">{review ? <><button className="button secondary" disabled={pending === 'apply'} onClick={() => setReview(null)}>返回</button><button className="button primary" disabled={blocked || reviewInvalid} onClick={() => void apply()}>{pending === 'apply' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}确认更新 {review.modules.length} 个模块</button></> : <><button className="button secondary" disabled={pending !== null || checking || updating || uncertain || needsSetup} onClick={() => void request('check')}><RefreshCw size={16} className={checking ? 'spin' : ''} />{checking ? '正在检查' : '检查更新'}</button>{changes.length ? <button className="button primary" disabled={blocked} onClick={prepare}>{updating ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{updating ? '正在更新' : expired || snapshot?.planId === submittedPlan.current ? '请先重新检查' : recoveries.length === changes.length ? '恢复未完成更新' : '查看更新'}</button> : <span className="update-channel">正式版本</span>}</>}</footer></div></dialog>, document.body) : null}</>;
}
