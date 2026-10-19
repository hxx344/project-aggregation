/**
 * 命令执行：固定参数数组、独立日志、超时终止与 dry-run。
 *
 * pnpm 优先通过当前 Node 执行其 JavaScript 入口（npm_execpath），
 * 不把 shell 包装器交给 Node；这是项目里已经踩过的坑（LESSONS L018）。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 40;

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
}) {
  const invocation = resolveInvocation(command, { platform });
  const started = Date.now();
  const secrets = redact.filter(value => typeof value === 'string' && value.length >= 4);
  const sanitize = text => secrets.reduce((result, secret) => result.split(secret).join('***'), text);
  if (dryRun) {
    return Promise.resolve({ ...invocation, code: 0, signal: null, timedOut: false, durationMs: 0, tail: '', dryRun: true });
  }
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(invocation.cmd, invocation.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new CommandError(`无法启动 ${invocation.cmd}：${error.message}`, { invocation }));
      return;
    }

    const sink = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    const tail = [];
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const collect = chunk => {
      const text = sanitize(chunk.toString());
      if (sink) sink.write(text);
      if (echo) process.stdout.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const done = () => resolve({ ...invocation, ...result, durationMs: Date.now() - started, tail: tail.join('\n') });
      if (sink) sink.end(done);
      else done();
    };

    timer = setTimeout(() => {
      timedOut = true;
      terminate(child, { platform, signal: 'SIGTERM' });
      killTimer = setTimeout(() => terminate(child, { platform, signal: 'SIGKILL' }), 5000);
    }, timeoutMs);

    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (sink) sink.end();
      reject(new CommandError(`无法启动 ${invocation.cmd}：${error.message}`, { invocation }));
    });

    child.once('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

function terminate(child, { platform, signal }) {
  if (!child.pid || child.killed) return;
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill(signal);
}

export async function probeVersion(command, options = {}) {
  const result = await runCommand({ command: { cmd: command, args: ['--version'] }, timeoutMs: 30000, ...options });
  if (result.code !== 0) throw new CommandError(`${command} --version 失败（退出码 ${result.code}）`);
  return (result.tail.split(/\r?\n/).filter(Boolean).at(-1) ?? '').trim();
}
