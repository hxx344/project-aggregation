import { isSqliteBusy, recordBusyReply } from './sqlite-writes.mjs';

// Shared by the API server and the runtime data plane, so a route keeps the
// same body rules and error mapping on whichever side handles it.
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export const MAX_BODY_BYTES = 32768;
export const INTERNAL_ERROR = '服务暂时无法处理请求';
export const DATABASE_BUSY = '数据库繁忙，请稍后重试';

export const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };

// `stream` is any iterable of Buffers: the incoming request or a forwarded body.
// Returns the parsed object and the bytes it came from, so a caller can forward them unchanged.
export async function readJsonBody(contentType, stream) {
  if (!contentType?.startsWith('application/json')) throw new HttpError(415, '请求需使用 JSON');
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) throw new HttpError(413, '请求内容过大'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks);
  try { const body = JSON.parse(raw.toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return { body, raw }; } catch { throw new HttpError(400, 'JSON 格式不正确'); }
}
export const readJson = async (contentType, stream) => (await readJsonBody(contentType, stream)).body;

// Errors of the listed classes are decisions with a public message. A write that waited out
// busy_timeout for the other process is retryable, so it is a 503; anything else is a 500.
export function errorResponder(classes) {
  return error => {
    if (classes.some(type => error instanceof type)) return { status: error.status, body: { error: error.message } };
    if (isSqliteBusy(error)) { recordBusyReply(); return { status: 503, body: { error: DATABASE_BUSY } }; }
    return { status: 500, body: { error: INTERNAL_ERROR } };
  };
}
