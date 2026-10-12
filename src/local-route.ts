export const LOCAL_ROUTE_URL = 'http://127.0.0.1:3101/route';
export const LOCAL_ROUTE_ORIGIN = 'http://hub.localhost:3100';
const intervalMs = 10_000;
const timeoutMs = 15_000;
const maxAgeMs = 15_000;

export type LocalRouteState = {
  state: 'direct' | 'unknown' | 'checking' | 'paused' | 'offline';
  reason: string;
  server?: string;
  sshPort?: number;
  checkedAt?: number;
};
export const initialLocalRoute: LocalRouteState = { state: 'unknown', reason: 'not-connected' };

export function decodeLocalRoute(value: unknown, now = Date.now()): LocalRouteState {
  if (!value || typeof value !== 'object') throw new Error('Invalid route response');
  const data = value as Record<string, unknown>;
  const checkedAt = typeof data.checkedAt === 'string' ? Date.parse(data.checkedAt) : NaN;
  if (data.service !== 'project-aggregation-local-route' || data.schema !== 1 ||
      (data.state !== 'direct' && data.state !== 'unknown') || typeof data.reason !== 'string' || data.reason.length > 100 ||
      (data.state === 'direct' && data.reason !== 'verified-direct') ||
      typeof data.server !== 'string' || !/^[\da-fA-F:.]{2,45}$/.test(data.server) ||
      typeof data.sshPort !== 'number' || !Number.isInteger(data.sshPort) || data.sshPort < 1 || data.sshPort > 65535 ||
      !Number.isFinite(checkedAt) || checkedAt < now - maxAgeMs || checkedAt > now + 2_000) throw new Error('Invalid or stale route response');
  return { state: data.state as 'direct' | 'unknown', reason: data.reason, server: data.server, sshPort: data.sshPort, checkedAt };
}

export async function readLocalRoute(signal: AbortSignal, fetcher = fetch): Promise<LocalRouteState> {
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      signal.throwIfAborted();
      // Do not use the authenticated hub API client: local requests must never carry its credentials.
      const response = await fetcher(LOCAL_ROUTE_URL, { signal, method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Local route helper unavailable');
      const data: unknown = await response.json();
      signal.throwIfAborted();
      return decodeLocalRoute(data);
    })()]);
  } finally { signal.removeEventListener('abort', cancel); }
}

export function createLocalRouteMonitor({ onChange, read = readLocalRoute }: {
  onChange: (state: LocalRouteState) => void;
  read?: (signal: AbortSignal) => Promise<LocalRouteState>;
}) {
  let active = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | null = null;
  const cancel = () => {
    clearTimeout(timer); clearTimeout(deadline);
    const previous = current; current = null; previous?.abort();
  };
  const refresh = async () => {
    if (disposed || !active || current) return;
    clearTimeout(timer);
    const controller = new AbortController(); current = controller;
    onChange({ state: 'checking', reason: 'checking' });
    deadline = setTimeout(() => controller.abort(new DOMException('Local route probe timed out', 'TimeoutError')), timeoutMs);
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([read(controller.signal), aborted]);
      if (!disposed && current === controller) onChange(value);
    } catch {
      if (!disposed && current === controller) onChange({ state: 'unknown', reason: 'not-connected' });
    } finally {
      controller.signal.removeEventListener('abort', abort);
      if (!disposed && current === controller) {
        clearTimeout(deadline); current = null;
        timer = setTimeout(() => void refresh(), intervalMs);
      }
    }
  };
  return {
    sync({ supported, online, visible }: { supported: boolean; online: boolean; visible: boolean }) {
      if (disposed) return;
      active = supported && online && visible;
      if (!active) {
        cancel();
        onChange(!supported ? { state: 'unknown', reason: 'unsupported-origin' } : !online ? { state: 'offline', reason: 'offline' } : { state: 'paused', reason: 'paused' });
      } else void refresh();
    },
    dispose() { disposed = true; cancel(); },
  };
}
