import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowLeftRight, ArrowUpRight, Check, ChevronRight, CircleAlert, FolderKanban, Gauge, Info, LayoutDashboard, LoaderCircle, LogOut, Menu, RefreshCw, Save, ScrollText, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { api, ApiError, setCsrfToken } from './api';
import ProjectWorkspace from './ProjectWorkspace';
import DiagnosticDetails from './DiagnosticDetails';
import UpdateStatus from './UpdateStatus';
import ConnectionStatus from './ConnectionStatus';
import { ageSnapshot, attentionDiagnostics, connectionDiagnostic, navigationQuery, nextSnapshotExpiry } from './hub-state';
import { createOverviewDecoder, createStreamWatchdog } from './overview-feed';
import { checkNotice, statusText } from './check-notice';
import { groupLabels, ProjectIcon, Status } from './ProjectBadges';
import { createTradingCache } from './trading-cache';
import type { Notice } from './check-notice';
import type { NavigationQuery } from './hub-state';
import type { Adapter, Category, Metric, Overview, Project, Snapshot } from './types';
import { HUB_QUERY_KEYS } from '../server/hub-navigation.mjs';

const TrendChart = lazy(() => import('./TrendChart'));
const TradingPage = lazy(() => import('./TradingPage'));
const DiagnosticPage = lazy(() => import('./DiagnosticPage'));
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="chart-empty" role="status"><CircleAlert size={24} /><span>图表暂时无法载入</span><small>页面更新或连接恢复后，刷新即可重试。</small><button className="button secondary" onClick={() => location.reload()}>刷新页面</button></div> : this.props.children;
  }
}
const categories: Record<Category, string> = { trading: '交易执行', monitoring: '市场监控', assets: '资产管理', other: '其他项目' };
const adapters: Record<Adapter, string> = { aster: 'Gate CrossEx工作台', monitor: 'Market Monitor', asset: '资产账本', standard: '标准概览接口', link: '仅网页入口' };
type Route = { view: 'overview' | 'projects' | 'project' | 'trading' | 'diagnostic'; id: string; query?: NavigationQuery };

