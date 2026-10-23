import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleUpdateGuard } from '../server/modules/updates.mjs';
import { moduleCapabilities } from '../server/modules/capabilities.mjs';
import { createUpdateCoordinator, UpdateError, unavailableUpdateState } from '../server/updates.mjs';

const planId = 'embedded-update-plan-1234';
const stamp = '2026-10-13T01:00:00.000Z';
const modules = ['crossex', 'greeks', 'aster'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = (status = null) => ({ enabled: true, checking: false, checkedAt: stamp, checkError: null,
  planId, expiresAt: stamp, modules: [], job: status ? { id: 'managed-update', status, startedAt: stamp,
    finishedAt: ['queued', 'running'].includes(status) ? null : stamp, activeModule: null, steps: [], message: '更新状态' } : null });

function fixture({ maintenance = false, pendingPlanId = null, releasePollMs = 0 } = {}) {
  const persisted = { maintenance, pendingPlanId };
  const active = { crossex: null, greeks: null, aster: null }, events = [], handlers = {}, calls = [];
  let updaterState = state('running');
  const gates = { status: null };
  const request = async (origin, route, options) => {
    const id = modules.find(id => origin === `http://${id}.workspace.internal`);
    assert.ok(id, 'guard must use one of the fixed private module origins');
    assert.ok(options.deadline >= Date.now() && options.deadline <= Date.now() + (id === 'aster' && route.endsWith('update-status') ? 60_000 : 10_000), 'module requests have a bounded deadline');
    if (route === '/__workspace/capabilities') {
      events.push(`capabilities:${id}`);
      return handlers[`capabilities:${id}`] ? handlers[`capabilities:${id}`]() : { data: moduleCapabilities(id) };
    }
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
    async status() {
      calls.push('status');
      const snapshot = structuredClone(updaterState);
      if (gates.status) { const gate = gates.status; gates.status = null; gate.entered.resolve(); await gate.release.promise; }
      return snapshot;
    },
    async check() { calls.push('check'); return structuredClone(updaterState); },
    async apply(id, deployMode) {
      calls.push('apply'); events.push('updater:apply'); assert.equal(id, planId);
      assert.equal(persisted.maintenance, true, 'hub durable latch must precede updater submission');
      assert.equal(persisted.pendingPlanId, planId);
      if (handlers.apply) return handlers.apply(deployMode);
      return state('running');
    },
  };
  const coordinator = createUpdateCoordinator({ client, execution: { state: () => ({ jobs: [] }) },
    readMaintenance: () => persisted.maintenance,
    writeMaintenance: value => { persisted.maintenance = value; events.push(`persist:maintenance:${value}`); },
    readPendingPlanId: () => persisted.pendingPlanId,
    writePendingPlanId: value => { persisted.pendingPlanId = value; events.push(`persist:plan:${value}`); },
    setModuleMaintenance: guard.setMaintenance, tradingModules: modules,
    prepareApply: async () => { events.push('prepare'); await guard.prepareApply(); },
    releasePollMs,
  });
  return { coordinator, guard, persisted, active, events, handlers, calls,
    apply: deployMode => coordinator.apply(planId, () => events.push('authorize'), deployMode),
    set updaterState(value) { updaterState = value; },
    holdNextStatus() { const gate = { entered: deferred(), release: deferred() }; gates.status = gate; return gate; } };
}

test('coordinator initialization synchronizes each module with durable maintenance and pending-plan recovery', async t => {
  for (const initial of [{ maintenance: false, pendingPlanId: null }, { maintenance: true, pendingPlanId: null },
    { maintenance: false, pendingPlanId: planId }, { maintenance: true, pendingPlanId: planId }]) {
    await t.test(JSON.stringify(initial), async () => {
      const f = fixture(initial);
      await f.coordinator.initialize();
      const expected = initial.maintenance || Boolean(initial.pendingPlanId);
      assert.deepEqual(f.active, { crossex: expected, greeks: expected, aster: expected });
      assert.equal(f.persisted.maintenance, expected);
      assert.equal(f.persisted.pendingPlanId, initial.pendingPlanId);
      assert.deepEqual(f.calls, [], 'initialization must not clear a durable latch by consulting a stale updater status');
      assert.equal(f.events.filter(value => value.startsWith('gate:') && value.endsWith(':done')).length, 3);
    });
  }
});

test('ci apply waits for all module gates, then all busy checks, before privileged updater submission', async () => {
  const f = fixture(), gateEntered = deferred(), gateRelease = deferred(), statusEntered = deferred(), statusRelease = deferred();
  f.handlers['gate:greeks'] = async active => {
    if (active) { gateEntered.resolve(); await gateRelease.promise; }
    return { data: { active } };
  };
  f.handlers['status:greeks'] = async () => { statusEntered.resolve(); await statusRelease.promise; return { data: { busy: false } }; };
  f.handlers.apply = mode => { assert.equal(mode, 'ci'); return state('running'); };
  const result = f.apply('ci');
  await gateEntered.promise;
  assert.throws(() => f.apply('source'), error => error.status === 409);
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.equal(f.events.includes('prepare'), false); assert.deepEqual(f.calls, []);
  gateRelease.resolve(); await statusEntered.promise;
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
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
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
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
      assert.deepEqual(f.active, { crossex: previous, greeks: previous, aster: previous });
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
      assert.deepEqual(f.active, { crossex: initial.maintenance, greeks: initial.maintenance, aster: initial.maintenance });
    });
  }
});

