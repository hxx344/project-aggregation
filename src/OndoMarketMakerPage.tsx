import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, LoaderCircle, Play, RefreshCw, Save, Square, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import type { OndoMmConfig, OndoMmSide, OndoMmSnapshot } from './ondo-mm-types';
import './ondo-mm.css';
import { useLiveResource } from './use-live-resource';
import { Callout, StatePanel, TableEmpty } from './StateViews';

const ROOT = '/api/automation/ondo-mm';
const HOLDS: Record<string, string> = {
  starting: '启动中', stopping: '正在撤单停止', maintenance: '更新维护中，暂停挂单并撤单', admission: '账户隔离恢复中，暂停挂单并撤单', auth_failed: '凭据或访问被拒绝，已停止下单；撤单可能失败，请到 Ondo 核对',
  rate_limited: '交易所限流冷却中，暂停挂单并撤单', no_rules: '市场规则未读到', unknown_market: '交易所没有这个市场', market_closed: '休市或暂停交易', private_stream: '账户推送未连接',
  account_unknown: '账户状态读取失败', stale_book: '盘口过期或单边', unknown_order: '有订单结果未知，核对中',
};
const REASONS: Record<string, string> = {
  ...HOLDS, in_flight: '请求处理中', duplicate: '重复挂单，撤销中', role_change: '持仓变化，换单中', position_cap: '持仓已到上限，不再加仓', total_cap: '总名义已到上限', total_unknown: '有市场的持仓暂时无法估值，不新挂单',
  too_close: '离中间价太近', too_far: '离中间价太远，等待确认后改价', unprotected: '前方大单变少，等待确认后改价', own_order_in_way: '会碰到本账户的反向挂单',
  no_book: '盘口不完整', no_price: '没有可挂的价位', no_tick_in_band: '价格步长太粗，区间内没有价位', size_too_small: '每单金额不足一个最小数量', syncing: '核对账户中',
  backoff: '下单被拒后等待重试', close_size: '持仓变化，调整平仓数量', close_follow: '跟随盘口平仓', dust_position: '持仓不足一个最小数量',
};
const STATES: Record<OndoMmSide['state'], string> = { none: '未挂', planned: '计划', sending: '下单中', open: '挂单中', canceling: '撤单中', unknown: '结果未知' };
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const when = (value: string | number | null) => { const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? dates.format(ms) : '—'; };
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';
const marketList = (text: string) => text.split(/[\s,，、]+/).filter(Boolean).map(item => item.toUpperCase());

function SideCell({ side }: { side: OndoMmSide }) {
  if (side.state === 'none') return <td><span className="muted">未挂</span>{side.reason ? <small>{REASONS[side.reason] ?? side.reason}</small> : null}</td>;
  return <td>
    <span className={side.state === 'open' ? 'om-ok' : undefined}>{side.role === 'close' ? '平仓 ' : ''}{side.price} × {side.size}</span>
    <small>{STATES[side.state]}{side.bps === undefined ? '' : ` · 距中间价 ${side.bps.toFixed(2)} bps`}{side.mode === 'wall' ? ' · 大单后' : side.mode === 'fixed' ? ' · 固定距离' : ''}{side.protection ? ` · 前方 ${Number(side.protection).toFixed(0)} USD` : ''}</small>
    {side.reason ? <small>{REASONS[side.reason] ?? side.reason}</small> : null}
  </td>;
}

