import type { PerpetualSnapshot } from './perpetual-types.ts';

export const PERPETUAL_DISPLAY_INTERVAL_MS = 20_000;

/** Keep the latest accumulated frame without delaying first paint or explicit refreshes. */
export function createPerpetualDisplay({ onData, now = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }: {
  onData: (snapshot: PerpetualSnapshot) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  let latest: PerpetualSnapshot | null = null, publishedAt: number | null = null;
  let timer: unknown, stopped = false;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const flush = () => {
    clear();
    if (stopped || !latest) return;
    const snapshot = latest;
    latest = null; publishedAt = now();
    onData(snapshot);
  };
  const reset = () => { clear(); latest = null; publishedAt = null; };
  return {
    accept(snapshot: PerpetualSnapshot) {
      if (stopped) return;
      latest = snapshot;
      const wait = publishedAt === null ? 0 : PERPETUAL_DISPLAY_INTERVAL_MS - (now() - publishedAt);
      if (wait <= 0) flush();
      else if (timer === undefined) timer = schedule(flush, wait);
    },
    flush,
    reset,
    stop() { stopped = true; reset(); },
  };
}
