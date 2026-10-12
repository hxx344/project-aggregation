"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPerpetualClock, readPerpetualSnapshot, startPerpetualFeed, type PerpetualConnection } from "../lib/perpetual-feed";
import type { PerpetualSnapshot } from "../lib/perpetual-types";
import { backgroundReadDelay, readActivity } from "../lib/read-activity";
import { createPerpetualDisplay, PERPETUAL_DISPLAY_INTERVAL_MS } from "../lib/perpetual-display";

export function usePerpetualFeed(active: boolean, paused = false) {
  const [data, setData] = useState<PerpetualSnapshot | null>(null);
  const [connection, setConnection] = useState<PerpetualConnection>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const controls = useRef<ReturnType<typeof startPerpetualFeed> | null>(null);
  const display = useRef<ReturnType<typeof createPerpetualDisplay> | null>(null);
  const [sourceClock] = useState(() => createPerpetualClock());

  useEffect(() => {
    const publisher = createPerpetualDisplay({ onData: snapshot => { setData(snapshot); setNow(sourceClock.read()); } });
    display.current = publisher;
    let clock: ReturnType<typeof setInterval> | undefined;
    let background = readActivity.background(document.hidden);
    function synchronizeVisibility(event?: Event) {
      clearInterval(clock);
      if (!active || !readActivity.allowed(document.hidden)) { controls.current?.stop(); controls.current = null; publisher.reset(); setConnection("paused"); return; }
      const previousBackground = background;
      background = readActivity.background(document.hidden);
      const updateClock = () => {
        // Source time still ages between display updates; old quotes must expire on time.
        setNow(sourceClock.read());
      };
      updateClock();
      clock = setInterval(updateClock, backgroundReadDelay(1_000));
      // Inspection stops network work, but source time must still age so a
      // retained quote cannot stay "fresh" indefinitely while the user reads it.
      if (paused) { controls.current?.stop(); controls.current = null; publisher.reset(); setConnection("paused"); return; }
      if (!navigator.onLine) {
        controls.current?.stop(); controls.current = null;
        publisher.reset();
        setConnection("error");
        setError("网络已断开，恢复连接后自动更新。");
        return;
      }
      if (controls.current) {
        if (!background && (previousBackground || event?.type === 'focus' || event?.type === 'pageshow' || event?.type === 'online')) { controls.current.resume(); publisher.flush(); }
        return;
      }
      controls.current = startPerpetualFeed({
        fetchSnapshot: readPerpetualSnapshot,
        pollIntervalMs: () => backgroundReadDelay(PERPETUAL_DISPLAY_INTERVAL_MS),
        createStream: () => {
          const source = new EventSource("/api/monitors/perpetual/stream");
          const adapter: { onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null; close: () => void } = { onmessage: null, onerror: null, close: () => source.close() };
          source.onmessage = event => adapter.onmessage?.({ data: event.data });
          source.onerror = () => adapter.onerror?.();
          return adapter;
        },
        onData: (snapshot, context) => {
          sourceClock.accept(snapshot.generatedAt, snapshot.streamId, context.baseline);
          publisher.accept(snapshot);
        }, onConnection: setConnection, onError: setError,
      });
    }
    synchronizeVisibility();
    const unsubscribe = readActivity.subscribe(synchronizeVisibility);
    document.addEventListener("visibilitychange", synchronizeVisibility);
    window.addEventListener("online", synchronizeVisibility);
    window.addEventListener("offline", synchronizeVisibility);
    window.addEventListener("focus", synchronizeVisibility);
    window.addEventListener("pageshow", synchronizeVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", synchronizeVisibility);
      window.removeEventListener("online", synchronizeVisibility);
      window.removeEventListener("offline", synchronizeVisibility);
      window.removeEventListener("focus", synchronizeVisibility);
      window.removeEventListener("pageshow", synchronizeVisibility);
      clearInterval(clock);
      publisher.stop(); display.current = null;
      controls.current?.stop(); controls.current = null;
    };
  }, [active, paused, sourceClock]);

  const refresh = useCallback(() => {
    const feed = controls.current, publisher = display.current;
    if (!feed || !publisher) return;
    publisher.flush();
    void feed.refresh().then(() => { if (controls.current === feed) publisher.flush(); });
  }, []);
  return { data, connection, error, now, refresh };
}
