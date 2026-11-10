import { failedOutcome, positionItems, positionsReply, withExecutionLegs } from './hub-positions';
import type { PositionsOutcome, PositionsRequest } from './hub-positions';
import type { TradingPositionsResponse } from './trading-positions-types';

type Snapshot = { data: TradingPositionsResponse | null; receivedAt: number; error: string; failed: boolean; reading: boolean; unauthorized: boolean };

/** One public snapshot per App login session; never persisted in browser storage.
 * Successful responses replace the entire directory. Session/source changes clear
 * it and fence late reads; failures retain evidence without renewing its time. */
export function createPositionsCache(load: (signal: AbortSignal) => Promise<TradingPositionsResponse>, clock = () => performance.now()) {
  const empty = (): Snapshot => ({ data: null, receivedAt: 0, error: '', failed: false, reading: false, unauthorized: false });
  let snapshot = empty(), generation = 0, attemptedAt: number | null = null;
  let lastOutcome: PositionsOutcome | null = null;
  let pending: { controller: AbortController; promise: Promise<PositionsOutcome> } | null = null;
  const invalidations = new Map<string, (signal: AbortSignal) => Promise<void>>();
  const listeners = new Set<() => void>();
  const publish = (value: Snapshot) => { snapshot = value; listeners.forEach(listener => listener()); };
  const currentTime = () => snapshot.data ? Date.parse(snapshot.data.generatedAt) + Math.max(0, clock() - snapshot.receivedAt) : Date.now();
  function outcome(): PositionsOutcome | null {
    if (snapshot.unauthorized) return { status: 'unauthorized', at: clock() };
    if (!snapshot.data) return lastOutcome;
    const data = snapshot.failed ? { ...snapshot.data, sources: snapshot.data.sources.map(source => ({ ...source,
      status: source.data ? 'stale' as const : source.status,
    })) } : snapshot.data;
    return { status: 'ok', data, at: snapshot.receivedAt };
  }
  function refresh(force = false): Promise<PositionsOutcome> {
    if (pending && !force) return pending.promise;
    if (force) { generation++; pending?.controller.abort(); pending = null; }
    const ownGeneration = generation, controller = new AbortController();
    // Account-change acknowledgement and the GET share the existing 15s budget.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    publish({ ...snapshot, reading: true });
    const promise = (async (): Promise<PositionsOutcome> => {
      let result: PositionsOutcome;
      try {
        if (invalidations.size) {
          const results = await Promise.allSettled([...invalidations].map(async ([id, invalidate]) => {
            await invalidate(signal); signal.throwIfAborted();
            if (ownGeneration === generation && invalidations.get(id) === invalidate) invalidations.delete(id);
          }));
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        }
        signal.throwIfAborted();
        const data = await Promise.resolve().then(() => load(signal));
        signal.throwIfAborted();
        if (!data || !Number.isFinite(Date.parse(data.generatedAt))) throw new Error('仓位数据格式无效，请稍后重试。');
        positionItems(data, [], Date.parse(data.generatedAt));
        result = { status: 'ok', data, at: clock() };
        if (ownGeneration === generation && !controller.signal.aborted) publish({ data, receivedAt: result.at, error: '', failed: false, reading: false, unauthorized: false });
      } catch (error) {
        result = failedOutcome(error, clock());
        if (ownGeneration === generation && !controller.signal.aborted) publish(result.status === 'unauthorized'
          ? { ...empty(), unauthorized: true }
          : { ...snapshot, error: error instanceof Error ? error.message : '仓位读取失败，请重试。', failed: true, reading: false });
      }
      if (ownGeneration !== generation || controller.signal.aborted) return { status: 'unavailable', at: clock(), reason: 'background' };
      attemptedAt = clock(); lastOutcome = result; pending = null;
      return outcome() ?? result;
    })();
    pending = { controller, promise };
    return promise;
  }
  function reset(clearInvalidations: boolean) {
    generation++; pending?.controller.abort(); pending = null; attemptedAt = null; lastOutcome = null;
    if (clearInvalidations) invalidations.clear();
    publish(empty());
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    now: currentTime,
    generation: () => generation,
    peek: outcome,
    // Re-read at publication time: a slow supplemental source must not resurrect
    // positions captured before a clear, offline event or unauthorized response.
    reply(request: PositionsRequest, legs: PositionsOutcome | undefined, readGeneration: number) {
      const unavailable: PositionsOutcome = { status: 'unavailable', at: clock() };
      const current = outcome() ?? unavailable;
      return positionsReply(request, legs ? withExecutionLegs(current, readGeneration === generation ? legs : unavailable) : current, currentTime());
    },
    refresh,
    read(allowNetwork: boolean): Promise<PositionsOutcome> {
      const hit = outcome();
      if (allowNetwork && (attemptedAt === null || clock() - attemptedAt >= 20_000)) {
        const work = refresh(); return hit ? Promise.resolve(hit) : work;
      }
      return Promise.resolve(hit ?? { status: 'unavailable', at: clock(), reason: 'background' });
    },
    clear() { reset(true); },
    invalidate(source?: { id: string; run: (signal: AbortSignal) => Promise<void> }) {
      // Several Asset sources can change together. Successful acknowledgements
      // are removed; failed ones retry only on the next normal bounded read.
      if (source) invalidations.set(source.id, source.run);
      reset(false);
    },
    markUnavailable() {
      generation++; pending?.controller.abort(); pending = null; attemptedAt = null;
      publish({ ...snapshot, failed: true, reading: false });
    },
  };
}
export type PositionsCache = ReturnType<typeof createPositionsCache>;
