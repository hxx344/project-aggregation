"use client";

import { useHubBridge } from "../lib/hub-bridge";
import { memo, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Activity, ArrowUpRight, Layers3 } from "lucide-react";
import { lazyComponent } from '../lib/lazy-component';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { monitors } from "../lib/monitors";
import { goldOilSummary, goldOilTrend, summaryExpired, summaryStatusLabels, summaryTimestamp, type MonitorSummary } from "../lib/monitor-summary";
import { initialSummaries, initialGoldOilMarket, type InitialMarketData } from "../lib/initial-market";
import Dashboard from "./dashboard";
import OilPanel from "./oil-panel";
import GoldOilPanel from './gold-oil-panel';
import MonitorSparkline from "./monitor-sparkline";
import { trendExpired } from "../lib/monitor-trend";
import NotificationSettings from "./notification-settings";
import AlertSettings from "./alert-settings";
import { monitorAlertAdapters, goldOilAlertId } from "../lib/monitor-alerts";
import { GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, GOLD_OIL_VARIANTS, goldOilVariantKey, type GoldOilType, type GoldOilExchange } from '../lib/gold-oil';
import ExchangeComparison from "./exchange-comparison";
import { useMonitorControls } from '../lib/use-monitor-controls';
import { usePerpetualSummary } from '../hooks/use-perpetual-summary';
const PerpetualPanel = lazyComponent(() => import('./perpetual-panel'), { loading: () => <p role="status">正在加载合约监控…</p> });

const panels = { oil: memo(OilPanel), hynix: memo(Dashboard), 'cl-xau': memo(GoldOilPanel) };

const CardSummary = memo(function CardSummary({ summary, intervalMs, renderedAt, disabled = false }: { summary: MonitorSummary; intervalMs: number; renderedAt?: number; disabled?: boolean }) {
  const [now, setNow] = useState(() => renderedAt ?? Date.now());
  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    const timer = setInterval(updateClock, 10_000);
    document.addEventListener("visibilitychange", updateClock);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", updateClock); };
  }, []);
  const timestamp = summaryTimestamp(summary.fetchedAt);
  const expired = summaryExpired(summary, intervalMs, now);
  return <>
    <span className="hub-card-metrics">{summary.metrics.map((metric, index) => <span key={metric.label}><small>{metric.label}</small><span className="hub-metric-reading"><strong className={metric.tone}>{metric.value}</strong>{index === 0 && summary.trend && <MonitorSparkline trend={summary.trend} expired={trendExpired(summary.trend, now)}/>}</span></span>)}</span>
    {summary.note && <span className="hub-card-note">{summary.note}</span>}
    <span className={`hub-card-status ${disabled ? 'disabled' : expired ? "stale" : summary.status}`}><span><i aria-hidden="true"/>{disabled ? '已关闭 · 保留上次数据' : expired ? "行情待更新" : summaryStatusLabels[summary.status]}</span>{timestamp && <time dateTime={summary.fetchedAt!}>{timestamp} 北京时间</time>}</span>
  </>;
});

