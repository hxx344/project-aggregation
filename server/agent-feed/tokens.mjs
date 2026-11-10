import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../http-common.mjs';

// Read-only access tokens for the agent data feed (docs/agent-feed.md). A token
// grants GET on /api/agent/v1/* for its scopes and nothing else: it is never a
// session. Only the SHA-256 of a token is stored, in the control `settings`
// table, so every API instance sees a new or revoked token on its next request.
export const SCOPES = Object.freeze(['public', 'system']);
export const MAX_TOKENS = 8;
export const MAX_LABEL_LENGTH = 40;
const KEY = 'agent-feed-tokens';
const RAW = /^paf_[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest();
const label = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_LENGTH && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const scopes = value => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(item => SCOPES.includes(item));
const entry = value => value !== null && typeof value === 'object' && ID.test(value.id) && label(value.label) && scopes(value.scopes)
  && typeof value.hash === 'string' && HASH.test(value.hash) && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt));

export function createAgentTokens({ getSetting, setSetting, now = Date.now }) {
  // Last use is kept per API instance and lost on restart: a read must not write the database.
  const lastUsed = new Map();
  let cachedText, cached = { tokens: [], corrupt: false };
  // An unreadable record grants nothing; the page says so and the next token replaces it.
  function load() {
    const text = getSetting(KEY);
    if (text === cachedText) return cached;
    let value = { tokens: [], corrupt: false };
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text);
        if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.tokens) || parsed.tokens.length > MAX_TOKENS || !parsed.tokens.every(entry)
          || new Set(parsed.tokens.map(item => item.id)).size !== parsed.tokens.length) throw new Error('invalid');
        value = { tokens: parsed.tokens.map(item => ({ id: item.id, label: item.label, scopes: [...item.scopes], hash: item.hash, createdAt: item.createdAt })), corrupt: false };
      } catch { value = { tokens: [], corrupt: true }; }
    }
    cachedText = text; cached = value; return value;
  }
  const save = tokens => setSetting(KEY, JSON.stringify({ schemaVersion: 1, tokens }));
  const view = item => ({ id: item.id, label: item.label, scopes: [...item.scopes], createdAt: item.createdAt, lastUsedAt: lastUsed.has(item.id) ? new Date(lastUsed.get(item.id)).toISOString() : null });
  return {
    state() { const { tokens, corrupt } = load(); return { tokens: tokens.map(view), corrupt, maxTokens: MAX_TOKENS, scopes: [...SCOPES] }; },
    // The token itself is returned once, here, and cannot be read again.
    create(body) {
      if (!body || !label(body.label)) throw new HttpError(400, `名称需为 1–${MAX_LABEL_LENGTH} 个字符，首尾不能有空格`);
      if (!scopes(body.scopes)) throw new HttpError(400, '请至少选择一个数据范围');
      const { tokens } = load();
      if (tokens.length >= MAX_TOKENS) throw new HttpError(409, `最多保留 ${MAX_TOKENS} 个令牌，请先撤销不用的令牌`);
      if (tokens.some(item => item.label === body.label)) throw new HttpError(409, '已有同名令牌');
      const token = `paf_${randomBytes(32).toString('base64url')}`;
      const item = { id: randomUUID(), label: body.label, scopes: SCOPES.filter(scope => body.scopes.includes(scope)), hash: digest(token).toString('hex'), createdAt: new Date(now()).toISOString() };
      save([...tokens, item]);
      return { token, entry: view(item) };
    },
    revoke(id) {
      const { tokens } = load();
      if (!tokens.some(item => item.id === id)) throw new HttpError(404, '令牌不存在或已撤销');
      save(tokens.filter(item => item.id !== id)); lastUsed.delete(id);
    },
    // Compares against every stored hash, so the time taken does not tell which one matched.
    verify(token) {
      if (typeof token !== 'string' || !RAW.test(token)) return null;
      const candidate = digest(token); let found = null;
      for (const item of load().tokens) if (timingSafeEqual(candidate, Buffer.from(item.hash, 'hex'))) found = item;
      if (!found) return null;
      lastUsed.set(found.id, now());
      return { id: found.id, label: found.label, scopes: [...found.scopes] };
    },
  };
}

// At most `limit` calls per key in each window; keys idle for a window are dropped.
export function createRateLimit({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  return key => {
    const at = now();
    if (windows.size > 64) for (const [name, value] of windows) if (at - value.start >= windowMs) windows.delete(name);
    let current = windows.get(key);
    if (!current || at - current.start >= windowMs) { current = { start: at, count: 0 }; windows.set(key, current); }
    current.count += 1;
    return current.count <= limit ? null : Math.max(1, Math.ceil((current.start + windowMs - at) / 1000));
  };
}
