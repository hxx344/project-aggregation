import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowUpRight, Check, ChevronRight, CircleAlert, ExternalLink, FolderKanban, Gauge, LayoutDashboard, LoaderCircle, LogOut, Menu, Plus, RefreshCw, Save, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { api, ApiError, setCsrfToken } from './api';
import type { Adapter, Category, Metric, Overview, Project, ProjectInput, Snapshot } from './types';

const TrendChart = lazy(() => import('./TrendChart'));
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="chart-empty" role="status"><CircleAlert size={24} /><span>图表暂时无法载入</span><small>页面更新或连接恢复后，刷新即可重试。</small><button className="button secondary" onClick={() => location.reload()}>刷新页面</button></div> : this.props.children;
  }
}
const categories: Record<Category, string> = { trading: '交易执行', monitoring: '市场监控', assets: '资产管理', other: '其他项目' };
const adapters: Record<Adapter, string> = { aster: 'Aster 交易工作台', monitor: 'Market Monitor', asset: '资产账本', standard: '标准概览接口', link: '仅网页入口' };
const statusText: Record<Snapshot['state'], string> = { unconfigured: '待配置', online: '已连接', stale: '数据过期', offline: '连接中断', unauthorized: '需要登录', disabled: '已停用', partial: '部分数据异常' };
type Route = { view: 'overview' | 'projects' | 'project'; id: string };

