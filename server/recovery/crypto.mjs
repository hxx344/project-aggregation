import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function keys(dataKey, secretsKey) {
  if (!Buffer.isBuffer(dataKey) || !Buffer.isBuffer(secretsKey) || dataKey.length !== 32 || secretsKey.length !== 32 || timingSafeEqual(dataKey, secretsKey)) throw new Error('RECOVERY_KEYS_INVALID');
  return { data: dataKey, secrets: secretsKey };
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const mac = (key, body) => createHmac('sha256', key).update('workbench-recovery-v1\0').update(canonical(body)).digest('hex');
export function authenticate(body, dataKey, secretsKey) {
  keys(dataKey, secretsKey);
  return { body, authentication: { data: mac(dataKey, body), secrets: mac(secretsKey, body) } };
}
export function verify(document, dataKey, secretsKey) {
  keys(dataKey, secretsKey);
  if (!document?.body || !document?.authentication) throw new Error('RECOVERY_MANIFEST_INVALID');
  for (const [kind, key] of [['data', dataKey], ['secrets', secretsKey]]) {
    const given = document.authentication[kind];
    if (typeof given !== 'string' || !/^[a-f0-9]{64}$/.test(given) || !timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(mac(key, document.body), 'hex'))) throw new Error('RECOVERY_AUTHENTICATION_FAILED');
  }
  return document.body;
}
export async function fileHash(filename, check = () => {}) {
  const hasher = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename, { signal: check.signal })) { check(); hasher.update(chunk); }
  return hasher.digest('hex');
}
function limiter(check, size, expectedHash) {
  let bytes = 0; const hasher = createHash('sha256');
  return new Transform({ transform(chunk, encoding, callback) { try { check(); bytes += chunk.length; if (bytes > size) throw new Error('RECOVERY_SIZE_MISMATCH'); hasher.update(chunk); callback(null, chunk); } catch (error) { callback(error); } }, flush(callback) { try { check(); if (bytes !== size || (expectedHash && hasher.digest('hex') !== expectedHash)) throw new Error('RECOVERY_HASH_MISMATCH'); callback(); } catch (error) { callback(error); } } });
}
const aad = (checkpointId, entry) => Buffer.from(canonical({ schema: 1, checkpointId, path: entry.path, hash: entry.sha256, size: entry.size, category: entry.category }));
// Envelope is fixed 12-byte nonce, ciphertext, 16-byte GCM tag. No plaintext is stored in the backup.
export async function encryptFile(source, destination, key, checkpointId, entry, check) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(checkpointId, entry));
  const fd = fs.openSync(destination, 'wx', 0o600);
  try { fs.writeSync(fd, iv); await pipeline(fs.createReadStream(source), limiter(check, entry.size, entry.sha256), cipher, fs.createWriteStream(destination, { fd, autoClose: false, start: 12 }), { signal: check.signal }); fs.writeSync(fd, cipher.getAuthTag(), 0, 16, entry.size + 12); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export async function decryptFile(source, destination, key, checkpointId, entry, check) {
  const info = fs.statSync(source);
  if (info.size !== entry.size + 28) throw new Error('RECOVERY_SIZE_MISMATCH');
  const fd = fs.openSync(source, 'r'), iv = Buffer.alloc(12), tag = Buffer.alloc(16);
  try { fs.readSync(fd, iv, 0, 12, 0); fs.readSync(fd, tag, 0, 16, info.size - 16); }
  finally { fs.closeSync(fd); }
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(checkpointId, entry)); decipher.setAuthTag(tag);
  const out = fs.openSync(destination, 'wx', 0o600);
  try { await pipeline(entry.size ? fs.createReadStream(source, { start: 12, end: info.size - 17 }) : Readable.from([]), decipher, limiter(check, entry.size, entry.sha256), fs.createWriteStream(destination, { fd: out, autoClose: false }), { signal: check.signal }); fs.fsyncSync(out); }
  finally { fs.closeSync(out); }
}
