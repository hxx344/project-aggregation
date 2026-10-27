import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { updateSettings } from '../server/control/update-state.mjs';
import { createExecutionJobsReader } from '../server/control/execution-jobs.mjs';
import { createModuleUpdateGuard, tradingModules } from '../server/modules/updates.mjs';
import { moduleCapabilities } from '../server/modules/capabilities.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { loadCredentialCipher } from '../server/runtime/credentials.mjs';
import { coordinatorHooks, createInProcessClient } from '../server/runtime/supervisor-client.mjs';
import { createUpdateCoordinator, UpdateError } from '../server/updates.mjs';
import { startApi } from '../server/api/main.mjs';
import { startEntry } from '../server/entry/main.mjs';
import { controlRequest, entrySockets, slotDirectory, slotSockets } from '../server/slot-protocol.mjs';

const protectedSkip = process.platform !== 'win32' && process.getuid() !== 0 ? 'Real updater metadata requires root; run with sudo in the existing privileged CI job' : false;
const bridgeFile = fileURLToPath(new URL('./fixtures/update-sharing.py', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function linesChild(t, args) {
  const child = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', bridgeFile, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', nextId = 0;
  const waiting = new Map(), lines = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = deferred();
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.ready) { ready.resolve(); return; }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new UpdateError(message.error.status, message.error.message));
    else pending.resolve(message.value);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Updater fixture exited ${code}/${signal}: ${stderr}`)); }
    waiting.clear(); resolve({ code, signal });
  }));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    }
    lines.close();
  };
  t.after(close);
  return { child, exited, ready: ready.promise,
    call(action, fields = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Updater fixture timed out on ${action}: ${stderr}`)); }, 10_000);
        waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...fields }) + '\n');
      });
    } };
}

async function fixture(t, { runtimeBootstrap = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-sharing-'));
  const cleanups = [], cleanup = { after: action => cleanups.push(action) };
  // Explicit reverse ownership order also works when the test assertion fails.
  t.after(async () => {
    try { for (const close of cleanups.reverse()) await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  // A real runtime creates its credential key before hub.sqlite. This fixture
  // precreates the database for the Python boundary, so preserve that order.
  if (runtimeBootstrap) loadCredentialCipher(root, { info() {} });
  const database = path.join(root, 'hub.sqlite'), databases = [];
  const connect = () => { const db = openHubDatabase(database); databases.push(db); return createControlStore(db); };
  const durable = connect(); cleanup.after(() => { for (const db of databases.reverse()) db.close(); });
  const rootUpdater = linesChild(cleanup, [root, database]);
  const state = await rootUpdater.call('check');
  assert.ok(state.planId); assert.deepEqual(state.planScopes, { source: 'full', ci: 'full' });
  const client = {
    status: () => rootUpdater.call('status'), check: () => rootUpdater.call('check'),
    apply: (planId, deployMode = 'source', scope = 'full') => rootUpdater.call('apply', { planId, deployMode, scope }),
  };
  return { root, database, connect, durable, rootUpdater, client, planId: state.planId, cleanup,
    holdCli: () => linesChild(cleanup, ['hold-cli', path.join(root, 'stack.lock')]) };
}

function coordinators(t, f, { holdAt = 'apply', createPair = true } = {}) {
  const active = Object.fromEntries(tradingModules.map(id => [id, null]));
  const held = deferred(), entered = deferred();
  let holdEvidence = holdAt === 'prepare';
  const request = async (origin, route, options) => {
    const id = tradingModules.find(id => origin === `http://${id}.workspace.internal`);
    assert.ok(id);
    if (route === '/__workspace/capabilities') return { data: moduleCapabilities(id) };
    if (route === '/__workspace/maintenance') { active[id] = options.body.active; return { data: { active: active[id] } }; }
    assert.equal(route, '/__workspace/update-status');
    if (id === 'crossex' && holdEvidence) {
      holdEvidence = false; entered.resolve(); await held.promise;
      return { data: { busy: true } };
    }
    return { data: { busy: false } };
  };
  const runtime = createRuntimeService({ guard: createModuleUpdateGuard({ request }), readMaintenance: updateSettings(f.durable).readMaintenance });
  const hooks = coordinatorHooks(createInProcessClient(runtime));
  const make = (client = f.client) => {
    const control = f.connect();
    const coordinator = createUpdateCoordinator({ client, execution: createExecutionJobsReader(control.db), ...updateSettings(control), ...hooks, tradingModules, releasePollMs: 0 });
    f.cleanup.after(() => coordinator.close()); return coordinator;
  };
  const a = createPair ? make(holdAt === 'apply' ? { ...f.client, async apply(...args) { entered.resolve(); await held.promise; return f.client.apply(...args); } } : f.client) : null;
  const b = createPair ? make() : null;
  f.cleanup.after(() => held.resolve());
  return { a, b, make, entered: entered.promise, release: held.resolve, active };
}

test('conflicting deployment modes are refused across APIs before privileged acceptance', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { a, b, entered, release, active } = coordinators(t, f);
  await a.initialize(); await b.initialize();
  const source = a.apply(f.planId, () => {}, 'source'); void source.catch(() => {});
  await entered;
  await assert.rejects(async () => b.apply(f.planId, () => {}, 'ci'), error => error instanceof UpdateError && error.status === 409);
  assert.equal(updateSettings(f.durable).readMaintenance(), true);
  assert.equal(updateSettings(f.durable).readPendingDeployMode(), 'source');
  release(); const accepted = await source;
  assert.equal(accepted.job.status, 'queued'); assert.equal(accepted.job.deployMode, 'source');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1);
  assert.equal(result.beforeInstaller[0].maintenance, true);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
});

test('the runtime sharing fixture preserves credential bootstrap before its precreated database', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t, { runtimeBootstrap: true });
  // Re-enter the real loader after SQLite exists, as startRuntime does. It
  // must reuse the original key and keep existing ciphertext readable.
  const first = loadCredentialCipher(f.root, { info() {} }), value = { fixture: 'offline' };
  const encrypted = first.encrypt(value);
  const restarted = loadCredentialCipher(f.root, { info() {} });
  assert.deepEqual(restarted.decrypt(encrypted), value);
});

