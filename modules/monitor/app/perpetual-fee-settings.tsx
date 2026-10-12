"use client";

import { memo, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown } from 'lucide-react';
import { defaultQualityBudget, takerFeeVenues, validFeePercent, type QualityBudget, type TakerFeeVenue } from '../lib/perpetual-fees';

function PerpetualFeeSettings({ budget, onChange }: { budget: QualityBudget; onChange: Dispatch<SetStateAction<QualityBudget>> }) {
  function updateFee(venue: TakerFeeVenue, text: string) {
    const value = text.trim() === '' ? undefined : Number(text);
    if (value !== undefined && !validFeePercent(value)) return;
    onChange(previous => {
      const takerOverrides = { ...previous.takerOverrides };
      if (value === undefined) delete takerOverrides[venue]; else takerOverrides[venue] = value;
      return { ...previous, takerOverrides };
    });
  }
  const customCount = Object.keys(budget.takerOverrides).length;
  return <details className="perp-quality-budget">
    <summary>Taker 手续费与滑点<span>{customCount ? `${customCount} 家账户费率` : '按平台与合约'} · 滑点 {budget.slippagePercent.toFixed(2)}%</span><ChevronDown size={14}/></summary>
    <p>默认使用已核对的普通账户公开 taker 费率。VIP、代币抵扣、Premium 或入口附加费，请填写账户显示的单次合计费率；留空恢复自动。覆盖值适用于该平台全部合约，仅保存在当前浏览器。</p>
    <div className="perp-taker-settings">{takerFeeVenues.map(venue => <label key={venue.id}><span>{venue.name}<small>单次 taker / %</small></span><input aria-label={`${venue.name} 账户单次 taker 费率 / %`} type="number" min={0} max={10} step="0.0001" placeholder="自动按合约" value={budget.takerOverrides[venue.id] ?? ''} onChange={event => updateFee(venue.id, event.target.value)}/></label>)}</div>
    <div className="perp-quality-budget-fields">
      <label>双腿往返滑点 / %<input type="number" min={0} max={10} step="0.01" value={budget.slippagePercent} onChange={event => { const value = event.target.valueAsNumber; if (validFeePercent(value)) onChange(previous => ({ ...previous, slippagePercent: value })); }}/></label>
      <button type="button" onClick={() => onChange({ ...defaultQualityBudget, takerOverrides: {} })}>恢复公开费率与默认滑点</button>
    </div>
    <p>双腿开平仓共 4 次 taker 成交：往返手续费 = 2 ×（做多费率 + 做空费率）。按每腿相同名义本金估算；滑点默认 0.10%。具体费率、来源和扣费价差见展开详情。</p>
  </details>;
}

export default memo(PerpetualFeeSettings);
