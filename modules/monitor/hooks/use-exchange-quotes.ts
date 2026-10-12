"use client";

import { useEffect, useRef, useState } from "react";
import { comparisonExchanges, exchangeAction, validateComparisonQuote, EXCHANGE_REFRESH_MS, type Exchange, type ExternalQuoteSet, type SpreadMarket } from "../lib/exchange-quotes";
import { startActivityPolling } from "../lib/polling";

export function useExchangeQuotes(monitorId: SpreadMarket, initial?: ExternalQuoteSet, active = true) {
  const [quotes, setQuotes] = useState<ExternalQuoteSet>(initial ?? {});
  const [errors, setErrors] = useState<Partial<Record<Exchange, string>>>({});
  const [loading, setLoading] = useState(false);
  const polls = useRef<ReturnType<typeof startActivityPolling>[]>([]);
  const latest = useRef<ExternalQuoteSet>(initial ?? {});
  useEffect(() => {
    if (!active) return;
    const controls = comparisonExchanges(monitorId).map(exchange => startActivityPolling({
      intervalMs: EXCHANGE_REFRESH_MS,
      async load(signal) {
        const response = await fetch(`/api/monitors/${monitorId}/${exchangeAction(exchange)}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw new Error("本轮更新失败，保留上次数据");
        return validateComparisonQuote(await response.json(), exchange, monitorId);
      },
      onData(value) {
        if (!value) return;
        if (latest.current[exchange] && Date.parse(latest.current[exchange]!.fetchedAt) > Date.parse(value.fetchedAt)) {
          setErrors(previous => ({ ...previous, [exchange]: "收到较旧报价，保留已有数据" })); return;
        }
        latest.current[exchange] = value;
        setQuotes(previous => ({ ...previous, [exchange]: value }));
        setErrors(previous => ({ ...previous, [exchange]: "" }));
      },
      onError(error) { setErrors(previous => ({ ...previous, [exchange]: error instanceof Error ? error.message : "行情暂不可用" })); },
    }));
    polls.current = controls;
    return () => { controls.forEach(control => control.stop()); polls.current = []; };
  }, [monitorId, active]);
  async function refresh() {
    setLoading(true);
    try { await Promise.all(polls.current.map(poll => poll.refresh())); }
    finally { setLoading(false); }
  }
  return { quotes, errors, refresh, loading };
}
