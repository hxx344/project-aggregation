import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, Play, Square } from 'lucide-react';
import { api, ApiError } from './api';
import { useLiveResource } from './use-live-resource';
import { beijingTime } from './trading-format';
import './contract-probes.css';

const ROOT = '/api/system/contract-probes';
type Probe = 'bybit' | 'aster' | 'canary';
type CanaryStep = 'check' | 'open' | 'close' | 'settle';
type Run = {
  id: string; probe: Probe; mode: 'read-only' | 'live'; params: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed' | 'not-sent' | 'needs-check' | 'interrupted';
  startedAt: string; endedAt: string | null; exitCode: number | null; phrase: string | null; outcome: string | null; error: string | null;
  stopRequestedAt: string | null; forced: boolean; usedForLive: boolean; hasReport: boolean; log?: string[];
};
type State = {
  observedAt: string; running: string | null; maintenance: boolean; liveWindowMs: number;
  options: { bybit: { symbols: string[] }; aster: { prefixes: string[] }; canary?: { symbols: string[] } }; liveBlocked: Record<Probe, string | null>; runs: Run[];
};
const NAMES: Record<Probe, string> = { bybit: 'Bybit 原生追价', aster: 'ASTER 子账户划转', canary: '原油双腿金丝雀（新执行器）' };
const STEP_NAMES: Record<CanaryStep, string> = { check: '启动检查与核对', open: '开仓', close: '平仓', settle: '收尾' };
const VENUES: Record<string, string> = { binance: 'Binance', bybit: 'Bybit' };
const NONCE_PRESET = '-30,-59,-61,-90,-121,61';

function verdict(run: Run) {
  if (run.status === 'running') return run.stopRequestedAt ? '已请求停止，正在收尾' : run.mode === 'live' ? '真实运行中' : '只读检查中';
  if (run.status === 'completed' && run.probe === 'canary') return run.mode === 'live' ? '真实运行完成，任务已到终态' : run.phrase ? '预览完成，未发送任何写请求' : '检查完成，未发送任何写请求（结论见下方结果）';
  if (run.status === 'completed') return run.mode === 'live' ? '真实运行完成，收尾正常' : '只读检查通过，未发送任何写请求';
  if (run.status === 'failed') return '只读检查未通过，未发送任何写请求';
  if (run.status === 'not-sent') return '真实运行未发出任何写请求';
  if (run.status === 'needs-check') return '已发送过真实请求且未确认收尾正常：请到交易所核对';
  return run.mode === 'live' ? '运行环境重启时被中断：请到交易所核对' : '运行环境重启时被中断，未发送任何写请求';
}
const tone = (run: Run) => run.status === 'completed' ? 'ok' : run.status === 'running' ? 'busy' : run.status === 'needs-check' || run.status === 'interrupted' && run.mode === 'live' ? 'bad' : 'warn';
function summary(run: Run) {
  const p = run.params;
  if (run.probe === 'canary') {
    const step = p.step as CanaryStep, caps = `单笔上限 ${p.perJob} / 累计开仓上限 ${p.totalOpen} USDT`;
    if (step === 'check' || step === 'settle') return `${STEP_NAMES[step]} · ${p.symbol} · ${caps}`;
    return `${STEP_NAMES[step]} · ${p.symbol} · 首腿 ${VENUES[String(p.lead)]}${step === 'open' ? (p.leadSide === 'long' ? ' 做多' : ' 做空') : '（方向取金丝雀持仓）'}${p.leadOrder === 'chase' ? ' 原生追价' : ' 市价'} · 每腿 ${p.quantity} 桶 · ${caps} · 最长 ${p.timeoutS} 秒${p.maxSlippageBps ? ` · 价格保护 ${p.maxSlippageBps} bps` : ''}`;
  }
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
      <p>将按上面这组参数{run.probe === 'bybit' ? '向 Bybit 发送真实追价委托' : run.probe === 'aster' ? '向 ASTER 发起真实划转（A→B 后划回）' : run.params.step === 'settle' ? '把剩余的金丝雀任务核对到终态（首腿撤挂单、不再新发，已成交部分可能补发对冲腿）' : `在 Binance 与 Bybit 各下一腿真实${run.params.step === 'open' ? '开仓' : '平仓'}委托`}。确认内容：<code>{run.phrase}</code></p>
      {run.probe === 'bybit' && run.params.allowFill ? <p className="probe-error">已选择成交与平仓测试：会真实成交一笔并随后市价平仓，产生手续费与价差损耗。</p> : null}
      {run.probe === 'aster' && Array.isArray(run.params.probeNonce) && run.params.probeNonce.length ? <p className="probe-error">已选择 nonce 探测：被交易所接受的每一笔都是真实划转，会逐笔划回。</p> : null}
      {run.probe === 'canary' && run.params.step !== 'settle' ? <p className="probe-error">真实运行前会按当时行情重新预览；价格变化后名义金额上限仍然生效，超限即不下单。</p> : null}
      <label><input type="checkbox" checked={confirmed} disabled={!!blocked} onChange={event => setConfirmed(event.target.checked)} />我确认用真实账户发送上述{run.probe === 'aster' ? '划转' : '委托'}</label>
      <label><input type="checkbox" checked={exclusive} disabled={!!blocked} onChange={event => setExclusive(event.target.checked)} />{run.probe === 'bybit' ? '测试期间不在其他系统对该 Bybit 账户的这个标的下单'
        : run.probe === 'aster' ? '测试期间旧系统不对这两个子账户做划转，且不触发 ASTER 限频'
        : run.params.step === 'settle' ? '我已看过上方待收尾的任务，需要人工处理的剩余敞口已在交易所处理'
        : '测试期间旧系统（含自动规则）和人工都不对这两个账户的该合约下单'}</label>
      {blocked ? <p className="probe-error">{blocked}</p> : null}
      <button className="button probe-live-button" disabled={busy || !!blocked || !confirmed || !exclusive} onClick={() => onLive(run)}><Play size={15} />开始真实运行</button>
    </div> : null}
  </div>;
}

