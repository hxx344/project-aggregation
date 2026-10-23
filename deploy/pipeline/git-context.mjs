/** Git 身份查询：CLI 经执行器以子进程运行本文件，使整体受命令预算和环境锁保护。 */
import { execFileSync } from 'node:child_process';
import { ConfigError } from './config.mjs';
import { CHILD_FORCED_MARKER } from './constants.mjs';
import { parseGithubRepository } from './identity.mjs';

const NO_EXACT_TAG = { status: 128, reason: /^(?:fatal: no tag exactly matches '[0-9a-f]+'|fatal: No names found, cannot describe anything\.)$/ };
const NO_ORIGIN = { status: 2, reason: /^error: No such remote 'origin'$/ };

export function gitContext(root, execute = execFileSync) {
  const run = (args, tolerate = null) => {
    try {
      // 每项最多 10 秒、不重试；外层执行器另有 60 秒命令预算，强制终止即隔离。
      return execute('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }).trim();
    } catch (error) {
      const reason = String(error.stderr || error.code || error.message).trim();
      if (tolerate && error.status === tolerate.status && !error.signal && tolerate.reason.test(reason)) return '';
      // 超时或信号终止的 Git 可能留下后代，交给外层执行器隔离环境锁。
      const forced = Boolean(error.signal) || error.code === 'ETIMEDOUT';
      throw Object.assign(new ConfigError(`无法读取 Git 状态（git ${args.join(' ')}）：${reason}`), { forced });
    }
  };
  const commit = run(['rev-parse', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!commit || !branch) throw new ConfigError('Git 提交或分支为空，无法确认源码身份');
  return {
    commit,
    // 缺少 origin 只让发布阶段拒绝发布，不影响构建与部署。
    repository: parseGithubRepository(run(['remote', 'get-url', 'origin'], NO_ORIGIN)),
    branch,
    tag: run(['describe', '--tags', '--exact-match'], NO_EXACT_TAG),
    dirty: Boolean(run(['status', '--porcelain'])),
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(gitContext(process.cwd())));
  } catch (error) {
    process.stderr.write(`${error.forced ? `${CHILD_FORCED_MARKER}: ` : ''}${error.message}\n`);
    process.exitCode = 2;
  }
}
