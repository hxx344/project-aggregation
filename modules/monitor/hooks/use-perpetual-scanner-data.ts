"use client";

import { observeReadActivity, readsAllowed } from "../lib/read-activity";

import { useEffect, useMemo, useRef, useState } from 'react';
import { startPerpetualScannerDataFeed } from '../lib/perpetual-scanner-data-feed';
import { scannerDataRequirementsKey, scannerDataSelectionKey, type PerpetualScannerDataReport, type ScannerDataPair, type ScannerDataRequirements } from '../lib/perpetual-scanner-data';

export function usePerpetualScannerData(pairs: ScannerDataPair[], requirements: ScannerDataRequirements, active: boolean) {
  const [report, setReport] = useState<PerpetualScannerDataReport | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualScannerDataFeed> | null>(null);
  const selectionKey = useMemo(() => scannerDataSelectionKey(pairs), [pairs]);
  const requirementsKey = useMemo(() => scannerDataRequirementsKey(requirements), [requirements]);
  useEffect(() => {
    const feed = startPerpetualScannerDataFeed({
      load: async (request, signal) => {
        const response = await fetch('/api/monitors/perpetual/scanner-data', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
        if (!response.ok) throw Error('筛选数据读取失败');
        return await response.json() as PerpetualScannerDataReport;
      },
      onData: setReport, onLoading: setLoading, onError: setError,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => { controls.current?.setSelection(JSON.parse(selectionKey) as ScannerDataPair[], JSON.parse(requirementsKey) as ScannerDataRequirements); }, [selectionKey, requirementsKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error: [error, report?.storageError].filter(Boolean).join(' ') };
}
