import type { FundingHistoryPairRequest } from "./perpetual-funding-history.ts";
import { backgroundReadDelay } from './read-activity.ts';

interface ContractLeg { key: string; identity: string; status: string; error: string }
interface ContractReport<Leg> { schemaVersion: 1; generatedAt: number; legs: Record<string, Leg>; storageError?: string }
interface CacheEntry<Leg> { leg?: Leg; nextReadAt: number }
interface SharedRequest { controller: AbortController; keys: Set<string>; clearTimeout: () => void }

export interface PerpetualContractDataCache<Leg> {
  entries: Map<string, CacheEntry<Leg>>;
  report: ContractReport<Leg> | null;
  request: SharedRequest | null;
  listeners: Set<() => void>;
  active: Set<object>;
  failure: { keys: Set<string>; message: string } | null;
  lastReadAt: number;
}

/** A factory allows isolated server/test instances; only the browser opts into sharing. */
export function createPerpetualContractDataCache<Leg>(): PerpetualContractDataCache<Leg> {
  return { entries: new Map(), report: null, request: null, listeners: new Set(), active: new Set(), failure: null, lastReadAt: -Infinity };
}

/** Prices, quote times and ranking order do not change the requested contracts. */
export function perpetualContractRequestKey(pairs: FundingHistoryPairRequest[]) {
  const entries = new Map<string, FundingHistoryPairRequest>();
  for (const { base, longKey, shortKey } of pairs.slice(0, 30)) {
    entries.set(JSON.stringify([base, longKey, shortKey]), { base, longKey, shortKey });
  }
  return JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair));
}

