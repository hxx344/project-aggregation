type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type RefreshOptions = {
  page: EventSource & { readonly hidden: boolean };
  view: EventSource;
  enabled: () => boolean;
  onActivity: (active: boolean) => void;
  refresh: () => void;
};

/** Keep the one-minute sync alive in the background; callers own request deduplication. */
export function startRefreshLoop({ page, view, enabled, onActivity, refresh }: RefreshOptions) {
  let active = false, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const synchronize = (event?: Event) => {
    if (stopped) return;
    const previous = active;
    active = enabled();
    onActivity(active);
    if (!active) { clearInterval(timer); timer = undefined; return; }
    if (timer === undefined) timer = setInterval(() => refresh(), 60_000);
    const restored = Boolean(event && (['focus', 'pageshow', 'online'].includes(event.type) || (event.type === 'visibilitychange' && !page.hidden)));
    if (!previous || restored) refresh();
  };
  page.addEventListener('visibilitychange', synchronize);
  for (const type of ['online', 'offline', 'focus', 'pageshow']) view.addEventListener(type, synchronize);
  synchronize();
  return {
    synchronize,
    stop() {
      stopped = true; clearInterval(timer); onActivity(false);
      page.removeEventListener('visibilitychange', synchronize);
      for (const type of ['online', 'offline', 'focus', 'pageshow']) view.removeEventListener(type, synchronize);
    },
  };
}
