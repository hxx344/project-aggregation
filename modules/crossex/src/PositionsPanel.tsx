// Layout informed by your-quantguy/gate-crossex at 423356d89e5c8f41d9d9033f4db1f40299774ec0.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search, Layers3 } from 'lucide-react';
import type { CloseLeg, Instrument, LivePosition, LiveView, PositionFundingRate } from './live-types';
import { amountClass, liquidationPrice, positiveQuantity, sideLabel } from './live-display';
import DecimalValue from './DecimalValue';
import AdlIndicator from './AdlIndicator';
import { fractionQuantity, groupPositions, percentage } from './position-view';
import type { CurrencyAmount } from './position-view';
import type { FundingOpportunity } from './funding-opportunities';
import { PositionMetricsSummary, PositionMetricsDetails } from './PositionMetrics';
import { positionHistorySamples, updatePositionHistory } from './position-history';
import type { PositionHistoryState } from './position-history';
import { time, venue } from './display';
import PositionActionDialog from './PositionActionDialog';
import type { PositionActionProps, PositionActionSelection } from './PositionActionDialog';
import { legQuantityDiff } from './position-actions';

const COLUMNS = 11;
type GroupFilter = 'all' | 'hedge' | 'single';
const filterLabels: [GroupFilter, string][] = [['all', '全部'], ['hedge', '对冲组'], ['single', '单腿']];
const sideMark = (side: string) => side.toUpperCase() === 'LONG' ? '多' : side.toUpperCase() === 'SHORT' ? '空' : null;

