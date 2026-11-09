import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// systemd starts the entries through the `current` release symlink. Each entry
// is given settings it refuses at once, so a non-zero exit with its own
// message proves its main block ran instead of exiting 0 without starting.
const skip = process.platform === 'win32' ? 'POSIX release symlink only' : false;

test('service and recovery entries start through a symlinked release path', { skip }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'main-module-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), current, 'dir');
  const notDirectory = path.join(dir, 'file');
  writeFileSync(notDirectory, '');
  const cases = [
    { entry: 'server/runtime/main.mjs', env: { DATA_DIR: notDirectory }, output: '运行时启动失败' },
    { entry: 'server/api/main.mjs', env: { DATA_DIR: dir }, output: '运行时尚未初始化数据目录' },
    { entry: 'server/entry/main.mjs', env: {}, output: '稳定入口需要绝对路径' },
    { entry: 'server/entry/probe.mjs', env: {}, output: '--dir 须为绝对路径' },
    { entry: 'server/launcher.mjs', env: { PORT: '0' }, output: '工作台配置无效' },
    { entry: 'server/recovery/cli.mjs', env: {}, output: 'RECOVERY_' },
  ];
  for (const { entry, env, output } of cases) {
    const result = spawnSync(process.execPath, [path.join(current, entry)], { cwd: current, env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, `${entry}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, new RegExp(output), entry);
  }
});

function generatedEntry(unit, { env, output, release, entry, instance = 'a' }) {
  const field = name => {
    const values = [...unit.matchAll(new RegExp(`^${name}=(.+)$`, 'gm'))];
    assert.equal(values.length, 1, `one generated ${name} is required`);
    const value = values[0][1].trim().replaceAll('%i', instance);
    // These installer fields are literal absolute paths and whitespace-delimited
    // arguments. Refuse new quoting/specifiers until the probe supports them.
    assert.doesNotMatch(value, /["'\\%$]/, `unsupported generated ${name}`);
    return value;
  };
  const workingDirectory = field('WorkingDirectory'), execStart = field('ExecStart');
  const [executable, ...args] = execStart.split(/\s+/);
  assert.equal(realpathSync(executable), realpathSync(process.execPath));
  assert.equal(realpathSync(workingDirectory), realpathSync(release));
  assert.equal(realpathSync(args[0]), realpathSync(path.join(release, entry)), 'generated command must start the expected entry in this release');
  const result = spawnSync(executable, args, { cwd: workingDirectory, env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, `${execStart}: ${result.error}`);
  assert.equal(result.status, 1, `${execStart}: entry must run and refuse its fixture configuration: ${result.stdout}${result.stderr}`);
  assert.ok((result.stdout + result.stderr).includes(output), `${execStart}: expected entry refusal, not an import failure: ${result.stdout}${result.stderr}`);
  return { workingDirectory, execStart, instance, exitCode: result.status, expectedRefusal: output };
}

test('generated systemd units execute real release entries through current and both slots', { skip }, async t => {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const release = process.env.ENTRY_TEST_RELEASE || repository;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'generated-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const application = path.join(dir, 'application'), units = path.join(dir, 'units');
  mkdirSync(path.join(application, 'slots'), { recursive: true }); mkdirSync(units);
  for (const link of ['current', 'slots/a', 'slots/b']) symlinkSync(release, path.join(application, link), 'dir');
  const generated = spawnSync('bash', ['-c', `
set -euo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$1/deploy/install.sh"
APP_DIR=$2 work_dir=$3 NODE_BIN=$4
SERVICE=agg-entry-probe API_SERVICE=agg-entry-probe-api ENTRY_SERVICE=agg-entry-probe-entry
SERVICE_USER=agg-entry-probe DATA_PATH=$APP_DIR/data ENV_FILE=$APP_DIR/environment
GREEKS_PYTHON_PATH=/usr/bin/python3 ASTER_PYTHON_PATH=/usr/bin/python3
slot_layout=dual systemd_version=254
write_unit
`, 'generated-entry', repository, application, units, process.execPath], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(generated.error, undefined);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const notDirectory = path.join(dir, 'file'); writeFileSync(notDirectory, '');
  const cases = [
    { unit: 'service', entry: 'server/runtime/main.mjs', env: { DATA_DIR: notDirectory }, output: '运行时启动失败' },
    { unit: 'api.service', entry: 'server/api/main.mjs', env: { DATA_DIR: dir }, output: '运行时尚未初始化数据目录' },
    { unit: 'entry.service', entry: 'server/entry/main.mjs', env: {}, output: '稳定入口需要绝对路径' },
    ...['a', 'b'].map(instance => ({ unit: 'slot.service', entry: 'server/api/main.mjs', instance, env: { DATA_DIR: dir, WORKBENCH_API_SLOT: instance, WORKBENCH_API_SLOT_DIR: path.join(dir, 'slot-' + instance), WORKBENCH_API_SLOT_RECORD: path.join(application, '.api-slot') }, output: '运行时尚未初始化数据目录' })),
  ];
  const checks = cases.map(entry => ({ unit: entry.unit, ...generatedEntry(readFileSync(path.join(units, entry.unit), 'utf8'), { ...entry, release }) }));
  const runtimeUnit = readFileSync(path.join(units, 'service'), 'utf8');
  // Prove that a wrong generated path or an import-only module cannot satisfy
  // the same probe. This also catches a main block that silently exits zero.
  assert.throws(() => generatedEntry(runtimeUnit.replace('/server/runtime/main.mjs', '/server/missing-entry.mjs'), { ...cases[0], release }), /ENOENT/);
  assert.throws(() => generatedEntry(runtimeUnit.replace('/server/runtime/main.mjs', '/server/process-entry.mjs'), { ...cases[0], release, entry: 'server/process-entry.mjs' }), /entry must run/);
  const foreignEntry = path.join(dir, 'other-release', 'server/runtime/main.mjs');
  mkdirSync(path.dirname(foreignEntry), { recursive: true });
  writeFileSync(foreignEntry, "process.stderr.write('运行时启动失败'); process.exitCode = 1;\n");
  assert.throws(() => generatedEntry(runtimeUnit.replace(path.join(application, 'current', cases[0].entry), foreignEntry), { ...cases[0], release }), /expected entry in this release/);
  if (process.env.ENTRY_TEST_EVIDENCE) {
    const commit = readFileSync(path.join(release, '.release-commit'), 'utf8').trim();
    assert.equal(commit, process.env.DEPLOYMENT_TEST_COMMIT);
    assert.match(process.env.PACKAGE_TEST_SHA256 || '', /^[a-f0-9]{64}$/);
    const report = { schema: 1, layer: 'packaged-generated-ExecStart-refusal', commit, packageSha256: process.env.PACKAGE_TEST_SHA256,
      runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null, job: process.env.GITHUB_JOB || null,
      checks, negativeControls: ['missing-entry-rejected', 'import-only-zero-exit-rejected', 'other-release-entry-rejected'],
      limitation: 'Uses the generated command and working directory with deliberate refusal settings; actual systemd lifecycle is checked separately.' };
    writeFileSync(process.env.ENTRY_TEST_EVIDENCE, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
});
