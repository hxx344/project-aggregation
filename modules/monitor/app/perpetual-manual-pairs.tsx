"use client";

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { usePerpetualFx } from '../hooks/use-perpetual-fx';
import { evaluateManualPair, manualQuoteKey, maxManualPairs, parseManualPairs, validManualPair, type ManualPair } from '../lib/perpetual-manual-pairs';
import type { PerpetualPriceMode, PerpetualSnapshot } from '../lib/perpetual-types';
import type { QualityBudget } from '../lib/perpetual-fees';
import './perpetual-manual-pairs.css';

const storageKey = 'market-monitor:perpetual-manual-pairs:v1';
const numberFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 9 });
const number = (value: number) => numberFormat.format(value);
const percent = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(3)}%`;
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const freshDraft = () => ({ id: '', first: '', second: '', firstFactor: '1', secondFactor: '1' });

export default function PerpetualManualPairs({ snapshot, mode, now, budget, active, paused }: { snapshot: PerpetualSnapshot | null; mode: PerpetualPriceMode; now: number; budget: QualityBudget; active: boolean; paused: boolean }) {
  const [pairs, setPairs] = useState<ManualPair[]>([]);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(freshDraft);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      try { setPairs(parseManualPairs(localStorage.getItem(storageKey))); }
      catch { setStorageError('浏览器存储不可用，配置仅在本次页面有效。'); }
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  function persist(next: ManualPair[]) {
    setPairs(next);
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, pairs: next })); setStorageError(''); }
    catch { setStorageError('保存失败，刷新页面后可能丢失配置。'); }
  }
  // Keep the form mounted to preserve drafts, but skip the full market catalog
  // while either the tools section or this panel is collapsed.
  const visible = active && open;
  const quotes = visible ? snapshot?.quotes : null;
  const exchanges = visible ? snapshot?.exchanges : null;
  const byKey = useMemo(() => new Map((quotes ?? []).map(q => [manualQuoteKey(q), q])), [quotes]);
  const venues = useMemo(() => new Map((exchanges ?? []).map(v => [v.id, v.name])), [exchanges]);
  // Price ticks do not change select options; only catalog metadata triggers sorting.
  const catalogSignature = JSON.stringify([...byKey].map(([key, q]) => [key, `${venues.get(q.exchange) ?? q.exchange} · ${q.symbol} · ${q.quoteCurrency}${q.comparable === false ? ' · 独立合约' : ''}`]));
  const catalog = useMemo(() => (JSON.parse(catalogSignature) as [string, string][]).map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)), [catalogSignature]);
  const matches = useMemo(() => catalog.filter(q => `${q.key} ${q.label}`.toUpperCase().includes(search.trim().toUpperCase())), [catalog, search]);
  const options = useMemo(() => {
    const visible = new Set(matches.slice(0, 100).map(q => q.key));
    visible.add(draft.first); visible.add(draft.second);
    return catalog.filter(q => visible.has(q.key));
  }, [catalog, matches, draft.first, draft.second]);
  const needsFx = pairs.some(pair => { const a = byKey.get(pair.first), b = byKey.get(pair.second); return a && b && a.quoteCurrency !== b.quoteCurrency; });
  const { data: fx, error: fxError } = usePerpetualFx(visible && needsFx && !paused);
  const results = useMemo(() => visible ? pairs.map(pair => ({ pair, result: evaluateManualPair(pair, snapshot, byKey, mode, now, budget, fx) })) : [], [visible, pairs, snapshot, byKey, mode, now, budget, fx]);
  function save(event: FormEvent) {
    event.preventDefault();
    const next = { ...draft, id: draft.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, firstFactor: Number(draft.firstFactor), secondFactor: Number(draft.secondFactor) };
    if (!validManualPair(next)) { setMessage('请选择不同交易所的两个合约，换算倍数须为 0.000000000001 至 1000000000000 之间的正数。'); return; }
    if (!byKey.has(next.first) || !byKey.has(next.second)) { setMessage('所选合约当前未加载，请等待行情更新。'); return; }
    if (pairs.some(pair => pair.id !== next.id && [pair.first, pair.second].includes(next.first) && [pair.first, pair.second].includes(next.second))) { setMessage('这两个合约已经配对，请编辑已有配置。'); return; }
    if (!draft.id && pairs.length >= maxManualPairs) { setMessage(`最多保存 ${maxManualPairs} 个配对。`); return; }
    persist(draft.id ? pairs.map(pair => pair.id === next.id ? next : pair) : [...pairs, next]);
    setDraft(freshDraft()); setMessage('已保存手动配对');
  }
  return <section className="perp-manual" aria-label="手动配对">
    <button className="perp-manual-toggle" type="button" aria-expanded={open} aria-controls="perpetual-manual-content" onClick={() => setOpen(value => !value)}><strong>手动配对{ready ? ` · ${pairs.length}` : ''}</strong><span>{open ? '收起' : '添加 / 查看'}　{open ? '−' : '+'}</span></button>
    {open ? <div id="perpetual-manual-content">
      <p>自行指定两个合约，独立计算双向价差。手动配对不代表合约规格已核实；只对所选两份合约生效。</p>
      <p>换算价 = 页面报价 × 各侧倍数，再按需换汇。例如 A 报价 100、B 报价 10，若代表相同估值，可设 A × 1、B × 10。两侧必须换算到同一单位。</p>
      <form onSubmit={save}>
        <label className="perp-manual-search">搜索可选合约<input value={search} onChange={event => setSearch(event.target.value)} placeholder="如 POLYMARKET、BTC、Aster" maxLength={100}/><small>{matches.length} 个匹配，最多显示前 100 个；已选合约保留</small></label>
        <div className="perp-manual-fields">{(['first', 'second'] as const).map((side, index) => <div key={side}>
          <label>合约 {index === 0 ? 'A' : 'B'}<select value={draft[side]} onChange={event => setDraft({ ...draft, [side]: event.target.value })} required><option value="">选择合约</option>{draft[side] && !byKey.has(draft[side]) ? <option value={draft[side]}>{draft[side]} · 暂未加载</option> : null}{options.map(q => <option key={q.key} value={q.key}>{q.label}</option>)}</select></label>
          <label>{index === 0 ? 'A' : 'B'} 价格换算倍数<input type="number" min="0.000000000001" max="1000000000000" step="any" required value={draft[`${side}Factor`]} onChange={event => setDraft({ ...draft, [`${side}Factor`]: event.target.value })}/></label>
        </div>)}</div>
        <div className="perp-manual-actions"><button type="submit" disabled={!ready}>{draft.id ? '保存修改' : '添加配对'}</button>{draft.id ? <button type="button" onClick={() => { setDraft(freshDraft()); setMessage(''); }}>取消编辑</button> : null}<span>仅保存在当前浏览器 · 最多 {maxManualPairs} 组</span></div>
      </form>
      {message ? <p role="status">{message}</p> : null}{storageError ? <p role="status">{storageError}</p> : null}
      <p>以下结果独立于自动排行筛选，沿用当前报价口径和手续费设置；跨计价币自动换算至 USDT。{paused ? '当前显示暂停时的快照。' : ''}</p>
      {needsFx && fxError ? <p role="status">{fxError}</p> : null}
      {!pairs.length ? <p>尚未添加手动配对。</p> : results.map(({ pair, result }) => <article key={pair.id}>
        <header><strong>手动配对 · 未核实规格</strong><div><button type="button" onClick={() => { setDraft({ ...pair, firstFactor: String(pair.firstFactor), secondFactor: String(pair.secondFactor) }); setMessage(''); }}>编辑<span className="perp-sr-only"> {pair.first} / {pair.second}</span></button><button type="button" onClick={() => { persist(pairs.filter(item => item.id !== pair.id)); if (draft.id === pair.id) setDraft(freshDraft()); setMessage('已删除手动配对'); }}>删除<span className="perp-sr-only"> {pair.first} / {pair.second}</span></button></div></header>
        <p>{pair.first} × {number(pair.firstFactor)} ↔ {pair.second} × {number(pair.secondFactor)}</p>
        {result.reason ? <p className="perp-manual-unavailable">{result.reason}</p> : <div className="perp-manual-directions">{result.directions.map(row => <div key={manualQuoteKey(row.long)}>
          <strong>买入 {venues.get(row.long.exchange) ?? row.long.exchange} → 卖出 {venues.get(row.short.exchange) ?? row.short.exchange}</strong>
          <p>{row.long.symbol} → {row.short.symbol}</p>
          <dl><div><dt>毛价差{mode === 'mark' ? ' · 标记价参考' : ''}</dt><dd>{percent(row.spreadPercent)}</dd></div><div><dt>扣费与滑点后</dt><dd>{percent(row.netSpreadPercent)}</dd></div><div><dt>资金费差 / 8h</dt><dd>{percent(row.fundingSpread8h === null ? null : row.fundingSpread8h * 100)}</dd></div></dl>
          <p>原始买 / 卖：{number(row.buy)} {row.long.quoteCurrency} / {number(row.sell)} {row.short.quoteCurrency}</p>
          <p>换算买 / 卖：{number(row.referenceBuy)} / {number(row.referenceSell)} {row.currency} / 共同单位</p>
          <p>报价时间 {time(row.updatedAt)}{row.fxAt ? ` · 汇率时间 ${time(row.fxAt)} · 换汇手续费另计` : ''}</p>
          {row.feeNote ? <p>{row.feeNote}</p> : null}
        </div>)}</div>}
      </article>)}
    </div> : null}
  </section>;
}
