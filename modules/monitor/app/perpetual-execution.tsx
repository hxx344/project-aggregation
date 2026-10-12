"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import type { PerpetualQuote } from "@/lib/perpetual-types";
import { depthEstimateExpired, type PerpetualDepthEstimate } from "@/lib/perpetual-execution";
import "./perpetual-execution.css";

type Props = {
  long: Pick<PerpetualQuote, "exchange" | "symbol" | "base" | "displayBase">;
  short: Pick<PerpetualQuote, "exchange" | "symbol">;
  active: boolean;
  now: number;
};
const number = (value: number | null, digits = 5) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;

function ExecutionInspector({ long, short, active, now }: Props) {
  const [amount, setAmount] = useState("1000");
  const [result, setResult] = useState<PerpetualDepthEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null), id = useId();
  useEffect(() => {
    if (!active) pending.current?.abort();
    const visibility = () => { if (document.hidden) pending.current?.abort(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { pending.current?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [active]);

  async function inspect() {
    if (!active || document.hidden || busy) return;
    const notional = Number(amount);
    if (!Number.isFinite(notional) || notional <= 0 || notional > 10_000_000) { setError("金额需大于 0 且不超过 10,000,000 USDT"); return; }
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setResult(null);
    try {
      const response = await fetch("/api/monitors/perpetual/depth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ long: { exchange: long.exchange, symbol: long.symbol }, short: { exchange: short.exchange, symbol: short.symbol }, notional }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      const data = await response.json() as (Partial<PerpetualDepthEstimate> & { error?: unknown }) | null;
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "盘口校验暂不可用");
      if (!data || !Array.isArray(data.reasons) || typeof data.complete !== "boolean" || !Number.isFinite(data.generatedAt)) throw new Error("盘口校验返回格式不正确");
      if (!controller.signal.aborted && pending.current === controller) setResult(data as PerpetualDepthEstimate);
    } catch (cause) {
      if (!controller.signal.aborted && pending.current === controller) setError(cause instanceof Error ? cause.message : "盘口查询失败，请重试");
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  const expired = result ? depthEstimateExpired(result, now) : false;
  const changed = result !== null && Number(amount) !== result.notional;
  return <section className="perp-execution" aria-labelledby={`${id}-title`}>
    <div className="perp-execution-heading"><div><h4 id={`${id}-title`}>按金额校验盘口</h4><p>单次获取当前深度，两腿匹配相同标的数量；列表保持暂停。</p></div><span className="perp-execution-tag">按需查询 · 无历史存储</span></div>
    <form className="perp-execution-form" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <label htmlFor={`${id}-amount`}>做多腿目标金额</label><div><input id={`${id}-amount`} type="number" inputMode="decimal" min="0.01" max="10000000" step="any" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} /><span>USDT</span></div>
      <button type="submit" disabled={busy || !active}>{busy ? "正在校验…" : result ? "重新校验" : "校验盘口"}</button>
    </form>
    {error ? <p className="perp-execution-warning" role="alert">{error}</p> : null}
    {result ? <div className="perp-execution-result" aria-live="polite">
      <p className={!result.complete || expired || changed ? "perp-execution-warning" : "perp-execution-status"}>{changed ? `金额已修改，下方保留 ${number(result.notional, 2)} USDT 的结果` : expired ? "盘口校验已过期，请重新校验" : result.complete ? "两腿公开盘口可覆盖目标数量" : "盘口校验未通过"} · {new Date(result.generatedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} 北京时间</p>
      <div className="perp-execution-metrics"><div><span>盘口成交价差</span><strong>{percent(result.estimatedSpreadPct)}</strong><small>已计入开仓深度影响，未扣手续费</small></div><div><span>开仓价差损耗</span><strong>{result.entrySlippagePct === null ? "—" : `${number(result.entrySlippagePct, 3)} 个百分点`}</strong><small>相对两腿买卖一档</small></div><div><span>两腿目标标的数量</span><strong>{number(result.quantity)}</strong><small>{long.displayBase || long.base}{!result.long?.complete ? " · 做多盘口可见部分" : ""}</small></div></div>
      <div className="perp-execution-legs">{([['做多 / 买入', result.long], ['做空 / 卖出', result.short]] as const).map(([title, leg]) => leg ? <div key={title}><h5>{title} · {leg.exchange}</h5><p>{leg.symbol} · {leg.levels} 档 · {leg.transport.toUpperCase()}</p><dl><div><dt>{leg.complete ? "成交均价" : "部分成交均价"}</dt><dd>{number(leg.vwap)} USDT</dd></div><div><dt>盘口可覆盖金额</dt><dd>{number(leg.filledNotional, 2)} USDT</dd></div><div><dt>该侧公开档位总额</dt><dd>{number(leg.capacityNotional, 2)} USDT</dd></div></dl></div> : null)}</div>
      {result.reasons.length ? <ul className="perp-execution-warning">{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    </div> : null}
    <p className="perp-execution-footnote">金额指名义仓位，非保证金。只估算公开盘口，不包含下单步长、最小金额、价格保护和退出成交；跨计价币使用现货一档换算，未校验换汇深度。</p>
  </section>;
}

/** Reset results on a direction/contract change, even within the same coin. */
export const PerpetualExecution = memo(function PerpetualExecution(props: Props) {
  return <ExecutionInspector key={`${props.long.exchange}:${props.long.symbol}|${props.short.exchange}:${props.short.symbol}`} {...props} />;
});