function readRoute(): Route {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  return { view: view === 'projects' || view === 'project' ? view : 'overview', id: params.get('id') || '' };
}
function formatDate(value: string | null, full = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', { ...(full ? { month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
function metricValue(metric?: Metric) {
  if (!metric || metric.value === null) return '—';
  return typeof metric.value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(metric.value) : metric.value;
}
function ProjectIcon({ category, size = 22 }: { category: Category; size?: number }) {
  return category === 'assets' ? <Wallet size={size} /> : category === 'monitoring' ? <Activity size={size} /> : category === 'trading' ? <Gauge size={size} /> : <FolderKanban size={size} />;
}
function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>集序<small>项目工作台</small></span></div>; }
function Status({ state, adapter }: { state: Snapshot['state']; adapter?: Adapter }) { if (adapter === 'link' && state === 'online') return <span className="status unconfigured">网页入口</span>; return <span className={`status ${state}`}><span aria-hidden="true" />{statusText[state]}</span>; }
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
    <section className="login-intro"><Brand /><div className="login-copy"><h1>每个项目，<br />各就其位。</h1><p>交易的进度，市场的变化，资产的全貌。<br />在一个工作台里，找到现在需要关注的事。</p><div className="login-projects"><span><Gauge />Aster 交易</span><span><Activity />市场监控</span><span><Wallet />资产账本</span></div></div><span className="login-footer">独立运行 · 统一查看</span></section>
    <section className="login-side"><form className="login-form" onSubmit={submit}><div className="login-symbol"><LayoutDashboard size={25} /></div><h2>进入工作台</h2><p>使用安装时生成的工作台密码登录。</p><label htmlFor="password">工作台密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus />{error ? <div className="error-box" role="alert">{error}</div> : null}<Button className="button primary wide" type="submit" busy={busy}>登录<ChevronRight size={18} /></Button><div className="login-note"><ShieldCheck size={17} />项目登录信息仅保存在你的服务器上</div></form></section>
  </div>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<Project | 'new' | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
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

  const expire = useCallback(() => { requestVersion.current++; setAuthenticated(false); setOverview(null); setEditor(null); setCsrfToken(''); }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<{ authenticated: boolean; csrfToken?: string }>('/api/session', { signal: controller.signal }).then(s => { setCsrfToken(s.csrfToken || ''); setAuthenticated(s.authenticated); }).catch(e => { if (e.name !== 'AbortError') { setAuthenticated(false); setError('工作台服务暂时不可用，请检查服务后刷新。'); } });
    return () => controller.abort();
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try { const data = await api<Overview>('/api/overview', { signal }); if (version === requestVersion.current) { setOverview(data); setError(''); } }
    catch (e) { if (e instanceof ApiError && e.status === 401) expire(); else if (e instanceof Error && e.name !== 'AbortError' && version === requestVersion.current) setError(e.message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [expire]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    void load(controller.signal);
    const refresh = () => { if (document.visibilityState === 'visible') void load(controller.signal); };
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('online', refresh);
    return () => { controller.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
  }, [authenticated, load]);
  useEffect(() => { const change = () => setRoute(readRoute()); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const navigate = (next: Route) => {
    const params = new URLSearchParams(); if (next.view !== 'overview') params.set('view', next.view); if (next.view === 'project') params.set('id', next.id);
    history.pushState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`); setRoute(next); setMenuOpen(false); if (menuOpen) mobileMenuButton.current?.focus(); window.scrollTo(0, 0);
  };
  const check = async (project: Project) => {
    setChecking(project.id);
    try { const result = await api<{ snapshot: Snapshot }>(`/api/projects/${encodeURIComponent(project.id)}/check`, { method: 'POST' }); setNotice(`${project.name}：${project.adapter === 'link' ? '网页入口已配置，未检测可达性' : statusText[result.snapshot.state]}`); await load(); }
    catch (e) { if (e instanceof ApiError && e.status === 401) expire(); else setError(e instanceof Error ? e.message : '连接检查失败'); }
    finally { setChecking(null); }
  };
  const logout = async () => {
    try { await api('/api/logout', { method: 'POST' }); expire(); }
    catch (e) { setError(e instanceof Error ? e.message : '退出失败，请重试'); }
  };
  if (authenticated === null) return <div className="app-loading"><LoaderCircle className="spin" /><p>正在打开工作台</p></div>;
  if (!authenticated) return <>{error ? <div className="service-error" role="alert">{error}</div> : null}<Login onLogin={() => { setError(''); setAuthenticated(true); }} /></>;
  const snapshots = overview?.projects || [];
  const selected = snapshots.find(s => s.project.id === route.id);
  const pageTitle = route.view === 'overview' ? '总览' : route.view === 'projects' ? '项目管理' : selected?.project.name || '项目详情';
  return <div className="app-shell">
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    {menuOpen ? <button className="nav-backdrop" aria-label="关闭导航" onClick={() => { setMenuOpen(false); mobileMenuButton.current?.focus(); }} /> : null}
    <aside ref={sidebar} className={`sidebar ${menuOpen ? 'open' : ''}`}><Brand /><nav aria-label="主导航"><button className={`nav-item ${route.view === 'overview' ? 'active' : ''}`} onClick={() => navigate({ view: 'overview', id: '' })}><LayoutDashboard size={19} />总览</button><div className="nav-label">我的项目 <span>{snapshots.length}</span></div>{snapshots.map(s => <button key={s.project.id} className={`nav-item project-nav ${route.view === 'project' && route.id === s.project.id ? 'active' : ''}`} onClick={() => navigate({ view: 'project', id: s.project.id })}><ProjectIcon category={s.project.category} size={19} /><span>{s.project.name}</span><span className={`nav-status ${s.project.adapter === 'link' ? 'unconfigured' : s.state}`} aria-label={s.project.adapter === 'link' ? '网页入口' : statusText[s.state]} /></button>)}<button className={`nav-item manage-nav ${route.view === 'projects' ? 'active' : ''}`} onClick={() => navigate({ view: 'projects', id: '' })}><Settings2 size={19} />项目管理</button></nav><div className="sidebar-bottom"><div><span className="workspace-avatar">私</span><span>个人工作台<small>数据保存在自有服务器</small></span></div><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={() => void logout()}><LogOut size={18} /></button></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button ref={mobileMenuButton} className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} /></button><span>工作台</span><ChevronRight size={14} /><strong>{pageTitle}</strong></div><div className="topbar-right"><span className="refresh-label">总览读取于 {formatDate(overview?.generatedAt || null)}</span><button className="icon-button" aria-label="刷新总览" title="刷新总览" disabled={loading} onClick={() => void load()}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div></header>
      <main id="main-content" className="main-content"><div className="page-heading"><div><h1>{pageTitle}</h1><p>{route.view === 'overview' ? '先看当前状态，再进入需要处理的项目。' : route.view === 'projects' ? '配置连接，管理入口，接入后续项目。' : selected?.project.description}</p></div>{route.view === 'projects' ? <Button className="button primary" onClick={() => setEditor('new')}><Plus size={18} />添加项目</Button> : <span className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span>}</div>
      {error ? <div className="error-box inline-error" role="alert"><CircleAlert size={18} />{error}<button onClick={() => void load()}>重试</button></div> : null}
      {!overview ? <div className="empty-state loading-state"><LoaderCircle className="spin" /><h2>正在读取项目</h2><p>各项目独立连接，结果会在这里显示。</p></div> : route.view === 'overview' ? <OverviewPage snapshots={snapshots} onProject={id => navigate({ view: 'project', id })} onEdit={setEditor} onManage={() => navigate({ view: 'projects', id: '' })} /> : route.view === 'projects' ? <ProjectsPage snapshots={snapshots} onEdit={setEditor} onCheck={check} checking={checking} /> : selected ? <ProjectPage snapshot={selected} onEdit={() => setEditor(selected.project)} onCheck={() => void check(selected.project)} checking={checking === selected.project.id} /> : <div className="empty-state"><FolderKanban /><h2>没有找到这个项目</h2><p>项目可能已被移除，请回到项目管理查看。</p><button className="button secondary" onClick={() => navigate({ view: 'projects', id: '' })}>查看项目</button></div>}
      </main><footer className="workspace-footer"><span>各项目独立运行，工作台汇总展示。</span><span>时间按本机时区显示</span></footer>
    </div>
    {editor ? <ProjectEditor key={editor === 'new' ? 'new' : editor.id} project={editor} onClose={() => setEditor(null)} onSaved={async message => { setEditor(null); setNotice(message); await load(); }} onExpired={expire} /> : null}
    {notice ? <div className="toast" role="status"><Check size={18} />{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div> : null}
  </div>;
}

function OverviewPage({ snapshots, onProject, onEdit, onManage }: { snapshots: Snapshot[]; onProject: (id: string) => void; onEdit: (p: Project) => void; onManage: () => void }) {
  const enabled = snapshots.filter(s => s.project.enabled && s.project.adapter !== 'link');
  const online = enabled.filter(s => s.state === 'online').length;
  const attention = enabled.filter(s => !['online', 'unconfigured'].includes(s.state));
  const asset = enabled.find(s => s.project.adapter === 'asset');
  const firstMetric = asset?.metrics[0];
  return <>
    <div className="overview-strip"><div><span className="strip-icon"><FolderKanban size={21} /></span><div><strong>{snapshots.length}<small>个项目</small></strong><span>已接入工作台</span></div></div><div><span className="strip-icon connected"><Activity size={21} /></span><div><strong>{online}<small>/ {enabled.length}</small></strong><span>连接正常</span></div></div><div><span className="strip-icon attention"><CircleAlert size={21} /></span><div><strong>{attention.length}<small>个项目</small></strong><span>需要关注</span></div></div><button onClick={onManage}>管理接入<ChevronRight size={17} /></button></div>
    <div className="overview-grid"><section className="asset-panel panel"><div className="panel-heading"><h2><Wallet size={19} />资产概览</h2>{asset ? <Status state={asset.state} /> : <span className="muted">未接入账本</span>}</div><div className="asset-number"><span>{firstMetric?.label || '表内总额'}</span><div>{metricValue(firstMetric)}<small>{firstMetric?.unit || 'USD'}</small></div><p>{asset?.updatedAt ? `${asset.freshness === 'static' ? '手工估值记录于' : '源数据更新于'} ${formatDate(asset.updatedAt, true)}` : '连接资产账本后展示已有记录'}</p></div>{asset?.trend && asset.trend.length > 1 ? <ChartBoundary><Suspense fallback={<div className="chart-empty">正在载入历史曲线</div>}><TrendChart points={asset.trend} label="表内总额" unit="USD" /></Suspense></ChartBoundary> : <div className="chart-empty"><Wallet size={26} /><span>暂无可展示的资产曲线</span><small>只显示账本中的真实历史记录</small></div>}<div className="panel-footer"><span>来自资产账本，不重复累加交易账户余额</span>{asset ? <button onClick={() => onProject(asset.project.id)}>查看账本<ArrowUpRight size={15} /></button> : null}</div></section>
    <section className="attention-panel panel"><div className="panel-heading"><h2><CircleAlert size={19} />当前关注</h2><span className="count-label">{attention.length}</span></div>{attention.length ? <div className="attention-list">{attention.slice(0, 5).map(s => <div className="attention-item" key={s.project.id}><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} size={19} /></span><div><strong>{s.project.name}</strong><p>{s.message || statusText[s.state]}</p><button onClick={() => onEdit(s.project)}>{s.state === 'unauthorized' || s.state === 'unconfigured' ? '配置连接' : '检查设置'}<ChevronRight size={14} /></button></div></div>)}</div> : <div className="empty-state compact"><ShieldCheck size={32} /><h3>{enabled.length ? '暂无连接异常' : '接入你的第一个项目'}</h3><p>{enabled.length ? '每个项目的数据时效仍按来源单独判断。' : '在项目管理中添加页面和数据连接。'}</p></div>}<div className="attention-note">服务在线与数据更新分别检查，旧值保留原始时间。</div></section></div>
    <section className="projects-overview"><div className="section-heading"><h2>项目工作区</h2><button className="text-button" onClick={onManage}>管理项目<ChevronRight size={16} /></button></div><div className="project-grid">{snapshots.map(s => <ProjectCard key={s.project.id} snapshot={s} onOpen={() => onProject(s.project.id)} onEdit={() => onEdit(s.project)} />)}</div>{!snapshots.length ? <div className="empty-state"><FolderKanban /><p>添加项目后，概览会出现在这里。</p><button className="button secondary" onClick={onManage}>添加项目</button></div> : null}</section>
  </>;
}
function MetricView({ metric }: { metric: Metric }) { return <div className="metric"><span>{metric.label}</span><strong>{metricValue(metric)}{metric.unit ? <small>{metric.unit}</small> : null}</strong>{metric.detail ? <p>{metric.detail}</p> : null}</div>; }
function ProjectCard({ snapshot: s, onOpen, onEdit }: { snapshot: Snapshot; onOpen: () => void; onEdit: () => void }) {
  return <article className="project-card"><div className="project-card-top"><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} /></span><Status state={s.state} adapter={s.project.adapter} /></div><h3>{s.project.name}</h3><p className="project-description">{s.project.description || categories[s.project.category]}</p>{s.metrics.length ? <div className="mini-metrics">{s.metrics.slice(0, 2).map(m => <MetricView metric={m} key={m.key} />)}</div> : <div className="project-empty"><span>暂未取得概览数据</span><small>{s.message || '配置数据连接后自动读取'}</small></div>}<div className="project-time">{s.freshness === 'static' ? '手工估值记录' : '源数据'} {formatDate(s.updatedAt, true)}</div><div className="project-card-actions"><button className="button secondary" onClick={onOpen}>进入项目<ArrowUpRight size={15} /></button><button className="icon-button" aria-label={`配置${s.project.name}`} title="配置连接" onClick={onEdit}><Settings2 size={17} /></button></div></article>;
}
function ProjectsPage({ snapshots, onEdit, onCheck, checking }: { snapshots: Snapshot[]; onEdit: (p: Project) => void; onCheck: (p: Project) => void; checking: string | null }) {
  return <section className="panel management-panel"><div className="panel-heading"><h2>已接入项目 <span className="count-label">{snapshots.length}</span></h2><span className="muted">支持独立服务和网页入口</span></div><div className="project-table" role="table" aria-label="项目连接列表"><div className="project-table-head" role="row"><span role="columnheader">项目</span><span role="columnheader">接入方式</span><span role="columnheader">连接状态</span><span role="columnheader">操作</span></div>{snapshots.map(s => <div className="project-table-row" role="row" key={s.project.id}><div className="table-project" role="cell"><span className={`project-icon ${s.project.category}`}><ProjectIcon category={s.project.category} /></span><div><strong>{s.project.name}</strong><span>{s.project.url || '尚未设置网页地址'}</span></div></div><div className="adapter-cell" role="cell"><span>{adapters[s.project.adapter]}</span><small>{s.project.hasCredentials ? '已保存登录信息' : '未保存登录信息'}</small></div><div role="cell"><Status state={s.state} adapter={s.project.adapter} /><small className="table-time">检查于 {formatDate(s.checkedAt)}</small></div><div className="row-actions" role="cell"><Button className="button ghost" busy={checking === s.project.id} disabled={checking !== null || !s.project.enabled} onClick={() => onCheck(s.project)}>检查</Button><button className="button secondary" onClick={() => onEdit(s.project)}>编辑</button></div></div>)}</div>{!snapshots.length ? <div className="empty-state"><FolderKanban /><h3>还没有项目</h3><p>点击右上角“添加项目”，登记已有服务。</p></div> : null}<div className="management-note"><ShieldCheck size={19} /><p>这里保存的是各项目的网页登录信息。工作台只读取概览，交易、资产编辑等操作在原项目中完成。</p></div></section>;
}
function ProjectPage({ snapshot: s, onEdit, onCheck, checking }: { snapshot: Snapshot; onEdit: () => void; onCheck: () => void; checking: boolean }) {
  const [showEmbed, setShowEmbed] = useState(false);
  useEffect(() => { setShowEmbed(false); }, [s.project.id]);
  return <>
    <div className="project-toolbar"><div><Status state={s.state} adapter={s.project.adapter} /><span className="muted">检查于 {formatDate(s.checkedAt, true)}</span></div><div><Button className="button secondary" onClick={onCheck} busy={checking} disabled={!s.project.enabled}><RefreshCw size={16} />检查连接</Button><button className="button secondary" onClick={onEdit}><Settings2 size={16} />配置连接</button>{s.project.url ? <a className="button primary" href={s.project.url} target="_blank" rel="noopener noreferrer">打开原项目<ExternalLink size={16} /></a> : null}</div></div>
    {s.state !== 'online' ? <div className={`connection-banner ${s.state}`} role="status"><CircleAlert size={20} /><div><strong>{statusText[s.state]}</strong><p>{s.message || '请在连接设置中补全项目地址和登录信息。'}</p>{s.updatedAt ? <small>以下保留上次取得的数据，源时间为 {formatDate(s.updatedAt, true)}。</small> : null}</div></div> : null}
    <section className="panel details-panel"><div className="panel-heading"><h2>项目概览</h2><span className="muted">{s.freshness === 'static' ? '手工估值记录于' : '源数据更新于'} {formatDate(s.updatedAt, true)}</span></div>{s.metrics.length ? <div className="detail-metrics">{s.metrics.map(m => <MetricView key={m.key} metric={m} />)}</div> : <div className="empty-state"><ProjectIcon category={s.project.category} size={34} /><h3>{s.project.adapter === 'link' ? '此项目作为网页入口接入' : '等待项目数据'}</h3><p>{s.project.adapter === 'link' ? '通过“打开原项目”访问完整功能。' : '检查连接后，已保存的概览指标会出现在这里。'}</p><button className="button secondary" onClick={onEdit}>配置连接</button></div>}{s.trend && s.trend.length > 1 ? <div className="detail-chart"><h3>历史记录</h3><ChartBoundary><Suspense fallback={<p>正在载入曲线</p>}><TrendChart points={s.trend} label={s.project.adapter === 'asset' ? '表内总额' : '记录值'} unit={s.project.adapter === 'asset' ? 'USD' : undefined} /></Suspense></ChartBoundary></div> : null}</section>
    {s.project.mode === 'embed' && s.project.url ? <section className="panel embedded-panel"><div className="panel-heading"><h2>完整页面</h2><a className="text-button" href={s.project.url} target="_blank" rel="noopener noreferrer">单独打开<ExternalLink size={15} /></a></div><p className="embed-note">原项目可能需要再次登录。如果页面禁止嵌入或无法打开，请使用“单独打开”。</p>{showEmbed ? <iframe title={`${s.project.name}完整页面`} src={s.project.url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" /> : <div className="embed-start"><button className="button secondary" onClick={() => setShowEmbed(true)}>载入项目页面</button><span>按需载入，避免多个页面同时刷新。</span></div>}</section> : null}
  </>;
}

const newProject: ProjectInput = { id: '', name: '', description: '', category: 'other', adapter: 'standard', url: '', apiUrl: '', mode: 'external', enabled: true, staleAfterSeconds: 120, order: 100, username: '' };
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>; }
function ProjectEditor({ project, onClose, onSaved, onExpired }: { project: Project | 'new'; onClose: () => void; onSaved: (message: string) => Promise<void>; onExpired: () => void }) {
  const isNew = project === 'new';
  const [form, setForm] = useState<ProjectInput>(() => isNew ? { ...newProject } : { ...project, password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const connectionChanged = !isNew && project.hasCredentials && (form.apiUrl.replace(/\/+$/, '') !== project.apiUrl.replace(/\/+$/, '') || form.adapter !== project.adapter || (form.authOrigin || '').replace(/\/+$/, '') !== (project.authOrigin || '').replace(/\/+$/, ''));
  const update = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setForm(current => ({ ...current, [key]: value }));
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(); return () => element?.close(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    if (connectionChanged && form.adapter !== 'link' && !form.password && !form.clearCredentials) { setError('服务地址、登录来源或接入方式已改变，请重新输入密码，或勾选清除登录信息。'); setBusy(false); return; }
    try {
      const body = { id: form.id.trim(), name: form.name.trim(), description: form.description, category: form.category, adapter: form.adapter, url: form.url, apiUrl: form.apiUrl, authOrigin: form.authOrigin || '', mode: form.mode, enabled: form.enabled, staleAfterSeconds: form.staleAfterSeconds, order: form.order, username: form.username, password: form.password || undefined, clearCredentials: !!form.clearCredentials };
      await api(isNew ? '/api/projects' : `/api/projects/${encodeURIComponent(project.id)}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) });
      await onSaved(isNew ? '项目已添加，后台开始检查连接。' : '连接设置已保存。');
    } catch (e) { if (e instanceof ApiError && e.status === 401) onExpired(); else setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (isNew) return; setBusy(true); setError('');
    try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' }); await onSaved('项目已从工作台移除，原项目不受影响。'); }
    catch (e) { if (e instanceof ApiError && e.status === 401) onExpired(); else setError(e instanceof Error ? e.message : '移除失败'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="editor-dialog" aria-labelledby="editor-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}><form onSubmit={save}><div className="editor-header"><div><h2 id="editor-title">{isNew ? '添加项目' : `编辑${project.name}`}</h2><p>连接已有服务，保留项目独立运行。</p></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭编辑"><X size={21} /></button></div><div className="editor-body">{error ? <div className="error-box" role="alert">{error}</div> : null}<div className="form-grid"><Field label="项目名称"><input value={form.name} onChange={e => update('name', e.target.value)} maxLength={60} required autoFocus /></Field><Field label="项目标识" hint="小写字母、数字和连字符；保存后不可修改"><input value={form.id} onChange={e => update('id', e.target.value)} pattern="[a-z0-9](?:[a-z0-9]|-){0,39}" maxLength={40} required disabled={!isNew} /></Field><Field label="项目分类"><select value={form.category} onChange={e => update('category', e.target.value as Category)}>{Object.entries(categories).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></Field><Field label="数据接入方式"><select value={form.adapter} onChange={e => update('adapter', e.target.value as Adapter)}>{Object.entries(adapters).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></Field></div><Field label="项目说明"><input value={form.description} onChange={e => update('description', e.target.value)} maxLength={200} placeholder="这个项目主要用来做什么" /></Field><Field label="网页地址" hint="你在浏览器中打开项目的地址，可包含页面参数。"><input type="url" value={form.url} onChange={e => update('url', e.target.value)} placeholder="http://127.0.0.1:3000/?monitor=oil" /></Field>{form.adapter !== 'link' ? <><Field label="服务地址" hint="工作台服务器访问项目的地址。同机部署可使用 127.0.0.1。"><input type="url" value={form.apiUrl} onChange={e => update('apiUrl', e.target.value)} placeholder="http://127.0.0.1:3000" /></Field>{(form.adapter === 'aster' || form.adapter === 'asset') ? <Field label="登录来源地址（可选）" hint="原项目设置了公开访问域名时填写该域名；留空时使用服务地址。"><input type="url" value={form.authOrigin || ''} onChange={e => update('authOrigin', e.target.value)} placeholder="https://asset.example.com" /></Field> : null}<div className="form-section-title">项目登录</div>{form.adapter === 'monitor' || form.adapter === 'standard' ? <Field label="用户名" hint={form.adapter === 'standard' ? '标准接口可选 HTTP Basic 登录。' : undefined}><input value={form.username || ''} onChange={e => update('username', e.target.value)} autoComplete="off" /></Field> : null}<Field label="项目网页登录密码" hint={connectionChanged ? '服务地址、登录来源或接入方式已改变，请重新输入密码；旧密码不会发送到新地址。' : !isNew && project.hasCredentials ? '已保存密码；留空表示保留，不会回显原密码。' : '使用已有项目的网页登录密码，不要填写交易所 API 密钥。'}><input type="password" value={form.password || ''} onChange={e => update('password', e.target.value)} autoComplete="new-password" /></Field>{!isNew && project.hasCredentials ? <label className="checkbox-field"><input type="checkbox" checked={!!form.clearCredentials} onChange={e => update('clearCredentials', e.target.checked)} />清除已保存的登录信息</label> : null}</> : null}<div className="form-section-title">展示与刷新</div><div className="form-grid"><Field label="完整页面打开方式"><select value={form.mode} onChange={e => update('mode', e.target.value as 'external' | 'embed')}><option value="external">独立打开原项目</option><option value="embed">在工作台内按需嵌入</option></select></Field><Field label="数据过期时间（秒）" hint="按源数据更新时间判断，默认 120 秒。"><input type="number" min={30} max={86400} value={form.staleAfterSeconds} onChange={e => update('staleAfterSeconds', Number(e.target.value))} required /></Field><Field label="排列顺序" hint="数字越小越靠前"><input type="number" min={0} max={9999} value={form.order} onChange={e => update('order', Number(e.target.value))} required /></Field><label className="checkbox-field enable-field"><input type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} />启用此项目的连接</label></div>{form.mode === 'embed' ? <p className="field-hint">嵌入需要原页面允许；网页地址必须能由当前浏览器访问。</p> : null}{confirmDelete ? <div className="delete-confirm" role="alert"><p>从工作台移除“{form.name}”？已保存的连接信息会删除，原项目和业务数据不受影响。</p><button className="button danger" type="button" disabled={busy} onClick={() => void remove()}>确认移除</button><button className="button ghost" type="button" onClick={() => setConfirmDelete(false)}>保留项目</button></div> : null}</div><div className="editor-footer">{!isNew ? <button type="button" className="text-button danger-text" disabled={busy} onClick={() => setConfirmDelete(true)}>移除项目</button> : <span />}<div><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><Button className="button primary" type="submit" busy={busy}><Save size={16} />保存设置</Button></div></div></form></dialog>;
}
