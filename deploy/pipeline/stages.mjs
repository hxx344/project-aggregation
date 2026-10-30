/**
 * 阶段实现：预检、依赖、配置、构建、校验、打包、发布、激活。
 *
 * 每个阶段提供 run（执行）、validate（校验点）、snapshot（回滚快照）。
 * 只有配置、打包两个阶段会自动回滚；发布与激活必须人工确认后处理，
 * 因为远端 Release 和服务器切换不能靠本地文件恢复。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, renderEnvFile } from './config.mjs';
import { formatInvocation, probeVersion } from './exec.mjs';
import { hashFile } from './digest.mjs';
import { snapshotFile, restoreFile } from './config-files.mjs';
import { releasePaths, validateRelease } from './release-manifest.mjs';

const TOOLCHAIN_COMMANDS = new Set(['git', 'bash', 'python3', 'python', 'sudo']);

export function expandPath(ctx, template) {
  const config = ctx.profile?.stages?.config;
  return template.replaceAll('{releaseDirectory}', ctx.profile?.stages?.package?.releaseDirectory ?? '')
    .replaceAll('{target}', config?.target ?? '').replaceAll('{applyTarget}', config?.applyTarget ?? '')
    .replaceAll('{env}', ctx.env).replaceAll('{commit}', ctx.git?.commit ?? '');
}

/** 健康检查地址支持 {env} 与 {PORT}，避免端口改了但探测地址没跟着改。 */
export function expandUrl(ctx, template) {
  return template.replaceAll('{env}', ctx.env).replaceAll('{PORT}', String(ctx.resolved?.values?.PORT ?? ''));
}

export function compareVersion(actual, requirement) {
  const parse = value => String(value).replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(actual);
  const minimum = requirement.startsWith('>=');
  const [rMajor, rMinor, rPatch] = parse(minimum ? requirement.slice(2) : requirement);
  const compare = (a, b) => (a === b ? 0 : a > b ? 1 : -1);
  const result = compare(aMajor, rMajor) || compare(aMinor, rMinor) || compare(aPatch, rPatch);
  return minimum ? result >= 0 : result === 0;
}

function requireStage(ctx, id) {
  const spec = ctx.profile.stages?.[id];
  if (!spec) throw new Error(`环境 ${ctx.env} 未声明阶段 ${id}`);
  return spec;
}

/** deferCode：命令以该退出码结束表示“未做任何改动、目标尚不可用”，交由调用阶段记为 deferred。 */
async function runCommands(ctx, id, commands, { deferCode } = {}) {
  for (const [index, original] of commands.entries()) {
    const command = { ...original, args: (original.args ?? []).map(arg => expandPath(ctx, arg)) };
    const result = await ctx.exec(command, id);
    // 终止不明优先于日志写入，不能让日志故障掩盖仍可能写入的进程。
    if (result.terminationUnconfirmed) {
      const error = new Error(`命令进程树终止未确认，保留环境锁并暂停补偿：pid ${result.pid}${result.terminationReason ? `；${result.terminationReason}` : ''}`);
      error.detail = result;
      throw error;
    }
    ctx.journal({
      type: 'command',
      stage: id,
      index,
      cmd: command.cmd,
      args: command.args ?? [],
      code: result.code,
      durationMs: result.durationMs,
      timedOut: Boolean(result.timedOut),
      dryRun: Boolean(result.dryRun),
    });
    const line = formatInvocation({ cmd: command.cmd, args: command.args ?? [] });
    if (result.dryRun) {
      ctx.logger.info('command.planned', `将执行：${line}`);
      continue;
    }
    if (result.timedOut) throw new Error(`命令超时（${command.timeoutMs ?? '默认'}ms）：${line}`);
    if (deferCode !== undefined && result.code === deferCode) return { deferred: true };
    if (result.code !== 0) {
      const tail = result.tail ? `\n${result.tail}` : '';
      throw new Error(`命令失败（退出码 ${result.code}）：${line}${tail}`);
    }
    ctx.logger.info('command.ok', `完成：${line}`, { durationMs: result.durationMs });
  }
}

function assertOutputs(ctx, id) {
  const outputs = (requireStage(ctx, id).outputs ?? []).map(item => expandPath(ctx, item));
  const missing = outputs.filter(relative => {
    const absolute = path.resolve(ctx.root, relative);
    return !existsSync(absolute) || !statSync(absolute).isFile() || statSync(absolute).size === 0;
  });
  if (missing.length) throw new Error(`阶段 ${id} 缺少产物：${missing.join('、')}`);
  return outputs;
}

