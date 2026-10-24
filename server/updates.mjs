import http from 'node:http';
import { EXECUTION_MAINTENANCE as MAINTENANCE, FINAL_EXECUTION } from './control/execution-jobs.mjs';

const SOCKET_PATH = '/run/project-aggregation-updater/control.sock';
const UNAVAILABLE = '更新服务不可用，请先运行一键部署初始化更新服务';
const ACTIVE = new Set(['queued', 'running']);
const MODULE_UNCONFIRMED = '该交易模块正在恢复，维护状态尚未确认，请稍后重试';
const SCOPE_INVALID = '写入范围无效，暂不能写入';
const EXECUTION_BUSY = '请先停止所有实盘任务并完成委托核对，再更新系统';
const PLAN_ID = /^[A-Za-z0-9_-]{16,128}$/;
const GITHUB_TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const TOKEN_BUSY = '正在检查版本或执行更新，请完成后再修改 GitHub Token';
const TOKEN_INVALID = 'GitHub Token 格式无效，请粘贴完整 Token，且不要包含空格或换行';
const DEPLOYMENT_MODES = new Set(['source', 'ci']);

export class UpdateError extends Error {
  constructor(status, message, { uncertain = false } = {}) { super(message); this.status = status; this.uncertain = uncertain; }
}

