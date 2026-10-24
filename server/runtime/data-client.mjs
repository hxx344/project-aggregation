import { RuntimeError, unavailable } from './protocol.mjs';

// The DataPlaneClient contract: the calls the API makes into the data plane
// (design doc 5.2). Both implementations validate arguments locally and every
// result with the same functions; P1-3 adds the socket one.
const REASONS = new Set(['created', 'updated', 'deleted', 'preferences']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateProjectId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new RuntimeError(400, '项目标识无效');
  return id;
}
export function validateChange(change) {
  if (!object(change) || !REASONS.has(change.reason) || change.clearSnapshot !== undefined && typeof change.clearSnapshot !== 'boolean'
    || change.clearSnapshot && change.reason !== 'updated') throw new RuntimeError(400, '项目变更通知无效');
  return { reason: change.reason, clearSnapshot: change.clearSnapshot === true };
}
export function validateRevision(revision) {
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) throw new RuntimeError(400, '项目版本无效');
  return revision;
}
// `target` is the normalized path and query; `deadline` is the browser request's remaining budget, if any.
export function validateForward(request) {
  if (!object(request) || typeof request.method !== 'string' || !/^[A-Z][A-Z-]{0,15}$/.test(request.method) || typeof request.target !== 'string' || !request.target.startsWith('/api/')
    || typeof request.sessionId !== 'string' || !request.sessionId || request.contentType !== undefined && typeof request.contentType !== 'string'
    || request.deadline !== undefined && !Number.isSafeInteger(request.deadline)
    || typeof (request.body?.[Symbol.asyncIterator] ?? request.body?.[Symbol.iterator]) !== 'function') throw new RuntimeError(400, '转发请求无效');
  return { method: request.method, target: request.target, sessionId: request.sessionId, contentType: request.contentType, deadline: request.deadline, body: request.body };
}
export function validateOverview(value) {
  if (!object(value) || !Array.isArray(value.projects) || typeof value.generatedAt !== 'string') throw unavailable();
  return value;
}
export function validateOverviewEvent(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw unavailable();
  return { revision: value.revision, overview: validateOverview(value.overview) };
}
export function validateReply(value) {
  if (!object(value) || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || !object(value.body)) throw unavailable();
  return { status: value.status, body: value.body };
}
const validateSyncStatus = value => { if (value !== null && !object(value)) throw unavailable(); return value; };
const validateAccepted = value => { if (!object(value) || value.accepted !== true) throw unavailable(); return { accepted: true }; };

// `invoke(name, argument)` performs one call; `subscribe(subscriber)` registers
// for overview events and returns the function that ends the subscription.
function contract(invoke, subscribe) {
  return {
    async overview() { return validateOverview(await invoke('overview')); },
    // `subscriber.wants()` reports whether anyone listens; deliver() receives { revision, overview }.
    subscribeOverview(subscriber) {
      if (typeof subscriber?.wants !== 'function' || typeof subscriber.deliver !== 'function') throw new TypeError('Overview subscriber needs wants() and deliver()');
      return subscribe({ wants: () => subscriber.wants(), deliver: event => subscriber.deliver(validateOverviewEvent(event)) });
    },
    async projectChanged(id, change) { validateProjectId(id); const value = validateChange(change); return validateAccepted(await invoke('projectChanged', { id, ...value })); },
    async coordinateAssetSync(id, revision) { validateProjectId(id); validateRevision(revision); return validateSyncStatus(await invoke('coordinateAssetSync', { id, revision })); },
    async forward(request) { return validateReply(await invoke('forward', validateForward(request))); },
    // Transitional: P1-4 reports the API's SSE counts, slow consumers included, as one record.
    async observeSlowConsumer() { return validateAccepted(await invoke('observeSlowConsumer')); },
  };
}

// Used by createApp, where API and data plane share one process. Forwarded
// bodies stay streams, so a route reads only what it needs, as before.
export function createInProcessDataClient(dataPlane, { log }) {
  const operations = {
    overview: () => dataPlane.overview(),
    projectChanged: ({ id, reason, clearSnapshot }) => { dataPlane.projectChanged(id, { reason, clearSnapshot }); return { accepted: true }; },
    coordinateAssetSync: ({ id, revision }) => dataPlane.coordinateAssetSync(id, revision),
    forward: request => dataPlane.handle(request),
    observeSlowConsumer: () => { dataPlane.observeSlowConsumer(); return { accepted: true }; },
  };
  return contract(async (name, argument) => {
    try { return await operations[name](argument); }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      // The caller only sees the generic message; the cause stays in this log.
      log.error({ err: error, operation: name, type: 'runtime' }, '数据面调用失败');
      throw new RuntimeError(503, '运行时内部错误');
    }
  }, subscriber => dataPlane.subscribeOverview(subscriber));
}
