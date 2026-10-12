import { backgroundReadDelay, readActivity } from './read-activity.ts';

export const QUOTE_REFRESH_MS = 10_000;
export const HISTORY_REFRESH_MS = 60_000;

interface PollingOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  intervalMs: number;
  immediate?: boolean;
  timeoutMs?: number;
}
interface VisibilitySource {
  hidden: boolean;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}
interface NetworkSource {
  readonly onLine: boolean;
  addEventListener: (type: "online" | "offline", listener: () => void) => void;
  removeEventListener: (type: "online" | "offline", listener: () => void) => void;
}
const browserNetwork: NetworkSource | undefined = typeof window === "undefined" ? undefined : {
  get onLine() { return navigator.onLine; },
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener),
};

/** Fixed-cadence polling with a shared in-flight request and unmount cancellation. */
export function startPolling<T>({ load, onData, onError, onSettled, intervalMs, immediate = true, timeoutMs = 15_000 }: PollingOptions<T>) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  let stopped = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const refresh = ({ replace = false }: { replace?: boolean } = {}) => {
    if (stopped) return Promise.resolve();
    if (pending && replace) { controller?.abort(); pending = undefined; }
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    const deadline = setTimeout(() => controllerForRequest.abort(new DOMException("数据读取超时，稍后自动重试", "TimeoutError")), timeoutMs);
    const controllerForRequest = controller;
    let cancel: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    pending = Promise.race([cancelled, Promise.resolve()
      .then(() => { if (signal.aborted) throw signal.reason; return load(signal); })])
      .then(value => { if (!stopped && !signal.aborted) onData(value); })
      .catch(error => { if (!stopped && (!signal.aborted || signal.reason?.name === "TimeoutError")) onError(error); })
      .finally(() => { clearTimeout(deadline); signal.removeEventListener("abort", cancel); if (controller === controllerForRequest) { pending = undefined; if (!stopped) onSettled?.(); } });
    return pending;
  };
  let cadence = intervalMs;
  let timer = setInterval(() => { void refresh(); }, cadence);
  if (immediate) void refresh();
  return {
    refresh,
    setIntervalMs(value: number) { if (stopped || value === cadence) return; cadence = value; clearInterval(timer); timer = setInterval(() => { void refresh(); }, cadence); },
    stop() { stopped = true; clearInterval(timer); controller?.abort(); },
  };
}

/** Retain selected panel reads in the background, at most once per 30 seconds. */
export function startActivityPolling<T>({ active = true, page = typeof document === "undefined" ? undefined : document, network = browserNetwork, ...options }: PollingOptions<T> & { active?: boolean; page?: VisibilitySource; network?: NetworkSource }) {
  let enabled = active, stopped = false, activated = !active || network?.onLine === false;
  let polling: ReturnType<typeof startPolling<T>> | null = null;
  let background = readActivity.background(Boolean(page?.hidden));
  function synchronize() {
    if (stopped) return;
    if (!enabled || !readActivity.allowed(Boolean(page?.hidden)) || network?.onLine === false) { polling?.stop(); polling = null; return; }
    const previousBackground = background;
    background = readActivity.background(Boolean(page?.hidden));
    const intervalMs = backgroundReadDelay(options.intervalMs, Boolean(page?.hidden));
    if (polling) { polling.setIntervalMs(intervalMs); if (previousBackground && !background) void polling.refresh({ replace: true }); return; }
    polling = startPolling({ ...options, intervalMs, immediate: activated ? true : options.immediate });
    activated = true;
  }
  const restore = () => { synchronize(); void polling?.refresh({ replace: true }); };
  const visibility = () => { if (page?.hidden) synchronize(); else restore(); };
  page?.addEventListener("visibilitychange", visibility);
  const unsubscribe = readActivity.subscribe(synchronize);
  const view = typeof window === 'undefined' ? undefined : window;
  view?.addEventListener('focus', restore); view?.addEventListener('pageshow', restore);
  network?.addEventListener("online", restore);
  network?.addEventListener("offline", synchronize);
  synchronize();
  return {
    refresh() { return polling?.refresh() ?? Promise.resolve(); },
    setActive(value: boolean) { enabled = value; synchronize(); },
    stop() { stopped = true; polling?.stop(); polling = null; unsubscribe(); page?.removeEventListener("visibilitychange", visibility); network?.removeEventListener("online", restore); network?.removeEventListener("offline", synchronize); view?.removeEventListener('focus', restore); view?.removeEventListener('pageshow', restore); },
  };
}
