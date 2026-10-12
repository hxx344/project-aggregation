"use client";
import { hubChanged } from "../lib/hub-bridge";

import { memo, useEffect, useId, useRef, useState } from "react";
import type { PerpetualQuote } from "../lib/perpetual-types";
import { resolveTakerFee, type QualityBudget } from "../lib/perpetual-fees";
import { exitEstimateExpired, perpetualExitIdentity, validatePerpetualExitPosition, type PerpetualExitEstimate, type PerpetualExitInput } from "../lib/perpetual-exit";
import type { PerpetualPaperView } from "../lib/perpetual-paper";
import "./perpetual-exit.css";

const number = (value: number | null | undefined, digits = 4) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const precise = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value < 1e-8 ? value.toExponential(4) : number(value, 12) : "—";
const percent = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${number(value, 3)}%`;
const stamp = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const amount = (value: string) => value.trim() ? Number(value) : NaN;

function ExitCheck({ input, active, now }: { input: PerpetualExitInput; active: boolean; now: number }) {
  const [result, setResult] = useState<PerpetualExitEstimate | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) pending.current?.abort();
    const hide = () => { if (document.hidden) pending.current?.abort(); };
    document.addEventListener("visibilitychange", hide);
    return () => { pending.current?.abort(); document.removeEventListener("visibilitychange", hide); };
  }, [active]);
  async function inspect() {
    if (busy || !active || document.hidden) return;
    try { validatePerpetualExitPosition(input); } catch (cause) { setError((cause as Error).message); return; }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/monitors/perpetual/exit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      const body = await response.json() as (Partial<PerpetualExitEstimate> & { error?: string }) | null;
      if (!response.ok) throw new Error(body?.error || "平仓测算暂不可用");
      if (body?.kind !== "exit" || !Array.isArray(body.reasons) || !Number.isFinite(body.generatedAt)) throw new Error("平仓测算返回格式不正确");
      if (!controller.signal.aborted) setResult(body as PerpetualExitEstimate);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "查询失败"); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  const expired = result?.long && result.short ? exitEstimateExpired(result, now) : false;
  return <section className="perp-exit-check" aria-label="当前盘口平仓测算">
    <button type="button" className="perp-exit-primary" disabled={busy || !active} onClick={() => void inspect()}>{busy ? "正在读取平仓盘口…" : "测算现在平仓"}</button>
    <p className="perp-exit-note">点击时查询一次盘口。卖出多腿、买回空腿；不发送交易指令。</p>
    {error ? <p role="alert" className="perp-exit-warning">{error}</p> : null}
    {result ? <div aria-live="polite">
      <p className={expired || !result.complete ? "perp-exit-warning" : "perp-exit-status"}>{expired ? "盘口已过期 · 下方保留上次测算" : result.complete ? "两腿深度可覆盖 · 费用已纳入" : "条件未齐全 · 净收益不予计算"} · {stamp(result.generatedAt)} 北京时间</p>
      <div className="perp-exit-metrics"><div><span>估算净收益</span><strong className={result.netPnl !== null && result.netPnl < 0 ? "is-negative" : undefined}>{number(result.netPnl)} <small>USDT</small></strong><small>按已登记累计资金费</small></div><div><span>价格盈亏</span><strong className={result.rawPnl !== null && result.rawPnl < 0 ? "is-negative" : undefined}>{number(result.rawPnl)} <small>USDT</small></strong><small>多腿 {number(result.longPnl)} / 空腿 {number(result.shortPnl)}</small></div><div><span>投入本金收益率</span><strong>{percent(result.capitalReturnPercent)}</strong><small>两账户投入本金为分母</small></div></div>
      <div className="perp-exit-legs">{([["卖出多腿", result.long], ["买回空腿", result.short]] as const).map(([label, leg]) => <section key={label}><h5>{label} · {leg?.exchange ?? "—"}</h5><p>{leg?.symbol ?? "盘口不可用"}</p><dl><div><dt>{leg?.complete ? "预计成交均价" : "部分成交均价"}</dt><dd>{precise(leg?.vwap)} USDT</dd></div><div><dt>可覆盖 / 目标数量</dt><dd>{precise(leg?.filledQuantity)} / {precise(result.position.quantity)} {result.base}</dd></div><div><dt>预计平仓手续费</dt><dd>{number(leg?.closeFee)} USDT</dd></div><div><dt>taker 费率</dt><dd>{leg?.fee.percent == null ? "—" : `${number(leg.fee.percent)}%`}</dd></div><div><dt>盘口来源时间</dt><dd>{leg?.sourceTime ? stamp(leg.sourceTime) : "—"}</dd></div></dl><small>{leg?.fee.detail}</small></section>)}</div>
      <p className="perp-exit-note">净收益 = 两腿价格盈亏 − 已付开仓费用 {number(result.entryFeePaid)} − 预计平仓费用 {number(result.closeFeePaid)} + 登记资金费 {number(result.settledFunding)} USDT。以多腿开仓名义金额为分母：{percent(result.notionalReturnPercent)}。</p>
      {result.reasons.length ? <ul className="perp-exit-warning">{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    </div> : null}
  </section>;
}

/** Editing any input discards the previous estimate and aborts its pending request. */
export const PerpetualExitCheck = memo(function PerpetualExitCheck(props: { input: PerpetualExitInput; active: boolean; now: number }) {
  return <ExitCheck key={JSON.stringify(props.input)} {...props}/>;
});

type Props = { long: PerpetualQuote; short: PerpetualQuote; budget: QualityBudget; active: boolean; now: number; onRegistered: () => void };
function ExitWorkspace({ long, short, budget, active, now, onRegistered }: Props) {
  const id = useId(), pending = useRef<AbortController | null>(null);
  const registration = useRef<{ key: string; requestId: string; openedAt: number } | null>(null);
  const [mode, setMode] = useState<"paper" | "manual">("paper");
  const initialQuantity = long.ask && long.ask > 0 ? 1000 / long.ask : 0;
  const longFee = resolveTakerFee(long, budget.takerOverrides, now), shortFee = resolveTakerFee(short, budget.takerOverrides, now);
  const initialFee = longFee.percent !== null && shortFee.percent !== null && long.ask && short.bid ? initialQuantity * (long.ask * longFee.percent + short.bid * shortFee.percent) / 100 : null;
  const [fields, setFields] = useState({ quantity: initialQuantity ? String(Number(initialQuantity.toPrecision(10))) : "", entryLongPrice: long.ask ? String(long.ask) : "", entryShortPrice: short.bid ? String(short.bid) : "", entryFeePaid: initialFee === null ? "" : String(Number(initialFee.toPrecision(8))), settledFunding: "0", capital: "", targetNetProfit: "", maxHoldingHours: "", openedAt: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!active) pending.current?.abort();
    const hide = () => { if (document.hidden) pending.current?.abort(); };
    document.addEventListener("visibilitychange", hide);
    return () => { pending.current?.abort(); document.removeEventListener("visibilitychange", hide); };
  }, [active]);
  const supported = [long, short].every(quote => quote.quoteCurrency === "USDT" && (!quote.collateralCurrency || quote.collateralCurrency === "USDT"));
  const input: PerpetualExitInput = { long: { exchange: long.exchange, symbol: long.symbol }, short: { exchange: short.exchange, symbol: short.symbol }, identity: perpetualExitIdentity(long, short), quantity: amount(fields.quantity), entryLongPrice: amount(fields.entryLongPrice), entryShortPrice: amount(fields.entryShortPrice), entryFeePaid: amount(fields.entryFeePaid), settledFunding: amount(fields.settledFunding), capital: fields.capital.trim() ? amount(fields.capital) : null, takerOverrides: budget.takerOverrides };
  async function register() {
    if (busy || !active || document.hidden) return;
    try { validatePerpetualExitPosition(input); } catch (cause) { setError((cause as Error).message); return; }
    const registrationKey = JSON.stringify({ mode, fields, input });
    const openedAt = registration.current?.key === registrationKey ? registration.current.openedAt : mode === "paper" ? now : Date.parse(`${fields.openedAt}:00+08:00`);
    if (!Number.isFinite(openedAt) || openedAt > now + 5_000) { setError("请填写有效的开仓北京时间，不能晚于当前时间"); return; }
    if (registration.current?.key !== registrationKey) registration.current = { key: registrationKey, requestId: globalThis.crypto?.randomUUID?.() ?? `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`, openedAt };
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    try {
      const response = await fetch("/api/monitors/perpetual/paper", { signal, cache: "no-store" });
      const state = await response.json() as PerpetualPaperView;
      if (!response.ok || !state.available) throw new Error(state.error || "持仓跟踪暂不可用");
      const saved = await fetch("/api/monitors/perpetual/paper", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ revision: state.revision, action: "create", position: { ...input, mode, requestId: registration.current!.requestId, base: long.base, longKey: `${long.exchange}:${long.symbol}`, shortKey: `${short.exchange}:${short.symbol}`, openedAt, targetNetProfit: fields.targetNetProfit.trim() ? amount(fields.targetNetProfit) : null, maxHoldingHours: fields.maxHoldingHours.trim() ? amount(fields.maxHoldingHours) : null } }) });
      const body = await saved.json() as { error?: string } | null;
      if (!saved.ok) throw new Error(body?.error || "登记失败");
      hubChanged();
      if (!controller.signal.aborted) onRegistered();
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "登记失败"); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <section className="perp-exit-workspace" aria-labelledby={`${id}-heading`}>
    <div className="perp-exit-heading"><div><h4 id={`${id}-heading`}>平仓收益与持仓跟踪</h4><p>多 {long.exchange} {long.symbol} / 空 {short.exchange} {short.symbol}</p></div><span>仅测算与登记</span></div>
    {!supported ? <p className="perp-exit-warning">当前仅支持两腿均以 USDT 计价、以 USDT 抵押的线性合约。此组合暂不登记，避免币种换算造成错误收益。</p> : <>
      <div className="perp-exit-mode" aria-label="登记方式">{([['paper', '模拟仓位'], ['manual', '手工登记已有持仓']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => { if (mode === value) return; setMode(value); setError(""); if (value === "manual") setFields(previous => ({ ...previous, entryLongPrice: "", entryShortPrice: "", entryFeePaid: "" })); }}>{label}</button>)}</div>
      <p className="perp-exit-note">{mode === "paper" ? "默认开仓价格来自当前展开时的快照，仅作模拟起点，不代表实际成交。修改数量或价格后，请同时核对开仓费用。" : "填写两腿实际开仓均价与已付费用；时间按北京时间登记。系统不读取交易账户。"} 数量统一为标的币数量，非合约张数；资金费收入填正数，支出填负数。</p>
      <div className="perp-exit-fields">{([{ key: "quantity", label: `两腿相同数量 / ${long.base}`, required: true }, { key: "entryLongPrice", label: "多腿开仓均价 / USDT", required: true }, { key: "entryShortPrice", label: "空腿开仓均价 / USDT", required: true }, { key: "entryFeePaid", label: "已付开仓费用合计 / USDT", required: true }, { key: "settledFunding", label: "累计已结算资金费 / USDT", required: true }, { key: "capital", label: "两账户投入本金 / USDT" }, { key: "targetNetProfit", label: "目标净收益 / USDT" }, { key: "maxHoldingHours", label: "最长持有时间 / 小时" }] as const).map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}><span>{field.label}</span><input id={`${id}-${field.key}`} type="number" step="any" inputMode="decimal" disabled={busy} value={fields[field.key]} placeholder={'required' in field ? "必填" : "可选"} onChange={event => setFields(previous => ({ ...previous, [field.key]: event.target.value }))}/></label>)}{mode === "manual" ? <label htmlFor={`${id}-opened`}><span>开仓时间 / 北京时间</span><input id={`${id}-opened`} type="datetime-local" disabled={busy} value={fields.openedAt} onChange={event => setFields(previous => ({ ...previous, openedAt: event.target.value }))}/></label> : null}</div>
      <PerpetualExitCheck input={input} active={active} now={now}/>
      <div className="perp-exit-register"><button type="button" disabled={busy || !active} onClick={() => void register()}>{busy ? "正在登记…" : mode === "paper" ? "加入模拟跟踪" : "登记持仓并跟踪"}</button><span>按缓存报价跟踪；深度仅手动查询。资金费需手工更新。</span></div>
      {error ? <p role="alert" className="perp-exit-warning">{error}</p> : null}
    </>}
  </section>;
}

export default memo(function PerpetualExit(props: Props) { return <ExitWorkspace key={perpetualExitIdentity(props.long, props.short)} {...props}/>; });
