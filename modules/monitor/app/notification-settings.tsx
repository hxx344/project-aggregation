"use client";
import { hubChanged } from "../lib/hub-bridge";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, ChevronDown, Save, Send } from "lucide-react";
import type { NotificationView } from "../lib/notification-types";
import { startActivityPolling } from "../lib/polling";

const endpoint = "/api/notifications/feishu";
export default function NotificationSettings({ active = true }: { active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NotificationView | null>(null);
  const [revision, setRevision] = useState(0);
  const [webhookUrl, setWebhook] = useState("");
  const [signingSecret, setSecret] = useState("");
  const [clearWebhook, setClearWebhook] = useState(false);
  const [clearSigningSecret, setClearSecret] = useState(false);
  const [migrationSource, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false), busyRef = useRef(false), latestRevision = useRef(0), generation = useRef(0);
  const activity = useRef<ReturnType<typeof startActivityPolling> | null>(null);
  const edit = () => { dirtyRef.current = true; setDirty(true); setMessage(""); };
  const apply = (next: NotificationView) => {
    latestRevision.current = next.revision; setView(next); setRevision(next.revision);
    setWebhook(""); setSecret(""); setClearWebhook(false); setClearSecret(false); setSource("");
    dirtyRef.current = false; setDirty(false);
  };
  useEffect(() => {
    const controller = new AbortController();
    const load = async (signal: AbortSignal) => {
      if (busyRef.current) return;
      const requestGeneration = generation.current;
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([controller.signal, signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error();
        const next: NotificationView = await response.json();
        if (controller.signal.aborted || signal.aborted || generation.current !== requestGeneration || (next.available && next.revision < latestRevision.current)) return;
        setLoadError(""); setView(next);
        if (next.available) { latestRevision.current = next.revision; if (!dirtyRef.current) setRevision(next.revision); }
      } catch { if (!controller.signal.aborted && !signal.aborted) setLoadError("无法连接统一告警设置，请检查后台服务。"); }
    };
    const show = () => { setOpen(true); document.getElementById("shared-feishu")?.scrollIntoView({ block: "start", behavior: "instant" }); };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    const polling = startActivityPolling({ intervalMs: 10_000, active: false, load, onData: () => {}, onError: () => {} });
    activity.current = polling;
    const reload = () => { void polling.refresh(); };
    window.addEventListener("open-feishu-settings", show);
    window.addEventListener("feishu-settings-changed", reload);
    window.addEventListener("beforeunload", unload);
    return () => { controller.abort(); polling.stop(); activity.current = null; window.removeEventListener("open-feishu-settings", show); window.removeEventListener("feishu-settings-changed", reload); window.removeEventListener("beforeunload", unload); };
  }, []);
  useEffect(() => { activity.current?.setActive(open && active); }, [open, active]);
  async function mutate(testing: boolean) {
    if (busyRef.current) return;
    busyRef.current = true; generation.current++; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${endpoint}${testing ? "/test" : ""}`, { method: testing ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(45_000), body: testing ? "{}" : JSON.stringify({ revision, webhookUrl, signingSecret, clearWebhook, clearSigningSecret, migrationSource }) });
      const result = await response.json() as NotificationView & { error?: string };
      if (!response.ok) throw new Error(result.error || "操作失败，请重试。");
      hubChanged();
      apply(result);
      setLoadError(""); setMessage(testing ? "测试消息已发送到共用的飞书机器人。" : "统一配置已保存，所有监控模块立即共用；无需重启。");
    } catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally { generation.current++; busyRef.current = false; setBusy(false); window.dispatchEvent(new Event("feishu-settings-changed")); }
  }
  const connected = view?.available === true;
  const summary = loadError ? "连接异常" : !view ? open ? "连接后台中…" : "展开查看配置" : !connected ? "Linux 后台未连接" : view.error ? "发送已暂停" : view.candidates.length ? "已有配置待选择" : view.webhookConfigured ? "所有模块共用 · 已配置" : "所有模块共用 · 待配置";
  return <div className="hub-notifications"><section id="shared-feishu" className="alert-panel shared-feishu" aria-label="统一飞书告警">
    <button className="alert-heading" aria-expanded={open} aria-controls="shared-feishu-body" onClick={() => setOpen(!open)}><span><Bell size={18}/><strong>统一飞书告警</strong><span className="alert-summary">{summary}{dirty ? " · 未保存" : ""}</span></span><span>设置<ChevronDown size={16} className={open ? "rotated" : ""}/></span></button>
    {open && <div className="alert-body" id="shared-feishu-body">
      {!connected ? <p className="alert-help">{loadError || view?.reason || "正在连接告警后台…"}</p> : <>
        <p className="alert-help">原油、金油比、海力士和合约价差共用一个飞书机器人。各模块独立设置阈值与开关，关闭网页后告警仍由后台运行。</p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void mutate(false); }}><fieldset className="alert-fields" disabled={busy}>
          {view.candidates.length > 0 && <div className="shared-migration"><p>原油和海力士原有机器人配置不同，请选择要共用的机器人。选择并保存前，两个模块暂停发送。</p><label>共用机器人<select aria-label="共用机器人" value={migrationSource} onChange={event => { edit(); setSource(event.target.value); setWebhook(""); setSecret(""); setClearWebhook(false); setClearSecret(false); }}><option value="">填写新的机器人</option>{view.candidates.map(source => <option key={source.id} value={source.id}>沿用{source.label}机器人 · {source.destination}{source.signingSecretConfigured ? " · 有签名" : ""}</option>)}</select></label></div>}
          {!migrationSource && <><div className="alert-form-grid">
            <label>飞书机器人 Webhook<input type="password" autoComplete="new-password" disabled={clearWebhook} value={webhookUrl} onChange={event => { edit(); setWebhook(event.target.value); }} placeholder={view.webhookConfigured ? "已配置；留空保留" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"}/></label>
            <label>签名密钥（可选）<input type="password" autoComplete="new-password" disabled={clearWebhook || clearSigningSecret} value={signingSecret} onChange={event => { edit(); setSecret(event.target.value); }} placeholder={view.signingSecretConfigured ? "已配置；同一机器人留空保留" : "机器人启用签名校验时填写"}/></label>
          </div><p className="alert-help">更换 Webhook 时请同时填写新机器人的签名密钥；留空表示新机器人不使用签名。如开启关键词校验，请添加“告警”，以匹配各模块的消息。</p>
          <div className="shared-clear-options">{view.signingSecretConfigured && <label className="alert-checkbox"><input type="checkbox" disabled={clearWebhook} checked={clearSigningSecret} onChange={event => { edit(); setClearSecret(event.target.checked); if (event.target.checked) setSecret(""); }}/>清除签名密钥</label>}{(view.webhookConfigured || view.candidates.length > 0) && <label className="alert-checkbox"><input type="checkbox" checked={clearWebhook} onChange={event => { edit(); setClearWebhook(event.target.checked); if (event.target.checked) { setWebhook(""); setSecret(""); } }}/>清除机器人，暂停所有模块发送</label>}</div></>}
          <div className="alert-actions"><span className="alert-summary">{dirty ? "有未保存的修改" : view.migratedFrom.length ? `已迁移${view.migratedFrom.join("、")}原有配置` : "凭据仅保存在服务器"}</span><div><button className="alert-button" type="button" disabled={dirty || !view.webhookConfigured || Boolean(view.error) || Boolean(loadError)} onClick={() => void mutate(true)}><Send size={14}/>发送测试消息</button><button className="alert-button primary" type="submit"><Save size={14}/>{busy ? "处理中…" : "保存统一配置"}</button></div></div>
        </fieldset></form>
        {dirty && <button className="alert-button shared-reload" type="button" disabled={busy} onClick={() => { apply(view); setError(""); }}>放弃修改并重载</button>}
        {view.testResult && <p className="alert-help">最近连接测试：{new Date(view.testResult.time).toLocaleString("zh-CN", { hour12: false })} · {view.testResult.status === "sent" ? "发送成功" : view.testResult.status === "failed" ? `发送失败 · ${view.testResult.error}` : "发送中或结果待确认"}</p>}
        {message && <p role="status" className="alert-feedback">{message}</p>}
        {(error || view.error || loadError) && <p role="alert" className="alert-feedback failure">{error || view.error || loadError}</p>}
      </>}
    </div>}
  </section></div>;
}
