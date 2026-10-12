import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticFetch } from '../src/request-diagnostics.ts';

test('diagnostics return streaming headers without reading or cloning the body', { timeout: 1000 }, async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: hello\n\n')); } }), {
    headers: { 'content-type': 'text/event-stream' },
  });
  response.clone = () => { throw new Error('must not clone'); };
  const logs = [];
  const observed = createDiagnosticFetch(async () => response, log => logs.push(log));
  assert.equal(await observed('/api/stream'), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(logs[0].status, 200);
  assert.equal(logs[0].size, null);
  await response.body.cancel();
});

test('diagnostics forward input and options unchanged and honor an overriding method', async () => {
  const request = new Request('http://localhost/api/check', { method: 'POST' });
  const options = { method: 'PUT', signal: new AbortController().signal };
  const logs = [];
  const response = new Response('hello', { headers: { 'content-length': '5' } });
  const observed = createDiagnosticFetch(async (...args) => {
    assert.equal(args[0], request); assert.equal(args[1], options); return response;
  }, log => logs.push(log));
  assert.equal(await observed(request, options), response);
  assert.equal(await response.text(), 'hello');
  assert.equal(logs[0].method, 'PUT');
  assert.equal(logs[0].url, request.url);
  assert.equal(logs[0].size, 5);
});

test('URL inputs preserve the supplied method; absent or invalid lengths stay unknown', async () => {
  for (const length of [null, '', '-1', 'bad', '9007199254740992', '0']) {
    const logs = [];
    const observed = createDiagnosticFetch(async () => new Response(null, { headers: length === null ? {} : { 'content-length': length } }), log => logs.push(log));
    await observed(new URL('http://localhost/api/check'), { method: 'DELETE' });
    assert.equal(logs[0].method, 'DELETE');
    assert.equal(logs[0].size, length === '0' ? 0 : null);
  }
});

test('network failure identity is preserved and recorded even when aborted', async () => {
  const failure = new DOMException('Stopped', 'AbortError');
  const logs = [];
  const observed = createDiagnosticFetch(async () => { throw failure; }, log => logs.push(log));
  await assert.rejects(observed('/api/check'), error => error === failure);
  assert.equal(logs[0].status, 0);
  assert.equal(logs[0].size, null);
});

test('a failing diagnostic sink never changes a successful response or original error', async () => {
  const sink = () => { throw new Error('diagnostic rendering failed'); };
  const response = new Response('ok');
  assert.equal(await createDiagnosticFetch(async () => response, sink)('/api/check'), response);
  const failure = new Error('offline');
  await assert.rejects(createDiagnosticFetch(async () => { throw failure; }, sink)('/api/check'), error => error === failure);
});
