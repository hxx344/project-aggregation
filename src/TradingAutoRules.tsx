import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Bot, CircleAlert, Pencil, Plus, Power, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import type { TradingExchange } from './trading-types';
import type { AutoDirection, AutoMarket, AutoPhase, AutoRule, AutoRuleConfig, AutoState, ExecutionOrderType } from './trading-execution-types';
import './trading-execution.css';

const BASE = '/api/trading/execution/auto';
const EXCHANGES: Record<TradingExchange, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
const MARKETS: Record<AutoMarket, { name: string; premium: string; base: string; unit: string; sizing: string; sizeUnit: string }> = {
  oil: { name: '原油', premium: 'BZ', base: 'CL', unit: 'USDT/桶', sizing: '每腿桶数', sizeUnit: '桶' },
  hynix: { name: '海力士', premium: 'ADR', base: '正股', unit: '%', sizing: '每腿名义金额', sizeUnit: 'USDT' },
};
const PHASES: Record<AutoPhase, string> = { idle: '等待开仓', opening: '开仓执行中', holding: '持仓中 · 等待平仓', closing: '平仓执行中', review: '待人工核对' };
const PHASE_TONE: Record<AutoPhase, string> = { idle: '', opening: 'running', holding: 'connected', closing: 'running', review: 'attention' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(Date.parse(value)) : '—';
const decimalText = /^-?\d+(?:\.\d{1,18})?$/;
/** Exact order of two decimal strings (up to 18 places), matching the server's comparison. */
function compareDecimal(left: string, right: string) {
  const scaled = (value: string) => { const [whole, fraction = ''] = value.replace('-', '').split('.'); const magnitude = BigInt(whole + fraction.padEnd(18, '0')); return value.startsWith('-') ? -magnitude : magnitude; };
  const a = scaled(left.trim()), b = scaled(right.trim());
  return a > b ? 1 : a < b ? -1 : 0;
}
type Form = { name: string; market: AutoMarket; exchange: TradingExchange; direction: AutoDirection; openThreshold: string; closeThreshold: string; equalSize: string; orderType: ExecutionOrderType;
  confirmSamples: string; maxOpensPerDay: string; batchCount: string; batchInterval: string; repriceInterval: string; timeout: string };
const emptyForm = (): Form => ({ name: '', market: 'oil', exchange: 'binance', direction: 'short', openThreshold: '', closeThreshold: '', equalSize: '', orderType: 'chase',
  confirmSamples: '3', maxOpensPerDay: '3', batchCount: '1', batchInterval: '1', repriceInterval: '5', timeout: '300' });
const formOf = (config: AutoRuleConfig): Form => ({ ...config, confirmSamples: String(config.confirmSamples), maxOpensPerDay: String(config.maxOpensPerDay), batchCount: String(config.batchCount),
  batchInterval: String(config.batchIntervalMs / 1000), repriceInterval: String(config.repriceIntervalMs / 1000), timeout: String(config.timeoutMs / 1000) });
const configOf = (form: Form): AutoRuleConfig => ({ name: form.name.trim(), market: form.market, exchange: form.exchange, direction: form.direction,
  openThreshold: form.openThreshold.trim(), closeThreshold: form.closeThreshold.trim(), equalSize: form.equalSize.trim(), orderType: form.orderType,
  confirmSamples: Number(form.confirmSamples), maxOpensPerDay: Number(form.maxOpensPerDay), batchCount: Number(form.batchCount),
  batchIntervalMs: Math.round(Number(form.batchInterval) * 1000), repriceIntervalMs: Math.round(Number(form.repriceInterval) * 1000), timeoutMs: Math.round(Number(form.timeout) * 1000) });
/** What the rule trades, in the words of its market. */
function directionText(market: AutoMarket, direction: AutoDirection) {
  const { premium, base } = MARKETS[market];
  return direction === 'short' ? `做空价差：卖 ${premium} / 买 ${base}` : `做多价差：买 ${premium} / 卖 ${base}`;
}
function conditionText(config: AutoRuleConfig) {
  const unit = MARKETS[config.market].unit, short = config.direction === 'short';
  return `开仓：价差 ${short ? '≥' : '≤'} ${config.openThreshold} ${unit} · 平仓：价差 ${short ? '≤' : '≥'} ${config.closeThreshold} ${unit}`;
}
const spreadValue = (rule: AutoRule, value: number) => rule.config.market === 'hynix' ? `${value.toFixed(3)}%` : `${value.toFixed(4)} USDT/桶`;

const RuleForm = memo(function RuleForm({ initial, editing, disabled, onSave, onCancel }: { initial: Form; editing: AutoRule | null; disabled: boolean; onSave: (config: AutoRuleConfig, enable: boolean, observe: boolean) => Promise<boolean>; onCancel: () => void }) {
  const [form, setForm] = useState(initial);
  const [enable, setEnable] = useState(false), [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  const [observe, setObserve] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
  const fixed = !!editing && editing.state.phase !== 'idle';
  const market = MARKETS[form.market], short = form.direction === 'short';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decimalText.test(form.openThreshold.trim()) || !decimalText.test(form.closeThreshold.trim())) { setError('开仓与平仓阈值须为十进制数，可为负数。'); return; }
    if (!/^\d+(?:\.\d{1,18})?$/.test(form.equalSize.trim()) || !/[1-9]/.test(form.equalSize)) { setError(`请填写大于零的${market.sizing}。`); return; }
    const order = compareDecimal(form.closeThreshold, form.openThreshold);
    if (short ? order >= 0 : order <= 0) { setError(short ? '做空价差时，平仓阈值须低于开仓阈值。' : '做多价差时，平仓阈值须高于开仓阈值。'); return; }
    setError('');
    await onSave(configOf(form), enable && confirmed, observe);
  }
  return <form className="auto-rule-form" onSubmit={submit} aria-label={editing ? `修改自动规则 ${editing.title}` : '新建自动规则'}>
    <fieldset disabled={disabled}>
      <div className="auto-rule-form-grid">
        <label>规则名称（选填）<input type="text" maxLength={40} value={form.name} onChange={event => set('name', event.target.value)} placeholder="留空按交易所与方向命名" /></label>
        <label>品种<select value={form.market} disabled={fixed} onChange={event => set('market', event.target.value as AutoMarket)}>{(Object.keys(MARKETS) as AutoMarket[]).map(value => <option key={value} value={value}>{MARKETS[value].name}（{value === 'oil' ? 'BZ − CL' : 'ADR 溢价'}）</option>)}</select></label>
        <label>交易所（同所两腿）<select value={form.exchange} disabled={fixed} onChange={event => set('exchange', event.target.value as TradingExchange)}>{(Object.keys(EXCHANGES) as TradingExchange[]).map(value => <option key={value} value={value}>{EXCHANGES[value]}</option>)}</select></label>
        <label>开仓方向<select value={form.direction} disabled={fixed} onChange={event => set('direction', event.target.value as AutoDirection)}><option value="short">{directionText(form.market, 'short')}</option><option value="long">{directionText(form.market, 'long')}</option></select></label>
        <label>开仓阈值 · {market.unit}<input type="text" inputMode="decimal" required maxLength={24} value={form.openThreshold} onChange={event => set('openThreshold', event.target.value)} placeholder={short ? '价差达到或高于此值开仓' : '价差达到或低于此值开仓'} /></label>
        <label>平仓阈值 · {market.unit}<input type="text" inputMode="decimal" required maxLength={24} value={form.closeThreshold} onChange={event => set('closeThreshold', event.target.value)} placeholder={short ? '价差回落到此值或以下平仓' : '价差回升到此值或以上平仓'} /></label>
        <label>{market.sizing} · {market.sizeUnit}<input type="text" inputMode="decimal" required maxLength={48} value={form.equalSize} onChange={event => set('equalSize', event.target.value)} /></label>
        <label>下单方式<select value={form.orderType} onChange={event => set('orderType', event.target.value as ExecutionOrderType)}><option value="chase">追价限价（按价差设界限）</option><option value="market">市价</option></select></label>
        <label>连续满足次数<input type="number" min="1" max="30" step="1" required value={form.confirmSamples} onChange={event => set('confirmSamples', event.target.value)} /></label>
        <label>每日最多开仓次数<input type="number" min="1" max="50" step="1" required value={form.maxOpensPerDay} onChange={event => set('maxOpensPerDay', event.target.value)} /></label>
        <label>拆分批数<input type="number" min="1" max="200" step="1" required value={form.batchCount} onChange={event => set('batchCount', event.target.value)} /></label>
        <label>批间等待 · 秒<input type="number" min="0" max="600" step="0.001" required value={form.batchInterval} onChange={event => set('batchInterval', event.target.value)} /></label>
        <label>本地追价间隔 · 秒<input type="number" min="1" max="60" step="0.001" required value={form.repriceInterval} onChange={event => set('repriceInterval', event.target.value)} /></label>
        <label>每次最长执行 · 秒<input type="number" min="30" max="3600" step="0.001" required value={form.timeout} onChange={event => set('timeout', event.target.value)} /></label>
      </div>
      <p className="execution-help">按可成交价判断：卖出价差取 {market.premium} 买一价与 {market.base} 卖一价，买入价差取 {market.premium} 卖一价与 {market.base} 买一价{form.market === 'hynix' ? '，正股按 ÷ 10 折算' : ''}。每次读到新盘口并满足条件计一次，达到连续次数才下单；建任务和每批发送前再用最新盘口复核，不满足则不发送；通过后按超出阈值的余量给每条腿设追价界限，追到界限即停在原价，到执行时间仍未全部成交则任务暂停、规则转待核对。Binance 与 OKX 以界限内的明确价格只挂单（不吃单），Bybit 由交易所按界限限制追价；行情越过挂单价导致只挂单被拒时，任务暂停、规则转待核对。市价单不设界限，可能有滑点。平仓数量等于本规则开仓实际成交的数量，且只向开仓时的实盘连接平仓。</p>
      {fixed ? <p className="execution-help">规则持有仓位或待核对，品种、交易所与方向不能修改。</p> : null}
      {!editing ? <div className="auto-rule-confirm"><label className="execution-checkbox"><input type="checkbox" checked={observe} onChange={event => { setObserve(event.target.checked); setEnable(false); setConfirmed(false); }} />保存后开始只观察</label><label className="execution-checkbox"><input type="checkbox" checked={enable} onChange={event => { setEnable(event.target.checked); setObserve(false); setConfirmed(false); }} />保存后立即启用</label>{enable ? <label className="execution-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />我确认此规则会使用实盘账户自动开仓和平仓</label> : null}</div> : null}
      {error ? <p className="execution-warning" role="alert">{error}</p> : null}
      <div className="execution-actions"><button className="button primary" type="submit">{editing ? '保存修改' : observe ? '保存并观察' : enable ? '保存并启用' : '保存规则'}</button><button className="button secondary" type="button" onClick={onCancel}>取消</button></div>
    </fieldset>
  </form>;
});

const RuleCard = memo(function RuleCard({ rule, disabled, evidenceValid, serverNow, onAction, onEdit }: { rule: AutoRule; disabled: boolean; evidenceValid: boolean; serverNow: number; onAction: (rule: AutoRule, path: string, method: 'POST' | 'DELETE', body: object) => Promise<boolean>; onEdit: (rule: AutoRule) => void }) {
  const [confirmed, setConfirmed] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const { config, state, live } = rule, market = MARKETS[config.market];
  const busyPhase = state.phase === 'opening' || state.phase === 'closing';
  const observing = rule.mode === 'observe';
  const fresh = (reading: AutoRule['live']) => evidenceValid && !!reading?.at && serverNow - Date.parse(reading.at) <= 10_000;
  return <article className={`execution-job auto-rule ${state.phase}`} aria-label={`自动规则 ${rule.title}`}>
    <header><div><h3>{rule.title}<span className={`execution-badge ${evidenceValid && rule.enabled ? 'connected' : ''}`}>{!evidenceValid ? '状态待更新' : observing ? rule.observing ? '只观察中' : '观察已停止' : rule.enabled ? '已启用' : '未启用'}</span><span className={`execution-badge ${PHASE_TONE[state.phase]}`}>{observing ? '条件信号 · 不下单' : PHASES[state.phase]}</span></h3>
      <p>{EXCHANGES[config.exchange]} · {market.name} · {directionText(config.market, config.direction)} · {conditionText(config)}</p>
      <p>{market.sizing} {config.equalSize} {market.sizeUnit} · {config.orderType === 'market' ? '市价' : '追价限价'} · 连续 {config.confirmSamples} 次满足才{observing ? '记录信号' : '下单'} · 今日已开仓 {state.opensToday} / {config.maxOpensPerDay} 次</p></div></header>
    <div className="auto-rule-live">
      {!evidenceValid ? <span className="execution-warning">当前状态待重新读取，不展示旧连续次数。</span> : observing ? <div><p className="execution-help">开仓与平仓条件独立观察；不代表完成开平仓，不计算模拟收益。</p>{!rule.observing ? <p>观察已停止。</p> : rule.observation?.note ? <p className="execution-warning">{rule.observation.note}</p> : (['open', 'close'] as const).map(action => {
        const reading = rule.observation?.[action];
        return <p key={action}>{action === 'open' ? '开仓' : '平仓'}条件：{reading?.note ? reading.note : fresh(reading) && reading?.value !== null && reading?.value !== undefined ? <>{spreadValue(rule, reading.value)} · 连续满足 {reading.hits} / {config.confirmSamples} 次 · 盘口 {date(reading.at)}</> : '等待新鲜盘口'}</p>;
      })}</div> : rule.enabled && (state.phase === 'idle' || state.phase === 'holding') ? live?.note ? <span className="execution-warning">{live.note}</span>
        : live && !fresh(live) ? <span className="execution-warning">盘口已过期，等待更新。</span>
        : live && live.value !== null ? <span>当前{state.phase === 'idle' ? '开仓' : '平仓'}可成交价差（{live.side === 'sell' ? '卖出' : '买入'}价差）：<strong className={live.met ? 'spread-up' : undefined}>{spreadValue(rule, live.value)}</strong> · 连续满足 {live.hits} / {config.confirmSamples} 次 · 盘口 {date(live.at)}</span>
        : <span className="execution-help">等待读取盘口…</span>
        : busyPhase ? <span>任务执行中，进度见「价差下单」中的「执行进度」{state.jobId ? `（执行编号 ${state.jobId}）` : ''}</span>
        : <span className="execution-help">{rule.enabled ? '' : '未启用，不会自动下单。'}</span>}
    </div>
    {state.held ? <p className="auto-rule-held">本规则持仓：{state.held.map(leg => `${leg.symbol} ${leg.side === 'long' ? '多' : '空'} ${leg.quantity}${leg.exchange === 'okx' ? ' 张' : ''}`).join('，')}</p> : null}
    {state.reason ? <p className="execution-job-reason" role={state.phase === 'review' ? 'alert' : undefined}>{state.reason}{state.retryAt && rule.enabled ? `（${date(state.retryAt)} 后重新判断）` : ''}</p> : null}
    <footer>
      <div className="auto-rule-actions">
        {rule.enabled || rule.observing ? <button className="button secondary" type="button" disabled={disabled} onClick={() => void onAction(rule, 'disable', 'POST', { revision: rule.revision })}><Power size={14} />{observing ? '停止观察' : '停用'}</button> : null}
        {!rule.enabled && state.phase !== 'review' && !busyPhase ? <><label className="execution-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={disabled} />{observing ? '确认结束观察并转为自动实盘下单' : '确认自动实盘下单'}</label><button className="button primary" type="button" disabled={disabled || !confirmed} onClick={async () => { if (await onAction(rule, observing ? 'live' : 'enable', 'POST', { revision: rule.revision, confirmLive: true })) setConfirmed(false); }}><Power size={14} />{observing ? '转为实盘' : '启用'}</button></> : null}
        {!rule.enabled && !rule.observing && state.phase === 'idle' ? <button className="button secondary" type="button" disabled={disabled} onClick={() => void onAction(rule, 'observe', 'POST', { revision: rule.revision })}>开始只观察</button> : null}
        {!busyPhase ? <button className="button secondary" type="button" disabled={disabled} onClick={() => onEdit(rule)}><Pencil size={14} />修改</button> : null}
        {state.phase === 'review' || state.phase === 'holding' ? <><label className="execution-checkbox"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={disabled} />我已核对并自行处理{state.phase === 'holding' ? '本规则持仓' : '成交与仓位'}</label><button className="button secondary" type="button" disabled={disabled || !acknowledged} onClick={async () => { if (await onAction(rule, 'reset', 'POST', { revision: rule.revision, acknowledge: true })) setAcknowledged(false); }}><RotateCcw size={14} />重置为等待开仓</button></> : null}
        {state.phase === 'idle' ? <button className="button secondary auto-rule-delete" type="button" disabled={disabled} onClick={() => void onAction(rule, '', 'DELETE', { revision: rule.revision })}><Trash2 size={14} />删除</button> : null}
      </div>
    </footer>
    <details className="execution-events"><summary>规则记录</summary><p>规则编号：{rule.id} · 创建于 {date(rule.createdAt)}（北京时间）</p><ul>{[...state.events].reverse().map((item, index) => <li key={`${item.time}-${index}`}><time>{date(item.time)}</time><span>{item.message}</span></li>)}</ul></details>
    {rule.observation?.events.length ? <details className="execution-events"><summary>观察记录（最近 30 条）</summary><p>同一轮连续满足只记录一次；条件中断后重新计数。停止、修改、维护、行情缺口及重启均清零。</p><ul>{[...rule.observation.events].reverse().map((item, index) => <li key={`${item.time}-${index}`}><time>{date(item.time)}</time><span>{item.message}{item.inputs ? ` · ${market.premium} ${date(item.inputs.premiumAt)} / ${market.base} ${date(item.inputs.baseAt)} · 价差 ${spreadValue(rule, item.value!)} · 阈值 ${item.threshold} · ${item.hits} 次` : ''}</span></li>)}</ul></details> : null}
  </article>;
});

export default function TradingAutoRules({ onExpired }: { onExpired: () => void }) {
  const [state, setState] = useState<AutoState | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(''), [writeError, setWriteError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ rule: AutoRule | null; key: number } | null>(null);
  const [verified, setVerified] = useState(false), [clock, setClock] = useState(() => performance.now());
  const received = useRef(performance.now());
  const mounted = useRef(false), busyRef = useRef(false), readController = useRef<AbortController | null>(null), version = useRef(0), expired = useRef(onExpired);
  expired.current = onExpired;
  const load = useCallback(async () => {
    if (!mounted.current || busyRef.current || readController.current || !navigator.onLine) return;
    const controller = new AbortController(), started = version.current; readController.current = controller; setReading(true);
    try {
      const value = await api<AutoState>(BASE, { signal: controller.signal, timeoutMs: 12_000 });
      if (mounted.current && !controller.signal.aborted && started === version.current && navigator.onLine) { received.current = performance.now(); setState(value); setVerified(true); setReadError(''); }
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setVerified(false);
      if (error instanceof ApiError && error.status === 401) expired.current();
      else setReadError(error instanceof Error ? error.message : '自动规则读取失败');
    } finally { if (readController.current === controller) { readController.current = null; if (mounted.current) setReading(false); } }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clockTimer = setInterval(() => setClock(performance.now()), 1000);
    const poll = () => { void load(); timer = setTimeout(poll, document.hidden ? 30_000 : 3000); };
    const wake = () => { if (!document.hidden) { clearTimeout(timer); poll(); } };
    const invalidate = () => { version.current++; setVerified(false); readController.current?.abort(); readController.current = null; setReading(false); };
    const online = () => { invalidate(); wake(); };
    poll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('offline', invalidate); window.addEventListener('online', online);
    return () => { mounted.current = false; clearTimeout(timer); clearInterval(clockTimer); readController.current?.abort(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('offline', invalidate); window.removeEventListener('online', online); };
  }, [load]);
  async function mutate(path: string, method: 'POST' | 'PUT' | 'DELETE', body: object, message: string) {
    if (busyRef.current || !navigator.onLine) return false;
    let reread = false;
    busyRef.current = true; setBusy(true); setWriteError(''); setNotice(''); version.current++; readController.current?.abort();
    try {
      const value = await api<AutoState>(BASE + path, { method, body: JSON.stringify(body), timeoutMs: 15_000 });
      if (mounted.current) { received.current = performance.now(); setState(value); setVerified(navigator.onLine); setNotice(message); }
      return true;
    } catch (error) {
      // Without a definite answer the write may have been saved: re-read before anything is retried.
      // A 2xx whose body could not be read was very likely saved.
      const uncertain = !(error instanceof ApiError) || error.status >= 500 || error.status < 300;
      if (mounted.current) { if (error instanceof ApiError && error.status === 401) expired.current(); else setWriteError(`${error instanceof Error ? error.message : '操作未完成'}${uncertain ? ' 结果未确认，已重新读取规则列表，请核对后再操作。' : ''}`); }
      if (uncertain) reread = true;
      if (uncertain) setVerified(false);
      return false;
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); if (reread) void load(); }
  }
  const action = useCallback((rule: AutoRule, path: string, method: 'POST' | 'DELETE', body: object) => mutate(`/rules/${rule.id}${path ? '/' + path : ''}`, method, body,
    { enable: '规则已启用，满足条件时将自动下单。', live: '已转为实盘，等待新盘口重新判断。', observe: '已开始只观察，不会下单。', disable: '规则已停用；执行中的任务不受影响。', reset: '规则已重置为等待开仓，需要重新启用。', '': '规则已删除。' }[path] ?? '已更新。'), []);
  const edit = useCallback((rule: AutoRule) => setEditor({ rule, key: Date.now() }), []);
  async function save(config: AutoRuleConfig, enable: boolean, observe: boolean) {
    const rule = editor?.rule ?? null;
    const ok = rule ? await mutate(`/rules/${rule.id}`, 'PUT', { revision: rule.revision, config }, '规则已更新。')
      : await mutate('/rules', 'POST', { config, ...(observe ? { mode: 'observe', observing: true } : enable ? { enabled: true, confirmLive: true } : {}) }, observe ? '规则已保存并开始只观察。' : enable ? '规则已保存并启用。' : '规则已保存，启用后才会自动下单。');
    if (ok) setEditor(null);
    return ok;
  }
  const disabled = busy || !navigator.onLine;
  const evidenceValid = verified && navigator.onLine && Math.max(0, clock - received.current) <= 12_000;
  const serverNow = Date.parse(state?.generatedAt ?? '') + Math.max(0, clock - received.current);
  return <section className="trading-panel auto-panel" aria-labelledby="auto-title">
    <header className="trading-panel-heading"><div><h2 id="auto-title"><Bot size={17} />自动开平仓</h2><p>同所两腿 · 可成交价差达到阈值时自动开仓，回到平仓阈值时自动平仓 · 由服务器运行，关闭页面不影响</p></div><div className="execution-actions"><button className="button secondary" type="button" disabled={disabled || reading} onClick={() => void load()}><RefreshCw size={15} className={reading ? 'spin' : ''} />刷新</button>{!editor ? <button className="button primary" type="button" disabled={disabled} onClick={() => setEditor({ rule: null, key: Date.now() })}><Plus size={15} />新建规则</button> : null}</div></header>
    {state?.maintenance ? <p className="execution-message warning" role="status"><CircleAlert size={16} />系统正在更新，自动规则暂停触发；更新完成后恢复。</p> : null}
    {readError ? <p className="execution-message warning" role="alert">{readError}</p> : null}
    {writeError ? <p className="execution-message warning" role="alert"><CircleAlert size={16} />{writeError}</p> : null}
    {notice ? <p className="execution-message" role="status">{notice}</p> : null}
    {editor ? <RuleForm key={editor.key} initial={editor.rule ? formOf(editor.rule.config) : emptyForm()} editing={editor.rule} disabled={disabled} onSave={save} onCancel={() => setEditor(null)} /> : null}
    <div className="auto-rules">{state ? state.rules.length ? state.rules.map(rule => <RuleCard key={`${rule.id}:${rule.revision}:${evidenceValid}`} rule={rule} disabled={disabled || !evidenceValid} evidenceValid={evidenceValid} serverNow={serverNow} onAction={action} onEdit={edit} />) : <p className="execution-help">尚无自动规则。可以先只观察条件信号，再确认启用实盘。</p> : <p className="execution-help">正在读取自动规则…</p>}</div>
    <p className="execution-help auto-panel-note">使用「价差下单」中「组合交易」的实盘账户连接与执行器，下单前同样核对账户、盘口、持仓和现有委托。任务未全部成交（暂停、停止或待核对）时规则自动停用，需人工核对后重置。服务重启会暂停执行中的任务，对应规则同样转为待核对。同一交易所与品种可以有多条规则，每条只平自己开的仓；它们的任务依次执行，同合约有未结束的任务时其他规则等待。单向持仓模式下，反方向的规则要等已有仓位平掉后才开仓。</p>
  </section>;
}
