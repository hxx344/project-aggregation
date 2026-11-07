import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDownToLine, LoaderCircle } from 'lucide-react';
import { api, ApiError } from './api';
import { ANTHROPIC_CONTRACTS, contractKey, findContract, sharesProblem } from './trading-anthropic';
import { amount, beijingTime } from './trading-format';
import type { AnthropicShares } from './trading-execution-types';
import type { AnthropicReductionConfig, AnthropicReductionState } from './trading-anthropic-reduction-types';

const BASE = '/api/trading/execution/anthropic-reduction';
const PHASES: Record<AnthropicReductionState['state']['phase'], string> = { disabled: '已停用', armed: '监测中', reducing: '减仓执行中', completed: '本轮完成 · 已自动停用', review: '已暂停 · 请核对' };
type Draft = {
  revision: number; enabled: boolean; contracts: [string, string]; shares: AnthropicShares;
  threshold: string; percent: string; batches: string; interval: string; timeout: string;
};
function draftOf(data: AnthropicReductionState, shares: AnthropicShares): Draft {
  const config = data.config;
  return { revision: data.revision, enabled: config?.enabled ?? false,
    contracts: config ? [contractKey(config.legs.find(leg => leg.side === 'long')!), contractKey(config.legs.find(leg => leg.side === 'short')!)] : ['hyperliquid:io:ANTH', 'hyperliquid:xyz:ANT'],
    shares: config?.shares ?? { ...shares }, threshold: config?.thresholdPercent ?? '5', percent: config?.reducePercent ?? '25',
    batches: String(config?.batchCount ?? 3), interval: String((config?.batchIntervalMs ?? 5000) / 1000), timeout: String((config?.timeoutMs ?? 600000) / 1000) };
}
function problem(form: Draft): string | null {
  const contracts = form.contracts.map(findContract);
  if (contracts.some(contract => !contract) || form.contracts[0] === form.contracts[1]) return '请选择两个不同的 Anthropic 合约。';
  if (contracts[0]!.exchange === contracts[1]!.exchange && contracts[0]!.exchange !== 'hyperliquid') return '同交易所仅支持 Hyperliquid io:ANTH 与 xyz:ANT。';
  const shareError = sharesProblem(form.shares);
  if (shareError) return shareError;
  if ([form.threshold, form.percent].some(value => value.trim().length > 48 || !/^\d+(?:\.\d{1,18})?$/.test(value.trim()) || Number(value) <= 0 || Number(value) > 100)) return '触发阈值和总减仓比例须大于 0 且不超过 100，最多 18 位小数。';
  if (!/^\d+$/.test(form.batches) || Number(form.batches) < 1 || Number(form.batches) > 200) return '批次数须为 1 至 200 的整数。';
  const interval = Math.round(Number(form.interval) * 1000), timeout = Math.round(Number(form.timeout) * 1000);
  if (!/^\d+(?:\.\d{1,3})?$/.test(form.interval) || !Number.isSafeInteger(interval) || interval < 0 || interval > 600000) return '批次间隔须为 0 至 600 秒，最多 3 位小数。';
  if (!/^\d+(?:\.\d{1,3})?$/.test(form.timeout) || !Number.isSafeInteger(timeout) || timeout < 30000 || timeout > 3600000) return '最长执行时间须为 30 至 3600 秒，最多 3 位小数。';
  if (timeout < (Number(form.batches) - 1) * interval + 30000) return '最长执行时间须覆盖全部批次间隔，并至少预留 30 秒执行。';
  return null;
}
function configOf(form: Draft): AnthropicReductionConfig {
  const [first, second] = form.contracts.map(key => findContract(key)!);
  return { enabled: form.enabled, legs: [{ exchange: first.exchange, symbol: first.symbol, side: 'long' }, { exchange: second.exchange, symbol: second.symbol, side: 'short' }],
    shares: { outstanding: form.shares.outstanding.trim(), diluted: form.shares.diluted.trim() }, thresholdPercent: form.threshold.trim(), reducePercent: form.percent.trim(),
    batchCount: Number(form.batches), batchIntervalMs: Math.round(Number(form.interval) * 1000), timeoutMs: Math.round(Number(form.timeout) * 1000) };
}
const sameShares = (first: AnthropicShares, second: AnthropicShares) => first.outstanding === second.outstanding && first.diluted === second.diluted;
const contractLabel = (leg: { exchange: string; symbol: string }) => findContract(`${leg.exchange}:${leg.symbol}`)?.label ?? `${leg.exchange} ${leg.symbol}`;