test('independent module evidence runs concurrently and rollback waits for every pending read', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.handlers['status:crossex'] = () => ({ data: { busy: true } });
  f.handlers['status:aster'] = async () => { entered.resolve(); await release.promise; return { data: { busy: false } }; };
  const result = f.apply();
  const rejected = assert.rejects(result, error => error.status === 409);
  await entered.promise;
  for (const id of modules) assert.ok(f.events.includes(`status:${id}:start`));
  assert.equal(f.persisted.maintenance, true);
  assert.equal(f.events.some(value => value.includes(':false:')), false);
  release.resolve(); await rejected;
  assert.deepEqual(f.active, { crossex: false, greeks: false, aster: false });
  assert.deepEqual(f.calls, []);
});

test('Aster verification failures explain which account evidence must be restored', async () => {
  const f = fixture();
  f.handlers['status:aster'] = () => ({ data: { busy: true, reason: '实盘账户缺少有效凭据，无法核查完整挂单；请配置凭据后重试' } });
  await assert.rejects(f.apply(), error => error.status === 409 && error.message.includes('请配置凭据后重试'));
  assert.deepEqual(f.calls, []);
});

test('missing, mismatched and unknown capability contracts refuse update before querying account evidence', async t => {
  const cases = [null, {}, { ...moduleCapabilities('aster'), schemaVersion: 2 },
    { ...moduleCapabilities('aster'), moduleId: 'greeks' }, { ...moduleCapabilities('aster'), accountWriterVersion: null },
    { ...moduleCapabilities('aster'), extra: 'not-allowed' }];
  for (const value of cases) await t.test(JSON.stringify(value), async () => {
    const f = fixture(); f.handlers['capabilities:aster'] = () => ({ data: value });
    await assert.rejects(f.apply(), error => error.status === 503 && /维护协议/.test(error.message));
    assert.equal(f.events.includes('status:aster:start'), false);
    assert.deepEqual(f.calls, []); assert.equal(f.persisted.maintenance, false);
  });
  const f = fixture(); f.handlers['capabilities:aster'] = () => { throw new Error('private timeout details'); };
  await assert.rejects(f.apply(), error => error.status === 503 && !error.message.includes('private timeout'));
});

test('uncertain updater acceptance keeps all module gates across unavailable status and restart initialization', async () => {
  const f = fixture();
  f.handlers.apply = () => { throw new UpdateError(503, '等待更新结果超时', { uncertain: true }); };
  await assert.rejects(f.apply(), error => error.uncertain === true);
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
  f.updaterState = unavailableUpdateState();
  await f.coordinator.status();
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId });
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
  const restarted = fixture(f.persisted);
  await restarted.coordinator.initialize();
  assert.deepEqual(restarted.active, { crossex: true, greeks: true, aster: true });
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
  assert.deepEqual(f.active, { crossex: false, greeks: false, aster: false });
});

