"use client";

import { useEffect, useRef, useState } from "react";
import { startActivityPolling } from "../lib/polling";
import { retainFundingRows } from "../lib/hynix-funding-analysis";
import type { SettledFundingRow } from "../lib/hynix-funding-history";
import { validateFundingSnapshot } from "../modules/oil/binance-funding-history.mjs";

export const OIL_FUNDING_REFRESH_MS = 300_000;
type OilFunding = { rows: SettledFundingRow[]; fetchedAt: string; status: "live" | "snapshot" };

/** Binance four-hour settlements; leg A (`adr`) = Brent, leg B (`ordinary`) = WTI, per-settlement rates. */
export function useOilFunding() {
  const [data, setData] = useState<OilFunding | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const controls = useRef<{ refresh: () => Promise<void> } | null>(null);
  useEffect(() => {
    const polling = startActivityPolling({
      intervalMs: OIL_FUNDING_REFRESH_MS,
      async load(signal) {
        const response = await fetch("/api/monitors/oil/funding", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("历史资金费暂不可用，请稍后刷新。价差行情继续更新。");
        const input = await response.json() as { status?: string };
        const snapshot = validateFundingSnapshot(input);
        const rows = snapshot.data.map(row => ({ time: row.time as number, adr: row.brent as number | null, ordinary: row.wti as number | null }));
        return { rows, fetchedAt: snapshot.metadata.fetchedAt as string, status: input.status === "snapshot" ? "snapshot" as const : "live" as const };
      },
      onData(next) {
        setData(previous => previous && Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt) ? previous : { ...next, rows: retainFundingRows(previous?.rows, next.rows) });
        setError("");
      },
      onError(cause) { setError(cause instanceof Error && /[一-鿿]/.test(cause.message) ? cause.message : "历史资金费校验失败，将在下一轮自动重试。"); },
      onSettled() { setLoading(false); },
    });
    controls.current = polling;
    return () => { controls.current = null; polling.stop(); };
  }, []);
  return { data, error, loading, refresh: () => { setLoading(true); void controls.current?.refresh(); } };
}
