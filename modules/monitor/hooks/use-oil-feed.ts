"use client";

import { useEffect, useRef, useState } from "react";
import { HISTORY_REFRESH_MS, HISTORY_TIMEOUT_MS, QUOTE_REFRESH_MS, startActivityPolling } from "../lib/polling";
import { validateOilQuote } from "../lib/market-validation";
import type { QuoteFreshness } from "../lib/market-freshness";
import type { InitialMarketData } from "../lib/initial-market";
import { oilHistory, retainOilHistory, type OilHistory } from "../lib/oil-history";
import { OIL_CANDLE_ACTION } from "../modules/oil/intraday.mjs";

export type { OilHistory };
export type OilQuote = ReturnType<typeof validateOilQuote> & QuoteFreshness & { status?: "live" | "snapshot" };
const retainedQuote = "后台尚未取得新报价，显示上次保存的数据；请留意采集时间。";

async function request(path: string, signal: AbortSignal): Promise<unknown> {
  // The polling signal carries each read's deadline.
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("行情更新失败，将在下一轮自动重试。");
  return response.json();
}

/** Validates the raw quote and keeps its freshness metadata. */
function readQuote(input: unknown): OilQuote {
  validateOilQuote(input);
  return input as OilQuote;
}

/**
 * Quote polling serves both the overview card and the detail; 15-minute candles only poll while the detail is open.
 * The first render embeds only the overview trend, so candles are always read from the API: the last
 * `windowDays` days, or the complete history when it is null.
 */
export function useOilFeed(initial?: InitialMarketData["oil"], active = true, summaryActive = active, windowDays: number | null = null) {
  const [data, setData] = useState<OilHistory | null>(null);
  const [quote, setQuote] = useState<OilQuote | null>(initial?.quote ?? null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [quoteLoading, setQuoteLoading] = useState(!initial?.quote);
  const [error, setError] = useState("");
  // The window whose read set `error`, so a failure is not attributed to a later selection.
  const [errorWindow, setErrorWindow] = useState<number | null>(null);
  const [quoteError, setQuoteError] = useState(initial?.quote?.status === "snapshot" ? retainedQuote : "");
  const controls = useRef<{ history?: () => void; quote?: () => void }>({});
  const latest = useRef<OilQuote | null>(initial?.quote ?? null);
  const quoteActive = active || summaryActive;

  useEffect(() => {
    if (!quoteActive) return;
    const live = startActivityPolling({
      intervalMs: QUOTE_REFRESH_MS,
      load: async signal => readQuote(await request("/api/monitors/oil/quote", signal)),
      onData: next => {
        // An out-of-order older response must not change either the quote or its notice.
        if (latest.current && Date.parse(next.fetchedAt) < Date.parse(latest.current.fetchedAt)) return;
        latest.current = next;
        setQuote(next);
        setQuoteError(next.status === "snapshot" ? retainedQuote : "");
      },
      onError: () => setQuoteError("实时报价更新失败，10 秒后自动重试；请留意报价获取时间。"),
      onSettled: () => setQuoteLoading(false),
    });
    controls.current.quote = () => { void live.refresh(); };
    return () => { controls.current.quote = undefined; live.stop(); };
  }, [quoteActive]);

  useEffect(() => {
    if (!active) return;
    const history = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      timeoutMs: HISTORY_TIMEOUT_MS,
      load: async signal => oilHistory(await request(`/api/monitors/oil/${OIL_CANDLE_ACTION}${windowDays === null ? "" : `?days=${windowDays}`}`, signal)),
      onData: next => { setData(previous => retainOilHistory(previous, next)); setError(""); },
      // Validation errors are internal English text; only user-facing (Chinese) messages are shown as-is.
      onError: cause => { setError(cause instanceof Error && /[\u4e00-\u9fff]/.test(cause.message) ? cause.message : "15 分钟 K 线校验失败，将在下一轮自动重试。"); setErrorWindow(windowDays); },
      onSettled: () => setHistoryLoading(false),
    });
    controls.current.history = () => { void history.refresh(); };
    return () => { controls.current.history = undefined; history.stop(); };
  }, [active, windowDays]);

  return {
    data, quote, error, errorWindow, quoteError, loading: historyLoading || quoteLoading,
    refresh: () => { setHistoryLoading(true); setQuoteLoading(true); controls.current.history?.(); controls.current.quote?.(); },
  };
}