function readRoute(): Route {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const query = Object.fromEntries(HUB_QUERY_KEYS.filter(key => params.has(key)).map(key => [key, params.get(key)]));
  return { view: view === 'projects' || view === 'project' || view === 'trading' || view === 'diagnostic' ? view : 'overview', id: params.get('id') || '', ...(Object.keys(query).length && navigationQuery(query) ? { query: navigationQuery(query)! } : {}) };
}
function formatDate(value: string | null, full = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', { ...(full ? { month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
function metricValue(metric?: Metric) {
  if (!metric || metric.value === null) return '—';
  return typeof metric.value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(metric.value) : metric.value;
}
function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>集序<small>项目工作台</small></span></div>; }
function Button({ children, busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button {...props} disabled={props.disabled || busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null}{children}</button>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const session = await api<{ csrfToken: string }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }); setCsrfToken(session.csrfToken); setPassword(''); onLogin(); }
    catch (e) { setError(e instanceof Error ? e.message : '登录失败'); }
    finally { setBusy(false); }
  }
  return <div className="login-layout">
    <section className="login-intro"><Brand /><div className="login-copy"><h1>每个项目，<br />各就其位。</h1><p>交易的进度，市场的变化，资产的全貌。<br />在一个工作台里，找到现在需要关注的事。</p><div className="login-projects"><span><Gauge />Gate CrossEx</span><span><Activity />市场监控</span><span><Wallet />资产账本</span></div></div><span className="login-footer">内嵌模块 · 统一运行</span></section>
    <section className="login-side"><form className="login-form" onSubmit={submit}><div className="login-symbol"><LayoutDashboard size={25} /></div><h2>进入工作台</h2><p>使用安装时生成的工作台密码登录。</p><label htmlFor="password">工作台密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus />{error ? <div className="error-box" role="alert">{error}</div> : null}<Button className="button primary wide" type="submit" busy={busy}>登录<ChevronRight size={18} /></Button><div className="login-note"><ShieldCheck size={17} />一次登录，使用全部内嵌模块</div></form></section>
  </div>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [tradingCache] = useState(createTradingCache);
  const [route, setRoute] = useState<Route>(readRoute);
  const [diagnosticOpened, setDiagnosticOpened] = useState(false);
  useEffect(() => { if (route.view === 'diagnostic') setDiagnosticOpened(true); }, [route.view]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<Project | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [preloadId, setPreloadId] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const receivedAt = useRef(performance.now());
  const streamLive = useRef(false);
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
  const pendingLoad = useRef<{ promise: Promise<void>; signal: AbortSignal; controller: AbortController } | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const first = sidebar.current?.querySelector<HTMLButtonElement>('button'); first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); mobileMenuButton.current?.focus(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(sidebar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const expire = useCallback(() => { tradingCache.clear(); requestVersion.current++; pendingLoad.current?.controller.abort(); pendingLoad.current = null; setAuthenticated(false); setOverview(null); setEditor(null); setNotice(null); setCsrfToken(''); }, [tradingCache]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ authenticated: boolean; csrfToken?: string }>('/api/session', { signal: controller.signal }).then(s => { if (controller.signal.aborted) return; setCsrfToken(s.csrfToken || ''); setAuthenticated(s.authenticated); }).catch(e => { if (!controller.signal.aborted && e.name !== 'AbortError') { setAuthenticated(false); setError('工作台服务暂时不可用，请检查服务后刷新。'); } });
    return () => controller.abort();
  }, []);
  const accept = useCallback((data: Overview) => { receivedAt.current = performance.now(); setOverview(data); setError(''); }, []);
  const load = useCallback((signal?: AbortSignal, force = false) => {
    if (pendingLoad.current && !pendingLoad.current.signal.aborted && !force) return pendingLoad.current.promise;
    pendingLoad.current?.controller.abort();
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    const version = ++requestVersion.current;
    setLoading(true);
    const promise = (async () => {
      try { const data = await api<Overview>('/api/overview', { signal: requestSignal }); if (version === requestVersion.current) accept(data); }
      catch (e) { if (version !== requestVersion.current) return; if (e instanceof ApiError && e.status === 401) expire(); else if (e instanceof Error && e.name !== 'AbortError') setError(e.message); }
      finally { if (version === requestVersion.current) setLoading(false); }
    })().finally(() => { if (pendingLoad.current?.promise === promise) pendingLoad.current = null; });
    pendingLoad.current = { promise, signal: requestSignal, controller }; return promise;
  }, [expire, accept]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    const refresh = () => { if (navigator.onLine && !streamLive.current) void load(controller.signal); };
    const first = window.setTimeout(refresh, 1500);
    const interval = window.setInterval(refresh, 30_000);
    return () => { controller.abort(); clearTimeout(first); clearInterval(interval); };
  }, [authenticated, load]);
  useEffect(() => {
    if (!authenticated) return;
    let stream: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog = createStreamWatchdog();
    const controller = new AbortController();
    const connect = () => {
      stream?.close(); stream = null; streamLive.current = false; clearTimeout(retry);
      if (controller.signal.aborted || !navigator.onLine) return;
      watchdog = createStreamWatchdog();
      const decode = createOverviewDecoder();
      const current = new EventSource('/api/overview/events?protocol=2'); stream = current;
      current.onmessage = event => {
        if (controller.signal.aborted || stream !== current) return;
        try { const data = decode(event.data); watchdog.received(); streamLive.current = true; if (data) { requestVersion.current++; setLoading(false); accept(data); } }
        catch { streamLive.current = false; current.close(); stream = null; void load(controller.signal); retry = setTimeout(connect, 5000); }
      };
      current.onerror = () => { if (controller.signal.aborted || stream !== current) return; streamLive.current = false; void load(controller.signal); };
    };
    const resume = () => {
      if (!navigator.onLine || controller.signal.aborted) return;
      if (!stream || watchdog.expired()) connect();
      if (resumeTimer !== undefined) return;
      const previousRead = pendingLoad.current;
      // Coalesce wake events and give the stream a chance to supply fresh data.
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined;
        if (!controller.signal.aborted && navigator.onLine && !streamLive.current) {
          void load(controller.signal, previousRead !== null && pendingLoad.current === previousRead);
        }
      }, 1000);
    };
    const visible = () => { if (!document.hidden) resume(); };
    const offline = () => { clearTimeout(resumeTimer); resumeTimer = undefined; connect(); pendingLoad.current?.controller.abort(); };
    connect();
    document.addEventListener('visibilitychange', visible); window.addEventListener('online', resume); window.addEventListener('offline', offline);
    window.addEventListener('focus', resume); window.addEventListener('pageshow', resume);
    // This local timer only sends requests when the stream heartbeat has expired.
    const health = window.setInterval(() => { if (navigator.onLine && watchdog.expired()) { connect(); void load(controller.signal); } }, 5000);
    return () => { controller.abort(); stream?.close(); stream = null; streamLive.current = false; clearTimeout(retry); clearTimeout(resumeTimer); clearInterval(health); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', resume); window.removeEventListener('offline', offline); window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume); for (const timer of refreshTimers.current.values()) clearTimeout(timer); refreshTimers.current.clear(); };
  }, [authenticated, accept, load]);
  useEffect(() => {
    if (!overview || !authenticated) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      const now = Date.parse(overview.generatedAt) + performance.now() - receivedAt.current;
      const expiry = nextSnapshotExpiry(overview.projects, now);
      if (expiry !== null) timer = setTimeout(() => setClock(value => value + 1), Math.min(expiry - now, 2_147_483_647));
    };
    const visible = () => { if (!document.hidden) setClock(value => value + 1); schedule(); };
    schedule(); document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [authenticated, overview, clock]);
  useEffect(() => { const change = () => setRoute(readRoute()); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  useEffect(() => { if (!notice || notice.tone === 'warning' || notice.tone === 'error') return; const timer = window.setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timer); }, [notice]);
  const navigate = (next: Route) => {
    const params = new URLSearchParams(); if (next.view !== 'overview') params.set('view', next.view); if (next.view === 'project') params.set('id', next.id);
    if (next.view === 'trading') params.set('tradingSection', 'positions');
    if (next.view === 'project' && next.query) for (const [key, value] of Object.entries(next.query)) params.set(key, value);
    history.pushState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`); setRoute(next); setMenuOpen(false); if (menuOpen) mobileMenuButton.current?.focus(); window.scrollTo(0, 0);
  };
  const changed = useCallback((id: string) => {
    if (refreshTimers.current.has(id)) return;
    refreshTimers.current.set(id, setTimeout(() => {
      void api(`/api/projects/${encodeURIComponent(id)}/check`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(() => { if (!streamLive.current) void load(); }).catch(e => { if (e instanceof ApiError && e.status === 401) expire(); }).finally(() => refreshTimers.current.delete(id));
    }, 500));
  }, [load, expire]);
  const check = async (project: Project) => {
    setNotice(null);
    setChecking(project.id);
    try { const result = await api<{ snapshot: Snapshot }>(`/api/projects/${encodeURIComponent(project.id)}/check`, { method: 'POST' }); setNotice(checkNotice(project, result.snapshot)); await load(); }
    catch (e) { if (e instanceof ApiError && e.status === 401) expire(); else setNotice({ title: `${project.name}：连接检查失败`, tone: 'error', detail: e instanceof Error ? e.message : '未能取得检查结果，请稍后重试。' }); }
    finally { setChecking(null); }
  };
  const logout = async () => {
    try { await api('/api/logout', { method: 'POST' }); expire(); }
    catch (e) { setError(e instanceof Error ? e.message : '退出失败，请重试'); }
  };
  if (authenticated === null) return <div className="app-loading"><LoaderCircle className="spin" /><p>正在打开工作台</p></div>;
  if (!authenticated) return <>{error ? <div className="service-error" role="alert">{error}</div> : null}<Login onLogin={() => { tradingCache.clear(); setError(''); setAuthenticated(true); }} /></>;
  const serverNow = overview ? Date.parse(overview.generatedAt) + performance.now() - receivedAt.current : Date.now();
  const snapshots = overview?.projects.map(snapshot => ageSnapshot(snapshot, serverNow)) || [];
  const selected = snapshots.find(s => s.project.id === route.id);
  const pageTitle = route.view === 'overview' ? '总览' : route.view === 'projects' ? '模块设置' : route.view === 'trading' ? '交易中心' : route.view === 'diagnostic' ? '请求诊断' : selected?.project.name || '项目详情';
  const section = route.view === 'project' ? selected ? groupLabels[selected.project.category] : null : route.view === 'trading' ? '交易' : route.view === 'projects' || route.view === 'diagnostic' ? '系统' : null;
  const attentionCount = snapshots.filter(s => s.project.enabled && s.project.adapter !== 'link' && attentionDiagnostics(s, serverNow).length).length;
  const enabledCount = snapshots.filter(s => s.project.enabled && s.project.adapter !== 'link').length;
  const firstOf = (category: Category) => snapshots.find(s => s.project.category === category && s.project.enabled);
  const monitorEntry = firstOf('monitoring'), assetEntry = firstOf('assets');
  const projectNav = (s: Snapshot) => <button key={s.project.id} className={`nav-item project-nav ${route.view === 'project' && route.id === s.project.id ? 'active' : ''}`} aria-current={route.view === 'project' && route.id === s.project.id ? 'page' : undefined} onPointerEnter={() => setPreloadId(s.project.id)} onFocus={() => setPreloadId(s.project.id)} onClick={() => navigate({ view: 'project', id: s.project.id })}><ProjectIcon category={s.project.category} size={17} /><span>{s.project.name}</span><span className={`nav-status ${s.project.adapter === 'link' ? 'unconfigured' : s.state}`} aria-label={s.project.adapter === 'link' ? '网页入口' : statusText[s.state]} /></button>;
  const viewNav = (view: Route['view'], label: string, icon: ReactNode, extra?: ReactNode) => <button className={`nav-item ${route.view === view ? 'active' : ''}`} aria-current={route.view === view ? 'page' : undefined} onClick={() => navigate({ view, id: '' })}>{icon}<span className="nav-text">{label}</span>{extra}</button>;
  return <div className={`app-shell ${route.view === 'project' ? 'project-shell' : ''}`}>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    {menuOpen ? <button className="nav-backdrop" aria-label="关闭导航" onClick={() => { setMenuOpen(false); mobileMenuButton.current?.focus(); }} /> : null}
    <aside ref={sidebar} className={`sidebar ${menuOpen ? 'open' : ''}`}><Brand /><nav aria-label="主导航">{viewNav('overview', '总览', <LayoutDashboard size={17} />, attentionCount ? <span className="nav-count" aria-hidden="true">{attentionCount}</span> : null)}
      {(['trading', 'monitoring', 'assets', 'other'] as const).map(category => { const items = snapshots.filter(s => s.project.category === category); if (category !== 'trading' && !items.length) return null; return <div className="nav-group" role="group" aria-label={groupLabels[category]} key={category}><div className="nav-label" aria-hidden="true">{groupLabels[category]}</div>{category === 'trading' ? viewNav('trading', '交易中心', <ArrowLeftRight size={17} />) : null}{items.map(projectNav)}</div>; })}
      <div className="nav-group" role="group" aria-label="系统"><div className="nav-label" aria-hidden="true">系统</div>{viewNav('projects', '模块设置', <Settings2 size={17} />)}{viewNav('diagnostic', '请求诊断', <ScrollText size={17} />)}<UpdateStatus onExpired={expire} onOpen={() => setMenuOpen(false)} /></div></nav><div className="sidebar-bottom"><div><span className="workspace-avatar">私</span><span>个人工作台<small>数据保存在自有服务器</small></span></div><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={() => void logout()}><LogOut size={17} /></button></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button ref={mobileMenuButton} className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} /></button>{section ? <><span>{section}</span><ChevronRight size={13} /></> : null}<strong>{pageTitle}</strong></div><div className="topbar-right"><ConnectionStatus />{route.view !== 'trading' ? <><span className="refresh-label">总览读取于 {formatDate(overview?.generatedAt || null)}</span><button className="icon-button" aria-label="刷新总览" title="刷新总览" disabled={loading} onClick={() => void load()}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></> : null}</div></header>
      <main id="main-content" className={`main-content ${route.view === 'project' ? 'project-content' : ''}`}>{route.view !== 'project' && route.view !== 'trading' ? <div className="page-heading"><div><h1>{pageTitle}</h1><p className="page-meta">{route.view === 'overview' ? <><span>{enabledCount} 个启用模块</span><span>{attentionCount ? `${attentionCount} 个需要关注` : '暂无需要处理的问题'}</span></> : route.view === 'projects' ? <span>管理内嵌模块的显示与刷新</span> : <span>本机浏览器发往工作台的请求记录</span>}<span>时间按本机时区显示</span></p></div><span className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span></div> : null}
      {error ? <div className="error-box inline-error" role="alert"><CircleAlert size={18} />{error}<button onClick={() => void load()}>重试</button></div> : null}
      {diagnosticOpened || route.view === 'diagnostic' ? <section hidden={route.view !== 'diagnostic'} aria-label="请求诊断面板"><Suspense fallback={<div className="empty-state loading-state" role="status"><LoaderCircle className="spin" /><p>正在加载诊断工具…</p></div>}><DiagnosticPage /></Suspense></section> : null}
      {route.view === 'trading' ? <Suspense fallback={<div className="empty-state loading-state" role="status"><LoaderCircle className="spin" /><p>正在加载交易模块…</p></div>}><TradingPage cache={tradingCache} onExpired={expire} navigationSearch={location.search} onProject={id => navigate({ view: 'project', id })} /></Suspense> : route.view === 'diagnostic' ? null : !overview ? <div className="empty-state loading-state"><LoaderCircle className="spin" /><h2>正在读取项目</h2><p>正在读取内嵌模块的运行状态。</p></div> : route.view === 'overview' ? <OverviewPage now={serverNow} onPreload={setPreloadId} snapshots={snapshots} onProject={id => navigate({ view: 'project', id })} onEdit={setEditor} onManage={() => navigate({ view: 'projects', id: '' })} /> : route.view === 'projects' ? <ProjectsPage now={serverNow} snapshots={snapshots} onEdit={setEditor} onCheck={check} checking={checking} /> : selected ? null : <div className="empty-state"><FolderKanban /><h2>没有找到这个项目</h2><p>项目可能已被移除，请回到模块设置查看。</p><button className="button secondary" onClick={() => navigate({ view: 'projects', id: '' })}>查看项目</button></div>}
      {overview ? <ProjectWorkspace snapshots={snapshots} now={serverNow} priorityId={preloadId} projects={overview.projects.map(s => s.project)} activeId={route.view === 'project' ? route.id : null} query={route.query} onEdit={setEditor} onExpired={expire} onChanged={changed} onNavigate={(id, query) => { const target = overview.projects.find(s => s.project.id === id && s.project.enabled && s.project.accessMode === 'proxy'); if (target) navigate({ view: 'project', id, query }); }} onOpenTrading={() => navigate({ view: 'trading', id: '' })} /> : null}
      </main>
      {!menuOpen ? <nav className="mobile-tabbar" aria-label="快捷导航"><button className={route.view === 'overview' ? 'active' : ''} onClick={() => navigate({ view: 'overview', id: '' })}><LayoutDashboard size={19} />总览</button><button className={route.view === 'trading' ? 'active' : ''} onClick={() => navigate({ view: 'trading', id: '' })}><ArrowLeftRight size={19} />交易</button>{monitorEntry ? <button className={route.view === 'project' && route.id === monitorEntry.project.id ? 'active' : ''} onClick={() => navigate({ view: 'project', id: monitorEntry.project.id })}><Activity size={19} />监控</button> : null}{assetEntry ? <button className={route.view === 'project' && route.id === assetEntry.project.id ? 'active' : ''} onClick={() => navigate({ view: 'project', id: assetEntry.project.id })}><Wallet size={19} />资产</button> : null}<button aria-label="更多导航" onClick={() => setMenuOpen(true)}><Menu size={19} />更多</button></nav> : null}
    </div>
    {editor ? <ProjectEditor key={editor.id} project={editor} onClose={() => setEditor(null)} onSaved={async message => { setEditor(null); setNotice({ title: message, tone: 'success' }); await load(); }} onExpired={expire} /> : null}
    {notice ? <div className={`toast ${notice.tone}`} role={notice.tone === 'warning' || notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <Check size={18} /> : notice.tone === 'info' ? <Info size={18} /> : <CircleAlert size={18} />}<div className="toast-content"><strong>{notice.title}</strong>{notice.detail ? <p>{notice.detail}</p> : null}</div><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div> : null}
  </div>;
}

function OverviewPage({ snapshots, now, onProject, onEdit, onManage, onPreload }: { now: number; onPreload: (id: string) => void; snapshots: Snapshot[]; onProject: (id: string) => void; onEdit: (p: Project) => void; onManage: () => void }) {
  const enabled = snapshots.filter(s => s.project.enabled && s.project.adapter !== 'link');
  const attention = enabled.map(snapshot => ({ snapshot, issues: attentionDiagnostics(snapshot, now) })).filter(item => item.issues.length);
  const quiet = enabled.length - attention.length;
  const asset = enabled.find(s => s.project.adapter === 'asset');
  const firstMetric = asset?.metrics[0];
  const assetOld = asset ? ['stale', 'offline'].includes(asset.state) : false;
  return <>
    <section className="overview-strip panel" aria-label="运行概况">
      <div className="kpi"><span className="kpi-label">{firstMetric?.label || '表内总额'}</span><strong className="kpi-value">{metricValue(firstMetric)}<small>{firstMetric?.unit || 'USD'}</small>{assetOld && firstMetric?.value !== null && firstMetric ? <span className="old-tag" title="源数据未按时更新，显示最后取得的值">旧</span> : null}</strong><span className="kpi-sub">{asset?.updatedAt ? `${asset.freshness === 'static' ? '估值记录于' : '源数据更新于'} ${formatDate(asset.updatedAt, true)}` : asset ? '尚无源数据更新时间' : '未接入资产账本'}</span></div>
      <div className="kpi"><span className="kpi-label">已接入模块</span><strong className="kpi-value">{snapshots.length}<small>个</small></strong><span className="kpi-sub">{enabled.length} 个启用</span></div>
      <div className="kpi"><span className="kpi-label">运行正常</span><strong className="kpi-value">{quiet}<small>/ {enabled.length}</small></strong><span className="kpi-sub">暂无首页提醒</span></div>
      <div className={`kpi ${attention.length ? 'attention' : ''}`}><span className="kpi-label">需要关注</span><strong className="kpi-value">{attention.length}<small>个项目</small></strong><span className="kpi-sub">需人工处理的问题立即提醒</span></div>
    </section>
    <div className="overview-grid"><div className="overview-main">
      <section className="asset-panel panel"><div className="panel-heading"><h2><Wallet size={16} />资产走势</h2>{asset ? <Status state={asset.state} diagnostics={asset.diagnostics} /> : <span className="muted">未接入账本</span>}</div>{asset?.trend && asset.trend.length > 1 ? <ChartBoundary><Suspense fallback={<div className="chart-empty">正在载入历史曲线</div>}><TrendChart points={asset.trend} label="表内总额" unit="USD" /></Suspense></ChartBoundary> : <div className="chart-empty"><Wallet size={22} /><span>暂无可展示的资产曲线</span><small>只显示账本中的真实历史记录</small></div>}<div className="panel-footer"><span>来自资产账本，不重复累加交易账户余额</span>{asset ? <button onClick={() => onProject(asset.project.id)}>查看账本<ArrowUpRight size={14} /></button> : null}</div></section>
      <section className="panel modules-panel"><div className="panel-heading"><h2>模块<span className="count-label">{snapshots.length}</span></h2><button className="text-button" onClick={onManage}>管理模块<ChevronRight size={15} /></button></div>{snapshots.length ? <div className="module-table" role="table" aria-label="模块状态"><div className="module-row module-head" role="row"><span role="columnheader">模块</span><span role="columnheader">状态</span><span role="columnheader">关键指标</span><span role="columnheader">数据时间</span><span role="columnheader"><span className="visually-hidden">操作</span></span></div>{snapshots.map(s => <ModuleRow key={s.project.id} snapshot={s} onPreload={() => onPreload(s.project.id)} onOpen={() => onProject(s.project.id)} onEdit={() => onEdit(s.project)} />)}</div> : <div className="empty-state"><FolderKanban /><p>添加项目后，概览会出现在这里。</p><button className="button secondary" onClick={onManage}>添加项目</button></div>}</section>
    </div>
    <section className="attention-panel panel"><div className="panel-heading"><h2><CircleAlert size={16} />当前关注<span className="count-label">{attention.length}</span></h2></div>{attention.length ? <div className="attention-list">{attention.slice(0, 5).map(({ snapshot: s, issues }) => {
      const configure = issues.every(connectionDiagnostic);
      return <div className="attention-item" key={s.project.id}><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} size={16} /></span><div><strong>{s.project.name}</strong><p>{issues.slice(0, 3).map(issue => issue.message).concat(issues.length > 3 ? [`另有 ${issues.length - 3} 项，请查看运行详情。`] : []).join("\n")}</p><button onClick={() => configure ? onEdit(s.project) : onProject(s.project.id)}>{configure ? '检查连接' : '进入项目'}<ChevronRight size={14} /></button></div></div>;
    })}</div> : <div className="empty-state compact"><ShieldCheck size={28} /><h3>{enabled.length ? '暂无需要处理的问题' : '接入你的第一个项目'}</h3><p>{enabled.length ? '统计更新和自动核对进度可在项目运行详情查看。' : '在模块设置中添加页面和数据连接。'}</p></div>}<div className="attention-note">需人工处理的问题立即提醒；其他故障持续 2 分钟后显示。</div></section></div>
  </>;
}
function ModuleRow({ snapshot: s, onOpen, onEdit, onPreload }: { onPreload: () => void; snapshot: Snapshot; onOpen: () => void; onEdit: () => void }) {
  return <div className="module-row" role="row" onPointerEnter={onPreload} onFocusCapture={onPreload}>
    <div className="module-name" role="cell"><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} size={16} /></span><div><h3>{s.project.name}</h3><span>{s.project.description || categories[s.project.category]}</span></div></div>
    <div role="cell"><Status state={s.state} adapter={s.project.adapter} diagnostics={s.diagnostics} /></div>
    <div className="module-metrics" role="cell">{s.metrics.length ? s.metrics.slice(0, 2).map(m => <span className="module-metric" key={m.key}><small>{m.label}</small><b>{metricValue(m)}</b>{m.unit && m.value !== null ? <small>{m.unit}</small> : null}</span>) : <span className="module-empty">{s.message || '暂未取得概览数据'}</span>}</div>
    <div className="module-time" role="cell"><small>{s.freshness === 'static' ? '估值记录' : '源数据'}</small>{formatDate(s.updatedAt, true)}</div>
    <div className="module-actions" role="cell"><button className="button secondary" onClick={onOpen}>打开<ArrowUpRight size={14} /></button><button className="icon-button" aria-label={`配置${s.project.name}`} title="配置连接" onClick={onEdit}><Settings2 size={16} /></button></div>
  </div>;
}
function ProjectsPage({ snapshots, now, onEdit, onCheck, checking }: { now: number; snapshots: Snapshot[]; onEdit: (p: Project) => void; onCheck: (p: Project) => void; checking: string | null }) {
  return <section className="panel management-panel"><div className="panel-heading"><h2>已接入项目 <span className="count-label">{snapshots.length}</span></h2><span className="muted">随工作台统一运行与更新</span></div><div className="project-table" role="table" aria-label="项目连接列表"><div className="project-table-head" role="row"><span role="columnheader">项目</span><span role="columnheader">接入方式</span><span role="columnheader">连接状态</span><span role="columnheader">操作</span></div>{snapshots.map(s => <div className="project-table-row" role="row" key={s.project.id}><div className="table-project" role="cell"><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} /></span><div><strong>{s.project.name}</strong><span>{s.project.accessMode === 'proxy' ? '通过工作台访问 · 单端口' : s.project.url || '尚未设置网页地址'}</span></div></div><div className="adapter-cell" role="cell"><span>{adapters[s.project.adapter]}</span><small>{s.project.embedded ? '工作台统一登录' : s.project.hasCredentials ? '已保存登录信息' : '未保存登录信息'}</small></div><div role="cell"><Status state={s.state} adapter={s.project.adapter} diagnostics={s.diagnostics} /><small className="table-time">检查于 {formatDate(s.checkedAt)}</small><DiagnosticDetails snapshot={s} now={now} />{s.project.adapter === 'asset' && s.sync ? <small className="table-time" title={s.sync.message}>后台同步：{({ idle: '等待同步', syncing: '正在同步', success: '已完成', partial: '部分来源异常', error: '同步失败', unauthorized: '登录信息无效', unconfigured: '待配置', disabled: '已关闭' })[s.sync.state]}</small> : null}</div><div className="row-actions" role="cell"><Button className="button ghost" busy={checking === s.project.id} disabled={checking !== null || !s.project.enabled} onClick={() => onCheck(s.project)}>检查</Button><button className="button secondary" onClick={() => onEdit(s.project)}>编辑</button></div></div>)}</div>{!snapshots.length ? <div className="empty-state"><FolderKanban /><h3>还没有项目</h3><p>点击右上角“添加项目”，登记已有服务。</p></div> : null}<div className="management-note"><ShieldCheck size={19} /><p>五个模块的页面和数据由工作台统一管理；资产后台同步可单独关闭。</p></div></section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}{hint ? <small className="field-hint">{hint}</small> : null}</label>;
}
function ProjectEditor({ project, onClose, onSaved, onExpired }: { project: Project; onClose: () => void; onSaved: (message: string) => Promise<void>; onExpired: () => void }) {
  const [staleAfterSeconds, setStale] = useState(project.staleAfterSeconds);
  const [order, setOrder] = useState(project.order);
  const [autoSync, setAutoSync] = useState(project.autoSync ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify({ staleAfterSeconds, order, ...(project.id === 'asset' ? { autoSync } : {}) }) });
      await onSaved('模块设置已保存。');
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="editor-dialog" aria-labelledby="editor-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}><form onSubmit={save}>
    <div className="editor-header"><div><h2 id="editor-title">{project.name}</h2><p>使用工作台登录，随工作台统一运行与更新。</p></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭设置"><X size={21} /></button></div>
    <div className="editor-body">{error ? <div className="error-box" role="alert">{error}</div> : null}<div className="form-grid">
      <Field label="数据过期时间（秒）" hint="按源数据更新时间判断。"><input type="number" min={30} max={86400} value={staleAfterSeconds} onChange={event => setStale(Number(event.target.value))} required autoFocus /></Field>
      <Field label="排列顺序" hint="数字越小越靠前。"><input type="number" min={0} max={9999} value={order} onChange={event => setOrder(Number(event.target.value))} required /></Field>
    </div>{project.id === 'asset' ? <label className="checkbox-field"><input type="checkbox" checked={autoSync} onChange={event => setAutoSync(event.target.checked)} />服务器每分钟同步资产，关闭页面后继续更新</label> : null}</div>
    <div className="editor-footer"><span /><div><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><Button className="button primary" type="submit" busy={busy}><Save size={16} />保存设置</Button></div></div>
  </form></dialog>;
}
