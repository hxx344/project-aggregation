import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The credential key lives with the runtime: only the data plane encrypts and
// decrypts account credentials (design doc 5.1). A missing key next to an
// existing database is refused, because rows encrypted with it would be lost.
export function loadCredentialCipher(dataDir, log) {
  const keyPath = path.join(dataDir, 'credentials.key');
  if (!existsSync(keyPath)) {
    if (existsSync(path.join(dataDir, 'hub.sqlite'))) throw new Error('凭据密钥文件缺失，请恢复 credentials.key 后再启动');
    log.info({ type: 'security' }, '生成新的凭据加密密钥');
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('凭据密钥文件长度不正确');
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); };
  const decrypt = value => { if (!value) return null; const buffer = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); cipher.setAuthTag(buffer.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString()); };
  return { encrypt, decrypt };
}
