/**
 * 环境配置：继承、解析、校验与指纹。
 *
 * 分工：
 * - deploy/pipeline/environments/*.json 保存非敏感声明（类型、默认值、阶段命令、触发守卫）。
 * - 敏感值只从进程环境或 .env.<env> 读取，不进入仓库、日志与指纹明文。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_IDS, PIPELINE_VERSION, STAGE_ORDER, TRIGGER_IDS } from './constants.mjs';

const VALUE_TYPES = new Set(['string', 'port', 'integer', 'boolean', 'url', 'path', 'enum']);
const GUARD_KEYS = new Set(['branch', 'requireClean', 'tagPattern', 'requireConfirmation']);
const STAGE_KEYS = new Set(['enabled', 'commands', 'applyCommands', 'inputs', 'outputs', 'frozen', 'target', 'applyTarget', 'applyWithSudo', 'architectures', 'releaseDirectory', 'healthUrl', 'healthAttempts', 'healthIntervalMs', 'deployedRecord', 'targetMismatchExitCode', 'requiresConfirmation', 'requiresApply', 'description']);
const CONFIG_KEYS = new Set(['name', 'type', 'required', 'secret', 'default', 'values', 'pattern', 'minLength', 'maxLength', 'min', 'max', 'absolute', 'description']);

export class ConfigError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function environmentDirectory(root) {
  return path.join(root, 'deploy', 'pipeline', 'environments');
}

/** 读取环境配置并展开 extends 链，返回合并后的完整声明。 */
export function loadProfile(root, envId) {
  if (!ENV_IDS.includes(envId)) throw new ConfigError(`未知环境：${envId}（可用：${ENV_IDS.join('、')}）`);
  const directory = environmentDirectory(root);
  const chain = [];
  const seen = new Set();
  let current = envId;
  while (current) {
    if (seen.has(current)) throw new ConfigError(`环境配置循环继承：${[...seen, current].join(' -> ')}`);
    seen.add(current);
    const file = path.join(directory, `${current}.json`);
    if (!existsSync(file)) throw new ConfigError(`缺少环境配置：${path.relative(root, file)}`);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new ConfigError(`环境配置不是合法 JSON：${path.relative(root, file)}（${error.message}）`);
    }
    chain.unshift({ id: current, file, data });
    current = typeof data.extends === 'string' ? data.extends : null;
    if (chain.length > 4) throw new ConfigError('环境配置继承层级过深，最多 4 层');
  }

  let merged = chain[0].data;
  for (const entry of chain.slice(1)) merged = mergeProfiles(merged, entry.data);
  merged = { ...merged, id: envId, file: chain.at(-1).file, inherits: chain.slice(0, -1).map(entry => entry.id) };
  validateProfile(merged, envId);
  return merged;
}

/** 子配置按字段覆盖父配置；配置项与阶段按名称/ID 合并，命令与输入整体替换。 */
export function mergeProfiles(base, child) {
  return {
    ...base,
    ...child,
    toolchain: { ...base.toolchain, ...child.toolchain },
    guards: { ...base.guards, ...child.guards },
    triggers: child.triggers ? { ...child.triggers } : (base.triggers ?? {}),
    config: mergeEntries(base.config, child.config, 'name'),
    stages: mergeEntries(base.stages, child.stages, 'id'),
  };
}

function mergeEntries(base = [], child = [], key) {
  if (Array.isArray(base) || Array.isArray(child)) {
    const merged = new Map((base ?? []).map(entry => [entry[key], { ...entry }]));
    for (const entry of child ?? []) merged.set(entry[key], { ...(merged.get(entry[key]) ?? {}), ...entry });
    return [...merged.values()];
  }
  const merged = {};
  for (const [id, value] of Object.entries(base ?? {})) merged[id] = { ...value };
  for (const [id, value] of Object.entries(child ?? {})) merged[id] = { ...(merged[id] ?? {}), ...value };
  return merged;
}

