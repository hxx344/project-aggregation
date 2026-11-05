import { oilSpread } from '../modules/oil/spread.mjs';
import type { AlertConfig, AlertView } from "./alert-types";

export type MonitorAlertRule = {
  id: string; name: string; metric: string; direction: "above" | "below" | "both";
  threshold: number; cooldownMinutes: number; hysteresis: number; enabled: boolean;
};
export type MonitorAlertDraft = {
  enabled: boolean; rules: MonitorAlertRule[];
  /** Preserve legacy Hynix defaults; existing rules need no storage migration. */
  defaults?: { cooldownSeconds: number; hysteresis: number };
};
export type MonitorAlertEvent = { id: string; time: string; status: "sent" | "failed" | "sending"; description: string; error?: string };
export type MonitorAlertView = {
  available: boolean; reason?: string; revision: number; draft: MonitorAlertDraft;
  webhookConfigured: boolean; checkedAt: string | null; lastSuccessAt: string | null;
  market: string; error: string; history: MonitorAlertEvent[];
  /** Server-side market sample is past its freshness budget (oil reports this). */
  stale?: boolean;
};
export type AlertMetric = { id: string; label: string; unit: string; hysteresisUnit: string; min: number; max: number };
type Fetcher = typeof fetch;
export interface MonitorAlertAdapter {
  metrics: readonly AlertMetric[]; maxRules: number; nameMaxLength: number;
  cooldownMax: number; hysteresisMax: number; example: string;
  /** Initial range for the tier generator when the draft has no evenly spaced tiers to reuse. */
  grid: { from: number; to: number; step: number };
  /** Optional warning derived from the current draft (oil: converted percentage rules still off). */
  notice?: (draft: MonitorAlertDraft) => string | null;
  newRule: (draft: MonitorAlertDraft) => MonitorAlertRule;
  load: (signal: AbortSignal, fetcher?: Fetcher) => Promise<MonitorAlertView>;
  save: (draft: MonitorAlertDraft, revision: number, signal: AbortSignal, fetcher?: Fetcher) => Promise<{ draft: MonitorAlertDraft; revision: number }>;
}