test('failed module synchronization rejects initialization, and live entry closes only for that module or an unscoped caller', async () => {
  const f = fixture(); const entries = [];
  f.handlers['gate:greeks'] = () => { throw new Error('private failure'); };
  await assert.rejects(f.coordinator.initialize(), error => error instanceof UpdateError && error.status === 503);
  f.updaterState = state();
  for (const scope of [undefined, 'greeks']) {
    await assert.rejects(f.coordinator.withExecutionEntry(() => { entries.push(scope); }, { scope }), error => error instanceof UpdateError && error.status === 503);
  }
  // CrossEx, Monitor, Asset and native execution do not depend on the Greeks gate.
  for (const scope of ['crossex', 'monitor', 'asset', 'native']) assert.equal(await f.coordinator.withExecutionEntry(() => { entries.push(scope); return scope; }, { scope }), scope);
  assert.deepEqual(entries, ['crossex', 'monitor', 'asset', 'native']);
  assert.equal(f.calls.includes('apply'), false);
});

test('status reports each trading module gate instead of failing while one module is unreachable', async () => {
  const f = fixture();
  f.updaterState = state();
  let failing = true;
  f.handlers['gate:aster'] = active => { if (failing) throw new Error('restarting'); return { data: { active } }; };
  const first = await f.coordinator.status();
  assert.equal(first.job, null);
  assert.deepEqual(first.moduleMaintenance, [{ id: 'crossex', confirmed: true }, { id: 'greeks', confirmed: true }, { id: 'aster', confirmed: false }]);
  assert.deepEqual((await f.coordinator.check()).moduleMaintenance.map(row => row.confirmed), [true, true, false]);
  const released = f.coordinator.moduleMaintenance();
  assert.equal(released.aster.confirmed, false); assert.equal(released.aster.releasedAt, null);
  assert.equal(released.crossex.confirmed, true); assert.equal(released.crossex.maintenance, false); assert.match(released.crossex.releasedAt, /^\d{4}-/);
  failing = false;
  assert.deepEqual((await f.coordinator.status()).moduleMaintenance.map(row => row.confirmed), [true, true, true]);
  assert.match(f.coordinator.moduleMaintenance().aster.releasedAt, /^\d{4}-/);
  assert.equal(f.coordinator.moduleMaintenance().crossex.releasedAt, released.crossex.releasedAt, 'a repeated release keeps the first release time');
});

