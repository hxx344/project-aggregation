/** Browser-local UI choices, never market snapshots, account data or alert configuration. */
export function readViewPreference(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= 4096 ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function writeViewPreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Disabled/full storage must not break the panel. */ }
}
export const booleanPreference = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
export const rangePreference = (value: unknown, fallback: number | null): number | null => value === null || value === 7 || value === 30 ? value : fallback;
export const legPreference = (value: unknown) => value === 'io' || value === 'rh' ? value : 'xyz';
export const basisPreference = (value: unknown) => value === 'notional' ? value : 'quantity';
export type ChartPreferences = { mode: 'premium' | 'spread' | 'price' | null; sma: boolean; bands: boolean; zscore: boolean };
export const DEFAULT_CHART_PREFERENCES: ChartPreferences = { mode: null, sma: true, bands: true, zscore: true };
export function chartPreference(value: unknown): ChartPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { mode: source.mode === 'premium' || source.mode === 'spread' || source.mode === 'price' ? source.mode : null,
    sma: booleanPreference(source.sma, true), bands: booleanPreference(source.bands, true), zscore: booleanPreference(source.zscore, true) };
}
