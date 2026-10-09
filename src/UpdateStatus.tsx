import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, CircleAlert, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from './api';
import type { UpdateJob, UpdateModule, UpdateState } from './update-types';
import './updates.css';

const CHECK_INTERVAL = 900_000;
const moduleLabels = { current: '已是最新', available: '可更新', unavailable: '检查未完成', unmanaged: '需手动更新' };
const jobLabels = { queued: '更新已排队', running: '正在更新', succeeded: '更新已完成', failed: '更新未完成', interrupted: '更新已中断' };
const stepLabels = { pending: '等待', running: '进行中', succeeded: '已完成', failed: '失败', skipped: '已跳过' };
const running = (job: UpdateJob | null | undefined) => job?.status === 'queued' || job?.status === 'running';
const validState = (value: UpdateState) => value && typeof value.enabled === 'boolean' && typeof value.checking === 'boolean' && Array.isArray(value.modules);
function dateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
function Version({ version, commit }: { version: string | null; commit: string | null }) {
  return <span className="update-version"><strong>{version || (commit ? commit.slice(0, 8) : '尚未识别')}</strong>{version && commit ? <small>{commit.slice(0, 8)}</small> : null}</span>;
}
function ModuleRow({ module }: { module: UpdateModule }) {
  return <li className="update-module"><div className="update-module-heading"><h3>{module.name}</h3><span className={`update-tag ${module.state}`}>{moduleLabels[module.state]}</span></div><div className="update-versions"><div><span>当前版本</span><Version version={module.currentVersion} commit={module.currentCommit} /></div>{module.latestVersion || module.latestCommit ? <><ArrowRight size={16} aria-hidden="true" /><div><span>最新正式版</span><Version version={module.latestVersion} commit={module.latestCommit} /></div></> : null}</div>{module.reason ? <p className="update-module-note">{module.reason}</p> : null}</li>;
}
function JobProgress({ job, modules }: { job: UpdateJob; modules: UpdateModule[] }) {
  const activeName = modules.find(module => module.id === job.activeModule)?.name;
  return <section className={`update-progress ${job.status}`} aria-labelledby="update-progress-title"><div className="update-progress-heading"><h3 id="update-progress-title">{running(job) ? <LoaderCircle size={18} className="spin" /> : job.status === 'succeeded' ? <Check size={18} /> : <CircleAlert size={18} />}{jobLabels[job.status]}</h3><span>{dateTime(job.finishedAt || job.startedAt)}</span></div><p role="status">{job.message || (activeName ? `正在处理${activeName}` : '进度会自动更新。')}</p>{job.steps.length ? <ol className="update-steps" aria-label="更新进度">{job.steps.map(step => <li className={step.status} key={step.id}><span className="update-step-mark" aria-hidden="true">{step.status === 'running' ? <LoaderCircle size={15} className="spin" /> : step.status === 'succeeded' ? <Check size={14} /> : step.status === 'failed' ? <X size={14} /> : <span />}</span><div><strong>{step.name}</strong>{step.message ? <p>{step.message}</p> : null}</div><span>{stepLabels[step.status]}</span></li>)}</ol> : null}{running(job) ? <small className="update-progress-note">可以关闭此面板；更新会继续，重新打开即可查看进度。</small> : null}</section>;
}

