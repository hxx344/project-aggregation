import { useEffect, useState } from 'react';
import { CircleAlert, ListPlus, LoaderCircle, Play, ScanSearch, ShieldCheck } from 'lucide-react';
import type { MarketPool } from './aero-market-types';
import type { AeroSafePreview } from './aero-safe-types';
import { CHANGE_TIMEOUT_MS, exactUnits, rawUnits, same, tokenOf, units, useAeroSafe } from './aero-safe-client';
import { openAeroTab } from './aero-nav';
import './aero-safe.css';

const PREVIEW_TTL_MS = 2 * 60_000;
type OpenCap = { usd: number; usd0: number; usd1: number };
// 新代币每日额度的默认值：约合这么多美元（按市场页的代币价折算），可改。
const DEFAULT_ALLOWANCE_USD = 1000;

function defaultAllowance(usd: number | null, decimals: number) {
  if (!usd || !(usd > 0)) return '';
  const value = DEFAULT_ALLOWANCE_USD / usd;
  const digits = Math.max(0, Math.min(decimals, 4 - Math.floor(Math.log10(value))));
  const text = value.toFixed(digits);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

// 不在白名单的池子：加入待加池（可多个并行），在「配置」→ 白名单变更里合成一份 Safe 批次，
// 硬件钱包在 Safe{Wallet} 执行后，服务端以 bot 身份模拟核对生效，再并入配置。
function AddPool({ pool, safe }: { pool: MarketPool; safe: ReturnType<typeof useAeroSafe> }) {
  const { state, busy, call } = safe;
  const known = state?.config?.permissions.allowances ?? [];
  const changes = state?.changes;
  const queued = changes?.pools.find((p) => same(p.address, pool.address));
  const pendingOf = (token: string) => changes?.allowances.find((a) => same(a.token, token));
  // 已有额度（配置或其他待加池）的代币沿用；只有全新的代币要填。
  const fresh = [pool.token0, pool.token1].filter((t) => !known.some((a) => same(a.token, t.address)) && !pendingOf(t.address));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(fresh.map((t) => [t.address, defaultAllowance(t.usd, t.decimals)])));
  const missing = fresh.find((t) => rawUnits(amounts[t.address] ?? '', t.decimals) === null);
  const add = () => {
    if (missing) return;
    void call('queue', '/changes/pool', 'POST', { pool: pool.address, allowances: Object.fromEntries(fresh.map((t) => [t.address, amounts[t.address]])) }, CHANGE_TIMEOUT_MS);
  };
  const others = (changes?.pools.length ?? 0) - (queued ? 1 : 0);
  if (queued) {
    const newTokens = [queued.token0, queued.token1].filter((t) => !known.some((a) => same(a.token, t.address)));
    return <>
      <p className="as-muted">这个池子已在待加池里（{new Date(queued.addedAt).toLocaleString('zh-CN')} 加入）{others ? `，另有 ${others} 个待加池` : ''}。在「配置」→ 白名单变更里生成 Safe 批次，由硬件钱包在 Safe{'{'}Wallet{'}'} 执行后核对启用。</p>
      {queued.gaugeStatus?.state !== 'alive' ? <div className="lp-callout warning" role="status">gauge 状态未知：{queued.gaugeStatus?.note ?? '加入时未核对 gauge 是否已被停用'}。零排放不一定是停用，请自行确认该池 gauge 仍在发放排放后再执行批次。</div> : null}
      {newTokens.length ? <p className="as-muted">新代币每日额度：{newTokens.map((t) => { const a = pendingOf(t.address); return `${t.symbol} ${a ? exactUnits(a.perDay, a.decimals) : '—'}`; }).join('；')}（可在白名单变更里修改）</p> : null}
      <div className="as-form">
        <button type="button" className="button primary" onClick={() => openAeroTab('config')}><ShieldCheck size={15} />前往「配置」生成批次</button>
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void call('unqueue', '/changes/remove', 'POST', { pool: pool.address })}>移出待加池</button>
      </div>
    </>;
  }
  return <>
    <p className="as-muted">这个池子不在 Roles 白名单里，bot 还不能在此开仓。加入待加池后，可与其他待加池、额度调整合成一份 Safe 批次：增加该池的 gauge、开仓与质押权限、新代币的授权与每日额度，以及该池两个方向的配平兑换；由硬件钱包在 Safe{'{'}Wallet{'}'} 执行后启用。加入时会核对 gauge 是否已被停用（Voter 的激活状态与 gauge 工厂的排放上限）：未激活或排放上限已清零的拒绝，读不到时标为「gauge 状态未知」。</p>
    {others ? <p className="as-muted">已有 {others} 个待加池，会合进同一份批次。</p> : null}
    <div className="as-form">
      {fresh.map((t) => <label key={t.address}>{t.symbol} 每日额度
        <input inputMode="decimal" value={amounts[t.address] ?? ''} onChange={(e) => setAmounts((prev) => ({ ...prev, [t.address]: e.target.value.trim() }))} />
        <small className="as-muted">{t.usd && Number(amounts[t.address]) > 0 ? `约 $${Math.round(Number(amounts[t.address]) * t.usd).toLocaleString('zh-CN')}` : '\u00a0'}</small>
      </label>)}
      {fresh.length === 0 ? <span className="as-muted">两种代币已有每日额度，沿用现有额度。</span> : null}
      <button type="button" className="button secondary" disabled={!!busy || !!missing} title={missing ? `请填写 ${missing.symbol} 的每日额度` : undefined} onClick={add}>{busy === 'queue' ? <LoaderCircle size={15} className="spin" /> : <ListPlus size={15} />}加入待加池</button>
    </div>
    {fresh.length ? <p className="as-muted">每日额度是 bot 每 24 小时最多能投入开仓或卖出兑换的数量，bot 私钥泄露时损失也以此为上限；已有代币的额度在「配置」→ 白名单变更里调整。</p> : null}
  </>;
}


