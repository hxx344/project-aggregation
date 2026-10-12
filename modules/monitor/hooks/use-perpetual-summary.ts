"use client";

import { useEffect, useState } from 'react';
import { startActivityPolling } from '../lib/polling';
import { failedPerpetualSummary, perpetualMonitorSummary, readPerpetualSummary, PERPETUAL_SUMMARY_REFRESH_MS } from '../lib/perpetual-summary';
import type { MonitorSummary } from '../lib/monitor-summary';

/** The visible overview owns one small cached read, independently of detail streams. */
export function usePerpetualSummary(active: boolean): MonitorSummary {
  const [summary, setSummary] = useState<MonitorSummary>(() => perpetualMonitorSummary());
  useEffect(() => {
    const polling = startActivityPolling({ active, intervalMs: PERPETUAL_SUMMARY_REFRESH_MS, load: readPerpetualSummary,
      onData: value => setSummary(previous => perpetualMonitorSummary(value, previous)),
      onError: () => setSummary(failedPerpetualSummary) });
    return () => polling.stop();
  }, [active]);
  return summary;
}
