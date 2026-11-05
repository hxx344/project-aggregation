import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeftRight, CircleAlert, Coins, KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import type { AeroSafeConfig as SafeConfig, AeroSafePool, AeroSafePosition, AeroSafeState } from './aero-safe-types';
import type { AeroSafe } from './aero-safe-client';
import { autoSellNote, rewardSellTarget, same, tokenOf, units } from './aero-safe-client';
import type { AeroMarket } from './aero-market-client';
import { amount, days, pct, signed, usd } from './aero-market-format';
import { positionMetrics, priceText, quoteOf } from './aero-market-math';
import type { MarketPool } from './aero-market-types';
import type { PositionMetrics } from './aero-market-math';
import './aero-lp.css';
import './aero-safe.css';

const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const time = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? dates.format(ms) : '—');
const short = (address: string | null | undefined) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—');
const txLink = (hash: string) => (/^0x[0-9a-fA-F]{64}$/.test(hash) ? <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)}</a> : hash);
const statusLabels: Record<string, string> = { confirmed: '已确认', reverted: '链上回滚', dropped: '未上链', replaced: '已被替换' };
const eventLabels: Record<string, string> = { job_started: '任务开始', job_done: '任务完成', job_failed: '任务失败', tx_signed: '交易已签名', tx_confirmed: '交易已确认', tx_settled: '交易结清', broadcast_error: '广播报错', pending_check_failed: '核对待确认交易失败' };
const tone = (v: number | null | undefined) => ((v ?? 0) > 0 ? 'up' : (v ?? 0) < 0 ? 'down' : '');

// 与 Safe 白名单池对应的行情池子（Base），并用 Safe 链上读到的现价覆盖快照里的现价。
function livePool(pools: MarketPool[] | undefined, pool: AeroSafePool): MarketPool | null {
  const hit = pools?.find((p) => p.chain === 'base' && same(p.address, pool.address));
  return hit ? { ...hit, tick: pool.tick, sqrtPriceX96: pool.sqrtPriceX96 } : null;
}
// 任务或待上链交易阻止新操作时的原因。
function blockedOf(state: AeroSafeState | null) {
  if (!state) return null;
  const job = state.job;
  return !state.wallet ? '请先在「配置」填写 bot 私钥' : state.paused ? state.pauseReason : job?.status === 'running' ? `${job.label}正在执行` : state.pending && !state.pending.stale ? `上一笔交易（${state.pending.label}）等待上链` : null;
}

function YieldCell({ metrics, market }: { metrics: PositionMetrics | null; market: boolean }) {
  if (!metrics) return <td className="num">—<small>{market ? '估值不可用' : '行情未覆盖本池（在「配置」启用 Base 扫描）'}</small></td>;
  if (!metrics.inRange) return <td className="num as-out">0<small>出区间，没有排放</small></td>;
  if (metrics.aeroPerDay === null) return <td className="num">—<small>本池没有 gauge 排放数据</small></td>;
  const y = metrics.yield;
  return <td className="num" title="排放按本头寸占当前价位质押流动性的份额分配；净年化 = 排放年化 − 无常损失 − 自动调仓的停摆与成本（与行情页同一模型，假设出区间后自动居中重开）">
    {metrics.projected ? '质押后 ' : ''}{amount(metrics.aeroPerDay)} AERO/天
    <small>≈ {usd(metrics.usdPerDay)}/天 · 占质押 {pct(metrics.share, 2)}</small>
    <small>排放年化 {pct(metrics.apr, 0)} · <span className={tone(y?.net)}>净年化 {pct(y?.net, 0)}</span></small>
    {y ? <small>无常损失 {pct(y.impermanent, 0)} · 调仓 {pct(y.rebalance + y.downtime, 0)}</small> : null}
  </td>;
}

