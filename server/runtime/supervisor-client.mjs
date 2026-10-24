import http from 'node:http';
import { UpdateError } from '../updates.mjs';
import { BUDGETS, MAX_RESPONSE_BYTES, readDiscovery, RUNTIME_KEY_HEADER, RuntimeError, runtimeErrorFrom, SUPPORTED_PROTOCOLS, unavailable,
  validateMaintenanceIds, validateModuleId, validatePrepareStop, validateRestart, validateStatus, validateSync, validateTransport } from './protocol.mjs';

// The SupervisorClient contract. Both implementations validate arguments
// locally and every result with the same functions, so callers cannot tell
// them apart except by latency and transport failures.
function contract(invoke) {
  return {
    async status() { return validateStatus(await invoke('status')); },
    async resolveTransport(id) { validateModuleId(id); return validateTransport(await invoke('resolveTransport', id), id); },
    async syncMaintenance(ids) { const modules = validateMaintenanceIds(ids); return validateSync(await invoke('syncMaintenance', modules), modules); },
    async prepareStop() { return validatePrepareStop(await invoke('prepareStop')); },
    async restartModule(id) { validateModuleId(id); return validateRestart(await invoke('restartModule', id), id); },
  };
}

// Used by createApp, where API and runtime share one process.
export function createInProcessClient(service) {
  return contract(async (name, argument) => {
    try { return await service[name](argument); }
    catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError(503, '运行时内部错误'); }
  });
}

const operations = {
  status: { method: 'GET', route: () => '/internal/v1/status', budget: 'read', retry: true },
  resolveTransport: { method: 'GET', route: id => `/internal/v1/modules/${id}/transport`, budget: 'read', retry: true },
  syncMaintenance: { method: 'POST', route: () => '/internal/v1/maintenance/sync', body: modules => ({ modules }), budget: 'maintenance', retry: false },
  prepareStop: { method: 'POST', route: () => '/internal/v1/maintenance/prepare-stop', body: () => ({}), budget: 'prepareStop', retry: false },
  restartModule: { method: 'POST', route: id => `/internal/v1/modules/${id}/restart`, budget: 'read', retry: false },
};

// Resolves the runtime from its discovery file and talks HTTP over its private
// socket. The cached record is dropped on refusal, disconnect, a rejected key
// or a different instance; only reads are retried, once, after re-resolving.
export function createSocketClient({ dir, protocols = SUPPORTED_PROTOCOLS, budgets: overrides = {}, onInstanceChange = () => {} }) {
  const budgets = { ...BUDGETS, ...overrides };
  let record = null, lastInstance = null;
  function exchange(target, method, route, body, deadline) {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(unavailable()); return; }
      let settled = false, connected = false;
      const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
      // A POST that reached the runtime may have taken effect.
      const fail = () => finish(unavailable(method === 'POST' && connected));
      const req = http.request({ socketPath: target.socketPath, path: route, method, agent: false,
        headers: { [RUNTIME_KEY_HEADER]: target.secret, ...(content ? { 'Content-Type': 'application/json', 'Content-Length': content.length } : {}) } }, res => {
        const chunks = []; let size = 0;
        const abort = () => { fail(); res.destroy(); req.destroy(); };
        res.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) abort(); else chunks.push(chunk); });
        res.on('aborted', abort); res.on('error', abort);
        res.on('end', () => {
          if (settled) return;
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(); return; }
          finish(null, { status: res.statusCode, body: value });
        });
      });
      req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
      req.on('error', fail);
      // Wall-clock deadline also bounds slow trickle responses, not just idle sockets.
      const timer = setTimeout(() => { fail(); req.destroy(); }, remaining);
      timer.unref?.();
      req.end(content);
    });
  }
  async function resolveRecord(deadline) {
    if (record) return record;
    let next;
    try { next = readDiscovery(dir); } catch { throw unavailable(); }
    if (!next || !protocols.includes(next.protocol)) throw unavailable();
    // The file alone is not proof: the instance behind the socket must confirm its identity.
    const reply = await exchange(next, 'GET', '/internal/v1/status', undefined, deadline);
    let status;
    try { if (reply.status !== 200) throw unavailable(); status = validateStatus(reply.body, protocols); } catch { throw unavailable(); }
    if (status.instanceId !== next.instanceId || status.protocol !== next.protocol) throw unavailable();
    record = next;
    const previous = lastInstance; lastInstance = next.instanceId;
    if (previous !== null && previous !== next.instanceId) { try { onInstanceChange(next.instanceId, previous); } catch { /* observer failures do not fail the call */ } }
    return record;
  }
  async function invoke(name, argument) {
    const operation = operations[name], deadline = Date.now() + budgets[operation.budget];
    for (let attempt = 0; ; attempt += 1) {
      let target = null;
      try {
        target = await resolveRecord(deadline);
        const reply = await exchange(target, operation.method, operation.route(argument), operation.body?.(argument), deadline);
        // A rejected key means the record is stale, not that the call was refused.
        if (reply.status === 401) throw unavailable();
        if (reply.status !== 200) throw runtimeErrorFrom(reply.status, reply.body);
        if (name === 'status' && reply.body?.instanceId !== target.instanceId) throw unavailable();
        return reply.body;
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.origin !== 'transport') throw error;
        if (record === target) record = null;
        if (!operation.retry || attempt > 0 || error.uncertain || Date.now() >= deadline) throw error;
      }
    }
  }
  return { ...contract(invoke), invalidate() { record = null; } };
}

// Adapts the client to the update coordinator's hooks. The runtime reports the
// durable value it applied; a different value than the coordinator expects
// leaves every module unconfirmed (fail closed).
export function coordinatorHooks(client) {
  const unconfirmed = failed => Object.assign(new UpdateError(503, '内嵌交易模块的维护状态尚未确认，请重试'), { failed });
  return {
    async setModuleMaintenance(active, ids) {
      let result;
      try { result = await client.syncMaintenance(ids); } catch { throw unconfirmed([...ids]); }
      const failed = result.active !== active ? [...ids] : result.modules.filter(row => !row.confirmed).map(row => row.id);
      if (failed.length) throw unconfirmed(failed);
    },
    async prepareApply() {
      try { await client.prepareStop(); }
      catch (error) {
        if (error instanceof RuntimeError && error.origin === 'runtime' && (error.status === 409 || error.status === 503)) throw new UpdateError(error.status, error.message);
        throw new UpdateError(503, '运行时不可用，暂不能更新');
      }
    },
  };
}
