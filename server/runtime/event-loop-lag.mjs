// Event-loop stalls of the current process, for the 「服务器状态」 page.
// A short interval is expected to fire every TICK_MS on the monotonic clock;
// any extra delay is time the loop spent on other work (sync I/O, big JSON,
// CPU-heavy code). Every WS frame, timer and HTTP reply in this process waited
// at least that long. Wall-clock jumps do not count: only the monotonic clock
// measures the delay, the wall clock only labels when it ended.
export const EVENT_LOOP_TICK_MS = 100;
export const EVENT_LOOP_STALL_MS = 200;
const BUCKET_MS = 10_000;
const WINDOW_MS = 5 * 60_000;
const MAX_STALLS = 20;

const round = value => Math.round(value);

export function createEventLoopLag({ mono = () => performance.now(), now = Date.now, tickMs = EVENT_LOOP_TICK_MS, stallMs = EVENT_LOOP_STALL_MS,
  setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let last = null, timer = null, startedAt = null;
  // Each bucket covers BUCKET_MS of monotonic time; old ones fall out of the window.
  const buckets = [], stalls = [];
  function record(at, lag) {
    const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    let bucket = buckets.at(-1);
    if (!bucket || bucket.start !== start) { bucket = { start, maxMs: 0, samples: 0, stalls: 0 }; buckets.push(bucket); }
    bucket.maxMs = Math.max(bucket.maxMs, lag); bucket.samples += 1;
    while (buckets.length && buckets[0].start + BUCKET_MS <= at - WINDOW_MS) buckets.shift();
    if (lag < stallMs) return;
    bucket.stalls += 1;
    const endedAt = now();
    stalls.push({ endedAt: new Date(endedAt).toISOString(), durationMs: round(lag) });
    if (stalls.length > MAX_STALLS) stalls.shift();
  }
  function observe() {
    const at = mono();
    if (last !== null) record(at, Math.max(0, at - last - tickMs));
    last = at;
  }
  function windowed(ms) {
    const at = mono(), selected = buckets.filter(bucket => bucket.start + BUCKET_MS > at - ms);
    if (!selected.length) return { maxMs: null, stalls: 0 };
    return { maxMs: round(Math.max(...selected.map(bucket => bucket.maxMs))), stalls: selected.reduce((sum, bucket) => sum + bucket.stalls, 0) };
  }
  return {
    start() {
      if (timer) return;
      last = mono(); startedAt = now();
      timer = setTimer(observe, tickMs); timer.unref?.();
    },
    stop() { if (timer) clearTimer(timer); timer = null; last = null; },
    observe,
    read() {
      return {
        schemaVersion: 1,
        generatedAt: new Date(now()).toISOString(),
        monitoring: timer !== null,
        since: startedAt === null ? null : new Date(startedAt).toISOString(),
        tickMs, stallThresholdMs: stallMs,
        lastMinute: windowed(60_000),
        lastFiveMinutes: windowed(WINDOW_MS),
        // Newest first; kept across windows so a stall that already aged out is still visible.
        recentStalls: [...stalls].reverse(),
      };
    },
  };
}
