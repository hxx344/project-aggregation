import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn, SpawnOptions } from 'node:child_process';
import { isAbsolute, basename } from 'node:path';
import { diagnoseVariationalPython } from '../lib/variational-python-diagnostics.ts';
import { readVariationalPythonBalance, readVariationalPythonPositions, runVariationalPython } from '../lib/variational-python-client.ts';

const credential = { vrToken: 'synthetic.python.input' };
const privateText = 'PRIVATE_HELPER_TEXT ' + credential.vrToken;
const success = {
  endpoint: 'session', path: '/api/me', status: 200, contentType: 'json',
  challenge: false, elapsedMs: 12, structureOk: true, outcome: 'ok',
};
const portfolioSuccess = { ...success, endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' };
type Run = Awaited<ReturnType<typeof runVariationalPython>>;
const single = (c: typeof credential, signal?: AbortSignal, launch?: typeof spawn) => runVariationalPython(c, 'diagnose-session', signal, launch);

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = null;
  exitCode: number | null = null;
  input = '';
  signals: Array<NodeJS.Signals | number> = [];
  autoClose = true;
  closed = false;

  constructor() {
    super();
    this.stdin.on('data', data => { this.input += data.toString(); });
  }
  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signals.push(signal);
    if (this.autoClose) queueMicrotask(() => this.finish(null));
    return true;
  }
  finish(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true; this.exitCode = code;
    this.stdout.end(); this.emit('close', code);
  }
}

function childFixture(action?: (child: FakeChild) => void) {
  const child = new FakeChild();
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const launch = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    child.stdin.once('finish', () => queueMicrotask(() => action?.(child)));
    return child;
  }) as unknown as typeof spawn;
  return { child, launch, calls };
}

function safe(report: Run, outcome: string, endpoint: 'session' | 'portfolio' = 'session') {
  assert.deepEqual(Object.keys(report).sort(), ['balance', 'result']);
  assert.equal(report.balance, null, 'Diagnostics and failures cannot carry asset values');
  const result = report.result;
  assert.deepEqual(Object.keys(result).sort(), ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk']);
  assert.equal(result.endpoint, endpoint); assert.equal(result.path, endpoint === 'session' ? '/api/me' : '/api/portfolio?compute_margin=true');
  assert.equal(result.outcome, outcome);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  for (const secret of [credential.vrToken, privateText, 'PRIVATE_ENV_VALUE', 'PRIVATE_RESPONSE_VALUE']) {
    assert.equal(JSON.stringify(report).includes(secret), false, 'Only safe metadata may leave the subprocess boundary');
  }
  return result;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('Python positions use the fixed independent operation and reject unvalidated or leaking subprocess fields', async () => {
  const item = { id: 'a'.repeat(64), symbol: 'BTC', instrumentId: 'b'.repeat(64), side: 'long', quantity: '1.000000000000000001',
    quantityUnit: 'BTC', contractSize: '1', entryPrice: '90000', markPrice: '91000', notional: '91000', unrealizedPnl: '-0.1',
    leverage: null, liquidationPrice: null, priceCurrency: 'USDC', notionalCurrency: 'USDC', pnlCurrency: 'USDC', marginMode: null, sourceUpdatedAt: null };
  const response = { ...portfolioSuccess, path: '/api/positions', positions: [item] };
  const fixture = childFixture(child => { child.stdout.write(JSON.stringify(response)); child.finish(); });
  assert.deepEqual(await readVariationalPythonPositions(credential, undefined, fixture.launch), [item]);
  assert.deepEqual(JSON.parse(fixture.child.input), { vrToken: credential.vrToken, operation: 'sync-positions' });
  assert.ok(!JSON.stringify(fixture.calls).includes(credential.vrToken));
  for (const bad of [
    { ...response, path: '/api/portfolio?compute_margin=true' }, { ...response, positions: null },
    { ...response, positions: [item, item] }, { ...response, positions: [{ ...item, quantity: '0' }] },
    { ...response, positions: [{ ...item, quantity: 1 }] }, { ...response, positions: [{ ...item, token: credential.vrToken }] },
    { ...response, outcome: 'invalid_data', structureOk: false },
  ]) {
    const failing = childFixture(child => { child.stdout.write(JSON.stringify(bad)); child.finish(); });
    await assert.rejects(readVariationalPythonPositions(credential, undefined, failing.launch), error => error instanceof Error && !error.message.includes(credential.vrToken));
  }
  const empty = childFixture(child => { child.stdout.write(JSON.stringify({ ...response, positions: [] })); child.finish(); });
  assert.deepEqual(await readVariationalPythonPositions(credential, undefined, empty.launch), []);
});

test('Python diagnostics use the fixed isolated helper and stdin, never argv or inherited app secrets', async t => {
  const saved = process.env.ASSET_PYTHON_TEST_SECRET;
  process.env.ASSET_PYTHON_TEST_SECRET = 'PRIVATE_ENV_VALUE';
  t.after(() => { if (saved === undefined) delete process.env.ASSET_PYTHON_TEST_SECRET; else process.env.ASSET_PYTHON_TEST_SECRET = saved; });
  const fixture = childFixture(child => {
    const output = JSON.stringify(success) + '\n';
    child.stdout.write(output.slice(0, 20)); child.stdout.write(output.slice(20)); child.finish();
  });
  const report = await single(credential, undefined, fixture.launch);
  assert.deepEqual(safe(report, 'ok'), success);
  assert.equal(fixture.calls.length, 1);
  const { command, args, options } = fixture.calls[0];
  assert.equal(command, process.platform === 'win32' ? 'python' : 'python3');
  assert.deepEqual(args.slice(0, 2), ['-I', '-B']); assert.equal(args.length, 3);
  assert.ok(isAbsolute(args[2])); assert.equal(basename(args[2]), 'variational-diagnostic.py');
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.ok(Object.keys(options.env ?? {}).every(key => ['NODE_ENV', 'PATH', 'SystemRoot', 'WINDIR'].includes(key)));
  assert.equal(JSON.stringify(fixture.calls).includes(credential.vrToken), false);
  assert.equal(JSON.stringify(fixture.calls).includes('PRIVATE_ENV_VALUE'), false);
  assert.deepEqual(JSON.parse(fixture.child.input), { ...credential, operation: 'diagnose-session' });
  assert.deepEqual(fixture.child.signals, []);
});

test('Python safe response classifications survive the strict subprocess projection', async () => {
  for (const [outcome, status, contentType, challenge, structureOk] of [
    ['challenge', 403, 'html', true, null], ['unauthorized', 401, 'json', false, null],
    ['forbidden', 403, 'json', false, null], ['redirect', 302, 'html', false, null],
    ['timeout', null, null, false, null], ['network_error', null, null, false, null],
    ['invalid_data', 200, 'json', false, false],
  ] as const) {
    const value = { ...success, outcome, status, contentType, challenge, structureOk };
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(value)); child.finish(); });
    assert.deepEqual(safe(await single(credential, undefined, fixture.launch), outcome), value);
  }
});

