import { randomUUID } from 'node:crypto';
import { moduleOrigin, moduleTransport } from '../modules/transport.mjs';
import { PROTOCOL_VERSION, RuntimeError, validateMaintenanceIds, validateModuleId } from './protocol.mjs';

const MODULES_DISABLED = '未启用内嵌模块';
// The runtime side of the internal protocol. Both the in-process client and the
// internal HTTP server call these methods; neither adds behaviour of its own.
export function createRuntimeService({ instanceId = randomUUID(), moduleRuntime = null, guard = null, readMaintenance, isReady = () => true }) {
  if (typeof readMaintenance !== 'function') throw new Error('Runtime service needs the durable maintenance reader');
  function status() {
    const modules = moduleRuntime ? moduleRuntime.status() : [];
    return { schemaVersion: 1, protocol: PROTOCOL_VERSION, instanceId, ready: !!isReady(), degraded: modules.filter(row => row.state === 'fault').map(row => row.moduleId),
      modulesEnabled: !!moduleRuntime, modules };
  }
  function resolveTransport(id) {
    validateModuleId(id);
    if (!moduleRuntime) throw new RuntimeError(404, MODULES_DISABLED);
    let transport;
    try { transport = moduleTransport(moduleOrigin(id)); } catch { throw new RuntimeError(503, '模块暂不可用'); }
    return { moduleId: id, socketPath: transport.socketPath, secret: transport.secret, instanceId: transport.instanceId, generation: transport.generation };
  }
  // The durable flag is the only authority: the caller names modules, never the value.
  // Calls run one at a time in arrival order, so a sync its caller abandoned
  // still reaches the modules before a later one and cannot overwrite it.
  // `ifIdle` skips the call (null) while another one is queued or running: that
  // one sends the current durable value. `deadlineMs` shortens the per-module
  // deadline, so an API sync queued behind this one still fits its budget.
  let syncs = Promise.resolve(), queued = 0;
  function syncMaintenance(ids, { ifIdle = false, deadlineMs } = {}) {
    const modules = validateMaintenanceIds(ids);
    if (!guard) throw new RuntimeError(404, MODULES_DISABLED);
    if (ifIdle && queued) return Promise.resolve(null);
    queued += 1;
    const run = syncs.then(async () => {
      const active = readMaintenance() === true;
      let failed = [];
      try { await guard.setMaintenance(active, modules, { deadlineMs }); }
      catch (error) { failed = Array.isArray(error?.failed) ? error.failed : modules; }
      return { active, modules: modules.map(id => ({ id, confirmed: !failed.includes(id) })) };
    }).finally(() => { queued -= 1; });
    syncs = run.catch(() => {});
    return run;
  }
  async function prepareStop() {
    if (!guard) throw new RuntimeError(404, MODULES_DISABLED);
    try { await guard.prepareApply(); }
    catch (error) { throw error?.status === 409 || error?.status === 503 ? new RuntimeError(error.status, error.message) : new RuntimeError(503, '无法确认内嵌模块的停机条件，暂不能更新'); }
    return { ready: true };
  }
  function restartModule(id) {
    validateModuleId(id);
    if (!moduleRuntime) throw new RuntimeError(404, '模块不存在');
    if (!moduleRuntime.restart(id)) throw new RuntimeError(409, '模块不在故障状态，无需恢复');
    return { accepted: true, moduleId: id };
  }
  return { instanceId, status, resolveTransport, syncMaintenance, prepareStop, restartModule };
}
