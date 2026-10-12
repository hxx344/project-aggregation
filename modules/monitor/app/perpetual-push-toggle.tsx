"use client";

import type { PerpetualCrossExController } from "../hooks/use-perpetual-crossex-settings";

export default function PerpetualPushToggle({ base, settings }: { base: string; settings: PerpetualCrossExController }) {
  // Use the canonical base only; display names and native contract symbols can differ.
  if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(base)) return null;
  const blocked = settings.blockedBases.has(base), pending = settings.saving && settings.actionBase === base;
  const failure = settings.actionBase === base && settings.saveError;
  return <div className="perp-push-control">
    {blocked ? <span className="perp-push-blocked">已屏蔽推送</span> : null}
    <button type="button" className="perp-push-toggle" disabled={settings.disabled} aria-label={`${blocked ? "恢复" : "屏蔽并隐藏"} ${base} 的行情与 CrossEx 机会推送`} title={`${blocked ? "恢复" : "隐藏"} ${base} 的排名和全部报价，${blocked ? "恢复" : "停止"}所有交易所和方向的新机会推送；可在上方屏蔽名单中解除`} onClick={() => void settings.setBaseBlocked(base, !blocked)}>{pending ? "保存中…" : blocked ? "恢复显示与推送" : "屏蔽并隐藏"}</button>
    {failure ? <span className="perp-push-error">保存未成功：{failure}</span> : null}
  </div>;
}