export default function UpdateStatus({ onExpired, onOpen }: { onExpired: () => void; onOpen?: () => void }) {
  const [snapshot, setSnapshot] = useState<UpdateState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [networkError, setNetworkError] = useState('');
  const [checkRequestFailed, setCheckRequestFailed] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const [pending, setPending] = useState<'read' | 'check' | 'apply' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<{ planId: string; modules: UpdateModule[] } | null>(null);
  const snapshotRef = useRef<UpdateState | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastCheckAttempt = useRef(0);
  const failedCheckAt = useRef<string | null | undefined>(undefined);
  const submittedPlan = useRef<string | null>(null);
  const uncertainRef = useRef<{ previousJobId: string | null } | null>(null);
  const reviewRef = useRef(false);
  const reviewElement = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const request = useCallback(async (kind: 'read' | 'check' | 'apply', planId?: string) => {
    if (requestRef.current) return null;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(kind);
    if (kind === 'check') { lastCheckAttempt.current = Date.now(); setActionNotice(''); }
    if (kind === 'apply') {
      submittedPlan.current = planId || null;
      uncertainRef.current = { previousJobId: snapshotRef.current?.job?.id || null };
      setActionNotice('');
    }
    try {
      const data = await api<UpdateState>(`/api/system/updates${kind === 'read' ? '' : `/${kind}`}`, {
        signal: controller.signal,
        ...(kind === 'read' ? {} : { method: 'POST', body: JSON.stringify(kind === 'apply' ? { planId } : {}) }),
      });
      if (controller.signal.aborted) return null;
      if (!validState(data)) throw new ApiError('更新功能尚未安装', 404);
      if (kind === 'check' || data.checking || (failedCheckAt.current !== undefined && data.checkedAt !== failedCheckAt.current)) {
        failedCheckAt.current = undefined;
        setCheckRequestFailed(false);
      }
      if (kind === 'read' && uncertainRef.current) {
        if ((!running(data.job) && data.job?.id === uncertainRef.current.previousJobId) || !data.job) setActionNotice('已恢复连接。未发现新的更新任务，请重新检查版本后再试。');
        uncertainRef.current = null;
        setUncertain(false);
      }
      if (kind === 'apply') { uncertainRef.current = null; setUncertain(false); }
      snapshotRef.current = data;
      setSnapshot(data);
      setUnavailable(false);
      setNetworkError('');
      return data;
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (error instanceof ApiError && error.status === 401) { onExpired(); return null; }
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        setUnavailable(true);
        setNetworkError('');
      } else if (kind === 'apply' && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        uncertainRef.current = null;
        setUncertain(false);
        setActionNotice(error.message);
        setReview(null);
        reviewRef.current = false;
      } else {
        if (kind === 'check') { failedCheckAt.current = snapshotRef.current?.checkedAt || null; setCheckRequestFailed(true); }
        if (kind === 'apply') { setUncertain(true); setReview(null); reviewRef.current = false; }
        setNetworkError(kind === 'check' ? '检查失败，暂时无法连接更新服务。' : kind === 'apply' || running(snapshotRef.current?.job) ? '连接暂时中断，正在重连并核实更新进度。' : '暂时无法连接更新服务，正在重连。');
      }
      return null;
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; if (!controller.signal.aborted) setPending(null); }
    }
  }, [onExpired]);

  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);
  const active = !!snapshot?.checking || running(snapshot?.job) || uncertain;
  useEffect(() => {
    let disposed = false;
    let ticking = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (disposed || ticking) return;
      ticking = true;
      clearTimeout(timer);
      try {
        if (navigator.onLine && (!document.hidden || active)) {
          const data = await request('read');
          if (!disposed && data?.enabled && !data.checking && !running(data.job) && !uncertainRef.current && !reviewRef.current && !document.hidden && Date.now() - lastCheckAttempt.current >= CHECK_INTERVAL && (!data.checkedAt || Date.now() - Date.parse(data.checkedAt) >= CHECK_INTERVAL)) await request('check');
        }
      } finally {
        ticking = false;
        if (!disposed) timer = setTimeout(() => void tick(), active ? 2_000 : 60_000);
      }
    };
    const resume = () => { if (!document.hidden && navigator.onLine) void tick(); };
    void tick();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, [request, active]);

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
  const incomplete = modules.some(module => module.state === 'unavailable' || module.state === 'unmanaged');
  const checking = !!snapshot?.checking || pending === 'check';
  const updating = running(snapshot?.job) || pending === 'apply';
  const needsSetup = unavailable || snapshot?.enabled === false;
  const expired = !snapshot?.expiresAt || Date.parse(snapshot.expiresAt) <= Date.now();
  const blocked = !snapshot?.enabled || !snapshot.planId || expired || !!snapshot.checkError || checkRequestFailed || !!networkError || pending !== null || updating || checking || uncertain || !changes.length || snapshot.planId === submittedPlan.current;
  const summary = networkError ? '连接待恢复' : updating || uncertain ? '更新进行中' : checking ? '正在检查版本' : needsSetup ? '待启用' : snapshot?.checkError || checkRequestFailed ? '检查失败' : changes.length ? `${changes.length} 个可用更新` : incomplete ? '部分模块待处理' : snapshot?.checkedAt && modules.length ? '已是最新正式版' : snapshot ? '尚无检查结果' : '正在读取状态';
  const tone = networkError || snapshot?.checkError || checkRequestFailed || needsSetup || incomplete ? 'attention' : changes.length ? 'available' : '';
  const close = () => { setOpen(false); setReview(null); reviewRef.current = false; requestAnimationFrame(() => { const mobileMenu = document.querySelector<HTMLButtonElement>('.mobile-menu'); if (mobileMenu?.getClientRects().length) mobileMenu.focus(); else trigger.current?.focus(); }); };
  const show = () => { onOpen?.(); setOpen(true); void request('read'); };
  const prepare = () => {
    if (blocked || !snapshot?.planId) return;
    setReview({ planId: snapshot.planId, modules: changes });
    reviewRef.current = true;
  };
  const apply = async () => {
    if (!review || blocked || review.planId !== snapshot?.planId || !snapshot.expiresAt || Date.parse(snapshot.expiresAt) <= Date.now()) {
      setActionNotice('版本检查结果已变化或过期，请重新检查后确认。');
      setReview(null); reviewRef.current = false; return;
    }
    const data = await request('apply', review.planId);
    if (data) { setReview(null); reviewRef.current = false; }
  };

  return <><button ref={trigger} className={`nav-item update-nav ${tone}`} aria-label={`系统更新：${summary}`} aria-haspopup="dialog" onClick={show}>{updating || checking || uncertain ? <LoaderCircle size={19} className="spin" /> : <Download size={19} />}<span>系统更新<small>{summary}</small></span><ChevronRight size={15} /></button>{open ? createPortal(<dialog ref={dialog} className="update-dialog" aria-labelledby="update-title" aria-describedby="update-description" onCancel={event => { event.preventDefault(); close(); }}><div className="update-dialog-content"><header className="update-header"><div><h2 id="update-title">系统更新</h2><p id="update-description">工作台与本机已安装模块 · 仅正式版本</p></div><button className="icon-button" aria-label="关闭系统更新" onClick={close}><X size={21} /></button></header><div className="update-body">
    {needsSetup ? <div className="update-message setup"><CircleAlert size={20} /><div><strong>先启用在线更新</strong><p>请在服务器上重新运行原一键部署命令，升级一次后即可在这里更新。</p>{snapshot?.reason ? <p>{snapshot.reason}</p> : null}</div></div> : <div className={`update-summary ${tone}`}><span className="update-summary-icon">{updating || checking || uncertain || !snapshot ? <LoaderCircle size={22} className="spin" /> : snapshot.checkError || checkRequestFailed || networkError || incomplete ? <CircleAlert size={22} /> : changes.length ? <Download size={22} /> : <Check size={22} />}</span><div><strong>{summary}</strong><p>{snapshot?.checkedAt ? `上次检查 ${dateTime(snapshot.checkedAt)}` : '检查本机模块可用的正式版本'}</p></div></div>}
    {networkError ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>{networkError}</strong><p>恢复连接后会自动读取服务器记录。</p><button className="text-button" disabled={pending !== null} onClick={() => void request('read')}>重新连接</button></div></div> : null}
    {snapshot?.checkError || checkRequestFailed ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>版本检查未完成</strong><p>{snapshot?.checkError || '上次检查请求未完成，当前显示的是已有记录。'}</p><p>目前无法确认是否为最新正式版本，请稍后重新检查。</p></div></div> : null}
    {actionNotice ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><p>{actionNotice}</p></div> : null}
    {snapshot?.job ? <JobProgress job={snapshot.job} modules={modules} /> : null}
    {modules.length ? <section aria-labelledby="update-modules-title"><div className="update-section-heading"><h3 id="update-modules-title">本机模块</h3><span>{modules.length} 个已安装</span></div><ul className="update-modules">{modules.map(module => <ModuleRow key={module.id} module={module} />)}</ul></section> : snapshot?.enabled && !checking ? <p className="update-empty">尚未识别到可更新的本机模块，请重新检查。</p> : null}
    {review ? <section ref={reviewElement} tabIndex={-1} className="update-review" aria-labelledby="update-review-title"><h3 id="update-review-title">确认本次更新</h3><p>将更新 {review.modules.map(module => module.name).join('、')}，共 {review.modules.length} 个模块。</p><p>变更模块会短暂重启。请先完成这些模块中正在进行的操作。</p>{blocked || review.planId !== snapshot?.planId ? <p role="alert">版本检查结果已变化或过期，请返回重新检查。</p> : null}</section> : changes.length && !updating ? <p className="update-footnote">仅更新有新正式版本的模块；变更模块会短暂重启。</p> : null}
  </div><footer className="update-footer">{review ? <><button className="button secondary" disabled={pending === 'apply'} onClick={() => { setReview(null); reviewRef.current = false; }}>返回</button><button className="button primary" disabled={blocked || review.planId !== snapshot?.planId} onClick={() => void apply()}>{pending === 'apply' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}确认更新 {review.modules.length} 个模块</button></> : <><button className="button secondary" disabled={pending !== null || checking || updating || uncertain || needsSetup} onClick={() => void request('check')}><RefreshCw size={16} className={checking ? 'spin' : ''} />{checking ? '正在检查' : '检查更新'}</button>{changes.length ? <button className="button primary" disabled={blocked} onClick={prepare}>{updating ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{updating ? '正在更新' : expired || snapshot?.planId === submittedPlan.current ? '请先重新检查' : '查看更新'}</button> : <span className="update-channel">正式版本</span>}</>}</footer></div></dialog>, document.body) : null}</>;
}
