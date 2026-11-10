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