export default function TradingAnthropicReduction({ shares, onExpired }: { shares: AnthropicShares; onExpired: () => void }) {
  const [data, setData] = useState<AnthropicReductionState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [readError, setReadError] = useState<string | null>(null), [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState<'save' | 'disable' | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const mounted = useRef(false), reading = useRef<AbortController | null>(null), generation = useRef(0), writing = useRef(false), lastRead = useRef(0), expires = useRef(onExpired);
  expires.current = onExpired;
  const load = useCallback(async () => {
    if (reading.current || writing.current || !navigator.onLine) return;
    const controller = new AbortController(), version = generation.current;
    reading.current = controller; lastRead.current = Date.now();
    try {
      const value = await api<AnthropicReductionState>(BASE, { signal: controller.signal, timeoutMs: 12000 });
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      setData(current => !current || value.revision >= current.revision ? value : current); setReadError(null);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setReadError(failure instanceof Error ? failure.message : '自动减仓状态读取失败');
    } finally { if (reading.current === controller) reading.current = null; }
  }, []);
  useEffect(() => {
    mounted.current = true; void load();
    const timer = setInterval(() => { if (!document.hidden || Date.now() - lastRead.current >= 60000) void load(); }, 5000);
    const wake = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    return () => { mounted.current = false; generation.current++; clearInterval(timer); reading.current?.abort(); reading.current = null; document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [load]);

  const form = data ? draft ?? draftOf(data, shares) : null;
  const changed = !!form && (!data?.config || !!draft && JSON.stringify(form) !== JSON.stringify(draftOf(data!, shares)));
  const validation = form ? problem(form) : null;
  const executing = data?.state.phase === 'reducing' || !!data?.job && !['completed', 'stopped'].includes(data.job.status);
  const connectionStamp = JSON.stringify(data?.connections.map(connection => [connection.exchange, connection.revision, connection.connected, connection.locked]));
  const confirmStamp = JSON.stringify([form, connectionStamp, data?.revision]);
  const confirmedLive = confirmed === confirmStamp;
  const connectionsReady = !!form && form.contracts.every(key => data?.connections.some(connection => connection.exchange === findContract(key)?.exchange && connection.connected && !connection.locked));
  function edit(patch: Partial<Draft>) {
    if (!form) return;
    setDraft({ ...form, ...patch }); setConfirmed(null); setNotice(null);
  }
  async function write(kind: 'save' | 'disable', event?: FormEvent) {
    event?.preventDefault();
    if (!data || !form || writing.current) return;
    if (kind === 'save' && (validation || executing || form.enabled && (!confirmedLive || !connectionsReady || data.maintenance || readError))) { setWriteError(validation ?? '请先核对实盘连接、执行状态并确认启用。'); return; }
    writing.current = true; generation.current++; reading.current?.abort(); reading.current = null;
    setBusy(kind); setWriteError(null); setNotice(null);
    try {
      const value = await api<AnthropicReductionState>(kind === 'save' ? BASE : `${BASE}/disable`, { method: kind === 'save' ? 'PUT' : 'POST',
        body: JSON.stringify(kind === 'save' ? { revision: form.revision, config: configOf(form), confirmLive: form.enabled && confirmedLive } : { revision: data.revision }), timeoutMs: 20000 });
      if (!mounted.current) return;
      setData(value); setDraft(null); setReadError(null);
      setNotice(kind === 'disable' ? '已停用新触发；在途批次不会撤销，请到「价差下单」查看或停止执行。' : value.config?.enabled ? '自动减仓已启用；达到条件后会发送实盘市价减仓委托。' : '自动减仓设置已保存，当前未启用。');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setWriteError(failure instanceof Error ? failure.message : '自动减仓操作失败');
    } finally {
      generation.current++; writing.current = false;
      if (mounted.current) { setBusy(null); setConfirmed(null); void load(); }
    }
  }

  return <section className="trading-anthropic-alerts trading-anthropic-reduction" aria-labelledby="anthropic-reduction-title">
    <h3 id="anthropic-reduction-title"><ArrowDownToLine size={16} />ANT 自动多批减仓</h3>
    <p>任一指定腿距强平 ≤ 阈值时，对两条腿同时市价减仓。第一批下单前再次核对风险；本轮完成后自动停用，需要手动再次启用。</p>
    {!data || !form ? <div role="status">{readError ?? '正在读取自动减仓设置…'}{readError ? <button className="button secondary" type="button" onClick={() => void load()}>重新读取</button> : <LoaderCircle size={16} className="spin" />}</div> : <>
      <p className="trading-anthropic-reduction-status" role="status"><strong>{PHASES[data.state.phase]}</strong> · 新触发{data.config?.enabled ? '已启用' : '已关闭'}{data.state.triggeredAt ? ` · 触发于 ${beijingTime(data.state.triggeredAt)}（北京时间）` : ''}</p>
      {data.state.reason ? <p className="trading-warning" role="alert">{data.state.reason}</p> : null}
      {data.maintenance ? <p className="trading-warning">当前处于维护状态，不能启用新触发。</p> : null}
      {executing ? <p className="trading-muted">当前减仓任务尚未结束；请先在「价差下单」核对执行，之后再修改规则。</p> : null}
      {data.live?.warning ? <p className="trading-warning" role="alert">{data.live.warning}</p> : null}
      {data.live ? <div className="trading-anthropic-reduction-live"><p>最近风险检查：{beijingTime(data.live.checkedAt)}（北京时间） · {data.live.met ? '已达到触发阈值' : '未达到触发阈值'}</p><ul>{data.live.legs.map(leg => <li key={`${leg.exchange}:${leg.symbol}:${leg.side}`}>{contractLabel(leg)} · {leg.side === 'long' ? '多头' : '空头'} · 持仓 {amount(leg.quantity)} 原生单位 · 距强平 {leg.distancePercent === null ? '未提供' : `${leg.distancePercent}%`}</li>)}</ul></div> : <p className="trading-muted">尚无自动减仓风险检查结果。两腿都需要有效、新鲜的强平价；缺少任一腿的数据时，不会自动发送委托。</p>}
      {data.job ? <div className="trading-anthropic-reduction-progress" aria-label="自动减仓执行进度"><strong>执行进度 · 第 {Math.min(data.job.batchIndex + 1, data.job.batchCount)} / {data.job.batchCount} 批</strong><ul>{data.job.legs.map(leg => <li key={leg.id}>{contractLabel(leg)} · {leg.side === 'long' ? '多头' : '空头'} · 已成交 {amount(leg.filledQuantity)} / 目标 {amount(leg.quantity)} · 剩余 {amount(leg.remainingQuantity)} 原生单位</li>)}</ul><p>执行编号：{data.job.id}</p></div> : null}
      <form onSubmit={event => void write('save', event)} aria-label="ANT 自动减仓设置">
        <fieldset className="trading-anthropic-reduction-fields" disabled={!!busy || executing}>
          {([0, 1] as const).map(index => <label key={index}>{index === 0 ? '减仓多头合约' : '减仓空头合约'}<select value={form.contracts[index]} onChange={event => { const contracts: [string, string] = [...form.contracts]; contracts[index] = event.target.value; edit({ contracts }); }}>{ANTHROPIC_CONTRACTS.map(contract => <option key={contractKey(contract)} value={contractKey(contract)} disabled={contractKey(contract) === form.contracts[1 - index]}>{contract.label}</option>)}</select></label>)}
          <label>触发阈值（距强平 %）<input type="text" inputMode="decimal" maxLength={48} value={form.threshold} onChange={event => edit({ threshold: event.target.value })} /></label>
          <label>总减仓比例（%）<input type="text" inputMode="decimal" maxLength={48} value={form.percent} onChange={event => edit({ percent: event.target.value })} /></label>
          <label>减仓批次数<input type="number" min={1} max={200} step={1} value={form.batches} onChange={event => edit({ batches: event.target.value })} /></label>
          <label>减仓批次间隔（秒）<input type="number" min={0} max={600} step="0.001" value={form.interval} onChange={event => edit({ interval: event.target.value })} /></label>
          <label>最长执行时间（秒）<input type="number" min={30} max={3600} step="0.001" value={form.timeout} onChange={event => edit({ timeout: event.target.value })} /></label>
          <label className="trading-anthropic-reduction-toggle"><input type="checkbox" checked={form.enabled} onChange={event => edit({ enabled: event.target.checked })} />启用自动减仓</label>
        </fieldset>
        <p className="trading-anthropic-rule">每条腿以触发时各自的持仓总量 × 总减仓比例作为本轮目标，再拆成指定批数；按原生单位精度向下取整，数量不足以拆分全部批次时拒绝执行。受单笔数量上限影响，实际批数可能增加，以执行进度为准。异常会停止后续批次，请在「价差下单 → 执行进度」核对已成交数量。</p>
        <p>本规则股数快照：流通 {form.shares.outstanding}B · 完全稀释 {form.shares.diluted}B。页面股数变化不会修改已保存规则。</p>
        {!sameShares(form.shares, shares) ? <p>当前页面为 {shares.outstanding}B / {shares.diluted}B。<button className="button secondary" type="button" disabled={!!busy || executing} onClick={() => edit({ shares: { ...shares } })}>使用当前页面股数</button></p> : null}
        {draft && draft.revision !== data.revision ? <p className="trading-warning" role="alert">服务器规则已变化，当前草稿仍保留；请放弃草稿并读取当前规则后重新编辑。</p> : null}
        {form.enabled ? <><p className={connectionsReady ? 'trading-muted' : 'trading-warning'}>{connectionsReady ? '两条腿的实盘账户已连接。' : '所选腿需要可用的实盘账户连接；请到「价差下单」连接或核对占用任务。'}</p><label className="trading-anthropic-reduction-toggle"><input type="checkbox" checked={confirmedLive} disabled={!!busy || executing} onChange={event => setConfirmed(event.target.checked ? confirmStamp : null)} />我确认启用后按本规则自动发送双边实盘市价减仓委托</label></> : null}
        {validation ? <p className="trading-warning" role="alert">{validation}</p> : null}
        <div className="trading-anthropic-robot-actions"><button className="button primary" type="submit" disabled={!!busy || executing || !changed || !!validation || !!draft && draft.revision !== data.revision || form.enabled && (!confirmedLive || !connectionsReady || data.maintenance || !!readError)}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : null}{form.enabled ? '保存并启用自动减仓' : '保存减仓设置'}</button>
          {draft ? <button className="button secondary" type="button" disabled={!!busy} onClick={() => { setDraft(null); setConfirmed(null); setNotice(null); void load(); }}>放弃草稿并读取当前规则</button> : null}
          <button className="button secondary" type="button" disabled={!!busy || !data.config?.enabled} onClick={() => void write('disable')}>{busy === 'disable' ? <LoaderCircle size={15} className="spin" /> : null}停用新触发</button>
          <a className="button secondary" href="?view=trading&tradingSection=trade">到价差下单核对执行</a></div>
      </form>
      <p className="trading-anthropic-rule">停用只停止新触发，不撤销在途批次。停止当前任务请使用「价差下单」中的“停止并撤销余单”；已经成交的仓位保留。</p>
      {readError ? <p className="trading-warning" role="alert">{readError} · 当前显示上次读取结果，启用前需重新读取成功。</p> : null}
      {writeError ? <p className="trading-warning" role="alert">{writeError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {data.state.events.length ? <details className="trading-anthropic-history"><summary>自动减仓记录</summary><ul>{data.state.events.slice(-10).reverse().map((entry, index) => <li key={`${entry.time}-${index}`}><time dateTime={entry.time}>{beijingTime(entry.time)}</time> · {entry.message}</li>)}</ul></details> : null}
    </>}
  </section>;
}
