"use client";

import { useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Link2 } from "lucide-react";
import { hubOpenTrading, POSITIONS_TIMEOUT_MS, useHubHost, useHubPositions, type HubPositionItem, type PositionsMarket } from "../lib/hub-bridge";
import { pairedMarket, relatedSpreadPairs, type RealizedStatus, type SpreadPair, type UnpairedReason, type VenueSpreads } from "../lib/related-pairs";
import type { SpreadMarket } from "../lib/exchange-quotes";

export type { VenueSpreads };
const unpairedText = (market: PositionsMarket): Record<UnpairedReason, string> => ({ "same-side": market === "hynix" ? "ADR 与正股同向" : "CL 与 BZ 同向", multiple: "同一交易所有多笔同币种持仓", "missing-leg": "缺少另一条腿" });
const totalsFoot = "平仓价差用两腿本轮平仓均价按同一公式计算。组合盈亏为两腿相加：未实现取当前持仓，已实现取各腿本轮（自仓位从零开仓起）已平仓部分，总盈亏 = 未实现 + 已实现净额；币种不同不合并。";
const pairFoot: Record<SpreadMarket, string> = {
  oil: `价差 =（BZ − CL）÷ CL，仅在同一交易所 CL 与 BZ 各一笔且方向相反时计算；当前价差取本页交易所报价。${totalsFoot}`,
  hynix: `价差 = ADR ÷（正股 ÷ 10）− 1，10 份 ADR 对 1 股正股；仅在同一交易所 ADR 与正股各一笔且方向相反时计算；当前价差取本页交易所报价，无报价的交易所显示 —。${totalsFoot}`,
};

const beijing = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const beijingDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const clock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijing.format(new Date(value)) : "—";
const dateClock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijingDate.format(new Date(value)) : "—";
const finite = (value: string | null) => { if (value === null || value.trim() === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const tone = (value: number | null) => value === null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const sign = (value: number) => value > 0 ? "+" : value < 0 ? "−" : "";
const signedPercent = (value: number | null) => value === null ? "—" : `${sign(Number(value.toFixed(3)))}${Math.abs(value).toFixed(3)}%`;
const signedPoints = (value: number | null) => value === null ? "—" : `${sign(Number(value.toFixed(3)))}${Math.abs(value).toFixed(3)} 百分点`;
const moneyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Sign and tone follow the rounded text, so a tiny loss never shows as "−0.00" in red. */
const money = (value: number | null, currency: string | null) => {
  if (value === null) return { text: "—", tone: "" };
  const digits = moneyFormat.format(Math.abs(value)), shown = /[1-9]/.test(digits) ? value : 0;
  return { text: `${sign(shown)}${digits}${currency ? ` ${currency}` : ""}`, tone: tone(shown) };
};
const MoneyCell = ({ label, value, currency, title, children }: { label: string; value: number | null; currency: string | null; title?: string; children?: ReactNode }) => {
  const view = money(value, currency);
  return <div><dt title={title}>{label}</dt><dd className={view.tone}>{view.text}{children}</dd></div>;
};
const priceLarge = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }), priceSmall = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const priceText = (value: string | null) => { const number = finite(value); return number === null ? value ?? "—" : (Math.abs(number) >= 1 ? priceLarge : priceSmall).format(number); };

function CycleSummary({ item }: { item: HubPositionItem }) {
  const cycle = item.cycle;
  if (!cycle) return null;
  if (cycle.status === "loading") return <p className="related-cycle-note">本轮平仓统计中…</p>;
  if (cycle.status === "unavailable") return <p className="related-cycle-note">本轮平仓：{cycle.note ?? "暂不可用"}</p>;
  const amount = (label: string, value: string | null) => <MoneyCell label={label} value={finite(value)} currency={cycle.currency}/>;
  return <div className="related-cycle" data-cycle-status={cycle.status}>
    <div className="related-cycle-head"><span>本轮已平仓</span><span>{cycle.since ? `${dateClock(cycle.since)} 开仓 · ` : ""}{clock(cycle.updatedAt)} 统计{cycle.status === "partial" ? "（不完整）" : ""}</span></div>
    <dl>
      <div><dt>平仓数量</dt><dd>{cycle.closedQuantity === null ? "—" : `${cycle.closedQuantity} ${item.quantityUnit}`}</dd></div>
      <div><dt>平仓均价</dt><dd>{priceText(cycle.closePrice)}</dd></div>
      {amount("已实现盈亏", cycle.realizedPnl)}{amount("手续费", cycle.fees)}{amount("资金费", cycle.funding)}{amount("净额", cycle.net)}
    </dl>
    {cycle.note ? <p className="related-cycle-note">{cycle.note}</p> : null}
  </div>;
}

