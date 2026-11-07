import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createOkxTradingClient } from '../server/trading-okx-readonly.mjs';
import { TradingExchangeError } from '../server/trading-exchanges.mjs';
import { formatTradingDiagnostic } from '../server/trading-diagnostics.mjs';
import { createTrading } from '../server/trading.mjs';

const NOW = Date.parse('2026-11-07T09:00:00Z'), DAY = 86_400_000;
const credentials = Object.freeze({ apiKey: 'fixture-okx-key', apiSecret: 'fixture-okx-secret', passphrase: 'fixture-okx-passphrase' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (code, status = 200, headers = {}) => new Response(JSON.stringify({ code, msg: 'fixture-private-upstream-text' }), { status, headers });
function harness({ handler = () => undefined, wait, timeoutMs = 1000 } = {}) {
  const calls = [], waits = [], state = { now: NOW, perm: 'read_only', held: true };
  const client = createOkxTradingClient({ ErrorClass: TradingExchangeError, now: () => state.now, timeoutMs,
    waitImpl: async (ms, signal) => { waits.push(ms); if (wait) await wait(ms, signal); else state.now += ms; },
    fetchImpl: async (url, init) => {
      const parsed = new URL(url), call = { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), init }; calls.push(call);
      let data = await handler(call, state);
      if (data instanceof Response) return data;
      if (data === undefined) {
        if (call.path.endsWith('/config')) data = [{ uid: '12345', acctLv: '2', posMode: 'net_mode', perm: state.perm }];
        else if (call.path.endsWith('/instruments')) data = [{ instId: call.params.instId, instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT',
          ctValCcy: call.params.instId.split('-')[0], state: 'live', ctVal: '1', ctMult: '1', tickSz: '0.01', lotSz: '1', minSz: '1', maxLmtSz: '100000', maxMktSz: '10000' }];
        else if (call.path.endsWith('/positions')) data = state.held && call.params.instId === 'ANTHROPIC-USDT-SWAP' ? [{ instId: call.params.instId, instType: 'SWAP', posSide: 'net', mgnMode: 'cross', pos: '2', ccy: 'USDT', markPx: '80', avgPx: '79', upl: '2', lever: '3', liqPx: '60', uTime: String(state.now) }] : [];
        else if (call.path.endsWith('/bills-archive')) data = [];
        else throw new Error('Unexpected fixture route');
      }
      return new Response(JSON.stringify({ code: '0', data }));
    },
  });
  return { client, calls, waits, state, configs: () => calls.filter(call => call.path.endsWith('/config')) };
}
const parallelReads = h => Promise.all([
  h.client.positions({ ...credentials }), h.client.hynixPositions({ ...credentials }), h.client.anthropicPositions({ ...credentials }),
  h.client.funding({ ...credentials }, { start: h.state.now - DAY, end: h.state.now }),
]);

test('OKX concurrent read-only paths share only an in-flight permission check', async () => {
  const h = harness();
  await parallelReads(h);
  assert.equal(h.configs().length, 1);
  h.state.perm = 'read_only,trade';
  const before = h.calls.length;
  await assert.rejects(h.client.anthropicPositions(credentials), { code: 'permissions' });
  assert.equal(h.configs().length, 2, 'completed permissions are never cached');
  assert.equal(h.calls.length, before + 1, 'a changed permission cannot authorize positions');
});

test('OKX permission sharing binds every credential field', async () => {
  for (const field of ['apiKey', 'apiSecret', 'passphrase']) {
    const h = harness();
    await Promise.all([h.client.positions(credentials), h.client.positions({ ...credentials, [field]: credentials[field] + '-changed' })]);
    assert.equal(h.configs().length, 2, field);
  }
});

test('OKX cancelling one permission subscriber leaves the other read alive', async () => {
  const gate = deferred(), a = new AbortController(), b = new AbortController();
  const h = harness({ handler: async call => { if (call.path.endsWith('/config')) await gate.promise; } });
  const first = h.client.positions(credentials, { signal: a.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  const second = h.client.anthropicPositions(credentials, { signal: b.signal });
  await nextTurn();
  a.abort(); await cancelled;
  assert.equal(h.configs().length, 1);
  assert.equal(h.configs()[0].init.signal.aborted, false);
  gate.resolve();
  assert.equal((await second).positions.length, 1);
});

test('OKX cancelling all subscribers removes the old flight without removing its replacement', async () => {
  const gate = deferred(), a = new AbortController(), b = new AbortController();
  const h = harness({ handler: async call => { if (call.path.endsWith('/config')) await gate.promise; } });
  const first = assert.rejects(h.client.positions(credentials, { signal: a.signal }), { name: 'AbortError' });
  const second = assert.rejects(h.client.hynixPositions(credentials, { signal: b.signal }), { name: 'AbortError' });
  await nextTurn(); a.abort(); b.abort();
  const replacement = h.client.anthropicPositions(credentials);
  await Promise.all([first, second]); await nextTurn();
  const follower = h.client.positions(credentials);
  assert.equal(h.configs()[0].init.signal.aborted, true);
  gate.resolve(); await Promise.all([replacement, follower]);
  assert.equal(h.configs().length, 2);
});

test('OKX configuration rate limits retry once inside the shared flight with a new signature', async () => {
  for (const status of [200, 429]) {
    let attempts = 0;
    const h = harness({ handler: call => call.path.endsWith('/config') && ++attempts === 1 ? response('50011', status) : undefined });
    await parallelReads(h);
    assert.equal(h.configs().length, 2);
    assert.equal(h.waits.filter(ms => ms >= 2100).length, 1);
    const [a, b] = h.configs().map(call => call.init.headers);
    assert.notEqual(a['OK-ACCESS-TIMESTAMP'], b['OK-ACCESS-TIMESTAMP']);
    assert.notEqual(a['OK-ACCESS-SIGN'], b['OK-ACCESS-SIGN']);
  }
});

test('OKX persistent configuration limits fail after two requests and never read positions', async () => {
  const h = harness({ handler: call => call.path.endsWith('/config') ? response('50011', 429) : undefined });
  await assert.rejects(h.client.anthropicPositions(credentials), error => {
    assert.match(formatTradingDiagnostic(error.diagnostic), /请求频率受限/);
    assert.doesNotMatch(formatTradingDiagnostic(error.diagnostic), /权限|白名单|fixture/);
    return true;
  });
  assert.equal(h.calls.length, 2); assert.deepEqual(h.waits, [2100]);
});

test('OKX Retry-After survives repeated reads without shortening the server deadline', async () => {
  for (const header of ['60', new Date(NOW + 60_000).toUTCString()]) {
    let limited = true;
    const h = harness({ handler: call => call.path.endsWith('/config') && limited ? response('50011', 429, { 'retry-after': header }) : undefined });
    await assert.rejects(h.client.positions(credentials));
    await assert.rejects(h.client.anthropicPositions(credentials));
    assert.equal(h.configs().length, 1); assert.deepEqual(h.waits, []);
    h.state.now += 59_999;
    limited = false;
    await h.client.positions(credentials);
    assert.equal(h.configs().length, 2);
    assert.equal(h.state.now, NOW + 60_000);
  }
});

test('OKX abort during rate-limit waiting prevents retry and permits a later fresh read', async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  let limited = true;
  const h = harness({ handler: call => call.path.endsWith('/config') && limited ? response('50011', 429) : undefined,
    wait: async () => { entered.resolve(); await release.promise; } });
  const pending = assert.rejects(h.client.positions(credentials, { signal: controller.signal }), { name: 'AbortError' });
  await entered.promise; controller.abort(); await pending;
  h.state.now += 2100; limited = false;
  const fresh = h.client.anthropicPositions(credentials);
  release.resolve(); await fresh; await nextTurn();
  assert.equal(h.configs().length, 2);
});

test('OKX malformed and overflowing Retry-After values cannot permanently block the client', async () => {
  for (const header of ['not-a-date', '9'.repeat(400), '9007199254740']) {
    let limited = true;
    const h = harness({ handler: call => call.path.endsWith('/config') && limited ? response('50011', 429, { 'retry-after': header }) : undefined });
    await assert.rejects(h.client.positions(credentials));
    await assert.rejects(h.client.anthropicPositions(credentials));
    assert.equal(h.configs().length, 1); assert.deepEqual(h.waits, []);
    h.state.now += 60_000; limited = false;
    await h.client.anthropicPositions(credentials);
    assert.equal(h.configs().length, 2);
  }
});

test('OKX HTTP 429 takes precedence over a timestamp code without bypassing Retry-After', async () => {
  let limited = true;
  const h = harness({ handler: call => call.path.endsWith('/config') && limited ? response('50102', 429, { 'retry-after': '60' }) : undefined });
  await assert.rejects(h.client.positions(credentials), error => error.diagnostic.httpStatus === 429);
  await assert.rejects(h.client.anthropicPositions(credentials));
  assert.deepEqual(h.calls.map(call => call.path), ['/api/v5/account/config']);
  assert.deepEqual(h.waits, []);
  h.state.now += 60_000; limited = false;
  await h.client.anthropicPositions(credentials);
  assert.equal(h.configs().length, 2);
  assert.equal(h.calls.some(call => call.path.endsWith('/time')), false);
});

test('OKX non-JSON HTTP 429 remains a bounded, sanitized rate-limit failure', async () => {
  const h = harness({ handler: call => call.path.endsWith('/config') ? new Response('<html>fixture-private-upstream-text</html>', { status: 429 }) : undefined });
  await assert.rejects(h.client.positions(credentials), error => {
    assert.equal(error.diagnostic.httpStatus, 429);
    const message = formatTradingDiagnostic(error.diagnostic);
    assert.match(message, /请求频率受限/); assert.doesNotMatch(message, /fixture|权限/);
    return true;
  });
  assert.equal(h.calls.length, 2); assert.deepEqual(h.waits, [2100]);
});

test('OKX authentication failures are not retried and old stored rate-limit diagnostics are corrected', async () => {
  const h = harness({ handler: call => call.path.endsWith('/config') ? response('50113', 401) : undefined });
  await assert.rejects(h.client.positions(credentials), error => error.diagnostic.providerCode === 50113);
  assert.equal(h.configs().length, 1); assert.deepEqual(h.waits, []);
  for (const [httpStatus, providerCode] of [[429, 50011], [200, 50011], [429, undefined]]) {
    const text = formatTradingDiagnostic({ version: 1, exchange: 'okx', accountMode: 'unified', operation: 'permissions', code: 'api', httpStatus, providerCode });
    assert.match(text, /请求频率受限/); assert.doesNotMatch(text, /权限|白名单/);
  }
});

test('OKX real trading refresh retains stale Anthropic positions on limits and clears the error after recovery', async t => {
  let limited = false;
  const h = harness({ handler: call => call.path.endsWith('/config') && limited ? response('50011', 429) : undefined });
  const db = new DatabaseSync(':memory:');
  const trading = createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, intervalMs: 0, now: () => h.state.now,
    clientFactory: exchange => exchange === 'okx' ? h.client : {}, logger: { error() {} } });
  t.after(async () => { await trading.close(); db.close(); });
  await trading.connect('okx', { revision: 0, ...credentials });
  await trading.refresh();
  const snapshot = () => trading.anthropic().find(row => row.exchange === 'okx');
  const before = snapshot();
  limited = true; h.state.now += 30_000;
  await trading.refresh();
  const failed = snapshot();
  assert.equal(failed.state, 'stale'); assert.equal(failed.fetchedAt, before.fetchedAt);
  assert.deepEqual(failed.positions, before.positions); assert.match(failed.error, /请求频率受限/);
  limited = false; h.state.now += 30_000;
  await trading.refresh();
  const recovered = snapshot();
  assert.equal(recovered.state, 'live'); assert.equal(recovered.error, null);
  assert.notEqual(recovered.fetchedAt, before.fetchedAt);
});
