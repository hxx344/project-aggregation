import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { acceptsGzip, createStaticResponder } from '../server/static-response.mjs';

test('public assets negotiate compression, revalidate, honor HEAD and invalidate changed files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-static-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.js'); const source = 'window.example = "test content";\n'.repeat(2000);
  await writeFile(file, source);
  const serve = createStaticResponder();
  async function request(headers = {}, method = 'GET') {
    const result = {};
    await serve({ headers, method }, { writeHead(status, h) { result.status = status; result.headers = h; }, end(body) { result.body = body; } }, file, { 'Content-Type': 'application/javascript' });
    return result;
  }
  const plain = await request(); assert.equal(plain.body.toString(), source);
  const zipped = await request({ 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers.Vary, 'Accept-Encoding'); assert.equal(zipped.headers['Content-Encoding'], 'gzip');
  assert.equal(gunzipSync(zipped.body).toString(), source); assert.ok(zipped.body.length < plain.body.length / 4);
  const head = await request({ 'accept-encoding': 'gzip' }, 'HEAD'); assert.equal(head.body, undefined); assert.equal(head.headers['Content-Length'], zipped.body.length);
  const cached = await request({ 'if-none-match': zipped.headers.ETag }); assert.equal(cached.status, 304); assert.equal(cached.body, undefined);
  assert.equal((await request({ 'accept-encoding': 'gzip;q=0, *;q=1' })).headers['Content-Encoding'], undefined);
  await writeFile(file, 'changed build');
  const next = await request({ 'if-none-match': zipped.headers.ETag }); assert.equal(next.status, 200); assert.equal(next.body.toString(), 'changed build');
});

test('encoding negotiation respects quality and explicit refusal', () => {
  for (const value of ['br, gzip', 'GZIP; q=0.4', '*;q=1']) assert.equal(acceptsGzip(value), true);
  for (const value of ['', 'br', 'gzip;q=0,*;q=1', '*;q=0']) assert.equal(acceptsGzip(value), false);
});
