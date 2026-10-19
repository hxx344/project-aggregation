/**
 * 运行日志：控制台给操作者看，run.jsonl 给复盘与自动化读取。
 * 所有输出先脱敏；敏感值只以 *** 出现，命令的环境变量不落盘。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY = /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key)$/i;

export function createLogger({ runId, env, directory = null, secrets = [], out = process.stdout, now = () => new Date(), bound = {} }) {
  const secretValues = secrets.filter(value => typeof value === 'string' && value.length >= 4);
  let jsonl = null;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    jsonl = path.join(directory, 'run.jsonl');
  }

  const redactText = text => secretValues.reduce((result, secret) => result.split(secret).join('***'), String(text));

  const redactValue = value => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '***' : redactValue(item)]));
    }
    return value;
  };

  const write = (level, event, message, data = {}) => {
    const timestamp = now();
    const record = {
      ts: timestamp.toISOString(),
      level,
      event,
      runId,
      env,
      ...bound,
      msg: redactText(message),
      ...(Object.keys(data).length ? { data: redactValue(data) } : {}),
    };
    if (jsonl) appendFileSync(jsonl, `${JSON.stringify(record)}\n`);
    const clock = timestamp.toISOString().slice(11, 19);
    const stage = bound.stage ? `[${bound.stage}] ` : '';
    out.write(`[${clock}] ${level === 'error' ? '错误' : level === 'warn' ? '提醒' : '信息'} ${stage}${record.msg}\n`);
    return record;
  };

  return {
    runId,
    env,
    directory,
    jsonl,
    child: extra => createLogger({ runId, env, directory, secrets: secretValues, out, now, bound: { ...bound, ...extra } }),
    info: (event, message, data) => write('info', event, message, data),
    warn: (event, message, data) => write('warn', event, message, data),
    error: (event, message, data) => write('error', event, message, data),
  };
}
