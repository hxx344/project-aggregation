"use client";

import { memo } from "react";
import SettledFundingPanel, { type SettledFundingConfig } from "./settled-funding-panel";
import { FIRST_SETTLEMENT, FUNDING_MS } from "../modules/oil/binance-funding-history.mjs";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { useOilFunding } from "../hooks/use-oil-funding";
import type { OilQuote } from "../hooks/use-oil-feed";

export type FundingBasis = "quantity" | "notional";
const config: SettledFundingConfig = {
  label: "原油历史多空资金费", intervalMs: FUNDING_MS, firstSettlement: FIRST_SETTLEMENT,
  short: "空布伦特、多 WTI", long: "多布伦特、空 WTI", coverage: { count: "次共同结算", missing: "次结算", valid: "次有效结算" },
  method: "区间累计年化 = 净小时费率之和 ÷ 有效小时数 × 8,760，不复利。历史图按两腿等名义计算；当前预估按所选口径使用实时费率与标记价格。",
  details: <><p>Binance BZUSDT 与 CLUSDT 每 4 小时结算一次。做空净小时率 = (布伦特结算费率 − WTI 结算费率) ÷ 2 ÷ 4；做多取相反数。累计曲线从所选区间重新求和实际结算费率，累计年化使用截至各时点的有效结算次数 × 4 小时。只统计资金费，不含价差盈亏、手续费、滑点和保证金成本。</p><p>当前预估：等数量 = 空 1 桶布伦特、多 1 桶 WTI，分母为两腿标记价之和；等名义 = 两腿 USDT 名义相等，净小时率 = (布伦特小时费率 − WTI 小时费率) ÷ 2。</p><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">Binance 资金费规则 ↗</a></>,
};
const percent = (value: number | null | undefined, digits = 5) => value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(digits)}%`;
const tone = (value: number | null | undefined) => value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const bases: { id: FundingBasis; label: string }[] = [{ id: "quantity", label: "等数量" }, { id: "notional", label: "等名义" }];

function CurrentFunding({ quote, basis, onBasisChange }: { quote: OilQuote | null; basis: FundingBasis; onBasisChange: (basis: FundingBasis) => void }) {
  const result = quote ? calculateShortSpreadFunding(quote, basis) : null;
  const legs = quote ? [["布伦特", quote.brent], ["WTI", quote.wti]] as const : [];
  return <div className="funding-current" aria-label="当前预估资金费">
    <div className="funding-current-head"><span>当前预估 · 空布伦特、多 WTI</span><div className="segmented" aria-label="资金费口径">{bases.map(item => <button type="button" key={item.id} aria-pressed={basis === item.id} className={basis === item.id ? "active" : ""} onClick={() => onBasisChange(item.id)}>{item.label}</button>)}</div></div>
    {result?.hourlyRate == null ? <p>{quote ? "资金费暂不可用 · 等待有效费率和结算周期" : "等待实时报价"}</p> : <dl>
      <div><dt>净小时费率</dt><dd className={tone(result.hourlyRate)}>{percent(result.hourlyRate)} / 小时</dd></div>
      <div><dt>简单年化</dt><dd className={tone(result.hourlyRate)}>{percent(result.annualizedRate, 2)}</dd></div>
      <div><dt>每 1 万 USDT · 每小时</dt><dd className={tone(result.hourlyRate)}>{result.cashflowPer10k! < 0 ? "−" : result.cashflowPer10k! > 0 ? "+" : ""}{Math.abs(result.cashflowPer10k!).toFixed(4)} USDT</dd></div>
      {legs.map(([name, leg]) => <div key={name}><dt>{name}费率</dt><dd>{percent(leg.fundingRate)} / {leg.fundingIntervalHours} h</dd></div>)}
    </dl>}
  </div>;
}

function OilFundingPanel({ range, onRangeChange, quote, basis, onBasisChange }: { range: number | null; onRangeChange: (range: number | null) => void; quote: OilQuote | null; basis: FundingBasis; onBasisChange: (basis: FundingBasis) => void }) {
  const { data, error, loading, refresh } = useOilFunding();
  return <SettledFundingPanel range={range} onRangeChange={onRangeChange} config={config}
    feed={{ rows: data?.rows ?? null, fetchedAt: data?.fetchedAt ?? null, snapshot: data?.status === "snapshot", error, loading, refresh }}
    current={<CurrentFunding quote={quote} basis={basis} onBasisChange={onBasisChange}/>}/>;
}

export default memo(OilFundingPanel);
