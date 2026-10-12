export const CONNECTION_INTERVAL_MS = 10_000;
export const CONNECTION_TIMEOUT_MS = 3_000;

export type ConnectionQuality = 'checking' | 'good' | 'fair' | 'slow' | 'unreachable' | 'offline' | 'paused';
export type ConnectionState = { quality: ConnectionQuality; latencyMs: number | null; checkedAt: number | null };
export const initialConnectionState: ConnectionState = { quality: 'checking', latencyMs: null, checkedAt: null };

export function latencyQuality(latencyMs: number): ConnectionQuality {
  return latencyMs <= 150 ? 'good' : latencyMs <= 500 ? 'fair' : 'slow';
}

// The caller supplies the existing API client so its deadline and cancellation also cover the body.
export async function checkConnectionHealth(request: (url: string, options: RequestInit & { timeoutMs: number }) => Promise<unknown>, signal: AbortSignal) {
  const data = await request('/api/health', { signal, timeoutMs: CONNECTION_TIMEOUT_MS, cache: 'no-store', redirect: 'error' });
  if (!data || typeof data !== 'object' || !('status' in data) || data.status !== 'ok') throw new Error('Invalid health response');
}

export function createConnectionMonitor({ probe, onChange, now = () => performance.now() }: {
  probe: (signal: AbortSignal) => Promise<void>;
  onChange: (state: ConnectionState) => void;
  now?: () => number;
}) {
  let online = true, visible = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | null = null;

  const publish = (quality: ConnectionQuality, latencyMs: number | null = null, checkedAt: number | null = null) => {
    onChange({ quality, latencyMs, checkedAt });
  };
  const cancel = () => {
    clearTimeout(timer);
    const previous = current;
    current = null;
    previous?.abort();
  };
  const refresh = async () => {
    if (disposed || !online || !visible || current) return;
    clearTimeout(timer);
    const controller = new AbortController();
    current = controller;
    const started = now();
    try {
      await probe(controller.signal);
      if (disposed || current !== controller) return;
      const elapsed = now() - started;
      publish(latencyQuality(elapsed), Math.max(1, Math.round(elapsed)), Date.now());
    } catch {
      if (disposed || current !== controller) return;
      publish('unreachable', null, Date.now());
    } finally {
      if (!disposed && current === controller) {
        current = null;
        timer = setTimeout(() => void refresh(), CONNECTION_INTERVAL_MS);
      }
    }
  };
  return {
    sync(availability: { online: boolean; visible: boolean }) {
      if (disposed) return;
      const changed = online !== availability.online || visible !== availability.visible;
      online = availability.online; visible = availability.visible;
      if (!online || !visible) {
        cancel(); publish(!online ? 'offline' : 'paused');
      } else {
        if (changed) { cancel(); publish('checking'); }
        void refresh();
      }
    },
    dispose() { disposed = true; cancel(); },
  };
}