function validateProfile(profile, envId) {
  const issues = [];
  const fail = (where, message) => issues.push(`${where}：${message}`);

  if (profile.schema !== 1) fail('schema', '必须为 1');
  if (typeof profile.description !== 'string' || !profile.description) fail('description', '必须说明环境用途');

  const toolchain = profile.toolchain ?? {};
  if (typeof toolchain.node !== 'string' || !toolchain.node) fail('toolchain.node', '必须声明 Node 版本要求');
  if (typeof toolchain.pnpm !== 'string' || !toolchain.pnpm) fail('toolchain.pnpm', '必须声明 pnpm 版本要求');

  const triggers = profile.triggers ?? {};
  if (!Object.keys(triggers).length) fail('triggers', '至少声明一个触发条件');
  for (const [trigger, value] of Object.entries(triggers)) {
    if (!TRIGGER_IDS.includes(trigger)) fail(`triggers.${trigger}`, `未知触发条件（可用：${TRIGGER_IDS.join('、')}）`);
    for (const key of Object.keys(value?.guards ?? {})) {
      if (!GUARD_KEYS.has(key)) fail(`triggers.${trigger}.guards.${key}`, '未知守卫字段');
    }
  }

  const stages = profile.stages ?? {};
  for (const [id, stage] of Object.entries(stages)) {
    if (!STAGE_ORDER.includes(id)) fail(`stages.${id}`, `未知阶段（可用：${STAGE_ORDER.join('、')}）`);
    for (const key of Object.keys(stage)) if (!STAGE_KEYS.has(key)) fail(`stages.${id}.${key}`, '未知阶段字段');
    for (const list of ['commands', 'applyCommands']) {
      if (stage[list] !== undefined && !Array.isArray(stage[list])) fail(`stages.${id}.${list}`, '必须为数组');
      for (const [index, command] of (stage[list] ?? []).entries()) {
        if (typeof command?.cmd !== 'string' || !command.cmd) fail(`stages.${id}.${list}[${index}].cmd`, '必须为可执行文件名');
        if (command?.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string'))) {
          fail(`stages.${id}.${list}[${index}].args`, '必须为字符串数组');
        }
        if (command?.timeoutMs !== undefined && (!Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0)) {
          fail(`stages.${id}.${list}[${index}].timeoutMs`, '必须为正整数毫秒');
        }
        if (command?.privileged !== undefined && typeof command.privileged !== 'boolean') {
          fail(`stages.${id}.${list}[${index}].privileged`, '必须为布尔值');
        }
      }
    }
    for (const list of ['inputs', 'outputs']) {
      if (stage[list] !== undefined && (!Array.isArray(stage[list]) || stage[list].some(item => typeof item !== 'string' || !item))) {
        fail(`stages.${id}.${list}`, '必须为非空字符串数组');
      }
    }
    if (stage.enabled !== undefined && typeof stage.enabled !== 'boolean') fail(`stages.${id}.enabled`, '必须为布尔值');
    if (stage.applyWithSudo !== undefined && typeof stage.applyWithSudo !== 'boolean') fail(`stages.${id}.applyWithSudo`, '必须为布尔值');
    if (stage.applyCommands?.length) {
      if (typeof stage.applyTarget !== 'string' || !path.isAbsolute(stage.applyTarget)) fail(`stages.${id}.applyTarget`, '必须声明实际写入的绝对路径');
      if (!stage.applyCommands.some(command => command.args?.includes('{applyTarget}'))) fail(`stages.${id}.applyCommands`, '必须引用 {applyTarget}');
    }
    for (const key of ['healthAttempts', 'healthIntervalMs']) {
      if (stage[key] !== undefined && (!Number.isInteger(stage[key]) || stage[key] <= 0)) fail(`stages.${id}.${key}`, '必须为正整数');
    }
    if (stage.targetMismatchExitCode !== undefined && (!Number.isInteger(stage.targetMismatchExitCode)
      || stage.targetMismatchExitCode < 2 || stage.targetMismatchExitCode > 125)) fail(`stages.${id}.targetMismatchExitCode`, '必须为 2–125 的整数');
    // 激活必须绑定本轮提交：命令传入 {commit}，并核对安装器的部署记录。
    if (id === 'activate' && stage.enabled !== false && stage.commands?.length) {
      if (!stage.commands.some(command => command.args?.includes('{commit}'))) fail('stages.activate.commands', '必须以 {commit} 传入本轮目标提交');
      if (typeof stage.deployedRecord !== 'string' || !path.isAbsolute(stage.deployedRecord)) fail('stages.activate.deployedRecord', '必须声明安装器部署记录的绝对路径');
    }
    if (id === 'package' && stage.enabled !== false) {
      if (!Array.isArray(stage.architectures) || !stage.architectures.length
        || stage.architectures.some(arch => !['x64', 'arm64'].includes(arch))
        || new Set(stage.architectures).size !== stage.architectures.length) fail('stages.package.architectures', '必须声明不重复的 x64/arm64 目标架构');
      if (typeof stage.releaseDirectory !== 'string' || !stage.releaseDirectory) fail('stages.package.releaseDirectory', '必须声明发布产物目录');
    }
  }

  const names = new Set();
  for (const [index, entry] of (profile.config ?? []).entries()) {
    const where = `config[${index}]`;
    if (typeof entry?.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry.name)) fail(`${where}.name`, '必须为大写环境变量名');
    if (names.has(entry.name)) fail(`${where}.name`, `重复定义 ${entry.name}`);
    names.add(entry.name);
    for (const key of Object.keys(entry)) if (!CONFIG_KEYS.has(key)) fail(`${where}.${key}`, '未知配置字段');
    if (!VALUE_TYPES.has(entry.type)) fail(`${where}.type`, `未知类型（可用：${[...VALUE_TYPES].join('、')}）`);
    if (entry.type === 'enum' && (!Array.isArray(entry.values) || !entry.values.length)) fail(`${where}.values`, '枚举必须声明候选值');
    if (entry.pattern !== undefined) {
      try {
        new RegExp(entry.pattern);
      } catch (error) {
        fail(`${where}.pattern`, `正则无效：${error.message}`);
      }
    }
    if (entry.default !== undefined && entry.default !== null) {
      const checked = coerceValue(entry, entry.default);
      if (!checked.ok) fail(`${where}.default`, checked.message);
    }
  }

  if (issues.length) throw new ConfigError(`环境 ${envId} 配置无效（${issues.length} 项）`, issues);
  return profile;
}

