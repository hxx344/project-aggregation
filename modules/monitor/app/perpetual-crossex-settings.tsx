"use client";

import { useState } from "react";
import { MAX_CROSSEX_BLOCKED_BASES, normalizeCrossExBlockedBases } from "../lib/perpetual-crossex-config";
import type { PerpetualCrossExController } from "../hooks/use-perpetual-crossex-settings";

const names: Record<string, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX", gate: "Gate", kraken: "Kraken", hyperliquid: "Hyperliquid", lighter: "Lighter" };
const labels: Record<string, string> = { live: "资料已更新", pending: "待采集", stale: "已过期", error: "读取失败", unsupported: "无法核验" };

export default function PerpetualCrossExSettings({ settings, now }: { settings: PerpetualCrossExController; now: number }) {
  const { data, error, saveError, saving, saved, disabled, update, setBaseBlocked, reportError } = settings;
  const [blockedInput, setBlockedInput] = useState("");
  async function addBlockedBase() {
    if (!data || disabled) return;
    reportError("");
    try {
      const base = normalizeCrossExBlockedBases([blockedInput])[0];
      if (data.config.blockedBases.includes(base)) throw new Error(`${base} 已在屏蔽名单中`);
      if (await setBaseBlocked(base, true)) setBlockedInput("");
    } catch (cause) { reportError(cause instanceof Error ? cause.message : "币种无效"); }
  }
  return <section className="perp-crossex-settings" aria-label="CrossEx 推送筛选">
    <div className="perp-crossex-control"><strong>CrossEx 推送筛选</strong><label><input type="checkbox" checked={data?.config.requireSpotTransfer ?? false} disabled={disabled} onChange={event => void update({ requireSpotTransfer: event.target.checked })}/>仅显示并推送双边有现货且共同网络充提正常的机会</label><span role="status">{saving ? "保存中…" : saved ? "已保存到服务器" : data ? data.config.requireSpotTransfer ? "充提筛选已开启" : "充提筛选未开启" : "读取设置中…"}</span></div>
    <p>双方均有可交易现货，且至少一条共同网络的充值、提现均开放；代币地址须匹配。未知或过期不参与价差排名及新机会推送，页面关闭后仍生效。</p>
    {data?.config.requireSpotTransfer ? <p>已接入 Binance、Gate 公开数据；其他平台当前无法核验，暂不推送。</p> : null}
    <form className="perp-crossex-block-form" onSubmit={event => { event.preventDefault(); void addBlockedBase(); }}>
      <label htmlFor="crossex-blocked-base">屏蔽币种 <span>{data ? `${data.config.blockedBases.length} / ${MAX_CROSSEX_BLOCKED_BASES}` : ""}</span></label>
      <input id="crossex-blocked-base" value={blockedInput} maxLength={40} placeholder="输入基础币种，如 BTC" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="crossex-blocked-help" disabled={disabled} onChange={event => setBlockedInput(event.target.value)}/>
      <button type="submit" disabled={disabled || !blockedInput.trim()}>添加屏蔽</button>
    </form>
    <p id="crossex-blocked-help">点击行情列表币种旁的“屏蔽并隐藏”，保存后隐藏该币种的价差排名和全部报价，同时停止所有平台和方向的新机会推送。可在下方名单中解除屏蔽；独立于充提开关生效。手动添加时填写 BTC 等基础币种，不填 BTCUSDT。</p>
    {data?.config.blockedBases.length ? <ul className="perp-crossex-blocked-list" aria-label="已屏蔽币种">{data.config.blockedBases.map(base => <li key={base}><strong>{base}</strong><button type="button" disabled={disabled} aria-label={`解除屏蔽 ${base}`} onClick={() => void setBaseBlocked(base, false)}>解除屏蔽</button></li>)}</ul> : data ? <p>尚未屏蔽任何币种</p> : null}
    {saveError || error || data?.error ? <p role="alert">{saveError || error || data?.error}</p> : null}
    {data?.config.requireSpotTransfer ? <details><summary>公开数据覆盖与核验时间</summary><p>每分钟更新，到达核验时间后 3 分钟即失效。排名、统计和分页使用相同资格；详情暂停期间仍核对资格。全部报价保留供核对。</p><ul>{data.venues.map(venue => <li key={venue.exchange}><strong>{names[venue.exchange] ?? venue.exchange}</strong> · {labels[venue.state === "live" && venue.checkedAt && now >= venue.checkedAt + 180_000 ? "stale" : venue.state] ?? "无法核验"}{venue.checkedAt ? ` · 核验 ${new Date(venue.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })} · 到期 ${new Date(venue.checkedAt + 180_000).toLocaleTimeString("zh-CN", { hour12: false })}` : " · 现货与充提未知"}{venue.error ? ` · ${venue.error}` : ""}</li>)}</ul></details> : null}
  </section>;
}
