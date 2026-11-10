import type { TradingCache } from './trading-cache';
import type { TradingPair, TradingState } from './trading-types';

function retryable(error: unknown) {
  if (!(error instanceof Error)) return false;
  if ('status' in error) return [408, 502, 503, 504].includes(Number(error.status))
    && (!('retryAfter' in error) || error.retryAfter === null);
  return error instanceof TypeError || error.name === 'TimeoutError';
}

function waitToRetry(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Cache GET only: at most two 12s attempts and one 1s delay, within the owner's
 * existing in-flight read. Never renew snapshot timestamps or retry mutations. */
export async function readTradingCache<T>(request: (url: string, options: RequestInit & { timeoutMs: number }) => Promise<T>, url: string, signal: AbortSignal): Promise<T> {
  const read = () => { signal.throwIfAborted(); return request(url, { method: 'GET', signal, timeoutMs: 12_000 }); };
  try { return await read(); }
  catch (error) {
    signal.throwIfAborted();
    if (!retryable(error)) throw error;
    await waitToRetry(signal);
    return read();
  }
}
type TradingRequest = (url: string, options: RequestInit & { timeoutMs: number }) => Promise<TradingState>;

export function readTradingPage(cache: TradingCache, request: TradingRequest, days: 7 | 30, page: number, pair: TradingPair) {
  return cache.read(days, page, pair, signal => readTradingCache(request, `/api/trading?days=${days}&page=${page}&pair=${pair}`, signal));
}

/** Once-per-session caller schedules this after login. Existing page data wins;
 * warmup never loads account imports, execution state or other selections. */
export async function warmTradingCache(cache: TradingCache, request: TradingRequest, selection: { days: 7 | 30; pair: TradingPair }, onExpired: () => void) {
  if (cache.busy() || cache.get(selection.days, 0, selection.pair)) return;
  const shared = readTradingPage(cache, request, selection.days, 0, selection.pair);
  try { await shared.promise; }
  catch (cause) {
    if (cache.valid(shared.request) && cause instanceof Error && 'status' in cause && cause.status === 401) {
      cache.clear(); onExpired();
    }
    // The page will retry normally if a best-effort warmup fails or is cancelled.
  }
}
