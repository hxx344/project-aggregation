import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PerpetualQuote } from "../lib/perpetual-types";
import { normalizedFunding8h } from "../lib/perpetual-spreads";
import { fundingWindowTotal, PERPETUAL_FUNDING_STALE_MS, type FundingWindowTotal, type PerpetualFundingLeg } from "../lib/perpetual-funding-history";
import { PERPETUAL_MARKET_METRICS_STALE_MS, type PerpetualMarketMetricsLeg } from "../lib/perpetual-market-metrics";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export const scannerPercent = (value: number | null, digits = 4) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
export const scannerPolarity = (value: number | null) => value !== null && value > 0 ? "positive" : value !== null && value < 0 ? "negative" : "";
const exchangeMarks: Record<string, string> = { binance: "B", bybit: "By", okx: "OK", bitget: "Bg", gate: "G", kraken: "Kr", lighter: "L", "rh-lighter": "RH", hyperliquid: "H", aster: "A", entropy: "E" };

export function ScannerMenu({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <details name="perpetual-scanner-menu" className={`scanner-menu ${className}`} onKeyDown={event => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}><summary>{label}</summary><div className="scanner-menu-content">{children}</div></details>;
}

export function ScannerLeg({ quote, name, side, now }: { quote: PerpetualQuote; name: string; side: "long" | "short"; now: number }) {
  const delistingAt = quote.delistingAt;
  const notice = quote.delisting ? delistingAt && Number.isFinite(delistingAt) ? `${now >= delistingAt ? "已到下架时间" : "即将下架"}：${dateFormat.format(delistingAt)} 北京时间` : "即将下架，时间待公布" : "";
  return <div className={`scanner-leg perp-${side}`}>
    <span className={`scanner-side ${side}`} title={side === "long" ? "做多 · 买入" : "做空 · 卖出"}>{side === "long" ? "多" : "空"}</span>
    <span className="scanner-venue-mark" data-exchange={quote.exchange} aria-hidden="true">{exchangeMarks[quote.exchange] ?? name.slice(0, 2)}</span>
    <strong>{name}</strong><small className="scanner-symbol" title={quote.symbol}>{quote.symbol}</small>
    {notice ? <span className="scanner-delisting" title={notice}>下架<small>{notice}</small></span> : null}
  </div>;
}

export function ScannerFundingRate({ quote, now }: { quote: PerpetualQuote; now: number }) {
  const valid = normalizedFunding8h(quote, now) !== null;
  const rate = valid ? quote.fundingRate! * 100 : null;
  const next = quote.nextFundingAt;
  const remaining = next && Number.isFinite(next) && next > now ? Math.ceil((next - now) / 60_000) : null;
  const until = remaining === null ? "待更新" : remaining >= 60 ? `${Math.floor(remaining / 60)}h${String(remaining % 60).padStart(2, "0")}m` : `${remaining}m`;
  return <div className="scanner-funding-rate">
    <span className={`scanner-value ${scannerPolarity(rate)}`} title={valid ? "当前资金费率，按交易所原周期" : "资金费缺失或超过 5 分钟未更新"}>{scannerPercent(rate)}</span>
    <small>{quote.fundingIntervalHours && Number.isFinite(quote.fundingIntervalHours) ? `${quote.fundingIntervalHours}h` : "—"}</small>
    <time dateTime={remaining === null ? undefined : new Date(next!).toISOString()} title={remaining === null ? "下次结算时间待更新" : `下次结算 ${dateFormat.format(next!)} 北京时间`}>{until}</time>
  </div>;
}

export function ScannerHistory({ long, short, now, hours = 24, total }: { long: PerpetualFundingLeg | undefined; short: PerpetualFundingLeg | undefined; now: number; hours?: FundingWindowTotal["hours"]; total?: FundingWindowTotal | null }) {
  const source = total === undefined ? fundingWindowTotal(long, short, hours, now) : total ?? fundingWindowTotal(undefined, undefined, hours, now);
  const value: FundingWindowTotal = source.status === "ready" && (source.asOf === null || source.asOf > now + 5_000 || now - source.asOf > PERPETUAL_FUNDING_STALE_MS)
    ? { ...source, status: "stale", reason: "历史已过期，保留上次累计" } : source;
  const labels = { pending: "采集中", partial: "历史不足", stale: "已过期", error: "更新失败", unsupported: "不支持", ready: "" };
  return <div className="scanner-history" data-history-hours={hours} title={`已结算资金费净累计 = 空腿 − 多腿；单腿等名义本金${value.asOf === null ? "" : `；截止 ${dateFormat.format(value.asOf)} 北京时间`}。${value.reason}`}>
    <strong className={scannerPolarity(value.netPercent)}>{scannerPercent(value.netPercent)}</strong>
    {value.status !== "ready" ? <small>{labels[value.status]}</small> : null}
  </div>;
}

const amountFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const exactAmountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
function ScannerMetricEvidence({ anchor, id, label, onClose, children }: { anchor: HTMLButtonElement; id: string; label: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // The portal also keeps the fixed fallback outside the table's clipping area.
    if (typeof panel.showPopover === "function") panel.showPopover();
    else panel.removeAttribute("popover");
    const viewport = window.visualViewport;
    const position = () => {
      const margin = 12, gap = 8;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      panel.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      panel.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const trigger = anchor.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      const x = width <= 700 ? left + (width - bounds.width) / 2 : Math.max(left + margin, Math.min(trigger.right - bounds.width, left + width - bounds.width - margin));
      const below = trigger.bottom + gap;
      const y = width <= 700 ? top + height - bounds.height - margin : below + bounds.height <= top + height - margin ? below : trigger.top - bounds.height - gap;
      panel.style.left = `${x}px`;
      panel.style.top = `${Math.max(top + margin, Math.min(y, top + height - bounds.height - margin))}px`;
    };
    let frame = 0;
    const schedulePosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.focus({ preventScroll: true });
    };
    position();
    panel.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    viewport?.addEventListener("resize", schedulePosition);
    viewport?.addEventListener("scroll", schedulePosition);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape, true);
    const observer = new ResizeObserver(schedulePosition);
    observer.observe(panel);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      viewport?.removeEventListener("resize", schedulePosition);
      viewport?.removeEventListener("scroll", schedulePosition);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={panelRef} id={id} className="scanner-metric-evidence" popover="auto" role="dialog" aria-label={label} onToggle={event => {
    if (event.newState === "closed") onClose();
  }}>
    <button type="button" className="scanner-metric-close" aria-label="收起指标来源" onClick={() => { onClose(); anchor.focus({ preventScroll: true }); }}>关闭</button>
    {children}
  </div>, anchor.closest(".perp-scanner") ?? document.body);
}

