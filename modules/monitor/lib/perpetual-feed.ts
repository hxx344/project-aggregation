import type { PerpetualDelta, PerpetualExchange, PerpetualPatch, PerpetualQuote, PerpetualSnapshot } from "./perpetual-types.ts";

export type PerpetualConnection = "connecting" | "stream" | "polling" | "error" | "paused";
interface SnapshotStream {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}
interface FeedOptions {
  fetchSnapshot: (signal: AbortSignal) => Promise<unknown>;
  createStream: () => SnapshotStream;
  onData: (snapshot: PerpetualSnapshot, context: { baseline: boolean }) => void;
  onConnection: (state: PerpetualConnection) => void;
  onError: (message: string) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  monotonic?: () => number;
  pollIntervalMs?: () => number;
}

export class PerpetualRequestError extends Error {}

export async function readPerpetualSnapshot(signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/monitors/perpetual/quote", { cache: "no-store", signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new PerpetualRequestError(`行情访问已失效（HTTP ${response.status}），请从工作台重新打开价差模块。`);
    throw new PerpetualRequestError(`行情接口返回 HTTP ${response.status}，请检查价差服务是否正常运行。`);
  }
  try { return parsePerpetualSnapshot(await response.json()); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new PerpetualRequestError("行情接口返回了无效数据，请检查价差服务是否已正确启动。");
  }
}

export function parsePerpetualSnapshot(value: unknown): PerpetualSnapshot {
  const snapshot = value as PerpetualSnapshot | null;
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.monitorId !== "perpetual" || !Number.isFinite(snapshot.generatedAt)
    || !Number.isFinite(snapshot.staleAfterMs) || snapshot.staleAfterMs <= 0 || !Array.isArray(snapshot.quotes) || !Array.isArray(snapshot.exchanges)) {
    throw new Error("行情响应格式异常，正在重试。");
  }
  return snapshot;
}

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

export class PerpetualSequenceError extends Error {}

const validSequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Estimate source time using elapsed monotonic time, without the viewer's wall clock. */
export function createPerpetualClock(monotonic: () => number = () => performance.now()) {
  let server = 0, received = 0, previousTimestamp = 0, source: string | undefined;
  return {
    accept(timestamp: number, streamId?: string, baseline = false) {
      const local = monotonic();
      const reset = !server || baseline || source !== streamId || timestamp < previousTimestamp;
      server = reset ? timestamp : Math.max(timestamp, server + Math.max(0, local - received));
      previousTimestamp = timestamp; source = streamId; received = local;
      return server;
    },
    read() { return server ? server + Math.max(0, monotonic() - received) : 0; },
    quietFor() { return server ? Math.max(0, monotonic() - received) : Infinity; },
  };
}

