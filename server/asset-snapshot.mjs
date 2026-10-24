import { requestAuthenticatedJson, requestJson } from './adapters.mjs';

/** Only configured Asset projects are addressable; exchange credentials stay in Asset. */
export function createAssetSnapshot({ listTargets, request = requestJson, now = Date.now, cacheMs, cacheMsFor = () => cacheMs, timeoutMs, backgroundIntervalMs = 0, backgroundIdleMs = Infinity, path, sessionScope, limit, normalize, age, sourceError } = {}) {
  const entries = new Map();
  let closed = false, timer, background = null, foregroundAt = null;
  const targets = () => listTargets().filter(target => target.project.enabled && target.project.adapter === 'asset');
  const usable = target => !!target.project.apiUrl && (!!target.project.embedded || !!target.credentials?.password);
  const present = target => !closed && targets().some(current => current.project.id === target.project.id && current.revision === target.revision && usable(current));
  const secureRequest = (base, path, options) => request(base, path, { ...options, requireSecureTransport: true, limit });
  function invalidate(id) {
    const entry = entries.get(id);
    if (entry) { entry.controller?.abort(); entries.delete(id); }
  }
  function reconcile() {
    const selected = targets();
    for (const [id, entry] of entries) if (!selected.some(target => target.project.id === id && target.revision === entry.revision && usable(target))) invalidate(id);
    return selected;
  }
  function view(target, entry) {
    const failed = !!entry?.error;
    return { projectId: target.project.id, name: target.project.name,
      status: !usable(target) ? 'unconfigured' : failed ? entry.data ? 'stale' : 'unavailable' : entry?.data ? 'ready' : 'unavailable',
      error: !usable(target) ? '请在项目管理中保存 Asset 服务地址和登录密码' : entry?.error ?? (entry?.data ? null : 'Asset 来源已更改，请重新读取'),
      checkedAt: entry?.checkedAt ?? null, data: age(entry?.data ?? null, now(), failed),
    };
  }
  async function read(target) {
    if (!usable(target) || closed) return;
    const id = target.project.id;
    let entry = entries.get(id);
    if (entry && entry.revision !== target.revision) { invalidate(id); entry = null; }
    if (!entry) { entry = { revision: target.revision, data: null, error: null, checkedAt: null, readAt: null, cacheMs, pending: null, controller: null }; entries.set(id, entry); }
    if (entry.pending) return entry.pending;
    if (entry.readAt !== null && now() - entry.readAt < entry.cacheMs) return;
    const controller = new AbortController(); entry.controller = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Asset read timed out', 'TimeoutError')), timeoutMs); timer.unref?.();
    entry.pending = (async () => {
      try {
        const response = await requestAuthenticatedJson(target.project, target.credentials, path, {
          request: secureRequest, deadline: Date.now() + timeoutMs, signal: controller.signal, retryUnauthorized: true, sessionScope,
        });
        controller.signal.throwIfAborted();
        const data = normalize(response.data, now());
        if (present(target) && entries.get(id) === entry) { entry.data = data; entry.error = null; entry.cacheMs = cacheMsFor(data); }
      } catch (error) {
        if (present(target) && entries.get(id) === entry) { entry.error = sourceError(error); entry.cacheMs = cacheMs; }
      } finally {
        clearTimeout(timer);
        entry.checkedAt = new Date(now()).toISOString(); entry.readAt = now(); entry.pending = null; entry.controller = null;
      }
    })();
    return entry.pending;
  }
  async function state() {
    if (closed) return { generatedAt: new Date(now()).toISOString(), sources: [] };
    // The project store caps this list at 30. Asset serves cached snapshots, so
    // independent sources can be read together within one request deadline.
    await Promise.all(reconcile().map(read));
    if (closed) return { generatedAt: new Date(now()).toISOString(), sources: [] };
    // A removed or edited project must never survive a request that started before the edit.
    const current = reconcile();
    return { generatedAt: new Date(now()).toISOString(), sources: current.map(target => view(target, entries.get(target.project.id))) };
  }
  // Background reads stop once no page has asked for backgroundIdleMs, so unused sources stop polling exchanges.
  const recentlyRead = () => backgroundIdleMs === Infinity || foregroundAt !== null && now() - foregroundAt < backgroundIdleMs;
  if (backgroundIntervalMs > 0) {
    // Without an open page Asset only refreshes when read; this keeps its per-scope snapshots warm.
    timer = setInterval(() => { if (recentlyRead()) background ??= state().catch(() => {}).finally(() => { background = null; }); }, backgroundIntervalMs);
    timer.unref?.();
  }
  return { state: () => { foregroundAt = now(); return state(); }, invalidate, async close() {
    closed = true; clearInterval(timer);
    const pending = [...entries.values()].map(entry => entry.pending);
    for (const id of entries.keys()) invalidate(id);
    await Promise.allSettled([...pending, background]);
  } };
}