export default function MonitorHub({ initial = null, initialMonitor = "oil", initialGoldOil = 'cl', initialGoldOilExchange = 'binance' }: { initial?: InitialMarketData | null; initialMonitor?: "oil" | "hynix" | "perpetual" | 'cl-xau'; initialGoldOil?: GoldOilType; initialGoldOilExchange?: GoldOilExchange }) {
  const hub = useHubBridge("monitor");
  const controls = useMonitorControls(initial?.runtime, hub.readActive);
  const enabled = (id: string) => controls.runtime[id]?.enabled !== false && !controls.runtime[id]?.error;
  const [active, setActive] = useState<string>(initialMonitor);
  const [goldOilType, setGoldOilType] = useState<GoldOilType>(initialGoldOil);
  const [goldOilExchange, setGoldOilExchange] = useState<GoldOilExchange>(initialGoldOilExchange);
  const goldOilKey = goldOilVariantKey(goldOilType, goldOilExchange);
  const [perpetualVisited, setPerpetualVisited] = useState(initialMonitor === "perpetual");
  const [oil, setOil] = useState(() => initialSummaries(initial).oil);
  const [hynix, setHynix] = useState(() => initialSummaries(initial).hynix);
  const [goldOilMarkets, setGoldOilMarkets] = useState(() => Object.fromEntries(GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => {
    const seed = initialGoldOilMarket(initial, oilType, exchange);
    return [goldOilVariantKey(oilType, exchange), goldOilSummary(seed?.quote ?? null, false, goldOilTrend(seed?.history ?? null, false, oilType, exchange), oilType, exchange)];
  })) as Record<string, MonitorSummary>);
  const setGoldOil = useCallback((summary: MonitorSummary) => setGoldOilMarkets(previous => ({ ...previous, [goldOilKey]: summary })), [goldOilKey]);
  const perpetual = usePerpetualSummary(hub.readActive && enabled('perpetual'));
  const summaries: Record<string, MonitorSummary> = { oil, hynix, perpetual, 'cl-xau': goldOilMarkets[goldOilKey] };
  // Stable setters keep mounted panels and their pollers intact on every quote.
  const summaryHandlers = { oil: setOil, hynix: setHynix, 'cl-xau': setGoldOil };
  const selectMonitor = useCallback((id: string) => {
    if (id === 'perpetual') setPerpetualVisited(true);
    setActive(id);
    const url = new URL(window.location.href);
    url.searchParams.set("monitor", id);
    window.history.replaceState(null, "", url);
  }, []);
  const selectGoldOil = useCallback((oilType: GoldOilType) => {
    setGoldOilType(oilType);
    try { localStorage.setItem('market-monitor.goldOil', oilType); } catch { /* Storage may be unavailable in private browsing. */ }
    const url = new URL(window.location.href);
    url.searchParams.set('goldOil', oilType);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }, []);
  const selectGoldOilExchange = useCallback((exchange: GoldOilExchange) => {
    setGoldOilExchange(exchange);
    try { localStorage.setItem('market-monitor.goldOilExchange', exchange); } catch { /* Storage is optional. */ }
    const url = new URL(window.location.href);
    url.searchParams.set('goldOilExchange', exchange);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }, []);
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href), id = url.searchParams.get("monitor");
      if (id && monitors.some(monitor => monitor.id === id)) { setActive(id); if (id === 'perpetual') setPerpetualVisited(true); }
      let oil = url.searchParams.get('goldOil');
      if (oil !== 'cl' && oil !== 'bz') { try { oil = localStorage.getItem('market-monitor.goldOil'); } catch { /* Keep the CL default when storage is unavailable. */ } }
      let exchange = url.searchParams.get('goldOilExchange');
      if (exchange !== 'binance' && exchange !== 'bybit') { try { exchange = localStorage.getItem('market-monitor.goldOilExchange'); } catch { /* Keep the Binance default. */ } }
      const restoredOil = oil === 'bz' ? 'bz' : 'cl', restoredExchange = exchange === 'bybit' ? 'bybit' : 'binance';
      setGoldOilType(restoredOil); setGoldOilExchange(restoredExchange);
      try { localStorage.setItem('market-monitor.goldOil', restoredOil); localStorage.setItem('market-monitor.goldOilExchange', restoredExchange); } catch { /* Storage is optional. */ }
      url.searchParams.set('goldOil', restoredOil); url.searchParams.set('goldOilExchange', restoredExchange);
      window.history.replaceState(null, '', url);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => object }, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "select_market_monitor", title: "切换监控面板", description: "打开已接入的市场监控面板；保留其他面板的图表选项和未保存告警设置。",
        inputSchema: { type: "object", properties: { monitorId: { type: "string", enum: monitors.map(monitor => monitor.id) } }, required: ["monitorId"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("monitorId" in input) || typeof input.monitorId !== "string") throw new Error("需要有效的 monitorId");
          const monitor = monitors.find(item => item.id === input.monitorId);
          if (!monitor) throw new Error("监控模块不存在");
          flushSync(() => selectMonitor(monitor.id));
          return { monitorId: monitor.id, title: monitor.title };
        },
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch { /* Standard browsers do not require WebMCP. */ }
    return () => lifecycle.abort();
  }, [selectMonitor]);
  return <div className={`monitor-hub ${active === "perpetual" ? "monitor-hub-perpetual" : ""}`}>
    <header className="hub-header"><a className="hub-brand" href="/"><span><Activity size={23}/></span>MARKET <b>/ MONITOR</b></a><div className="hub-source">跨市场行情 <span>· CEX / DEX</span></div></header>
    <div className="hub-intro"><div><p className="eyebrow">跨市场价差观察</p><h1>市场监控</h1></div><a href="https://github.com/hxx344/market-spread-monitor" target="_blank" rel="noreferrer"><Layers3 size={16}/>项目与扩展说明<ArrowUpRight size={15}/></a></div>
    <Tabs value={active} onValueChange={value => selectMonitor(String(value))} className={`hub-tabs ${active === "perpetual" ? "hub-perpetual-active" : ""}`}>
      <TabsList className="hub-market-nav" aria-label="选择监控市场">{monitors.map(monitor => <TabsTrigger key={monitor.id} value={monitor.id} className="hub-market-tab">{monitor.title}</TabsTrigger>)}</TabsList>
      <section className="hub-market-overview" aria-label="市场行情概览">{monitors.map(monitor => {
        const runtime = controls.runtime[monitor.id], pending = controls.pending[monitor.id], error = controls.errors[monitor.id] || runtime?.error;
        return <article key={monitor.id} className="hub-summary-shell" data-active={active === monitor.id} data-disabled={!enabled(monitor.id)} aria-label={monitor.title}>
          <button type="button" className="hub-summary-card" aria-pressed={active === monitor.id} onClick={() => selectMonitor(monitor.id)}><span className="hub-card-heading"><i style={{background:monitor.accent}}/><span>{monitor.title}<small>{monitor.id === 'cl-xau' ? `XAU / ${GOLD_OIL_INSTRUMENTS[goldOilType].code}` : monitor.subtitle}{monitor.id === "perpetual" ? " · WS 行情" : ` · ${monitor.id === "hynix" ? "Hyperliquid" : monitor.id === 'cl-xau' ? GOLD_OIL_EXCHANGES[goldOilExchange].name : "Binance"}`}</small></span><em>{monitor.category}</em></span>{summaries[monitor.id] && <CardSummary summary={summaries[monitor.id]} intervalMs={monitor.quoteIntervalMs} renderedAt={initial?.renderedAt} disabled={!enabled(monitor.id)} />}</button>
          <div className="hub-monitor-controls"><span>运行监控</span><button type="button" role="switch" aria-label={`${monitor.title}监控开关`} aria-checked={runtime?.enabled ?? true} aria-busy={pending || undefined} disabled={!runtime?.available || pending} title={runtime?.reason || '控制行情采集、自动告警及跟踪'} onClick={() => void controls.toggle(monitor.id)}><span>{pending ? '保存中…' : runtime?.error ? '重试切换' : !runtime ? '读取中…' : !runtime.available ? '预览模式' : runtime.enabled ? '已开启' : '已关闭'}</span><i aria-hidden="true"/></button></div>
          {error && <p className="hub-monitor-error" role="alert">{error}</p>}
        </article>;
      })}</section>
      {controls.errors.load && <p className="hub-control-notice" role="status">{controls.errors.load}</p>}
      <NotificationSettings active={hub.readActive}/>
      {monitors.filter(monitor => enabled(monitor.id) && (monitor.id === "oil" || monitor.id === "hynix")).map(monitor => { const id = monitor.id as "oil" | "hynix"; return <div key={id} hidden={active !== id} className="hub-exchange-comparison"><ExchangeComparison active={hub.readActive && active === id} interactionActive={hub.active && active === id} monitorId={id} primary={summaries[id]?.comparison} initial={initial?.[id].exchanges} renderedAt={initial?.renderedAt}/></div>; })}
      <div className="hub-alert-settings">{monitors.filter(monitor => enabled(monitor.id) && monitor.capabilities.includes("alerts")).map(monitor => <div key={monitor.id} hidden={active !== monitor.id}>{monitor.id === 'cl-xau' ? <>
        <p className="alert-help">当前组合：{GOLD_OIL_EXCHANGES[goldOilExchange].name} · {GOLD_OIL_INSTRUMENTS[goldOilType].code} · {GOLD_OIL_INSTRUMENTS[goldOilType].name}。各交易所的 CL 与 BZ 告警分别保存，并由后台独立检查。</p>
        {GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => { const id = goldOilAlertId(oilType, exchange), selected = goldOilType === oilType && goldOilExchange === exchange; return <div key={id} hidden={!selected}><AlertSettings active={hub.readActive && active === monitor.id && selected} monitorId={id} title={`金油比 · ${GOLD_OIL_EXCHANGES[exchange].name} ${GOLD_OIL_INSTRUMENTS[oilType].code}`} adapter={monitorAlertAdapters[id]}/></div>; })}
      </> : monitorAlertAdapters[monitor.id] ? <AlertSettings active={hub.readActive && active === monitor.id} monitorId={monitor.id} title={monitor.title} adapter={monitorAlertAdapters[monitor.id]}/> : <p role="alert">该监控模块尚未接入统一告警设置。</p>}</div>)}</div>
      {monitors.map(monitor => { const id = monitor.id as keyof typeof panels; const Panel = panels[id]; return <TabsContent key={monitor.id} value={monitor.id} forceMount className="hub-content">{!enabled(monitor.id) ? <p className="notice" role="status">{monitor.title}监控已关闭，行情采集、自动告警{monitor.id === 'perpetual' ? '和持仓跟踪' : ''}已暂停。配置和历史数据已保留，可通过上方开关重新开启。</p> : monitor.id === "perpetual" ? (perpetualVisited && <PerpetualPanel hubConnected={hub.connected} active={hub.readActive && active === "perpetual"} interactionActive={hub.active && active === "perpetual"}/>) : Panel ? <Panel initial={initial} onSummary={summaryHandlers[id]} active={hub.readActive && active === id} summaryActive={hub.readActive} {...(id === 'cl-xau' ? { oilType: goldOilType, onOilTypeChange: selectGoldOil, exchange: goldOilExchange, onExchangeChange: selectGoldOilExchange } : {})} /> : <p role="alert">该监控模块尚未提供面板。</p>}</TabsContent>; })}
    </Tabs>
  </div>;
}
