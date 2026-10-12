import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleUpdateGuard } from '../server/modules/updates.mjs';
import { createUpdateCoordinator, UpdateError, unavailableUpdateState } from '../server/updates.mjs';

const planId = 'embedded-update-plan-1234';
const stamp = '2026-10-13T01:00:00.000Z';
const modules = ['crossex', 'greeks'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = (status = null) => ({ enabled: true, checking: false, checkedAt: stamp, checkError: null,
  planId, expiresAt: stamp, modules: [], job: status ? { id: 'managed-update', status, startedAt: stamp,
    finishedAt: ['queued', 'running'].includes(status) ? null : stamp, activeModule: null, steps: [], message: '更新状态' } : null });

function fixture({ maintenance = false, pendingPlanId = null } = {}) {
  const persisted = { maintenance, pendingPlanId };
  const active = { crossex: null, greeks: null }, events = [], handlers = {}, calls = [];
  let updaterState = state('running');
  const request = async (origin, route, options) => {
    const id = modules.find(id => origin === `http://${id}.workspace.internal`);
    assert.ok(id, 'guard must use one of the fixed private module origins');
    assert.ok(options.deadline >= Date.now() && options.deadline <= Date.now() + 10_000, 'module requests have a bounded deadline');
    if (route === '/__workspace/maintenance') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(Object.keys(options.body), ['active']);
      assert.equal(typeof options.body.active, 'boolean');
      const desired = options.body.active;
      events.push(`gate:${id}:${desired}:start`);
      const result = handlers[`gate:${id}`] ? await handlers[`gate:${id}`](desired) : { data: { active: desired } };
      if (result.data?.active === desired) active[id] = desired;
      events.push(`gate:${id}:${desired}:done`);
      return result;
    }
    assert.equal(route, '/__workspace/update-status');
    assert.equal(options.body, undefined);
    events.push(`status:${id}:start`);
    const result = handlers[`status:${id}`] ? await handlers[`status:${id}`]() : { data: { busy: false } };
    events.push(`status:${id}:done`);
    return result;
  };
  const guard = createModuleUpdateGuard({ request });
  const client = {
    async status() { calls.push('status'); return structuredClone(updaterState); },
    async check() { calls.push('check'); return structuredClone(updaterState); },
    async apply(id) {
      calls.push('apply'); events.push('updater:apply'); assert.equal(id, planId);
      assert.equal(persisted.maintenance, true, 'hub durable latch must precede updater submission');
      assert.equal(persisted.pendingPlanId, planId);
      if (handlers.apply) return handlers.apply();
      return state('running');
    },
  };
  const coordinator = createUpdateCoordinator({ client, execution: { state: () => ({ jobs: [] }) },
    readMaintenance: () => persisted.maintenance,
    writeMaintenance: value => { persisted.maintenance = value; events.push(`persist:maintenance:${value}`); },
    readPendingPlanId: () => persisted.pendingPlanId,
    writePendingPlanId: value => { persisted.pendingPlanId = value; events.push(`persist:plan:${value}`); },
    setModuleMaintenance: guard.setMaintenance,
    prepareApply: async () => { events.push('prepare'); await guard.prepareApply(); },
  });
  return { coordinator, guard, persisted, active, events, handlers, calls,
    apply: () => coordinator.apply(planId, () => events.push('authorize')),
    set updaterState(value) { updaterState = value; } };
}

test('coordinator initialization synchronizes each module with durable maintenance and pending-plan recovery', async t => {
  for (const initial of [{ maintenance: false, pendingPlanId: null }, { maintenance: true, pendingPlanId: null },
    { maintenance: false, pendingPlanId: planId }, { maintenance: true, pendingPlanId: planId }]) {
    await t.test(JSON.stringify(initial), async () => {
      const f = fixture(initial);
      await f.coordinator.initialize();
      const expected = initial.maintenance || Boolean(initial.pendingPlanId);
      assert.deepEqual(f.active, { crossex: expected, greeks: expected });
      assert.equal(f.persisted.maintenance, expected);
      assert.equal(f.persisted.pendingPlanId, initial.pendingPlanId);
      assert.deepEqual(f.calls, [], 'initialization must not clear a durable latch by consulting a stale updater status');
      assert.equal(f.events.filter(value => value.startsWith('gate:') && value.endsWith(':done')).length, 2);
    });
  }
});

test('apply waits for both module gates, then both busy checks, before privileged updater submission', async () => {
  const f = fixture(), gateEntered = deferred(), gateRelease = deferred(), statusEntered = deferred(), statusRelease = deferred();
  f.handlers['gate:greeks'] = async active => {
    if (active) { gateEntered.resolve(); await gateRelease.promise; }
    return { data: { active } };
  };
  f.handlers['status:greeks'] = async () => { statusEntered.resolve(); await statusRelease.promise; return { data: { busy: false } }; };
  const result = f.apply();
  await gateEntered.promise;
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.equal(f.events.includes('prepare'), false); assert.deepEqual(f.calls, []);
  gateRelease.resolve(); await statusEntered.promise;
  assert.deepEqual(f.active, { crossex: true, greeks: true });
  assert.deepEqual(f.calls, []);
  statusRelease.resolve(); assert.equal((await result).job.status, 'running');
  const prepare = f.events.indexOf('prepare'), apply = f.events.indexOf('updater:apply');
  for (const id of modules) {
    assert.ok(f.events.indexOf(`gate:${id}:true:done`) < prepare);
    assert.ok(f.events.indexOf(`status:${id}:start`) > prepare);
    assert.ok(f.events.indexOf(`status:${id}:done`) < apply);
  }
  assert.equal(f.events[apply - 1], 'authorize', 'authorization is rechecked after module readiness, immediately before apply');
  assert.deepEqual(f.calls, ['apply']);
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: null });
  assert.deepEqual(f.active, { crossex: true, greeks: true });
});

