import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { authenticate, encryptFile, fileHash, hash } from '../server/recovery/crypto.mjs';
import { verifyArchive } from '../server/recovery/archive.mjs';
import { runRecoveryCli } from '../server/recovery/cli.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-readonly-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDir = path.join(root, 'backup'); fs.mkdirSync(backupDir, { mode: 0o700 }); fs.mkdirSync(path.join(backupDir, 'data'), { mode: 0o700 });
  const dataKey = randomBytes(32), secretsKey = randomBytes(32), checkpointId = '12345678-1234-1234-1234-123456789012';
  const plain = path.join(root, 'plain'); fs.writeFileSync(plain, 'fixture', { mode: 0o600 });
  const entry = { path: 'hub.sqlite', category: 'data', size: 7, sha256: hash('fixture') };
  const payload = path.join(backupDir, 'data/0.gcm');
  await encryptFile(plain, payload, dataKey, checkpointId, entry, () => {});
  entry.payloadSha256 = await fileHash(payload);
  const body = { schemaVersion: 1, protocol: 'cold-checkpoint-v1', kind: 'backup', checkpointId, commit: 'a'.repeat(40), completedAt: '2026-11-10T01:00:00Z', entries: [entry], unresolvedDependencies: [] };
  const write = () => fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(authenticate(body, dataKey, secretsKey)), { mode: 0o600 });
  write();
  return { root, backupDir, dataKey, secretsKey, body, write, payload };
}

test('read-only archive verifier authenticates both keys without touching source or producing a restore', async t => {
  const f = await fixture(t), before = fs.readdirSync(f.root);
  const result = await verifyArchive(f);
  assert.equal(result.archiveVerification, 'authenticated-ciphertext');
  assert.equal(result.commit, 'a'.repeat(40));
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.restorable, undefined);
  assert.equal(result.sourceAuthorityId, undefined);
  assert.deepEqual(fs.readdirSync(f.root), before);
  await assert.rejects(verifyArchive({ ...f, secretsKey: randomBytes(32) }), /AUTHENTICATION_FAILED/);
});

test('hash corruption, size mismatch, unsafe path and byte limit refuse with no writes', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyArchive({ ...f, maxBytes: 1 }), /LIMIT_EXCEEDED/);
  f.body.entries[0].path = '../unsafe'; f.write();
  await assert.rejects(verifyArchive(f), /UNSAFE_PATH/);
  f.body.entries[0].path = 'hub.sqlite'; f.write();
  const bytes = fs.readFileSync(f.payload); bytes[15] ^= 1; fs.writeFileSync(f.payload, bytes);
  await assert.rejects(verifyArchive(f), /HASH_MISMATCH/);
});

test('CLI verify-archive uses only backup and two keys, never source locks or release identity', async t => {
  const f = await fixture(t), first = path.join(f.root, 'data.key'), second = path.join(f.root, 'secrets.key');
  fs.writeFileSync(first, f.dataKey, { mode: 0o600 }); fs.writeFileSync(second, f.secretsKey, { mode: 0o600 });
  const result = await runRecoveryCli(['verify-archive', '--backup-dir', f.backupDir, '--data-key-file', first, '--secrets-key-file', second]);
  assert.equal(result.checkpointId, f.body.checkpointId);
  assert.equal(fs.existsSync(path.join(f.backupDir, '.runtime.lock')), false);
});
