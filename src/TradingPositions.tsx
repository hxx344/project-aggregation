import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, ChevronDown, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Callout, StatePanel } from './StateViews';
import { usePositionsCache } from './positions-cache-context';
import { amount, beijingTime } from './trading-format';
import type { AssetPosition, PositionAccount, PositionScope, PositionScopeStatus, PositionSource } from './trading-positions-types';

const staleAfterMs = 90_000;
const statusNames: Record<PositionScopeStatus, string> = { unconfigured: '未配置', loading: '首次读取中', live: '已同步', stale: '旧值', error: '读取失败', unsupported: '暂不支持' };
const sourceNames = { ready: '来源已连接', unconfigured: '未配置连接', unavailable: '来源不可用', stale: '来源旧值' };
type Filters = { source: string; exchange: string; account: string };
const filterParams = { source: 'positionsSource', exchange: 'positionsExchange', account: 'positionsAccount' };
function readFilters(): Filters {
  const params = new URLSearchParams(location.search);
  return { source: params.get(filterParams.source) || '', exchange: params.get(filterParams.exchange) || '', account: params.get(filterParams.account) || '' };
}
const accountKey = (sourceId: string, exchangeId: string, account: PositionAccount) => JSON.stringify([sourceId, exchangeId, account.id]);
const formatDate = (value: string | null) => beijingTime(value);
const oldTime = (value: string | null, now: number) => !value || !Number.isFinite(Date.parse(value)) || now - Date.parse(value) > staleAfterMs;

function Money({ value, currency, signed = false }: { value: string | null; currency: string | null; signed?: boolean }) {
  return <>{amount(value, signed)}{value !== null ? <small className="positions-unit">{currency || '币种未提供'}</small> : null}</>;
}
const PositionRow = memo(function PositionRow({ position }: { position: AssetPosition }) {
  const pnlClass = position.unrealizedPnl && /[1-9]/.test(position.unrealizedPnl) ? position.unrealizedPnl.startsWith('-') ? 'positions-negative' : 'positions-positive' : '';
  const quantityUnit = position.quantityUnit === 'contracts' ? '张' : position.quantityUnit;
  return <tr data-position-id={position.id}>
    <th scope="row"><strong>{position.symbol}</strong>{position.instrumentId !== position.symbol ? <small>{position.instrumentId}</small> : null}</th>
    <td><span className={`positions-side ${position.side}`}>{position.side === 'long' ? '做多' : '做空'}</span></td>
    <td>{amount(position.quantity)}<small className="positions-unit">{quantityUnit}</small></td>
    <td><Money value={position.entryPrice} currency={position.priceCurrency} /></td>
    <td><Money value={position.markPrice} currency={position.priceCurrency} /></td>
    <td><Money value={position.notional} currency={position.notionalCurrency} /></td>
    <td className={pnlClass}><Money value={position.unrealizedPnl} currency={position.pnlCurrency} signed /></td>
    <td><details className="positions-details"><summary>详情<ChevronDown size={13} /></summary><dl>
      <div><dt>合约</dt><dd>{position.instrumentId}</dd></div>
      <div><dt>保证金模式</dt><dd>{position.marginMode === 'cross' ? '全仓' : position.marginMode === 'isolated' ? '逐仓' : position.marginMode || '未提供'}</dd></div>
      <div><dt>杠杆</dt><dd>{amount(position.leverage)}{position.leverage !== null ? '×' : ''}</dd></div>
      {position.contractSize !== null ? <div><dt>合约乘数</dt><dd>{amount(position.contractSize)}</dd></div> : null}
      <div><dt>强平价</dt><dd><Money value={position.liquidationPrice} currency={position.priceCurrency} /></dd></div>
      <div><dt>交易所变更时间 · 北京时间</dt><dd>{position.sourceUpdatedAt ? formatDate(position.sourceUpdatedAt) : '未提供'}</dd></div>
    </dl></details></td>
  </tr>;
});
const ScopePositions = memo(function ScopePositions({ scope, stale, now, context }: { scope: PositionScope; stale: boolean; now: number; context: string }) {
  const status = scope.status === 'live' && (stale || oldTime(scope.fetchedAt, now)) ? 'stale' : scope.status;
  const emptyText = status === 'live' ? '当前无持仓' : status === 'unconfigured' ? '在 Asset 配置此账户后显示仓位。' : status === 'unsupported' ? 'Asset 暂不支持读取此产品范围。' : status === 'loading' ? '正在首次读取，尚未确认仓位。' : '尚无可确认的仓位数据。';
  return <section className="positions-scope" data-scope={scope.id}>
    <div className="positions-scope-heading"><div><h4>{scope.label}</h4><span className={`positions-status ${status}`}>{statusNames[status]}{status === 'error' && scope.positions.length ? ' · 旧值' : ''}</span>{scope.refreshing ? <span className="positions-muted">后台更新中</span> : null}</div><p>仓位读取：<time dateTime={scope.fetchedAt || undefined}>{formatDate(scope.fetchedAt)}</time>（北京时间）</p></div>
    {scope.error ? <p className="positions-warning"><CircleAlert size={15} />{scope.error}</p> : null}
    {scope.positions.length ? <div className="positions-table-scroll" role="region" tabIndex={0} aria-label={`${context} · ${scope.label}仓位`}><table className="positions-table"><thead><tr><th scope="col">合约</th><th scope="col">方向</th><th scope="col">数量 / 单位</th><th scope="col">开仓均价</th><th scope="col">标记价格</th><th scope="col">名义价值</th><th scope="col">未实现盈亏</th><th scope="col"><span className="visually-hidden">仓位详情</span></th></tr></thead><tbody>{scope.positions.map(position => <PositionRow key={position.id} position={position} />)}</tbody></table></div> : <p className={`positions-scope-empty ${status === 'live' ? 'confirmed' : ''}`}>{emptyText}</p>}
  </section>;
});

