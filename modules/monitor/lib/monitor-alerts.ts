import { oilSpreadPercent } from '../modules/oil/spread.mjs';
import type { AlertConfig, AlertView } from "./alert-types";
import { GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, goldOilUnits, goldOilAction, validateGoldOilQuote, type GoldOilQuote, type GoldOilType, type GoldOilExchange } from './gold-oil.ts';

export type MonitorAlertRule = {
  id: string; name: string; metric: string; direction: "above" | "below";
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
};
export type AlertMetric = { id: string; label: string; unit: string; hysteresisUnit: string; min: number; max: number };
type Fetcher = typeof fetch;
export interface MonitorAlertAdapter {
  metrics: readonly AlertMetric[]; maxRules: number; nameMaxLength: number;
  cooldownMax: number; hysteresisMax: number; example: string;
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
const baseRule = (draft: MonitorAlertDraft, metric: string, cooldownMinutes: number, hysteresis: number): MonitorAlertRule => ({
  id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: `档位 ${draft.rules.length + 1}`, metric, direction: "above", threshold: Number.NaN, cooldownMinutes, hysteresis, enabled: true,
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
  metrics: [{ id: "premium", label: "ADR 溢价率", unit: "%", hysteresisUnit: "百分点", min: -100, max: 10000 }], maxRules: 20, nameMaxLength: 40, cooldownMax: 1440, hysteresisMax: 100,
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

type OilConfig = { enabled: boolean; rules: { id: string; label: string; metric: string; operator: "gte" | "lte"; threshold: number; cooldownMinutes: number; hysteresis: number; enabled: boolean }[] };
type OilStatus = { available: boolean; reason?: string; webhookConfigured: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; stale: boolean; error?: string; deliveryError?: string; market?: { brent: { markPx: number }; wti: { markPx: number } } };
type OilEvent = { source?: string; id: string; time: string; status: MonitorAlertEvent["status"]; test?: boolean; error?: string; rules: { label: string; metric: string; operator: string; threshold: number; value: number }[] };
const oilMetricLabel: Record<string, string> = { spreadPercent: "百分比价差", spread: "绝对价差", brent: "布伦特", wti: "WTI" };
export const oilDraft = (config: OilConfig): MonitorAlertDraft => ({ enabled: config.enabled, rules: config.rules.map(rule => ({ id: rule.id, name: rule.label, metric: rule.metric, direction: rule.operator === "gte" ? "above" : "below", threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled })) });
export const oilConfig = (draft: MonitorAlertDraft): OilConfig => ({ enabled: draft.enabled, rules: draft.rules.map(rule => ({ id: rule.id, label: rule.name, metric: rule.metric, operator: rule.direction === "above" ? "gte" : "lte", threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled })) });
export const oilAlerts: MonitorAlertAdapter = {
  metrics: [{ id: "spreadPercent", label: "价差 · 相对 WTI", unit: "%", hysteresisUnit: "百分点", min: -1e6, max: 1e6 }, { id: "spread", label: "绝对价差（旧口径）", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: -1e6, max: 1e6 }, { id: "brent", label: "布伦特价格", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: 0, max: 1e6 }, { id: "wti", label: "WTI 价格", unit: "USDT/桶", hysteresisUnit: "USDT/桶", min: 0, max: 1e6 }], maxRules: 50, nameMaxLength: 60, cooldownMax: 10080, hysteresisMax: 1e6,
  example: "百分比价差以 WTI 为基准。阈值 5%、回差 0.1 个百分点：触发后需回落到 4.9% 以下，再次达到 5% 且冷却结束才提醒。已有绝对价差规则仍按 USDT/桶判断。",
  newRule: draft => baseRule(draft, "spreadPercent", 30, 0.1),
  async load(signal, fetcher = fetch) {
    const status = await request<OilStatus>("/api/monitors/oil/status", signal, fetcher);
    if (!status.available) return empty(status.reason);
    const [config, events] = await Promise.all([request<{ revision: number; config: OilConfig }>("/api/monitors/oil/config", signal, fetcher), request<{ events: OilEvent[] }>("/api/monitors/oil/events", signal, fetcher)]);
    const market = status.market;
    return { available: true, revision: config.revision, draft: oilDraft(config.config), webhookConfigured: status.webhookConfigured, checkedAt: status.lastAttemptAt, lastSuccessAt: status.lastSuccessAt,
      market: market ? `Binance 标记价${status.stale ? "（已过期）" : ""} · 布伦特 ${market.brent.markPx.toFixed(4)} / WTI ${market.wti.markPx.toFixed(4)} / 价差 ${oilSpreadPercent(market.brent.markPx, market.wti.markPx)?.toFixed(4) ?? "—"}%` : "服务器尚未取得有效行情。",
      error: [status.error, status.deliveryError].filter(Boolean).join("；"), history: events.events.map(event => ({ id: event.id, time: event.time, status: event.status, description: event.test ? "测试消息" : event.rules.map(rule => `${event.source === 'hyperliquid' ? '[历史 Hyperliquid] ' : '[Binance] '}${rule.label} · ${oilMetricLabel[rule.metric] ?? rule.metric} ${rule.value.toFixed(4)} ${rule.operator === "gte" ? "≥" : "≤"} ${rule.threshold} ${rule.metric === 'spreadPercent' ? '%' : event.source === 'hyperliquid' ? '美元/桶' : 'USDT/桶'}`).join("；"), error: event.error })) };
  },
  async save(draft, revision, signal, fetcher = fetch) {
    const result = await request<{ revision: number; config: OilConfig }>("/api/monitors/oil/config", signal, fetcher, { revision, config: oilConfig(draft) });
    return { revision: result.revision, draft: oilDraft(result.config) };
  },
};

function createGoldOilAlerts(oilType: GoldOilType, exchange: GoldOilExchange = 'binance'): MonitorAlertAdapter {
  const instrument = GOLD_OIL_INSTRUMENTS[oilType], source = GOLD_OIL_EXCHANGES[exchange].name, units = goldOilUnits(oilType, exchange), endpoint = (action: string) => `/api/monitors/cl-xau/${goldOilAction(action, oilType, exchange)}`;
  const read = async <T,>(action: string, signal: AbortSignal, fetcher: Fetcher, body?: unknown) => {
    const result = await request<T & { oilType?: string; exchange?: string; source?: string }>(endpoint(action), signal, fetcher, body);
    // Legacy Binance endpoints omitted identity; Bybit must never accept that payload.
    if ((exchange === 'bybit' || result.oilType !== undefined) && result.oilType !== oilType
      || (exchange === 'bybit' || result.exchange !== undefined) && result.exchange !== exchange
      || (exchange === 'bybit' || result.source !== undefined) && result.source !== source) throw new Error('告警后台返回了其他交易所或合约的数据，现有配置与草稿已保留。');
    return result;
  };
  return {
  metrics: [{ id: 'ratio', label: `金油比 XAU / ${instrument.code}`, unit: units.ratio, hysteresisUnit: units.ratio, min: 0, max: 1e6 }],
  maxRules: 50, nameMaxLength: 60, cooldownMax: 10080, hysteresisMax: 1e6,
  example: `金油比＝黄金标记价 ÷ ${instrument.name}（${instrument.code}）标记价。阈值 50、回差 0.5 ${units.ratio}：触发后需回落到 49.5 以下，再次达到 50 且冷却结束才提醒。阈值和回差均为${units.ratio}。`,
  newRule: draft => baseRule(draft, 'ratio', 30, 0.5),
  async load(signal, fetcher = fetch) {
    const status = await read<Omit<OilStatus, 'market'> & { market?: GoldOilQuote }>('status', signal, fetcher);
    if (!status.available) return empty(status.reason);
    const [config, events] = await Promise.all([
      read<{ revision: number; config: OilConfig }>('config', signal, fetcher),
      read<{ events: OilEvent[] }>('events', signal, fetcher),
    ]);
    let market: GoldOilQuote | null = null, marketError = '';
    if (status.market) { try { market = validateGoldOilQuote(status.market, oilType, exchange); } catch { marketError = '行情合约标识或格式无效，已隐藏报价。'; } }
    return { available: true, revision: config.revision, draft: oilDraft(config.config), webhookConfigured: status.webhookConfigured,
      checkedAt: status.lastAttemptAt, lastSuccessAt: status.lastSuccessAt,
      market: market ? `${source} 标记价${status.stale ? '（已过期）' : ''} · 金油比 XAU / ${instrument.code} ${market.ratio.toFixed(4)} ${units.ratio} · 黄金 ${market.xau.price.toFixed(4)} USDT/盎司 / ${instrument.name} ${market.oil.price.toFixed(4)} ${units.oil}` : '服务器尚未取得有效行情。',
      error: [status.error, status.deliveryError, marketError].filter(Boolean).join('；'),
      history: events.events.map(event => ({ id: event.id, time: event.time, status: event.status,
        description: event.rules.map(rule => `[${source} ${instrument.code}] ${rule.label} · 金油比 ${rule.value.toFixed(4)} ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.threshold} ${units.ratio}`).join('；'), error: event.error })),
    };
  },
  async save(draft, revision, signal, fetcher = fetch) {
    const result = await read<{ revision: number; config: OilConfig }>('config', signal, fetcher, { revision, config: oilConfig(draft) });
    return { revision: result.revision, draft: oilDraft(result.config) };
  },
  };
}
export const goldOilAlerts = createGoldOilAlerts('cl');
export const goldOilBzAlerts = createGoldOilAlerts('bz');
export const goldOilBybitAlerts = createGoldOilAlerts('cl', 'bybit');
export const goldOilBybitBzAlerts = createGoldOilAlerts('bz', 'bybit');
export function goldOilAlertId(oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') {
  return `cl-xau${exchange === 'bybit' ? '-bybit' : ''}${oilType === 'bz' ? '-bz' : ''}`;
}

/** All alert-capable monitors use the hub's fixed editor slot and this contract. */
export const monitorAlertAdapters: Record<string, MonitorAlertAdapter> = { oil: oilAlerts, hynix: hynixAlerts, 'cl-xau': goldOilAlerts, 'cl-xau-bz': goldOilBzAlerts, 'cl-xau-bybit': goldOilBybitAlerts, 'cl-xau-bybit-bz': goldOilBybitBzAlerts };