export interface PerpetualContractFeedOptions<Leg> {
  load: (pairs: FundingHistoryPairRequest[], signal: AbortSignal) => Promise<ContractReport<Leg>>;
  onData: (report: ContractReport<Leg>) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
  cache?: PerpetualContractDataCache<Leg>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface ContractFeedPolicy<Leg> {
  validate: (value: unknown) => value is ContractReport<Leg>;
  merge: (previous: Leg | undefined, incoming: Leg) => Leg;
  refreshAfter: (leg: Leg) => number;
  missingMessage: string;
  failureMessage: string;
}

/** Shared requests and per-leg freshness survive selections, pagination and hook remounts. */
export function startPerpetualContractDataFeed<Leg extends ContractLeg>(options: PerpetualContractFeedOptions<Leg>, policy: ContractFeedPolicy<Leg>) {
  const cache = options.cache ?? createPerpetualContractDataCache<Leg>();
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const subscriber = {};
  let active = false, stopped = false, selecting = false;
  let pairs: FundingHistoryPairRequest[] = [], key = "[]";
  let refreshTimer: unknown, debounceTimer: unknown, deadlineTimer: unknown;
  let delivered: ContractReport<Leg> | null = null;
  const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };
  const legKeys = () => new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]));
  function clearSelectionTimers() { clear(debounceTimer); clear(deadlineTimer); debounceTimer = deadlineTimer = undefined; selecting = false; }
  function clearTimers() { clearSelectionTimers(); clear(refreshTimer); refreshTimer = undefined; }
  function notify() { for (const listener of cache.listeners) listener(); }
  function abortIfUnused() {
    if (cache.active.size || !cache.request) return;
    const request = cache.request;
    cache.request = null;
    request.clearTimeout(); request.controller.abort();
  }
  function publish() {
    if (!active || stopped) return;
    if (cache.report && delivered !== cache.report) { delivered = cache.report; options.onData(cache.report); }
    const keys = legKeys();
    options.onError(cache.failure && [...keys].some(key => cache.failure!.keys.has(key)) ? cache.failure.message : "");
    options.onLoading(Boolean(cache.request && [...keys].some(key => cache.request!.keys.has(key))));
  }
  function snapshot(report: ContractReport<Leg>) {
    while (cache.entries.size > 500) cache.entries.delete(cache.entries.keys().next().value!);
    cache.report = { schemaVersion: 1, generatedAt: Math.max(report.generatedAt, cache.report?.generatedAt ?? 0), legs: Object.fromEntries([...cache.entries].flatMap(([key, entry]) => entry.leg ? [[key, entry.leg]] : [])), ...(report.storageError ? { storageError: report.storageError } : {}) };
  }
  function synchronize() {
    publish();
    clear(refreshTimer); refreshTimer = undefined;
    if (stopped || !active || !pairs.length || selecting || cache.request) return;
    const earliest = Math.min(...[...legKeys()].map(key => cache.entries.get(key)?.nextReadAt ?? 0));
    if (earliest <= now()) { void load(); return; }
    refreshTimer = schedule(() => { refreshTimer = undefined; synchronize(); }, Math.max(1, earliest - now()));
  }
  async function load() {
    if (stopped || !active || selecting || cache.request) return;
    const wait = cache.lastReadAt + backgroundReadDelay(0) - now();
    if (wait > 0) { clear(refreshTimer); refreshTimer = schedule(() => { void load(); }, wait); return; }
    const requested = pairs.filter(pair => [pair.longKey, pair.shortKey].some(key => (cache.entries.get(key)?.nextReadAt ?? 0) <= now()));
    if (!requested.length) { synchronize(); return; }
    cache.lastReadAt = now();
    const keys = new Set(requested.flatMap(pair => [pair.longKey, pair.shortKey]));
    const controller = new AbortController();
    let timedOut = false;
    const timeout = schedule(() => { timedOut = true; controller.abort(); }, 12_000);
    const request = { controller, keys, clearTimeout: () => cancel(timeout) };
    cache.request = request;
    notify();
    try {
      // Resolve the request lifecycle even if a loader ignores AbortSignal.
      const report = await Promise.race([
        options.load(requested, controller.signal),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Contract read aborted")), { once: true })),
      ]);
      if (controller.signal.aborted || cache.request !== request) return;
      if (!policy.validate(report)) throw new Error("Invalid contract report");
      for (const key of keys) {
        const previous = cache.entries.get(key)?.leg, incoming = report.legs[key];
        const leg = incoming ? policy.merge(previous, incoming) : previous ? { ...previous, status: "error", error: policy.missingMessage } : undefined;
        cache.entries.delete(key);
        cache.entries.set(key, { leg, nextReadAt: now() + (incoming ? policy.refreshAfter(incoming) : 60_000) });
      }
      cache.failure = null;
      snapshot(report);
    } catch {
      if (cache.request !== request || (controller.signal.aborted && !timedOut)) return;
      for (const key of keys) {
        const previous = cache.entries.get(key);
        cache.entries.set(key, { ...previous, nextReadAt: now() + 60_000 });
      }
      while (cache.entries.size > 500) cache.entries.delete(cache.entries.keys().next().value!);
      cache.failure = { keys, message: policy.failureMessage };
    } finally {
      request.clearTimeout();
      if (cache.request === request) { cache.request = null; notify(); }
    }
  }
  function requestLatest() { clearSelectionTimers(); synchronize(); }
  cache.listeners.add(synchronize);
  return {
    refresh: requestLatest,
    setPairs(next: FundingHistoryPairRequest[]) {
      const nextKey = perpetualContractRequestKey(next);
      if (nextKey === key || stopped) return;
      const wasEmpty = !pairs.length;
      key = nextKey; pairs = JSON.parse(nextKey) as FundingHistoryPairRequest[];
      clear(refreshTimer); refreshTimer = undefined;
      if (!pairs.length) { cache.active.delete(subscriber); clearSelectionTimers(); abortIfUnused(); options.onLoading(false); return; }
      if (!active) return;
      cache.active.add(subscriber);
      publish();
      // Cached legs are immediately usable, regardless of direction or page order.
      if ([...legKeys()].every(key => (cache.entries.get(key)?.nextReadAt ?? 0) > now()) || wasEmpty) { requestLatest(); return; }
      selecting = true;
      clear(debounceTimer); debounceTimer = schedule(requestLatest, 1_200);
      if (deadlineTimer === undefined) deadlineTimer = schedule(requestLatest, 5_000);
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value;
      if (active) { if (pairs.length) cache.active.add(subscriber); requestLatest(); return; }
      cache.active.delete(subscriber); clearTimers(); abortIfUnused(); options.onLoading(false);
    },
    stop() {
      stopped = true; active = false; cache.listeners.delete(synchronize); cache.active.delete(subscriber);
      clearTimers(); abortIfUnused();
    },
  };
}
