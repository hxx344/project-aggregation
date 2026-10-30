import Decimal from 'decimal.js';
import type { LiveView } from './live-types';
import { amountClass, exact } from './live-display';
import { decimalField, percentage, sumNative } from './position-view';
import { positionAsset } from './position-actions';
import DecimalValue from './DecimalValue';
import { time } from './display';

const share = (part: string | null, whole: string | null) => {
  if (exact(part) === '—' || exact(whole) === '—' || new Decimal(whole!).lte(0)) return null;
  return new Decimal(part!).div(whole!).toFixed();
};
const meterWidth = (rate: string | null) => exact(rate) === '—' ? null : Decimal.min(1, Decimal.max(0, new Decimal(rate!))).mul(100).toFixed(2) + '%';

export default function AccountOverview({ live, stale }: { live: LiveView; stale: boolean }) {
  const account = live.account;
  const equity = decimalField(account, 'margin_balance'), available = decimalField(account, 'available_margin');
  const maintenanceRate = decimalField(account, 'maintenance_margin_rate'), initialRate = decimalField(account, 'initial_margin_rate');
  const pnl = sumNative(live.positions, p => p.unrealizedPnl, p => p.pnlCurrency);
  const coins = new Set(live.positions.map(p => positionAsset(p) || p.symbol)).size;
  const availableShare = share(available, equity), width = meterWidth(maintenanceRate);
  const old = stale ? <span className="old" title="账户数据未及时更新，显示上次已知值">旧</span> : null;
  const rate = (value: string | null) => <span className="numeric-value" title={value == null ? undefined : `${exact(value)}（原始比例）`}>{percentage(value)}</span>;
  return <section className="panel account-overview" aria-label="账户总览">
    <div className="kpi"><span className="kpi-label">保证金权益 <small>USDT</small></span><strong><DecimalValue value={equity} kind="amount"/>{old}</strong><small>账户来源 {time(live.asOf)}</small></div>
    <div className="kpi"><span className="kpi-label">可用保证金</span><strong className="accent"><DecimalValue value={available} kind="amount"/>{old}</strong><small>{availableShare ? <>占权益 {percentage(availableShare)}</> : 'USDT · 账户保证金口径'}</small></div>
    <div className="kpi"><span className="kpi-label">未实现盈亏</span><strong>{pnl.length ? pnl.map(item => <span key={item.currency} className={amountClass(item.value)}><DecimalValue value={item.value} kind="amount" signed/>{pnl.length > 1 && <small> {item.currency}</small>}</span>) : <span className="muted">—</span>}{old}</strong><small>{coins} 个币种 · {live.positions.length} 条持仓腿{pnl.length === 1 ? ` · ${pnl[0].currency}` : ''}</small></div>
    <div className="kpi"><span className="kpi-label">初始保证金</span><strong><DecimalValue value={decimalField(account, 'initial_margin')} kind="amount"/>{old}</strong><small>初始保证金率 {rate(initialRate)}</small></div>
    <div className="kpi"><span className="kpi-label">维持保证金</span><strong><DecimalValue value={decimalField(account, 'maintenance_margin')} kind="amount"/>{old}</strong><small>USDT · 账户保证金口径</small></div>
    <div className="kpi"><span className="kpi-label">维持保证金率</span><strong>{rate(maintenanceRate)}{old}</strong>{width ? <div className="meter" role="img" aria-label={`维持保证金率 ${percentage(maintenanceRate)}`}><i style={{ width }}/></div> : <small>交易所返回比例</small>}</div>
  </section>;
}
