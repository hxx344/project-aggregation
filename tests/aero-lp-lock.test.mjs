import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet } from 'ethers';
import { AERO_LP_DEFAULTS as DEFAULT_SETTINGS } from '../server/automation/aero-lp.mjs';

const KEY = '0x' + '11'.repeat(32), ADDRESS = new Wallet(KEY).address;
const CLI = fileURLToPath(new URL('../tools/aero-lp/cli.mjs', import.meta.url));
const LOADER = new URL('./fixtures/aero-lp-cli-loader.mjs', import.meta.url).href;
async function until(check, detail = 'fixture state', timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await delay(10); }
  throw new Error(`Timed out waiting for ${detail}`);
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-lock-')), children = [];
  const lock = join(directory, `run-${ADDRESS.toLowerCase()}.lock`);
  t.after(async () => {
    for (const name of ['publish', 'reclaim']) writeFileSync(join(directory, `${name}.release`), '1');
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.done));
    rmSync(directory, { recursive: true, force: true });
  });
  const launch = (mode = 'managed', env = {}) => {
    const config = join(directory, `${mode}.json`);
    writeFileSync(config, JSON.stringify(mode === 'managed' ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, address: ADDRESS, dataDir: directory }));
    const args = mode === 'managed' ? ['run', '--managed', '--config', config, '--data', directory] : [mode === 'dry-run' ? 'once' : mode, '--config', config, ...(mode === 'dry-run' ? ['--dry-run'] : [])];
    const child = fork(CLI, args, { execArgv: ['--import', LOADER], env: { ...process.env, AERO_LP_PRIVATE_KEY: KEY, AERO_FIXTURE_DIR: directory, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.events = []; child.stderrText = ''; let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; const lines = stdout.split('\n'); stdout = lines.pop(); for (const line of lines) { try { child.events.push(JSON.parse(line)); } catch {} } });
    child.stderr.on('data', chunk => { child.stderrText += chunk; });
    child.on('message', message => {
      if (message.type === 'aero-lp-ready') child.send({ type: 'aero-lp-key', key: KEY, paused: true });
      if (message.type === 'aero-lp-event') child.events.push(message.entry);
    });
    child.done = new Promise(resolve => child.once('exit', code => resolve(code)));
    children.push(child);
    return child;
  };
  return { directory, lock, launch, owner: () => JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) };
}
const cycle = child => child.events.find(entry => entry.event === 'cycle');
const stop = async child => { child.send({ type: 'aero-lp-stop' }); assert.equal(await child.done, 0, child.stderrText); };
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;

test('real managed/standalone processes cannot both enter the mkdir-to-owner publication window', async t => {
  const f = fixture(t), first = f.launch('managed', { AERO_FIXTURE_BARRIER: 'publish' });
  await until(() => existsSync(join(f.directory, 'publish.entered')));
  const second = f.launch('once');
  assert.equal(await second.done, 1, 'second writer must refuse an unpublished owner');
  assert.equal(cycle(second), undefined);
  writeFileSync(join(f.directory, 'publish.release'), '1');
  await until(() => cycle(first));
  assert.equal(f.owner().pid, first.pid);
  await stop(first);
});

test('two stale-lock reclaimers cannot remove each other newly acquired ownership', async t => {
  const f = fixture(t); mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: deadPid() }));
  const first = f.launch('managed', { AERO_FIXTURE_BARRIER: 'reclaim' });
  await until(() => existsSync(join(f.directory, 'reclaim.entered')));
  const second = f.launch('once');
  assert.equal(await second.done, 1, 'second reclaimer must not pass the guard');
  assert.equal(cycle(second), undefined);
  writeFileSync(join(f.directory, 'reclaim.release'), '1');
  await until(() => cycle(first));
  assert.equal(f.owner().pid, first.pid);
  await stop(first);
});