async function privilegedConfigFile(ctx, operation, ...args) {
  // 无交互、无重试；60 秒命令时限之外沿用执行器有界终止预算。
  const result = await ctx.exec({
    cmd: 'sudo',
    args: ['-n', process.execPath, fileURLToPath(new URL('./config-files.mjs', import.meta.url)), operation, ...args],
    timeoutMs: 60000,
  }, 'config');
  if (result.terminationUnconfirmed) {
    const error = new Error(`配置文件操作的进程终止未确认，保留环境锁${result.terminationReason ? `；${result.terminationReason}` : ''}`);
    error.detail = result;
    throw error;
  }
  if (result.timedOut || result.code !== 0) throw new Error(`系统配置 ${operation} 失败：${result.tail ?? ''}`);
  return operation === 'snapshot' ? JSON.parse(result.tail) : undefined;
}

export const STAGES = {
  preflight: {
    id: 'preflight',
    title: '预检',
    alwaysRun: true,
    async run(ctx) {
      const findings = [];
      const strict = ctx.profile.toolchain?.strict !== false;
      const checkTool = (name, actual, requirement) => {
        if (compareVersion(actual, requirement)) return;
        const message = `${name} 版本不满足要求：当前 ${actual}，要求 ${requirement}`;
        if (strict) findings.push(message);
        else ctx.logger.warn('preflight.toolchain', `${message}（本环境非严格模式，继续）`);
      };
      checkTool('Node', ctx.toolchain.node, ctx.profile.toolchain.node);
      checkTool('pnpm', ctx.toolchain.pnpm, ctx.profile.toolchain.pnpm);

      const requiredCommands = new Set();
      for (const [id, stage] of Object.entries(ctx.profile.stages ?? {})) {
        if (stage.enabled === false) continue;
        if (id === 'activate' && !ctx.options.apply) continue;
        for (const command of [...(stage.commands ?? []), ...(ctx.options.apply ? stage.applyCommands ?? [] : [])]) {
          if (TOOLCHAIN_COMMANDS.has(command.cmd)) requiredCommands.add(command.cmd);
        }
      }
      for (const command of [...requiredCommands].sort()) {
        try {
          await probeVersion(command, { platform: ctx.platform, npmExecPath: ctx.npmExecPath, commandLock: ctx.commandLock, stageId: 'preflight' });
        } catch (error) {
          if (error.detail?.terminationUnconfirmed || error.detail?.lockRetained) throw error;
          findings.push(`缺少命令：${command}（阶段 ${ctx.profile.id} 需要）`);
        }
      }

      if (ctx.resolved.issues.length) {
        findings.push(...ctx.resolved.issues.map(issue => `配置 ${issue.name}：${issue.message}`));
      }
      if (!ctx.git.commit) findings.push('无法读取 Git 提交：构建与发布需要可追溯的提交身份');

      if (findings.length) throw new Error(`预检未通过（${findings.length} 项）\n- ${findings.join('\n- ')}`);
      ctx.logger.info('preflight.ok', `预检通过：Node ${ctx.toolchain.node}，pnpm ${ctx.toolchain.pnpm}，提交 ${ctx.git.commit.slice(0, 12)}`);
    },
  },

  deps: {
    id: 'deps',
    title: '依赖安装',
    async run(ctx) {
      const spec = requireStage(ctx, 'deps');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不安装依赖' };
      const lockfile = path.join(ctx.root, 'pnpm-lock.yaml');
      const before = existsSync(lockfile) ? hashFile(lockfile) : null;
      await runCommands(ctx, 'deps', spec.commands ?? []);
      if (spec.frozen !== false && before) {
        const after = hashFile(lockfile);
        if (after !== before) throw new Error('冻结安装改写了 pnpm-lock.yaml：锁文件与声明不一致');
      }
    },
    validate(ctx) {
      return assertOutputs(ctx, 'deps');
    },
    manualRollback: '依赖安装不回滚；锁文件或依赖损坏时删除 node_modules 后重新执行本阶段。',
  },

  config: {
    id: 'config',
    title: '配置渲染',
    async snapshot(ctx) {
      const spec = requireStage(ctx, 'config');
      const target = path.resolve(ctx.root, expandPath(ctx, spec.target));
      if (ctx.options.dryRun) return { target };
      // 共享目录始终由流水线用户创建，root 只创建自己的隔离子目录。
      mkdirSync(ctx.paths.backupDir, { recursive: true, mode: 0o700 });
      const snapshot = snapshotFile(target, path.join(ctx.paths.backupDir, 'rendered.env'));
      if (ctx.options.apply && spec.applyCommands?.length) {
        const appliedTarget = path.resolve(ctx.root, expandPath(ctx, spec.applyTarget));
        const backup = path.join(ctx.paths.backupDir, ...(spec.applyWithSudo ? ['privileged'] : []), 'applied.env');
        const applied = spec.applyWithSudo
          ? await privilegedConfigFile(ctx, 'snapshot', appliedTarget, backup)
          : snapshotFile(appliedTarget, backup);
        snapshot.applied = { ...applied, sudo: Boolean(spec.applyWithSudo) };
      }
      return snapshot;
    },
    async run(ctx) {
      const spec = requireStage(ctx, 'config');
      const snapshot = ctx.snapshots.config;
      if (!snapshot) throw new Error('配置阶段缺少快照，无法保证可回滚');
      if (ctx.resolved.issues.length) throw new Error(`配置不完整：${ctx.resolved.issues.map(issue => issue.name).join('、')}`);
      if (ctx.options.dryRun) {
        ctx.logger.info('config.planned', `将生成 ${path.relative(ctx.root, snapshot.target)}（dry-run 未写入）`);
        return;
      }
      mkdirSync(path.dirname(snapshot.target), { recursive: true });
      if (existsSync(snapshot.target)) chmodSync(snapshot.target, 0o600);
      writeFileSync(snapshot.target, renderEnvFile(ctx.profile, ctx.resolved), { mode: 0o600 });
      chmodSync(snapshot.target, 0o600);
      ctx.logger.info('config.rendered', `已生成 ${path.relative(ctx.root, snapshot.target)}（权限 0600）`);
      const applyCommands = spec.applyCommands ?? [];
      if (!applyCommands.length) return;
      if (!ctx.options.apply) return { deferred: true, reason: '已生成配置文件，未加 --apply，跳过写入系统路径' };
      await runCommands(ctx, 'config', applyCommands);
    },
    validate(ctx) {
      const spec = requireStage(ctx, 'config');
      const target = ctx.snapshots.config?.target ?? path.resolve(ctx.root, expandPath(ctx, spec.target));
      if (!existsSync(target)) throw new Error(`配置文件未生成：${path.relative(ctx.root, target)}`);
      const parsed = parseEnvFile(readFileSync(target, 'utf8'));
      const missing = (ctx.profile.config ?? [])
        .filter(entry => entry.required && parsed[entry.name] === undefined)
        .map(entry => entry.name);
      if (missing.length) throw new Error(`配置文件缺少必填项：${missing.join('、')}`);
      if (process.platform !== 'win32') {
        const mode = statSync(target).mode & 0o777;
        if (mode !== 0o600) throw new Error(`配置文件权限应为 0600，实际 ${mode.toString(8)}`);
      }
      return target;
    },
    async compensate(ctx, snapshot) {
      if (!snapshot?.target) return;
      const failures = [];
      for (const item of [snapshot.applied, snapshot].filter(Boolean)) {
        try {
          if (item.sudo) await privilegedConfigFile(ctx, 'restore', JSON.stringify(item));
          else restoreFile(item);
          ctx.logger.warn('config.restored', `已恢复配置原状态：${item.target}`);
        } catch (error) {
          if (error.detail?.terminationUnconfirmed) throw error;
          failures.push(`${item.target}：${error.message}；保留备份 ${item.backup ?? '(原文件不存在，应删除新文件)'}`);
        }
      }
      if (failures.length) throw new Error(`配置未完全回滚：${failures.join('；')}`);
    },
  },

  build: {
    id: 'build',
    title: '构建',
    async run(ctx) {
      const spec = requireStage(ctx, 'build');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不构建' };
      await runCommands(ctx, 'build', spec.commands ?? []);
    },
    validate(ctx) {
      return assertOutputs(ctx, 'build');
    },
    manualRollback: '构建产物由下一次构建覆盖；不单独回滚，避免留下与源码不一致的 dist。',
  },

  verify: {
    id: 'verify',
    title: '校验',
    async run(ctx) {
      const spec = requireStage(ctx, 'verify');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不执行校验' };
      await runCommands(ctx, 'verify', spec.commands ?? []);
    },
    validate(ctx) {
      return assertOutputs(ctx, 'verify');
    },
    manualRollback: '校验阶段只读，无需回滚。',
  },

  package: {
    id: 'package',
    title: '打包',
    async snapshot(ctx) {
      const spec = requireStage(ctx, 'package');
      const paths = releasePaths(ctx);
      const manifests = [...paths.manifests, paths.merged];
      const saved = [];
      for (const relative of manifests) {
        const target = path.resolve(ctx.root, relative);
        if (!existsSync(target)) {
          saved.push({ relative, target, backup: null, existed: false });
          continue;
        }
        const backup = path.join(ctx.paths.backupDir, `${saved.length}-${path.basename(relative)}.bak`);
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(target, backup);
        saved.push({ relative, target, backup, existed: true });
      }
      return { manifests: saved };
    },
    async run(ctx) {
      const spec = requireStage(ctx, 'package');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不打包' };
      if (!ctx.options.dryRun) {
        const paths = releasePaths(ctx);
        for (const file of [...paths.manifests, paths.merged]) rmSync(file, { force: true });
      }
      await runCommands(ctx, 'package', spec.commands ?? []);
    },
    validate(ctx) {
      assertOutputs(ctx, 'package');
      return validateRelease(ctx);
    },
    async compensate(ctx, snapshot) {
      for (const item of snapshot?.manifests ?? []) {
        if (item.existed && item.backup && existsSync(item.backup)) {
          copyFileSync(item.backup, item.target);
          ctx.logger.warn('package.restored', `已恢复上一份发布清单：${item.relative}`);
        } else if (!item.existed) {
          rmSync(item.target, { force: true });
        }
      }
    },
  },

  publish: {
    id: 'publish',
    title: '发布',
    manual: true,
    rollbackManual: true,
    async run(ctx) {
      const spec = requireStage(ctx, 'publish');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不发布' };
      if (spec.requiresConfirmation && ctx.trigger === 'manual' && !ctx.options.confirmProd) {
        return { deferred: true, reason: '手动发布需要 --confirm-prod' };
      }
      if (!ctx.options.dryRun) validateRelease(ctx);
      await runCommands(ctx, 'publish', spec.commands ?? []);
    },
    validate(ctx) {
      return validateRelease(ctx);
    },
    manualRollback: '远端 Release 不能由本地自动撤回：请在 GitHub 将上一正式版重新标记为 latest，并核对清单提交与 SHA-256。',
  },

  activate: {
    id: 'activate',
    title: '服务切换',
    manual: true,
    rollbackManual: true,
    async run(ctx) {
      const spec = requireStage(ctx, 'activate');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不切换服务' };
      if (spec.requiresApply && !ctx.options.apply) {
        return { deferred: true, reason: '需要 --apply 才会执行服务器切换' };
      }
      // 安装器只部署本轮提交：当前正式版不是它（未晋级或已被替换）时什么也不装，记为 deferred。
      const outcome = await runCommands(ctx, 'activate', spec.commands ?? [], { deferCode: spec.targetMismatchExitCode });
      if (outcome?.deferred) {
        return { deferred: true, targetUnavailable: true, reason: `当前正式版不是本轮提交 ${ctx.git.commit.slice(0, 12)}，未安装任何版本；晋级为正式版后重跑` };
      }
    },
    async validate(ctx) {
      await verifyActivation(ctx, { attempts: ctx.options.dryRun ? 1 : undefined });
      return [];
    },
    // 缓存只说明安装输入未变，不说明服务仍在运行本轮提交：命中缓存时仍须核验运行态。
    async revalidate(ctx) {
      await verifyActivation(ctx, { attempts: 1 });
    },
    manualRollback: '服务切换的回滚由安装器负责：保留的上一版本与部署记录可恢复旧程序、单元和配置；业务数据库写入不回滚。',
  },
};

