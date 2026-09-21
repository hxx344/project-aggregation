let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options, credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || '请求未完成，请稍后重试。', response.status);
  return data as T;
}
