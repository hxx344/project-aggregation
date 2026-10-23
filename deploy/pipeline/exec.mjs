/**
 * 命令执行：固定参数数组、独立日志、超时终止与 dry-run。
 *
 * pnpm 优先通过当前 Node 执行其 JavaScript 入口（npm_execpath），
 * 不把 shell 包装器交给 Node；这是项目里已经踩过的坑（LESSONS L018）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_FORCED_MARKER } from './constants.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 40;
const JOB_FORCED_MARKER = 'PIPELINE_JOB_FORCED_CLEANUP';
const MARKER_SCAN = Math.max(JOB_FORCED_MARKER.length, CHILD_FORCED_MARKER.length);

export class CommandError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CommandError';
    this.detail = detail;
  }
}

export function resolveInvocation(command, { platform = process.platform, npmExecPath = process.env.npm_execpath, execPath = process.execPath } = {}) {
  const args = command.args ?? [];
  if (command.cmd !== 'pnpm') return { cmd: command.cmd, args };
  if (npmExecPath && existsSync(npmExecPath) && /pnpm/i.test(npmExecPath)) {
    return { cmd: execPath, args: [npmExecPath, ...args] };
  }
  if (platform === 'win32') {
    // 直接 spawn .cmd 在部分 Node 版本会失败；交给系统命令解释器并逐个加引号。
    const line = ['pnpm', ...args].map(quoteWindowsArgument).join(' ');
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
  }
  return { cmd: 'pnpm', args };
}

function quoteWindowsArgument(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function formatInvocation({ cmd, args }) {
  return [cmd, ...args].join(' ');
}

export function runCommand({
  command,
  cwd,
  env,
  timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  logFile = null,
  dryRun = false,
  echo = false,
  platform = process.platform,
  redact = [],
  spawnImpl = spawn,
  termGraceMs = 5000,
  killGraceMs = 5000,
  closeGraceMs = 1000,
  commandLock = null,
  stageId = 'command',
}) {
  const invocation = resolveInvocation(command, { platform });
  // 提权标记只供人工核查使用；所有命令一旦强制终止都采用相同的隔离规则。
  const privileged = platform !== 'win32' && (path.posix.basename(command.cmd) === 'sudo' || command.privileged === true);
  // 正常 exit + close 不检测已脱离的后代。仅接受仓库内受信脚本，由脚本等待
  // 部署工作结束；服务须由 systemd 管理。install-all 的 setsid 安装器正常路径会等待。
  const started = Date.now();
  const secrets = redact.filter(value => typeof value === 'string' && value.length >= 4);
  const sanitize = text => secrets.reduce((result, secret) => result.split(secret).join('***'), text);
  if (dryRun) {
    return Promise.resolve({ ...invocation, code: 0, signal: null, timedOut: false, durationMs: 0, tail: '', dryRun: true });
  }
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });
  // 仅用于匹配锁内这一条命令记录，不注入环境，也不用于识别进程。
  const commandId = randomUUID();

  return new Promise((resolve, reject) => {
    let child;
    let marked = false;
    try {
      const launch = platform === 'win32' ? windowsJobInvocation(invocation) : invocation;
      // 任何 spawn 之前必须先持久化；此处失败不会启动外部命令。
      commandLock?.beginCommand({ commandId, stage: stageId, privileged });
      marked = Boolean(commandLock);
      child = spawnImpl(launch.cmd, launch.args, {
        cwd, env,
        windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // 同步 spawn 抛错没有进程；如果解除标记失败，磁盘与内存仍保守持锁。
      if (marked) {
        try { commandLock.confirmCommand(commandId); } catch {}
      }
      reject(new CommandError(`无法启动 ${invocation.cmd}：${error.message}`, { invocation, commandId, lockRetained: Boolean(commandLock) }));
      return;
    }

    const sink = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    const tail = [];
    let timedOut = false;
    let exited = false;
    let closed = false;
    let stdioForced = false;
    let jobForced = false;
    let childForced = false;
    let markerScan = '';
    let settled = false;
    let timer = null;
    let killTimer = null;
    let finalTimer = null;
    let closeTimer = null;
    let terminating = false;
    let stopCause = null;
    let exitCode = null;
    let exitSignal = null;

    const collect = (chunk, stream = null) => {
      const raw = chunk.toString();
      // 在脱敏前、仅对 stderr 识别强制终止标记：脱敏或 stdout 交错都不能让强制清理漏判。
      if (stream === 'stderr') {
        markerScan = markerScan.slice(-MARKER_SCAN) + raw;
        if (platform === 'win32') jobForced ||= markerScan.includes(JOB_FORCED_MARKER);
        childForced ||= markerScan.includes(CHILD_FORCED_MARKER);
      }
      const text = sanitize(raw);
      if (sink && !sink.destroyed) sink.write(text);
      if (echo) process.stdout.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    child.stdout?.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr?.on('data', chunk => collect(chunk, 'stderr'));

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      const terminationUnconfirmed = Boolean(terminating || stdioForced || jobForced || childForced || exitSignal);
      const cause = timedOut ? '命令超时' : stopCause === 'log-error' ? '命令日志写入失败'
        : stdioForced ? '输出管道在宽限后仍未关闭'
        : jobForced ? '命令退出时仍有后代，已由 Windows Job 强制清理'
        : childForced ? '内部子命令被超时或信号强制终止' : '命令被强制终止';
      const terminationReason = terminationUnconfirmed
        ? `${cause}；后代停止未确认，请以 root 核对相关进程、安装器日志和独立锁后再解除`
        : undefined;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(finalTimer);
      clearTimeout(closeTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (terminationReason) collect(`${terminationReason}\n`);
      if (sink) sink.end();
      const detail = {
        ...invocation, ...extra, code: terminationUnconfirmed && exitCode === 0 ? 1 : exitCode,
        signal: exitSignal, timedOut, stdioForced, terminationUnconfirmed, terminationReason, pid: child.pid, commandId,
        durationMs: Date.now() - started, tail: tail.join('\n'),
      };
      if (commandLock) {
        if (terminationUnconfirmed) {
          try { commandLock.quarantine({ commandId, pid: child.pid, stage: stageId, privileged, reason: terminationReason }); }
          catch (error) { detail.lockError = error.message; } // commandRunning 已经落盘，不能释放或回收。
        } else {
          try { commandLock.confirmCommand(commandId); } catch (error) {
            reject(new CommandError(`命令已结束，但无法解除运行标记：${error.message}`, { ...detail, lockRetained: true }));
            return;
          }
        }
      }
      resolve(detail);
    };

    const stop = (reason = 'timeout') => {
      if (settled || terminating) return;
      terminating = true;
      stopCause = reason;
      timedOut = reason === 'timeout';
      clearTimeout(timer);
      // 只按直接子进程的退出事件决定是否升级，不依赖 child.killed，也不查询后代。
      // 退出后不再向可能复用的 PID/PGID 发信号；后代是否停止交由人工核查。
      killTimer = setTimeout(() => {
        if (!settled && !exited) terminate(child, { platform, signal: 'SIGKILL' });
      }, termGraceMs);
      finalTimer = setTimeout(() => {
        stdioForced = !closed;
        finish();
      }, termGraceMs + killGraceMs);
      if (!exited) terminate(child, { platform, signal: 'SIGTERM' });
    };
    timer = setTimeout(() => stop(), timeoutMs);
    sink?.once('error', () => stop('log-error'));

    child.once('error', error => {
      if (settled) return;
      if (child.pid) {
        stop('child-error');
      } else {
        finish({ launchError: error.message }); // 未启动进程，无需隔离。
      }
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (closed) { finish(); return; }
      // exit 不代表 close：宽限后强制销毁管道并隔离，不把关闭管道当作停止后代。
      closeTimer = setTimeout(() => { stdioForced = true; finish(); }, closeGraceMs);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      closed = true;
      exitCode = code;
      exitSignal = signal;
      if (exited) finish();
      else stop('missing-exit'); // 异常事件顺序也有界结算，不能当作正常结束。
    });
  });
}

function terminate(child, { platform, signal }) {
  if (!child.pid) return;
  try {
    if (platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') return; // 发送失败也不取消隔离；仍受最终预算约束。
  }
}

function windowsJobInvocation(invocation) {
  // CreateProcess 使用 CRT 参数规则；base64 仅传输命令行，不经过 PowerShell 插值。
  const quote = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  const isCmdShell = path.basename(invocation.cmd).toLowerCase() === 'cmd.exe'
    && invocation.args.length === 4 && invocation.args.slice(0, 3).join(' ').toLowerCase() === '/d /s /c';
  // cmd /s /c 自己剥离命令首尾引号，不能将其中的引号按 CRT 再次转义。
  const line = isCmdShell
    ? `${quote(invocation.cmd)} /d /s /c "${invocation.args[3]}"`
    : [invocation.cmd, ...invocation.args].map(quote).join(' ');
  return {
    cmd: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-job.ps1', import.meta.url)), Buffer.from(line).toString('base64')],
  };
}

export async function probeVersion(command, options = {}) {
  const result = await runCommand({ command: { cmd: command, args: ['--version'] }, timeoutMs: 30000, ...options });
  if (result.code !== 0 || result.timedOut || result.terminationUnconfirmed) {
    throw new CommandError(`${command} --version 失败（退出码 ${result.code}）${result.terminationReason ? `：${result.terminationReason}` : ''}`, result);
  }
  return (result.tail.split(/\r?\n/).filter(Boolean).at(-1) ?? '').trim();
}
