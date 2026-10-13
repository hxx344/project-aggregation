import { Fragment, useId, useMemo, useState } from 'react';
import type { LiveView } from './live-types';
import { amountClass, sideLabel } from './live-display';
import { time } from './display';
import DecimalValue from './DecimalValue';
import { groupAccountHistory, historyDecimal, historyText, historyTime } from './account-history';
import type { HistoryAmount, HistoryRecord } from './account-history';
import './account-history.css';

const EMPTY: HistoryRecord[] = [];
const statementNames: Record<string, string> = { TRANSACTION: '交易变动', TRADING_FEE: '交易手续费', FUNDING_FEE: '资金费', LIQUIDATION_FEE: '强平手续费', TRANSFER_IN: '转入', TRANSFER_OUT: '转出' };
const statementName = (type: string) => statementNames[type] || type;
function Amounts({ values, signed = false }: { values: HistoryAmount[]; signed?: boolean }) {
  return <span className="native-values">{values.map(item => <span key={item.currency} className={signed ? amountClass(item.value) : undefined}><DecimalValue value={item.value} kind="amount" signed={signed}/> <small>{item.currency}</small></span>)}</span>;
}

export default function AccountHistory({ live, kind }: { live: LiveView; kind: 'trades' | 'book' }) {
  const trade = kind === 'trades', records = (trade ? live.recentTrades : live.accountBook) || EMPTY;
  const groups = useMemo(() => groupAccountHistory(records, kind), [records, kind]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const detailId = useId(), historyError = trade ? live.recentTradesError : live.accountBookError;
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return <section className="panel account-history"><div className="section-heading"><div><h2>{trade ? '真实成交' : '资金流水'}</h2><p>按委托聚合 · {records.length} 条原始记录 · 来源时间 {time(trade ? live.recentTradesAsOf : live.accountBookAsOf)}</p></div><span className="count">{groups.length} 组</span></div>
    {historyError && <p className="inline-state warning">{historyError} · 保留上次已知记录</p>}
    {groups.length ? <div className="table-wrap"><table className="responsive-table"><thead>{trade
      ? <tr><th>委托 / 合约</th><th>方向</th><th>成交总量</th><th>成交均价</th><th>手续费合计</th><th>已实现盈亏</th><th>时间 / 明细</th></tr>
      : <tr><th>委托 / 合约</th><th>净变动</th><th>类型明细</th><th>时间 / 明细</th></tr>}</thead><tbody>{groups.slice(0, 150).map((group, index) => {
      const open = expanded.has(group.key), id = `${detailId}-${index}`;
      return <Fragment key={group.key}><tr><td data-label="委托 / 合约"><strong className="order-id">{group.orderId || '无关联委托'}</strong><small>{group.symbol || '—'} · {group.exchange || '—'}</small></td>
        {trade ? <><td data-label="方向">{sideLabel(group.side)}</td><td data-label="成交总量"><DecimalValue value={group.quantity}/></td><td data-label="成交均价"><DecimalValue value={group.price} kind="price"/><small>按成交数量加权</small></td><td data-label="手续费合计"><Amounts values={group.fees}/></td><td data-label="已实现盈亏" className={amountClass(group.realizedPnl)}><DecimalValue value={group.realizedPnl} kind="amount" signed/><small>合约原生值</small></td></>
          : <><td data-label="净变动"><Amounts values={group.changes} signed/></td><td data-label="类型明细">{group.statements.map(item => <div className="history-statement" key={item.type}><span>{statementName(item.type)}</span><Amounts values={item.amounts} signed/></div>)}</td></>}
        <td data-label="时间 / 明细"><small>{time(group.lastAt)}</small>{group.firstAt !== group.lastAt && <small>起于 {time(group.firstAt)}</small>}<button aria-expanded={open} aria-controls={id} onClick={() => toggle(group.key)}>{open ? '收起' : '展开'} {group.rows.length} 笔明细</button></td></tr>
        {open && <tr className="account-history-detail" id={id}><td colSpan={trade ? 7 : 4}><RawHistory rows={group.rows} trade={trade}/></td></tr>}
      </Fragment>;
    })}</tbody></table></div> : <div className="empty">{historyError ? '暂时无法读取记录。' : '尚无可显示的交易所记录。'}</div>}
    <p className="footnote">最多显示 150 组，汇总当前已加载的近期记录，可能未覆盖委托全部成交。金额按原币种分别合计；缺失值显示「—」。资金费结算、划转及无委托编号的流水独立显示。</p>
  </section>;
}

function RawHistory({ rows, trade }: { rows: HistoryRecord[]; trade: boolean }) {
  return <div className="table-wrap"><table className="responsive-table" aria-label={trade ? '逐笔成交明细' : '逐笔资金明细'}><thead>{trade
    ? <tr><th>成交编号 / 时间</th><th>成交数量</th><th>成交价</th><th>手续费</th><th>已实现盈亏</th></tr>
    : <tr><th>流水编号 / 时间</th><th>类型</th><th>变动金额</th><th>业务编号</th></tr>}</thead><tbody>{rows.map((row, index) => <tr key={index}>
      <td data-label={trade ? '成交编号 / 时间' : '流水编号 / 时间'}><span className="order-id">{historyText(row, trade ? 'transaction_id' : 'id') || '—'}</span><small>{time(historyTime(row))}</small></td>
      {trade ? <><td data-label="成交数量"><DecimalValue value={historyDecimal(row, 'qty')}/></td><td data-label="成交价"><DecimalValue value={historyDecimal(row, 'price')} kind="price"/></td><td data-label="手续费"><DecimalValue value={historyDecimal(row, 'fee')} kind="amount"/> {historyText(row, 'fee_coin') || '币种未知'}</td><td data-label="已实现盈亏"><DecimalValue value={historyDecimal(row, 'rpnl')} kind="amount" signed/></td></>
        : <><td data-label="类型">{statementName(historyText(row, 'statement_type'))}</td><td data-label="变动金额" className={amountClass(historyDecimal(row, 'change'))}><DecimalValue value={historyDecimal(row, 'change')} kind="amount" signed/> {historyText(row, 'coin') || historyText(row, 'currency') || '币种未知'}</td><td data-label="业务编号" className="order-id">{historyText(row, 'business_id') || '—'}</td></>}
    </tr>)}</tbody></table></div>;
}
