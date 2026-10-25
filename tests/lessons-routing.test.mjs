import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const section = (text, heading) => text.split(`\n${heading}\n`)[1]?.split(/\n#{1,2} /)[0] ?? '';
const ids = text => [...text.matchAll(/^### (L\d{3})\b/gm)].map(match => match[1]);
const lessonsText = read('LESSONS.md');
const active = ids(section(lessonsText, '## 经验条目'));
const archived = ids(section(lessonsText, '## 已归档'));
// Only the second column of routing table rows counts; prose around the table may cite IDs freely.
const routed = section(read('AGENTS.md'), '### 按改动取用经验').split('\n')
  .filter(line => /^\|[^|]+\|[^|]*\bL\d{3}\b/.test(line))
  .flatMap(line => line.split('|')[2].match(/\bL\d{3}\b/g) ?? []);

test('lesson headings use the stable form and unique ids', () => {
  assert.ok(active.length > 0);
  assert.deepEqual(ids(lessonsText), [...active, ...archived]);
  assert.deepEqual(lessonsText.match(/^### L\d{3}(?!：).*$/gm) ?? [], []);
  assert.equal(new Set([...active, ...archived]).size, active.length + archived.length);
  assert.deepEqual(active, [...active].sort());
});

test('every active lesson is reachable from the AGENTS.md routing table', () => {
  assert.deepEqual(active.filter(id => !routed.includes(id)), []);
  assert.deepEqual([...new Set(routed)].filter(id => !active.includes(id)), []);
});
