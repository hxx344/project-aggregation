"use client";
import { hubChanged } from "../lib/hub-bridge";

import { memo, useEffect, useRef, useState, type FormEvent } from 'react';
import { Bell, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { startActivityPolling } from '../lib/polling';
import type { PerpetualSpread } from '../lib/perpetual-spreads';
import type { QualityBudget } from '../lib/perpetual-fees';
import { createPerpetualAlertId, maxPerpetualAlertRules, type PerpetualAlertRule, type PerpetualAlertConfig, type PerpetualAlertView } from '../lib/perpetual-alerts';
import './perpetual-alerts.css';

const time = (stamp: number | null | undefined) => stamp ? new Date(stamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const numberValue = (value: number) => Number.isFinite(value) ? value : '';
const initial: PerpetualAlertConfig = { enabled: false, rules: [] };

function PerpetualAlerts({ active = true, defaultOpen = false, pair = null, budget }: { active?: boolean; defaultOpen?: boolean; pair?: PerpetualSpread | null; budget: QualityBudget }) {
  const [open, setOpen] = useState(defaultOpen), [view, setView] = useState<PerpetualAlertView | null>(null);
  const [draft, setDraft] = useState<PerpetualAlertConfig>(initial), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [message, setMessage] = useState('');
  const dirtyRef = useRef(false), busyRef = useRef(false), generation = useRef(0), latestRevision = useRef(0), mutation = useRef<AbortController | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  function apply(result: PerpetualAlertView) { setView(result); setDraft(result.config); setRevision(result.revision); latestRevision.current = result.revision; dirtyRef.current = false; setDirty(false); }
  function edit(next: PerpetualAlertConfig) { dirtyRef.current = true; setDirty(true); setDraft(next); setMessage(''); }
  function editRule(id: string, patch: Partial<PerpetualAlertRule>) { edit({ ...draft, rules: draft.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) }); }
  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protectDraft);
    return () => { mutation.current?.abort(); window.removeEventListener('beforeunload', protectDraft); };
  }, []);
  useEffect(() => {
    if (!open || !active) return;
    const polling = startActivityPolling({ intervalMs: 5_000, load: async signal => {
      if (busyRef.current) return null;
      const version = generation.current;
      const response = await fetch('/api/monitors/perpetual/alerts', { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      if (!response.ok) throw new Error('合约机会提醒后台未连接');
      const result = await response.json() as PerpetualAlertView;
      if (version !== generation.current || busyRef.current || result.revision < latestRevision.current) return null;
      if (!Number.isSafeInteger(result.revision) || !Array.isArray(result.config?.rules)) throw new Error('提醒资料格式异常');
      return result;
    }, onData: result => {
      if (!result) return;
      setView(result); setError(''); latestRevision.current = result.revision;
      if (!dirtyRef.current) { setDraft(result.config); setRevision(result.revision); }
    }, onError: () => setError('无法读取机会提醒后台，保留当前草稿。只有 Linux 常驻服务可在关页后发送。') });
    refresh.current = polling.refresh;
    const reload = () => { void polling.refresh(); };
    window.addEventListener('feishu-settings-changed', reload);
    return () => { polling.stop(); window.removeEventListener('feishu-settings-changed', reload); };
  }, [active, open]);
  async function save(discard = false) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); generation.current++; setError(''); setMessage('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const response = await fetch('/api/monitors/perpetual/alerts', { method: discard ? 'GET' : 'PUT', cache: 'no-store', headers: discard ? undefined : { 'Content-Type': 'application/json' },
        body: discard ? undefined : JSON.stringify({ revision, ...draft }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const result = await response.json() as PerpetualAlertView & { error?: string };
      if (!response.ok || !result.available) throw new Error(result.error || 'Linux 机会提醒后台未连接，草稿已保留');
      if (!discard) hubChanged();
      if (result.revision < latestRevision.current) throw new Error('后台返回旧配置，草稿已保留，请稍后重试');
      if (controller.signal.aborted) return;
      apply(result); setMessage(discard ? '已重载后台配置。' : '规则已保存，后台从下一次观察开始检查。');
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '保存失败，草稿已保留'); }
    finally { generation.current++; busyRef.current = false; if (!controller.signal.aborted) { setBusy(false); void refresh.current(); } }
  }
  function addPair() {
    if (!pair || draft.rules.length >= maxPerpetualAlertRules) return;
    const rule: PerpetualAlertRule = { id: createPerpetualAlertId(), name: `${pair.base} ${pair.long.exchange} → ${pair.short.exchange}`, enabled: false,
      base: pair.base, longKey: `${pair.long.exchange}:${pair.long.symbol}`, shortKey: `${pair.short.exchange}:${pair.short.symbol}`,
      thresholdPercent: 0.3, durationSeconds: 30, windowSeconds: 60, minHitRatio: 0.8, cooldownSeconds: 300, maxAgeSeconds: 10,
      budget: { slippagePercent: budget.slippagePercent, takerOverrides: { ...budget.takerOverrides } } };
    edit({ ...draft, rules: [...draft.rules, rule] });
  }
  const connected = view?.available === true;
  return <section className="perp-opportunity-alerts" aria-label="合约组合持续条件提醒">
    <button type="button" className="perp-opportunity-heading" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="perp-opportunity-alerts-body"><span><Bell size={17}/><strong>机会提醒</strong><small>{view ? view.config.enabled ? '飞书已启用' : '飞书未启用' : '后台持续条件'}{dirty ? ' · 未保存' : ''}</small></span><ChevronDown size={16}/></button>
    {open ? <div id="perp-opportunity-alerts-body" className="perp-opportunity-body">
      <p>每个完整做多 / 做空组合独立观察。持续时间与窗口达标占比同时满足后提醒；持续达标只提醒一次，需先跌回阈值以下并结束冷却才可再次提醒。缺失、过期或停机间隔会中断持续计时。</p>
      <p className="perp-opportunity-note">{connected ? '运行于 Linux 后台，关闭浏览器继续观察；状态查看每 5 秒更新，收起即停止页面查询。' : '未连接 Linux 提醒后台，浏览器不承担关页后的观察或消息发送。'} {connected && !view.webhookConfigured ? '尚未配置统一飞书机器人。' : ''}<button type="button" onClick={() => window.dispatchEvent(new Event('open-feishu-settings'))}>统一飞书设置</button></p>
      {error ? <p role="alert" className="perp-opportunity-error">{error}</p> : null}
      {view?.error ? <p role="status" className="perp-opportunity-error">{view.error}</p> : null}
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || !connected}>
          <div className="perp-opportunity-toolbar"><strong>观察组合 {draft.rules.length} / {maxPerpetualAlertRules}</strong><button type="button" disabled={!pair || draft.rules.length >= maxPerpetualAlertRules || pair.crossCurrency} onClick={addPair}><Plus size={14}/>添加当前组合</button></div>
          {!pair ? <p className="perp-opportunity-note">先展开价差列表的一条组合，即可添加该组合。</p> : pair.crossCurrency ? <p className="perp-opportunity-note">此提醒暂只支持相同计价币的组合。</p> : <p className="perp-opportunity-note">当前：{pair.base} · {pair.long.exchange} {pair.long.symbol} → {pair.short.exchange} {pair.short.symbol}</p>}
          {draft.rules.map(rule => {
            const progress = view?.progress[rule.id];
            return <article className="perp-opportunity-rule" key={rule.id}>
              <div className="perp-opportunity-rule-heading"><label><input type="checkbox" checked={rule.enabled} onChange={event => editRule(rule.id, { enabled: event.target.checked })}/>观察此组合</label><button type="button" aria-label={`删除 ${rule.name}`} onClick={() => edit({ ...draft, rules: draft.rules.filter(item => item.id !== rule.id) })}><Trash2 size={15}/></button></div>
              <p className="perp-opportunity-identity">{rule.base} · 做多 {rule.longKey} → 做空 {rule.shortKey}</p>
              <div className="perp-opportunity-fields">
                <label>规则名称<input required maxLength={80} value={rule.name} onChange={event => editRule(rule.id, { name: event.target.value })}/></label>
                <label>扣预算后价差 ≥ %<input required type="number" min={-100} max={1000} step="any" value={numberValue(rule.thresholdPercent)} onChange={event => editRule(rule.id, { thresholdPercent: event.target.valueAsNumber })}/></label>
                <label>连续达标 / 秒<input required type="number" min={1} max={3600} step={1} value={numberValue(rule.durationSeconds)} onChange={event => editRule(rule.id, { durationSeconds: event.target.valueAsNumber })}/></label>
                <label>观察窗口 / 秒<input required type="number" min={5} max={3600} step={1} value={numberValue(rule.windowSeconds)} onChange={event => editRule(rule.id, { windowSeconds: event.target.valueAsNumber })}/></label>
                <label>窗口达标占比 ≥ %<input required type="number" min={0} max={100} step={1} value={numberValue(rule.minHitRatio * 100)} onChange={event => editRule(rule.id, { minHitRatio: event.target.valueAsNumber / 100 })}/></label>
                <label>冷却 / 秒<input required type="number" min={30} max={86400} step={1} value={numberValue(rule.cooldownSeconds)} onChange={event => editRule(rule.id, { cooldownSeconds: event.target.valueAsNumber })}/></label>
                <label>最大报价年龄 / 秒<input required type="number" min={1} max={30} step={1} value={numberValue(rule.maxAgeSeconds)} onChange={event => editRule(rule.id, { maxAgeSeconds: event.target.valueAsNumber })}/></label>
                <label>双腿往返滑点 / %<input required type="number" min={0} max={10} step="any" value={numberValue(rule.budget.slippagePercent)} onChange={event => editRule(rule.id, { budget: { ...rule.budget, slippagePercent: event.target.valueAsNumber } })}/></label>
              </div>
              <p className="perp-opportunity-note">taker 按后台最新公开费率；{Object.keys(rule.budget.takerOverrides).length ? `${Object.keys(rule.budget.takerOverrides).length} 家使用添加规则时的账户覆盖。` : '未设置账户覆盖。'}<button type="button" onClick={() => editRule(rule.id, { budget: { slippagePercent: budget.slippagePercent, takerOverrides: { ...budget.takerOverrides } } })}>同步当前费用设置</button></p>
              {progress ? <div className={`perp-opportunity-progress ${progress.state}`}><strong>{{ disabled: '观察关闭', observing: '观察中', triggered: '条件达标' }[progress.state]}</strong><span>连续 {progress.continuousSeconds} 秒</span><span>窗口达标 {(progress.hitRatio * 100).toFixed(1)}%</span><span>有效覆盖 {(progress.coverage * 100).toFixed(1)}%</span><span>扣预算价差 {progress.netSpreadPercent === null ? '—' : `${progress.netSpreadPercent.toFixed(4)}%`}</span><p>{progress.reason} · 检查 {time(progress.checkedAt)}</p></div> : <p className="perp-opportunity-note">保存后开始积累真实样本。</p>}
            </article>;
          })}
          <div className="perp-opportunity-actions"><label><input type="checkbox" checked={draft.enabled} onChange={event => edit({ ...draft, enabled: event.target.checked })}/>启用这些规则的飞书提醒</label><div>{dirty ? <button type="button" onClick={() => void save(true)}>放弃并重载</button> : null}<button type="submit">{busy ? '保存中…' : '保存规则'}</button></div></div>
        </fieldset>
      </form>
      <p className="perp-opportunity-note">飞书关闭时，已开启观察的规则仍累计持续时间与窗口占比。缺失费率不会视为零费率。扣预算价差是入场筛选，未计持有期资金费、退出价差或实际深度。</p>
      {message ? <p role="status" className="perp-opportunity-success">{message}</p> : null}
      <details className="perp-opportunity-history"><summary>最近提醒记录（24 小时，最多 100 条）</summary>{view?.history.length ? view.history.map(item => <p key={item.id}><strong>{{ sending: '发送中或结果待确认', sent: '已发送', failed: '未发送成功' }[item.status]}</strong> · {time(item.time)} · {item.name} · {item.netSpreadPercent.toFixed(4)}%{item.error ? ` · ${item.error}` : ''}</p>) : <p>尚无提醒记录。</p>}</details>
    </div> : null}
  </section>;
}
export default memo(PerpetualAlerts);