export default function PositionsPanel({ live, instruments, disabled, close, now, fundingOpportunities, positionFundingRates, marketStale, ...actionProps }: PositionActionProps & {
  live: LiveView; instruments: Instrument[]; disabled: boolean; close: (positions: CloseLeg[]) => Promise<boolean>;
  now: number; positionFundingRates?: PositionFundingRate[]; fundingOpportunities: FundingOpportunity[]; marketStale: boolean;
}) {
  const [search, setSearch] = useState(''), [expanded, setExpanded] = useState<Set<string>>(new Set()), [filter, setFilter] = useState<GroupFilter>('all');
  const [closing, setClosing] = useState<LivePosition[] | null>(null), [page, setPage] = useState(0);
  const [action, setAction] = useState<PositionActionSelection | null>(null);
  const stale = live.stale || !live.connection.connected || !live.asOf || now - live.asOf > 15_000 || live.asOf > now + 1000;
  const scope = JSON.stringify([live.connection.accountId, live.connection.version]);
  useEffect(() => { setClosing(null); }, [scope]);
  const allGroups = useMemo(() => groupPositions(live.positions, { now, fundingOpportunities, positionFundingRates, marketStale, stale, partial: live.partial }), [live.positions, now, fundingOpportunities, positionFundingRates, marketStale, stale, live.partial]);
  const filterCounts = { all: allGroups.length, hedge: allGroups.filter(group => group.legs.length > 1).length, single: allGroups.filter(group => group.legs.length === 1).length };
  const groups = useMemo(() => allGroups.filter(group => (filter === 'all' || (filter === 'hedge') === (group.legs.length > 1))
    && `${group.base} ${group.legs.map(p => p.exchange + ' ' + p.symbol).join(' ')}`.toUpperCase().includes(search.trim().toUpperCase())), [allGroups, search, filter]);
  const [history, setHistory] = useState<PositionHistoryState | null>(null);
  useEffect(() => {
    setHistory(previous => updatePositionHistory(previous, allGroups, { scope, at: live.asOf, now, stale, partial: live.partial }));
  }, [allGroups, scope, live.asOf, now, stale, live.partial]);
  const pages = Math.max(1, Math.ceil(groups.length / 20)), shownPage = Math.min(page, pages - 1), shown = groups.slice(shownPage * 20, (shownPage + 1) * 20);
  const toggle = (base: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(base)) next.delete(base); else next.add(base); return next; });
  const actionDisabled = disabled || stale || live.partial || !!closing || !!action;
  const legFunding = (p: LivePosition) => positionFundingRates?.find(rate => rate.exchange === p.exchange && rate.symbol === p.symbol && rate.expiresAt > now) || null;
  return <section className="panel positions-panel">
    <div className="section-heading panel-h"><h2>持仓</h2><div className="seg" role="group" aria-label="持仓类型">{filterLabels.map(([id, label]) => <button key={id} className={filter === id ? 'on' : ''} aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(0); }}>{label}<span className="count">{filterCounts[id]}</span></button>)}</div>
      <label className="search-field"><Search size={14}/><input aria-label="搜索持仓币种或交易所" placeholder="搜索币种 / 交易所" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/></label></div>
    {live.partial && <p className="inline-state warning">持仓数据不完整，保留已知仓位；汇总可能不完整，暂不可交易。</p>}
    {shown.length ? <div className="table-wrap positions-wrap"><table className="positions-table"><thead><tr><th>合约</th><th>交易所</th><th>方向</th><th className="r">数量</th><th className="r">名义价值</th><th className="r">开仓价</th><th className="r">标记价</th><th className="r">强平价</th><th className="r">未实现盈亏</th><th className="r">资金费率</th><th className="r">操作</th></tr></thead>
      {shown.map(group => { const open = expanded.has(group.base), single = group.legs.length === 1; return <tbody className={'position-group ' + (open ? 'expanded' : '')} key={group.base}>
        <tr className="group-row">
          <td colSpan={3} className="group-cell-identity"><div className="group-title"><button className="group-identity" onClick={() => toggle(group.base)} aria-expanded={open} aria-label={`${open ? '收起' : '展开'} ${group.base} 持仓`}>
            {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<span className="coin-icon">{group.base.slice(0, 1)}</span><span><strong>{group.base}<em>{group.legs.length} 腿</em></strong><small>{Array.from(new Set(group.legs.map(p => venue(p.exchange)))).join(' / ')}</small></span>
          </button><span className={'group-kind ' + (single ? 'single' : '')}>{single ? '单腿 · 未对冲' : '对冲组'}</span></div></td>
          <td data-label="净数量" className={'r ' + amountClass(group.net)} title="同基础币净数量"><small className="cell-label">净</small><DecimalValue value={group.net} signed/> <small>{group.base}</small></td>
          <td data-label="总名义额" className="r" title="总名义额"><NativeValues values={group.notional}/></td>
          <td data-label="加权开仓价" className="r" title="加权开仓价"><DecimalValue value={group.entry?.value} kind="price"/>{group.entry?.currency && <small> {group.entry.currency}</small>}</td>
          <td data-label="加权标记价" className="r" title="加权标记价"><DecimalValue value={group.mark?.value} kind="price"/>{group.mark?.currency && <small> {group.mark.currency}</small>}</td>
          <td data-label="强平价" className="r muted" aria-hidden="true"></td>
          <td data-label="未实现盈亏" className="r" title="未实现盈亏合计"><NativeValues values={group.pnl} signed/></td>
          <td data-label="已实现 / 资金费" className="r" title="已实现 / 资金费"><span className="group-split"><small className="cell-label">已实现</small><NativeValues values={group.realized} signed/></span><span className="group-split"><small className="cell-label">资金费</small><NativeValues values={group.funding} signed subtle/></span></td>
          <td data-label="操作" className="r"><div className="group-actions"><button className="danger-quiet" disabled={disabled || !!action || group.legs.length > 16} onClick={() => setClosing(group.legs)}>平仓组合</button><button className="primary-quiet" aria-label={`${group.base} 加仓`} title={!group.metrics.applicable ? '加仓需要严格等量且有效的双腿组合' : actionProps.entryPaused ? '新开仓已暂停' : actionProps.catalogError || '双腿等量加仓'} disabled={actionDisabled || actionProps.entryPaused || !!actionProps.catalogError || !group.metrics.applicable || !legQuantityDiff(group.legs).equal} onClick={() => setAction({ action: 'add', group, connectionVersion: live.connection.version, accountId: live.connection.accountId })}>加仓</button><button className="secondary-quiet" aria-label={`${group.base} 平衡双腿`} title={legQuantityDiff(group.legs).problem || '数量差异超过双腿均值的 0.1% 时可平衡'} disabled={actionDisabled || !legQuantityDiff(group.legs).needsBalance} onClick={() => setAction({ action: 'balance', group, connectionVersion: live.connection.version, accountId: live.connection.accountId })}>平衡双腿</button>{group.legs.length > 16 && <small>每次最多 16 腿，请逐腿操作</small>}</div></td>
        </tr>
        <tr className="group-summary-row"><td colSpan={COLUMNS}><PositionMetricsSummary group={group} stale={stale || live.partial}/></td></tr>
        {group.legs.map(p => { const rate = legFunding(p), mark = sideMark(p.side), liquidation = liquidationPrice(p.liquidationPrice); return <tr className="position-leg" key={p.id}>
          <td data-label="合约"><strong className="leg-symbol">{p.symbol}</strong><span className={'ml ' + (single ? 'warning' : '')}>{single ? '单腿 · 未对冲' : `${group.base} 对冲组`}</span></td>
          <td data-label="交易所">{venue(p.exchange)}<span className="ml"><DecimalValue value={p.leverage} kind="rate"/>×</span></td>
          <td data-label="方向">{mark && <span className={'side-badge mark ' + p.side.toLowerCase()} aria-hidden="true">{mark}</span>}{mark ? sideLabel(p.side) : <span className={'side-badge ' + p.side.toLowerCase()}>{sideLabel(p.side)}</span>}</td>
          <td data-label="数量" className="r"><DecimalValue value={p.baseQuantity}/> <small>{p.baseCurrency}</small></td>
          <td data-label="名义价值" className="r"><DecimalValue value={p.notional ?? p.positionValue} kind="amount"/> <small>{p.quoteCurrency}</small></td>
          <td data-label="开仓价" className="r"><DecimalValue value={p.entryPrice} kind="price"/></td>
          <td data-label="标记价" className="r"><DecimalValue value={p.markPrice} kind="price"/></td>
          <td data-label="强平价" className="r">{liquidation ? <DecimalValue value={p.liquidationPrice} kind="price"/> : <span className="muted" title="未提供或不适用">—</span>}</td>
          <td data-label="未实现盈亏" className={'r ' + amountClass(p.unrealizedPnl)}><DecimalValue value={p.unrealizedPnl} kind="amount" signed/> <small>{p.pnlCurrency}</small></td>
          <td data-label="资金费率" className={'r ' + (rate ? amountClass(String(rate.rate)) : 'muted')}>{rate ? <span title={`每 ${rate.intervalHours} 小时结算`}>{percentage(String(rate.rate))}<small> /{rate.intervalHours}h</small></span> : '—'}</td>
          <td data-label="操作" className="r"><button className="danger-quiet" disabled={disabled} onClick={() => setClosing([p])}>平此腿</button></td>
        </tr>; })}
        {open && <tr className="group-detail-row"><td colSpan={COLUMNS}>
          <PositionMetricsDetails group={group} now={now} samples={positionHistorySamples(history, group, scope)} stale={stale || live.partial}/>
          <div className="position-leg-list">{group.legs.map(p => <section className="leg-detail" key={p.id} aria-label={`${venue(p.exchange)} ${p.symbol} 明细`}><div className="leg-identity"><span className={'side-badge ' + p.side.toLowerCase()}>{sideLabel(p.side)}</span><strong>{venue(p.exchange)}</strong><span>{p.symbol}</span><span className="muted"><DecimalValue value={p.leverage} kind="rate"/>×</span></div>
            <dl className="leg-values"><div><dt>开仓均价 / 标记价</dt><dd><DecimalValue value={p.entryPrice} kind="price"/> / <DecimalValue value={p.markPrice} kind="price"/> <small>{p.quoteCurrency}</small></dd></div><div><dt>初始 / 维持保证金</dt><dd><DecimalValue value={p.margin} kind="amount"/> / <DecimalValue value={p.maintenanceMargin} kind="amount"/> <small>{p.marginCurrency}</small></dd></div><div><dt>强平价</dt><dd>{liquidationPrice(p.liquidationPrice) ? <DecimalValue value={p.liquidationPrice} kind="price"/> : '未提供或不适用'} <small>{liquidationPrice(p.liquidationPrice) ? p.quoteCurrency : ''}</small></dd></div><div><dt>已实现 / 资金费 / 交易费</dt><dd><DecimalValue value={p.realizedPnl} kind="amount"/> / <DecimalValue value={p.fundingFee} kind="amount"/> / <DecimalValue value={p.fee} kind="amount"/> <small>{p.pnlCurrency}</small></dd></div><div><dt>方向来源</dt><dd>{p.directionSource === 'quantity_sign' ? '方向由数量符号推导' : p.directionSource === 'position_side' ? '交易所持仓方向' : '交易所返回值'}</dd></div><div><dt>ADL 减仓优先级</dt><dd><AdlIndicator exchange={p.exchange} internalRank={p.crossExAdlRank} exchangeRank={p.exchangeAdlRank} stale={live.stale || !!live.adlError || !live.connection.connected} asOf={live.adlAsOf}/></dd></div><div><dt>最大杠杆 / 风险限额</dt><dd><DecimalValue value={p.maxLeverage} kind="rate"/>× / <DecimalValue value={p.riskLimit} kind="amount"/></dd></div><div><dt>来源时间</dt><dd>{time(p.updatedAt)}</dd></div></dl>
          </section>)}</div>
        </td></tr>}
      </tbody>; })}</table></div> : <div className="empty"><Layers3 size={28}/><h3>{search || filter !== 'all' ? '没有匹配的持仓' : !live.connection.configured ? '连接账户后查看持仓组合' : live.stale || live.partial ? '持仓数据尚未完整读取' : '当前没有持仓'}</h3><p>同币种仓位按交易所分组，已有仓位会在账户同步后显示。</p></div>}
    <div className="table-footer"><span>{live.positions.length} 条真实持仓腿 · 点击币种展开价差、资金费与单腿风险。名义价值、盈亏按原币种显示；强平价为交易所返回值，资金费率为交易所原始费率（标注结算周期）。同基础币汇总净数量；金额按原币种汇总，缺失值显示「—」。</span><div><button disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>上一页</button><span>{shownPage + 1} / {pages}</span><button disabled={shownPage + 1 >= pages} onClick={() => setPage(shownPage + 1)}>下一页</button></div></div>
    {closing && <ClosePositionDialog key={closing.map(p => p.id).join(':')} positions={closing} instruments={instruments} disabled={disabled} dismiss={() => setClosing(null)} preview={async legs => { if (await close(legs)) setClosing(null); }}/>}
    {action && <PositionActionDialog selection={action} live={live} instruments={instruments} disabled={disabled || stale || live.partial} {...actionProps} dismiss={() => setAction(null)}/>}
  </section>;
}
function NativeValues({ values, signed = false, subtle = false }: { values: CurrencyAmount[]; signed?: boolean; subtle?: boolean }) {
  return <span className={'native-values ' + (subtle ? 'subtle' : '')}>{values.map(item => <span key={item.currency} className={signed ? amountClass(item.value) : undefined}><DecimalValue value={item.value} kind="amount" signed={signed}/> <small>{item.currency}</small></span>)}</span>;
}

