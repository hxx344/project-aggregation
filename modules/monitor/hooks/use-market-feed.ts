"use client";

import { useEffect, useRef, useState } from "react";
import { retainHistoryPoints, type LiveQuote, type MarketData } from "../lib/market";
import { parseTrendHistory, type TrendHistory } from "../lib/monitor-trend";
import { HISTORY_REFRESH_MS, HISTORY_TIMEOUT_MS, QUOTE_REFRESH_MS, startActivityPolling } from "../lib/polling";
import type { InitialMarketData } from "../lib/initial-market";

const retainedQuote = "后台尚未取得新报价，显示上次保存的数据；请留意采集时间。";

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  // The polling signal carries each read's deadline.
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("行情更新失败，将在下一轮自动重试。");
  return response.json();
}

/**
 * Quotes serve both the overview card and the detail. The full history only polls while the detail is open;
 * otherwise the card polls the server's seven-day trend. The first render embeds only that trend.
 */
export function useMarketFeed(initial?: InitialMarketData["hynix"], active = true, summaryActive = active) {
  const [data,setData] = useState<MarketData | null>(null);
  const [trend,setTrend] = useState<TrendHistory | null>(null);
  const [quote,setQuote] = useState<LiveQuote | null>(initial?.quote ?? null);
  const [historyLoading,setHistoryLoading] = useState(true);
  const [quoteLoading,setQuoteLoading] = useState(!initial?.quote);
  const [error,setError] = useState("");
  const [trendError,setTrendError] = useState(false);
  const [quoteError,setQuoteError] = useState(initial?.quote?.status === "snapshot" ? retainedQuote : "");
  const controls = useRef<{ history?: () => void; quote?: () => void }>({});
  const quoteActive = active || summaryActive, trendActive = summaryActive && !active;
  // A failure flag outlives pauses (offline, hidden) of its own reader and clears only on that reader's success,
  // but another reader taking over the card must not inherit a flag it never raised.
  const reader = active ? "history" : trendActive ? "trend" : null;
  const [lastReader,setLastReader] = useState(reader);
  if (reader && reader !== lastReader) {
    setLastReader(reader);
    if (reader === "history") setError(""); else setTrendError(false);
  }

  useEffect(() => {
    if (!quoteActive) return;
    const live = startActivityPolling({
      intervalMs: QUOTE_REFRESH_MS,
      load: signal => request<LiveQuote>("/api/monitors/hynix/quote",signal),
      onData: next => { setQuote(next); setQuoteError(next.status === "snapshot" ? retainedQuote : ""); },
      onError: () => setQuoteError("实时报价更新失败，10 秒后自动重试；请留意报价获取时间。"),
      onSettled: () => setQuoteLoading(false),
    });
    controls.current.quote = () => { void live.refresh(); };
    return () => { controls.current.quote = undefined; live.stop(); };
  },[quoteActive]);

  useEffect(() => {
    if (!active) return;
    const history = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      timeoutMs: HISTORY_TIMEOUT_MS,
      load: async signal => {
        const next = await request<MarketData>("/api/monitors/hynix/history",signal);
        if (!next.points?.length) throw new Error("暂时没有可对齐的历史行情。");
        return next;
      },
      onData: next => { setData(previous => retainHistoryPoints(previous, next)); setError(""); },
      onError: error => setError(error instanceof Error ? error.message : "历史行情加载失败。"),
      onSettled: () => setHistoryLoading(false),
    });
    controls.current.history = () => { void history.refresh(); };
    return () => { controls.current.history = undefined; history.stop(); };
  },[active]);

  useEffect(() => {
    if (!trendActive) return;
    const overview = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      load: async signal => parseTrendHistory(await request<unknown>("/api/monitors/hynix/trend", signal)),
      // An out-of-order older response must not replace a newer trend.
      onData: next => { setTrend(previous => previous && Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt) ? previous : next); setTrendError(false); },
      onError: () => setTrendError(true),
    });
    return () => overview.stop();
  },[trendActive]);

  return {
    data, trend, quote, error, trendError, quoteError, loading: historyLoading || quoteLoading,
    refresh: () => { setHistoryLoading(true); setQuoteLoading(true); controls.current.history?.(); controls.current.quote?.(); },
  };
}
