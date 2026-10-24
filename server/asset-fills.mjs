import { createAssetSnapshot } from './asset-snapshot.mjs';

export const ASSET_FILLS_TIMEOUT_MS = 12_000;
export const ASSET_FILLS_CACHE_MS = 20_000;
// While Asset is still reading a scope, follow-ups must see its result within seconds.
export const ASSET_FILLS_PENDING_CACHE_MS = 3_000;
export const ASSET_FILLS_BACKGROUND_MS = 60_000;
// Only a market a page read within this window keeps being warmed; the Asset fill cache covers later reopens.
export const ASSET_FILLS_BACKGROUND_IDLE_MS = 6 * 60 * 60_000;
export const FILL_MARKETS = { oil: ['CL', 'BZ'], hynix: ['SKHY', 'SKHYNIX'] };
export const ASSET_FILLS_STALE_MS = 15 * 60_000;
// 5,000 fills with six 128-character decimal fields and bounded labels can
// exceed 2 MiB. Allow ~2 KiB per fill plus scope metadata, still with a hard cap.
export const ASSET_FILLS_RESPONSE_LIMIT = 12 * 1024 * 1024;
const STATES = new Set(['unconfigured', 'loading', 'live', 'stale', 'error', 'unsupported']);
const malformed = () => new Error('invalid_fills');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function label(value, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw malformed();
  return value;
}
function decimal(value, positive = false) {
  if (value === null && !positive) return null;
  if (typeof value !== 'string' || value.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(value)
    || positive && (value.startsWith('-') || !/[1-9]/.test(value))) throw malformed();
  return value;
}
function timestamp(value, now, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now + 60_000) throw malformed();
  const canonical = new Date(value).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) throw malformed();
  return canonical;
}
function unique(rows, maximum, map, fillIds = false) {
  if (!Array.isArray(rows) || rows.length > maximum) throw malformed();
  const seen = new Set();
  return rows.map(row => {
    if (!object(row)) throw malformed();
    if (fillIds) label(row.id, 200);
    else if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.id)) throw malformed();
    if (seen.has(row.id)) throw malformed();
    seen.add(row.id);
    return map(row);
  });
}

// Reject the whole source on a malformed row: dropping fills would silently
// change the event grouping and its opening/closing quantities.
export function normalizeAssetFills(data, now = Date.now(), market = 'oil') {
  const bases = FILL_MARKETS[market];
  if (!object(data) || data.schemaVersion !== 1) throw malformed();
  const generatedAt = timestamp(data.generatedAt, now, false), lookbackStart = timestamp(data.lookbackStart, now, false);
  if (lookbackStart > generatedAt) throw malformed();
  let count = 0;
  const exchanges = unique(data.exchanges, 40, exchange => ({
    id: exchange.id, name: label(exchange.name),
    accounts: unique(exchange.accounts, 100, account => {
      if (typeof account.configured !== 'boolean' || (account.configured
        ? typeof account.revision !== 'string' || !/^[a-f0-9]{64}$/.test(account.revision) : account.revision !== null)) throw malformed();
      if (typeof account.name !== 'string' || account.name.length > 160) throw malformed();
      return { id: account.id, name: label(account.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || '未命名账号'),
        configured: account.configured, revision: account.revision,
        scopes: unique(account.scopes, 24, scope => {
          if (!STATES.has(scope.status) || typeof scope.refreshing !== 'boolean' || typeof scope.truncated !== 'boolean'
            || !account.configured && scope.status !== 'unconfigured') throw malformed();
          const fetchedAt = timestamp(scope.fetchedAt, now), coverageStart = timestamp(scope.coverageStart, now), coverageEnd = timestamp(scope.coverageEnd, now);
          const empty = ['unconfigured', 'loading', 'unsupported'].includes(scope.status);
          const fullyTruncated = scope.truncated && Array.isArray(scope.fills) && scope.fills.length === 0 && coverageStart === null;
          if (empty && (fetchedAt !== null || coverageStart !== null || coverageEnd !== null || scope.truncated)
            || ['live', 'stale'].includes(scope.status) && (!fetchedAt || !coverageEnd || !coverageStart && !fullyTruncated)
            || !fullyTruncated && (coverageStart === null) !== (coverageEnd === null)
            || coverageStart && coverageEnd && coverageStart > coverageEnd) throw malformed();
          const fills = unique(scope.fills, 2000, row => {
            if (++count > 5000 || !bases.includes(row.base) || !['buy', 'sell'].includes(row.side)
              || !['long', 'short', 'net'].includes(row.positionSide) || !['USDT', 'USDC'].includes(row.priceCurrency)) throw malformed();
            const symbol = label(row.symbol);
            const symbols = exchange.id === 'okx' ? [`${row.base}-USDT-SWAP`]
              : exchange.id === 'binance' ? [`${row.base}USDT`]
                : exchange.id === 'bybit' ? [row.base + row.priceCurrency, ...(row.priceCurrency === 'USDC' ? [row.base + 'PERP'] : [])] : [];
            if (!symbols.includes(symbol) || exchange.id !== 'bybit' && row.priceCurrency !== 'USDT'
              || row.quantityUnit !== (exchange.id === 'okx' ? '张' : row.base)) throw malformed();
            const fill = { id: row.id, symbol, base: row.base, time: timestamp(row.time, now, false), side: row.side, positionSide: row.positionSide,
              quantity: decimal(row.quantity, true), quantityUnit: row.quantityUnit, price: decimal(row.price, true), priceCurrency: row.priceCurrency,
              fee: decimal(row.fee), feeCurrency: row.feeCurrency === null ? null : label(row.feeCurrency, 160),
              realizedPnl: decimal(row.realizedPnl), positionBefore: decimal(row.positionBefore), positionAfter: decimal(row.positionAfter) };
            if ((fill.positionBefore === null) !== (fill.positionAfter === null)) throw malformed();
            return fill;
          }, true).sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id));
          // A failed positions snapshot can still yield real fills with unknown
          // before/after values; fetchedAt then remains the last complete success.
          if (fills.length && (!coverageStart || !coverageEnd || empty)) throw malformed();
          const error = scope.status === 'unsupported' ? 'Asset 暂不支持此产品范围的成交读取'
            : scope.status === 'error' ? 'Asset 读取此范围失败，请在 Asset 检查连接与权限'
              : scope.status === 'stale' ? '成交数据已过期，等待 Asset 更新' : null;
          return { id: scope.id, label: label(scope.label), status: scope.status, refreshing: scope.refreshing, fetchedAt, coverageStart, coverageEnd,
            truncated: scope.truncated, error, fills };
        }),
      };
    }),
  }));
  return { schemaVersion: 1, generatedAt, lookbackStart, exchanges };
}

