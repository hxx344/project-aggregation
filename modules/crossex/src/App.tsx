import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeftRight, RefreshCw, LayoutDashboard, CandlestickChart, ListOrdered, Settings2, ArrowUpRight } from 'lucide-react';
import { createLatestRead } from './latest-read';
import { createServerClock, sourceIsStale, STATE_POLL_MS } from './freshness';
import { cleanHubQuery, hubChanged, hubNavigate, observeReadWake, readPollDelay, useHubBridge } from './hub-bridge';
import type { LiveBootstrap, LiveExecution, LiveOrder, LivePreview, LiveState, PreviewInput } from './live-types';
import { BOOTSTRAP_REFRESH_MS, latestBootstrap, needsCatalog, parseBootstrap, readRetryDelay, stateReadPath, validCsrf } from './live-loading';
import { time } from './display';
import { executionStatus, liveStatus, stateIsUncertain } from './live-display';
import { readPendingRequest, readRequestStatus, requestStorageKey, resolveRequestStatus, writePendingRequest } from './live-requests';
import type { PendingRequest } from './live-requests';
import AccountOverview from './AccountOverview';
import PortfolioPanel from './PortfolioPanel';
import TradingTerminal from './TradingTerminal';
import ManualHedgePanel from './ManualHedgePanel';
import { useInstruments } from './live-market';
import SettingsForm from './SettingsForm';
import HistoryPanel from './HistoryPanel';
import { CancelReview, TradeReview } from './TradeReview';

type Tab = 'trade' | 'hedge' | 'positions' | 'orders' | 'settings';
const tabs: [Tab, string, typeof ArrowLeftRight][] = [['trade', '交易终端', CandlestickChart], ['hedge', '跨所对冲', ArrowLeftRight], ['positions', '投资组合', LayoutDashboard], ['orders', '订单记录', ListOrdered], ['settings', '设置', Settings2]];
const requestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');

