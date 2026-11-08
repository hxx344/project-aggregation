import { ExchangeResponseError, readJsonResponse } from './exchange-transport/response.mjs';

const TIME_URL = 'https://fapi.binance.com/fapi/v1/time';
const MAX_OFFSET_MS = 300_000;
const MAX_BODY_BYTES = 4096;

export class BinanceClockError extends Error {
  constructor(code) { super('Binance 服务器时间同步失败'); this.name = 'BinanceClockError'; this.code = code; }
}
const aborted = () => new DOMException('读取已取消', 'AbortError');

// The shared bounded reader (docs/evolution-plan.md E2), with this clock's
// codes: an oversized answer is a clock failure, an unparsable one transport.
async function readClockJson(response, signal) {
  try { return await readJsonResponse(response, { maxBytes: MAX_BODY_BYTES, signal }); }
  catch (error) {
    if (!(error instanceof ExchangeResponseError)) throw error;
    if (error.code === 'aborted') throw aborted();
    throw new BinanceClockError(error.code === 'response_limit' ? 'clock' : 'transport');
  }
}

/** Public server time only: no credentials, signed URLs or private account state. */
export function createBinanceClock({ fetchImpl = fetch, now = Date.now, timeoutMs = 12_000,
  ttlMs = 300_000, monotonicNow = () => performance.now() } = {}) {
  let sample = null, pending = null, revision = 0;
  function local() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new BinanceClockError('clock');
    return value;
  }
  function currentSample() {
    if (sample) {
      const elapsed = monotonicNow() - sample.monotonicAt, wallElapsed = local() - sample.syncedAt;
      // A wall-clock correction invalidates the estimate even before its TTL.
      if (elapsed < 0 || elapsed >= ttlMs || wallElapsed < 0 || wallElapsed >= ttlMs || Math.abs(wallElapsed - elapsed) > 1000) sample = null;
    }
    return sample;
  }
  function serverNow() { const valid = currentSample(); return local() + (valid?.offset ?? 0); }
  function forget() { revision++; sample = null; pending?.controller.abort(); pending = null; }
  function start() {
    const controller = new AbortController(), generation = revision;
    const entry = { controller, waiters: 0, promise: null };
    let timedOut = false, abort;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const interrupted = new Promise((_, reject) => { abort = () => reject(aborted()); controller.signal.addEventListener('abort', abort, { once: true }); });
    const read = async () => {
      const before = local(), monotonicBefore = monotonicNow();
      const response = await fetchImpl(TIME_URL, { method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (controller.signal.aborted) throw aborted();
      if (!response.ok || response.redirected) throw new BinanceClockError('clock');
      if (!response.body?.getReader) throw new BinanceClockError('clock');
      const data = await readClockJson(response, controller.signal);
      const after = local(), monotonicAt = monotonicNow(), rtt = after - before;
      const offset = Math.round(data?.serverTime - (before + after) / 2);
      if (!Number.isSafeInteger(data?.serverTime) || data.serverTime < 0 || rtt < 0 || rtt > 5000
        || Math.abs(rtt - (monotonicAt - monotonicBefore)) > 1000 || !Number.isSafeInteger(offset) || Math.abs(offset) > MAX_OFFSET_MS) throw new BinanceClockError('clock');
      const result = { offset, rtt, syncedAt: after, monotonicAt };
      if (generation === revision && !controller.signal.aborted) sample = result;
      return { offset, rtt, syncedAt: after };
    };
    entry.promise = Promise.race([read(), interrupted]).catch(error => {
      if (timedOut) throw new BinanceClockError('timeout');
      if (controller.signal.aborted) throw aborted();
      if (error instanceof BinanceClockError) throw error;
      throw new BinanceClockError('transport');
    }).finally(() => {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort();
      if (pending === entry) pending = null;
    });
    pending = entry;
    return entry;
  }
  async function sync({ signal, force = false } = {}) {
    if (signal?.aborted) throw aborted();
    const valid = currentSample();
    if (!force && valid) return { offset: valid.offset, rtt: valid.rtt, syncedAt: valid.syncedAt };
    const entry = pending ?? start();
    entry.waiters++;
    let abort;
    const interrupted = new Promise((_, reject) => { abort = () => reject(aborted()); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
    try { return await Promise.race([entry.promise, interrupted]); }
    finally {
      signal?.removeEventListener('abort', abort);
      if (--entry.waiters === 0 && pending === entry) { pending = null; entry.controller.abort(); }
    }
  }
  return Object.freeze({ timestamp: serverNow, serverNow, sync, forget });
}
