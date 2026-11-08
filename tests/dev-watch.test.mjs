import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDevWatch, DEV_RUN_ENV, findMarked } from '../server/dev-watch.mjs';

const linux = process.platform === 'linux';
const entry = path.join(import.meta.dirname, 'fixtures', 'dev-group.mjs');
const quiet = { info() {}, warn() {}, error() {} };
// A zombie (state Z) has exited; its parent has not reaped it yet.
const alive = pid => { try { return !/^\S+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const until = async (predicate, ms = 5000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await delay(20); assert.ok(predicate()); };

function setup(t, mode, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'starts.log');
  writeFileSync(log, '');
  const watch = createDevWatch({ entry, roots: [], logger: quiet, debounceMs: 20, residueGraceMs: 2000, env: { ...process.env, DEV_FIXTURE_MODE: mode, DEV_FIXTURE_LOG: log }, ...options });
  t.after(() => watch.close());
  const starts = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => { const [pid, run, leaked] = line.split(' '); return { pid: Number(pid), run, leaked: leaked && Number(leaked) }; });
  return { dir, watch, starts };
}

test('findMarked lists the processes that carry a marker', { skip: !linux }, async t => {
  const marked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, [DEV_RUN_ENV]: 'marked-run' }, stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { marked.kill('SIGKILL'); other.kill('SIGKILL'); });
  await until(() => findMarked(DEV_RUN_ENV, 'marked-run').length > 0);
  assert.deepEqual(findMarked(DEV_RUN_ENV, 'marked-run'), [marked.pid]);
});

test('a change restarts the group once, after the old group left', { skip: !linux }, async t => {
  const { watch, starts } = setup(t, 'slow');
  await until(() => starts().length === 1);
  const [first] = starts();
  watch.changed('a.mjs'); watch.changed('b.mjs');
  await until(() => starts().length === 2);
  assert.equal(alive(first.pid), false, 'the old group left before the new one started');
  assert.notEqual(starts()[1].run, first.run);
  assert.equal(watch.starts, 2);
  // Changes during the 300 ms stop are covered by the restart under way.
  watch.changed('c.mjs');
  await delay(60);
  watch.changed('d.mjs'); watch.changed('e.mjs');
  await until(() => starts().length === 3);
  await delay(800);
  assert.equal(watch.starts, 3, 'spawned once more, not once per change');
  assert.equal(starts().length, 3);
  assert.deepEqual(await watch.close(), []);
  for (const { run } of starts()) assert.deepEqual(findMarked(DEV_RUN_ENV, run), []);
});

test('a group that does not stop in time is killed before the next one starts', { skip: !linux }, async t => {
  const { watch, starts } = setup(t, 'stubborn', { stopMs: 300 });
  await until(() => starts().length === 1);
  const [first] = starts();
  const began = Date.now();
  watch.changed('a.mjs');
  await until(() => starts().length === 2);
  assert.ok(Date.now() - began >= 300, 'it waited for the stop deadline');
  assert.equal(alive(first.pid), false);
  assert.deepEqual(await watch.close(), []);
  assert.equal(alive(starts()[1].pid), false);
});

test('a process left behind by the group is found and ended', { skip: !linux }, async t => {
  const { watch, starts } = setup(t, 'leak');
  await until(() => starts().length === 1);
  const [{ run, leaked }] = starts();
  t.after(() => { try { process.kill(leaked, 'SIGKILL'); } catch {} });
  assert.equal(alive(leaked), true);
  assert.deepEqual(await watch.close(), []);
  assert.equal(alive(leaked), false);
  assert.deepEqual(findMarked(DEV_RUN_ENV, run), []);
});

test('groups a dead watch of this repository left are ended before the first start', { skip: !linux }, async t => {
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => gone.once('exit', resolve));
  const root = path.resolve(import.meta.dirname, '..');
  const left = (marker, extra = {}) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, [DEV_RUN_ENV]: marker, ...extra }, stdio: 'ignore' });
  const orphan = left(`${gone.pid}:old:${root}`), foreign = left(`${gone.pid}:old:/elsewhere`), owned = left(`${process.pid}:mine:${root}`);
  t.after(() => { for (const child of [orphan, foreign, owned]) child.kill('SIGKILL'); });
  await until(() => findMarked(DEV_RUN_ENV, value => value.endsWith(':old:' + root) || value.includes(':mine:')).length === 2);
  const { starts } = setup(t, 'slow');
  await until(() => starts().length === 1);
  assert.equal(alive(orphan.pid), false);
  assert.equal(alive(foreign.pid), true, 'another repository');
  assert.equal(alive(owned.pid), true, 'its watch is alive');
});

test('a group that exits by itself is started again only on a change', { skip: !linux }, async t => {
  const { watch, starts } = setup(t, 'crash');
  await until(() => starts().length === 1);
  await until(() => watch.pid === null);
  await delay(200);
  assert.equal(starts().length, 1);
  watch.changed('a.mjs');
  await until(() => starts().length === 2);
});

test('file changes under a watched directory restart the group; ignored paths do not', { skip: !linux }, async t => {
  const source = mkdtempSync(path.join(tmpdir(), 'dev-watch-src-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(path.join(source, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(source, 'nested'));
  const { starts } = setup(t, 'slow', { roots: [source, path.join(source, 'missing')] });
  await until(() => starts().length === 1);
  writeFileSync(path.join(source, 'node_modules', 'pkg', 'index.js'), '1');
  writeFileSync(path.join(source, 'nested', 'x.pyc'), '1');
  await delay(400);
  assert.equal(starts().length, 1);
  writeFileSync(path.join(source, 'nested', 'module.mjs'), 'export {};');
  await until(() => starts().length === 2);
  assert.equal(existsSync(path.join(source, 'missing')), false);
});
