import { amountClass } from './live-display';
import DecimalValue from './DecimalValue';
import { decimalField } from './position-view';
import { venue } from './display';

export default function AccountBalances({ balances }: { balances: Record<string, unknown>[] }) {
  return <section className="panel"><div className="section-heading"><div><h2>资产与保证金</h2><p>按交易所、原币种展示金额，悬停查看完整值</p></div><span className="count">{balances.length} 项</span></div>
    {balances.length ? <div className="table-wrap"><table className="responsive-table"><thead><tr><th>交易账户 / 币种</th><th>余额</th><th>权益</th><th>可用余额</th><th>未实现盈亏</th><th>初始 / 维持保证金</th><th>负债</th></tr></thead><tbody>{balances.slice(0, 150).map((asset, index) => <tr key={`${asset.exchange_type}:${asset.coin}:${index}`}>
      <td data-label="账户 / 币种"><strong>{typeof asset.coin === 'string' ? asset.coin : '币种未知'}</strong><small>{typeof asset.exchange_type === 'string' ? venue(asset.exchange_type.toLowerCase()) : '—'}</small></td>
      <td data-label="余额"><DecimalValue value={decimalField(asset, 'balance')} kind="amount"/></td><td data-label="权益"><DecimalValue value={decimalField(asset, 'equity')} kind="amount"/></td><td data-label="可用余额"><DecimalValue value={decimalField(asset, 'available_balance')} kind="amount"/></td><td data-label="未实现盈亏" className={amountClass(decimalField(asset, 'upnl'))}><DecimalValue value={decimalField(asset, 'upnl')} kind="amount" signed/></td><td data-label="初始 / 维持保证金"><DecimalValue value={decimalField(asset, 'futures_initial_margin')} kind="amount"/> / <DecimalValue value={decimalField(asset, 'futures_maintenance_margin')} kind="amount"/></td><td data-label="负债"><DecimalValue value={decimalField(asset, 'liability')} kind="amount"/></td>
    </tr>)}</tbody></table></div> : <div className="empty">账户尚无可显示的资产数据。</div>}
    <p className="footnote">各行使用原始币种，不合并不同币种；单所可用余额与 CrossEx 统一保证金口径可能不同。</p>
  </section>;
}
