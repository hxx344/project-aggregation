"use client";

import { observeReadActivity, readsAllowed } from "../lib/read-activity";

import { useEffect, useRef, useState } from "react";
import { qualityRequestKey, startPerpetualQualityFeed, type QualityPairRequest } from "../lib/perpetual-quality-feed";
import type { PerpetualQualityReport } from "../lib/perpetual-quality";

export function usePerpetualQuality(pairs: QualityPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualQualityFeed> | null>(null);
  const requestKey = qualityRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualQualityFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/quality", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("质量资料读取失败");
        const value = await response.json() as PerpetualQualityReport;
        const records = [value?.pairs, value?.assets, value?.assetErrors, value?.positioning, value?.positioningErrors];
        if (value?.schemaVersion !== 1 || !Number.isFinite(value.generatedAt) || records.some(record => !record || typeof record !== "object" || Array.isArray(record))) throw new Error("质量资料格式异常");
        return value;
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as QualityPairRequest[]); }, [requestKey]);

  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error };
}
