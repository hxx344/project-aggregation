import { createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { AppError } from './model.mjs';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const matches = async (value, record) => {
  const [salt, encoded] = record.split(':');
  return timingSafeEqual(await derive(value, salt, 64), Buffer.from(encoded, 'hex'));
};

export function createAuthenticator({ getRecord, verify = matches, clock = Date.now, sleep = sleepMs }) {
  let authRecord, generation = 0, validAuth = null, failed = 0, failedAt = null, nextAllowedAt = 0, lastStartedAt = null, checkingAuth = 0;
  const leases = new Set();
  function reset() {
    authRecord = getRecord(); generation++; validAuth = null;
    failed = 0; failedAt = null; nextAllowedAt = 0; lastStartedAt = null;
    // Revoke queued work immediately; real derivations keep their concurrency slots.
    for (const lease of leases) if (!lease.started) lease.cancel();
  }
  function current() {
    if (authRecord !== getRecord()) reset();
    if (failedAt !== null && clock() - failedAt >= 900000) { failed = 0; failedAt = null; nextAllowedAt = 0; lastStartedAt = null; }
    return generation;
  }
  async function authenticate(authorization = '') {
    const requestGeneration = current(), record = authRecord;
    if (typeof authorization !== 'string' || !authorization.startsWith('Basic ') || authorization.length > 2048) return false;
    if (validAuth && equal(authorization, validAuth)) return true;
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8'), colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== 'admin') {
      if (failed >= 10) throw new AppError('登录信息不正确，请检查密码后重试', 429);
      return false;
    }
    if (checkingAuth >= 4) throw new AppError('登录校验繁忙，请稍后重试', 429);
    checkingAuth++;
    const controller = new AbortController();
    let cancelWait, released = false;
    const cancelled = new Promise(resolve => { cancelWait = resolve; });
    const release = () => { if (!released) { released = true; checkingAuth--; leases.delete(lease); } };
    const lease = { started: false, cancel() { release(); cancelWait(); controller.abort(); } };
    leases.add(lease);
    // Reserve before yielding: simultaneous requests cannot claim the same verification time.
    let allowedAt = clock();
    if (failed >= 10) { allowedAt = Math.max(allowedAt, nextAllowedAt); nextAllowedAt = allowedAt + 1000; }
    try {
      while (true) {
        if (current() !== requestGeneration) return false;
        if (validAuth && equal(authorization, validAuth)) return true;
        // If the event loop woke several expired slots together, keep real starts spaced too.
        const due = failed >= 10 && lastStartedAt !== null ? Math.max(allowedAt, lastStartedAt + 1000) : allowedAt;
        const delay = due - clock();
        if (delay <= 0) break;
        await Promise.race([sleep(delay, undefined, { signal: controller.signal }), cancelled]);
        if (current() !== requestGeneration) return false;
      }
      if (current() !== requestGeneration) return false;
      if (failed >= 10) lastStartedAt = clock();
      lease.started = true;
      const accepted = await verify(decoded.slice(colon + 1), record);
      // Password changes revoke both queued attempts and results already being derived.
      if (current() !== requestGeneration) return false;
      if (accepted) { validAuth = authorization; failed = 0; failedAt = null; nextAllowedAt = 0; lastStartedAt = null; return true; }
      failedAt ??= clock(); failed++;
      if (failed === 10) nextAllowedAt = Math.max(nextAllowedAt, clock() + 1000);
      if (failed >= 10) throw new AppError('登录信息不正确，请检查密码后重试', 429);
      return false;
    } finally { release(); }
  }
  return { authenticate, reset };
}
