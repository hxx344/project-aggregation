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

function isolationAdvice(lockFile, holder) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const lock = quote(path.resolve(lockFile));
  const runId = String(holder.runId ?? '<runId>').replace(/-rollback$/, '');
  const run = quote(path.join(path.dirname(path.dirname(path.resolve(lockFile))), 'runs', runId));
  return [
    `存在运行中或终止未确认的命令，禁止自动回收；主进程退出或原组为空不能作为后代停止依据；须完成以下人工核查后才能手动移除锁：${lockFile}`,
    `1. 停止自动触发及并行流水线，以 root 核查持有者：sudo ps -p ${holder.pid} -o pid,ppid,pgid,sid,user,lstart,args；保留运行记录与备份：${run}。`,
    '2. 以 root 核对安装器日志：sudo ls -lt /var/log/project-aggregation-stack；读取对应运行目录的 hub.log、hub.download.log、summary.txt；核对相关进程：sudo ps -eo pid,ppid,pgid,sid,user,lstart,args --forest。',
    '3. 核对 install-all 独立锁及持有者：sudo fuser -v /run/lock/project-aggregation-stack.lock；sudo flock -n /run/lock/project-aggregation-stack.lock -c true。锁空闲也不单独证明后代停止；不要删除此独立锁文件。',
    `4. 对照日志核实并停止仍在写入的安装器/工作进程，复查其 PID、启动时间、会话及独立锁；无法证明全部停止时保持隔离。证据齐全后先备份 ${lock}，再执行 sudo rm -- ${lock}；详见 docs/deployment-pipeline.md 的“人工解除隔离”。`,
  ].join('\n');
}

/**
 * 每个环境一把锁：同一环境不允许并发执行。
 * 只有可读、无运行中或隔离标记且持有者已退出的锁才回收；不按经过时长回收。
 */
export function acquireLock(lockFile, { pid = process.pid, runId, now = Date.now(), persist = persistLock } = {}) {
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
          const inspected = inspectLock(lockFile);
          if (!inspected) continue;
          const { holder } = inspected;
          if (!holder) throw new LockError(`环境锁不可读或损坏，禁止自动回收，请人工核查：${lockFile}`);
          if (holder.commandRunning || holder.terminationUnconfirmed) throw new LockError(isolationAdvice(lockFile, holder), holder);
          if (isProcessAlive(holder.pid)) {
            throw new LockError(`环境已被运行中的任务占用：pid ${holder.pid}，run ${holder.runId}，开始于 ${holder.startedAt}`, holder);
          }
          fs.unlinkSync(lockFile);
        }
      }
      let pending = false;
      let isolated = false;
      const owned = () => {
        const current = readLock(lockFile);
        if (current?.token !== token) throw new LockError('环境锁丢失或已被替换，禁止启动命令', current);
        return current;
      };
      // 标记写入与回收检查共用保护目录，避免检查通过后锁被替换。
      const guarded = work => withLockGuard(lockFile, work, { attempts: 50 });
      return {
        file: lockFile,
        pid,
        runId,
        beginCommand({ commandId, stage, privileged = false }) {
          guarded(() => {
            const current = owned();
            if (pending || isolated || current.commandRunning || current.terminationUnconfirmed) throw new LockError(isolationAdvice(lockFile, current), current);
            if (!commandId) throw new LockError('命令缺少记录编号，禁止启动');
            persist(lockFile, { ...current, commandRunning: { commandId, stage, pid: null, privileged } });
            pending = true;
          });
        },
        confirmCommand(commandId) {
          guarded(() => {
            const current = owned();
            if (isolated || current.terminationUnconfirmed || current.commandRunning?.commandId !== commandId) throw new LockError('命令记录与环境锁不一致，保留锁', current);
            const { commandRunning, ...idle } = current;
            persist(lockFile, idle);
            pending = false;
          });
        },
        quarantine(detail) {
          // 先锁住本进程的 release；持久化失败仍保留启动前写入的 commandRunning。
          isolated = true;
          guarded(() => persist(lockFile, { ...owned(), terminationUnconfirmed: detail }));
        },
        release() {
          if (pending || isolated) return;
          // A competitor may hold the guard briefly while it inspects this live lock.
          guarded(() => {
            const current = readLock(lockFile);
            if (current?.token === token && !current.commandRunning && !current.terminationUnconfirmed) fs.unlinkSync(lockFile);
          });
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
    try { holder = JSON.parse(text); } catch { /* 损坏的锁可能丢失隔离标记，只能人工处理。 */ }
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

/** 保守标记先刷新临时文件再原子替换；写入失败不会覆盖上一份有效锁。 */
function persistLock(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
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
