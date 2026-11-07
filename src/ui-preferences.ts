/** Small, versioned display/form preferences only. Never store account data or execution authorization. */
export function readPreference(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= 32_768 ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writePreference(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled or full; editing still works. */ }
}

export function preferenceObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function preferenceChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback;
}
