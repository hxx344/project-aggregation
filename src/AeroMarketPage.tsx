import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowUp, CircleAlert, LoaderCircle, RefreshCw, Save, Settings2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from './api';
import { dilutedApr, expectedDaysInRange, liquidityUnitUsd, rangeTicks } from './aero-market-math';
import type { MarketChain, MarketConfig, MarketPool, MarketPoolHistory, MarketSnapshot, MarketUnchanged } from './aero-market-types';
import './aero-lp.css';
import './aero-market.css';

const ROOT = '/api/research/aero-market';
const DAY = 86400;
const RANGES = [{ value: 0, label: '最窄（单个 tickSpacing）' }, { value: 0.01, label: '±1%' }, { value: 0.02, label: '±2%' }, { value: 0.05, label: '±5%' }, { value: 0.1, label: '±10%' }, { value: 0.2, label: '±20%' }];
const STATUS: Record<MarketChain['status'], string> = { idle: '等待首次扫描', loading: '扫描中', ok: '正常', error: '最近一次失败', disabled: '已停用' };
const HISTORY: Record<MarketChain['history']['archive'], string> = { archive: '历史区块回填', unavailable: '历史区块不可读，本机累计', local: '本机按小时累计' };
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const when = (ms: number | null) => (ms ? dates.format(ms) : '—');
const message = (reason: unknown) => (reason instanceof Error ? reason.message : '请求失败，请重试。');
const usd = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
const signed = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const days = (v: number | null) => (v === null ? '—' : v >= 365 ? '>1 年' : v >= 10 ? `${v.toFixed(0)} 天` : v >= 1 ? `${v.toFixed(1)} 天` : `${(v * 24).toFixed(1)} 小时`);
const amount = (v: number) => (v >= 1e4 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
const pairName = (p: MarketPool) => `${p.token0.symbol} / ${p.token1.symbol}`;
const key = (p: MarketPool) => `${p.chain}:${p.address}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Metrics = {
  pool: MarketPool; change: number | null; stakedShare: number | null; aeroPerDay: number | null; emissionUsdYear: number | null; emissionTvl: number | null;
  apr: number | null; narrowApr: number | null; daysIn: number | null; range: [number, number];
};
type SortKey = 'tvl' | 'staked' | 'emission' | 'emissionTvl' | 'apr' | 'narrowApr' | 'vol24h' | 'vol7d' | 'days' | 'change';
const SORTS: Record<SortKey, (m: Metrics) => number | null> = {
  tvl: (m) => m.pool.tvlUsd, staked: (m) => m.stakedShare, emission: (m) => m.aeroPerDay, emissionTvl: (m) => m.emissionTvl, apr: (m) => m.apr, narrowApr: (m) => m.narrowApr,
  vol24h: (m) => m.pool.vol24h?.daily ?? null, vol7d: (m) => m.pool.vol7d?.daily ?? null, days: (m) => m.daysIn, change: (m) => m.change,
};

// 区间收益只按当前价位的质押流动性稀释：价格离开当前位置后的竞争流动性不同，结果仅用于同一时刻横向比较。
function metricsFor(pool: MarketPool, aeroUsd: number | null, width: number, deposit: number): Metrics {
  const liquidity = Number(pool.liquidity), staked = Number(pool.stakedLiquidity);
  const p0 = pool.token0.usd === null ? null : { usd: pool.token0.usd }, p1 = pool.token1.usd === null ? null : { usd: pool.token1.usd };
  const usdPerSecond = pool.emissionPerSec !== null && aeroUsd !== null ? pool.emissionPerSec * aeroUsd : null;
  const aprFor = (range: [number, number]) => usdPerSecond === null || !pool.gauge ? null
    : dilutedApr({ usdPerSecond, competingLiquidity: pool.stakedLiquidity, unitUsd: liquidityUnitUsd(pool.sqrtPriceX96, range[0], range[1], pool.token0, pool.token1, p0, p1), deposit });
  const range = rangeTicks(pool.tick, pool.tickSpacing, width);
  const emissionUsdYear = usdPerSecond === null ? null : usdPerSecond * 365 * DAY;
  // 涨跌与页面报价同向：以美元价较高的代币为基准。
  const change = pool.change24h === null ? null : (pool.token1.usd ?? 0) > (pool.token0.usd ?? 0) ? 1 / (1 + pool.change24h) - 1 : pool.change24h;
  return {
    pool, range, change,
    stakedShare: liquidity > 0 ? staked / liquidity : null,
    aeroPerDay: pool.emissionPerSec === null ? null : pool.emissionPerSec * DAY,
    emissionUsdYear, emissionTvl: emissionUsdYear !== null && pool.tvlUsd ? emissionUsdYear / pool.tvlUsd : null,
    apr: aprFor(range), narrowApr: aprFor(rangeTicks(pool.tick, pool.tickSpacing, 0)),
    daysIn: expectedDaysInRange(pool.tick, range[0], range[1], pool.vol24h?.daily ?? pool.vol7d?.daily),
  };
}

// 默认以美元价较高的代币为基准报价，例如 WETH/USDC 显示每 WETH 多少 USDC；flip 时反过来。
function quoteOf(pool: MarketPool, flip = false) {
  const invert = ((pool.token1.usd ?? 0) > (pool.token0.usd ?? 0)) !== flip;
  const scale = 10 ** (pool.token0.decimals - pool.token1.decimals);
  const price = (tick: number) => { const raw = 1.0001 ** tick * scale; return invert ? 1 / raw : raw; };
  const label = invert ? `${pool.token1.symbol} / ${pool.token0.symbol}` : `${pool.token0.symbol} / ${pool.token1.symbol}`;
  return { price, label: `每 ${invert ? pool.token1.symbol : pool.token0.symbol} 折合 ${invert ? pool.token0.symbol : pool.token1.symbol}`, pair: label, base: invert ? pool.token1.symbol : pool.token0.symbol, quote: invert ? pool.token0.symbol : pool.token1.symbol };
}
const priceText = (v: number) => (v >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : v >= 1 ? v.toPrecision(6) : v.toPrecision(5));

function PoolDetail({ metrics, history, error, width }: { metrics: Metrics; history: MarketPoolHistory | null; error: string; width: number }) {
  const { pool, range } = metrics;
  const [flip, setFlip] = useState(false);
  const quote = quoteOf(pool, flip);
  const data = (history?.points ?? []).map(([t, tick]) => ({ t, price: quote.price(tick) }));
  const [lo, hi] = [quote.price(range[0]), quote.price(range[1])].sort((a, b) => a - b);
  // 反向报价常是 0.000xxx 这类长刻度：按最长刻度文字留宽，避免左侧被截。
  const yWidth = Math.min(104, 16 + 7 * Math.max(...[lo, hi, ...data.map((d) => d.price)].map((v) => priceText(v).length)));
  return <div className="am-detail">
    <dl className="am-detail-facts">
      <div><dt>池子</dt><dd><code>{pool.address}</code></dd></div>
      <div><dt>Gauge</dt><dd>{pool.gauge ? <code>{pool.gauge}</code> : '无（不产生排放）'}</dd></div>
      <div><dt>当前价格</dt><dd>{priceText(quote.price(pool.tick))}<small>{quote.label}</small></dd></div>
      <div><dt>所选区间</dt><dd>{priceText(lo)} – {priceText(hi)}<small>{width ? `±${(width * 100).toFixed(0)}%` : '最窄'}，tick {range[0]} 至 {range[1]}</small></dd></div>
      <div><dt>手续费</dt><dd>{pool.fee === null ? '—' : `${(pool.fee / 1e4).toFixed(3)}%`}<small>未质押分成 {pool.unstakedFee === null ? '—' : `${(pool.unstakedFee / 1e4).toFixed(0)}%`}</small></dd></div>
      <div><dt>排放速率窗口</dt><dd>{pool.emissionWindowSec ? `${(pool.emissionWindowSec / 3600).toFixed(1)} 小时` : '—'}<small>按 voter 累计排放份额的差值计算</small></dd></div>
      <div><dt>波动率样本</dt><dd>24h {pool.vol24h?.samples ?? 0} 个 · 7d {pool.vol7d?.samples ?? 0} 个<small>年化 24h {pct(pool.vol24h?.annual)} · 7d {pct(pool.vol7d?.annual)}</small></dd></div>
      <div><dt>代币报价</dt><dd>{pool.token0.symbol} {usd(pool.token0.usd)} · {pool.token1.symbol} {usd(pool.token1.usd)}<small>从稳定币按池子深度逐级推算</small></dd></div>
    </dl>
    <figure className="am-chart" aria-label={`${pairName(pool)} 近 7 天价格，共 ${data.length} 个点`}>
      <figcaption><span>近 7 天价格（{quote.label}），阴影为所选区间</span>
        <button type="button" className="button secondary am-swap" onClick={() => setFlip((v) => !v)} aria-pressed={flip} title={`改为每 ${quote.quote} 折合 ${quote.base}`}><ArrowLeftRight size={13} />{quote.quote} / {quote.base}</button></figcaption>
      {error ? <p className="lp-error">{error}</p> : !history ? <p className="muted"><LoaderCircle size={14} className="spin" /> 正在读取历史…</p> : data.length < 2 ? <p className="muted">历史样本不足，扫描运行几个小时后会出现。</p>
        : <div className="am-chart-box"><ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 240 }} minWidth={0}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--surface-5)" />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => dates.format(Number(v))} tickLine={false} axisLine={false} minTickGap={48} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
            <YAxis width={yWidth} domain={[(min: number) => Math.min(min, lo), (max: number) => Math.max(max, hi)]} tickFormatter={(v) => priceText(Number(v))} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
            <ReferenceArea y1={lo} y2={hi} fill="var(--accent)" fillOpacity={0.08} stroke="none" ifOverflow="extendDomain" />
            <Tooltip labelFormatter={(v) => new Date(Number(v)).toLocaleString('zh-CN')} formatter={(v) => [priceText(Number(v)), quote.pair]} contentStyle={{ backgroundColor: 'var(--surface-3)', color: 'var(--text-primary)', border: '1px solid var(--surface-6)', borderRadius: 8, fontSize: 13 }} />
            <Line type="linear" dataKey="price" stroke="var(--accent)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer></div>}
    </figure>
  </div>;
}

// 草稿只在打开表单时取一次服务端配置：轮询更新不能覆盖正在编辑的内容；保存成功后表单关闭。
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
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'apr', desc: true });
  const [limit, setLimit] = useState(60);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<{ key: string; data: MarketPoolHistory | null; error: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef<number | null>(null);
  const generation = useRef(0);
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  const accept = useCallback((data: MarketSnapshot) => { revision.current = data.revision; setSnapshot(data); setLoadError(''); }, []);
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
  const minTvl = Math.max(Number(minTvlText) || 0, 0);
  const aeroUsd = snapshot?.aero.usd ?? null;
  const chainNames = useMemo(() => new Map((snapshot?.chains ?? []).map((c) => [c.id, c.name])), [snapshot]);
  const all = useMemo(() => (snapshot?.pools ?? []).map((p) => metricsFor(p, aeroUsd, width, deposit)), [snapshot, aeroUsd, width, deposit]);
  const rows = useMemo(() => {
    const words = search.trim().toLowerCase().split(/[\s/,]+/).filter(Boolean);
    const pick = SORTS[sort.key];
    return all.filter((m) => (chainFilter === 'all' || m.pool.chain === chainFilter)
      && (!emittingOnly || (m.pool.emissionPerSec ?? 0) > 0)
      && (m.pool.tvlUsd ?? 0) >= minTvl
      && words.every((w) => m.pool.token0.symbol.toLowerCase().includes(w) || m.pool.token1.symbol.toLowerCase().includes(w) || m.pool.address.startsWith(w)))
      .sort((a, b) => { const x = pick(a), y = pick(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return sort.desc ? y - x : x - y; });
  }, [all, chainFilter, emittingOnly, minTvl, search, sort]);
  const openMetrics = open ? all.find((m) => key(m.pool) === open) ?? null : null;

  const loadHistory = useCallback(async (chain: string, address: string, quiet: boolean) => {
    const k = `${chain}:${address}`, signal = lifetime.current?.signal;
    if (!quiet) setHistory({ key: k, data: null, error: '' });
    try {
      const data = await api<MarketPoolHistory>(`${ROOT}/pool?chain=${encodeURIComponent(chain)}&address=${address}`, { signal, timeoutMs: 15_000 });
      if (!signal?.aborted) setHistory((h) => (h?.key === k ? { key: k, data, error: '' } : h));
    } catch (reason) { if (!signal?.aborted && !quiet) fail(reason, (text) => setHistory((h) => (h?.key === k ? { key: k, data: null, error: text } : h))); }
  }, [fail]);
  const toggle = (m: Metrics) => {
    const k = key(m.pool);
    if (open === k) { setOpen(null); return; }
    setOpen(k); void loadHistory(m.pool.chain, m.pool.address, false);
  };
  // 新一轮扫描后静默刷新已展开池子的价格图；失败时保留当前图。
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const k = openRef.current;
    if (!k) return;
    const [chain, address] = k.split(':');
    void loadHistory(chain, address, true);
  }, [snapshot?.revision, loadHistory]);
  const header = (k: SortKey, label: string, title?: string) => <th scope="col" className="num" aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className="am-sort" title={title} onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }))}>{label}{sort.key === k ? sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} /> : null}</button>
  </th>;

  if (!snapshot) return <div className="lp-page">{loadError ? <div className="panel lp-empty"><CircleAlert /><p>{loadError}</p><button className="button secondary" onClick={() => void read()}><RefreshCw size={15} />重试</button></div>
    : <div className="panel lp-empty" role="status"><LoaderCircle className="spin" /><p>正在读取 Aero 市场数据…</p></div>}</div>;

  const staleAfter = snapshot.config.intervalMin * 60_000 * 2 + 120_000;
  return <div className="lp-page am-page">
    <div className="lp-heading">
      <div><h1>Aero 市场</h1><p>各链 Aero CL 池的 TVL、排放年化与波动率，按区间宽度和投入金额估算，用于比较入场机会。数据只读链上，AERO {usd(aeroUsd)}{snapshot.aero.at ? `（${when(snapshot.aero.at)}）` : ''}</p></div>
      <div className="lp-toolbar">
        <button className="button secondary" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}><Settings2 size={15} />扫描设置</button>
        <button className="button secondary" disabled={!!busy || !snapshot.config.enabled} onClick={() => void execute('refresh', '/refresh', 'POST', {})}><RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />立即刷新</button>
      </div>
    </div>
    {snapshot.configError ? <div className="lp-callout warning"><CircleAlert size={15} />{snapshot.configError}</div> : null}
    {!snapshot.config.enabled ? <div className="lp-callout warning"><CircleAlert size={15} />扫描已停用，页面显示的是上次保存的数据。可在「扫描设置」中启用。</div> : null}
    {loadError ? <div className="lp-callout warning"><CircleAlert size={15} />刷新失败：{loadError}（显示的是上次读取的数据）</div> : null}
    {actionError ? <div className="lp-callout warning"><CircleAlert size={15} />{actionError}</div> : null}
    {showSettings ? <SettingsForm config={snapshot.config} busy={!!busy} onSave={(next) => void execute('save', '/config', 'PUT', { config: next })} /> : null}

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
        <label>最低 TVL（美元）<input type="number" min={0} step={1000} value={minTvlText} onChange={(e) => setMinTvlText(e.target.value)} /></label>
        <label className="am-check"><input type="checkbox" checked={emittingOnly} onChange={(e) => setEmittingOnly(e.target.checked)} />只看有排放</label>
      </div>
      <p className="am-note">排放年化 = 池子排放（AERO 计价）×（你的流动性 /（当前价位质押流动性 + 你的））÷ 投入，假设全程在区间内并质押；价格移动后的竞争流动性不同，仅用于同一时刻横向比较。不含手续费：质押仓位的手续费归投票者。预计在区间时间按 24 小时波动率（不足时用 7 天）的无漂移随机游走估算。</p>
      <div className="lp-table-scroll"><table className="lp-table am-table">
        <thead><tr>
          <th scope="col">池子</th>
          {header('tvl', 'TVL')}{header('staked', '质押占比', '当前价位质押流动性 / 全部流动性')}
          {header('emission', '日排放', '每天发给该池的 AERO')}{header('emissionTvl', '排放/TVL', '年化排放价值除以池子 TVL')}
          {header('apr', '区间年化', '所选区间宽度下的排放年化')}{header('narrowApr', '最窄年化', '单个 tickSpacing 区间的排放年化')}
          {header('vol24h', '日波动 24h', '小时对数收益折算到 1 天')}{header('vol7d', '日波动 7d')}
          {header('days', '在区间', '所选区间内的预计停留时间')}{header('change', '24h 涨跌')}
        </tr></thead>
        <tbody>{rows.slice(0, limit).map((m) => {
          const k = key(m.pool), isOpen = open === k;
          return <Fragment key={k}>
            <tr className={isOpen ? 'open' : undefined} onClick={() => toggle(m)}>
              <th scope="row"><button type="button" className="am-pool" aria-expanded={isOpen}><strong>{pairName(m.pool)}</strong><small>{chainNames.get(m.pool.chain)} · CL{m.pool.tickSpacing} · {m.pool.fee === null ? '—' : `${(m.pool.fee / 1e4).toFixed(2)}%`} · {short(m.pool.address)}</small></button></th>
              <td className="num">{usd(m.pool.tvlUsd)}</td><td className="num">{pct(m.stakedShare, 0)}</td>
              <td className="num">{m.aeroPerDay === null ? '—' : amount(m.aeroPerDay)}<small>{usd(m.emissionUsdYear === null ? null : m.emissionUsdYear / 365)}</small></td>
              <td className="num">{pct(m.emissionTvl, 0)}</td>
              <td className="num strong">{pct(m.apr, 0)}</td><td className="num">{pct(m.narrowApr, 0)}</td>
              <td className="num">{pct(m.pool.vol24h?.daily, 2)}</td><td className="num">{pct(m.pool.vol7d?.daily, 2)}</td>
              <td className="num">{days(m.daysIn)}</td>
              <td className={`num ${(m.change ?? 0) > 0 ? 'up' : (m.change ?? 0) < 0 ? 'down' : ''}`} title={quoteOf(m.pool).pair}>{signed(m.change)}</td>
            </tr>
            {isOpen && openMetrics ? <tr className="am-detail-row"><td colSpan={11}><PoolDetail metrics={openMetrics} history={history?.key === k ? history.data : null} error={history?.key === k ? history.error : ''} width={width} /></td></tr> : null}
          </Fragment>;
        })}
        {!rows.length ? <tr><td colSpan={11} className="lp-table-empty">{snapshot.pools.length ? '没有符合筛选条件的池子' : '还没有扫描结果；首次扫描每条链约需 1 分钟'}</td></tr> : null}</tbody>
      </table></div>
      {rows.length > limit ? <div className="am-more"><button className="button secondary" onClick={() => setLimit((v) => v + 60)}>显示更多（共 {rows.length} 个）</button></div> : null}
    </section>
  </div>;
}
