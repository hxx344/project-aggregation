import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CircleAlert, Droplets, KeyRound, LoaderCircle, Play, RefreshCw, Save, Square, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import type { AeroLpConfig, AeroLpCycle, AeroLpEvent, AeroLpLedger, AeroLpPosition, AeroLpSnapshot } from './aero-lp-types';
import './aero-lp.css';

const ROOT = '/api/automation/aero-lp';
const stateLabels = { starting: '正在启动', running: '运行中', stopping: '正在停止', stopped: '已停止', fault: '异常' };
const phaseLabels: Record<string, string> = { connecting: '正在连接链上合约', cycle: '正在检查区间', executing: '正在发送交易', sleeping: '等待下一轮' };
const eventLabels: Record<string, string> = {
  start: '已连接', stop: '已停止', cycle_error: '本轮出错', skip: '跳过执行', tx_signed: '交易已签名', tx_confirmed: '交易已确认',
  close_quote: '撤出报价', minted: '已开仓', mint_skipped: '未开仓', stake_failed: '质押失败', ledger_error: '记账失败',
};
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const prices = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 6 });
function time(value: string | number | null | undefined) { const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? dates.format(ms) : '—'; }
function price(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? prices.format(value) : '—'; }
const amountFormats = [{ maximumSignificantDigits: 4 }, { maximumFractionDigits: 4 }, { maximumFractionDigits: 2 }].map(options => new Intl.NumberFormat('zh-CN', options));
const percents = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });
// Wallet and position amounts: fewer decimals as the magnitude grows; dust shows as a bound, not 18 digits.
function amount(value: string | number | null | undefined) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const size = Math.abs(n);
  if (size < 0.000001) return n < 0 ? '>-0.000001' : '<0.000001';
  return amountFormats[size >= 1000 ? 2 : size >= 1 ? 1 : 0].format(n);
}
function percent(value: number | null | undefined) { return typeof value === 'number' && Number.isFinite(value) ? percents.format(value) : '—'; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : '请求失败，请重试。'; }
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// Where the current price sits relative to a range, on a log-price axis padded around both.
// The child's tick-based state is the pool's own test and wins; price comparison is the fallback for older cycles.
function spot(range: [number, number], current: number, given?: 'below' | 'in' | 'above') {
  const [lower, upper] = range;
  const state = given ?? (current < lower ? 'below' : current >= upper ? 'above' : 'in');
  const gap = (v: number) => (v >= 0.00005 ? percent(v) : '<0.01%');
  const text = state === 'below' ? `低于下沿 ${gap(lower / current - 1)}` : state === 'above' ? `高于上沿 ${gap(current / upper - 1)}`
    : `区间内 ${percent(Math.min(Math.max((current - lower) / (upper - lower), 0), 1))}`;
  const lo = Math.log(Math.min(lower, current)), hi = Math.log(Math.max(upper, current)), pad = (hi - lo) * 0.06 || 0.01;
  const at = (v: number) => ((Math.log(v) - lo + pad) / (hi - lo + pad * 2)) * 100;
  return { state, text, left: at(lower), width: at(upper) - at(lower), marker: at(current) };
}
function RangeSpot({ range, current, state }: { range: [number, number]; current: number; state?: 'below' | 'in' | 'above' }) {
  if (!(current > 0 && range[0] > 0 && range[1] > 0)) return <>—</>;
  const s = spot(range, current, state);
  return <div className={`lp-spot ${s.state}`}><span className="lp-spot-bar" aria-hidden="true"><span className="lp-spot-range" style={{ left: `${s.left}%`, width: `${s.width}%` }} /><span className="lp-spot-marker" style={{ left: `${s.marker}%` }} /></span><span>{s.text}</span></div>;
}
// The headline position: the first live one, staked first.
function mainPosition(cycle: AeroLpCycle | null | undefined): AeroLpPosition | undefined {
  const live = cycle?.positions.filter(p => p.liquidity !== '0') ?? [];
  return live.find(p => p.staked) ?? live[0];
}
function aprFact(cycle: AeroLpCycle | null | undefined, quote: string) {
  const rewards = cycle?.rewards;
  const pool = typeof rewards?.poolPerDay === 'number' ? `池子排放 ${amount(rewards.poolPerDay)} AERO/天` : null;
  const priced = typeof rewards?.price === 'number' ? `AERO ${price(rewards.price)} ${quote}` : null;
  const p = mainPosition(cycle);
  if (!cycle) return { value: '—', hint: '尚未完成检查' };
  if (!rewards) return { value: '—', hint: cycle.rewardsError ? '奖励数据读取失败，下一轮重试' : '奖励数据暂不可用' };
  if (!p) return { value: '—', hint: [pool, '暂无头寸'].filter(Boolean).join(' · ') };
  if (!p.staked) return { value: '—', hint: '头寸未质押，不分 AERO 排放' };
  if (typeof p.apr !== 'number') return { value: '—', hint: rewards.poolPerDay === null ? '需要两轮检查测出排放速率' : priced ? '头寸价值无法估算' : 'AERO 报价不可用' };
  const basis = p.apr === 0 ? '价格高于上沿，不分排放' : p.aprEstimated ? '价格低于区间：按刚进入下沿时估算' : '区间内实时';
  return { value: percent(p.apr), hint: [basis, priced, pool].filter(Boolean).join(' · ') };
}
function rewardFact(cycle: AeroLpCycle | null | undefined, ledger: AeroLpLedger | null, quote: string) {
  const rewards = cycle?.rewards;
  const parts: string[] = [];
  if (rewards && Number(rewards.deferred) > 0) parts.push(`延后发放 ${amount(rewards.deferred)}`);
  if (ledger) parts.push(`累计到账 ${amount(ledger.reward)}`);
  if (rewards && typeof rewards.price === 'number') parts.push(`≈ ${amount(Number(rewards.pending) * rewards.price)} ${quote}`);
  return { value: rewards ? `待领取 ${amount(rewards.pending)}` : '—', hint: parts.join(' · ') || undefined };
}
function gasFact(ledger: AeroLpLedger | null) {
  if (!ledger) return { value: '—', hint: '交易账本暂不可用' };
  const failed = ledger.failed ? `，${ledger.failed} 笔回滚或未上链` : '';
  return { value: `${amount(ledger.gasEth)} ETH`, hint: `${ledger.txs} 笔交易${failed}${ledger.since ? ` · 自 ${time(ledger.since)}` : ''}` };
}

