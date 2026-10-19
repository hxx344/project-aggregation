#!/usr/bin/env node
/**
 * 自动化环境配置与部署流水线入口。
 *
 * 用法：
 *   node deploy/pipeline/cli.mjs plan   --env prod --trigger manual
 *   node deploy/pipeline/cli.mjs run    --env dev
 *   node deploy/pipeline/cli.mjs run    --env prod --trigger release --confirm-prod
 *   node deploy/pipeline/cli.mjs status --env prod
 *   node deploy/pipeline/cli.mjs rollback --env prod --run <runId> --yes
 *
 * 退出码：0 成功；1 阶段失败；2 参数或配置错误；3 触发条件不满足；4 环境锁被占用。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadProfile, parseEnvFile, resolveConfig, configFingerprint, secretFingerprint } from './config.mjs';
import { ENV_IDS, STATUS, STAGE_ORDER } from './constants.mjs';
import { snapshotOutputs } from './digest.mjs';
import { CommandError, probeVersion, runCommand } from './exec.mjs';
import { createLogger } from './logger.mjs';
import { buildPlan, computeInputKey, evaluateGuards, planRollback, shouldSkip } from './plan.mjs';
import { STAGES, expandPath } from './stages.mjs';
import { LockError, acquireLock, appendJournal, readJournal, readState, writeState } from './state.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_TRIGGER = { dev: 'local', test: 'manual', prod: 'manual' };

function usage() {
  return [
    '用法：node deploy/pipeline/cli.mjs <plan|run|status|config|rollback> [选项]',
    '',
    '选项：',
    '  --env <dev|test|prod>   目标环境，默认 dev',
    '  --trigger <条件>        local | pull_request | push | release | manual',
    '  --from <阶段>           从指定阶段开始（含）',
    '  --to <阶段>             到指定阶段结束（含）',
    '  --only <阶段,...>       只执行列出的阶段',
    '  --skip <阶段,...>       跳过列出的阶段',
    '  --force                 忽略历史状态，强制重跑',
    '  --dry-run               只打印计划与命令，不执行',
    '  --apply                 允许写入系统配置并执行服务切换',
    '  --confirm-prod          生产发布的显式确认',
    '  --allow-dirty           开发环境允许脏工作树',
    '  --echo                  实时输出命令日志',
    '  --json                  plan 输出 JSON',
    '  --run <runId>           rollback 指定运行记录',
    '  --yes                   rollback 确认执行',
    '',
    `阶段顺序：${STAGE_ORDER.join(' -> ')}`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : null,
    env: 'dev', trigger: null, from: null, to: null, only: [], skip: [],
    force: false, dryRun: false, apply: false, confirmProd: false, allowDirty: false,
    echo: false, json: false, run: null, yes: false,
  };
  const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
  for (let index = options.command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ConfigError(`${arg} 缺少参数值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--env': options.env = next(); break;
      case '--trigger': options.trigger = next(); break;
      case '--from': options.from = next(); break;
      case '--to': options.to = next(); break;
      case '--only': options.only.push(...list(next())); break;
      case '--skip': options.skip.push(...list(next())); break;
      case '--run': options.run = next(); break;
      case '--force': options.force = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--apply': options.apply = true; break;
      case '--confirm-prod': options.confirmProd = true; break;
      case '--allow-dirty': options.allowDirty = true; break;
      case '--echo': options.echo = true; break;
      case '--json': options.json = true; break;
      case '--yes': options.yes = true; break;
      case '-h': case '--help': options.command = 'help'; break;
      default: throw new ConfigError(`未知参数：${arg}`);
    }
  }
  if (!ENV_IDS.includes(options.env)) throw new ConfigError(`未知环境：${options.env}`);
  options.trigger ??= DEFAULT_TRIGGER[options.env];
  return options;
}

function gitContext(root) {
  const run = args => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  return {
    commit: run(['rev-parse', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    tag: run(['describe', '--tags', '--exact-match']),
    dirty: Boolean(run(['status', '--porcelain'])),
  };
}

function readEnvFile(root, env) {
  const file = path.join(root, `.env.${env}`);
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
}

function createRunId(git) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${stamp}-${(git.commit || 'nogit').slice(0, 8)}-${randomBytes(2).toString('hex')}`;
}

async function createContext(root, options, { runId, state }) {
  const profile = loadProfile(root, options.env);
  const resolved = resolveConfig(profile, { env: process.env, fileValues: readEnvFile(root, options.env) });
  const git = gitContext(root);
  const toolchain = {
    node: process.versions.node,
    pnpm: await probeVersion('pnpm', { platform: process.platform }).catch(() => 'unknown'),
  };
  const pipelineDir = path.join(root, '.pipeline');
  const runDir = path.join(pipelineDir, 'runs', runId);
  const paths = {
    pipelineDir,
    runDir,
    logsDir: path.join(runDir, 'logs'),
    backupDir: path.join(runDir, 'backups'),
    stateFile: path.join(pipelineDir, 'state', `${options.env}.json`),
    lockFile: path.join(pipelineDir, 'locks', `${options.env}.lock`),
  };
  const secretValues = [...resolved.secretNames].map(name => resolved.values[name]).filter(Boolean);
  const childEnv = { ...process.env, PIPELINE_ENV: options.env, PIPELINE_RUN_ID: runId, PIPELINE_COMMIT: git.commit };
  for (const [name, value] of Object.entries(resolved.values)) childEnv[name] = String(value);

  const context = {
    root,
    env: options.env,
    profile,
    resolved,
    git,
    toolchain,
    runId,
    logger: null,
    state,
    options,
    paths,
    platform: process.platform,
    npmExecPath: process.env.npm_execpath,
    configFingerprint: configFingerprint(profile, resolved, toolchain),
    secretFingerprint: secretFingerprint(resolved),
    snapshots: {},
    journal: record => appendJournal(path.join(runDir, 'journal.jsonl'), { ts: new Date().toISOString(), runId, env: options.env, ...record }),
    exec: (command, stageId) => runCommand({
      command,
      cwd: root,
      env: childEnv,
      timeoutMs: command.timeoutMs,
      logFile: path.join(paths.logsDir, `${stageId}.log`),
      dryRun: options.dryRun,
      echo: options.echo,
      platform: process.platform,
      redact: secretValues,
    }),
  };
  // 日志本身也要脱敏：logger 构造时传入敏感值，后续 child 继承。
  context.logger = createLogger({
    runId, env: options.env, directory: runDir, secrets: secretValues, out: process.stdout,
  });
  return context;
}

function summarise(plan, results) {
  const lines = [];
  for (const item of plan) {
    const record = results[item.id];
    if (!record) continue;
    const seconds = record.durationMs === undefined ? '' : `${(record.durationMs / 1000).toFixed(1)}s`;
    lines.push(`  ${item.id.padEnd(9)} ${record.status.padEnd(9)} ${seconds.padStart(8)}  ${record.reason ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}

async function commandPlan(root, options) {
  const profile = loadProfile(root, options.env);
  const resolved = resolveConfig(profile, { env: process.env, fileValues: readEnvFile(root, options.env) });
  const git = gitContext(root);
  const violations = evaluateGuards({ profile, trigger: options.trigger, git, options });
  const plan = buildPlan({ profile, options });
  const output = {
    env: options.env,
    trigger: options.trigger,
    commit: git.commit,
    branch: git.branch,
    dirty: git.dirty,
    guards: { ok: violations.length === 0, violations },
    config: {
      issues: resolved.issues,
      values: Object.fromEntries(Object.entries(resolved.values).map(([name, value]) => [name, resolved.secretNames.has(name) ? '***' : value])),
      sources: resolved.sources,
    },
    stages: plan,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`环境 ${options.env}（${profile.description}）\n`);
    process.stdout.write(`触发 ${options.trigger}｜分支 ${git.branch || '-'}｜提交 ${git.commit.slice(0, 12) || '-'}${git.dirty ? '｜工作树有改动' : ''}\n`);
    if (violations.length) {
      process.stdout.write('触发条件未满足：\n');
      for (const violation of violations) process.stdout.write(`  - ${violation}\n`);
    }
    for (const [index, stage] of plan.entries()) {
      const detail = stage.commands.length ? stage.commands.join(' && ') : stage.reason ?? '';
      process.stdout.write(`  ${index + 1}. ${stage.id.padEnd(9)} ${stage.enabled ? '执行' : '跳过'}  ${detail}\n`);
    }
    if (resolved.issues.length) {
      process.stdout.write('配置问题：\n');
      for (const issue of resolved.issues) process.stdout.write(`  - ${issue.name}: ${issue.message}\n`);
    }
  }
  return violations.length ? 3 : 0;
}

async function commandConfig(root, options) {
  const profile = loadProfile(root, options.env);
  const resolved = resolveConfig(profile, { env: process.env, fileValues: readEnvFile(root, options.env) });
  const toolchain = { node: process.versions.node, pnpm: await probeVersion('pnpm', { platform: process.platform }).catch(() => 'unknown') };
  const rows = (profile.config ?? []).map(entry => ({
    name: entry.name,
    type: entry.type,
    required: Boolean(entry.required),
    secret: Boolean(entry.secret),
    source: resolved.sources[entry.name],
    value: entry.secret ? (resolved.values[entry.name] === undefined ? '(未设置)' : '***') : (resolved.values[entry.name] ?? '(未设置)'),
  }));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ env: options.env, configFingerprint: configFingerprint(profile, resolved, toolchain), rows, issues: resolved.issues }, null, 2)}\n`);
  } else {
    process.stdout.write(`环境 ${options.env} 配置（来源：env > .env.${options.env} > 默认值）\n`);
    for (const row of rows) {
      process.stdout.write(`  ${row.name.padEnd(20)} ${row.type.padEnd(8)} ${(row.source ?? 'missing').padEnd(8)} ${row.value}\n`);
    }
    if (resolved.issues.length) {
      process.stdout.write('配置问题：\n');
      for (const issue of resolved.issues) process.stdout.write(`  - ${issue.name}: ${issue.message}\n`);
    }
  }
  return resolved.issues.length ? 2 : 0;
}

async function commandStatus(root, options) {
  const profile = loadProfile(root, options.env);
  const state = readState(path.join(root, '.pipeline', 'state', `${options.env}.json`), options.env);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ env: options.env, profile: profile.id, state }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`环境 ${options.env} 最近运行：${state.lastRunId ?? '(无)'}｜提交 ${String(state.commit ?? '-').slice(0, 12)}\n`);
  for (const id of STAGE_ORDER) {
    const record = state.stages?.[id];
    if (!record) continue;
    process.stdout.write(`  ${id.padEnd(9)} ${String(record.status).padEnd(9)} ${record.finishedAt ?? ''}  ${record.runId ?? ''}\n`);
  }
  return 0;
}

async function commandRun(root, options) {
  const profile = loadProfile(root, options.env);
  const runId = createRunId(gitContext(root));
  const stateFile = path.join(root, '.pipeline', 'state', `${options.env}.json`);
  const state = readState(stateFile, options.env);
  const placeholder = { runId, env: options.env, directory: path.join(root, '.pipeline', 'runs', runId), secrets: [], out: process.stdout };
  const logger = createLogger(placeholder);
  let lock;
  try {
    lock = acquireLock(path.join(root, '.pipeline', 'locks', `${options.env}.lock`), { runId });
  } catch (error) {
    if (error instanceof LockError) {
      logger.error('lock.busy', error.message);
      return 4;
    }
    throw error;
  }

  const startedAt = Date.now();
  let context;
  try {
    context = await createContext(root, options, { runId, logger, state });
    const { resolved, git, profile: loaded } = context;
    context.logger.info('run.start', `环境 ${options.env}｜触发 ${options.trigger}｜提交 ${git.commit.slice(0, 12) || '-'}${git.dirty ? '｜工作树有改动' : ''}`);
    context.journal({ type: 'run.start', trigger: options.trigger, commit: git.commit, branch: git.branch, dirty: git.dirty, configFingerprint: context.configFingerprint, toolchain: context.toolchain, options: { ...options, only: options.only, skip: options.skip } });

    const violations = evaluateGuards({ profile: loaded, trigger: options.trigger, git, options });
    if (violations.length) {
      for (const violation of violations) context.logger.error('guard.failed', violation);
      context.journal({ type: 'run.end', status: 'guard-failed', violations });
      return 3;
    }
    if (resolved.issues.length) {
      for (const issue of resolved.issues) context.logger.error('config.invalid', `${issue.name}：${issue.message}`);
      context.journal({ type: 'run.end', status: 'config-invalid', issues: resolved.issues.map(issue => issue.name) });
      return 2;
    }

    const plan = buildPlan({ profile: loaded, options });
    const results = {};
    const executed = [];
    let failed = false;

    for (const item of plan) {
      const definition = STAGES[item.id];
      const spec = loaded.stages[item.id];
      const stageLogger = context.logger.child({ stage: item.id });
      const stageContext = { ...context, logger: stageLogger };
      const stageStarted = Date.now();

      if (!item.enabled) {
        results[item.id] = { status: STATUS.deferred, reason: item.reason, durationMs: 0 };
        stageLogger.info('stage.deferred', item.reason);
        continue;
      }

      const inputKey = computeInputKey({
        root, stageId: item.id, profile: loaded, spec,
        configFingerprint: context.configFingerprint,
        secretFingerprint: context.secretFingerprint,
        git, toolchain: context.toolchain,
      });
      const outputs = snapshotOutputs(root, (spec.outputs ?? []).map(item => expandPath(context, item)));
      const decision = definition.alwaysRun
        ? { skip: false, reason: '每轮必跑' }
        : shouldSkip({ state: context.state, stageId: item.id, inputKey, root, outputs, force: options.force });

      if (decision.skip) {
        results[item.id] = { status: STATUS.skipped, reason: decision.reason, durationMs: 0 };
        stageLogger.info('stage.skipped', `跳过：${decision.reason}`);
        context.journal({ type: 'stage.skip', stage: item.id, reason: decision.reason, inputKey });
        continue;
      }

      stageLogger.info('stage.start', `开始：${item.title}${decision.reason ? `（${decision.reason}）` : ''}`);
      try {
        if (definition.snapshot) {
          const snapshot = await definition.snapshot(stageContext);
          context.snapshots[item.id] = snapshot;
          context.journal({ type: 'snapshot', stage: item.id, data: snapshot });
        }
        context.journal({ type: 'stage.start', stage: item.id, inputKey });
        const result = await definition.run(stageContext);
        if (result?.deferred) {
          results[item.id] = { status: STATUS.deferred, reason: result.reason, durationMs: Date.now() - stageStarted };
          stageLogger.warn('stage.deferred', result.reason);
          context.journal({ type: 'stage.deferred', stage: item.id, reason: result.reason });
          continue;
        }
        if (!options.dryRun && definition.validate) await definition.validate(stageContext, result);
        const durationMs = Date.now() - stageStarted;
        results[item.id] = { status: options.dryRun ? STATUS.planned : STATUS.ok, durationMs };
        if (!options.dryRun) {
          context.state.stages[item.id] = {
            status: STATUS.ok,
            inputKey,
            runId,
            finishedAt: new Date().toISOString(),
            durationMs,
            outputs: snapshotOutputs(root, (spec.outputs ?? []).map(entry => expandPath(context, entry))),
          };
          writeState(stateFile, { ...context.state, lastRunId: runId, commit: git.commit, configFingerprint: context.configFingerprint });
          executed.push(item.id);
        }
        context.journal({ type: 'stage.ok', stage: item.id, durationMs });
        stageLogger.info('stage.ok', `完成：${item.title}`, { durationMs });
      } catch (error) {
        failed = true;
        const durationMs = Date.now() - stageStarted;
        results[item.id] = { status: STATUS.failed, reason: error.message.split('\n')[0], durationMs };
        if (!options.dryRun) {
          context.state.stages[item.id] = { status: STATUS.failed, inputKey, runId, finishedAt: new Date().toISOString(), durationMs };
          writeState(stateFile, { ...context.state, lastRunId: runId, commit: git.commit, configFingerprint: context.configFingerprint });
        }
        stageLogger.error('stage.failed', `${item.title} 失败：${error.message}`, { durationMs });
        context.journal({ type: 'stage.failed', stage: item.id, message: error.message, durationMs });
        const rollbackTargets = definition.compensate ? [...executed, item.id] : executed;
        const { compensated } = await rollbackRun(context, rollbackTargets, { reason: `${item.id} 失败`, logger: stageLogger });
        for (const id of compensated) {
          if (id === item.id) continue;
          if (results[id]) results[id].status = STATUS.rolledBack;
          if (context.state.stages[id]) context.state.stages[id].status = STATUS.rolledBack;
        }
        if (compensated.length) writeState(stateFile, { ...context.state, lastRunId: runId, commit: git.commit, configFingerprint: context.configFingerprint });
        break;
      }
    }

    const status = failed ? 'failed' : options.dryRun ? 'planned' : 'ok';
    context.journal({ type: 'run.end', status, durationMs: Date.now() - startedAt });
    const summary = {
      runId, env: options.env, trigger: options.trigger, commit: git.commit, status,
      startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
      stages: results,
      configFingerprint: context.configFingerprint,
    };
    writeFileSync(path.join(context.paths.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    context.logger.info('run.end', `运行结束：${status}（${((Date.now() - startedAt) / 1000).toFixed(1)}s）\n${summarise(plan, results)}`);
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error('config.error', error.message);
      for (const issue of error.issues ?? []) logger.error('config.issue', issue);
      return 2;
    }
    if (error instanceof CommandError) {
      logger.error('command.error', error.message);
      return 1;
    }
    logger.error('run.error', error.stack ?? error.message);
    return 1;
  } finally {
    lock?.release();
  }
}

/** 失败回滚：只回滚本次已成功的阶段，逆序执行；人工阶段单独列出。 */
async function rollbackRun(context, executed, { reason, logger }) {
  const stages = [...executed].reverse();
  const manual = [];
  const compensated = [];
  for (const id of stages) {
    const definition = STAGES[id];
    const snapshot = context.snapshots[id];
    try {
      if (definition.compensate) {
        await definition.compensate(context, snapshot);
        compensated.push(id);
        context.journal({ type: 'rollback.ok', stage: id });
      } else if (definition.manualRollback) {
        manual.push({ stage: id, instruction: definition.manualRollback });
        context.journal({ type: 'rollback.manual', stage: id, instruction: definition.manualRollback });
      }
    } catch (error) {
      logger.error('rollback.failed', `回滚 ${id} 失败：${error.message}`);
      context.journal({ type: 'rollback.failed', stage: id, message: error.message });
    }
  }
  context.journal({ type: 'rollback.end', reason, stages, compensated, manual });
  if (manual.length) {
    logger.warn('rollback.manual', `以下阶段需要人工回滚：\n${manual.map(item => `  - ${item.stage}: ${item.instruction}`).join('\n')}`);
  }
  if (!stages.length) logger.warn('rollback.empty', '失败发生在首个可回滚阶段之前，没有需要恢复的本地状态');
  return { compensated, manual };
}

