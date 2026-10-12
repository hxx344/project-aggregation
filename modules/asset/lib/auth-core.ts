import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SESSION_SECONDS = 12 * 60 * 60;
export function createSession(secret: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ owner: 'owner', exp: now + SESSION_SECONDS * 1000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function validSession(token: string | undefined, secret: string, now = Date.now()) {
  if (!token || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return payload.owner === 'owner' && Number.isFinite(payload.exp) && payload.exp > now && payload.exp <= now + SESSION_SECONDS * 1000;
  } catch { return false; }
}
export async function verifyPassword(password: string, stored: string) {
  if (password.length < 12 || password.length > 256 || !/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(stored)) return false;
  const [salt, hash] = stored.split(':');
  const derived = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, (error, value) => error ? reject(error) : resolve(value)));
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}
