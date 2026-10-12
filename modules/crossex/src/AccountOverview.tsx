import type { LiveView } from './live-types';
import { exact } from './live-display';
import { decimalField, percentage } from './position-view';
import DecimalValue from './DecimalValue';

export default function AccountOverview({ live }: { live: LiveView }) {
  const account = live.account;
  const metrics = [
    { label: '可用保证金', value: decimalField(account, 'available_margin'), note: 'USDT · 账户保证金口径', accent: true },
    { label: '保证金权益', value: decimalField(account, 'margin_balance'), note: 'USDT · 账户保证金口径' },
    { label: '初始保证金', value: decimalField(account, 'initial_margin'), note: 'USDT · 账户保证金口径' },
    { label: '维持保证金', value: decimalField(account, 'maintenance_margin'), note: 'USDT · 账户保证金口径' },
    { label: '初始保证金率', value: decimalField(account, 'initial_margin_rate'), note: '交易所返回比例', rate: true },
    { label: '维持保证金率', value: decimalField(account, 'maintenance_margin_rate'), note: '交易所返回比例', rate: true },
  ];
  return <section className="account-overview" aria-label="账户总览">{metrics.map(metric => <div key={metric.label} className={metric.accent ? 'account-metric accent' : 'account-metric'}><span>{metric.label}</span><strong>{metric.rate ? <span className="numeric-value" title={metric.value == null ? undefined : `${exact(metric.value)}（原始比例）`}>{percentage(metric.value)}</span> : <DecimalValue value={metric.value} kind="amount"/>}</strong><small>{metric.note}</small></div>)}</section>;
}
