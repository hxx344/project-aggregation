"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowLeftRight, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { usePerpetualFundingHistory } from '../hooks/use-perpetual-funding-history';
import { usePerpetualPriceHistory } from '../hooks/use-perpetual-price-history';
import { analyzeFundingStability, type FundingStabilityDay, type FundingStabilityReport } from '../lib/perpetual-funding-stability';
import { PERPETUAL_FUNDING_STALE_MS, type FundingHistoryPairRequest } from '../lib/perpetual-funding-history';
import { perpetualChartUrl, type PerpetualChartSelection } from '../lib/perpetual-chart-state';
import { perpetualPriceIdentity, PRICE_HOUR_MS, PRICE_HISTORY_STALE_MS, type PerpetualPriceLeg } from '../lib/perpetual-price-history';
import { quoteIsFresh, quotePrice, quotePriceTime } from '../lib/perpetual-spreads';
import type { PerpetualQuote, PerpetualSnapshot } from '../lib/perpetual-types';
import './perpetual-chart.css';

interface Props {
  selection: PerpetualChartSelection;
  snapshot: PerpetualSnapshot | null;
  active: boolean;
  now: number;
  onSelectionChange: (selection: PerpetualChartSelection) => void;
  onBack: () => void;
  connectionError: string;
}
type Point = { time: number; value: number | null };
type Series = { label: string; color: string; points: Point[]; dashed?: boolean; step?: boolean };
type DataStatus = FundingStabilityReport['status'] | 'loading';
const DAY = 86_400_000, WINDOWS = [3, 7, 30] as const;
const labels: Record<DataStatus, string> = { ready: '完整', pending: '采集中', partial: '历史不足', stale: '已过期', error: '更新失败', unsupported: '暂不支持', loading: '加载中' };
const stampFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
const stamp = (time: number | null | undefined) => time && Number.isFinite(time) ? stampFormat.format(time) : '—';
const number = (value: number | null | undefined) => value !== null && value !== undefined && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumSignificantDigits: 7 }) : '—';
const percent = (value: number | null | undefined) => value !== null && value !== undefined && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 5 })}%` : '—';
const polarity = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'is-positive' : 'is-negative';
const keyOf = (quote: PerpetualQuote) => `${quote.exchange}:${quote.symbol}`;
// Public quotes intentionally omit CrossEx-only enrichment. The server's
// directory fingerprint joins both histories without changing quote eligibility.
const historyIdentity = (quote: PerpetualQuote) => quote.historyIdentity === undefined ? perpetualPriceIdentity(quote) : quote.historyIdentity;
const emptyPoints: Point[] = [];

function nearestIndex(times: number[], time: number) {
  let low = 0, high = times.length - 1;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (times[middle] < time) low = middle + 1; else high = middle; }
  return low > 0 && time - times[low - 1] <= times[low] - time ? low - 1 : low;
}
function valueAt(points: Point[], time: number, step = false): Point | undefined {
  let low = 0, high = points.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (points[middle].time <= time) low = middle + 1; else high = middle; }
  const point = points[low - 1];
  return point && point.value !== null && (step || time - point.time < PRICE_HOUR_MS) ? point : undefined;
}

const TimePlot = memo(function TimePlot({ title, series, bars, start, end, cursor, onSelect, unit = '%', empty }: {
  title: string; series: Series[]; bars?: FundingStabilityDay[]; start: number; end: number;
  cursor: number; onSelect: (time: number) => void; unit?: string; empty: string;
}) {
  const container = useRef<HTMLDivElement>(null), clip = useId();
  const [width, setWidth] = useState(360);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0]?.contentRect.width ?? 360); if (next > 0) setWidth(next); });
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => {
    const left = 60, right = Math.max(80, width - 12), top = 14, bottom = 156;
    const values = [...series.flatMap(line => line.points.flatMap(point => point.value === null ? [] : [point.value])), ...(bars ?? []).flatMap(day => day.netPercent === null ? [] : [day.netPercent])];
    if (bars || unit === '%') values.push(0);
    const low = values.length ? Math.min(...values) : -1, high = values.length ? Math.max(...values) : 1;
    const pad = Math.max((high - low) * .10, Math.abs(high) * .005, .00001), minimum = low - pad, maximum = high + pad;
    const x = (time: number) => left + (time - start) / Math.max(1, end - start) * (right - left);
    const y = (value: number) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const paths = series.map(line => {
      let previous: Point | null = null;
      return line.points.map(point => {
        if (point.value === null) { previous = null; return ''; }
        const connected = previous && (line.step || point.time - previous.time <= PRICE_HOUR_MS);
        const command = !connected ? `M${x(point.time)},${y(point.value)}` : line.step ? `H${x(point.time)}V${y(point.value)}` : `L${x(point.time)},${y(point.value)}`;
        previous = point; return command;
      }).join(' ');
    });
    return { left, right, top, bottom, x, y, paths, ticks: [minimum, (minimum + maximum) / 2, maximum], hasData: series.some(line => line.points.some(point => point.value !== null)) || Boolean(bars?.some(day => day.netPercent !== null)) };
  }, [series, bars, start, end, width, unit]);
  const select = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / Math.max(1, bounds.width) * width;
    onSelect(start + Math.max(0, Math.min(1, (x - geometry.left) / (geometry.right - geometry.left))) * (end - start));
  };
  return <div className="perp-chart-canvas" ref={container}>
    <svg viewBox={`0 0 ${width} 188`} height="188" width="100%" role="img" aria-label={title}
      onPointerDown={select} onPointerMove={event => { if (event.pointerType === 'mouse' || event.buttons) select(event); }}>
      <defs><clipPath id={clip}><rect x={geometry.left} y={geometry.top} width={geometry.right - geometry.left} height={geometry.bottom - geometry.top}/></clipPath></defs>
      {geometry.ticks.map(value => <g key={value}><line className="perp-chart-grid" x1={geometry.left} x2={geometry.right} y1={geometry.y(value)} y2={geometry.y(value)}/><text className="perp-chart-axis" x={geometry.left - 8} y={geometry.y(value) + 4} textAnchor="end">{Number(value.toPrecision(3)).toLocaleString('en-US', { maximumSignificantDigits: 3 })}</text></g>)}
      <text className="perp-chart-axis" x="3" y="12">{unit}</text>
      <g clipPath={`url(#${clip})`}>
        {bars?.map(day => { const x = geometry.x(day.from) + 2, barWidth = Math.max(2, geometry.x(day.to) - x - 2); return day.netPercent === null
          ? <rect key={day.to} x={x} width={barWidth} y={geometry.top + 4} height={geometry.bottom - geometry.top - 8} className="perp-chart-missing"><title>{stamp(day.to)} · 该24小时资料不足</title></rect>
          : <rect key={day.to} x={x} width={barWidth} y={Math.min(geometry.y(0), geometry.y(day.netPercent)) - (day.netPercent === 0 ? 1 : 0)} height={Math.max(2, Math.abs(geometry.y(day.netPercent) - geometry.y(0)))} className={`perp-chart-bar ${polarity(day.netPercent)}`}><title>{stamp(day.to)} · {percent(day.netPercent)}</title></rect>; })}
        {series.map((line, index) => <path key={line.label} d={geometry.paths[index]} fill="none" stroke={line.color} strokeWidth="1.8" strokeDasharray={line.dashed ? '5 3' : undefined} vectorEffect="non-scaling-stroke"/>)}
        {start <= cursor && cursor <= end ? <line className="perp-chart-crosshair" x1={geometry.x(cursor)} x2={geometry.x(cursor)} y1={geometry.top} y2={geometry.bottom}/> : null}
        {series.map(line => { const selected = valueAt(line.points, cursor, line.step); return selected ? <circle key={line.label} cx={geometry.x(line.step ? cursor : selected.time)} cy={geometry.y(selected.value!)} r="3.4" fill={line.color} stroke="var(--scanner-bg, var(--card))" strokeWidth="1.5"/> : null; })}
      </g>
      {[0, .5, 1].map(fraction => { const at = start + fraction * (end - start); return <text key={fraction} x={geometry.x(at)} y="179" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'} className="perp-chart-axis">{end > 0 ? dayFormat.format(at) : '—'}</text>; })}
    </svg>
    {!geometry.hasData ? <p className="perp-chart-empty">{empty}</p> : null}
  </div>;
});

function ChartPanel({ index, title, note, state, children, selected }: { index: string; title: string; note: string; state: DataStatus; children: ReactNode; selected: ReactNode }) {
  return <section className="perp-chart-panel"><header><div><span className="perp-chart-index">{index}</span><h4>{title}</h4></div><span className={`perp-chart-state is-${state}`}>{labels[state]}</span></header><p className="perp-chart-note">{note}</p>{children}<div className="perp-chart-selected">{selected}</div></section>;
}

function QuoteBrief({ quote, contract, side, name, now, staleAfter }: { quote: PerpetualQuote | undefined; contract: string; side: 'long' | 'short'; name: string; now: number; staleAfter: number }) {
  const price = quote ? quotePrice(quote, 'book', side === 'long' ? 'buy' : 'sell') : null;
  const fresh = Boolean(quote && quoteIsFresh(quote, 'book', now, staleAfter));
  const fundingFresh = quote?.fundingAt !== undefined && quote.fundingAt <= now + 5000 && now - quote.fundingAt <= 300_000;
  return <div className={`perp-chart-leg is-${side}`}><div><span>{side === 'long' ? '做多' : '做空'}</span><strong>{name}</strong><small>{quote?.symbol ?? contract.slice(contract.indexOf(':') + 1)}</small></div>
    <p><span>{side === 'long' ? '当前卖一' : '当前买一'}</span><b>{number(price)}</b><small>{quote?.quoteCurrency ?? ''}</small>{!quote ? <em>合约不可用</em> : !fresh ? <em>报价已过期</em> : null}</p>
    <small>资金费 {percent(quote?.fundingRate == null ? null : quote.fundingRate * 100)} / {quote?.fundingIntervalHours ?? '—'}h{quote && !fundingFresh ? ' · 已过期或时间缺失' : ''} · 盘口 {quote ? stamp(quotePriceTime(quote, 'book')) : '—'}</small>
  </div>;
}

function priceState(leg: PerpetualPriceLeg | undefined, start: number, end: number, now: number, failed: boolean, count: number, expected: number): DataStatus {
  if (!leg) return 'pending';
  if (leg.status === 'unsupported') return 'unsupported';
  if (failed || leg.status === 'error') return 'error';
  if (leg.to !== null && (leg.to > now + 5000 || now - leg.to > PRICE_HISTORY_STALE_MS)) return 'stale';
  if (!count) return leg.status === 'pending' ? 'pending' : 'partial';
  if (leg.from === null || leg.to === null || leg.from > start || leg.to < Math.floor(end / PRICE_HOUR_MS) * PRICE_HOUR_MS || count < expected) return 'partial';
  return 'ready';
}
const noSeries: Series[] = [];

function PerpetualChart({ selection, snapshot, active, now, onSelectionChange, onBack, connectionError }: Props) {
  useEffect(() => { document.getElementById('perpetual-chart-heading')?.focus(); }, []);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [copied, setCopied] = useState({ key: '', message: '' });
  const [recordsOpen, setRecordsOpen] = useState(false), [recordPage, setRecordPage] = useState(0);
  const pair = useMemo<FundingHistoryPairRequest>(() => ({ base: selection.base, longKey: selection.longKey, shortKey: selection.shortKey }), [selection.base, selection.longKey, selection.shortKey]);
  const pairs = useMemo(() => [pair], [pair]);
  const quotes = useMemo(() => [selection.longKey, selection.shortKey].map(key => snapshot?.quotes.find(quote => keyOf(quote) === key && quote.base === selection.base)), [snapshot, selection.longKey, selection.shortKey, selection.base]);
  const [longQuote, shortQuote] = quotes;
  const usable = Boolean(longQuote && shortQuote && longQuote.comparable !== false && shortQuote.comparable !== false && longQuote.historyIdentity !== null && shortQuote.historyIdentity !== null);
  const funding = usePerpetualFundingHistory(pairs, active && usable);
  const prices = usePerpetualPriceHistory(pair, selection.days, active && usable);
  const clock = now > 0 ? now : snapshot?.generatedAt ?? 0;
  const histories = [selection.longKey, selection.shortKey].map((key, index) => {
    const leg = funding.report?.legs[key], quote = quotes[index];
    return leg?.key === key && (!quote || leg.identity === historyIdentity(quote)) ? leg : undefined;
  });
  const [longHistory, shortHistory] = histories;
  const commonEnd = longHistory?.coverage && shortHistory?.coverage ? Math.min(longHistory.coverage.to, shortHistory.coverage.to) : null;
  // Clock ticks only change these analyses when freshness crosses a boundary.
  const analysisClock = commonEnd === null ? 0 : commonEnd > clock + 5000 ? commonEnd - 5001 : clock - commonEnd > PERPETUAL_FUNDING_STALE_MS ? commonEnd + PERPETUAL_FUNDING_STALE_MS + 1 : commonEnd;
  const analyses = useMemo(() => WINDOWS.map(days => analyzeFundingStability(longHistory, shortHistory, days, analysisClock)), [longHistory, shortHistory, analysisClock]);
  const analysis = analyses.find(item => item.days === selection.days)!;
  const end = analysis.asOf !== null && analysis.asOf <= clock + 5000 ? analysis.asOf : clock, start = end - selection.days * DAY;
  const closedHour = Math.floor(clock / PRICE_HOUR_MS) * PRICE_HOUR_MS;
  const priceData = useMemo(() => {
    const legs = [selection.longKey, selection.shortKey].map((key, index) => {
      const leg = prices.report?.legs[key], quote = quotes[index];
      return leg?.key === key && (!quote || leg.identity === historyIdentity(quote)) ? leg : undefined;
    });
    const hours: number[] = [];
    for (let time = (Math.floor(start / PRICE_HOUR_MS) + 1) * PRICE_HOUR_MS; time <= Math.min(end, closedHour); time += PRICE_HOUR_MS) hours.push(time);
    const points = legs.map(leg => {
      const byTime = new Map((leg?.points ?? []).filter(point => point.time <= closedHour && point.time > start && point.time <= end).map(point => [point.time, point.close]));
      return hours.map(time => ({ time, value: byTime.get(time) ?? null }));
    });
    const currencies = legs.map((leg, index) => leg?.currency ?? quotes[index]?.quoteCurrency ?? '');
    const comparable = Boolean(currencies[0] && currencies[0] === currencies[1]);
    const spread = hours.map((time, index) => ({ time, value: comparable && points[0][index].value !== null && points[1][index].value !== null
      ? (points[1][index].value! / points[0][index].value! - 1) * 100 : null }));
    return { legs, hours, points, currencies, comparable, spread };
  }, [prices.report, quotes, selection.longKey, selection.shortKey, start, end, closedHour]);
  const fundingPoints = useMemo(() => analysis.cumulative.map(point => ({ time: point.time, value: point.netPercent })), [analysis.cumulative]);
  const times = useMemo(() => [...new Set([start, end, ...priceData.hours, ...analysis.events.map(event => event.time), ...analysis.daily.map(day => day.to)])].sort((left, right) => left - right), [start, end, priceData.hours, analysis.events, analysis.daily]);
  const cursorIndex = nearestIndex(times, cursorTime ?? end), cursor = times[cursorIndex];
  const selectTime = useCallback((time: number) => setCursorTime(time), []);
  const spreadSeries = useMemo<Series[]>(() => [{ label: '小时收盘价差', color: 'var(--scanner-focus, var(--primary))', points: priceData.spread }], [priceData.spread]);
  const priceSeries = useMemo<Series[]>(() => [
    { label: '做多腿', color: 'var(--chart-long)', points: priceData.points[0] ?? emptyPoints },
    { label: '做空腿', color: 'var(--chart-short)', points: priceData.points[1] ?? emptyPoints, dashed: true },
  ], [priceData.points]);
  const cumulativeSeries = useMemo<Series[]>(() => [{ label: '累计净资金费', color: 'var(--scanner-focus, var(--primary))', points: fundingPoints, step: true }], [fundingPoints]);
  const selectedSpread = valueAt(priceData.spread, cursor), selectedPrices = priceData.points.map(points => valueAt(points, cursor));
  const selectedCumulative = valueAt(fundingPoints, cursor, true), selectedDay = analysis.daily.find(day => cursor > day.from && cursor <= day.to);
  const priceStates = priceData.legs.map((leg, index) => priceState(leg, start, end, clock, Boolean(prices.error), priceData.points[index].filter(point => point.value !== null).length, priceData.hours.length));
  const priceStatus = (['error', 'unsupported', 'stale', 'pending', 'partial', 'ready'] as const).find(status => priceStates.includes(status)) ?? 'pending';
  const fundingStatus = funding.error ? 'error' : analysis.status;
  const fundingReason = funding.error || analysis.reason;
  const names = [selection.longKey, selection.shortKey].map(key => snapshot?.exchanges.find(exchange => exchange.id === key.split(':')[0])?.name ?? key.split(':')[0]);
  const selectionKey = JSON.stringify(selection);
  const copy = async () => {
    try { await navigator.clipboard.writeText(perpetualChartUrl(window.location.href, selection)); setCopied({ key: selectionKey, message: '链接已复制' }); }
    catch { setCopied({ key: selectionKey, message: '复制失败，请复制地址栏链接' }); }
  };
  const rawRows = useMemo(() => {
    if (!recordsOpen) return [];
    const rows = new Map<number, { time: number; long: number | null; short: number | null }>();
    for (const side of ['long', 'short'] as const) for (const event of analysis[`${side}Events`]) {
      const row = rows.get(event.time) ?? { time: event.time, long: null, short: null };
      row[side] = event.percent; rows.set(event.time, row);
    }
    return [...rows.values()].sort((left, right) => right.time - left.time);
  }, [analysis, recordsOpen]);
  const pages = Math.max(1, Math.ceil(rawRows.length / 50)), visibleRecordPage = Math.min(recordPage, pages - 1);
  const shared = { start, end, cursor, onSelect: selectTime };
  const historicalPriceMessage = prices.error || priceData.legs.map(leg => leg?.error).filter(Boolean).join(' · ') || '小时成交价历史采集中；资金费分析可独立查看。';

  return <section className="perpetual-chart" aria-label={`${selection.base} 组合历史图表`}>
    <div className="perp-chart-actions"><button type="button" onClick={onBack}><ArrowLeft size={16}/>返回机会</button><div><button type="button" onClick={() => onSelectionChange({ ...selection, longKey: selection.shortKey, shortKey: selection.longKey })}><ArrowLeftRight size={16}/>交换多空</button><button type="button" onClick={() => void copy()}><Copy size={15}/>复制链接</button></div></div>
    <header className="perp-chart-heading"><div><span>{selection.base} · 永续合约</span><h3 id="perpetual-chart-heading" tabIndex={-1}>创建价差图表</h3></div><p>历史收盘价与真实结算 · 北京时间</p></header>
    {copied.key === selectionKey ? <p role="status" className="perp-chart-copy-status">{copied.message}</p> : null}
    {!usable ? <p role="status" className="perp-chart-warning">{snapshot ? '当前目录中缺少所选合约或该合约不可比较。已保留组合名称与已有历史，暂停发起新读取。' : '正在读取所选合约目录…'}</p> : null}
    {connectionError ? <p role="status" className="perp-chart-warning">{connectionError} · 已取得的历史继续保留。</p> : null}
    <div className="perp-chart-direction"><QuoteBrief quote={longQuote} contract={selection.longKey} side="long" name={names[0]} now={clock} staleAfter={snapshot?.staleAfterMs ?? 30000}/><QuoteBrief quote={shortQuote} contract={selection.shortKey} side="short" name={names[1]} now={clock} staleAfter={snapshot?.staleAfterMs ?? 30000}/></div>
    <div className="perp-chart-windows" aria-label="资金费稳定度窗口">{analyses.map(item => <button type="button" key={item.days} aria-label={`查看 ${item.days} 天资金费稳定度`} aria-pressed={selection.days === item.days} onClick={() => onSelectionChange({ ...selection, days: item.days })}>
      <span><b>{item.days} 天</b><small>{funding.error ? '更新失败' : labels[item.status]}</small></span><strong>{item.positiveRatio === null ? '—' : `${Math.round(item.positiveRatio * 100)}%`}</strong><span>正收益日占比</span><small>{item.positiveRatio === null ? `有效 ${item.validDays} / ${item.totalDays} 天` : `${item.positiveDays} / ${item.totalDays} 天净收款`}</small><span className="perp-chart-window-total">累计 <b className={polarity(item.total.netPercent)}>{percent(item.total.netPercent)}</b></span>
    </button>)}</div>
    <div className="perp-chart-window-context"><p>{analysis.asOf !== null ? <>{stamp(start)} — {stamp(end)} · 两腿共同截止</> : '等待共同资金费覆盖；价格先按当前时间展示。'}{!active ? ' · 读取已暂停' : ''}</p><span>{funding.loading ? '结算资料更新中' : '实际结算 · 单腿等名义金额'}</span></div>
    {fundingReason ? <p className="perp-chart-data-status" role="status">{fundingReason}{analysis.validDays < analysis.totalDays ? ` · 已覆盖的 ${analysis.validDays} 个完整日仍可核对，总体稳定度暂不计算。` : ''}</p> : null}
    <dl className="perp-chart-metrics"><div><dt>最差 24h</dt><dd className={polarity(analysis.worstDayPercent)}>{percent(analysis.worstDayPercent)}</dd></div><div><dt>最长连续负收益</dt><dd>{analysis.longestNegativeDays === null ? '—' : `${analysis.longestNegativeDays} 天`}</dd></div><div><dt>累计资金费回撤</dt><dd>{percent(analysis.maxDrawdownPercent)}</dd></div><div><dt>日均净资金费</dt><dd className={polarity(analysis.meanDayPercent)}>{percent(analysis.meanDayPercent)}</dd></div></dl>
    <div className="perp-chart-cursor"><div><strong>查看时间</strong><time dateTime={cursor > 0 ? new Date(cursor).toISOString() : undefined}>{stamp(cursor)} 北京时间</time></div><div><button type="button" aria-label="前一个图表时间" disabled={cursorIndex <= 0} onClick={() => setCursorTime(times[cursorIndex - 1])}><ChevronLeft size={17}/></button><input aria-label="图表查看时间" type="range" min="0" max={times.length - 1} step="1" value={cursorIndex} aria-valuetext={`${stamp(cursor)} 北京时间`} onChange={event => setCursorTime(times[Number(event.target.value)])}/><button type="button" aria-label="后一个图表时间" disabled={cursorIndex >= times.length - 1} onClick={() => setCursorTime(times[cursorIndex + 1])}><ChevronRight size={17}/></button></div></div>
    <div className="perp-chart-plots">
      <ChartPanel index="01" title="小时收盘价差" note="（空腿收盘价 ÷ 多腿收盘价 − 1）× 100%；已闭合小时，缺口断线。" state={priceData.comparable ? priceStatus : 'unsupported'} selected={<><strong className={polarity(selectedSpread?.value)}>{percent(selectedSpread?.value)}</strong><span>收盘时刻 {stamp(selectedSpread?.time)}</span></>}>
        <TimePlot {...shared} title="小时收盘价差图" series={spreadSeries} empty={priceData.comparable ? historicalPriceMessage : '两腿计价币不同或尚未确认，暂不计算历史价差；未使用当前汇率回填。'}/>
      </ChartPanel>
      <ChartPanel index="02" title="双腿成交价格" note={priceData.comparable ? `小时收盘价 · ${priceData.currencies[0]} / ${selection.base}；实线多腿，虚线空腿。` : '不同计价币分别展示原币价格，不共用价格纵轴。'} state={priceStatus} selected={<>{selectedPrices.map((point, index) => <span key={index}><i className={index ? 'is-short' : 'is-long'}/>{index ? '空' : '多'} <strong>{number(point?.value)} {priceData.currencies[index]}</strong><small>{stamp(point?.time)}</small></span>)}</>}>
        {priceData.comparable ? <TimePlot {...shared} title="双腿小时成交价格图" series={priceSeries} unit={priceData.currencies[0]} empty={historicalPriceMessage}/> : priceSeries.map((line, index) => <div className="perp-chart-price-leg" key={line.label}><p>{line.label} · {names[index]} · {priceData.currencies[index] || '币种待确认'} <span>{labels[priceStates[index]]}</span></p><TimePlot {...shared} title={`${line.label}小时成交价格图`} series={[line]} unit={priceData.currencies[index]} empty={priceData.legs[index]?.error || historicalPriceMessage}/></div>)}
        {prices.error ? <p className="perp-chart-data-status">{prices.error}</p> : null}
      </ChartPanel>
      <ChartPanel index="03" title="累计净资金费" note="空腿结算收入减多腿结算支出；同刻先合并，累计按真实结算阶梯变化。" state={fundingStatus} selected={<><strong className={polarity(selectedCumulative?.value)}>{percent(selectedCumulative?.value)}</strong><span>截至游标时间 · 最近变化 {stamp(analysis.events.filter(event => event.time <= cursor).at(-1)?.time)}</span></>}>
        <TimePlot {...shared} title="累计净资金费阶梯图" series={cumulativeSeries} empty={fundingReason || '完整窗口尚未取得，暂不绘制累计曲线。'}/>
      </ChartPanel>
      <ChartPanel index="04" title="每日净资金费" note="从共同截止向前划分完整 24h；绿为净收款、红为净支出，虚框为资料不足。" state={fundingStatus} selected={<><strong className={polarity(selectedDay?.netPercent)}>{percent(selectedDay?.netPercent)}</strong><span>{selectedDay ? `${stamp(selectedDay.from)} — ${stamp(selectedDay.to)} · ${labels[selectedDay.status]}` : '选择窗口内时间查看对应的完整 24h'}</span></>}>
        <TimePlot {...shared} title="每日净资金费柱状图" series={noSeries} bars={analysis.daily} empty={fundingReason || '尚无可核对的完整24小时数据。'}/>
      </ChartPanel>
    </div>
    <details className="perp-chart-records" onToggle={event => setRecordsOpen(event.currentTarget.open)}><summary>每腿实际结算记录 <span>{analysis.longEvents.length} 条多腿 / {analysis.shortEvents.length} 条空腿</span></summary>
      {recordsOpen ? <><p>每次实际结算费率，未折算为 8h。正费率对多腿是支出、对空腿是收入；“—”表示该时刻无记录。</p><div className="perp-chart-table-wrap"><table><thead><tr><th>结算时刻 / 北京</th><th>多腿 / %</th><th>空腿 / %</th></tr></thead><tbody>{rawRows.slice(visibleRecordPage * 50, (visibleRecordPage + 1) * 50).map(row => <tr key={row.time}><th scope="row">{stamp(row.time)}</th><td>{percent(row.long)}</td><td>{percent(row.short)}</td></tr>)}</tbody></table>{!rawRows.length ? <p>暂未取得实际结算记录。</p> : null}</div><div className="perp-chart-record-pages"><button type="button" disabled={visibleRecordPage === 0} onClick={() => setRecordPage(visibleRecordPage - 1)}>上一页</button><span>{visibleRecordPage + 1} / {pages}</span><button type="button" disabled={visibleRecordPage + 1 >= pages} onClick={() => setRecordPage(visibleRecordPage + 1)}>下一页</button></div></> : null}
    </details>
    <details className="perp-chart-method"><summary>研究口径与数据来源</summary><p>历史价格来自所选交易所的已闭合小时成交价，不是可成交盘口。当前多腿卖一、空腿买一单独列示，页面约每 20 秒应用最新行情。价格已按合约倍率归一，不重复换算；不同计价币没有历史汇率时不计算价差。</p><p>资金费统计窗口为（起点，共同截止]，共同截止取两腿查询覆盖结束的较早值。分母为单腿等名义金额；统计不含开平仓价差、手续费、滑点，也不是账户实际盈亏。查询覆盖、窗口前真实结算及每日双腿记录用于核对数据，不能证明交易所没有遗漏结算。</p><p>正收益日占比 = 净资金费大于零的天数 ÷ 完整窗口天数；零不算正收益日。完整窗口不足时仅展示可核对的完整天，不补零，不计算总体稳定度。回撤为真实结算累计从历史高点到之后低点的最大下降，含窗口起点零值；不是未来盈利概率。</p><p>多腿历史覆盖 {stamp(longHistory?.coverage?.from)} — {stamp(longHistory?.coverage?.to)}；空腿 {stamp(shortHistory?.coverage?.from)} — {stamp(shortHistory?.coverage?.to)}。资金费最近查询 {stamp(funding.report?.generatedAt)}；价格最近查询 {stamp(prices.report?.generatedAt)}。时间存储为 UTC epoch，页面统一显示北京时间。</p></details>
  </section>;
}

export default memo(PerpetualChart);