type Field = { key: keyof AeroLpConfig; label: string; kind: 'text' | 'integer' | 'number'; hint?: string; wide?: boolean };
const strategyFields: Field[] = [
  { key: 'upperPrice', label: '固定上沿价格（USDC）', kind: 'number', hint: '按最近的可用格点取整' },
  { key: 'gapBps', label: '下沿高于现价（bps）', kind: 'integer', hint: '40 = 0.4%，再向上取到格点' },
  { key: 'intervalSec', label: '检查间隔（秒）', kind: 'integer', hint: '60–86400' },
  { key: 'minDeploy', label: '最小开仓数量（代币）', kind: 'text', hint: '可投入余额低于此值不开仓' },
  { key: 'keepInWallet', label: '钱包保留数量（代币）', kind: 'text', hint: '这部分不投入' },
  { key: 'minEthForGas', label: '最低 ETH 余额', kind: 'text', hint: '低于此值只记日志，不发交易' },
];
const guardFields: Field[] = [
  { key: 'twapSec', label: 'TWAP 窗口（秒）', kind: 'integer', hint: '0 关闭保护，最大 3600' },
  { key: 'maxTwapDeviationBps', label: '低于 TWAP 暂缓阈值（bps）', kind: 'integer', hint: '1–5000' },
  { key: 'slippageBps', label: '滑点保护（bps）', kind: 'integer', hint: '1–500' },
];
const connectionFields: Field[] = [
  { key: 'rpcUrl', label: 'Base RPC（https）', kind: 'text', wide: true },
  { key: 'pool', label: '池子地址', kind: 'text', wide: true },
  { key: 'token', label: '投入代币（token0）', kind: 'text', wide: true },
  { key: 'factory', label: '池工厂', kind: 'text', wide: true },
  { key: 'nft', label: '头寸 NFT 合约', kind: 'text', wide: true },
];
const allFields = [...strategyFields, ...guardFields, ...connectionFields];
type Draft = Record<keyof AeroLpConfig, string>;
const draftOf = (config: AeroLpConfig) => Object.fromEntries(allFields.map(f => [f.key, String(config[f.key])])) as Draft;
function configOf(draft: Draft): AeroLpConfig {
  const value: Record<string, string | number> = {};
  for (const f of allFields) {
    const raw = draft[f.key].trim();
    if (f.kind === 'text') { value[f.key] = raw; continue; }
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) throw new Error(`${f.label}须为${f.kind === 'integer' ? '整数' : '数字'}。`);
    value[f.key] = n;
  }
  return value as AeroLpConfig;
}