export default function TradingPositions({ onExpired, onProject, navigationSearch }: { onExpired: () => void; onProject: (id: string) => void; navigationSearch: string }) {
  const cache = usePositionsCache();
  const { data, error, failed, reading, unauthorized } = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const [filters, setFilters] = useState(readFilters);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [, setClock] = useState(0);
  const mounted = useRef(false), version = useRef(0), lastReadAt = useRef<number | null>(null);
  const pending = useRef<{ promise: Promise<void> } | null>(null);
  const expiredRef = useRef(onExpired);
  useEffect(() => { expiredRef.current = onExpired; }, [onExpired]);
  useEffect(() => { if (unauthorized) expiredRef.current(); }, [unauthorized]);
  useEffect(() => { setFilters(readFilters()); }, [navigationSearch]);
  // A view leaving does not cancel the shared read needed by another view.
  const cancel = useCallback(() => { version.current++; pending.current = null; }, []);
  const load = useCallback((force = false): Promise<void> => {
    if (!mounted.current || !navigator.onLine) return Promise.resolve();
    if (pending.current && !force) return pending.current.promise;
    if (!force && document.hidden && lastReadAt.current !== null && performance.now() - lastReadAt.current < 30_000) return Promise.resolve();
    if (force) cancel();
    const requestVersion = ++version.current;
    lastReadAt.current = performance.now();
    const promise = (async () => {
      try {
        await cache.refresh(force);
      } finally {
        if (version.current === requestVersion) pending.current = null;
      }
    })();
    pending.current = { promise }; return promise;
  }, [cache, cancel]);
  useEffect(() => {
    let disposed = false;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelResume = () => { clearTimeout(resumeTimer); resumeTimer = undefined; };
    mounted.current = true; void load();
    const resume = () => {
      if (disposed) return;
      setOffline(!navigator.onLine); setClock(value => value + 1);
      if (!navigator.onLine) { cancelResume(); cancel(); cache.markUnavailable(); }
      else if (resumeTimer === undefined) {
        const previousRead = pending.current;
        // Coalesce wake events and preserve reads started during the grace period.
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined;
          if (!disposed && navigator.onLine) void load(!pending.current || pending.current === previousRead);
        }, 1000);
      }
    };
    const visible = () => { if (!document.hidden) resume(); };
    const timer = window.setInterval(() => {
      if (disposed) return;
      setClock(value => value + 1);
      if (resumeTimer === undefined) void load();
    }, 5000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', resume); window.addEventListener('offline', resume);
    window.addEventListener('focus', resume); window.addEventListener('pageshow', resume);
    return () => {
      disposed = true; mounted.current = false; cancelResume(); cancel(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
      window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume);
    };
  }, [cache, cancel, load]);
  useEffect(() => {
    const back = () => setFilters(readFilters());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  function changeFilter(key: keyof Filters, value: string) {
    const next = { ...filters, [key]: value, ...(key === 'source' ? { exchange: '', account: '' } : key === 'exchange' ? { account: '' } : {}) };
    updateFilters(next);
  }
  function updateFilters(next: Filters) {
    const url = new URL(location.href); url.searchParams.set('tradingSection', 'positions');
    for (const key of Object.keys(filterParams) as (keyof Filters)[]) {
      if (next[key]) url.searchParams.set(filterParams[key], next[key]); else url.searchParams.delete(filterParams[key]);
    }
    history.pushState(null, '', url); setFilters(next);
  }
  const sources = data?.sources ?? [];
  const now = cache.now();
  const stale = offline || failed || !!error || !!data && oldTime(data.generatedAt, now);
  const selectedSources = sources.filter(source => !filters.source || source.projectId === filters.source);
  const exchangeOptions = Array.from(new Map(selectedSources.flatMap(source => source.data?.exchanges.map(exchange => [exchange.id, exchange.name] as const) ?? [])).entries());
  const groups = selectedSources.flatMap(source => (source.data?.exchanges ?? []).filter(exchange => !filters.exchange || exchange.id === filters.exchange).map(exchange => ({ source, exchange })));
  const accountOptions = groups.flatMap(({ source, exchange }) => exchange.accounts.map(account => ({ id: accountKey(source.projectId, exchange.id, account), label: `${source.name} · ${exchange.name} · ${account.name}` })));
  const visibleGroups = groups.map(group => ({ ...group, accounts: group.exchange.accounts.filter(account => !filters.account || accountKey(group.source.projectId, group.exchange.id, account) === filters.account) })).filter(group => group.accounts.length);
  const invalidFilter = !!filters.source && !sources.some(source => source.projectId === filters.source) || !!filters.exchange && !exchangeOptions.some(([id]) => id === filters.exchange) || !!filters.account && !accountOptions.some(account => account.id === filters.account);
  const sourceStale = (source: PositionSource) => stale || source.status !== 'ready' || oldTime(source.checkedAt, now);
  const issues = sources.some(source => sourceStale(source) || source.data?.exchanges.some(exchange => exchange.accounts.some(account => account.scopes.some(scope => scope.status !== 'live' || oldTime(scope.fetchedAt, now)))));
  return <div className="positions-page">
    <div className="trading-toolbar"><p className="positions-readonly"><ShieldCheck size={15} /><span>Asset 中全部交易所账户的持仓 · 只读查看，账户在 Asset 管理</span></p><button className="button secondary" onClick={() => void load(true)} disabled={reading || offline}>{reading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}刷新仓位</button></div>
    {offline ? <Callout tone="warning" role="status">网络已断开，当前显示最后读取的旧值；连接恢复后自动更新。</Callout> : null}
    {error ? <Callout tone="warning">{error}{data ? ' 当前保留上次数据，已标记为旧值。' : ''}</Callout> : null}
    {data && reading ? <Callout tone="info">已显示上次读取的仓位，正在后台更新。</Callout> : null}
    {data ? <>
      <div className={`positions-overview ${stale || issues ? 'attention' : ''}`} role="status"><span>{stale ? '当前显示旧值' : issues ? '部分账户或来源待核对' : sources.length ? '仓位状态已更新' : '尚未接入 Asset 来源'}</span><small>工作台读取：{formatDate(data.generatedAt)}（北京时间）· 每 5 秒检查更新</small></div>
      <div className="positions-sources" aria-label="Asset 数据来源">{sources.map(source => <section className="positions-source" key={source.projectId}><div><strong>{source.name}</strong><span className={`positions-status ${source.status === 'ready' ? sourceStale(source) ? 'stale' : 'live' : source.status === 'unconfigured' ? 'unconfigured' : 'error'}`}>{source.status === 'ready' && sourceStale(source) ? '来源旧值' : sourceNames[source.status]}</span></div><p>来源读取：{formatDate(source.checkedAt)}（北京时间）</p>{source.error ? <p className="positions-warning">{source.error}</p> : null}<button className="positions-project-link" type="button" onClick={() => onProject(source.projectId)} aria-label={`在 ${source.name} 管理账户`}>在 Asset 管理账户<ArrowUpRight size={15} /></button></section>)}</div>
      {sources.length ? <div className="positions-filters" role="group" aria-label="仓位筛选">
        <label>Asset 来源<select value={filters.source} onChange={event => changeFilter('source', event.target.value)}><option value="">全部来源</option>{filters.source && !sources.some(source => source.projectId === filters.source) ? <option value={filters.source}>来源已移除</option> : null}{sources.map(source => <option key={source.projectId} value={source.projectId}>{source.name}</option>)}</select></label>
        <label>交易所<select value={filters.exchange} onChange={event => changeFilter('exchange', event.target.value)}><option value="">全部交易所</option>{filters.exchange && !exchangeOptions.some(([id]) => id === filters.exchange) ? <option value={filters.exchange}>交易所已变更</option> : null}{exchangeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>账户<select value={filters.account} onChange={event => changeFilter('account', event.target.value)}><option value="">全部账户</option>{filters.account && !accountOptions.some(account => account.id === filters.account) ? <option value={filters.account}>账户已变更</option> : null}{accountOptions.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        {filters.source || filters.exchange || filters.account ? <button className="button secondary" onClick={() => updateFilters({ source: '', exchange: '', account: '' })}>清除筛选</button> : null}
      </div> : null}
      {invalidFilter ? <Callout tone="warning" role="status">所选来源、交易所或账户已变更，请清除筛选后重新选择。</Callout> : null}
      {visibleGroups.map(({ source, exchange, accounts }) => <section className="positions-exchange" key={`${source.projectId}:${exchange.id}`} aria-label={`${source.name} · ${exchange.name}`}><div className="positions-exchange-heading"><h2>{exchange.name}</h2><span>{source.name}</span></div>{accounts.map(account => <section className="positions-account" key={account.id}><div className="positions-account-heading"><h3>{account.name}</h3>{!account.configured ? <span className="positions-status unconfigured">未配置账户</span> : null}</div>{account.scopes.length ? account.scopes.map(scope => <ScopePositions key={scope.id} scope={scope} stale={sourceStale(source)} now={now} context={`${exchange.name} · ${account.name}`} />) : <p className="positions-scope-empty">{account.configured ? 'Asset 尚未提供此账户的产品范围。' : '在 Asset 配置此账户后显示仓位。'}</p>}</section>)}</section>)}
      {!visibleGroups.length ? <StatePanel kind="empty" title={!sources.length ? '尚未接入 Asset 来源' : invalidFilter ? '没有符合筛选的账户' : '暂未取得账户目录'} detail={!sources.length ? '在项目管理中添加 Asset 项目并配置登录连接，仓位目录会自动显示。' : invalidFilter ? '清除筛选后查看当前可用账户。' : '可进入上方 Asset 项目检查连接与账户配置。'} /> : <p className="positions-footnote">数量和金额沿用交易所单位；不同币种分别显示。仅“已同步”的产品范围可确认空仓，旧值与读取失败不代表无持仓。</p>}
    </> : reading ? <StatePanel kind="loading" title="正在读取 Asset 仓位目录…" /> : <StatePanel kind="empty" title="尚未取得仓位数据" />}
  </div>;
}
