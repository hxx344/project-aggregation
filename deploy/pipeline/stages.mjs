/**
 * 阶段实现：预检、依赖、配置、构建、校验、打包、发布、激活。
 *
 * 每个阶段提供 run（执行）、validate（校验点）、snapshot（回滚快照）。
 * 只有配置、打包两个阶段会自动回滚；发布与激活必须人工确认后处理，
 * 因为远端 Release 和服务器切换不能靠本地文件恢复。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { parseEnvFile, renderEnvFile } from './config.mjs';
import { formatInvocation, probeVersion } from './exec.mjs';
import { hashFile } from './digest.mjs';

const TOOLCHAIN_COMMANDS = new Set(['git', 'bash', 'python3', 'python', 'sudo']);

export function expandPath(ctx, template) {
  return template.replaceAll('{env}', ctx.env);
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

async function runCommands(ctx, id, commands) {
  for (const [index, command] of commands.entries()) {
    const result = await ctx.exec(command, id);
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
    if (result.code !== 0) {
      const tail = result.tail ? `\n${result.tail}` : '';
      throw new Error(`命令失败（退出码 ${result.code}）：${line}${tail}`);
    }
    ctx.logger.info('command.ok', `完成：${line}`, { durationMs: result.durationMs });
  }
}

function assertOutputs(ctx, id) {
  const outputs = requireStage(ctx, id).outputs ?? [];
  const missing = outputs.filter(relative => {
    const absolute = path.resolve(ctx.root, relative);
    return !existsSync(absolute) || !statSync(absolute).isFile() || statSync(absolute).size === 0;
  });
  if (missing.length) throw new Error(`阶段 ${id} 缺少产物：${missing.join('、')}`);
  return outputs;
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
          await probeVersion(command, { platform: ctx.platform, npmExecPath: ctx.npmExecPath });
        } catch {
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
      const target = path.resolve(ctx.root, expandPath(ctx, requireStage(ctx, 'config').target));
      const backup = existsSync(target) ? path.join(ctx.paths.backupDir, `${ctx.env}-${Date.now()}.env`) : null;
      if (backup) {
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(target, backup);
      }
      return { target, backup, existed: Boolean(backup) };
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
      writeFileSync(snapshot.target, renderEnvFile(ctx.profile, ctx.resolved));
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
      if (snapshot.existed && snapshot.backup && existsSync(snapshot.backup)) {
        copyFileSync(snapshot.backup, snapshot.target);
        chmodSync(snapshot.target, 0o600);
        ctx.logger.warn('config.restored', `已恢复上一份配置：${path.relative(ctx.root, snapshot.target)}`);
        return;
      }
      rmSync(snapshot.target, { force: true });
      ctx.logger.warn('config.removed', `已移除本次生成的配置：${path.relative(ctx.root, snapshot.target)}`);
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
      const manifests = (spec.outputs ?? []).filter(item => item.endsWith('.json'));
      const saved = [];
      for (const relative of manifests) {
        const target = path.resolve(ctx.root, relative);
        if (!existsSync(target)) {
          saved.push({ relative, target, backup: null, existed: false });
          continue;
        }
        const backup = path.join(ctx.paths.backupDir, `${path.basename(relative)}.${Date.now()}.bak`);
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(target, backup);
        saved.push({ relative, target, backup, existed: true });
      }
      return { manifests: saved };
    },
    async run(ctx) {
      const spec = requireStage(ctx, 'package');
      if (spec.enabled === false) return { deferred: true, reason: '本环境不打包' };
      await runCommands(ctx, 'package', spec.commands ?? []);
    },
    validate(ctx) {
      const outputs = assertOutputs(ctx, 'package');
      const manifestPath = outputs.find(item => item.endsWith('.json'));
      if (!manifestPath) return outputs;
      const manifest = JSON.parse(readFileSync(path.resolve(ctx.root, manifestPath), 'utf8'));
      if (ctx.git.commit && manifest.commit !== ctx.git.commit) {
        throw new Error(`发布清单提交 ${String(manifest.commit).slice(0, 12)} 与当前提交 ${ctx.git.commit.slice(0, 12)} 不一致`);
      }
      const artifact = manifest.artifact ?? {};
      if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? ''))) throw new Error('发布清单缺少有效的 SHA-256');
      const artifactPath = path.join(path.dirname(path.resolve(ctx.root, manifestPath)), artifact.file ?? '');
      if (!artifact.file || !existsSync(artifactPath)) throw new Error(`发布包缺失：${artifact.file ?? '(未声明)'}`);
      return outputs;
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
      await runCommands(ctx, 'publish', spec.commands ?? []);
    },
    validate(ctx) {
      const packageSpec = ctx.profile.stages?.package;
      const manifestPath = (packageSpec?.outputs ?? []).find(item => item.endsWith('.json'));
      if (!manifestPath) return [];
      const absolute = path.resolve(ctx.root, expandPath(ctx, manifestPath));
      if (!existsSync(absolute)) throw new Error(`发布前缺少打包清单：${manifestPath}`);
      const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
      if (!String(manifest.tag ?? '').startsWith('deploy-')) throw new Error(`发布清单标签不是 deploy-*：${manifest.tag ?? '(缺失)'}`);
      if (ctx.git.commit && manifest.commit !== ctx.git.commit) {
        throw new Error(`发布清单提交 ${String(manifest.commit).slice(0, 12)} 与当前提交 ${ctx.git.commit.slice(0, 12)} 不一致`);
      }
      return [manifestPath];
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
      await runCommands(ctx, 'activate', spec.commands ?? []);
    },
    async validate(ctx) {
      const spec = requireStage(ctx, 'activate');
      if (!spec.healthUrl) return [];
      await checkHealth(expandUrl(ctx, spec.healthUrl), { logger: ctx.logger, attempts: ctx.options.dryRun ? 1 : 30 });
      return [];
    },
    manualRollback: '服务切换的回滚由安装器负责：保留的上一版本与部署记录可恢复旧程序、单元和配置；业务数据库写入不回滚。',
  },
};

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
