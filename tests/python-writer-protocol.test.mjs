import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createPythonModule } from '../server/modules/python-module.mjs';
import { pythonExecutable } from '../server/modules/greeks.mjs';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const valid = { writerProtectionVersion: 1, ready: true, registeredConnections: 1 };
const start = (status, headers = [['x-fixture-private', 'trusted-parent']]) => createPythonModule({
  root, secret: 'protocol-fixture-secret', executable: pythonExecutable(), application: 'workspace_writer:app', label: 'Writer fixture',
  env: { ...process.env, PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', FIXTURE_WRITER_STATUS: JSON.stringify(status) },
  privateHeaders: headers, requireWriterProtection: true, startupTimeout: 3000, shutdownTimeout: 1000,
});

test('real Python stdio handshake accepts enforced protection including read-only recovery state', async () => {
  for (const ready of [true, false]) {
    const module = await start({ ...valid, ready });
    try { assert.equal(module.writerProtectionVersion, 1); assert.equal(module.server.listening, false); }
    finally { await module.close(); }
    assert.ok(module.child.exitCode !== null || module.child.signalCode);
  }
});

test('real Python stdio handshake rejects missing, incompatible and unauthenticated writer enforcement', async () => {
  for (const value of [{}, { ...valid, writerProtectionVersion: null }, { ...valid, writerProtectionVersion: 2 },
    { ...valid, ready: 'true' }, { ...valid, registeredConnections: -1 }]) {
    await assert.rejects(start(value), /shared account protection is unavailable/);
  }
  await assert.rejects(start(valid, []), /shared account protection is unavailable/);
});
