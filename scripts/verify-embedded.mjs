import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(process.argv[2] || '.');
const dataDir = await mkdtemp(path.join(tmpdir(), 'ci-package-data-'));
const password = 'package-test-only-123456';
let app, modules, failure, accountWriter, runtimeLock, recoveryDirectory, entry, interrupted;
// Stops the service entry's whole process group, so no runtime or API is left behind.
async function stopEntry() {
  const group = signal => { try { process.kill(-entry.pid, signal); } catch { /* Already gone. */ } };
  group('SIGTERM');
  const timer = setTimeout(() => group('SIGKILL'), 60_000);
  await entry.exited; clearTimeout(timer);
}
try {
  const { startModules } = await import(pathToFileURL(path.join(root, 'server/modules/runtime.mjs')));
  const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.mjs')));
  const { readSummary } = await import(pathToFileURL(path.join(root, 'server/adapters.mjs')));
  const { createAccountWriter } = await import(pathToFileURL(path.join(root, 'server/execution/account-writer.mjs')));
  const { acquireRuntimeLock, acquireRecoveryLocks } = await import(pathToFileURL(path.join(root, 'server/recovery/lifecycle-lock.mjs')));
  runtimeLock = await acquireRuntimeLock({ dataDir });
  const writerContext = { databasePath: path.join(dataDir, 'execution-control.sqlite'), runtimeId: randomUUID() };
  accountWriter = createAccountWriter({ ...writerContext, moduleId: 'hub' });
  modules = await startModules({ root, dataDir, logger: console, writerContext, onFailure: error => { failure = error; } });
  app = await createApp({ dataDir, initialPassword: password, embeddedModules: true, accountWriter, logger: () => {},
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(Number(process.env.PACKAGE_TEST_PORT || 3100), '127.0.0.1', resolve); });
  const port = app.server.address().port, host = `hub.localhost:${port}`;
  let cookie = '', csrf = '';
  function request(route, { method = 'GET', body, moduleHost = host, headers = {}, authorize = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
        headers: { Host: moduleHost, Origin: `http://${moduleHost}`, ...(authorize && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
          ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, text, data }); });
      }); req.on('error', reject); req.setTimeout(60_000, () => req.destroy(new Error(`Request timed out: ${route}`))); req.end(encoded);
    });
  }
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/projects')).status, 401);
  const login = await request('/api/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.data.csrfToken;
  const architecture = (await request('/api/system/architecture')).data;
  assert.equal(architecture.accountWriterVersion, 1);
  assert.equal(architecture.recoveryProtectionVersion, 1);
  for (const module of architecture.modules.filter(row => ['crossex', 'greeks', 'aster'].includes(row.moduleId))) {
    assert.equal(module.state, 'compatible'); assert.equal(module.capabilities.accountWriterVersion, 1); assert.equal(module.capabilities.recoveryProtectionVersion, 1);
  }
  const accounts = await request('/api/system/accounts');
  assert.equal(accounts.status, 200); assert.equal(accounts.data.enabled, true); assert.deepEqual(accounts.data.operations, []);
  const projects = (await request('/api/projects')).data.projects;
  assert.deepEqual(projects.map(item => item.id), ['monitor', 'asset', 'crossex', 'greeks', 'aster']);
  assert.equal((await request('/api/trading')).status, 200, 'Original trading module remains available');
  const hubPage = await request('/'); assert.equal(hubPage.status, 200); assert.match(hubPage.text, /<html/);
  const hubAssets = [...hubPage.text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(hubAssets.length > 0);
  for (const asset of hubAssets) { assert.ok((await readFile(path.join(root, 'dist', asset))).length); assert.equal((await request(asset)).status, 200); }
  const grants = [];
  for (const project of projects) {
    const launch = await request(`/api/projects/${project.id}/launch`, { method: 'POST' });
    assert.equal(launch.status, 200, launch.text);
    const url = new URL(launch.data.url); assert.equal(url.port, String(port));
    const auth = await request(url.pathname + url.search, { moduleHost: url.host, authorize: false, headers: { Origin: `http://${host}` } });
    assert.equal(auth.status, 302, auth.text);
    const headers = { Cookie: auth.headers['set-cookie'][0].split(';')[0] }, settings = { moduleHost: url.host, authorize: false, headers };
    grants.push(settings);
    const destination = new URL(auth.headers.location, url).pathname + new URL(auth.headers.location, url).search;
    const page = await request(destination, settings);
    assert.equal(page.status, 200, `${project.id}: ${page.text.slice(0, 300)}`); assert.match(page.text, /<html/i);
    const assets = [...page.text.matchAll(/(?:src|href)="(\/(?:assets|_next\/static|static)\/[^"#]+)"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, `${project.id}: frontend assets are referenced`);
    for (const asset of [...new Set(assets)].slice(0, 6)) assert.equal((await request(asset, settings)).status, 200, `${project.id}: ${asset}`);
    const summary = await request('/api/hub/summary?schemaVersion=2', settings);
    assert.equal(summary.status, 200, `${project.id} summary: ${summary.text.slice(0, 300)}`);
    if (project.id === 'aster') {
      const state = await request('/api/state', settings);
      assert.equal(state.status, 200, state.text.slice(0, 300));
      assert.equal(state.data.workspaceManaged, true);
      assert.equal((await request('/api/login', { ...settings, method: 'POST', body: { password } })).status, 409);
      assert.equal((await request('/api/logout', { ...settings, method: 'POST', body: {} })).status, 409);
    }
    const normalized = await readSummary(modules.projects.find(item => item.id === project.id), null, { deadline: Date.now() + 30_000 });
    assert.ok(Array.isArray(normalized.metrics), `${project.id}: summary is accepted by the real hub adapter`);
    assert.equal((await request('/__workspace/update-status', settings)).status, 403);
    console.log(`Packaged ${project.id}: page, static assets, authenticated summary and private boundary passed on ${port}.`);
  }
  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  for (const settings of grants) assert.equal((await request('/', settings)).status, 401);
  assert.equal(failure, undefined, failure?.message);
  await import(pathToFileURL(path.join(root, 'server/logger.mjs')));
  console.log('Complete deployment package passed: five real modules + native trading, one port, one login, logout revocation.');
  const beforeBackupLogin = await request('/api/login', { method: 'POST', body: { password } });
  assert.equal(beforeBackupLogin.status, 200); cookie = beforeBackupLogin.headers['set-cookie'][0].split(';')[0]; csrf = beforeBackupLogin.data.csrfToken;
  assert.equal((await request('/api/projects')).status, 200, 'backup contains a genuinely live session');
  // Exercise the actual packaged modules after restoring their persisted data,
  // not only fresh fixture factories. The Linux harness runs this in a netns.
  await app.close(); await modules.close(); await runtimeLock.close();
  app = modules = runtimeLock = undefined;
  const { createBackup } = await import(pathToFileURL(path.join(root, 'server/recovery/backup.mjs')));
  const { restoreBackup } = await import(pathToFileURL(path.join(root, 'server/recovery/restore.mjs')));
  recoveryDirectory = await mkdtemp(path.join(tmpdir(), 'ci-package-recovery-'));
  const backupDir = path.join(recoveryDirectory, 'checkpoint'), targetDir = path.join(recoveryDirectory, 'restored');
  const dataKey = randomBytes(32), secretsKey = randomBytes(32);
  let commit;
  for (const filename of ['.release-commit', '.source-sha']) {
    try { const value = (await readFile(path.join(root, filename), 'utf8')).trim(); if (/^[a-f0-9]{40}$/.test(value)) { commit = value; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(commit, 'verified package has a fixed release identity');
  let lock = await acquireRecoveryLocks({ dataDir });
  const backupStartedAt = Date.now();
  try { await createBackup({ dataDir, destination: backupDir, dataKey, secretsKey, lock, commit }); }
  finally { await lock.close(); }
  const faultAt = Date.now(), restoreStartedAt = Date.now();
  await mkdir(targetDir, { mode: 0o700 }); lock = await acquireRecoveryLocks({ dataDir: targetDir });
  try { await restoreBackup({ backupDir, targetDir, dataKey, secretsKey, lock }); }
  finally { await lock.close(); dataKey.fill(0); secretsKey.fill(0); }
  runtimeLock = await acquireRuntimeLock({ dataDir: targetDir });
  const restoredContext = { databasePath: path.join(targetDir, 'execution-control.sqlite'), runtimeId: randomUUID() };
  accountWriter = createAccountWriter({ ...restoredContext, moduleId: 'hub' });
  assert.equal(accountWriter.snapshot().recovery.state, 'quarantine');
  const testSubject = { authority: 'bybit', environment: 'mainnet', accountId: '999999999' };
  accountWriter.bind('restore-drill', testSubject, 1);
  const readTicket = accountWriter.claim([testSubject]);
  assert.throws(() => accountWriter.prepare(readTicket, 'restore-drill:blocked', { action: 'create' }), { code: 'RECOVERY_REQUIRED' });
  accountWriter.releaseBinding('restore-drill');
  modules = await startModules({ root, dataDir: targetDir, logger: console, writerContext: restoredContext, onFailure: error => { failure = error; } });
  app = await createApp({ dataDir: targetDir, initialPassword: password, embeddedModules: true, accountWriter, logger: () => {},
    refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
  assert.equal((await request('/api/projects')).status, 401, 'restored sessions never revive');
  const restoredLogin = await request('/api/login', { method: 'POST', body: { password } });
  assert.equal(restoredLogin.status, 200); cookie = restoredLogin.headers['set-cookie'][0].split(';')[0]; csrf = restoredLogin.data.csrfToken;
  assert.equal((await request('/api/system/recovery')).data.recovery.state, 'quarantine');
  assert.equal((await request('/api/projects')).data.projects.length, 5);
  for (const module of (await request('/api/system/architecture')).data.modules) assert.equal(module.state, 'compatible', module.moduleId);
  assert.equal((await request('/api/system/accounts')).data.recovery.state, 'quarantine');
  const diagnostic = spawnSync(process.env.ASTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-I', path.join(root, 'deploy/diagnose-aster-margin.py'), targetDir], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  assert.equal(diagnostic.status, 0, 'packaged read-only Aster diagnostic succeeds as the service account');
  const evidence = JSON.parse(diagnostic.stdout);
  assert.equal(evidence.schema, 'aster-margin-diagnostics/v1');
  assert.equal(evidence.recoveryState, 'quarantine');
  assert.deepEqual(evidence.sharedOperations.items, []);
  assert.equal(failure, undefined, failure?.message);
  console.log(JSON.stringify({ recoveryDrill: 'real-five-module-read-only', checkpointAgeAtFaultMs: faultAt - backupStartedAt,
    restoreToReadableMs: Date.now() - restoreStartedAt, scope: 'local-CI-artifact-and-keys', trading: 'quarantine' }));

  // The launcher of manual runs (server/index.mjs; the units start the same
  // two entries separately) over the data of the first phase: it starts the
  // runtime with the five modules and then the API. A killed API restarts alone while the runtime and its modules
  // keep running, collection goes on and the native execution lease keeps its
  // holder, sessions survive it, and SIGTERM to the whole process group (as
  // systemd signals the unit) stops it with status 0 (design doc 5.10).
  // Windows runs the single-process workbench instead.
  if (process.platform === 'linux') {
    await app.close(); await modules.close(); await runtimeLock.close();
    app = modules = runtimeLock = accountWriter = undefined;
    const { WORKBENCH_RUNTIME_DIR: _ignored, ...inherited } = process.env;
    entry = spawn(process.execPath, [path.join(root, 'server/index.mjs')], { cwd: root, detached: true, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...inherited, NODE_ENV: 'production', DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' } });
    entry.exited = new Promise(resolve => entry.once('exit', (code, signal) => resolve({ code, signal })));
    // The entry has its own process group, so a signal to this script does not
    // reach it: stop the group and remove the data before exiting.
    interrupted = () => {
      if (interrupted.running) return;
      interrupted.running = true;
      void stopEntry().then(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
        .then(() => recoveryDirectory && rm(recoveryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
        .finally(() => process.exit(130));
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupted);
    const until = async (predicate, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate().catch(() => false)) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const children = () => readFileSync(`/proc/${entry.pid}/task/${entry.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    const runtimePid = () => JSON.parse(readFileSync(path.join(dataDir, 'run', 'runtime.json'), 'utf8')).pid;
    const lease = () => { const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true }); try { return db.prepare('SELECT owner, expires FROM execution_lease WHERE id=1').get(); } finally { db.close(); } };
    const checkedAt = async () => Math.max(...(await request('/api/overview')).data.projects.map(item => Date.parse(item.checkedAt || '') || 0));
    const moduleRows = async () => (await request('/api/system/modules')).data.modules.map(({ moduleId, state, generation, readyAt }) => ({ moduleId, state, generation, readyAt }));
    assert.ok(await until(async () => (await request('/api/health')).status === 200, 180_000), 'the service entry became healthy');
    const signedIn = await request('/api/login', { method: 'POST', body: { password } });
    assert.equal(signedIn.status, 200, signedIn.text); cookie = signedIn.headers['set-cookie'][0].split(';')[0]; csrf = signedIn.data.csrfToken;
    assert.deepEqual((await request('/api/projects')).data.projects.map(item => item.id), ['monitor', 'asset', 'crossex', 'greeks', 'aster']);
    const runtime = runtimePid(), [api, ...others] = children().filter(pid => pid !== runtime);
    assert.deepEqual([children().includes(runtime), others], [true, []], 'the launcher runs exactly the runtime and the API');
    const rows = await moduleRows();
    assert.deepEqual(rows.map(row => row.state), ['ready', 'ready', 'ready', 'ready', 'ready'], JSON.stringify(rows));
    const open = async (project, when) => {
      const launch = await request(`/api/projects/${project}/launch`, { method: 'POST' });
      assert.equal(launch.status, 200, launch.text);
      const url = new URL(launch.data.url);
      const auth = await request(url.pathname + url.search, { moduleHost: url.host, authorize: false, headers: { Origin: `http://${host}` } });
      assert.equal(auth.status, 302, auth.text);
      const settings = { moduleHost: url.host, authorize: false, headers: { Cookie: auth.headers['set-cookie'][0].split(';')[0] } };
      const target = new URL(auth.headers.location, url), destination = target.pathname + target.search;
      const page = await request(destination, settings);
      assert.equal(page.status, 200, `${project} ${when}: ${page.text.slice(0, 300)}`); assert.match(page.text, /<html/i);
      return { project, destination, settings };
    };
    const portal = [];
    for (const project of ['monitor', 'asset', 'crossex', 'greeks', 'aster']) portal.push(await open(project, 'through the API process'));
    assert.equal((await request('/api/trading')).status, 200, 'forwarded to the runtime process');

    const { owner: holder, expires } = lease() ?? {};
    assert.ok(holder, 'the runtime holds the native execution lease');
    const killedAt = Date.now();
    process.kill(api, 'SIGKILL');
    assert.ok(await until(async () => children().some(pid => pid !== runtime && pid !== api) && (await request('/api/health')).status === 200, 60_000), 'the launcher restarted the API');
    assert.equal(alive(api), false);
    assert.equal(runtimePid(), runtime); assert.ok(alive(runtime), 'the runtime kept running');
    assert.deepEqual(await moduleRows(), rows, 'no module restarted with the API');
    // Each project is read at least every 30 s (data-plane refresh).
    assert.ok(await until(async () => await checkedAt() > killedAt, 60_000), 'collection went on across the API restart');
    assert.ok(await until(async () => lease()?.owner === holder && lease().expires > expires, 30_000), 'the lease holder renewed the native execution lease');
    assert.equal((await request('/api/projects')).status, 200, 'the session survived the API restart');
    // Portal grants live in the API process (design doc 1, persistent grants
    // are M4): a page asks to be reopened, and reopening reaches the same module.
    const reopened = [];
    for (const { project, destination, settings } of portal) {
      assert.equal((await request(destination, settings)).status, 401, `${project}: a grant of the previous API`);
      reopened.push(await open(project, 'reopened after the API restart'));
    }
    assert.deepEqual(await moduleRows(), rows, 'reopening the pages restarted no module');
    assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
    for (const { project, settings } of reopened) assert.equal((await request('/', settings)).status, 401, `${project} after logout`);

    const pids = children();
    process.kill(-entry.pid, 'SIGTERM');
    assert.deepEqual(await entry.exited, { code: 0, signal: null }, 'the unit stops with status 0');
    entry = undefined;
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupted);
    assert.deepEqual(pids.filter(alive), [], 'the runtime and the API stopped with the launcher');
    assert.equal(existsSync(path.join(dataDir, 'run', 'runtime.json')), false, 'the runtime removed its discovery record');
    console.log('Service entry passed: launcher, runtime with five real modules, API restart without module restarts, pages reopened, collection and execution lease kept, group SIGTERM exit 0.');
  }
} finally {
  // An interrupt cleans up and exits 130 on its own.
  if (interrupted?.running) await new Promise(() => {});
  if (entry) await stopEntry();
  await app?.close();
  await modules?.close();
  if (!app) accountWriter?.close();
  await runtimeLock?.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (recoveryDirectory) await rm(recoveryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
