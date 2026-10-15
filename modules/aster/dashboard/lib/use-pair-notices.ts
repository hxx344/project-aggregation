'use client';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPairNoticeStore } from './pair-notice-store';
import type { Pair } from './pairs';

export function usePairNotices(pairs: Pair[], now: number, offline: boolean) {
  const [store] = useState(createPairNoticeStore);
  const observations = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  // Observe committed data before paint, including immediate error/recovery
  // updates. The external clock and its deadline timer stay outside render.
  useLayoutEffect(
    () => store.update(pairs, now, offline),
    [store, pairs, now, offline],
  );
  return { observations, clear: store.clear };
}