test('the same-plan competing API waits for the first real stop check to finish before retrying', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { a, b, entered, release, active } = coordinators(t, f, { holdAt: 'prepare' });
  await a.initialize(); await b.initialize();
  const rejected = assert.rejects(a.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  await entered;
  await assert.rejects(async () => b.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  assert.equal((await f.rootUpdater.call('status')).job, null);
  release(); await rejected;
  assert.equal(updateSettings(f.durable).readMaintenance(), false);
  assert.equal(updateSettings(f.durable).readAdmissionOwner(), null);
  const accepted = await b.apply(f.planId, () => {}, 'source');
  assert.equal(accepted.job.status, 'queued'); assert.equal(accepted.job.scope, 'full');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1, 'the real worker acquired the stack lock and passed identity/release validation');
  t.diagnostic(JSON.stringify({ beforeInstaller: result.beforeInstaller, moduleMaintenance: active }));
  assert.equal(result.beforeInstaller[0].maintenance, true, 'the accepted full update must still own the durable maintenance latch');
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
});

test('an immediately scheduled worker cannot pass a live CLI installer stack lock', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), cli = f.holdCli();
  await cli.ready;
  assert.equal((await f.client.apply(f.planId, 'ci')).job.status, 'queued');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.state.job.status, 'failed'); assert.deepEqual(result.beforeInstaller, []);
  assert.match(result.state.job.message, /另一个部署/);
});

test('a delayed worker refuses a CLI installation identity changed since acceptance', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), cli = f.holdCli();
  await cli.ready;
  assert.equal((await f.client.apply(f.planId, 'ci')).job.status, 'queued');
  cli.child.stdin.end(); await cli.exited;
  await f.rootUpdater.call('identity-change');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.state.job.status, 'failed'); assert.deepEqual(result.beforeInstaller, []);
  assert.match(result.state.job.message, /本机版本已改变/);
});

for (const action of ['status', 'check']) test(`a delayed ${action} response cannot release a newer admission from another API`, { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  settings.writeMaintenance(true);
  const { b, make, active } = coordinators(t, f), captured = deferred(), release = deferred();
  f.cleanup.after(() => release.resolve());
  const observer = make({ ...f.client, async [action]() {
    const snapshot = await f.client[action](); captured.resolve(); await release.promise; return snapshot;
  } });
  await observer.initialize(); await b.initialize();
  const late = observer[action](); await captured.promise;
  assert.equal((await b.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  release.resolve(); await late;
  assert.equal(settings.readMaintenance(), true);
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1); assert.equal(result.beforeInstaller[0].maintenance, true);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
  await b.status();
  assert.equal(settings.readMaintenance(), false, 'the actual terminal worker state still releases the latch');
  assert.equal(await b.withExecutionEntry(() => 'allowed'), 'allowed');
});

test('a definite root rejection restores admission and a later accepted job releases on its real terminal state', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { b, active } = coordinators(t, f), settings = updateSettings(f.durable);
  await b.initialize();
  await assert.rejects(b.apply('unavailable-release-plan-1234', () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, false])));
  assert.equal((await f.rootUpdater.call('status')).job, null, 'a rejected plan did not launch a worker');
  assert.equal((await b.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  assert.equal((await f.rootUpdater.call('run')).state.job.status, 'failed', 'the offline installer deliberately stops at its entry boundary');
  await b.status();
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, false])));
});

