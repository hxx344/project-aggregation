/** 运行状态：环境锁、阶段状态文件与追加式日志（journal）。 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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
    return error.code === 'EPERM';
  }
}

/**
 * 每个环境一把锁：同一环境不允许并发执行。
 * 只有持有者进程已退出或锁超过 staleMs 才回收，避免误删正在运行的锁。
 */
export function acquireLock(lockFile, { pid = process.pid, runId, now = Date.now(), staleMs = 6 * 60 * 60 * 1000 } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const payload = JSON.stringify({ pid, runId, startedAt: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, `${payload}\n`);
      closeSync(fd);
      return {
        file: lockFile,
        pid,
        runId,
        release() {
          const current = readLock(lockFile);
          if (current?.pid === pid && current?.runId === runId) rmSync(lockFile, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(lockFile);
      const age = holder ? now - Date.parse(holder.startedAt) : staleMs + 1;
      const stale = !holder || !isProcessAlive(holder.pid) || !Number.isFinite(age) || age > staleMs;
      if (!stale) {
        throw new LockError(`环境已被运行中的任务占用：pid ${holder.pid}，run ${holder.runId}，开始于 ${holder.startedAt}`, holder);
      }
      rmSync(lockFile, { force: true });
    }
  }
  throw new LockError(`无法取得环境锁：${lockFile}`);
}

export function readLock(lockFile) {
  if (!existsSync(lockFile)) return null;
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
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
