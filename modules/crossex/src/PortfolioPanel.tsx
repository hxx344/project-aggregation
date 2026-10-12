import { useState } from 'react';
import type { CloseLeg, Instrument, LiveView } from './live-types';
import { amountClass, sideLabel } from './live-display';
import DecimalValue from './DecimalValue';
import { decimalField } from './position-view';
import { time } from './display';
import AccountBalances from './AccountBalances';
import PositionsPanel from './PositionsPanel';

export default function PortfolioPanel({ live, instruments, disabled, close }: { live: LiveView; instruments: Instrument[]; disabled: boolean; close: (positions: CloseLeg[]) => Promise<boolean> }) {
  const [tab, setTab] = useState('positions');
  return <><div className="panel-tabs portfolio-tabs" role="tablist" aria-label="账户明细">{[['positions', '持仓组合'], ['balances', '账户资产'], ['trades', '真实成交'], ['book', '资金流水']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'positions' && <span className="count">{live.positions.length}</span>}</button>)}</div>
    {tab === 'positions' && <PositionsPanel live={live} instruments={instruments} disabled={disabled} close={close}/>}
    {tab === 'balances' && <AccountBalances balances={live.balances}/>}
    {(tab === 'trades' || tab === 'book') && <AccountHistory live={live} kind={tab}/>}
  </>;
}

const textField = (row: Record<string, unknown>, key: string) => typeof row[key] === 'string' ? row[key] as string : '—';
function recordTime(row: Record<string, unknown>): number | null {
  for (const name of ['create_time', 'time', 'update_time']) { const value = row[name]; if (typeof value !== 'number' && typeof value !== 'string') continue; const parsed = Number(value); if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e12 ? parsed * 1000 : parsed; }
  return null;
}
function AccountHistory({ live, kind }: { live: LiveView; kind: string }) {
  const trade = kind === 'trades', records = trade ? live.recentTrades || [] : live.accountBook || [];
  const historyError = trade ? live.recentTradesError : live.accountBookError;
  return <section className="panel"><div className="section-heading"><div><h2>{trade ? '真实成交' : '资金流水'}</h2><p>交易所账户记录 · 来源时间 {time(trade ? live.recentTradesAsOf : live.accountBookAsOf)}</p></div><span className="count">{records.length} 条</span></div>{historyError && <p className="inline-state warning">{historyError} · 保留上次已知记录</p>}
    {records.length ? <div className="table-wrap"><table className="responsive-table"><thead>{trade ? <tr><th>合约 / 时间</th><th>方向</th><th>成交数量</th><th>成交价</th><th>手续费</th><th>已实现盈亏</th><th>订单 / 成交编号</th></tr> : <tr><th>类型 / 时间</th><th>变动金额</th><th>币种</th><th>合约 / 交易账户</th></tr>}</thead><tbody>{records.slice(0, 150).map((row, index) => trade ? <tr key={textField(row, 'transaction_id') + index}><td data-label="合约 / 时间"><strong>{textField(row, 'symbol')}</strong><small>{time(recordTime(row))}</small></td><td data-label="方向">{sideLabel(textField(row, 'side'))}</td><td data-label="成交数量"><DecimalValue value={decimalField(row, 'qty')}/></td><td data-label="成交价"><DecimalValue value={decimalField(row, 'price')} kind="price"/></td><td data-label="手续费"><DecimalValue value={decimalField(row, 'fee')} kind="amount"/> {textField(row, 'fee_coin')}</td><td data-label="已实现盈亏" className={amountClass(decimalField(row, 'rpnl'))}><DecimalValue value={decimalField(row, 'rpnl')} kind="amount" signed/><small>合约原生值</small></td><td data-label="订单 / 成交编号" className="order-id">{textField(row, 'order_id')}<small>{textField(row, 'transaction_id')}</small></td></tr> : <tr key={index}><td data-label="类型 / 时间"><strong>{textField(row, 'statement_type')}</strong><small>{time(recordTime(row))}</small></td><td data-label="变动金额" className={amountClass(decimalField(row, 'change'))}><DecimalValue value={decimalField(row, 'change')} kind="amount" signed/></td><td data-label="币种">{row.currency || row.coin ? String(row.currency || row.coin) : '—'}</td><td data-label="合约 / 账户">{textField(row, 'symbol')}<small>{textField(row, 'exchange_type')}</small></td></tr>)}</tbody></table></div> : <div className="empty">{historyError ? '暂时无法读取记录。' : '尚无可显示的交易所记录。'}</div>}
    <p className="footnote">最多显示 150 条近期记录；金额使用原币种，悬停查看完整值。</p></section>;
}
