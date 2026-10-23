/** 运行状态：环境锁、阶段状态文件与追加式日志（journal）。 */
import fs, { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { STATE_SCHEMA } from './constants.mjs';

export class LockError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockError';
    this.holder = holder;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw new LockError(`无法确认锁持有进程状态：${error.code || 'unknown'}`);
  }
}

/**
 * 每个环境一把锁：同一环境不允许并发执行。
 * 只有持有者进程已退出或锁超过 staleMs 才回收，避免误删正在运行的锁。
 */
export function acquireLock(lockFile, { pid = process.pid, runId, now = Date.now(), staleMs = 6 * 60 * 60 * 1000 } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = randomUUID();
  const payload = JSON.stringify({ pid, runId, token, startedAt: new Date(now).toISOString() });
  return withLockGuard(lockFile, () => {
    const temporary = `${lockFile}.${token}.tmp`;
    try {
      fs.writeFileSync(temporary, `${payload}\n`, { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          // link publishes the fully written inode without replacing an existing lock.
          fs.linkSync(temporary, lockFile);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw new LockError(`无法创建环境锁：${error.code || 'unknown'}`);
          if (attempt) throw new LockError(`无法取得环境锁：${lockFile}`);
          const { holder, mtimeMs } = inspectLock(lockFile) ?? {};
          if (mtimeMs === undefined) continue;
          const age = now - (holder ? Date.parse(holder.startedAt) : mtimeMs);
          const stale = age > staleMs || (holder && !isProcessAlive(holder.pid));
          if (!stale) {
            throw new LockError(holder
              ? `环境已被运行中的任务占用：pid ${holder.pid}，run ${holder.runId}，开始于 ${holder.startedAt}`
              : '环境锁内容无效且尚未超时，拒绝回收', holder);
          }
          fs.unlinkSync(lockFile);
        }
      }
      return {
        file: lockFile,
        pid,
        runId,
        release() {
          // A competitor may hold the guard briefly while it inspects this live lock.
          withLockGuard(lockFile, () => {
            const current = readLock(lockFile);
            if (current?.token === token) fs.unlinkSync(lockFile);
          }, { attempts: 50 });
        },
      };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  });
}

function withLockGuard(lockFile, work, { attempts = 1, waitMs = 20 } = {}) {
  const guard = `${lockFile}.guard`;
  // Serialize stale-lock removal with acquisition/release so a second reclaimer
  // cannot unlink a newly acquired lock. An abandoned guard fails closed.
  for (let attempt = 1; ; attempt += 1) {
    try { fs.mkdirSync(guard); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= attempts) {
        throw new LockError(`环境锁正在变更或保护目录不可用（${error.code || 'unknown'}）：${guard}；若持续存在，请确认没有流水线进程后人工清理`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  try { return work(); }
  finally { fs.rmdirSync(guard); }
}

function inspectLock(lockFile) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'r');
    const stat = fs.fstatSync(fd);
    const text = fs.readFileSync(fd, 'utf8');
    let holder;
    try { holder = JSON.parse(text); } catch { /* An incomplete old lock may only expire by mtime. */ }
    const valid = holder && Number.isInteger(holder.pid) && holder.pid > 0
      && typeof holder.startedAt === 'string' && Number.isFinite(Date.parse(holder.startedAt));
    return { holder: valid ? holder : null, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new LockError(`无法读取环境锁，拒绝回收：${error.code || 'unknown'}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readLock(lockFile) {
  const value = inspectLock(lockFile);
  if (!value) return null;
  if (!value.holder) throw new LockError('环境锁内容无法解析或字段无效，不能视为无锁');
  return value.holder;
}

export function emptyState(env) {
  return { schema: STATE_SCHEMA, env, lastRunId: null, commit: null, configFingerprint: null, stages: {} };
}

export function readState(file, env) {
  if (!existsSync(file)) return emptyState(env);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.schema !== STATE_SCHEMA) return emptyState(env);
    return { ...emptyState(env), ...parsed, stages: parsed.stages ?? {} };
  } catch {
    return emptyState(env);
  }
}

/** 先写临时文件再 rename：进程被终止时不会留下半截 JSON。 */
export function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}

export function appendJournal(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

export function readJournal(file) {
  if (!existsSync(file)) return { records: [], invalid: 0 };
  const records = [];
  let invalid = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid };
}
