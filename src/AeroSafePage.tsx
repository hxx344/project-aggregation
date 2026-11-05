import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeftRight, CircleAlert, Coins, KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import type { AeroSafeConfig, AeroSafePool, AeroSafePosition, AeroSafeState } from './aero-safe-types';
import { autoSellNote, rewardSellTarget, same, tokenOf, units, useAeroSafe } from './aero-safe-client';
import './aero-lp.css';
import './aero-safe.css';

const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const time = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? dates.format(ms) : '—');
const short = (address: string | null | undefined) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—');
const txLink = (hash: string) => (/^0x[0-9a-fA-F]{64}$/.test(hash) ? <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)}</a> : hash);
const statusLabels: Record<string, string> = { confirmed: '已确认', reverted: '链上回滚', dropped: '未上链', replaced: '已被替换' };
const eventLabels: Record<string, string> = { job_started: '任务开始', job_done: '任务完成', job_failed: '任务失败', tx_signed: '交易已签名', tx_confirmed: '交易已确认', tx_settled: '交易结清', broadcast_error: '广播报错', pending_check_failed: '核对待确认交易失败' };

type Draft = { rpcUrl: string; safe: string; roles: string; slippageBps: string; autoSellRewards: boolean; minRewardSell: string; permissions: string };
function draftOf(state: AeroSafeState): Draft {
  const c = state.config;
  return { rpcUrl: c?.rpcUrl ?? state.defaults.rpcUrl, safe: c?.safe ?? '', roles: c?.roles ?? '', slippageBps: String(c?.slippageBps ?? state.defaults.slippageBps),
    autoSellRewards: c?.autoSellRewards ?? state.defaults.autoSellRewards, minRewardSell: c?.minRewardSell ?? state.defaults.minRewardSell, permissions: c ? JSON.stringify(c.permissions, null, 2) : '' };
}
function configOf(draft: Draft): AeroSafeConfig {
  let permissions;
  try { permissions = JSON.parse(draft.permissions); } catch { throw new Error('权限配置不是有效的 JSON。'); }
  const slippageBps = Number(draft.slippageBps);
  if (!Number.isInteger(slippageBps)) throw new Error('滑点须为整数基点。');
  return { rpcUrl: draft.rpcUrl.trim(), safe: draft.safe.trim(), roles: draft.roles.trim(), permissions, slippageBps, autoSellRewards: draft.autoSellRewards, minRewardSell: draft.minRewardSell.trim() };
}

function PositionRow({ pool, position, state, disabled, onAction }: { pool: AeroSafePool; position: AeroSafePosition; state: AeroSafeState; disabled: boolean; onAction: (action: 'close' | 'stake' | 'unstake', p: AeroSafePosition, penalty: boolean) => void }) {
  const chain = state.chain!;
  const t0 = tokenOf(chain, pool.token0), t1 = tokenOf(chain, pool.token1);
  const inRange = pool.tick >= position.tickLower && pool.tick < position.tickUpper;
  const penaltyBlocks = position.staked && position.penaltyUntilBlock ? Number(position.penaltyUntilBlock) - chain.blockNumber : 0;
  const penalty = penaltyBlocks > 0;
  const raw = (v: number | null, d = 18) => (typeof v === 'number' ? units(BigInt(Math.floor(v)).toString(), d) : '—');
  return <tr>
    <th scope="row">#{position.tokenId}</th>
    <td>tick {position.tickLower} 至 {position.tickUpper}</td>
    <td className={inRange ? 'as-in' : 'as-out'}>{inRange ? '区间内' : pool.tick < position.tickLower ? '低于下沿' : '高于上沿'}</td>
    <td>{raw(position.amount0, t0?.decimals)} {t0?.symbol}<br />{raw(position.amount1, t1?.decimals)} {t1?.symbol}</td>
    <td>{position.staked ? '已质押' : '未质押'}{penalty ? <small className="as-warn">罚没期还剩约 {penaltyBlocks} 块（≈{Math.ceil(penaltyBlocks * 2 / 60)} 分钟）</small> : null}</td>
    <td className="as-actions">
      {position.staked ? <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('unstake', position, penalty)}>解押</button>
        : <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('stake', position, false)}>质押</button>}
      <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('close', position, penalty)}>平仓</button>
    </td>
  </tr>;
}

