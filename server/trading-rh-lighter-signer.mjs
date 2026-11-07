import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./trading-rh-lighter-signer-worker.mjs', import.meta.url);
// The first call decompresses and compiles the ~14 MB module; later calls take milliseconds.
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Lazily started signer thread. A call that times out terminates the worker
 * (a stuck WASM call cannot be interrupted otherwise); the next call starts a
 * fresh one. Nothing is retried here: the caller decides what a failed
 * signature means, and no request has been sent when signing fails.
 */
export function createRhLighterSigner({ timeoutMs = DEFAULT_TIMEOUT_MS, WorkerClass = Worker } = {}) {
  let worker = null, sequence = 0;
  const pending = new Map();
  function settleAll(message) {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(message)); }
    pending.clear();
  }
  function start() {
    const current = new WorkerClass(WORKER_URL);
    current.unref?.();
    current.on('message', ({ id, result, error }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id); clearTimeout(entry.timer);
      if (error) entry.reject(new Error(error)); else entry.resolve(result);
    });
    const lost = () => { if (worker === current) { worker = null; settleAll('signer stopped'); } };
    current.on('error', lost);
    current.on('exit', lost);
    return current;
  }
  function call(method, params) {
    worker ??= start();
    const id = ++sequence, current = worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('signer timeout'));
        if (worker === current) { worker = null; settleAll('signer restarted'); void current.terminate(); }
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      current.postMessage({ id, method, params });
    });
  }
  return {
    createOrder: params => call('createOrder', params),
    modifyOrder: params => call('modifyOrder', params),
    cancelOrder: params => call('cancelOrder', params),
    authToken: params => call('authToken', params),
    close() { const current = worker; worker = null; settleAll('signer closed'); return current ? current.terminate() : Promise.resolve(); },
  };
}
