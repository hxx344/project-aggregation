import { useState } from 'react';
import type { LiveOrder, LiveView } from './live-types';
import { executionStatus, liveStatus, sideLabel } from './live-display';
import DecimalValue from './DecimalValue';
import { time, venue } from './display';

export default function HistoryPanel({ live, disabled, querying, query, cancel }: {
  live: LiveView; disabled: boolean; querying: boolean; query: () => void; cancel: (order: LiveOrder) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const terminal = new Set(['FILLED', 'CANCELLED', 'CANCELED', 'FAIL', 'REJECT', 'REJECTED', 'EXPIRED']);
  const orders = live.orders.filter(order => showClosed || !terminal.has(order.status.toUpperCase())).slice(0, 150);
  return <div className="order-panels">
    <section className="panel">
      <div className="section-heading"><div><h2>订单查询与撤单</h2><p>来源时间 {time(live.asOf)} · 状态以交易所最新查询为准</p></div><div className="filters"><label className="check"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)}/>显示已结束订单</label><button disabled={querying || !live.connection.configured} onClick={query}>{querying ? '正在查询…' : '查询最新状态'}</button></div></div>
      {orders.length ? <div className="table-wrap"><table className="responsive-table orders-table"><thead><tr><th>交易所 / 合约</th><th>方向 / 类型</th><th>委托数量</th><th>已成交数量</th><th>订单状态</th><th>操作</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}>
        <td data-label="合约"><strong>{order.symbol}</strong><small>{order.exchange ? venue(order.exchange) : 'Gate CrossEx'}</small><small className="order-id">{order.orderId || order.id}</small></td>
        <td data-label="方向">{sideLabel(order.side)}<small>{order.reduceOnly ? '只减仓' : '开仓委托'}</small></td>
        <td data-label="委托数量"><DecimalValue value={order.quantity}/></td><td data-label="已成交"><DecimalValue value={order.filledQuantity}/></td>
        <td data-label="状态"><span className={['UNKNOWN', 'CANCEL_PENDING', 'SENDING'].includes(order.status.toUpperCase()) ? 'warning' : ''}>{liveStatus(order.status)}</span><small>{time(order.updatedAt)}</small></td>
        <td data-label="操作"><button disabled={disabled || !order.canCancel || !['NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(order.status.toUpperCase())} onClick={() => cancel(order)}>撤销订单</button></td>
      </tr>)}</tbody></table></div> : <div className="empty"><h3>{live.connection.configured ? '当前没有可显示的订单' : '连接账户后查询订单'}</h3><p>下单后可在这里查询部分成交、挂单和撤单结果。</p></div>}
      <div className="footnote">状态待确认的订单先查询结果；查询与刷新不会发送新的委托。最多显示 150 条。</div>
    </section>
    <section className="panel execution-panel"><div className="section-heading"><div><h2>本工作台的实盘操作</h2><p>每次手动提交的结果与逐腿状态，不构造历史收益曲线。</p></div></div>
      {live.executions.length ? <div className="execution-list">{live.executions.slice(0, 100).map(execution => <article className="execution" key={execution.id}><div className="execution-title"><h3>{execution.kind === 'open' ? '手动开仓' : execution.kind === 'close' ? '手动平仓' : '撤单'} <span>{executionStatus(execution.state)}</span></h3><small>{time(execution.updatedAt || execution.createdAt)}</small></div><p className="order-id">请求 {execution.requestId || execution.id}</p>{execution.error && <p className="warning">{execution.error}</p>}<div className="execution-legs">{execution.legs?.map((leg, index) => <div key={leg.orderId || index}><strong>{leg.exchange ? venue(leg.exchange) : 'Gate CrossEx'} {leg.symbol || ''}</strong><span>{sideLabel(leg.side || '')} · {liveStatus(leg.status || leg.state || 'unknown')}</span><span>委托 <DecimalValue value={leg.quantity}/> / 已成交 <DecimalValue value={leg.filledQuantity}/></span>{leg.error && <span className="warning">{leg.error}</span>}</div>)}</div></article>)}</div> : <p className="empty">尚无实盘操作记录。</p>}
    </section>
  </div>;
}
