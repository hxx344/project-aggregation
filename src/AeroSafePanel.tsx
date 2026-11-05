import { useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, Play, ScanSearch } from 'lucide-react';
import type { MarketPool } from './aero-market-types';
import type { AeroSafePreview } from './aero-safe-types';
import { same, tokenOf, units, useAeroSafe } from './aero-safe-client';
import './aero-safe.css';

const PREVIEW_TTL_MS = 2 * 60_000;

// 打开工作台的 Aero 实盘页（App 监听 popstate 切换路由）。
export function openAeroSafePage() {
  history.pushState(null, '', `${location.pathname}?view=aero-safe`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// 池详情页里的实盘开仓：按页面上选定的区间（默认推荐区间），用 Safe 里的余额经 Roles 开仓并质押。先预览，再确认执行。
export default function AeroSafePanel({ pool, range, onExpired }: { pool: MarketPool; range: [number, number]; onExpired: () => void }) {
  const { state, loadError, busy, actionError, execute, preview: requestPreview } = useAeroSafe(onExpired);
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
  const blocked = !state?.wallet ? '请先在 Aero 实盘页填写 bot 私钥' : state.paused ? state.pauseReason : running ? `${job.label}正在执行` : state.pending && !state.pending.stale ? `上一笔交易（${state.pending.label}）等待上链` : null;
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
    if (!state.configured) return <p className="as-muted">尚未配置 Safe 实盘。<button type="button" className="as-link" onClick={openAeroSafePage}>前往 Aero 实盘配置</button></p>;
    if (!whitelisted) return <p className="as-muted">这个池子不在 Roles 白名单里，bot 无权在此开仓；白名单在 Safe 上由硬件钱包设置。</p>;
    if (!chainPool) return <p className="as-muted">{state.chainError ? `链上读取失败：${state.chainError}` : '正在读取 Safe 链上状态…'}</p>;
    const stale = preview && (preview.key !== key || expired);
    return <>
      <div className="as-row">
        <span>Safe 余额：{amount(t0?.balance, t0)} · {amount(t1?.balance, t1)}</span>
        <span>本池头寸 {chainPool.positions.length} 个{chainPool.positions.length ? <button type="button" className="as-link" onClick={openAeroSafePage}>管理</button> : null}</span>
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
