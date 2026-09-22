let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(url: string, { timeoutMs = 15_000, ...options }: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const checking = /\/check$/.test(url);
  const writing = options.method && !['GET', 'HEAD'].includes(options.method) && !/\/(?:check|launch|login|logout)$/.test(url);
  const timeout = () => new DOMException(checking ? '连接检查超时，请检查该项目服务后重试。' : writing ? '请求超时，保存结果尚未确认；请先刷新核对。' : '数据读取超时，请稍后重试。', 'TimeoutError');
  const abort = () => controller.abort(options.signal?.reason?.name === 'TimeoutError' ? timeout() : options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), timeoutMs);
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(controller.signal.reason);
    if (controller.signal.aborted) cancel();
    else controller.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      controller.signal.throwIfAborted();
      const response = await fetch(url, {
        ...options, signal: controller.signal, credentials: 'same-origin',
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
      });
      const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
      controller.signal.throwIfAborted();
      if (!response.ok) throw new ApiError(data.error || '请求未完成，请稍后重试。', response.status);
      return data as T;
    })()]);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancel);
  }
}
