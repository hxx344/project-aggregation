import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, Play, Square } from 'lucide-react';
import { api, ApiError } from './api';
import { beijingTime } from './trading-format';
import './contract-probes.css';

const ROOT = '/api/system/contract-probes';
type Probe = 'bybit' | 'aster';
type Run = {
  id: string; probe: Probe; mode: 'read-only' | 'live'; params: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed' | 'not-sent' | 'needs-check' | 'interrupted';
  startedAt: string; endedAt: string | null; exitCode: number | null; phrase: string | null; outcome: string | null; error: string | null;
  stopRequestedAt: string | null; forced: boolean; usedForLive: boolean; hasReport: boolean; log?: string[];
};
type State = {
  observedAt: string; running: string | null; maintenance: boolean; liveWindowMs: number;
  options: { bybit: { symbols: string[] }; aster: { prefixes: string[] } }; liveBlocked: Record<Probe, string | null>; runs: Run[];
};
const NAMES: Record<Probe, string> = { bybit: 'Bybit 原生追价', aster: 'ASTER 子账户划转' };
const NONCE_PRESET = '-30,-59,-61,-90,-121,61';

function verdict(run: Run) {
  if (run.status === 'running') return run.stopRequestedAt ? '已请求停止，正在收尾' : run.mode === 'live' ? '真实运行中' : '只读检查中';
  if (run.status === 'completed') return run.mode === 'live' ? '真实运行完成，收尾正常' : '只读检查通过，未发送任何写请求';
  if (run.status === 'failed') return '只读检查未通过，未发送任何写请求';
  if (run.status === 'not-sent') return '真实运行未发出任何写请求';
  if (run.status === 'needs-check') return '已发送过真实请求且未确认收尾正常：请到交易所核对';
  return run.mode === 'live' ? '运行环境重启时被中断：请到交易所核对' : '运行环境重启时被中断，未发送任何写请求';
}
const tone = (run: Run) => run.status === 'completed' ? 'ok' : run.status === 'running' ? 'busy' : run.status === 'needs-check' || run.status === 'interrupted' && run.mode === 'live' ? 'bad' : 'warn';
function summary(run: Run) {
  const p = run.params;
  if (run.probe === 'bybit') return `${p.symbol} · 名义金额上限 ${p.maxNotional} USDT · 被动价距 ${p.passiveBps} bps · 结清等待 ${p.settleTimeoutS} 秒 · ${p.allowFill ? '含成交与平仓测试' : '只测不成交的追价'}`;
  const offsets = Array.isArray(p.probeNonce) ? p.probeNonce : [];
  return `主账户 ${p.masterPrefix} · A ${p.aPrefix} ⇄ B ${p.bPrefix} · 每笔 ${p.amount} USD1 · ${offsets.length ? `nonce 偏移 ${offsets.join('、')} 秒` : '不探测 nonce'} · 入账等待 ${p.settleTimeoutS} 秒${p.balancerPaused ? ' · 已声明暂停保证金平衡' : ''}`;
}

