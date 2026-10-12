import test from 'node:test';
import assert from 'node:assert/strict';
import { assetRequestHandler } from '../server/modules/asset.mjs';
import { validSession } from '../modules/asset/lib/auth-core.ts';
import { workspaceExportAuthorized } from '../modules/asset/lib/workspace-auth.ts';

const sessionSecret = 'a'.repeat(64), secret = 'private-worker-secret';
function response() { return { status: 200, headers: {}, body: '', writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(value = '') { this.body = value; return this; } }; }

test('Asset injects a signed owner only after private authentication without changing CSRF headers', async () => {
  let forwarded;
  const handler = assetRequestHandler({ secret, sessionSecret, handler: request => { forwarded = request; } });
  const denied = response();
  await handler({ url: '/', headers: { cookie: 'asset_session=forged' } }, denied);
  assert.equal(denied.status, 403); assert.equal(forwarded, undefined);
  const request = { url: '/api/ledger', headers: { 'x-workspace-key': secret, cookie: 'asset_session=forged; other=retained; asset_session=duplicate', origin: 'https://hostile.example', 'sec-fetch-site': 'cross-site' } };
  const result = response(); await handler(request, result);
  assert.equal(forwarded, request);
  const sessions = request.headers.cookie.split(';').map(value => value.trim()).filter(value => value.startsWith('asset_session='));
  assert.equal(sessions.length, 1);
  assert.ok(validSession(sessions[0].slice('asset_session='.length), sessionSecret));
  assert.match(request.headers.cookie, /other=retained/);
  assert.equal(request.headers.origin, 'https://hostile.example');
  assert.equal(request.headers['sec-fetch-site'], 'cross-site');
  assert.equal(request.headers['x-workspace-key'], undefined);
  assert.equal(result.headers['Set-Cookie'], undefined);
});

test('Asset standalone login and logout cannot create a competing workspace session', async () => {
  const handler = assetRequestHandler({ secret, sessionSecret, handler: () => assert.fail('standalone auth forwarded') });
  for (const url of ['/api/login', '/api/logout']) {
    const result = response(); await handler({ url, headers: { 'x-workspace-key': secret } }, result);
    assert.equal(result.status, 409); assert.equal(result.headers['Set-Cookie'], undefined);
  }
  const result = response(); await handler({ url: '/login', headers: { 'x-workspace-key': secret } }, result);
  assert.equal(result.status, 302); assert.equal(result.headers.Location, '/');
});

test('Asset export authorization exists only on the canonical private route and in managed mode', async () => {
  const environment = { WORKSPACE_MANAGED: '1', ASSET_WORKSPACE_EXPORT_SECRET: secret };
  assert.equal(workspaceExportAuthorized(new Headers(), environment), false);
  assert.equal(workspaceExportAuthorized(new Headers({ 'x-workspace-asset-export': 'forged' }), environment), false);
  assert.equal(workspaceExportAuthorized(new Headers({ 'x-workspace-asset-export': secret }), {}), false);
  const requests = [];
  const handler = assetRequestHandler({ secret, sessionSecret, handler: request => requests.push(request) });
  for (const url of ['/api/hub/trading-connections/export', '/api/ledger', '/api/hub/trading-connections/%65xport']) {
    await handler({ url, headers: { 'x-workspace-key': secret, 'x-workspace-asset-export': 'forged' } }, response());
  }
  assert.equal(workspaceExportAuthorized(new Headers(requests[0].headers), environment), true);
  assert.equal(requests[1].headers['x-workspace-asset-export'], undefined);
  assert.equal(requests[2].headers['x-workspace-asset-export'], undefined);
});