/** 读取 KEY=VALUE 形式的环境文件；支持注释、export 前缀与成对引号。 */
export function parseEnvFile(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * 按声明顺序解析配置值：进程环境 > .env 文件 > 默认值。
 * 返回 issues 而不是抛错，便于一次列出所有缺失项（只列名称，不输出值）。
 */
export function resolveConfig(profile, { env = process.env, fileValues = {} } = {}) {
  const values = {};
  const sources = {};
  const secretNames = new Set();
  const issues = [];
  for (const entry of profile.config ?? []) {
    if (entry.secret) secretNames.add(entry.name);
    let raw;
    let source = 'missing';
    if (env[entry.name] !== undefined && env[entry.name] !== '') {
      raw = env[entry.name];
      source = 'env';
    } else if (fileValues[entry.name] !== undefined && fileValues[entry.name] !== '') {
      raw = fileValues[entry.name];
      source = 'file';
    } else if (entry.default !== undefined && entry.default !== null) {
      raw = entry.default;
      source = 'default';
    }
    sources[entry.name] = source;
    if (source === 'missing') {
      if (entry.required) issues.push({ name: entry.name, message: `缺少必填配置${entry.secret ? '（敏感值请通过环境变量或 .env.' + profile.id + ' 提供）' : ''}` });
      continue;
    }
    const checked = coerceValue(entry, raw);
    if (!checked.ok) {
      issues.push({ name: entry.name, message: checked.message });
      continue;
    }
    values[entry.name] = checked.value;
  }
  return { values, sources, secretNames, issues };
}

function coerceValue(entry, raw) {
  const invalid = message => ({ ok: false, message });
  switch (entry.type) {
    case 'string': {
      const value = String(raw);
      if (entry.minLength !== undefined && value.length < entry.minLength) return invalid(`长度不能小于 ${entry.minLength}`);
      if (entry.maxLength !== undefined && value.length > entry.maxLength) return invalid(`长度不能大于 ${entry.maxLength}`);
      if (entry.pattern && !new RegExp(entry.pattern).test(value)) return invalid(`不匹配 ${entry.pattern}`);
      return { ok: true, value };
    }
    case 'port': {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65535) return invalid('必须为 1-65535 的整数');
      return { ok: true, value };
    }
    case 'integer': {
      const value = Number(raw);
      if (!Number.isInteger(value)) return invalid('必须为整数');
      if (entry.min !== undefined && value < entry.min) return invalid(`不能小于 ${entry.min}`);
      if (entry.max !== undefined && value > entry.max) return invalid(`不能大于 ${entry.max}`);
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const text = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(text)) return { ok: true, value: false };
      return invalid('必须为 true/false');
    }
    case 'url': {
      try {
        const url = new URL(String(raw));
        if (!['http:', 'https:'].includes(url.protocol)) return invalid('必须为 http 或 https 地址');
        return { ok: true, value: url.origin };
      } catch {
        return invalid('不是合法 URL');
      }
    }
    case 'path': {
      const value = String(raw);
      if (!value.trim()) return invalid('不能为空');
      if (entry.absolute && !path.isAbsolute(value)) return invalid('必须为绝对路径');
      return { ok: true, value };
    }
    case 'enum': {
      const value = String(raw);
      if (!entry.values.includes(value)) return invalid(`必须为 ${entry.values.join(' / ')}`);
      return { ok: true, value };
    }
    default:
      return invalid(`未知类型 ${entry.type}`);
  }
}

