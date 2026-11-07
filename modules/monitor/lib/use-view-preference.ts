import { useCallback, useEffect, useState } from 'react';
import type { SetStateAction } from 'react';
import { readViewPreference, writeViewPreference } from './view-preferences';

/** Hydrate with the server default, then restore once. Writes only start after restoration. */
export function useViewPreference<T>(key: string, fallback: T, decode: (value: unknown, fallback: T) => T): [T, (next: SetStateAction<T>) => void] {
  const [stored, setStored] = useState({ key, value: fallback, ready: false });
  useEffect(() => {
    const raw = readViewPreference(key);
    // Missing storage and an explicitly stored null ("all" range) have different meanings.
    const value = raw && typeof raw === 'object' && 'value' in raw ? decode(raw.value, fallback) : fallback;
    setStored({ key, value, ready: true });
  }, [key, fallback, decode]);
  useEffect(() => { if (stored.key === key && stored.ready) writeViewPreference(key, { value: stored.value }); }, [key, stored]);
  const setValue = useCallback((next: SetStateAction<T>) => setStored(current => ({ key, ready: true,
    value: typeof next === 'function' ? (next as (previous: T) => T)(current.key === key ? current.value : fallback) : next,
  })), [key, fallback]);
  return [stored.key === key ? stored.value : fallback, setValue];
}
