"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HISTORY_REFRESH_MS, validateExchangeFundingHistory, type ExchangeFundingHistory } from "../lib/exchange-funding-history";
import { validateOilHedgePrices, type OilHedgePrices } from "../lib/oil-hedge-prices";
import { startActivityPolling } from "../lib/polling";

type Source = "bybit" | "binance" | "prices";
type HistoryData = { bybit?: ExchangeFundingHistory; binance?: ExchangeFundingHistory; prices?: OilHedgePrices };
const sources = ["bybit", "binance", "prices"] as const;
const labels = { bybit: "Bybit 资金费", binance: "Binance 资金费", prices: "四腿历史价格" };
const networkSubscribe = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
};

/** Each source can settle independently; a failed read never clears another source. */
export function useOilHedgeHistory(active: boolean) {
  const [data, setData] = useState<HistoryData>({});
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const [pending, setPending] = useState<Record<Source, boolean>>({ bybit: true, binance: true, prices: true });
  const latest = useRef<HistoryData>({});
  const controls = useRef<Partial<Record<Source, ReturnType<typeof startActivityPolling>>>>({});
  const online = useSyncExternalStore(networkSubscribe, () => navigator.onLine, () => true);

  useEffect(() => {
    if (!active) return;
    const current = sources.map(source => {
      const polling = startActivityPolling({
        intervalMs: HISTORY_REFRESH_MS,
        async load(signal) {
          const path = source === "prices" ? "funding-hedge/prices" : `exchanges/${source}/funding-history`;
          const response = await fetch(`/api/monitors/oil/${path}`, { cache: "no-store", signal });
          if (!response.ok) throw new Error(response.status === 423 ? "原油监控已暂停。" : `${labels[source]}读取失败，已有数据保留。`);
          try {
            const payload: unknown = await response.json();
            return source === "prices" ? validateOilHedgePrices(payload) : validateExchangeFundingHistory(payload, source);
          } catch { throw new Error(`${labels[source]}格式异常，已有数据保留。`); }
        },
        onData(value) {
          const previous = latest.current[source];
          if (previous && Date.parse(value.fetchedAt) < Date.parse(previous.fetchedAt)) {
            setErrors(old => ({ ...old, [source]: `${labels[source]}返回较旧数据，保留已有记录。` }));
            return;
          }
          const next = { ...latest.current, [source]: value } as HistoryData;
          latest.current = next;
          setData(next);
          setErrors(old => ({ ...old, [source]: "" }));
        },
        onError(error) { setErrors(old => ({ ...old, [source]: error instanceof Error ? error.message : `${labels[source]}暂不可用。` })); },
        onSettled() { setPending(old => ({ ...old, [source]: false })); },
      });
      controls.current[source] = polling;
      return polling;
    });
    return () => { current.forEach(control => control.stop()); controls.current = {}; };
  }, [active]);

  async function refresh() {
    if (!active || !online) return;
    setPending({ bybit: true, binance: true, prices: true });
    await Promise.all(sources.map(async source => {
      try { await controls.current[source]?.refresh(); }
      finally { setPending(old => ({ ...old, [source]: false })); }
    }));
  }
  return { ...data, errors, loading: active && online && Object.values(pending).some(Boolean), online, refresh };
}
