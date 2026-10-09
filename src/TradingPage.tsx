import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { ChevronDown, CircleAlert, Link2, LoaderCircle, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { api, ApiError } from './api';
import { ageTradingData, normalizeTradingPair, pairExchanges, tradingCacheNow } from './trading-cache';
import type { TradingCache } from './trading-cache';
import TradingFundingChart from './TradingFundingChart';
import TradingPnlChart from './TradingPnlChart';
import TradingExecution from './TradingExecution';
import type { TradingAccount, TradingAccountMode, TradingExchange, TradingImportSelection, TradingImportSource, TradingLeg, TradingPair, TradingPosition, TradingReadState, TradingState } from './trading-types';
import './trading.css';

const exchangeNames = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
const accountModeNames: Record<TradingAccountMode, string> = { standard: '普通 U 本位', 'portfolio-margin': '组合保证金（Portfolio Margin）', unified: '统一交易账户', cross: '全仓', isolated: '逐仓' };
type ImportRequest = TradingImportSelection & { revision: number; accountMode: TradingAccountMode };
const stateNames: Record<TradingReadState, string> = { unconfigured: '未连接', loading: '同步中', live: '已同步', stale: '数据已过期', error: '读取失败' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const readDays = (): 7 | 30 => new URLSearchParams(location.search).get('tradingDays') === '30' ? 30 : 7;
const readPair = () => normalizeTradingPair(new URLSearchParams(location.search).get('tradingPair'));
const formatDate = (value: string | null) => value && Number.isFinite(new Date(value).getTime()) ? dateFormat.format(new Date(value)) : '尚未同步';

// Keep decimal strings intact. Positions and receipts can exceed Number precision.
function amount(value: string | null, signed = false) {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const negative = value.startsWith('-');
  const [integer, fraction] = value.replace(/^-/, '').split('.');
  const nonzero = /[1-9]/.test(value);
  const decimals = fraction?.replace(/0+$/, '');
  return `${negative && nonzero ? '−' : signed && nonzero ? '+' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals ? `.${decimals}` : ''}`;
}
function polarity(value: string | null) { return value === null || !/[1-9]/.test(value) ? '' : value.startsWith('-') ? 'trading-negative' : 'trading-positive'; }
function ReadStatus({ state }: { state: TradingReadState }) { return <span className={`trading-status ${state}`}><i aria-hidden="true" />{stateNames[state]}</span>; }

function PositionDetails({ position }: { position: TradingPosition }) {
  return <details className="trading-position-details"><summary>仓位详情<ChevronDown size={13} /></summary><dl>
    <div><dt>持仓模式</dt><dd>{position.mode === 'hedge' ? '双向持仓' : '单向持仓'}</dd></div>
    {position.marginMode ? <div><dt>保证金模式</dt><dd>{accountModeNames[position.marginMode]}</dd></div> : null}
    {position.contractSize ? <div><dt>合约乘数 · 底层单位/张</dt><dd>{amount(position.contractSize)}</dd></div> : null}
    <div><dt>杠杆</dt><dd>{amount(position.leverage)}{position.leverage !== null ? '×' : ''}</dd></div>
    <div><dt>强平价 · USDT/底层单位</dt><dd>{amount(position.liquidationPrice)}</dd></div>
    <div><dt>交易所仓位变更时间</dt><dd>{position.sourceUpdatedAt ? formatDate(position.sourceUpdatedAt) : '交易所未提供'}</dd></div>
  </dl></details>;
}
function PositionRow({ leg, position, first }: { leg: TradingLeg; position: TradingPosition | null; first: boolean }) {
  return <tr className={first ? 'trading-leg-start' : ''} data-leg={leg.id}>
    <th scope="row" className="trading-leg-name"><strong>{position?.instrumentId ?? leg.symbol}</strong><span>{exchangeNames[leg.exchange]}</span>{first ? <ReadStatus state={leg.state} /> : <small>同一合约的另一仓位</small>}</th>
    <td data-label="方向">{position ? <span className={`trading-side ${position.side}`}>{position.side === 'long' ? '做多' : '做空'}</span> : <span className="trading-muted">{leg.state === 'live' ? '无持仓' : '暂无仓位数据'}</span>}</td>
    <td data-label="合约数量">{amount(position?.quantity ?? null)}{position && leg.exchange === 'okx' ? ' 张' : ''}</td>
    <td data-label="开仓均价 · USDT/底层单位">{amount(position?.entryPrice ?? null)}</td>
    <td data-label="标记价格 · USDT/底层单位">{amount(position?.markPrice ?? null)}</td>
    <td data-label="名义价值 · USDT">{amount(position?.notional ?? null)}</td>
    <td data-label="未实现盈亏 · USDT" className={polarity(position?.unrealizedPnl ?? null)}>{amount(position?.unrealizedPnl ?? null, true)}</td>
    <td className="trading-details-cell">{position ? <PositionDetails position={position} /> : null}</td>
  </tr>;
}
function AccountConnection({ account, busy, mutate, sources, sourcesLoading, importAccount }: {
  account: TradingAccount; busy: boolean;
  mutate: (exchange: TradingExchange, method: 'PUT' | 'DELETE', body: object) => Promise<boolean>;
  sources: TradingImportSource[] | null; sourcesLoading: boolean;
  importAccount: (exchange: TradingExchange, body: ImportRequest) => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [apiPassphrase, setApiPassphrase] = useState('');
  const [accountMode, setAccountMode] = useState<TradingAccountMode>(account.accountMode ?? (account.exchange === 'binance' ? 'standard' : 'unified'));
  const [selection, setSelection] = useState<TradingImportSelection | null>(null);
  const choices = (sources ?? []).map(source => {
    const connection = source.connections.find(item => item.exchange === account.exchange);
    const available = source.status === 'ready' && connection?.configured && connection.supported && !!connection.revision;
    const description = source.status !== 'ready' ? source.status === 'unconfigured' ? '未配置登录连接' : '暂不可用' : connection && !connection.supported ? connection.reason || '不支持导入' : !connection?.configured ? `未配置 ${exchangeNames[account.exchange]} 密钥` : connection.label ? `密钥尾号 ${connection.label}` : '已保存只读候选密钥';
    return { source, connection, available, description };
  });
  // Keep the user's chosen revisions. Refreshing metadata must never silently choose a new key.
  const chosen = choices.find(({ source, connection, available }) => available && source.projectId === selection?.projectId && source.projectRevision === selection.projectRevision && connection?.revision === selection.sourceRevision);
  function choose(projectId: string) {
    const choice = choices.find(item => item.available && item.source.projectId === projectId);
    setSelection(choice?.connection?.revision ? { projectId, projectRevision: choice.source.projectRevision, sourceRevision: choice.connection.revision } : null);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { revision: account.revision, accountMode, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), ...(account.exchange === 'okx' ? { passphrase: apiPassphrase.trim() } : {}) };
    setApiPassphrase('');
    if (await mutate(account.exchange, 'PUT', body)) { setApiKey(''); setApiSecret(''); }
  }
  async function disconnect() {
    if (await mutate(account.exchange, 'DELETE', { revision: account.revision })) { setApiKey(''); setApiSecret(''); setApiPassphrase(''); }
  }
  async function importSelected() {
    if (!chosen || !selection || busy || sourcesLoading) return;
    if (await importAccount(account.exchange, { revision: account.revision, accountMode, ...selection })) { setApiKey(''); setApiSecret(''); setApiPassphrase(''); }
  }
  return <form className="trading-account-form" onSubmit={save} aria-label={`${exchangeNames[account.exchange]} 账户连接`}>
    <div className="trading-account-form-heading"><h3>{exchangeNames[account.exchange]}</h3><span>{account.connected ? '已连接' : '未连接'}</span></div>
    {account.connected ? <p>当前连接：{accountModeNames[account.accountMode]}</p> : null}
    <div className="trading-account-import">
      {account.exchange === 'binance' ? <label htmlFor="trading-binance-mode">Binance 账户模式<select id="trading-binance-mode" value={accountMode} disabled={busy} onChange={event => setAccountMode(event.target.value as TradingAccountMode)}><option value="standard">普通 U 本位</option><option value="portfolio-margin">组合保证金（Portfolio Margin）</option></select></label> : null}
      <label htmlFor={`trading-source-${account.exchange}`}>Asset 来源<select id={`trading-source-${account.exchange}`} value={chosen?.source.projectId ?? ''} disabled={busy || sourcesLoading || !choices.some(choice => choice.available)} onChange={event => choose(event.target.value)}><option value="">{sourcesLoading ? '正在读取 Asset 来源…' : choices.some(choice => choice.available) ? '请选择 Asset 项目' : '暂无可导入的 Asset 连接'}</option>{choices.map(({ source, available, description }) => <option key={source.projectId} value={source.projectId} disabled={!available}>{source.name} · {description}</option>)}</select></label>
      {chosen ? <p className="trading-import-detail">{chosen.connection?.label ? `密钥尾号 ${chosen.connection.label} · ` : ''}{chosen.connection?.updatedAt ? `Asset 保存时间：${formatDate(chosen.connection.updatedAt)}（北京时间）` : '导入时将重新验证只读权限。'}</p> : selection && sources ? <p className="trading-import-detail">来源已变更或不可用，请重新选择。</p> : null}
      {choices.filter(choice => !choice.available && choice.source.status === 'ready').map(choice => <p key={choice.source.projectId} className="trading-import-detail">{choice.source.name}：{choice.description}</p>)}
      <button className="button secondary" type="button" disabled={busy || sourcesLoading || !chosen} onClick={() => void importSelected()}><Link2 size={16} />{account.connected ? '从 Asset 导入并替换' : '从 Asset 导入'}</button>
    </div>
    <p>{account.connected ? '填写新的只读密钥可替换当前连接。' : '连接后读取 CLUSDT、BZUSDT 仓位和资金费账单。'}</p>
    <label htmlFor={`trading-key-${account.exchange}`}>API Key<input id={`trading-key-${account.exchange}`} type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} required disabled={busy} /></label>
    <label htmlFor={`trading-secret-${account.exchange}`}>API Secret<input id={`trading-secret-${account.exchange}`} type="password" autoComplete="off" spellCheck={false} value={apiSecret} onChange={event => setApiSecret(event.target.value)} required disabled={busy} /></label>
    {account.exchange === 'okx' ? <label htmlFor="trading-passphrase-okx">Passphrase<input id="trading-passphrase-okx" type="password" autoComplete="off" spellCheck={false} value={apiPassphrase} onChange={event => setApiPassphrase(event.target.value)} required disabled={busy} /></label> : null}
    <div className="trading-form-actions"><button className="button primary" type="submit" disabled={busy || !apiKey.trim() || !apiSecret.trim() || account.exchange === 'okx' && !apiPassphrase.trim()}><Link2 size={16} />{account.connected ? '验证并替换连接' : '验证并连接'}</button>{account.connected ? <button className="button secondary trading-disconnect" type="button" disabled={busy} onClick={() => void disconnect()}><Unplug size={16} />断开连接</button> : null}</div>
    {account.verifiedAt ? <small>密钥验证：{formatDate(account.verifiedAt)}（北京时间）</small> : null}
  </form>;
}

export default function TradingPage({ cache, onExpired }: { cache: TradingCache; onExpired: () => void }) {
  useSyncExternalStore(cache.subscribe, cache.getVersion);
  const [days, setDays] = useState<7 | 30>(readDays);
  const [pair, setPair] = useState<TradingPair>(readPair);
  const [reading, setReading] = useState(false);
  const [, setClock] = useState(0);
  const busy = cache.busy();
  const [error, setError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(!navigator.onLine);
  const [page, setPage] = useState(() => cache.selection().days === days && cache.selection().pair === pair ? cache.selection().page : 0);
  const entry = cache.get(days, page, pair) ?? cache.latest(pair);
  const now = entry ? tradingCacheNow(entry) : 0;
  const data = entry ? ageTradingData(entry, now, offline || !!error) : null;
  const oldCache = !!entry && (offline || !!error || entry.failed || !entry.data.cache.builtAt || now - Date.parse(entry.data.cache.builtAt) > 75_000);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [sources, setSources] = useState<TradingImportSource[] | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const daysRef = useRef(days);
  const pageRef = useRef(page);
  const pairRef = useRef(pair);
  const expiredRef = useRef(onExpired);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const lastReadAt = useRef<number | null>(null);
  const sourceRequest = useRef<AbortController | null>(null);
  const connectionsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { expiredRef.current = onExpired; }, [onExpired]);
  const cancelRead = useCallback(() => { sequence.current++; pending.current?.controller.abort(); pending.current = null; }, []);
  const cancelSources = useCallback(() => { sourceRequest.current?.abort(); sourceRequest.current = null; }, []);
  const loadSources = useCallback(async () => {
    if (!mounted.current || cache.busy() || !navigator.onLine) return;
    cancelSources();
    const request = cache.beginSource(), controller = request.controller; sourceRequest.current = controller;
    setSourcesLoading(true); setSourcesError('');
    try {
      const next = await api<{ sources: TradingImportSource[] }>('/api/trading/import-sources', { signal: controller.signal, timeoutMs: 30_000 });
      if (!mounted.current || !cache.valid(request)) return;
      setSources(next.sources);
    } catch (cause) {
      if (!mounted.current || !cache.valid(request)) return;
      if (cause instanceof ApiError && cause.status === 401) expiredRef.current();
      else { setSources(null); setSourcesError(cause instanceof Error ? cause.message : 'Asset 来源读取失败，请刷新来源重试。'); }
    } finally {
      cache.finish(request);
      if (sourceRequest.current === controller) { sourceRequest.current = null; if (mounted.current) setSourcesLoading(false); }
    }
  }, [cache, cancelSources]);
  const load = useCallback((force = false): Promise<void> => {
    if (!mounted.current || cache.busy() || !navigator.onLine) return Promise.resolve();
    if (pending.current && !force) return pending.current.promise;
    // Embedded or restored browser pages can keep reporting hidden. Continue
    // bounded cache reads there, without triggering any exchange collection.
    if (!force && document.hidden && lastReadAt.current !== null && performance.now() - lastReadAt.current < 30_000) return Promise.resolve();
    if (force) cancelRead();
    const requestedPair = pairRef.current;
    const request = cache.beginRead(requestedPair), controller = request.controller;
    const version = ++sequence.current;
    const requestedDays = daysRef.current;
    const requestedPage = pageRef.current;
    lastReadAt.current = performance.now();
    setReading(true);
    const promise = (async () => {
      try {
        const next = await api<TradingState>(`/api/trading?days=${requestedDays}&page=${requestedPage}&pair=${requestedPair}`, { signal: controller.signal, timeoutMs: 12_000 });
        if (!mounted.current || version !== sequence.current || !cache.valid(request)) return;
        if (cache.accept(request, next)) {
          setError('');
          if (requestedPair === pairRef.current && requestedDays === daysRef.current && requestedPage === pageRef.current && next.funding.pagination.page !== requestedPage) setPage(next.funding.pagination.page);
        }
      } catch (cause) {
        if (!mounted.current || version !== sequence.current || !cache.valid(request)) return;
        if (cause instanceof ApiError && cause.status === 401) expiredRef.current();
        else { cache.fail(request, requestedDays, requestedPage); setError(cause instanceof Error ? cause.message : '交易数据读取失败，请重试。'); }
      } finally {
        cache.finish(request);
        if (mounted.current && version === sequence.current) setReading(false);
        if (pending.current?.controller === controller) pending.current = null;
      }
    })();
    pending.current = { controller, promise };
    return promise;
  }, [cache, cancelRead]);
  useEffect(() => {
    mounted.current = true;
    const resume = () => {
      setOffline(!navigator.onLine);
      setClock(value => value + 1);
      if (!navigator.onLine) { cancelRead(); setReading(false); cancelSources(); setSourcesLoading(false); }
      else void load(true);
    };
    const timer = window.setInterval(() => { setClock(value => value + 1); void load(); }, 5000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume); window.addEventListener('offline', resume);
    window.addEventListener('focus', resume); window.addEventListener('pageshow', resume);
    return () => {
      mounted.current = false; cancelRead(); cancelSources();
      clearInterval(timer); document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
      window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume);
    };
  }, [cancelRead, cancelSources, load]);
  useEffect(() => { daysRef.current = days; pageRef.current = page; pairRef.current = pair; cache.select(days, page, pair); setError(''); void load(true); }, [cache, days, page, pair, load]);
  useEffect(() => { if (!busy) void load(); }, [busy, load]);
  useEffect(() => { if (connectionsOpen) void loadSources(); }, [connectionsOpen, loadSources]);
  useEffect(() => {
    const back = () => { cancelRead(); pairRef.current = readPair(); setPair(pairRef.current); setDays(readDays()); setPage(0); setOperationError(''); setNotice(''); };
    window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back);
  }, [cancelRead]);
  function changePair(next: TradingPair) {
    if (next === pair) return;
    cancelRead(); pairRef.current = next; pageRef.current = 0;
    const url = new URL(location.href); url.searchParams.set('tradingPair', next);
    history.pushState(null, '', url); setPair(next); setPage(0); setError(''); setOperationError(''); setNotice('');
  }
  function changeDays(next: 7 | 30) {
    if (next === days) return;
    const url = new URL(location.href); url.searchParams.set('tradingDays', String(next));
    history.pushState(null, '', url); setDays(next); setPage(0);
  }
  async function write(path: string, method: 'POST' | 'PUT' | 'DELETE', body: object, label: string, importing = false) {
    if (!navigator.onLine) return false;
    const requestedPair = pairRef.current;
    const request = cache.beginMutation(label, requestedPair);
    if (!request) return false;
    const controller = request.controller;
    const requestedDays = daysRef.current;
    cancelRead(); cancelSources(); setSourcesLoading(false); setReading(false); setOperationError(''); setNotice('');
    let succeeded = false;
    try {
      const next = await api<TradingState>(`${path}?days=${requestedDays}&page=0&pair=${requestedPair}`, { method, body: JSON.stringify(body), signal: controller.signal, timeoutMs: importing ? 65_000 : method === 'PUT' ? 45_000 : 15_000 });
      if (!cache.accept(request, next, label !== 'refresh')) return false;
      succeeded = true;
      if (mounted.current && requestedPair === pairRef.current) {
        setPage(0); setError('');
        setNotice(importing ? '已从 Asset 导入并验证只读密钥，正在同步账户数据。' : method === 'DELETE' ? '账户已断开，已清除该账户的当前缓存。' : method === 'PUT' ? '只读密钥已验证，正在同步账户数据。' : '已请求同步，已有数据会保留到同步完成。');
      }
    } catch (cause) {
      if (!cache.valid(request)) return false;
      if (cause instanceof ApiError && cause.status === 401) expiredRef.current();
      else if (mounted.current) setOperationError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      cache.finish(request);
    }
    return succeeded;
  }
  const mutateAccount = (exchange: TradingExchange, method: 'PUT' | 'DELETE', body: object) => write(`/api/trading/accounts/${exchange}`, method, body, exchange);
  const importAccount = (exchange: TradingExchange, body: ImportRequest) => write(`/api/trading/accounts/${exchange}/import`, 'POST', body, exchange, true);
  const exchanges = pairExchanges(pair);
  const selectedAccounts = data?.accounts.filter(account => exchanges.includes(account.exchange)) ?? [];
  const connected = selectedAccounts.some(account => account.connected);
  const refreshing = selectedAccounts.some(account => account.refreshing);
  const events = data?.funding.events ?? [];
  const pageCount = Math.max(1, data?.funding.pagination.pages ?? 1);
  const currentPage = data?.funding.pagination.page ?? 0;
  const pendingPage = !!data && (days !== data.period.days || page !== currentPage);
  const openConnections = () => {
    setConnectionsOpen(true);
    requestAnimationFrame(() => { connectionsRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' }); connectionsRef.current?.querySelector('summary')?.focus(); });
  };

  return <div className="trading-page">
    <header className="trading-heading"><div><div className="trading-title-line"><h1>原油四腿资金费套利</h1></div><p>{exchanges.map(exchange => exchangeNames[exchange]).join(" 与 ")} · CL / BZ 永续合约</p></div><button className="button secondary" onClick={() => void write('/api/trading/refresh', 'POST', {}, 'refresh')} disabled={!!busy || refreshing || !connected || offline}>{busy === 'refresh' || refreshing ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{refreshing ? '同步中' : '刷新观察数据'}</button></header>
    <div className="trading-pair-selector" role="group" aria-label="交易所组合">{(['binance,bybit', 'binance,okx', 'bybit,okx'] as const).map(value => <button key={value} type="button" aria-pressed={pair === value} disabled={!!busy} onClick={() => changePair(value)}>{pairExchanges(value).map(exchange => exchangeNames[exchange]).join(' + ')}</button>)}</div>
    <TradingExecution pair={pair} onExpired={onExpired} />
    {offline ? <div className="trading-notice warning" role="status"><CircleAlert size={17} />网络已断开，当前显示最后读取的数据；连接恢复后自动更新。</div> : null}
    {error ? <div className="trading-notice warning" role="alert"><CircleAlert size={17} /><span>{error}{data ? ' 当前保留上次数据。' : ''}</span><button className="button secondary" onClick={() => void load(true)} disabled={reading || !!busy}>重试读取</button></div> : null}
    {operationError ? <div className="trading-notice warning" role="alert"><CircleAlert size={17} /><span>{operationError}</span></div> : null}
    {notice ? <div className="trading-notice" role="status">{notice}</div> : null}
    {data ? <div className={`trading-notice trading-cache-status${oldCache ? ' warning' : ''}`} role="status"><span>{oldCache ? '当前显示旧缓存，等待更新。' : data.cache.rebuilding ? '后台正在更新缓存，当前显示上次数据。' : reading ? '已显示缓存，正在检查更新。' : '已显示缓存。'} 缓存生成：{formatDate(data.cache.builtAt)}{data.cache.builtAt ? '（北京时间）' : ''}</span></div> : null}
    {!data ? <div className="trading-initial" role="status">{reading ? <><LoaderCircle className="spin" size={22} /><span>正在读取交易账户状态…</span></> : <span>尚未获取交易数据</span>}</div> : <>
      <section className="trading-panel trading-positions" aria-labelledby="trading-positions-title">
        <div className="trading-panel-heading"><div><h2 id="trading-positions-title">四腿仓位</h2><p>按实际持仓显示方向 · OKX 数量为张，价格为 USDT/底层单位</p></div><button className="button secondary" onClick={openConnections}><Link2 size={16} />账户连接</button></div>
        <div className="trading-account-statuses">{selectedAccounts.map(account => <div className="trading-account-status" key={account.exchange}><div><strong>{exchangeNames[account.exchange]}</strong><ReadStatus state={account.positions.state} />{account.refreshing ? <span className="trading-muted">后台同步中</span> : null}</div><p>仓位读取：{formatDate(account.positions.fetchedAt)}{account.positions.fetchedAt ? '（北京时间）' : ''}</p>{account.positions.error ? <p className="trading-warning">{account.positions.error}</p> : null}</div>)}</div>
        {!connected ? <div className="trading-connect-empty"><ShieldCheck size={27} /><h3>连接账户，查看四腿的真实仓位</h3><p>使用所选两家交易所的只读密钥。连接后，这里会显示持仓方向、名义价值和资金费账单。</p><button className="button primary" onClick={openConnections}>连接只读账户</button></div> : null}
        <div className={`trading-structure ${data.structure.state}`}><span>跨所方向</span><strong>{data.structure.message}</strong></div>
        <div className="trading-position-scroll"><table className="trading-position-table"><thead><tr><th scope="col">合约 / 交易所</th><th scope="col">方向</th><th scope="col">合约数量</th><th scope="col">开仓均价<small>USDT/底层单位</small></th><th scope="col">标记价格<small>USDT/底层单位</small></th><th scope="col">名义价值<small>USDT</small></th><th scope="col">未实现盈亏<small>USDT</small></th><th scope="col"><span className="visually-hidden">仓位详情</span></th></tr></thead><tbody>{data.legs.flatMap(leg => leg.positions.length ? leg.positions.map((position, index) => <PositionRow key={`${leg.id}-${position.id}`} leg={leg} position={position} first={index === 0} />) : [<PositionRow key={leg.id} leg={leg} position={null} first />])}</tbody></table></div>
        <details className="trading-leg-totals"><summary>查看每腿名义价值与资金费</summary><div className="trading-table-scroll" tabIndex={0} role="region" aria-label="每腿汇总"><table><thead><tr><th scope="col">合约 / 交易所</th><th scope="col">总名义价值 · USDT</th><th scope="col">净名义价值 · USDT</th><th scope="col">区间资金费净额 · USDT</th><th scope="col">资金费记录</th></tr></thead><tbody>{data.legs.map(leg => <tr key={leg.id}><th scope="row">{exchangeNames[leg.exchange]} {leg.symbol}</th><td>{amount(leg.grossNotional)}</td><td>{amount(leg.netNotional, true)}</td><td className={polarity(leg.fundingNet)}>{amount(leg.fundingNet, true)}</td><td>{leg.fundingComplete ? '完整' : '部分 / 尚未获取'}</td></tr>)}</tbody></table></div></details>
        <p className="trading-footnote">方向仅反映当前持仓结构；不同交易所的合约数量不直接等同，不代表完全对冲。</p>
      </section>

      <section className="trading-panel trading-pnl" aria-labelledby="trading-pnl-title">
        <div className="trading-panel-heading"><div><h2 id="trading-pnl-title">四腿总盈亏</h2><p>持仓浮盈亏＋区间累计已结算资金费</p></div><div className="trading-range" role="group" aria-label="盈亏与资金费时间范围">{([7, 30] as const).map(value => <button key={value} aria-pressed={days === value} onClick={() => changeDays(value)}>近{value}天</button>)}</div></div>
        {days !== data.period.days ? <p className="trading-window-loading" role="status">{reading ? `正在读取近${days}天缓存；下方仍显示近${data.period.days}天的数据。` : `所选区间尚未取得，保留近${data.period.days}天的数据。`}</p> : null}
        <p className="trading-caption">资金费累计起点：{formatDate(data.period.start)}（北京时间）；每个采样点仅累计到该时刻。</p>
        <TradingPnlChart pnl={data.pnl} />
        <p className="trading-footnote">仅统计这四腿的浮盈亏与资金费，不含平仓已实现盈亏及交易手续费；切换账户后重新开始记录。切换区间会改变资金费累计起点。</p>
      </section>

      <section className="trading-panel trading-funding" aria-labelledby="trading-funding-title">
        <div className="trading-panel-heading"><div><h2 id="trading-funding-title">{data.funding.complete ? '区间资金费' : '已获取的资金费'}</h2><p>{formatDate(data.period.start)} — {formatDate(data.period.end)}（北京时间）· 与上方曲线共用近{data.period.days}天区间</p></div></div>
        <div className="trading-funding-summary"><div><span>{data.funding.complete ? '收入' : '已获取收入'}<small>USDT</small></span><strong className="trading-positive">{amount(data.funding.income)}</strong></div><div><span>{data.funding.complete ? '支出' : '已获取支出'}<small>USDT</small></span><strong className="trading-negative">{amount(data.funding.expense)}</strong></div><div><span>{data.funding.complete ? '净额' : '已获取净额'}<small>USDT</small></span><strong className={polarity(data.funding.net)}>{amount(data.funding.net, true)}</strong></div></div>
        <div className="trading-funding-coverage">{!data.funding.complete ? <p className="trading-warning"><CircleAlert size={15} />部分记录：当前汇总不代表整个区间的完整实收。</p> : null}{selectedAccounts.map(account => <div key={account.exchange}><strong>{exchangeNames[account.exchange]}</strong><ReadStatus state={account.funding.state} /><span>资金费截至：{account.funding.coverageEnd ? formatDate(account.funding.coverageEnd) : '尚未同步'}</span>{account.funding.error ? <p className="trading-warning">{account.funding.error}</p> : null}</div>)}</div>
        <TradingFundingChart daily={data.funding.daily} />
        <p className="trading-footnote">资金费按账户与合约归属，可能包含其他策略；区间账单不等于当前持仓周期收益。</p>
      </section>

      <section className="trading-panel trading-ledger" aria-labelledby="trading-ledger-title"><div className="trading-panel-heading"><div><h2 id="trading-ledger-title">{data.funding.complete ? '资金费流水' : '已获取的资金费流水'}</h2><p>仅 CLUSDT / BZUSDT 的资金费收付 · 共 {data.funding.pagination.total} 条</p></div></div>
        {pendingPage ? <p className="trading-window-loading" role="status">{reading ? `正在读取近${days}天第 ${page + 1} 页缓存；` : `所选分页尚未取得；`}当前保留近{data.period.days}天第 {currentPage + 1} 页。</p> : null}
        {events.length ? <><div className="trading-table-scroll trading-ledger-scroll" tabIndex={0} role="region" aria-label="资金费流水明细"><table><thead><tr><th scope="col">时间（北京时间）</th><th scope="col">交易所</th><th scope="col">合约</th><th scope="col">收付</th><th scope="col">金额 · USDT</th></tr></thead><tbody>{events.map(event => <tr key={`${event.exchange}-${event.id}`}><td>{formatDate(event.time)}</td><td>{exchangeNames[event.exchange]}</td><td>{event.symbol}</td><td>{!/[1-9]/.test(event.amount) ? '零额' : event.amount.startsWith('-') ? '支出' : '收入'}</td><td className={polarity(event.amount)}>{amount(event.amount, true)}</td></tr>)}</tbody></table></div><div className="trading-pagination"><span>第 {currentPage + 1} / {pageCount} 页 · 每页最多 50 条</span><div><button className="button secondary" disabled={pendingPage || currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="button secondary" disabled={pendingPage || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div></> : <div className="trading-ledger-empty">{data.funding.complete ? '所选区间没有资金费流水。' : '尚无已获取的资金费流水；连接账户并完成同步后显示。'}</div>}
      </section>

      <details ref={connectionsRef} className="trading-panel trading-connections" open={connectionsOpen} onToggle={event => setConnectionsOpen(event.currentTarget.open)}><summary><span><Link2 size={18} /><strong>账户连接</strong><small>{data.accounts.filter(account => account.connected).length} / {data.accounts.length} 已连接</small></span><ChevronDown size={18} /></summary><div className="trading-connections-body">
        <p className="trading-connection-note">仅支持 HMAC 只读密钥，请关闭交易和提现权限。密钥在服务器保存，保存后不回显。</p>
        <div className="trading-import-sources">
          <div className="trading-import-heading"><h3>从 Asset 导入</h3><button className="button secondary" type="button" disabled={!!busy || offline || sourcesLoading} onClick={() => void loadSources()}>{sourcesLoading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}刷新来源</button></div>
          <p>使用工作台已保存的 Asset 登录连接，重新验证只读权限后导入。</p>
          <p>导入后独立保存；Asset 更换或移除密钥不会自动修改这里。</p>
          {sourcesLoading ? <p role="status">正在读取 Asset 来源…</p> : null}
          {sourcesError ? <p className="trading-warning" role="alert">{sourcesError}</p> : null}
          {sources?.length === 0 ? <p>暂无已启用的 Asset 项目。可先在工作台配置 Asset 登录连接，或在下方手动填写只读密钥。</p> : null}
          {sources?.filter(source => source.status !== 'ready').map(source => <p className="trading-warning" key={source.projectId}>{source.name}：{source.error || (source.status === 'unconfigured' ? '请先在工作台配置 Asset API 地址与登录密码。' : '来源暂不可用，请确认 Asset 服务已更新并刷新来源。')}</p>)}
        </div>
        <div className="trading-account-forms">{data.accounts.map(account => <AccountConnection key={`${account.exchange}:${account.revision}`} account={account} busy={!!busy || offline} mutate={mutateAccount} sources={sources} sourcesLoading={sourcesLoading} importAccount={importAccount} />)}</div>{busy && busy !== 'refresh' ? <p className="trading-saving" role="status"><LoaderCircle className="spin" size={16} />正在验证账户连接，请稍候…</p> : null}
      </div></details>
      <p className="trading-page-note">只读查看仓位与资金费 · 前台每 5 秒检查缓存，返回页面立即更新 · 所有时间为北京时间</p>
    </>}
  </div>;
}
