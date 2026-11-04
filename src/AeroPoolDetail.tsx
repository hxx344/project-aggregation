import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowLeft, ArrowLeftRight, CircleAlert, Crosshair, LoaderCircle, Minus, Plus, RefreshCw, Star, ZoomIn, ZoomOut } from 'lucide-react';
import { api, ApiError } from './api';
import { expectedDaysInRange, fullRange, netYield, priceText, quoteOf, rangeAmounts, rangeApr, rangeLabel, rangeTicks, rebalanceCost, riskVolOf } from './aero-market-math';
import type { NetYield } from './aero-market-math';
import { dates, days, message, pct, tokenAmount, usd } from './aero-market-format';
import type { MarketLiquidity, MarketPool, MarketPoolHistory } from './aero-market-types';

const ROOT = '/api/research/aero-market';
// width 为 -1 表示全范围；其余与列表的区间宽度一致（以当前 tick 为中心、对齐到 tickSpacing）。
const PRESETS = [{ width: 0, label: '最窄' }, { width: 0.01, label: '±1%' }, { width: 0.02, label: '±2%' }, { width: 0.05, label: '±5%' }, { width: 0.1, label: '±10%' }, { width: 0.2, label: '±20%' }, { width: -1, label: '全范围' }];
const PERIODS = { '1d': { label: '1 天', ms: 86_400_000 }, '7d': { label: '1 周', ms: 7 * 86_400_000 }, '30d': { label: '1 月', ms: 30 * 86_400_000 } } as const;
type Period = keyof typeof PERIODS;
const CHART_H = 260;
const PAD = 10;
const BUCKETS = 56;
const LABEL_W = 70;
// 自动视图最多显示到当前价 ÷4 至 ×4（与服务端读取的流动性范围一致），全范围区间的边界画在图外。
const AUTO_MAX_HALF = 13_864;
type Edge = 'lower' | 'upper';
type View = { center: number; half: number };
type Evaluation = { apr: number | null; net: NetYield | null; days: number | null; inRange: boolean };

function evaluate(pool: MarketPool, aeroUsd: number | null, range: [number, number], deposit: number): Evaluation {
  const inRange = pool.tick >= range[0] && pool.tick < range[1];
  const vol = riskVolOf(pool);
  const apr = inRange ? rangeApr(pool, aeroUsd, range, deposit) : null;
  return { apr, inRange, net: netYield({ apr, tick: pool.tick, lower: range[0], upper: range[1], dailyVol: vol, costFraction: rebalanceCost(pool, deposit) }), days: expectedDaysInRange(pool.tick, range[0], range[1], vol) };
}
const presetRange = (pool: MarketPool, width: number): [number, number] => (width < 0 ? fullRange(pool.tickSpacing) : rangeTicks(pool.tick, pool.tickSpacing, width));
const sameRange = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

// 图表宽度跟随容器；高度固定，y 坐标即像素，拖动时不用换算缩放。
function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

type Props = {
  pool: MarketPool; chainName: string; aeroUsd: number | null; initialWidth: number; recommended: [number, number] | null; depositText: string; onDeposit: (text: string) => void;
  favorite: boolean; favoriteDisabled: boolean; onFavorite: () => void; onBack: () => void; onExpired: () => void; notice?: string; children?: ReactNode;
};

