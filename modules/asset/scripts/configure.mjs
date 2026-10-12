import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

/** @param {string} directory @param {{password?: string, reset?: boolean}} [options] */
export function configure(directory, { password, reset = false } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = resolve(directory, 'config.json');
  let previous;
  try { previous = JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !reset) return { created: false };
  password ??= randomBytes(24).toString('base64url');
  if (password.length < 12 || password.length > 256) throw new Error('登录密码必须为 12–256 个字符');
  const salt = randomBytes(16).toString('hex');
  const config = {
    credentialKey: previous?.credentialKey ?? randomBytes(32).toString('hex'),
    sessionSecret: randomBytes(32).toString('hex'),
    passwordHash: salt + ':' + scryptSync(password, salt, 32).toString('hex'),
  };
  if (!previous) writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  else {
    const temporary = filename + '.new';
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, filename);
  }
  return { created: true, password };
}
// Node resolves the deployed `current` symlink before loading this module.
if (import.meta.main) {
  const result = configure(resolve(process.env.ASSET_DATA_DIR || '.data'), { reset: process.argv.includes('--reset-password') });
  if (result.created) console.log('登录密码（请保存）：' + result.password);
  else console.log('已有配置、登录密码及加密密钥已保留。');
}
