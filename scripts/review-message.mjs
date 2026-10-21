#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { changedPaths, diffArgs, git } from './review-gate.mjs';

const evidenceRequired = paths => paths.some(file => !/\.(md|mdc|rst)$/i.test(file) && !/^docs\/.*\.txt$/i.test(file));
// Keep in step with user_notes() in deploy/publish-release.py, which turns this section into the release notes.
const NOTE_LABEL = /^更新说明[ \t]*[:：][ \t]*/;
const NOTE_END = /^(?:风险等级|已运行|未运行|待确认|独立审查|回滚)[ \t]*[:：]/;
const MAX_NOTE_CHARACTERS = 300;

function validNote(lines) {
  const starts = lines.flatMap((line, index) => NOTE_LABEL.test(line) ? [index] : []);
  if (starts.length !== 1) return false;
  const section = [lines[starts[0]].replace(NOTE_LABEL, '')];
  for (const line of lines.slice(starts[0] + 1)) {
    if (!line.trim() || NOTE_END.test(line)) break;
    section.push(line);
  }
  const note = section.map(line => line.trim()).filter(Boolean).join('\n');
  return /[\u3400-\u9fff]/.test(note) && !/^<.*>$|^TODO$/i.test(note) && [...note].length <= MAX_NOTE_CHARACTERS;
}

function validEvidence(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').filter(line => !line.startsWith('#'));
  if (!validNote(lines)) return false;
  const text = lines.join('\n');
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
    console.error(`提交缺少有效审查证据：更新说明：面向用户的中文摘要（不超过 ${MAX_NOTE_CHARACTERS} 字，会显示在系统更新弹窗）；风险等级：R1/R2/R3；已运行：命令与结果；未运行：原因或无；待确认：事项或无。`);
    for (const entry of rejected) if (entry.commit) console.error(`提交 ${entry.commit.slice(0, 12)}`);
    process.exitCode = 1;
  }
} catch {
  console.error('提交证据检查失败。用法：--staged --message <文件> 或 --range <base..head>。');
  process.exitCode = 2;
}