test('malformed, extra, secret-bearing or wrong-shape helper output is rejected', async () => {
  const bad = [
    '', privateText, JSON.stringify(success) + '\n' + JSON.stringify(success), 'null', '[]',
    JSON.stringify({ ...success, token: credential.vrToken }),
    JSON.stringify({ ...success, balance: 'PRIVATE_RESPONSE_VALUE' }),
    JSON.stringify({ ...success, endpoint: 'portfolio' }),
    JSON.stringify({ ...success, path: 'https://untrusted.example/' }),
    JSON.stringify({ ...success, outcome: privateText }),
    JSON.stringify({ ...success, status: 700 }), JSON.stringify({ ...success, status: 200.5 }),
    JSON.stringify({ ...success, contentType: privateText }), JSON.stringify({ ...success, challenge: 'true' }),
    JSON.stringify({ ...success, structureOk: 'true' }), JSON.stringify({ ...success, elapsedMs: -1 }),
    JSON.stringify({ ...success, elapsedMs: 24_001 }), JSON.stringify({ ...success, elapsedMs: null }),
  ];
  for (const output of bad) {
    const fixture = childFixture(child => { child.stdout.write(output); child.finish(); });
    safe(await single(credential, undefined, fixture.launch), 'client_error');
  }
});

test('nonzero helper exit cannot turn otherwise valid stdout into success', async () => {
  for (const code of [1, 2, null]) {
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(success)); child.finish(code); });
    safe(await single(credential, undefined, fixture.launch), 'client_error');
  }
});

test('helper stdout is bounded to 8192 bytes and overflow terminates the child', async () => {
  const exact = JSON.stringify(success).padEnd(8192, ' ');
  const good = childFixture(child => { child.stdout.write(exact); child.finish(); });
  safe(await single(credential, undefined, good.launch), 'ok');
  const oversized = childFixture(child => { child.stdout.write(exact); child.stdout.write('x'); });
  safe(await single(credential, undefined, oversized.launch), 'client_error');
  assert.deepEqual(oversized.child.signals, ['SIGTERM']);
});

