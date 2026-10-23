/** 运行状态：环境锁、阶段状态文件与追加式日志（journal）。 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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
 * 只有持有者已退出且未登记未确认终止的进程树时才回收。
 */
export function acquireLock(lockFile, { pid = process.pid, runId, now = Date.now(), persist = persistLock } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const payload = JSON.stringify({ pid, runId, startedAt: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx');
      try { writeSync(fd, `${payload}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      let pending = false;
      let isolated = false;
      const owned = () => {
        const current = readLock(lockFile);
        if (current?.pid !== pid || current?.runId !== runId) throw new LockError('环境锁丢失或不可读，禁止启动命令', current);
        return current;
      };
      return {
        file: lockFile,
        pid,
        runId,
        beginCommand({ commandId, stage, privileged = false }) {
          const current = owned();
          if (pending || isolated || current.commandRunning || current.terminationUnconfirmed) throw new LockError(isolationAdvice(lockFile, current), current);
          if (!commandId) throw new LockError('命令缺少记录编号，禁止启动');
          persist(lockFile, { ...current, commandRunning: { commandId, stage, pid: null, privileged } });
          pending = true;
        },
        confirmCommand(commandId) {
          const current = owned();
          if (isolated || current.terminationUnconfirmed || current.commandRunning?.commandId !== commandId) throw new LockError('命令记录与环境锁不一致，保留锁', current);
          const { commandRunning, ...idle } = current;
          persist(lockFile, idle);
          pending = false;
        },
        quarantine(detail) {
          // 先锁住本进程的 release；持久化失败仍保留启动前写入的 commandRunning。
          isolated = true;
          persist(lockFile, { ...owned(), terminationUnconfirmed: detail });
        },
        release() {
          if (pending || isolated) return;
          const current = readLock(lockFile);
          if (current?.pid === pid && current?.runId === runId && !current.commandRunning && !current.terminationUnconfirmed) rmSync(lockFile, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(lockFile);
      if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) throw new LockError(`环境锁不可读或损坏，禁止自动回收，请人工核查：${lockFile}`, holder);
      if (holder.commandRunning || holder.terminationUnconfirmed) throw new LockError(isolationAdvice(lockFile, holder), holder);
      const stale = !isProcessAlive(holder.pid);
      if (!stale) {
        throw new LockError(`环境已被运行中的任务占用：pid ${holder.pid}，run ${holder.runId}，开始于 ${holder.startedAt}`, holder);
      }
      // 序列化死锁回收，避免两个竞争者都读到旧锁后，其中一个删除另一方的新锁。
      const reclaiming = `${lockFile}.reclaim`;
      try { mkdirSync(reclaiming); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new LockError(`环境锁正在回收；若回收者已退出，请人工核查后移除回收标记：${reclaiming}`, holder);
      }
      try {
        const latest = readLock(lockFile);
        if (JSON.stringify(latest) !== JSON.stringify(holder) || isProcessAlive(latest.pid)) continue;
        rmSync(lockFile, { force: true });
      } finally { rmdirSync(reclaiming); }
    }
  }
  throw new LockError(`无法取得环境锁：${lockFile}`);
}

/** 保守标记先刷新临时文件再原子替换；写入失败不会覆盖上一份有效锁。 */
function persistLock(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
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
