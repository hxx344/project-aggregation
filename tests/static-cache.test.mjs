import test from 'node:test';
import assert from 'node:assert/strict';
import { cachePolicy } from '../server/static-cache.mjs';

test('only registered module transports may retain private immutable build assets in the browser cache', () => {
  const headers = { 'content-type': 'text/javascript', 'cache-control': 'private, max-age=31536000, immutable' };
  const asset = '/assets/app-deadbeef.js';
  assert.equal(cachePolicy(asset, headers), 'no-store');
  assert.equal(cachePolicy(asset, headers, 200, true), 'private, max-age=31536000, immutable');
  for (const path of ['/', '/api/state', '/assets/unversioned.js']) assert.equal(cachePolicy(path, headers, 200, true), 'no-store');
  for (const extra of [{ 'set-cookie': 'session=private' }, { location: '/login' }, { 'content-type': 'application/json' }, { 'cache-control': 'private, immutable, no-store' }]) {
    assert.equal(cachePolicy(asset, { ...headers, ...extra }, 200, true), 'no-store');
  }
  for (const status of [206, 304, 401, 500]) assert.equal(cachePolicy(asset, headers, status, true), 'no-store');
});
