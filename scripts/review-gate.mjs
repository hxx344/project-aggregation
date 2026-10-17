#!/usr/bin/env node
/**
 * 合并前机器门禁：只检查本次改动新增的行，不追溯历史代码。
 *
 * 用法：
 *   node scripts/review-gate.mjs --staged          # 预提交（暂存区）
 *   node scripts/review-gate.mjs --range origin/main...HEAD
 *   node scripts/review-gate.mjs                   # 工作区未提交改动
 *
 * 退出码：0 通过（可能有警告），1 存在阻断项，2 用法或环境错误。
 * 本脚本只覆盖可机械判定的部分；语义、缓存、资金边界仍须人工/代理审查。
 */
import { execFileSync } from 'node:child_process';

const BLOCKED_PATHS = [
  { re: /^(output|dist|node_modules)\//, why: '生成物或依赖目录不提交，改为修改生成源' },
  { re: /(^|\/)\.env(\.|$)/, why: '环境文件可能含凭据，不得提交' },
];

const CONTENT_RULES = [
  {
    id: 'debugger',
    re: /(^|\s)debugger\s*;?(\s|$)/,
    level: 'error',
    why: '调试残留，提交前删除',
  },
  {
    id: 'console.log',
    re: /\bconsole\.log\s*\(/,
    level: 'error',
    scope: /^(src|server|modules\/[^/]+\/src)\//,
    why: '服务端/前端日志走 logger 或已有诊断通道，不新增 console.log',
  },
  {
    id: 'test.only',
    re: /\b(it|test|describe|suite)\.only\s*\(/,
    level: 'error',
    why: '只跑单个用例会让其余测试静默失效',
  },
  {
    id: 'test.skip',
    re: /\b(it|test|describe|suite)\.skip\s*\(/,
    level: 'warn',
    why: '跳过用例需在 PR 里说明原因与恢复计划',
  },
  {
    id: 'conflict',
    re: /^(<{7}|={7}|>{7})(\s|$)/,
    level: 'error',
    why: '未解决的合并冲突标记',
  },
  {
    id: 'secret',
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bsk-[A-Za-z0-9]{20,})/,
    level: 'error',
    why: '疑似凭据，禁止入库',
  },
  {
    id: 'relaxed-assert',
    re: /\bassert\.ok\(\s*true\s*[,)]|\bexpect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
    level: 'warn',
    why: '恒真断言没有验证任何行为',
  },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseArgs(argv) {
  const out = { mode: 'worktree', range: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--staged') out.mode = 'staged';
    else if (argv[i] === '--range') {
      out.range = argv[i + 1];
      i += 1;
    } else if (argv[i] === '-h' || argv[i] === '--help') out.mode = 'help';
    else {
      console.error(`未知参数：${argv[i]}`);
      out.mode = 'invalid';
    }
  }
  return out;
}

function readDiff(mode, range) {
  if (mode === 'staged') return git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff']);
  if (mode === 'range') {
    if (!range) throw new Error('--range 需要形如 origin/main...HEAD 的范围');
    return git(['diff', '-U0', '--no-color', '--no-ext-diff', range]);
  }
  return git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']);
}

function parseAddedLines(diff) {
  const files = new Map();
  let current = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (!current || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      files.get(current).push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    }
  }
  return files;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help') {
    console.log('用法：node scripts/review-gate.mjs [--staged | --range <base...head>]');
    return 0;
  }
  if (opts.mode === 'invalid') return 2;

  let diff;
  try {
    diff = readDiff(opts.mode, opts.range);
  } catch (error) {
    console.error(`读取 diff 失败：${error.message}`);
    return 2;
  }

  const files = parseAddedLines(diff);
  const findings = [];
  let addedLines = 0;

  for (const [file, lines] of files) {
    for (const rule of BLOCKED_PATHS) {
      if (rule.re.test(file)) {
        findings.push({ level: 'error', file, line: 0, rule: 'blocked-path', why: rule.why });
      }
    }
    for (const { line, text } of lines) {
      addedLines += 1;
      for (const rule of CONTENT_RULES) {
        if (rule.scope && !rule.scope.test(file)) continue;
        if (rule.re.test(text)) {
          findings.push({ level: rule.level, file, line, rule: rule.id, why: rule.why, text: text.trim() });
        }
      }
    }
  }

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');

  if (!files.size) {
    console.log('门禁：本次没有代码改动。');
    return 0;
  }

  for (const group of [errors, warnings]) {
    for (const f of group) {
      const mark = f.level === 'error' ? '阻断' : '提醒';
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`[${mark}] ${where}  ${f.why}`);
      if (f.text) console.log(`         ${f.text.slice(0, 120)}`);
    }
  }

  console.log(
    `\n门禁结果：${files.size} 个文件、${addedLines} 行新增；阻断 ${errors.length}，提醒 ${warnings.length}。`,
  );
  if (errors.length) {
    console.log('阻断项必须修复后再提交。语义、缓存、资金边界与验证证据仍须按 docs/code-review-checklist.md 人工确认。');
    return 1;
  }
  return 0;
}

process.exitCode = main();
