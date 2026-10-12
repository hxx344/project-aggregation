"use client";

import { useEffect, useRef, useState } from 'react';
import { observeReadActivity, readsAllowed } from '../lib/read-activity';
import { priceHistoryIsStale, startPerpetualPriceHistoryFeed, type PerpetualPriceHistoryReport, type PriceHistoryDays } from '../lib/perpetual-price-history';
import type { FundingHistoryPairRequest } from '../lib/perpetual-funding-history';

export function usePerpetualPriceHistory(pair: FundingHistoryPairRequest | null, days: PriceHistoryDays, enabled = true) {
  const [report, setReport] = useState<PerpetualPriceHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualPriceHistoryFeed> | null>(null);
  const requestKey = pair ? JSON.stringify([pair.base, pair.longKey, pair.shortKey]) : '';
  useEffect(() => {
    const feed = startPerpetualPriceHistoryFeed({
      load: async (requested, days, signal) => {
        const response = await fetch('/api/monitors/perpetual/price-history', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pair: requested, days }), signal });
        if (!response.ok) throw Error('成交价历史读取失败');
        return response.json();
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => {
    const selected = requestKey ? JSON.parse(requestKey) as string[] : null;
    controls.current?.setSelection(selected ? { base: selected[0], longKey: selected[1], shortKey: selected[2] } : null, days);
  }, [requestKey, days]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(enabled));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(enabled)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [enabled]);
  // The render that changes selection must already hide the previous pair,
  // before effects have had an opportunity to cancel its request.
  const selectedReport = report && pair && report.legs[pair.longKey] && report.legs[pair.shortKey]
    && JSON.parse(report.legs[pair.longKey].identity)[2] === pair.base ? report : null;
  const states = Object.values(selectedReport?.legs ?? {}).map(leg => leg.status);
  const status = error || states.includes('error') ? 'error' : states.includes('unsupported') ? 'unsupported' : !selectedReport || states.includes('pending') ? 'pending' : 'ready';
  return { report: selectedReport, loading, error: [error, selectedReport?.storageError].filter(Boolean).join(' '), status, isStale: Boolean(error && selectedReport) || priceHistoryIsStale(selectedReport) };
}