test('spawn errors are classified without returning executable paths or raw error messages', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const fixture = childFixture();
    const pending = single(credential, undefined, fixture.launch);
    fixture.child.emit('error', Object.assign(new Error(privateText), { code }));
    fixture.child.finish(-1);
    safe(await pending, code === 'ENOENT' ? 'client_unavailable' : 'client_error');
    const launch = (() => { throw Object.assign(new Error(privateText), { code }); }) as typeof spawn;
    safe(await single(credential, undefined, launch), code === 'ENOENT' ? 'client_unavailable' : 'client_error');
  }
});

test('stdin failure kills the helper and returns a safe client error', async () => {
  const fixture = childFixture();
  const pending = single(credential, undefined, fixture.launch);
  fixture.child.stdin.emit('error', new Error(privateText));
  safe(await pending, 'client_error');
  assert.deepEqual(fixture.child.signals, ['SIGTERM']);
});

test('the hard deadline escalates to SIGKILL and settles only after child close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = childFixture(); fixture.child.autoClose = false;
  let settled = false;
  const pending = single(credential, undefined, fixture.launch).then(report => { settled = true; return report; });
  t.mock.timers.tick(22_999); await flush();
  assert.deepEqual(fixture.child.signals, []);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM']); assert.equal(settled, false);
  t.mock.timers.tick(249); assert.deepEqual(fixture.child.signals, ['SIGTERM']);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  fixture.child.finish(null);
  safe(await pending, 'timeout');
});

test('caller cancellation waits for close and cannot be replaced by late stdout', async () => {
  const controller = new AbortController();
  const fixture = childFixture(); fixture.child.autoClose = false;
  let settled = false;
  const pending = single(credential, controller.signal, fixture.launch).then(report => { settled = true; return report; });
  controller.abort(new Error(privateText)); await flush();
  assert.deepEqual(fixture.child.signals, ['SIGTERM']); assert.equal(settled, false);
  fixture.child.stdout.write(JSON.stringify(success)); fixture.child.finish();
  safe(await pending, 'cancelled');
});

test('already cancelled or invalid input cannot start a Python process', async () => {
  let calls = 0;
  const launch = (() => { calls++; assert.fail('No subprocess should be started'); }) as typeof spawn;
  const controller = new AbortController(); controller.abort(new Error(privateText));
  safe(await single(credential, controller.signal, launch), 'cancelled');
  for (const vrToken of ['', 'abc', 'a; other=secret', 'a\r\nb', 'vr-token=abcdef', 'Bearer abcdef', '令牌token', 'a'.repeat(4097)]) {
    await assert.rejects(single({ vrToken }, undefined, launch), /Var /);
  }
  assert.equal(calls, 0);
});

test('portfolio diagnostics use a distinct fixed operation and never return balance', async () => {
  const fixture = childFixture(child => { child.stdout.write(JSON.stringify(portfolioSuccess)); child.finish(); });
  assert.deepEqual(safe(await runVariationalPython(credential, 'diagnose-portfolio', undefined, fixture.launch), 'ok', 'portfolio'), portfolioSuccess);
  assert.deepEqual(JSON.parse(fixture.child.input), { ...credential, operation: 'diagnose-portfolio' });
  for (const value of [success, { ...portfolioSuccess, balance: '125' }, { ...portfolioSuccess, path: '/api/me' }]) {
    const bad = childFixture(child => { child.stdout.write(JSON.stringify(value)); child.finish(); });
    safe(await runVariationalPython(credential, 'diagnose-portfolio', undefined, bad.launch), 'client_error', 'portfolio');
  }
});

