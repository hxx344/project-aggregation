// Local HTTP surface for the minimal page. It binds to loopback only, checks
// the Host header against DNS rebinding, hands the session cookie out only in
// exchange for the access token written to the data directory, and requires that
// cookie plus a custom header on every write, so neither another site nor another
// local process that merely reaches the port can drive it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ContractError, VENUES, exactKeys, type Venue } from './contracts.ts';
import type { Executor } from './executor.ts';
import { PAGE } from './page.ts';

const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const UUID_PATH = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(stop|acknowledge|adopt-strategy|confirm-not-created|release-strategy))?$/i;

const PAIR_PATH = /^\/api\/transfer-pairs\/([0-9A-Za-z_-]{1,64})\/(enable|disable)$/;
const ADL_CONFIG_PATH = /^\/api\/adl\/pairs\/([0-9A-Za-z_-]{1,64})\/config$/;
const ADL_RESTART_PATH = /^\/api\/adl\/incidents\/([0-9a-f-]{36})\/restart$/;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
const LOGIN_REQUIRED = '<!doctype html><meta charset="utf-8"><title>需要登录</title><p>请使用数据目录 access-url 中的登录链接打开。</p>';

/** Instances on different ports of one host share the browser cookie jar for 127.0.0.1, so the name carries the port. */
export const sessionCookieName = (port: number): string => `pa_executor_session_${port}`;

/** accessToken is exchanged once per browser at /login; session is the cookie value and the executor session id. */
export interface HttpOptions { executor: Executor; accessToken: string; session?: string }

// Hashing first gives equal-length inputs, so the comparison does not leak the token length either.
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

export function createExecutorServer({ executor, accessToken, session = randomBytes(32).toString('base64url') }: HttpOptions): Server {
  if (!accessToken) throw new Error('需要访问令牌');
  if (sameSecret(session, accessToken)) throw new Error('会话值不能与访问令牌相同');
  // The name follows the port actually bound, which is only known once listening (port 0 in tests).
  const cookieName = (request: IncomingMessage) => sessionCookieName(request.socket.localPort ?? 0);
  const authorized = (request: IncomingMessage): boolean => {
    const name = cookieName(request);
    const value = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    return value !== undefined && sameSecret(value, session);
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
    if (request.method === 'GET' && url.pathname === '/login') {
      if (!sameSecret(url.searchParams.get('token') ?? '', accessToken)) { response.writeHead(401, PAGE_HEADERS); response.end(LOGIN_REQUIRED); return; }
      response.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': `${cookieName(request)}=${session}; HttpOnly; SameSite=Strict; Path=/` });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const ok = authorized(request);
      response.writeHead(ok ? 200 : 401, PAGE_HEADERS);
      response.end(ok ? PAGE : LOGIN_REQUIRED);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { code: 'not_found', message: '不存在' });
    if (!authorized(request)) return send(response, 401, { code: 'session', message: '会话无效，请使用数据目录 access-url 中的登录链接重新打开' });
    if (request.method === 'POST' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return send(response, 200, { generation: executor.generation, retired: executor.retired, transport: 'simulated', accounts: executor.accounts(), jobs: executor.recentJobs(20),
        transfers: { pairs: executor.transferPairs(), corruptPairs: executor.corruptTransferPairs(), recent: executor.recentTransfers(20) },
        adl: { pairs: executor.adlPairs(), recent: executor.recentAdlIncidents(10) } });
    }
    if (request.method === 'GET' && url.pathname === '/api/observe') {
      const venue = url.searchParams.get('venue') ?? '', symbol = url.searchParams.get('symbol') ?? '';
      if (!(VENUES as readonly string[]).includes(venue)) return send(response, 400, { code: 'venue', message: '交易所无效' });
      return send(response, 200, await executor.observe(venue as Venue, symbol));
    }
    if (request.method === 'POST' && url.pathname === '/api/preview') return send(response, 200, executor.publicPreview(await executor.preview(await readJson(request), session)));
    if (request.method === 'POST' && url.pathname === '/api/confirm') return send(response, 200, executor.confirm(await readJson(request), session));
    const pair = request.method === 'POST' ? PAIR_PATH.exec(url.pathname) : null;
    if (pair) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.setTransferEnabled({ pairId: pair[1], enabled: pair[2] === 'enable', requestId: body.requestId }, session));
    }
    const adlConfig = request.method === 'POST' ? ADL_CONFIG_PATH.exec(url.pathname) : null;
    if (adlConfig) {
      const body = exactKeys(await readJson(request), ['requestId', 'autoReduce', 'batchNotional']);
      return send(response, 200, executor.setAdlConfig({ pairId: adlConfig[1], ...body }, session));
    }
    const adlRestart = request.method === 'POST' ? ADL_RESTART_PATH.exec(url.pathname) : null;
    if (adlRestart) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, executor.restartAdl({ incidentId: adlRestart[1], requestId: body.requestId }, session));
    }
    const match = UUID_PATH.exec(url.pathname);
    // The path match is case-insensitive, so the action is compared lowercased; otherwise /STOP would fall through to acknowledge.
    const action = match?.[2]?.toLowerCase();
    if (match && request.method === 'GET' && !action) return send(response, 200, executor.jobView(match[1]));
    if (match && request.method === 'POST' && action === 'adopt-strategy') {
      const body = exactKeys(await readJson(request), ['requestId', 'strategyId']);
      return send(response, 200, await executor.adoptStrategy({ jobId: match[1], requestId: body.requestId, strategyId: body.strategyId }, session));
    }
    if (match && request.method === 'POST' && action === 'confirm-not-created') {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.confirmNotCreated({ jobId: match[1], requestId: body.requestId }, session));
    }
    if (match && request.method === 'POST' && action === 'release-strategy') {
      const body = exactKeys(await readJson(request), ['requestId'], ['acknowledgeRisk']);
      return send(response, 200, executor.releaseStrategy({ jobId: match[1], requestId: body.requestId, acknowledgeRisk: body.acknowledgeRisk }, session));
    }
    if (match && request.method === 'POST' && (action === 'stop' || action === 'acknowledge')) {
      const body = await readJson(request) as { requestId?: unknown } | null;
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      return send(response, 200, action === 'stop' ? executor.requestStop(match[1], requestId, session) : executor.acknowledge(match[1], requestId, session));
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
