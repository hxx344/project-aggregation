import fs from 'node:fs';
import path from 'node:path';
import { canonical, fileHash, hash, verify } from './crypto.mjs';
import { budget, safePath, uniqueEntryPaths } from './inventory.mjs';

/** Authentication and ciphertext integrity only; never decrypts, restores or admits. */
export async function verifyArchive({ backupDir, dataKey, secretsKey, ...options }) {
  const root = safePath(backupDir, { directory: true });
  const filename = safePath(path.join(root, 'manifest.json'));
  if (fs.statSync(filename).size > 8 * 1024 * 1024) throw new Error('RECOVERY_MANIFEST_INVALID');
  const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const body = verify(document, dataKey, secretsKey), limits = budget(options);
  if (body.schemaVersion !== 1 || body.protocol !== 'cold-checkpoint-v1' || !['backup', 'handoff'].includes(body.kind) ||
      !/^[a-f0-9-]{36}$/.test(body.checkpointId ?? '') || !/^[a-f0-9]{7,64}$/i.test(body.commit ?? '') ||
      typeof body.completedAt !== 'string' || body.completedAt.length > 32 || !Number.isFinite(Date.parse(body.completedAt)) || !Array.isArray(body.entries) || body.entries.length > limits.maxFiles) throw new Error('RECOVERY_MANIFEST_INVALID');
  uniqueEntryPaths(body.entries);
  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i];
    if (!['data', 'secrets'].includes(entry.category) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.payloadSha256 ?? '')) throw new Error('RECOVERY_MANIFEST_INVALID');
    limits.add(entry.size);
    const payload = safePath(path.join(root, entry.category, i + '.gcm'));
    if (fs.statSync(payload).size !== entry.size + 28 || await fileHash(payload, limits.check) !== entry.payloadSha256) throw new Error('RECOVERY_HASH_MISMATCH');
  }
  limits.check();
  return { schemaVersion: 1, checkpointId: body.checkpointId, digest: hash(canonical(document)), commit: body.commit,
    completedAt: body.completedAt, kind: body.kind, files: body.entries.length, bytes: body.entries.reduce((sum, entry) => sum + entry.size, 0),
    archiveVerification: 'authenticated-ciphertext', verifiedAt: new Date().toISOString(),
    unresolvedDependencyCount: Array.isArray(body.unresolvedDependencies) ? body.unresolvedDependencies.length : null };
}
