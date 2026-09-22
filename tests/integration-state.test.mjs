import test from 'node:test';
import assert from 'node:assert/strict';
import { standardSummary, readSummary, UpstreamError } from '../server/adapters.mjs';
import { cachePolicy } from '../server/static-cache.mjs';
import { ageSnapshot, retainedProjects, projectKey, navigation } from '../src/hub-state.ts';
import { checkNotice } from '../src/check-notice.ts';

const project = { id: 'crossex', enabled: true, adapter: 'standard', apiUrl: 'http://127.0.0.1:3200', staleAfterSeconds: 120, revision: 'one' };
const summary = (state = 'online', updatedAt = new Date().toISOString()) => ({ schemaVersion: 2, data: { updatedAt, health: { state, message: '来源状态', staleAfterSeconds: 10 }, metrics: [{ key: 'source', label: '来源', value: state }] } });
test('v2 source state and TTL survive normalization; incomplete health is rejected', () => {
  for (const state of ['online', 'partial', 'offline', 'stale']) {
    const value = summary(state); value.data.health.message = '账户 A：成交统计读取失败，等待重新读取';
    const normalized = standardSummary(value); assert.equal(normalized.state, state); assert.equal(normalized.staleAfterSeconds, 10); assert.equal(normalized.message, value.data.health.message);
  }
  assert.equal(standardSummary(summary('offline', null)).updatedAt, null);
  for (const ttl of [0, -1, 0.5, 86401, '10']) { const value = summary(); value.data.health.staleAfterSeconds = ttl; assert.throws(() => standardSummary(value)); }
  for (const state of ['unknown', null]) assert.throws(() => standardSummary(summary(state)));
  const value = summary(); value.data.health.secret = 'unexpected'; assert.throws(() => standardSummary(value));
});
test('check notices preserve the concrete reason and distinguish success, warnings, failures and links', () => {
  const configured = { ...project, name: 'ASTER 5X', adapter: 'aster' };
  for (const [state, tone] of [['online', 'success'], ['partial', 'warning'], ['stale', 'warning'], ['unauthorized', 'warning'], ['offline', 'error'], ['unconfigured', 'info'], ['disabled', 'info']]) {
    const notice = checkNotice(configured, { state, message: '账户 A：成交统计已过期（超过 15 秒）' });
    assert.equal(notice.tone, tone); assert.equal(notice.detail, '账户 A：成交统计已过期（超过 15 秒）'); assert.match(notice.title, /^ASTER 5X：/);
  }
  const link = { ...configured, adapter: 'link' };
  const notice = checkNotice(link, { state: 'online', message: '链接入口' });
  assert.equal(notice.tone, 'info'); assert.match(notice.title, /未检测可达性/);
  assert.match(checkNotice(link, { state: 'unconfigured', message: '请配置项目地址' }).title, /待配置/);
  assert.match(checkNotice(configured, { state: 'partial', message: ' ' }).detail, /上游未提供具体原因/);
});
test('summary probing falls back only for missing methods/routes, never for auth, invalid data or timeout', async () => {
  for (const status of [404, 405]) {
    const calls = [];
    const value = await readSummary(project, null, { request: async (_base, route) => { calls.push(route); if (route.includes('?')) throw new UpstreamError('offline', 'missing', status); return { data: summary() }; } });
    assert.equal(value.staleAfterSeconds, 10); assert.deepEqual(calls, ['/api/hub/summary?schemaVersion=2', '/api/hub/summary']);
  }
  for (const failure of [new UpstreamError('unauthorized', 'denied', 401), new UpstreamError('timeout', 'timeout'), new UpstreamError('offline', 'unavailable', 503), null]) {
    let calls = 0;
    await assert.rejects(readSummary(project, null, { request: async () => { calls++; if (failure) throw failure; return { data: { metrics: [] } }; } }));
    assert.equal(calls, 1);
  }
});
test('client ages source timestamps without waiting for polling and preserves offline/static states', () => {
  const base = { project, state: 'online', staleAfterSeconds: 10, updatedAt: new Date(100000).toISOString(), message: '正常' };
  assert.equal(ageSnapshot(base, 109999).state, 'online'); assert.equal(ageSnapshot(base, 110001).state, 'stale');
  assert.equal(ageSnapshot({ ...base, state: 'offline' }, 110001).state, 'offline');
  assert.equal(ageSnapshot({ ...base, freshness: 'static' }, 110001).state, 'online');
  assert.equal(ageSnapshot({ ...base, updatedAt: null }, 100000).state, 'stale');
});

test('lightweight Monitor summary preserves the configured module and Basic authentication', async () => {
  let requested;
  await readSummary({ ...project, adapter: 'monitor', url: 'http://127.0.0.1:3000/?monitor=hynix' }, { username: 'reader', password: 'test-value' }, { request: async (_base, route, options) => { requested = { route, headers: options.headers }; return { data: summary() }; } });
  assert.equal(requested.route, '/api/hub/summary?schemaVersion=2&monitor=hynix');
  assert.equal(requested.headers.Authorization, 'Basic ' + Buffer.from('reader:test-value').toString('base64'));
});
test('only two compatible frames survive and edits/removal revoke retained pages', () => {
  const projects = ['a','b','c'].map(id => ({ ...project, id })); const keys = projects.map(projectKey);
  assert.deepEqual(retainedProjects(keys, projects, 'c', new Set(keys)), [keys[2], keys[0]]);
  assert.deepEqual(retainedProjects(keys, projects, null, new Set([keys[1]])), [keys[1]]);
  assert.deepEqual(retainedProjects(keys, [{ ...projects[0], revision: 'two' }, { ...projects[1], enabled: false }], null, new Set(keys)), []);
});
test('cross-module navigation accepts only known targets and bounded view filters', () => {
  assert.deepEqual(navigation({ projectId: 'crossex', query: { symbol: 'BTC', longExchange: 'binance', shortExchange: 'bybit' } }).query.symbol, 'BTC');
  for (const value of [{ projectId: 'https://evil.test', query: {} }, { projectId: 'asset', query: { symbol: 'BTC' } }, { projectId: 'crossex', query: { symbol: '<script>' } }, { projectId: 'monitor', query: { url: 'https://evil.test' } }, { projectId: 'monitor', query: { longExchange: 'unknown' } }]) assert.equal(navigation(value), null);
});
test('only explicitly public immutable hashed JS/CSS are cacheable', () => {
  const headers = { 'cache-control': 'public, max-age=31536000, immutable', 'content-type': 'text/javascript; charset=utf-8' };
  assert.match(cachePolicy('/assets/index-AbCd1234.js', headers), /^private,/);
  assert.match(cachePolicy('/_next/static/chunks/framework-DTZGTDtF.js', headers), /^private,/);
  assert.match(cachePolicy('/_next/static/chunks/1234-abcdef123456.js', headers), /^private,/);
  for (const path of ['/api/state', '/', '/assets/private.js', '/assets/index-AbCd1234.js.map']) assert.equal(cachePolicy(path, headers), 'no-store');
  for (const patch of [{ 'set-cookie': ['private=1'] }, { 'content-type': 'text/html' }, { 'cache-control': 'no-store' }, { 'cache-control': 'private, immutable' }]) assert.equal(cachePolicy('/assets/index-AbCd1234.js', { ...headers, ...patch }), 'no-store');
  assert.equal(cachePolicy('/assets/index-AbCd1234.js', headers, 401), 'no-store');
});
