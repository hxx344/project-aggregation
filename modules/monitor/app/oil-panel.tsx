"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { mount as mountChart } from "../modules/oil/app.mjs";
import { createOilSummaryReader, type SummaryProps } from "../lib/monitor-summary";
import { initialSummaries, type InitialMarketData } from "../lib/initial-market";
import { useHubFills, type HubFillsView } from "../lib/hub-fills";
type Mounted = { dispose: () => void; setActive: (active: boolean) => void; setSummaryActive: (active: boolean) => void; setTrades: (view: HubFillsView) => void };

export default function OilPanel({ onSummary, initial = null, active = true, summaryActive = active, tradesActive = false, children }: SummaryProps & { initial?: InitialMarketData | null; active?: boolean; summaryActive?: boolean; tradesActive?: boolean; children?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const mountedPanel = useRef<Mounted | null>(null);
  const activeRef = useRef(active);
  const summaryActiveRef = useRef(summaryActive);
  const trades = useHubFills('oil', tradesActive);
  const tradesRef = useRef(trades);
  useEffect(() => { tradesRef.current = trades; mountedPanel.current?.setTrades(trades); }, [trades]);
  useEffect(() => { activeRef.current = active; mountedPanel.current?.setActive(active); }, [active]);
  useEffect(() => { summaryActiveRef.current = summaryActive; mountedPanel.current?.setSummaryActive(summaryActive); }, [summaryActive]);
  useEffect(() => {
    const controller = new AbortController();
    const node = host.current!;
    const root = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    const mounted: Mounted[] = [];
    const summarize = createOilSummaryReader();
    async function load() {
      try {
        const responses = await Promise.all(["/oil/panel.html", "/oil/styles.css"].map(url => fetch(url, { signal: controller.signal })));
        if (responses.some(response => !response.ok)) throw new Error("原油面板加载失败，请刷新页面重试。");
        const [html, css] = await Promise.all(responses.map(response => response.text()));
        controller.signal.throwIfAborted();
        // This markup is a checked-in first-party asset, never user/API HTML.
        root.innerHTML = `<style>${css}</style>${html}`;
        const panel = mountChart(root, { initial: initial?.oil, initialReadAt: initial?.renderedAt, active: activeRef.current, summaryActive: summaryActiveRef.current, onSummary: update => onSummary?.(summarize(update)) });
        mounted.push(panel); mountedPanel.current = panel; panel.setTrades(tradesRef.current);
        root.querySelectorAll<HTMLAnchorElement>("[data-local-anchor]").forEach(anchor => anchor.addEventListener("click", event => { event.preventDefault(); root.getElementById(anchor.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }); }, { signal: controller.signal }));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "原油面板加载失败。");
          // Light-DOM details (exchange comparison) only render through this slot.
          const slot = document.createElement("slot"); slot.name = "after-chart"; root.replaceChildren(slot);
          onSummary?.({ ...initialSummaries(initial).oil, status: initial?.oil.quote ? "stale" : "error" });
        }
      }
    }
    void load();
    return () => { controller.abort(); mountedPanel.current = null; mounted.forEach(panel => panel.dispose()); root.replaceChildren(); };
  }, [onSummary, initial]);
  return <>{error && <p role="alert" className="notice error">{error}</p>}<div ref={host} data-monitor="oil">{children}</div></>;
}
