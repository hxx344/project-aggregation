import type { LiveBootstrap, LiveState } from './live-types';

export const CATALOG_CACHE_MS = 5 * 60_000;
export const BOOTSTRAP_REFRESH_MS = 30_000;
export const stateReadPath = (tab: string) => tab === 'hedge' ? '/api/state' : '/api/state?opportunities=0';
export const needsCatalog = (tab: string) => ['trade', 'hedge', 'positions'].includes(tab);
export const readRetryDelay = (failures: number) => Math.min(30_000, 3000 * 2 ** Math.max(0, Math.min(failures - 1, 4)));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const validCsrf = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** The lightweight response is authoritative configuration, never a manufactured empty account. */
export function parseBootstrap(value: unknown): LiveBootstrap {
  if (!object(value) || !Number.isFinite(value.now) || !validCsrf(value.csrfToken) || !object(value.connection)
    || typeof value.connection.configured !== 'boolean' || typeof value.connection.connected !== 'boolean'
    || !object(value.config) || typeof value.config.monitorUrl !== 'string' || typeof value.config.entryPaused !== 'boolean') {
    throw new Error('连接信息格式不可用，请重试读取');
  }
  return value as LiveBootstrap;
}

export function latestBootstrap(bootstrap: LiveBootstrap | null, state: LiveState | null): LiveBootstrap | null {
  const fromState = state && validCsrf(state.csrfToken) && state.config && state.live?.connection
    ? { now: state.now, config: state.config, connection: state.live.connection, csrfToken: state.csrfToken } : null;
  if (!bootstrap) return fromState;
  if (!fromState) return bootstrap;
  return bootstrap.now >= fromState.now ? bootstrap : fromState;
}

/** Public catalogue data stays in memory; configuration and secrets never enter this cache. */
export function createTimedCache<T>(ttl: number, clock = Date.now) {
  let value: T | null = null, expiresAt = 0;
  return {
    peek: () => ({ value, fresh: value !== null && clock() < expiresAt, remaining: Math.max(0, expiresAt - clock()) }),
    put(next: T) { value = next; expiresAt = clock() + ttl; },
  };
}
