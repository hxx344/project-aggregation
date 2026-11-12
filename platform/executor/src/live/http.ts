// One bounded HTTP exchange for the live connectors (3.0b). Signing and the bounded JSON reader are the shared
// server/exchange-transport code; error classification is venue-specific and stays in each connector.
import { ExchangeResponseError, readJsonResponse } from '../../../../server/exchange-transport/response.mjs';
import { VenueError } from '../connector.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Venue ids are 64-bit integers on the wire; they are kept as their exact digits, never as a rounded double. */
const ID_KEYS = new Set(['orderId', 'algoId', 'uid', 'userID', 'lastUpdateId']);
function idReviver(key: string, value: unknown, context?: { source?: string }): unknown {
  if (!ID_KEYS.has(key) || typeof value !== 'number') return value;
  if (context?.source !== undefined && /^\d{1,30}$/.test(context.source)) return context.source;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new ExchangeResponseError('invalid_data');
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}
export interface HttpReply { status: number; data: unknown }
export interface ExchangeOptions {
  signal: AbortSignal;
  /** Present for a mutation: runs synchronously with no await before fetch is called; a throw there proves nothing was sent. */
  beforeSend?: () => void;
}

/**
 * Not-sent is only ever reported before fetch is called: an abort already seen on entry or a refusal by beforeSend.
 * From the fetch call on, every failure of a mutation (timeout, abort, reset, redirect, unreadable body) is uncertain,
 * whatever the abort listener sees, and every failure of a read is read-failed. HTTP status and venue codes are returned
 * to the caller, which alone can tell a definitive rejection from an unknown outcome.
 */
export async function exchange(fetchImpl: FetchLike, timeoutMs: number, request: HttpRequest, { signal, beforeSend }: ExchangeOptions): Promise<HttpReply> {
  const mutation = beforeSend !== undefined;
  const failure = (message: string): VenueError => new VenueError(mutation ? 'uncertain' : 'read-failed', message);
  if (signal.aborted) throw new VenueError(mutation ? 'not-sent' : 'read-failed', '请求已取消，未发送');
  if (beforeSend) {
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${error instanceof Error ? error.message : '未知'}`); }
  }
  const controller = new AbortController();
  let timedOut = false;
  const forward = (): void => controller.abort();
  signal.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(failure(timedOut ? `请求超过 ${timeoutMs} 毫秒` : '请求已取消'));
    controller.signal.addEventListener('abort', interrupt, { once: true });
  });
  interrupted.catch(() => undefined);
  const run = async (): Promise<HttpReply> => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method, headers: request.headers ?? {}, ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
    } catch { throw failure('网络请求失败'); }
    if (!response || response.redirected || (response.status >= 300 && response.status < 400)) throw failure('交易所应答被重定向');
    let data: unknown;
    try { data = await readJsonResponse(response, { maxBytes: request.maxBytes ?? MAX_BODY_BYTES, signal: controller.signal, reviver: idReviver }); }
    catch (error) { throw failure(error instanceof ExchangeResponseError && error.code === 'response_limit' ? '交易所应答超过大小上限' : `交易所应答无法解析（HTTP ${response.status}）`); }
    return { status: response.status, data };
  };
  try { return await Promise.race([run(), interrupted]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    controller.signal.removeEventListener('abort', interrupt);
    controller.abort();
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
