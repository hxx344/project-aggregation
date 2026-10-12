"use client";

import { memo, useMemo, useState } from "react";
import { estimatePerpetualHoldingScenario } from "../lib/perpetual-opportunity";
import type { QualityBudget } from "../lib/perpetual-fees";
import type { PerpetualSpread } from "../lib/perpetual-spreads";
import type { PerpetualPriceMode } from "../lib/perpetual-types";

const pct = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(4)}%`;
const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function PerpetualHolding({ row, budget, now, mode, fundingFocused = false }: { row: PerpetualSpread; budget: QualityBudget; now: number; mode: PerpetualPriceMode; fundingFocused?: boolean }) {
  const [hours, setHours] = useState(fundingFocused ? 24 : 8);
  const [exitSpread, setExitSpread] = useState(fundingFocused ? row.spreadPercent : 0);
  const scenario = useMemo(() => estimatePerpetualHoldingScenario(row, budget, { holdingHours: hours, exitSpreadPercent: exitSpread, priceMode: mode }, now), [row, budget, hours, exitSpread, mode, now]);
  return <section className="perp-holding" aria-label="持有期收益情景">
    <div className="perp-detail-section-title"><h3>持有期情景 <small>单腿名义金额口径</small></h3><span>费率维持当前值的估算</span></div>
    {fundingFocused ? <p>资金费机会默认持有 24 小时、退出价差与入场相同，不预设价差收益；可调整下方假设。</p> : null}
    <div className="perp-scenario-controls"><label>预计持有 / 小时<select value={hours} onChange={event => setHours(Number(event.target.value))}>{[1, 4, 8, 24, 72, 168].map(value => <option key={value} value={value}>{value} 小时</option>)}</select></label><label>退出残余价差 / %<input aria-label="退出残余价差" type="number" min={-100} max={1000} step="0.01" value={Number.isNaN(exitSpread) ? "" : exitSpread} onChange={event => setExitSpread(event.target.valueAsNumber)}/></label><div><span>预估扣费后结果</span><strong className={scenario.estimatedNetPercent !== null && scenario.estimatedNetPercent > 0 ? "is-positive" : ""}>{pct(scenario.estimatedNetPercent)}</strong><small>含预计资金费 · 非锁定利润</small></div></div>
    <dl className="perp-scenario-breakdown"><div><dt>价差收敛</dt><dd>{pct(scenario.convergencePercent)}</dd></div><div><dt>资金费净收支</dt><dd>{pct(scenario.fundingPercent)}</dd></div><div><dt>往返 taker 成本</dt><dd>{scenario.roundTripFeePercent === null ? "—" : `${scenario.roundTripFeePercent.toFixed(4)}%`}</dd></div><div><dt>往返滑点预算</dt><dd>{scenario.slippagePercent === null ? "—" : `${scenario.slippagePercent.toFixed(2)}%`}</dd></div></dl>
    <div className="perp-settlement-legs">{([{ label: "做多腿", name: row.long.exchange, leg: scenario.long }, { label: "做空腿", name: row.short.exchange, leg: scenario.short }] as const).map(({ label, name, leg }) => <div key={label}><strong>{label} · {name}</strong><span>预计结算 {leg.settlements ?? "—"} 次 · 收支 {pct(leg.cashflowPercent)}</span><small>下次 {leg.nextFundingAt ? time.format(leg.nextFundingAt) : "—"} 北京时间</small></div>)}</div>
    {scenario.reasons.length ? <ul className="perp-scenario-reasons">{scenario.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    <details className="perp-scenario-assumptions"><summary>估算口径与退出条件</summary>{scenario.assumptions.map(assumption => <p key={assumption}>{assumption}</p>)}<p>退出残余价差需包含退出时的买卖盘口差异；滑点预算按双腿往返计，不是上方深度检查结果。两腿按各自实际下次结算时点和周期计数。</p></details>
  </section>;
}

export default memo(PerpetualHolding);