export default function ContractProbePage({ onExpired }: { onExpired: () => void }) {
  const [writeError, setWriteError] = useState(''), [busy, setBusy] = useState(false), [running, setRunning] = useState(false);
  const [bybit, setBybit] = useState({ symbol: 'CLUSDT', maxNotional: '50', passiveBps: '200', settleTimeoutS: '60', allowFill: false });
  const [canary, setCanary] = useState({ symbol: 'CLUSDT', lead: 'binance', leadSide: 'long', leadOrder: 'market', quantity: '', perJob: '100', totalOpen: '300', timeoutS: '120', maxSlippageBps: '', strategy: 'auto', strategyId: '' });
  const [aster, setAster] = useState({ masterPrefix: '', aPrefix: '', bPrefix: '', amount: '1', probeNonce: '', balancerPaused: false, settleTimeoutS: '300', historyMinutes: '30' });
  const mounted = useRef(false), writing = useRef(false), expires = useRef(onExpired);
  expires.current = onExpired;
  // 探测运行中每 3 秒读一次，否则 15 秒。写操作确认的结果直接成为当前值，之前发出的读取作废。
  const probes = useLiveResource<State>(ROOT, { intervalMs: running ? 3000 : 15000, timeoutMs: 12000, onExpired });
  const state = probes.data, readError = probes.error && !(probes.error instanceof ApiError && probes.error.status === 401) ? probes.error.message : '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setRunning(!!state?.running); }, [state?.running]);

  async function write(path: string, body: unknown) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true); setWriteError('');
    try {
      const value = await api<State>(ROOT + path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 30000 });
      if (mounted.current) probes.commit(value);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setWriteError(failure instanceof Error ? failure.message : '操作未完成，请刷新核对');
    } finally { writing.current = false; if (mounted.current) { setBusy(false); void probes.refresh(); } }
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
  function startCanary(step: CanaryStep) {
    const placing = step === 'open' || step === 'close';
    if (placing && !/^\d{1,6}(?:\.\d{1,8})?$/.test(canary.quantity)) { setWriteError('请填写每腿数量（桶）。'); return; }
    if (![canary.perJob, canary.totalOpen].every(value => /^\d{1,3}(?:\.\d{1,2})?$/.test(value)) || !/^\d{1,3}$/.test(canary.timeoutS) || !/^(?:\d{1,3})?$/.test(canary.maxSlippageBps)) { setWriteError('请填写有效的金额上限、执行时长与价格保护。'); return; }
    const recovering = step === 'settle' && canary.strategy !== 'auto';
    if (recovering && canary.strategy === 'adopt' && !/^[A-Za-z0-9_-]{1,100}$/.test(canary.strategyId)) { setWriteError('认领追价策略须填写 Bybit 策略编号。'); return; }
    void write('/runs', { probe: 'canary', params: { step, symbol: canary.symbol, lead: canary.lead, leadSide: canary.leadSide, leadOrder: canary.lead === 'bybit' ? canary.leadOrder : 'market',
      ...(placing ? { quantity: canary.quantity } : {}), perJob: canary.perJob, totalOpen: canary.totalOpen, timeoutS: Number(canary.timeoutS),
      ...(canary.maxSlippageBps ? { maxSlippageBps: Number(canary.maxSlippageBps) } : {}),
      ...(recovering ? { strategy: canary.strategy, ...(canary.strategy === 'adopt' ? { strategyId: canary.strategyId } : {}) } : {}) } });
  }
  const live = (run: Run) => { if (run.phrase) void write(`/runs/${run.id}/live`, { confirmLive: true, phrase: run.phrase }); };
  const stop = (run: Run, force: boolean) => {
    if (!window.confirm(force ? '强制结束会跳过收尾：可能在交易所留下未撤的追价、挂单、持仓或未划回的资金，须自行核对处理。确定强制结束？' : run.probe === 'bybit' ? '停止后探测不再创建新追价，并收尾（停止自己的追价、平掉自己成交的数量）。确定停止？'
      : run.probe === 'canary' ? '停止后不再创建新任务；已在运行的任务交给执行器收尾（首腿撤挂单，已成交部分按需补发对冲腿），之后请做启动检查核对。确定停止？' : '停止后探测不再发起新的划转，但不会自动划回：已划到子账户 B 的金额须按报告自行核对并划回。确定停止？')) return;
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
  const shown = new Set([latest('bybit')?.id, latest('aster')?.id, latest('canary')?.id]);
  const earlier = state?.runs.filter(run => !shown.has(run.id)) ?? [];
  const locked = busy || !state || !!state.running || state.maintenance;
  const prefixes = state?.options.aster.prefixes ?? [];
  const panel = (probe: Probe) => { const run = latest(probe); return run && state ? <RunPanel key={run.id} run={run} state={state} busy={busy} onLive={live} onStop={stop} onDownload={run => void download(run)} /> : null; };
  const pick = (label: string, key: 'masterPrefix' | 'aPrefix' | 'bPrefix') => <label>{label}<select aria-label={label} value={aster[key]} disabled={locked} onChange={event => setAster({ ...aster, [key]: event.target.value })}>
    <option value="">请选择</option>{prefixes.map(prefix => <option key={prefix} value={prefix}>{prefix}</option>)}</select></label>;
  return <div className="contract-probes">
    <header><h1>接口实测</h1>
      <p>用真实账户核对交易所接口的实际行为。每项测试先做<strong>只读检查</strong>（不发任何委托或划转），通过后显示本次的确认内容，勾选确认才会<strong>真实运行</strong>。真实运行有固定上限：Bybit 单笔名义金额不超过 200 USDT，ASTER 单笔不超过 5 USD1，原油金丝雀单笔不超过 200 USDT、累计开仓不超过 500 USDT。</p>
      <p>同一时刻只运行一项测试；真实运行期间系统更新会被挡住。测试结束后可下载报告（已隐去密钥、签名与账户编号）。</p></header>
    {readError ? <div className="error-box inline-error" role="alert"><CircleAlert size={18} />{readError}；页面内容可能已过期。<button onClick={() => void probes.refresh()}>重试</button></div> : null}
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
      <section aria-labelledby="probe-canary-title"><h2 id="probe-canary-title">{NAMES.canary}</h2>
        <p>使用交易中心已保存的 Binance 与 Bybit 执行账户，由新执行器在原油合约上做跨所双腿开平仓；执行记录单独存放在数据目录的 executor-canary 下，平仓只平金丝雀自己开的仓位。建议顺序：启动检查 → 开仓预览并真实开仓 → 平仓预览并真实平仓 → 再做一次启动检查核对。某一步被中断或有任务待人工确认时，先做收尾。两个密钥都须绑定本机出口 IP，否则启动检查不通过。</p>
        <div className="probe-form">
          <label>合约<select aria-label="合约" value={canary.symbol} disabled={locked} onChange={event => setCanary({ ...canary, symbol: event.target.value })}>{(state.options.canary?.symbols ?? ['CLUSDT', 'BZUSDT']).map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
          <label>首腿交易所<select aria-label="首腿交易所" value={canary.lead} disabled={locked} onChange={event => setCanary({ ...canary, lead: event.target.value })}><option value="binance">Binance</option><option value="bybit">Bybit</option></select></label>
          <label>首腿方向（开仓用）<select aria-label="首腿方向" value={canary.leadSide} disabled={locked} onChange={event => setCanary({ ...canary, leadSide: event.target.value })}><option value="long">做多</option><option value="short">做空</option></select></label>
          <label>首腿下单方式<select aria-label="首腿下单方式" value={canary.lead === 'bybit' ? canary.leadOrder : 'market'} disabled={locked || canary.lead !== 'bybit'} onChange={event => setCanary({ ...canary, leadOrder: event.target.value })}><option value="market">市价</option><option value="chase">Bybit 原生追价（只限买入方向）</option></select></label>
          <label>每腿数量（桶）<input aria-label="每腿数量" inputMode="decimal" value={canary.quantity} disabled={locked} placeholder="开平仓必填" onChange={event => setCanary({ ...canary, quantity: event.target.value.trim() })} /></label>
          <label>单笔上限（USDT，≤200）<input aria-label="单笔上限" inputMode="decimal" value={canary.perJob} disabled={locked} onChange={event => setCanary({ ...canary, perJob: event.target.value.trim() })} /></label>
          <label>累计开仓上限（USDT，≤500）<input aria-label="累计开仓上限" inputMode="decimal" value={canary.totalOpen} disabled={locked} onChange={event => setCanary({ ...canary, totalOpen: event.target.value.trim() })} /></label>
          <label>最长执行（秒，30–600）<input aria-label="最长执行" inputMode="numeric" value={canary.timeoutS} disabled={locked} onChange={event => setCanary({ ...canary, timeoutS: event.target.value.trim() })} /></label>
          <label>价格保护（bps，1–200，留空用默认）<input aria-label="价格保护" inputMode="numeric" value={canary.maxSlippageBps} disabled={locked} placeholder="默认" onChange={event => setCanary({ ...canary, maxSlippageBps: event.target.value.trim() })} /></label>
          <label>未知追价策略（收尾用）<select aria-label="未知追价策略" value={canary.strategy} disabled={locked} onChange={event => setCanary({ ...canary, strategy: event.target.value })}><option value="auto">自动核对未创建</option><option value="adopt">按策略编号认领</option><option value="release">强制释放（策略可能已成交）</option></select></label>
          <label>策略编号（认领用）<input aria-label="策略编号" value={canary.strategyId} disabled={locked || canary.strategy !== 'adopt'} placeholder="Bybit 策略编号" onChange={event => setCanary({ ...canary, strategyId: event.target.value.trim() })} /></label>
        </div>
        <p>Bybit 追价首腿的创建请求没有得到回应时，任务会停在待人工确认：收尾默认自动核对策略未创建；核对不通过时，到 Bybit 查到策略编号后按编号认领，查不到又无法证明未创建时才强制释放。认领或强制释放后，先到交易所处理敞口，再做一次收尾确认。</p>
        <p>平仓时方向取自金丝雀记录的持仓，与上面的首腿方向无关；累计开仓上限按金丝雀已开过的所有任务计，平仓不退回。</p>
        <div className="probe-actions">
          <button className="button primary" disabled={locked} onClick={() => startCanary('check')}><Play size={15} />启动检查与核对</button>
          <button className="button secondary" disabled={locked} onClick={() => startCanary('open')}><Play size={15} />开仓预览</button>
          <button className="button secondary" disabled={locked} onClick={() => startCanary('close')}><Play size={15} />平仓预览</button>
          <button className="button secondary" disabled={locked} onClick={() => startCanary('settle')}><Play size={15} />收尾</button>
        </div>
        {panel('canary')}
      </section>
      {earlier.length ? <section aria-labelledby="probe-history-title"><h2 id="probe-history-title">较早的测试</h2>
        <div className="probe-table"><table><thead><tr><th>开始（北京时间）</th><th>接口</th><th>方式</th><th>结论</th><th>报告</th></tr></thead>
          <tbody>{earlier.map(run => <tr key={run.id}><td>{beijingTime(run.startedAt)}</td><td>{NAMES[run.probe]}</td><td>{run.mode === 'live' ? '真实运行' : '只读检查'}</td><td className={tone(run)}>{verdict(run)}</td>
            <td>{run.hasReport ? <button className="button secondary" disabled={busy} onClick={() => void download(run)}>下载</button> : '无'}</td></tr>)}</tbody></table></div>
      </section> : null}
    </>}
  </div>;
}