test('a restarted trading module is synchronized alone and other modules stay writable while it is unconfirmed', async t => {
  const f = fixture({ releasePollMs: 0 });
  t.after(() => f.coordinator.close());
  f.updaterState = state();
  await f.coordinator.initialize();
  let attempts = 0;
  // The first acknowledgement fails as if the module were still finishing startup.
  f.handlers['gate:greeks'] = active => { if (attempts++ === 0) throw new Error('starting'); return { data: { active } }; };
  const before = f.events.length;
  await f.coordinator.resynchronize('greeks');
  assert.deepEqual(f.events.slice(before).filter(value => value.startsWith('gate:')), ['gate:greeks:false:start'], 'only Greeks is synchronized for its own restart');
  const gates = f.coordinator.moduleMaintenance();
  assert.equal(gates.greeks.confirmed, false); assert.equal(gates.greeks.releasedAt, null);
  assert.equal(gates.crossex.confirmed, true);
  f.handlers['gate:greeks'] = () => { throw new Error('still starting'); };
  assert.equal(await f.coordinator.withExecutionEntry(() => 'crossex', { scope: 'crossex' }), 'crossex');
  await assert.rejects(f.coordinator.withExecutionEntry(() => 'greeks', { scope: 'greeks' }), error => error instanceof UpdateError && error.status === 503);
  delete f.handlers['gate:greeks'];
  assert.equal(await f.coordinator.withExecutionEntry(() => 'greeks', { scope: 'greeks' }), 'greeks', 'the next status read confirms Greeks');
  const events = f.events.length;
  await f.coordinator.resynchronize('monitor');
  await f.coordinator.resynchronize('constructor');
  assert.equal(f.events.length, events, 'non-trading and unknown ids synchronize nothing');
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

const until = async (condition, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('a restarted hub releases the update latch itself once the updater job finishes', async t => {
  const f = fixture({ maintenance: true, releasePollMs: 10 });
  t.after(() => f.coordinator.close());
  await f.coordinator.initialize();
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
  await until(() => f.calls.length >= 2);
  assert.equal(f.persisted.maintenance, true, 'a running job keeps the latch');
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
  f.updaterState = state('succeeded');
  await until(() => f.active.aster === false);
  assert.deepEqual(f.active, { crossex: false, greeks: false, aster: false });
  assert.deepEqual(f.persisted, { maintenance: false, pendingPlanId: null });
  const settled = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.calls.length, settled, 'polling stops once the latch is released and modules acknowledged it');
});

test('background release polling keeps an uncertain plan latched and stops on close', async () => {
  const f = fixture({ maintenance: true, pendingPlanId: planId, releasePollMs: 10 });
  await f.coordinator.initialize();
  f.updaterState = unavailableUpdateState();
  await until(() => f.calls.length >= 2);
  f.updaterState = state();
  await until(() => f.calls.length >= 4);
  assert.deepEqual(f.persisted, { maintenance: true, pendingPlanId: planId }, 'an idle updater still offering the pending plan is not completion');
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
  f.coordinator.close();
  const stopped = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(f.calls.length <= stopped + 1, 'close stops further polling');
});

test('a failed initial module synchronization is retried without any browser status read', async t => {
  const f = fixture({ releasePollMs: 10 });
  t.after(() => f.coordinator.close());
  let failures = 2;
  f.handlers['gate:aster'] = active => {
    if (failures-- > 0) throw new Error('module not ready');
    return { data: { active } };
  };
  f.active.aster = true;
  f.updaterState = state();
  await assert.rejects(f.coordinator.initialize(), error => error instanceof UpdateError && error.status === 503);
  await until(() => f.active.aster === false);
  assert.deepEqual(f.active, { crossex: false, greeks: false, aster: false });
  assert.equal(f.persisted.maintenance, false);
});

test('release polling never reads status while an apply is in flight', async t => {
  const f = fixture({ releasePollMs: 10 }), entered = deferred(), release = deferred();
  t.after(() => f.coordinator.close());
  f.handlers['status:aster'] = async () => { entered.resolve(); await release.promise; return { data: { busy: false } }; };
  const result = f.apply();
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(f.calls, [], 'no updater status read races the privileged submission');
  release.resolve();
  assert.equal((await result).job.status, 'running');
  await until(() => f.calls.includes('status'));
  f.updaterState = state('succeeded');
  await until(() => f.active.aster === false);
  assert.deepEqual(f.persisted, { maintenance: false, pendingPlanId: null });
});

test('closing during a background status read neither persists the result nor calls modules', async () => {
  const f = fixture({ maintenance: true, releasePollMs: 10 });
  await f.coordinator.initialize();
  f.updaterState = state('succeeded');
  const gate = f.holdNextStatus();
  await gate.entered.promise;
  const closing = f.coordinator.close();
  const events = f.events.length;
  gate.release.resolve();
  await closing;
  assert.equal(f.events.length, events, 'no persistence or module call after close');
  assert.equal(f.persisted.maintenance, true);
  assert.deepEqual(f.active, { crossex: true, greeks: true, aster: true });
});

test('a restarted trading module is released without a browser status read and stays held under a durable latch', async t => {
  for (const maintenance of [false, true]) {
    await t.test(`maintenance ${maintenance}`, async t => {
      const f = fixture({ maintenance, releasePollMs: 10 });
      t.after(() => f.coordinator.close());
      await f.coordinator.initialize();
      // The restarted module comes back in maintenance and is briefly unreachable.
      f.active.greeks = true;
      let failures = 1;
      f.handlers['gate:greeks'] = active => {
        if (failures-- > 0) throw new Error('module still starting');
        return { data: { active } };
      };
      // Retries read updater status: an idle updater releases, a running job keeps the latch.
      f.updaterState = maintenance ? state('running') : state();
      await f.coordinator.resynchronize();
      await until(() => failures < 0);
      await until(() => f.active.greeks === maintenance);
      assert.deepEqual(f.active, { crossex: maintenance, greeks: maintenance, aster: maintenance });
      assert.equal(f.persisted.maintenance, maintenance);
    });
  }
  const closed = fixture();
  await closed.coordinator.close();
  const events = closed.events.length;
  await closed.coordinator.resynchronize();
  assert.equal(closed.events.length, events, 'no module call after close');
});