/** Materialize delta frames once, preserving unaffected object and array identities. */
export function createPerpetualSnapshotAccumulator() {
  let snapshot: PerpetualSnapshot | null = null;
  let quotes = new Map<string, PerpetualQuote>();
  let venues = new Map<string, PerpetualExchange>();
  const key = (quote: PerpetualQuote) => {
    if (!quote || typeof quote.exchange !== "string" || typeof quote.symbol !== "string") throw new Error("行情报价格式异常。");
    return `${quote.exchange}:${quote.symbol}`;
  };
  const reuseVenues = (next: PerpetualExchange[]) => {
    const list = next.map(venue => { const previous = venues.get(venue.id); return previous && sameFields(previous, venue) ? previous : venue; });
    const same = snapshot && list.length === snapshot.exchanges.length && list.every((venue, index) => venue === snapshot!.exchanges[index]);
    venues = new Map(list.map(venue => [venue.id, venue]));
    return same ? snapshot!.exchanges : list;
  };
  return (value: unknown): PerpetualSnapshot | null => {
    const frame = value as PerpetualSnapshot | PerpetualDelta | PerpetualPatch;
    const sequenced = frame && typeof frame.streamId === "string" && validSequence(frame.sequence);
    const sameStream = snapshot && sequenced && snapshot.streamId === frame.streamId && validSequence(snapshot.sequence);
    if (sameStream && frame.sequence! < snapshot!.sequence!) return null;
    if (!sequenced && snapshot && frame && Number.isFinite(frame.generatedAt) && frame.generatedAt < snapshot.generatedAt) return null;
    if (frame && "type" in frame && frame.type === "patch") {
      if (!snapshot || !sameStream) throw new PerpetualSequenceError("行情基线已变化，正在重新同步。");
      if (frame.sequence <= snapshot.sequence!) return null;
      if (!validSequence(frame.baseSequence) || frame.baseSequence !== snapshot.sequence) throw new PerpetualSequenceError("行情帧不连续，正在重新同步。");
      if (frame.schemaVersion !== 1 || frame.monitorId !== "perpetual" || !Number.isFinite(frame.generatedAt)
        || !Number.isFinite(frame.staleAfterMs) || frame.staleAfterMs <= 0 || !Array.isArray(frame.patches) || !Array.isArray(frame.removed) || !Array.isArray(frame.exchanges)) throw new Error("增量行情格式异常。");
      // Validate before mutating the baseline. A new identity must include its full quote.
      const updates = frame.patches.map(patch => {
        if (!Array.isArray(patch) || patch.length !== 2 || typeof patch[0] !== "string" || !patch[1] || typeof patch[1] !== "object") throw new Error("行情字段更新异常。");
        const [id, changes] = patch;
        const previous = quotes.get(id);
        const next = (previous ? { ...previous, ...changes } : changes) as PerpetualQuote;
        if (key(next) !== id || typeof next.base !== "string" || typeof next.quoteCurrency !== "string") throw new PerpetualSequenceError("新增报价缺少完整数据，正在重新同步。");
        return [id, next] as const;
      });
      if (frame.removed.some(id => typeof id !== "string")) throw new Error("移除报价标识异常。");
      let changed = updates.length > 0;
      for (const id of frame.removed) if (quotes.delete(id)) changed = true;
      for (const [id, quote] of updates) quotes.set(id, quote);
      snapshot = { schemaVersion: 1, monitorId: "perpetual", generatedAt: frame.generatedAt, staleAfterMs: frame.staleAfterMs, status: frame.status,
        streamId: frame.streamId, sequence: frame.sequence, exchanges: reuseVenues(frame.exchanges), quotes: changed ? [...quotes.values()] : snapshot.quotes,
        error: frame.error ?? null, note: frame.note ?? null, storageError: frame.storageError ?? null };
    } else if (frame && "type" in frame && frame.type === "delta") {
      if (!snapshot) throw new Error("增量行情缺少完整快照，正在重新同步。");
      if (frame.schemaVersion !== 1 || frame.monitorId !== "perpetual" || !Number.isFinite(frame.generatedAt)
        || !Number.isFinite(frame.staleAfterMs) || frame.staleAfterMs <= 0 || !Array.isArray(frame.updates) || !Array.isArray(frame.removed) || !Array.isArray(frame.exchanges)) throw new Error("增量行情格式异常。");
      let changed = false;
      for (const removed of frame.removed) { if (typeof removed !== "string") throw new Error("移除报价标识异常。"); if (quotes.delete(removed)) changed = true; }
      for (const quote of frame.updates) {
        // A delta explicitly declares changed quotes; scanning every field again duplicates server work.
        quotes.set(key(quote), quote); changed = true;
      }
      snapshot = { schemaVersion: 1, monitorId: "perpetual", generatedAt: frame.generatedAt, staleAfterMs: frame.staleAfterMs, status: frame.status,
        streamId: frame.streamId, sequence: frame.sequence,
        exchanges: reuseVenues(frame.exchanges), quotes: changed ? [...quotes.values()] : snapshot.quotes,
        error: frame.error ?? null, note: frame.note ?? null, storageError: frame.storageError ?? null };
    } else {
      const next = parsePerpetualSnapshot(value);
      const list = next.quotes.map(quote => { const previous = quotes.get(key(quote)); return previous && sameFields(previous, quote) ? previous : quote; });
      const same = snapshot && list.length === snapshot.quotes.length && list.every((quote, index) => quote === snapshot!.quotes[index]);
      const exchanges = reuseVenues(next.exchanges);
      quotes = new Map(list.map(quote => [key(quote), quote]));
      snapshot = { ...next, quotes: same ? snapshot!.quotes : list, exchanges };
    }
    return snapshot;
  };
}

