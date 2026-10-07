import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRightLeft, ChevronDown, CircleAlert, Clock3, Link2, LoaderCircle, RefreshCw, Square, Unplug } from 'lucide-react';
import { api, ApiError } from './api';
import type { OilSymbol, TradingAccountMode, TradingExchange } from './trading-types';
import type { ExecutionAction, ExecutionConnection, ExecutionJob, ExecutionLegInput, ExecutionPlanInput, ExecutionPreset, ExecutionPreview, ExecutionSide, ExecutionState } from './trading-execution-types';
import './trading-execution.css';

const BASE = '/api/trading/execution';
const EXCHANGES = { binance: 'Binance', bybit: 'Bybit' };
const MODES: Record<TradingAccountMode, string> = { standard: '普通 U 本位', 'portfolio-margin': '组合保证金', unified: '统一交易账户' };
const PRESETS: Record<ExecutionPreset, string> = { 'four-leg': '四腿组合', 'same-exchange': '同所两腿', 'cross-exchange': '跨所两腿' };
const STATUS: Record<ExecutionJob['status'], string> = { queued: '待执行', running: '执行中', stopping: '正在撤销余单', paused: '已暂停', attention: '待核对', completed: '已全部成交', stopped: '已停止' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(Date.parse(value)) : '尚未取得';
const seconds = (value: number) => `${value / 1000} 秒`;
const amount = (value: string | null) => {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer, fraction] = value.split('.');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : '.' + fraction}`;
};
const positive = (value: string) => /^\d+(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value);
const direction = (side: ExecutionSide) => side === 'long' ? '多仓' : '空仓';
const orderSide = (action: ExecutionAction, side: ExecutionSide) => (action === 'open') === (side === 'long') ? 'buy' : 'sell';
const operation = (action: ExecutionAction, side: ExecutionSide) => `${orderSide(action, side) === 'buy' ? '买入' : '卖出'}${action === 'open' ? '开' : '平'}${side === 'long' ? '多' : '空'}`;
const legKey = (leg: Pick<ExecutionLegInput, 'exchange' | 'symbol'>) => `${leg.exchange}-${leg.symbol}`;
const terminal = (job: ExecutionJob) => job.status === 'completed' || job.status === 'stopped';
type LegStructure = Pick<ExecutionLegInput, 'exchange' | 'symbol' | 'side'>;
type MutationResult<T> = { ok: true; value: T } | { ok: false; error?: unknown };
type Write = (suffix: string, body: object, method?: 'POST' | 'PUT' | 'DELETE') => Promise<boolean>;

function structure(preset: ExecutionPreset, exchange: TradingExchange, symbol: OilSymbol, reverse: boolean): LegStructure[] {
  const first: ExecutionSide = reverse ? 'short' : 'long', second: ExecutionSide = reverse ? 'long' : 'short';
  if (preset === 'same-exchange') return [{ exchange, symbol: 'CLUSDT', side: first }, { exchange, symbol: 'BZUSDT', side: second }];
  if (preset === 'cross-exchange') return [{ exchange: 'binance', symbol, side: first }, { exchange: 'bybit', symbol, side: second }];
  return [{ exchange: 'binance', symbol: 'CLUSDT', side: first }, { exchange: 'binance', symbol: 'BZUSDT', side: second }, { exchange: 'bybit', symbol: 'CLUSDT', side: second }, { exchange: 'bybit', symbol: 'BZUSDT', side: first }];
}

function ConnectionForm({ connection, disabled, write }: { connection: ExecutionConnection; disabled: boolean; write: Write }) {
  const [mode, setMode] = useState(connection.accountMode);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const name = EXCHANGES[connection.exchange], locked = disabled || connection.locked;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await write(`/accounts/${connection.exchange}`, { revision: connection.revision, accountMode: mode, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }, 'PUT')) { setApiKey(''); setApiSecret(''); }
  }
  return <form className="execution-connection" onSubmit={save} aria-label={`${name} 实盘账户连接`}>
    <div className="execution-connection-title"><h4>{name}</h4><span className={`execution-badge ${connection.connected ? 'connected' : ''}`}>{connection.connected ? '已连接' : '未连接'}</span></div>
    {connection.connected ? <p className="execution-account-identity">{MODES[connection.accountMode]} · UID {connection.identity ?? '未返回'} · 密钥尾号 {connection.keyLabel ?? '未返回'}<small>验证时间：{date(connection.verifiedAt)}（北京时间）</small></p> : <p className="execution-help">连接允许合约交易、关闭提现和转账权限的独立密钥。</p>}
    {connection.locked ? <p className="execution-warning">存在未结束或待核对的执行，完成对账前不能替换或断开连接。</p> : null}
    <fieldset disabled={locked}>
      {connection.exchange === 'binance' ? <label>Binance 实盘账户模式<select value={mode} onChange={event => setMode(event.target.value as TradingAccountMode)}><option value="standard">普通 U 本位</option><option value="portfolio-margin">组合保证金（Portfolio Margin）</option></select></label> : null}
      <label>{name} 实盘 API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} required /></label>
      <label>{name} 实盘 API Secret<input type="password" autoComplete="off" spellCheck={false} value={apiSecret} onChange={event => setApiSecret(event.target.value)} required /></label>
      <div className="execution-actions"><button className="button primary" type="submit" disabled={!apiKey.trim() || !apiSecret.trim()}><Link2 size={15} />{connection.connected ? '验证并替换实盘连接' : '验证并连接实盘账户'}</button>{connection.connected ? <button className="button secondary" type="button" onClick={() => void write(`/accounts/${connection.exchange}`, { revision: connection.revision }, 'DELETE')}><Unplug size={15} />断开</button> : null}</div>
    </fieldset>
  </form>;
}

function JobCard({ job, disabled, canPreview, write, resume }: { job: ExecutionJob; disabled: boolean; canPreview: boolean; write: Write; resume: (id: string) => void }) {
  const [strategyIds, setStrategyIds] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  return <article className={`execution-job ${job.status}`} aria-label={`${PRESETS[job.preset]}${job.action === 'open' ? '开仓' : '平仓'} ${STATUS[job.status]}`}>
    <header><div><h3>{PRESETS[job.preset]}{job.action === 'open' ? '开仓' : '平仓'} <span className={`execution-badge ${job.status}`}>{STATUS[job.status]}</span></h3><p>第 {Math.min(job.batchIndex + 1, job.batchCount)} / {job.batchCount} 批 · 更新于 {date(job.updatedAt)}（北京时间）</p></div>{!terminal(job) && job.status !== 'stopping' ? <button className="button secondary execution-stop" type="button" disabled={disabled} onClick={() => void write(`/jobs/${encodeURIComponent(job.id)}/stop`, {})}><Square size={14} />停止并撤销余单</button> : null}</header>
    {job.reason ? <p className="execution-job-reason" role={job.status === 'attention' ? 'alert' : undefined}>{job.reason}</p> : null}
    <div className="execution-table-wrap"><table className="execution-progress-table"><thead><tr><th scope="col">交易腿</th><th scope="col">已成交 / 目标<small>原生合约单位</small></th><th scope="col">剩余数量</th><th scope="col">当前委托 / 策略</th><th scope="col">最后对账<small>北京时间</small></th></tr></thead><tbody>{job.legs.map(leg => <tr key={leg.id}>
      <th scope="row"><strong>{EXCHANGES[leg.exchange]} {leg.symbol}</strong><span className={`execution-side ${leg.side}`}>{operation(job.action, leg.side)}</span></th>
      <td data-label="已成交 / 目标"><strong>{amount(leg.filledQuantity)}</strong> / {amount(leg.quantity)}</td><td data-label="剩余数量">{amount(leg.remainingQuantity)}</td>
      <td data-label="当前委托 / 策略">{leg.currentOrder ? <><span className={leg.currentOrder.unknown ? 'execution-warning' : ''}>{leg.currentOrder.unknown ? '结果未知，等待核对' : leg.currentOrder.state}</span><small>{leg.currentOrder.kind === 'strategy' ? 'Bybit 原生追逐' : 'Binance 同向价一'}{leg.currentOrder.price ? ` · ${amount(leg.currentOrder.price)} USDT` : ''}</small>{leg.currentOrder.id || leg.exchange === 'binance' && leg.currentOrder.clientId ? <small style={{ maxWidth: '26ch', marginLeft: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{leg.currentOrder.id ? `${leg.currentOrder.kind === 'strategy' ? '策略' : '订单'} ID：${leg.currentOrder.id}` : `客户单号：${leg.currentOrder.clientId}`}</small> : null}</> : '尚无活动委托'}</td>
      <td data-label="最后对账">{date(leg.currentOrder?.lastCheckedAt ?? null)}</td>
    </tr>)}</tbody></table></div>
    {job.legs.filter(leg => leg.currentOrder?.unknown).map(leg => {
      const needsId = leg.exchange === 'bybit' && !leg.currentOrder?.id;
      return <form key={leg.id} className="execution-reconcile" onSubmit={event => { event.preventDefault(); void write(`/jobs/${encodeURIComponent(job.id)}/reconcile`, { legId: leg.id, ...(needsId ? { strategyId: (strategyIds[leg.id] || '').trim(), acknowledge: true } : {}) }); }}>
        <strong>{EXCHANGES[leg.exchange]} {leg.symbol} · {operation(job.action, leg.side)}</strong>
        {needsId ? <><p>请在 Bybit 核对该账户、合约、方向与数量，填写对应追逐策略 ID。核对后将停止该策略的余单。</p><label>对应策略 ID<input type="text" autoComplete="off" spellCheck={false} maxLength={100} required value={strategyIds[leg.id] || ''} onChange={event => setStrategyIds(current => ({ ...current, [leg.id]: event.target.value }))} disabled={disabled} /></label><label className="execution-checkbox"><input type="checkbox" checked={!!acknowledged[leg.id]} onChange={event => setAcknowledged(current => ({ ...current, [leg.id]: event.target.checked }))} required disabled={disabled} />我已核对这是此交易腿提交的策略</label></> : <p>先向交易所核对实际状态；结果未知期间不会重复提交。</p>}
        <button className="button secondary" type="submit" disabled={disabled || needsId && (!acknowledged[leg.id] || !strategyIds[leg.id]?.trim())}><RefreshCw size={14} />{needsId ? '核对并停止策略余单' : '重新核对'}</button>
      </form>;
    })}
    <footer><span>停止只撤销余单，已成交仓位保留。</span>{job.canResume ? <button className="button secondary" type="button" disabled={disabled || !canPreview} onClick={() => resume(job.id)}>预览继续剩余</button> : null}</footer>
    <details className="execution-events"><summary>执行记录与编号</summary><p>执行编号：{job.id} · 最晚结束：{date(job.deadlineAt)}（北京时间）</p><ul>{job.events.map((event, index) => <li key={`${event.time}-${index}`}><time>{date(event.time)}</time><span>{event.message}</span></li>)}</ul></details>
  </article>;
}

function Preview({ preview, expired, disabled, uncertain, onSubmit, onEdit }: { preview: ExecutionPreview; expired: boolean; disabled: boolean; uncertain: boolean; onSubmit: () => void; onEdit: () => void }) {
  return <section className="execution-review" aria-labelledby="execution-review-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="execution-review-title">确认{preview.resumeJobId ? '剩余数量的' : ''}{PRESETS[preview.preset]}{preview.action === 'open' ? '开仓' : '平仓'}</h3><p>预览有效至 {date(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge connected">限价 · 仅挂单</span></div>
    <div className="execution-review-accounts">{preview.connections.map(connection => <p key={connection.exchange}><strong>{EXCHANGES[connection.exchange]}</strong> {MODES[connection.accountMode]} · UID {connection.identity ?? '未返回'} · 密钥尾号 {connection.keyLabel ?? '未返回'}</p>)}</div>
    <dl className="execution-review-settings"><div><dt>批次</dt><dd>{preview.batchCount} 批</dd></div><div><dt>批间等待</dt><dd>{seconds(preview.batchIntervalMs)}</dd></div><div><dt>Binance 追价间隔</dt><dd>{seconds(preview.repriceIntervalMs)}</dd></div><div><dt>最长执行</dt><dd>{seconds(preview.timeoutMs)}</dd></div></dl>
    <div className="execution-review-legs">{preview.legs.map(leg => <article key={leg.id}><header><h4>{EXCHANGES[leg.exchange]} {leg.symbol}</h4><span className={`execution-side ${leg.side}`}>{operation(preview.action, leg.side)}</span></header><dl>
      <div><dt>总数量 · 原生合约单位</dt><dd>{amount(leg.quantity)}</dd></div><div><dt>估算名义金额 · USDT</dt><dd>{amount(leg.estimatedNotional)}</dd></div><div><dt>持仓模式 / 当前该方向数量</dt><dd>{leg.positionMode === 'hedge' ? '双向' : '单向'} / {amount(leg.currentQuantity)}</dd></div><div><dt>{leg.orderSide === 'buy' ? '买单追价停止上限' : '卖单追价停止下限'} · USDT</dt><dd>{amount(leg.stopPrice)}</dd></div><div><dt>买一 / 卖一 · USDT</dt><dd>{amount(leg.bid)} / {amount(leg.ask)}</dd></div><div><dt>盘口时间 · 北京时间</dt><dd>{date(leg.quoteAt)}</dd></div><div className="execution-batches"><dt>各批数量 · 原生合约单位</dt><dd>{leg.batchQuantities.map((quantity, index) => <span key={index}>第 {index + 1} 批：{amount(quantity)}</span>)}</dd></div>
    </dl></article>)}</div>
    <p className="execution-help">Bybit 使用原生追逐限价单，按本方一档追价；Binance 使用同向价一限价单，定时撤单、核对后重挂。达到停止价时停止追价并撤销余单；停止价不是严格成交限价，盘口瞬时跳价仍可能越过它。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {uncertain ? <p className="execution-warning" role="alert">本次提交结果尚未确认。请用下方按钮核对同一次提交，不要重复创建组合。</p> : expired ? <p className="execution-warning" role="status">预览已过期，请重新获取盘口与持仓后确认。</p> : null}
    <div className="execution-actions"><button className="button primary" type="button" disabled={disabled || expired && !uncertain} onClick={onSubmit}>{disabled ? <LoaderCircle size={16} className="spin" /> : <ArrowRightLeft size={16} />}{uncertain ? '重新核对本次提交' : `确认并一键${preview.action === 'open' ? '开仓' : '平仓'}`}</button><button className="button secondary" type="button" disabled={disabled || uncertain} onClick={onEdit}>返回修改参数</button></div>
  </section>;
}

export default function TradingExecution({ onExpired }: { onExpired: () => void }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(''), [writeError, setWriteError] = useState(''), [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(!navigator.onLine), [expiredSession, setExpiredSession] = useState(false);
  const [preset, setPreset] = useState<ExecutionPreset>('four-leg'), [action, setAction] = useState<ExecutionAction>('open');
  const [selectedExchange, setSelectedExchange] = useState<TradingExchange>('binance'), [selectedSymbol, setSelectedSymbol] = useState<OilSymbol>('CLUSDT');
  const [orientation, setOrientation] = useState('');
  const [values, setValues] = useState<Record<string, { quantity: string; stopPrice: string }>>({});
  const [batchCount, setBatchCount] = useState('1'), [batchInterval, setBatchInterval] = useState('1'), [repriceInterval, setRepriceInterval] = useState('5'), [timeout, setExecutionTimeout] = useState('300');
  const [review, setReview] = useState<{ preview: ExecutionPreview; requestId: string; uncertain: boolean } | null>(null);
  const [, setClock] = useState(0);
  const mounted = useRef(false), busyRef = useRef(false), readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const responseVersion = useRef(0), lastSuccess = useRef<number | null>(null), expiresHandler = useRef(onExpired);
  const connectionsRef = useRef<HTMLDetailsElement>(null), reviewRef = useRef<HTMLDivElement>(null);
  expiresHandler.current = onExpired;
  const acceptState = useCallback((value: ExecutionState) => { lastSuccess.current = performance.now(); setState(value); setReadError(''); }, []);
  const expire = useCallback(() => { if (!mounted.current) return; readController.current?.abort(); writeController.current?.abort(); setState(null); setReview(null); setExpiredSession(true); expiresHandler.current(); }, []);
  const load = useCallback(async (force = false) => {
    if (!mounted.current || busyRef.current || !navigator.onLine) return;
    if (readController.current) { if (!force) return; readController.current.abort(); }
    const controller = new AbortController(), version = responseVersion.current;
    readController.current = controller; setReading(true);
    try {
      const value = await api<ExecutionState>(BASE, { signal: controller.signal, timeoutMs: 12_000 });
      if (mounted.current && !controller.signal.aborted && version === responseVersion.current) acceptState(value);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) expire();
      else setReadError(error instanceof Error ? error.message : '执行状态读取失败');
    } finally { if (readController.current === controller) { readController.current = null; if (mounted.current) setReading(false); } }
  }, [acceptState, expire]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => { void load(); timer = setTimeout(poll, document.hidden ? 30_000 : 3000); };
    const wake = () => { setOffline(!navigator.onLine); if (navigator.onLine && !document.hidden) { clearTimeout(timer); void load(true); timer = setTimeout(poll, 3000); } };
    const disconnected = () => { setOffline(true); readController.current?.abort(); };
    poll();
    const clock = setInterval(() => setClock(value => value + 1), 3000);
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake); window.addEventListener('pageshow', wake); window.addEventListener('online', wake); window.addEventListener('offline', disconnected);
    return () => { mounted.current = false; clearTimeout(timer); clearInterval(clock); readController.current?.abort(); writeController.current?.abort(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); window.removeEventListener('pageshow', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', disconnected); };
  }, [load]);
  useEffect(() => { if (review) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [review?.preview.id]);

  async function mutate<T>(suffix: string, body: object, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<MutationResult<T>> {
    if (busyRef.current || !navigator.onLine || !mounted.current || expiredSession) return { ok: false };
    busyRef.current = true; setBusy(true); setWriteError(''); setNotice(''); responseVersion.current++;
    readController.current?.abort();
    const controller = new AbortController(); writeController.current = controller;
    try {
      const value = await api<T>(BASE + suffix, { method, body: JSON.stringify(body), signal: controller.signal, timeoutMs: suffix.startsWith('/accounts/') ? 45_000 : 30_000 });
      if (!mounted.current || controller.signal.aborted) return { ok: false };
      return { ok: true, value };
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) expire(); else setWriteError(error instanceof Error ? error.message : '操作尚未确认，请核对执行状态'); }
      return { ok: false, error };
    } finally { if (writeController.current === controller) writeController.current = null; busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const write: Write = async (suffix, body, method) => {
    const result = await mutate<ExecutionState>(suffix, body, method);
    if (!result.ok) return false;
    acceptState(result.value); setReview(current => current?.uncertain ? current : null);
    setNotice(suffix.endsWith('/stop') ? '已请求停止，正在核对并撤销余单。已成交仓位保留。' : suffix.endsWith('/reconcile') ? '核对请求已完成，请查看各腿最新状态。' : '实盘连接已更新。');
    return true;
  };
  function resetStructure() { setOrientation(''); setValues({}); setReview(null); setWriteError(''); }
  async function preview(body: ExecutionPlanInput | { resumeJobId: string }) {
    const result = await mutate<ExecutionPreview>('/preview', body);
    if (result.ok) setReview({ preview: result.value, requestId: crypto.randomUUID(), uncertain: false });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!orientation) return;
    const legs = draftLegs.map(leg => ({ ...leg, quantity: values[legKey(leg)]?.quantity.trim() || '', stopPrice: values[legKey(leg)]?.stopPrice.trim() || '' }));
    if (legs.some(leg => !positive(leg.quantity) || !positive(leg.stopPrice))) { setWriteError('每腿数量和追价停止价均需填写大于零的十进制数。'); return; }
    await preview({ preset, action, legs, batchCount: Number(batchCount), batchIntervalMs: Math.round(Number(batchInterval) * 1000), repriceIntervalMs: Math.round(Number(repriceInterval) * 1000), timeoutMs: Math.round(Number(timeout) * 1000) });
  }
  async function confirm() {
    if (!review || busyRef.current || !navigator.onLine) return;
    const current = review;
    setReview({ ...current, uncertain: true });
    const result = await mutate<ExecutionState>('/jobs', { previewId: current.preview.id, requestId: current.requestId, confirmLive: true });
    if (result.ok) { acceptState(result.value); setReview(null); setNotice('组合已受理。实际成交与余单状态见执行进度。'); }
    // The server resolves a persisted request ID before checking preview expiry.
    // A definite rejection therefore lets this same submission return to editing.
    else if (result.error instanceof ApiError && [400, 403, 404, 409, 422].includes(result.error.status) && mounted.current) setReview({ ...current, uncertain: false });
  }

  const draftLegs = structure(preset, selectedExchange, selectedSymbol, orientation === 'reverse');
  const requiredExchanges = new Set(draftLegs.map(leg => leg.exchange));
  const missingConnection = !state || [...requiredExchanges].some(exchange => !state.connections.some(connection => connection.exchange === exchange && connection.connected));
  const elapsed = lastSuccess.current === null ? Infinity : performance.now() - lastSuccess.current;
  const stale = !!state && elapsed > 15_000;
  const serverNow = state ? Date.parse(state.generatedAt) + elapsed : Date.now();
  const reviewExpired = !!review && serverNow >= Date.parse(review.preview.expiresAt);
  const disabled = busy || offline;
  const activeJobs = state?.jobs.filter(job => !terminal(job)) ?? [], pastJobs = state?.jobs.filter(terminal) ?? [];
  const selectedDirectionLabel = preset === 'cross-exchange' ? `Binance 多 / Bybit 空（${selectedSymbol}）` : preset === 'same-exchange' ? 'CL 多 / BZ 空' : 'Binance：CL 多 / BZ 空；Bybit：CL 空 / BZ 多';
  const reverseDirectionLabel = preset === 'cross-exchange' ? `Binance 空 / Bybit 多（${selectedSymbol}）` : preset === 'same-exchange' ? 'CL 空 / BZ 多' : 'Binance：CL 空 / BZ 多；Bybit：CL 多 / BZ 空';
  if (expiredSession) return <section className="trading-panel execution-panel"><p className="execution-session-expired">登录已过期，请重新登录后核对执行状态。</p></section>;
  return <section className="trading-panel execution-panel" aria-labelledby="execution-title">
    <header className="trading-panel-heading"><div><h2 id="execution-title">组合交易</h2><p>Bybit 原生追逐限价单 · Binance 同向价一追价 · 分批开平仓</p></div><button className="button secondary" type="button" disabled={disabled || reading} onClick={() => void load(true)}><RefreshCw size={15} className={reading ? 'spin' : ''} />刷新执行状态</button></header>
    <div className={`execution-sync${offline || stale || readError ? ' stale' : ''}`} role="status"><Clock3 size={14} /><span>{offline ? '网络已断开，显示最后取得的执行状态。' : readError ? '执行状态读取失败，当前保留上次结果。' : stale ? '执行状态已过期，正在重新核对。' : state ? '前台每 3 秒更新执行状态。' : '正在读取执行状态…'}{state ? ` 最近取得：${date(state.generatedAt)}（北京时间）` : ''}</span></div>
    {readError ? <p className="execution-message warning" role="alert">{readError}</p> : null}
    {writeError ? <p className="execution-message warning" role="alert"><CircleAlert size={16} />{writeError}</p> : null}
    {notice ? <p className="execution-message" role="status">{notice}</p> : null}
    {activeJobs.length ? <div className="execution-jobs" aria-label="当前执行"><h3>执行进度</h3>{activeJobs.map(job => <JobCard key={job.id} job={job} disabled={disabled} canPreview={!review} write={write} resume={id => void preview({ resumeJobId: id })} />)}</div> : null}
    <div ref={reviewRef}>{review ? <Preview preview={review.preview} expired={reviewExpired} disabled={disabled} uncertain={review.uncertain} onSubmit={() => void confirm()} onEdit={() => { setReview(null); setWriteError(''); }} /> : null}</div>
    <form className="execution-builder" onSubmit={submit} aria-label="组合交易参数">
      <fieldset disabled={disabled || !!review}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-presets" role="group" aria-label="交易预设">{(Object.keys(PRESETS) as ExecutionPreset[]).map(value => <button key={value} type="button" aria-pressed={preset === value} onClick={() => { setPreset(value); resetStructure(); }}>{PRESETS[value]}<small>{value === 'four-leg' ? '两所 · CL 与 BZ' : value === 'same-exchange' ? '单所 · CL 与 BZ' : '两所 · 同一合约'}</small></button>)}</div>
        <div className="execution-form-top"><label>交易动作<select value={action} onChange={event => { setAction(event.target.value as ExecutionAction); resetStructure(); }}><option value="open">开仓</option><option value="close">平仓</option></select></label>{preset === 'same-exchange' ? <label>交易所<select value={selectedExchange} onChange={event => { setSelectedExchange(event.target.value as TradingExchange); resetStructure(); }}><option value="binance">Binance</option><option value="bybit">Bybit</option></select></label> : preset === 'cross-exchange' ? <label>合约<select value={selectedSymbol} onChange={event => { setSelectedSymbol(event.target.value as OilSymbol); resetStructure(); }}><option value="CLUSDT">CLUSDT</option><option value="BZUSDT">BZUSDT</option></select></label> : null}<label className="execution-direction">{action === 'open' ? '开仓方向' : '待平仓方向'}<select value={orientation} required onChange={event => { setOrientation(event.target.value); setValues({}); }}><option value="">请选择方向</option><option value="forward">{selectedDirectionLabel}</option><option value="reverse">{reverseDirectionLabel}</option></select></label></div>
        {orientation ? <div className="execution-leg-inputs">{draftLegs.map(leg => {
          const key = legKey(leg), value = values[key] || { quantity: '', stopPrice: '' }, buy = orderSide(action, leg.side) === 'buy';
          const position = state?.positions.find(row => row.exchange === leg.exchange && row.symbol === leg.symbol && row.side === leg.side);
          return <section key={key} className="execution-leg-input" aria-label={`${EXCHANGES[leg.exchange]} ${leg.symbol} 交易参数`}><header><strong>{EXCHANGES[leg.exchange]} {leg.symbol}</strong><span className={`execution-side ${leg.side}`}>{operation(action, leg.side)}</span></header><label>数量 · 原生合约单位<input type="text" inputMode="decimal" autoComplete="off" value={value.quantity} required maxLength={80} pattern="[0-9]+([.][0-9]{1,18})?" onChange={event => setValues(current => ({ ...current, [key]: { ...value, quantity: event.target.value } }))} /></label>{action === 'close' ? <div className="execution-position-hint"><span>{position ? `最近${direction(leg.side)} ${amount(position.quantity)} · ${date(position.fetchedAt)}` : `尚无该方向仓位数据`}</span><button type="button" className="text-button" disabled={!position || !positive(position.quantity)} onClick={() => position && setValues(current => ({ ...current, [key]: { ...value, quantity: position.quantity } }))}>填入当前数量</button></div> : null}<label>{buy ? '买单追价停止上限' : '卖单追价停止下限'} · USDT<input type="text" inputMode="decimal" autoComplete="off" value={value.stopPrice} required maxLength={80} pattern="[0-9]+([.][0-9]{1,18})?" onChange={event => setValues(current => ({ ...current, [key]: { ...value, stopPrice: event.target.value } }))} /></label></section>;
        })}</div> : <p className="execution-choose-direction">先选择交易方向，再分别填写每腿数量和追价停止价。</p>}
        <div className="execution-settings"><label>拆分批数<input type="number" min="1" max="200" step="1" required value={batchCount} onChange={event => setBatchCount(event.target.value)} /></label><label>批间等待 · 秒<input type="number" min="0" max="600" step="0.001" required value={batchInterval} onChange={event => setBatchInterval(event.target.value)} /></label><label>Binance 追价间隔 · 秒<input type="number" min="1" max="60" step="0.001" required value={repriceInterval} onChange={event => setRepriceInterval(event.target.value)} /></label><label>最长执行 · 秒<input type="number" min="30" max="3600" step="0.001" required value={timeout} onChange={event => setExecutionTimeout(event.target.value)} /></label></div>
        <p className="execution-help">每批各腿完成后才进入下一批。达到停止价、最长时间或出现无法核对的状态时，停止后续批次并处理余单；已成交数量单独保留。不同交易所的合约数量不直接等同。</p>
        <div className="execution-builder-footer"><p>{missingConnection ? '请先连接此组合需要的实盘账户。' : '预览会重新读取交易账户的盘口、规则与持仓。'}</p><button className="button primary" type="submit" disabled={missingConnection || !orientation || stale}><ArrowRightLeft size={16} />预览{action === 'open' ? '开仓' : '平仓'}组合</button></div>
      </fieldset>
    </form>
    <details ref={connectionsRef} className="execution-connections"><summary><span><Link2 size={17} /><strong>实盘账户连接</strong><small>{state?.connections.filter(connection => connection.connected).length ?? 0} / 2 已连接</small></span><ChevronDown size={17} /></summary><div><p className="execution-help">这里的交易密钥独立保存，不覆盖下方仓位观察与资金费统计的只读账户。执行进度按本区账户显示，UID 与只读账户不同时，两区数据不能合并理解。密钥不保存在浏览器，保存后不回显。</p>{state ? <div className="execution-connection-grid">{state.connections.map(connection => <ConnectionForm key={`${connection.exchange}:${connection.revision}`} connection={connection} disabled={disabled || !!review} write={write} />)}</div> : <button className="button secondary" type="button" disabled={disabled || reading} onClick={() => void load(true)}>重新读取连接状态</button>}</div></details>
    {pastJobs.length ? <details className="execution-history"><summary>已完成与已停止的执行（{pastJobs.length}）</summary><div>{pastJobs.map(job => <JobCard key={job.id} job={job} disabled={disabled} canPreview={!review} write={write} resume={id => void preview({ resumeJobId: id })} />)}</div></details> : null}
  </section>;
}
