"use client";

import { Bell } from "lucide-react";
import type { AlertViewState } from "./alert-settings";

const beijing = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clock = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? beijing.format(new Date(value)) : "—";
const statusLabels = { sent: "已通知飞书", failed: "发送失败", sending: "发送中或结果待确认" } as const;

/** Read-only digest of the alert editor's own poll; it never fetches by itself. */
export function MonitorAlertSide({ state, onOpenRules, rulesAvailable = true }: { state?: AlertViewState; onOpenRules: () => void; rulesAvailable?: boolean }) {
  const view = state?.view ?? null;
  const connected = view?.available === true;
  const summary = state?.loadError ? "连接异常" : !view ? "连接后台中…" : !connected ? "Linux 后台未连接" : view.draft.enabled ? `已启用 · ${view.draft.rules.filter(rule => rule.enabled).length} 档` : "未启用";
  const recent = connected ? view.history.slice(0, 5) : [];
  return <section className="detail-side-panel detail-alerts" data-detail-alerts="">
    <div className="detail-side-heading"><h2><Bell size={15} aria-hidden="true"/>提醒</h2><button type="button" className="detail-side-action" onClick={onOpenRules} disabled={!rulesAvailable}>提醒规则</button></div>
    <p className="detail-side-summary">{summary}{view?.stale ? <span className="detail-stale-tag">行情陈旧</span> : null}</p>
    {state?.loadError ? <p className="detail-side-error">{state.loadError}</p> : null}
    {view && !connected ? <p className="detail-side-note">{view.reason || "正在连接告警后台…"}</p> : null}
    {connected && view.error ? <p className="detail-side-error">{view.error}</p> : null}
    {connected ? <dl className="detail-side-times"><div><dt>最近检查</dt><dd>{clock(view.checkedAt)}</dd></div><div><dt>最近成功取价</dt><dd>{clock(view.lastSuccessAt)}</dd></div></dl> : null}
    {connected ? recent.length ? <ol className="detail-alert-events">{recent.map(event => <li key={event.id}><div><time dateTime={event.time}>{clock(event.time)}</time><strong className={event.status === "sent" ? "positive" : event.status === "failed" ? "negative" : ""}>{statusLabels[event.status]}</strong></div><p>{event.description}{event.error ? ` · ${event.error}` : ""}</p></li>)}</ol> : <p className="detail-side-empty">暂无触发</p> : null}
    {connected ? <p className="detail-side-foot">北京时间 · 显示最近 {Math.min(5, view.history.length)} / {view.history.length} 条</p> : null}
  </section>;
}
