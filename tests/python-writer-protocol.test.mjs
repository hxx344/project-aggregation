import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createPythonModule } from '../server/modules/python-module.mjs';
import { pythonExecutable } from '../server/modules/greeks.mjs';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const valid = { writerProtectionVersion: 1, recoveryProtectionVersion: 1, ready: true, registeredConnections: 1 };
const start = (status, headers = [['x-fixture-private', 'trusted-parent']]) => createPythonModule({
  root, secret: 'protocol-fixture-secret', executable: pythonExecutable(), application: 'workspace_writer:app', label: 'Writer fixture',
  env: { ...process.env, PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', FIXTURE_WRITER_STATUS: JSON.stringify(status) },
  privateHeaders: headers, requireWriterProtection: true, startupTimeout: 3000, shutdownTimeout: 1000,
});

test('real Python stdio handshake accepts enforced protection including read-only recovery state', async () => {
  for (const ready of [true, false]) {
    const module = await start({ ...valid, ready });
    try { assert.equal(module.writerProtectionVersion, 1); assert.equal(module.recoveryProtectionVersion, 1); assert.equal(module.server.listening, false); }
    finally { await module.close(); }
    assert.ok(module.child.exitCode !== null || module.child.signalCode);
  }
});

test('real Python stdio handshake rejects missing, incompatible and unauthenticated writer enforcement', async () => {
  for (const value of [{}, { ...valid, writerProtectionVersion: null }, { ...valid, writerProtectionVersion: 2 },
    { ...valid, recoveryProtectionVersion: null }, { ...valid, recoveryProtectionVersion: 2 }, { ...valid, ready: 'true' }, { ...valid, registeredConnections: -1 }]) {
    await assert.rejects(start(value), /shared account protection is unavailable/);
  }
  await assert.rejects(start(valid, []), /shared account protection is unavailable/);
});

test('the bridge ignores SIGTERM while its worker lives and refuses an event stream at once', async () => {
  const module = await start(valid);
  try {
    await new Promise(resolve => module.server.listen(0, '127.0.0.1', resolve));
    const get = path => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: module.server.address().port, path, agent: false, headers: { 'x-workspace-key': 'protocol-fixture-secret' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }).on('error', reject));
    // systemd signals the whole unit; the worker, still alive, stops the bridge in its own order.
    module.child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(module.child.exitCode, null);
    assert.equal(module.child.signalCode, null);
    const started = Date.now();
    assert.equal(await get('/fixture-stream'), 502);
    assert.ok(Date.now() - started < 2000, 'refused at once, not at the pending deadline');
    assert.equal(await get('/'), 200);
  } finally { module.server.closeAllConnections(); await new Promise(resolve => module.server.close(resolve)); await module.close(); }
  assert.ok(module.child.exitCode !== null || module.child.signalCode);
});
