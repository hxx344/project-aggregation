"use client";

import { useEffect, useRef, useState } from "react";
import "./variational-session.css";

type SessionView = {
  available: boolean;
  configured: boolean;
  revision: number;
  expiresAt: string | null;
  updatedAt: string | null;
  status: "missing" | "ready" | "expired" | "rejected" | "unavailable";
  error: string;
};
type Props = { id: string; now: number; onClose: () => void; onSaved: () => void };
const endpoint = "/api/monitors/oil/exchanges/variational/session";
const statusLabels = { missing: "尚未配置", ready: "已配置 · 有效性以后台采集结果为准", expired: "已过期，请更新 token", rejected: "会话已失效，请更新 token", unavailable: "认证行情暂不可用" };
const dateText = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function parseView(value: unknown): SessionView {
  const data = value as Partial<SessionView> | null;
  const date = (input: unknown) => input === null || typeof input === "string" && Number.isFinite(Date.parse(input));
  if (!data || typeof data.available !== "boolean" || typeof data.configured !== "boolean" || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 || !date(data.expiresAt) || !date(data.updatedAt) || typeof data.status !== "string" || !Object.hasOwn(statusLabels, data.status) || typeof data.error !== "string") throw Error("配置返回格式不正确，请刷新配置。");
  return { available: data.available, configured: data.configured, revision: data.revision!, expiresAt: data.expiresAt!, updatedAt: data.updatedAt!, status: data.status, error: data.error };
}

async function readSession(controller: AbortController) {
  const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
  if (!response.ok) throw Error("配置读取失败，请刷新配置后重试。");
  return parseView(await response.json());
}

export default function VariationalSession({ id, now, onClose, onSaved }: Props) {
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const [hasToken, setHasToken] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  // Keep the credential only in the password input, never in browser storage or React state.
  const input = useRef<HTMLInputElement | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const field = input.current;
    pending.current = controller;
    void readSession(controller).then(data => {
      if (!controller.signal.aborted) setView(data);
    }).catch(() => {
      if (!controller.signal.aborted) { setError("配置读取失败，请刷新配置后重试。"); setNeedsReload(true); }
    }).finally(() => {
      if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setBusy(null); }
    });
    const hide = () => { if (document.hidden) onClose(); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      pending.current?.abort();
      if (field) field.value = "";
      document.removeEventListener("visibilitychange", hide);
    };
  }, [onClose]);

  async function reload() {
    if (pending.current || document.hidden) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy("loading"); setError(""); setSuccess(false);
    try {
      const data = await readSession(controller);
      if (controller.signal.aborted) return;
      setView(data); setNeedsReload(false);
    } catch {
      if (!controller.signal.aborted) { setError("配置读取失败，请刷新配置后重试。"); setNeedsReload(true); }
    } finally {
      if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setBusy(null); }
    }
  }

  async function save() {
    if (pending.current || document.hidden || !view?.available || needsReload) return;
    const token = input.current?.value.trim() ?? "";
    if (!token) { setError("请填写 Cookie 中 vr-token 的值。"); input.current?.focus(); return; }
    const controller = new AbortController(); pending.current = controller;
    setBusy("saving"); setError(""); setSuccess(false);
    try {
      const response = await fetch(endpoint, { method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, revision: view.revision }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 409) { setNeedsReload(true); setError("配置已被其他页面更新，请先刷新配置，再确认后保存。"); }
        else setError(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "保存失败，请稍后重试。");
        return;
      }
      const saved = parseView(data);
      if (!saved.available || !saved.configured) throw Error("保存结果未确认");
      setView(saved); setSuccess(true); setHasToken(false);
      if (input.current) input.current.value = "";
      onSaved();
    } catch {
      if (!controller.signal.aborted) { setError("保存结果未确认，请刷新配置后再重试。"); setNeedsReload(true); }
    } finally {
      if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setBusy(null); }
    }
  }

  const status = view?.status === "ready" && view.expiresAt && Date.parse(view.expiresAt) <= now ? "expired" : view?.status;
  return <section id={id} className="variational-session" aria-labelledby={`${id}-heading`}>
    <div className="variational-session-heading"><div><h3 id={`${id}-heading`}>更新 Var token</h3><p id={`${id}-help`}>公开价格和资金费无需 token。需要认证报价时，可从已登录 Variational 的浏览器 Cookie 复制 vr-token 的值，不要粘贴整段 Cookie。</p></div><button type="button" className="variational-session-close" onClick={onClose} aria-label="收起 Var token 表单">收起</button></div>
    <div className="variational-session-status" aria-live="polite">
      {view && status ? <><p>{view.available ? statusLabels[status] : "当前环境无法更新会话"}</p>{view.configured ? <p>{view.expiresAt ? `token 声明到期时间：${dateText(view.expiresAt)} 北京时间` : "到期时间未知"}{view.updatedAt ? `；最近保存：${dateText(view.updatedAt)} 北京时间` : ""}</p> : null}{view.error ? <p className="variational-session-warning">{view.error}</p> : null}</> : <p>{busy === "loading" ? "正在读取配置…" : "尚未读取配置"}</p>}
    </div>
    <form className="variational-session-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={`${id}-token`}>新的 vr-token</label>
      <div className="variational-session-fields"><input ref={input} id={`${id}-token`} name="variational-session-token" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={8192} required aria-describedby={`${id}-help`} disabled={busy !== null || !view?.available} onChange={event => { setHasToken(Boolean(event.currentTarget.value.trim())); setSuccess(false); }}/><button type="submit" disabled={busy !== null || !view?.available || !hasToken || needsReload}>{busy === "saving" ? "保存中…" : "保存 token"}</button><button type="button" className="variational-session-reload" disabled={busy !== null} onClick={() => void reload()}>{busy === "loading" ? "读取中…" : "刷新配置"}</button></div>
    </form>
    {error ? <p className="variational-session-warning" role="alert">{error}</p> : null}
    {success ? <p className="variational-session-success" role="status">已保存，后台会在下一轮采集时自动使用，通常在 15 秒内更新，无需重启。</p> : null}
  </section>;
}