function RunPanel({ run, state, busy, onLive, onStop, onDownload }: { run: Run; state: State; busy: boolean; onLive: (run: Run) => void; onStop: (run: Run, force: boolean) => void; onDownload: (run: Run) => void }) {
  const [confirmed, setConfirmed] = useState(false), [exclusive, setExclusive] = useState(false);
  const expired = !!run.endedAt && Date.parse(state.observedAt) - Date.parse(run.endedAt) > state.liveWindowMs;
  const offer = run.mode === 'read-only' && run.status === 'completed' && !!run.phrase && !run.usedForLive;
  const blocked = state.maintenance ? '系统正在更新或等待确认更新结果。' : state.liveBlocked[run.probe] ?? (state.running ? '已有一项测试在运行。' : expired ? `只读检查已超过 ${state.liveWindowMs / 60000} 分钟，请重新检查。` : null);
  // A confirmation given for one check, or before the run became blocked, never carries over.
  useEffect(() => { setConfirmed(false); setExclusive(false); }, [run.id, blocked]);
  return <div className={`probe-run ${tone(run)}`} role="status" aria-label={`${NAMES[run.probe]}最近一次测试`}>
    <strong>{run.status === 'running' ? <LoaderCircle size={15} className="spin" /> : null}{verdict(run)}</strong>
    <p>{run.mode === 'live' ? '真实运行' : '只读检查'} · 开始 {beijingTime(run.startedAt)}{run.endedAt ? ` · 结束 ${beijingTime(run.endedAt)}` : ''}（北京时间）{run.exitCode !== null ? ` · 退出码 ${run.exitCode}` : ''}</p>
    <p>{summary(run)}</p>
    {run.outcome ? <p>结果：{run.outcome}</p> : null}
    {run.error ? <p className="probe-error">{run.error}</p> : null}
    {run.log?.length ? <details open={run.status === 'running'}><summary>运行过程（最近 {run.log.length} 行）</summary><pre>{run.log.join('\n')}</pre></details> : null}
    <div className="probe-actions">
      {run.status === 'running' && !run.stopRequestedAt ? <button className="button secondary" disabled={busy} onClick={() => onStop(run, false)}><Square size={15} />停止并收尾</button> : null}
      {run.status === 'running' && run.stopRequestedAt ? <button className="button secondary" disabled={busy} onClick={() => onStop(run, true)}><Square size={15} />强制结束</button> : null}
      {run.hasReport ? <button className="button secondary" disabled={busy} onClick={() => onDownload(run)}><Download size={15} />下载报告</button> : null}
    </div>
    {offer ? <div className="probe-live">
      <strong>真实运行</strong>
      <p>将按上面这组参数向{run.probe === 'bybit' ? ' Bybit 发送真实追价委托' : ' ASTER 发起真实划转（A→B 后划回）'}。确认内容：<code>{run.phrase}</code></p>
      {run.probe === 'bybit' && run.params.allowFill ? <p className="probe-error">已选择成交与平仓测试：会真实成交一笔并随后市价平仓，产生手续费与价差损耗。</p> : null}
      {run.probe === 'aster' && Array.isArray(run.params.probeNonce) && run.params.probeNonce.length ? <p className="probe-error">已选择 nonce 探测：被交易所接受的每一笔都是真实划转，会逐笔划回。</p> : null}
      <label><input type="checkbox" checked={confirmed} disabled={!!blocked} onChange={event => setConfirmed(event.target.checked)} />我确认用真实账户发送上述{run.probe === 'bybit' ? '委托' : '划转'}</label>
      <label><input type="checkbox" checked={exclusive} disabled={!!blocked} onChange={event => setExclusive(event.target.checked)} />{run.probe === 'bybit' ? '测试期间不在其他系统对该 Bybit 账户的这个标的下单' : '测试期间旧系统不对这两个子账户做划转，且不触发 ASTER 限频'}</label>
      {blocked ? <p className="probe-error">{blocked}</p> : null}
      <button className="button probe-live-button" disabled={busy || !!blocked || !confirmed || !exclusive} onClick={() => onLive(run)}><Play size={15} />开始真实运行</button>
    </div> : null}
  </div>;
}

