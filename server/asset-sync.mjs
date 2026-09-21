import { requestAuthenticatedJson, UpstreamError } from './adapters.mjs';

// Asset's existing route refreshes saved quotes and read-only exchange balances.
export async function syncAsset(project, credentials, { deadline = Date.now() + 60000, signal, request } = {}) {
  if (project.adapter !== 'asset') throw new UpstreamError('invalid', '仅资产项目支持自动同步');
  if (!credentials?.password) throw new UpstreamError('unauthorized', '请先保存资产项目的网页登录密码');
  const response = await requestAuthenticatedJson(project, credentials, '/api/sync', {
    ...(request ? { request } : {}), deadline, signal, method: 'POST', body: {}, retryUnauthorized: true,
  });
  const data = response.data;
  if (!data || !Array.isArray(data.assets) || data.assets.length > 1000 || !Array.isArray(data.history)) throw new UpstreamError('invalid', '资产同步响应格式不正确');
  return { partial: data.dataKind === 'example' || data.assets.some(asset => !!asset?.error) || !!data.fxStatus?.error ||
    Object.values(data.connections || {}).some(connection => !!connection?.error) ||
    (Array.isArray(data.asterAccounts) && data.asterAccounts.some(account => !!account?.error)) };
}

const asTime = value => value == null ? null : new Date(value).toISOString();
const baseStatus = (state, message, nextAttemptAt = null) => ({
  state, message, startedAt: null, finishedAt: null, lastSuccessAt: null, nextAttemptAt,
});

export function createAssetSync({
  listTargets, onComplete = () => {}, intervalMs = 60000, timeoutMs = 60000,
  now = Date.now, syncReader = syncAsset, autoStart = true,
}) {
  if (typeof listTargets !== 'function') throw new TypeError('listTargets is required');
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
  const timeLimit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  const pending = new Map();
  const statuses = new Map();
  const lastStarts = new Map();
  let closed = false;
  let timer;
  const targets = () => new Map(listTargets().filter(target => target?.project?.id).map(target => [target.project.id, target]));
  const eligible = target => target?.project.adapter === 'asset' && target.project.enabled !== false &&
    target.project.autoSync !== false && !!target.project.apiUrl && !!target.credentials?.password;
  const current = (id, revision) => {
    if (closed) return false;
    const target = targets().get(id);
    return eligible(target) && target.revision === revision;
  };
  function reconcile(currentTargets) {
    for (const [id, job] of pending) {
      const target = currentTargets.get(id);
      if (!eligible(target) || target.revision !== job.revision) job.controller.abort();
    }
    for (const [id, stored] of statuses) {
      const target = currentTargets.get(id);
      if (!target || target.project.adapter !== 'asset' || target.revision !== stored.revision) statuses.delete(id);
    }
    for (const id of lastStarts.keys()) if (!currentTargets.has(id)) lastStarts.delete(id);
  }
  function getStatus(id) {
    const target = targets().get(id);
    if (!target || target.project.adapter !== 'asset') return null;
    if (target.project.enabled === false || target.project.autoSync === false) return baseStatus('disabled', '资产自动同步已关闭');
    if (!target.project.apiUrl) return baseStatus('unconfigured', '请先配置资产项目的接口地址');
    if (!target.credentials?.password) return baseStatus('unconfigured', '请先保存资产项目的网页登录密码');
    const stored = statuses.get(id);
    if (stored?.revision === target.revision) return { ...stored.status };
    return baseStatus('idle', '等待后台同步', lastStarts.has(id) ? asTime(lastStarts.get(id) + period) : null);
  }
  function start(target) {
    const id = target.project.id;
    if (pending.has(id)) return pending.get(id).promise;
    if (!eligible(target) || closed) return Promise.resolve(null);
    const started = now();
    if (lastStarts.has(id) && started - lastStarts.get(id) < period) return Promise.resolve(getStatus(id));
    lastStarts.set(id, started);
    const prior = statuses.get(id);
    const priorSuccess = prior?.revision === target.revision ? prior.status.lastSuccessAt : null;
    const status = { ...baseStatus('syncing', '正在后台同步资产', asTime(started + period)), startedAt: asTime(started), lastSuccessAt: priorSuccess };
    statuses.set(id, { revision: target.revision, status });
    const controller = new AbortController();
    const job = { controller, revision: target.revision, promise: null };
    pending.set(id, job);
    const project = { ...target.project };
    const credentials = { ...target.credentials };
    job.promise = (async () => {
      let timeout;
      let aborted;
      let result;
      let failure;
      try {
        const canceled = new Promise((_, reject) => {
          aborted = () => reject(new UpstreamError('timeout', '资产同步超时'));
          controller.signal.addEventListener('abort', aborted, { once: true });
        });
        timeout = setTimeout(() => controller.abort(), timeLimit);
        result = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted || closed) throw new UpstreamError('timeout', '资产同步已停止');
            return syncReader(project, credentials, { deadline: started + timeLimit, signal: controller.signal });
          }),
          canceled,
        ]);
      } catch (error) { failure = error; }
      finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', aborted); }
      try {
        if (!current(id, job.revision)) return null;
        let state = result?.partial ? 'partial' : 'success';
        let message = result?.partial ? '同步已完成，部分来源未更新，保留对应旧值' : '后台同步已完成，正在读取最新账本';
        if (failure) {
          state = failure.code === 'unauthorized' ? 'unauthorized' : 'error';
          message = state === 'unauthorized' ? '资产登录失效或来源配置不匹配，请检查项目设置' :
            failure.code === 'timeout' ? '资产同步超时，保留已有账本和源更新时间' : '资产同步未完成，保留已有账本，请检查原项目状态';
        }
        const finished = now();
        const completed = { ...status, state, message, finishedAt: asTime(finished), lastSuccessAt: state === 'success' ? asTime(finished) : priorSuccess };
        statuses.set(id, { revision: job.revision, status: completed });
        try { await onComplete(id, job.revision, { ...completed }); } catch { /* The source sync result does not depend on a subsequent read. */ }
        return { ...completed };
      } finally { if (pending.get(id) === job) pending.delete(id); }
    })();
    return job.promise;
  }
  async function refresh() {
    if (closed) return [];
    const currentTargets = targets();
    reconcile(currentTargets);
    return Promise.allSettled([...currentTargets.values()].filter(eligible).map(start));
  }
  async function run(id) {
    if (closed) return null;
    const currentTargets = targets();
    reconcile(currentTargets);
    const target = currentTargets.get(id);
    return target ? start(target) : null;
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const job of pending.values()) job.controller.abort();
    await Promise.allSettled([...pending.values()].map(job => job.promise));
  }
  if (autoStart && intervalMs > 0) {
    timer = setInterval(() => { void refresh().catch(() => {}); }, period);
    timer.unref?.();
    queueMicrotask(() => { if (!closed) void refresh().catch(() => {}); });
  }
  return { refresh, run, getStatus, close };
}
