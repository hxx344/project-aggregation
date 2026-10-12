export async function requestJson<T>(path: string, { timeoutMs = 15_000, ...options }: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  const timeoutMessage = path === '/api/sync' ? '刷新超时，已保留上次数据，请稍后重试。' : !options.method || options.method === 'GET' ? '数据读取超时，请稍后重试。' : '请求超时，保存结果尚未确认；请先刷新核对。';
  const timer = setTimeout(() => controller.abort(new DOMException(timeoutMessage, 'TimeoutError')), timeoutMs);
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(controller.signal.reason);
    if (controller.signal.aborted) cancel(); else controller.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      controller.signal.throwIfAborted();
      const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal });
      const data = await response.json() as T & { error?: string };
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试');
      return data;
    })()]);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancel);
  }
}

export function createRequestSlot() {
  let current: { controller: AbortController; automatic: boolean } | null = null;
  return {
    start(automatic = false) { if (current) return null; current = { controller: new AbortController(), automatic }; return current.controller; },
    finish(controller: AbortController) { if (current?.controller !== controller) return false; current = null; return true; },
    cancel(automaticOnly = false) { if (!current || (automaticOnly && !current.automatic)) return false; const old = current; current = null; old.controller.abort(); return true; },
  };
}
