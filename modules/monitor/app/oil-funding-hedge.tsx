"use client";

import { memo, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { calculateOilFundingHedge, type HedgeDirection } from "../lib/oil-funding-hedge";
import { fundingRangeInput, parseFundingRangeInput } from "../lib/exchange-funding-analysis";
import { HISTORY_STALE_MS } from "../lib/exchange-funding-history";
import { useOilHedgeHistory } from "../hooks/use-oil-hedge-history";
import "./oil-funding-hedge.css";

const hour = 3_600_000, day = 24 * hour, pageSize = 48;
type Settings = { from: number; to: number; days: 7 | 30 | 60 | null; rolling: boolean; notional: number; bybitMakerRate: number; binanceMakerRate: number; direction: HedgeDirection };
type Draft = { from: string; to: string; notional: string; bybitMakerRate: string; binanceMakerRate: string };
type HedgeResult = ReturnType<typeof calculateOilFundingHedge>;
type HedgePoint = HedgeResult["points"][number];
const metrics = [
  { key: "funding", label: "累计资金费", color: "var(--positive)", dash: undefined, step: true, line: "绿色实线", formula: "四腿已结算资金费收支合计", note: "未扣手续费；正数收款，负数付款" },
  { key: "fundingNet", label: "扣开仓费后资金费", color: "var(--chart-2)", dash: "7 3", step: true, line: "蓝色长虚线", formula: "累计资金费 − 开仓手续费", note: "未计价格盈亏与平仓手续费" },
  { key: "netPnl", label: "模拟平仓后总盈亏", color: "var(--chart-5)", dash: undefined, step: false, line: "紫色实线", formula: "资金费 + 价格盈亏 − 开平仓手续费", note: "全部手续费已扣；正数盈利，负数亏损" },
  { key: "makerCost", label: "开平仓手续费", color: "var(--warning)", dash: "3 3", step: false, line: "橙色短虚线", formula: "开仓费 + 该时点估算的平仓费", note: "正数为支出，负数为返佣" },
] as const;
const money = (value: number | null | undefined, signed = true, digits = 2) => value == null ? "—" : `${signed && value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const percent = (value: number | null | undefined) => value == null ? "—" : `${money(value, true, 3)}%`;
const tone = (value: number | null | undefined) => value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const stamp = (value: number | string) => fundingRangeInput(typeof value === "number" ? value : Date.parse(value)).replace("T", " ");
const eventStamp = (value: number) => new Date(value + 8 * hour).toISOString().replace("T", " ").slice(0, value % 1000 ? 23 : 19);
const shortStamp = (value: number) => stamp(value).slice(5, 16);
const presetRange = (days: 7 | 30 | 60, now: number) => { const to = Math.floor(now / hour) * hour; return { from: to - days * day + (days === 60 ? hour : 0), to }; };
const defaults = (now: number): Settings => ({ ...presetRange(7, now), days: 7, rolling: true, notional: 10_000, bybitMakerRate: 0.0002, binanceMakerRate: 0.0002, direction: "bybit-long" });
const draftFor = (settings: Settings): Draft => ({ from: fundingRangeInput(settings.from), to: fundingRangeInput(settings.to), notional: String(settings.notional), bybitMakerRate: String(Number((settings.bybitMakerRate * 100).toFixed(6))), binanceMakerRate: String(Number((settings.binanceMakerRate * 100).toFixed(6))) });

function readSettings(now: number): { settings: Settings; notice: string } {
  const initial = defaults(now);
  if (typeof window === "undefined") return { settings: initial, notice: "" };
  const query = new URL(window.location.href).searchParams;
  const settings = { ...initial };
  let invalid = false;
  const number = (key: string, valid: (value: number) => boolean, fallback: number) => {
    if (!query.has(key)) return fallback;
    const raw = query.get(key)!, value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || !valid(value)) { invalid = true; return fallback; }
    return value;
  };
  settings.notional = number("hedgeNotional", value => value > 0 && value <= 1_000_000_000, initial.notional);
  settings.bybitMakerRate = number("hedgeBybitFee", value => value >= -0.001 && value <= 0.01, initial.bybitMakerRate);
  settings.binanceMakerRate = number("hedgeBinanceFee", value => value >= -0.001 && value <= 0.01, initial.binanceMakerRate);
  const direction = query.get("hedgeDirection");
  if (direction === "bybit-long" || direction === "bybit-short") settings.direction = direction;
  else if (direction !== null) invalid = true;
  if (query.has("hedgeFrom") || query.has("hedgeTo")) {
    const from = Number(query.get("hedgeFrom")), to = Number(query.get("hedgeTo"));
    if (query.has("hedgeFrom") && query.has("hedgeTo") && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= Date.UTC(2020, 0, 1) && from % hour === 0 && to % hour === 0 && from < to && to <= Math.floor(now / hour) * hour && to - from <= 60 * day) {
      settings.from = from; settings.to = to; settings.rolling = false;
      const days = Number(query.get("hedgeDays"));
      settings.days = [7, 30, 60].includes(days) && (to - from === days * day || days === 60 && to - from === 60 * day - hour) ? days as Settings["days"] : null;
    } else invalid = true;
  }
  return { settings, notice: invalid ? "链接中的无效模拟参数已回退为默认值；请检查当前参数。" : "" };
}

function writeSettings(settings: Settings, replace = false) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries({ hedgeFrom: settings.from, hedgeTo: settings.to, hedgeNotional: settings.notional, hedgeBybitFee: settings.bybitMakerRate, hedgeBinanceFee: settings.binanceMakerRate, hedgeDirection: settings.direction })) url.searchParams.set(key, String(value));
  if (settings.days) url.searchParams.set("hedgeDays", String(settings.days)); else url.searchParams.delete("hedgeDays");
  if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](null, "", url);
}

function MetricSwatch({ metric }: { metric: typeof metrics[number] }) {
  return <svg className="oil-hedge-swatch" width="28" height="10" viewBox="0 0 28 10" aria-hidden="true" focusable="false"><line x1="0" y1="5" x2="28" y2="5" stroke={metric.color} strokeWidth={metric.key === "netPnl" ? 2.2 : 1.8} strokeDasharray={metric.dash}/></svg>;
}

function HedgeTooltip({ active, payload }: { active?: boolean; payload?: { payload: HedgePoint }[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return <div className="oil-hedge-tooltip"><strong>{eventStamp(point.time)} 北京时间</strong>{metrics.map(metric => <div key={metric.key}><span><MetricSwatch metric={metric}/>{metric.label}</span><b>{money(point[metric.key])} USDT</b></div>)}<small>紫线为扣除全部手续费后的总盈亏；橙线正数表示费用支出。</small></div>;
}

function OilFundingHedge({ active, now }: { active: boolean; now: number }) {
  const id = useId();
  const [initial] = useState(() => readSettings(Date.now()));
  const [selection, setSettings] = useState(initial.settings);
  const nowHour = Math.floor(now / hour) * hour;
  const settings = useMemo(() => selection.rolling && selection.days ? { ...selection, ...presetRange(selection.days, nowHour) } : selection, [selection, nowHour]);
  const [draftState, setDraft] = useState(() => draftFor(initial.settings));
  const [rangeEdited, setRangeEdited] = useState(false);
  const draft = rangeEdited ? draftState : { ...draftState, from: fundingRangeInput(settings.from), to: fundingRangeInput(settings.to) };
  const [notice, setNotice] = useState(initial.notice);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const history = useOilHedgeHistory(active);
  const { prices, bybit, binance } = history;
  const result = useMemo(() => prices && bybit && binance ? calculateOilFundingHedge({ prices, bybit, binance, ...settings }) : null, [prices, bybit, binance, settings]);
  const sourceErrors = Object.values(history.errors).filter(Boolean);
  const fetched = [prices, bybit, binance].filter(value => value !== undefined);
  const sourceLegs = [bybit?.left, bybit?.right, binance?.left, binance?.right, ...(prices?.legs ?? [])].filter(value => value !== undefined);
  const dataTimes = sourceLegs.flatMap(leg => leg.fetchedAt ? [Date.parse(leg.fetchedAt)] : []);
  const oldestData = dataTimes.length ? Math.min(...dataTimes) : null;
  const stale = fetched.some(value => value.status === "snapshot" || Date.parse(value.fetchedAt) < now - HISTORY_STALE_MS) || sourceLegs.some(leg => leg.error || leg.fetchedAt && Date.parse(leg.fetchedAt) < now - HISTORY_STALE_MS) || sourceErrors.length > 0;
  const last = result?.final;
  const pages = Math.max(1, Math.ceil((result?.points.length ?? 0) / pageSize));
  const currentPage = Math.min(page, pages);
  const detailPoints = result?.points.slice().reverse().slice((currentPage - 1) * pageSize, currentPage * pageSize) ?? [];
  const bybitLong = settings.direction === "bybit-long";
  const state = !history.online ? "离线 · 保留已得数据" : !active ? "监控已暂停" : !result ? history.loading ? "正在读取历史数据" : "数据暂不可用" : stale ? "保留数据 · 待更新" : result.status === "complete" ? "所选区间数据可计算" : result.status === "partial" ? "部分数据缺失" : "所选区间无法估值";

  useEffect(() => {
    const restore = () => { const restored = readSettings(Date.now()); setSettings(restored.settings); setDraft(draftFor(restored.settings)); setRangeEdited(false); setNotice(restored.notice); setError(""); setPage(1); };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (settings.rolling && new URL(window.location.href).searchParams.has("hedgeFrom")) writeSettings(settings, true);
  }, [settings]);

  function commit(next: Settings) { setSettings(next); setDraft(draftFor(next)); setRangeEdited(false); setError(""); setNotice(""); setPage(1); writeSettings(next); }
  function chooseDays(days: 7 | 30 | 60) { commit({ ...settings, ...presetRange(days, nowHour), days, rolling: true }); }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const from = parseFundingRangeInput(draft.from), to = parseFundingRangeInput(draft.to);
    if (from === null || to === null || from % hour !== 0 || to % hour !== 0 || from >= to || from < Date.UTC(2020, 0, 1)) { setError("请输入有效的北京时间整点，平仓时间须晚于开仓时间。"); return; }
    if (to > Math.floor(Date.now() / hour) * hour || to - from > 60 * day) { setError("只能模拟已到达的整点，区间最长 60 天。"); return; }
    const notional = Number(draft.notional), bybitMakerRate = Number(draft.bybitMakerRate) / 100, binanceMakerRate = Number(draft.binanceMakerRate) / 100;
    if (!draft.notional.trim() || !Number.isFinite(notional) || notional <= 0 || notional > 1_000_000_000) { setError("四腿总开仓名义金额需大于 0，且不超过 10 亿 USDT。"); return; }
    if (![draft.bybitMakerRate, draft.binanceMakerRate].every(value => value.trim() && Number.isFinite(Number(value)) && Number(value) >= -0.1 && Number(value) <= 1)) { setError("Maker 费率需在 −0.1% 至 1% 之间；负值表示返佣。"); return; }
    commit({ ...settings, from, to, notional, bybitMakerRate, binanceMakerRate, days: rangeEdited ? null : settings.days, rolling: !rangeEdited && settings.rolling });
  }

  return <section className="oil-hedge" aria-labelledby={`${id}-title`} data-oil-hedge="true" data-hedge-status={result?.status ?? "loading"}>
    <div className="oil-hedge-heading"><div><span className="oil-hedge-kicker">BYBIT × BINANCE · BZ / CL</span><h3 id={`${id}-title`}>四腿对冲 · 历史收益模拟</h3><p>固定等桶数持仓，按实际历史结算累计资金费。</p></div><button type="button" className="refresh-button" aria-label="刷新四腿模拟历史" disabled={history.loading || !active || !history.online} onClick={() => void history.refresh()}><RefreshCw size={14} className={history.loading ? "spinning" : ""}/>{history.loading ? "读取中" : "刷新历史"}</button></div>
    <div className="oil-hedge-toolbar"><div className="oil-hedge-shortcuts" aria-label="四腿模拟时间范围">{([7, 30, 60] as const).map(days => <button key={days} type="button" aria-pressed={settings.days === days} onClick={() => chooseDays(days)}>最近 {days} 天</button>)}</div><div className="oil-hedge-direction" aria-label="四腿持仓方向"><button type="button" aria-pressed={bybitLong} onClick={() => commit({ ...settings, direction: "bybit-long" })}>Bybit 多 BZ / 空 CL</button><button type="button" aria-pressed={!bybitLong} onClick={() => commit({ ...settings, direction: "bybit-short" })}>Bybit 空 BZ / 多 CL</button></div></div>
    <p className="oil-hedge-position">Bybit {bybitLong ? "多 BZ、空 CL" : "空 BZ、多 CL"} · Binance {bybitLong ? "空 BZ、多 CL" : "多 BZ、空 CL"}<span data-hedge-range-mode={settings.rolling ? "rolling" : "fixed"} data-hedge-from={settings.from} data-hedge-to={settings.to}>{stamp(settings.from)} → {stamp(settings.to)} 北京时间 · {settings.rolling ? "随整点滚动" : "固定区间"}</span></p>
    <details className="oil-hedge-settings"><summary>模拟参数 <span>四腿总名义 {money(settings.notional, false, 0)} USDT · Maker：Bybit {percent(settings.bybitMakerRate * 100)} / Binance {percent(settings.binanceMakerRate * 100)}</span></summary><form onSubmit={apply} noValidate>
      <label>开仓（北京时间整点）<input type="datetime-local" step="3600" value={draft.from} onChange={event => { setRangeEdited(true); setDraft({ ...draft, from: event.target.value }); }}/></label>
      <label>平仓（北京时间整点）<input type="datetime-local" step="3600" value={draft.to} onChange={event => { setRangeEdited(true); setDraft({ ...draft, to: event.target.value }); }}/></label>
      <label>四腿总开仓名义（USDT）<input type="number" min="0.01" max="1000000000" step="any" inputMode="decimal" value={draft.notional} onChange={event => setDraft(old => ({ ...old, notional: event.target.value }))}/></label>
      <label>Bybit Maker 费率（%）<input type="number" min="-0.1" max="1" step="0.001" inputMode="decimal" value={draft.bybitMakerRate} onChange={event => setDraft(old => ({ ...old, bybitMakerRate: event.target.value }))}/></label>
      <label>Binance Maker 费率（%）<input type="number" min="-0.1" max="1" step="0.001" inputMode="decimal" value={draft.binanceMakerRate} onChange={event => setDraft(old => ({ ...old, binanceMakerRate: event.target.value }))}/></label>
      <div className="oil-hedge-form-actions"><button type="submit">应用模拟参数</button><button type="button" onClick={() => commit(defaults(Date.now()))}>恢复默认</button></div>
      <p>默认两家均为 0.02%，仅为可编辑的模拟假设，非账户真实费率；负值表示返佣。开平仓均假设全部按 maker 成交。快捷区间随整点滚动；手动修改起止时间后固定，未应用的编辑保留。</p>
      {error ? <p className="oil-hedge-error" role="alert">{error}</p> : null}
    </form></details>
    {notice ? <p className="oil-hedge-notice" role="status">{notice}</p> : null}
    <div className="oil-hedge-status" role="status"><strong className={stale || !history.online || result?.status !== "complete" ? "oil-hedge-warning" : "positive"}>{state}</strong><span>资金费区间：开仓后至平仓时（含终点） · 正收益为收款</span></div>
    {oldestData !== null ? <p className="oil-hedge-source-time" data-hedge-updated={oldestData}>已得各腿数据最早采集：{stamp(oldestData)} 北京时间；逐腿时间见下方口径。</p> : null}
    {sourceErrors.length ? <p className="oil-hedge-notice">{sourceErrors.join(" ")}</p> : null}
    {result?.warnings.length ? <p className="oil-hedge-notice" data-hedge-warning="true">{result.warnings.join(" ")}</p> : null}
    <div className="oil-hedge-kpis">{metrics.map(metric => <article key={metric.key} data-hedge-metric={metric.key}><span><MetricSwatch metric={metric}/>{metric.label}</span><strong className={metric.key === "makerCost" ? "oil-hedge-cost" : tone(last?.[metric.key])}>{money(last?.[metric.key])}<small>USDT</small></strong><p>{metric.note}</p></article>)}</div>
    <div className="oil-hedge-reading" id={`${id}-reading`}><strong>整体赚亏看紫线</strong><span>高于 0 为估算盈利，低于 0 为估算亏损，已计价格变化和全部手续费。橙线是费用，正数表示支出。</span></div>
    <ul className="oil-hedge-legend" aria-label="四条曲线含义" id={`${id}-legend`}>{metrics.map(metric => <li key={metric.key}><div><MetricSwatch metric={metric}/><strong>{metric.label}</strong></div><span>{metric.line}</span><p>{metric.formula}</p></li>)}</ul>
    <div className="oil-hedge-chart-meta"><span>金额（USDT）</span><span>北京时间 · 缺失保留断点</span></div>
    <div className="oil-hedge-chart" role="group" aria-label="四腿模拟收益与 maker 成本曲线，详细金额见下方数值明细" aria-describedby={`${id}-reading ${id}-legend`}>
      {result?.points.some(point => metrics.some(metric => point[metric.key] !== null)) ? <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 900, height: 300 }}><LineChart data={result.points} margin={{ top: 12, right: 10, left: 0, bottom: 6 }} accessibilityLayer>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="time" type="number" domain={[settings.from, settings.to]} tickFormatter={shortStamp} minTickGap={70} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{ fontSize: 11 }}/><YAxis orientation="right" width={70} tickFormatter={value => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]} stroke="var(--muted-foreground)" axisLine={false} tickLine={false} tick={{ fontSize: 11 }}/><ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4" label={{ value: "0 · 盈亏分界", position: "insideBottomLeft", fill: "var(--muted-foreground)", fontSize: 11 }}/><Tooltip content={<HedgeTooltip/>} wrapperStyle={{ maxWidth: "100%" }}/>
        {metrics.map(metric => <Line key={metric.key} dataKey={metric.key} name={metric.label} type={metric.step ? "stepAfter" : "linear"} stroke={metric.color} strokeWidth={metric.key === "netPnl" ? 2.2 : 1.8} strokeDasharray={metric.dash} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false}/>)}
      </LineChart></ResponsiveContainer> : <div className="oil-hedge-empty"><strong>{history.loading ? "正在读取四腿历史…" : "所选区间暂无可用估值"}</strong><p>需要四腿开仓价格与历史结算数据；缺失值不按零计算。</p></div>}
    </div>
    <p className="oil-hedge-chart-note">绿线、蓝线在资金费结算时变化；紫线另计每小时标记价格变化。橙线只计一次开仓费，并按各时点重估平仓费，不随时间重复累加。估值采用小时标记价格近似，缺失数据保留断点。</p>
    <div className="oil-hedge-entry" aria-label="开仓点差与成本"><div><span>Bybit BZ / CL 开仓点差</span><strong data-hedge-entry="bybit">{percent(result?.entry?.bybitSpreadPct)}</strong></div><div><span>Binance BZ / CL 开仓点差</span><strong data-hedge-entry="binance">{percent(result?.entry?.binanceSpreadPct)}</strong></div><div><span>Bybit − Binance 点差差</span><strong>{money(result?.entry?.spreadDifferencePp, true, 3)}<small>百分点</small></strong></div><div><span>四腿有向开仓价差</span><strong>{money(result?.entry?.hedgeEntryValue)}<small>USDT</small></strong></div><div><span>BZ 跨所开仓点差</span><strong>{percent(result?.entry?.bzCrossPct)}</strong></div><div><span>CL 跨所开仓点差</span><strong>{percent(result?.entry?.clCrossPct)}</strong></div></div>
    <p className="oil-hedge-entry-note">平台内点差 =（BZ − CL）÷ CL；跨所点差为 Binance 相对 Bybit 的同品种价格差百分比。有向开仓价差 = 空腿开仓名义 − 多腿开仓名义，正值表示该方向开仓价差有利，不另记作收入。固定每腿 {money(result?.quantity, false, 6)} 桶；四腿开仓费合计 {money(result?.openingFee)} USDT。</p>
    <details className="oil-hedge-details"><summary>各腿名义、手续费与资金费 <span>四腿固定数量 · 不调仓</span></summary><div className="oil-hedge-table-scroll" tabIndex={0} role="region" aria-label="四腿开仓及费用明细"><table className="oil-hedge-table"><thead><tr><th scope="col">交易所 / 合约 / 方向</th><th scope="col">开仓价</th><th scope="col">开仓名义</th><th scope="col">Maker 费率</th><th scope="col">开仓费</th><th scope="col">模拟平仓费</th><th scope="col">累计资金费</th><th scope="col">结算次数</th><th scope="col">价格盈亏</th></tr></thead><tbody>{result?.legs.map(leg => <tr key={leg.id} data-hedge-leg={leg.id}><th scope="row">{leg.exchange === "bybit" ? "Bybit" : "Binance"} · {leg.symbol}<span>{leg.side === "long" ? "做多" : "做空"}</span></th><td>{money(leg.entryPrice, false, 4)}</td><td>{money(leg.entryNotional, false)}</td><td>{percent((leg.exchange === "bybit" ? settings.bybitMakerRate : settings.binanceMakerRate) * 100)}</td><td>{money(leg.openingFee)}</td><td>{money(leg.closingFee)}</td><td className={tone(leg.funding)}>{money(leg.funding)}{leg.funding === null && leg.settlements > 0 ? <small>已知部分 {money(leg.knownFunding)}</small> : null}</td><td>{leg.settlements}</td><td className={tone(leg.pricePnl)}>{money(leg.pricePnl)}</td></tr>) ?? <tr><td colSpan={9}>正在等待历史数据。</td></tr>}</tbody></table></div><p>除费率、次数与数量外均为 USDT；价格单位为 USDT / 桶。各腿独立结算，未配对为同一资金费时点。</p></details>
    <details className="oil-hedge-details"><summary>曲线数值明细 <span>每小时及实际结算时点 · 支持键盘与触摸查看</span></summary><div className="oil-hedge-table-scroll" tabIndex={0} role="region" aria-label="四腿模拟曲线数值"><table className="oil-hedge-table"><thead><tr><th scope="col">北京时间</th>{metrics.map(metric => <th scope="col" key={metric.key}>{metric.label}（USDT）</th>)}</tr></thead><tbody>{detailPoints.length ? detailPoints.map(point => <tr key={point.time}><th scope="row"><time dateTime={new Date(point.time).toISOString()} title={new Date(point.time).toISOString()}>{eventStamp(point.time)}</time></th>{metrics.map(metric => <td key={metric.key}>{money(point[metric.key])}</td>)}</tr>) : <tr><td colSpan={5}>暂无数值。</td></tr>}</tbody></table></div><nav className="oil-hedge-pagination" aria-label="四腿模拟数值分页"><span>第 {currentPage} / {pages} 页 · {result?.points.length ?? 0} 个时点 · 最新在前</span><div><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></nav></details>
    <details className="oil-hedge-details"><summary>估值口径与数据时间</summary><div className="oil-hedge-method"><p>四腿使用相同桶数，数量 = 四腿总开仓名义 ÷ 四个开仓价之和；总名义不是保证金。资金费收入 = 空腿数量 × 结算估值 × 费率 − 多腿数量 × 结算估值 × 费率。使用实际历史结算，不由当前费率或年化倒推。</p><p>扣开仓费后资金费 = 累计资金费 − 四腿开仓费。模拟平仓后总盈亏 = 累计资金费 + 四腿价格盈亏 − 开平仓手续费；开仓费只扣一次。终点结算后模拟平仓；相邻结算间资金费保持不变。</p><p>价格来自两家交易所小时 mark K 线开盘价，结算时使用所在小时的价格作近似，非真实成交价。未计滑点、盘口冲击、保证金利息或强平，持仓数量固定，不调仓、不自动优化。本面板仅作历史模拟。查询覆盖不能证明上游结算记录没有遗漏。</p><p>参数保存在链接的 hedge* 字段，可复制地址复现；无效参数回退到默认设置。最近 60 天按可用整点向内取整，实际起止以上方为准。刷新每 5 分钟进行，页面隐藏、断网或监控暂停时停止读取。</p><ul>{([['Bybit 资金费', bybit], ['Binance 资金费', binance], ['四腿小时 mark 价格', prices]] as const).map(([label, source]) => <li key={label}>{label}：{source ? `${stamp(source.fetchedAt)} 北京时间${source.status === "snapshot" ? " · 备用数据" : ""}` : "尚未取得"}</li>)}</ul>{[bybit, binance].flatMap(source => source ? (["left", "right"] as const).map(side => { const leg = source[side]; return <p key={`${source.exchange}-${side}`}>{source.exchange === "bybit" ? "Bybit" : "Binance"} {leg.symbol} 资金费采集：{leg.fetchedAt ? stamp(leg.fetchedAt) : "未知"}；查询覆盖：{leg.coverage ? `${stamp(leg.coverage.from)} → ${stamp(leg.coverage.to)}` : "未知"} 北京时间{leg.error ? ` · ${leg.error}` : ""}</p>; }) : [])}{prices?.legs.map(leg => <p key={`${leg.exchange}-${leg.symbol}`}>{leg.exchange === "bybit" ? "Bybit" : "Binance"} {leg.symbol} 价格采集：{leg.fetchedAt ? stamp(leg.fetchedAt) : "未知"}；查询覆盖：{leg.coverage ? `${stamp(leg.coverage.from)} → ${stamp(leg.coverage.to)}` : "未知"} 北京时间{leg.error ? ` · ${leg.error}` : ""}</p>)}</div></details>
  </section>;
}

export default memo(OilFundingHedge);