export default function OndoMarketMakerPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<OndoMmSnapshot | null>(null);
  const [draft, setDraft] = useState<OndoMmConfig | null>(null);
  const [marketsText, setMarketsText] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [adoptPositions, setAdoptPositions] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const lastAccepted = useRef<OndoMmSnapshot | null>(null);
  const dirty = !!snapshot && !!draft && JSON.stringify(draft) !== JSON.stringify(snapshot.config);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const busyRef = useRef(false);
  busyRef.current = !!busy;
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  // 未保存的草稿保留；轮询只刷新运行状态。
  const accept = useCallback((data: OndoMmSnapshot, replace?: boolean) => {
    lastAccepted.current = data; setSnapshot(data);
    if (replace ?? !dirtyRef.current) { setDraft(data.config); setMarketsText(data.config.markets.join(', ')); }
  }, []);
  const active = !!snapshot && snapshot.phase !== 'stopped';
  const resource = useLiveResource<OndoMmSnapshot>(ROOT, { intervalMs: active ? 2000 : 15_000, timeoutMs: 10_000, onExpired });
  const loadError = resource.error && !(resource.error instanceof ApiError && resource.error.status === 401) ? resource.error.message : '';
  // 写入进行中不接收读取结果：写入成功后的结果作废之前发出的读取（L089）。
  useEffect(() => {
    if (busy || !resource.data || resource.data === lastAccepted.current) return;
    accept(resource.data);
  }, [resource.data, busy, accept]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); };
  }, []);
  const execute = async (name: string, path: string, method: string, body: unknown, done: string, replace: () => boolean | undefined = () => undefined, timeoutMs = 30_000) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busyRef.current) return null;
    busyRef.current = true;
    setBusy(name); setActionError(''); setNotice('');
    try {
      const data = await api<OndoMmSnapshot>(ROOT + path, { method, body: JSON.stringify(body), signal, timeoutMs });
      if (signal.aborted) return null;
      accept(data, replace()); resource.commit(data); setNotice(done);
      return data;
    } catch (reason) { if (!signal.aborted) { fail(reason, setActionError); void resource.refresh(); } return null; }
    finally { busyRef.current = false; if (!signal.aborted) setBusy(''); }
  };
  const change = (next: Partial<OndoMmConfig>) => setDraft(current => current && { ...current, ...next });
  const save = async () => {
    if (!draft) return;
    const submitted = JSON.stringify(draft);
    await execute('save', '/config', 'PUT', { config: draft }, '设置已保存', () => JSON.stringify(draftRef.current) === submitted);
  };
  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await execute('key', '/credentials', 'PUT', { keyId: keyId.trim(), secret: secret.trim() }, 'API Key 已保存');
    if (saved) { setKeyId(''); setSecret(''); }
  };
  const start = async () => {
    if (!snapshot) return;
    const live = snapshot.config.mode === 'live';
    const started = await execute('start', '/start', 'POST', live ? { revision: snapshot.revision, confirmLive: true, adoptPositions } : { revision: snapshot.revision }, live ? '实盘挂单已启动' : '观察已启动');
    if (started) { setConfirmLive(false); setAdoptPositions(false); }
  };
  const stop = async () => {
    // 停止要等交易所确认没有遗留挂单，最长约 20 秒；超时后服务器继续撤单。
    const stopped = await execute('stop', '/stop', 'POST', {}, '', undefined, 60_000);
    // 请求本身失败时服务器可能仍在撤单：撤完后同样清掉提示。
    if (!stopped) { setStopPending(true); return; }
    if (stopped.phase === 'stopped') setNotice('已停止，全部挂单已确认撤销');
    else { setStopPending(true); setActionError('撤单尚未得到交易所确认，服务器仍在继续撤单，请留意下方状态；必要时到 Ondo 页面手动撤单。'); }
  };
  // 服务器在后台撤完后，上面的提示不再成立。
  useEffect(() => {
    if (!stopPending || snapshot?.phase !== 'stopped') return;
    setStopPending(false); setActionError(''); setNotice('已停止，全部挂单已确认撤销');
  }, [stopPending, snapshot?.phase]);

  const liveSaved = snapshot?.config.mode === 'live';
  const startBlock = !snapshot ? '' : dirty ? '请先保存设置' : liveSaved && !snapshot.credentials.configured ? '请先保存 API Key' : liveSaved && snapshot.paused ? snapshot.pauseReason ?? '' : liveSaved && snapshot.recovery ? '请先撤销上次实盘的遗留挂单' : liveSaved && !confirmLive ? '请先勾选实盘确认' : '';
  const heading = <header className="wb-heading"><div><h1>Ondo 挂单奖励</h1><p>在 Ondo Perps 双边挂只做 Maker 的限价单，跟随盘口保持在奖励区间内并尽量避免成交；由工作台服务器运行，不需要打开页面</p></div><div className="wb-toolbar">
    <button className="button secondary" disabled={!!busy} onClick={() => void resource.refresh()}><RefreshCw size={15} />刷新</button>
    {active ? <button className="button primary" disabled={!!busy} onClick={() => void stop()}>{busy === 'stop' ? <LoaderCircle size={15} className="spin" /> : <Square size={15} />}{snapshot?.phase === 'stopping' ? '继续停止' : '停止并撤单'}</button>
      : <><button className="button secondary" disabled={!dirty || !!busy} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存设置</button>
        <button className="button primary" disabled={!!busy || !snapshot || !!startBlock} title={startBlock || undefined} onClick={() => void start()}>{busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{liveSaved ? '启动实盘挂单' : '启动观察'}</button></>}
  </div></header>;
  const disabled = active || !!busy;
  return <div className="wb-page">
    {heading}
    {actionError ? <Callout tone="error">{actionError}</Callout> : null}
    {notice ? <Callout tone="success">{notice}</Callout> : null}
    {loadError ? <Callout tone="warning">状态读取失败：{loadError}。保留最后读取的数据，稍后自动重试。</Callout> : null}
    {snapshot?.loadError ? <Callout tone="warning">{snapshot.loadError}</Callout> : null}
    {snapshot?.credentials.error ? <Callout tone="warning">{snapshot.credentials.error}</Callout> : null}
    {snapshot?.lastError ? <Callout tone="error">{snapshot.lastError}</Callout> : null}
    {snapshot?.leftPositions.length ? <Callout tone="warning">上次停止时账户仍有持仓未平（停止那一刻的记录，之后不再更新）：{snapshot.leftPositions.map(item => `${item.market} ${item.position}`).join('、')}。停止后本模块不再挂平仓单，请到 Ondo 自行处理，或重新启动并勾选接管。</Callout> : null}
    {snapshot?.recovery ? <Callout tone="warning">上次实盘会话{snapshot.recovery.startedAt ? `（${when(snapshot.recovery.startedAt)} 启动）` : ''}没有确认撤完挂单，交易所可能还有遗留挂单。{snapshot.recovery.cleaning ? '正在自动撤销…' : snapshot.recovery.error ? `自动撤销失败（${snapshot.recovery.error}）。` : ''}
      {' '}<button className="button secondary" disabled={!!busy || snapshot.recovery.cleaning || active} onClick={() => void execute('cleanup', '/cleanup', 'POST', {}, '已核对遗留挂单', undefined, 60_000)}>{busy === 'cleanup' ? <LoaderCircle size={15} className="spin" /> : null}撤销遗留挂单</button>
      {' '}{snapshot.recovery.error && !snapshot.recovery.cleaning ? <button className="button secondary" disabled={!!busy || active} onClick={() => { if (window.confirm('请先在 Ondo 页面确认没有遗留挂单。确认后工作台不再跟踪上次会话的挂单，继续吗？')) void execute('discard', '/recovery/discard', 'POST', {}, '已忽略上次实盘的遗留记录'); }}>已手动核对，忽略</button> : null}</Callout> : null}
    {!snapshot || !draft ? <StatePanel kind="loading" title="正在读取状态" /> : <div className="om-layout">
      <div className="om-column">
        <section className="panel wb-status" aria-label="运行状态"><div className="wb-state-line">
          <span className={`wb-state ${snapshot.phase === 'running' ? 'running' : ''}`}>{snapshot.phase === 'stopped' ? '未运行' : snapshot.phase === 'stopping' ? '正在停止：撤单并核对中' : snapshot.live ? '实盘挂单运行中' : '观察中（不下单）'}</span>
          {snapshot.paused && snapshot.live && active ? <span className="wb-paused">{snapshot.pauseReason}</span> : null}
          {dirty ? <span className="wb-paused">有未保存的修改</span> : null}</div>
          {active ? <div className="om-facts">
            <span>启动于 {when(snapshot.startedAt)}</span>
            <span>行情 {snapshot.stream?.publicReady ? '已连接' : `未连接${snapshot.stream?.error ? `（${snapshot.stream.error}）` : ''}`}</span>
            {snapshot.live ? <span>账户推送 {snapshot.stream?.privateReady ? '已连接' : '未连接'}</span> : null}
            {snapshot.cooldownUntil && snapshot.cooldownUntil > snapshot.serverNow ? <span className="om-hold">限流冷却至 {when(snapshot.cooldownUntil)}</span> : null}
            {snapshot.syncError ? <span className="om-hold">账户读取失败：{snapshot.syncError}</span> : null}
            {snapshot.rulesError ? <span className="om-hold">市场规则读取失败：{snapshot.rulesError}</span> : null}
            {snapshot.totals && snapshot.live ? <span>下单 {snapshot.totals.placed} · 撤单 {snapshot.totals.canceled} · 成交 {snapshot.totals.fills} · 被拒 {snapshot.totals.rejected} · 只做 Maker 拦截 {snapshot.totals.postOnly}</span> : null}
          </div> : null}</section>
        <section className="panel" aria-label="市场"><div className="panel-heading"><h2>市场</h2><span className="muted">{active ? `数据 ${when(snapshot.serverNow)}` : '启动后显示'}</span></div>
          {!snapshot.markets.length ? <TableEmpty>尚未运行。保存设置后启动观察，可以先看计划的挂单位置。</TableEmpty> : <div className="om-table"><table>
            <thead><tr><th scope="col">市场</th><th scope="col">状态</th><th scope="col" className="num">买一 / 卖一</th><th scope="col" className="num">持仓</th><th scope="col">买单</th><th scope="col">卖单</th></tr></thead>
            <tbody>{snapshot.markets.map(market => <tr key={market.market}>
              <th scope="row">{market.market}</th>
              <td className={market.hold ? 'om-hold' : 'om-ok'}>{market.hold ? HOLDS[market.hold] ?? market.hold : snapshot.live ? '挂单中' : '观察中'}{market.error ? <small>循环出错：{market.error}</small> : null}</td>
              <td className="num">{market.bid ?? '—'} / {market.ask ?? '—'}</td>
              <td className="num">{market.position ?? '—'}{snapshot.live && !market.synced ? <small>核对中</small> : null}</td>
              <SideCell side={market.buy} /><SideCell side={market.sell} />
            </tr>)}</tbody>
          </table></div>}</section>
        <section className="panel" aria-label="事件"><div className="panel-heading"><h2>事件</h2><span className="muted">最近 {snapshot.events.length} 条，重启后清空</span></div>
          {snapshot.events.length ? <ul className="om-events">{snapshot.events.map((event, index) => <li key={`${event.at}-${index}`}><time>{when(event.at)}</time><span>{event.market ? <b>{event.market}</b> : null}{event.text}</span></li>)}</ul>
            : <p className="muted om-form">暂无事件</p>}</section>
      </div>
      <div className="om-column">
        <section className="panel wb-section" aria-label="挂单设置"><div className="panel-heading"><h2>挂单设置</h2><span className="muted">{active ? '运行中不可修改' : `版本 ${snapshot.revision}`}</span></div>
          <fieldset className="om-form" disabled={disabled}>
            <div className="om-modes" role="radiogroup" aria-label="运行模式">
              <label><input type="radio" name="om-mode" checked={draft.mode === 'observe'} onChange={() => change({ mode: 'observe' })} />观察（只计算，不下单）</label>
              <label><input type="radio" name="om-mode" checked={draft.mode === 'live'} onChange={() => change({ mode: 'live' })} />实盘（真实下单）</label></div>
            <div className="wb-grid om-grid">
              <label className="wb-field wide"><span>市场</span><input value={marketsText} onChange={e => { setMarketsText(e.target.value); change({ markets: marketList(e.target.value) }); }} placeholder="NVDA-USD.P, TSLA-USD.P" /><small>最多 10 个，逗号分隔。奖励市场名单每周可能变化，请以 Ondo 公告为准。</small></label>
              <label className="wb-field"><span>每单金额（USD）</span><input inputMode="decimal" value={draft.orderUsd} onChange={e => change({ orderUsd: e.target.value.trim() })} /><small>每个市场买卖各挂一单。</small></label>
              <label className="wb-field"><span>目标距离（bps）</span><input inputMode="decimal" value={draft.targetBps} onChange={e => change({ targetBps: e.target.value.trim() })} /><small>距中间价 0–5 bps 的挂单分 85% 奖励。</small></label>
              <label className="wb-field"><span>最近距离（bps）</span><input inputMode="decimal" value={draft.minBps} onChange={e => change({ minBps: e.target.value.trim() })} /><small>比这更近立即撤单重挂。</small></label>
              <label className="wb-field"><span>最远距离（bps）</span><input inputMode="decimal" value={draft.maxBps} onChange={e => change({ maxBps: e.target.value.trim() })} /><small>比这更远、确认后改价；超过 25 bps 没有奖励。</small></label>
              <label className="wb-field"><span>单市场最大持仓（USD）</span><input inputMode="decimal" value={draft.maxPositionUsd} onChange={e => change({ maxPositionUsd: e.target.value.trim() })} /><small>成交后持仓到此上限就不再加仓，只挂平仓单。</small></label>
              <label className="wb-field"><span>总名义上限（USD）</span><input inputMode="decimal" value={draft.maxTotalUsd} onChange={e => change({ maxTotalUsd: e.target.value.trim() })} /><small>上面所列市场的挂单与持仓合计；不含其他市场的持仓。</small></label>
              <label className="wb-field"><span>改价确认时间（毫秒）</span><input type="number" min={0} max={60000} value={draft.dwellMs} onChange={e => change({ dwellMs: Number(e.target.value) })} /><small>偏远时等这么久再改价，减少来回撤挂。</small></label>
              <label className="wb-field"><span>每秒请求上限</span><input type="number" min={1} max={10} value={draft.rps} onChange={e => change({ rps: Number(e.target.value) })} /><small>Ondo 未公布限速，默认保守；撤单优先于新挂单。</small></label>
            </div>
            <label className="checkbox-field"><input type="checkbox" checked={draft.wallEnabled} onChange={e => change({ wallEnabled: e.target.checked })} />大单保护：优先挂在同侧大额挂单后一档</label>
            <div className="wb-grid om-grid"><label className="wb-field"><span>大单阈值（USD）</span><input inputMode="decimal" value={draft.wallUsd} disabled={!draft.wallEnabled} onChange={e => change({ wallUsd: e.target.value.trim() })} /><small>挂单前方的他人挂单累计达到此金额才算有保护；区间内找不到就按目标距离挂。买卖价差较宽时，挂单本身可能成为买一或卖一。</small></label></div>
          </fieldset>
          {!active && liveSaved ? <label className="checkbox-field om-confirm om-form"><input type="checkbox" checked={confirmLive} disabled={!!busy} onChange={e => setConfirmLive(e.target.checked)} />我确认用真实资金在 {snapshot.config.markets.join('、')} 挂单，每单 {snapshot.config.orderUsd} USD</label> : null}
          {!active && liveSaved ? <label className="checkbox-field om-form"><input type="checkbox" checked={adoptPositions} disabled={!!busy} onChange={e => setAdoptPositions(e.target.checked)} />已有持仓交给本模块平掉：这些市场里现有的持仓（包括手动开的）会被挂只减仓单平掉；不勾选时，有持仓就不启动</label> : null}
        </section>
        <section className="panel wb-section" aria-label="API Key"><div className="panel-heading"><h2>Ondo API Key</h2><span className="muted">{snapshot.credentials.configured ? `已配置 …${snapshot.credentials.hint ?? ''}` : '尚未配置'}</span></div>
          <form className="wb-key om-form" onSubmit={e => void saveKey(e)} autoComplete="off">
            <label className="wb-field wide"><span>Key ID</span><input type="password" value={keyId} onChange={e => setKeyId(e.target.value)} placeholder="ondoKeyId_…" autoComplete="off" disabled={snapshot.live && active} /></label>
            <label className="wb-field wide"><span>Secret</span><input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="ondoApiSecret_…" autoComplete="new-password" disabled={snapshot.live && active} /><small>在 Ondo Perps 的 API 管理页创建，只需交易权限，建议绑定服务器 IP 白名单。加密保存，不在页面回显。</small></label>
            <div className="wb-key-actions"><button className="button primary" type="submit" disabled={!!busy || (snapshot.live && active) || !keyId.trim() || !secret.trim()} title={snapshot.recovery && snapshot.credentials.configured ? '遗留挂单清理完成后才能更换' : undefined}>{busy === 'key' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}保存 API Key</button>
              {snapshot.credentials.configured ? <button type="button" className="button secondary" disabled={!!busy || (snapshot.live && active) || !!snapshot.recovery} onClick={() => void execute('clear', '/credentials/clear', 'POST', {}, 'API Key 已清除')}><Trash2 size={15} />清除</button> : null}</div>
          </form></section>
      </div>
    </div>}
  </div>;
}
