import http from 'node:http';

const SOCKET_PATH = '/run/project-aggregation-updater/control.sock';
const UNAVAILABLE = '更新服务不可用，请先运行一键部署初始化更新服务';
const MAINTENANCE = '系统正在更新或等待确认更新结果，暂不能新建实盘任务或修改实盘连接';
const ACTIVE = new Set(['queued', 'running']);
const FINAL_EXECUTION = new Set(['completed', 'stopped']);
const PLAN_ID = /^[A-Za-z0-9_-]{16,128}$/;

export class UpdateError extends Error {
  constructor(status, message, { uncertain = false } = {}) { super(message); this.status = status; this.uncertain = uncertain; }
}

export const unavailableUpdateState = () => ({ enabled: false, reason: UNAVAILABLE, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timestamp = value => text(value, 40) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const nullable = (value, valid) => value === null || valid(value);

/** Explicit public schema: never forward command output, paths or unknown fields. */
export function publicUpdateState(value) {
  const invalid = () => { throw new UpdateError(503, UNAVAILABLE); };
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.checking !== 'boolean'
    || !nullable(value.checkedAt, timestamp) || !nullable(value.checkError, text)
    || !nullable(value.planId, value => typeof value === 'string' && PLAN_ID.test(value)) || !nullable(value.expiresAt, timestamp)
    || !Array.isArray(value.modules) || value.modules.length > 32 || value.reason !== undefined && !text(value.reason)) invalid();
  const modules = value.modules.map(row => {
    if (!object(row) || !identifier(row.id) || !text(row.name, 120) || !['current', 'available', 'unavailable', 'unmanaged'].includes(row.state)
      || !['currentVersion', 'latestVersion', 'currentCommit', 'latestCommit'].every(key => nullable(row[key], value => text(value, 128)))
      || row.reason !== undefined && !text(row.reason)) invalid();
    return { id: row.id, name: row.name, state: row.state, currentVersion: row.currentVersion, latestVersion: row.latestVersion,
      currentCommit: row.currentCommit, latestCommit: row.latestCommit, ...(row.reason === undefined ? {} : { reason: row.reason }) };
  });
  let job = null;
  if (value.job !== null) {
    const row = value.job;
    if (!object(row) || !identifier(row.id) || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(row.status)
      || !timestamp(row.startedAt) || !nullable(row.finishedAt, timestamp) || !nullable(row.activeModule, identifier)
      || !text(row.message) || !Array.isArray(row.steps) || row.steps.length > 128) invalid();
    const steps = row.steps.map(step => {
      if (!object(step) || !identifier(step.id) || !text(step.name, 120) || !['pending', 'running', 'succeeded', 'failed', 'skipped'].includes(step.status)
        || step.message !== undefined && !text(step.message)) invalid();
      return { id: step.id, name: step.name, status: step.status, ...(step.message === undefined ? {} : { message: step.message }) };
    });
    job = { id: row.id, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, activeModule: row.activeModule, steps, message: row.message };
  }
  return { enabled: value.enabled, ...(value.reason === undefined ? {} : { reason: value.reason }), checking: value.checking,
    checkedAt: value.checkedAt, checkError: value.checkError, planId: value.planId, expiresAt: value.expiresAt, modules, job };
}

export function validateUpdateBody(action, body) {
  if (!object(body) || Object.keys(body).some(key => action === 'apply' ? key !== 'planId' : true)) throw new UpdateError(400, '更新请求包含不支持的字段');
  if (action === 'apply' && (typeof body.planId !== 'string' || !PLAN_ID.test(body.planId))) throw new UpdateError(400, '更新计划无效，请重新检查更新');
}

/** socketPath is a test dependency only; production does not read a URL/path from env or requests. */
export function createUpdateClient({ socketPath = SOCKET_PATH, timeoutMs = 8000 } = {}) {
  function request(method, route, body) {
    return new Promise((resolve, reject) => {
      let settled = false, connected = false;
      const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const req = http.request({ socketPath, path: route, method, agent: false,
        headers: content ? { 'Content-Type': 'application/json', 'Content-Length': content.length } : {} }, res => {
        const chunks = []; let size = 0;
        const fail = () => { finish(new UpdateError(503, UNAVAILABLE, { uncertain: method === 'POST' })); res.destroy(); req.destroy(); };
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) fail(); else chunks.push(chunk); });
        res.on('aborted', fail); res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const status = [400, 409, 429, 503].includes(res.statusCode) ? res.statusCode : 503;
            const message = status === 409 ? '更新计划已改变或已有更新任务，请刷新后重试' : status === 400 ? '更新计划无效，请重新检查更新' : status === 429 ? '更新请求过于频繁，请稍后重试' : UNAVAILABLE;
            finish(new UpdateError(status, message, { uncertain: method === 'POST' && status === 503 })); return;
          }
          try { finish(null, publicUpdateState(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
          catch { finish(new UpdateError(503, UNAVAILABLE, { uncertain: method === 'POST' })); }
        });
      });
      req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
      req.on('error', () => finish(new UpdateError(503, UNAVAILABLE, { uncertain: method === 'POST' && connected })));
      // Wall-clock deadline also bounds slow trickle responses, not just idle sockets.
      const timer = setTimeout(() => { finish(new UpdateError(503, UNAVAILABLE, { uncertain: method === 'POST' && connected })); req.destroy(); }, timeoutMs);
      timer.unref?.();
      req.end(content);
    });
  }
  return {
    async status() { try { return await request('GET', '/status'); } catch { return unavailableUpdateState(); } },
    check() { return request('POST', '/check', {}); },
    apply(planId) { validateUpdateBody('apply', { planId }); return request('POST', '/apply', { planId }); },
  };
}

