import { requestJson, UpstreamError } from './adapters.mjs';

const cookieNames = { aster: 'aster_session', asset: 'asset_session' };
const invalidSession = () => new UpstreamError('unauthorized', '上游没有返回有效的登录会话');

function sessionCookie(cookies, expectedName) {
  if (!Array.isArray(cookies)) throw invalidSession();
  const matches = [];
  for (const header of cookies) {
    if (typeof header !== 'string') continue;
    const pair = header.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== expectedName) continue;
    const value = pair.slice(separator + 1);
    // Only an unambiguous RFC 6265 cookie value is handed to the portal.
    if (pair.slice(0, separator) !== expectedName || /[\x00-\x1F\x7F]/.test(header) ||
      !value || value.length > 4096 || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) throw invalidSession();
    matches.push(value);
  }
  if (matches.length !== 1) throw invalidSession();
  return { name: expectedName, value: matches[0], maxAge: 43200 };
}

export async function loginForPortal(project, credentials, {
  deadline = Date.now() + 10000, signal, request = requestJson,
} = {}) {
  if (typeof credentials?.password !== 'string' || !credentials.password ||
    !['aster', 'asset', 'monitor', 'standard'].includes(project?.adapter)) return null;
  const checkDeadline = () => {
    if (signal?.aborted || !Number.isFinite(deadline) || deadline <= Date.now()) throw new UpstreamError('timeout', '服务响应超时');
  };
  checkDeadline();
  let origin;
  try { origin = project.authOrigin || new URL(project.apiUrl).origin; }
  catch { throw new UpstreamError('invalid', '项目服务地址不正确'); }
  const headers = { Origin: origin };
  const name = cookieNames[project.adapter];
  if (name) {
    // Opening a page must never borrow the summary worker's revocable session.
    const response = await request(project.apiUrl, '/api/login', {
      method: 'POST', body: { password: credentials.password }, headers, deadline, signal,
    });
    checkDeadline();
    return { cookie: sessionCookie(response?.cookies, name) };
  }
  const authorization = 'Basic ' + Buffer.from((credentials.username || '') + ':' + credentials.password).toString('base64');
  await request(project.apiUrl, project.adapter === 'monitor' ? '/api/monitors' : '/api/hub/summary', {
    method: 'GET', headers: { ...headers, Authorization: authorization }, deadline, signal,
  });
  checkDeadline();
  return { authorization };
}
