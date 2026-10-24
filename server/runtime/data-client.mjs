import { MAX_BODY_BYTES } from '../http-common.mjs';
import { createRuntimeConnection } from './connection.mjs';
import { BUDGETS, RuntimeError, runtimeErrorFrom, SUPPORTED_PROTOCOLS, unavailable } from './protocol.mjs';
import { invokeOverSocket, writeResult } from './supervisor-client.mjs';

// The DataPlaneClient contract: the calls the API makes into the data plane
// (design doc 5.2). Both implementations validate arguments locally and every
// result with the same functions; the runtime's internal server validates the
// arguments again.
export const FORWARD_PREFIX = '/internal/v1/forward';
export const SESSION_HEADER = 'x-workspace-session';
export const DEADLINE_HEADER = 'x-workspace-deadline';
// A HEAD reply carries no body, so a forwarded HEAD travels as GET with this header.
export const METHOD_HEADER = 'x-workspace-method';
// Budgets of design doc 5.2: a forwarded request keeps the browser request's
// remaining time, at most the API's 60 s request timeout.
export const FORWARD_BUDGET = 60_000, ASSET_SYNC_BUDGET = 60_000;
// Business replies such as fill histories may be larger than internal JSON.
export const MAX_FORWARD_REPLY_BYTES = 16 * 1024 * 1024;
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
const reads = new Set(['GET', 'HEAD']);
// A write that may have reached the data plane: the browser must check before trying again.
export const unconfirmed = () => new RuntimeError(503, '结果未确认，请刷新后核对', { origin: 'transport', uncertain: true });
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
    async projectChanged(id, change) { validateProjectId(id); const value = validateChange(change); return writeResult(invoke('projectChanged', { id, ...value }), validateAccepted); },
    async coordinateAssetSync(id, revision) { validateProjectId(id); validateRevision(revision); return writeResult(invoke('coordinateAssetSync', { id, revision }), validateSyncStatus); },
    async forward(request) {
      const value = validateForward(request);
      if (reads.has(value.method)) return validateReply(await invoke('forward', value));
      try { return await writeResult(invoke('forward', value), validateReply); }
      catch (error) { throw error instanceof RuntimeError && error.origin === 'transport' && error.uncertain ? unconfirmed() : error; }
    },
    // Transitional: P1-4 reports the API's SSE counts, slow consumers included, as one record.
    async observeSlowConsumer() { return writeResult(invoke('observeSlowConsumer'), validateAccepted); },
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

// Reads up to one byte past the body limit, so the data plane still answers 413
// for a larger body; the browser's stream is iterated by hand because leaving a
// for-await early would destroy it and its socket.
async function bufferBody(body) {
  const chunks = body[Symbol.asyncIterator]?.() ?? body[Symbol.iterator]();
  const parts = []; let size = 0;
  while (size <= MAX_BODY_BYTES) {
    const { value, done } = await chunks.next();
    if (done) break;
    const chunk = Buffer.from(value); parts.push(chunk); size += chunk.length;
  }
  return Buffer.concat(parts).subarray(0, MAX_BODY_BYTES + 1);
}

// Overview events reconnect with 1 to 30 s backoff; the runtime pushes at
// least every 15 s, so a stream silent for 45 s is treated as broken.
export const EVENTS_IDLE_MS = 45_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];

// Talks to the runtime's internal server over its private socket; pass the
// supervisor client's `connection` so both share one discovery record.
export function createSocketDataClient({ dir, protocols = SUPPORTED_PROTOCOLS, connection = createRuntimeConnection({ dir, protocols }), budgets: overrides = {}, idleMs = EVENTS_IDLE_MS, backoffMs = BACKOFF_MS, log }) {
  if (!(idleMs > 0 && idleMs <= 2 ** 31 - 1)) throw new TypeError('Data-plane client needs idleMs between 1 and 2^31-1');
  const budgets = { read: BUDGETS.read, assetSync: ASSET_SYNC_BUDGET, forward: FORWARD_BUDGET, ...overrides };
  const call = (route, { method = 'POST', body, budget = budgets.read, retry = false } = {}) => invokeOverSocket(connection, { method, route, body, budget, retry });
  const operations = {
    overview: () => call('/internal/v1/overview', { method: 'GET', retry: true }),
    projectChanged: ({ id, reason, clearSnapshot }) => call(`/internal/v1/projects/${id}/changed`, { body: { reason, clearSnapshot } }),
    coordinateAssetSync: async ({ id, revision }) => {
      const value = await call(`/internal/v1/projects/${id}/asset-sync`, { body: { revision }, budget: budgets.assetSync });
      if (!object(value) || !('status' in value)) throw unavailable(true);
      return value.status;
    },
    observeSlowConsumer: () => call('/internal/v1/overview/slow-consumers', { body: {} }),
    forward: async request => {
      const deadline = Math.min(request.deadline ?? Infinity, Date.now() + budgets.forward);
      const content = await bufferBody(request.body);
      let target = null;
      try {
        target = await connection.resolve(deadline);
        const head = request.method === 'HEAD';
        const reply = await connection.exchange(target, { method: head ? 'GET' : request.method, route: FORWARD_PREFIX + request.target, deadline, body: content.length ? content : null, maxBytes: MAX_FORWARD_REPLY_BYTES,
          headers: { [SESSION_HEADER]: request.sessionId, [DEADLINE_HEADER]: String(deadline), ...(head ? { [METHOD_HEADER]: 'HEAD' } : {}), ...(request.contentType !== undefined ? { 'Content-Type': request.contentType } : {}) } });
        if (reply.status === 401) throw unavailable();
        if (reply.status !== 200) throw runtimeErrorFrom(reply.status, reply.body);
        return reply.body;
      } catch (error) {
        if (error instanceof RuntimeError && error.origin === 'transport') connection.invalidate(target);
        throw error;
      }
    },
  };
  // One upstream stream per subscriber, kept open until the subscription ends.
  function subscribe(subscriber) {
    let stopped = false, current = null, timer = null, failures = 0;
    const retry = () => {
      if (stopped) return;
      const delay = backoffMs[Math.min(failures, backoffMs.length - 1)]; failures += 1;
      timer = setTimeout(open, delay); timer.unref?.();
    };
    async function open() {
      timer = null;
      let target;
      try { target = await connection.resolve(Date.now() + budgets.read); }
      catch { retry(); return; }
      if (stopped) return;
      // The backoff resets only once an event was delivered; an event the API
      // refuses keeps backing off and does not drop the shared record.
      let refused = false;
      current = connection.stream(target, { route: '/internal/v1/overview/events', idleMs,
        onLine: event => {
          try { subscriber.deliver(event); } catch (error) { refused = true; throw error; }
          failures = 0;
        },
        onClose: error => {
          current = null;
          if (stopped) return;
          if (refused) log?.warn({ err: error, type: 'overview' }, '概览推送处理失败');
          else connection.invalidate(target);
          retry();
        } });
    }
    void open();
    return () => { stopped = true; clearTimeout(timer); current?.close(); };
  }
  return contract(async (name, argument) => operations[name](argument), subscribe);
}
