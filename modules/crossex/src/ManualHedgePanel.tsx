// Manual A/B arrangement inspired by your-quantguy/gate-crossex at 423356d89e5c8f41d9d9033f4db1f40299774ec0.
import { useEffect, useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import { ArrowLeftRight, Radio, Search } from 'lucide-react';
import type { Instrument, LiveView, MarketData, PreviewInput } from './live-types';
import type { Opportunity } from './types';
import { useMarket } from './live-market';
import { nativeSpread } from './TradingTerminal';
import { amountClass, positiveQuantity, liveStatus } from './live-display';
import DecimalValue from './DecimalValue';
import BaseCurrencyPicker from './BaseCurrencyPicker';
import HedgeLegSelector from './HedgeLegSelector';
import { availableBase } from './base-currency';
import { decimalField, percentage } from './position-view';
import { opportunityStaleReason } from './freshness';
import { direction, time, venue } from './display';
import OpenCapacityPanel from './OpenCapacityPanel';
import type { CapacityContext } from './use-open-capacity';
import type { OpenCapacityInput } from './open-capacity';
import FundingOpportunitiesTable from './FundingOpportunitiesTable';
import { fundingPair, fundingStaleReason, type FundingOpportunity } from './funding-opportunities';
import type { HubQuery } from './hub-bridge';
import { importStatusMessage, instrumentBase, resolveOpportunityImport } from './opportunity-import';
const D = Decimal.clone({ precision: 100 });

export default function ManualHedgePanel({ instruments, catalogError, live, budget, active, background, disabled, opportunities, fundingOpportunities, now, initial, monitorStale, preview, capacityContext }: {
  instruments: Instrument[]; catalogError: string; live: LiveView; budget: number; active: boolean; background: boolean; disabled: boolean; opportunities: Opportunity[]; fundingOpportunities: FundingOpportunity[]; now: number;
  initial: HubQuery; monitorStale: boolean; preview: (input: PreviewInput) => Promise<boolean>; capacityContext: CapacityContext;
}) {
  const [base, setBase] = useState(initial.symbol || 'BTC'), [manualLongSymbol, setLongSymbol] = useState(''), [manualShortSymbol, setShortSymbol] = useState('');
  const [quantity, setQuantity] = useState(''), [search, setSearch] = useState(initial.symbol || ''), [prefillNotice, setPrefillNotice] = useState('');
  const [imported, setImported] = useState<HubQuery | null>(() => initial.importId ? initial : null);
  const [manualSelection, setManualSelection] = useState(false);
  const [opportunityKind, setOpportunityKind] = useState<'funding' | 'spread'>(initial.opportunityKind || 'funding');
  const bases = useMemo(() => Array.from(new Set(instruments.map(instrumentBase))).sort(), [instruments]);
  const choices = useMemo(() => instruments.filter(i => instrumentBase(i) === base), [instruments, base]);
  const importedResolution = useMemo(() => imported ? resolveOpportunityImport(imported, instruments) : null, [imported, instruments]);
  const importedPair = importedResolution?.long && importedResolution.short ? { long: importedResolution.long, short: importedResolution.short } : null;
  const importReady = !!importedPair && !catalogError;
  // Keep the leg CrossEx actually lists so only the missing side needs a new choice.
  const keptLong = catalogError ? '' : importedResolution?.long?.symbol || '';
  const keptShort = catalogError ? '' : importedResolution?.short?.symbol || '';
  const longSymbol = imported ? importReady ? importedPair!.long.symbol : keptLong : manualLongSymbol;
  const shortSymbol = imported ? importReady ? importedPair!.short.symbol : keptShort : manualShortSymbol;
  useEffect(() => {
    if (imported) return;
    if (!choices.length) { setLongSymbol(''); setShortSymbol(''); return; }
    if (manualSelection) {
      setLongSymbol(current => choices.some(i => i.symbol === current) ? current : '');
      setShortSymbol(current => choices.some(i => i.symbol === current) ? current : '');
      return;
    }
    const first = choices.find(i => i.exchange === initial.longExchange) || choices[0];
    setLongSymbol(current => choices.some(i => i.symbol === current) ? current : first.symbol);
    setShortSymbol(current => choices.some(i => i.symbol === current) ? current : (choices.find(i => i.exchange === initial.shortExchange && i.exchange !== first.exchange) || choices.find(i => i.exchange !== first.exchange) || choices[0]).symbol);
  }, [choices, imported, initial.longExchange, initial.shortExchange, manualSelection]);
  useEffect(() => {
    if (imported || !bases.length) return;
    const next = availableBase(base, bases);
    if (next !== base) { setBase(next); setQuantity(''); }
  }, [bases, base, imported]);
  useEffect(() => { if (imported && !importReady) setQuantity(''); }, [imported, importReady]);
  const long = instruments.find(i => i.symbol === longSymbol), short = instruments.find(i => i.symbol === shortSymbol);
  const a = useMarket(longSymbol, '5m', active, background), b = useMarket(shortSymbol, '5m', active, background);
  const sameCurrency = !!long && !!short && long.quoteCurrency === short.quoteCurrency;
  const spread = sameCurrency ? nativeSpread(a.data?.ticker?.askPrice, b.data?.ticker?.bidPrice) : null;
  const ready = !!long && !!short && instrumentBase(long) === base && instrumentBase(short) === base && long.exchange !== short.exchange && positiveQuantity(quantity) && a.data?.status === 'live' && b.data?.status === 'live' && a.data?.tradingAvailable !== false && b.data?.tradingAvailable !== false;
  const notional = (price: string | null | undefined) => price && positiveQuantity(price) && positiveQuantity(quantity) ? new D(price).mul(quantity).toFixed() : null;
  const filtered = opportunities.filter(row => row.base.includes(search.trim().toUpperCase())).slice(0, 60);
  const fundingRows = fundingOpportunities.filter(row => row.base.includes(search.trim().toUpperCase())).slice(0, 60);
  const capacityInput: OpenCapacityInput | null = long && short && instrumentBase(long) === base && instrumentBase(short) === base && long.exchange !== short.exchange && (!quantity || positiveQuantity(quantity))
    ? { pair: { longSymbol, shortSymbol, ...(quantity ? { quantity } : {}) } } : null;
  const importNotice = imported ? !importReady
    ? importStatusMessage(imported, importedResolution, instruments, catalogError, venue)
    : `已导入${imported.opportunityKind === 'funding' ? '资金费' : '价差'}机会的精确多空合约。请填写数量，以最新盘口预览。` : prefillNotice;
  const chooseLegs = (nextLong: string, nextShort: string) => {
    setManualSelection(true); setImported(null); setLongSymbol(nextLong); setShortSymbol(nextShort); setQuantity(''); setPrefillNotice('');
  };
  const fillImported = (query: HubQuery) => {
    setImported(query); setBase(query.symbol || ''); setQuantity(''); setPrefillNotice('');
    document.querySelector('.hedge-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const spreadQuery = (row: Opportunity): HubQuery => {
    const contract = (leg: Opportunity['long'] & { crossexSymbol?: string }) => leg.crossexSymbol || (leg.symbol.includes('_FUTURE_') ? leg.symbol : '');
    return { symbol: instrumentBase({ exchange: row.long.exchange, base: row.base }), longExchange: row.long.exchange, shortExchange: row.short.exchange,
      longContract: contract(row.long), shortContract: contract(row.short), opportunityKind: 'spread', importId: 'internal-spread' };
  };
  const prefill = (row: Opportunity) => fillImported(spreadQuery(row));
  const prefillFunding = (row: FundingOpportunity) => {
    const reason = fundingStaleReason(row, now, monitorStale), pair = fundingPair(row, instruments);
    if (reason || !pair) { setPrefillNotice(reason || '此资金费机会的精确合约尚未进入目录，请等待更新。'); return; }
    fillImported({ symbol: row.base, longExchange: row.long.exchange, shortExchange: row.short.exchange,
      longContract: pair.long.symbol, shortContract: pair.short.symbol, opportunityKind: 'funding', importId: 'internal-funding' });
  };
  return <div className="hedge-view"><div className="view-heading"><div><span className="eyebrow">CROSS-EXCHANGE HEDGE</span><h2>跨所手动对冲</h2><p>选择同一基础币的两个交易所，核对价差与数量后提交。</p></div><div className="asset-picker"><span>基础币</span><BaseCurrencyPicker bases={bases} value={base} onChange={value => { setManualSelection(false); setImported(null); setBase(value); setLongSymbol(''); setShortSymbol(''); setQuantity(''); setPrefillNotice(''); }}/></div></div>
    {(catalogError || a.error || b.error) && <p className="inline-state warning">{catalogError || a.error || b.error}</p>}
    {importNotice && <p className={"inline-state " + (imported && importReady ? 'positive' : 'warning')} role="status">{importNotice}</p>}
    <div className="hedge-layout"><section className="panel hedge-pair"><div className="section-heading"><h2>{base || '—'} · 对冲组合</h2><span className="tag">手动 LIMIT / IOC</span></div><div className="hedge-legs"><VenueLeg label="A" side="buy" title="买入 / 做多" instruments={choices} selected={longSymbol} onChange={symbol => chooseLegs(symbol, shortSymbol)} instrument={long} data={a.data}/><div className="leg-spread"><span>开仓毛价差</span><strong className={amountClass(spread)}><DecimalValue value={spread} kind="rate" signed/> <small>bp</small></strong><small>{sameCurrency ? '空腿买一 / 多腿卖一' : '跨计价币不直接相减'}</small><button className="switch-direction" aria-label="交换多空腿" disabled={!long || !short} onClick={() => chooseLegs(shortSymbol, longSymbol)}><ArrowLeftRight size={17}/></button></div><VenueLeg label="B" side="sell" title="卖出 / 做空" instruments={choices} selected={shortSymbol} onChange={symbol => chooseLegs(longSymbol, symbol)} instrument={short} data={b.data}/></div><div className="hedge-insights"><div><span>多腿参考名义额</span><strong><DecimalValue value={notional(a.data?.ticker?.askPrice)} kind="amount"/> <small>{long?.quoteCurrency}</small></strong></div><div><span>空腿参考名义额</span><strong><DecimalValue value={notional(b.data?.ticker?.bidPrice)} kind="amount"/> <small>{short?.quoteCurrency}</small></strong></div><div><span>数量口径</span><strong>两腿相同基础币数量</strong><small>不同交易所步长以预览校验为准</small></div></div><p className="footnote">盘口使用各自原生计价币。开仓价差未扣交易费与滑点；资金费率保留各所原始周期，不能据此推定收益。</p></section>
      <section className="panel hedge-ticket"><div className="section-heading"><h2>核对手动开仓</h2><span className="tag live-tag">实盘</span></div><form onSubmit={e => { e.preventDefault(); if (ready && !disabled) void preview({ kind: 'open', pair: { longSymbol, shortSymbol, quantity } }); }}><label>每腿数量<div className="input-unit"><input required inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="输入基础币数量"/><span>{base || '—'}</span></div></label><OpenCapacityPanel input={capacityInput} context={capacityContext} base={base} pair/><dl className="ticket-details"><div><dt>多腿数量步长</dt><dd><DecimalValue value={long?.lot_size} full/> {base}</dd></div><div><dt>空腿数量步长</dt><dd><DecimalValue value={short?.lot_size} full/> {base}</dd></div><div><dt>单腿名义额上限</dt><dd><DecimalValue value={String(budget)} kind="amount"/> USDT</dd></div>{live.account?.account_mode === 'CROSS_EXCHANGE' && <div><dt>共享可用保证金 (USDT)</dt><dd><DecimalValue value={decimalField(live.account, 'available_margin')} kind="amount"/></dd></div>}<div><dt>执行方式</dt><dd>两腿限价 · IOC</dd></div><div><dt>方向</dt><dd>{long ? venue(long.exchange) : '—'} 多 / {short ? venue(short.exchange) : '—'} 空</dd></div></dl>{long?.exchange === short?.exchange && long && <p className="warning">请为两腿选择不同交易所。</p>}<button type="submit" className="submit-order buy" disabled={disabled || !ready}>{disabled ? '当前不可开仓' : '预览双腿委托'}</button><p className="ticket-note">上限约束每腿名义额，不是保证金。参考金额未计入保护价格、盘口深度与汇率影响，以预览中的 USDT 校验金额为准。双腿逐腿执行，部分成交需手动处理。</p></form></section>
    </div><section className="panel opportunities-panel"><div className="section-heading"><div><h2><Radio size={15}/>Monitor 机会</h2><div className="opportunity-switch" role="group" aria-label="机会类型"><button aria-pressed={opportunityKind === 'funding'} onClick={() => setOpportunityKind('funding')}>资金费机会</button><button aria-pressed={opportunityKind === 'spread'} onClick={() => setOpportunityKind('spread')}>价差机会</button></div><p>点击填入对冲组合，真实委托仍由上方手动预览与确认。</p></div><div className="filters"><span className={monitorStale ? 'warning' : 'positive'}>{monitorStale ? 'Monitor 行情待更新' : 'Monitor 已同步'}</span><label className="search-field"><Search size={13}/><input aria-label="搜索 Monitor 机会" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索币种"/></label></div></div>{opportunityKind === 'funding' ? <FundingOpportunitiesTable rows={fundingRows} instruments={instruments} now={now} monitorStale={monitorStale} onSelect={prefillFunding}/> : <>{filtered.length ? <div className="table-wrap"><table className="responsive-table opportunity-table"><thead><tr><th>币种 / 方向</th><th>多腿卖一 / 空腿买一</th><th>毛价差</th><th>预算净价差</th><th>行情检查</th><th>操作</th></tr></thead><tbody>{filtered.map(row => { const stale = opportunityStaleReason(row, now), resolution = resolveOpportunityImport(spreadQuery(row), instruments), missingImport = instruments.length > 0 && !(resolution?.long && resolution?.short); return <tr key={row.pairKey}><td data-label="币种 / 方向"><strong>{row.base}</strong><small>{direction(row)}</small></td><td data-label="盘口参考"><DecimalValue value={row.long.ask == null ? null : String(row.long.ask)} kind="price"/> {row.long.quoteCurrency}<small><DecimalValue value={row.short.bid == null ? null : String(row.short.bid)} kind="price"/> {row.short.quoteCurrency}</small></td><td data-label="毛价差"><DecimalValue value={row.grossBps == null ? null : String(row.grossBps)} kind="rate"/> bp</td><td data-label="预算净价差"><DecimalValue value={row.netBps == null ? null : String(row.netBps)} kind="rate"/> bp</td><td data-label="行情检查"><span className={row.eligible && !stale ? 'positive' : 'warning'}>{stale || (row.eligible ? '可参考' : row.reason)}</span>{missingImport && <small className="warning">CrossEx 未上架该组合的精确合约</small>}</td><td data-label="操作"><button onClick={() => prefill(row)} disabled={!instruments.length || missingImport} title={missingImport ? 'CrossEx 目录缺少该组合的精确合约；请改用受支持的交易所或等待上架' : undefined}>填入对冲组合</button></td></tr>; })}</tbody></table></div> : <div className="empty compact">暂无匹配的 Monitor 机会，可直接在上方选择合约。</div>}<p className="footnote">Monitor 价差折算为 USDT，预算净价差包含费率与滑点预算。当前最多显示 60 项。</p></>}</section>
  </div>;
}

function VenueLeg({ label, side, title, instruments, selected, onChange, instrument, data }: { label: string; side: string; title: string; instruments: Instrument[]; selected: string; onChange: (symbol: string) => void; instrument?: Instrument; data: MarketData | null }) {
  return <article className={'venue-leg ' + side}><div className="leg-top"><span className="leg-letter">{label}</span><strong>{title}</strong><span className={'side-badge ' + (side === 'buy' ? 'long' : 'short')}>{side === 'buy' ? 'LONG' : 'SHORT'}</span></div><HedgeLegSelector instruments={instruments} value={selected} onChange={onChange} label={`${label} 腿`}/><div className="leg-quote"><span>{side === 'buy' ? '卖一价格' : '买一价格'}</span><strong><DecimalValue value={side === 'buy' ? data?.ticker?.askPrice : data?.ticker?.bidPrice} kind="price"/></strong><small>{instrument?.quoteCurrency || '—'}</small></div><dl className="leg-market-details"><div><dt>标记价格</dt><dd><DecimalValue value={data?.ticker?.markPrice} kind="price"/></dd></div><div><dt>资金费率</dt><dd>{percentage(data?.ticker?.fundingRate)}</dd></div><div><dt>下次结算</dt><dd>{time(data?.ticker?.nextFundingAt)}</dd></div><div><dt>行情状态</dt><dd className={data?.status === 'live' ? 'positive' : 'warning'}>{liveStatus(data?.status || 'connecting')}</dd></div><div><dt>来源时间</dt><dd>{time(data?.asOf)}</dd></div></dl>{(data?.error || data?.tradingReason) && <p className="inline-state warning">{data.error || data.tradingReason}</p>}</article>;
}