/** 生成可复现的 dotenv 内容：顺序固定、无时间戳，敏感值只在运行时写入。 */
export function renderEnvFile(profile, resolved) {
  const lines = [`# 由 deploy/pipeline 生成，环境 ${profile.id}；请勿手工编辑`, '# 敏感值来自运行环境，不写入版本库'];
  for (const entry of [...(profile.config ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    if (resolved.values[entry.name] === undefined) {
      lines.push(`# ${entry.name} 未设置`);
      continue;
    }
    lines.push(`${entry.name}=${formatEnvValue(resolved.values[entry.name])}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatEnvValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

/** 非敏感配置指纹：决定构建与校验缓存是否可复用。 */
export function configFingerprint(profile, resolved, toolchain) {
  const schema = (profile.config ?? []).map(entry => ({
    name: entry.name,
    type: entry.type,
    required: Boolean(entry.required),
    secret: Boolean(entry.secret),
    default: entry.default ?? null,
    values: entry.values ?? null,
    minLength: entry.minLength ?? null,
    maxLength: entry.maxLength ?? null,
    pattern: entry.pattern ?? null,
    absolute: Boolean(entry.absolute),
  }));
  const publicValues = Object.fromEntries(
    Object.entries(resolved.values).filter(([name]) => !resolved.secretNames.has(name)).sort(([a], [b]) => a.localeCompare(b)),
  );
  return sha256(JSON.stringify({ version: PIPELINE_VERSION, env: profile.id, schema, values: publicValues, toolchain }));
}

/** 敏感值指纹：只用于判断配置阶段是否需要重新渲染，不写入日志或状态文件。 */
export function secretFingerprint(resolved) {
  const entries = Object.entries(resolved.values)
    .filter(([name]) => resolved.secretNames.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256(JSON.stringify(entries));
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
