#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { changedPaths, diffArgs, git } from './review-gate.mjs';

const evidenceRequired = paths => paths.some(file => !/\.(md|mdc|rst)$/i.test(file) && !/^docs\/.*\.txt$/i.test(file));

function validEvidence(body) {
  const text = body.split('\n').filter(line => !line.startsWith('#')).join('\n');
  const levels = [...text.matchAll(/^风险等级[ \t]*[:：][ \t]*([^\r\n]*)/gm)];
  if (levels.length !== 1 || !/^R[123](?:[ \t]*[（(].*[）)])?$/.test(levels[0][1].trim())) return false;
  return ['已运行', '未运行', '待确认'].every(label => {
    const match = new RegExp(`^${label}[ \\t]*[:：][ \\t]*([^\\r\\n]+)`, 'm').exec(text);
    return match && match[1].trim() && !/^<.*>$|^TODO$/i.test(match[1].trim());
  });
}

try {
  const args = process.argv.slice(2);
  let entries;
  if (args.length === 3 && args[0] === '--staged' && args[1] === '--message') {
    entries = [{ paths: changedPaths('staged', null, true), body: readFileSync(args[2], 'utf8') }];
  } else if (args.length === 2 && args[0] === '--range') {
    diffArgs('range', args[1]);
    const [, , , head] = /^(.+?)(\.{2,3})(.+)$/.exec(args[1]);
    // The target commit records evidence for this entire delivery. A later
    // corrective review can supply evidence without rewriting earlier history.
    entries = [{ commit: git(['rev-parse', '--verify', `${head}^{commit}`]).trim(), paths: changedPaths('range', args[1], true), body: git(['show', '-s', '--format=%B', head]) }];
  } else throw new Error('usage');
  const rejected = entries.filter(entry => evidenceRequired(entry.paths) && !validEvidence(entry.body));
  if (rejected.length) {
    console.error('提交缺少有效审查证据：风险等级：R1/R2/R3；已运行：命令与结果；未运行：原因或无；待确认：事项或无。');
    for (const entry of rejected) if (entry.commit) console.error(`提交 ${entry.commit.slice(0, 12)}`);
    process.exitCode = 1;
  }
} catch {
  console.error('提交证据检查失败。用法：--staged --message <文件> 或 --range <base..head>。');
  process.exitCode = 2;
}
