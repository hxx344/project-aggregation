import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';

test('非 204 成功响应解析失败必须拒绝，写请求提示核对结果', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response('<html>proxy response</html>', { status: 200 }); });
  await assert.rejects(api('/api/overview'), error => error instanceof ApiError && error.status === 200 && /响应数据无效/.test(error.message));
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    await assert.rejects(api('/api/trading/accounts/binance', { method }), /保存结果尚未确认；请先刷新核对/);
  }
  await assert.rejects(api('/api/login', { method: 'POST' }), /无法确认请求结果/);
  assert.equal(count, 6, '解析失败不自动重发写请求');
});

test('204 正常返回，其他空的 2xx 响应拒绝，合法 JSON 保留', async t => {
  const stub = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.deepEqual(await api('/api/resource', { method: 'DELETE' }), {});
  for (const status of [200, 201, 202]) {
    stub.mock.mockImplementation(async () => new Response(null, { status }));
    await assert.rejects(api('/api/resource'), error => error instanceof ApiError && error.status === status);
  }
  stub.mock.mockImplementation(async () => Response.json({ accepted: true }, { status: 202 }));
  assert.deepEqual(await api('/api/resource'), { accepted: true });
});

test('错误响应解析失败仍保留 HTTP 状态与通用文案', async t => {
  const stub = t.mock.method(globalThis, 'fetch', async () => new Response('<html>internal diagnostic</html>', { status: 502 }));
  await assert.rejects(api('/api/resource'), error => error instanceof ApiError && error.status === 502 && error.message === '请求未完成，请稍后重试。');
  stub.mock.mockImplementation(async () => Response.json({ error: '连接已过期' }, { status: 401 }));
  await assert.rejects(api('/api/resource'), error => error instanceof ApiError && error.status === 401 && error.message === '连接已过期');
  for (const data of [null, { error: { private: 'detail' } }]) {
    stub.mock.mockImplementation(async () => Response.json(data, { status: 500 }));
    await assert.rejects(api('/api/resource'), error => error instanceof ApiError && error.status === 500 && error.message === '请求未完成，请稍后重试。');
  }
});