function Input({ field, draft, onChange }: { field: Field; draft: Draft; onChange: (key: keyof AeroLpConfig, value: string) => void }) {
  return <label className={`lp-field ${field.wide ? 'wide' : ''}`}><span>{field.label}</span><input value={draft[field.key]} inputMode={field.kind === 'text' ? undefined : 'decimal'} spellCheck={false} autoComplete="off" onChange={e => onChange(field.key, e.target.value)} />{field.hint ? <small>{field.hint}</small> : null}</label>;
}
function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}{hint ? <small>{hint}</small> : null}</dd></div>;
}
function eventDetail(entry: AeroLpEvent) {
  const parts: ReactNode[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'at' || key === 'event' || value === null || value === undefined) continue;
    if (key === 'hash' && typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) parts.push(<a key={key} href={`https://basescan.org/tx/${value}`} target="_blank" rel="noreferrer">{short(value)}</a>);
    else parts.push(<span key={key}>{key}={typeof value === 'string' ? value : JSON.stringify(value)}</span>);
  }
  return parts;
}

export default function AeroLpPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<AeroLpSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const dirtyRef = useRef(false), busyRef = useRef(''), lifetime = useRef<AbortController | null>(null), generation = useRef(0);
  const accept = useCallback((data: AeroLpSnapshot, replaceDraft: boolean) => {
    setSnapshot(data); setLoadError('');
    if (!dirtyRef.current || replaceDraft) { setDraft(draftOf(data.config)); dirtyRef.current = false; setDirty(false); }
  }, []);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || document.hidden) return;
    const version = ++generation.current;
    setLoading(true);
    try { const data = await api<AeroLpSnapshot>(ROOT, { signal, timeoutMs: 10_000 }); if (!signal.aborted && version === generation.current) accept(data, false); }
    catch (reason) { if (signal.aborted || version !== generation.current) return; if (reason instanceof ApiError && reason.status === 401) onExpired(); else setLoadError(message(reason)); }
    finally { if (!signal.aborted && version === generation.current) setLoading(false); }
  }, [accept, onExpired]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void read();
    const poll = setInterval(() => { if (!busyRef.current) void read(); }, 5000);
    const visibility = () => { if (!document.hidden && !busyRef.current) void read(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearInterval(poll); document.removeEventListener('visibilitychange', visibility); };
  }, [read]);
  const execute = async (action: 'start' | 'stop' | 'save' | 'key' | 'clear', body: unknown, done: string) => {
    const signal = lifetime.current?.signal;
    if (busyRef.current || !signal || signal.aborted) return;
    busyRef.current = action; setBusy(action); setActionError(''); setNotice('');
    generation.current++; setLoading(false);
    const target = action === 'save' ? [`${ROOT}/config`, 'PUT'] : action === 'key' ? [`${ROOT}/wallet`, 'PUT'] : action === 'clear' ? [`${ROOT}/wallet/clear`, 'POST'] : [`${ROOT}/${action}`, 'POST'];
    try {
      const data = await api<AeroLpSnapshot>(target[0], { method: target[1], body: JSON.stringify(body), signal, timeoutMs: 20_000 });
      if (!signal.aborted) { accept(data, action === 'save'); setNotice(done); if (action === 'key') setPrivateKey(''); }
    } catch (reason) { if (!signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setActionError(message(reason)); } }
    finally { busyRef.current = ''; if (!signal.aborted) { setBusy(''); void read(); } }
  };
  const change = (key: keyof AeroLpConfig, value: string) => { if (!draft) return; setDraft({ ...draft, [key]: value }); dirtyRef.current = true; setDirty(true); setNotice(''); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    let config: AeroLpConfig;
    try { config = configOf(draft); } catch (reason) { setActionError(message(reason)); return; }
    void execute('save', { config }, snapshot?.state === 'running' || snapshot?.state === 'starting' ? '参数已保存，已立即按新参数开始一轮检查。' : '参数已保存，启动后生效。');
  };
  const saveKey = (event: FormEvent) => { event.preventDefault(); void execute('key', { privateKey: privateKey.trim() }, '私钥已加密保存。'); };
  const clearKey = () => { if (window.confirm('清除已保存的私钥？清除后需要重新填写才能启动。')) void execute('clear', {}, '私钥已清除。'); };
  const restoreDefaults = () => { if (!snapshot) return; setDraft(draftOf(snapshot.defaults)); dirtyRef.current = true; setDirty(true); setNotice(''); };

  const cycle = snapshot?.lastCycle;
  const idle = snapshot?.state === 'stopped' || snapshot?.state === 'fault';
  const symbols = cycle ? Object.keys(cycle.wallet) : [];
  const [symbol0, symbol1] = cycle?.symbols ?? [symbols[0] ?? '代币', 'USDC'];
  const apr = aprFact(cycle, symbol1), reward = rewardFact(cycle, snapshot?.ledger ?? null, symbol1), gas = gasFact(snapshot?.ledger ?? null);
  return <div className="lp-page">
    <header className="lp-heading"><div><h1>Aero LP 单边调仓</h1><p>Aerodrome Slipstream（Base）· 价格跌出区间时把下沿移到现价上方，上沿固定</p></div><div className="lp-toolbar">
      <button className="button secondary" onClick={() => void read()} disabled={!!busy || loading} aria-label="刷新状态"><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>
      {idle ? <button className="button primary" disabled={!snapshot || !!busy || !snapshot.wallet || dirty} title={dirty ? '请先保存参数' : !snapshot?.wallet ? '请先填写私钥' : undefined} onClick={() => void execute('start', {}, '已请求启动。')}>{busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}启动</button>
        : <button className="button secondary" disabled={!snapshot || !!busy || snapshot.state === 'stopping'} onClick={() => void execute('stop', {}, '已请求停止；正在执行的交易最多再等 90 秒，超时强制结束，下次启动按链上状态继续。')}>{busy === 'stop' || snapshot?.state === 'stopping' ? <LoaderCircle size={15} className="spin" /> : <Square size={15} />}停止</button>}
    </div></header>
    {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    {notice ? <div className="lp-callout success" role="status">{notice}</div> : null}
    {loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>状态读取失败：{loadError}。保留最后读取的数据，稍后自动重试。</span></div> : null}
    {!snapshot || !draft ? <section className="panel lp-empty" role="status">{loading ? <LoaderCircle className="spin" /> : <CircleAlert />}<strong>{loading ? '正在读取状态' : '暂未取得状态'}</strong></section> : <>
      <section className="panel lp-status" aria-label="运行状态">
        <div className="lp-state-line"><span className={`lp-state ${snapshot.state}`}><Droplets size={16} />{stateLabels[snapshot.state]}</span>
          {snapshot.phase ? <span>{phaseLabels[snapshot.phase.name] || snapshot.phase.name}{snapshot.phase.name === 'sleeping' && snapshot.phase.nextAt ? `，下一轮 ${time(snapshot.phase.nextAt)}` : ''}</span> : null}
          {snapshot.paused ? <span className="lp-paused">工作台更新维护中：只检查不发交易</span> : null}
          {snapshot.error ? <p className="lp-error">{snapshot.error}</p> : null}</div>
        <dl className="lp-facts">
          <Fact label="现价（USDC）" hint={cycle ? `区块 ${cycle.block} · ${time(cycle.at)}` : '尚未完成检查'}>{price(cycle?.price)}</Fact>
          <Fact label="TWAP" hint={cycle?.twapError ? 'TWAP 读取失败，本轮暂缓调仓' : `${snapshot.config.twapSec} 秒窗口`}>{price(cycle?.twapPrice)}</Fact>
          <Fact label="目标区间" hint={cycle && !cycle.target ? '价格已到上沿或以上' : undefined}>{cycle?.target ? `${price(cycle.target[0])} – ${price(cycle.target[1])}` : '—'}</Fact>
          <Fact label="钱包余额" hint={snapshot.wallet ? short(snapshot.wallet) : '未设置私钥'}>{symbols.length ? symbols.map(s => <span className="lp-balance" key={s}>{s} {amount(cycle!.wallet[s])}</span>) : '—'}</Fact>
          <Fact label="AERO 年化" hint={apr.hint}>{apr.value}</Fact>
          <Fact label="AERO 奖励" hint={reward.hint}>{reward.value}</Fact>
          <Fact label="累计 Gas" hint={gas.hint}>{gas.value}</Fact>
        </dl>
        <div className="lp-table-scroll"><table className="lp-table"><caption className="visually-hidden">本钱包在池中的头寸</caption><thead><tr><th>头寸</th><th>区间（USDC）</th><th>现价位置</th><th>持有</th><th>价值（USDC）</th><th>AERO 年化</th><th>质押</th></tr></thead><tbody>
          {cycle?.positions.length ? cycle.positions.map(p => <tr key={p.id}><th scope="row">#{p.id}</th><td>{price(p.range[0])} – {price(p.range[1])}</td><td><RangeSpot range={p.range} current={cycle.price} state={p.state} /></td>
            <td>{typeof p.amount0 === 'number' ? <>{amount(p.amount0)} {symbol0}{p.amount1 ? <><br />{amount(p.amount1)} {symbol1}</> : null}</> : '—'}</td><td>{amount(p.value)}</td>
            <td>{typeof p.apr === 'number' ? `${percent(p.apr)}${p.aprEstimated ? '（估）' : ''}` : '—'}</td><td>{p.staked ? '已质押' : '未质押'}</td></tr>)
            : <tr><td colSpan={7} className="lp-table-empty">{cycle ? '本池暂无头寸' : '等待第一轮检查'}</td></tr>}
        </tbody></table></div>
        {cycle ? <p className="lp-plan"><span>本轮动作：{cycle.actions.length ? cycle.actions.join('、') : '无'}</span>{cycle.notes.map(note => <span key={note}>{note}</span>)}</p> : null}
      </section>
      <section className="panel lp-section" aria-label="钱包私钥"><div className="panel-heading"><h2>钱包私钥</h2><span className="muted">{snapshot.wallet ? `当前地址 ${snapshot.wallet}` : '尚未设置'}</span></div>
        <form className="lp-key" onSubmit={saveKey} autoComplete="off">
          <label className="lp-field wide"><span>{snapshot.wallet ? '更换私钥' : '私钥'}</span><input type="password" value={privateKey} onChange={e => setPrivateKey(e.target.value)} placeholder="0x 开头的 64 位十六进制" autoComplete="new-password" spellCheck={false} disabled={!idle || !!busy} /><small>只写入不回显：服务器用工作台凭据密钥加密保存，页面只显示地址。建议使用只放本策略资金的专用钱包。{idle ? '' : '停止后才能更换或清除。'}</small></label>
          <div className="lp-key-actions"><button className="button primary" type="submit" disabled={!idle || !!busy || !privateKey.trim()}>{busy === 'key' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}保存私钥</button>{snapshot.wallet ? <button className="button secondary" type="button" disabled={!idle || !!busy} onClick={clearKey}><Trash2 size={15} />清除私钥</button> : null}</div>
        </form>
      </section>
      <form className="panel lp-section" onSubmit={save} noValidate aria-label="调仓参数"><div className="panel-heading"><h2>调仓参数</h2><span className="muted">保存后立即生效：运行中会马上按新参数检查一轮；连接参数变化时自动重连</span></div>
        <fieldset disabled={!!busy}>
          <h3>策略</h3><div className="lp-grid">{strategyFields.map(f => <Input key={f.key} field={f} draft={draft} onChange={change} />)}</div>
          <h3>保护</h3><div className="lp-grid">{guardFields.map(f => <Input key={f.key} field={f} draft={draft} onChange={change} />)}</div>
          <details className="lp-advanced"><summary>链与合约地址</summary><p>启动和每次修改后都会核对 chainId 8453、池子工厂、gauge 与投入代币是否匹配，不匹配时本轮不执行。</p><div className="lp-grid">{connectionFields.map(f => <Input key={f.key} field={f} draft={draft} onChange={change} />)}</div></details>
        </fieldset>
        <div className="lp-form-actions"><span>{dirty ? '有未保存的修改' : '参数已同步'}</span><div><button type="button" className="button secondary" disabled={!!busy} onClick={restoreDefaults}>填入默认值</button><button type="button" className="button secondary" disabled={!dirty || !!busy} onClick={() => { setDraft(draftOf(snapshot.config)); dirtyRef.current = false; setDirty(false); }}>放弃修改</button><button className="button primary" type="submit" disabled={!dirty || !!busy}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存参数</button></div></div>
      </form>
      <section className="panel lp-section" aria-label="最近事件"><div className="panel-heading"><h2>最近事件</h2><span className="muted">最多 50 条，完整记录在数据目录 aero-lp/events.jsonl</span></div>
        {snapshot.events.length ? <ol className="lp-events">{[...snapshot.events].reverse().map((entry, i) => <li key={`${entry.at}:${i}`} className={entry.event === 'cycle_error' || entry.event === 'stake_failed' ? 'bad' : ''}><time>{time(entry.at)}</time><strong>{eventLabels[entry.event] || entry.event}</strong><span className="lp-event-detail">{eventDetail(entry)}</span></li>)}</ol>
          : <p className="lp-table-empty">工作台本次启动后尚无事件。</p>}
      </section>
    </>}
  </div>;
}
