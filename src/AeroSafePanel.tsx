import { useEffect, useState } from 'react';
import { CircleAlert, Download, ListPlus, LoaderCircle, Play, ScanSearch, ShieldCheck } from 'lucide-react';
import type { MarketPool } from './aero-market-types';
import type { AeroSafePoolPlan, AeroSafePreview } from './aero-safe-types';
import { same, tokenOf, units, useAeroSafe } from './aero-safe-client';
import { openAeroTab } from './aero-nav';
import './aero-safe.css';

const PREVIEW_TTL_MS = 2 * 60_000;
// 新代币每日额度的默认值：约合这么多美元（按市场页的代币价折算），可改。
const DEFAULT_ALLOWANCE_USD = 1000;

function defaultAllowance(usd: number | null, decimals: number) {
  if (!usd || !(usd > 0)) return '';
  const value = DEFAULT_ALLOWANCE_USD / usd;
  const digits = Math.max(0, Math.min(decimals, 4 - Math.floor(Math.log10(value))));
  const text = value.toFixed(digits);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

// 原始单位的十进制字符串 → 精确的代币数量文本（不舍入，供重新生成同一批次）。
function exactUnits(raw: string, decimals: number) {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${value / scale}.${fraction}` : `${value / scale}`;
}

// 不在白名单的池子：生成增量 Safe 批次（新 gauge、mint/质押权限、新代币授权与额度、该池两个方向的兑换），
// 硬件钱包在 Safe{Wallet} 执行后，服务端以 bot 身份模拟核对生效，再并入配置。
function AddPool({ pool, safe }: { pool: MarketPool; safe: ReturnType<typeof useAeroSafe> }) {
  const { state, busy, call, planPool } = safe;
  const known = state?.config?.permissions.allowances ?? [];
  const fresh = [pool.token0, pool.token1].filter((t) => !known.some((a) => same(a.token, t.address)));
  const saved = state?.poolPlan;
  const mine = saved && same(saved.pool.address, pool.address) ? saved : null;
  // 已有本池的计划时沿用其中的额度（按当前币价重算会生成不同的批次，与已执行的批次对不上）。
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(fresh.map((t) => {
    const kept = mine && !mine.stale ? mine.pool.allowances.find((a) => same(a.token, t.address)) : null;
    return [t.address, kept ? exactUnits(kept.perDay, kept.decimals) : defaultAllowance(t.usd, t.decimals)];
  })));
  const [plan, setPlan] = useState<AeroSafePoolPlan | null>(null);
  const current = plan && mine && same(plan.pool.address, pool.address) && plan.pool.transactions === mine.pool.transactions ? plan : null;
  const missing = fresh.find((t) => !/^\d+(\.\d+)?$/.test(amounts[t.address] ?? '') || Number(amounts[t.address]) <= 0);
  const generate = async () => {
    if (missing) return;
    const data = await planPool({ pool: pool.address, allowances: Object.fromEntries(fresh.map((t) => [t.address, amounts[t.address]])) });
    if (data) setPlan(data);
  };
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(current.builder, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `aero-add-pool-${current.pool.name.replace(/[^\w.-]+/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const usage = current?.usage.length ? Math.max(...current.usage.map((u) => u.nodes)) : null;
  return <>
    <p className="as-muted">这个池子不在 Roles 白名单里，bot 还不能在此开仓。可以生成一份加池 Safe 批次：增加该池的 gauge、开仓与质押权限、新代币的授权与每日额度，以及该池两个方向的配平兑换；由硬件钱包在 Safe{'{'}Wallet{'}'} 执行后启用。</p>
    {saved && !mine ? <p className="as-muted">已有另一个待启用的加池计划（{saved.pool.name}）；在这里生成会替换它。</p> : null}
    {mine?.stale ? <p className="as-muted">之前生成的批次之后 Safe 配置已变化，请重新生成。</p> : null}
    <div className="as-form">
      {fresh.map((t) => <label key={t.address}>{t.symbol} 每日额度
        <input inputMode="decimal" value={amounts[t.address] ?? ''} onChange={(e) => setAmounts((prev) => ({ ...prev, [t.address]: e.target.value.trim() }))} />
        <small className="as-muted">{t.usd && Number(amounts[t.address]) > 0 ? `约 $${Math.round(Number(amounts[t.address]) * t.usd).toLocaleString('zh-CN')}` : '\u00a0'}</small>
      </label>)}
      {fresh.length === 0 ? <span className="as-muted">两种代币已有每日额度，沿用现有额度。</span> : null}
      <button type="button" className="button secondary" disabled={!!busy || !!missing} title={missing ? `请填写 ${missing.symbol} 的每日额度` : undefined} onClick={() => void generate()}>{busy === 'plan' ? <LoaderCircle size={15} className="spin" /> : <ListPlus size={15} />}生成 Safe 批次</button>
    </div>
    {fresh.length ? <p className="as-muted">每日额度是 bot 每 24 小时最多能投入开仓或卖出兑换的数量，bot 私钥泄露时损失也以此为上限；已有代币的额度不在这里修改。</p> : null}
    {current ? <>
      <p className="as-muted">批次共 {current.transactions.length} 笔{usage !== null ? `，条件树最多用到 ${usage}/255 个节点` : ''}。下载后在 Safe{'{'}Wallet{'}'} →「应用」→ Transaction Builder 拖入 JSON（提示无法校验 checksum 属正常），逐笔核对后用硬件钱包签名执行；同一批次只执行一次，重复执行会把新代币当天的额度重置为满额。</p>
      <details className="as-muted"><summary>批次明细</summary><ol>{current.transactions.map((t, i) => <li key={i}>{t.description}</li>)}</ol></details>
      <div className="as-form"><button type="button" className="button secondary" onClick={download}><Download size={15} />下载批次 JSON</button></div>
    </> : mine && !mine.stale ? <p className="as-muted">{new Date(mine.createdAt).toLocaleString('zh-CN')} 已生成 {mine.pool.transactions} 笔的批次；如需重新下载，请再点一次「生成 Safe 批次」（沿用相同额度，内容相同）。</p> : null}
    {mine && !mine.stale ? <div className="as-form">
      <button type="button" className="button primary" disabled={!!busy || !state?.wallet} title={!state?.wallet ? '请先在 Aero「配置」填写 bot 私钥' : undefined} onClick={() => void call('apply', '/pools/apply', 'POST', {}, 120_000)}>{busy === 'apply' ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}已执行，核对并启用</button>
      <button type="button" className="button secondary" disabled={!!busy} onClick={() => { setPlan(null); void call('discard', '/pools/discard', 'POST', {}); }}>放弃</button>
    </div> : null}
  </>;
}


// 池详情页里的实盘开仓：按页面上选定的区间（默认推荐区间），用 Safe 里的余额经 Roles 开仓并质押。先预览，再确认执行。
export default function AeroSafePanel({ pool, range, onExpired }: { pool: MarketPool; range: [number, number]; onExpired: () => void }) {
  const safe = useAeroSafe(onExpired);
  const { state, loadError, busy, actionError, execute, preview: requestPreview } = safe;
  const [shareText, setShareText] = useState('100');
  const [rebalance, setRebalance] = useState(true);
  const [preview, setPreview] = useState<{ key: string; data: AeroSafePreview; at: number } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const share = Number(shareText);
  const shareBps = Number.isFinite(share) && share > 0 && share <= 100 ? Math.round(share * 100) : null;
  const key = `${range[0]}:${range[1]}:${shareBps}:${rebalance}`;
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

  const runPreview = async () => {
    if (shareBps === null) return;
    const data = await requestPreview({ pool: pool.address, tickLower: range[0], tickUpper: range[1], shareBps, rebalance });
    if (data) { const at = Date.now(); setPreview({ key, data, at }); setClock(at); }
  };
  const open = () => {
    if (!preview || preview.key !== key || expired || shareBps === null) return;
    const p = preview.data;
    const slippage = (state?.config?.slippageBps ?? 50) / 100;
    const lines = [`在 ${pool.token0.symbol}/${pool.token1.symbol} CL${pool.tickSpacing} 开仓：tick ${range[0]} 至 ${range[1]}`,
      `投入 Safe 余额的 ${shareBps / 100}%：${amount(p.amount0, t0)} + ${amount(p.amount1, t1)}`,
      p.swap ? `先配平兑换 ${amount(p.swap.amountIn, tokenOf(state?.chain, p.swap.tokenIn))}` : '不兑换',
      `兑换与开仓的最小成交量按报价扣 ${slippage}% 滑点；执行时余额偏离预览超过 1%、配平兑换超出预览 10% 或方向改变都会停止。`,
      '开仓后自动质押到 gauge；提前解押会被罚没部分奖励。'];
    if (state?.pending?.stale) lines.push(`上一笔交易（${state.pending.label}）超过 10 分钟未上链，本次会用同一 nonce 提价替换它。`);
    const expect = { previewedAt: p.previewedAt, amount0: p.amount0, amount1: p.amount1, swapIn: p.swap?.amountIn ?? null, swapTokenIn: p.swap?.tokenIn ?? null };
    if (window.confirm(`${lines.join('\n')}\n\n确认由 bot 经 Roles 发送？`)) void execute('open', { pool: pool.address, tickLower: range[0], tickUpper: range[1], shareBps, rebalance, expect });
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
        <label className="as-check"><input type="checkbox" checked={rebalance} onChange={(e) => setRebalance(e.target.checked)} />按区间比例先兑换配平</label>
        <span className="as-range">tick {range[0]} 至 {range[1]}</span>
        <button type="button" className="button secondary" disabled={!!busy || shareBps === null || range[0] >= range[1]} onClick={() => void runPreview()}>{busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <ScanSearch size={15} />}预览</button>
        <button type="button" className="button primary" disabled={!!busy || !!blocked || !preview || !!stale} title={blocked ?? (stale ? (expired ? '预览已过期，请重新预览' : '区间或比例已改变，请重新预览') : !preview ? '请先预览' : undefined)} onClick={open}>{busy === 'open' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}开仓并质押</button>
      </div>
      {preview && !stale ? <p className="as-muted">预览：投入 {amount(preview.data.amount0, t0)} + {amount(preview.data.amount1, t1)}；{preview.data.swap ? `兑换 ${amount(preview.data.swap.amountIn, tokenOf(state.chain, preview.data.swap.tokenIn))}${preview.data.swap.quoted ? ` → 约 ${amount(preview.data.swap.quoted, tokenOf(state.chain, preview.data.swap.tokenOut))}` : '（授权后再报价）'}` : '无需兑换'}；预计存入约 {amount(preview.data.deposit0, t0)} + {amount(preview.data.deposit1, t1)}，零头留在 Safe。</p> : null}
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
