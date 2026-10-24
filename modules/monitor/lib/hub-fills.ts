"use client";

import { useEffect, useMemo, useState } from 'react';
import { useHubHost, postHubMessage, subscribeHubFills, subscribeHostReady } from './hub-bridge.ts';
import { createFillsPoller, emptyFillsView, retainFillsReply, type FillMarket, type HubFillsView } from './hub-fills-contract.ts';
export type { HubFillsView } from './hub-fills-contract.ts';

/** Foreground only. Successful reads replace the snapshot; failures retain its original time. */
export function useHubFills(market: FillMarket, active: boolean): HubFillsView {
  const host = useHubHost();
  const mode = !host.embedded ? 'standalone' : !host.connected ? 'connecting' : !host.fills ? 'unsupported' : null;
  const [stored, setStored] = useState<HubFillsView | null>(null);
  useEffect(() => {
    if (mode || !active) return;
    const requester = createFillsPoller({
      send: postHubMessage,
      onReply: reply => setStored(current => retainFillsReply(current, reply)),
    }, market);
    const stopReplies = subscribeHubFills(value => { requester.receive(value); });
    const stopReady = subscribeHostReady(() => { requester.retry(); });
    requester.start();
    return () => { stopReplies(); stopReady(); requester.dispose(); };
  }, [market, active, mode]);
  return useMemo(() => mode ? emptyFillsView(mode) : stored ?? emptyFillsView('loading'), [mode, stored]);
}
