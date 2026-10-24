import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createExecutionEntries, createExecutionJobsReader, EXECUTION_CALL_TIMEOUT_MS, EXECUTION_ENTRY_TTL_MS } from '../server/control/execution-jobs.mjs';
import { createUpdateCoordinator, unavailableUpdateState } from '../server/updates.mjs';

// Native execution entries and the update coordinator's idle check over a
// real hub.sqlite (design doc 5.5).
const refuse = () => { throw Object.assign(new Error('maintenance'), { status: 409 }); };
async function hub(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'execution-entries-'));
  const file = path.join(dir, 'hub.sqlite');
  const db = openHubDatabase(file);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const control = createControlStore(db);
  return { db, file, control, maintenance: () => control.getSetting('updates-maintenance') === '1', count: () => db.prepare('SELECT COUNT(*) AS count FROM execution_entries').get().count };
}

test('an execution entry lasts as long as its operation, also when it fails, and is refused under maintenance', async t => {
  const h = await hub(t);
  let clock = 1000;
  const entries = createExecutionEntries({ db: h.db, readMaintenance: h.maintenance, refuse, now: () => clock });
  const reader = createExecutionJobsReader(h.db, { now: () => clock });
  assert.equal(await entries.run(async () => { assert.equal(h.count(), 1); assert.equal(reader.openEntries(), 1); return 'done'; }), 'done');
  assert.equal(h.count(), 0);
  await assert.rejects(entries.run(async () => { throw new Error('exchange'); }), /exchange/);
  assert.equal(h.count(), 0);
  h.control.setSetting('updates-maintenance', '1');
  let ran = false;
  await assert.rejects(entries.run(async () => { ran = true; }), error => error.status === 409);
  assert.equal(ran, false); assert.equal(h.count(), 0);
  // An entry a crashed runtime left behind stops counting after its expiry, and a new runtime clears it.
  h.db.prepare('INSERT INTO execution_entries(id,created_at,expires_at) VALUES (?,?,?)').run('left', clock, clock + EXECUTION_ENTRY_TTL_MS);
  assert.equal(reader.openEntries(), 1);
  clock += EXECUTION_ENTRY_TTL_MS;
  assert.equal(reader.openEntries(), 0);
  entries.clear(); assert.equal(h.count(), 0);
});

test('an entry outlives the longest native write, a preview of two exchange calls', () => {
  assert.ok(EXECUTION_ENTRY_TTL_MS >= 2 * EXECUTION_CALL_TIMEOUT_MS + 15_000);
});

const stamp = new Date(0).toISOString();
const running = { enabled: true, checking: false, checkedAt: stamp, checkError: null, planId: null, expiresAt: null, modules: [],
  job: { id: 'managed-update', status: 'running', startedAt: stamp, finishedAt: null, activeModule: null, steps: [], message: '更新状态' } };
function coordinator(h, reader, { writeMaintenance = value => h.control.setSetting('updates-maintenance', value ? '1' : '0') } = {}) {
  return createUpdateCoordinator({ client: { status: async () => unavailableUpdateState(), apply: async () => structuredClone(running) }, execution: reader,
    readMaintenance: h.maintenance, writeMaintenance,
    readPendingPlanId: () => h.control.getSetting('updates-pending-plan') || null, writePendingPlanId: value => h.control.setSetting('updates-pending-plan', value || ''),
    releasePollMs: 0 });
}
const planId = 'plan-0123456789abcdef';

test('an update is refused while an execution entry is open and writes no maintenance', async t => {
  const h = await hub(t);
  const reader = createExecutionJobsReader(h.db);
  const entries = createExecutionEntries({ db: h.db, readMaintenance: h.maintenance, refuse });
  const updates = coordinator(h, reader);
  t.after(() => updates.close());
  let release; const held = new Promise(resolve => { release = resolve; });
  const open = entries.run(() => held);
  await assert.rejects(async () => updates.apply(planId, () => {}), error => error.status === 409 && /停止所有实盘任务/.test(error.message));
  assert.equal(h.maintenance(), false); assert.equal(h.control.getSetting('updates-pending-plan') || null, null);
  release(); await open;
  await updates.apply(planId, () => {});
  assert.equal(h.maintenance(), true);
  await assert.rejects(entries.run(async () => {}), error => error.status === 409);
});

test('the idle check runs again inside the admission transaction', async t => {
  const h = await hub(t);
  const reader = createExecutionJobsReader(h.db);
  // The open entry appears between the first check and the transaction, as when another process records it.
  let checks = 0;
  const racing = { ...reader, openEntries: () => (checks += 1) > 1 ? 1 : 0 };
  const updates = coordinator(h, racing);
  t.after(() => updates.close());
  await assert.rejects(async () => updates.apply(planId, () => {}), error => error.status === 409);
  assert.equal(h.maintenance(), false);
  // The coordinator still accepts the plan once the entry is gone, so its cache did not keep a pending plan.
  racing.openEntries = () => 0;
  await updates.apply('plan-fedcba9876543210', () => {});
  assert.equal(h.maintenance(), true);
});