test('a restarted API restores legacy pending admission without a token and releases after real worker completion', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  settings.writePendingPlanId(f.planId); settings.writePendingDeployMode('source'); settings.writeMaintenance(false);
  assert.equal(settings.readAdmissionToken(), '');
  const { b: restarted, active } = coordinators(t, f);
  await restarted.initialize();
  assert.equal(settings.readMaintenance(), true);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
  await restarted.status(); assert.equal(settings.readMaintenance(), true, 'the still-acceptable pending plan is not completion evidence');
  assert.equal((await restarted.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  await restarted.close();
  const { b: next } = coordinators(t, f); await next.initialize();
  assert.equal(settings.readMaintenance(), true, 'a restart during the accepted job retains maintenance');
  await f.rootUpdater.call('run'); await next.status();
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null);
});

test('an actual SQLite token write failure rolls back pending values and leaves the next admission usable', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { b, active } = coordinators(t, f), settings = updateSettings(f.durable);
  await b.initialize();
  f.durable.db.exec("CREATE TRIGGER refuse_update_token BEFORE INSERT ON settings WHEN NEW.key='updates-admission-token' BEGIN SELECT RAISE(ABORT,'admission token write failed'); END");
  assert.throws(() => b.apply(f.planId, () => {}, 'source'), /admission token write failed/);
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null); assert.equal(settings.readAdmissionToken(), '');
  assert.equal(settings.readAdmissionOwner(), null);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, false])));
  assert.equal((await f.rootUpdater.call('status')).job, null);
  f.durable.db.exec('DROP TRIGGER refuse_update_token');
  assert.equal((await b.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  assert.equal(settings.readMaintenance(), true); assert.ok(settings.readAdmissionToken());
});

test('uncertain acceptance retires its owner, keeps pending protection and permits an idempotent retry through another API', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { b, make } = coordinators(t, f), settings = updateSettings(f.durable);
  let acceptedId;
  const first = make({ ...f.client, async apply(...args) {
    acceptedId = (await f.client.apply(...args)).job.id;
    throw new UpdateError(503, 'accepted response deliberately lost', { uncertain: true });
  } });
  await first.initialize(); await b.initialize();
  await assert.rejects(first.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.uncertain === true);
  assert.equal(settings.readAdmissionOwner(), null);
  assert.equal(settings.readMaintenance(), true); assert.equal(settings.readPendingPlanId(), f.planId);
  const retry = await b.apply(f.planId, () => {}, 'source');
  assert.equal(retry.job.id, acceptedId, 'the real updater accepted the same job without relaunching it');
  assert.equal(settings.readAdmissionOwner(), null);
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1); assert.equal(result.beforeInstaller[0].maintenance, true);
  await b.status(); assert.equal(settings.readMaintenance(), false);
});

