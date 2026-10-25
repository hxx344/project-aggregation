import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, runLauncher } from '../server/launcher.mjs';

// The launcher and the process entry over small child scripts written per
// test, so each case controls when a child becomes ready, exits or stops.
const skip = process.platform === 'win32' ? 'POSIX signals only' : false;
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const processEntry = pathToFileURL(path.resolve('server/process-entry.mjs')).href;
const until = async (predicate, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 20)); } return false; };

async function scripts(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const starts = path.join(dir, 'starts');
  return { dir, starts, count: () => existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0,
    // Each script records its start, then runs `body`.
    write(name, body) {
      const file = path.join(dir, name);
      writeFileSync(file, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(starts)}, '${name}\\n');\n${body}\n`);
      return file;
    } };
}
const readyChild = "process.on('SIGTERM', () => process.exit(0)); process.send({ type: 'ready', port: 1 }); setInterval(() => {}, 1000);";

test('the launcher ends an API that is not ready in time and starts another', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const runtimeEntry = s.write('runtime.mjs', readyChild);
  const apiEntry = s.write('api.mjs', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
  const launcher = launch({ runtimeEntry, apiEntry, logger: quiet, apiReadyMs: 200, apiBackoffMs: [20] });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  assert.ok(await until(() => s.count() >= 3), 'the API was started again after the ready deadline');
  assert.equal(await launcher.stop(0), 0);
  assert.equal(await launcher.done, 0);
});

test('stop() during the API backoff starts no further API', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const runtimeEntry = s.write('runtime.mjs', readyChild);
  const apiEntry = s.write('api.mjs', 'process.exit(3);');
  let exited = false;
  const logger = { ...quiet, error: (fields, message) => { if (message === 'API 进程已退出，稍后重启') exited = true; } };
  const launcher = launch({ runtimeEntry, apiEntry, logger, apiBackoffMs: [300] });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  assert.ok(await until(() => exited), 'the launcher saw the API exit and scheduled a restart');
  assert.equal(await launcher.stop(0), 0);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(s.count(), 2);
});

test('a runtime that cannot be started ends the launcher with a non-zero code and no API', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const apiEntry = s.write('api.mjs', readyChild);
  const launcher = launch({ runtimeEntry: path.join(s.dir, 'missing.mjs'), apiEntry, logger: quiet });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  assert.equal(await launcher.done, 1);
  assert.equal(s.count(), 0);
});

test('an API that ignores SIGTERM is killed after the stop deadline and the exit code says so', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const runtimeEntry = s.write('runtime.mjs', readyChild);
  const apiEntry = s.write('api.mjs', "process.on('SIGTERM', () => {}); process.send({ type: 'ready', port: 1 }); setInterval(() => {}, 1000);");
  let ready; const apiReady = new Promise(resolve => { ready = resolve; });
  const launcher = launch({ runtimeEntry, apiEntry, logger: quiet, apiStopMs: 200, onApiReady: ready });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  const { apiPid, runtimePid } = await apiReady;
  assert.equal(await launcher.stop(0), 1);
  for (const pid of [apiPid, runtimePid]) assert.throws(() => process.kill(pid, 0));
});

test('children ended by the SIGTERM of stop() count as stopped', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  // Neither child has a SIGTERM handler, like a child still loading its modules.
  const child = "process.send({ type: 'ready', port: 1 }); setInterval(() => {}, 1000);";
  let ready; const apiReady = new Promise(resolve => { ready = resolve; });
  const launcher = launch({ runtimeEntry: s.write('runtime.mjs', child), apiEntry: s.write('api.mjs', child), logger: quiet, onApiReady: ready });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  const { apiPid, runtimePid } = await apiReady;
  assert.equal(await launcher.stop(0), 0);
  assert.equal(await launcher.done, 0);
  for (const pid of [apiPid, runtimePid]) assert.throws(() => process.kill(pid, 0));
});

test('stop() replaces the ready deadline of a starting API with the stop deadline', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const runtimeEntry = s.write('runtime.mjs', readyChild);
  // Never ready, and slower to stop than the ready deadline. The start record
  // and the SIGTERM handler come in one synchronous step.
  const apiEntry = s.write('api.mjs', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 4500)); setInterval(() => {}, 1000);");
  let killed = false;
  const logger = { ...quiet, error: (fields, message) => { if (message === 'API 未在期限内就绪，正在结束') killed = true; } };
  const launcher = launch({ runtimeEntry, apiEntry, logger, apiReadyMs: 3000 });
  t.after(() => launcher.stop(0)); // A failed assertion leaves no child behind.
  assert.ok(await until(() => s.count() === 2), 'the API started');
  assert.equal(killed, false, 'the API was stopped before its ready deadline');
  assert.equal(await launcher.stop(0), 0);
});

test('settings the API refuses on every start end the service entry before any process starts', { timeout: 10_000 }, async t => {
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  for (const env of [{ PORT: '70000' }, { PORT: '3100', PUBLIC_ORIGIN: 'https://hub.example/path' }]) {
    const errors = [];
    process.exitCode = undefined;
    await runLauncher({ env, logger: { ...quiet, error: (fields, message) => errors.push(message) }, start: () => assert.fail('no process may start') });
    assert.equal(process.exitCode, 1, JSON.stringify(env));
    assert.deepEqual(errors, ['工作台配置无效']);
  }
});

// A child running runProcess(); `start` is the body of its start function.
function entry(t, s, start) {
  const file = s.write('entry.mjs', `import { runProcess } from ${JSON.stringify(processEntry)};
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const closed = () => process.send({ type: 'closed' });
void runProcess({ name: 'test', logger, start: async ({ signal, fail }) => { ${start} } });`);
  const child = fork(file, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const messages = [];
  child.on('message', message => messages.push(message.type));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, exited, messages };
}
const waitAbort = "if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve)); throw new Error('aborted');";

test('a signal during startup aborts the start and exits 0', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const { child, exited, messages } = entry(t, s, `process.send({ type: 'starting' }); ${waitAbort}`);
  assert.ok(await until(() => messages.includes('starting')));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(messages.includes('ready'), false);
});

test('fail() during startup aborts the start and exits 1', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const { exited, messages } = entry(t, s, `fail(new Error('lost')); ${waitAbort}`);
  assert.deepEqual(await exited, { code: 1, signal: null });
  assert.equal(messages.includes('ready'), false);
});

test('fail() after the ready report closes the process and exits 1', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const { exited, messages } = entry(t, s, "setTimeout(() => fail(new Error('lock lost')), 50); return { ready: {}, close: async () => closed() };");
  assert.deepEqual(await exited, { code: 1, signal: null });
  assert.deepEqual(messages, ['ready', 'closed']);
});

test('a close() that fails exits 1 after a signal', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  const { child, exited, messages } = entry(t, s, "return { ready: {}, close: async () => { throw new Error('stuck'); } };");
  assert.ok(await until(() => messages.includes('ready')));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 1, signal: null });
});

test('a repeated signal while closing waits for close() instead of ending the process', { skip, timeout: 30_000 }, async t => {
  const s = await scripts(t);
  // systemd signals the whole unit and the launcher signals its children again.
  const { child, exited, messages } = entry(t, s, "return { ready: {}, close: async () => { process.send({ type: 'closing' }); await new Promise(resolve => setTimeout(resolve, 300)); closed(); } };");
  assert.ok(await until(() => messages.includes('ready')));
  child.kill('SIGTERM');
  assert.ok(await until(() => messages.includes('closing')));
  child.kill('SIGTERM'); child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.deepEqual(messages, ['ready', 'closing', 'closed']);
});
