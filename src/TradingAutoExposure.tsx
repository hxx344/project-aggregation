import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import type { AutoExposure, AutoExposureGroup } from './trading-auto-exposure-types';

const names: Record<string, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
const phases: Record<string, string> = { idle: '等待开仓', opening: '开仓中', holding: '记录持仓', closing: '平仓中', review: '待核对' };
const jobs: Record<string, string> = { queued: '排队', running: '执行中', stopping: '停止中', paused: '暂停', attention: '待核对', completed: '完成', stopped: '停止' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? timeFormat.format(Date.parse(value)) : '未取得';
const quantity = (value: string | null, unit: string) => value === null ? '未知' : `${value} ${unit}`;
function ExposureGroup({ group }: { group: AutoExposureGroup }) {
  const metric = (label: string, value: { quantity: string | null; notional: string | null }) => <p><strong>{label}：</strong>{quantity(value.quantity, group.unit)}{value.notional !== null ? <span className="execution-help"> · 约 {value.notional} {group.quoteAsset}</span> : null}</p>;
  return <article className="execution-job" aria-label={`${names[group.exchange]} ${group.instrumentId ?? group.symbol} ${group.side === 'long' ? '多头' : '空头'}敞口`}>
    <header><div><h3>{names[group.exchange]} · {group.instrumentId ?? `${group.symbol}（原生代码未确认）`}<span className="execution-badge">{group.side === 'long' ? '多头' : '空头'}</span>{group.sharedRuleIds.length > 1 ? <span className="execution-badge attention">{group.sharedRuleIds.length} 条规则共享合约</span> : null}</h3>
      <p>{group.accountLabel} · 数量单位：{group.unit} · 每单位乘数：{group.contractSize ?? '未知'}{!group.currentAccount ? ' · 历史或未核验账户' : ''}</p></div></header>
    {metric('配置目标合计', group.target)}
    {group.target.unknownCount ? <p className="execution-help">已知部分 {quantity(group.target.knownQuantity, group.unit)}；{group.target.unknownCount} 项未换算</p> : null}
    {metric('规则记录持仓', group.held)}
    {group.held.unknownCount ? <p className="execution-help">已核验记录 {quantity(group.held.knownQuantity, group.unit)}；{group.held.unknownCount} 项归属未确认</p> : null}
    {metric('账户真实仓位', group.actual)}
    <p><strong>在途委托：</strong>买入余量 {quantity(group.orders.buyQuantity, group.unit)} · 卖出余量 {quantity(group.orders.sellQuantity, group.unit)}{group.orders.unknownCount ? ` · ${group.orders.unknownCount} 项证据缺口` : ''}</p>
    {group.orders.items.some(order => !['LONG', 'SHORT'].includes(order.positionSide ?? '')) ? <p className="execution-help">多空归属未确认的委托同时列于两方向明细；这是同一委托，不能相加。</p> : null}
    <p className="execution-help">仓位读取起点 {time(group.accountAt)} · 盘口 {time(group.quoteAt)}（北京时间）</p>
    {group.rules.length ? <ul>{group.rules.map(rule => <li key={rule.id}>{rule.title} · {rule.mode === 'observe' ? rule.observing ? '观察运行中' : '观察已停用' : rule.enabled ? '实盘已启用' : '实盘未启用'} · {phases[rule.phase] ?? rule.phase} · 目标 {quantity(rule.quantity, group.unit)}{rule.heldQuantity !== null ? ` · 记录 ${quantity(rule.heldQuantity, group.unit)}` : ''}{rule.waitingFor.length ? ` · 共享合约被 ${rule.waitingFor.length} 个任务占用或待核对` : ''}</li>)}</ul> : null}
    {group.jobs.length ? <details><summary>共享合约任务（{group.jobs.length}）</summary><ul>{group.jobs.map(job => <li key={job.id}>{job.ruleId ? '自动' : '手动'}{job.action === 'open' ? '开仓' : '平仓'} · {jobs[job.status] ?? job.status} · {job.id.slice(0, 8)} · 本方向计划余量 {quantity(job.remainingQuantity, group.unit)}{!job.accountMatches ? ' · 账户不匹配' : ''}</li>)}</ul></details> : null}
    {group.orders.items.length ? <details><summary>交易所委托明细（{group.orders.items.length}）</summary><ul>{group.orders.items.map((order, index) => <li key={`${order.kind}-${order.id ?? index}`}>{order.kind === 'strategy' ? '策略委托' : '普通委托'} · {order.side === 'buy' ? '买入' : order.side === 'sell' ? '卖出' : '方向未知'} · 余量 {quantity(order.remainingQuantity, group.unit)} · {order.positionSide === 'LONG' ? '多头仓位' : order.positionSide === 'SHORT' ? '空头仓位' : '开平方向未确认'}{order.reduceOnly === true ? ' · 只减仓' : ''}</li>)}</ul></details> : null}
    {group.gaps.length ? <div className="execution-warning" role="status"><strong>数据缺口</strong><ul>{group.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div> : null}
  </article>;
}

/** Manual read only. Parent rulesVersion also invalidates late results after writes. */
export default function TradingAutoExposure({ onExpired, rulesVersion }: { onExpired: () => void; rulesVersion: string }) {
  const [result, setResult] = useState<AutoExposure | null>(null), [reading, setReading] = useState(false), [message, setMessage] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const mounted = useRef(false), controller = useRef<AbortController | null>(null), version = useRef(rulesVersion), expiry = useRef<ReturnType<typeof setTimeout> | null>(null), sessionExpired = useRef(onExpired);
  version.current = rulesVersion; sessionExpired.current = onExpired;
  const clear = useCallback((reason: string) => {
    controller.current?.abort(); controller.current = null;
    if (expiry.current !== null) clearTimeout(expiry.current);
    expiry.current = null; setResult(null); setReading(false); setMessage(reason);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const network = () => { setOnline(navigator.onLine); clear(navigator.onLine ? '网络已恢复，请手动刷新取得当前证据。' : '网络离线，已撤回旧敞口结果。'); };
    const wake = () => { if (!document.hidden) clear('页面已恢复，请手动刷新取得当前证据。'); };
    window.addEventListener('online', network); window.addEventListener('offline', network); document.addEventListener('visibilitychange', wake); window.addEventListener('pageshow', wake);
    return () => { mounted.current = false; controller.current?.abort(); if (expiry.current !== null) clearTimeout(expiry.current); window.removeEventListener('online', network); window.removeEventListener('offline', network); document.removeEventListener('visibilitychange', wake); window.removeEventListener('pageshow', wake); };
  }, [clear]);
  useEffect(() => { clear('规则或运行状态已变化，请手动刷新敞口。'); }, [rulesVersion, clear]);
  const load = async () => {
    if (controller.current || !navigator.onLine || !rulesVersion) return;
    clear('');
    const request = new AbortController(), requestedVersion = version.current, started = performance.now(); controller.current = request; setReading(true);
    try {
      const value = await api<AutoExposure>('/api/trading/execution/auto/exposure', { signal: request.signal, timeoutMs: 45_000 });
      if (!mounted.current || request.signal.aborted || requestedVersion !== version.current) return;
      if (value.rulesVersion !== version.current) { clear('规则版本已变化，请等待规则列表刷新后重试。'); return; }
      // Subtract the whole request duration: browser/server wall-clock skew must
      // never extend validity, including time spent receiving the response body.
      const remaining = Date.parse(value.expiresAt) - Date.parse(value.startedAt) - (performance.now() - started);
      if (!Number.isFinite(remaining) || remaining <= 0) { clear('本次读取的数据已过期，请重新刷新。'); return; }
      setResult(value); setMessage('');
      expiry.current = setTimeout(() => { if (mounted.current) clear('敞口证据已过期，请手动刷新；旧合计已撤回。'); }, Math.min(remaining, value.maxAgeMs));
    } catch (error) {
      if (!mounted.current || request.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) sessionExpired.current();
      else setMessage(error instanceof Error ? error.message : '敞口读取失败');
    } finally { if (controller.current === request) { controller.current = null; if (mounted.current) setReading(false); } }
  };
  const visible = result?.rulesVersion === rulesVersion ? result : null;
  return <section className="execution-help auto-exposure" aria-labelledby="auto-exposure-title">
    <header className="trading-panel-heading"><div><h3 id="auto-exposure-title">多规则合计敞口与共享合约</h3><p>手动读取 · 多空分别展示 · 不改变任何规则、委托或仓位</p></div><button className="button secondary" type="button" disabled={reading || !online || !rulesVersion} onClick={() => void load()}><RefreshCw size={15} className={reading ? 'spin' : ''} />{reading ? '读取中…' : '刷新敞口'}</button></header>
    {message ? <p role="status">{message}</p> : null}
    {!visible && !reading && !message ? <p>点击刷新，读取自动规则所用账户、合约和在途委托。</p> : null}
    {visible ? <><p>{visible.scope}</p><p>结果时间 {time(visible.generatedAt)}（北京时间） · {visible.complete ? '读取范围内证据完整' : '存在数据缺口，请逐项核对'}</p>{visible.groups.length ? visible.groups.map(group => <ExposureGroup key={group.id} group={group} />) : <p>暂无自动规则，没有需要汇总的合约。</p>}</> : null}
  </section>;
}
