import { UpdateError } from '../updates.mjs';
import { createRuntimeConnection } from './connection.mjs';
import { BUDGETS, RuntimeError, runtimeErrorFrom, SUPPORTED_PROTOCOLS, unavailable,
  validateMaintenanceIds, validateModuleId, validatePrepareStop, validateRestart, validateStatus, validateSync, validateTransport } from './protocol.mjs';

// A write whose reply fails validation may still have taken effect.
export async function writeResult(reply, validate) {
  const value = await reply;
  try { return validate(value); } catch (error) { throw error instanceof RuntimeError && error.origin === 'transport' ? unavailable(true) : error; }
}

// The SupervisorClient contract. Both implementations validate arguments
// locally and every result with the same functions, so callers cannot tell
// them apart except by latency and transport failures.
function contract(invoke) {
  return {
    async status() { return validateStatus(await invoke('status')); },
    async resolveTransport(id) { validateModuleId(id); return validateTransport(await invoke('resolveTransport', id), id); },
    async syncMaintenance(ids) { const modules = validateMaintenanceIds(ids); return writeResult(invoke('syncMaintenance', modules), value => validateSync(value, modules)); },
    async prepareStop() { return writeResult(invoke('prepareStop'), validatePrepareStop); },
    async restartModule(id) { validateModuleId(id); return writeResult(invoke('restartModule', id), value => validateRestart(value, id)); },
  };
}

// Used by createApp, where API and runtime share one process.
export function createInProcessClient(service, { log } = {}) {
  return contract(async (name, argument) => {
    try { return await service[name](argument); }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      // The caller only sees the generic message; the cause stays in this log.
      log?.error({ err: error, operation: name, type: 'runtime' }, '运行时调用失败');
      throw new RuntimeError(503, '运行时内部错误');
    }
  });
}

const operations = {
  status: { method: 'GET', route: () => '/internal/v1/status', budget: 'read', retry: true },
  resolveTransport: { method: 'GET', route: id => `/internal/v1/modules/${id}/transport`, budget: 'read', retry: true },
  syncMaintenance: { method: 'POST', route: () => '/internal/v1/maintenance/sync', body: modules => ({ modules }), budget: 'maintenance', retry: false },
  prepareStop: { method: 'POST', route: () => '/internal/v1/maintenance/prepare-stop', body: () => ({}), budget: 'prepareStop', retry: false },
  restartModule: { method: 'POST', route: id => `/internal/v1/modules/${id}/restart`, budget: 'read', retry: false },
};

// Sends one JSON call over `connection`: the cached record is dropped on
// refusal, disconnect, a rejected key or a different instance; a call marked
// `retry` is retried once after re-resolving, within the same budget.
export async function invokeOverSocket(connection, { method, route, body, budget, retry, maxBytes, check = () => {} }) {
  const deadline = Date.now() + budget;
  const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
  for (let attempt = 0; ; attempt += 1) {
    let target = null;
    try {
      target = await connection.resolve(deadline);
      const reply = await connection.exchange(target, { method, route, deadline, maxBytes, body: content, headers: content ? { 'Content-Type': 'application/json' } : {} });
      // A rejected key means the record is stale, not that the call was refused.
      if (reply.status === 401) throw unavailable();
      if (reply.status !== 200) throw runtimeErrorFrom(reply.status, reply.body);
      check(reply.body, target);
      return reply.body;
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.origin !== 'transport') throw error;
      connection.invalidate(target);
      if (!retry || attempt > 0 || error.uncertain || Date.now() >= deadline) throw error;
    }
  }
}

// Resolves the runtime from its discovery file and talks HTTP over its private
// socket; `connection` may be shared with the data-plane client.
// `onInstanceChange` belongs to the connection, so it cannot be combined with a shared one.
export function createSocketClient({ dir, protocols = SUPPORTED_PROTOCOLS, budgets: overrides = {}, onInstanceChange, connection }) {
  if (connection && onInstanceChange) throw new TypeError('Pass onInstanceChange to the shared connection');
  connection ??= createRuntimeConnection({ dir, protocols, ...(onInstanceChange ? { onInstanceChange } : {}) });
  const budgets = { ...BUDGETS, ...overrides };
  return { ...contract((name, argument) => {
    const operation = operations[name];
    return invokeOverSocket(connection, { method: operation.method, route: operation.route(argument), body: operation.body?.(argument), budget: budgets[operation.budget], retry: operation.retry,
      check: (value, target) => { if (name === 'status' && value?.instanceId !== target.instanceId) throw unavailable(); } });
  }), invalidate() { connection.invalidate(); } };
}

// Adapts the client to the update coordinator's hooks. The runtime reports the
// durable value it applied; a different value than the coordinator expects
// leaves every module unconfirmed (fail closed).
export function coordinatorHooks(client, { log } = {}) {
  const unconfirmed = failed => Object.assign(new UpdateError(503, '内嵌交易模块的维护状态尚未确认，请重试'), { failed });
  return {
    async setModuleMaintenance(active, ids) {
      let result;
      try { result = await client.syncMaintenance(ids); }
      catch (error) { log?.warn({ err: error, modules: ids, type: 'maintenance' }, '维护同步未获运行时确认'); throw unconfirmed([...ids]); }
      const failed = result.active !== active ? [...ids] : result.modules.filter(row => !row.confirmed).map(row => row.id);
      if (failed.length) throw unconfirmed(failed);
    },
    async prepareApply() {
      try { await client.prepareStop(); }
      catch (error) {
        if (error instanceof RuntimeError && error.origin === 'runtime' && (error.status === 409 || error.status === 503)) throw new UpdateError(error.status, error.message);
        log?.warn({ err: error, type: 'maintenance' }, '停机准入未获运行时确认');
        throw new UpdateError(503, '运行时不可用，暂不能更新');
      }
    },
  };
}