export default function App() {
  const hub = useHubBridge('crossex');
  const [state, setState] = useState<LiveState | null>(null), [online, setOnline] = useState(false);
  const [bootstrap, setBootstrap] = useState<LiveBootstrap | null>(null), [bootstrapError, setBootstrapError] = useState(''), [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(() => tabs.some(item => item[0] === location.hash.slice(1)) ? location.hash.slice(1) as Tab : 'positions');
  const [search, setSearch] = useState('');
  const [pair, setPair] = useState<{ longExchange?: string; shortExchange?: string }>({});
  const [preview, setPreview] = useState<LivePreview | null>(null), [cancelOrder, setCancelOrder] = useState<LiveOrder | null>(null);
  const [requestStore] = useState(() => { let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Writes stay blocked when their identity cannot survive reload. */ } return { storage, key: requestStorageKey(location.pathname) }; });
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(() => readPendingRequest(requestStore.storage, requestStore.key)), [now, setNow] = useState(0);
  const pendingRef = useRef(pendingRequest);
  const requests = useRef(new Map<string, string>());
  const rememberPending = useCallback((next: PendingRequest | null) => {
    const saved = writePendingRequest(requestStore.storage, requestStore.key, next);
    if (!saved && next) return false;
    pendingRef.current = next; setPendingRequest(next); return true;
  }, [requestStore]);
  const lifecycle = useRef({ active: hub.readActive, mutating: false, tab }); lifecycle.current.active = hub.readActive; lifecycle.current.tab = tab;
  const serverClock = useRef(createServerClock());
  const instruments = useInstruments(hub.readActive && needsCatalog(tab), hub.background);
  const bootstrapFailures = useRef(0), stateFailures = useRef(0);
  const bootstrapReader = useRef<ReturnType<typeof createLatestRead<LiveBootstrap>> | null>(null);
  if (!bootstrapReader.current) bootstrapReader.current = createLatestRead<LiveBootstrap>({
    canRead: () => lifecycle.current.active && !lifecycle.current.mutating,
    load: async signal => {
      setBootstrapLoading(true);
      const response = await fetch('/api/bootstrap', { signal, cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取连接信息失败');
      return parseBootstrap(data);
    },
    onData: data => { bootstrapFailures.current = 0; setBootstrap(data); setBootstrapError(''); setBootstrapLoading(false); },
    onError: cause => { bootstrapFailures.current++; setBootstrapLoading(false); setBootstrapError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '读取连接信息超时，请重试。'); },
    timeoutMs: 8000,
  });
  const cancelBootstrap = useCallback(() => { bootstrapReader.current?.cancel(); setBootstrapLoading(false); }, []);
  const refreshBootstrap = useCallback(() => bootstrapReader.current!.refresh(), []);
  const loadBootstrap = tab === 'settings' || !bootstrap && !state;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, epoch = 0, stopped = false;
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); cancelBootstrap();
      if (!loadBootstrap || !hub.readActive || busy || stopped) return;
      const poll = async () => {
        if (version !== epoch || stopped) return;
        await refreshBootstrap();
        if (version === epoch && !stopped) timer = setTimeout(poll, readPollDelay(bootstrapFailures.current ? readRetryDelay(bootstrapFailures.current) : BOOTSTRAP_REFRESH_MS, hub.background));
      };
      void poll();
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { stopped = true; epoch++; clearTimeout(timer); cancelBootstrap(); stopWake(); };
  }, [hub.readActive, hub.background, loadBootstrap, busy, bootstrapRevision, refreshBootstrap, cancelBootstrap]);
  const reader = useRef<ReturnType<typeof createLatestRead<LiveState & { requestStartedAt: number; requestedTab: Tab }>> | null>(null);
  if (!reader.current) reader.current = createLatestRead<LiveState & { requestStartedAt: number; requestedTab: Tab }>({
    canRead: () => lifecycle.current.active && lifecycle.current.tab !== 'settings' && !lifecycle.current.mutating,
    load: async signal => {
      const requestStartedAt = performance.now(), requestedTab = lifecycle.current.tab;
      const response = await fetch(stateReadPath(requestedTab), { signal, cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取状态失败');
      if (!data.live || !validCsrf(data.csrfToken)) throw new Error('服务尚未提供完整实盘账户状态，请更新服务后重试');
      return { ...data, requestStartedAt, requestedTab };
    },
    onData: ({ requestStartedAt, requestedTab, ...data }) => {
      if (requestedTab !== lifecycle.current.tab) return;
      stateFailures.current = 0;
      serverClock.current.sample(data.now, requestStartedAt); setState(data); setOnline(true); setReadError(''); setNow(serverClock.current.now());
    },
    onError: cause => { stateFailures.current++; setOnline(false); setReadError(cause instanceof Error ? cause.name === 'TimeoutError' ? '读取超时，保留上次数据；恢复连接后继续查询。' : cause.message : '连接中断，保留上次数据。'); },
  });
  const cancelRead = useCallback(() => reader.current?.cancel(), []);
  const refresh = useCallback((force = false) => reader.current!.refresh(force), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, epoch = 0, stopped = false;
    const synchronize = () => {
      setNow(serverClock.current.now());
      const version = ++epoch; clearTimeout(timer); cancelRead();
      if (!hub.readActive || tab === 'settings' || stopped) return;
      const poll = async () => { if (version !== epoch || stopped) return; const startedAt = performance.now(); await refresh(); if (version === epoch && !stopped) timer = setTimeout(poll, readPollDelay(stateFailures.current ? readRetryDelay(stateFailures.current) : Math.max(0, STATE_POLL_MS - (performance.now() - startedAt)), hub.background)); };
      void poll();
    };
    const ageTimer = setInterval(() => { if (hub.readActive && !document.hidden) setNow(serverClock.current.now()); }, 1000);
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { stopped = true; epoch++; clearTimeout(timer); clearInterval(ageTimer); cancelRead(); stopWake(); };
  }, [hub.readActive, hub.background, tab, refresh, cancelRead]);
  useEffect(() => {
    const restore = () => {
      const params = new URL(location.href).searchParams;
      const query = cleanHubQuery(Object.fromEntries(['symbol', 'longExchange', 'shortExchange'].flatMap(key => params.has(key) ? [[key, params.get(key)!]] : [])));
      if (!query) return;
      setSearch(query.symbol || ''); setPair({ longExchange: query.longExchange, shortExchange: query.shortExchange });
      if (Object.keys(query).length) setTab('hedge');
    };
    restore(); addEventListener('popstate', restore); return () => removeEventListener('popstate', restore);
  }, []);
  useEffect(() => { const change = () => { const hash = location.hash.slice(1); if (tabs.some(item => item[0] === hash)) setTab(hash as Tab); }; addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => {
    if (!pendingRequest || !state || busy) return;
    const execution = pendingRequest.kind === 'confirm' ? state.live.executions.find(item => item.requestId === pendingRequest.id || item.id === pendingRequest.id) : null;
    const order = pendingRequest.kind === 'cancel' && pendingRequest.orderId ? state.live.orders.find(item => item.id === pendingRequest.orderId || item.orderId === pendingRequest.orderId) : null;
    if (execution && !stateIsUncertain(execution.state) || order && ['FILLED', 'CANCELLED', 'CANCELED', 'FAIL', 'REJECT', 'REJECTED', 'EXPIRED'].includes(order.status.toUpperCase())) {
      rememberPending(null); setError(''); setNotice('已查询到先前操作的结果，请核对订单与逐腿持仓。');
    }
  }, [pendingRequest, state, busy, rememberPending]);
  const connectionInfo = latestBootstrap(bootstrap, state);

  async function mutate<T>(route: string, input: object, method = 'POST', actionKey?: string): Promise<T | null> {
    const administrative = route === '/api/settings' || route === '/api/live/connection';
    const csrfToken = administrative ? connectionInfo?.csrfToken : state?.csrfToken;
    if (!validCsrf(csrfToken) || lifecycle.current.mutating || !administrative && (!state || tradingDisabled) || actionKey && pendingRef.current) return null;
    lifecycle.current.mutating = true; cancelRead(); cancelBootstrap(); setBusy(true); setError(''); setNotice('');
    let id: string | undefined;
    try {
      if (actionKey) {
        id = requests.current.get(actionKey) || requestId(); requests.current.set(actionKey, id);
        const pending: PendingRequest = { version: 1, id, kind: actionKey.startsWith('cancel:') ? 'cancel' : 'confirm', ...(actionKey.startsWith('cancel:') ? { orderId: actionKey.slice(7) } : {}) };
        if (!rememberPending(pending)) { setError('此浏览器无法保存待确认请求，委托尚未发送。请允许会话存储后重试。'); return null; }
      }
      const response = await fetch(route, { method, signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ ...input, ...(id ? { requestId: id } : {}) }) });
      const data = await response.json();
      if (!response.ok) {
        if (actionKey && data.requestStatus === 'not_submitted') { rememberPending(null); setError(data.error || '委托未提交，请重新预览。'); return null; }
        throw new Error(data.error || '请求未完成');
      }
      if (id) {
        const result = data.execution || data;
        if (data.order?.id && pendingRef.current) rememberPending({ ...pendingRef.current, orderId: data.order.id });
        const resultState = result.state || data.order?.status || result.status;
        if (resultState && !stateIsUncertain(resultState)) rememberPending(null);
      }
      if (administrative) setOnline(false);
      hubChanged(); return data as T;
    } catch (cause) {
      setError(actionKey ? '提交结果尚未确认。请查询最新状态，确认前不要再次提交。请求编号：' + id : cause instanceof Error ? cause.message : '请求未完成，请稍后重试');
      return null;
    } finally {
      lifecycle.current.mutating = false; setBusy(false);
      if (lifecycle.current.tab === 'settings') setBootstrapRevision(value => value + 1);
      else await refresh(true);
    }
  }
  const go = (value: Tab) => { setTab(value); location.hash = value; };
  const queryAccount = async () => {
    if (lifecycle.current.mutating) return;
    lifecycle.current.mutating = true; cancelRead(); cancelBootstrap(); setBusy(true); setError(''); setNotice('');
    let message = '已查询账户与订单状态。';
    try {
      const pending = pendingRef.current;
      if (pending) {
        const resolution = resolveRequestStatus(pending, await readRequestStatus(pending));
        if (resolution.resolved) {
          rememberPending(null);
          message = resolution.notSubmitted ? '服务已确认原请求未提交。可重新预览并核对后下单。' : '已查到原请求的真实结果，请核对订单与逐腿持仓。';
        } else {
          if (resolution.orderId) rememberPending({ ...pending, orderId: resolution.orderId });
          message = '原请求仍待确认，继续保留交易限制；本次仅查询账户与订单。';
        }
      }
      if (!connectionInfo) { setNotice(message); throw new Error('连接授权信息尚未读取；未发送账户刷新请求，请重试读取连接信息。'); }
      const response = await fetch('/api/live/refresh', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': connectionInfo.csrfToken }, body: '{}' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '账户查询未完成，请继续查询。');
      setNotice(message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '状态查询未完成，待确认请求已保留。'); }
    finally { lifecycle.current.mutating = false; setBusy(false); if (lifecycle.current.tab === 'settings') setBootstrapRevision(value => value + 1); else await refresh(true); }
  };
  const previewOrder = async (input: PreviewInput) => {
    const data = await mutate<LivePreview | { preview: LivePreview }>('/api/live/preview', input);
    if (data) setPreview('preview' in data ? data.preview : data);
    return !!data;
  };
  const confirmOrder = async () => {
    if (!preview) return;
    const current = preview;
    const data = await mutate<LiveExecution | { execution: LiveExecution }>('/api/live/confirm', { previewId: current.id }, 'POST', 'confirm:' + current.id);
    setPreview(null); go('orders');
    if (data) { const result = 'execution' in data ? data.execution : data; setNotice('真实委托处理状态：' + executionStatus(result.state) + '。请核对逐腿成交结果。'); }
  };
  const confirmCancel = async () => {
    if (!cancelOrder) return;
    const data = await mutate('/api/live/cancel', { orderId: cancelOrder.id }, 'POST', 'cancel:' + cancelOrder.id);
    setCancelOrder(null); if (data) setNotice('撤单请求已处理，请核对最新订单状态。');
  };
  const marketStale = sourceIsStale(state?.source, now, online);
  const live = state?.live;
  const accountStale = !online || !live || live.stale || live.partial || !live.asOf || now - live.asOf > 15_000 || live.asOf > now + 1000;
  const tradingDisabled = busy || !live?.tradingAllowed || accountStale || !!pendingRequest;
  const openingDisabled = tradingDisabled || !!state?.config.entryPaused;
  const capacityContext = live && state ? { live: { ...live, stale: accountStale }, active: hub.readActive, background: hub.background,
    csrfToken: connectionInfo?.csrfToken || state.csrfToken, now, readNow: serverClock.current.now,
    revision: JSON.stringify([state.config, !!pendingRequest, live.orders.map(o => [o.id, o.status, o.filledQuantity]), live.positions.map(p => [p.id, p.quantity])]) } : null;
  const extraAlerts = live?.alerts.map(item => typeof item === 'string' ? item : item.message || item.reason).filter((item): item is string => !!item && !live.reasons.includes(item) && item !== live.connection.error) || [];

  return <div className="app"><header className="topbar"><a className="brand" href="#positions" onClick={() => go('positions')}><span className="brand-icon"><ArrowLeftRight size={21}/></span><span>Gate <strong>CrossEx</strong></span><span className="tag live-tag">LIVE</span></a>
    <nav aria-label="模块功能">{tabs.map(([id, label, Icon]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}><Icon size={15}/>{label}</button>)}</nav>
    <div className="header-actions">{hub.connected && <button className="text-button" onClick={() => hubNavigate('monitor', { ...(search.trim() ? { symbol: search.trim().toUpperCase() } : {}), ...pair })}>Monitor <ArrowUpRight size={13}/></button>}<span className={'connection-badge ' + (!accountStale && live?.connection.connected ? 'positive' : 'warning')}><i className={'status-dot ' + (!accountStale && live?.connection.connected ? 'live' : '')}/>{!connectionInfo ? '读取连接信息' : !connectionInfo.connection.configured ? '未连接账户' : accountStale ? '待同步' : '账户已连接'}</span><button className="icon-button" disabled={busy} onClick={() => { if (tab === 'settings') void refreshBootstrap(); else void refresh(true); }} aria-label="刷新页面状态"><RefreshCw size={15}/></button><button className="primary small" onClick={() => go('settings')}>{connectionInfo?.connection.configured ? '管理账户' : '连接账户'}</button></div>
  </header><main>
    {(error || tab !== 'settings' && readError) && <div className="notice error" role="alert"><AlertCircle size={16}/><span>{error || readError}</span>{error && !pendingRequest && <button onClick={() => setError('')} aria-label="关闭操作提示">×</button>}</div>}
    {pendingRequest && <div className="notice warning" role="status"><span>存在结果待确认的操作，新的交易暂不可用。请求 {pendingRequest.id}</span><button disabled={busy} onClick={() => void queryAccount()}>查询最新状态</button></div>}
    {notice && <div className="notice success" role="status"><span>{notice}</span><button aria-label="关闭状态提示" onClick={() => setNotice('')}>×</button></div>}
    {tab === 'settings' && <><div className="view-heading"><div><span className="eyebrow">ACCOUNT & PREFERENCES</span><h2>连接与设置</h2><p>管理账户连接、行情来源和手动交易额度</p></div></div><SettingsForm config={connectionInfo?.config || null} configured={connectionInfo?.connection.configured ?? null} ready={!!connectionInfo} loading={bootstrapLoading} loadError={bootstrapError} retry={() => void refreshBootstrap()} busy={busy} save={async input => !!await mutate('/api/settings', input, 'PUT')} connect={async input => !!await mutate('/api/live/connection', input, 'PUT')} disconnect={async () => !!await mutate('/api/live/connection', {}, 'DELETE')}/></>}
    {tab === 'settings' ? null : !state || !live ? <div className="empty panel loading-state"><p>{readError ? '账户状态尚未读取，可重试或先连接账户。' : '正在读取 Gate CrossEx 账户状态…'}</p><div className="filters"><button disabled={busy} onClick={() => void refresh(true)}>重试账户状态</button><button className="primary" onClick={() => go('settings')}>连接账户</button></div></div> : <>
      <div className="account-identity"><div><span>Gate CrossEx</span><strong>{live.connection.accountId ? 'UID ' + live.connection.accountId : live.connection.connected ? 'UID 未返回' : '账户尚未连接'}</strong><span>Key {live.connection.keySuffix ? '•••• ' + live.connection.keySuffix : '—'}</span><span>{live.connection.positionMode === 'SINGLE' ? '单向持仓' : live.connection.positionMode === 'DUAL' ? '双向持仓' : '持仓模式待查询'}</span><span className={accountStale ? 'warning' : 'positive'}>{liveStatus(live.status)}</span></div><div><span>账户来源 {time(live.asOf)}</span><button className="text-button" disabled={busy || !live.connection.configured} onClick={() => void queryAccount()}><RefreshCw size={12}/>{busy ? '处理中…' : '查询账户与订单'}</button></div></div>
      {(accountStale && live.connection.configured || live.reasons.length > 0 || live.connection.error) && <div className="notice warning"><AlertCircle size={15}/><span>{[...(accountStale && live.connection.configured ? [live.partial ? '账户数据不完整，保留上次已知数据，暂停交易。' : '账户数据待更新，保留上次已知数据，暂停交易。'] : []), ...live.reasons, ...(live.connection.error ? [live.connection.error] : [])].filter((item, index, all) => all.indexOf(item) === index).join(' ')}</span></div>}
      {extraAlerts.length > 0 && <div className="notice warning" role="status"><AlertCircle size={15}/><span>{extraAlerts.join(' ')}</span></div>}
      {state.config.entryPaused && (tab === 'trade' || tab === 'hedge') && <p className="inline-state warning">新开仓已暂停，可在设置中恢复；仍可手动平仓和撤单。</p>}
      {tab === 'positions' && <><div className="view-heading portfolio-heading"><div><span className="eyebrow">PORTFOLIO</span><h2>投资组合</h2><p>统一保证金概览与跨交易所真实持仓</p></div><div className="portfolio-count"><strong>{new Set(live.positions.map(p => p.baseCurrency || p.symbol)).size}</strong><span>个币种 <b>·</b> {live.positions.length} 条持仓腿</span></div></div><AccountOverview live={live}/><PortfolioPanel live={live} instruments={instruments.items} disabled={tradingDisabled} close={positions => previewOrder({ kind: 'close', positions })}/></>}
      {tab === 'trade' && <TradingTerminal instruments={instruments.items} catalogError={instruments.error} live={live} budget={state.config.notionalPerLeg} active={hub.readActive} background={hub.background} disabled={openingDisabled} preview={previewOrder} capacityContext={capacityContext!}/>}
      {tab === 'hedge' && <ManualHedgePanel key={[search, pair.longExchange, pair.shortExchange].join(':')} instruments={instruments.items} catalogError={instruments.error} live={live} budget={state.config.notionalPerLeg} active={hub.readActive} background={hub.background} disabled={openingDisabled} opportunities={state.opportunities} now={now} initial={{ base: search, ...pair }} monitorStale={marketStale} preview={previewOrder} capacityContext={capacityContext!}/>}
      {tab === 'orders' && <><div className="view-heading"><div><span className="eyebrow">ORDERS & EXECUTIONS</span><h2>订单与操作记录</h2><p>核对真实成交状态，管理尚未成交的委托</p></div></div><HistoryPanel live={live} disabled={tradingDisabled} querying={busy} query={() => void queryAccount()} cancel={setCancelOrder}/></>}

    </>}
    <footer className="app-footer"><span><i className="status-dot"/>手动实盘 · 北京时间 · 2 秒状态刷新</span><span><a href="https://github.com/hxx344/gate-crossex-arbitrage" target="_blank" rel="noreferrer">源代码</a><b>·</b><a href="https://github.com/your-quantguy/gate-crossex" target="_blank" rel="noreferrer">参考 your-quantguy/gate-crossex</a><b>·</b><a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0-only</a></span></footer>
  </main>
  {preview && <TradeReview key={preview.id} preview={preview} now={now} busy={busy} disabled={preview.kind === 'open' ? openingDisabled : tradingDisabled} close={() => setPreview(null)} confirm={() => void confirmOrder()}/>}
  {cancelOrder && <CancelReview order={cancelOrder} busy={busy} disabled={tradingDisabled} close={() => setCancelOrder(null)} confirm={() => void confirmCancel()}/>}
  </div>;
}