/** Serializes update acceptance with live-entry operations, without touching stop/reconcile. */
export function createUpdateCoordinator({ client, execution, readMaintenance = () => false, writeMaintenance = () => {}, readPendingPlanId = () => null, writePendingPlanId = () => {} }) {
  let pendingPlanId = readPendingPlanId();
  let maintenance = readMaintenance(), generation = 0, entries = 0, applying = null;
  function remember(value) { if (maintenance !== value) { writeMaintenance(value); maintenance = value; } }
  function rememberPending(value) { if (pendingPlanId !== value) { writePendingPlanId(value); pendingPlanId = value; } }
  if (pendingPlanId) remember(true);
  function observe(state) {
    if (state.enabled) {
      // A timed-out request may still be waiting for root's lock. Idle state is
      // conclusive only after that request's plan can no longer be accepted.
      if (ACTIVE.has(state.job?.status) || pendingPlanId && state.planId === pendingPlanId) remember(true);
      else { rememberPending(null); remember(false); }
    }
    return state;
  }
  async function status() {
    const version = generation;
    const state = publicUpdateState(await client.status());
    if (!applying && version === generation) observe(state);
    return state;
  }
  async function check() {
    const version = generation;
    const state = publicUpdateState(await client.check());
    if (!applying && version === generation) observe(state);
    return state;
  }
  async function withExecutionEntry(operation) {
    if (applying) throw new UpdateError(409, MAINTENANCE);
    // Reserve before the first await, so apply cannot pass its idle check concurrently.
    entries += 1;
    try {
      await status();
      if (maintenance || applying) throw new UpdateError(409, MAINTENANCE);
      return await operation();
    } finally { entries -= 1; }
  }
  function apply(planId, authorize) {
    authorize();
    if (applying) {
      if (applying.planId !== planId) throw new UpdateError(409, MAINTENANCE);
      return applying.promise;
    }
    if (pendingPlanId && pendingPlanId !== planId) throw new UpdateError(409, MAINTENANCE);
    if (entries || execution.state().jobs.some(job => !FINAL_EXECUTION.has(job.status))) throw new UpdateError(409, '请先停止所有实盘任务并完成委托核对，再更新系统');
    generation += 1;
    const previous = { maintenance, pendingPlanId };
    // Persist the plan first; restoration also treats a pending plan as maintenance.
    rememberPending(planId);
    remember(true);
    const pending = { planId, promise: null };
    applying = pending;
    pending.promise = (async () => {
      try {
        // Run authorization again immediately before sending the privileged request.
        authorize();
        const state = publicUpdateState(await client.apply(planId));
        rememberPending(null);
        observe(state);
        return state;
      } catch (error) {
        // A timeout may follow successful acceptance. Keep the durable latch until status confirms completion.
        if (error instanceof UpdateError && !error.uncertain) { rememberPending(previous.pendingPlanId); remember(previous.maintenance); }
        throw error;
      } finally { if (applying === pending) { generation += 1; applying = null; } }
    })();
    return pending.promise;
  }
  return { status, check, apply, withExecutionEntry };
}