test('when both competing attempts fail no owner or pending latch is stranded', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { a, b, entered, release } = coordinators(t, f, { holdAt: 'prepare' }), settings = updateSettings(f.durable);
  await a.initialize(); await b.initialize();
  const first = assert.rejects(a.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  await entered;
  await assert.rejects(async () => b.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  release(); await first;
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null); assert.equal(settings.readAdmissionOwner(), null);
  await assert.rejects(b.apply('unavailable-release-plan-1234', () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  assert.equal(settings.readMaintenance(), false); assert.equal(settings.readPendingPlanId(), null); assert.equal(settings.readAdmissionOwner(), null);
  assert.equal((await f.rootUpdater.call('status')).job, null);
});

for (const phase of ['preparing', 'sending']) test(`close retires this process's ${phase} owner before a same-process replacement starts`, { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { a, make, entered, release } = coordinators(t, f, { holdAt: phase === 'preparing' ? 'prepare' : 'apply' }), settings = updateSettings(f.durable);
  await a.initialize();
  const original = a.apply(f.planId, () => {}, 'source'); void original.catch(() => {});
  await entered; assert.equal(settings.readAdmissionOwner()?.phase, phase);
  await a.close();
  assert.equal(settings.readAdmissionOwner(), null);
  assert.equal(settings.readMaintenance(), phase === 'sending');
  assert.equal(settings.readPendingPlanId(), phase === 'sending' ? f.planId : null);
  const replacement = make(); await replacement.initialize();
  assert.equal((await replacement.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  const replacementToken = settings.readAdmissionToken();
  release(); await original.catch(() => {});
  assert.equal(settings.readMaintenance(), true); assert.equal(settings.readAdmissionOwner(), null);
  assert.equal(settings.readAdmissionToken(), replacementToken, 'a late callback from the closed coordinator cannot write the replacement generation');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1); assert.equal(result.beforeInstaller[0].maintenance, true);
});

for (const phase of ['preparing', 'sending']) test(`a killed owner process recovers its ${phase} boundary from the durable record`, { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  const owner = runtimeChild(f, { ...process.env, DATA_DIR: f.root, SHARING_OWNER_PHASE: phase, SHARING_PLAN_ID: f.planId }, 'update-sharing-owner.mjs');
  assert.equal((await owner.next('owner-held')).phase, phase);
  const liveOwner = settings.readAdmissionOwner();
  assert.equal(liveOwner.pid, owner.child.pid); assert.equal(liveOwner.phase, phase);
  const { b } = coordinators(t, f); await b.initialize();
  await assert.rejects(async () => b.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  assert.equal(settings.readMaintenance(), true);
  owner.child.kill('SIGKILL'); await owner.exited;
  await b.status();
  assert.equal(settings.readAdmissionOwner(), null);
  assert.equal(settings.readMaintenance(), phase === 'sending');
  assert.equal(settings.readPendingPlanId(), phase === 'sending' ? f.planId : null);
  assert.equal((await b.apply(f.planId, () => {}, 'source')).job.status, 'queued');
  const result = await f.rootUpdater.call('run');
  assert.equal(result.beforeInstaller.length, 1); assert.equal(result.beforeInstaller[0].maintenance, true);
});

test('the first API constructed after a preparing owner dies restores baseline before initialize without a status read', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  const owner = runtimeChild(f, { ...process.env, DATA_DIR: f.root, SHARING_OWNER_PHASE: 'preparing', SHARING_PLAN_ID: f.planId }, 'update-sharing-owner.mjs');
  await owner.next('owner-held');
  assert.equal(settings.readMaintenance(), true); assert.equal(settings.readPendingPlanId(), f.planId);
  owner.child.kill('SIGKILL'); await owner.exited;
  const { make, active } = coordinators(t, f, { createPair: false });
  const restarted = make();
  assert.equal(settings.readMaintenance(), false, 'constructor recovery must not re-latch maintenance from its stale initial pending value');
  assert.equal(settings.readPendingPlanId(), null); assert.equal(settings.readAdmissionOwner(), null);
  await restarted.initialize();
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, false])));
  assert.equal((await f.rootUpdater.call('status')).job, null, 'startup recovery did not submit an update');
});

test('invalid persisted owner syntax or shape refuses reads and admission while preserving maintenance', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  settings.writeMaintenance(true);
  const { b, active } = coordinators(t, f); await b.initialize();
  let operations = 0;
  for (const invalid of ['{', JSON.stringify({ version: 1 })]) {
    f.durable.setSetting('updates-admission-owner', invalid);
    assert.throws(() => settings.readAdmissionOwner());
    await assert.rejects(b.status()); await assert.rejects(b.check());
    await assert.rejects(async () => b.apply(f.planId, () => {}, 'source'));
    await assert.rejects(b.withExecutionEntry(() => { operations += 1; }));
    assert.equal(settings.readMaintenance(), true); assert.equal(f.durable.getSetting('updates-admission-owner'), invalid);
    assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
  }
  assert.equal(operations, 0); assert.equal((await f.rootUpdater.call('status')).job, null);
});

