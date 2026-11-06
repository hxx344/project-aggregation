"use client";

import { useEffect, useRef, useState } from "react";
import { HISTORY_REFRESH_MS, HISTORY_TIMEOUT_MS, QUOTE_REFRESH_MS, startActivityPolling } from "../lib/polling";
import { anthropicHistory, retainAnthropicHistory, type AnthropicHistory, type AnthropicQuote } from "../lib/anthropic-history";
import { ANTHROPIC_CANDLE_ACTION, validateAnthropicQuote } from "../modules/anthropic/market.mjs";

const retainedQuote = "后台尚未取得新报价，显示上次保存的数据；请留意采集时间。";

async function request(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("行情更新失败，将在下一轮自动重试。");
  return response.json();
}

/** Validates the raw quote and keeps its freshness metadata. */
function readQuote(input: unknown): AnthropicQuote {
  validateAnthropicQuote(input);
  return input as AnthropicQuote;
}

/** Days the overview card's seven-day trend reads while the detail is closed. */
const SUMMARY_DAYS = 8;
/**
 * Quote and candle polling serve both the overview card and the detail. While the detail is open the
 * candles cover `windowDays` days (null = complete history); otherwise only the card's trend window.
 */
export function useAnthropicFeed(active = true, summaryActive = active, windowDays: number | null = null) {
  const [data, setData] = useState<AnthropicHistory | null>(null);
  const [quote, setQuote] = useState<AnthropicQuote | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [error, setError] = useState("");
  // The window whose read set `error`, so a failure is not attributed to a later selection.
  const [errorWindow, setErrorWindow] = useState<number | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const controls = useRef<{ history?: () => void; quote?: () => void }>({});
  const latest = useRef<AnthropicQuote | null>(null);
  const quoteActive = active || summaryActive;
  const historyDays = active ? windowDays : SUMMARY_DAYS;

  useEffect(() => {
    if (!quoteActive) return;
    const live = startActivityPolling({
      intervalMs: QUOTE_REFRESH_MS,
      load: async signal => readQuote(await request("/api/monitors/anthropic/quote", signal)),
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
    if (!quoteActive) return;
    const history = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      timeoutMs: HISTORY_TIMEOUT_MS,
      load: async signal => anthropicHistory(await request(`/api/monitors/anthropic/${ANTHROPIC_CANDLE_ACTION}${historyDays === null ? "" : `?days=${historyDays}`}`, signal)),
      onData: next => { setData((previous: AnthropicHistory | null) => retainAnthropicHistory(previous, next)); setError(""); },
      // Validation errors are internal English text; only user-facing (Chinese) messages are shown as-is.
      onError: cause => { setError(cause instanceof Error && /[一-鿿]/.test(cause.message) ? cause.message : "15 分钟 K 线校验失败，将在下一轮自动重试。"); setErrorWindow(historyDays); },
      onSettled: () => setHistoryLoading(false),
    });
    controls.current.history = () => { void history.refresh(); };
    return () => { controls.current.history = undefined; history.stop(); };
  }, [quoteActive, historyDays]);

  return {
    data, quote, error, errorWindow, quoteError, loading: historyLoading || quoteLoading,
    refresh: () => { setHistoryLoading(true); setQuoteLoading(true); controls.current.history?.(); controls.current.quote?.(); },
  };
}