test('a rolled-back admission leaves the cached plan and maintenance as the database has them', async t => {
  const h = await hub(t);
  let fail = true;
  const updates = coordinator(h, createExecutionJobsReader(h.db), { writeMaintenance: value => { if (fail) { fail = false; throw new Error('disk full'); } h.control.setSetting('updates-maintenance', value ? '1' : '0'); } });
  t.after(() => updates.close());
  await assert.rejects(async () => updates.apply(planId, () => {}), /disk full/);
  assert.equal(h.control.getSetting('updates-pending-plan') || null, null, 'the plan written before the failure was rolled back');
  // A different plan is accepted: the coordinator does not still hold the rolled-back one.
  await updates.apply('plan-fedcba9876543210', () => {});
  assert.equal(h.maintenance(), true);
});

// Two writers on their own connections, as the runtime and the API are: one
// keeps opening entries, the other keeps admitting updates through the
// coordinator and clearing them. A
// third connection never sees maintenance on together with an open entry.
test('concurrent execution entries and update admissions never leave maintenance on with an open entry', { timeout: 90_000 }, async t => {
  const h = await hub(t);
  const modules = { ...Object.fromEntries(['schema', 'store', 'execution-jobs'].map(name => [name, new URL(`../server/control/${name}.mjs`, import.meta.url).href])), updates: new URL('../server/updates.mjs', import.meta.url).href };
  const worker = role => new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { openHubDatabase } = await import(workerData.modules.schema);
      const { createControlStore } = await import(workerData.modules.store);
      const { createExecutionEntries, createExecutionJobsReader } = await import(workerData.modules['execution-jobs']);
      const db = openHubDatabase(workerData.file), control = createControlStore(db);
      const maintenance = () => control.getSetting('updates-maintenance') === '1';
      // Shared counts: entries done, entries refused, admissions done, admissions refused.
      // Both sides run for at least 1.5 s and until every count is non-zero (at most
      // 10 s), so each refusal direction happens while the other side still runs.
      const progress = new Int32Array(workerData.progress), base = workerData.role === 'entries' ? 0 : 2;
      const started = Date.now(), elapsed = () => Date.now() - started;
      const more = () => elapsed() < 1500 || progress.some((_, index) => Atomics.load(progress, index) === 0) && elapsed() < 10_000;
      const count = slot => Atomics.add(progress, base + slot, 1);
      if (workerData.role === 'entries') {
        const entries = createExecutionEntries({ db, readMaintenance: maintenance, refuse: () => { throw Object.assign(new Error('maintenance'), { status: 409 }); } });
        while (more()) {
          try { await entries.run(() => new Promise(resolve => setTimeout(resolve, 1))); count(0); } catch (error) { if (error.status !== 409) throw error; count(1); await new Promise(resolve => setImmediate(resolve)); }
        }
      } else {
        // The real coordinator, new for each attempt so a finished update can be cleared.
        const { createUpdateCoordinator } = await import(workerData.modules.updates);
        const reader = createExecutionJobsReader(db);
        const client = { status: async () => { throw new Error('unused'); }, apply: async () => workerData.running };
        while (more()) {
          const updates = createUpdateCoordinator({ client, execution: reader, readMaintenance: maintenance, releasePollMs: 0,
            writeMaintenance: value => control.setSetting('updates-maintenance', value ? '1' : '0'), writePendingPlanId: value => control.setSetting('updates-pending-plan', value || '') });
          let admitted = true;
          try { await updates.apply('plan-0123456789abcdef', () => {}); } catch (error) { if (error.status !== 409) throw error; admitted = false; }
          if (admitted) { count(0); await new Promise(resolve => setTimeout(resolve, 1)); control.setSetting('updates-maintenance', '0'); } else count(1);
          await updates.close();
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      db.close(); parentPort.postMessage('done');
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { role, file: h.file, modules, running, progress: progress.buffer } });
  const progress = new Int32Array(new SharedArrayBuffer(16)), workers = [];
  // A failing side ends the other before the database is closed and removed.
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  const run = role => new Promise((resolve, reject) => {
    const w = worker(role); workers.push(w);
    w.once('message', resolve); w.once('error', reject); w.once('exit', code => reject(new Error(`${role} worker exited with ${code}`)));
  });
  const results = Promise.all([run('entries'), run('admissions')]);
  let finished = false, checks = 0, violations = 0;
  results.then(() => { finished = true; }, () => { finished = true; });
  while (!finished) {
    h.db.exec('BEGIN');
    try { if (h.maintenance() && h.count() > 0) violations += 1; checks += 1; } finally { h.db.exec('COMMIT'); }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await results;
  assert.equal(violations, 0);
  const [entriesDone, entriesRefused, admissionsDone, admissionsRefused] = progress;
  assert.ok(checks > 10 && entriesDone > 0 && entriesRefused > 0 && admissionsDone > 0 && admissionsRefused > 0, JSON.stringify({ checks, entriesDone, entriesRefused, admissionsDone, admissionsRefused }));
});
