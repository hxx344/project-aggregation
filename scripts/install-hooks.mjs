#!/usr/bin/env node
/**
 * 让新克隆的仓库自动启用 .githooks（pnpm install 时经 prepare 执行）。
 * 非 git 环境、只读检出或缺少钩子文件时静默跳过，不影响安装。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS = ['pre-commit', 'commit-msg'];

try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (top && existsSync(join(top, '.githooks', 'pre-commit'))) {
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
  }
} catch {
  // 非 git 检出或没有写权限：跳过，不阻断安装。
}