export default function ContractProbePage({ onExpired }: { onExpired: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [readError, setReadError] = useState(''), [writeError, setWriteError] = useState(''), [busy, setBusy] = useState(false);
  const [bybit, setBybit] = useState({ symbol: 'CLUSDT', maxNotional: '50', passiveBps: '200', settleTimeoutS: '60', allowFill: false });
  const [aster, setAster] = useState({ masterPrefix: '', aPrefix: '', bPrefix: '', amount: '1', probeNonce: '', balancerPaused: false, settleTimeoutS: '300', historyMinutes: '30' });
  const mounted = useRef(false), reading = useRef<AbortController | null>(null), generation = useRef(0), running = useRef(false), writing = useRef(false), expires = useRef(onExpired);
  expires.current = onExpired;
  running.current = !!state?.running;
  const load = useCallback(async () => {
    if (reading.current || writing.current) return;
    const controller = new AbortController(), version = generation.current;
    reading.current = controller;
    try {
      const value = await api<State>(ROOT, { signal: controller.signal, timeoutMs: 12000 });
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      setState(value); setReadError('');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setReadError(failure instanceof Error ? failure.message : '测试状态读取失败');
    } finally { if (reading.current === controller) reading.current = null; }
  }, []);
  useEffect(() => {
    mounted.current = true; void load();
    let ticks = 0;
    // Every 3 s while a probe runs, every 15 s otherwise.
    const timer = setInterval(() => { ticks += 1; if (!document.hidden && (running.current || ticks % 5 === 0)) void load(); }, 3000);
    const wake = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', wake);
    return () => { mounted.current = false; generation.current++; clearInterval(timer); reading.current?.abort(); reading.current = null; document.removeEventListener('visibilitychange', wake); };
  }, [load]);

  async function write(path: string, body: unknown) {
    if (writing.current) return;
    writing.current = true; generation.current++; reading.current?.abort(); reading.current = null;
    setBusy(true); setWriteError('');
    try {
      const value = await api<State>(ROOT + path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 30000 });
      if (mounted.current) { setState(value); setReadError(''); }
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setWriteError(failure instanceof Error ? failure.message : '操作未完成，请刷新核对');
    } finally { writing.current = false; if (mounted.current) { setBusy(false); void load(); } }
  }
  function startBybit() {
    if (![bybit.passiveBps, bybit.settleTimeoutS].every(value => /^\d{1,4}$/.test(value)) || !/^\d{1,3}(?:\.\d{1,2})?$/.test(bybit.maxNotional)) { setWriteError('请填写有效的金额上限、价距与等待时间。'); return; }
    void write('/runs', { probe: 'bybit', params: { symbol: bybit.symbol, maxNotional: bybit.maxNotional, passiveBps: Number(bybit.passiveBps), settleTimeoutS: Number(bybit.settleTimeoutS), allowFill: bybit.allowFill } });
  }
  function startAster() {
    const offsets = aster.probeNonce.split(/[,，\s]+/).filter(Boolean);
    if (!aster.masterPrefix || !aster.aPrefix || !aster.bPrefix) { setWriteError('请选择主账户与两个子账户。'); return; }
    if (offsets.some(value => !/^-?\d{1,3}$/.test(value)) || ![aster.settleTimeoutS, aster.historyMinutes].every(value => /^\d{1,4}$/.test(value)) || !/^\d(?:\.\d{1,8})?$/.test(aster.amount)) { setWriteError('请填写有效的金额、nonce 偏移与等待时间。'); return; }
    void write('/runs', { probe: 'aster', params: { masterPrefix: aster.masterPrefix, aPrefix: aster.aPrefix, bPrefix: aster.bPrefix, amount: aster.amount, probeNonce: offsets.map(Number),
      balancerPaused: aster.balancerPaused, settleTimeoutS: Number(aster.settleTimeoutS), historyMinutes: Number(aster.historyMinutes) } });
  }
  const live = (run: Run) => { if (run.phrase) void write(`/runs/${run.id}/live`, { confirmLive: true, phrase: run.phrase }); };
  const stop = (run: Run, force: boolean) => {
    if (!window.confirm(force ? '强制结束会跳过收尾：可能在交易所留下未撤的追价、挂单、持仓或未划回的资金，须自行核对处理。确定强制结束？' : run.probe === 'bybit' ? '停止后探测不再创建新追价，并收尾（停止自己的追价、平掉自己成交的数量）。确定停止？' : '停止后探测不再发起新的划转，但不会自动划回：已划到子账户 B 的金额须按报告自行核对并划回。确定停止？')) return;
    void write(`/runs/${run.id}/stop`, force ? { force: true } : {});
  };
  async function download(run: Run) {
    setWriteError('');
    try {
      const value = await api<{ report: unknown }>(`${ROOT}/runs/${run.id}/report`, { timeoutMs: 30000 });
      const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(value.report, null, 2)], { type: 'application/json' }));
      link.href = url; link.download = `contract-${run.probe}-${run.mode}-${run.startedAt.replace(/[:.]/g, '-')}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setWriteError(failure instanceof Error ? failure.message : '报告下载失败');
    }
  }

  const latest = (probe: Probe) => state?.runs.find(run => run.probe === probe);
  const shown = new Set([latest('bybit')?.id, latest('aster')?.id]);
  const earlier = state?.runs.filter(run => !shown.has(run.id)) ?? [];
  const locked = busy || !state || !!state.running || state.maintenance;
  const prefixes = state?.options.aster.prefixes ?? [];
  const panel = (probe: Probe) => { const run = latest(probe); return run && state ? <RunPanel key={run.id} run={run} state={state} busy={busy} onLive={live} onStop={stop} onDownload={run => void download(run)} /> : null; };
  const pick = (label: string, key: 'masterPrefix' | 'aPrefix' | 'bPrefix') => <label>{label}<select aria-label={label} value={aster[key]} disabled={locked} onChange={event => setAster({ ...aster, [key]: event.target.value })}>
    <option value="">请选择</option>{prefixes.map(prefix => <option key={prefix} value={prefix}>{prefix}</option>)}</select></label>;
  return <div className="contract-probes">
    <header><h1>接口实测</h1>
      <p>用真实账户核对交易所接口的实际行为。每项测试先做<strong>只读检查</strong>（不发任何委托或划转），通过后显示本次的确认内容，勾选确认才会<strong>真实运行</strong>。真实运行有固定上限：Bybit 单笔名义金额不超过 200 USDT，ASTER 单笔不超过 5 USD1。</p>
      <p>同一时刻只运行一项测试；真实运行期间系统更新会被挡住。测试结束后可下载报告（已隐去密钥、签名与账户编号）。</p></header>
    {readError ? <div className="error-box inline-error" role="alert"><CircleAlert size={18} />{readError}；页面内容可能已过期。<button onClick={() => void load()}>重试</button></div> : null}
    {writeError ? <div className="error-box inline-error" role="alert"><CircleAlert size={18} />{writeError}</div> : null}
    {!state ? <p role="status"><LoaderCircle size={15} className="spin" /> 正在读取测试状态…</p> : <>
      {state.maintenance ? <p className="probe-error" role="status">系统正在更新或等待确认更新结果，暂不能开始测试。</p> : null}
      <section aria-labelledby="probe-bybit-title"><h2 id="probe-bybit-title">{NAMES.bybit}</h2>
        <p>使用交易中心已保存的 Bybit 执行账户。只读检查读取行情、持仓模式与已有追价策略；真实运行挂一笔远离盘口、预期不成交的追价后停止并核对。</p>
        <div className="probe-form">
          <label>标的<select aria-label="标的" value={bybit.symbol} disabled={locked} onChange={event => setBybit({ ...bybit, symbol: event.target.value })}>{state.options.bybit.symbols.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
          <label>名义金额上限（USDT，≤200）<input aria-label="名义金额上限" inputMode="decimal" value={bybit.maxNotional} disabled={locked} onChange={event => setBybit({ ...bybit, maxNotional: event.target.value.trim() })} /></label>
          <label>被动价距（bps，50–2000）<input aria-label="被动价距" inputMode="numeric" value={bybit.passiveBps} disabled={locked} onChange={event => setBybit({ ...bybit, passiveBps: event.target.value.trim() })} /></label>
          <label>结清等待（秒，10–300）<input aria-label="结清等待" inputMode="numeric" value={bybit.settleTimeoutS} disabled={locked} onChange={event => setBybit({ ...bybit, settleTimeoutS: event.target.value.trim() })} /></label>
          <label className="probe-check"><input type="checkbox" checked={bybit.allowFill} disabled={locked} onChange={event => setBybit({ ...bybit, allowFill: event.target.checked })} />同时测试成交与平仓（真实运行时会成交一笔并随后市价平仓）</label>
        </div>
        <button className="button primary" disabled={locked} onClick={startBybit}><Play size={15} />只读检查</button>
        {panel('bybit')}
      </section>
      <section aria-labelledby="probe-aster-title"><h2 id="probe-aster-title">{NAMES.aster}</h2>
        <p>使用 ASTER 模块已配置的账户。只读检查做签名读取；真实运行由主账户把 USD1 从子账户 A 划到 B 再划回，核对回执、两侧流水与入账延迟。</p>
        {prefixes.length < 3 ? <p className="probe-error">ASTER 模块的配置里不足三个凭据齐全的账户（每个账户需要 _USER、_SIGNER、_PRIVATE_KEY 三项），暂不能测试。</p> : <>
          <div className="probe-form">
            {pick('主账户', 'masterPrefix')}{pick('子账户 A', 'aPrefix')}{pick('子账户 B', 'bPrefix')}
            <label>每笔金额（USD1，≤5）<input aria-label="每笔金额" inputMode="decimal" value={aster.amount} disabled={locked} onChange={event => setAster({ ...aster, amount: event.target.value.trim() })} /></label>
            <label>入账等待（秒，10–900）<input aria-label="入账等待" inputMode="numeric" value={aster.settleTimeoutS} disabled={locked} onChange={event => setAster({ ...aster, settleTimeoutS: event.target.value.trim() })} /></label>
            <label>流水回看（分钟，1–1440）<input aria-label="流水回看" inputMode="numeric" value={aster.historyMinutes} disabled={locked} onChange={event => setAster({ ...aster, historyMinutes: event.target.value.trim() })} /></label>
            <label className="probe-wide">nonce 偏移探测（秒，逗号分隔，最多 8 个，留空则不探测）<span><input aria-label="nonce 偏移" value={aster.probeNonce} disabled={locked} placeholder="留空则不探测" onChange={event => setAster({ ...aster, probeNonce: event.target.value })} />
              <button type="button" className="button secondary" disabled={locked} onClick={() => setAster({ ...aster, probeNonce: NONCE_PRESET })}>填入建议值</button></span></label>
            <label className="probe-check"><input type="checkbox" checked={aster.balancerPaused} disabled={locked} onChange={event => setAster({ ...aster, balancerPaused: event.target.checked })} />A 或 B 有持仓，且我已在 ASTER 模块里暂停该配对的保证金平衡（系统不替你核实；无持仓时不必勾选）</label>
          </div>
          <button className="button primary" disabled={locked} onClick={startAster}><Play size={15} />只读检查</button></>}
        {panel('aster')}
      </section>
      {earlier.length ? <section aria-labelledby="probe-history-title"><h2 id="probe-history-title">较早的测试</h2>
        <div className="probe-table"><table><thead><tr><th>开始（北京时间）</th><th>接口</th><th>方式</th><th>结论</th><th>报告</th></tr></thead>
          <tbody>{earlier.map(run => <tr key={run.id}><td>{beijingTime(run.startedAt)}</td><td>{NAMES[run.probe]}</td><td>{run.mode === 'live' ? '真实运行' : '只读检查'}</td><td className={tone(run)}>{verdict(run)}</td>
            <td>{run.hasReport ? <button className="button secondary" disabled={busy} onClick={() => void download(run)}>下载</button> : '无'}</td></tr>)}</tbody></table></div>
      </section> : null}
    </>}
  </div>;
}