/**
 * 激活结果核验：服务就绪，且安装器的部署记录（与在线更新读取的当前版本同源）
 * 等于本轮提交。生产配置探测 /api/ready：/api/health 只说明 API 存活，runtime 失联时仍是 200。
 * 就绪端点只返回 {ready}，不含版本；运行目录的 .source-sha 在内容未变时
 * 可以是更早的提交，不能代表已部署身份。
 */
export async function verifyActivation(ctx, { attempts } = {}) {
  const spec = requireStage(ctx, 'activate');
  if (spec.healthUrl) {
    await checkHealth(expandUrl(ctx, spec.healthUrl), {
      logger: ctx.logger, attempts: attempts ?? spec.healthAttempts ?? 30, intervalMs: spec.healthIntervalMs ?? 2000,
    });
  }
  if (!spec.deployedRecord) return;
  const deployed = readDeployedCommit(spec.deployedRecord);
  if (deployed !== ctx.git.commit) {
    throw new Error(`部署记录显示当前版本 ${deployed.slice(0, 12)}，不是本轮提交 ${ctx.git.commit.slice(0, 12)}：${spec.deployedRecord}`);
  }
  ctx.logger.info('activate.identity', `部署记录与本轮提交一致：${deployed.slice(0, 12)}`);
}

export function readDeployedCommit(file) {
  let text;
  try {
    if (!lstatSync(file).isFile()) throw new Error('不是普通文件');
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取部署记录 ${file}：${error.message}`);
  }
  const commit = text.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`部署记录缺少有效提交：${file}`);
  return commit;
}

export async function checkHealth(url, { logger, attempts = 30, intervalMs = 2000, fetchImpl = fetch } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        logger?.info('health.ok', `健康检查通过：${url}（第 ${attempt} 次）`);
        return true;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`健康检查失败：${url}（${attempts} 次，最后错误：${lastError?.message ?? '未知'}）`);
}
