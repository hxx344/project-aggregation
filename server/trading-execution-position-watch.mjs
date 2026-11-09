import { createHash } from 'node:crypto';
import { decimal, compareDecimals } from './trading-decimal.mjs';
import { EXECUTION_MARKETS, EXECUTION_VENUE_SYMBOLS, TRADING_NAMES } from './trading-markets.mjs';

const EXCHANGES = Object.freeze(['binance', 'okx', 'hyperliquid', 'rh-lighter']);
const MODES = { binance: ['standard', 'portfolio-margin'], okx: ['cross', 'isolated'], hyperliquid: ['agent'], 'rh-lighter': ['api-key'] };
const MAX_POSITIONS = 2000;
const timeOf = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optional = (value, options) => value === null || value === undefined ? null : decimal(value, options);

function connection(exchange, value) {
  const connected = value?.connected === true;
  const revision = Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : null;
  const identity = typeof value?.identity === 'string' && value.identity.length > 0 && value.identity.length <= 256 ? value.identity : null;
  const accountMode = MODES[exchange].includes(value?.accountMode) ? value.accountMode : null;
  const accountIndex = exchange === 'rh-lighter' && Number.isSafeInteger(value?.accountIndex) && value.accountIndex > 0 ? value.accountIndex : null;
  const binding = { revision, identity, accountMode, accountIndex };
  const key = createHash('sha256').update(JSON.stringify(['execution-position-v1', exchange, connected, binding])).digest('hex');
  const error = connected && (revision === null || !identity || !accountMode || exchange === 'rh-lighter' && accountIndex === null)
    ? '执行账户连接待核验，暂时无法读取仓位' : null;
  return { exchange, connected, binding, key, error };
}

function snapshotRows(exchange, binding, snapshot, current) {
  if (!object(snapshot) || snapshot.identity !== binding.identity || exchange === 'rh-lighter' && snapshot.accountIndex !== binding.accountIndex) throw Object.assign(new Error('invalid_snapshot_identity'), { code: 'position_identity' });
  const fetched = timeOf(snapshot.fetchedAt);
  if (fetched === null || fetched > current + 1000 || !Array.isArray(snapshot.positions) || snapshot.positions.length > MAX_POSITIONS) throw Object.assign(new Error('invalid_snapshot'), { code: 'invalid_data' });
  const rows = [], seen = new Set();
  for (const row of snapshot.positions) {
    if (!object(row) || typeof row.symbol !== 'string') throw new Error('invalid_position');
    if (!EXECUTION_MARKETS.anthropic.symbols.includes(row.symbol) || !EXECUTION_VENUE_SYMBOLS[exchange].includes(row.symbol)) continue;
    if (!['long', 'short'].includes(row.side) || row.marginMode != null && !['cross', 'isolated'].includes(row.marginMode)) throw new Error('invalid_position');
    const quantity = decimal(row.quantity, { nonnegative: true });
    if (quantity === '0') continue;
    const marginMode = row.marginMode ?? null;
    const liquidationPrice = optional(row.liquidationPrice, { nonnegative: true });
    const liquidationKnown = row.liquidationKnown === true || row.liquidationKnown === undefined && liquidationPrice !== null && compareDecimals(liquidationPrice, '0') > 0;
    const id = `${exchange}:${row.symbol}:${row.side}:${marginMode ?? 'unknown'}:${binding.accountIndex ?? 'main'}`;
    if (seen.has(id)) throw new Error('duplicate_position');
    seen.add(id);
    // Whitelist display fields; the account proof belongs only to the source.
    rows.push({ id, exchange, symbol: row.symbol, side: row.side, quantity,
      ...(exchange === 'rh-lighter' ? { account: binding.accountIndex } : {}),
      quantityUnit: ['张', 'ANTHROPIC', 'ANT', 'ANTH'].includes(row.quantityUnit) ? row.quantityUnit : null,
      ...(row.contractSize === undefined ? {} : { contractSize: optional(row.contractSize, { positive: true }) }),
      entryPrice: optional(row.entryPrice, { nonnegative: true }), markPrice: optional(row.markPrice, { nonnegative: true }),
      notional: optional(row.notional, { nonnegative: true }), unrealizedPnl: optional(row.unrealizedPnl),
      leverage: optional(row.leverage, { positive: true }), marginMode, marginUsed: optional(row.marginUsed, { nonnegative: true }),
      liquidationPrice, liquidationKnown,
      riskFetchedAt: timeOf(row.riskFetchedAt) === null ? null : row.riskFetchedAt });
  }
  return { fetchedAt: snapshot.fetchedAt, positions: rows };
}

