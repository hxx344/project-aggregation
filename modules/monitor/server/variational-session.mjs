import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestVariational, variationalTokenExpiry } from '../lib/variational-api.ts';

const failure = (message, status = 400) => Object.assign(Error(message), { status });
const empty = () => ({ version: 1, revision: 0, token: '', updatedAt: null });

export async function openVariationalSessionStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'variational-session.json');
  let state = empty();
  try {
    const metadata = await stat(file);
    if (metadata.size > 16_384 || (process.platform !== 'win32' && (metadata.mode & 0o077))) throw Error();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) throw Error();
    variationalTokenExpiry(saved.token);
    state = { version: 1, revision: saved.revision, token: saved.token, updatedAt: saved.updatedAt };
  } catch (error) {
    if (error.code !== 'ENOENT') throw failure('无法读取 Var token 配置，请检查数据目录中的 variational-session.json。', 503);
  }
  return {
    get: () => ({ ...state }),
    async save(next) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(next) + '\n', 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await rename(temporary, file);
        state = { ...next };
      } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
    },
  };
}

export function createVariationalSession(store, { fetcher = fetch, clock = Date.now } = {}) {
  let queue = Promise.resolve(), lastAttempt = -Infinity, observation = '';
  const status = () => {
    const { token } = store.get();
    if (!token) return 'missing';
    if (variationalTokenExpiry(token) <= clock() + 30_000) return 'expired';
    return observation || 'ready';
  };
  const view = () => {
    const state = store.get(), current = status();
    return { available: true, configured: Boolean(state.token), revision: state.revision,
      expiresAt: state.token ? new Date(variationalTokenExpiry(state.token)).toISOString() : null, updatedAt: state.updatedAt, status: current,
      error: current === 'expired' ? 'Var token 已过期，请更新；公开行情不受影响。' : current === 'rejected' ? 'Variational 未通过会话认证，请更新 token；公开行情不受影响。' : current === 'unavailable' ? '认证行情暂不可用，后台将自动重试；公开行情不受影响。' : '' };
  };
  return {
    view,
    current() {
      const state = store.get(), current = status(), usable = !['missing', 'expired', 'rejected'].includes(current);
      return { token: usable ? state.token : null, revision: state.revision, status: current };
    },
    report(revision, next) { if (store.get().revision === revision && ['ready', 'rejected', 'unavailable'].includes(next)) observation = next; },
    update(input) {
      const operation = queue.then(async () => {
        const previous = store.get();
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['token', 'revision'].includes(key)) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('请提供 Var token 和有效配置版本号。');
        if (input.revision !== previous.revision) throw failure('Var token 已被另一页面更新，请重新读取状态后再保存。', 409);
        const token = typeof input.token === 'string' ? input.token.trim() : input.token;
        if (variationalTokenExpiry(token) <= clock() + 30_000) throw failure('Var token 已过期或即将过期，请重新获取。');
        if (clock() - lastAttempt < 3000) throw failure('验证过于频繁，请稍等 3 秒再试。', 429);
        lastAttempt = clock();
        let result;
        try { result = await requestVariational('/me', token, { fetcher }); }
        catch (error) { throw failure(`${error.message} 原配置未修改。`, error.status || 502); }
        try { if (variationalTokenExpiry(result?.token) <= clock() || variationalTokenExpiry(token) <= clock() + 30_000) throw Error(); }
        catch { throw failure('Variational 未确认有效会话，请重新获取 Var token。'); }
        const next = { version: 1, revision: previous.revision + 1, token, updatedAt: new Date(clock()).toISOString() };
        try { await store.save(next); }
        catch { throw failure('Var token 保存失败，原配置已保留；请检查数据目录权限和磁盘空间。', 503); }
        observation = '';
        return view();
      });
      queue = operation.catch(() => {});
      return operation;
    },
    stop: () => queue,
  };
}
