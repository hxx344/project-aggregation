import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, CircleAlert, LoaderCircle, RefreshCw, RotateCcw, Save, Settings2, SlidersHorizontal, Star } from 'lucide-react';
import { api, ApiError } from './api';
import AeroPoolDetail from './AeroPoolDetail';
import { readCache, writeCache } from './aero-market-cache';
import { amount, days, message, pct, signed, usd, when } from './aero-market-format';
import { bestRange, centeredRange, expectedDaysInRange, fullRange, netYield, quoteOf, rangeApr, rangeLabel, rangeTicks, rebalanceCost, riskVolOf } from './aero-market-math';
import type { NetYield, RangeChoice } from './aero-market-math';
import type { MarketChain, MarketConfig, MarketPool, MarketSamples, MarketSamplesUnchanged, MarketSnapshot, MarketUnchanged, MarketWindow } from './aero-market-types';
import './aero-lp.css';
import './aero-market.css';

const ROOT = '/api/research/aero-market';
const DAY = 86400;
const RANGES = [{ value: 0, label: '最窄（单个 tickSpacing）' }, { value: 0.01, label: '±1%' }, { value: 0.02, label: '±2%' }, { value: 0.05, label: '±5%' }, { value: 0.1, label: '±10%' }, { value: 0.2, label: '±20%' }];
const STATUS: Record<MarketChain['status'], string> = { idle: '等待首次扫描', loading: '扫描中', ok: '正常', error: '最近一次失败', disabled: '已停用' };
const HISTORY: Record<MarketChain['history']['archive'], string> = { archive: '历史区块回填', unavailable: '历史区块不可读，本机累计', local: '本机按小时累计' };
// 本地缓存不存 RPC 地址（可能带密钥）；显示缓存期间扫描设置不可用，等服务器的完整数据。
const forCache = (data: MarketSnapshot): MarketSnapshot => ({ ...data, config: { ...data.config, chains: Object.fromEntries(Object.entries(data.config.chains).map(([id, c]) => [id, { ...c, rpcUrl: '' }])) } });
const usableSnapshot = (data: unknown): data is MarketSnapshot => {
  const d = data as MarketSnapshot | null;
  return !!d && d.schema === 1 && Array.isArray(d.pools) && Array.isArray(d.chains) && !!d.config && typeof d.config.chains === 'object' && !!d.aero;
};
const NO_FAVORITES: string[] = [];
const pairName = (p: MarketPool) => `${p.token0.symbol} / ${p.token1.symbol}`;
const key = (p: MarketPool) => `${p.chain}:${p.address}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Metrics = {
  pool: MarketPool; change: number | null; stakedShare: number | null; aeroPerDay: number | null; emissionUsdYear: number | null; emissionTvl: number | null;
  apr: number | null; narrowApr: number | null; daysIn: number | null; range: [number, number];
  // best 为推荐区间：按 tickSpacing 粒度搜索的居中区间中净年化最高者。
  net: NetYield | null; best: RangeChoice | null; score: number | null; riskVol: number | null;
  // 与 RANGES 一一对应的各宽度净年化；avg 为过去窗口的平均值，由样本另行计算。
  widths: (NetYield | null)[]; avg: Average | null;
};
// 过去窗口内逐小时按当前宽度与投入重算后的平均；days 按平均调仓频率折回天数。
// score 为平均收益波动比：最佳宽度的平均净年化 ÷（各点日波动的平均 × √365），用比值的平均会被个别低波动点放大。
// 平均值的最佳宽度只在 RANGES 的几档中选：逐点细搜区间的计算量太大。
// 平均值的最佳宽度：index 指向 sums，RANGES 之后一档为推荐区间的格数。
type PresetBest = { index: number; label: string; result: NetYield } | null;
type Average = { hours: number; samples: number; widths: (NetYield | null)[]; selected: NetYield | null; best: PresetBest; score: number | null };
const WINDOWS: Record<MarketWindow, string> = { '24h': '近 24 小时', '3d': '近 3 天', '7d': '近 7 天', '30d': '近 30 天' };
const WINDOW_HOURS: Record<MarketWindow, number> = { '24h': 24, '3d': 72, '7d': 168, '30d': 720 };
const Q96 = 2 ** 96;
// 最佳宽度只在预计至少能在区间内待这么久的宽度中选：否则窄区间靠高频调仓刷出的净年化不稳定，也不现实。
const MIN_HOLD_DAYS = 1;
const widthLabel = (w: number) => (w ? `±${(w * 100).toFixed(0)}%` : '最窄');
// 交易对类型按代币美元价判断：约 1 美元视为稳定币（不限于报价锚定的 USDC/USDT）；同价对指两币价差不超过 2%，如稳定币对、cbBTC/WBTC。
const PAIRS = { all: '全部', stable: '含稳定币', volatile: '不含稳定币', pegged: '同价对（价差 ≤2%）' } as const;
type PairKind = keyof typeof PAIRS;
const isUsd = (t: MarketPool['token0']) => t.usd !== null && Math.abs(t.usd - 1) <= 0.02;
function pairMatches(pool: MarketPool, kind: PairKind) {
  if (kind === 'all') return true;
  const s0 = isUsd(pool.token0), s1 = isUsd(pool.token1);
  if (kind === 'stable') return s0 || s1;
  if (kind === 'volatile') return pool.token0.usd !== null && pool.token1.usd !== null && !s0 && !s1;
  return pool.token0.usd !== null && pool.token1.usd !== null && pool.token1.usd > 0 && Math.abs(pool.token0.usd / pool.token1.usd - 1) <= 0.02;
}
// 空输入表示不限；非数字同样不限，避免输入过程中的中间态把表格清空。
const limitOf = (text: string) => { if (!text.trim()) return null; const v = Number(text); return Number.isFinite(v) && v >= 0 ? v : null; };
type SortKey = 'score' | 'avgScore' | 'net' | 'avgNet' | 'tvl' | 'staked' | 'emission' | 'emissionTvl' | 'apr' | 'narrowApr' | 'vol24h' | 'vol7d' | 'days' | 'change';
const SORTS: Record<SortKey, (m: Metrics) => number | null> = {
  score: (m) => m.score, avgScore: (m) => m.avg?.score ?? null, net: (m) => m.best?.result.net ?? null, avgNet: (m) => m.avg?.best?.result.net ?? null,
  tvl: (m) => m.pool.tvlUsd, staked: (m) => m.stakedShare, emission: (m) => m.aeroPerDay, emissionTvl: (m) => m.emissionTvl, apr: (m) => m.apr, narrowApr: (m) => m.narrowApr,
  vol24h: (m) => m.pool.vol24h?.daily ?? null, vol7d: (m) => m.pool.vol7d?.daily ?? null, days: (m) => m.daysIn, change: (m) => m.change,
};

// 区间收益只按当前价位的质押流动性稀释：价格离开当前位置后的竞争流动性不同，结果仅用于同一时刻横向比较。
// best 由调用方传入：推荐区间只取决于池子读数、AERO 价与投入，单独缓存，切换宽度或样本到达时不重搜。
function metricsFor(pool: MarketPool, aeroUsd: number | null, width: number, deposit: number, best: RangeChoice | null): Metrics {
  const liquidity = Number(pool.liquidity), staked = Number(pool.stakedLiquidity);
  const usdPerSecond = pool.emissionPerSec !== null && aeroUsd !== null ? pool.emissionPerSec * aeroUsd : null;
  const aprFor = (range: [number, number]) => rangeApr(pool, aeroUsd, range, deposit);
  const range = rangeTicks(pool.tick, pool.tickSpacing, width);
  const riskVol = riskVolOf(pool), costFraction = rebalanceCost(pool, deposit);
  const netAt = (r: [number, number], apr: number | null) => netYield({ apr, tick: pool.tick, lower: r[0], upper: r[1], dailyVol: riskVol, costFraction });
  const widths = RANGES.map((option) => { const r = rangeTicks(pool.tick, pool.tickSpacing, option.value); return netAt(r, aprFor(r)); });
  const apr = aprFor(range);
  const emissionUsdYear = usdPerSecond === null ? null : usdPerSecond * 365 * DAY;
  // 涨跌与页面报价同向：以美元价较高的代币为基准。
  const change = pool.change24h === null ? null : (pool.token1.usd ?? 0) > (pool.token0.usd ?? 0) ? 1 / (1 + pool.change24h) - 1 : pool.change24h;
  return {
    pool, range, change,
    stakedShare: liquidity > 0 ? staked / liquidity : null,
    aeroPerDay: pool.emissionPerSec === null ? null : pool.emissionPerSec * DAY,
    emissionUsdYear, emissionTvl: emissionUsdYear !== null && pool.tvlUsd ? emissionUsdYear / pool.tvlUsd : null,
    apr, narrowApr: aprFor(rangeTicks(pool.tick, pool.tickSpacing, 0)), net: netAt(range, apr), best,
    score: best && riskVol !== null ? best.result.net / (riskVol * Math.sqrt(365)) : null,
    daysIn: expectedDaysInRange(pool.tick, range[0], range[1], riskVol),
    widths, avg: null, riskVol,
  };
}

function scoreOf(best: PresetBest, sums: { vol: number; volN: number }[]) {
  const s = best ? sums[best.index] : null;
  return best && s?.volN ? best.result.net / ((s.vol / s.volN) * Math.sqrt(365)) : null;
}

function bestOf(widths: (NetYield | null)[]): PresetBest {
  let best: PresetBest = null;
  widths.forEach((result, i) => { if (result && result.days >= MIN_HOLD_DAYS && (!best || result.net > best.result.net)) best = { index: i, label: i < RANGES.length ? widthLabel(RANGES[i].value) : '推荐宽度', result }; });
  return best;
}

// 每个样本按当时的价格、质押流动性、代币价、排放与波动重建池子读数，沿用同一套公式算各宽度净年化，再按宽度取平均。
// 区间按当时价格居中，相当于一直跟着价格调仓；调仓频率取各点 365/天数 的平均，避免个别长停留时间把平均天数拉高。
// 候选除预设宽度外还有当前推荐区间的格数（全范围则仍取全范围），在每个点按当时价格居中，使平均值与当前推荐可比。
function averageOf(pool: MarketPool, entry: MarketSamples['pools'][string] | undefined, width: number, deposit: number, recommended: RangeChoice | null): Average | null {
  if (!entry) return null;
  const full = fullRange(pool.tickSpacing);
  const recCells = recommended && !(recommended.range[0] === full[0] && recommended.range[1] === full[1]) ? (recommended.range[1] - recommended.range[0]) / pool.tickSpacing : null;
  // vol 只在该宽度结果有效的点上累计，平均收益波动比的分子分母用同一批样本。
  const sums = [...RANGES, null].map(() => ({ n: 0, net: 0, emission: 0, impermanent: 0, rebalance: 0, exits: 0, vol: 0, volN: 0 }));
  for (const [, tick, staked, usd0, usd1, emissionUsd, v24, v7, fee] of entry.samples) {
    const vol = (daily: number | null) => (daily === null ? null : { daily, annual: daily * Math.sqrt(365), samples: 0 });
    const at: MarketPool = { ...pool, tick, sqrtPriceX96: String(Math.sqrt(1.0001 ** (tick + 0.5)) * Q96), stakedLiquidity: String(staked),
      token0: { ...pool.token0, usd: usd0 }, token1: { ...pool.token1, usd: usd1 }, emissionPerSec: emissionUsd, vol24h: vol(v24), vol7d: vol(v7), fee };
    const m = metricsFor(at, 1, width, deposit, null);
    const recRange = recommended ? (recCells === null ? full : centeredRange(tick, pool.tickSpacing, recCells)) : null;
    const rec = recRange ? netYield({ apr: rangeApr(at, 1, recRange, deposit), tick, lower: recRange[0], upper: recRange[1], dailyVol: m.riskVol, costFraction: rebalanceCost(at, deposit) }) : null;
    [...m.widths, rec].forEach((r, i) => {
      if (!r) return;
      const s = sums[i];
      s.n++; s.net += r.net; s.emission += r.emission; s.impermanent += r.impermanent; s.rebalance += r.rebalance; s.exits += r.days === Infinity ? 0 : 365 / r.days;
      if (m.riskVol !== null) { s.vol += m.riskVol; s.volN++; }
    });
  }
  const all = sums.map((s) => (s.n ? { net: s.net / s.n, emission: s.emission / s.n, impermanent: s.impermanent / s.n, rebalance: s.rebalance / s.n, days: s.exits > 0 ? 365 / (s.exits / s.n) : Infinity } : null));
  const index = RANGES.findIndex((r) => r.value === width);
  const widths = all.slice(0, RANGES.length);
  const best = bestOf(all);
  return { hours: entry.hours, samples: Math.max(...sums.map((s) => s.n)), widths, selected: index >= 0 ? widths[index] : null, best,
    score: scoreOf(best, sums) };
}


// 详情页底部的池子数据；净年化按列表当前的区间宽度与投入，便于和列表对照。
function PoolFacts({ metrics, width, average }: { metrics: Metrics; width: number; average: string }) {
  const { pool } = metrics;
  return <dl className="am-detail-facts">
    <div><dt>池子</dt><dd><code>{pool.address}</code></dd></div>
    <div><dt>Gauge</dt><dd>{pool.gauge ? <code>{pool.gauge}</code> : '无（不产生排放）'}</dd></div>
    <div><dt>净年化（列表 {widthLabel(width)}）</dt><dd>{pct(metrics.net?.net, 0)}<small>{metrics.net ? `排放 ${pct(metrics.net.emission, 0)} − 无常损失 ${pct(metrics.net.impermanent, 0)} − 调仓 ${pct(metrics.net.rebalance, 0)}` : '缺少波动率或排放'}{metrics.best ? `；推荐 ${rangeLabel(pool, metrics.best.range)} 为 ${pct(metrics.best.result.net, 0)}` : ''}</small></dd></div>
    <div><dt>平均净年化（列表 {widthLabel(width)}）</dt><dd>{pct(metrics.avg?.selected?.net, 0)}<small>{metrics.avg?.selected ? `排放 ${pct(metrics.avg.selected.emission, 0)} − 无常损失 ${pct(metrics.avg.selected.impermanent, 0)} − 调仓 ${pct(metrics.avg.selected.rebalance, 0)}；${average}` : average}{metrics.avg?.best ? `；最佳 ${metrics.avg.best.label} 为 ${pct(metrics.avg.best.result.net, 0)}` : ''}</small></dd></div>
    <div><dt>TVL / 质押占比</dt><dd>{usd(pool.tvlUsd)} · {pct(metrics.stakedShare, 0)}<small>质押占比 = 当前价位质押流动性 / 全部流动性</small></dd></div>
    <div><dt>日排放</dt><dd>{metrics.aeroPerDay === null ? '—' : `${amount(metrics.aeroPerDay)} AERO`}<small>{usd(metrics.emissionUsdYear === null ? null : metrics.emissionUsdYear / 365)} / 天 · 排放/TVL {pct(metrics.emissionTvl, 0)}</small></dd></div>
    <div><dt>手续费</dt><dd>{pool.fee === null ? '—' : `${(pool.fee / 1e4).toFixed(3)}%`}<small>未质押分成 {pool.unstakedFee === null ? '—' : `${(pool.unstakedFee / 1e4).toFixed(0)}%`}</small></dd></div>
    <div><dt>排放速率窗口</dt><dd>{pool.emissionWindowSec ? `${(pool.emissionWindowSec / 3600).toFixed(1)} 小时` : '—'}<small>按 voter 累计排放份额的差值计算</small></dd></div>
    <div><dt>波动率样本</dt><dd>24h {pool.vol24h?.samples ?? 0} 个 · 7d {pool.vol7d?.samples ?? 0} 个<small>日波动 24h {pct(pool.vol24h?.daily, 2)} · 7d {pct(pool.vol7d?.daily, 2)}；24h 涨跌 {signed(metrics.change)}</small></dd></div>
    <div><dt>代币报价</dt><dd>{pool.token0.symbol} {usd(pool.token0.usd)} · {pool.token1.symbol} {usd(pool.token1.usd)}<small>从稳定币按池子深度逐级推算</small></dd></div>
  </dl>;
}

function SettingsForm({ config, busy, onSave }: { config: MarketConfig; busy: boolean; onSave: (next: MarketConfig) => void }) {
  const [draft, setDraft] = useState(config);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(draft.intervalMin) || draft.intervalMin < 5 || draft.intervalMin > 240) { setError('刷新间隔须为 5–240 分钟的整数'); return; }
    if (!(draft.minTvlUsd >= 0)) { setError('TVL 门槛不能为负'); return; }
    setError(''); onSave({ ...draft, chains: Object.fromEntries(Object.entries(draft.chains).map(([id, c]) => [id, { ...c, rpcUrl: c.rpcUrl.trim() }])) });
  };
  const chain = (id: string, patch: Partial<MarketConfig['chains'][string]>) => setDraft((d) => ({ ...d, chains: { ...d.chains, [id]: { ...d.chains[id], ...patch } } }));
  return <form className="panel lp-section" onSubmit={submit} noValidate aria-label="扫描设置">
    <div className="panel-heading"><h2>扫描设置</h2><span className="muted">只读公共 RPC，不需要私钥；保存后按新设置重新排程</span></div>
    <fieldset disabled={busy}>
      <div className="lp-grid">
        <label className="lp-field am-check"><span><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用扫描</span><small>停用后保留已有数据，不再访问 RPC</small></label>
        <label className="lp-field">刷新间隔（分钟）<input type="number" min={5} max={240} step={1} value={draft.intervalMin} onChange={(e) => setDraft({ ...draft, intervalMin: Number(e.target.value) })} /><small>每条链独立排程，上一轮结束后才计时</small></label>
        <label className="lp-field">无 gauge 池子的 TVL 门槛（美元）<input type="number" min={0} step={1000} value={draft.minTvlUsd} onChange={(e) => setDraft({ ...draft, minTvlUsd: Number(e.target.value) })} /><small>有 gauge 且有流动性的池子始终跟踪</small></label>
      </div>
      <h3>各链 RPC</h3>
      <div className="am-chain-config">{Object.entries(draft.chains).map(([id, c]) => <div key={id}>
        <label className="am-check"><input type="checkbox" checked={c.enabled} onChange={(e) => chain(id, { enabled: e.target.checked })} /> {id}</label>
        <input aria-label={`${id} RPC 地址`} value={c.rpcUrl} onChange={(e) => chain(id, { rpcUrl: e.target.value })} spellCheck={false} />
      </div>)}</div>
    </fieldset>
    <div className="lp-form-actions"><span>{error ? <span className="lp-error">{error}</span> : 'RPC 只显示主机名于状态栏；地址带密钥时请使用自己的节点'}</span><div><button className="button primary" type="submit" disabled={busy}><Save size={15} />保存设置</button></div></div>
  </form>;
}

export default function AeroMarketPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [chainFilter, setChainFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [width, setWidth] = useState(0.05);
  const [depositText, setDepositText] = useState('1000');
  const [minTvlText, setMinTvlText] = useState('100000');
  const [emittingOnly, setEmittingOnly] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [pairKind, setPairKind] = useState<PairKind>('all');
  const [spacing, setSpacing] = useState('all');
  const [minAprText, setMinAprText] = useState('');
  const [minNetText, setMinNetText] = useState('');
  const [minAvgText, setMinAvgText] = useState('');
  const [avgWindow, setAvgWindow] = useState<MarketWindow | 'off'>('7d');
  const [samples, setSamples] = useState<{ window: MarketWindow; version: number; data: MarketSamples | null; error: string } | null>(null);
  const samplesGeneration = useRef(0);
  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [minScoreText, setMinScoreText] = useState('');
  const [minAvgScoreText, setMinAvgScoreText] = useState('');
  const [maxVolText, setMaxVolText] = useState('');
  const [minDaysText, setMinDaysText] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'score', desc: true });
  const [limit, setLimit] = useState(60);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // 收藏先在本地生效，再按顺序同步到服务端；同步中只发送最新的列表。
  const [pendingFavorites, setPendingFavorites] = useState<string[] | null>(null);
  const desiredFavorites = useRef<string[] | null>(null);
  const syncingFavorites = useRef(false);
  // 详情页由地址栏 pool=链:地址 决定，浏览器后退回到列表；工作台切换页面时也按地址栏重新判断。
  const [, setRouteTick] = useState(0);
  const detailKey = new URLSearchParams(location.search).get('pool');
  const listScroll = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef<number | null>(null);
  const generation = useRef(0);
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  const accept = useCallback((data: MarketSnapshot) => {
    revision.current = data.revision; setSnapshot(data); setCachedAt(null); setLoadError('');
    void writeCache('snapshot', forCache(data));
  }, []);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const version = ++generation.current;
    try {
      const data = await api<MarketSnapshot | MarketUnchanged>(revision.current === null ? ROOT : `${ROOT}?revision=${revision.current}`, { signal, timeoutMs: 20_000 });
      if (signal.aborted || version !== generation.current) return;
      if (data.unchanged) { setLoadError(''); setSnapshot((s) => (s ? { ...s, serverNow: data.serverNow } : s)); } else accept(data);
    } catch (reason) { if (!signal.aborted && version === generation.current) fail(reason, setLoadError); }
  }, [accept, fail]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    // 先显示本机缓存，服务器的数据到了再替换；服务器先到（revision 已有值）时缓存直接作废。
    void readCache<MarketSnapshot>('snapshot').then((hit) => {
      if (!hit || controller.signal.aborted || revision.current !== null || !usableSnapshot(hit.data)) return;
      setSnapshot(hit.data); setCachedAt(hit.savedAt);
    });
    void read();
    const poll = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [read]);
  const execute = async (name: string, path: string, method: string, body: unknown) => {
    const signal = lifetime.current?.signal;
    if (!signal || busy) return;
    generation.current++;
    setBusy(name); setActionError('');
    try { const data = await api<MarketSnapshot>(ROOT + path, { method, body: JSON.stringify(body), signal, timeoutMs: 20_000 }); if (!signal.aborted) { accept(data); if (name === 'save') setShowSettings(false); } }
    catch (reason) { if (!signal.aborted) fail(reason, setActionError); }
    finally { if (!signal.aborted) setBusy(''); }
  };

  const deposit = Math.max(Number(depositText) || 0, 0);
  const favorites = pendingFavorites ?? snapshot?.favorites ?? NO_FAVORITES;
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const minTvl = Math.max(Number(minTvlText) || 0, 0);
  const aeroUsd = snapshot?.aero.usd ?? null;
  const chainNames = useMemo(() => new Map((snapshot?.chains ?? []).map((c) => [c.id, c.name])), [snapshot]);
  const samplesVersion = snapshot?.samples?.version ?? null;
  // 服务端按启用的链过滤样本：启停链后同一整点内样本版本不变，也要重读。
  const enabledChains = snapshot ? (snapshot.config.enabled ? Object.keys(snapshot.config.chains).filter((id) => snapshot.config.chains[id].enabled).sort().join(',') : '') : '';
  // 样本每整点才有新点：只在窗口切换、启用链变化或服务端样本版本变化时重读，不跟随 30 秒轮询。迟到的旧窗口响应按代次丢弃。
  // 手里没有该窗口的数据时先取本机缓存；请求带上 tag，服务端内容未变时只回未变化标记，不重发样本。
  // 快照还是本机缓存时只显示缓存样本、不发请求：服务器快照到了样本版本多半会变，提前请求会把约 700 KB 下载两遍。
  const freshSnapshot = cachedAt === null;
  useEffect(() => {
    if (avgWindow === 'off' || samplesVersion === null) return;
    const page = lifetime.current?.signal;
    if (!page) return;
    // 每轮自带取消：窗口、版本或启用链一变就中止上一轮还在下载的样本。
    const run = new AbortController();
    const signal = AbortSignal.any([page, run.signal]);
    const version = ++samplesGeneration.current;
    const current = () => !signal.aborted && version === samplesGeneration.current;
    const key = `samples:${avgWindow}`;
    void (async () => {
      let held = samplesRef.current?.window === avgWindow ? samplesRef.current.data : null;
      if (!held) {
        setSamples({ window: avgWindow, version: samplesVersion, data: null, error: '' });
        const hit = await readCache<MarketSamples>(key);
        if (!current()) return;
        if (hit && hit.data?.window === avgWindow && hit.data.available && typeof hit.data.tag === 'string' && hit.data.pools && typeof hit.data.pools === 'object') {
          held = hit.data;
          setSamples({ window: avgWindow, version: samplesVersion, data: held, error: '' });
        }
      }
      const kept = held;
      if (!freshSnapshot) return;
      try {
        const data = await api<MarketSamples | MarketSamplesUnchanged>(`${ROOT}/samples?window=${avgWindow}${kept?.tag ? `&tag=${encodeURIComponent(kept.tag)}` : ''}`, { signal, timeoutMs: 20_000 });
        if (!current()) return;
        if (data.unchanged) { setSamples({ window: avgWindow, version: samplesVersion, data: kept, error: '' }); return; }
        setSamples({ window: avgWindow, version: samplesVersion, data, error: '' });
        if (data.available && data.tag) void writeCache(key, data);
      } catch (reason) { if (current()) fail(reason, (text) => setSamples({ window: avgWindow, version: samplesVersion, data: kept, error: text })); }
    })();
    return () => run.abort();
  }, [avgWindow, samplesVersion, enabledChains, freshSnapshot, fail]);
  const sampleData = avgWindow !== 'off' && samples?.window === avgWindow ? samples.data : null;
  const recommended = useMemo(() => new Map((snapshot?.pools ?? []).map((p) => [key(p), bestRange(p, aeroUsd, deposit, MIN_HOLD_DAYS)])), [snapshot, aeroUsd, deposit]);
  const all = useMemo(() => (snapshot?.pools ?? []).map((p) => {
    const best = recommended.get(key(p)) ?? null, m = metricsFor(p, aeroUsd, width, deposit, best);
    return sampleData?.available ? { ...m, avg: averageOf(p, sampleData.pools[key(p)], width, deposit, best) } : m;
  }), [snapshot, aeroUsd, width, deposit, sampleData, recommended]);
  // 平均值的状态说明：样本库不可用、读取中、还在累计或覆盖不足时都要讲清楚，不能让空列看起来像是池子没收益。
  const averageNote = (m: Metrics | null) => {
    if (avgWindow === 'off') return '未计算（在筛选栏选择平均窗口）';
    if (snapshot?.samples === undefined) return '服务端未提供样本，更新后可用';
    if (samples?.window === avgWindow && samples.error) return `样本读取失败：${samples.error}`;
    if (!sampleData) return '正在读取样本…';
    if (!sampleData.available) return `样本库不可用${sampleData.error ? `：${sampleData.error}` : ''}`;
    if (!m?.avg) return `${WINDOWS[avgWindow]}还没有该池的排放样本（每小时记录一次）`;
    return `${WINDOWS[avgWindow]} ${m.avg.hours} / ${WINDOW_HOURS[avgWindow]} 小时有样本，按 ${m.avg.samples} 个点平均`;
  };
  const spacings = useMemo(() => [...new Set((snapshot?.pools ?? []).map((p) => p.tickSpacing))].sort((a, b) => a - b), [snapshot]);
  // 轮询后若所选档位已不存在，按“全部”处理，避免下拉框与结果错位。
  const spacingValue = spacing !== 'all' && spacings.includes(Number(spacing)) ? spacing : 'all';
  const minNet = minNetText.trim() && Number.isFinite(Number(minNetText)) ? Number(minNetText) : null;
  const minAvg = minAvgText.trim() && Number.isFinite(Number(minAvgText)) ? Number(minAvgText) : null;
  const minScore = minScoreText.trim() && Number.isFinite(Number(minScoreText)) ? Number(minScoreText) : null;
  const minAvgScore = minAvgScoreText.trim() && Number.isFinite(Number(minAvgScoreText)) ? Number(minAvgScoreText) : null;
  const minApr = limitOf(minAprText), maxVol = limitOf(maxVolText), minDays = limitOf(minDaysText);
  const advancedCount = [pairKind !== 'all', spacingValue !== 'all', minScore !== null, minAvgScore !== null, minNet !== null, minAvg !== null, minApr !== null, maxVol !== null, minDays !== null].filter(Boolean).length;
  const rows = useMemo(() => {
    const words = search.trim().toLowerCase().split(/[\s/,]+/).filter(Boolean);
    const pick = SORTS[sort.key];
    // 指标缺失的池子在设了对应门槛时排除：无法判断是否满足。
    const vol = (m: Metrics) => m.pool.vol24h?.daily ?? m.pool.vol7d?.daily ?? null;
    return all.filter((m) => (chainFilter === 'all' || m.pool.chain === chainFilter)
      && (!favoritesOnly || favoriteSet.has(key(m.pool)))
      && (!emittingOnly || (m.pool.emissionPerSec ?? 0) > 0)
      && (m.pool.tvlUsd ?? 0) >= minTvl
      && pairMatches(m.pool, pairKind)
      && (spacingValue === 'all' || m.pool.tickSpacing === Number(spacingValue))
      && (minScore === null || (m.score !== null && m.score >= minScore))
      && (minAvgScore === null || (m.avg?.score != null && m.avg.score >= minAvgScore))
      && (minNet === null || (m.best !== null && m.best.result.net * 100 >= minNet))
      && (minAvg === null || (m.avg?.best ? m.avg.best.result.net * 100 >= minAvg : false))
      && (minApr === null || (m.apr !== null && m.apr * 100 >= minApr))
      && (maxVol === null || ((vol(m) ?? Infinity) * 100 <= maxVol))
      && (minDays === null || (m.daysIn !== null && m.daysIn >= minDays))
      && words.every((w) => m.pool.token0.symbol.toLowerCase().includes(w) || m.pool.token1.symbol.toLowerCase().includes(w) || m.pool.address.startsWith(w)))
      .sort((a, b) => { const x = pick(a), y = pick(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return sort.desc ? y - x : x - y; });
  }, [all, chainFilter, favoritesOnly, favoriteSet, emittingOnly, minTvl, search, sort, pairKind, spacingValue, minScore, minAvgScore, minNet, minAvg, minApr, maxVol, minDays]);
  const resetFilters = () => {
    setChainFilter('all'); setSearch(''); setMinTvlText('100000'); setEmittingOnly(true);
    setPairKind('all'); setSpacing('all'); setMinScoreText(''); setMinAvgScoreText(''); setMinNetText(''); setMinAvgText(''); setMinAprText(''); setMaxVolText(''); setMinDaysText('');
  };
  useEffect(() => { const change = () => setRouteTick((v) => v + 1); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  const openPool = (pool: MarketPool) => {
    const params = new URLSearchParams(location.search);
    params.set('pool', key(pool));
    listScroll.current = window.scrollY;
    history.pushState({ aeroPool: true }, '', `${location.pathname}?${params}`);
    setRouteTick((v) => v + 1);
  };
  const closePool = () => {
    if ((history.state as { aeroPool?: boolean } | null)?.aeroPool) { history.back(); return; }
    // 直接打开详情链接时没有可后退的列表页：替换地址回到列表。
    const params = new URLSearchParams(location.search);
    params.delete('pool');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    setRouteTick((v) => v + 1);
  };
  const inDetail = detailKey !== null;
  useLayoutEffect(() => { window.scrollTo(0, inDetail ? 0 : listScroll.current); }, [inDetail]);

  const syncFavorites = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || syncingFavorites.current) return;
    syncingFavorites.current = true;
    try {
      while (!signal.aborted && desiredFavorites.current) {
        const list = desiredFavorites.current;
        // 发出与完成时都让进行中的列表读取作废，避免旧收藏覆盖刚改的（L089）。
        generation.current++;
        try {
          const data = await api<MarketSnapshot>(`${ROOT}/favorites`, { method: 'PUT', body: JSON.stringify({ favorites: list }), signal, timeoutMs: 20_000 });
          generation.current++;
          if (signal.aborted) return;
          // 被更新的列表取代时也接收：显示仍由待同步列表覆盖，之后若失败可回到服务端的真实状态。
          accept(data);
          if (desiredFavorites.current !== list) continue;
          desiredFavorites.current = null; setPendingFavorites(null);
        } catch (reason) {
          generation.current++;
          if (signal.aborted) return;
          desiredFavorites.current = null; setPendingFavorites(null);
          fail(reason, (text) => setActionError(`收藏未保存：${text}`));
        }
      }
    } finally { syncingFavorites.current = false; }
  };
  const toggleFavorite = (pool: MarketPool) => {
    const k = key(pool), next = favoriteSet.has(k) ? favorites.filter((f) => f !== k) : [...favorites, k];
    setActionError('');
    desiredFavorites.current = next; setPendingFavorites(next);
    void syncFavorites();
  };
  const favoriteDisabled = cachedAt !== null;

  const header = (k: SortKey, label: string, title?: string) => <th scope="col" className="num" aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className="am-sort" title={title} onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }))}>{label}{sort.key === k ? sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} /> : null}</button>
  </th>;

  if (!snapshot) return <div className="lp-page">{loadError ? <div className="panel lp-empty"><CircleAlert /><p>{loadError}</p><button className="button secondary" onClick={() => void read()}><RefreshCw size={15} />重试</button></div>
    : <div className="panel lp-empty" role="status"><LoaderCircle className="spin" /><p>正在读取 Aero 市场数据…</p></div>}</div>;

  if (detailKey !== null) {
    const detail = all.find((m) => key(m.pool) === detailKey);
    if (!detail) return <div className="lp-page am-page"><div className="panel lp-empty"><CircleAlert /><p>没有找到这个池子：可能已不在跟踪范围内，或所在的链已停用。</p><button className="button secondary" onClick={closePool}><ArrowLeft size={15} />返回列表</button></div></div>;
    return <AeroPoolDetail key={detailKey} pool={detail.pool} chainName={chainNames.get(detail.pool.chain) ?? detail.pool.chain} aeroUsd={aeroUsd} initialWidth={width} recommended={detail.best?.range ?? null}
      depositText={depositText} onDeposit={setDepositText} favorite={favoriteSet.has(detailKey)} favoriteDisabled={favoriteDisabled} onFavorite={() => toggleFavorite(detail.pool)} onBack={closePool} onExpired={onExpired}
      notice={actionError}>
      <PoolFacts metrics={detail} width={width} average={averageNote(detail)} />
    </AeroPoolDetail>;
  }

  const staleAfter = snapshot.config.intervalMin * 60_000 * 2 + 120_000;
  return <div className="lp-page am-page">
    <div className="lp-heading">
      <div><h1>Aero 市场</h1><p>各链 Aero CL 池的 TVL、排放年化与波动率，按区间宽度和投入金额估算，用于比较入场机会。数据只读链上，AERO {usd(aeroUsd)}{snapshot.aero.at ? `（${when(snapshot.aero.at)}）` : ''}</p></div>
      <div className="lp-toolbar">
        <button className="button secondary" disabled={cachedAt !== null} onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}><Settings2 size={15} />扫描设置</button>
        <button className="button secondary" disabled={!!busy || cachedAt !== null || !snapshot.config.enabled} onClick={() => void execute('refresh', '/refresh', 'POST', {})}><RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />立即刷新</button>
      </div>
    </div>
    {cachedAt !== null ? <div className="lp-callout" role="status">{loadError ? <CircleAlert size={15} /> : <LoaderCircle size={15} className="spin" />}显示的是本机缓存（{when(cachedAt)} 保存），{loadError ? '服务器暂时读不到，30 秒后自动重试' : '正在从服务器更新…'}{loadError ? <button className="button secondary" onClick={() => void read()}><RefreshCw size={15} />重试</button> : null}</div> : null}
    {snapshot.configError ? <div className="lp-callout warning"><CircleAlert size={15} />{snapshot.configError}</div> : null}
    {!snapshot.config.enabled ? <div className="lp-callout warning"><CircleAlert size={15} />扫描已停用，页面显示的是上次保存的数据。可在「扫描设置」中启用。</div> : null}
    {loadError ? <div className="lp-callout warning"><CircleAlert size={15} />刷新失败：{loadError}（显示的是上次读取的数据）</div> : null}
    {actionError ? <div className="lp-callout warning"><CircleAlert size={15} />{actionError}</div> : null}
    {showSettings && cachedAt === null ? <SettingsForm config={snapshot.config} busy={!!busy} onSave={(next) => void execute('save', '/config', 'PUT', { config: next })} /> : null}

    <section className="am-chains" aria-label="各链状态">{snapshot.chains.map((c) => {
      const stale = c.enabled && c.updatedAt !== null && snapshot.serverNow - c.updatedAt > staleAfter;
      return <div key={c.id} className={`panel am-chain ${c.status}${stale ? ' stale' : ''}`}>
        <div className="am-chain-head"><strong>{c.name}</strong><span className="am-chain-status">{c.status === 'loading' ? <LoaderCircle size={12} className="spin" /> : null}{stale ? '数据过期' : STATUS[c.status]}</span></div>
        <span>{c.activeCount ?? '—'} 个跟踪 / {c.poolCount ?? '—'} 个池 · {c.gaugeCount ?? '—'} 个有 gauge</span>
        <span>数据 {when(c.updatedAt)}{c.nextAt && c.enabled ? ` · 下次 ${when(c.nextAt)}` : ''}</span>
        <span title={c.rpcHost}>{HISTORY[c.history.archive]} · {c.history.points} 点{c.enabled && c.history.archive === 'archive' && c.history.pending > 0 ? ` · 还差 ${c.history.pending} 小时未补` : ''}</span>
        {c.error ? <span className="lp-error" title={c.error}>{when(c.errorAt)} {c.error}</span> : null}
      </div>;
    })}</section>

    <section className="panel" aria-label="池子列表">
      <div className="am-filters">
        <label>链<select value={chainFilter} onChange={(e) => setChainFilter(e.target.value)}><option value="all">全部</option>{snapshot.chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>搜索<input type="search" placeholder="代币或池子地址" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>区间宽度<select value={width} onChange={(e) => setWidth(Number(e.target.value))}>{RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label>投入（美元）<input type="number" min={1} step={100} value={depositText} onChange={(e) => setDepositText(e.target.value)} /></label>
        <label>平均窗口<select value={avgWindow} onChange={(e) => setAvgWindow(e.target.value as MarketWindow | 'off')}>{Object.entries(WINDOWS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="off">不计算</option></select></label>
        <label>最低 TVL（美元）<input type="number" min={0} step={1000} value={minTvlText} onChange={(e) => setMinTvlText(e.target.value)} /></label>
        <label className="am-check"><input type="checkbox" checked={emittingOnly} onChange={(e) => setEmittingOnly(e.target.checked)} />只看有排放</label>
        <label className="am-check"><input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} />只看收藏{favorites.length ? `（${favorites.length}）` : ''}</label>
        <button type="button" className="button secondary am-more-toggle" aria-expanded={showMore} aria-controls="am-more-filters" onClick={() => setShowMore((v) => !v)}><SlidersHorizontal size={14} />更多筛选{advancedCount ? `（${advancedCount}）` : ''}</button>
        <span className="am-count">符合 {rows.length} / {all.length} 个池子</span>
      </div>
      <div className="am-filters am-filters-more" id="am-more-filters" hidden={!showMore}>
        <label>交易对<select value={pairKind} onChange={(e) => setPairKind(e.target.value as PairKind)}>{Object.entries(PAIRS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>CL 档位<select value={spacingValue} onChange={(e) => setSpacing(e.target.value)}><option value="all">全部</option>{spacings.map((v) => <option key={v} value={v}>CL{v}</option>)}</select></label>
        <label>最低收益波动比<input type="number" step={0.5} placeholder="不限" value={minScoreText} onChange={(e) => setMinScoreText(e.target.value)} /></label>
        <label>最低平均收益波动比<input type="number" step={0.5} placeholder="不限" value={minAvgScoreText} onChange={(e) => setMinAvgScoreText(e.target.value)} /></label>
        <label>最低净年化（%）<input type="number" step={10} placeholder="不限" value={minNetText} onChange={(e) => setMinNetText(e.target.value)} /></label>
        <label>最低平均净年化（%）<input type="number" step={10} placeholder="不限" value={minAvgText} onChange={(e) => setMinAvgText(e.target.value)} /></label>
        <label>最低区间年化（%）<input type="number" min={0} step={10} placeholder="不限" value={minAprText} onChange={(e) => setMinAprText(e.target.value)} /></label>
        <label>最高日波动（%）<input type="number" min={0} step={0.5} placeholder="不限" value={maxVolText} onChange={(e) => setMaxVolText(e.target.value)} /></label>
        <label>最少在区间（天）<input type="number" min={0} step={1} placeholder="不限" value={minDaysText} onChange={(e) => setMinDaysText(e.target.value)} /></label>
        <button type="button" className="button secondary" onClick={resetFilters}><RotateCcw size={14} />重置筛选</button>
        <small className="am-filter-hint">最高日波动按 24h（样本不足时用 7d）筛选；设了门槛时缺少该指标的池子不显示。区间年化、净年化与在区间天数随上面的区间宽度和投入变化。</small>
      </div>
      <p className="am-note">排放年化 = 池子排放（AERO 计价）×（你的流动性 /（当前价位质押流动性 + 你的））÷ 投入，假设全程在区间内并质押；价格移动后的竞争流动性不同，仅用于同一时刻横向比较。不含手续费：质押仓位的手续费归投票者。预计在区间时间按日波动 σ 的无漂移随机游走估算。
        净年化 = 排放年化 − 无常损失 365·σ²/(4h) − 调仓成本 365/在区间天数 ×（0.5×费率 + gas/投入）；σ 取 24h 与 7d 日波动中较大者（最低按 0.1%/天），h 约为区间对数半宽（按仓位实际价值精确计算），gas 按 Ethereum 10 美元、其余链 0.2 美元估算；推荐区间按 tickSpacing 粒度（最小一格）以当前价居中搜索宽度，从最窄到当前价 ÷4 至 ×4 及全范围，在预计至少待满 1 天的区间中取净年化最高者并标出上下沿涨跌幅（不考虑把当前价放在靠近一侧边沿的摆放），点进池子可一键套用。平均净年化：服务端每小时记录一次各池读数（保留 30 天，从本功能上线后开始累计），按当前所选宽度与投入逐点重算净年化后取平均，长窗口均匀抽 24 个点；最佳宽度在各预设宽度与推荐区间的格数（每个点按当时价格居中）中，按平均值在平均在区间至少 1 天的宽度中选，能看出排放与流动性变化后收益是否持续。收益波动比 = 净年化 ÷（日波动 × √365），即每承担一份年化波动换来的净收益，默认按它排序；平均收益波动比 = 平均净年化（最佳宽度）÷（窗口内各点日波动的平均 × √365），看这份性价比是否持续；稳定币对的脱锚风险、代币单边下跌（趋势）与排放随投票周期变化不在公式内，不含稳定币的交易对还承担两个币对美元的整体涨跌。</p>
      <div className="lp-table-scroll"><table className="lp-table am-table">
        <thead><tr>
          <th scope="col">池子</th>
          {header('score', '收益波动比', '净年化 ÷ 年化波动（σ × √365）')}{header('avgScore', '平均收益波动比', avgWindow === 'off' ? '在筛选栏选择平均窗口后计算' : `${WINDOWS[avgWindow]}平均净年化 ÷ 平均年化波动`)}{header('net', '净年化', '推荐区间：按 tickSpacing 粒度搜索以当前价居中、预计在区间至少 1 天的区间中净年化最高者（排放 − 无常损失 − 调仓成本）')}{header('avgNet', '平均净年化', avgWindow === 'off' ? '在筛选栏选择平均窗口后计算' : `${WINDOWS[avgWindow]}逐小时重算净年化的平均，在预设宽度与推荐区间宽度中取平均值最高者`)}{header('tvl', 'TVL')}{header('staked', '质押占比', '当前价位质押流动性 / 全部流动性')}
          {header('emission', '日排放', '每天发给该池的 AERO')}{header('emissionTvl', '排放/TVL', '年化排放价值除以池子 TVL')}
          {header('apr', '区间年化', '所选区间宽度下的排放年化')}{header('narrowApr', '最窄年化', '单个 tickSpacing 区间的排放年化')}
          {header('vol24h', '日波动 24h', '小时对数收益折算到 1 天')}{header('vol7d', '日波动 7d')}
          {header('days', '在区间', '所选区间内的预计停留时间')}{header('change', '24h 涨跌')}
        </tr></thead>
        <tbody>{rows.slice(0, limit).map((m) => {
          const k = key(m.pool), starred = favoriteSet.has(k);
          return <tr key={k} onClick={() => openPool(m.pool)}>
              <th scope="row"><span className="am-pool-cell"><button type="button" className={`am-star${starred ? ' on' : ''}`} aria-pressed={starred} aria-label={`${starred ? '取消收藏' : '收藏'} ${pairName(m.pool)}`} title={favoriteDisabled ? '正在连接服务器，稍后可收藏' : starred ? '取消收藏' : '收藏'} disabled={favoriteDisabled} onClick={(e) => { e.stopPropagation(); toggleFavorite(m.pool); }}><Star size={15} /></button>
                <button type="button" className="am-pool" title="查看池子详情"><strong>{pairName(m.pool)}</strong><small>{chainNames.get(m.pool.chain)} · CL{m.pool.tickSpacing} · {m.pool.fee === null ? '—' : `${(m.pool.fee / 1e4).toFixed(2)}%`} · {short(m.pool.address)}</small></button></span></th>
              <td className="num strong">{m.score === null ? '—' : m.score.toFixed(1)}</td>
              <td className="num" title={averageNote(m)}>{m.avg?.score == null ? '—' : m.avg.score.toFixed(1)}</td>
              <td className={`num ${(m.best?.result.net ?? 0) > 0 ? 'up' : (m.best?.result.net ?? 0) < 0 ? 'down' : ''}`}>{pct(m.best?.result.net, 0)}<small>{m.best ? `${rangeLabel(m.pool, m.best.range)} · ${days(m.best.result.days)}` : ''}</small></td>
              <td className={`num ${(m.avg?.best?.result.net ?? 0) > 0 ? 'up' : (m.avg?.best?.result.net ?? 0) < 0 ? 'down' : ''}`} title={averageNote(m)}>{pct(m.avg?.best?.result.net, 0)}<small>{m.avg?.best ? `${m.avg.best.label} · ${m.avg.hours} 小时` : ''}</small></td>
              <td className="num">{usd(m.pool.tvlUsd)}</td><td className="num">{pct(m.stakedShare, 0)}</td>
              <td className="num">{m.aeroPerDay === null ? '—' : amount(m.aeroPerDay)}<small>{usd(m.emissionUsdYear === null ? null : m.emissionUsdYear / 365)}</small></td>
              <td className="num">{pct(m.emissionTvl, 0)}</td>
              <td className="num">{pct(m.apr, 0)}</td><td className="num">{pct(m.narrowApr, 0)}</td>
              <td className="num">{pct(m.pool.vol24h?.daily, 2)}</td><td className="num">{pct(m.pool.vol7d?.daily, 2)}</td>
              <td className="num">{days(m.daysIn)}</td>
              <td className={`num ${(m.change ?? 0) > 0 ? 'up' : (m.change ?? 0) < 0 ? 'down' : ''}`} title={quoteOf(m.pool).pair}>{signed(m.change)}</td>
            </tr>;
        })}
        {!rows.length ? <tr><td colSpan={15} className="lp-table-empty">{snapshot.pools.length ? '没有符合筛选条件的池子' : '还没有扫描结果；首次扫描每条链约需 1 分钟'}</td></tr> : null}</tbody>
      </table></div>
      {rows.length > limit ? <div className="am-more"><button className="button secondary" onClick={() => setLimit((v) => v + 60)}>显示更多（共 {rows.length} 个）</button></div> : null}
    </section>
  </div>;
}