/** One stream per selected panel; falls back to bounded snapshot requests on transport failure. */
export function startPerpetualFeed(options: FeedOptions) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const monotonic = options.monotonic ?? (() => performance.now());
  let stopped = false;
  let stream: SnapshotStream | null = null;
  let pollingTimer: unknown, reconnectTimer: unknown, watchdogTimer: unknown;
  let request: AbortController | null = null;
  let requestCompletion: Promise<void> | null = null;
  let requestTimer: unknown;
  let requestStartedAt = 0, streamActivityAt = 0, resumedAt = -Infinity;
  const accumulate = createPerpetualSnapshotAccumulator();
  let streaming = false;
  let fallback = false;
  let sequenceRecoveries = 0;
  let acceptedVersion = 0;
  let latest: PerpetualSnapshot | null = null;
  const sourceClock = createPerpetualClock(monotonic);

  const accept = (value: unknown) => {
    const snapshot = accumulate(value);
    if (!snapshot) return false;
    const baseline = !(value && typeof value === "object" && "type" in value);
    const estimatedNow = sourceClock.accept(snapshot.generatedAt, snapshot.streamId, baseline);
    if (!baseline && estimatedNow - snapshot.generatedAt > 12_000) throw new PerpetualSequenceError("行情传输延迟过大，正在重新同步。");
    latest = snapshot;
    acceptedVersion++;
    options.onData(snapshot, { baseline });
    options.onError("");
    return true;
  };
  const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };

  function loadSnapshot(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (request && requestCompletion) return requestCompletion;
    requestCompletion = readSnapshot();
    return requestCompletion;
  }

  async function readSnapshot() {
    if (stopped || request) return;
    const controller = new AbortController();
    const requestVersion = acceptedVersion;
    request = controller;
    requestStartedAt = monotonic();
    const canceled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new PerpetualRequestError("行情快照请求超过 12 秒未完成，请检查价差服务与连接。")), { once: true });
    });
    const timeout = schedule(() => controller.abort(), 12_000);
    requestTimer = timeout;
    try {
      // Abort is advisory for a transport. Settle our slot even when it ignores
      // cancellation, so a stalled first read cannot block all future refreshes.
      const value = await Promise.race([options.fetchSnapshot(controller.signal), canceled]);
      if (stopped || controller.signal.aborted) return;
      const responseStream = (value as PerpetualSnapshot | null)?.streamId;
      // A delayed HTTP response from a retired service cannot replace a newer stream baseline.
      if (acceptedVersion !== requestVersion && latest?.streamId && responseStream && responseStream !== latest.streamId) return;
      accept(value);
      if (!streaming) { fallback = true; options.onConnection("polling"); }
    } catch (error) {
      if (!stopped && request === controller && !streaming) {
        fallback = true;
        options.onConnection("error");
        options.onError((error instanceof PerpetualRequestError ? error.message : "无法更新行情，请检查价差服务与连接。") + ` ${(options.pollIntervalMs?.() ?? 5_000) / 1000} 秒后自动重试，过期报价不参与排名。`);
      }
    } finally {
      clear(timeout);
      if (request === controller) {
        request = null;
        if (!stopped && fallback) {
          clear(pollingTimer);
          pollingTimer = schedule(() => { void loadSnapshot(); }, options.pollIntervalMs?.() ?? 5_000);
        }
      }
    }
  }

  function switchToPolling() {
    if (stopped) return;
    streaming = false;
    fallback = true;
    stream?.close(); stream = null;
    clear(watchdogTimer);
    options.onConnection("polling");
    void loadSnapshot();
    clear(reconnectTimer);
    reconnectTimer = schedule(connect, 30_000);
  }

  function watch() {
    clear(watchdogTimer);
    watchdogTimer = schedule(switchToPolling, 12_000);
  }

  function connect() {
    if (stopped) return;
    try {
      stream?.close();
      const current = options.createStream();
      stream = current;
      streamActivityAt = monotonic();
      current.onmessage = event => {
        if (stopped || current !== stream) return;
        try {
          const frame = JSON.parse(event.data);
          const accepted = accept(frame);
          if (!accepted) return;
          if (frame.type === "patch") sequenceRecoveries = 0;
          streamActivityAt = monotonic();
          streaming = true; fallback = false;
          clear(pollingTimer); clear(reconnectTimer);
          options.onConnection("stream");
          watch();
        } catch (error) {
          if (error instanceof PerpetualSequenceError && sequenceRecoveries++ === 0) {
            options.onConnection("connecting");
            options.onError("行情正在重新同步，恢复后自动更新。");
            connect();
          } else switchToPolling();
        }
      };
      current.onerror = () => { if (current === stream) switchToPolling(); };
      watch();
    } catch { switchToPolling(); }
  }

  options.onConnection("connecting");
  connect();
  // A buffered SSE connection must not delay the first visible snapshot.
  void loadSnapshot();
  return {
    refresh: () => { clear(pollingTimer); return loadSnapshot(); },
    resume() {
      if (stopped) return;
      const now = monotonic();
      // Visibility/focus/pageshow often arrive together. Keep healthy streams
      // and their delta baseline; only recover transports silent past the watchdog.
      if (stream && now - streamActivityAt < 12_000 || now - resumedAt < 1_000) return;
      resumedAt = now;
      clear(reconnectTimer); clear(pollingTimer);
      if (request && now - requestStartedAt >= 12_000) {
        request.abort(); clear(requestTimer); request = null;
      }
      streaming = false;
      options.onConnection("connecting");
      connect();
      void loadSnapshot();
    },
    stop() {
      stopped = true;
      stream?.close(); stream = null;
      request?.abort();
      [pollingTimer, reconnectTimer, watchdogTimer, requestTimer].forEach(clear);
    },
  };
}
