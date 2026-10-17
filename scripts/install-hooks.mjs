#!/usr/bin/env node
/**
 * 让新克隆的仓库自动启用 .githooks（pnpm install 时经 prepare 执行）。
 * 非 git 环境、只读检出或缺少钩子文件时静默跳过，不影响安装。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = ['pre-commit', 'commit-msg'];

try {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (top && relative(realpathSync.native(top), realpathSync.native(project)) === '' && HOOKS.every(hook => existsSync(join(top, '.githooks', hook)))) {
    let configured = '';
    try { configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Unconfigured. */ }
    if (configured && configured !== '.githooks') { console.info('审查钩子：保留已有 hooksPath；CI 仍执行审查门禁。'); process.exit(0); }
    for (const hook of HOOKS) {
      try {
        chmodSync(join(top, '.githooks', hook), 0o755);
      } catch {
        // Windows 或只读文件系统上忽略；git 在 Windows 不依赖执行位。
      }
    }
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
      cwd: top,
      stdio: 'ignore',
    });
    console.info('审查钩子：.githooks 已启用。');
  } else {
    console.info('审查钩子：当前为归档或钩子文件不完整，跳过本地安装。');
  }
} catch {
  console.info('审查钩子：无可写 Git 检出，跳过本地安装；未声称已启用。');
}
