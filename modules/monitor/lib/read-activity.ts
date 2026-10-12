/** Host visibility and read permission are separate: read permission never enables actions. */
export function createReadActivity(embedded = false) {
  let connected = !embedded, hostActive = !embedded, backgroundUpdates = !embedded;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    configure(proxy: boolean) { connected = !proxy; hostActive = !proxy; backgroundUpdates = !proxy; notify(); },
    connect() { connected = true; },
    update(active: boolean, background: unknown) {
      if (!connected) return;
      hostActive = active; backgroundUpdates = background === true; notify();
    },
    allowed(hidden: boolean) { return connected && (backgroundUpdates || (hostActive && !hidden)); },
    background(hidden: boolean) { return hidden || !hostActive; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const embedded = typeof window !== 'undefined' && window.parent !== window && /^p-[a-f0-9]{24}\.hub\.localhost$/.test(window.location.hostname);
export const readActivity = createReadActivity(embedded);
export const backgroundReadDelay = (delay: number, hidden = typeof document !== 'undefined' && document.hidden) => readActivity.background(hidden) ? Math.max(30_000, delay) : delay;
export const readsAllowed = (active: boolean) => active && navigator.onLine && readActivity.allowed(document.hidden);

/** Resume selected reads after foreground/network/BFCache restoration without changing action state. */
export function observeReadActivity(synchronize: () => void, refresh = synchronize) {
  let background = readActivity.background(document.hidden);
  const update = () => {
    const previous = background;
    background = readActivity.background(document.hidden);
    if (previous && !background) refresh(); else synchronize();
  };
  const restore = () => refresh();
  const unsubscribe = readActivity.subscribe(update);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('online', restore); window.addEventListener('offline', update);
  window.addEventListener('focus', restore); window.addEventListener('pageshow', restore);
  synchronize();
  return () => {
    unsubscribe(); document.removeEventListener('visibilitychange', update);
    window.removeEventListener('online', restore); window.removeEventListener('offline', update);
    window.removeEventListener('focus', restore); window.removeEventListener('pageshow', restore);
  };
}