const realizedNote: Partial<Record<RealizedStatus, string>> = {
  loading: "已实现部分统计中…",
  unavailable: "已实现部分暂不可用：至少一条腿的本轮平仓统计不可用",
  "mixed-currency": "两腿已实现结算币种不同，不合并",
};

function PairDetail({ pair }: { pair: Extract<SpreadPair, { status: "paired" }> }) {
  const totals = pair.totals;
  const changeTone = pair.change === null || Number(pair.change.toFixed(3)) === 0 ? "" : (pair.change < 0) === pair.narrowingFavors ? "positive" : "negative";
  const totalsNote = realizedNote[totals.realizedStatus] ?? (totals.unrealized === null && totals.unrealizedCurrency === null ? "两腿未实现盈亏币种不同，不合并" : "");
  return <>
    <dl>
      <div><dt>开仓价差</dt><dd className={tone(pair.opening)}>{signedPercent(pair.opening)}</dd></div>
      <div><dt>当前价差</dt><dd className={tone(pair.current)}>{signedPercent(pair.current)}{pair.current !== null && pair.currentStale ? <span className="detail-stale-tag">旧</span> : null}</dd></div>
      <div><dt>平仓价差</dt><dd className={tone(pair.closing)}>{signedPercent(pair.closing)}</dd></div>
      <div><dt title="当前价差 − 开仓价差；绿色表示对本组合有利">价差变化</dt><dd className={changeTone}>{signedPoints(pair.change)}</dd></div>
    </dl>
    <div className="related-pair-totals" data-pair-totals={totals.realizedStatus}>
      <div className="related-cycle-head"><span>组合盈亏</span>{totals.realizedStatus === "partial" ? <span>已实现不完整</span> : null}</div>
      <dl>
        <MoneyCell label="未实现盈亏" value={totals.unrealized} currency={totals.unrealizedCurrency}>{totals.unrealized !== null && totals.unrealizedStale ? <span className="detail-stale-tag">旧</span> : null}</MoneyCell>
        <MoneyCell label="已实现盈亏" value={totals.realized} currency={totals.realizedCurrency}/>
        <MoneyCell label="手续费" value={totals.fees} currency={totals.realizedCurrency}/>
        <MoneyCell label="资金费" value={totals.funding} currency={totals.realizedCurrency}/>
        <MoneyCell label="已实现净额" value={totals.net} currency={totals.realizedCurrency} title="已实现盈亏 + 手续费 + 资金费"/>
        <MoneyCell label="总盈亏" value={totals.total} currency={totals.unrealizedCurrency} title="未实现盈亏 + 已实现净额"/>
      </dl>
      {totalsNote ? <p className="related-cycle-note">{totalsNote}</p> : null}
    </div>
  </>;
}

function PositionRows({ items }: { items: HubPositionItem[] }) {
  return <ul className="related-positions-list">{items.map(item => <li key={item.key} data-stale={item.stale}>
    <div className="related-position-head"><span className="related-position-source">{item.source} · {item.exchange}</span>{item.stale ? <span className="detail-stale-tag" title={item.updatedAt ? `数据时间 ${clock(item.updatedAt)} 北京时间` : "数据时间未知"}>旧</span> : null}</div>
    <div className="related-position-main"><strong>{item.symbol}</strong><span className={item.side === "long" ? "positive" : "negative"}>{item.side === "long" ? "多" : "空"}</span><span>{item.quantity} {item.quantityUnit}</span></div>
    <dl><MoneyCell label="未实现盈亏" value={finite(item.unrealizedPnl)} currency={item.pnlCurrency}/><div><dt>入场价</dt><dd>{priceText(item.entryPrice)}</dd></div></dl>
    <CycleSummary item={item}/>
  </li>)}</ul>;
}

