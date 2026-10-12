/** One active read; superseded, inactive, cancelled and timed-out responses cannot update the UI. */
export function createLatestRead<T>({ canRead, load, onData, onError, timeoutMs = 12_000 }: {
  canRead: () => boolean; load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void; onError: (error: unknown) => void; timeoutMs?: number;
}) {
  let sequence = 0, controller: AbortController | null = null, pending: Promise<void> | null = null;
  const cancel = () => { sequence++; controller?.abort(); controller = null; pending = null; };
  return { cancel, refresh(force = false): Promise<void> {
    if (!canRead()) return Promise.resolve();
    if (force) cancel();
    if (pending) return pending;
    const version = ++sequence, own = new AbortController(); controller = own;
    const timeout = AbortSignal.timeout(timeoutMs), signal = AbortSignal.any([own.signal, timeout]);
    let abort: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const loading = Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return load(signal); });
    // A transport that ignores abort must not hold the polling loop forever.
    // Promise.race also observes late rejections without accepting late data.
    pending = Promise.race([loading, deadline])
      .then(value => { if (version === sequence && !signal.aborted && canRead()) onData(value); })
      .catch(error => { if (version === sequence && !own.signal.aborted && canRead()) onError(error); })
      .finally(() => { signal.removeEventListener('abort', abort); if (version === sequence) { pending = null; controller = null; } });
    return pending;
  } };
}