function safeError(exchange, error, limited) {
  const name = TRADING_NAMES[exchange];
  if (limited) return `${name} 请求受限，等待交易所允许重试后重新读取`;
  if (error?.code === 'position_binding_changed') return `${name} 执行连接已变化，等待按当前账户重新读取`;
  if (error?.code === 'position_identity') return `${name} 执行账户身份或子账户不一致，请重新核验连接`;
  if (error?.code === 'unsupported_reader') return `${name} 执行连接暂不支持独立仓位读取`;
  if (error?.code === 'invalid_data') return `${name} 执行账户仓位数据无法核验，保留上次仓位`;
  if (error?.name === 'TimeoutError' || error?.code === 'timeout') return `${name} 仓位读取超时，保留上次仓位`;
  if (error?.name === 'AbortError' || error?.code === 'aborted') return `${name} 仓位读取已取消，保留上次仓位`;
  return `${name} 执行账户仓位读取失败，保留上次仓位`;
}

/** In-memory observation only. The injected reader owns its 35 s timeout and has
 * no write permission. One attempt per venue per refresh; no retries here.
 * Credentials, connection changes and account scope invalidate every cache hit.
 * Source and risk times are never renewed by access, failure or persistence. */
export function createExecutionPositionWatch({ readConnections, read, now = Date.now, staleMs = 75_000 } = {}) {
  const entries = new Map(), controller = new AbortController();
  let inFlight = null, closed = false;

  function connections() {
    try {
      const list = readConnections();
      if (!Array.isArray(list)) throw new Error('invalid_connections');
      return EXCHANGES.map(exchange => {
        const matches = list.filter(item => item?.exchange === exchange);
        if (matches.length > 1) return { ...connection(exchange, null), error: '执行连接状态暂时无法读取' };
        return connection(exchange, matches[0]);
      });
    } catch {
      return EXCHANGES.map(exchange => ({ ...connection(exchange, null), error: '执行连接状态暂时无法读取' }));
    }
  }
  function state() {
    const current = now(), fresh = value => { const at = timeOf(value); return at !== null && at <= current + 1000 && current - at <= staleMs; };
    return connections().map(source => {
      const cached = entries.get(source.exchange), entry = !closed && source.connected && cached?.key === source.key ? cached : null;
      const data = entry?.data, error = closed ? '仓位读取已停止' : source.error || entry?.error || null;
      const status = !source.connected && !source.error ? 'unconfigured' : !data ? error ? 'error' : 'loading'
        : error || !fresh(data.fetchedAt) || data.positions.some(row => !fresh(row.riskFetchedAt)) ? 'stale' : 'live';
      return { exchange: source.exchange, origin: 'execution', connected: source.connected, accountMode: source.binding.accountMode,
        ...(source.exchange === 'rh-lighter' ? { accountIndex: source.binding.accountIndex } : {}),
        state: status, fetchedAt: data?.fetchedAt ?? null, error, refreshing: !!entry?.refreshing,
        positions: data ? data.positions.map(row => ({ ...row })) : [],
        ...(data ? { executionBinding: { ...source.binding } } : {}), connectionKey: source.key };
    });
  }
  function refresh(signal) {
    if (closed || signal?.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const list = connections();
    // Install this round before calling the reader, including synchronous readers.
    inFlight = Promise.resolve().then(() => Promise.all(list.map(async source => {
      let entry = entries.get(source.exchange);
      if (entry?.key !== source.key) {
        entry = { key: source.key, data: null, error: null, retryAt: 0, refreshing: false };
        entries.set(source.exchange, entry);
      }
      if (!source.connected || source.error || combined.aborted || now() < entry.retryAt) return;
      const stillCurrent = () => !closed && !combined.aborted && connections().some(value => value.exchange === source.exchange && !value.error && value.key === source.key);
      if (!stillCurrent()) return;
      entry.refreshing = true;
      try {
        const snapshot = await read(source.exchange, { ...source.binding }, { signal: combined });
        if (!stillCurrent()) return;
        entry.data = snapshotRows(source.exchange, source.binding, snapshot, now());
        entry.error = null; entry.retryAt = 0;
      } catch (error) {
        if (!stillCurrent()) return;
        const limited = Number.isSafeInteger(error?.retryAt) && error.retryAt > now();
        entry.retryAt = limited ? error.retryAt : 0;
        entry.error = safeError(source.exchange, error, limited);
      } finally { entry.refreshing = false; }
    }))).finally(() => { inFlight = null; });
    return inFlight;
  }
  return { state, refresh, async close() {
    closed = true; controller.abort();
    await inFlight?.catch(() => {});
    entries.clear();
  } };
}
