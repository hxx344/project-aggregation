import {
  clearPastPairNotices,
  nextPairNoticeDeadline,
  updatePairNoticeStates,
  type PairNoticeState,
} from './pair-notices.ts';
import type { Pair } from './pairs.ts';

// Each workspace owns its observations. Timers run only while a display
// warning is pending and a mounted view is subscribed; they never fetch data.
export function createPairNoticeStore(
  readClock = () => performance.now() / 1000,
) {
  const empty: ReadonlyMap<string, PairNoticeState> = new Map();
  let snapshot = empty;
  let source:
    | { pairs: Pair[]; now: number; offline: boolean; anchor: number }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const publish = (next: ReadonlyMap<string, PairNoticeState>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    stopTimer();
    const deadline = nextPairNoticeDeadline(snapshot);
    if (!listeners.size || deadline === null) return;
    timer = setTimeout(
      () => observe(readClock()),
      Math.max(1, (deadline - readClock()) * 1000),
    );
  };
  const observe = (observedAt: number) => {
    if (!source) return;
    const now =
      source.now > 0
        ? source.now + Math.max(0, observedAt - source.anchor)
        : source.now;
    publish(
      updatePairNoticeStates(
        snapshot,
        source.pairs,
        now,
        source.offline,
        observedAt,
      ),
    );
    schedule();
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => empty,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stopTimer();
      };
    },
    update: (pairs: Pair[], now: number, offline: boolean) => {
      const observedAt = readClock();
      const anchor =
        source && Object.is(source.now, now) ? source.anchor : observedAt;
      source = { pairs, now, offline, anchor };
      observe(observedAt);
    },
    clear: (id: string) => {
      const current = snapshot.get(id);
      if (!current) return;
      const history = clearPastPairNotices({
        ...current.history,
        activeKeys: current.current.map(({ key }) => key),
      });
      if (history === current.history) return;
      const next = new Map(snapshot);
      next.set(id, { ...current, history });
      publish(next);
    },
  };
}
