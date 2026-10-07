import { memo, useEffect, useId, useRef, useState } from 'react';
import type { TradingState } from './trading-types';

const compact = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, notation: 'compact' });
const exact = (value: string | null) => value === null ? '—' : value;

export default memo(function TradingFundingChart({ daily }: { daily: TradingState['funding']['daily'] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const descriptionId = useId();
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  // A rolling 30-day window may intersect 31 Beijing calendar dates.
  const points = daily.slice(-31);
  const values = points.flatMap(point => [point.income, point.expense]).filter((value): value is string => value !== null).map(Number).filter(Number.isFinite);
  const maximum = values.length ? Math.max(0, ...values) : 0;
  const limit = maximum || 1;
  const left = 49, right = 9, top = 19, baseline = 106, bottom = 193, height = 224;
  const plotWidth = Math.max(1, width - left - right);
  const band = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(1, Math.min(17, band * .32));
  const labels = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const scale = (value: number) => Math.abs(value) / limit * (baseline - top);
  return <figure className="trading-chart">
    <figcaption><strong>按日资金费收付</strong><span className="trading-chart-key"><span><i className="income" />收入</span><span><i className="expense" />支出</span><span>USDT · 北京时间</span></span></figcaption>
    <p id={descriptionId} className="trading-caption">收入在零线上方，支出在下方；首尾日按区间截取。虚线标记记录不完整，缺失值不绘制。</p>
    <div ref={container} className="trading-chart-plot">
      {values.length ? <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`按日资金费收付，共 ${points.length} 天`} aria-describedby={descriptionId}>
        {[top, baseline, bottom].map((y, index) => <g key={y}><line x1={left} x2={width - right} y1={y} y2={y} stroke={index === 1 ? '#9aabba' : '#e7edf3'} strokeDasharray={index === 1 ? undefined : '3 4'} /><text x={left - 7} y={y + 4} textAnchor="end" fill="#66748a" fontSize="11">{index === 1 ? '0' : `${index === 2 ? '−' : ''}${compact.format(maximum)}`}</text></g>)}
        {points.map((point, index) => {
          const x = left + band * (index + .5);
          const income = point.income === null ? null : Number(point.income);
          const expense = point.expense === null ? null : Number(point.expense);
          return <g key={point.date}>
            <title>{`${point.date}：收入 ${exact(point.income)} USDT，支出 ${exact(point.expense)} USDT，净额 ${exact(point.net)} USDT${point.complete ? '' : '，部分记录'}`}</title>
            {income !== null && Number.isFinite(income) && income > 0 ? <rect x={x - barWidth - 1} y={baseline - scale(income)} width={barWidth} height={scale(income)} fill="#147d64" rx="1" /> : null}
            {expense !== null && Number.isFinite(expense) && expense > 0 ? <rect x={x + 1} y={baseline} width={barWidth} height={scale(expense)} fill="#c64b55" rx="1" /> : null}
            {!point.complete ? <line x1={x} x2={x} y1={top} y2={bottom} stroke="#9a6718" strokeDasharray="2 5" opacity=".65" /> : null}
            {labels.has(index) ? <text x={x} y={height - 8} fill="#66748a" fontSize="11" textAnchor="middle">{point.date.slice(5).replace('-', '/')}</text> : null}
          </g>;
        })}
      </svg> : <div className="trading-chart-empty">尚无可绘制的资金费记录</div>}
    </div>
    {points.length ? <details className="trading-daily-data"><summary>查看逐日数值</summary><div className="trading-table-scroll" tabIndex={0} role="region" aria-label="逐日资金费数值"><table><thead><tr><th scope="col">日期（北京时间）</th><th scope="col">收入 · USDT</th><th scope="col">支出 · USDT</th><th scope="col">净额 · USDT</th><th scope="col">记录状态</th></tr></thead><tbody>{points.map(point => <tr key={point.date}><td>{point.date}</td><td>{exact(point.income)}</td><td>{exact(point.expense)}</td><td>{exact(point.net)}</td><td>{point.complete ? '完整' : '部分记录'}</td></tr>)}</tbody></table></div></details> : null}
  </figure>;
});