const empty = (reason?: string): MonitorAlertView => ({ available: false, reason, revision: 0, draft: { enabled: false, rules: [] }, webhookConfigured: false, checkedAt: null, lastSuccessAt: null, market: "", error: "", history: [] });
async function request<T>(url: string, signal: AbortSignal, fetcher: Fetcher, body?: unknown): Promise<T> {
  const response = await fetcher(url, { cache: "no-store", signal, ...(body === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 409 ? "另一页面已更新配置。你的修改仍保留，请放弃修改并重载后再编辑。" : result.error || `后台请求失败（${response.status}）。`);
  return result;
}
export const newRuleId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const baseRule = (draft: MonitorAlertDraft, metric: string, cooldownMinutes: number, hysteresis: number): MonitorAlertRule => ({
  id: newRuleId(), name: `档位 ${draft.rules.length + 1}`, metric, direction: "above", threshold: Number.NaN, cooldownMinutes, hysteresis, enabled: true,
});
export function hynixDraft(config: AlertConfig): MonitorAlertDraft {
  return { enabled: config.enabled, defaults: { cooldownSeconds: config.cooldownSeconds, hysteresis: config.hysteresis }, rules: config.rules.map(rule => ({ id: rule.id, name: rule.name, direction: rule.direction, enabled: rule.enabled, threshold: rule.threshold, metric: "premium", cooldownMinutes: (rule.cooldownSeconds ?? config.cooldownSeconds) / 60, hysteresis: rule.hysteresis ?? config.hysteresis })) };
}
export function hynixConfig(draft: MonitorAlertDraft): AlertConfig {
  const defaults = draft.defaults ?? { cooldownSeconds: 300, hysteresis: 0.5 };
  return { enabled: draft.enabled, ...defaults, rules: draft.rules.map(rule => {
    const seconds = rule.cooldownMinutes * 60;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400 || Math.abs(seconds - Math.round(seconds)) > Number.EPSILON * 8 * Math.max(1, Math.abs(seconds))) throw new Error(`${rule.name}的冷却时间须为 0–1440 分钟，精确到整秒（例如 0.5 分钟 = 30 秒）。`);
    // Omit inherited values so saving an unchanged legacy rule does not migrate it.
    return { id: rule.id, name: rule.name, direction: rule.direction, threshold: rule.threshold, enabled: rule.enabled,
      ...(Math.round(seconds) === defaults.cooldownSeconds ? {} : { cooldownSeconds: Math.round(seconds) }),
      ...(rule.hysteresis === defaults.hysteresis ? {} : { hysteresis: rule.hysteresis }) };
  }) };
}
export const hynixAlerts: MonitorAlertAdapter = {
  metrics: [{ id: "premium", label: "ADR 溢价率", unit: "%", hysteresisUnit: "百分点", min: -100, max: 10000 }], maxRules: 20, nameMaxLength: 40, cooldownMax: 1440, hysteresisMax: 100, grid: { from: 30, to: 50, step: 5 },
  example: "例如向上阈值为 40%、回差为 0.5 个百分点：触发后需回落到 39.5% 以下，再次达到 40% 且冷却结束，才会再次提醒。",
  newRule: draft => baseRule(draft, "premium", (draft.defaults?.cooldownSeconds ?? 300) / 60, draft.defaults?.hysteresis ?? 0.5),
  async load(signal, fetcher = fetch) {
    const view = await request<AlertView>("/api/monitors/hynix/alerts", signal, fetcher);
    if (!view.available) return empty(view.reason);
    const quote = view.status.lastQuote;
    return { available: true, revision: view.revision, draft: hynixDraft(view.config), webhookConfigured: view.config.webhookConfigured, checkedAt: view.status.checkedAt, lastSuccessAt: view.status.lastSuccessAt,
      market: quote ? `服务器最近溢价率 · ${quote.premium.toFixed(2)}%` : "服务器尚未取得有效行情。", error: view.status.lastError,
      history: view.history.map(event => ({ id: event.id, time: event.time, status: event.status, description: event.kind === "test" ? "测试消息" : `${event.rules.join("、")}${event.premium == null ? "" : ` · ${event.premium.toFixed(2)}%`}`, error: event.error })) };
  },
  async save(draft, revision, signal, fetcher = fetch) {
    const result = await request<AlertView>("/api/monitors/hynix/alerts", signal, fetcher, { ...hynixConfig(draft), revision });
    return { revision: result.revision, draft: hynixDraft(result.config) };
  },
};

type OilConfig = { enabled: boolean; rules: { id: string; label: string; metric: string; operator: "gte" | "lte" | "both"; threshold: number; cooldownMinutes: number; hysteresis: number; enabled: boolean }[] };
type OilStatus = { available: boolean; reason?: string; webhookConfigured: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; stale: boolean; error?: string; deliveryError?: string; market?: { brent: { markPx: number }; wti: { markPx: number } } };
type OilEvent = { source?: string; id: string; time: string; status: MonitorAlertEvent["status"]; test?: boolean; error?: string; rules: { label: string; metric: string; operator: string; threshold: number; value: number }[] };
// Must match server/oil/config.mjs LEGACY_PERCENT_SUFFIX.
const LEGACY_PERCENT_SUFFIX = "（原百分比）";
// `spreadPercent` only appears in alert history recorded before the switch to the absolute spread.
const oilMetricLabel: Record<string, string> = { spreadPercent: "百分比价差（已停用）", spread: "价差", brent: "布伦特", wti: "WTI" };
export const oilDraft = (config: OilConfig): MonitorAlertDraft => ({ enabled: config.enabled, rules: config.rules.map(rule => ({ id: rule.id, name: rule.label, metric: rule.metric, direction: rule.operator === "both" ? "both" : rule.operator === "gte" ? "above" : "below", threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled })) });
export const oilConfig = (draft: MonitorAlertDraft): OilConfig => ({ enabled: draft.enabled, rules: draft.rules.map(rule => ({ id: rule.id, label: rule.name, metric: rule.metric, operator: rule.direction === "both" ? "both" : rule.direction === "above" ? "gte" : "lte", threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled })) });
export const oilAlerts: MonitorAlertAdapter = {
  metrics: [{ id: "spread", label: "价差 · 布伦特 − WTI", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: -1e6, max: 1e6 }, { id: "brent", label: "布伦特价格", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: 0, max: 1e6 }, { id: "wti", label: "WTI 价格", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: 0, max: 1e6 }], maxRules: 50, nameMaxLength: 60, cooldownMax: 10080, hysteresisMax: 1e6, grid: { from: 3, to: 5, step: 0.5 },
  example: "价差＝布伦特 − WTI，单位 USDT/桶。阈值 4、回差 0.1：触发后需回落到 3.9 以下，再次达到 4 且冷却结束才提醒。",
  notice(draft) {
    const count = draft.rules.filter(rule => !rule.enabled && rule.name.endsWith(LEGACY_PERCENT_SUFFIX)).length;
    return count ? `有 ${count} 档原百分比规则已转为价差规则并停用，数值未换算（现单位 USDT/桶），请核对阈值后重新启用或删除。` : null;
  },
  newRule: draft => baseRule(draft, "spread", 30, 0.1),
  async load(signal, fetcher = fetch) {
    const status = await request<OilStatus>("/api/monitors/oil/status", signal, fetcher);
    if (!status.available) return empty(status.reason);
    const [config, events] = await Promise.all([request<{ revision: number; config: OilConfig }>("/api/monitors/oil/config", signal, fetcher), request<{ events: OilEvent[] }>("/api/monitors/oil/events", signal, fetcher)]);
    const market = status.market;
    return { available: true, revision: config.revision, draft: oilDraft(config.config), webhookConfigured: status.webhookConfigured, checkedAt: status.lastAttemptAt, lastSuccessAt: status.lastSuccessAt, stale: status.stale === true,
      market: market ? `Binance 标记价${status.stale ? "（已过期）" : ""} · 布伦特 ${market.brent.markPx.toFixed(4)} / WTI ${market.wti.markPx.toFixed(4)} / 价差 ${oilSpread(market.brent.markPx, market.wti.markPx)?.toFixed(4) ?? "—"} USDT/桶` : "服务器尚未取得有效行情。",
      error: [status.error, status.deliveryError].filter(Boolean).join("；"), history: events.events.map(event => ({ id: event.id, time: event.time, status: event.status, description: event.test ? "测试消息" : event.rules.map(rule => `${event.source === 'hyperliquid' ? '[历史 Hyperliquid] ' : '[Binance] '}${rule.label} · ${oilMetricLabel[rule.metric] ?? rule.metric} ${rule.value.toFixed(4)} ${rule.operator === "gte" ? "≥" : "≤"} ${rule.threshold} ${rule.metric === 'spreadPercent' ? '%' : event.source === 'hyperliquid' ? '美元/桶' : 'USDT/桶'}`).join("；"), error: event.error })) };
  },
  async save(draft, revision, signal, fetcher = fetch) {
    const result = await request<{ revision: number; config: OilConfig }>("/api/monitors/oil/config", signal, fetcher, { revision, config: oilConfig(draft) });
    return { revision: result.revision, draft: oilDraft(result.config) };
  },
};

/** All alert-capable monitors use the hub's fixed editor slot and this contract. */
export const monitorAlertAdapters: Record<string, MonitorAlertAdapter> = { oil: oilAlerts, hynix: hynixAlerts };