export function ageAssetFills(data, now = Date.now(), failed = false) {
  if (!data) return null;
  return { ...data, exchanges: data.exchanges.map(exchange => ({ ...exchange, accounts: exchange.accounts.map(account => ({ ...account,
    scopes: account.scopes.map(scope => scope.status === 'live' && (failed || now - Date.parse(scope.fetchedAt) > ASSET_FILLS_STALE_MS)
      ? { ...scope, status: 'stale', refreshing: false, error: failed ? 'Asset 来源暂不可用，保留上次成交' : '成交数据已过期，等待 Asset 更新' } : scope),
  })) })) };
}

export const fillsPending = data => data.exchanges.some(exchange => exchange.accounts.some(account => account.scopes.some(scope => scope.status === 'loading' || scope.refreshing)));

function sourceError(error, market) {
  if ([404, 405].includes(error?.statusCode)) return '此 Asset 尚不支持只读成交，请先更新 Asset';
  // Assets released before market queries reject the unknown parameter.
  if (market !== 'oil' && error?.statusCode === 400) return '此 Asset 尚不支持海力士成交，请先更新 Asset';
  if ([401, 403].includes(error?.statusCode)) return 'Asset 登录失败，请检查项目中保存的登录密码';
  if (error?.statusCode === 429) return 'Asset 暂时限流，请稍后重试';
  if (error?.code === 'insecure_transport') return 'Asset 连接需要 HTTPS 或本机回环地址';
  if (error?.code === 'timeout' || ['AbortError', 'TimeoutError'].includes(error?.name)) return '读取 Asset 成交超时，请稍后重试';
  if (error?.message === 'invalid_fills') return 'Asset 成交响应格式无效，请更新 Asset 后重试';
  return '暂时无法读取 Asset 成交，请检查项目连接';
}

export function createAssetFills({ market = 'oil', cacheMs = ASSET_FILLS_CACHE_MS, pendingCacheMs = ASSET_FILLS_PENDING_CACHE_MS, timeoutMs = ASSET_FILLS_TIMEOUT_MS, backgroundIdleMs = ASSET_FILLS_BACKGROUND_IDLE_MS, ...options } = {}) {
  if (!Object.hasOwn(FILL_MARKETS, market)) throw new Error('unknown_fills_market');
  // The shared reader invalidates on project/credential revision, removal or
  // shutdown. Authentication gets at most one retry, inside the same deadline.
  // Oil keeps the original path so an Asset without market queries still serves it.
  return createAssetSnapshot({ ...options, backgroundIdleMs, cacheMs, cacheMsFor: data => fillsPending(data) ? Math.min(cacheMs, pendingCacheMs) : cacheMs, timeoutMs,
    path: market === 'oil' ? '/api/hub/fills' : '/api/hub/fills?market=' + market, sessionScope: 'asset-fills',
    limit: ASSET_FILLS_RESPONSE_LIMIT, normalize: (data, now) => normalizeAssetFills(data, now, market), age: ageAssetFills, sourceError: error => sourceError(error, market) });
}
