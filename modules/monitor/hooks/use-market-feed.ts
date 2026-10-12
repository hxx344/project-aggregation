"use client";

import { useEffect, useRef, useState } from "react";
import { retainHistoryPoints, type LiveQuote, type MarketData } from "../lib/market";
import { HISTORY_REFRESH_MS, QUOTE_REFRESH_MS, startActivityPolling } from "../lib/polling";
import type { InitialMarketData } from "../lib/initial-market";

const retainedQuote = "后台尚未取得新报价，显示上次保存的数据；请留意采集时间。";

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.any([signal,AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new Error("行情更新失败，将在下一轮自动重试。");
  return response.json();
}

export function useMarketFeed(initial?: InitialMarketData["hynix"], initialReadAt?: number, active = true) {
  const [data,setData] = useState<MarketData | null>(initial?.history ?? null);
  const [quote,setQuote] = useState<LiveQuote | null>(initial?.quote ?? null);
  const [historyLoading,setHistoryLoading] = useState(!initial?.history);
  const [quoteLoading,setQuoteLoading] = useState(!initial?.quote);
  const [error,setError] = useState("");
  const [quoteError,setQuoteError] = useState(initial?.quote?.status === "snapshot" ? retainedQuote : "");
  const controls = useRef<{ refresh: () => void } | null>(null);
  const hydrated = useRef({ history: Boolean(initial?.history), readAt: initialReadAt ?? 0 });
  const activated = useRef(false);

  useEffect(() => {
    if (!active) return;
    const history = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      immediate: activated.current || !hydrated.current.history || Date.now() - hydrated.current.readAt >= HISTORY_REFRESH_MS,
      load: async signal => {
        const next = await request<MarketData>("/api/monitors/hynix/history",signal);
        if (!next.points?.length) throw new Error("暂时没有可对齐的历史行情。");
        return next;
      },
      onData: next => { setData(previous => retainHistoryPoints(previous, next)); setError(""); },
      onError: error => setError(error instanceof Error ? error.message : "历史行情加载失败。"),
      onSettled: () => setHistoryLoading(false),
    });
    const live = startActivityPolling({
      intervalMs: QUOTE_REFRESH_MS,
      load: signal => request<LiveQuote>("/api/monitors/hynix/quote",signal),
      onData: next => { setQuote(next); setQuoteError(next.status === "snapshot" ? retainedQuote : ""); },
      onError: () => setQuoteError("实时报价更新失败，10 秒后自动重试；请留意报价获取时间。"),
      onSettled: () => setQuoteLoading(false),
    });
    controls.current = { refresh: () => { void history.refresh(); void live.refresh(); } };
    activated.current = true;
    return () => { controls.current = null; history.stop(); live.stop(); };
  },[active]);

  return {
    data, quote, error, quoteError, loading: historyLoading || quoteLoading,
    refresh: () => { setHistoryLoading(true); setQuoteLoading(true); controls.current?.refresh(); },
  };
}