export default function AeroSafePage({ onExpired }: { onExpired: () => void }) {
  const { state, loadError, busy, actionError, setActionError, read, call, execute } = useAeroSafe(onExpired);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [swapRoute, setSwapRoute] = useState(0);
  const [swapAmount, setSwapAmount] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (state && !dirty) setDraft(draftOf(state)); }, [state, dirty]);

  const job = state?.job, chain = state?.chain;
  const running = job?.status === 'running';
  const blocked = !state?.wallet ? '请先填写 bot 私钥' : state.paused ? state.pauseReason : running ? `${job.label}正在执行` : state.pending && !state.pending.stale ? `上一笔交易（${state.pending.label}）等待上链` : null;
  const disabled = !!busy || !!blocked || !chain;
  const symbol = (address: string) => tokenOf(chain, address)?.symbol ?? short(address);
  const run = async (action: Parameters<typeof execute>[0], params: Record<string, unknown>, done: string) => { setNotice(''); if (await execute(action, params)) setNotice(done); };
  const positionAction = (pool: AeroSafePool) => (action: 'close' | 'stake' | 'unstake', p: AeroSafePosition, penalty: boolean) => {
    const label = action === 'close' ? '平仓（解押后撤出全部流动性并销毁 NFT，代币回到 Safe）' : action === 'stake' ? '质押到 gauge' : '从 gauge 解押';
    const warning = penalty ? '\n\n头寸仍在提前解押罚没期内，继续将被罚没部分奖励。' : '';
    const sell = action === 'stake' ? '' : autoSellNote(state);
    if (!window.confirm(`${pool.name} #${p.tokenId}：${label}？${warning}${sell}`)) return;
    void run(action, { tokenId: p.tokenId, ...(penalty ? { acceptPenalty: true } : {}) }, `已开始${action === 'close' ? '平仓' : action === 'stake' ? '质押' : '解押'}，进度见上方任务状态。`);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    let config: AeroSafeConfig;
    try { config = configOf(draft); } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); return; }
    const data = await call('save', '/config', 'PUT', { config });
    if (data) { setDirty(false); setDraft(draftOf(data)); setNotice('配置已保存，正在核对链上 Safe 与 Roles。'); }
  };
  const saveKey = async (event: FormEvent) => { event.preventDefault(); if (await call('key', '/wallet', 'PUT', { privateKey: privateKey.trim() })) { setPrivateKey(''); setNotice('bot 私钥已加密保存。'); } };
  const clearKey = async () => { if (window.confirm('清除已保存的 bot 私钥？')) { if (await call('clear', '/wallet/clear', 'POST', {})) setNotice('bot 私钥已清除。'); } };
  const swaps = state?.config?.permissions.swaps ?? [];
  const route = swaps[swapRoute];
  const doSwap = (event: FormEvent) => {
    event.preventDefault();
    if (!route || !swapAmount.trim()) return;
    if (window.confirm(`用 Safe 的 ${swapAmount.trim()} ${symbol(route.tokenIn)} 兑换 ${symbol(route.tokenOut)}（CL${route.tickSpacing}）？\n\n最小成交量按报价扣 ${(state?.config?.slippageBps ?? 50) / 100}% 滑点。`)) void run('swap', { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount: swapAmount.trim() }, '已开始兑换。');
  };
  const change = (patch: Partial<Draft>) => { if (draft) { setDraft({ ...draft, ...patch }); setDirty(true); setNotice(''); } };
  const earned = chain?.pools.reduce((sum, p) => sum + BigInt(p.earned || '0'), 0n) ?? 0n;
  const aero = chain?.tokens.find((t) => t.symbol === 'AERO');
  const sellTarget = rewardSellTarget(state);

  return <div className="lp-page">
    <header className="lp-heading"><div><h1>Aero 实盘（Safe + Roles）</h1><p>资产与头寸在 Safe；bot 只持 gas，经 Zodiac Roles 在白名单与每日额度内操作，转出路径只有回到 Safe</p></div><div className="lp-toolbar">
      <button className="button secondary" disabled={!!busy || !state?.configured} onClick={() => void call('refresh', '/refresh', 'POST', {}).then(() => read())}><RefreshCw size={15} className={state?.refreshing ? 'spin' : ''} />刷新链上</button>
    </div></header>
    {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    {notice ? <div className="lp-callout success" role="status">{notice}</div> : null}
    {loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>状态读取失败：{loadError}</span></div> : null}
    {!state || !draft ? <section className="panel lp-empty" role="status"><LoaderCircle className="spin" /><strong>正在读取状态</strong></section> : <>
      {state.configError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{state.configError}</span></div> : null}
      {state.ledgerError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{state.ledgerError}</span></div> : null}
      {state.paused ? <div className="lp-callout warning" role="status"><CircleAlert size={16} /><span>{state.pauseReason}</span></div> : null}
      {state.pending ? <div className="lp-callout warning" role="status"><CircleAlert size={16} /><span>已签名待上链：{state.pending.label}（nonce {state.pending.nonce}，{time(state.pending.at)}）{state.pending.hash.startsWith('0x') ? <> · {txLink(state.pending.hash)}</> : null}{state.ledgerError ? '' : state.pending.stale ? '；已超过 10 分钟，下一次操作会用同一 nonce 提价替换它' : '；结清前不能发新操作'}</span></div> : null}
      {job ? <div className={`lp-callout ${job.status === 'failed' ? 'warning' : job.status === 'done' ? 'success' : ''}`} role="status">{job.status === 'running' ? <LoaderCircle size={16} className="spin" /> : job.status === 'failed' ? <CircleAlert size={16} /> : <ShieldCheck size={16} />}
        <span>{job.label}（{time(job.startedAt)}）：{job.status === 'running' ? job.step ?? '执行中' : job.status === 'done' ? '已完成' : `${job.error}${job.signed ? '（本任务已有交易签名发出，请按下方台账与 Safe 现状核对后再操作）' : '（未签名，可直接重试）'}`}</span></div> : null}

      <section className="panel lp-status" aria-label="Safe 状态">
        <dl className="lp-facts">
          <div><dt>Safe</dt><dd>{short(state.config?.safe)}<small>Roles {short(state.config?.roles)}</small></dd></div>
          <div><dt>bot</dt><dd>{short(state.wallet)}<small>{chain?.botEth != null ? `${units(chain.botEth, 18)} ETH 付 gas` : '未读取'}</small></dd></div>
          <div><dt>链上快照</dt><dd>{chain ? `区块 ${chain.blockNumber}` : '—'}<small>{state.chainError ? `读取失败：${state.chainError}` : state.refreshing ? '正在读取…' : time(state.chainAt)}</small></dd></div>
          <div><dt>待领 AERO</dt><dd>{aero ? units(earned.toString(), aero.decimals) : '—'}<small>{state.config?.autoSellRewards && sellTarget ? `领取后自动卖成 ${sellTarget}（≥ ${state.config.minRewardSell}）` : '领取后不自动卖出'}</small></dd></div>
          {chain?.tokens.map((t) => <div key={t.address}><dt>Safe {t.symbol}</dt><dd>{units(t.balance, t.decimals)}{(() => { const a = chain.allowances.find((x) => same(x.token, t.address)); return a ? <small>今日额度剩余 {units(a.remaining, t.decimals)} / {units(a.perDay, t.decimals)}</small> : null; })()}</dd></div>)}
        </dl>
        <div className="as-toolbar">
          <button type="button" className="button secondary" disabled={disabled || earned === 0n} onClick={() => { if (window.confirm(`领取全部 gauge 的 AERO 排放到 Safe？${autoSellNote(state)}`)) void run('claim', {}, '已开始领取。'); }}>{busy === 'claim' ? <LoaderCircle size={15} className="spin" /> : <Coins size={15} />}领取排放</button>
          <button type="button" className="button secondary" disabled={disabled || !aero || aero.balance === '0' || !sellTarget} title={sellTarget ? undefined : '白名单里没有卖出 AERO 的路径'} onClick={() => { if (window.confirm(`把 Safe 里的全部 AERO 卖成 ${sellTarget}（不超过今日额度）？`)) void run('sell', {}, '已开始卖出。'); }}>{busy === 'sell' ? <LoaderCircle size={15} className="spin" /> : <ArrowLeftRight size={15} />}卖出 AERO</button>
          {blocked ? <span className="as-muted">{blocked}</span> : <span className="as-muted">开仓在 Aero 市场的池详情页选区间后进行</span>}
        </div>
        {chain?.ownedNfts != null && chain.ownedScanned != null && BigInt(chain.ownedNfts) > BigInt(chain.ownedScanned) ? <p className="as-muted">Safe 持有 {chain.ownedNfts} 个头寸 NFT，未质押头寸只列出索引最靠后的 {chain.ownedScanned} 个，另含本系统开出的头寸（已质押的全部列出）。</p> : null}
        {chain?.pools.map((pool) => <div key={pool.address} className="as-pool">
          <h3>{pool.name} <small>tick {pool.tick} · 待领 {aero ? units(pool.earned, aero.decimals) : pool.earned} AERO</small></h3>
          <div className="lp-table-scroll"><table className="lp-table"><thead><tr><th>头寸</th><th>区间</th><th>现价</th><th>持有（估）</th><th>质押</th><th>操作</th></tr></thead><tbody>
            {pool.positions.length ? pool.positions.map((p) => <PositionRow key={p.tokenId} pool={pool} position={p} state={state} disabled={disabled} onAction={positionAction(pool)} />)
              : <tr><td colSpan={6} className="lp-table-empty">Safe 在本池暂无头寸</td></tr>}
          </tbody></table></div>
        </div>)}
      </section>

      {swaps.length ? <form className="panel lp-section" onSubmit={doSwap} aria-label="手动兑换"><div className="panel-heading"><h2>手动兑换</h2><span className="muted">只能走白名单路由，收款方固定为 Safe</span></div>
        <div className="as-form as-pad">
          <label>路由<select value={swapRoute} onChange={(e) => setSwapRoute(Number(e.target.value))}>{swaps.map((s, i) => <option key={i} value={i}>{symbol(s.tokenIn)} → {symbol(s.tokenOut)}（CL{s.tickSpacing}）</option>)}</select></label>
          <label>卖出数量<input value={swapAmount} inputMode="decimal" onChange={(e) => setSwapAmount(e.target.value)} placeholder={route ? `Safe 有 ${units(tokenOf(chain, route.tokenIn)?.balance, tokenOf(chain, route.tokenIn)?.decimals ?? 18)}` : ''} /></label>
          <button className="button secondary" type="submit" disabled={disabled || !swapAmount.trim()}>{busy === 'swap' ? <LoaderCircle size={15} className="spin" /> : <ArrowLeftRight size={15} />}兑换</button>
        </div>
      </form> : null}

      <section className="panel lp-section" aria-label="bot 私钥"><div className="panel-heading"><h2>bot 私钥</h2><span className="muted">{state.wallet ? `当前 ${state.wallet}` : '尚未设置'}</span></div>
        <form className="lp-key" onSubmit={saveKey} autoComplete="off">
          <label className="lp-field wide"><span>{state.wallet ? '更换私钥' : '私钥'}</span><input type="password" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="0x 开头的 64 位十六进制" autoComplete="new-password" spellCheck={false} disabled={!!busy || running} /><small>只写入不回显，服务器用工作台凭据密钥加密保存。这个地址须已在 Roles 上被分配角色；只放少量 ETH 付 gas。</small></label>
          <div className="lp-key-actions"><button className="button primary" type="submit" disabled={!!busy || running || !privateKey.trim()}>{busy === 'key' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}保存私钥</button>{state.wallet ? <button className="button secondary" type="button" disabled={!!busy || running} onClick={() => void clearKey()}><Trash2 size={15} />清除私钥</button> : null}</div>
        </form>
      </section>

      <form className="panel lp-section" onSubmit={(e) => void save(e)} noValidate aria-label="Safe 配置"><div className="panel-heading"><h2>Safe 配置</h2><span className="muted">保存时核对 chainId、Roles 的 avatar/target 与 Safe 已启用该模块</span></div>
        <fieldset disabled={!!busy || running}>
          <div className="lp-grid">
            <label className="lp-field wide"><span>Base RPC（http/https）</span><input value={draft.rpcUrl} spellCheck={false} onChange={(e) => change({ rpcUrl: e.target.value })} /></label>
            <label className="lp-field wide"><span>Safe 地址</span><input value={draft.safe} spellCheck={false} onChange={(e) => change({ safe: e.target.value })} /></label>
            <label className="lp-field wide"><span>Roles 模块地址</span><input value={draft.roles} spellCheck={false} onChange={(e) => change({ roles: e.target.value })} /></label>
            <label className="lp-field"><span>默认滑点（bps）</span><input value={draft.slippageBps} inputMode="numeric" onChange={(e) => change({ slippageBps: e.target.value })} /><small>1–500</small></label>
            <label className="lp-field"><span>最小卖出 AERO</span><input value={draft.minRewardSell} inputMode="decimal" onChange={(e) => change({ minRewardSell: e.target.value })} /><small>低于此数量不自动卖</small></label>
            <label className="lp-field as-check"><span>领奖后自动卖成 WETH</span><input type="checkbox" checked={draft.autoSellRewards} onChange={(e) => change({ autoSellRewards: e.target.checked })} /></label>
            <label className="lp-field wide"><span>权限配置（与 tools/aero-roles 部署用的 config.json 相同）</span><textarea rows={10} value={draft.permissions} spellCheck={false} onChange={(e) => change({ permissions: e.target.value })} /><small>只影响本地预校验与页面展示；真正的权限以链上 Roles 为准，改动链上权限须用硬件钱包签 Safe 交易。</small></label>
          </div>
        </fieldset>
        <div className="lp-form-actions"><span>{dirty ? '有未保存的修改' : '配置已同步'}</span><div><button type="button" className="button secondary" disabled={!dirty || !!busy} onClick={() => { setDraft(draftOf(state)); setDirty(false); }}>放弃修改</button><button className="button primary" type="submit" disabled={!dirty || !!busy || running}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存配置</button></div></div>
      </form>

      <section className="panel lp-section" aria-label="交易记录"><div className="panel-heading"><h2>交易记录</h2><span className="muted">最近 30 笔，完整记录在数据目录 aero-safe/txs.jsonl</span></div>
        {state.ledger.length ? <div className="lp-table-scroll"><table className="lp-table"><thead><tr><th>时间</th><th>操作</th><th>结果</th><th>交易</th><th>Gas</th></tr></thead><tbody>
          {state.ledger.map((e) => <tr key={e.hash}><td>{time(e.at)}</td><td>{e.label}</td><td className={e.status === 'confirmed' ? 'as-in' : 'as-out'}>{statusLabels[e.status] ?? e.status}</td><td>{txLink(e.hash)}</td><td>{e.fee ? `${units(e.fee, 18)} ETH` : '—'}</td></tr>)}
        </tbody></table></div> : <p className="lp-table-empty">暂无交易。</p>}
      </section>
      <section className="panel lp-section" aria-label="最近事件"><div className="panel-heading"><h2>最近事件</h2><span className="muted">工作台本次启动后最多 50 条</span></div>
        {state.events.length ? <ol className="lp-events">{[...state.events].reverse().map((e, i) => <li key={`${e.at}:${i}`} className={e.event === 'job_failed' || e.event === 'broadcast_error' ? 'bad' : ''}><time>{time(e.at)}</time><strong>{eventLabels[String(e.event)] ?? String(e.event ?? '')}</strong>
          <span className="lp-event-detail">{Object.entries(e).filter(([k, v]) => k !== 'at' && k !== 'event' && k !== 'job' && v != null).map(([k, v]) => <span key={k}>{k === 'hash' && typeof v === 'string' ? txLink(v) : `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`}</span>)}</span></li>)}</ol>
          : <p className="lp-table-empty">暂无事件。</p>}
      </section>
    </>}
  </div>;
}
