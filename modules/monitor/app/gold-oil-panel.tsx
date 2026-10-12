"use client";

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Chart, { FundingChart } from './gold-oil-svg-chart';
import { GOLD_OIL_STALE_MS, GOLD_OIL_INTERVAL_MS, GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, goldOilVariantKey, goldOilUnits, goldOilChartPoints, type GoldOilType, type GoldOilExchange, type GoldOilPoint } from '../lib/gold-oil';
import { currentGoldOilFunding, analyzeAvailableGoldOilFunding, type GoldOilFundingHistory } from '../lib/gold-oil-funding';
import { goldOilStatistics, sampleGoldOilPoints, adjacentRatioChange } from '../lib/gold-oil-analysis';
import { goldOilSummary, goldOilTrend, summaryTimestamp, type SummaryProps } from '../lib/monitor-summary';
import type { InitialMarketData } from '../lib/initial-market';
import { useGoldOilFeed } from '../hooks/use-gold-oil-feed';

const ranges = [{ days: 1, label: '1 天' }, { days: 7, label: '1 周' }, { days: '1m' as const, label: '1 月' }, { days: 0, label: '全部' }];
const format = (value: number | null | undefined, digits = 3) => value == null ? '—' : value.toFixed(digits);
const percent = (value: number | null | undefined, digits = 4) => value == null ? '—' : `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
const signed = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(3)}`;
const time = (value: number | undefined) => value === undefined ? '—' : summaryTimestamp(new Date(value).toISOString());
const extraStyles = `
.gold-chart{height:340px;min-width:0}.gold-funding-chart{height:230px}
.funding-history-period{font-size:12px;line-height:1.7;color:var(--muted)}
.gold-svg-chart{height:100%;width:100%;position:relative}.gold-chart-svg{display:block;overflow:visible;touch-action:pan-y}.gold-chart-svg text{fill:var(--muted);font:11px Arial,sans-serif}.gold-chart-tooltip{position:absolute;top:4px;left:80px;max-width:calc(100% - 90px);padding:7px 10px;background:var(--surface,var(--card));border:1px solid var(--line,var(--border));border-radius:6px;font-size:11px;line-height:1.7;pointer-events:none}.gold-chart-tooltip span{display:block}
.gold-cursor{display:block;width:100%;accent-color:var(--accent);margin:12px 0}
.gold-cursor-reading{display:block;color:var(--muted);font-size:12px;min-height:24px}
.gold-empty{display:grid;place-items:center;height:100%;color:var(--muted);font-size:14px}
.gold-chart svg:focus-visible{outline:2px solid var(--accent)}
.gold-oil-selector{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;margin-top:16px}.gold-oil-selector>span{font-size:12px;color:var(--muted)}.gold-oil-selector .range-buttons{justify-self:start;margin-left:0}.gold-oil-selector .range-buttons button{min-height:40px;padding:8px 14px}
.gold-range-unit{font-size:12px;color:var(--muted)}
.funding-basis span{font-size:12px;color:var(--accent);padding:8px 12px}.gold-data-stale{color:var(--warning)}
.view-tabs button[aria-pressed=true]{color:var(--accent);background:transparent}
.view-tabs button[aria-pressed=true]:after{content:'';height:3px;background:var(--accent);position:absolute;bottom:-1px;left:0;right:0;border-radius:3px 3px 0 0}
.monthly-chart{overflow-x:auto;overflow-y:hidden}.month-item{min-width:56px}
@media(max-width:700px){.gold-chart{height:280px}.plot-heading{flex-wrap:wrap}.chart-legend{flex-wrap:wrap;gap:10px}.gold-cursor-reading{line-height:1.8}.funding-basis{margin-top:10px}}
`;