test('Python diagnostics start both independent requests before either finishes and keep endpoint order', async () => {
  const children: FakeChild[] = [];
  const launch = (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  const pending = diagnoseVariationalPython(credential, undefined, launch);
  assert.equal(children.length, 2, 'Both probes must start without waiting for the other response');
  assert.deepEqual(children.map(child => JSON.parse(child.input)), [
    { ...credential, operation: 'diagnose-session' }, { ...credential, operation: 'diagnose-portfolio' },
  ]);
  const challenge = { ...success, status: 403, contentType: 'html', challenge: true, structureOk: null, outcome: 'challenge' };
  children[1].stdout.write(JSON.stringify(portfolioSuccess)); children[1].finish();
  children[0].stdout.write(JSON.stringify(challenge)); children[0].finish();
  const report = await pending;
  assert.deepEqual(Object.keys(report).sort(), ['checkedAt', 'client', 'results']);
  assert.equal(report.client, 'grid-python');
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  assert.deepEqual(report.results, [challenge, portfolioSuccess]);
  for (const result of report.results) assert.deepEqual(Object.keys(result).sort(), ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk']);
  assert.equal(JSON.stringify(report).includes(credential.vrToken), false);
});

test('cancelling the comparison closes both Python children and retains two safe results', async () => {
  const children: FakeChild[] = [];
  const launch = (() => {
    const child = new FakeChild(); children.push(child); return child;
  }) as unknown as typeof spawn;
  const controller = new AbortController();
  const pending = diagnoseVariationalPython(credential, controller.signal, launch);
  assert.equal(children.length, 2);
  controller.abort(new Error(privateText));
  const report = await pending;
  assert.deepEqual(report.results.map(result => [result.endpoint, result.outcome]), [['session', 'cancelled'], ['portfolio', 'cancelled']]);
  for (const child of children) { assert.equal(child.closed, true); assert.deepEqual(child.signals, ['SIGTERM']); }
  assert.equal(JSON.stringify(report).includes(privateText), false);
});

test('the formal Python reader returns only valid balance and sends the sync operation through stdin', async () => {
  for (const balance of [0, -50, 125, '0', '-0.000', '-50.25', '125.75']) {
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify({ ...portfolioSuccess, balance })); child.finish(); });
    assert.equal(await readVariationalPythonBalance(credential, undefined, fixture.launch), balance);
    assert.deepEqual(JSON.parse(fixture.child.input), { ...credential, operation: 'sync-portfolio' });
    assert.equal(fixture.calls.length, 1);
    assert.equal(JSON.stringify(fixture.calls).includes(credential.vrToken), false);
  }
});

test('the formal Python reader rejects malformed balances and extra account fields without leaking them', async () => {
  const bad = [
    portfolioSuccess, { ...success, balance: '1' },
    ...[null, false, '', ' ', '1e9', '123junk', 'NaN', 'Infinity', '9'.repeat(309), '0.' + '0'.repeat(400) + '1', {}, []].map(balance => ({ ...portfolioSuccess, balance })),
    { ...portfolioSuccess, balance: '1', token: credential.vrToken },
    { ...portfolioSuccess, balance: '1', account: 'PRIVATE_RESPONSE_VALUE' },
  ];
  for (const value of bad) {
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(value)); child.finish(); });
    await assert.rejects(readVariationalPythonBalance(credential, undefined, fixture.launch), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /^Var /);
      assert.doesNotMatch(error.message, /PRIVATE_RESPONSE_VALUE|synthetic\.python\.input/);
      return true;
    });
  }
});

test('formal Python failures retain safe HTTP and challenge diagnoses without exposing subprocess output', async () => {
  for (const [outcome, status, contentType, challenge, expected] of [
    ['challenge', 403, 'html', true, /Cloudflare/],
    ['unauthorized', 401, 'json', false, /HTTP 401/],
    ['forbidden', 403, 'json', false, /HTTP 403/],
    ['rate_limited', 429, 'json', false, /频繁|受限/],
    ['html', 200, 'html', false, /网页/],
    ['timeout', null, null, false, /超时/],
    ['network_error', null, null, false, /^Var /],
    ['redirect', 302, 'html', false, /^Var /],
    ['invalid_data', 200, 'json', false, /无效|不完整/],
  ] as const) {
    const value = { ...portfolioSuccess, outcome, status, contentType, challenge, structureOk: outcome === 'invalid_data' ? false : null, balance: null };
    const fixture = childFixture(child => { child.stdout.write(JSON.stringify(value)); child.finish(); });
    await assert.rejects(readVariationalPythonBalance(credential, undefined, fixture.launch), error => {
      assert.ok(error instanceof Error); assert.match(error.message, expected); assert.match(error.message, /^Var /);
      assert.doesNotMatch(error.message, /PRIVATE_|synthetic\.python\.input/);
      return true;
    });
  }
  for (const code of ['ENOENT', 'EACCES']) {
    const launch = (() => { throw Object.assign(new Error(privateText), { code }); }) as typeof spawn;
    await assert.rejects(readVariationalPythonBalance(credential, undefined, launch), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /^Var /);
      assert.doesNotMatch(error.message, /PRIVATE_|synthetic\.python\.input/);
      return true;
    });
  }
});
