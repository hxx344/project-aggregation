import { useState } from 'react';
import DecimalValue from './DecimalValue';
import { time, venue } from './display';
import { amountClass } from './live-display';
import { instrumentFees, percentage } from './position-view';
import { DEFAULT_HOLDING_HOURS, HOLDING_HOURS, estimateHoldingScenario, type HoldingScenarioFunding, type HoldingScenarioLeg } from './holding-scenario';
import type { Instrument, LiveView, MarketData } from './live-types';
import type { State } from './types';
import './holding-scenario.css';

export default function HoldingScenarioPanel({ long, short, longData, shortData, quantity, funding, monitorStale, live, slippageBps, fx, now }: {
  long: Instrument; short: Instrument; longData: MarketData | null; shortData: MarketData | null; quantity: string;
  funding: HoldingScenarioFunding | null; monitorStale: boolean;
  live: LiveView; slippageBps: number | undefined; fx: State['fx'] | undefined; now: number;
}) {
  const [hours, setHours] = useState<number>(DEFAULT_HOLDING_HOURS);
  const scenario = estimateHoldingScenario({ quantity, holdingHours: hours, now, monitorStale, fx, slippageBps,
    fundingExpiresAt: funding?.expiresAt ?? null, fundingStatus: funding, feesAsOf: live.feesAsOf ?? null, feesError: live.feesError ?? null,
    long: { exchange: long.exchange, symbol: long.symbol, quoteCurrency: long.quoteCurrency, settlementCurrency: long.settlementCurrency,
      price: longData?.ticker?.askPrice, priceAt: longData?.asOf, priceLive: longData?.status === 'live',
      funding: funding?.long ?? null, takerRate: instrumentFees(live.fees, long.symbol).taker },
    short: { exchange: short.exchange, symbol: short.symbol, quoteCurrency: short.quoteCurrency, settlementCurrency: short.settlementCurrency,
      price: shortData?.ticker?.bidPrice, priceAt: shortData?.asOf, priceLive: shortData?.status === 'live',
      funding: funding?.short ?? null, takerRate: instrumentFees(live.fees, short.symbol).taker } });
  const { totals } = scenario, unit = totals.currency + (totals.converted ? '（折算）' : '');
  return <section className="holding-scenario" aria-label="持有期资金费与往返成本情景">
    <div className="holding-heading"><h3>持有期情景 <small>按本次数量 · 两腿各自名义额</small></h3><span className="tag">假设结果</span></div>
    <div className="holding-controls">
      <label>预计持有<select aria-label="预计持有时长" value={hours} onChange={event => setHours(Number(event.target.value))}>{HOLDING_HOURS.map(value => <option key={value} value={value}>{value} 小时</option>)}</select></label>
      <div className="holding-net"><span>情景净额</span><strong className={scenario.complete ? amountClass(totals.net) : 'muted'}><DecimalValue value={totals.net} kind="amount" signed/> <small>{unit}</small></strong><small>{scenario.complete ? '资金费净额 − 往返手续费 − 滑点预算 · 非锁定利润' : '数据不完整，未生成净额'}</small></div>
    </div>
    <dl className="holding-breakdown">
      <div><dt>资金费收入</dt><dd><DecimalValue value={totals.fundingIncome} kind="amount" signed/> <small>{unit}</small></dd></div>
      <div><dt>资金费支出</dt><dd><DecimalValue value={totals.fundingExpense} kind="amount" signed/> <small>{unit}</small></dd></div>
      <div><dt>资金费净额</dt><dd className={amountClass(totals.fundingNet)}><DecimalValue value={totals.fundingNet} kind="amount" signed/> <small>{unit}</small></dd></div>
      <div><dt>往返手续费</dt><dd><DecimalValue value={totals.fee} kind="amount"/> <small>{unit}</small></dd></div>
      <div><dt>滑点预算</dt><dd><DecimalValue value={totals.slippage} kind="amount"/> <small>{unit}</small></dd></div>
    </dl>
    <div className="holding-legs">
      <ScenarioLeg label="做多腿" exchange={long.exchange} leg={scenario.long}/>
      <ScenarioLeg label="做空腿" exchange={short.exchange} leg={scenario.short}/>
    </div>
    {scenario.reasons.length ? <ul className="holding-reasons" role="status">{scenario.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    {scenario.notices.length ? <ul className="holding-reasons" role="status" aria-label="开仓策略提示">{scenario.notices.map(notice => <li key={notice}>开仓策略提示（不影响情景估算）：{notice}</li>)}</ul> : null}
    <details className="holding-assumptions"><summary>估算口径与假设</summary>{scenario.assumptions.map(text => <p key={text}>{text}</p>)}<p>滑点预算取设置中的价格偏离上限 {Number.isFinite(slippageBps) ? `${slippageBps} bp` : '—'}；仅为只读估算，不改变预览、确认或下单校验。</p></details>
  </section>;
}

function ScenarioLeg({ label, exchange, leg }: { label: string; exchange: string; leg: HoldingScenarioLeg }) {
  return <div className="holding-leg">
    <strong>{label} · {venue(exchange)}</strong>
    <span>名义额 <DecimalValue value={leg.notional} kind="amount"/> {leg.currency}</span>
    <span>费率 {leg.rate === null ? '—' : percentage(String(leg.rate))} / {leg.intervalHours ?? '—'}h · 预计结算 {leg.settlements ?? '—'} 次</span>
    <span>资金费 <b className={amountClass(leg.funding)}><DecimalValue value={leg.funding} kind="amount" signed/></b> · 手续费 <DecimalValue value={leg.fee} kind="amount"/> · 滑点 <DecimalValue value={leg.slippage} kind="amount"/> {leg.currency}</span>
    <small>下次 {time(leg.nextFundingAt)}{leg.lastFundingAt ? ` · 末次 ${time(leg.lastFundingAt)}` : ''}</small>
  </div>;
}
