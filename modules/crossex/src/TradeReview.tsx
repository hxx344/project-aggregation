import { useEffect, useRef, useState } from 'react';
import type { LiveOrder, LivePreview } from './live-types';
import { exact, sideLabel } from './live-display';
import { time, venue } from './display';
import { percentage } from './position-view';
import DecimalValue from './DecimalValue';

export function TradeReview({ preview, now, busy, disabled, close, confirm }: {
  preview: LivePreview; now: number; busy: boolean; disabled: boolean; close: () => void; confirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const expired = now >= preview.expiresAt;
  return <dialog ref={dialog} className="trade-dialog" aria-labelledby="trade-review-title" onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-heading"><div><span className="tag live-tag">真实交易</span><h2 id="trade-review-title">核对{preview.kind === 'open' ? '开仓' : '平仓'}委托</h2></div><button disabled={busy} onClick={close} aria-label="关闭订单核对">×</button></div>
    <div className="dialog-content"><dl className="review-account"><div><dt>Gate 账户</dt><dd>{preview.accountUid || '—'}</dd></div><div><dt>连接版本</dt><dd>{preview.connectionVersion}</dd></div><div><dt>预览有效期</dt><dd className={expired ? 'warning' : ''}>{expired ? '已到期，请关闭并重新预览' : time(preview.expiresAt)}</dd></div></dl>
      <div className="review-legs">{preview.legs.map((leg, index) => <section key={index} className="review-leg"><h3>{venue(leg.exchange)} · {leg.symbol}</h3><dl><div><dt>交易方向</dt><dd>{sideLabel(leg.side)} / {sideLabel(leg.positionSide)}</dd></div><div><dt>委托数量</dt><dd><DecimalValue value={leg.quantity} full/> {leg.baseCurrency || leg.base || ''}</dd></div><div><dt>{leg.orderType === 'MARKET' ? '市价参考' : '限价'}</dt><dd><DecimalValue value={leg.orderType === 'MARKET' ? leg.referencePrice || leg.price : leg.price} kind="price" full={leg.orderType !== 'MARKET'}/> {leg.quoteCurrency || ''}</dd></div>{preview.kind === 'open' && <><div><dt>校验名义额 / 单腿上限</dt><dd><DecimalValue value={leg.notionalUSDT} kind="amount"/> / <DecimalValue value={leg.singleLegBudgetUSDT} kind="amount"/> USDT</dd></div><div><dt>校验价格 × 汇率</dt><dd><DecimalValue value={leg.budgetPrice} kind="price"/> × <DecimalValue value={leg.budgetFxRate} kind="price"/></dd></div></>}<div><dt>订单方式</dt><dd>{leg.orderType} · {leg.timeInForce}</dd></div><div><dt>只减仓</dt><dd>{leg.reduceOnly ? '是' : '否'}</dd></div></dl></section>)}</div>
      {preview.risk && <section className="review-risk"><h3>保证金与风险检查</h3><dl className="ticket-details"><div><dt>预计占用保证金</dt><dd><DecimalValue value={preview.risk.requiredMargin} kind="amount"/> {preview.risk.marginCurrency}</dd></div><div><dt>账户可用保证金</dt><dd><DecimalValue value={preview.risk.availableMargin} kind="amount"/> {preview.risk.marginCurrency}</dd></div><div><dt>保证金预留系数</dt><dd>{exact(preview.risk.reserveFactor)}×</dd></div></dl>{preview.risk.legs.map(leg => <div className="risk-leg" key={leg.symbol}><strong>{leg.symbol}</strong><dl className="ticket-details"><div><dt>当前杠杆</dt><dd>{exact(leg.leverage)}×</dd></div><div><dt>成交后名义额 / 风险上限</dt><dd><DecimalValue value={leg.projectedNotional} kind="amount"/> / <DecimalValue value={leg.maxPositionNotional} kind="amount"/> {leg.quoteCurrency}</dd></div></dl></div>)}<p>校验名义额按数量 × 较高的委托价或盘口估值 × 结算币汇率计算。确认时会更新估值，重新检查单腿预算、总额度、保证金和风险档位；委托数量与限价不变。</p></section>}
      {preview.feeEstimate && <section className="review-risk"><h3>手续费参考 · 来源 {time(preview.feeEstimate.asOf)}</h3>{preview.feeEstimate.error && <p className="warning">{preview.feeEstimate.error}</p>}{preview.feeEstimate.legs.map((leg, index) => <div className="risk-leg" key={leg.symbol + index}><strong>{leg.symbol}</strong><dl className="ticket-details"><div><dt>Maker / Taker</dt><dd>{percentage(leg.makerRate)} / {percentage(leg.takerRate)}</dd></div><div><dt>本次预算费率 / 金额</dt><dd>{percentage(leg.assumedRate)} / <DecimalValue value={leg.estimatedFee} kind="amount"/> {leg.currency}</dd></div></dl></div>)}<p>手续费按预览价格估算，缺失费率显示「—」，实际费用以真实成交记录为准。</p></section>}
      <p className="trade-consequence">{preview.kind === 'open' ? preview.legs.length > 1 ? '确认后将逐腿发送真实委托。双腿可能部分成交或仅一腿成交，剩余敞口需要手动处理。' : '确认后发送以上真实开仓委托。市价单成交价格以交易所实际成交为准。' : '确认后逐腿只减持以上选中仓位。成交数量可能不同，请核对剩余持仓与净敞口。'}</p>
      {preview.warnings.length > 0 && <ul className="review-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <label className="check confirm-check"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)}/>我已核对账户、方向、数量、订单类型和价格，确认提交真实订单。</label>
    </div>
    <div className="dialog-actions"><button disabled={busy} onClick={close}>返回检查</button><button className="primary" disabled={busy || disabled || !acknowledged || expired || !preview.canConfirm} onClick={confirm}>{busy ? '正在提交，请等待…' : '确认实盘下单'}</button></div>
  </dialog>;
}

export function CancelReview({ order, busy, disabled, close, confirm }: { order: LiveOrder; busy: boolean; disabled: boolean; close: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="trade-dialog cancel-dialog" aria-labelledby="cancel-review-title" onCancel={e => { e.preventDefault(); if (!busy) close(); }}><div className="dialog-heading"><h2 id="cancel-review-title">核对撤单</h2><button disabled={busy} onClick={close} aria-label="关闭撤单核对">×</button></div><div className="dialog-content"><p>{order.exchange ? venue(order.exchange) : 'Gate CrossEx'} · {order.symbol} · {sideLabel(order.side)}</p><p className="order-id">订单 {order.id}</p><p>委托 <DecimalValue value={order.quantity} full/>，已成交 <DecimalValue value={order.filledQuantity} full/>。</p><p className="muted">仅撤销尚未成交的数量。已成交部分保留，最终状态以查询结果为准。</p></div><div className="dialog-actions"><button disabled={busy} onClick={close}>返回</button><button className="primary" disabled={busy || disabled} onClick={confirm}>{busy ? '正在发送…' : '确认撤销订单'}</button></div></dialog>;
}
