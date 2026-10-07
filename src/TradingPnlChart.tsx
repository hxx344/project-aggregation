import { memo, useEffect, useId, useRef, useState } from 'react';
import type { TradingPnl, TradingPnlPoint } from './trading-types';

const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
const exact = (value: string | null | undefined) => value == null ? '—' : value;
const series = [{ key: 'totalPnl', label: '总盈亏', color: '#2860c7' }, { key: 'unrealizedPnl', label: '持仓浮盈亏', color: '#75879b' }] as const;

export default memo(function TradingPnlChart({ pnl }: { pnl: TradingPnl | undefined }) {
  const container = useRef<HTMLDivElement>(null), descriptionId = useId();
  const [width, setWidth] = useState(640), [selectedTime, setSelectedTime] = useState<number | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const points = pnl?.points ?? [];
  const found = selectedTime === null ? -1 : points.findIndex(point => point.time >= selectedTime);
  const selectedIndex = found < 0 ? points.length - 1 : found;
  const selected = points[selectedIndex];
  const values = points.flatMap(point => series.map(({ key }) => point[key])).filter((value): value is string => value !== null).map(Number).filter(Number.isFinite);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), extent = max - min || 1;
  const low = min - extent * .1, high = max + extent * .1;
  const left = 63, right = 18, top = 14, bottom = 210, height = 246;
  const from = points[0]?.time ?? 0, to = Math.max(from + 60_000, points.at(-1)?.time ?? from);
  const x = (value: number) => left + (value - from) / (to - from) * (width - left - right);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  function line(key: 'totalPnl' | 'unrealizedPnl') {
    let drawing = false;
    return points.map(point => {
      const value = point[key] === null ? NaN : Number(point[key]);
      if (!Number.isFinite(value)) { drawing = false; return ''; }
      const command = `${drawing ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(value).toFixed(2)}`;
      drawing = true; return command;
    }).join(' ');
  }
  const detail = (point: TradingPnlPoint | null | undefined) => <><span>总盈亏 <b>{exact(point?.totalPnl)}</b></span><span>持仓浮盈亏 <b>{exact(point?.unrealizedPnl)}</b></span><span>区间累计资金费 <b>{exact(point?.fundingPnl)}</b></span></>;
  return <figure className="trading-pnl-chart">
    <figcaption className="trading-pnl-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}<span>USDT · 北京时间</span></figcaption>
    <p id={descriptionId} className="trading-caption">后台约每分钟记录一次。缺失或过期时断线；资金费未取全时仅显示浮盈亏。长区间保留峰谷，缺失区段不连线。</p>
    <div className="trading-pnl-latest">{detail(pnl?.latest)}</div>
    <div className="trading-pnl-plot" ref={container}>
      {values.length ? <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="四腿总盈亏与持仓浮盈亏曲线" aria-describedby={descriptionId}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const at = from + ((event.clientX - bounds.left) * width / bounds.width - left) / (width - left - right) * (to - from);
          let lo = 0, hi = points.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].time < at) lo = mid + 1; else hi = mid; }
          const index = lo > 0 && Math.abs(points[lo - 1].time - at) < Math.abs(points[lo].time - at) ? lo - 1 : lo;
          setSelectedTime(points[index].time);
        }}>
        {[min, (min + max) / 2, max].filter((value, index, all) => all.indexOf(value) === index).map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e1e8ef" strokeDasharray={value === 0 ? undefined : '3 4'} /><text x={left - 8} y={y(value) + 4} textAnchor="end" fill="#66748a" fontSize="11">{compact.format(value)}</text></g>)}
        {series.slice().reverse().map(item => <g key={item.key}><path data-series={item.key} d={line(item.key)} fill="none" stroke={item.color} strokeWidth={item.key === 'totalPnl' ? 2.5 : 1.6} strokeDasharray={item.key === 'totalPnl' ? undefined : '5 4'} />{points.map((point, index) => point[item.key] !== null && (points[index - 1]?.[item.key] == null && points[index + 1]?.[item.key] == null) ? <circle key={point.time} cx={x(point.time)} cy={y(Number(point[item.key]))} r="3.5" fill={item.color} /> : null)}</g>)}
        {[from, to].map((value, index) => <text key={value} x={index ? width - right : left} y={height - 8} textAnchor={index ? 'end' : 'start'} fill="#66748a" fontSize="11">{time.format(value)}</text>)}
        {selected ? <line x1={x(selected.time)} x2={x(selected.time)} y1={top} y2={bottom} stroke="#9caec1" strokeDasharray="3 4" /> : null}
      </svg> : <div className="trading-chart-empty">连接两所并取得完整仓位后开始记录，历史浮盈亏无法回补。</div>}
    </div>
    {points.length ? <div className="trading-pnl-inspect"><label htmlFor={descriptionId + '-point'}>查看采样时刻 <strong>{selected ? time.format(selected.time) : '—'}</strong>（北京时间）</label><input id={descriptionId + '-point'} type="range" min="0" max={points.length - 1} value={selectedIndex} aria-label="选择盈亏采样时刻" aria-valuetext={selected ? `${time.format(selected.time)}，总盈亏 ${exact(selected.totalPnl)} USDT` : undefined} onChange={event => setSelectedTime(points[Number(event.target.value)].time)} /><div>{detail(selected)}<span>USDT</span></div></div> : null}
    <p className="trading-footnote">{pnl?.recordingStartedAt ? `当前可用记录起点：${time.format(pnl.recordingStartedAt)}（北京时间）。` : '等待真实仓位采样。'}{pnl?.pointCount === 1 ? '已取得首个采样点，后续将逐步形成曲线。' : ''}{pnl?.latest ? ` 最新采样：${time.format(pnl.latest.time)}。` : ''}</p>
  </figure>;
});
