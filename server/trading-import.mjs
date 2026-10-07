import { requestAuthenticatedJson, requestJson } from './adapters.mjs';
import { TradingError, accountModeOf } from './trading.mjs';

const EXCHANGES = ['binance', 'bybit'];
const CATALOG = '/api/hub/trading-connections';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const changed = () => new TradingError(409, 'Asset 来源连接或项目配置已变更，请刷新来源后重试');
const malformed = () => new TradingError(400, 'Asset 返回的连接信息无效，请更新 Asset 后重试');
function sourceError(error) {
  if (error instanceof TradingError) return error;
  if (error?.code === 'insecure_transport') return new TradingError(400, '从 Asset 导入需要 HTTPS 或本机回环地址（如 127.0.0.1）');
  if ([404, 405].includes(error?.statusCode)) return new TradingError(400, '此 Asset 尚不支持交易连接导入，请先更新 Asset');
  if (error?.statusCode === 409) return changed();
  if (error?.statusCode === 429) return new TradingError(429, 'Asset 登录或导出暂时限流，请稍后重试');
  if ([401, 403].includes(error?.statusCode)) return new TradingError(400, 'Asset 登录或导出验证失败，请检查项目中保存的 Asset 登录密码');
  if (error?.code === 'timeout' || ['AbortError', 'TimeoutError'].includes(error?.name)) return new TradingError(504, '读取 Asset 超时或已取消，请稍后重试');
  return new TradingError(400, '无法读取 Asset 连接，请检查服务地址和连接状态');
}
function catalogOf(data) {
  if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.connections) || data.connections.length !== 2) throw malformed();
  return EXCHANGES.map(exchange => {
    const rows = data.connections.filter(row => row?.exchange === exchange);
    if (rows.length !== 1) throw malformed();
    const row = rows[0];
    if (typeof row.configured !== 'boolean' || typeof row.supported !== 'boolean'
      || row.configured && (!row.supported || !hex(row.revision))
      || !row.configured && row.revision !== null
      || !(row.label === null || typeof row.label === 'string' && /^[A-Za-z0-9_-]{4}$/.test(row.label))
      || !(row.updatedAt === null || typeof row.updatedAt === 'string' && row.updatedAt.length <= 40 && Number.isFinite(Date.parse(row.updatedAt)))) throw malformed();
    // Never forward arbitrary provider diagnostics or other upstream fields to the browser.
    return { exchange, configured: row.configured, supported: row.supported, revision: row.revision,
      label: row.label, updatedAt: row.updatedAt,
      reason: row.supported ? (row.configured ? null : 'Asset 尚未配置此交易所连接') : '此连接不可导入；仅支持全球站的 Binance、Bybit HMAC API' };
  });
}

/** One-time, server-to-server copies; callers can select configured project IDs only. */
export function createTradingImporter({ listTargets, trading, request = requestJson, sourceTimeoutMs = 12000, importTimeoutMs = 60000 } = {}) {
  let closed = false, listing = null;
  const controllers = new Set();
  const secureRequest = (base, path, options) => request(base, path, { ...options, requireSecureTransport: true, limit: 32768 });
  const targets = () => {
    if (closed) throw new TradingError(503, '交易导入正在关闭');
    return listTargets().filter(row => row.project.enabled && row.project.adapter === 'asset');
  };
  function current(id, revision) {
    const target = targets().find(row => row.project.id === id);
    if (!target || target.revision !== revision) throw changed();
    if (!target.project.apiUrl || !target.credentials?.password) throw new TradingError(400, '请先在 Asset 项目设置中保存服务地址和登录密码');
    return target;
  }
  async function read(target, path, signal, { method = 'GET', body, deadline = Date.now() + sourceTimeoutMs } = {}) {
    signal.throwIfAborted();
    try {
      const result = await requestAuthenticatedJson(target.project, target.credentials, path, {
        request: secureRequest, deadline, signal, method, body, retryUnauthorized: true, sessionScope: 'trading-import',
      });
      signal.throwIfAborted();
      current(target.project.id, target.revision);
      return result.data;
    } catch (error) { throw sourceError(error); }
  }
  async function sources() {
    if (listing) return listing;
    const selected = targets(), controller = new AbortController(); controllers.add(controller);
    const deadline = Date.now() + sourceTimeoutMs;
    const timer = setTimeout(() => controller.abort(new DOMException('Source read timed out', 'TimeoutError')), sourceTimeoutMs); timer.unref?.();
    listing = (async () => {
      const sources = new Array(selected.length); let index = 0;
      const worker = async () => {
        while (index < selected.length) {
          const position = index++, target = selected[position], project = target.project;
          const base = { projectId: project.id, name: project.name, projectRevision: target.revision };
          if (!project.apiUrl || !target.credentials?.password) { sources[position] = { ...base, status: 'unconfigured', error: '请在项目设置中保存 Asset 服务地址和登录密码', connections: [] }; continue; }
          try { sources[position] = { ...base, status: 'ready', error: null, connections: catalogOf(await read(target, CATALOG, controller.signal, { deadline })) }; }
          catch (error) { sources[position] = { ...base, status: 'unavailable', error: sourceError(error).message, connections: [] }; }
        }
      };
      await Promise.all([worker(), worker()]);
      return { sources };
    })().finally(() => { clearTimeout(timer); controllers.delete(controller); listing = null; });
    return listing;
  }
  async function importAccount(exchange, body) {
    if (!EXCHANGES.includes(exchange)) throw new TradingError(404, '交易所不存在');
    if (!object(body) || Object.keys(body).some(key => !['revision', 'projectId', 'projectRevision', 'sourceRevision', 'accountMode'].includes(key))
      || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.projectId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.projectId) || !hex(body.projectRevision) || !hex(body.sourceRevision)) throw new TradingError(400, '导入参数无效，请刷新来源后重试');
    const accountMode = accountModeOf(exchange, body.accountMode);
    const target = current(body.projectId, body.projectRevision), controller = new AbortController(); controllers.add(controller);
    try {
      await trading.connect(exchange, { revision: body.revision, accountMode }, {
        signal: controller.signal, timeoutMs: importTimeoutMs,
        credentialReader: async signal => {
          const rows = catalogOf(await read(target, CATALOG, signal));
          const row = rows.find(item => item.exchange === exchange);
          if (!row.configured || !row.supported || row.revision !== body.sourceRevision) throw changed();
          const data = await read(target, CATALOG + '/export', signal, { method: 'POST', body: { exchange, revision: row.revision, password: target.credentials.password } });
          if (!object(data) || data.schemaVersion !== 1 || data.exchange !== exchange || data.revision !== row.revision || data.region !== 'global' || !object(data.credentials)) throw malformed();
          return { apiKey: data.credentials.apiKey, apiSecret: data.credentials.apiSecret };
        },
        beforeSave: () => { current(body.projectId, body.projectRevision); },
      });
    } finally { controllers.delete(controller); }
  }
  return { sources, importAccount,
    async close() { closed = true; for (const controller of controllers) controller.abort(); await listing; },
  };
}
