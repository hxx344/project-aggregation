import { createAssetSnapshot } from './asset-snapshot.mjs';

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
const CYCLE_STATES = new Set(['loading', 'complete', 'partial', 'unavailable']);
const CYCLE_AMOUNTS = ['closedQuantity', 'closePrice', 'realizedPnl', 'fees', 'funding', 'net'];
/** Optional derived summary: a malformed one is dropped rather than hiding the positions it belongs to. */
function cycle(value, now) {
  try {
    if (!object(value) || !CYCLE_STATES.has(value.status)) throw malformed();
    const result = { status: value.status, since: timestamp(value.since, now) };
    for (const key of CYCLE_AMOUNTS) result[key] = decimal(value[key]);
    result.currency = value.currency === null ? null : label(value.currency, 20);
    result.note = value.note === null ? null : label(value.note, 300);
    result.updatedAt = timestamp(value.updatedAt, now);
    return result;
  } catch { return null; }
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
            if (row.cycle !== undefined) position.cycle = cycle(row.cycle, now);
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

export const ASSET_POSITIONS_TIMEOUT_MS = 12000;

export function createAssetPositions({ cacheMs = 5000, timeoutMs = ASSET_POSITIONS_TIMEOUT_MS, ...options } = {}) {
  return createAssetSnapshot({ ...options, cacheMs, timeoutMs,
    path: PATH, sessionScope: 'asset-positions', limit: 2 * 1024 * 1024,
    normalize: normalizeAssetPositions, age: ageAssetPositions, sourceError,
  });
}
