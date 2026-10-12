"use client";
import { hubChanged } from "../lib/hub-bridge";

import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, ChevronDown, Plus, Save, Trash2 } from "lucide-react";
import type { MonitorAlertAdapter, MonitorAlertDraft, MonitorAlertRule, MonitorAlertView } from "../lib/monitor-alerts";
import { startActivityPolling } from "../lib/polling";

const time = (value: string | null) => value == null ? "尚无记录" : `${new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 北京时间`;
const numberValue = (value: number) => Number.isFinite(value) ? value : "";

function AlertSettings({ monitorId, title, adapter, active = true }: { monitorId: string; title: string; adapter: MonitorAlertAdapter; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MonitorAlertView | null>(null);
  const [draft, setDraft] = useState<MonitorAlertDraft>({ enabled: false, rules: [] });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false), busyRef = useRef(false), latestRevision = useRef(0), generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const mutation = useRef<AbortController | null>(null);
  const activity = useRef<ReturnType<typeof startActivityPolling> | null>(null);
  const activeRef = useRef(active);
  const edit = (next: MonitorAlertDraft) => { dirtyRef.current = true; setDirty(true); setMessage(""); setError(""); setDraft(next); };
  const editRule = (id: string, values: Partial<MonitorAlertRule>) => edit({ ...draft, rules: draft.rules.map(rule => rule.id === id ? { ...rule, ...values } : rule) });
  const apply = (next: { draft: MonitorAlertDraft; revision: number }) => {
    latestRevision.current = next.revision; setDraft(next.draft); setRevision(next.revision);
    dirtyRef.current = false; setDirty(false);
  };
  useEffect(() => {
    const controller = new AbortController();
    const load = async (signal: AbortSignal) => {
      if (busyRef.current) return;
      const requestGeneration = generation.current;
      try {
        const next = await adapter.load(AbortSignal.any([controller.signal, signal, AbortSignal.timeout(15_000)]));
        if (controller.signal.aborted || signal.aborted || generation.current !== requestGeneration || (next.available && next.revision < latestRevision.current)) return;
        setLoadError(""); setView(next);
        if (next.available) {
          latestRevision.current = next.revision;
          if (!dirtyRef.current) { setDraft(next.draft); setRevision(next.revision); }
        }
      } catch {
        if (!controller.signal.aborted && !signal.aborted && generation.current === requestGeneration) setLoadError("无法刷新告警后台状态，现有配置与草稿已保留。请检查后台服务。");
      }
    };
    const polling = startActivityPolling({ intervalMs: 10_000, active: activeRef.current, load, onData: () => {}, onError: () => {} });
    activity.current = polling;
    refresh.current = () => polling.refresh();
    const reload = () => { void polling.refresh(); };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("feishu-settings-changed", reload);
    window.addEventListener("beforeunload", unload);
    return () => { controller.abort(); mutation.current?.abort(); polling.stop(); activity.current = null; window.removeEventListener("feishu-settings-changed", reload); window.removeEventListener("beforeunload", unload); };
  }, [adapter]);
  useEffect(() => { activeRef.current = active; activity.current?.setActive(active); }, [active]);

  async function mutate(discard: boolean) {
    if (busyRef.current) return;
    busyRef.current = true; generation.current++; setBusy(true); setError(""); setMessage("");
    const controller = new AbortController(); mutation.current = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]);
      if (discard) {
        const next = await adapter.load(signal);
        if (!next.available) throw new Error(next.reason || "告警后台未连接，草稿已保留。");
        if (next.revision < latestRevision.current) throw new Error("后台返回旧配置，草稿已保留，请稍后重试。");
        if (controller.signal.aborted) return;
        setView(next); apply(next); setLoadError("");
      } else {
        const next = await adapter.save(draft, revision, signal);
        hubChanged();
        if (controller.signal.aborted) return;
        apply(next); setView(current => current ? { ...current, ...next } : current); setLoadError("");
        setMessage("配置已保存，下一轮后台检查时生效。");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "操作失败，草稿已保留。");
    } finally {
      generation.current++; busyRef.current = false;
      if (!controller.signal.aborted) { setBusy(false); void refresh.current(); }
    }
  }
  const connected = view?.available === true;
  const summary = loadError ? "连接异常" : !view ? "连接后台中…" : !connected ? "Linux 后台未连接" : view.draft.enabled ? `已启用 · ${view.draft.rules.filter(rule => rule.enabled).length} 档` : "未启用";
  const bodyId = `monitor-alerts-${monitorId}-body`;
  return <section className="alert-panel monitor-alerts" aria-label={`${title}飞书告警梯度`} data-alert-monitor={monitorId}>
    <button type="button" className="alert-heading" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
      <span><Bell size={18}/><strong>飞书告警梯度</strong><span className="alert-summary">{title} · {summary}{dirty ? " · 未保存" : ""}</span></span><span>设置<ChevronDown size={16} className={open ? "rotated" : ""}/></span>
    </button>
    {open && <div id={bodyId} className="alert-body">
      <div className="alert-definitions"><p><strong>冷却</strong>两次成功提醒之间的最短间隔。</p><p><strong>回差</strong>再次允许提醒前，需要离开阈值的幅度。</p></div>
      <p className="alert-help">持续满足阈值只提醒一次；再次提醒须同时满足重新越过阈值和冷却结束。{adapter.example}</p>
      {!connected ? <p className="alert-help" role="status">{loadError || view?.reason || "正在连接告警后台…"}</p> : <>
        <p className="alert-help">{view.webhookConfigured ? "使用整个面板的统一飞书机器人。" : "尚未配置共用机器人，可先保存梯度。"}关闭网页后，后台仍会检查并发送告警。 <button className="shared-settings-link" type="button" onClick={() => window.dispatchEvent(new Event("open-feishu-settings"))}>打开统一设置</button></p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void mutate(false); }}>
          <fieldset disabled={busy} className="alert-fields">
            <div className="alert-rules-heading"><h3>梯度设置 <span className="alert-summary">{draft.rules.length} / {adapter.maxRules} 档</span></h3><button type="button" className="alert-button" disabled={draft.rules.length >= adapter.maxRules} onClick={() => edit({ ...draft, rules: [...draft.rules, adapter.newRule(draft)] })}><Plus size={15}/>添加梯度</button></div>
            <div className="monitor-alert-rules">{draft.rules.map((rule, index) => {
              const metric = adapter.metrics.find(metric => metric.id === rule.metric) ?? adapter.metrics[0];
              return <div className="monitor-alert-rule" key={rule.id} role="group" aria-label={`第 ${index + 1} 档`}>
                <div className="monitor-alert-rule-top"><span>第 {index + 1} 档</span><div><label className="alert-checkbox"><input type="checkbox" checked={rule.enabled} onChange={event => editRule(rule.id, { enabled: event.target.checked })}/>启用</label><button type="button" className="alert-delete" aria-label={`删除第 ${index + 1} 档`} onClick={() => edit({ ...draft, rules: draft.rules.filter(item => item.id !== rule.id) })}><Trash2 size={16}/></button></div></div>
                <div className="monitor-alert-rule-fields">
                  <label>档位名称<input value={rule.name} required maxLength={adapter.nameMaxLength} onChange={event => editRule(rule.id, { name: event.target.value })}/></label>
                  <label>监控指标<select aria-label="监控指标" value={rule.metric} onChange={event => editRule(rule.id, { metric: event.target.value })}>{adapter.metrics.map(metric => <option value={metric.id} key={metric.id}>{metric.label}</option>)}</select></label>
                  <label>触发方向<select aria-label="触发方向" value={rule.direction} onChange={event => editRule(rule.id, { direction: event.target.value as MonitorAlertRule["direction"] })}><option value="above">向上 ≥</option><option value="below">向下 ≤</option></select></label>
                  <label>阈值（{metric.unit}）<input type="number" step="any" min={metric.min} max={metric.max} required placeholder="输入阈值" value={numberValue(rule.threshold)} onChange={event => editRule(rule.id, { threshold: event.target.valueAsNumber })}/></label>
                  <label>冷却（分钟）<input type="number" step="any" min="0" max={adapter.cooldownMax} required value={numberValue(rule.cooldownMinutes)} onChange={event => editRule(rule.id, { cooldownMinutes: event.target.valueAsNumber })}/></label>
                  <label>回差（{metric.hysteresisUnit}）<input type="number" step="any" min="0" max={adapter.hysteresisMax} required value={numberValue(rule.hysteresis)} onChange={event => editRule(rule.id, { hysteresis: event.target.valueAsNumber })}/></label>
                </div>
              </div>;
            })}</div>
            {!draft.rules.length && <p className="alert-help">添加一档或多档阈值，每档可独立设置冷却、回差和开关。</p>}
            <div className="alert-actions"><label className="alert-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => edit({ ...draft, enabled: event.target.checked })}/>启用飞书告警</label><div>{dirty && <button type="button" className="alert-button" onClick={() => void mutate(true)}>放弃修改并重载</button>}<button type="submit" className="alert-button primary"><Save size={14}/>{busy ? "处理中…" : "保存配置"}</button></div></div>
          </fieldset>
        </form>
        {dirty && <p className="alert-help">有未保存的修改，切换监控会保留草稿。</p>}
        {message && <p className="alert-feedback" role="status">{message}</p>}
        {error && <p className="alert-feedback failure" role="alert">{error}</p>}
        {loadError && <p className="alert-feedback failure" role="alert">{loadError}</p>}
        <div className="alert-monitor"><span>最近后台检查：{time(view.checkedAt)}</span><span>最近成功取价：{time(view.lastSuccessAt)}</span></div>
        <p className="alert-help alert-server-market">{view.market}</p>
        {view.error && <p className="alert-feedback failure" role="alert">{view.error}</p>}
        <details className="monitor-alert-history"><summary>最近发送记录（{view.history.length} 条）</summary>{view.history.length ? view.history.map(item => <div key={item.id}><div><time>{time(item.time)}</time><strong className={item.status === "sent" ? "positive" : item.status === "failed" ? "negative" : ""}>{{ sent: "已发送", failed: "发送失败", sending: "发送中或结果待确认" }[item.status]}</strong></div><p>{item.description}{item.error && ` · ${item.error}`}</p></div>) : <p className="alert-help">尚无发送记录。</p>}</details>
      </>}
    </div>}
  </section>;
}

export default memo(AlertSettings);
