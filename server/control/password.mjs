import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { immediate } from './schema.mjs';

const scrypt = promisify(scryptCallback);

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}
export async function passwordMatches(password, record) {
  const [salt, expected] = record.split(':');
  const derived = await scrypt(password, salt, 64);
  return timingSafeEqual(derived, Buffer.from(expected, 'hex'));
}

// Only the process that owns logins generates the first password and writes it to its log.
export async function ensurePassword(store, { initialPassword, log }) {
  if (store.getSetting('password')) return;
  const password = initialPassword || randomBytes(18).toString('base64url');
  if (password.length < 12 || password.length > 1024) throw new Error('INITIAL_PASSWORD 必须为 12 至 1024 个字符');
  store.stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('password', await passwordRecord(password));
  if (!initialPassword) log.info({ type: 'security' }, `工作台初始登录密码：${password}\n请保存此密码；只在首次启动显示。重置请运行 node server/setup.mjs --reset-password`);
}

// Replaces the password and revokes every session; callers close their open streams afterwards.
export async function resetPassword(store) {
  const password = randomBytes(18).toString('base64url');
  const record = await passwordRecord(password);
  immediate(store.db, () => { store.setSetting('password', record); store.sessions.clear(); });
  return password;
}
