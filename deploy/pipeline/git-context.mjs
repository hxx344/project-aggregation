/** Git 查询整体受执行器的超时预算和环境锁保护。 */
import { execFileSync } from 'node:child_process';
import { parseGithubRepository } from './identity.mjs';

const query = args => {
  try {
    // 每项最多 10 秒、不重试；外层执行器另有 60 秒命令预算，强制终止即隔离。
    return execFileSync('git', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};
process.stdout.write(JSON.stringify({
  commit: query(['rev-parse', 'HEAD']),
  repository: parseGithubRepository(query(['remote', 'get-url', 'origin'])),
  branch: query(['rev-parse', '--abbrev-ref', 'HEAD']),
  tag: query(['describe', '--tags', '--exact-match']),
  dirty: Boolean(query(['status', '--porcelain'])),
}));