async function commandRollback(root, options) {
  const profile = loadProfile(root, options.env);
  const state = readState(path.join(root, '.pipeline', 'state', `${options.env}.json`), options.env);
  const runId = options.run ?? state.lastRunId;
  if (!runId) throw new ConfigError('没有可回滚的运行记录，请用 --run 指定 runId');
  const runDir = path.join(root, '.pipeline', 'runs', runId);
  const { records, invalid } = readJournal(path.join(runDir, 'journal.jsonl'));
  if (!records.length) throw new ConfigError(`运行记录为空或不存在：${runId}`);
  const plan = planRollback(records);
  if (invalid) process.stdout.write(`提醒：${invalid} 条日志无法解析，已忽略。\n`);
  if (!plan.length) {
    process.stdout.write(`运行 ${runId} 没有可回滚的阶段。\n`);
    return 0;
  }
  process.stdout.write(`回滚计划（${runId}，${options.env}）：\n`);
  for (const item of plan) {
    const action = item.definition.compensate ? '自动恢复' : '人工处理';
    process.stdout.write(`  ${item.stage.padEnd(9)} ${action}${item.definition.manualRollback ? `  ${item.definition.manualRollback}` : ''}\n`);
  }
  if (options.dryRun) return 0;
  if (!options.yes) {
    process.stdout.write('未执行：确认后加 --yes。\n');
    return 2;
  }

  const runLogger = createLogger({ runId, env: options.env, directory: runDir, secrets: [] });
  let lock;
  try {
    lock = acquireLock(path.join(root, '.pipeline', 'locks', `${options.env}.lock`), { runId: `${runId}-rollback` });
  } catch (error) {
    if (error instanceof LockError) {
      runLogger.error('lock.busy', error.message);
      return 4;
    }
    throw error;
  }
  try {
    const context = { root, env: options.env, profile, logger: runLogger, snapshots: {}, journal: record => appendJournal(path.join(runDir, 'journal.jsonl'), { ts: new Date().toISOString(), runId, env: options.env, ...record }) };
    for (const item of plan) {
      if (!item.definition.compensate) {
        runLogger.warn('rollback.manual', `${item.stage}：${item.definition.manualRollback}`);
        context.journal({ type: 'rollback.manual', stage: item.stage, instruction: item.definition.manualRollback });
        continue;
      }
      await item.definition.compensate(context, item.snapshot);
      context.journal({ type: 'rollback.ok', stage: item.stage });
      if (state.stages?.[item.stage]) state.stages[item.stage].status = STATUS.rolledBack;
      runLogger.info('rollback.ok', `已回滚 ${item.stage}`);
    }
    writeState(path.join(root, '.pipeline', 'state', `${options.env}.json`), state);
    runLogger.info('rollback.end', `回滚结束：${runId}`);
    return 0;
  } finally {
    lock.release();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (!options.command || options.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return options.command === 'help' ? 0 : 2;
  }
  try {
    switch (options.command) {
      case 'plan': return await commandPlan(ROOT, options);
      case 'config': return await commandConfig(ROOT, options);
      case 'status': return await commandStatus(ROOT, options);
      case 'run': return await commandRun(ROOT, options);
      case 'rollback': return await commandRollback(ROOT, options);
      default:
        process.stderr.write(`未知命令：${options.command}\n\n${usage()}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`配置错误：${error.message}\n`);
      for (const issue of error.issues ?? []) process.stderr.write(`  - ${issue}\n`);
      return 2;
    }
    process.stderr.write(`执行失败：${error.stack ?? error.message}\n`);
    return 1;
  }
}

process.exitCode = await main();
