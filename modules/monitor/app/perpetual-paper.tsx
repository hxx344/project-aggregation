"use client";
import { hubChanged } from "../lib/hub-bridge";

import { lazyComponent } from '../lib/lazy-component';
import { memo, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { startActivityPolling } from '../lib/polling';
import type { PerpetualExitInput } from '../lib/perpetual-exit';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperPosition, type PerpetualPaperView } from '../lib/perpetual-paper';
import './perpetual-paper.css';

const ExitCheck = lazyComponent(async () => ({ default: (await import('./perpetual-exit')).PerpetualExitCheck }), { loading: () => <p className="perp-paper-note">正在载入盘口测算…</p> });
const money = (value: number | null | undefined, digits = 3) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const precision = (value: number) => Number.isFinite(value) && value !== 0 && Math.abs(value) < 1e-8 ? value.toExponential(4) : money(value, 8);
const percent = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${money(value)}%` : '—';
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const numeric = (value: string) => value.trim() ? Number(value) : NaN;
const optional = (value: string) => value.trim() ? numeric(value) : null;
const display = (value: number | null | undefined) => value == null ? '' : String(value);
const leg = (key: string) => { const index = key.indexOf(':'); return { exchange: key.slice(0, index), symbol: key.slice(index + 1) }; };
const exitInput = (position: PerpetualPaperPosition): PerpetualExitInput => ({ long: leg(position.longKey), short: leg(position.shortKey), identity: position.identity,
  quantity: position.quantity, entryLongPrice: position.entryLongPrice, entryShortPrice: position.entryShortPrice, entryFeePaid: position.entryFeePaid,
  settledFunding: position.settledFunding, capital: position.capital ?? null, takerOverrides: position.takerOverrides });

type EditorKind = 'update' | 'close' | 'stop' | 'delete';
type Fields = { settledFunding: string; capital: string; targetNetProfit: string; maxHoldingHours: string; note: string; exitLongPrice: string; exitShortPrice: string; closeFeePaid: string; closedAt: string };
type Editor = { id: string; kind: EditorKind; revision: number; source: PerpetualPaperPosition; fields: Fields; fundingConfirmed: boolean; conflict: boolean };
const draftFields = (position: PerpetualPaperPosition): Fields => ({ settledFunding: display(position.settledFunding), capital: display(position.capital), targetNetProfit: display(position.targetNetProfit),
  maxHoldingHours: display(position.maxHoldingHours), note: position.note, exitLongPrice: '', exitShortPrice: '', closeFeePaid: '', closedAt: '' });
const editorTitle: Record<EditorKind, string> = { update: '更新持仓参数', close: '登记两腿平仓', stop: '停止跟踪', delete: '删除已结束记录' };

function PaperWorkspace({ active, readActive = active }: { active: boolean; readActive?: boolean }) {
  const id = useId(), [view, setView] = useState<PerpetualPaperView | null>(null), [now, setNow] = useState(0);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [inspectionId, setInspectionId] = useState<string | null>(null), [page, setPage] = useState(0);
  const anchor = useRef({ server: 0, elapsed: 0 }), revision = useRef(-1), generation = useRef(0), busyRef = useRef(false), editorRef = useRef<Editor | null>(null);
  const read = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), refresh = useRef<() => Promise<void>>(async () => {});
  const editorHeading = useRef<HTMLHeadingElement | null>(null);

  function apply(result: PerpetualPaperView) {
    if (result.revision < revision.current) return;
    revision.current = result.revision;
    anchor.current = { server: result.generatedAt, elapsed: performance.now() };
    setNow(result.generatedAt); setView(result);
  }
  function edit(next: Editor | null) { editorRef.current = next; setEditor(next); }
  function changeField(key: keyof Fields, value: string) {
    const current = editorRef.current;
    if (current) edit({ ...current, fields: { ...current.fields, [key]: value } });
  }
  useEffect(() => { editorHeading.current?.focus(); }, [editor?.id, editor?.kind]);
  useEffect(() => {
    const hide = () => { if (document.hidden) mutation.current?.abort(); };
    const protect = (event: BeforeUnloadEvent) => { if (editorRef.current) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hide); window.addEventListener('beforeunload', protect);
    return () => { read.current?.abort(); mutation.current?.abort(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('beforeunload', protect); };
  }, []);
  useEffect(() => {
    if (!readActive || unavailable) { read.current?.abort(); return; }
    const polling = startActivityPolling({ intervalMs: 5_000, load: async signal => {
      if (busyRef.current) return null;
      const controller = new AbortController(), version = generation.current; read.current = controller;
      try {
        const response = await fetch('/api/monitors/perpetual/paper', { cache: 'no-store', signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(8_000)]) });
        const result = await response.json() as PerpetualPaperView;
        if (!response.ok) throw new Error(result.error || '持仓跟踪后台未连接');
        if (!Number.isSafeInteger(result.revision) || !Number.isFinite(result.generatedAt) || !Array.isArray(result.positions)) throw new Error('持仓资料格式异常');
        return version === generation.current && !busyRef.current && result.revision >= revision.current ? { ...result, limits: result.limits ?? PERPETUAL_PAPER_LIMITS } : null;
      } catch (cause) { if (controller.signal.aborted || version !== generation.current) return null; throw cause;
      } finally { if (read.current === controller) read.current = null; }
    }, onData: result => { if (result) { apply(result); setLoadError(''); if (!result.available) setUnavailable(true); } }, onError: cause => setLoadError(cause instanceof Error ? cause.message : '持仓资料更新失败，保留上次记录') });
    const clock = startActivityPolling({ intervalMs: 1_000, load: async () => anchor.current.server ? anchor.current.server + Math.max(0, performance.now() - anchor.current.elapsed) : 0,
      onData: value => setNow(value), onError: () => {} });
    refresh.current = polling.refresh;
    return () => { polling.stop(); clock.stop(); refresh.current = async () => {}; };
  }, [readActive, unavailable]);
  useEffect(() => { if (!active || unavailable) mutation.current?.abort(); }, [active, unavailable]);

  function begin(position: PerpetualPaperPosition, kind: EditorKind) {
    if (!view || busyRef.current || editorRef.current) return;
    edit({ id: position.id, kind, source: position, fields: draftFields(position), revision: view.revision, fundingConfirmed: false, conflict: false });
    setError(''); setMessage('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const current = editorRef.current;
    if (!current || !active || document.hidden || busyRef.current) return;
    const { fields, source } = current;
    let payload: Record<string, unknown> = { revision: current.revision, id: current.id };
    if (current.kind === 'update') {
      const changes: Record<string, unknown> = { capital: optional(fields.capital), targetNetProfit: optional(fields.targetNetProfit), maxHoldingHours: optional(fields.maxHoldingHours), note: fields.note };
      if (numeric(fields.settledFunding) !== source.settledFunding || current.fundingConfirmed) changes.settledFunding = numeric(fields.settledFunding);
      if (!Number.isFinite(numeric(fields.settledFunding)) || (changes.capital !== null && (!Number.isFinite(changes.capital) || Number(changes.capital) <= 0)) || (changes.targetNetProfit !== null && !Number.isFinite(changes.targetNetProfit))
        || (changes.maxHoldingHours !== null && (!Number.isFinite(changes.maxHoldingHours) || Number(changes.maxHoldingHours) <= 0 || Number(changes.maxHoldingHours) > 8760))) { setError('请填写有效金额；本金、最长时间需大于 0，最长时间不超过 8760 小时。'); return; }
      payload = { ...payload, action: 'update', changes };
    } else if (current.kind === 'close') {
      const close = { kind: 'realized', exitLongPrice: numeric(fields.exitLongPrice), exitShortPrice: numeric(fields.exitShortPrice), closeFeePaid: numeric(fields.closeFeePaid), settledFunding: numeric(fields.settledFunding),
        ...(fields.closedAt ? { closedAt: Date.parse(`${fields.closedAt}:00+08:00`) } : {}) };
      if (![close.exitLongPrice, close.exitShortPrice].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(close.closeFeePaid) || close.closeFeePaid < 0 || !Number.isFinite(close.settledFunding)) { setError('请填写两腿平仓均价、已付平仓费用和累计资金费。'); return; }
      if (close.closedAt !== undefined && (!Number.isFinite(close.closedAt) || close.closedAt < source.openedAt || close.closedAt > now + 5_000)) { setError('结束时间须介于开仓与当前北京时间之间。'); return; }
      payload = { ...payload, action: 'close', close };
    } else if (current.kind === 'stop') payload = { ...payload, action: 'close', close: { kind: 'stop' } };
    else payload = { ...payload, action: 'delete' };
    busyRef.current = true; generation.current++; read.current?.abort(); setBusy(true); setError(''); setMessage('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const response = await fetch('/api/monitors/perpetual/paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const result = await response.json() as PerpetualPaperView;
      if (!response.ok) { if (response.status === 409) edit({ ...current, conflict: true }); throw new Error(result.error || '保存失败，输入已保留'); }
      hubChanged();
      if (!result.available || !Array.isArray(result.positions) || !Number.isSafeInteger(result.revision)) throw new Error('后台返回格式异常，请刷新核对保存结果');
      if (!controller.signal.aborted) { apply(result); edit(null); setMessage(current.kind === 'stop' ? '已停止观察，未登记平仓收益。' : current.kind === 'delete' ? '已删除记录。' : current.kind === 'close' ? '已保存手工登记的平仓结果。' : '持仓参数已保存。'); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '保存失败，输入已保留'); }
    finally { if (mutation.current === controller) mutation.current = null; generation.current++; busyRef.current = false; setBusy(false); if (!controller.signal.aborted) void refresh.current(); }
  }
  async function reloadRevision() {
    const current = editorRef.current;
    if (!current || !active || document.hidden || busyRef.current) return;
    busyRef.current = true; generation.current++; read.current?.abort(); setBusy(true); setError('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const response = await fetch('/api/monitors/perpetual/paper', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) });
      const result = await response.json() as PerpetualPaperView;
      if (!response.ok || !result.available) throw new Error(result.error || '读取最新记录失败');
      if (!Array.isArray(result.positions) || !Number.isSafeInteger(result.revision) || !Number.isFinite(result.generatedAt) || result.revision < revision.current) throw new Error('最新记录格式异常或版本过旧，请稍后重试');
      const latest = result.positions.find(position => position.id === current.id);
      if (!latest || latest.status !== current.source.status) throw new Error('此记录已被结束或删除。输入已保留，请取消编辑后查看最新记录。');
      if (!controller.signal.aborted) { apply(result); edit({ ...current, revision: result.revision, conflict: false }); setMessage('已载入最新版本，保留你的输入。请核对下方当前记录，再次保存。'); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '重载失败'); }
    finally { if (mutation.current === controller) mutation.current = null; generation.current++; busyRef.current = false; setBusy(false); }
  }

  const positions = view?.positions ?? [], activePositions = positions.filter(position => position.status === 'active');
  const closedPositions = positions.filter(position => position.status !== 'active').sort((a, b) => (b.close?.closedAt ?? 0) - (a.close?.closedAt ?? 0));
  const pageCount = Math.max(1, Math.ceil(closedPositions.length / 10)), visiblePage = Math.min(page, pageCount - 1);
  const liveEditorPosition = editor ? positions.find(position => position.id === editor.id) : null;
  return <section className="perp-paper" aria-labelledby={`${id}-heading`}>
    <header className="perp-paper-heading"><div><h3 id={`${id}-heading`}>持仓跟踪与复盘</h3><p>活动 {activePositions.length} / {view?.limits.active ?? 20} · 已结束 {closedPositions.length} · 北京时间</p></div><span className="perp-paper-tag">{view?.running ? '后台按分钟观察' : view ? '后台未运行' : '正在连接后台'}</span></header>
    <p className="perp-paper-note">在组合详情的“平仓收益与持仓跟踪”中添加模拟仓位或登记已有持仓。当前估值使用缓存买卖一，不验证成交容量；深度仅点击时查询。资金费按手工登记净额计算。</p>
    {error ? <p role="alert" className="perp-paper-warning">{error}</p> : null}
    {loadError ? <p role="status" className="perp-paper-warning">{loadError}</p> : null}
    {view?.error ? <p role="status" className="perp-paper-warning">{view.error}</p> : null}
    {unavailable ? <button type="button" disabled={busy || !active} onClick={() => setUnavailable(false)}>重新连接</button> : null}
    {message ? <p role="status" className="perp-paper-success">{message}</p> : null}
    {editor ? <form className="perp-paper-editor" aria-labelledby={`${id}-editor-heading`} onSubmit={event => void save(event)}>
      <h4 id={`${id}-editor-heading`} tabIndex={-1} ref={editorHeading}>{editorTitle[editor.kind]} · {editor.source.base}</h4><p className="perp-paper-note">多 {editor.source.longKey} / 空 {editor.source.shortKey}</p>
      {editor.kind === 'update' ? <><div className="perp-paper-fields">
        {([{ key: 'settledFunding', label: '累计已结算资金费 / USDT', required: true }, { key: 'capital', label: '两账户投入本金 / USDT' }, { key: 'targetNetProfit', label: '目标净收益 / USDT' }, { key: 'maxHoldingHours', label: '最长持有时间 / 小时' }] as const).map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}><span>{field.label}</span><input id={`${id}-${field.key}`} type="number" step="any" inputMode="decimal" disabled={busy} required={'required' in field} value={editor.fields[field.key]} placeholder={'required' in field ? '收入为正，支出为负' : '留空关闭此项'} onChange={event => changeField(field.key, event.target.value)}/></label>)}
        <label className="perp-paper-note-field" htmlFor={`${id}-note`}><span>备注</span><input id={`${id}-note`} maxLength={200} disabled={busy} value={editor.fields.note} onChange={event => changeField('note', event.target.value)}/></label>
      </div><label className="perp-paper-checkbox"><input type="checkbox" disabled={busy} checked={editor.fundingConfirmed} onChange={event => edit({ ...editor, fundingConfirmed: event.target.checked })}/>资金费净额已核对；即使数值未变，也更新核对时间</label><p className="perp-paper-note">仅修改本金或目标不会确认资金费。修改净额或勾选核对后，更新资金费确认时间。</p></> : null}
      {editor.kind === 'close' ? <><p className="perp-paper-note">{editor.source.mode === 'paper' ? '填写本次模拟结束使用的价格和费用。' : '填写实际成交均价及费用；系统不会读取交易账户或提交订单。'} 收益来自你的登记，不代表交易所确认。</p><div className="perp-paper-fields">
        {([{ key: 'exitLongPrice', label: '卖出多腿均价 / USDT' }, { key: 'exitShortPrice', label: '买回空腿均价 / USDT' }, { key: 'closeFeePaid', label: '已付平仓费用合计 / USDT' }, { key: 'settledFunding', label: '累计已结算资金费 / USDT' }] as const).map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}><span>{field.label}</span><input id={`${id}-${field.key}`} type="number" step="any" inputMode="decimal" required disabled={busy} value={editor.fields[field.key]} onChange={event => changeField(field.key, event.target.value)}/></label>)}
        <label htmlFor={`${id}-closedAt`}><span>结束时间 / 北京时间</span><input id={`${id}-closedAt`} type="datetime-local" disabled={busy} value={editor.fields.closedAt} onChange={event => changeField('closedAt', event.target.value)}/><small>留空使用保存时的服务器时间</small></label>
      </div></> : null}
      {editor.kind === 'stop' ? <p className="perp-paper-note">停止后台观察并保留已有复盘资料。不会登记平仓价格，也不会把当前估值计作已实现收益。</p> : null}
      {editor.kind === 'delete' ? <p className="perp-paper-warning">删除这条已结束记录及其采样资料，此操作不能撤销。</p> : null}
      {(editor.conflict || (view && view.revision !== editor.revision)) ? <div className="perp-paper-conflict"><p>其他页面已修改记录。你的输入已保留，需载入最新版本后再保存。</p>{liveEditorPosition ? <p>当前登记：资金费 {money(liveEditorPosition.settledFunding)} USDT · 本金 {money(liveEditorPosition.capital)} USDT · 目标 {money(liveEditorPosition.targetNetProfit)} USDT · 最长 {money(liveEditorPosition.maxHoldingHours)} 小时</p> : null}<button type="button" disabled={busy || !active} onClick={() => void reloadRevision()}>载入最新版本并保留输入</button></div> : null}
      <div className="perp-paper-actions"><button type="submit" disabled={busy || !active || editor.conflict || Boolean(view && view.revision !== editor.revision)}>{busy ? '正在保存…' : editor.kind === 'stop' ? '确认停止跟踪' : editor.kind === 'delete' ? '确认删除记录' : '保存登记'}</button><button type="button" disabled={busy} onClick={() => { edit(null); setError(''); setMessage(''); }}>取消编辑</button></div>
    </form> : null}
    <div className="perp-paper-list">{activePositions.map(position => {
      const observation = position.currentObservation ?? position.lastObservation;
      const fresh = Boolean(observation?.valid && observation.sourceAt && now - observation.sourceAt <= (view?.limits.quoteFreshMs ?? 30_000) && observation.sourceAt <= now + 5_000);
      const pnl = fresh ? observation?.pnl : null, inspecting = inspectionId === position.id;
      const duration = Math.max(0, now - position.openedAt) / 3_600_000;
      return <article key={position.id} className="perp-paper-card" aria-label={`${position.base} ${position.mode === 'paper' ? '模拟持仓' : '登记持仓'}`}>
        <header><div><strong>{position.base}</strong><span className="perp-paper-badge">{position.mode === 'paper' ? '模拟仓位' : '手工登记'}</span></div><span className="perp-paper-note">已持有 {money(duration, 2)} 小时</span></header>
        <p className="perp-paper-pair">多 {position.longKey} <span>/</span> 空 {position.shortKey}</p>
        <div className="perp-paper-summary"><div><span>当前一档估算净收益</span><strong className={pnl && pnl.netProfit < 0 ? 'perp-paper-negative' : ''}>{money(pnl?.netProfit)} <small>USDT</small></strong><small>{fresh ? '仅计登记资金费 · 未核验深度' : observation?.valid ? '报价已过期，等待更新' : observation?.reason || '等待有效报价'}</small></div><div><span>以多腿开仓名义金额为分母</span><strong>{percent(pnl?.returnOnLongNotionalPercent)}</strong><small>以投入本金为分母 {percent(pnl?.returnOnCapitalPercent)}</small></div></div>
        <dl className="perp-paper-details"><div><dt>两腿数量 / {position.base}</dt><dd>{precision(position.quantity)}</dd></div><div><dt>开仓均价 / USDT</dt><dd>多 {precision(position.entryLongPrice)} · 空 {precision(position.entryShortPrice)}</dd></div><div><dt>开仓时间</dt><dd>{time(position.openedAt)}</dd></div><div><dt>一档来源时间</dt><dd>{time(observation?.sourceAt)}</dd></div><div><dt>两腿价格盈亏 / USDT</dt><dd>{money(pnl?.grossProfit)}</dd></div><div><dt>开仓已付 / 预计平仓费用</dt><dd>{money(position.entryFeePaid)} / {money(pnl?.closeFeePaid)} USDT</dd></div><div><dt>登记资金费净额</dt><dd>{money(position.settledFunding)} USDT</dd></div><div><dt>资金费核对时间</dt><dd>{time(position.fundingUpdatedAt)}</dd></div><div><dt>最差分钟观测</dt><dd>{money(position.worstObservedNetProfit)} USDT</dd></div><div><dt>有效 / 全部分钟观测</dt><dd>{position.validObservations} / {position.observations}</dd></div><div><dt>目标净收益</dt><dd>{position.targetNetProfit === null ? '未设置' : `${money(position.targetNetProfit)} USDT`}{position.targetReachedAt ? ' · 估值曾触达' : ''}</dd></div><div><dt>最长持有时间</dt><dd>{position.maxHoldingHours === null ? '未设置' : `${money(position.maxHoldingHours)} 小时`}{position.timedOutAt || position.maxHoldingHours !== null && duration >= position.maxHoldingHours ? ' · 已超时' : ''}</dd></div></dl>
        {observation?.fundingNeedsReview ? <p role="status" className="perp-paper-warning">{position.nextFundingAt !== null && now >= position.nextFundingAt && position.fundingUpdatedAt < position.nextFundingAt ? '已跨资金费结算时点，请核对累计净额。' : '至少一腿结算时间未知或尚未更新，请手工核对累计资金费。'}当前估值尚未计入未登记的资金费。</p> : null}
        {position.targetReachedAt ? <p className="perp-paper-note">首次估值触达 {time(position.targetReachedAt)}；只是采样记录，不代表当时可以全部成交。</p> : null}
        {position.note ? <p className="perp-paper-note">备注：{position.note}</p> : null}
        <div className="perp-paper-actions"><button type="button" disabled={!active || busy} aria-expanded={inspecting} aria-controls={`${id}-depth-${position.id}`} onClick={() => setInspectionId(inspecting ? null : position.id)}>{inspecting ? '收起盘口测算' : '核验平仓盘口'}</button><button type="button" disabled={!active || busy || Boolean(editor)} onClick={() => begin(position, 'update')}>更新资金费与参数</button><button type="button" disabled={!active || busy || Boolean(editor)} onClick={() => begin(position, 'close')}>{position.mode === 'paper' ? '登记模拟结束' : '登记平仓'}</button><button type="button" disabled={!active || busy || Boolean(editor)} onClick={() => begin(position, 'stop')}>停止跟踪</button></div>
        {inspecting ? <div id={`${id}-depth-${position.id}`}><ExitCheck input={exitInput(position)} active={active} now={now}/></div> : null}
      </article>;
    })}</div>
    {view?.available && !activePositions.length ? <p className="perp-paper-empty">暂无活动持仓。从价差组合详情添加一条模拟跟踪即可开始观察。</p> : null}
    {closedPositions.length ? <section className="perp-paper-history" aria-labelledby={`${id}-history`}><h4 id={`${id}-history`}>已结束记录</h4><p className="perp-paper-note">最多保留 100 条 / 30 天；停止跟踪的记录不计作平仓收益。</p><div className="perp-paper-list">{closedPositions.slice(visiblePage * 10, visiblePage * 10 + 10).map(position => <article className="perp-paper-card perp-paper-closed" key={position.id}>
      <header><div><strong>{position.base}</strong><span className="perp-paper-badge">{position.mode === 'paper' ? '模拟' : '手工登记'} · {position.status === 'stopped' ? '已停止观察' : '已登记结束'}</span></div><button type="button" disabled={!active || busy || Boolean(editor)} onClick={() => begin(position, 'delete')}>删除记录</button></header><p className="perp-paper-pair">多 {position.longKey} / 空 {position.shortKey}</p>
      <dl className="perp-paper-details"><div><dt>结束时间</dt><dd>{time(position.close?.closedAt)}</dd></div><div><dt>{position.status === 'stopped' ? '平仓收益' : position.mode === 'paper' ? '模拟登记净收益' : '手工登记净收益'}</dt><dd>{position.status === 'stopped' ? '未登记' : `${money(position.close?.pnl?.netProfit)} USDT`}</dd></div><div><dt>最差分钟观测</dt><dd>{money(position.worstObservedNetProfit)} USDT</dd></div><div><dt>持有时间</dt><dd>{money(position.holdingHours, 2)} 小时</dd></div><div><dt>以多腿开仓名义金额为分母</dt><dd>{percent(position.close?.pnl?.returnOnLongNotionalPercent)}</dd></div><div><dt>以投入本金为分母</dt><dd>{percent(position.close?.pnl?.returnOnCapitalPercent)}</dd></div></dl>
    </article>)}</div><nav className="perp-paper-pagination" aria-label="已结束持仓分页"><button type="button" disabled={visiblePage === 0} onClick={() => setPage(Math.max(0, visiblePage - 1))}>上一页</button><span>{visiblePage + 1} / {pageCount} · 每页 10 条</span><button type="button" disabled={visiblePage >= pageCount - 1} onClick={() => setPage(visiblePage + 1)}>下一页</button></nav></section> : null}
  </section>;
}

export default memo(PaperWorkspace);