function ClosePositionDialog({ positions, instruments, disabled, dismiss, preview }: {
  positions: LivePosition[]; instruments: Instrument[]; disabled: boolean; dismiss: () => void; preview: (legs: CloseLeg[]) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState(new Set(positions.map(p => p.id)));
  const [percent, setPercent] = useState(100), [custom, setCustom] = useState<Record<string, string>>({}), [directions, setDirections] = useState<Record<string, 'LONG' | 'SHORT'>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const legs = positions.map(position => {
    const instrument = instruments.find(i => i.symbol === position.symbol), full = percent === 100 && custom[position.id] == null;
    const quantity = custom[position.id] ?? fractionQuantity(position.baseQuantity, percent, instrument?.lot_size);
    const known = ['LONG', 'SHORT'].includes(position.side.toUpperCase()), positionSide = known ? undefined : directions[position.id];
    return { position, quantity, full, positionSide, valid: !!quantity && positiveQuantity(quantity) && (known || !!positionSide) };
  }).filter(leg => selected.has(leg.position.id));
  const ready = legs.length > 0 && legs.length <= 16 && legs.every(leg => leg.valid);
  return <dialog ref={dialog} className="trade-dialog close-dialog" aria-labelledby="close-title" onCancel={e => { e.preventDefault(); if (!busy) dismiss(); }}><div className="dialog-heading"><div><span className="eyebrow">REDUCE ONLY</span><h2 id="close-title">{positions[0]?.baseCurrency} · 选择平仓持仓腿</h2></div><button disabled={busy} aria-label="关闭平仓选择" onClick={dismiss}>×</button></div><div className="dialog-content">
    <p className="muted">一次预览选中的持仓腿，核对后逐腿发送只减仓委托。</p><div className="percentage-controls">{[25, 50, 75, 100].map(value => <button key={value} className={percent === value && !Object.keys(custom).length ? 'active' : ''} disabled={busy} onClick={() => { setPercent(value); setCustom({}); }}>{value === 100 ? '全部' : value + '%'}</button>)}</div>
    <div className="close-leg-list">{positions.map(p => { const leg = legs.find(item => item.position.id === p.id); const displayed = custom[p.id] ?? fractionQuantity(p.baseQuantity, percent, instruments.find(i => i.symbol === p.symbol)?.lot_size) ?? ''; return <section key={p.id}><label className="check"><input type="checkbox" checked={selected.has(p.id)} disabled={busy} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })}/><strong>{venue(p.exchange)} · {sideLabel(p.side)}</strong><span>{p.symbol}</span></label><div className="close-leg-input"><span>当前 <DecimalValue value={p.baseQuantity}/> {p.baseCurrency}</span><label>平仓数量<input inputMode="decimal" aria-label={`${p.symbol} 平仓数量`} value={displayed} disabled={busy || !selected.has(p.id)} placeholder={percent < 100 ? '等待数量步长，或输入数量' : '基础币数量'} onChange={e => setCustom(previous => ({ ...previous, [p.id]: e.target.value }))}/></label><span>{p.baseCurrency}</span></div>{!['LONG', 'SHORT'].includes(p.side.toUpperCase()) && <label className="direction-selection">交易所方向未知，请明确减少方向<select value={directions[p.id] || ''} disabled={busy || !selected.has(p.id)} onChange={e => setDirections(previous => ({ ...previous, [p.id]: e.target.value as 'LONG' | 'SHORT' }))}><option value="">选择方向</option><option value="LONG">减少多仓（卖出）</option><option value="SHORT">减少空仓（买入）</option></select></label>}{leg && !leg.valid && <p className="warning">请填写有效数量并核对持仓方向；百分比数量向下对齐交易所步长。</p>}</section>; })}</div>
    <p className="footnote">双腿成交数量可能不同；剩余持仓和净敞口将在账户同步后更新。</p></div><div className="dialog-actions"><button disabled={busy} onClick={dismiss}>返回</button><button className="primary" disabled={disabled || busy || !ready} onClick={async () => { setBusy(true); try { await preview(legs.map(leg => ({ positionId: leg.position.id, ...(!leg.full ? { quantity: leg.quantity! } : {}), ...(leg.positionSide ? { positionSide: leg.positionSide } : {}) }))); } finally { setBusy(false); } }}>{busy ? '正在预览…' : `预览 ${legs.length} 条平仓腿`}</button></div></dialog>;
}