function ScannerMetricLeg({ leg, metricName, side, now }: { leg: PerpetualMarketMetricsLeg | undefined; metricName: "volume24h" | "openInterest"; side: "多" | "空"; now: number }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const evidenceId = useId();
  const closeEvidence = useCallback(() => setAnchor(null), []);
  const metric = leg?.[metricName];
  const value = metric?.value ?? null;
  const issue = metric?.error || (leg?.status === "error" && !leg.volume24h.error && !leg.openInterest.error ? leg.error : "");
  const observedAt = metric?.observedAt ?? null;
  const stale = observedAt !== null && (observedAt > now + 5_000 || now - observedAt > PERPETUAL_MARKET_METRICS_STALE_MS);
  const state = leg?.status === "unsupported" ? "不支持" : value === null ? !leg || leg.status === "pending" ? "采集中" : leg.status === "error" ? "更新失败" : "暂无数据" : issue ? "更新失败" : stale ? "已过期" : "";
  const label = metricName === "volume24h" ? "24h 成交额" : "持仓金额";
  return <div className="scanner-metric" data-metric={metricName} data-side={side}>
    <button type="button" className="scanner-metric-trigger" aria-haspopup="dialog" aria-expanded={anchor !== null} aria-controls={anchor ? evidenceId : undefined}
      aria-label={`${side}腿${label}，${value === null ? "暂无数据" : `${exactAmountFormat.format(value)} ${metric?.currency}`}，${state || "查看来源时间"}`}
      onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      <span>{value === null ? "—" : amountFormat.format(value)}</span>{value !== null ? <small>{metric?.currency}</small> : null}
      {state ? <span className={`scanner-metric-state${value !== null ? " scanner-stale" : ""}`}>{state}</span> : null}
    </button>
    {anchor ? <ScannerMetricEvidence anchor={anchor} id={evidenceId} label={`${side}腿${label}来源`} onClose={closeEvidence}>
      <strong>{side}腿 · {label}</strong>
      <p>{value === null ? "—" : `${exactAmountFormat.format(value)} ${metric?.currency}`}</p>
      <p>来源：{metric?.source || "等待来源"}</p>
      <p>源时间：{observedAt === null ? "—" : <time dateTime={new Date(observedAt).toISOString()}>{dateFormat.format(observedAt)} 北京时间</time>}</p>
      {state ? <p>{state}{issue ? `：${issue}` : leg?.status === "unsupported" && leg.error ? `：${leg.error}` : ""}</p> : null}
    </ScannerMetricEvidence> : null}
  </div>;
}

export function ScannerMarketMetric({ long, short, metricName, now }: { long: PerpetualMarketMetricsLeg | undefined; short: PerpetualMarketMetricsLeg | undefined; metricName: "volume24h" | "openInterest"; now: number }) {
  return <div className="scanner-stack scanner-market-metric"><ScannerMetricLeg leg={long} metricName={metricName} side="多" now={now}/><ScannerMetricLeg leg={short} metricName={metricName} side="空" now={now}/></div>;
}
