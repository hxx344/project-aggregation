import DecimalValue from './DecimalValue';
import { direction, time, venue } from './display';
import { percentage } from './position-view';
import { amountClass } from './live-display';
import { fundingPair, fundingStaleReason, type FundingLeg, type FundingOpportunity } from './funding-opportunities';
import type { Instrument } from './live-types';

export default function FundingOpportunitiesTable({ rows, instruments, now, monitorStale, onSelect }: {
  rows: FundingOpportunity[]; instruments: Instrument[]; now: number; monitorStale: boolean;
  onSelect: (row: FundingOpportunity) => void;
}) {
  return <>
    {rows.length ? <div className="table-wrap"><table className="responsive-table opportunity-table funding-table">
      <thead><tr><th>币种 / 方向</th><th>原始费率 / 周期</th><th>8h 等效费率差</th><th>开仓毛价差</th><th>下次结算</th><th>数据检查</th><th>操作</th></tr></thead>
      <tbody>{rows.map(row => {
        const reason = fundingStaleReason(row, now, monitorStale) || (!fundingPair(row, instruments) ? '对应合约尚未进入目录' : '');
        return <tr key={row.id}>
          <td data-label="币种 / 方向"><strong>{row.base}</strong><small>{direction(row)}</small><small>{row.long.quoteCurrency} / {row.short.quoteCurrency}</small></td>
          <td data-label="原始费率 / 周期"><FundingRate leg={row.long} side="多"/><FundingRate leg={row.short} side="空"/></td>
          <td data-label="8h 等效费率差"><strong className={reason ? 'muted' : 'positive'}><DecimalValue value={String(row.equivalent8hBps)} kind="rate" signed/> bp</strong><small>空腿 − 多腿 · 折合至 8h</small></td>
          <td data-label="开仓毛价差"><span className={amountClass(row.grossBps == null ? null : String(row.grossBps))}><DecimalValue value={row.grossBps == null ? null : String(row.grossBps)} kind="rate" signed/> bp</span><small>未扣交易费与滑点</small></td>
          <td data-label="下次结算"><small>多 · {time(row.long.nextFundingAt)}</small><small>空 · {time(row.short.nextFundingAt)}</small></td>
          <td data-label="数据检查"><span className={reason ? 'warning' : 'positive'}>{reason || '可参考'}</span><small>费率 · {time(row.asOf)}</small></td>
          <td data-label="操作"><button disabled={!!reason} onClick={() => onSelect(row)}>填入对冲组合</button></td>
        </tr>;
      })}</tbody>
    </table></div> : <div className="empty compact"><span>{monitorStale ? 'Monitor 行情待更新，暂无法比较资金费机会。' : '暂无匹配的正资金费差机会。'}</span><small>需要两所同币合约的有效费率与明确结算周期；缺失数据不按零计算。</small></div>}
    <p className="footnote">8h 等效费率差 =（空腿费率 ÷ 空腿周期 − 多腿费率 ÷ 多腿周期）× 8 × 10000 bp；公式中费率使用比例值，周期使用小时，按单腿相同名义额比较。正值表示该方向的资金费优势，不代表下次结算净收入；两腿结算时间、名义额及实际费率可能不同。开仓价差单独展示，未估算净收益或年化。最多显示 60 项。</p>
  </>;
}

function FundingRate({ leg, side }: { leg: FundingLeg; side: string }) {
  return <small className="funding-rate" title={`${leg.symbol} · 费率时间 ${time(leg.fundingAt)}`}><span>{side} · {venue(leg.exchange)}</span><strong>{percentage(String(leg.rate))} / {leg.intervalHours}h</strong></small>;
}
