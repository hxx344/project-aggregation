"use client";

import { observeReadActivity, readsAllowed } from "../lib/read-activity";

import { useEffect, useRef, useState } from "react";
import { marketMetricsRequestKey, startPerpetualMarketMetricsFeed } from "../lib/perpetual-market-metrics-feed";
import type { FundingHistoryPairRequest } from "../lib/perpetual-funding-history";
import type { PerpetualMarketMetricsReport } from "../lib/perpetual-market-metrics";

export function usePerpetualMarketMetrics(pairs: FundingHistoryPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualMarketMetricsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualMarketMetricsFeed> | null>(null);
  const requestKey = marketMetricsRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualMarketMetricsFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/metrics", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("市场指标读取失败");
        return await response.json() as PerpetualMarketMetricsReport;
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as FundingHistoryPairRequest[]); }, [requestKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error: [error, report?.storageError].filter(Boolean).join(" ") };
}