test('status and check cannot retire a same-process active preflight owner when the real root plan expires', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), { a, b, entered, release, active } = coordinators(t, f, { holdAt: 'prepare' }), settings = updateSettings(f.durable);
  await a.initialize(); await b.initialize();
  const original = assert.rejects(a.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  await entered;
  const owner = settings.readAdmissionOwner(), token = settings.readAdmissionToken();
  assert.equal(owner.pid, process.pid); assert.equal(owner.phase, 'preparing');
  const idle = await f.rootUpdater.call('expire-plan'); assert.equal(idle.planId, null); assert.equal(idle.job, null);
  await b.status(); await b.check();
  assert.equal(settings.readAdmissionOwner().requestId, owner.requestId);
  assert.equal(settings.readAdmissionToken(), token); assert.equal(settings.readMaintenance(), true); assert.equal(settings.readPendingPlanId(), f.planId);
  assert.deepEqual(active, Object.fromEntries(tradingModules.map(id => [id, true])));
  release(); await original;
  assert.equal(settings.readAdmissionOwner(), null); assert.equal(settings.readMaintenance(), false);
});

test('a still-running external owner with an unknown birth identity is retained conservatively', { skip: protectedSkip, timeout: 30_000 }, async t => {
  const f = await fixture(t), settings = updateSettings(f.durable);
  const owner = runtimeChild(f, { ...process.env, DATA_DIR: f.root, SHARING_OWNER_PHASE: 'preparing', SHARING_PLAN_ID: f.planId }, 'update-sharing-owner.mjs');
  await owner.next('owner-held');
  const live = settings.readAdmissionOwner(); assert.equal(live.pid, owner.child.pid);
  settings.writeAdmissionOwner({ ...live, processStart: null });
  const { b } = coordinators(t, f); await b.initialize();
  const idle = await f.rootUpdater.call('expire-plan'); assert.equal(idle.planId, null); assert.equal(idle.job, null);
  await b.status(); await b.check();
  await assert.rejects(async () => b.apply(f.planId, () => {}, 'source'), error => error instanceof UpdateError && error.status === 409);
  assert.equal(settings.readAdmissionOwner().requestId, live.requestId); assert.equal(settings.readMaintenance(), true);
  owner.child.kill('SIGKILL'); await owner.exited;
  await b.status();
  assert.equal(settings.readAdmissionOwner(), null); assert.equal(settings.readMaintenance(), false);
});

function runtimeChild(f, env, filename = 'update-sharing-runtime.mjs') {
  const child = fork(fileURLToPath(new URL(`./fixtures/${filename}`, import.meta.url)), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const messages = [], waiting = [];
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('message', message => {
    const index = waiting.findIndex(value => value.type === message.type);
    if (index < 0) messages.push(message); else waiting.splice(index, 1)[0].resolve(message);
  });
  f.cleanup.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { child, exited,
    next(type) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ${type} from runtime: ${stderr}`)), 15_000);
        waiting.push({ type, resolve: value => { clearTimeout(timer); resolve(value); } });
        exited.then(value => { clearTimeout(timer); reject(new Error(`Runtime exited ${JSON.stringify(value)}: ${stderr}`)); });
      });
    } };
}

function publicClient(port, session = {}, agent = false) {
  const request = (route, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body), host = `hub.localhost:${port}`;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent, timeout: 15_000,
      headers: { Host: host, Origin: `http://${host}`, ...(session.cookie ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text), headers: res.headers }); } catch { reject(new Error(`Invalid JSON response: ${text}`)); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Public API request timed out'))); req.end(encoded);
  });
  return { request, session };
}

