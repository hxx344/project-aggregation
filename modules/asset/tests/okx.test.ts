import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { okxGet, syncOkx, type OkxCredential } from '../lib/okx.ts';

const credential: OkxCredential = { apiKey: 'okx-fixture-key', apiSecret: 'okx-fixture-secret', passphrase: 'okx-fixture-passphrase' };
const configPath = '/api/v5/account/config';
const valuationPath = '/api/v5/asset/asset-valuation';
function valuation() {
  return { totalBal: '3790.09', ts: String(Date.now() - 1000), details: { funding: '0.09', trading: '2544.28', earn: '1122.73', classic: '124.6' } };
}
function mock(handler: (url: URL, init: RequestInit) => unknown): typeof fetch {
  return (async (url: RequestInfo | URL, init: RequestInit = {}) => Response.json(handler(new URL(String(url)), init))) as typeof fetch;
}
function response(value: unknown = valuation(), config: unknown = { perm: 'read_only' }): typeof fetch {
  return mock(url => ({ code: '0', data: [url.pathname === configPath ? config : value] }));
}

test('OKX signs exactly the transmitted GET path and fixed USD query with Base64 HMAC and reads permissions first', async () => {
  const calls: string[] = [];
  const value = valuation();
  const result = await syncOkx(credential, mock((url, init) => {
    calls.push(url.pathname);
    assert.equal(url.origin, 'https://openapi.okx.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.deepEqual([...headers.keys()].sort(), ['content-type', 'ok-access-key', 'ok-access-passphrase', 'ok-access-sign', 'ok-access-timestamp']);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('OK-ACCESS-KEY'), credential.apiKey);
    assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), credential.passphrase);
    const timestamp = headers.get('OK-ACCESS-TIMESTAMP')!;
    assert.equal(new Date(timestamp).toISOString(), timestamp);
    assert.ok(Math.abs(Date.parse(timestamp) - Date.now()) < 5000);
    assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', credential.apiSecret).update(timestamp + 'GET' + url.pathname + url.search).digest('base64'));
    for (const secret of Object.values(credential)) assert.equal(url.href.includes(secret), false);
    if (url.pathname === configPath) {
      assert.equal(url.search, '');
      return { code: '0', data: [{ perm: 'read_only' }] };
    }
    assert.equal(url.pathname, valuationPath);
    assert.equal(url.search, '?ccy=USD');
    return { code: '0', data: [value] };
  }));
  assert.deepEqual(calls, [configPath, valuationPath]);
  assert.equal(result.total, 3790.09);
  assert.deepEqual(result.details.map(row => row.value), [0.09, 2544.28, 1122.73, 124.6]);
  assert.ok(result.details.every(row => row.coin === 'USD' && row.quantity === row.value && row.price === 1 && row.account.endsWith('（USD 估值）')));
  assert.equal(result.updatedAt, new Date(Number(value.ts)).toISOString());
});

test('OKX uses totalBal once without adding account details, asset balances or P&L', async () => {
  const result = await syncOkx(credential, response({ ...valuation(), totalBal: '100', balance: '900', unrealizedPnl: '50' }));
  assert.equal(result.total, 100);
  assert.equal(result.details.length, 4);
});

