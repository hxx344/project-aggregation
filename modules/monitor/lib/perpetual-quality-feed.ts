import type { PerpetualQualityReport } from "./perpetual-quality.ts";
import { createPerpetualQualityCache } from "./perpetual-quality-cache.ts";
import { backgroundReadDelay } from './read-activity.ts';

export interface QualityPairRequest { base: string; longKey: string; shortKey: string; includeSeries?: boolean }

/** A reordered ranking is the same request; prices and timestamps are not request dependencies. */
export function qualityRequestKey(pairs: QualityPairRequest[]) {
  const entries = new Map<string, QualityPairRequest>();
  let seriesIncluded = false;
  for (const pair of pairs.slice(0, 30)) {
    const includeSeries = pair.includeSeries === true && !seriesIncluded;
    if (includeSeries) seriesIncluded = true;
    entries.set(JSON.stringify([pair.base, pair.longKey, pair.shortKey]), { base: pair.base, longKey: pair.longKey, shortKey: pair.shortKey, ...(includeSeries ? { includeSeries: true } : {}) });
  }
  return JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair));
}

interface QualityFeedOptions {
  load: (pairs: QualityPairRequest[], signal: AbortSignal) => Promise<PerpetualQualityReport>;
  onData: (report: PerpetualQualityReport) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** At most one cache read at a time, with bounded debounce for a changing visible ranking. */
export function startPerpetualQualityFeed(options: QualityFeedOptions) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let active = false, stopped = false, wanted = false;
  let pairs: QualityPairRequest[] = [], key = "[]";
  let request: AbortController | null = null;
  let lastReadAt = -Infinity;
  const cache = createPerpetualQualityCache();
  let refreshTimer: unknown, debounceTimer: unknown, deadlineTimer: unknown, timeoutTimer: unknown;
  const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };
  function clearSelectionTimers() {
    clear(debounceTimer); clear(deadlineTimer);
    debounceTimer = deadlineTimer = undefined;
  }
  function clearTimers() { clearSelectionTimers(); clear(refreshTimer); refreshTimer = undefined; }
  function abortRequest() { clear(timeoutTimer); timeoutTimer = undefined; request?.abort(); }
  async function load() {
    if (stopped || !active || !pairs.length || request) return;
    const wait = lastReadAt + backgroundReadDelay(0) - Date.now();
    if (wait > 0) { clear(refreshTimer); refreshTimer = schedule(() => { void load(); }, wait); return; }
    lastReadAt = Date.now();
    clearTimers(); wanted = false;
    const requestedKey = key, requestedPairs = pairs, controller = new AbortController();
    request = controller;
    let timedOut = false;
    timeoutTimer = schedule(() => { timedOut = true; controller.abort(); }, 12_000);
    options.onLoading(true);
    try {
      const result = await options.load(requestedPairs, controller.signal);
      if (!stopped && active && !controller.signal.aborted) { options.onData(cache.accept(result, requestedPairs)); options.onError(""); }
    } catch {
      if (!stopped && active && (timedOut || !controller.signal.aborted)) options.onError("质量资料暂时无法更新，保留上次记录，稍后自动重试。");
    } finally {
      clear(timeoutTimer); timeoutTimer = undefined;
      if (request === controller) request = null;
      if (!stopped) options.onLoading(false);
      if (stopped || !active || !pairs.length) return;
      if (wanted) { void load(); return; }
      if (requestedKey === key && debounceTimer === undefined) refreshTimer = schedule(() => { refreshTimer = undefined; void load(); }, 60_000);
    }
  }
  function requestLatest() { clearSelectionTimers(); wanted = true; void load(); }
  return {
    refresh() { if (!request) requestLatest(); },
    setPairs(next: QualityPairRequest[]) {
      const nextKey = qualityRequestKey(next);
      if (nextKey === key || stopped) return;
      const wasEmpty = !pairs.length;
      key = nextKey; pairs = JSON.parse(nextKey) as QualityPairRequest[];
      clear(refreshTimer); refreshTimer = undefined;
      if (!pairs.length) { clearSelectionTimers(); wanted = false; abortRequest(); options.onLoading(false); return; }
      if (!active) return;
      if (wasEmpty) { requestLatest(); return; }
      clear(debounceTimer);
      debounceTimer = schedule(requestLatest, 1_200);
      if (deadlineTimer === undefined) deadlineTimer = schedule(requestLatest, 5_000);
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value;
      if (active) { requestLatest(); return; }
      clearTimers(); wanted = false; abortRequest(); options.onLoading(false);
    },
    stop() { stopped = true; active = false; clearTimers(); abortRequest(); },
  };
}