test('SIGKILL between CLI switch and old-slot stop leaves an old keepalive and a new connection able to request the same full update',
  { skip: process.platform === 'win32' ? 'Linux slot/entry lifecycle; executed by the existing privileged CI job' : protectedSkip, timeout: 60_000 }, async t => {
    const f = await fixture(t, { runtimeBootstrap: true }), quiet = { info() {}, debug() {}, warn() {}, error() {} };
    const moduleDir = path.join(f.root, 'modules'), slotRoot = path.join(f.root, 'slots'), entryDir = path.join(f.root, 'entry');
    for (const dir of [moduleDir, slotRoot, entryDir]) mkdirSync(dir, { mode: 0o700 });
    const { WORKBENCH_RUNTIME_DIR: _runtime, WORKBENCH_API_SLOT: _slot, ...inherited } = process.env;
    const env = { ...inherited, DATA_DIR: f.root, INITIAL_PASSWORD: 'sharing-api-password', MODULE_SOCKET_DIR: moduleDir, NODE_ENV: 'test' };
    const runtime = runtimeChild(f, env); await runtime.next('ready');
    const record = path.join(f.root, '.api-slot'), cutover = path.join(f.root, '.api-cutover'), slots = {};
    for (const name of ['a', 'b']) {
      const release = path.join(f.root, `release-${name}`), dir = slotDirectory(slotRoot, name);
      mkdirSync(release); mkdirSync(dir, { mode: 0o700 }); slots[name] = { slot: name, dir, record, release: realpathSync(release) };
    }
    const writeRecord = name => writeFileSync(record, JSON.stringify({ slot: name, release: slots[name].release }));
    writeRecord('a');
    const a = await startApi({ dataDir: f.root, logger: quiet, env, slot: slots.a, updatesClient: f.client }); f.cleanup.after(() => a.close());
    const b = await startApi({ dataDir: f.root, logger: quiet, env, slot: slots.b, updatesClient: f.client }); f.cleanup.after(() => b.close());
    assert.equal(b.ready.mode, 'candidate');
    const entry = await startEntry({ host: '127.0.0.1', port: 0, dir: entryDir, record, slotRoot, logger: quiet }); f.cleanup.after(() => entry.close());
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); f.cleanup.after(() => agent.destroy());
    const old = publicClient(entry.ready.port, {}, agent);
    const login = await old.request('/api/login', { method: 'POST', body: { password: env.INITIAL_PASSWORD } });
    assert.equal(login.status, 200); old.session.cookie = login.headers['set-cookie'][0].split(';')[0]; old.session.csrf = login.data.csrfToken;
    assert.equal(entry.status().connections.a, 1);

    // Reproduce install.sh:2712–2722 up to switch, with its actual shared lock.
    // Killing this CLI lock holder before stop models the supported interrupted
    // .api-cutover state, without invoking an installer or touching systemd.
    const cli = f.holdCli(); await cli.ready;
    writeFileSync(cutover, JSON.stringify({ from: 'a', to: 'b', release: slots.b.release, phase: 'switching' }));
    writeRecord('b');
    assert.equal((await controlRequest(slotSockets(slots.b.dir).ctl, 'POST', '/promote', { timeoutMs: 15_000 })).status, 200);
    const identity = (await controlRequest(slotSockets(slots.b.dir).ctl, 'GET', '/identity')).data;
    assert.equal((await controlRequest(entrySockets(entryDir).ctl, 'POST', '/switch', { body: { slot: 'b', instanceId: identity.instanceId } })).status, 200);
    cli.child.kill('SIGKILL'); await cli.exited;
    assert.equal(entry.status().target, 'b');
    assert.equal((await controlRequest(slotSockets(slots.a.dir).ctl, 'GET', '/identity')).data.mode, 'serving');
    assert.equal((await old.request('/api/session')).data.authenticated, true, 'the old public keepalive still reaches serving slot a');
    assert.equal(entry.status().connections.a, 1);
    const next = publicClient(entry.ready.port, old.session);
    assert.equal((await next.request('/api/session')).data.authenticated, true, 'a new public connection reaches serving slot b');

    const olderRequest = old.request('/api/system/updates/apply', { method: 'POST', body: { planId: f.planId, deployMode: 'source' } });
    void olderRequest.catch(() => {});
    f.cleanup.after(async () => { runtime.child.send({ type: 'release-evidence' }); await olderRequest.catch(() => {}); });
    await runtime.next('evidence-held');
    const refused = await next.request('/api/system/updates/apply', { method: 'POST', body: { planId: f.planId, deployMode: 'source' } });
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.equal((await f.rootUpdater.call('status')).job, null);
    runtime.child.send({ type: 'release-evidence' });
    assert.equal((await olderRequest).status, 409, 'the older real module stop evidence failed without allowing a competing owner');
    assert.equal(updateSettings(f.durable).readMaintenance(), false);
    assert.equal(updateSettings(f.durable).readAdmissionOwner(), null);
    const accepted = await next.request('/api/system/updates/apply', { method: 'POST', body: { planId: f.planId, deployMode: 'source' } });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.data)); assert.equal(accepted.data.job.status, 'queued');
    for (const id of tradingModules) {
      const response = await controlRequest(path.join(moduleDir, `${id}.sock`), 'GET', '/maintenance-state');
      assert.equal(response.data.active, true, `${id} must remain in maintenance until the accepted full update completes`);
    }
    const result = await f.rootUpdater.call('run');
    assert.equal(result.beforeInstaller.length, 1, 'after CLI SIGKILL the real root worker passed the shared lock and identity checks');
    assert.equal(result.beforeInstaller[0].maintenance, true, JSON.stringify(result.beforeInstaller));
  });
