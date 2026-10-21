import { requestAuthenticatedJson, requestJson } from './adapters.mjs';

const PATH = '/api/hub/positions';
const STATES = new Set(['unconfigured', 'loading', 'live', 'stale', 'error', 'unsupported']);
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = () => new Error('invalid_positions');
function label(value, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw malformed();
  return value;
}
function accountName(value) {
  if (typeof value !== 'string' || value.length > 160) throw malformed();
  return label(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || '未命名账号');
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) throw malformed(); return value; }
function decimal(value, { positive = false } = {}) {
  if (value === null && !positive) return null;
  if (typeof value !== 'string' || value.length > 128 || !DECIMAL.test(value) || positive && (value.startsWith('-') || !/[1-9]/.test(value))) throw malformed();
  return value;
}
function timestamp(value, now, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || value.length > 40 || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now + 60_000) throw malformed();
  return new Date(value).toISOString();
}
function unique(rows, maximum, key, map) {
  if (!Array.isArray(rows) || rows.length > maximum) throw malformed();
  const seen = new Set();
  return rows.map(row => {
    if (!object(row)) throw malformed();
    const identity = identifier(row[key]);
    if (seen.has(identity)) throw malformed();
    seen.add(identity);
    return map(row);
  });
}

/** Construct an allowlisted public response; never relay provider objects or errors. */
export function normalizeAssetPositions(data, now = Date.now()) {
  if (!object(data) || data.schemaVersion !== 1) throw malformed();
  let count = 0;
  const generatedAt = timestamp(data.generatedAt, now, false);
  const exchanges = unique(data.exchanges, 40, 'id', exchange => ({
    id: exchange.id, name: label(exchange.name),
    accounts: unique(exchange.accounts, 100, 'id', account => {
      if (typeof account.configured !== 'boolean' || !(account.revision === null || typeof account.revision === 'string' && /^[a-f0-9]{64}$/.test(account.revision))
          || account.configured && account.revision === null || !account.configured && account.revision !== null) throw malformed();
      return { id: account.id, name: accountName(account.name), configured: account.configured, revision: account.revision,
        scopes: unique(account.scopes, 24, 'id', scope => {
          if (!STATES.has(scope.status) || typeof scope.refreshing !== 'boolean') throw malformed();
          const fetchedAt = timestamp(scope.fetchedAt, now);
          if (scope.status === 'live' && !fetchedAt) throw malformed();
          if (!account.configured && scope.status !== 'unconfigured') throw malformed();
          const positions = unique(scope.positions, 10000, 'id', row => {
            if (++count > 10000 || !['long', 'short'].includes(row.side)) throw malformed();
            const position = { id: row.id, symbol: label(row.symbol), instrumentId: label(row.instrumentId), side: row.side,
              quantity: decimal(row.quantity, { positive: true }), quantityUnit: label(row.quantityUnit, 200) };
            for (const key of ['contractSize', 'entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'leverage', 'liquidationPrice']) position[key] = decimal(row[key]);
            for (const key of ['priceCurrency', 'notionalCurrency', 'pnlCurrency', 'marginMode']) position[key] = row[key] === null ? null : label(row[key], 160);
            position.sourceUpdatedAt = timestamp(row.sourceUpdatedAt, now);
            return position;
          });
          if (positions.length && (!fetchedAt || ['unconfigured', 'loading', 'unsupported'].includes(scope.status))) throw malformed();
          if (['unconfigured', 'loading', 'unsupported'].includes(scope.status) && fetchedAt !== null) throw malformed();
          // Source labels explain product coverage; upstream errors are intentionally not echoed.
          const error = scope.status === 'unsupported' ? 'Asset 暂不支持此产品范围的仓位读取'
            : scope.status === 'error' ? 'Asset 读取此范围失败，请在 Asset 检查连接与权限'
              : scope.status === 'stale' ? '仓位数据已过期，等待 Asset 更新' : null;
          return { id: scope.id, label: label(scope.label), status: scope.status, refreshing: scope.refreshing, fetchedAt, error, positions };
        }),
      };
    }),
  }));
  return { schemaVersion: 1, generatedAt, exchanges };
}

export function ageAssetPositions(data, now = Date.now(), failed = false) {
  if (!data) return null;
  return { ...data, exchanges: data.exchanges.map(exchange => ({ ...exchange, accounts: exchange.accounts.map(account => ({ ...account,
    scopes: account.scopes.map(scope => {
      const old = scope.fetchedAt !== null && now - Date.parse(scope.fetchedAt) > 90_000;
      return scope.status === 'live' && (failed || old) ? { ...scope, status: 'stale', refreshing: false,
        error: failed ? 'Asset 来源暂不可用，保留上次仓位' : '仓位数据已过期，等待 Asset 更新' } : scope;
    }),
  })) })) };
}

function sourceError(error) {
  if ([404, 405].includes(error?.statusCode)) return '此 Asset 尚不支持只读仓位，请先更新 Asset';
  if ([401, 403].includes(error?.statusCode)) return 'Asset 登录失败，请检查项目中保存的登录密码';
  if (error?.statusCode === 429) return 'Asset 暂时限流，请稍后重试';
  if (error?.code === 'insecure_transport') return 'Asset 连接需要 HTTPS 或本机回环地址';
  if (error?.code === 'timeout' || ['AbortError', 'TimeoutError'].includes(error?.name)) return '读取 Asset 仓位超时，请稍后重试';
  if (error?.message === 'invalid_positions') return 'Asset 仓位响应格式无效，请更新 Asset 后重试';
  return '暂时无法读取 Asset 仓位，请检查项目连接';
}

/** Only configured Asset projects are addressable; exchange credentials stay in Asset. */
export function createAssetPositions({ listTargets, request = requestJson, now = Date.now, cacheMs = 5000, timeoutMs = 12000, backgroundIntervalMs = 0 } = {}) {
  const entries = new Map();
  let closed = false, timer, background = null;
  const targets = () => listTargets().filter(target => target.project.enabled && target.project.adapter === 'asset');
  const usable = target => !!target.project.apiUrl && (!!target.project.embedded || !!target.credentials?.password);
  const present = target => !closed && targets().some(current => current.project.id === target.project.id && current.revision === target.revision && usable(current));
  const secureRequest = (base, path, options) => request(base, path, { ...options, requireSecureTransport: true, limit: 2 * 1024 * 1024 });
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
      checkedAt: entry?.checkedAt ?? null, data: ageAssetPositions(entry?.data ?? null, now(), failed),
    };
  }
  async function read(target) {
    if (!usable(target) || closed) return;
    const id = target.project.id;
    let entry = entries.get(id);
    if (entry && entry.revision !== target.revision) { invalidate(id); entry = null; }
    if (!entry) { entry = { revision: target.revision, data: null, error: null, checkedAt: null, readAt: null, pending: null, controller: null }; entries.set(id, entry); }
    if (entry.pending) return entry.pending;
    if (entry.readAt !== null && now() - entry.readAt < cacheMs) return;
    const controller = new AbortController(); entry.controller = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Asset read timed out', 'TimeoutError')), timeoutMs); timer.unref?.();
    entry.pending = (async () => {
      try {
        const response = await requestAuthenticatedJson(target.project, target.credentials, PATH, {
          request: secureRequest, deadline: Date.now() + timeoutMs, signal: controller.signal, retryUnauthorized: true, sessionScope: 'asset-positions',
        });
        controller.signal.throwIfAborted();
        const data = normalizeAssetPositions(response.data, now());
        if (present(target) && entries.get(id) === entry) { entry.data = data; entry.error = null; }
      } catch (error) {
        if (present(target) && entries.get(id) === entry) entry.error = sourceError(error);
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
  if (backgroundIntervalMs > 0) {
    // Without an open page Asset only refreshes when read; this keeps its per-scope snapshots warm.
    timer = setInterval(() => { background ??= state().catch(() => {}).finally(() => { background = null; }); }, backgroundIntervalMs);
    timer.unref?.();
  }
  return { state, invalidate, async close() {
    closed = true; clearInterval(timer);
    const pending = [...entries.values()].map(entry => entry.pending);
    for (const id of entries.keys()) invalidate(id);
    await Promise.allSettled([...pending, background]);
  } };
}