// Quote polling, freshness ticks and cursor movement do not change historical rows.
const GoldOilDetails = memo(function GoldOilDetails({ points, fundingByCandle, funding, oilType, exchange, page, onPageChange }: {
  points: GoldOilPoint[];
  fundingByCandle: Map<number, { net: number; oil: number; xau: number }>;
  funding: GoldOilFundingHistory | null;
  oilType: GoldOilType;
  exchange: GoldOilExchange;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const instrument = GOLD_OIL_INSTRUMENTS[oilType], source = GOLD_OIL_EXCHANGES[exchange].name, units = goldOilUnits(oilType, exchange);
  const pageCount = Math.max(1, Math.ceil(points.length / 200)), selectedPage = Math.min(page, pageCount - 1), pageEnd = points.length - selectedPage * 200;
  const tableRows = points.slice(Math.max(0, pageEnd - 200), pageEnd).reverse();
  return <details className="data-details panel"><summary><span>15 分钟价格与资金费明细 <span className="table-count">{points.length} 条</span></span><span className="details-arrow">＋</span></summary><nav className="table-pagination" aria-label="明细翻页"><span aria-live="polite">第 {selectedPage + 1} / {pageCount} 页 · 每页 200 条</span><div><button disabled={selectedPage === 0} onClick={() => onPageChange(selectedPage - 1)}>上一页</button><button disabled={selectedPage >= pageCount - 1} onClick={() => onPageChange(selectedPage + 1)}>下一页</button></div></nav><div className="table-scroll" tabIndex={0} role="region" aria-label="金油比价格与资金费明细"><table><caption>{source} · 按 K 线起始时间倒序（北京时间）。黄金 USDT/盎司，原油 {units.oil}，比值及变化为{units.ratio}。资金费为该 15 分钟内实际结算记录之和，以两腿总名义为分母。</caption><thead><tr>{['时间 · 北京时间', '黄金', instrument.name, '金油比', '较上根 K 线', '做多资金费', '做空资金费', '结算记录'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{tableRows.map((row, index) => { const event = fundingByCandle.get(row.time); return <tr key={row.time}><td>{time(row.time)}</td><td>{format(row.xau, 2)}</td><td>{format(row.oil)}</td><td>{format(row.ratio)}</td><td>{signed(adjacentRatioChange(points, pageEnd - index - 1))}</td><td>{event ? percent(-event.net) : '—'}</td><td>{event ? percent(event.net) : '—'}</td><td>{event ? `XAU ${event.xau} 次 / ${instrument.code} ${event.oil} 次` : funding && row.time >= funding.coverageStart && row.time + GOLD_OIL_INTERVAL_MS <= funding.coverageEnd ? '无结算记录' : '未查询覆盖'}</td></tr>; })}</tbody></table></div></details>;
});

export default function GoldOilPanel({ initial, active = true, summaryActive = true, onSummary, oilType = 'cl', onOilTypeChange, exchange = 'binance', onExchangeChange }: SummaryProps & { initial?: InitialMarketData | null; active?: boolean; summaryActive?: boolean; oilType?: GoldOilType; onOilTypeChange?: (value: GoldOilType) => void; exchange?: GoldOilExchange; onExchangeChange?: (value: GoldOilExchange) => void }) {
  const feed = useGoldOilFeed(initial, active, summaryActive, oilType, exchange), { quote, history, funding, quoteError, historyError, fundingError } = feed;
  const instrument = GOLD_OIL_INSTRUMENTS[oilType], source = GOLD_OIL_EXCHANGES[exchange].name, marketKey = goldOilVariantKey(oilType, exchange), units = goldOilUnits(oilType, exchange);
  const contractUrl = (symbol: string) => exchange === 'bybit' ? `https://www.bybit.com/trade/usdt/${symbol}` : `https://www.binance.com/en/futures/${symbol}`;
  const [hasOpened, setHasOpened] = useState(active);
  if (active && !hasOpened) setHasOpened(true);
  const [root, setRoot] = useState<ShadowRoot | null>(null), [styled, setStyled] = useState(false);
  const mount = useCallback((node: HTMLDivElement | null) => { if (node) setRoot(node.shadowRoot ?? node.attachShadow({ mode: 'open' })); }, []);
  const [days, setDays] = useState<number | '1m'>(7), [view, setView] = useState<'ratio' | 'prices'>('ratio'), [fundingView, setFundingView] = useState<'annualized' | 'rate'>('annualized');
  const [page, setPage] = useState(0), [cursor, setCursor] = useState<number | null>(null), [now, setNow] = useState(initial?.renderedAt ?? 0);
  const [selectionMarket, setSelectionMarket] = useState(marketKey);
  if (selectionMarket !== marketKey) { setSelectionMarket(marketKey); setPage(0); setCursor(null); }
  const trend = useMemo(() => goldOilTrend(history, historyError, oilType, exchange), [history, historyError, oilType, exchange]);
  useEffect(() => { onSummary?.(goldOilSummary(quote, quoteError, trend, oilType, exchange)); }, [quote, quoteError, trend, onSummary, oilType, exchange]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, [active]);
  const points = useMemo(() => goldOilChartPoints(history, days), [history, days]);
  const sampled = useMemo(() => sampleGoldOilPoints(points), [points]);
  const stats = useMemo(() => goldOilStatistics(points), [points]);
  const allStats = useMemo(() => goldOilStatistics(history?.points ?? []), [history]);
  const start = points[0]?.time ?? 0, end = (points.at(-1)?.time ?? -GOLD_OIL_INTERVAL_MS) + GOLD_OIL_INTERVAL_MS;
  const fees = useMemo(() => analyzeAvailableGoldOilFunding(funding, start, end), [funding, start, end]);
  const fundingByCandle = useMemo(() => {
    const map = new Map<number, { net: number; oil: number; xau: number }>();
    for (const row of fees.events) {
      const at = Math.floor(row.time / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS, item = map.get(at) ?? { net: 0, oil: 0, xau: 0 };
      if (row.xau !== null) { item.net += row.xau / 2; item.xau++; }
      if (row.oil !== null) { item.net -= row.oil / 2; item.oil++; }
      map.set(at, item);
    }
    return map;
  }, [fees]);
  const current = currentGoldOilFunding(quote), latest = stats?.last;
  const stale = quote && (quote.status === 'snapshot' || quoteError || now - Date.parse(quote.fetchedAt) > GOLD_OIL_STALE_MS);
  const historyStale = history && (history.status === 'snapshot' || historyError || now - Date.parse(history.fetchedAt) > 150_000 || !latest || now - latest.time - 2 * GOLD_OIL_INTERVAL_MS > 150_000);
  const fundingStale = funding && (funding.status === 'snapshot' || fundingError || now - Date.parse(funding.fetchedAt) > 615_000);
  const selectedPoint = points[Math.min(cursor ?? points.length - 1, points.length - 1)];
  const rangeLabel = ranges.find(range => range.days === days)!.label;
  const maxMonth = Math.max(1, ...stats?.months.map(month => month.average) ?? []);
  const selectRange = (value: number | '1m') => { setDays(value); setPage(0); setCursor(null); };
  const status = !quote ? quoteError ? '行情暂不可用' : '正在获取行情' : stale ? '更新中断 · 保留数据' : '实时 · 每 30 秒更新';
  return <div className="gold-oil-host" ref={mount}>{root && createPortal(<>
    <link rel="stylesheet" href="/oil/styles.css" onLoad={() => setStyled(true)} onError={() => setStyled(false)}/>
    <style>{extraStyles}</style>
    {!styled && <p role="status">正在加载金油比面板样式…</p>}
    <div className="oil-panel" hidden={!styled}><main>
      <section className="page-heading" aria-labelledby="gold-oil-title"><div><p className="eyebrow">{source.toUpperCase()} USDT PERPETUALS · {instrument.code}-XAU</p><h1 id="gold-oil-title">黄金 / 原油 · 金油比</h1><p className="heading-description">XAUUSDT 与 {instrument.symbol} 永续合约 · 15 分钟标记价格</p><div className="gold-oil-selector"><span>交易所</span><div className="range-buttons" role="group" aria-label="金油比交易所">{(['binance', 'bybit'] as const).map(value => <button key={value} type="button" aria-pressed={exchange === value} onClick={() => onExchangeChange?.(value)}>{GOLD_OIL_EXCHANGES[value].name}</button>)}</div><span>原油合约</span><div className="range-buttons" role="group" aria-label="金油比原油合约">{(['cl', 'bz'] as const).map(value => <button key={value} type="button" aria-pressed={oilType === value} onClick={() => onOilTypeChange?.(value)}>{GOLD_OIL_INSTRUMENTS[value].code} · {GOLD_OIL_INSTRUMENTS[value].name}</button>)}</div></div></div><div className="data-stamp"><span className="stamp-label" role="status">{status}</span><span>{quote ? `${summaryTimestamp(quote.fetchedAt)} 北京时间` : '等待两腿有效报价'}</span><span className="stamp-source">{source} · 报价每 30 秒，历史每 60 秒</span><button className="refresh-data" onClick={feed.refresh}>刷新数据 ↻</button></div></section>
      {(historyError || fundingError || historyStale) && <div className="data-notice" role="status">{historyError || historyStale ? '价格历史待更新，保留已取得的数据。' : ''}{fundingError ? '资金费历史更新失败，保留已有记录。' : ''}</div>}
      <section className="metrics" aria-label="金油比报价">
        <article className="metric featured"><div className="metric-label"><span>当前金油比</span><span className="metric-tag">XAU / {instrument.code}</span></div><div className="metric-number">{format(quote?.ratio)}<small>{units.ratio}</small></div><div className="metric-foot">较最后收盘 <strong>{quote && allStats ? signed(quote.ratio - allStats.last.ratio) : '—'}</strong>{units.ratio}</div></article>
        <article className="metric"><div className="metric-label"><span><i className="legend-dot brent"/>黄金</span><span className="ticker">XAUUSDT</span></div><div className="metric-number">{format(quote?.xau.price, 2)}<small>USDT/盎司</small></div><div className="metric-foot"><a href={contractUrl('XAUUSDT')} target="_blank" rel="noreferrer">{source} 永续 · 标记价格 ↗</a></div></article>
        <article className="metric"><div className="metric-label"><span><i className="legend-dot wti"/>{instrument.name}</span><span className="ticker">{instrument.symbol}</span></div><div className="metric-number">{format(quote?.oil.price)}<small>{units.oil}</small></div><div className="metric-foot"><a href={contractUrl(instrument.symbol)} target="_blank" rel="noreferrer">{source} 永续 · 标记价格 ↗</a></div></article>
        <article className="metric"><div className="metric-label"><span>共同区间比值变化</span><span className="ticker">15 MIN</span></div><div className="metric-number">{signed(allStats?.change)}<small>{units.ratio}</small></div><div className="metric-foot">{allStats ? `${time(allStats.first.time)} 起 · 相对变化 ${format(allStats.percentChange, 2)}%` : '等待共同历史'}</div></article>
      </section>

      <section className="funding-panel panel" aria-labelledby="gold-funding-title"><div className="funding-header"><div><p className="eyebrow">SHORT XAU / LONG {instrument.code}</p><h2 id="gold-funding-title">做空金油比 · 当前资金费率</h2><p className="funding-subtitle">空黄金、多原油。正值收款，负值付款。</p></div><div className="funding-basis"><span>等 USDT 名义 · 两腿各 50%</span></div></div>
        <div className="funding-metrics"><article><p>预计净小时费率</p><strong className="funding-value">{percent(current?.hourlyRate, 5)}</strong><span>以两腿总名义金额为分母</span></article><article><p>每 10,000 USDT 总名义 / 小时</p><strong className="funding-value">{format(current?.cashPerHour, 4)} USDT</strong><span>空黄金 5,000 USDT · 多原油 5,000 USDT</span></article><article><p>按当前费率简单年化</p><strong className="funding-value">{percent(current?.annualized, 2)}</strong><span>净小时费率 × 8,760</span></article></div>
        <div className="funding-legs">{(['xau', 'oil'] as const).map(key => <div key={key}><span><i className={`legend-dot ${key === 'xau' ? 'brent' : 'wti'}`}/>{key === 'xau' ? '空 XAUUSDT' : `多 ${instrument.symbol}`}</span><strong>{quote?.funding ? `${percent(quote.funding[key].rate)} / ${quote.funding[key].intervalHours} 小时` : '—'}</strong><span>下次结算：{quote?.funding ? `${summaryTimestamp(quote.funding[key].nextFundingAt)} 北京时间` : '暂不可用'}</span></div>)}</div>
        <div className="funding-explanation"><p>净小时率 =（黄金费率 ÷ 黄金结算周期 − 原油费率 ÷ 原油结算周期）÷ 2。两腿按各自实际周期折算；简单年化不复利，不代表已实现收益。</p><p>{current ? `${stale ? '预估已过期 · ' : ''}费率源时间：${summaryTimestamp(quote!.fetchedAt)} 北京时间` : '资金费或结算周期暂不可用，价格继续独立更新。'}</p></div>
      </section>

      <section className="chart-panel panel" aria-label="金油比历史走势"><div className="chart-toolbar"><div className="view-tabs" role="group" aria-label="图表内容"><button aria-pressed={view === 'ratio'} onClick={() => setView('ratio')}>金油比走势</button><button aria-pressed={view === 'prices'} onClick={() => setView('prices')}>黄金 / 原油价格</button></div><div className="range-buttons" role="group" aria-label="时间范围">{ranges.map(range => <button key={range.days} aria-pressed={days === range.days} onClick={() => selectRange(range.days)}>{range.label}</button>)}</div></div>
        <div className="chart-layout"><div className="plot-section"><div className="plot-heading"><div><h2>{view === 'ratio' ? '黄金相对原油 · 金油比' : '黄金与原油标记价格'}</h2><p>{time(start || undefined)} — {time(end || undefined)} 北京时间</p></div><div className="chart-legend">{view === 'ratio' ? <><span><i className="legend-line brent"/>15 分钟金油比</span><span><i className="legend-line average"/>区间均值</span></> : <><span><i className="legend-line brent"/>黄金 · 左轴 USDT/盎司</span><span><i className="legend-line wti"/>原油 · 右轴 {units.oil}</span></>}</div></div>
          <div className="gold-chart" aria-label={`${rangeLabel}金油比，${stats?.count ?? 0} 个有效样本`}>{stats && hasOpened ? <Chart oilType={oilType} exchange={exchange} points={sampled} view={view} average={stats.average}/> : <div className="gold-empty">{historyError ? '历史行情暂不可用' : history ? '所选区间暂无有效共同历史' : '正在读取共同历史，首次采集需要回补…'}</div>}</div>
          {points.length > 0 && <><input className="gold-cursor" type="range" min={0} max={points.length - 1} value={Math.min(cursor ?? points.length - 1, points.length - 1)} onChange={event => setCursor(Number(event.target.value))} aria-label="按15分钟查看图表数值"/><output className="gold-cursor-reading" aria-live="polite">{selectedPoint && `${time(selectedPoint.time)} 北京时间 · 金油比 ${format(selectedPoint.ratio)} ${units.ratio} · 黄金 ${format(selectedPoint.xau, 2)} USDT/盎司 · 原油 ${format(selectedPoint.oil)} ${units.oil}`}</output></>}
          <div className="chart-footer"><span>触摸或方向键查看完整记录 · 缺失时段断线</span><span>有效样本 {stats?.count ?? 0} / {points.length}</span></div>
          {sampled.length < points.length && <p className="gold-range-unit">绘图保留极值与缺口，共 {sampled.length} 个点；统计、滑块和明细使用全部记录。</p>}

          <section className="funding-history-section" aria-labelledby="gold-history-funding"><div className="plot-heading"><div><h2 id="gold-history-funding">历史多空资金费率</h2><p>{source} 实际结算记录 · 两腿等名义 · 随所选时间范围统计</p></div><div className="chart-legend"><span><i className="legend-line wti"/>做多金油比</span><span><i className="legend-line brent"/>做空金油比</span></div></div>
            <div className="funding-history-returns" aria-label="区间累计资金费与年化">{(['long', 'short'] as const).map(direction => <article key={direction}><p>{direction === 'long' ? '做多金油比' : '做空金油比'} <small>{direction === 'long' ? '多黄金、空原油' : '空黄金、多原油'}</small></p><span>{fees.covered && !fees.selectedCovered ? '已查询区间年化' : '区间累计年化'}</span><strong>{percent(direction === 'long' ? fees.longAnnualized : fees.shortAnnualized, 2)}</strong><p>已取得累计资金费 <b>{percent(direction === 'long' ? fees.longCumulative : fees.shortCumulative, 4)}</b></p></article>)}</div>
            {fees.covered && <p className="funding-history-period">资金费统计区间：{time(fees.start)} — {time(fees.end)} 北京时间。{!fees.selectedCovered && '所选区间尾部待更新，年化与曲线按已查询区间计算。'}</p>}
            <div className="funding-history-controls"><div className="range-buttons" role="group" aria-label="历史资金费指标"><button aria-pressed={fundingView === 'annualized'} onClick={() => setFundingView('annualized')}>累计年化</button><button aria-pressed={fundingView === 'rate'} onClick={() => setFundingView('rate')}>日均小时率</button></div><p>{fundingView === 'annualized' ? '% / 年 · 简单年化' : '% / 小时'}</p></div>
            <div className="gold-funding-chart">{fees.covered && fees.oilCount > 0 && fees.xauCount > 0 && fees.points.length && hasOpened ? <FundingChart oilType={oilType} exchange={exchange} points={fees.points} view={fundingView}/> : <div className="gold-empty">{fundingError ? '资金费历史暂不可用' : !funding ? '正在读取结算记录…' : '所选区间查询覆盖或两腿记录不足，年化暂不可用'}</div>}</div>
            <div className="chart-footer"><span>正值收款 · 负值付款</span><span>XAU {fees.xauCount} 次 · {instrument.code} {fees.oilCount} 次</span></div>
            <p className="funding-history-method">做空净结算率＝黄金实际结算率之和 ÷ 2 − 原油实际结算率之和 ÷ 2，做多取反。两腿结算时间与周期分别保留。年化＝累计净结算率 ÷ 实际统计区间日历小时 × 8,760；统计从所选起点开始，截止不晚于已查询时间。按 UTC 日汇总的曲线使用截至当日结束（或统计截止）的日历小时。不复利，不含价格盈亏。无记录不显示零费率，API 查询覆盖不等于保证交易所记录无缺失。</p>
            <p className={`funding-history-status ${fundingStale ? 'gold-data-stale' : ''}`}>{funding ? `${fundingStale ? '更新中断 · 保留记录。' : ''}API 查询覆盖：${time(funding.coverageStart)} — ${time(funding.coverageEnd)} 北京时间。${fees.selectedCovered ? '已覆盖所选区间。' : '所选区间未完全覆盖。'}最后更新 ${summaryTimestamp(funding.fetchedAt)}。` : '等待资金费数据。'}</p>
          </section>
        </div><aside className="range-summary"><div className="summary-heading"><h3>区间速览</h3><span>{rangeLabel}</span></div><div className="summary-average"><p>平均金油比</p><div>{format(stats?.average)}</div><span>{units.ratio}</span></div><div className="summary-extremes"><div><span>最高金油比</span><strong>{format(stats?.max.ratio)}</strong><small>{time(stats?.max.time)}</small></div><div><span>最低金油比</span><strong>{format(stats?.min.ratio)}</strong><small>{time(stats?.min.time)}</small></div></div><div className="range-track" aria-hidden="true"><span style={{ left: `${stats?.position ?? 50}%` }}/></div><p className="range-description">末值 {format(stats?.last.ratio)} · 区间变化 {signed(stats?.change)} {units.ratio}</p><div className="summary-note"><span className="note-symbol">↗</span><p>比值上升表示黄金相对原油走强；比值下降表示原油相对黄金走强。</p></div></aside></div>
      </section>

      <section className="bottom-grid"><article className="panel monthly-panel"><div className="section-heading"><div><h2>月度金油比</h2><p>所选区间各月有效 15 分钟比值的平均值</p></div><span className="unit-label">{units.ratio}</span></div><div className="monthly-chart" role="list" aria-label="月度平均金油比">{stats?.months.map(month => <div className="month-item" role="listitem" tabIndex={0} aria-label={`${month.month}：${format(month.average)} ${units.ratio}，${month.count} 个有效样本`} key={month.month}><div className="month-bar-area" aria-hidden="true"><div className="month-bar" style={{ height: `${month.average / maxMonth * 80}%`, bottom: 0 }}/><span className="month-value" style={{ bottom: `calc(${month.average / maxMonth * 80}% + 6px)` }}>{format(month.average)}</span></div><span className="month-label">{month.month}</span></div>)}</div><p className="monthly-note">月份按 UTC 划分；首尾月可能仅覆盖部分日期，缺失时段不参与均值。</p></article><article className="panel methodology"><p className="eyebrow">READING THE RATIO</p><h2>如何读这条金油比？</h2><p>{units.ratio === '报价比' ? 'Bybit BZ 按两腿原始标记报价计算。' : `比值表示每盎司黄金对应的${instrument.name}桶数。`}顶部为当前标记价格，历史为同一 UTC 15 分钟已收盘标记价。</p><div className="formula"><span>XAUUSDT ÷ {instrument.symbol}</span><b>{units.ratio}</b></div><p className="methodology-fine">做多金油比对应多黄金、空原油；做空相反。{units.ratio === '报价比' ? '黄金按盎司、BZ 按原始合约报价计价。' : '黄金按盎司、原油按桶计价。'}资金费使用等 USDT 名义，不能套用等桶数配仓。</p><p className="methodology-fine">原油合约可能包含底层期货换月与期限结构影响；资金费年化不包含价格盈亏。</p></article></section>

      <GoldOilDetails points={points} fundingByCandle={fundingByCandle} funding={funding} oilType={oilType} exchange={exchange} page={page} onPageChange={setPage}/>
      <footer><div className="footer-brand">GOLD / OIL<span>{instrument.code}-XAU</span></div><p>来源：{source} XAUUSDT / {instrument.symbol} · 标记价格与实际结算资金费</p><p className="footer-note">共同历史从两腿较晚上市时间开始；缺失时段断线，不补值。</p></footer>
    </main></div>
  </>, root)}</div>;
}
