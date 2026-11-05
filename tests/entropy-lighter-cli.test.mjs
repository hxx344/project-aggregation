import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'tools/entropy-lighter-lab/cli.mjs');
const base = JSON.parse(readFileSync(join(root, 'tools/entropy-lighter-lab/config.example.json'), 'utf8'));
function child(args, env = {}) {
  const processChild = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', (d) => { stdout += d; }); processChild.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { processChild, done, output: () => ({ stdout, stderr }) };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'entropy-cli-'));
  // Offline startup uses real cooldown logic, without mocking the application.
  writeFileSync(join(directory, 'cooldowns.json'), JSON.stringify(Object.fromEntries(['entropy', 'lighter', 'binance'].map((v) => [v, Date.now() + 3600000]))));
  return directory;
}
async function waitStatus(directory, pid) {
  for (let i = 0; i < 100; i++) {
    try { const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8')); if (status.pid === pid) return status; } catch {}
    await delay(30);
  }
  throw new Error('No heartbeat from actual CLI entry');
}
const runSkip = ['linux', 'win32'].includes(process.platform) ? false : 'collector start arbitration supports only Linux and Windows';
const lockRefusal = /collector/i;
const linuxSkip = process.platform === 'linux' ? false : 'requires native Linux UID and file-descriptor permission semantics; Windows cannot verify these checks';
const guardEntries = ['run.guard.d', 'run.guard.d/run.guard-id'];
const guardPath = (dir) => join(dir, 'run.guard.d/run.guard-id');
function windowsSecurity(path, owner) {
  const script = '$ErrorActionPreference = "Stop"; $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json; ' +
    '$directory = ([IO.File]::GetAttributes($request.path) -band [IO.FileAttributes]::Directory) -ne 0; ' +
    '$acl = if ($directory) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }; ' +
    'if ($request.owner) { $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($request.owner))); if ($directory) { [IO.Directory]::SetAccessControl($request.path, $acl) } else { [IO.File]::SetAccessControl($request.path, $acl) } }; ' +
    '[pscustomobject]@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected; ' +
    'entries = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags; allow = $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } }) } | ConvertTo-Json -Depth 4 -Compress';
  return JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { input: Buffer.from(JSON.stringify({ path, owner })).toString('base64'), encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
}
function assertPrivateWindows(path, directory = false) {
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).match(/"(S-1-\d+(?:-\d+)+)"\s*$/)?.[1];
  assert.ok(sid);
  const security = windowsSecurity(path);
  assert.equal(security.owner, sid, 'the guard owner must be the current user SID');
  assert.equal(security.protected, true, 'the DACL must already be private before a secret is written');
  assert.deepEqual(security.entries, [{ sid, rights: 2032127, inherited: false, inheritance: directory ? 3 : 0, propagation: 0, allow: true }]);
}
function guardAddress(dir, id) {
  const path = realpathSync.native(dir);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const digest = createHash('sha256').update(id === undefined ? key : `${key}\0${id}`).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\project-aggregation-entropy-lighter-${digest}` : `\0project-aggregation-entropy-lighter-${digest}`;
}
async function occupy(address) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ path: address, exclusive: true }, resolve); });
  return () => new Promise((resolve) => server.close(() => resolve()));
}
function assertGuardPermissions(dir) {
  const path = guardPath(dir);
  if (process.platform === 'linux') {
    assert.equal(statSync(join(dir, 'run.guard.d')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'run.guard.d')).uid, process.getuid());
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(path).uid, process.getuid()); return;
  }
  const options = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], options).match(/"(S-1-\d+(?:-\d+)+)"\s*$/)?.[1];
  assert.ok(sid, 'whoami must return a numeric current-user SID');
  const saved = join(dir, 'guard-acl.txt');
  execFileSync('icacls.exe', [path, '/save', saved, '/q'], options);
  const descriptor = readFileSync(saved, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.startsWith('D:'));
  assert.match(descriptor, /^D:P/, 'the DACL must disable inheritance');
  const entries = [...descriptor.matchAll(/\(([^)]+)\)/g)].map((match) => match[1].split(';'));
  assert.deepEqual(entries.map((fields) => fields.slice(0, 5)), [['A', '', 'FA', '', '']], 'only one full-control allow entry may exist, with no inherited entries');
  // icacls may serialize well-known user SIDs as SDDL aliases (e.g. LA).
  const grantedSids = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; $acl = New-Object System.Security.AccessControl.RawSecurityDescriptor([Console]::In.ReadToEnd()); $acl.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value }'],
  { ...options, input: descriptor }).trim().split(/\r?\n/);
  assert.deepEqual(grantedSids, [sid], 'the only granted identity must be the numeric current-user SID');
}
function faultedRun(dir, inject) {
  const script = `import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    ${inject}
    syncBuiltinESMExports();
    const { run } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    await run({ configPath: ${JSON.stringify(join(root, 'tools/entropy-lighter-lab/config.example.json'))}, data: ${JSON.stringify(dir)}, duration: 1 })
      .catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });`;
  return child(['--input-type=module', '-e', script]).done;
}

test('unsupported platforms refuse a collector start before creating its data directory', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'entropy-cli-unsupported-'));
  const data = join(parent, 'not-created');
  try {
    const script = `const { run } = await import(${JSON.stringify(pathToFileURL(entry).href)});
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      await run({ configPath: ${JSON.stringify(join(root, 'tools/entropy-lighter-lab/config.example.json'))}, data: ${JSON.stringify(data)}, duration: 1 })
        .catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });`;
    const result = await child(['--input-type=module', '-e', script]).done;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /collector.*Linux or Windows/i);
    assert.equal(existsSync(data), false, 'an unsupported platform must not create the data directory');
  } finally { rmSync(parent, { recursive: true }); }
});

test('guard owner validation rejects foreign identities and accepts the current identity', async () => {
  const { assertCollectorGuardOwner } = await import(pathToFileURL(entry).href);
  assert.equal(typeof assertCollectorGuardOwner, 'function');
  assert.doesNotThrow(() => assertCollectorGuardOwner('S-1-5-21-1-2-3-1001', 'S-1-5-21-1-2-3-1001'));
  assert.doesNotThrow(() => assertCollectorGuardOwner(0, 0));
  for (const [owner, expected] of [['S-1-5-32-544', 'S-1-5-21-1-2-3-1001'], [1001, 1000], [undefined, undefined]]) {
    assert.throws(() => assertCollectorGuardOwner(owner, expected), /collector.*owner/i);
  }
});

test('real current symlink entry runs configuration check', async () => {
  const dir = mkdtempSync(join(root, '.data-entropy-entry-'));
  try {
    symlinkSync(join(root, 'tools/entropy-lighter-lab'), join(dir, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await child([join(dir, 'current/cli.mjs'), 'check']).done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Configuration valid/);
  } finally {
    if (process.platform === 'win32') rmdirSync(join(dir, 'current'));
    else unlinkSync(join(dir, 'current'));
    rmSync(dir, { recursive: true });
  }
});

test('offline run emits actual service heartbeat, bounded shutdown and readable report', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const c = child([entry, 'run', '--data', dir, '--duration', '1']);
    const status = await waitStatus(dir, c.processChild.pid);
    assert.equal(status.mode, 'research'); assert.equal(status.stopped, false);
    const result = await c.done; assert.equal(result.code, 0, result.stderr);
    const report = await child([entry, 'report', '--data', dir]).done;
    assert.equal(JSON.parse(report.stdout).stopped, true);
    assert.equal(JSON.parse(report.stdout).counts.books, 0);
    assert.equal(JSON.parse(report.stdout).automaticFees.mode, 'auto');
    assert.deepEqual(JSON.parse(report.stdout).automaticFees.rebateRatios, [1.1, 1.2]);
    assert.equal(JSON.parse(report.stdout).sessionConfig.simulation.entropyTakerFeeBps, null);
    assert.equal(JSON.parse(report.stdout).binanceScalper.enabled, true);
    assert.equal(JSON.parse(report.stdout).binanceScalper.suspendedReason, null);
  } finally { rmSync(dir, { recursive: true }); }
});

test('competing recovery starts cannot both own a dead collector lock', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const exited = child(['-e', 'process.exit(0)']); await exited.done;
    mkdirSync(join(dir, 'run.lock'));
    writeFileSync(join(dir, 'run.lock/owner.json'), JSON.stringify({ pid: exited.processChild.pid, token: 'old' }));
    const a = child([entry, 'run', '--data', dir, '--duration', '4']);
    const b = child([entry, 'run', '--data', dir, '--duration', '4']);
    const results = await Promise.all([a.done, b.done]);
    assert.equal(results.filter((r) => r.code === 0).length, 1);
    assert.match(results.find((r) => r.code !== 0).stderr, lockRefusal);
  } finally { rmSync(dir, { recursive: true }); }
});

// Start entries present at each pause on the recovery path; uuids are normalized.
const pauseSteps = {
  'guard-acquired': [...guardEntries, 'run.lock'],
  'lock-dir-created': [...guardEntries, 'run.lock.pending-*', 'run.lock.stale-*'],
  'old-lock-renamed': [...guardEntries, 'run.lock.stale-*'],
  'new-lock-published': [...guardEntries, 'run.lock', 'run.lock.stale-*'],
};
const startEntries = (dir) => readdirSync(dir).filter((name) => name.startsWith('run.')).flatMap((name) =>
  name === 'run.guard.d' ? [name, ...readdirSync(join(dir, name)).map((child) => `${name}/${child}`)] : [name]).sort();
async function waitPaused(c, step) {
  for (let i = 0; i < 200; i++) {
    if (c.output().stderr.includes(`test pause: ${step}`)) return;
    if (c.processChild.exitCode !== null) break;
    await delay(25);
  }
  throw new Error(`Start did not pause at ${step}: ${c.output().stderr}`);
}
async function deadPid() { const exited = child(['-e', 'process.exit(0)']); await exited.done; return exited.processChild.pid; }

test('Windows guard directories and temporaries are private before any secret is written', { skip: process.platform !== 'win32' }, async () => {
  const dir = fixture(); let paused, held;
  try {
    const resume = join(dir, 'resume-start');
    paused = child([entry, 'run', '--data', dir, '--duration', '1'], { ENTROPY_LAB_TEST_PAUSE_AT: 'guard-id-created', ENTROPY_LAB_TEST_RESUME_FILE: resume });
    await waitPaused(paused, 'guard-id-created');
    const privateDir = join(dir, 'run.guard.d');
    const location = existsSync(privateDir) ? privateDir : dir;
    const temporary = join(location, readdirSync(location).find((name) => name.startsWith('run.guard-id.tmp-')));
    assert.equal(statSync(temporary).size, 0);
    assertPrivateWindows(temporary);
    assertPrivateWindows(privateDir, true);
    held = openSync(temporary, 'r');
    writeFileSync(resume, '');
    const result = await paused.done; assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(held, 'utf8'), /^[0-9a-f]{32}$/, 'an allowed current-user handle stays readable through publication');
  } finally {
    if (held !== undefined) closeSync(held);
    if (paused?.processChild.exitCode === null && paused.processChild.signalCode === null) { paused.processChild.kill('SIGKILL'); await paused.done; }
    rmSync(dir, { recursive: true });
  }
});

for (const directory of [false, true]) test(`Windows refuses a foreign-owned guard ${directory ? 'directory' : 'secret'} without changing its owner or ACL`, { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fixture();
  try {
    const first = await child([entry, 'run', '--data', dir, '--duration', '1']).done; assert.equal(first.code, 0, first.stderr);
    const location = existsSync(join(dir, 'run.guard.d')) ? join(dir, 'run.guard.d') : dir;
    const path = directory ? location : join(location, 'run.guard-id');
    let before;
    try { before = windowsSecurity(path, 'S-1-5-32-544'); }
    catch { t.skip('the current Windows token cannot assign BUILTIN\\Administrators as an owner'); return; }
    assert.equal(before.owner, 'S-1-5-32-544');
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /collector.*owner/i);
    assert.deepEqual(windowsSecurity(path), before, 'a refused start must not take ownership or repair a foreign owner ACL');
  } finally { rmSync(dir, { recursive: true }); }
});

// The native owner-changing fixture above is unavailable to restricted Windows
// tokens. Inject only GetOwner's result to exercise the real helper's decision.
for (const directory of [false, true]) test(`Windows native helper rejects a foreign ${directory ? 'directory' : 'secret'} owner before ACL repair`, { skip: process.platform !== 'win32' }, async () => {
  const dir = fixture();
  try {
    const first = await child([entry, 'run', '--data', dir, '--duration', '1']).done; assert.equal(first.code, 0, first.stderr);
    const path = directory ? join(dir, 'run.guard.d') : guardPath(dir);
    const before = windowsSecurity(path);
    const report = readFileSync(join(dir, 'report.json'), 'utf8');
    const original = '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value';
    const injected = `$owner = if ($acl -is [Security.AccessControl.${directory ? 'Directory' : 'File'}Security]) { "S-1-5-32-544" } else { $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }`;
    const result = await faultedRun(dir, `const exec = childProcess.execFileSync;
      childProcess.execFileSync = (file, args, options) => exec(file, args.map((arg) => arg.replace(${JSON.stringify(original)}, ${JSON.stringify(injected)})), options);`);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /collector.*owner/i);
    assert.deepEqual(windowsSecurity(path), before);
    assert.equal(readFileSync(join(dir, 'report.json'), 'utf8'), report);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const directory of [false, true]) test(`Linux repairs broad permissions on an owned guard ${directory ? 'directory' : 'secret'} before use`, { skip: linuxSkip }, async () => {
  const dir = fixture(); const privateDir = join(dir, 'run.guard.d'); const path = join(privateDir, 'run.guard-id');
  try {
    mkdirSync(privateDir, { mode: 0o700 }); writeFileSync(path, '2'.repeat(32), { mode: 0o600 });
    chmodSync(directory ? privateDir : path, directory ? 0o777 : 0o644);
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done; assert.equal(result.code, 0, result.stderr);
    assert.equal(statSync(privateDir).uid, process.getuid()); assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    assert.equal(statSync(path).uid, process.getuid()); assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8'), '2'.repeat(32));
  } finally { rmSync(dir, { recursive: true }); }
});

for (const directory of [false, true]) test(`Linux rejects a foreign-owned guard ${directory ? 'directory' : 'secret'} before read or chmod`, { skip: linuxSkip }, async () => {
  const dir = fixture(); const privateDir = join(dir, 'run.guard.d');
  try {
    mkdirSync(privateDir, { mode: 0o700 }); writeFileSync(join(privateDir, 'run.guard-id'), '3'.repeat(32), { mode: 0o600 });
    const result = await faultedRun(dir, `const stat = fs.fstatSync, read = fs.readFileSync, chmod = fs.fchmodSync;
      const foreign = new Set(); let reads = 0, chmods = 0;
      fs.fstatSync = (fd) => { const value = stat(fd); if (value.${directory ? 'isDirectory' : 'isFile'}()) { foreign.add(fd); return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { uid: process.getuid() + 1 }); } return value; };
      fs.readFileSync = (fd, ...args) => { if (foreign.has(fd)) reads++; return read(fd, ...args); };
      fs.fchmodSync = (fd, ...args) => { if (foreign.has(fd)) chmods++; return chmod(fd, ...args); };
      process.on('exit', () => process.stdout.write('foreign-reads=' + reads + ';foreign-chmods=' + chmods));`);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /collector.*owner/i);
    assert.equal(result.stdout, 'foreign-reads=0;foreign-chmods=0');
    assert.equal(existsSync(join(dir, 'status.json')), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('Linux refuses a non-regular guard secret and a symlinked private directory', { skip: linuxSkip }, async () => {
  for (const symlink of [false, true]) {
    const dir = fixture();
    try {
      if (symlink) { mkdirSync(join(dir, 'elsewhere')); symlinkSync(join(dir, 'elsewhere'), join(dir, 'run.guard.d')); }
      else { mkdirSync(join(dir, 'run.guard.d'), { mode: 0o700 }); mkdirSync(join(dir, 'run.guard.d/run.guard-id')); }
      const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
      assert.notEqual(result.code, 0); assert.match(result.stderr, /collector/i);
      assert.equal(existsSync(join(dir, 'status.json')), false);
    } finally { rmSync(dir, { recursive: true }); }
  }
});

for (const [step, pausedEntries] of Object.entries(pauseSteps)) test(`a start SIGKILLed at ${step} recovers on restart, admits one recoverer and keeps unresolved paper exposure`, { skip: runSkip }, async () => {
  const dir = fixture(); const started = [];
  const start = (duration, env) => { const c = child([entry, 'run', '--data', dir, '--config', join(dir, 'config.json'), '--duration', String(duration)], env); started.push(c); return c; };
  try {
    const c = structuredClone(base); Object.assign(c.simulation, { enabled: true, entropyTakerFeeBps: 1, verifiedSymbols: ['SNDK'] });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(c));
    const crashed = start(30);
    const status = await waitStatus(dir, crashed.processChild.pid); assert.equal(status.mode, 'paper');
    // The crashed collector leaves a dead-owner run.lock, so the next start takes the recovery path.
    crashed.processChild.kill('SIGKILL'); await crashed.done;
    const paused = start(30, { ENTROPY_LAB_TEST_PAUSE_AT: step });
    await waitPaused(paused, step);
    assert.deepEqual(startEntries(dir).map((name) => name.replace(/-[0-9a-f-]{36}$/, '-*')), pausedEntries);
    if (step === 'lock-dir-created') assert.deepEqual(readdirSync(join(dir, startEntries(dir).find((name) => name.includes('.pending-')))), []);
    const blocked = await start(1).done;
    assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /claiming/);
    paused.processChild.kill('SIGKILL'); await paused.done;
    const results = await Promise.all([start(4).done, start(4).done]);
    assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results.map((r) => r.stderr)));
    assert.match(results.find((r) => r.code !== 0).stderr, lockRefusal);
    assert.deepEqual(startEntries(dir), guardEntries);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.mode, 'research'); assert.match(report.paperSuspendedReason, /previous_session/);
    const original = JSON.parse(readFileSync(join(dir, 'unresolved-paper.json'), 'utf8'));
    assert.equal(original.mode, 'paper'); assert.equal(original.session, status.session);
  } finally {
    for (const c of started) if (c.processChild.exitCode === null && c.processChild.signalCode === null) { c.processChild.kill('SIGKILL'); await c.done; }
    rmSync(dir, { recursive: true });
  }
});

test('start remnants left by an earlier version after a SIGKILL are recovered once they are older than the grace period', { skip: runSkip }, async () => {
  const old = new Date(Date.now() - 3600000);
  const ownerDir = (path, pid) => { mkdirSync(path); if (pid) writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid, token: 'old' })); utimesSync(path, old, old); };
  const remnants = {
    'guard created': async (dir) => { ownerDir(join(dir, 'run.lock'), await deadPid()); },
    'lock directory created before owner': async (dir) => { ownerDir(join(dir, 'run.lock')); },
    'old lock renamed': async (dir) => { ownerDir(join(dir, `run.lock.stale-${randomUUID()}`), await deadPid()); },
    'new lock created': async (dir) => { ownerDir(join(dir, `run.lock.stale-${randomUUID()}`), await deadPid()); ownerDir(join(dir, 'run.lock'), await deadPid()); },
  };
  for (const [name, prepare] of Object.entries(remnants)) {
    const dir = fixture();
    try {
      await prepare(dir); ownerDir(join(dir, 'run.claim'));
      const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      assert.deepEqual(startEntries(dir), guardEntries, name);
    } finally { rmSync(dir, { recursive: true }); }
  }
});

test('a fresh earlier-version guard or unpublished lock owner is not treated as abandoned', { skip: runSkip }, async () => {
  for (const name of ['run.claim', 'run.lock']) {
    const dir = fixture();
    try {
      mkdirSync(join(dir, name));
      const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
      assert.notEqual(result.code, 0); assert.match(result.stderr, new RegExp(name.replace('.', '\\.'))); assert.match(result.stderr, lockRefusal);
      assert.deepEqual(startEntries(dir), [name, ...guardEntries].sort());
    } finally { rmSync(dir, { recursive: true }); }
  }
});

test('a live collector keeps its lock while another start is refused', { skip: runSkip }, async () => {
  const dir = fixture(); let live;
  try {
    live = child([entry, 'run', '--data', dir, '--duration', '4']);
    await waitStatus(dir, live.processChild.pid);
    const owner = readFileSync(join(dir, 'run.lock/owner.json'), 'utf8');
    const refused = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /Another collector is active/);
    assert.equal(readFileSync(join(dir, 'run.lock/owner.json'), 'utf8'), owner);
    assert.equal(JSON.parse(owner).pid, live.processChild.pid);
    const result = await live.done; assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(startEntries(dir), guardEntries);
  } finally {
    if (live?.processChild.exitCode === null) { live.processChild.kill('SIGKILL'); await live.done; }
    rmSync(dir, { recursive: true });
  }
});

test('an expired earlier-version guard does not let a start replace a live collector lock', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const old = new Date(Date.now() - 3600000);
    mkdirSync(join(dir, 'run.lock'));
    const owner = JSON.stringify({ pid: process.pid, token: 'live' });
    writeFileSync(join(dir, 'run.lock/owner.json'), owner);
    mkdirSync(join(dir, 'run.claim')); utimesSync(join(dir, 'run.claim'), old, old);
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Another collector is active/);
    assert.equal(readFileSync(join(dir, 'run.lock/owner.json'), 'utf8'), owner);
    assert.ok(existsSync(join(dir, 'run.claim')));
  } finally { rmSync(dir, { recursive: true }); }
});

test('concurrent first starts publish a single private start guard id', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => child([entry, 'run', '--data', dir, '--duration', '4']).done));
    assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results.map((r) => r.stderr)));
    for (const r of results.filter((r) => r.code !== 0)) assert.match(r.stderr, lockRefusal);
    assert.match(readFileSync(guardPath(dir), 'utf8'), /^[0-9a-f]{32}$/);
    assert.deepEqual(startEntries(dir), guardEntries);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the published start guard id is readable only by its current user', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(result.code, 0, result.stderr);
    assertGuardPermissions(dir);
  } finally { rmSync(dir, { recursive: true }); }
});

test('Windows guard permissions support Unicode and shell metacharacters in data paths', { skip: process.platform !== 'win32' }, async () => {
  const parent = fixture();
  const dir = join(parent, "中文 [collector] & ' data");
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, 'cooldowns.json'), readFileSync(join(parent, 'cooldowns.json')));
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(result.code, 0, result.stderr);
    assertGuardPermissions(dir);
  } finally { rmSync(parent, { recursive: true }); }
});

test('each Windows start repairs inherited and explicit access on an existing guard id', { skip: process.platform !== 'win32' }, async () => {
  const dir = fixture();
  try {
    const first = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(first.code, 0, first.stderr);
    const id = readFileSync(guardPath(dir), 'utf8');
    execFileSync('icacls.exe', [guardPath(dir), '/inheritance:e', '/grant', '*S-1-1-0:R'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    execFileSync('icacls.exe', [join(dir, 'run.guard.d'), '/inheritance:e', '/grant', '*S-1-1-0:(OI)(CI)R'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const again = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(again.code, 0, again.stderr);
    assertGuardPermissions(dir);
    assertPrivateWindows(join(dir, 'run.guard.d'), true);
    assert.equal(readFileSync(guardPath(dir), 'utf8'), id);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const existing of [false, true]) test(`a Windows ACL command failure refuses the collector with ${existing ? 'an existing' : 'a new'} guard id`, { skip: process.platform !== 'win32' }, async () => {
  const dir = fixture();
  try {
    if (existing) { mkdirSync(join(dir, 'run.guard.d')); writeFileSync(guardPath(dir), '1'.repeat(32)); }
    const result = await faultedRun(dir, `let calls = 0;
      childProcess.execFileSync = (_file, _args, options) => {
        if (options.timeout !== 10000 || options.shell) throw new Error('ACL commands must have a ten-second timeout and no shell');
        calls++; const error = new Error('injected ACL timeout'); error.code = 'ETIMEDOUT'; throw error;
      };
      process.on('exit', () => process.stdout.write('acl-calls=' + calls));`);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /collector/i); assert.match(result.stderr, /inheritance.*FullControl/i);
    assert.equal(result.stdout, 'acl-calls=1', 'failed ACL commands must not be retried');
    assert.deepEqual(startEntries(dir), existing ? guardEntries : []);
    if (existing) assert.equal(readFileSync(guardPath(dir), 'utf8'), '1'.repeat(32));
    assert.equal(existsSync(join(dir, 'status.json')), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('guard-id publication stops after three attempts when every temporary disappears', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const result = await faultedRun(dir, `const link = fs.linkSync; let attempts = 0;
      fs.linkSync = (source, destination) => { attempts++; fs.unlinkSync(source); return link(source, destination); };
      process.on('exit', () => process.stdout.write('link-attempts=' + attempts));`);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /collector.*3 attempts/i);
    assert.equal(result.stdout, 'link-attempts=3');
    assert.deepEqual(startEntries(dir), ['run.guard.d']);
    assert.equal(existsSync(join(dir, 'status.json')), false);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const published of [true, false]) test(`a start whose guard temporary disappears before linking recovers with ${published ? 'a peer-published id' : 'no published id'}`, { skip: runSkip }, async () => {
  const dir = fixture(); let paused;
  try {
    const resume = join(dir, 'resume-start');
    paused = child([entry, 'run', '--data', dir, '--duration', '1'], { ENTROPY_LAB_TEST_PAUSE_AT: 'guard-id-written', ENTROPY_LAB_TEST_RESUME_FILE: resume });
    await waitPaused(paused, 'guard-id-written');
    const temp = join(dir, startEntries(dir).find((name) => name.startsWith('run.guard.d/run.guard-id.tmp-')));
    let peerId;
    if (published) {
      const old = new Date(Date.now() - 3600000); utimesSync(temp, old, old);
      const peer = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
      assert.equal(peer.code, 0, peer.stderr);
      peerId = readFileSync(guardPath(dir), 'utf8');
    } else unlinkSync(temp);
    assert.equal(existsSync(temp), false, 'the source file must disappear before the paused start links it');
    writeFileSync(resume, '');
    const result = await paused.done;
    assert.equal(result.code, 0, result.stderr);
    const id = readFileSync(guardPath(dir), 'utf8');
    assert.match(id, /^[0-9a-f]{32}$/);
    if (published) assert.equal(id, peerId);
    assert.deepEqual(startEntries(dir), guardEntries);
    assertGuardPermissions(dir);
  } finally {
    if (paused?.processChild.exitCode === null && paused.processChild.signalCode === null) { paused.processChild.kill('SIGKILL'); await paused.done; }
    rmSync(dir, { recursive: true });
  }
});

for (const published of [true, false]) test(`Windows recovers a private temporary removed before its first open with ${published ? 'a peer id' : 'no peer id'}`, { skip: process.platform !== 'win32' }, async () => {
  const dir = fixture();
  try {
    const result = await faultedRun(dir, `const open = fs.openSync; let attempts = 0;
      fs.openSync = (path, flags, ...args) => {
        if (flags === 'r+' && String(path).includes('run.guard-id.tmp-')) {
          attempts++;
          if (attempts === 1) { fs.unlinkSync(path); ${published ? "fs.writeFileSync(String(path).slice(0, String(path).lastIndexOf('.tmp-')), '4'.repeat(32), { flag: 'wx', mode: 0o600 });" : ''} }
        }
        return open(path, flags, ...args);
      };
      process.on('exit', () => process.stdout.write('open-attempts=' + attempts));`);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.endsWith(`open-attempts=${published ? 1 : 2}`), result.stdout);
    if (published) assert.equal(readFileSync(guardPath(dir), 'utf8'), '4'.repeat(32));
    assert.deepEqual(startEntries(dir), guardEntries); assertGuardPermissions(dir);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the start guard name derives from the stored secret and stays stable across starts', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const first = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(first.code, 0, first.stderr);
    const id = readFileSync(guardPath(dir), 'utf8');
    const release = await occupy(guardAddress(dir, id));
    try {
      const refused = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
      assert.notEqual(refused.code, 0); assert.match(refused.stderr, /claiming/);
    } finally { await release(); }
    const again = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(again.code, 0, again.stderr);
    assert.equal(readFileSync(guardPath(dir), 'utf8'), id);
  } finally { rmSync(dir, { recursive: true }); }
});

test('another local process holding the predictable path-only guard name cannot block a start', { skip: runSkip }, async () => {
  const dir = fixture();
  const release = await occupy(guardAddress(dir));
  try {
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(result.code, 0, result.stderr);
  } finally { await release(); rmSync(dir, { recursive: true }); }
});

test('a start SIGKILLed before publishing its guard id recovers and later clears the leftover', { skip: runSkip }, async () => {
  const dir = fixture(); let paused;
  try {
    paused = child([entry, 'run', '--data', dir, '--duration', '30'], { ENTROPY_LAB_TEST_PAUSE_AT: 'guard-id-written' });
    await waitPaused(paused, 'guard-id-written');
    const normalized = () => startEntries(dir).map((name) => name.replace(/-[0-9a-f-]{36}$/, '-*'));
    assert.deepEqual(normalized(), ['run.guard.d', 'run.guard.d/run.guard-id.tmp-*']);
    paused.processChild.kill('SIGKILL'); await paused.done;
    const second = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(second.code, 0, second.stderr);
    assert.match(readFileSync(guardPath(dir), 'utf8'), /^[0-9a-f]{32}$/);
    assert.deepEqual(normalized(), [...guardEntries, 'run.guard.d/run.guard-id.tmp-*']);
    const old = new Date(Date.now() - 3600000);
    for (const name of startEntries(dir).filter((n) => n.includes('.tmp-'))) utimesSync(join(dir, name), old, old);
    const third = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(third.code, 0, third.stderr);
    assert.deepEqual(startEntries(dir), guardEntries);
  } finally {
    if (paused?.processChild.exitCode === null && paused.processChild.signalCode === null) { paused.processChild.kill('SIGKILL'); await paused.done; }
    rmSync(dir, { recursive: true });
  }
});

test('a collector whose lock was already removed still exits successfully', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const c = child([entry, 'run', '--data', dir, '--duration', '2']);
    await waitStatus(dir, c.processChild.pid);
    rmSync(join(dir, 'run.lock'), { recursive: true });
    const result = await c.done; assert.equal(result.code, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the start pause hook is inert in production', { skip: runSkip }, async () => {
  const dir = fixture(); let c;
  try {
    c = child([entry, 'run', '--data', dir, '--duration', '1'], { NODE_ENV: 'production', ENTROPY_LAB_TEST_PAUSE_AT: 'guard-acquired' });
    const result = await Promise.race([c.done, delay(15000).then(() => ({ code: 'timeout', stderr: c.output().stderr }))]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /test pause/);
  } finally {
    if (c?.processChild.exitCode === null && c.processChild.signalCode === null) { c.processChild.kill('SIGKILL'); await c.done; }
    rmSync(dir, { recursive: true });
  }
});

test('unclean paper session suspends paper on restart even before first five-second snapshot', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const c = structuredClone(base); Object.assign(c.simulation, { enabled: true, entropyTakerFeeBps: 1, verifiedSymbols: ['SNDK'] });
    const configFile = join(dir, 'config.json'); writeFileSync(configFile, JSON.stringify(c));
    const first = child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '30']);
    const status = await waitStatus(dir, first.processChild.pid); assert.equal(status.mode, 'paper');
    first.processChild.kill('SIGKILL'); await first.done;
    const second = await child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '1']).done;
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.mode, 'research'); assert.match(report.paperSuspendedReason, /previous_session/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-paper.json'), 'utf8')).mode, 'paper');
    const third = await child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '1']).done;
    assert.equal(third.code, 0, third.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-paper.json'), 'utf8')).session, status.session);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a managed collector exits when its parent IPC disconnects and preserves the final snapshot', { skip: runSkip }, async () => {
  const dir = fixture(); let worker;
  try {
    worker = spawn(process.execPath, [entry, 'run', '--data', dir], { windowsHide: true, env: { ...process.env, ENTROPY_LAB_MANAGED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    worker.stdout.resume(); worker.stderr.resume();
    const exited = new Promise((resolve) => worker.once('exit', (code) => resolve(code)));
    await waitStatus(dir, worker.pid); worker.disconnect();
    const deadline = delay(3000).then(() => { throw new Error('Orphan collector did not exit'); });
    assert.equal(await Promise.race([exited, deadline]), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).stopped, true);
    assert.equal(existsSync(join(dir, 'run.lock')), false);
  } finally {
    if (worker?.exitCode === null) worker.kill('SIGKILL');
    worker?.stdout.destroy(); worker?.stderr.destroy();
    rmSync(dir, { recursive: true });
  }
});

test('unclean research session suspends the directional study even before its first trade snapshot', { skip: runSkip }, async () => {
  const dir = fixture(); let first;
  try {
    first = child([entry, 'run', '--data', dir, '--duration', '30']);
    const status = await waitStatus(dir, first.processChild.pid);
    assert.equal(status.mode, 'research');
    first.processChild.kill('SIGKILL'); await first.done;
    const second = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.mode, 'research'); assert.equal(report.paperSuspendedReason, null);
    assert.match(report.binanceScalper.suspendedReason, /previous_session/);
    assert.equal(report.binanceScalper.openTasks.length, 0);
    assert.equal(report.binanceScalper.enabled, false);
    assert.equal(report.binanceScalper.previousSession.session, status.session);
    for (const symbol of Object.values(report.binanceScalper.bySymbol)) for (const scenario of Object.values(symbol.scenarios)) {
      assert.equal(scenario.stats.netBeforeRebate, null);
      assert.ok(scenario.stats.rebateScenarios.every(value => value.net === null));
    }
    const original = JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8'));
    assert.equal(original.session, status.session); assert.equal(original.stopped, false);
    const third = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(third.code, 0, third.stderr);
    assert.match(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).binanceScalper.suspendedReason, /previous_session/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8')).session, status.session);
  } finally {
    if (first?.processChild.exitCode === null) { first.processChild.kill('SIGKILL'); await first.done; }
    rmSync(dir, { recursive: true });
  }
});

test('a cleanly stopped research report with a pending directional exit keeps its original evidence', { skip: runSkip }, async () => {
  const dir = fixture();
  try {
    const original = { session: 'stopped-with-position', mode: 'research', observedAt: 1793000000000, stopped: true, counts: {}, binanceScalper: {
      enabled: true, suspendedReason: null, observedAt: 1793000000000,
      openTasks: [{ symbol: 'SNDK', state: 'exit_pending', entry: { cash: 100, fee: 0.05 } }],
      bySymbol: { SNDK: { scenarios: { base: { state: 'exit_pending', position: { direction: 'long', entryPrice: 100 },
        stats: { completed: 2, lossesBeforeRebate: 1, fees: 0.15, turnover: 300, settledNetBeforeRebate: -3,
          netBeforeRebate: null, grossPnl: null, rebateScenarios: [{ ratio: 1.1, contingentRebate: 0.165, net: null }] },
        recentTrades: [{ id: 'prior-loss', netBeforeRebate: -3 }] } } } },
    } };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(original));
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.match(report.binanceScalper.suspendedReason, /previous_session/);
    assert.deepEqual(report.binanceScalper.openTasks, original.binanceScalper.openTasks);
    assert.deepEqual(report.binanceScalper.bySymbol, original.binanceScalper.bySymbol);
    assert.equal(report.binanceScalper.observedAt, original.observedAt);
    assert.equal(report.binanceScalper.previousSession.session, original.session);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8')), original);
  } finally { rmSync(dir, { recursive: true }); }
});