function PositionRow({ pool, position, metrics, market, state, disabled, onAction }: { pool: AeroSafePool; position: AeroSafePosition; metrics: PositionMetrics | null; market: boolean; state: AeroSafeState; disabled: boolean; onAction: (action: 'close' | 'stake' | 'unstake', p: AeroSafePosition, penalty: boolean) => void }) {
  const chain = state.chain!;
  const t0 = tokenOf(chain, pool.token0), t1 = tokenOf(chain, pool.token1);
  const inRange = pool.tick >= position.tickLower && pool.tick < position.tickUpper;
  const penaltyBlocks = position.staked && position.penaltyUntilBlock ? Number(position.penaltyUntilBlock) - chain.blockNumber : 0;
  const penalty = penaltyBlocks > 0;
  const raw = (v: number | null, d = 18) => (typeof v === 'number' ? units(BigInt(Math.floor(v)).toString(), d) : '—');
  const m = metrics;
  return <tr>
    <th scope="row">#{position.tokenId}</th>
    <td className="num">{m ? `${priceText(m.low)} – ${priceText(m.high)}` : `tick ${position.tickLower} 至 ${position.tickUpper}`}<small>{m ? `${m.width} · tick ${position.tickLower} 至 ${position.tickUpper}` : '行情未覆盖，只显示 tick'}</small></td>
    <td className={`num ${inRange ? 'as-in' : 'as-out'}`}>{m ? priceText(m.now) : `tick ${pool.tick}`}
      <small>{!inRange ? (pool.tick < position.tickLower ? '低于下沿' : '高于上沿') + (m ? `，${m.toLow > 0 ? `需变动 ${signed(m.toLow)} 回到区间` : `需变动 ${signed(m.toHigh)} 回到区间`}` : '') : m ? `距下沿 ${signed(m.toLow)} · 上沿 ${signed(m.toHigh)}` : '区间内'}</small></td>
    <td className="num">{raw(position.amount0, t0?.decimals)} {t0?.symbol}<small>{raw(position.amount1, t1?.decimals)} {t1?.symbol}</small><small>≈ {usd(m?.valueUsd)}</small></td>
    <YieldCell metrics={m} market={market} />
    <td className="num">{!inRange ? '已出区间' : m ? days(m.daysIn) : '—'}<small>{m ? `日波动 ${pct(m.vol, 2)}` : ''}</small></td>
    <td>{position.staked ? '已质押' : '未质押'}{m?.stakedSeconds != null ? <small>约 {days(m.stakedSeconds / 86_400)}</small> : null}{penalty ? <small className="as-warn">罚没期还剩约 {penaltyBlocks} 块（≈{Math.ceil(penaltyBlocks * 2 / 60)} 分钟）</small> : null}</td>
    <td><div className="as-actions">
      {position.staked ? <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('unstake', position, penalty)}>解押</button>
        : <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('stake', position, false)}>质押</button>}
      <button type="button" className="button secondary" disabled={disabled} onClick={() => onAction('close', position, penalty)}>平仓</button>
    </div></td>
  </tr>;
}

function JobCallouts({ state }: { state: AeroSafeState }) {
  const job = state.job;
  return <>
    {state.configError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{state.configError}</span></div> : null}
    {state.ledgerError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{state.ledgerError}</span></div> : null}
    {state.paused ? <div className="lp-callout warning" role="status"><CircleAlert size={16} /><span>{state.pauseReason}</span></div> : null}
    {state.pending ? <div className="lp-callout warning" role="status"><CircleAlert size={16} /><span>已签名待上链：{state.pending.label}（nonce {state.pending.nonce}，{time(state.pending.at)}）{state.pending.hash.startsWith('0x') ? <> · {txLink(state.pending.hash)}</> : null}{state.ledgerError ? '' : state.pending.stale ? '；已超过 10 分钟，下一次操作会用同一 nonce 提价替换它' : '；结清前不能发新操作'}</span></div> : null}
    {job ? <div className={`lp-callout ${job.status === 'failed' ? 'warning' : job.status === 'done' ? 'success' : ''}`} role="status">{job.status === 'running' ? <LoaderCircle size={16} className="spin" /> : job.status === 'failed' ? <CircleAlert size={16} /> : <ShieldCheck size={16} />}
      <span>{job.label}（{time(job.startedAt)}）：{job.status === 'running' ? job.step ?? '执行中' : job.status === 'done' ? '已完成' : `${job.error}${job.signed ? '（本任务已有交易签名发出，请按下方台账与 Safe 现状核对后再操作）' : '（未签名，可直接重试）'}`}</span></div> : null}
  </>;
}

