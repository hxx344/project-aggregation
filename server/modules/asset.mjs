import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSession } from '../../modules/asset/lib/auth-core.ts';

export function assetRequestHandler({ handler, sessionSecret, secret }) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(sessionSecret)) throw new Error('Invalid managed Asset configuration');
  return async (request, response) => {
    if (request.headers['x-workspace-key'] !== secret) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    delete request.headers['x-workspace-key'];
    delete request.headers['x-workspace-asset-export'];
    const pathname = new URL(request.url, 'http://workspace.internal').pathname;
    if (pathname === '/api/hub/trading-connections/export') request.headers['x-workspace-asset-export'] = secret;
    if (pathname === '/api/login' || pathname === '/api/logout') {
      response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: '请使用工作台的登录和退出功能' }));
      return;
    }
    if (pathname === '/login') {
      response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }).end();
      return;
    }
    // Only the private worker request gets a signed owner session. Never send it
    // to the browser or change Origin / Sec-Fetch-Site: Next still checks CSRF.
    const cookies = (request.headers.cookie || '').split(';').filter(value => value.trim() && value.trim().split('=')[0] !== 'asset_session');
    cookies.push(`asset_session=${createSession(sessionSecret)}`);
    request.headers.cookie = cookies.join('; ');
    try { await handler(request, response); }
    catch {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: '资产服务暂不可用' }));
    }
  };
}

export async function createModule({ root, dataDir, secret, environment = {} }) {
  Object.assign(process.env, environment, { ASSET_DATA_DIR: resolve(dataDir), NODE_ENV: 'production', WORKSPACE_MANAGED: '1', ASSET_WORKSPACE_EXPORT_SECRET: secret });
  // The external workspace module host is authoritative, not the old service URL.
  delete process.env.PUBLIC_ORIGIN;
  const { configure } = await import(pathToFileURL(resolve(root, 'scripts/configure.mjs')).href);
  configure(resolve(dataDir));
  const config = JSON.parse(readFileSync(resolve(dataDir, 'config.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(config.credentialKey) || !/^[a-f0-9]{64}$/i.test(config.sessionSecret)
      || !/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(config.passwordHash)) throw new Error('Invalid existing Asset configuration');
  const require = createRequire(resolve(root, 'package.json'));
  const next = require('next');
  // Use the build's serialized config so production never needs to compile the
  // TypeScript config or install development dependencies on the target host.
  const built = JSON.parse(readFileSync(resolve(root, '.next/required-server-files.json'), 'utf8'));
  const conf = { ...built.config, outputFileTracingRoot: root, turbopack: { ...built.config.turbopack, root } };
  // Next's custom router loads config separately; use its bundled-server config
  // channel as well as `conf` (the module pins the Next version).
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
  const application = next({ dev: false, dir: root, conf });
  await application.prepare();
  const server = createServer(assetRequestHandler({ handler: application.getRequestHandler(), sessionSecret: config.sessionSecret, secret }));
  return { server, close: () => application.close() };
}
