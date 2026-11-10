import { HttpError, send, readJson } from '../http-common.mjs';
import { createRateLimit } from './tokens.mjs';

export const AGENT_PREFIX = '/api/agent/v1';
export const MANAGE_PATH = '/api/system/agent-feed';
// One runaway polling loop must not occupy the API; snapshots are shared and
// rebuilt every few seconds, so a faster reader learns nothing new.
export const REQUESTS_PER_MINUTE = 120;
const ID = /^\/tokens\/([0-9a-f-]{36})$/;

// agent(): the token-only read surface. It never looks at the session cookie,
// and a token is accepted nowhere else. manage(): the page's token management,
// called after the API has checked the session, origin and CSRF token.
export function createAgentFeedRoutes({ tokens, feed, log, clientAddress = () => undefined, now = Date.now }) {
  const limited = createRateLimit({ limit: REQUESTS_PER_MINUTE, windowMs: 60_000, now });
  const bearer = req => /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] ?? null;
  async function agent(req, res, url) {
    if (req.method !== 'GET') { send(res, 405, { error: '数据接口只读，仅支持 GET' }, { Allow: 'GET' }); return; }
    const access = tokens.verify(bearer(req));
    if (!access) { send(res, 401, { error: '令牌无效或已撤销，请在请求头使用 Authorization: Bearer <令牌>' }, { 'WWW-Authenticate': 'Bearer' }); return; }
    const retryAfter = limited(access.id);
    if (retryAfter) { send(res, 429, { error: `请求过于频繁，每个令牌每分钟最多 ${REQUESTS_PER_MINUTE} 次`, retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) }); return; }
    const route = url.pathname.slice(AGENT_PREFIX.length);
    if (route === '/catalog') {
      if (url.search) throw new HttpError(400, '数据目录不接受查询参数');
      send(res, 200, feed.catalog(access.scopes)); return;
    }
    if (route === '/snapshot') {
      const names = [...url.searchParams.keys()];
      if (names.some(name => name !== 'datasets') || url.searchParams.getAll('datasets').length > 1) throw new HttpError(400, '快照只接受一个 datasets 参数');
      const wanted = url.searchParams.get('datasets');
      send(res, 200, await feed.snapshot(access.scopes, wanted === null ? null : wanted.split(','))); return;
    }
    throw new HttpError(404, '数据接口不存在，可用：/catalog、/snapshot');
  }
  async function manage(req, res, url) {
    if (url.search) throw new HttpError(400, '令牌管理接口不接受查询参数');
    const route = url.pathname.slice(MANAGE_PATH.length);
    if (route === '' && req.method === 'GET') { send(res, 200, { schemaVersion: 1, ...tokens.state(), requestsPerMinute: REQUESTS_PER_MINUTE, datasets: feed.catalog(tokens.state().scopes).datasets.map(({ id, scope, title }) => ({ id, scope, title })) }); return; }
    if (route === '/tokens' && req.method === 'POST') {
      const created = tokens.create(await readJson(req.headers['content-type'], req));
      log.info({ tokenId: created.entry.id, scopes: created.entry.scopes, ip: clientAddress(req), type: 'agent-feed' }, '已创建数据接口令牌');
      send(res, 201, { token: created.token, entry: created.entry }); return;
    }
    const match = ID.exec(route);
    if (match && req.method === 'DELETE') {
      tokens.revoke(match[1]);
      log.info({ tokenId: match[1], ip: clientAddress(req), type: 'agent-feed' }, '已撤销数据接口令牌');
      send(res, 200, { revoked: true }); return;
    }
    throw new HttpError(route === '' || route === '/tokens' || match ? 405 : 404, route === '' || route === '/tokens' || match ? '请求方法不支持' : '令牌管理接口不存在');
  }
  return { agent, manage };
}
