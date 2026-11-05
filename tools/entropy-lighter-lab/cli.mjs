#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Lab, Recorder, atomicJson, automaticConfig, readPreviousReport, validateConfig } from './core.mjs';
import { discover, startFeeds } from './feeds.mjs';

function argumentsFor(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--config', '--data', '--duration'].includes(rest[i]) || rest[i + 1] === undefined || Object.hasOwn(options, rest[i])) throw new Error('Usage: cli.mjs {check|run|report} [--config FILE] [--data DIR] [--duration SECONDS]');
    options[rest[i]] = rest[i + 1];
  }
  const duration = options['--duration'] === undefined ? null : Number(options['--duration']);
  if (duration !== null && (!Number.isFinite(duration) || duration < 1 || duration > 86400)) throw new Error('duration must be 1..86400 seconds');
  return { command, configPath: resolve(options['--config'] || join(dirname(fileURLToPath(import.meta.url)), 'config.example.json')), data: resolve(options['--data'] || '.data-entropy-lighter'), duration };
}

// Earlier versions arbitrated with a run.claim directory and wrote owner.json after
// creating run.lock, both within milliseconds. Remnants older than this are abandoned;
// it stays below the systemd start-limit budget (5 starts, RestartSec=5).
const LEGACY_START_GRACE_MS = 10_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ABANDONED_START_ENTRY = new RegExp(`^run\\.lock\\.(pending|stale)-${UUID}$`);
const GUARD_ID_TEMP = new RegExp(`^run\\.guard-id\\.tmp-${UUID}$`);
const GUARD_ID = /^[0-9a-f]{32}$/;
const GUARD_ID_PUBLISH_ATTEMPTS = 3;
const GUARD_DIRECTORY = 'run.guard.d';
const WINDOWS_GUARD_ACL_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json',
  '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  'function Result($state, $owner) { [pscustomobject]@{ state = $state; owner = $owner; sid = $sid.Value } | ConvertTo-Json -Compress }',
  'function Owner($acl) { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if ($owner -ne $sid.Value) { Result "foreign-owner" $owner; exit 0 } }',
  'function PrivateAcl($directory, $create) { ' +
    '$acl = if ($directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }; ' +
    '$flags = if ($directory) { "OICI" } else { "" }; ' +
    '$acl.SetSecurityDescriptorSddlForm(("D:P(A;" + $flags + ";FA;;;" + $sid.Value + ")"), [Security.AccessControl.AccessControlSections]::Access); ' +
    'if ($create) { $acl.SetOwner($sid) }; return $acl }',
  'function Inspect($path, $directory) { ' +
    '$attributes = [IO.File]::GetAttributes($path); ' +
    'if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw "Invalid collector guard object type" }; ' +
    '$acl = if ($directory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }; Owner $acl; return $acl }',
  'function Verify($acl, $directory) { ' +
    'Owner $acl; $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); $flags = if ($directory) { 3 } else { 0 }; ' +
    'if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or ' +
    '$rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ' +
    '$rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or [int]$rules[0].InheritanceFlags -ne $flags -or ' +
    '[int]$rules[0].PropagationFlags -ne 0) { throw "Invalid collector guard DACL" } }',
  // Security descriptors are supplied to the creation APIs, so no readable empty
  // file or directory is exposed before a later ACL repair.
  'if (-not [IO.Directory]::Exists($request.directory)) { $null = [IO.Directory]::CreateDirectory($request.directory, (PrivateAcl $true $true)) }',
  '$acl = Inspect $request.directory $true',
  '[IO.Directory]::SetAccessControl($request.directory, (PrivateAcl $true $false))',
  'Verify (Inspect $request.directory $true) $true',
  '$path = [IO.Path]::Combine($request.directory, "run.guard-id")',
  '$present = $true; try { $null = [IO.File]::GetAttributes($path) } catch [IO.FileNotFoundException] { $present = $false }',
  'if ($present) { ' +
    '$acl = Inspect $path $false; [IO.File]::SetAccessControl($path, (PrivateAcl $false $false)); Verify (Inspect $path $false) $false; ' +
    'Result "existing" $sid.Value; exit 0 }',
  'if (-not $request.temporary) { Result "missing" $sid.Value; exit 0 }',
  '$stream = New-Object IO.FileStream($request.temporary, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (PrivateAcl $false $true))',
  '$stream.Dispose()',
  'Verify (Inspect $request.temporary $false) $false',
  'Result "temporary" $sid.Value',
].join('; ');

