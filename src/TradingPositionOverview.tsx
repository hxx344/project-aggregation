import { memo } from 'react';
import { Layers } from 'lucide-react';
import { amount, beijingTime, polarity, roundedAmount } from './trading-format';
import type { OverviewMarket } from './trading-overview';
import type { TradingReadState } from './trading-types';

const STATES: Record<TradingReadState, string> = { unconfigured: '未连接', loading: '同步中', live: '已同步', stale: '数据已过期', error: '读取失败' };

/** Compact, read-only position summary shown beside the live spread; details stay in 套利仓位. */
function TradingPositionOverview({ markets, onOpen }: { markets: OverviewMarket[]; onOpen: () => void }) {
  return <section className="trading-panel trading-overview" aria-labelledby="trading-overview-title">
    <div className="trading-panel-heading"><div><h2 id="trading-overview-title">持仓概览</h2><p>只读 · 金额保留两位小数 · 明细、预警与减仓设置见「套利仓位」</p></div><button className="button secondary" type="button" onClick={onOpen}><Layers size={15} />完整仓位</button></div>
    <div className="trading-table-scroll trading-overview-scroll" tabIndex={0} role="region" aria-label="持仓概览明细"><table className="trading-overview-table">
      <thead><tr><th scope="col">交易所 / 合约</th><th scope="col">方向 · 数量</th><th scope="col">名义价值<small>USDT</small></th><th scope="col">浮盈亏<small>USDT</small></th><th scope="col">距强平</th></tr></thead>
      {markets.map(market => <tbody key={market.id} data-market={market.id}>
        <tr className="trading-overview-market"><th colSpan={5} scope="colgroup"><strong>{market.name}</strong><span>{market.venues}</span><span className={`trading-status ${market.state}`}><i aria-hidden="true" />{STATES[market.state]}</span>{market.fetchedAt ? <time dateTime={market.fetchedAt}>{beijingTime(market.fetchedAt)}</time> : null}</th></tr>
        {market.rows.length ? market.rows.map(row => <tr key={row.id} data-position-id={row.id}>
          <th scope="row"><strong>{row.symbol}</strong><span>{row.exchange}</span></th>
          <td><span className={`trading-side ${row.side}`}>{row.side === 'long' ? '多' : '空'}</span>{amount(row.quantity)}{row.unit ? ` ${row.unit}` : ''}</td>
          <td>{roundedAmount(row.notional)}</td>
          <td className={polarity(row.unrealizedPnl)}>{roundedAmount(row.unrealizedPnl, true)}</td>
          <td className={row.near ? 'trading-negative trading-overview-near' : ''}>{row.distancePercent === null ? '—' : `${row.distancePercent}%`}</td>
        </tr>) : <tr><td colSpan={5} className="trading-overview-empty">{market.empty}</td></tr>}
        {market.error ? <tr><td colSpan={5} className="trading-overview-error">{market.error}</td></tr> : null}
        {market.rows.length && market.summary ? <tr className="trading-overview-summary"><td colSpan={5}>{market.summary}</td></tr> : null}
      </tbody>)}
    </table></div>
  </section>;
}

export default memo(TradingPositionOverview);
