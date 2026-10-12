"use client";

import { backgroundReadDelay, observeReadActivity, readsAllowed } from "../lib/read-activity";

import { useEffect, useState } from "react";
import type { PerpetualFxSnapshot } from "../lib/perpetual-fx";

/** One low-frequency read only when cross-currency comparison is requested. */
export function usePerpetualFx(active: boolean) {
  const [data, setData] = useState<PerpetualFxSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let stopped = false;
    const eligible = () => !stopped && readsAllowed(active);
    async function read() {
      if (!eligible() || controller) return;
      const current = new AbortController(); controller = current;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 12_000);
      try {
        const response = await fetch("/api/monitors/perpetual/fx", { cache: "no-store", signal: current.signal });
        if (!response.ok) throw new Error();
        const result = await response.json() as PerpetualFxSnapshot;
        if (result?.baseCurrency !== "USDT" || !Number.isFinite(result.generatedAt) || !result.rates || Array.isArray(result.rates)) throw new Error();
        if (!current.signal.aborted && eligible()) { setData(result); setError(""); }
      } catch { if (eligible() && (timedOut || !current.signal.aborted)) setError("换汇行情暂不可用，缺失或过期汇率的组合暂不参与排名。"); }
      finally {
        clearTimeout(timeout);
        if (controller === current) { controller = null; if (eligible()) timer = setTimeout(read, backgroundReadDelay(60_000)); }
      }
    }
    function synchronize() {
      clearTimeout(timer);
      if (!eligible()) { controller?.abort(); return; }
      void read();
    }
    const restart = () => { clearTimeout(timer); controller?.abort(); controller = null; void read(); };
    const stop = observeReadActivity(synchronize, restart);
    return () => { stopped = true; stop(); clearTimeout(timer); controller?.abort(); };
  }, [active]);
  return { data, error };
}
