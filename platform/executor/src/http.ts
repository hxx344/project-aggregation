// Local HTTP surface for the minimal page. It binds to loopback only, checks
// the Host header against DNS rebinding and requires the per-process session
// cookie plus a custom header on every write, so another site cannot drive it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ContractError, VENUES, type Venue } from './contracts.ts';
import type { Executor } from './executor.ts';
import { PAGE } from './page.ts';

const MAX_BODY_BYTES = 16 * 1024;
const COOKIE = 'pa_executor_session';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const UUID_PATH = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(stop|acknowledge))?$/i;

export interface HttpOptions { executor: Executor; session?: string }

export function createExecutorServer({ executor, session = randomBytes(32).toString('base64url') }: HttpOptions): Server {
  const expected = Buffer.from(session);
  const authorized = (request: IncomingMessage): boolean => {
    const value = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    response.end(payload);
  };
  const readJson = (request: IncomingMessage): Promise<unknown> => new Promise((resolve, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) { chunks.push(chunk); return; }
      // Drain instead of destroying so the client still receives the 413; the connection closes after it.
      request.off('data', onData); request.resume();
      fail(new ContractError(413, 'body_too_large', '请求体过大'));
    };
    request.on('data', onData);
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { fail(new ContractError(400, 'invalid_json', '请求体不是有效 JSON')); } });
    request.on('error', fail);
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!LOOPBACK.test(request.headers.host ?? '')) return send(response, 421, { code: 'host', message: '只接受本机访问' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      });
      response.end(PAGE);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { code: 'not_found', message: '不存在' });
    if (!authorized(request)) return send(response, 401, { code: 'session', message: '会话无效，请刷新页面' });
    if (request.method === 'POST' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return send(response, 200, { generation: executor.generation, retired: executor.retired, transport: 'simulated', accounts: executor.accounts(), jobs: executor.recentJobs(20) });
    }
    if (request.method === 'GET' && url.pathname === '/api/observe') {
      const venue = url.searchParams.get('venue') ?? '', symbol = url.searchParams.get('symbol') ?? '';
      if (!(VENUES as readonly string[]).includes(venue)) return send(response, 400, { code: 'venue', message: '交易所无效' });
      return send(response, 200, await executor.observe(venue as Venue, symbol));
    }
    if (request.method === 'POST' && url.pathname === '/api/preview') return send(response, 200, executor.publicPreview(await executor.preview(await readJson(request), session)));
    if (request.method === 'POST' && url.pathname === '/api/confirm') return send(response, 200, executor.confirm(await readJson(request), session));
    const match = UUID_PATH.exec(url.pathname);
    if (match && request.method === 'GET' && !match[2]) return send(response, 200, executor.jobView(match[1]));
    if (match && request.method === 'POST' && match[2]) {
      const body = await readJson(request) as { requestId?: unknown } | null;
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      return send(response, 200, match[2] === 'stop' ? executor.requestStop(match[1], requestId, session) : executor.acknowledge(match[1], requestId, session));
    }
    return send(response, 404, { code: 'not_found', message: '不存在' });
  }

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ContractError) send(response, error.status, { code: error.code, message: error.message }, error.status === 413 ? { connection: 'close' } : {});
      else send(response, 500, { code: 'internal', message: '执行器内部错误' });
    });
  });
}