export default function RelatedPositions({ market, symbols, active, spreads, variant = "panel", extra }: { market: PositionsMarket; symbols: readonly string[]; active: boolean; spreads?: VenueSpreads; variant?: "panel" | "strip"; extra?: ReactNode }) {
  const host = useHubHost();
  const [open, setOpen] = useState(false);
  const positions = useHubPositions(market, symbols, active);
  const snapshot = positions.status === "ok" ? positions : positions.previous;
  const shown = snapshot?.items ?? [];
  const incomplete = snapshot?.incomplete === true;
  const sourcesIncomplete = snapshot?.sourcesIncomplete === true;
  const range = snapshot?.truncated ? `仅显示前 ${snapshot.itemLimit} 条（${sourcesIncomplete ? "已读取部分中共" : "共"} ${snapshot.matchedCount} 条匹配）` : "";
  const pairMarket = pairedMarket(market) ? market : null;
  const pairs = pairMarket ? relatedSpreadPairs(pairMarket, shown, spreads, incomplete) : [];
  const message = positions.status === "standalone" ? "在工作台中打开可查看关联持仓"
    : positions.status === "connecting" ? "正在连接工作台…"
    : positions.status === "unsupported" ? "持仓不可用：当前工作台未提供持仓查询"
    : positions.status === "empty" ? "无可查询的关联币种"
    : positions.status === "loading" ? "加载中…"
    : positions.status === "unauthorized" ? "未登录工作台，登录后可查看关联持仓"
    : positions.status === "unavailable" ? positions.timedOut ? `持仓不可用：${POSITIONS_TIMEOUT_MS / 1000} 秒内未收到工作台回复，稍后自动重试` : "持仓不可用：工作台暂时无法读取持仓"
    : positions.incomplete && !positions.items.length ? "部分数据源不可用"
    : !positions.items.length ? "无关联持仓" : "";
  const partial = sourcesIncomplete && shown.length > 0;
  const keptAt = positions.status !== "ok" && positions.previous ? `保留 ${clock(positions.previous.generatedAt)} 的持仓数据` : "";
  const openTrading = <div className="related-positions-actions"><button type="button" className="detail-side-action" disabled={!host.openTrading} onClick={() => hubOpenTrading(market)} title={host.openTrading ? undefined : "当前不在工作台中，或工作台未开放跳转"}>在交易中心查看<ArrowUpRight size={13} aria-hidden="true"/></button>{!host.openTrading ? <small>{host.embedded ? "工作台未开放跳转到交易中心" : "独立打开时不可跳转"}</small> : null}</div>;
  const body = <>
    {message ? <p className={positions.status === "unavailable" || positions.status === "unsupported" || positions.status === "unauthorized" || positions.incomplete ? "detail-side-error" : "detail-side-empty"}>{message}</p> : null}
    {partial ? <p className="detail-side-error">部分数据源不可用，列表可能不完整</p> : null}
    {range ? <p className="detail-side-error">{range}</p> : null}
    {pairMarket && incomplete && shown.length ? <p className="detail-side-note">持仓列表不完整，暂不确认配对</p> : null}
    {keptAt ? <p className="detail-side-note">{keptAt}</p> : null}
    {pairs.length ? <ul className="related-spread-pairs">{pairs.map(pair => <li key={pair.key} data-pair-status={pair.status}><span>{pair.label}</span>{pair.status === "paired" ? <PairDetail pair={pair}/> : <p className="related-unpaired">无法配对 · {unpairedText(market)[pair.reason]}</p>}</li>)}</ul> : null}
    {shown.length ? <PositionRows items={shown}/> : null}
    {pairMarket && pairs.length ? <p className="detail-side-foot">{pairFoot[pairMarket]}</p> : null}
  </>;
  if (variant === "strip") {
    const summary = positions.status === "ok" ? positions.items.length ? `${range || `${positions.items.length} 笔关联持仓`} · ${clock(positions.generatedAt)}${sourcesIncomplete ? " · 部分数据源不可用" : ""}` : message : message;
    return <section className="related-positions related-positions-strip" data-related-positions={market} data-status={positions.status}>
      <div className="related-strip-bar"><button type="button" className="related-strip-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Link2 size={14} aria-hidden="true"/><strong>关联交易</strong><span>{summary}</span><ChevronDown size={13} aria-hidden="true" className={open ? "rotated" : ""}/></button>{extra}{openTrading}</div>
      {open ? <div className="related-strip-body">{body}</div> : null}
    </section>;
  }
  return <section className="detail-side-panel related-positions related-positions-panel" data-related-positions={market} data-status={positions.status}>
    <div className="detail-side-heading"><h2><Link2 size={15} aria-hidden="true"/>关联交易</h2>{positions.status === "ok" && positions.generatedAt ? <span className="detail-side-meta">{clock(positions.generatedAt)}</span> : null}</div>
    {body}
    {openTrading}
  </section>;
}
