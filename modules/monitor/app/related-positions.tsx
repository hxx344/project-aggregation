"use client";

import { useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Link2 } from "lucide-react";
import { hubOpenTrading, POSITIONS_TIMEOUT_MS, useHubHost, useHubPositions, type HubPositionItem, type PositionsMarket } from "../lib/hub-bridge";
import { oilSpreadPairs, type UnpairedReason, type VenueSpreads } from "../lib/related-pairs";

export type { VenueSpreads };
const unpairedText: Record<UnpairedReason, string> = { "same-side": "CL 与 BZ 同向", multiple: "同一交易所有多笔同币种持仓", "missing-leg": "缺少另一条腿" };

const beijing = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijing.format(new Date(value)) : "—";
const finite = (value: string | null) => { if (value === null || value.trim() === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const tone = (value: number | null) => value === null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const signedPercent = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(3)}%`;
const pnlText = (item: HubPositionItem) => {
  const value = finite(item.unrealizedPnl);
  if (value === null || item.unrealizedPnl === null) return "—";
  const raw = item.unrealizedPnl.trim().replace(/^[+-]/, "");
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${raw}${item.pnlCurrency ? ` ${item.pnlCurrency}` : ""}`;
};

function PositionRows({ items }: { items: HubPositionItem[] }) {
  return <ul className="related-positions-list">{items.map(item => { const pnl = finite(item.unrealizedPnl); return <li key={item.key} data-stale={item.stale}>
    <div className="related-position-head"><span className="related-position-source">{item.source} · {item.exchange}</span>{item.stale ? <span className="detail-stale-tag" title={item.updatedAt ? `数据时间 ${clock(item.updatedAt)} 北京时间` : "数据时间未知"}>旧</span> : null}</div>
    <div className="related-position-main"><strong>{item.symbol}</strong><span className={item.side === "long" ? "positive" : "negative"}>{item.side === "long" ? "多" : "空"}</span><span>{item.quantity} {item.quantityUnit}</span></div>
    <dl><div><dt>未实现盈亏</dt><dd className={tone(pnl)}>{pnlText(item)}</dd></div><div><dt>入场价</dt><dd>{item.entryPrice ?? "—"}</dd></div></dl>
  </li>; })}</ul>;
}

export default function RelatedPositions({ market, symbols, active, spreads, variant = "panel", extra }: { market: PositionsMarket; symbols: readonly string[]; active: boolean; spreads?: VenueSpreads; variant?: "panel" | "strip"; extra?: ReactNode }) {
  const host = useHubHost();
  const [open, setOpen] = useState(false);
  const positions = useHubPositions(market, symbols, active);
  const shown = positions.status === "ok" ? positions.items : positions.previous?.items ?? [];
  const pairs = market === "oil" ? oilSpreadPairs(shown, spreads) : [];
  const message = positions.status === "standalone" ? "在工作台中打开可查看关联持仓"
    : positions.status === "connecting" ? "正在连接工作台…"
    : positions.status === "unsupported" ? "持仓不可用：当前工作台未提供持仓查询"
    : positions.status === "empty" ? "无可查询的关联币种"
    : positions.status === "loading" ? "加载中…"
    : positions.status === "unauthorized" ? "未登录工作台，登录后可查看关联持仓"
    : positions.status === "unavailable" ? positions.timedOut ? `持仓不可用：${POSITIONS_TIMEOUT_MS / 1000} 秒内未收到工作台回复，稍后自动重试` : "持仓不可用：工作台暂时无法读取持仓"
    : positions.incomplete && !positions.items.length ? "部分数据源不可用"
    : !positions.items.length ? "无关联持仓" : "";
  const partial = positions.status === "ok" && positions.incomplete && positions.items.length > 0;
  const keptAt = positions.status !== "ok" && positions.previous ? `保留 ${clock(positions.previous.generatedAt)} 的持仓数据` : "";
  const openTrading = <div className="related-positions-actions"><button type="button" className="detail-side-action" disabled={!host.openTrading} onClick={() => hubOpenTrading(market)} title={host.openTrading ? undefined : "当前不在工作台中，或工作台未开放跳转"}>在交易中心查看<ArrowUpRight size={13} aria-hidden="true"/></button>{!host.openTrading ? <small>{host.embedded ? "工作台未开放跳转到交易中心" : "独立打开时不可跳转"}</small> : null}</div>;
  const body = <>
    {message ? <p className={positions.status === "unavailable" || positions.status === "unsupported" || positions.status === "unauthorized" || positions.incomplete ? "detail-side-error" : "detail-side-empty"}>{message}</p> : null}
    {partial ? <p className="detail-side-error">部分数据源不可用，列表可能不完整</p> : null}
    {keptAt ? <p className="detail-side-note">{keptAt}</p> : null}
    {pairs.length ? <ul className="related-spread-pairs">{pairs.map(pair => <li key={pair.key} data-pair-status={pair.status}><span>{pair.label}</span>{pair.status === "paired" ? <dl><div><dt>开仓价差</dt><dd className={tone(pair.opening)}>{signedPercent(pair.opening)}</dd></div><div><dt>当前价差</dt><dd className={tone(pair.current)}>{signedPercent(pair.current)}{pair.current !== null && pair.currentStale ? <span className="detail-stale-tag">旧</span> : null}</dd></div></dl> : <p className="related-unpaired">无法配对 · {unpairedText[pair.reason]}</p>}</li>)}</ul> : null}
    {shown.length ? <PositionRows items={shown}/> : null}
    {pairs.length ? <p className="detail-side-foot">价差 =（BZ − CL）÷ CL，仅在同一交易所 CL 与 BZ 各一笔且方向相反时计算；当前价差取本页交易所报价。</p> : null}
  </>;
  if (variant === "strip") {
    const summary = positions.status === "ok" ? positions.items.length ? `${positions.items.length} 笔关联持仓 · ${clock(positions.generatedAt)}${positions.incomplete ? " · 部分数据源不可用" : ""}` : message : message;
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