// 仓位标签：Safe 余额、头寸（价格区间、价值、预计收益与在区间时间）、领奖与兑换、交易台账。
export function AeroSafePositions({ safe, market, onConfig }: { safe: AeroSafe; market: AeroMarket; onConfig: () => void }) {
  const { state, loadError, busy, actionError, read, call, execute } = safe;
  const [swapRoute, setSwapRoute] = useState(0);
  const [swapAmount, setSwapAmount] = useState('');
  const [notice, setNotice] = useState('');
  const chain = state?.chain;
  const blocked = blockedOf(state);
  const disabled = !!busy || !!blocked || !chain;
  const aeroUsd = market.snapshot?.aero.usd ?? null;
  const symbol = (address: string) => tokenOf(chain, address)?.symbol ?? short(address);
  const run = async (action: Parameters<typeof execute>[0], params: Record<string, unknown>, done: string) => { setNotice(''); if (await execute(action, params)) setNotice(done); };
  const positionAction = (pool: AeroSafePool) => (action: 'close' | 'stake' | 'unstake', p: AeroSafePosition, penalty: boolean) => {
    const label = action === 'close' ? '平仓（解押后撤出全部流动性并销毁 NFT，代币回到 Safe）' : action === 'stake' ? '质押到 gauge' : '从 gauge 解押';
    const warning = penalty ? '\n\n头寸仍在提前解押罚没期内，继续将被罚没部分奖励。' : '';
    const sell = action === 'stake' ? '' : autoSellNote(state);
    if (!window.confirm(`${pool.name} #${p.tokenId}：${label}？${warning}${sell}`)) return;
    void run(action, { tokenId: p.tokenId, ...(penalty ? { acceptPenalty: true } : {}) }, `已开始${action === 'close' ? '平仓' : action === 'stake' ? '质押' : '解押'}，进度见上方任务状态。`);
  };
  const swaps = state?.config?.permissions.swaps ?? [];
  const route = swaps[swapRoute];
  const doSwap = (event: FormEvent) => {
    event.preventDefault();
    if (!route || !swapAmount.trim()) return;
    if (window.confirm(`用 Safe 的 ${swapAmount.trim()} ${symbol(route.tokenIn)} 兑换 ${symbol(route.tokenOut)}（CL${route.tickSpacing}）？\n\n最小成交量按报价扣 ${(state?.config?.slippageBps ?? 50) / 100}% 滑点。`)) void run('swap', { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount: swapAmount.trim() }, '已开始兑换。');
  };
  const earned = chain?.pools.reduce((sum, p) => sum + BigInt(p.earned || '0'), 0n) ?? 0n;
  const aero = chain?.tokens.find((t) => t.symbol === 'AERO');
  const sellTarget = rewardSellTarget(state);
  // 各头寸的估算，以及按价值加权的合计。
  const rows = useMemo(() => (chain?.pools ?? []).map((pool) => {
    const live = livePool(market.snapshot?.pools, pool);
    return { pool, live, metrics: new Map(pool.positions.map((p) => [p.tokenId, live ? positionMetrics(live, p, aeroUsd, chain?.blockNumber ?? null) : null])) };
  }), [chain, market.snapshot, aeroUsd]);
  const all = rows.flatMap((r) => [...r.metrics.values()]).filter((m): m is PositionMetrics => !!m);
  const positionCount = rows.reduce((n, r) => n + r.pool.positions.length, 0);
  const totalValue = all.every((m) => m.valueUsd !== null) && all.length === positionCount ? all.reduce((s, m) => s + m.valueUsd!, 0) : null;
  const perDay = all.filter((m) => !m.projected && m.usdPerDay !== null);
  const usdPerDay = perDay.length ? perDay.reduce((s, m) => s + m.usdPerDay!, 0) : null;
  const aeroPerDay = perDay.length ? perDay.reduce((s, m) => s + m.aeroPerDay!, 0) : null;
  const priced = new Map((market.snapshot?.pools ?? []).filter((p) => p.chain === 'base').flatMap((p) => [p.token0, p.token1]).map((t) => [t.address.toLowerCase(), t.usd]));
  const tokenUsd = (address: string, raw: string | null, decimals: number) => { const p = priced.get(address.toLowerCase()); return p == null || raw === null ? null : (Number(raw) / 10 ** decimals) * p; };

  return <>
    <div className="lp-heading"><div><p>Safe 的余额与头寸；收益与在区间时间用「行情」的排放、质押流动性与波动率估算，现价取 Safe 链上快照</p></div><div className="lp-toolbar">
      <button className="button secondary" disabled={!!busy || !state?.configured} onClick={() => void call('refresh', '/refresh', 'POST', {}).then(() => read())}><RefreshCw size={15} className={state?.refreshing ? 'spin' : ''} />刷新链上</button>
    </div></div>
    {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    {notice ? <div className="lp-callout success" role="status">{notice}</div> : null}
    {loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>状态读取失败：{loadError}</span></div> : null}
    {market.loadError && !market.snapshot ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>行情读取失败，收益估算不可用：{market.loadError}</span></div> : null}
    {!state ? <section className="panel lp-empty" role="status"><LoaderCircle className="spin" /><strong>正在读取状态</strong></section> : <>
      <JobCallouts state={state} />
      {!state.configured ? <div className="lp-callout" role="status"><CircleAlert size={16} /><span>尚未配置 Safe 实盘。<button type="button" className="as-link" onClick={onConfig}>前往「配置」</button></span></div> : null}

      <section className="panel lp-status" aria-label="Safe 状态">
        <dl className="lp-facts">
          <div><dt>仓位总值（估）</dt><dd>{usd(totalValue)}<small>{positionCount} 个头寸</small></dd></div>
          <div><dt>预计日收益</dt><dd>{usdPerDay === null ? '—' : `${usd(usdPerDay)}/天`}<small>{aeroPerDay === null ? '无在区间的质押头寸' : `${amount(aeroPerDay)} AERO/天${totalValue ? ` · 年化 ${pct((usdPerDay! * 365) / totalValue, 0)}` : ''}`}</small></dd></div>
          <div><dt>待领 AERO</dt><dd>{aero ? units(earned.toString(), aero.decimals) : '—'}<small>{aero && aeroUsd !== null ? `≈ ${usd((Number(earned) / 10 ** aero.decimals) * aeroUsd)} · ` : ''}{state.config?.autoSellRewards && sellTarget ? `领取后自动卖成 ${sellTarget}（≥ ${state.config.minRewardSell}）` : '领取后不自动卖出'}</small></dd></div>
          <div><dt>Safe</dt><dd>{short(state.config?.safe)}<small>Roles {short(state.config?.roles)}</small></dd></div>
          <div><dt>bot</dt><dd>{short(state.wallet)}<small>{chain?.botEth != null ? `${units(chain.botEth, 18)} ETH 付 gas` : '未读取'}</small></dd></div>
          <div><dt>链上快照</dt><dd>{chain ? `区块 ${chain.blockNumber}` : '—'}<small>{state.chainError ? `读取失败：${state.chainError}` : state.refreshing ? '正在读取…' : time(state.chainAt)}</small></dd></div>
          {chain?.tokens.map((t) => <div key={t.address}><dt>Safe {t.symbol}</dt><dd>{units(t.balance, t.decimals)}{(() => {
            const a = chain.allowances.find((x) => same(x.token, t.address)), v = tokenUsd(t.address, t.balance, t.decimals);
            return <small>{v !== null ? `≈ ${usd(v)}` : ''}{v !== null && a ? ' · ' : ''}{a ? `今日额度剩余 ${units(a.remaining, t.decimals)} / ${units(a.perDay, t.decimals)}` : ''}</small>;
          })()}</dd></div>)}
        </dl>
        <div className="as-toolbar">
          <button type="button" className="button secondary" disabled={disabled || earned === 0n} onClick={() => { if (window.confirm(`领取全部 gauge 的 AERO 排放到 Safe？${autoSellNote(state)}`)) void run('claim', {}, '已开始领取。'); }}>{busy === 'claim' ? <LoaderCircle size={15} className="spin" /> : <Coins size={15} />}领取排放</button>
          <button type="button" className="button secondary" disabled={disabled || !aero || aero.balance === '0' || !sellTarget} title={sellTarget ? undefined : '白名单里没有卖出 AERO 的路径'} onClick={() => { if (window.confirm(`把 Safe 里的全部 AERO 卖成 ${sellTarget}（不超过今日额度）？`)) void run('sell', {}, '已开始卖出。'); }}>{busy === 'sell' ? <LoaderCircle size={15} className="spin" /> : <ArrowLeftRight size={15} />}卖出 AERO</button>
          {blocked ? <span className="as-muted">{blocked}</span> : <span className="as-muted">开仓在「行情」的池详情页选区间后进行</span>}
        </div>
        {chain?.ownedNfts != null && chain.ownedScanned != null && BigInt(chain.ownedNfts) > BigInt(chain.ownedScanned) ? <p className="as-muted">Safe 持有 {chain.ownedNfts} 个头寸 NFT，未质押头寸只列出索引最靠后的 {chain.ownedScanned} 个，另含本系统开出的头寸（已质押的全部列出）。</p> : null}
        {rows.map(({ pool, live, metrics }) => {
          const q = live ? quoteOf(live) : null;
          return <div key={pool.address} className="as-pool">
            <h3>{pool.name} <small>{q && live ? `现价 ${priceText(q.price(pool.tick))}（${q.label}）· 24h ${signed(live.change24h)} · 日波动 24h ${pct(live.vol24h?.daily, 2)} / 7d ${pct(live.vol7d?.daily, 2)} · TVL ${usd(live.tvlUsd)} · 池子日排放 ${live.emissionPerSec === null ? '—' : `${amount(live.emissionPerSec * 86_400)} AERO`}` : `tick ${pool.tick}`} · 待领 {aero ? units(pool.earned, aero.decimals) : pool.earned} AERO</small></h3>
            <div className="lp-table-scroll"><table className="lp-table as-table"><thead><tr><th>头寸</th><th className="num">价格区间{q ? `（${q.quote}/${q.base}）` : ''}</th><th className="num">现价位置</th><th className="num">持有（估）</th><th className="num">预计收益</th><th className="num" title="按日波动的无漂移随机游走估算首次离开区间的期望时间">预计在区间</th><th>质押</th><th>操作</th></tr></thead><tbody>
              {pool.positions.length ? pool.positions.map((p) => <PositionRow key={p.tokenId} pool={pool} position={p} metrics={metrics.get(p.tokenId) ?? null} market={!!live} state={state} disabled={disabled} onAction={positionAction(pool)} />)
                : <tr><td colSpan={8} className="lp-table-empty">Safe 在本池暂无头寸</td></tr>}
            </tbody></table></div>
          </div>;
        })}
        {positionCount ? <p className="as-muted">预计收益按本头寸占当前价位质押流动性的份额分配池子排放（排放与流动性取行情快照，约每 {market.snapshot?.config.intervalMin ?? '—'} 分钟更新）；未质押头寸显示质押后的预计值。预计在区间与净年化用 24h 与 7d 日波动中较大者，模型同「行情」页说明，只作估算。</p> : null}
      </section>

      {swaps.length ? <form className="panel lp-section" onSubmit={doSwap} aria-label="手动兑换"><div className="panel-heading"><h2>手动兑换</h2><span className="muted">只能走白名单路由，收款方固定为 Safe</span></div>
        <div className="as-form as-pad">
          <label>路由<select value={swapRoute} onChange={(e) => setSwapRoute(Number(e.target.value))}>{swaps.map((s, i) => <option key={i} value={i}>{symbol(s.tokenIn)} → {symbol(s.tokenOut)}（CL{s.tickSpacing}）</option>)}</select></label>
          <label>卖出数量<input value={swapAmount} inputMode="decimal" onChange={(e) => setSwapAmount(e.target.value)} placeholder={route ? `Safe 有 ${units(tokenOf(chain, route.tokenIn)?.balance, tokenOf(chain, route.tokenIn)?.decimals ?? 18)}` : ''} /></label>
          <button className="button secondary" type="submit" disabled={disabled || !swapAmount.trim()}>{busy === 'swap' ? <LoaderCircle size={15} className="spin" /> : <ArrowLeftRight size={15} />}兑换</button>
        </div>
      </form> : null}

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
  </>;
}

type Draft = { rpcUrl: string; safe: string; roles: string; slippageBps: string; autoSellRewards: boolean; minRewardSell: string; permissions: string };
function draftOf(state: AeroSafeState): Draft {
  const c = state.config;
  return { rpcUrl: c?.rpcUrl ?? state.defaults.rpcUrl, safe: c?.safe ?? '', roles: c?.roles ?? '', slippageBps: String(c?.slippageBps ?? state.defaults.slippageBps),
    autoSellRewards: c?.autoSellRewards ?? state.defaults.autoSellRewards, minRewardSell: c?.minRewardSell ?? state.defaults.minRewardSell, permissions: c ? JSON.stringify(c.permissions, null, 2) : '' };
}
function configOf(draft: Draft): SafeConfig {
  let permissions;
  try { permissions = JSON.parse(draft.permissions); } catch { throw new Error('权限配置不是有效的 JSON。'); }
  const slippageBps = Number(draft.slippageBps);
  if (!Number.isInteger(slippageBps)) throw new Error('滑点须为整数基点。');
  return { rpcUrl: draft.rpcUrl.trim(), safe: draft.safe.trim(), roles: draft.roles.trim(), permissions, slippageBps, autoSellRewards: draft.autoSellRewards, minRewardSell: draft.minRewardSell.trim() };
}

// 配置标签里的 Safe 部分：bot 私钥与 Safe / Roles 配置。
export function AeroSafeConfig({ safe }: { safe: AeroSafe }) {
  const { state, loadError, busy, actionError, setActionError, call } = safe;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (state && !dirty) setDraft(draftOf(state)); }, [state, dirty]);
  const running = state?.job?.status === 'running';
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    let config: SafeConfig;
    try { config = configOf(draft); } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); return; }
    const data = await call('save', '/config', 'PUT', { config });
    if (data) { setDirty(false); setDraft(draftOf(data)); setNotice('配置已保存，正在核对链上 Safe 与 Roles。'); }
  };
  const saveKey = async (event: FormEvent) => { event.preventDefault(); if (await call('key', '/wallet', 'PUT', { privateKey: privateKey.trim() })) { setPrivateKey(''); setNotice('bot 私钥已加密保存。'); } };
  const clearKey = async () => { if (window.confirm('清除已保存的 bot 私钥？')) { if (await call('clear', '/wallet/clear', 'POST', {})) setNotice('bot 私钥已清除。'); } };
  const change = (patch: Partial<Draft>) => { if (draft) { setDraft({ ...draft, ...patch }); setDirty(true); setNotice(''); } };

  return <>
    {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    {notice ? <div className="lp-callout success" role="status">{notice}</div> : null}
    {loadError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>实盘状态读取失败：{loadError}</span></div> : null}
    {!state || !draft ? <section className="panel lp-empty" role="status"><LoaderCircle className="spin" /><strong>正在读取实盘配置</strong></section> : <>
      {state.configError ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{state.configError}</span></div> : null}
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
    </>}
  </>;
}
