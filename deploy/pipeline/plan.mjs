/** 触发条件、阶段计划与幂等键：决定「这次该不该跑、跑哪些、能不能跳过」。 */
import { PIPELINE_VERSION, STAGE_ORDER } from './constants.mjs';
import { ConfigError, sha256 } from './config.mjs';
import { hashPaths, outputsIntact } from './digest.mjs';
import { STAGES } from './stages.mjs';

/** 触发守卫：不满足条件时不执行任何阶段，避免在错误的分支或未确认状态下发布。 */
export function evaluateGuards({ profile, trigger, git, options = {} }) {
  const violations = [];
  const triggerSpec = profile.triggers?.[trigger];
  if (!triggerSpec) {
    violations.push(`环境 ${profile.id} 不接受触发条件 ${trigger}（允许：${Object.keys(profile.triggers ?? {}).join('、') || '无'}）`);
    return violations;
  }
  const guards = { ...(profile.guards ?? {}), ...(triggerSpec.guards ?? {}) };

  if (guards.branch && git.branch !== guards.branch) {
    violations.push(`触发条件 ${trigger} 要求分支 ${guards.branch}，当前 ${git.branch || '(游离 HEAD)'}`);
  }
  if (guards.requireClean && git.dirty) {
    if (options.allowDirty && profile.guards?.allowDirtyOverride) {
      // 本机开发允许脏工作树，但仍记录到日志，便于回溯构建来源。
    } else {
      violations.push('工作树存在未提交改动，构建产物无法对应到确定的提交');
    }
  }
  if (guards.tagPattern) {
    if (!git.tag) violations.push(`触发条件 ${trigger} 要求提交带 ${guards.tagPattern} 标签，当前提交没有标签`);
    else if (!matchPattern(guards.tagPattern, git.tag)) violations.push(`标签 ${git.tag} 不匹配 ${guards.tagPattern}`);
  }
  if (guards.requireConfirmation && !options.confirmProd) {
    violations.push(`环境 ${profile.id} 的 ${trigger} 触发需要显式确认（--confirm-prod）`);
  }
  return violations;
}

export function matchPattern(pattern, value) {
  const source = `^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
  return new RegExp(source).test(value);
}

/**
 * 计划只包含本环境声明过的阶段；--from/--to/--only/--skip 用于局部重跑，
 * 顺序始终按 STAGE_ORDER，不因参数顺序改变。
 */
export function buildPlan({ profile, options = {} }) {
  const declared = new Set(Object.keys(profile.stages ?? {}));
  const selected = STAGE_ORDER.filter(id => declared.has(id));
  const unknown = [...(options.only ?? []), ...(options.skip ?? []), options.from, options.to]
    .filter(Boolean)
    .filter(id => !STAGE_ORDER.includes(id));
  if (unknown.length) throw new ConfigError(`未知阶段参数：${[...new Set(unknown)].join('、')}（可用：${STAGE_ORDER.join('、')}）`);

  let ids = selected;
  if (options.from) {
    const index = ids.indexOf(options.from);
    if (index < 0) throw new ConfigError(`--from ${options.from} 不在本环境计划中`);
    ids = ids.slice(index);
  }
  if (options.to) {
    const index = ids.indexOf(options.to);
    if (index < 0) throw new ConfigError(`--to ${options.to} 不在本环境计划中`);
    ids = ids.slice(0, index + 1);
  }
  if (options.only?.length) ids = ids.filter(id => options.only.includes(id));
  if (options.skip?.length) ids = ids.filter(id => !options.skip.includes(id));

  return ids.map(id => {
    const spec = profile.stages[id];
    const enabled = spec.enabled !== false;
    return {
      id,
      title: STAGES[id].title,
      enabled,
      reason: enabled ? null : '本环境已禁用',
      commands: (spec.commands ?? []).map(command => [command.cmd, ...(command.args ?? [])].join(' ')),
    };
  });
}

/**
 * 幂等键：阶段声明、命令、输入内容、配置指纹、提交与工具链共同决定。
 * 任一变化都会使旧状态失效；敏感值单独进入配置阶段的键，避免轮换密钥触发全量重建。
 */
export function computeInputKey({ root, stageId, profile, spec, configFingerprint, secretFingerprint, git, toolchain }) {
  const inputs = hashPaths(root, spec.inputs ?? []);
  return sha256(JSON.stringify({
    version: PIPELINE_VERSION,
    stage: stageId,
    env: profile.id,
    spec,
    inputs,
    configFingerprint,
    secretFingerprint: stageId === 'config' ? secretFingerprint : null,
    commit: git.commit,
    toolchain,
  }));
}

/** 跳过条件必须同时满足：同键成功记录、产物仍完整、未被 --force 覆盖。 */
export function shouldSkip({ state, stageId, inputKey, root, outputPaths = [], force = false }) {
  if (force) return { skip: false, reason: '已指定 --force' };
  const record = state.stages?.[stageId];
  if (!record) return { skip: false, reason: '没有历史记录' };
  if (record.status !== 'ok') return { skip: false, reason: `上次状态为 ${record.status}` };
  if (record.inputKey !== inputKey) return { skip: false, reason: '输入或配置已变化' };
  if (!record.outputs || typeof record.outputs !== 'object' || Array.isArray(record.outputs)
    || outputPaths.some(file => !/^[a-f0-9]{64}$/.test(record.outputs[file] ?? ''))) {
    return { skip: false, reason: '缺少可信的成功产物摘要' };
  }
  if (!outputsIntact(root, record.outputs)) return { skip: false, reason: '产物缺失或已变化' };
  return { skip: true, reason: '输入与产物均未变化' };
}

/** 回滚顺序：按 journal 中成功阶段逆序，只处理声明了补偿动作的阶段。 */
export function planRollback(records) {
  const snapshots = new Map(records.filter(record => record.type === 'snapshot').map(record => [record.stage, record.data]));
  const succeeded = records.filter(record => record.type === 'stage.ok'
    || (record.type === 'stage.failed' && snapshots.has(record.stage))).map(record => record.stage);
  return [...new Set(succeeded)]
    .reverse()
    .map(stage => ({ stage, snapshot: snapshots.get(stage) ?? null, definition: STAGES[stage] }))
    .filter(item => item.definition?.compensate || item.definition?.rollbackManual);
}
