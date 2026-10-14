import { useEffect, useRef, useState } from 'react';
import type { Instrument, LiveView, PreviewInput } from './live-types';
import type { PositionGroup } from './position-view';
import type { CapacityContext } from './use-open-capacity';
import { instrumentFees, percentage } from './position-view';
import { sideLabel } from './live-display';
import { time, venue } from './display';
import DecimalValue from './DecimalValue';
import { actionDecimal, addFractionQuantity, addQuantityFromTotal, commonQuantityStep, estimatePositionDelta, legQuantityDiff, planPositionAction,
  positionActionInput, positionInstrument, positionSnapshotChanged, sharedAvailableMargin, spreadDeviation } from './position-actions';
import type { BalanceStrategy } from './position-actions';
import './position-actions.css';

export type PositionActionProps = { preview: (input: PreviewInput) => Promise<boolean>; budget: string | number; entryPaused: boolean;
  capacityContext: CapacityContext; catalogError: string; previewError?: string };
export type PositionActionSelection = { action: 'add' | 'balance'; group: PositionGroup; connectionVersion: string | number; accountId: string | null };

export default function PositionActionDialog({ selection, live, instruments, disabled, preview, budget, entryPaused, capacityContext, catalogError, previewError, dismiss }: PositionActionProps & {
  selection: PositionActionSelection; live: LiveView; instruments: Instrument[]; disabled: boolean; dismiss: () => void;
}) {
  const { group, action, connectionVersion, accountId } = selection;
  const dialog = useRef<HTMLDialogElement>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [strategy, setStrategy] = useState<BalanceStrategy>('reduce'), [targetInput, setTargetInput] = useState('');
  const [percent, setPercent] = useState(100), [custom, setCustom] = useState<string | null>(null), [inputMode, setInputMode] = useState<'increment' | 'total'>('increment');
  const [invalidated, setInvalidated] = useState(false);
  const changed = positionSnapshotChanged(group, connectionVersion, accountId, live), snapshotInvalid = changed || invalidated;
  // Keep an observed invalidation latched even if a later poll happens to return the original quantity.
  useEffect(() => { if (changed) setInvalidated(true); }, [changed]);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const baseQuantity = actionDecimal(group.legs[0]?.baseQuantity)?.abs();
  const commonStep = commonQuantityStep(group.legs.map(p => positionInstrument(p, instruments)?.lot_size));
  const fraction = addFractionQuantity(baseQuantity?.toFixed() ?? null, percent, commonStep);
  const displayedQuantity = custom ?? (inputMode === 'total' && baseQuantity && fraction ? baseQuantity.add(fraction).toFixed() : fraction ?? '');
  const addQuantity = inputMode === 'total' ? addQuantityFromTotal(displayedQuantity, baseQuantity?.toFixed() ?? null) ?? '' : displayedQuantity;
  const plan = planPositionAction(group, instruments, action, action === 'add' ? addQuantity : targetInput, strategy);
  const diff = legQuantityDiff(group.legs), deviation = spreadDeviation(group);
  const feesFresh = !live.feesError && !!live.feesAsOf && live.feesAsOf <= capacityContext.now + 1000 && capacityContext.now - live.feesAsOf <= 300_000;
  const estimates = plan.legs.map(leg => ({ leg, ...estimatePositionDelta(leg, feesFresh ? instrumentFees(live.fees, leg.position.symbol).taker : null) }));
  const marginCurrencies = [...new Set(estimates.map(row => row.leg.position.marginCurrency || '币种未知'))];
  const marginTotals = marginCurrencies.map(currency => {
    const rows = estimates.filter(row => (row.leg.position.marginCurrency || '币种未知') === currency);
    const sum = (values: (string | null)[]) => values.some(value => value === null) ? null : values.reduce((total, value) => total!.add(value!), actionDecimal('0'))!.toFixed();
    return { currency, change: sum(rows.map(row => row.marginChange)), required: sum(rows.filter(row => !row.leg.reduceOnly).map(row => row.marginChange)) };
  });
  const available = sharedAvailableMargin(capacityContext.live, capacityContext.now);
  const usdtRequired = actionDecimal(marginTotals.find(row => row.currency === 'USDT')?.required), availableAmount = actionDecimal(available);
  const insufficient = !!usdtRequired && !!availableAmount && usdtRequired.mul('1.10').gt(availableAmount);
  const openingProblem = plan.hasIncrease ? entryPaused ? '新开仓已暂停；平衡时可选择仅减少仓位的目标。'
    : catalogError ? `合约目录不可用：${catalogError}` : '' : '';
  const blocked = disabled || busy || snapshotInvalid || !!openingProblem || plan.errors.length > 0;
  const submit = async () => {
    if (blocked) return;
    setBusy(true); setError('');
    try {
      if (await preview(positionActionInput(plan, action, strategy, connectionVersion))) dismiss();
      else setError('预览未通过，请核对数量、账户和行情后重试。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预览未完成，请重试。'); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="trade-dialog position-action-dialog" aria-labelledby="position-action-title" onCancel={event => { event.preventDefault(); if (!busy) dismiss(); }}>
    <div className="dialog-heading"><div><span className="eyebrow">{action === 'add' ? 'ADD POSITION' : 'BALANCE LEGS'}</span><h2 id="position-action-title">{group.base} · {action === 'add' ? '加仓持仓组合' : '平衡双腿数量'}</h2></div><button disabled={busy} aria-label="关闭持仓操作" onClick={dismiss}>×</button></div>
    <div className="dialog-content">
      <p className="muted">{action === 'add' ? '为两腿增加相同基础币数量，保留原持仓方向。' : '把两腿调整到相同基础币数量；仅执行数量变化的腿。'}按当前盘口生成保护限价 IOC 委托，前腿未全部成交时不发送后腿。</p>
      <section className="position-action-current" aria-label="当前双腿明细"><h3>当前持仓</h3><div className="review-legs">{group.legs.map(position => <section className="review-leg" key={position.id}><h3>{venue(position.exchange)} · {sideLabel(position.side)}</h3><p className="muted">{position.symbol}</p><dl>
        <div><dt>当前数量</dt><dd><DecimalValue value={actionDecimal(position.baseQuantity)?.abs().toFixed()} full/> {group.base}</dd></div>
        <div><dt>开仓均价 / 标记价</dt><dd><DecimalValue value={position.entryPrice} kind="price"/> / <DecimalValue value={position.markPrice} kind="price"/> {position.quoteCurrency}</dd></div>
        <div><dt>未实现盈亏 / 资金费</dt><dd><DecimalValue value={position.unrealizedPnl} kind="amount"/> / <DecimalValue value={position.fundingFee} kind="amount"/> {position.pnlCurrency}</dd></div>
        <div><dt>当前杠杆</dt><dd><DecimalValue value={position.leverage} kind="rate"/>×</dd></div>
      </dl></section>)}</div><p className="muted">数量固定于打开时；缺失数据为未知，显示「—」。</p></section>
      {action === 'add' ? <section className="position-action-input"><h3>加仓数量</h3><div className="percentage-controls" aria-label="按当前持仓比例加仓">{[25, 50, 75, 100].map(value => <button key={value} type="button" disabled={busy || snapshotInvalid} aria-pressed={percent === value && custom === null} className={percent === value && custom === null ? 'active' : ''} onClick={() => { setPercent(value); setCustom(null); setInputMode('increment'); }}>{value}%</button>)}</div>
        <div className="position-input-modes" role="group" aria-label="加仓数量输入方式">{(['increment', 'total'] as const).map(mode => <button key={mode} disabled={busy || snapshotInvalid} aria-pressed={inputMode === mode} onClick={() => { if (mode !== inputMode) { setInputMode(mode); setCustom(mode === 'total' ? plan.targetQuantity ?? '' : plan.quantity ?? ''); } }}>{mode === 'increment' ? '填写增量' : '填写总量'}</button>)}</div>
        <label>{inputMode === 'increment' ? '自定义加仓数量' : '加仓后每腿总数量'}<div className="input-unit"><input inputMode="decimal" aria-label={inputMode === 'increment' ? '自定义加仓数量' : '加仓后每腿总数量'} value={displayedQuantity} disabled={busy || snapshotInvalid} onChange={event => setCustom(event.target.value)}/><span>{group.base}</span></div></label>
        <p>每腿增加 <strong><DecimalValue value={plan.quantity} full/></strong> → 每腿总量 <strong><DecimalValue value={plan.targetQuantity} full/></strong> {group.base}</p>
        <p className="muted">共同数量步长：<DecimalValue value={commonStep} full/> {group.base}。比例数量向下对齐；自定义数量须精确满足每腿规则。</p>
      </section> : <>
        <section className="position-quantity-comparison" aria-label="双腿数量对比">{group.legs.map(position => <div key={position.id}><div><span>{venue(position.exchange)} · {sideLabel(position.side)}</span><strong><DecimalValue value={actionDecimal(position.baseQuantity)?.abs().toFixed()} full/> {group.base}</strong></div><div className="position-quantity-track" aria-hidden="true"><span style={{ width: `${actionDecimal(position.baseQuantity)?.abs().div(actionDecimal(diff.larger?.baseQuantity)?.abs() ?? 1).mul(100).toFixed(2) ?? 0}%` }}/></div></div>)}<p>数量差异 <strong><DecimalValue value={diff.diff} full/> {group.base}</strong> · 相对双腿均值 {percentage(diff.ratio)}</p></section>
        <fieldset className="position-strategies"><legend>平衡策略</legend>{([
          ['reduce', '减少较大腿', '只减仓，目标为较小腿数量'], ['increase', '增加较小腿', '保留较大腿，占用新增保证金'], ['target', '指定目标数量', '按目标逐腿增减；可能先减后增'],
        ] as const).map(([value, label, note]) => <label key={value}><input type="radio" name="balance-strategy" aria-label={label} checked={strategy === value} disabled={busy || snapshotInvalid || value === 'increase' && (entryPaused || !!catalogError)} onChange={() => setStrategy(value)}/><span><strong>{label}</strong><small>{note}</small></span></label>)}</fieldset>
        {strategy === 'target' && <label>平衡目标数量<div className="input-unit"><input aria-label="平衡目标数量" inputMode="decimal" value={targetInput} disabled={busy || snapshotInvalid} onChange={event => setTargetInput(event.target.value)}/><span>{group.base}</span></div></label>}
        <p>调整后每腿目标：<strong><DecimalValue value={plan.targetQuantity} full/> {group.base}</strong></p>
      </>}
      <section className="position-action-estimates" aria-label="逐腿费用与保证金估算"><h3>逐腿操作参考</h3>{estimates.map(({ leg, notional, projectedNotional, marginChange, fee }) => <div className="position-estimate-leg" key={leg.position.id}><strong>{venue(leg.position.exchange)} · {sideLabel(leg.position.side)} · {leg.unchanged ? '不变' : leg.reduceOnly ? '减少仓位' : '增加仓位'}</strong><dl className="ticket-details">
        <div><dt>调整数量</dt><dd><DecimalValue value={leg.quantity} full/> {group.base}</dd></div>
        <div><dt>本次名义额 / 调整后名义额</dt><dd><DecimalValue value={notional} kind="amount"/> / <DecimalValue value={projectedNotional} kind="amount"/> {leg.position.quoteCurrency}</dd></div>
        <div><dt>预计保证金变化</dt><dd><DecimalValue value={marginChange} kind="amount" signed/> {leg.position.marginCurrency || '币种未知'}</dd></div>
        <div><dt>预计 Taker 手续费</dt><dd><DecimalValue value={fee} kind="amount"/> {leg.position.quoteCurrency}</dd></div>
      </dl>{!leg.reduceOnly && !leg.unchanged && leg.position.quoteCurrency === 'USDT' && actionDecimal(notional)?.gt(budget) && <p className="warning">本次单腿名义额估算超过预算，服务端将按最新保护价复核。</p>}</div>)}
        <dl className="ticket-details"><div><dt>单腿订单预算</dt><dd><DecimalValue value={String(budget)} kind="amount"/> USDT</dd></div>{marginTotals.map(total => <div key={total.currency}><dt>保证金增加需求 / 净变化</dt><dd><DecimalValue value={total.required} kind="amount"/> / <DecimalValue value={total.change} kind="amount" signed/> {total.currency}</dd></div>)}<div><dt>账户共享可用保证金</dt><dd><DecimalValue value={available} kind="amount"/> USDT</dd></div></dl>
        {available === null && <p className="muted">可用保证金未知：仅显示新鲜 CROSS_EXCHANGE 账户共享额度；隔离账户由服务端逐交易所核验。</p>}
        {insufficient && <p className="warning">按 10% 保证金预留估算，可用保证金不足；最终结果以服务端预览为准。</p>}
        <p className="muted">价格与杠杆按打开时持仓估算；手续费来源 {time(feesFresh ? live.feesAsOf : null)}。金额按币种分别列示；非 USDT 名义额未作预算换汇。减少仓位预计释放的保证金不抵扣本次增仓需求。</p>
      </section>
      {action === 'add' && (deviation === null ? <p className="muted">开仓与当前价差的偏离程度未知。</p> : actionDecimal(deviation)!.gt('0.3') && <p className="warning">当前价差较开仓价差偏离 {percentage(deviation)}，已超过 30%，加仓成交价格与持仓均价可能不同。</p>)}
      {snapshotInvalid && <p role="alert" className="inline-state warning">持仓数量、方向或账户已变化。请关闭并重新打开对话框，重新核对目标。</p>}
      {disabled && !busy && <p className="warning">账户数据待更新、操作处理中或存在待确认请求，暂不可预览。</p>}
      {openingProblem && <p role="alert" className="warning">{openingProblem}</p>}
      {plan.errors.length > 0 && <ul className="review-warnings">{plan.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
      {error && <p role="alert" className="warning">{previewError || error}</p>}
      <p className="footnote">估算仅供核对。预览与确认会重新检查数量、当前盘口、预算、保证金与风险档位；IOC 剩余数量会取消，请在提交后核对逐腿成交。</p>
    </div><div className="dialog-actions"><button disabled={busy} onClick={dismiss}>取消</button><button className="primary" disabled={blocked} onClick={() => void submit()}>{busy ? '正在预览…' : action === 'add' ? '预览加仓' : '预览平衡操作'}</button></div>
  </dialog>;
}