// 池详情页里的实盘开仓：按页面上选定的区间（默认推荐区间），用 Safe 里的余额经 Roles 开仓并质押。先预览，再确认执行。
export default function AeroSafePanel({ pool, range, onExpired }: { pool: MarketPool; range: [number, number]; onExpired: () => void }) {
  const safe = useAeroSafe(onExpired);
  const { state, loadError, busy, actionError, execute, preview: requestPreview } = safe;
  const [shareText, setShareText] = useState('100');
  const [capText, setCapText] = useState('');
  const [rebalance, setRebalance] = useState(true);
  const [preview, setPreview] = useState<{ key: string; data: AeroSafePreview; at: number; cap: OpenCap | null } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const share = Number(shareText);
  const shareBps = Number.isFinite(share) && share > 0 && share <= 100 ? Math.round(share * 100) : null;
  // 投入上限（美元，选填）：按行情里的两币美元价估值，超过时两币等比缩小；开仓沿用预览时的价格。
  const capUsd = capText.trim() === '' ? null : Number(capText);
  const priced = !!pool.token0.usd && pool.token0.usd > 0 && !!pool.token1.usd && pool.token1.usd > 0;
  const capInvalid = capUsd !== null && (!Number.isFinite(capUsd) || capUsd <= 0 || !priced);
  const cap: OpenCap | null = capUsd !== null && !capInvalid ? { usd: capUsd, usd0: pool.token0.usd!, usd1: pool.token1.usd! } : null;
  const key = `${range[0]}:${range[1]}:${shareBps}:${rebalance}:${capUsd ?? ''}`;
  const whitelisted = state?.config?.permissions.pools.find((p) => (same(p.token0, pool.token0.address) && same(p.token1, pool.token1.address) && p.tickSpacing === pool.tickSpacing));
  const chainPool = state?.chain?.pools.find((p) => same(p.address, pool.address));
  const job = state?.job;
  const running = job?.status === 'running';
  // 任务结束后 Safe 余额已变，旧预览作废；预览本身超过有效期也作废（服务端同样拒绝）。
  useEffect(() => { if (job && job.status !== 'running') setPreview(null); }, [job?.id, job?.status]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const expired = preview ? clock - preview.at > PREVIEW_TTL_MS - 10_000 : false;
  const blocked = !state?.wallet ? '请先在 Aero「配置」填写 bot 私钥' : state.paused ? state.pauseReason : running ? `${job.label}正在执行` : state.pending && !state.pending.stale ? `上一笔交易（${state.pending.label}）等待上链` : null;
  const t0 = tokenOf(state?.chain, pool.token0.address), t1 = tokenOf(state?.chain, pool.token1.address);
  const amount = (raw: string | null | undefined, token: typeof t0) => (token ? `${units(raw, token.decimals)} ${token.symbol}` : '—');
  // 每日额度按兑换卖出量与开仓投入量合计消耗，24 小时周期内补满。
  const allowanceText = (p: AeroSafePreview) => {
    const rows = (p.allowance ?? []).filter((a) => BigInt(a.need) > 0n);
    if (!rows.length) return '';
    return `消耗今日额度 ${rows.map((a) => { const token = tokenOf(state?.chain, a.token); return `${amount(a.need, token)}（剩 ${a.remaining == null ? '无额度' : amount(a.remaining, token)}）`; }).join('、')}。`;
  };

  const runPreview = async () => {
    if (shareBps === null || capInvalid) return;
    const data = await requestPreview({ pool: pool.address, tickLower: range[0], tickUpper: range[1], shareBps, rebalance, ...(cap ? { cap } : {}) });
    if (data) { const at = Date.now(); setPreview({ key, data, at, cap }); setClock(at); }
  };
  const open = () => {
    if (!preview || preview.key !== key || expired || shareBps === null || preview.data.allowanceShort) return;
    const p = preview.data;
    const slippage = (state?.config?.slippageBps ?? 50) / 100;
    const lines = [`在 ${pool.token0.symbol}/${pool.token1.symbol} CL${pool.tickSpacing} 开仓：tick ${range[0]} 至 ${range[1]}`,
      `投入 Safe 余额的 ${shareBps / 100}%${preview.cap ? `，上限 $${preview.cap.usd.toLocaleString('zh-CN')}${p.capped ? '（已按上限缩减）' : '（未触及）'}` : ''}：${amount(p.amount0, t0)} + ${amount(p.amount1, t1)}`,
      p.swap ? `先配平兑换 ${amount(p.swap.amountIn, tokenOf(state?.chain, p.swap.tokenIn))}` : '不兑换',
      `兑换与开仓的最小成交量按报价扣 ${slippage}% 滑点；执行时余额偏离预览超过 1%、配平兑换超出预览 10% 或方向改变都会停止。`,
      '开仓后自动质押到 gauge；提前解押会被罚没部分奖励。'];
    if (state?.pending?.stale) lines.push(`上一笔交易（${state.pending.label}）超过 10 分钟未上链，本次会用同一 nonce 提价替换它。`);
    const expect = { previewedAt: p.previewedAt, amount0: p.amount0, amount1: p.amount1, swapIn: p.swap?.amountIn ?? null, swapTokenIn: p.swap?.tokenIn ?? null };
    if (window.confirm(`${lines.join('\n')}\n\n确认由 bot 经 Roles 发送？`)) void execute('open', { pool: pool.address, tickLower: range[0], tickUpper: range[1], shareBps, rebalance, ...(preview.cap ? { cap: preview.cap } : {}), expect });
  };

  const body = () => {
    if (!state) return <p className="as-muted">{loadError ? `读取实盘状态失败：${loadError}` : '正在读取实盘状态…'}</p>;
    if (!state.configured) return <p className="as-muted">尚未配置 Safe 实盘。<button type="button" className="as-link" onClick={() => openAeroTab('config')}>前往「配置」</button></p>;
    if (!whitelisted) return <AddPool pool={pool} safe={safe} />;
    if (!chainPool) return <p className="as-muted">{state.chainError ? `链上读取失败：${state.chainError}` : '正在读取 Safe 链上状态…'}</p>;
    const stale = preview && (preview.key !== key || expired);
    return <>
      <div className="as-row">
        <span>Safe 余额：{amount(t0?.balance, t0)} · {amount(t1?.balance, t1)}</span>
        <span>本池头寸 {chainPool.positions.length} 个{chainPool.positions.length ? <button type="button" className="as-link" onClick={() => openAeroTab('positions')}>在「仓位」管理</button> : null}</span>
      </div>
      <div className="as-form">
        <label>投入比例（%）<input type="number" min={1} max={100} step={1} value={shareText} onChange={(e) => setShareText(e.target.value)} /></label>
        <label>投入上限（美元，选填）<input inputMode="decimal" placeholder="不限" value={capText} onChange={(e) => setCapText(e.target.value)} />
          {capInvalid ? <small className="as-muted">{priced ? '须为正数' : '行情缺少代币美元价，暂不能按美元设上限'}</small> : null}</label>
        <label className="as-check"><input type="checkbox" checked={rebalance} onChange={(e) => setRebalance(e.target.checked)} />按区间比例先兑换配平</label>
        <span className="as-range">tick {range[0]} 至 {range[1]}</span>
        <button type="button" className="button secondary" disabled={!!busy || shareBps === null || capInvalid || range[0] >= range[1]} onClick={() => void runPreview()}>{busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <ScanSearch size={15} />}预览</button>
        <button type="button" className="button primary" disabled={!!busy || !!blocked || !preview || !!stale || !!preview.data.allowanceShort} title={blocked ?? (stale ? (expired ? '预览已过期，请重新预览' : '区间、比例或上限已改变，请重新预览') : !preview ? '请先预览' : preview.data.allowanceShort ?? undefined)} onClick={open}>{busy === 'open' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}开仓并质押</button>
      </div>
      {preview && !stale ? <p className="as-muted">预览：投入 {amount(preview.data.amount0, t0)} + {amount(preview.data.amount1, t1)}{preview.data.capped ? `（已按上限 $${preview.cap?.usd.toLocaleString('zh-CN')} 缩减）` : ''}；{preview.data.swap ? `兑换 ${amount(preview.data.swap.amountIn, tokenOf(state.chain, preview.data.swap.tokenIn))}${preview.data.swap.quoted ? ` → 约 ${amount(preview.data.swap.quoted, tokenOf(state.chain, preview.data.swap.tokenOut))}` : '（授权后再报价）'}` : '无需兑换'}；预计存入约 {amount(preview.data.deposit0, t0)} + {amount(preview.data.deposit1, t1)}，零头留在 Safe。{allowanceText(preview.data)}</p> : null}
      {preview && !stale && preview.data.allowanceShort ? <div className="lp-callout warning" role="alert"><CircleAlert size={16} /><span>{preview.data.allowanceShort}，暂不能开仓。</span></div> : null}
      {preview && expired && preview.key === key ? <p className="as-muted">预览已超过 2 分钟，请重新预览后再开仓。</p> : null}
      {blocked && state.wallet ? <p className="as-muted">{blocked}</p> : null}
    </>;
  };
  return <section className="panel as-panel" aria-label="Safe 实盘开仓">
    <div className="panel-heading"><h2>Safe 实盘开仓</h2><span className="muted">资产在 Safe，bot 只付 gas；Roles 白名单与每日额度在链上兜底</span></div>
    <div className="as-panel-body">
      {body()}
      {job ? <p className={`as-job ${job.status}`}>{job.status === 'running' ? <LoaderCircle size={14} className="spin" /> : job.status === 'failed' ? <CircleAlert size={14} /> : null}{job.label}：{job.status === 'running' ? job.step ?? '执行中' : job.status === 'done' ? '已完成' : job.error}</p> : null}
      {actionError ? <div className="error-box" role="alert">{actionError}</div> : null}
    </div>
  </section>;
}