test('busy, unknown and failed module checks never submit updates and restore the prior maintenance state', async t => {
  const responses = [
    ['busy', () => ({ data: { busy: true } }), 409],
    ['missing', () => ({ data: {} }), 409],
    ['wrong type', () => ({ data: { busy: 'false' } }), 409],
    ['null', () => ({ data: null }), 409],
    ['request failed', () => { throw new Error('private transport failure'); }, 503],
  ];
  for (const id of modules) for (const [name, reply, status] of responses) for (const previous of [false, true]) {
    await t.test(`${id}: ${name}, previous=${previous}`, async () => {
      const initial = { maintenance: previous, pendingPlanId: previous ? planId : null };
      const f = fixture(initial);
      f.handlers[`status:${id}`] = reply;
      await assert.rejects(f.apply(), error => error instanceof UpdateError && error.status === status && !error.uncertain);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.persisted, initial);
      assert.deepEqual(f.active, { crossex: previous, greeks: previous });
      assert.equal(f.events.some(value => value.includes('private transport failure')), false);
    });
  }
});

test('definitive updater rejection restores module gates and the exact previous durable state', async t => {
  for (const initial of [{ maintenance: false, pendingPlanId: null }, { maintenance: true, pendingPlanId: null },
    { maintenance: true, pendingPlanId: planId }]) {
    await t.test(JSON.stringify(initial), async () => {
      const f = fixture(initial);
      f.handlers.apply = () => { throw new UpdateError(409, '计划已过期'); };
      await assert.rejects(f.apply(), error => error.status === 409);
      assert.deepEqual(f.calls, ['apply']);
      assert.deepEqual(f.persisted, initial);
      assert.deepEqual(f.active, { crossex: initial.maintenance, greeks: initial.maintenance });
    });
  }
});

test('uncertain updater acceptance keeps both module gates across unavailable status and restart initialization', async () => {
  const f = fixture();
  f.handlers.apply = () => { throw new UpdateError(503, '等待更新结果超时', { uncertain: true }); };
  await assert.rejects(f.apply(), error => error.uncertain === true);
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.deepEqual(f.active, { crossex: true, greeks: true });
  f.updaterState = unavailableUpdateState();
  await f.coordinator.status();
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.deepEqual(f.active, { crossex: true, greeks: true });
  const restarted = fixture(f.persisted);
  await restarted.coordinator.initialize();
  assert.deepEqual(restarted.active, { crossex: true, greeks: true });
  assert.equal(f.events.some(value => value.startsWith('gate:') && value.includes(':false:')), false);
});

test('one failed module maintenance call waits for the other result and prevents updater submission', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.handlers['gate:crossex'] = active => {
    if (active) throw new Error('module unavailable');
    return { data: { active } };
  };
  f.handlers['gate:greeks'] = async active => {
    if (active) { entered.resolve(); await release.promise; }
    return { data: { active } };
  };
  const result = f.apply();
  const rejected = assert.rejects(result, error => error instanceof UpdateError && error.status === 503);
  await entered.promise;
  assert.equal(f.persisted.maintenance, true);
  assert.equal(f.events.includes('prepare'), false);
  assert.equal(f.events.some(value => value.includes(':false:')), false, 'rollback must wait for every in-flight enable call');
  release.resolve(); await rejected;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.persisted, { maintenance: false, pendingPlanId: null });
  assert.deepEqual(f.active, { crossex: false, greeks: false });
});

test('failed module synchronization rejects initialization and live-entry operations closed', async () => {
  const f = fixture(); let entries = 0;
  f.handlers['gate:greeks'] = () => { throw new Error('private failure'); };
  await assert.rejects(f.coordinator.initialize(), error => error instanceof UpdateError && error.status === 503);
  f.updaterState = state();
  await assert.rejects(f.coordinator.withExecutionEntry(() => { entries += 1; }), error => error instanceof UpdateError && error.status === 503);
  assert.equal(entries, 0);
  assert.equal(f.calls.includes('apply'), false);
});

test('a module that does not acknowledge the requested maintenance value fails closed before update submission', async t => {
  for (const data of [{ active: false }, {}, null, { active: 'true' }]) {
    await t.test(JSON.stringify(data), async () => {
      const f = fixture();
      f.handlers['gate:greeks'] = active => ({ data: active ? data : { active: false } });
      await assert.rejects(f.apply(), error => error instanceof UpdateError && error.status === 503);
      assert.deepEqual(f.calls, []);
      assert.equal(f.events.includes('prepare'), false);
    });
  }
});