export const unavailableUpdateState = () => ({ enabled: false, reason: UNAVAILABLE, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
// Release descriptions are display-only. Bad optional metadata must not block an update.
const releaseNotes = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 6000
  && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(value) ? value.trim() : '';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timestamp = value => text(value, 40) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const nullable = (value, valid) => value === null || valid(value);
const PROGRESS_STAGES = new Set(['preflight', 'download', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize']);
const PROGRESS_DETAILS = {
  download: new Set(['source-receive', 'source-retry']),
  prepare: new Set(['source-resolve', 'dependencies', 'runtime']),
  build: new Set(['build-workbench', 'build-monitor', 'build-asset', 'build-crossex', 'build-aster']),
  verify: new Set(['typecheck', 'tests']),
  finalize: new Set(['healthcheck', 'updater']),
};
const progressNumber = (value, maximum = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;

function publicProgress(value, job) {
  if (job.status !== 'running' || !object(value) || !PROGRESS_STAGES.has(value.stage)
    || !progressNumber(value.timestamp) || value.timestamp <= 0 || value.timestamp < Date.parse(job.startedAt)
    || value.progress !== undefined && !progressNumber(value.progress, 1)
    || ['downloaded', 'total', 'speed', 'eta'].some(key => value[key] !== undefined && !progressNumber(value[key]))
    || value.downloaded !== undefined && value.total !== undefined && value.downloaded > value.total) return null;
  const result = { stage: value.stage, timestamp: value.timestamp };
  if (PROGRESS_DETAILS[value.stage]?.has(value.detail)) result.detail = value.detail;
  if (value.progress !== undefined) result.progress = value.progress;
  if (value.stage === 'download') for (const key of ['downloaded', 'total', 'speed', 'eta']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function publicStageTimings(value, job) {
  if (!['succeeded', 'failed', 'interrupted'].includes(job.status) || !object(value)
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 32) return null;
  const entries = [], seen = new Set();
  for (const row of value.entries) {
    if (!object(row) || !PROGRESS_STAGES.has(row.stage)
      || row.detail !== undefined && !PROGRESS_DETAILS[row.stage]?.has(row.detail)
      || row.durationMs !== null && !progressNumber(row.durationMs)) return null;
    const key = `${row.stage}:${row.detail ?? ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ stage: row.stage, ...(row.detail === undefined ? {} : { detail: row.detail }), durationMs: row.durationMs });
  }
  return { entries };
}

/** Explicit public schema: never forward command output, paths or unknown fields. */
export function publicUpdateState(value) {
  const invalid = () => { throw new UpdateError(503, UNAVAILABLE); };
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.checking !== 'boolean'
    || !nullable(value.checkedAt, timestamp) || !nullable(value.checkError, text)
    || !nullable(value.planId, value => typeof value === 'string' && PLAN_ID.test(value)) || !nullable(value.expiresAt, timestamp)
    || !Array.isArray(value.modules) || value.modules.length > 32 || value.reason !== undefined && !text(value.reason)
    || value.moduleMaintenance !== undefined && (!Array.isArray(value.moduleMaintenance) || value.moduleMaintenance.length > 8
      || value.moduleMaintenance.some(row => !object(row) || !identifier(row.id) || typeof row.confirmed !== 'boolean'))) invalid();
  if (value.githubToken !== undefined && (!object(value.githubToken) || typeof value.githubToken.configured !== 'boolean')) invalid();
  if (value.deploymentModes !== undefined && (!Array.isArray(value.deploymentModes) || !value.deploymentModes.length
    || value.deploymentModes.length > DEPLOYMENT_MODES.size || new Set(value.deploymentModes).size !== value.deploymentModes.length
    || value.deploymentModes.some(mode => !DEPLOYMENT_MODES.has(mode)))) invalid();
  const modules = value.modules.map(row => {
    if (!object(row) || !identifier(row.id) || !text(row.name, 120) || !['current', 'available', 'unavailable', 'unmanaged'].includes(row.state)
      || !['currentVersion', 'latestVersion', 'currentCommit', 'latestCommit'].every(key => nullable(row[key], value => text(value, 128)))
      || row.reason !== undefined && !text(row.reason)
      || row.recovery !== undefined && typeof row.recovery !== 'boolean') invalid();
    const notes = releaseNotes(row.releaseNotes);
    return { id: row.id, name: row.name, state: row.state, currentVersion: row.currentVersion, latestVersion: row.latestVersion,
      currentCommit: row.currentCommit, latestCommit: row.latestCommit, ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(notes ? { releaseNotes: notes } : {}), ...(row.recovery === undefined ? {} : { recovery: row.recovery }) };
  });
  let job = null;
  if (value.job !== null) {
    const row = value.job;
    if (!object(row) || !identifier(row.id) || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(row.status)
      || !timestamp(row.startedAt) || !nullable(row.finishedAt, timestamp) || !nullable(row.activeModule, identifier)
      || !text(row.message) || !Array.isArray(row.steps) || row.steps.length > 128
      || row.deployMode !== undefined && !DEPLOYMENT_MODES.has(row.deployMode)) invalid();
    const steps = row.steps.map(step => {
      if (!object(step) || !identifier(step.id) || !text(step.name, 120) || !['pending', 'running', 'succeeded', 'failed', 'skipped'].includes(step.status)
        || step.message !== undefined && !text(step.message)) invalid();
      return { id: step.id, name: step.name, status: step.status, ...(step.message === undefined ? {} : { message: step.message }) };
    });
    job = { id: row.id, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, activeModule: row.activeModule, steps, message: row.message };
    if (row.deployMode !== undefined) job.deployMode = row.deployMode;
    const progress = publicProgress(row.progress, row);
    if (progress) job.progress = progress;
    const stageTimings = publicStageTimings(row.stageTimings, row);
    if (stageTimings) job.stageTimings = stageTimings;
  }
  return { enabled: value.enabled, ...(value.reason === undefined ? {} : { reason: value.reason }), checking: value.checking,
    checkedAt: value.checkedAt, checkError: value.checkError, planId: value.planId, expiresAt: value.expiresAt, modules, job,
    ...(value.deploymentModes === undefined ? {} : { deploymentModes: [...value.deploymentModes] }),
    ...(value.githubToken === undefined ? {} : { githubToken: { configured: value.githubToken.configured } }),
    ...(value.moduleMaintenance === undefined ? {} : { moduleMaintenance: value.moduleMaintenance.map(row => ({ id: row.id, confirmed: row.confirmed })) }) };
}

export function validateUpdateBody(action, body) {
  const fields = action === 'apply' ? ['planId', 'deployMode'] : action === 'token' ? ['token'] : [];
  if (!['check', 'apply', 'token'].includes(action) || !object(body) || Object.keys(body).some(key => !fields.includes(key))) throw new UpdateError(400, '更新请求包含不支持的字段');
  if (action === 'apply' && (typeof body.planId !== 'string' || !PLAN_ID.test(body.planId))) throw new UpdateError(400, '更新计划无效，请重新检查更新');
  if (action === 'apply' && body.deployMode !== undefined && !DEPLOYMENT_MODES.has(body.deployMode)) throw new UpdateError(400, '更新模式无效');
  if (action === 'token' && (typeof body.token !== 'string' || body.token !== '' && (!GITHUB_TOKEN.test(body.token) || body.token.trim() !== body.token))) throw new UpdateError(400, TOKEN_INVALID);
}

/** socketPath is a test dependency only; production does not read a URL/path from env or requests. */
export function createUpdateClient({ socketPath = SOCKET_PATH, timeoutMs = 8000 } = {}) {
  function request(method, route, body) {
    return new Promise((resolve, reject) => {
      let settled = false, connected = false;
      const tokenRequest = route === '/token';
      const unavailable = uncertain => new UpdateError(503, tokenRequest && uncertain ? 'GitHub Token 保存结果尚未确认，请刷新配置状态后核对' : UNAVAILABLE, { uncertain });
      const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const req = http.request({ socketPath, path: route, method, agent: false,
        headers: content ? { 'Content-Type': 'application/json', 'Content-Length': content.length } : {} }, res => {
        const chunks = []; let size = 0;
        const fail = () => { finish(unavailable(method === 'POST')); res.destroy(); req.destroy(); };
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) fail(); else chunks.push(chunk); });
        res.on('aborted', fail); res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const status = [400, 409, 429, 503].includes(res.statusCode) ? res.statusCode : 503;
            const message = status === 409 ? tokenRequest ? TOKEN_BUSY : '更新计划已改变或已有更新任务，请刷新后重试'
              : status === 400 ? tokenRequest ? TOKEN_INVALID : '更新计划无效，请重新检查更新'
                : status === 429 ? '更新请求过于频繁，请稍后重试'
                  : tokenRequest ? 'GitHub Token 保存结果尚未确认，请刷新配置状态后核对' : UNAVAILABLE;
            finish(new UpdateError(status, message, { uncertain: method === 'POST' && status === 503 })); return;
          }
          try {
            const value = publicUpdateState(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (tokenRequest && value.githubToken === undefined) throw new Error('Missing token configuration status');
            finish(null, value);
          } catch { finish(unavailable(method === 'POST')); }
        });
      });
      req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
      req.on('error', () => finish(unavailable(method === 'POST' && connected)));
      // Wall-clock deadline also bounds slow trickle responses, not just idle sockets.
      const timer = setTimeout(() => { finish(unavailable(method === 'POST' && connected)); req.destroy(); }, timeoutMs);
      timer.unref?.();
      req.end(content);
    });
  }
  return {
    async status() { try { return await request('GET', '/status'); } catch { return unavailableUpdateState(); } },
    check() { return request('POST', '/check', {}); },
    apply(planId, deployMode = 'source') {
      validateUpdateBody('apply', { planId, deployMode });
      // Keep source updates compatible with helpers installed before mode selection.
      return request('POST', '/apply', { planId, ...(deployMode === 'source' ? {} : { deployMode }) });
    },
    token(token) { validateUpdateBody('token', { token }); return request('POST', '/token', { token }); },
  };
}

/** Serializes update acceptance with live-entry operations, without touching stop/reconcile. */
export function createUpdateCoordinator({ client, execution, readMaintenance = () => false, writeMaintenance = () => {}, readPendingPlanId = () => null, writePendingPlanId = () => {}, readPendingDeployMode = () => 'source', writePendingDeployMode = () => {}, setModuleMaintenance = async () => {}, tradingModules = [], moduleIds = tradingModules, prepareApply = async () => {}, releasePollMs = 5000, now = Date.now }) {
  // Without these the idle check would skip open entries or run outside the write lock.
  // writeMaintenance and writePendingPlanId must use the connection of
  // execution.transaction, or they wait out busy_timeout under its write lock.
  if (!['state', 'openEntries', 'transaction'].every(name => typeof execution?.[name] === 'function')) throw new TypeError('createUpdateCoordinator requires execution.state, openEntries and transaction');
  let pendingPlanId = readPendingPlanId();
  let pendingDeployMode = readPendingDeployMode();
  let maintenance = readMaintenance(), generation = 0, entries = 0, applying = null;
  let moduleSync = Promise.resolve(), watcher = null, polling = null, closed = false;
  // The maintenance value each trading module last acknowledged; null is unknown.
  const acknowledged = new Map(tradingModules.map(id => [id, null])), releasedAt = new Map();
  const confirmed = id => acknowledged.get(id) === maintenance;
  // Rejects when any module fails, so initialize() and apply() stay all-or-nothing.
  const synchronizeModules = (ids = tradingModules) => {
    const next = moduleSync.catch(() => {}).then(async () => {
      const active = maintenance;
      let failed = [];
      try { await setModuleMaintenance(active, ids); }
      catch (error) { failed = Array.isArray(error?.failed) ? error.failed : ids; throw error; }
      finally {
        for (const id of ids) {
          const value = failed.includes(id) ? null : active;
          if (value === false && acknowledged.get(id) !== false) releasedAt.set(id, new Date(now()).toISOString());
          if (value !== false) releasedAt.delete(id);
          acknowledged.set(id, value);
        }
      }
    });
    moduleSync = next;
    void next.catch(() => {}).finally(watchRelease);
    return next;
  };
  const withModules = state => tradingModules.length ? { ...state, moduleMaintenance: tradingModules.map(id => ({ id, confirmed: confirmed(id) })) } : state;
  // The hub restarts while the update job is still running, so the latch can
  // only be released by a later status read. Without a server-side read the
  // trading modules stay in maintenance until some browser asks for status.
  function watchRelease() {
    if (closed || watcher || !(releasePollMs > 0) || applying || !maintenance && tradingModules.every(confirmed)) return;
    watcher = setTimeout(() => {
      // status() always resynchronizes modules; failures retry on the next turn.
      polling = (applying ? Promise.resolve() : status()).catch(() => {}).finally(() => { polling = null; watcher = null; watchRelease(); });
    }, releasePollMs);
    watcher.unref?.();
  }
  function remember(value) { if (maintenance !== value) { writeMaintenance(value); maintenance = value; } }
  function rememberPending(value, deployMode = 'source') {
    const rememberMode = () => { if (pendingDeployMode !== deployMode) { writePendingDeployMode(deployMode); pendingDeployMode = deployMode; } };
    // Record mode before a new plan, and clear the plan before resetting mode.
    if (value) rememberMode();
    if (pendingPlanId !== value) { writePendingPlanId(value); pendingPlanId = value; }
    if (!value) rememberMode();
  }
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
    // A read that returns during shutdown must not write state or call modules.
    if (closed) return state;
    if (!applying && version === generation) observe(state);
    // One restarting module must not hide the updater state; the result is per module.
    await synchronizeModules().catch(() => {});
    return withModules(state);
  }
  async function check() {
    const version = generation;
    const state = publicUpdateState(await client.check());
    if (!applying && version === generation) observe(state);
    await synchronizeModules().catch(() => {});
    return withModules(state);
  }
  async function token(value, authorize) {
    authorize();
    if (applying) throw new UpdateError(409, TOKEN_BUSY);
    // Credential writes do not enter or clear the trading maintenance gate.
    return publicUpdateState(await client.token(value));
  }
  /** scope is 'native' or a module id; without one every trading module must be confirmed. */
  async function withExecutionEntry(operation, { scope } = {}) {
    // An unknown scope would match no gate, so it is refused rather than allowed.
    if (scope !== undefined && scope !== 'native' && !moduleIds.includes(scope) && !tradingModules.includes(scope)) throw new UpdateError(503, SCOPE_INVALID);
    if (applying) throw new UpdateError(409, MAINTENANCE);
    // Reserve before the first await, so apply cannot pass its idle check concurrently.
    entries += 1;
    try {
      await status();
      if (maintenance || applying) throw new UpdateError(409, MAINTENANCE);
      // Only the target trading module's gate matters; other scopes need none.
      const required = scope === undefined ? tradingModules : tradingModules.filter(id => id === scope);
      if (!required.every(confirmed)) throw new UpdateError(503, MODULE_UNCONFIRMED);
      return await operation();
    } finally { entries -= 1; }
  }
  function apply(planId, authorize, deployMode = 'source') {
    authorize();
    validateUpdateBody('apply', { planId, deployMode });
    if (applying) {
      if (applying.planId !== planId || applying.deployMode !== deployMode) throw new UpdateError(409, MAINTENANCE);
      return applying.promise;
    }
    if (pendingPlanId && (pendingPlanId !== planId || pendingDeployMode !== deployMode)) throw new UpdateError(409, MAINTENANCE);
    const busy = () => entries || execution.openEntries() || execution.state().jobs.some(job => !FINAL_EXECUTION.has(job.status));
    if (busy()) throw new UpdateError(409, EXECUTION_BUSY);
    const previous = { maintenance, pendingPlanId, pendingDeployMode };
    // The idle check and the maintenance write share one write transaction, so
    // an execution entry the runtime records concurrently is either seen here
    // or refused by the committed flag (design doc 5.5). Persist the plan
    // first; restoration also treats a pending plan as maintenance.
    try {
      execution.transaction(() => {
        if (busy()) throw new UpdateError(409, EXECUTION_BUSY);
        rememberPending(planId, deployMode);
        remember(true);
      });
    } catch (error) {
      // A rolled-back write leaves the durable values; the cached ones follow them.
      ({ maintenance, pendingPlanId, pendingDeployMode } = previous);
      throw error;
    }
    generation += 1;
    const pending = { planId, deployMode, promise: null };
    applying = pending;
    pending.promise = (async () => {
      try {
        await synchronizeModules();
        await prepareApply();
        // Run authorization again immediately before sending the privileged request.
        authorize();
        const state = publicUpdateState(await client.apply(planId, deployMode));
        rememberPending(null);
        observe(state);
        return state;
      } catch (error) {
        // A timeout may follow successful acceptance. Keep the durable latch until status confirms completion.
        if (error instanceof UpdateError && !error.uncertain) { rememberPending(previous.pendingPlanId, previous.pendingDeployMode); remember(previous.maintenance); }
        throw error;
      } finally {
        if (applying === pending) { generation += 1; applying = null; }
        await synchronizeModules();
      }
    })();
    return pending.promise;
  }
  // A restarted trading module starts in maintenance. Synchronize only that
  // module at once instead of waiting for a browser status read; failures
  // retry via watchRelease.
  function resynchronize(id) {
    const ids = id === undefined ? tradingModules : tradingModules.filter(module => module === id);
    if (closed || !ids.length) return Promise.resolve();
    for (const module of ids) { acknowledged.set(module, null); releasedAt.delete(module); }
    return synchronizeModules(ids).catch(() => {});
  }
  /** Per trading module: whether its gate matches the durable value, and when it was last released. */
  function moduleMaintenance() {
    return Object.fromEntries(tradingModules.map(id => [id, { confirmed: confirmed(id), maintenance, releasedAt: releasedAt.get(id) ?? null }]));
  }
  async function close() { closed = true; clearTimeout(watcher); await polling; }
  return { status, check, apply, token, withExecutionEntry, initialize: () => synchronizeModules(), resynchronize, moduleMaintenance, close };
}
