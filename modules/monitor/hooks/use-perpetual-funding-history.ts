"use client";

import { observeReadActivity, readsAllowed } from "../lib/read-activity";

import { useEffect, useRef, useState } from "react";
import { fundingHistoryRequestKey, startPerpetualFundingHistoryFeed } from "../lib/perpetual-funding-history-feed";
import type { FundingHistoryPairRequest, PerpetualFundingHistoryReport } from "../lib/perpetual-funding-history";

export function usePerpetualFundingHistory(pairs: FundingHistoryPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualFundingHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualFundingHistoryFeed> | null>(null);
  const requestKey = fundingHistoryRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualFundingHistoryFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/funding-history", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("历史结算读取失败");
        return await response.json() as PerpetualFundingHistoryReport;
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