test('old release preserves a replacement owner with a different token', async t => {
  const f = fixture(t), first = f.launch(); await until(() => cycle(first));
  const old = f.owner(); renameSync(f.lock, `${f.lock}.old`); mkdirSync(f.lock);
  const replacement = { pid: process.pid, token: 'replacement-owner' };
  writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(replacement));
  await stop(first);
  assert.ok(existsSync(f.lock), 'old release must preserve the replacement');
  assert.deepEqual(f.owner(), replacement);
  assert.equal(typeof old.token, 'string');
  assert.notEqual(old.token, replacement.token);
});

test('live, missing, corrupt and uninspectable owners fail closed without changing the lock', async t => {
  for (const [name, text, env] of [
    ['live', JSON.stringify({ pid: process.pid }), {}], ['missing', null, {}], ['corrupt', '{broken', {}],
    ['invalid-pid', JSON.stringify({ pid: 0 }), {}], ['invalid-token', JSON.stringify({ pid: deadPid(), token: null }), {}],
    ['eperm', JSON.stringify({ pid: deadPid() }), { AERO_FIXTURE_EPERM: '1' }],
  ]) await t.test(name, async t => {
    const f = fixture(t); mkdirSync(f.lock); if (text !== null) writeFileSync(join(f.lock, 'owner.json'), text);
    const child = f.launch('once', env); assert.equal(await child.done, 1, child.stderrText); assert.equal(cycle(child), undefined);
    assert.ok(existsSync(f.lock)); if (text !== null) assert.equal(readFileSync(join(f.lock, 'owner.json'), 'utf8'), text);
  });
});

test('an abandoned guard fails closed, and a normal release tolerates a brief competing inspection', async t => {
  const f = fixture(t); mkdirSync(`${f.lock}.guard`);
  const refused = f.launch('once'); assert.equal(await refused.done, 1); assert.equal(cycle(refused), undefined);
  assert.ok(existsSync(`${f.lock}.guard`)); assert.ok(!existsSync(f.lock));
  rmSync(`${f.lock}.guard`, { recursive: true });
  const first = f.launch(); await until(() => cycle(first));
  const second = f.launch('once', { AERO_FIXTURE_BARRIER: 'reclaim' });
  await until(() => existsSync(join(f.directory, 'reclaim.entered')));
  first.send({ type: 'aero-lp-stop' });
  await delay(50);
  assert.ok(existsSync(f.lock), 'release waits for the same guard held by an inspector');
  writeFileSync(join(f.directory, 'reclaim.release'), '1');
  assert.equal(await second.done, 1); assert.equal(await first.done, 0, first.stderrText);
  assert.ok(!existsSync(f.lock));
});

test('managed/once/run share wallet ownership while status and dry-run remain read-only without a lock', async t => {
  const f = fixture(t), first = f.launch(); await until(() => cycle(first)); const owner = f.owner();
  for (const mode of ['managed', 'once', 'run']) { const child = f.launch(mode); assert.equal(await child.done, 1, `${mode}: ${child.stderrText}`); assert.equal(cycle(child), undefined); }
  for (const mode of ['status', 'dry-run']) { const child = f.launch(mode); assert.equal(await child.done, 0, `${mode}: ${child.stderrText}`); assert.ok(cycle(child)); assert.deepEqual(f.owner(), owner); }
  await stop(first); assert.ok(!existsSync(f.lock));
});

test('real rewardView-to-cycle path publishes one shared denominator and preserves independent row estimates', async t => {
  const f = fixture(t), child = f.launch('managed', { AERO_FIXTURE_REWARDS: '1' });
  await until(() => cycle(child));
  child.send({ type: 'aero-lp-reload' });
  const latest = await until(() => child.events.find(entry => entry.event === 'cycle' && entry.block === 2));
  assert.equal(latest.rewards.poolPerDay, 86400);
  assert.equal(latest.rewards.dailyTotal?.perDay, 69120);
  assert.equal(latest.rewards.dailyTotal?.scenario, 'same-lower');
  assert.deepEqual(latest.positions.map(p => p.aeroPerDay), [57600, 57600]);
  assert.equal(latest.rewards.price, null, 'token count does not require a reward quote');
  await stop(child);
});
