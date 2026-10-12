"use client";

import { useEffect, useRef, useState } from "react";
import { startActivityPolling } from "../lib/polling";
import { createHynixFundingSnapshot, type FundingHistoryData } from "../lib/hynix-funding-history";
import { retainFundingRows } from "../lib/hynix-funding-analysis";

export function useFundingHistory() {
  const [data, setData] = useState<FundingHistoryData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const controls = useRef<{ refresh: () => Promise<void> } | null>(null);
  useEffect(() => {
    const polling = startActivityPolling({
      intervalMs: 300_000,
      async load(signal) {
        const response = await fetch("/api/monitors/hynix/funding", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("历史资金费暂不可用，请稍后刷新。价差行情继续更新。");
        const next = await response.json() as FundingHistoryData;
        const validated = createHynixFundingSnapshot(next.rows, next.metadata.fetchedAt);
        return { ...next, ...validated };
      },
      onData(next) { setData(previous => ({ ...next, rows: retainFundingRows(previous?.rows, next.rows) })); setError(""); },
      onError(cause) { setError(cause instanceof Error ? cause.message : "历史资金费加载失败。"); },
      onSettled() { setLoading(false); },
    });
    controls.current = polling;
    return () => { controls.current = null; polling.stop(); };
  }, []);
  return { data, error, loading, refresh: () => { setLoading(true); void controls.current?.refresh(); } };
}