export default function AeroPoolDetail({ pool, chainName, aeroUsd, initialWidth, recommended, depositText, onDeposit, favorite, favoriteDisabled, onFavorite, onBack, onExpired, notice, children }: Props) {
  const spacing = pool.tickSpacing, full = fullRange(spacing);
  const deposit = Math.max(Number(depositText) || 0, 0);
  const [flip, setFlip] = useState(false);
  const quote = quoteOf(pool, flip);
  // 报价方向向上（价格升高）对应的 tick 方向。
  const dir = quote.rising ? 1 : -1;
  const [range, setRange] = useState<[number, number]>(() => recommended ?? rangeTicks(pool.tick, spacing, initialWidth));
  const [period, setPeriod] = useState<Period>('7d');
  const [zoom, setZoom] = useState<View | null>(null);
  // initial 为聚焦时显示的文本：未改动就失焦不提交，避免四舍五入后的价格再取整让边界外移一档。
  const [draft, setDraft] = useState<{ edge: 'low' | 'high'; text: string; initial: string } | null>(null);
  const cancelDraft = useRef(false);
  const [history, setHistory] = useState<{ data: MarketPoolHistory | null; error: string }>({ data: null, error: '' });
  const [liquidity, setLiquidity] = useState<{ data: MarketLiquidity | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });

  // 读取：打开时各读一次；该池子的链上读数变化（新一轮扫描）后静默重读，失败时保留已有图表。迟到的旧响应按代次丢弃。
  const lifetime = useRef<AbortController | null>(null);
  const historyGen = useRef(0), liquidityGen = useRef(0);
  useEffect(() => { const c = new AbortController(); lifetime.current = c; return () => c.abort(); }, []);
  const failed = useCallback((reason: unknown) => { if (reason instanceof ApiError && reason.status === 401) { onExpired(); return null; } return message(reason); }, [onExpired]);
  const query = `chain=${encodeURIComponent(pool.chain)}&address=${pool.address}`;
  const loadHistory = useCallback(async () => {
    const signal = lifetime.current?.signal, gen = ++historyGen.current;
    if (!signal) return;
    try {
      const data = await api<MarketPoolHistory>(`${ROOT}/pool?${query}`, { signal, timeoutMs: 15_000 });
      if (!signal.aborted && gen === historyGen.current) setHistory({ data, error: '' });
    } catch (reason) {
      const text = signal.aborted || gen !== historyGen.current ? null : failed(reason);
      if (text) setHistory((h) => (h.data ? h : { data: null, error: text }));
    }
  }, [query, failed]);
  // 服务端整次读取限时 25 秒，页面多等 10 秒，让服务端先给出具体失败原因。
  const loadLiquidity = useCallback(async () => {
    const signal = lifetime.current?.signal, gen = ++liquidityGen.current;
    if (!signal) return;
    setLiquidity((l) => ({ ...l, loading: true }));
    try {
      const data = await api<MarketLiquidity>(`${ROOT}/liquidity?${query}`, { signal, timeoutMs: 35_000 });
      if (!signal.aborted && gen === liquidityGen.current) setLiquidity({ data, error: '', loading: false });
    } catch (reason) {
      const text = signal.aborted || gen !== liquidityGen.current ? null : failed(reason);
      if (text !== null) setLiquidity((l) => ({ data: l.data, error: text, loading: false }));
    }
  }, [query, failed]);
  const stateKey = `${pool.sqrtPriceX96}:${pool.liquidity}:${pool.stakedLiquidity}`;
  useEffect(() => { void loadHistory(); void loadLiquidity(); }, [stateKey, loadHistory, loadLiquidity]);

  const now = Date.now();
  const points = useMemo(() => (history.data?.points ?? []).filter(([t]) => t >= now - PERIODS[period].ms), [history.data, period, now]);
  // 自动视图以当前价为中心，同时容纳所选区间与该时段的价格；用户拖动或缩放后固定，避免拖动时坐标跟着变。
  const auto = useMemo<View>(() => {
    const reach = Math.max(Math.abs(range[0] - pool.tick), Math.abs(range[1] - pool.tick));
    const dev = points.reduce((m, [, t]) => Math.max(m, Math.abs(t - pool.tick)), 0);
    return { center: pool.tick, half: Math.max(Math.min(reach * 1.35, AUTO_MAX_HALF), Math.min(dev * 1.15, AUTO_MAX_HALF), spacing * 6, 20) };
  }, [range, points, pool.tick, spacing]);
  const view = zoom ?? auto;
  const lo = view.center - view.half, hi = view.center + view.half;
  const yOf = useCallback((tick: number, v: View = view) => { const f = (tick - (v.center - v.half)) / (2 * v.half); return PAD + (dir > 0 ? 1 - f : f) * (CHART_H - 2 * PAD); }, [view, dir]);
  const tickAt = (y: number, v: View) => { let f = (y - PAD) / (CHART_H - 2 * PAD); if (dir > 0) f = 1 - f; return v.center - v.half + f * 2 * v.half; };

  const snap = (t: number) => Math.round(t / spacing) * spacing;
  const setEdge = useCallback((edge: Edge, tick: number) => setRange(([l, u]) => edge === 'lower'
    ? [Math.min(Math.max(snap(tick), full[0]), u - spacing), u]
    : [l, Math.max(Math.min(snap(tick), full[1]), l + spacing)]), [full[0], full[1], spacing]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (next: [number, number]) => { setRange(next); setZoom(null); setDraft(null); };

  // 拖动：上下沿各自移动，拖区间中部整体平移；坐标按按下时的视图换算。
  const drag = useRef<{ kind: Edge | 'band'; top: number; start: number; range: [number, number]; view: View } | null>(null);
  const begin = (kind: Edge | 'band') => (e: ReactPointerEvent<SVGElement>) => {
    const svg = e.currentTarget.ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement);
    const top = svg.getBoundingClientRect().top;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setZoom(view); setDraft(null);
    drag.current = { kind, top, start: tickAt(e.clientY - top, view), range, view };
  };
  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = tickAt(e.clientY - d.top, d.view);
    if (d.kind !== 'band') { setEdge(d.kind, t); return; }
    const width = d.range[1] - d.range[0];
    const lower = Math.min(Math.max(snap(d.range[0] + t - d.start), full[0]), full[1] - width);
    setRange([lower, lower + width]);
  };
  const end = () => { drag.current = null; };
  const keyStep = (edge: Edge) => (e: KeyboardEvent<SVGElement>) => {
    const step = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
    if (!step) return;
    e.preventDefault(); setDraft(null);
    setEdge(edge, (edge === 'lower' ? range[0] : range[1]) + step * dir * spacing);
  };

  const zoomBy = (factor: number) => setZoom((z) => { const v = z ?? view; return { center: v.center, half: Math.min(Math.max(v.half * factor, spacing * 4, 10), full[1]) }; });

  // 流动性按视图均分成若干格，每格取按 tick 长度加权的平均流动性；超出已读取范围的部分不画。
  const bars = useMemo(() => {
    const segs = liquidity.data?.segments ?? [];
    const step = (hi - lo) / BUCKETS;
    const out = Array.from({ length: BUCKETS }, (_, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, total: 0, staked: 0, known: 0 }));
    let j = 0;
    for (const b of out) {
      while (j < segs.length && segs[j][1] <= b.from) j++;
      for (let k = j; k < segs.length && segs[k][0] < b.to; k++) {
        const overlap = Math.min(segs[k][1], b.to) - Math.max(segs[k][0], b.from);
        if (overlap <= 0) continue;
        b.total += segs[k][2] * overlap; b.staked += segs[k][3] * overlap; b.known += overlap;
      }
      if (b.known > 0) { b.total /= b.known; b.staked /= b.known; }
    }
    const max = Math.max(...out.map((b) => b.total), 0);
    return { list: out, max };
  }, [liquidity.data, lo, hi]);

  const [liquidityBox, liquidityWidth] = useWidth();
  const [priceBox, priceWidth] = useWidth();
  const clipId = `am-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const selected = evaluate(pool, aeroUsd, range, deposit);
  const amounts = rangeAmounts(pool, range, deposit);
  // 推荐区间排在最前：列表按同一投入搜索得到，与预设重合时高亮推荐。
  const rows = [...(recommended ? [{ width: NaN, label: '推荐', range: recommended }] : []), ...PRESETS.map((p) => ({ ...p, range: presetRange(pool, p.width) }))]
    .map((r) => ({ ...r, result: evaluate(pool, aeroUsd, r.range, deposit) }));
  const activePreset = rows.find((r) => sameRange(r.range, range));

  // 显示侧的低价、高价对应哪个 tick 边：报价随 tick 下降时（反向报价）低价是上沿。
  const lowEdge: Edge = dir > 0 ? 'lower' : 'upper', highEdge: Edge = dir > 0 ? 'upper' : 'lower';
  const edgeTick = (edge: Edge) => (edge === 'lower' ? range[0] : range[1]);
  const atLimit = (edge: Edge) => edgeTick(edge) === (edge === 'lower' ? full[0] : full[1]);
  const current = quote.price(pool.tick);
  const commit = () => {
    if (!draft || cancelDraft.current || draft.text === draft.initial) { cancelDraft.current = false; setDraft(null); return; }
    const text = draft.text.trim().replace(/,/g, ''), edge = draft.edge === 'low' ? lowEdge : highEdge;
    setDraft(null);
    // 最低价填 0、最高价填 ∞ 表示该侧不设限。
    if ((draft.edge === 'low' && text === '0') || (draft.edge === 'high' && /^(∞|inf(inity)?)$/i.test(text))) { setZoom(null); setEdge(edge, edge === 'lower' ? full[0] : full[1]); return; }
    const v = Number(text);
    if (!text || !(v > 0) || !Number.isFinite(v)) return;
    setZoom(null);
    // 低价向外取整（区间包含输入价），高价同理。
    const t = quote.tickOf(v);
    setEdge(edge, edge === 'lower' ? Math.floor(t / spacing) * spacing : Math.ceil(t / spacing) * spacing);
  };
  const priceCard = (side: 'low' | 'high') => {
    const edge = side === 'low' ? lowEdge : highEdge, tick = edgeTick(edge), limit = atLimit(edge);
    const value = quote.price(tick);
    // 聚焦时保持显示的文本不变（提交时再去掉千分位），否则浏览器的全选会被重置。
    const shown = limit ? (side === 'low' ? '0' : '∞') : priceText(value);
    return <div className={`am-price-card ${side}`}>
      <span className="am-price-label">{side === 'low' ? '最低价' : '最高价'}</span>
      <input aria-label={side === 'low' ? '区间最低价' : '区间最高价'} inputMode="decimal" value={draft?.edge === side ? draft.text : shown}
        onFocus={(e) => { cancelDraft.current = false; setDraft({ edge: side, text: shown, initial: shown }); e.currentTarget.select(); }}
        onChange={(e) => setDraft({ edge: side, text: e.target.value, initial: draft?.edge === side ? draft.initial : shown })} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelDraft.current = true; e.currentTarget.blur(); } }} />
      <small>{limit ? '不设限' : `${((value / current - 1) * 100 >= 0 ? '+' : '')}${((value / current - 1) * 100).toFixed(2)}% · tick ${tick}`}</small>
      <div className="am-price-steps">
        <button type="button" className="button secondary" aria-label="降低一个 tickSpacing" onClick={() => { setDraft(null); setEdge(edge, tick - dir * spacing); }}><Minus size={14} /></button>
        <button type="button" className="button secondary" aria-label="提高一个 tickSpacing" onClick={() => { setDraft(null); setEdge(edge, tick + dir * spacing); }}><Plus size={14} /></button>
        <button type="button" className="button secondary" aria-label={side === 'low' ? '最低价不设限（0）' : '最高价不设限（∞）'} title={side === 'low' ? '最低价不设限' : '最高价不设限'} onClick={() => { setDraft(null); setEdge(edge, edge === 'lower' ? full[0] : full[1]); }}>{side === 'low' ? '0' : '∞'}</button>
      </div>
    </div>;
  };

  // 区间带与拖动手柄：两张图共用，边界在视图外时手柄贴边显示。
  const overlay = (width: number, withHandles: boolean) => {
    const y0 = yOf(range[0]), y1 = yOf(range[1]);
    const top = Math.max(Math.min(y0, y1), 0), bottom = Math.min(Math.max(y0, y1), CHART_H);
    const yNow = yOf(pool.tick);
    const handle = (edge: Edge) => {
      const raw = yOf(edgeTick(edge)), y = Math.min(Math.max(raw, 5), CHART_H - 5), off = raw !== y;
      const label = `${edge === lowEdge ? '最低价' : '最高价'} ${atLimit(edge) ? (edge === lowEdge ? '0' : '∞') : priceText(quote.price(edgeTick(edge)))}`;
      return <g className={`am-handle${off ? ' off' : ''}`}>
        {off ? null : <line x1={0} x2={width} y1={y} y2={y} />}
        {withHandles ? <rect x={width / 2 - 16} y={y - 6} width={32} height={12} rx={4} role="slider" tabIndex={0} aria-label={label} aria-valuetext={label}
          aria-valuenow={edgeTick(edge)} aria-valuemin={full[0]} aria-valuemax={full[1]}
          onPointerDown={begin(edge)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={keyStep(edge)} /> : null}
      </g>;
    };
    return <g>
      {bottom > top ? <rect className="am-band" x={0} y={top} width={width} height={bottom - top} onPointerDown={begin('band')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} /> : null}
      {yNow >= 0 && yNow <= CHART_H ? <line className="am-now" x1={0} x2={width} y1={yNow} y2={yNow} /> : null}
      {handle('lower')}{handle('upper')}
    </g>;
  };

  const priceTicks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const t0 = now - PERIODS[period].ms;
  const plotW = Math.max(priceWidth - LABEL_W, 1);
  const path = points.map(([t, tick], i) => `${i ? 'L' : 'M'}${(((t - t0) / (now - t0)) * plotW).toFixed(1)},${yOf(tick).toFixed(1)}`).join('');
  const liq = liquidity.data;
  const coverage = liq ? `已读取 ${priceText(Math.min(quote.price(liq.from), quote.price(liq.to)))} – ${priceText(Math.max(quote.price(liq.from), quote.price(liq.to)))} 内 ${liq.initialized} 个已初始化 tick（区块 ${liq.block}，${dates.format(liq.at)}）` : '';

  return <div className="lp-page am-page am-pool-page">
    <div className="panel am-pool-head">
      <button type="button" className="button secondary" onClick={onBack}><ArrowLeft size={15} />返回列表</button>
      <div className="am-pool-title">
        <h1>{pool.token0.symbol} / {pool.token1.symbol}<span className="am-badge">{pool.fee === null ? '—' : `${(pool.fee / 1e4).toFixed(2)}%`}</span></h1>
        <p>{chainName} · CL{spacing} · <code>{pool.address}</code></p>
      </div>
      <button type="button" className={`button secondary am-star-button${favorite ? ' on' : ''}`} aria-pressed={favorite} disabled={favoriteDisabled} onClick={onFavorite}><Star size={15} />{favorite ? '已收藏' : '收藏'}</button>
    </div>

    {notice ? <div className="lp-callout warning"><CircleAlert size={15} />{notice}</div> : null}
    <section className="am-rewards" aria-label="所选区间收益">
      <div className="panel"><span>排放年化</span><strong>{selected.inRange ? pct(selected.apr, 1) : '0%'}</strong><small>{!pool.gauge ? '没有 gauge，不产生排放' : !selected.inRange ? '当前价不在区间内，不产生排放' : `按当前价位质押流动性稀释，投入 ${usd(deposit)}`}</small></div>
      <div className="panel"><span>净年化</span><strong className={(selected.net?.net ?? 0) > 0 ? 'up' : (selected.net?.net ?? 0) < 0 ? 'down' : ''}>{pct(selected.net?.net, 1)}</strong><small>{selected.net ? `排放 ${pct(selected.net.emission, 0)} − 无常损失 ${pct(selected.net.impermanent, 0)} − 调仓 ${pct(selected.net.rebalance, 0)}` : '缺少波动率、排放或当前价不在区间内'}</small></div>
      <div className="panel"><span>预计在区间</span><strong>{days(selected.days)}</strong><small>按日波动 {pct(riskVolOf(pool), 2)} 的随机游走估算</small></div>
      <div className="panel"><span>手续费年化</span><strong>不计入</strong><small>质押仓位的手续费归投票者；未质押分成 {pool.unstakedFee === null ? '—' : `${(pool.unstakedFee / 1e4).toFixed(0)}%`}</small></div>
    </section>

    <section className="panel am-range" aria-label="价格区间">
      <div className="am-range-head">
        <h2>价格区间</h2>
        <button type="button" className="button secondary am-swap" onClick={() => { setFlip((v) => !v); setDraft(null); }} aria-pressed={flip} title={`改为每 ${quote.quote} 折合 ${quote.base}`}><ArrowLeftRight size={13} />{quote.label}</button>
      </div>
      <div className="am-presets" role="group" aria-label="预设区间">
        {rows.map((r) => <button key={r.label} type="button" className={activePreset?.label === r.label ? 'on' : ''} aria-pressed={activePreset?.label === r.label} title={r.label === '推荐' ? `居中区间中净年化最高：${rangeLabel(pool, r.range, flip)}` : undefined} onClick={() => choose(r.range)}>{r.label === '推荐' ? `推荐 ${rangeLabel(pool, r.range, flip)}` : r.label}</button>)}
      </div>
      <div className="am-charts">
        <figure className="am-panel-chart">
          <figcaption><span>流动性分布</span>
            <span className="am-chart-tools">
              <button type="button" className="am-icon" title="回到当前价" aria-label="回到当前价" onClick={() => setZoom(null)}><Crosshair size={15} /></button>
              <button type="button" className="am-icon" title="放大" aria-label="放大" onClick={() => zoomBy(1 / 1.5)}><ZoomIn size={15} /></button>
              <button type="button" className="am-icon" title="缩小" aria-label="缩小" onClick={() => zoomBy(1.5)}><ZoomOut size={15} /></button>
              <button type="button" className="am-icon" title="重新读取流动性" aria-label="重新读取流动性" disabled={liquidity.loading} onClick={() => void loadLiquidity()}><RefreshCw size={14} className={liquidity.loading ? 'spin' : ''} /></button>
            </span>
          </figcaption>
          <div className="am-svg-box" ref={liquidityBox}>
            {liquidityWidth > 0 ? <svg width={liquidityWidth} height={CHART_H} role="img" aria-label={`流动性分布，${quote.label}，浅色为全部流动性、深色为质押流动性`}>
              {bars.max > 0 ? bars.list.map((b, i) => {
                if (!(b.total > 0)) return null;
                const ya = yOf(b.from), yb = yOf(b.to), y = Math.min(ya, yb), h = Math.max(Math.abs(yb - ya) - 1, 1);
                const inside = (b.from + b.to) / 2 >= range[0] && (b.from + b.to) / 2 <= range[1];
                const w = ((liquidityWidth - 4) * b.total) / bars.max, ws = ((liquidityWidth - 4) * b.staked) / bars.max;
                return <g key={i} className={inside ? 'am-bar in' : 'am-bar'}><rect className="total" x={0} y={y} width={w} height={h} /><rect className="staked" x={0} y={y} width={ws} height={h} /></g>;
              }) : null}
              {overlay(liquidityWidth, true)}
            </svg> : null}
            {liquidity.loading && !liq ? <p className="am-chart-state"><LoaderCircle size={14} className="spin" />正在从链上读取流动性…</p>
              : liquidity.error && !liq ? <p className="am-chart-state lp-error"><CircleAlert size={14} />{liquidity.error}</p>
                : liq && bars.max === 0 ? <p className="am-chart-state">当前视图内没有流动性</p> : null}
          </div>
          <small className="am-chart-note">{liquidity.error && liq ? `刷新失败：${liquidity.error}；显示的是上次读取的结果。` : coverage}</small>
        </figure>
        <figure className="am-panel-chart">
          <figcaption><span>历史价格</span>
            <span className="am-periods" role="group" aria-label="时间范围">{(Object.keys(PERIODS) as Period[]).map((k) => <button key={k} type="button" className={period === k ? 'on' : ''} aria-pressed={period === k} onClick={() => { setPeriod(k); setZoom(null); }}>{PERIODS[k].label}</button>)}</span>
          </figcaption>
          <div className="am-svg-box" ref={priceBox}>
            {priceWidth > 0 ? <svg width={priceWidth} height={CHART_H} role="img" aria-label={`近${PERIODS[period].label}价格，${quote.label}，共 ${points.length} 个点`}>
              <defs><clipPath id={clipId}><rect x={0} y={0} width={plotW} height={CHART_H} /></clipPath></defs>
              {priceTicks.map((t) => <g key={t} className="am-grid"><line x1={0} x2={plotW} y1={yOf(t)} y2={yOf(t)} /><text x={priceWidth - 4} y={yOf(t) + 4} textAnchor="end">{priceText(quote.price(t))}</text></g>)}
              <g clipPath={`url(#${clipId})`}>
                {overlay(plotW, true)}
                {points.length > 1 ? <path className="am-price-line" d={path} /> : null}
              </g>
            </svg> : null}
            {history.error && !history.data ? <p className="am-chart-state lp-error"><CircleAlert size={14} />{history.error}</p>
              : !history.data ? <p className="am-chart-state"><LoaderCircle size={14} className="spin" />正在读取历史…</p>
                : points.length < 2 ? <p className="am-chart-state">该时段历史样本不足，扫描运行一段时间后会出现。</p> : null}
          </div>
          <small className="am-chart-note">{points.length ? `${dates.format(points[0][0])} 至 ${dates.format(points.at(-1)![0])}，${points.length} 个点；7 天以前为每小时样本` : '拖动区间上下沿调整范围，拖动区间中部整体平移'}</small>
        </figure>
      </div>
      <div className="am-price-cards">
        {priceCard('low')}
        <div className="am-price-card current"><span className="am-price-label">当前价</span><strong>{priceText(current)}</strong><small>{quote.label} · tick {pool.tick}</small></div>
        {priceCard('high')}
      </div>
      <div className="am-position">
        <label>投入（美元）<input type="number" min={1} step={100} value={depositText} onChange={(e) => onDeposit(e.target.value)} /></label>
        <div><span>需要 {pool.token0.symbol}</span><strong>{amounts ? tokenAmount(amounts.amount0) : '—'}</strong><small>{amounts ? usd(amounts.usd0) : '缺少代币报价'}</small></div>
        <div><span>需要 {pool.token1.symbol}</span><strong>{amounts ? tokenAmount(amounts.amount1) : '—'}</strong><small>{amounts ? usd(amounts.usd1) : ''}</small></div>
        <div><span>区间</span><strong>tick {range[0]} 至 {range[1]}</strong><small>{activePreset ? activePreset.label : '自定义'} · 宽 {(range[1] - range[0]) / spacing} 个 tickSpacing</small></div>
      </div>
    </section>

    <section className="panel" aria-label="不同区间的年化">
      <div className="lp-table-scroll"><table className="lp-table am-table am-range-table">
        <thead><tr><th scope="col">区间</th><th scope="col">价格范围（{quote.pair}）</th><th scope="col" className="num">排放年化</th><th scope="col" className="num">无常损失</th><th scope="col" className="num">调仓</th><th scope="col" className="num">净年化</th><th scope="col" className="num">预计在区间</th></tr></thead>
        <tbody>{[...rows, ...(activePreset ? [] : [{ label: '自定义', width: NaN, range, result: selected }])].map((r) => {
          const prices = [quote.price(r.range[0]), quote.price(r.range[1])].sort((a, b) => a - b);
          const isFull = sameRange(r.range, full);
          return <tr key={r.label} className={r.label === (activePreset?.label ?? '自定义') ? 'open' : undefined} onClick={() => choose(r.range)}>
            <th scope="row"><button type="button" className="am-pool">{r.label}{r.label === '推荐' ? <small>{rangeLabel(pool, r.range, flip)}</small> : null}</button></th>
            <td>{isFull ? '0 – ∞' : `${priceText(prices[0])} – ${priceText(prices[1])}`}</td>
            <td className="num">{r.result.inRange ? pct(r.result.apr, 0) : '0%'}</td>
            <td className="num">{pct(r.result.net?.impermanent, 0)}</td><td className="num">{pct(r.result.net?.rebalance, 0)}</td>
            <td className={`num strong ${(r.result.net?.net ?? 0) > 0 ? 'up' : (r.result.net?.net ?? 0) < 0 ? 'down' : ''}`}>{pct(r.result.net?.net, 0)}</td>
            <td className="num">{days(r.result.days)}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <p className="am-note">推荐区间按 tickSpacing 粒度以当前价居中搜索，在预计至少待满 1 天的居中区间中取净年化最高者，与列表的净年化列一致；预设区间以当前价为中心；排放年化按当前价位的质押流动性稀释，与列表同一口径（假设全程在区间内并质押），净年化 = 排放 − 无常损失 − 调仓成本。流动性分布按 tick 链上读数还原，浅色为全部流动性、深色为其中已质押的部分，只读取当前价 ÷4 至 ×4 内最近的至多 1500 个已初始化 tick。</p>
    </section>

    {children ? <section className="panel am-facts-panel" aria-label="池子数据">{children}</section> : null}
  </div>;
}