// Test-only fault injection: freezes the start at a named step so a test can SIGKILL it there.
function reachStartStep(step) {
  if (process.env.NODE_ENV === 'production' || process.env.ENTROPY_LAB_TEST_PAUSE_AT !== step) return;
  writeSync(2, `entropy-lighter-lab test pause: ${step}\n`);
  const resume = process.env.ENTROPY_LAB_TEST_RESUME_FILE;
  const deadline = Date.now() + 60000;
  const state = new Int32Array(new SharedArrayBuffer(4));
  do {
    if (resume && existsSync(resume)) return;
    Atomics.wait(state, 0, 0, resume ? 25 : 60000);
  } while (resume && Date.now() < deadline);
  process.exit(98);
}

// Guard names are visible machine-wide, so they include a secret only the data directory
// owner can read; otherwise any local user could pre-bind the name and block every start.
// The id is written and synced in a private temporary file and published with link(),
// which fails if another start published first, so readers never see a partial id.
function startGuardId(data) {
  const directory = join(data, GUARD_DIRECTORY);
  const path = join(directory, 'run.guard-id');
  if (process.platform === 'linux') preparePosixGuardDirectory(directory);
  for (let attempt = 0; attempt < GUARD_ID_PUBLISH_ATTEMPTS; attempt++) {
    const temp = `${path}.tmp-${randomUUID()}`;
    try {
      if (process.platform === 'win32') {
        if (prepareWindowsGuard(directory, temp) === 'existing') return readStartGuardId(path, true);
      } else {
        try { return readStartGuardId(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const fd = openGuardFile(temp, process.platform === 'win32' ? 'r+' : 'wx');
      try {
        reachStartStep('guard-id-created');
        writeSync(fd, randomBytes(16).toString('hex')); fsyncSync(fd);
      } finally { closeSync(fd); }
      reachStartStep('guard-id-written');
      let publishedByUs = false;
      try { linkSync(temp, path); publishedByUs = true; } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
      // Cleanup may have removed this live starter's old temporary. Prefer an id
      // already published by a peer; if none exists, retry with a fresh temporary.
      try { return readStartGuardId(path, publishedByUs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } catch (e) {
      // Windows creates the private empty file in the helper. A paused caller
      // can lose that file to cleanup even before Node opens it for writing.
      if (e.code !== 'ENOENT') throw e;
      try { return readStartGuardId(path); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
    } finally { rmSync(temp, { force: true }); }
  }
  throw new Error(`Cannot publish collector start guard id after ${GUARD_ID_PUBLISH_ATTEMPTS} attempts; inspect data directory permissions and cleanup tools`);
}

export function assertCollectorGuardOwner(owner, expected) {
  const valid = typeof expected === 'string' ? /^S-1-\d+(?:-\d+)+$/.test(expected) : Number.isSafeInteger(expected) && expected >= 0;
  if (!valid || owner !== expected) throw new Error('Collector guard owner differs from the current account; stop the collector and inspect ownership of run.guard.d and run.guard-id. Use a directory owned by this account; ownership will not be taken automatically.');
}

function prepareWindowsGuard(directory, temporary = null) {
  let output;
  try {
    // No shell or command interpolation; one attempt, at most 10 seconds. No
    // secret is passed to the helper. It returns only state and ownership SIDs.
    output = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_GUARD_ACL_SCRIPT],
      { input: Buffer.from(JSON.stringify({ directory, temporary }), 'utf8').toString('base64'), encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Cannot protect collector run.guard.d permissions on Windows; stop the collector and use file Properties > Security > Advanced to disable inheritance, remove all other permission entries and grant this collector account FullControl (including inheritance to files and subdirectories on run.guard.d), then retry. Check that Windows PowerShell is available.');
  }
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Invalid collector guard permission helper result'); }
  assertCollectorGuardOwner(result.owner, result.sid);
  if (!['existing', 'temporary', 'missing'].includes(result.state)) throw new Error('Invalid collector guard permission helper state');
  return result.state;
}

function preparePosixGuardDirectory(directory) {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  let fd;
  try { fd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); }
  catch { throw new Error('Cannot open collector private guard directory; inspect run.guard.d ownership, permissions and links'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error('Collector guard directory must be an ordinary directory');
    assertCollectorGuardOwner(stat.uid, process.getuid());
    if ((stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function openGuardFile(path, flags) {
  let fd;
  try {
    fd = openSync(path, process.platform === 'linux' && flags === 'r'
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK : flags, 0o600);
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    throw new Error('Cannot open collector guard secret; inspect run.guard.d/run.guard-id ownership, permissions and links');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Collector guard secret must be an ordinary file');
    if (process.platform === 'linux') {
      assertCollectorGuardOwner(stat.uid, process.getuid());
      if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    }
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}

function readStartGuardId(path, alreadyProtected = false) {
  if (process.platform === 'win32' && !alreadyProtected) prepareWindowsGuard(dirname(path));
  const fd = openGuardFile(path, 'r');
  try {
    const id = readFileSync(fd, 'utf8');
    if (!GUARD_ID.test(id)) throw new Error('Invalid collector start guard id; stop the collector and inspect run.guard.d/run.guard-id');
    return id;
  } finally { closeSync(fd); }
}

// The kernel releases an abstract Unix socket or a named pipe when its process dies,
// even by SIGKILL, so unlike a directory this guard cannot be left behind.
function startGuardAddress(data, guardId) {
  const path = realpathSync.native(data);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const id = createHash('sha256').update(`${key}\0${guardId}`).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\project-aggregation-entropy-lighter-${id}` : `\0project-aggregation-entropy-lighter-${id}`;
}

async function acquireStartGuard(data) {
  const address = startGuardAddress(data, startGuardId(data));
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: address, exclusive: true }, resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('Another start is claiming the collector lock; retry after it finishes');
    throw error;
  }
  return () => new Promise((resolve) => server.close(() => resolve()));
}

// Caller must hold the start guard: every pending/stale name and every run.lock
// publication or replacement by this version happens only under it.
function claimCollectorLock(data, lock, token) {
  const now = Date.now();
  // Every refusal is decided before anything is removed, so a refused start leaves the
  // directory exactly as it found it.
  const legacyGuard = join(data, 'run.claim');
  const legacy = statOrNull(legacyGuard);
  if (legacy && !(now - legacy.mtimeMs > LEGACY_START_GRACE_MS)) throw new Error('A start from an earlier version may be claiming the collector lock; retry later or inspect run.claim');
  const existing = statOrNull(lock);
  if (existing) {
    let ownerText = '';
    try { ownerText = readFileSync(join(lock, 'owner.json'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!ownerText) {
      if (!(now - existing.mtimeMs > LEGACY_START_GRACE_MS)) throw new Error('Collector lock owner is not published yet; retry later or inspect run.lock');
    } else {
      let owner = null;
      try { owner = JSON.parse(ownerText); } catch {}
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('Invalid collector lock; inspect run.lock');
      try { process.kill(owner.pid, 0); throw new Error('Another collector is active in this data directory'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  if (legacy) rmdirSync(legacyGuard);
  for (const name of readdirSync(data)) {
    if (ABANDONED_START_ENTRY.test(name)) rmSync(join(data, name), { recursive: true });
  }
  // A live creator tolerates an old temporary being reclaimed before publication.
  const guardDirectory = join(data, GUARD_DIRECTORY);
  for (const name of readdirSync(guardDirectory)) {
    if (GUARD_ID_TEMP.test(name) && now - (statOrNull(join(guardDirectory, name))?.mtimeMs ?? now) > LEGACY_START_GRACE_MS) rmSync(join(guardDirectory, name), { force: true });
  }
  const stale = `${lock}.stale-${token}`;
  if (existing) {
    renameSync(lock, stale);
    reachStartStep('old-lock-renamed');
  }
  const pending = `${lock}.pending-${token}`;
  mkdirSync(pending, { mode: 0o700 });
  reachStartStep('lock-dir-created');
  writeFileSync(join(pending, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  renameSync(pending, lock);
  reachStartStep('new-lock-published');
  if (existing) rmSync(stale, { recursive: true });
  // An earlier-version start does not honor the guard; detect it replacing the new lock.
  if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token !== token) throw new Error('Collector lock was replaced during start; stop all collectors and inspect run.lock');
}

function statOrNull(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function run({ configPath, data, duration }) {
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('Collector start arbitration requires Linux or Windows');
  const source = readFileSync(configPath, 'utf8');
  const config = validateConfig(automaticConfig(JSON.parse(source)));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // run.lock with PID ownership verification prevents two collectors from writing one
  // data directory or consuming the same paper book; the start guard serializes its
  // inspection, recovery and publication.
  const lock = join(data, 'run.lock');
  const lockToken = randomUUID();
  const releaseStartGuard = await acquireStartGuard(data);
  try {
    reachStartStep('guard-acquired');
    claimCollectorLock(data, lock, lockToken);
  } finally {
    await releaseStartGuard();
  }
  let cleanupReady = false;
  try {
    const session = randomUUID(), startedAt = new Date().toISOString();
    const abort = new AbortController();
    const previous = readPreviousReport(data);
    const previousScalper = previous?.binanceScalper;
    const previousScalperUnresolved = previousScalper?.suspendedReason || previousScalper?.openTasks?.length
      || Object.values(previousScalper?.bySymbol || {}).some((row) => Object.values(row?.scenarios || {}).some((scenario) => scenario.stats?.unresolved > 0))
      || (previousScalper?.enabled === true && !previous.stopped);
    const scalperSuspendedReason = previousScalperUnresolved ? 'previous_session_has_unresolved_scalper_exposure' : null;
    if (scalperSuspendedReason && previous && !existsSync(join(data, 'unresolved-scalper.json'))) atomicJson(join(data, 'unresolved-scalper.json'), previous);
    const previousUnresolved = previous?.openPaperTasks?.length || Object.values(previous?.paper || {}).some((r) => r.unresolved > 0) || previous?.paperSuspendedReason || (previous?.mode === 'paper' && !previous.stopped);
    const paperSuspendedReason = previousUnresolved ? 'previous_session_has_unresolved_paper_exposure_review_previous_report' : null;
    if (paperSuspendedReason && previous && !existsSync(join(data, 'unresolved-paper.json'))) atomicJson(join(data, 'unresolved-paper.json'), previous);
    const effective = structuredClone(config);
    if (paperSuspendedReason) effective.simulation.enabled = false;
    const recorder = new Recorder(data, config, session);
    let fatal = null, feeds = null, metadata = null, refreshing = false, refreshPromise = null;
    const diagnostics = { counts: {}, last: {}, rttMs: {} };
    const cooldownFile = join(data, 'cooldowns.json');
    const cooldowns = existsSync(cooldownFile) ? JSON.parse(readFileSync(cooldownFile, 'utf8')) : {};
    for (const [key, value] of Object.entries(cooldowns)) if (!['entropy', 'lighter', 'binance'].includes(key) || !Number.isFinite(value) || value < 0) throw new Error('Invalid persisted API cooldown');
    const fail = (error) => { if (!fatal) { fatal = error; abort.abort(); } };
    const safe = (fn) => (...args) => { if (fatal) return; try { fn(...args); } catch (e) { fail(e); } };
    const lab = new Lab(effective, safe((event) => recorder.write(event)), { automaticFees: true, scalperSuspendedReason });
    const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    const diagnostic = safe((d) => {
      const key = `${d.venue || 'collector'}:${d.event}`;
      diagnostics.counts[key] = (diagnostics.counts[key] || 0) + 1;
      diagnostics.last[key] = d;
      if (Number.isFinite(d.details?.rttMs)) {
        const samples = diagnostics.rttMs[key] || []; samples.push(d.details.rttMs);
        if (samples.length > 1000) samples.shift(); diagnostics.rttMs[key] = samples;
      }
      if (d.event === 'invalidated') lab.invalidate(d.venue, d.symbol, d.reason || d.details?.reason || d.message);
      if (d.event === 'cooldown') atomicJson(cooldownFile, cooldowns);
      recorder.write({ type: 'diagnostic', ...d });
    });
    const snapshot = () => {
      const research = lab.report();
      if (scalperSuspendedReason) {
        // Preserve the original visible evidence across every restart. The new
        // engine stays suspended; none of the old tasks is resumed or re-priced.
        const retained = structuredClone(previousScalper);
        for (const symbol of Object.values(retained.bySymbol || {})) for (const scenario of Object.values(symbol?.scenarios || {})) {
          if (!scenario.stats) continue;
          scenario.stats.netBeforeRebate = null; scenario.stats.grossPnl = null;
          for (const rebate of scenario.stats.rebateScenarios || []) rebate.net = null;
        }
        research.binanceScalper = { ...research.binanceScalper, ...retained, enabled: false,
          suspendedReason: scalperSuspendedReason,
          observedAt: retained.observedAt ?? previous.observedAt ?? null,
          previousSession: retained.previousSession || { session: previous.session, stopped: previous.stopped === true,
            heartbeatAt: previous.heartbeatAt ?? null, exposureUnconfirmed: true } };
      }
      return { schema: 1, pid: process.pid, session, mode: effective.simulation.enabled ? 'paper' : 'research', startedAt,
        heartbeatAt: new Date().toISOString(), region: config.region, configHash: createHash('sha256').update(source).digest('hex'),
        sessionConfig: structuredClone(effective), paperSuspendedReason, ...research, metadata, diagnostics,
        eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6 }, stopped: abort.signal.aborted };
    };
    const persist = () => {
      const report = snapshot();
      atomicJson(join(data, 'report.json'), report);
      atomicJson(cooldownFile, cooldowns);
      atomicJson(join(data, 'status.json'), { pid: report.pid, session, mode: report.mode, startedAt, heartbeatAt: report.heartbeatAt, stopped: report.stopped, paperSuspendedReason, books: report.counts.books });
      return report;
    };
    persist();
    recorder.write({ type: 'session_start', at: Date.now(), config, paperSuspendedReason, session });
    const refresh = async () => {
      if (refreshing || abort.signal.aborted) return;
      refreshing = true;
      try {
        const next = await discover({ signal: abort.signal, onDiagnostic: diagnostic, cooldowns });
        if (abort.signal.aborted) return;
        // Fee timestamps and prices do not change subscriptions. Refresh them
        // in place, so a routine fee refresh never tears down healthy books.
        const subscriptions = (value) => JSON.stringify((value?.markets || []).map((m) => [m.venue, m.symbol, m.nativeSymbol, m.marketId, m.status, m.quote, m.sizeDecimals, m.multiplier]).sort());
        const changed = !feeds || subscriptions(metadata) !== subscriptions(next);
        if (changed && feeds) { await feeds.stop(); feeds = null; }
        if (abort.signal.aborted) return;
        if (changed) for (const venue of ['entropy', 'lighter', 'binance']) lab.invalidate(venue, undefined, 'metadata_refresh');
        metadata = next;
        lab.setMarkets(metadata.markets);
        recorder.write({ type: 'metadata', ...metadata });
        if (changed) {
          feeds = startFeeds({ markets: metadata.markets, signal: abort.signal, cooldowns, onDiagnostic: diagnostic, onBook: safe((b) => lab.book(b)), onRaw: config.recordRaw ? safe((r) => recorder.write({ type: 'raw', ...r })) : undefined });
          feeds.done.catch(fail);
        }
        persist();
      } catch (e) {
        if (!abort.signal.aborted) diagnostic({ level: 'error', event: 'discovery_failed', message: 'Metadata unavailable; retry in 60 seconds', at: Date.now() });
      } finally { refreshing = false; }
    };
    const stop = () => abort.abort();
    const managedMessage = (message) => { if (message?.type === 'entropy-lighter-stop') stop(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.once('disconnect', stop);
    process.on('message', managedMessage);
    if (process.env.ENTROPY_LAB_MANAGED === '1' && !process.connected) stop();
    const ticker = setInterval(safe(() => { lab.advance(performance.now(), Date.now()); }), 50);
    const writer = setInterval(safe(persist), 5000);
    const launchRefresh = () => { refreshPromise = refresh(); refreshPromise.catch(fail); };
    const refresher = setInterval(() => {
      const missingTradingFeed = !metadata || ['entropy', 'lighter'].some((v) => !metadata.markets.some((m) => m.venue === v && m.status === 'active'));
      const missingFees = !metadata || metadata.markets.some((m) => ['entropy', 'lighter'].includes(m.venue)
        && (m.fee?.status !== 'available' || !(m.fee.expiresAt > Date.now() + 60000)));
      if (missingTradingFeed || missingFees || Date.now() - metadata.discoveredAt >= 900000) launchRefresh();
    }, 60000);
    const deadline = duration === null ? null : setTimeout(stop, duration * 1000);
    cleanupReady = true;
    try {
      launchRefresh();
      if (!abort.signal.aborted) await new Promise((done) => abort.signal.addEventListener('abort', done, { once: true }));
    } finally {
      clearInterval(ticker); clearInterval(writer); clearInterval(refresher); if (deadline) clearTimeout(deadline);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      process.removeListener('disconnect', stop);
      process.removeListener('message', managedMessage);
      if (refreshPromise) await refreshPromise;
      if (feeds) await feeds.stop();
      loop.disable();
      if (!fatal) {
        const report = persist(); recorder.write({ type: 'session_end', at: Date.now(), report });
        process.stdout.write(`${JSON.stringify({ session, data, books: report.counts.books, mode: report.mode, openPaperTasks: report.openPaperTasks.length, stopped: true })}\n`);
      }
    }
    if (fatal) throw fatal;
  } finally {
    // The directory is exclusively owned by this invocation after claim(); one already
    // removed by an operator is not a failed run.
    let owner = null;
    try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (owner?.token === lockToken) rmSync(lock, { recursive: true, force: true });
  }
  return cleanupReady;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (args.command === 'check') {
    validateConfig(automaticConfig(JSON.parse(readFileSync(args.configPath, 'utf8'))));
    process.stdout.write('Configuration valid; public-data research/paper only.\n');
  } else if (args.command === 'run') await run(args);
  else if (args.command === 'report') {
    const report = readPreviousReport(args.data);
    if (!report) throw new Error('No report.json in data directory');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.command === 'help') process.stdout.write('Usage: node cli.mjs {check|run|report} [--config FILE] [--data DIR] [--duration SECONDS]\n');
  else throw new Error('Unknown command');
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`entropy-lighter-lab: ${error.code || error.message}\n`);
  process.exitCode = 1;
});