test('OKX accepts real zero, negative values and absence of deprecated classic', async () => {
  const zero = await syncOkx(credential, response({ ...valuation(), totalBal: '-0.000', details: { funding: '0', trading: '-0.000', earn: '0' } }));
  assert.equal(zero.total, 0);
  assert.deepEqual(zero.details.map(row => [row.quantity, row.value, row.price]), [[0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  const negative = await syncOkx(credential, response({ ...valuation(), totalBal: '-10', details: { funding: '5', trading: '-15', earn: '0' } }));
  assert.equal(negative.total, -10);
  assert.equal(negative.details[1].value, -15);
});

test('OKX requires exactly read_only permissions before fetching assets', async () => {
  for (const perm of [undefined, null, false, 0, '', ' ', 'trade', 'withdraw', 'read_only,trade', 'read_only,withdraw', 'read_only,unknown', 'read_only,read_only', 'read_only ', 'READ_ONLY', ['read_only']]) {
    const calls: string[] = [];
    await assert.rejects(syncOkx(credential, mock(url => { calls.push(url.pathname); return { code: '0', data: [{ perm }] }; })), /无法确认只读权限/);
    assert.deepEqual(calls, [configPath]);
  }
});

test('OKX verifies permissions on every sync after key permissions change', async () => {
  let allowed = true;
  let assetReads = 0;
  const fetcher = mock(url => {
    if (url.pathname === configPath) return { code: '0', data: [{ perm: allowed ? 'read_only' : 'read_only,trade' }] };
    assetReads++;
    return { code: '0', data: [valuation()] };
  });
  await syncOkx(credential, fetcher);
  allowed = false;
  await assert.rejects(syncOkx(credential, fetcher), /无法确认只读权限/);
  assert.equal(assetReads, 1);
});

test('OKX rejects malformed wrappers and requires one account object per response', async () => {
  for (const data of [null, false, '', [], {}, { code: 0, data: [{}] }, { code: '0' }, { code: '0', data: {} }, { code: '0', data: [] }, { code: '0', data: [null] }, { code: '0', data: [[]] }, { code: '0', data: [{ perm: 'read_only' }, { perm: 'read_only' }] }]) {
    let calls = 0;
    await assert.rejects(syncOkx(credential, mock(() => { calls++; return data; })), /数据不完整|读取失败/);
    assert.equal(calls, 1);
  }
  for (const data of [[], [null], [[]], [valuation(), valuation()]]) {
    await assert.rejects(syncOkx(credential, mock(url => ({ code: '0', data: url.pathname === configPath ? [{ perm: 'read_only' }] : data }))), /数据不完整/);
  }
});

test('OKX rejects missing, malformed and unknown account detail structures with fixed errors', async () => {
  for (const details of [undefined, null, [], '', false, {}]) {
    await assert.rejects(syncOkx(credential, response({ ...valuation(), details })), /数据不完整|不是有效数值/);
  }
  for (const key of ['funding', 'trading', 'earn']) {
    const details: Record<string, unknown> = { ...valuation().details };
    delete details[key];
    await assert.rejects(syncOkx(credential, response({ ...valuation(), details })), /不是有效数值/);
  }
  await assert.rejects(syncOkx(credential, response({ ...valuation(), details: { ...valuation().details, [credential.apiSecret]: '1' } })), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /未知账户分项/);
    assert.equal(error.message.includes(credential.apiSecret), false);
    return true;
  });
});

test('OKX rejects missing, blank, malformed, underflowing or overflowing monetary values', async () => {
  for (const invalid of [undefined, null, false, 0, 1, [], {}, '', ' ', ' 1', '1 ', 'NaN', 'Infinity', '-Infinity', '0x10', '1e3', '+1', '1,000', '.1', '1.', '9'.repeat(400), '0.' + '0'.repeat(400) + '1']) {
    await assert.rejects(syncOkx(credential, response({ ...valuation(), totalBal: invalid })), /不是有效数值/);
    for (const key of ['funding', 'trading', 'earn', 'classic']) {
      // Undefined classic is omitted by JSON serialization and is an allowed legacy omission.
      if (key === 'classic' && invalid === undefined) continue;
      await assert.rejects(syncOkx(credential, response({ ...valuation(), details: { ...valuation().details, [key]: invalid } })), /不是有效数值/);
    }
  }
});

test('OKX accepts fresh source timestamps and rejects stale, future or malformed timestamps', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const offset of [-900000, -1000, 0, 60000]) {
    const result = await syncOkx(credential, response({ ...valuation(), ts: String(now + offset) }));
    assert.equal(result.updatedAt, new Date(now + offset).toISOString());
  }
  for (const ts of [undefined, null, false, 0, now, '', ' ', 'NaN', 'Infinity', '0', '-1', '0x10', '1e12', String(now) + '.0', ' ' + String(now), String(now - 900001), String(now + 60001), String(Math.floor(now / 1000)), '9'.repeat(16)]) {
    await assert.rejects(syncOkx(credential, response({ ...valuation(), ts })), /估值时间无效或已过期/);
  }
});

test('OKX allowlist blocks write paths, arbitrary hosts and caller-supplied queries before network access', async () => {
  let calls = 0;
  const never = mock(() => { calls++; return {}; });
  for (const path of ['/api/v5/trade/order', '/api/v5/asset/transfer', '/api/v5/asset/withdrawal', '/api/v5/account/balance', 'constructor', 'https://evil.example' + configPath, configPath + '?x=1', valuationPath + '?ccy=USD', valuationPath + '?ccy=BTC', valuationPath + '/../withdrawal', valuationPath + '#x']) {
    await assert.rejects(okxGet(credential, path, never), /只读账户接口/);
  }
  for (const key of ['apiKey', 'apiSecret', 'passphrase']) {
    for (const value of ['', ' ', null, undefined, 1, {}]) await assert.rejects(okxGet({ ...credential, [key]: value } as OkxCredential, configPath, never), /不能为空/);
  }
  assert.equal(calls, 0);
});

test('OKX errors never expose raw response text, request signatures or credentials', async () => {
  const sensitive = Object.values(credential).join(' ') + ' signature=private-signature https://evil.example';
  const safeError = (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const secret of [...Object.values(credential), 'signature=', 'private-signature', 'evil.example']) assert.equal(error.message.includes(secret), false);
    return true;
  };
  for (const code of ['50113', '50011', '0 ', '0\n', sensitive, {}, null, 50113, '-1', '1e3', '9'.repeat(11)]) {
    await assert.rejects(okxGet(credential, configPath, mock(() => ({ code, msg: sensitive, data: [] }))), error => {
      safeError(error);
      assert.match((error as Error).message, typeof code === 'string' && /^\d{1,10}$/.test(code) ? new RegExp('（' + code + '）') : /未知代码/);
      return true;
    });
  }
  for (const fetcher of [
    (async () => { throw new Error(sensitive); }) as typeof fetch,
    (async () => new Response(sensitive, { status: 200 })) as typeof fetch,
    (async () => new Response(sensitive, { status: 401 })) as typeof fetch,
  ]) await assert.rejects(okxGet(credential, configPath, fetcher), safeError);
});

test('OKX refuses redirects without forwarding credentials to another host', async () => {
  let calls = 0;
  const redirect = (async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
  }) as typeof fetch;
  await assert.rejects(okxGet(credential, configPath, redirect), /HTTP 302/);
  assert.equal(calls, 1);
  const followed = (async () => {
    const result = Response.json({ code: '0', data: [{ perm: 'read_only' }] });
    Object.defineProperty(result, 'redirected', { value: true });
    return result;
  }) as typeof fetch;
  await assert.rejects(okxGet(credential, configPath, followed), /读取失败/);
});
