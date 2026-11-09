import { createTradingExchangeClient, TradingExchangeError, MAX_FUNDING_EVENTS } from './trading-exchanges.mjs';
import { decimal, addDecimals, negateDecimal, compareDecimals } from './trading-decimal.mjs';
import { normalizeTradingDiagnostic, formatTradingDiagnostic } from './trading-diagnostics.mjs';
import { createTradingPnl } from './trading-pnl.mjs';
import { createHash } from 'node:crypto';
import { TRADING_VIEW_VERSION, packTradingView, unpackTradingView } from './trading-view-cache.mjs';
import { TRADING_EXCHANGES as EXCHANGES, TRADING_SYMBOLS as SYMBOLS, TRADING_HYNIX_SYMBOLS as HYNIX_SYMBOLS, TRADING_ANTHROPIC_SYMBOLS as ANTHROPIC_SYMBOLS, TRADING_ANTHROPIC_EXCHANGES as ANTHROPIC_EXCHANGES, TRADING_NAMES as NAMES, TRADING_PAIRS, DEFAULT_TRADING_PAIR, normalizeTradingPair, tradingPairKey } from './trading-markets.mjs';
import { createStatementCache } from './db-cache.mjs';
import { instrumentId as okxInstrumentId } from './trading-okx-common.mjs';
import { immediate } from './control/schema.mjs';

const DAY = 86_400_000;
const POSITION_INTERVAL = 30_000, FUNDING_INTERVAL = 300_000;
const POSITION_STALE = 75_000, FUNDING_STALE = 900_000;
const PAGE_SIZE = 50;
const HYNIX_NAMES = Object.freeze({ SKHYUSDT: 'SKHY · ADR', SKHYNIXUSDT: 'SKHYNIX · 正股' });
const iso = time => new Date(time).toISOString();
const timeOf = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export class TradingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function emptySnapshot(exchange) {
  return { version: 1, exchange,
    positions: { rows: [], fetchedAt: null, lastAttemptAt: null, error: null, diagnostic: null },
    hynix: { rows: [], fetchedAt: null, lastAttemptAt: null, error: null, diagnostic: null },
    anthropic: { rows: [], fetchedAt: null, lastAttemptAt: null, error: null, diagnostic: null },
    funding: { events: [], coverage: [], fetchedAt: null, lastAttemptAt: null, requestedEnd: null, error: null, diagnostic: null },
    trades: { events: [], coverage: [], fetchedAt: null, lastAttemptAt: null, requestedEnd: null, error: null, diagnostic: null } };
}
// Account ledgers read in 7-day windows with their own coverage: funding receipts,
// and closing PnL plus trading fees. A failure in one never hides the other.
const LEDGERS = Object.freeze({ funding: { method: 'funding', name: '资金费' }, trades: { method: 'trades', name: '平仓盈亏与手续费' } });
const TRADE_KINDS = Object.freeze(['realized', 'fee']);
function exchangeOf(exchange) {
  if (!EXCHANGES.includes(exchange)) throw new TradingError(404, '交易所不存在');
  return exchange;
}
export function accountModeOf(exchange, value) {
  exchangeOf(exchange);
  const modes = exchange === 'binance' ? ['standard', 'portfolio-margin'] : ['unified'];
  if (value === undefined) return modes[0];
  if (!modes.includes(value)) throw new TradingError(400, '账户模式无效，请选择此交易所支持的账户模式');
  return value;
}
function revisionOf(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TradingError(400, '连接版本无效，请刷新后重试');
  return value;
}
function credentialsOf(body, exchange) {
  const valid = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
  if (!valid(body.apiKey) || !valid(body.apiSecret)) throw new TradingError(400, '请填写有效的 HMAC API Key 和 API Secret');
  if (exchange === 'okx' && (typeof body.passphrase !== 'string' || body.passphrase.length < 8 || body.passphrase.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(body.passphrase))) throw new TradingError(400, '请填写有效的 OKX Passphrase');
  return { apiKey: body.apiKey, apiSecret: body.apiSecret, ...(exchange === 'okx' ? { passphrase: body.passphrase } : {}) };
}
function safeError(error) {
  if (error instanceof TradingExchangeError) return error.message.slice(0, 240);
  if (error?.name === 'TimeoutError') return '交易所读取超时，已保留上次数据';
  return '交易所读取失败，请稍后重试';
}
function mergeCoverage(intervals) {
  const result = [];
  for (const item of intervals.slice().sort((a, b) => a.start - b.start)) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.start >= item.end) throw new Error('Invalid coverage');
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ start: item.start, end: item.end });
  }
  return result;
}
function covered(intervals, start, end) {
  return intervals.some(item => item.start <= start && item.end >= end);
}
function fundingStart(snapshot, end) {
  let gap = end - 30 * DAY;
  for (const item of snapshot.coverage) {
    if (item.start > gap) break;
    if (item.end > gap) gap = item.end;
  }
  return Math.max(end - 30 * DAY, Math.min(gap, end - DAY));
}
function normalizePositions(result, exchange, now, symbols = SYMBOLS) {
  if (!result || !Array.isArray(result.positions) || result.positions.length > (exchange === 'okx' ? 8 : 4) || timeOf(result.fetchedAt) === null || timeOf(result.fetchedAt) > now + 60_000) throw new Error('Invalid positions');
  const ids = new Set();
  const rows = result.positions.map(item => {
    if (!item || item.exchange !== exchange || !symbols.includes(item.symbol) || !['long', 'short'].includes(item.side) || !['one-way', 'hedge'].includes(item.mode)) throw new Error('Invalid position identity');
    if (exchange === 'okx' && !['cross', 'isolated'].includes(item.marginMode)) throw new Error('Invalid margin mode');
    const id = `${exchange}:${item.symbol}:${item.mode}:${item.side}${exchange === 'okx' ? ':' + item.marginMode : ''}`;
    if (ids.has(id)) throw new Error('Duplicate position'); ids.add(id);
    const optional = (value, nonnegative = false) => value == null ? null : decimal(value, { nonnegative });
    return { id, exchange, symbol: item.symbol, side: item.side, mode: item.mode,
      quantity: decimal(item.quantity, { positive: true }), entryPrice: optional(item.entryPrice, true), markPrice: optional(item.markPrice, true),
      notional: optional(item.notional, true), unrealizedPnl: optional(item.unrealizedPnl), leverage: optional(item.leverage, true),
      liquidationPrice: optional(item.liquidationPrice, true), sourceUpdatedAt: timeOf(item.sourceUpdatedAt) === null ? null : iso(timeOf(item.sourceUpdatedAt)),
      ...(Object.hasOwn(item, 'riskFetchedAt') ? { riskFetchedAt: timeOf(item.riskFetchedAt) === null ? null : iso(timeOf(item.riskFetchedAt)) } : {}),
      ...(exchange === 'okx' ? { marginMode: item.marginMode, instrumentId: okxInstrumentId(item.symbol), quantityUnit: '张', contractSize: decimal(item.contractSize, { positive: true }) } : {}) };
  });
  for (const symbol of symbols) {
    for (const margin of exchange === 'okx' ? ['cross', 'isolated'] : [undefined]) {
      const positions = rows.filter(row => row.symbol === symbol && row.marginMode === margin);
      if (positions.some(row => row.mode === 'one-way') && positions.length > 1) throw new Error('Conflicting position modes');
    }
  }
  return { rows, fetchedAt: iso(timeOf(result.fetchedAt)), accountIdentity: exchange === 'okx' && /^[a-f0-9]{64}$/.test(result.accountIdentity ?? '') ? result.accountIdentity : null };
}
function normalizeReceipts(events, exchange, start = 0, end = Infinity, ledger = 'funding') {
  if (!Array.isArray(events) || events.length > MAX_FUNDING_EVENTS * 2) throw new Error('Invalid funding events');
  const result = new Map();
  for (const item of events) {
    const time = timeOf(item?.time);
    if (!item || item.exchange !== exchange || !SYMBOLS.includes(item.symbol) || item.currency !== 'USDT' || typeof item.id !== 'string' || !item.id || item.id.length > 250 || /[\u0000-\u001f]/.test(item.id) || time === null || time < start || time >= end) throw new Error('Invalid funding receipt');
    if (ledger === 'trades' && !TRADE_KINDS.includes(item.kind)) throw new Error('Invalid trade kind');
    const row = { id: item.id, exchange, symbol: item.symbol, time: iso(time), ...(ledger === 'trades' ? { kind: item.kind } : {}), amount: decimal(item.amount), currency: 'USDT' };
    const previous = result.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting funding receipt');
    result.set(row.id, row);
    if (result.size > MAX_FUNDING_EVENTS) throw new Error('Invalid funding event count');
  }
  return [...result.values()].sort((a, b) => timeOf(a.time) - timeOf(b.time) || a.id.localeCompare(b.id));
}
// Position-only sections read beside the oil ledger, by snapshot key.
const SIDE_MARKETS = Object.freeze({ hynix: { symbols: HYNIX_SYMBOLS, name: '海力士' }, anthropic: { symbols: ANTHROPIC_SYMBOLS, name: 'Anthropic' } });
function parseSide(kind, value, exchange) {
  // Snapshots written before a side reader existed have no section; a damaged one never discards the oil ledger.
  if (!value) return emptySnapshot(exchange)[kind];
  const { symbols, name } = SIDE_MARKETS[kind];
  try {
    const positions = value.fetchedAt ? normalizePositions({ positions: value.rows, fetchedAt: value.fetchedAt, accountIdentity: value.accountIdentity }, exchange, Date.now(), symbols) : { rows: [], fetchedAt: null };
    const diagnostic = normalizeTradingDiagnostic(value.diagnostic);
    return { ...positions, lastAttemptAt: timeOf(value.lastAttemptAt) === null ? null : iso(timeOf(value.lastAttemptAt)), diagnostic,
      error: formatTradingDiagnostic(diagnostic) || (value.error ? `上次${name}仓位读取失败，请刷新重试` : null) };
  } catch {
    return { ...emptySnapshot(exchange)[kind], error: `本地${name}仓位缓存无效，请刷新重新读取` };
  }
}
function parseTrades(value, exchange) {
  // Snapshots written before trade ledgers existed have no section; a damaged one never discards the funding ledger.
  if (!value) return emptySnapshot(exchange).trades;
  try {
    const safeStamp = item => timeOf(item) === null ? null : iso(timeOf(item));
    const diagnostic = normalizeTradingDiagnostic(value.diagnostic);
    return { events: normalizeReceipts(value.events, exchange, 0, Infinity, 'trades'), coverage: mergeCoverage(value.coverage), fetchedAt: safeStamp(value.fetchedAt), lastAttemptAt: safeStamp(value.lastAttemptAt),
      requestedEnd: Number.isSafeInteger(value.requestedEnd) ? value.requestedEnd : null, diagnostic, error: formatTradingDiagnostic(diagnostic) || (value.error ? '上次平仓盈亏与手续费读取未完成，请刷新重试' : null) };
  } catch {
    return { ...emptySnapshot(exchange).trades, error: '本地平仓盈亏缓存无效，请刷新重新读取' };
  }
}
function parseSnapshot(row) {
  const fallback = emptySnapshot(row.exchange);
  if (!row.snapshot) return fallback;
  try {
    const value = JSON.parse(row.snapshot);
    if (value.version !== 1 || value.exchange !== row.exchange) throw new Error('Invalid snapshot');
    const positions = value.positions.fetchedAt ? normalizePositions({ positions: value.positions.rows, fetchedAt: value.positions.fetchedAt }, row.exchange, Date.now()) : { rows: [], fetchedAt: null };
    const events = normalizeReceipts(value.funding.events, row.exchange), coverage = mergeCoverage(value.funding.coverage);
    const safeStamp = value => timeOf(value) === null ? null : iso(timeOf(value));
    const positionsDiagnostic = normalizeTradingDiagnostic(value.positions.diagnostic), fundingDiagnostic = normalizeTradingDiagnostic(value.funding.diagnostic);
    // Persist only application-owned diagnostics. Arbitrary disk strings never become API error text.
    return { ...fallback, hynix: parseSide('hynix', value.hynix, row.exchange), anthropic: parseSide('anthropic', value.anthropic, row.exchange), trades: parseTrades(value.trades, row.exchange), positions: { ...positions, lastAttemptAt: safeStamp(value.positions.lastAttemptAt), diagnostic: positionsDiagnostic, error: formatTradingDiagnostic(positionsDiagnostic) || (value.positions.error ? '上次仓位读取失败，请刷新重试' : null) },
      funding: { events, coverage, fetchedAt: safeStamp(value.funding.fetchedAt), lastAttemptAt: safeStamp(value.funding.lastAttemptAt),
        requestedEnd: Number.isSafeInteger(value.funding.requestedEnd) ? value.funding.requestedEnd : null, diagnostic: fundingDiagnostic, error: formatTradingDiagnostic(fundingDiagnostic) || (value.funding.error ? '上次资金费读取未完成，请刷新重试' : null) } };
  } catch {
    fallback.positions.error = fallback.hynix.error = fallback.anthropic.error = fallback.funding.error = fallback.trades.error = '本地交易缓存无效，请刷新重新读取';
    return fallback;
  }
}
function readState(connected, data, now, staleMs) {
  if (!connected) return 'unconfigured';
  if (!data.fetchedAt) return data.error ? 'error' : 'loading';
  return data.error || now - timeOf(data.fetchedAt) > staleMs ? 'stale' : 'live';
}
function tradesStatus(connected, trades, now) {
  return { state: readState(connected, trades, now, FUNDING_STALE), fetchedAt: trades.fetchedAt, error: trades.error,
    coverageEnd: trades.coverage.length ? iso(trades.coverage.at(-1).end) : null };
}
function sumOrUnknown(positions, field, signed = false) {
  if (positions.some(row => row[field] === null)) return null;
  return addDecimals(positions.map(row => signed && row.side === 'short' ? negateDecimal(row[field]) : row[field]));
}
function cashTotals(events, known) {
  if (!known && !events.length) return { income: null, expense: null, net: null };
  const income = addDecimals(events.filter(row => compareDecimals(row.amount, '0') > 0).map(row => row.amount));
  const expense = negateDecimal(addDecimals(events.filter(row => compareDecimals(row.amount, '0') < 0).map(row => row.amount)));
  return { income, expense, net: addDecimals(events.map(row => row.amount)) };
}
function structure(legs) {
  if (legs.some(leg => leg.state !== 'live')) return { state: 'unknown', message: '等待两所最新仓位，暂不判断四腿结构' };
  if (legs.some(leg => leg.positions.length > 1)) return { state: 'mixed', message: '存在同一合约多空并存，请分别核对仓位；资金费按合约汇总' };
  if (legs.some(leg => !leg.positions.length)) return { state: 'incomplete', message: '当前未持齐四腿，空仓合约仍保留历史资金费' };
  const opposed = SYMBOLS.every(symbol => { const pair = legs.filter(leg => leg.symbol === symbol); return pair[0].positions[0].side !== pair[1].positions[0].side; });
  return opposed ? { state: 'opposed', message: 'CL、BZ 的跨所方向均相反；数量与名义金额按各腿实际仓位展示' } : { state: 'same-direction', message: '存在同品种跨所同向仓位，请核对四腿结构' };
}

/** Account reads only. This service deliberately has no exchange mutation operation. */
export function createTrading({ db, stmt, encrypt, decrypt, clientFactory = createTradingExchangeClient, now = Date.now, intervalMs = 1000, taskTimeoutMs = 60000, validationTimeoutMs = 35000, logger = console } = {}) {
  if (!stmt) stmt = createStatementCache(db);
  immediate(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS trading_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, verified_at TEXT, snapshot TEXT, account_mode TEXT NOT NULL DEFAULT 'standard')");
    if (!stmt.prepare('PRAGMA table_info(trading_accounts)').all().some(column => column.name === 'account_mode')) {
      db.exec("ALTER TABLE trading_accounts ADD COLUMN account_mode TEXT NOT NULL DEFAULT 'standard'; UPDATE trading_accounts SET account_mode='unified' WHERE exchange IN ('bybit','okx')");
    }
    for (const exchange of EXCHANGES) stmt.prepare('INSERT OR IGNORE INTO trading_accounts(exchange,account_mode) VALUES (?,?)').run(exchange, accountModeOf(exchange));
  });
  const rowFor = exchange => stmt.prepare('SELECT exchange,revision,credentials,verified_at,account_mode FROM trading_accounts WHERE exchange=?').get(exchangeOf(exchange));
  const storedRows = stmt.prepare('SELECT * FROM trading_accounts ORDER BY exchange').all();
  const cache = new Map(storedRows.map(row => [row.exchange, parseSnapshot(row)]));
  const hash = value => createHash('sha256').update(value || '').digest('hex');
  const ledgerHash = snapshot => hash(JSON.stringify(Object.keys(LEDGERS).map(kind => [snapshot[kind].fetchedAt, snapshot[kind].requestedEnd, snapshot[kind].events, snapshot[kind].coverage])));
  const snapshotHashes = new Map(EXCHANGES.map(exchange => [exchange, ledgerHash(cache.get(exchange))]));
  // Performance: Track serialized snapshots to avoid redundant serialization
  const serializedCache = new Map(storedRows.map(row => [row.exchange, row.snapshot]));
  const pnl = createTradingPnl(db, stmt);
  const entriesFor = (pair = EXCHANGES) => pair.map(exchange => ({ row: rowFor(exchange), snapshot: cache.get(exchange) }));
  const recordPnl = () => TRADING_PAIRS.map(pair => pnl.record(entriesFor(pair), now())).some(Boolean);
  const clients = new Map(EXCHANGES.map(exchange => [exchange, clientFactory(exchange)]));
  const jobs = new Map(), validations = new Map(), watchers = new Map();
  db.exec('CREATE TABLE IF NOT EXISTS trading_views_v2 (pair_key TEXT NOT NULL, days INTEGER NOT NULL, version INTEGER NOT NULL, source_key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(pair_key,days))');
  let views = new Map(), viewsDirty = false, viewTimer = null;
  let viewError = null, viewRetryAt = 0, viewRetryDelay = 750;
  let closed = false;
  let fundingBatchEnd = Math.max(0, ...EXCHANGES.flatMap(exchange => Object.keys(LEDGERS).map(kind => cache.get(exchange)[kind].requestedEnd || 0)));
  function write(exchange, revision, change) {
    if (closed || rowFor(exchange).revision !== revision) return false;
    const previous = cache.get(exchange);
    const next = change(previous);

    // Performance: Only serialize and write if data actually changed
    const previousSerialized = serializedCache.get(exchange);
    const serialized = JSON.stringify(next);
    if (serialized === previousSerialized) return true; // No change, skip DB write

    if (!stmt.prepare('UPDATE trading_accounts SET snapshot=? WHERE exchange=? AND revision=?').run(serialized, exchange, revision).changes) return false;
    cache.set(exchange, next);
    serializedCache.set(exchange, serialized); // Update serialized cache
    const ledgerChanged = Object.keys(LEDGERS).some(kind => previous[kind].events !== next[kind].events || previous[kind].coverage !== next[kind].coverage);
    if (ledgerChanged || Object.keys(LEDGERS).some(kind => previous[kind].requestedEnd !== next[kind].requestedEnd)) snapshotHashes.set(exchange, ledgerHash(next));
    if (ledgerChanged) invalidateViews();
    return true;
  }
  async function deadline(controller, timeoutMs, work) {
    const timer = setTimeout(() => controller.abort(new DOMException('Read timed out', 'TimeoutError')), timeoutMs); timer.unref?.();
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(controller.signal.reason); if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([cancelled, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); })]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  function cancel(exchange) {
    for (const [key, watcher] of watchers) if (key.startsWith(`${exchange}:`)) { watchers.delete(key); watcher.unsubscribe(); }
    for (const [key, job] of jobs) if (key.startsWith(`${exchange}:`)) { job.controller.abort(); jobs.delete(key); }
  }
  function privateCredentials(row) {
    const value = decrypt(row.credentials);
    if (!value || value.exchange !== row.exchange) throw new Error('Invalid credential identity');
    return credentialsOf(value, row.exchange);
  }
  function watch(row, kind, credentials, accountMode) {
    const client = clients.get(row.exchange), key = `${row.exchange}:${kind}`;
    if (Object.hasOwn(LEDGERS, kind) || typeof client.watchPositions !== 'function') return null;
    if (watchers.get(key)?.revision === row.revision) return watchers.get(key);
    watchers.get(key)?.unsubscribe();
    const watcher = { revision: row.revision, version: 0, unsubscribe: () => {} };
    watchers.set(key, watcher);
    watcher.unsubscribe = client.watchPositions(credentials, { accountMode, symbols: SIDE_MARKETS[kind]?.symbols ?? SYMBOLS,
      onSnapshot(result) {
        if (closed || watchers.get(key) !== watcher || rowFor(row.exchange).revision !== row.revision) return;
        const value = normalizePositions(result, row.exchange, now(), SIDE_MARKETS[kind]?.symbols ?? SYMBOLS);
        if (write(row.exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], ...value, error: null, diagnostic: null } }))) watcher.version++;
      },
      onReset() {
        if (closed || watchers.get(key) !== watcher || rowFor(row.exchange).revision !== row.revision) return;
        const diagnostic = normalizeTradingDiagnostic({ version: 1, exchange: row.exchange, accountMode, operation: 'positions', code: 'transport' });
        write(row.exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], diagnostic, error: formatTradingDiagnostic(diagnostic) } }));
      },
    });
    return watcher;
  }
  function run(exchange, kind, { force = false, end = now() } = {}) {
    if (closed) return Promise.resolve();
    const row = rowFor(exchange), key = `${exchange}:${kind}`;
    const ledger = Object.hasOwn(LEDGERS, kind) ? LEDGERS[kind] : null;
    if (!row.credentials || kind === 'anthropic' && !ANTHROPIC_EXCHANGES.includes(exchange) || ledger && typeof clients.get(exchange)[ledger.method] !== 'function') return Promise.resolve();
    if (jobs.has(key)) return jobs.get(key).promise;
    const previous = cache.get(exchange)[kind];
    const newFundingBatch = !!ledger && (previous.requestedEnd || 0) < end;
    const cooldown = force || newFundingBatch ? 5000 : ledger ? FUNDING_INTERVAL : POSITION_INTERVAL;
    if (previous.lastAttemptAt && now() - timeOf(previous.lastAttemptAt) < cooldown) return Promise.resolve();
    const controller = new AbortController();
    const start = ledger ? fundingStart(previous, end) : null;
    const saveLedger = (result, progress = false) => {
      if (controller.signal.aborted || closed || rowFor(exchange).revision !== row.revision) return;
      if (timeOf(result?.fetchedAt) === null || timeOf(result.fetchedAt) > now() + 60000 || typeof result.complete !== 'boolean' || !Array.isArray(result.coverage)) throw new Error('Invalid funding response');
      const added = normalizeReceipts(result.events, exchange, start, end, kind), incomingCoverage = mergeCoverage(result.coverage);
      if (incomingCoverage.some(item => item.start < start || item.end > end) || result.complete && !covered(incomingCoverage, start, end)) throw new Error('Invalid funding coverage');
      const diagnostic = progress || result.complete ? null : normalizeTradingDiagnostic(result.diagnostic);
      write(exchange, row.revision, snapshot => {
        const events = normalizeReceipts([...snapshot[kind].events.filter(item => timeOf(item.time) >= end - 31 * DAY), ...added], exchange, 0, Infinity, kind);
        const coverage = mergeCoverage([...snapshot[kind].coverage, ...incomingCoverage]).filter(item => item.end > end - 31 * DAY).map(item => ({ start: Math.max(item.start, end - 31 * DAY), end: item.end }));
        return { ...snapshot, [kind]: { ...snapshot[kind], events, coverage, fetchedAt: result.fetchedAt, diagnostic,
          error: progress || result.complete ? null : formatTradingDiagnostic(diagnostic) || `${ledger.name}记录未取全，当前仅显示已获取记录，请刷新重试` } };
      });
    };
    write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], lastAttemptAt: iso(now()), ...(ledger ? { requestedEnd: end } : {}) } }));
    const promise = (async () => {
      try {
        const credentials = privateCredentials(row), accountMode = accountModeOf(exchange, row.account_mode);
        const client = clients.get(exchange);
        const watcher = watch(row, kind, credentials, accountMode), streamVersion = watcher?.version;
        const result = await deadline(controller, taskTimeoutMs, signal => kind === 'positions' ? client.positions(credentials, { signal, accountMode })
          : kind === 'hynix' ? client.hynixPositions(credentials, { signal, accountMode }) : kind === 'anthropic' ? client.anthropicPositions(credentials, { signal, accountMode }) : client[ledger.method](credentials, { start, end, signal, accountMode, onProgress: result => saveLedger(result, true) }));
        if (controller.signal.aborted || closed || rowFor(exchange).revision !== row.revision) return;
        if (ledger) saveLedger(result);
        else if (!watcher || watcher.version === streamVersion) {
          const value = normalizePositions(result, exchange, now(), SIDE_MARKETS[kind]?.symbols ?? SYMBOLS);
          write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], ...value, error: null, diagnostic: null } }));
        }
      } catch (error) {
        if (closed || rowFor(exchange).revision !== row.revision || controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
        const diagnostic = normalizeTradingDiagnostic(error?.diagnostic) || normalizeTradingDiagnostic({ version: 1, exchange, accountMode: row.account_mode, operation: ledger ? kind : 'positions', code: error?.name === 'TimeoutError' ? 'timeout' : 'upstream' });
        write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], diagnostic, error: formatTradingDiagnostic(diagnostic) || safeError(error) } }));
      }
    })().finally(() => { if (jobs.get(key)?.promise === promise) jobs.delete(key); });
    jobs.set(key, { controller, promise }); return promise;
  }
  function refresh({ force = false } = {}) {
    const current = now();
    if (!fundingBatchEnd || current - fundingBatchEnd >= (force ? 5000 : FUNDING_INTERVAL)) fundingBatchEnd = current;
    const positions = Promise.allSettled(EXCHANGES.map(exchange => run(exchange, 'positions', { force, end: current }))).then(() => { if (!closed && recordPnl()) invalidateViews(); });
    // SK hynix reads run beside, never inside, the oil position batch that records PnL.
    const sides = EXCHANGES.flatMap(exchange => [run(exchange, 'hynix', { force }), run(exchange, 'anthropic', { force })]);
    return Promise.allSettled([positions, ...sides, ...EXCHANGES.flatMap(exchange => Object.keys(LEDGERS).map(kind => run(exchange, kind, { force, end: fundingBatchEnd })))]).then(result => { if (!closed) flushViews(); return result; });
  }
  function buildState(days = 7, pair = DEFAULT_TRADING_PAIR) {
    if (![7, 30].includes(days)) throw new TradingError(400, '资金费区间仅支持 7 天或 30 天');
    const current = now();
    const entries = entriesFor(pair);
    const ends = entries.filter(({ row }) => row.credentials).map(({ snapshot }) => snapshot.funding.requestedEnd).filter(value => Number.isSafeInteger(value));
    const end = ends.length ? Math.max(...ends) : current, start = end - days * DAY;
    const accounts = entries.map(({ row, snapshot }) => {
      const connected = !!row.credentials;
      const fundingState = readState(connected, snapshot.funding, current, FUNDING_STALE);
      return { exchange: row.exchange, name: NAMES[row.exchange], accountMode: row.account_mode, connected, revision: row.revision, verifiedAt: row.verified_at,
        refreshing: [...jobs.keys()].some(key => key.startsWith(`${row.exchange}:`)),
        positions: { state: readState(connected, snapshot.positions, current, POSITION_STALE), fetchedAt: snapshot.positions.fetchedAt, error: snapshot.positions.error },
        funding: { state: fundingState, fetchedAt: snapshot.funding.fetchedAt, error: snapshot.funding.error,
          coverageStart: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage[0].start) : null,
          coverageEnd: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage.at(-1).end) : null,
          complete: fundingState === 'live' && covered(snapshot.funding.coverage, start, end) },
        trades: tradesStatus(connected, snapshot.trades, current) };
    });
    const events = entries.filter(({ row }) => row.credentials).flatMap(({ snapshot }) => snapshot.funding.events).filter(item => timeOf(item.time) >= start && timeOf(item.time) < end).sort((a, b) => timeOf(b.time) - timeOf(a.time) || a.id.localeCompare(b.id));
    const complete = accounts.every(account => account.funding.complete);
    const totals = cashTotals(events, complete);
    const legs = pair.flatMap(exchange => SYMBOLS.map(symbol => {
      const account = accounts.find(item => item.exchange === exchange), snapshot = cache.get(exchange);
      const positions = account.connected ? snapshot.positions.rows.filter(row => row.symbol === symbol) : [];
      const receipts = events.filter(item => item.exchange === exchange && item.symbol === symbol);
      const known = !!account.positions.fetchedAt;
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol === 'CLUSDT' ? 'CL · WTI' : 'BZ · 布伦特',
        state: account.positions.state, fetchedAt: account.positions.fetchedAt, positions,
        grossNotional: known ? sumOrUnknown(positions, 'notional') : null, netNotional: known ? sumOrUnknown(positions, 'notional', true) : null,
        unrealizedPnl: known ? sumOrUnknown(positions, 'unrealizedPnl') : null,
        fundingNet: cashTotals(receipts, account.funding.complete).net, fundingComplete: account.funding.complete, fundingReceiptCount: receipts.length };
    }));
    const daily = [], rowsByDay = new Map();
    for (const event of events) {
      const day = Math.floor((timeOf(event.time) + 8 * 3600000) / DAY) * DAY - 8 * 3600000;
      if (!rowsByDay.has(day)) rowsByDay.set(day, []);
      rowsByDay.get(day).push(event);
    }
    // The first and last Beijing dates may be partial calendar days; both are clipped to the displayed interval.
    for (let day = Math.floor((start + 8 * 3600000) / DAY) * DAY - 8 * 3600000; day < end; day += DAY) {
      const from = Math.max(day, start), to = Math.min(day + DAY, end);
      const dayComplete = entries.every(({ row, snapshot }) => !!row.credentials && readState(true, snapshot.funding, current, FUNDING_STALE) === 'live' && covered(snapshot.funding.coverage, from, to));
      const rows = rowsByDay.get(day) || [];
      daily.push({ date: iso(day + 8 * 3600000).slice(0, 10), ...cashTotals(rows, dayComplete), complete: dayComplete, receiptCount: rows.length });
    }
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: iso(current), period: { days, start: iso(start), end: iso(end) },
      exchanges: [...pair], accounts, legs, structure: structure(legs), funding: { complete, ...totals, currency: 'USDT', events, daily }, pnl: pnl.read(entries, start, current) };
  }
  function sourceKey(pair) {
    const entries = entriesFor(pair);
    return JSON.stringify([entries.map(({ row }) => [row.exchange, row.revision, !!row.credentials, snapshotHashes.get(row.exchange)]), pnl.sourceKey(entries)]);
  }
  function invalidateViews() {
    viewsDirty = true;
    if (closed || viewTimer) return;
    // Coalesce partial ledger windows and independent account completions. This
    // timer only calculates local data; no HTTP reader triggers or awaits it.
    viewTimer = setTimeout(() => { viewTimer = null; flushViews(); }, Math.max(750, viewRetryAt - now()));
    viewTimer.unref?.();
  }
  function flushViews({ required = false } = {}) {
    if (closed || !viewsDirty) return;
    // Polling and partial account completions must not bypass a failed rebuild's backoff.
    if (!required && now() < viewRetryAt) { invalidateViews(); return; }
    try {
      rebuildViews();
    } catch (error) {
      const retryInMs = viewRetryDelay;
      viewRetryAt = now() + retryInMs;
      viewRetryDelay = Math.min(30_000, retryInMs * 2);
      viewError = { code: 'view_rebuild_failed', message: '缓存更新失败，已保留上次数据，将自动重试。', at: iso(now()) };
      const category = ['ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR', 'ENOSPC'].includes(error?.code)
        ? error.code : ['TypeError', 'RangeError'].includes(error?.name) ? error.name : 'Error';
      logger.error?.({ type: 'trading_view_rebuild_failed', category, failedAt: viewError.at, retryInMs }, '交易视图缓存更新失败');
      invalidateViews();
      if (required) throw error;
    }
  }
  function rebuildViews() {
    clearTimeout(viewTimer); viewTimer = null;
    const next = new Map(), keys = new Map();
    for (const pair of TRADING_PAIRS) {
      const pairKey = tradingPairKey(pair), key = sourceKey(pair);
      keys.set(pairKey, key);
      for (const days of [7, 30]) next.set(`${pairKey}:${days}`, buildState(days, pair));
      if (key !== sourceKey(pair)) { invalidateViews(); return; }
    }
    immediate(db, () => {
      const save = stmt.prepare('INSERT INTO trading_views_v2(pair_key,days,version,source_key,json) VALUES (?,?,?,?,?) ON CONFLICT(pair_key,days) DO UPDATE SET version=excluded.version,source_key=excluded.source_key,json=excluded.json');
      for (const value of next.values()) { const pairKey = tradingPairKey(value.exchanges); save.run(pairKey, value.period.days, TRADING_VIEW_VERSION, keys.get(pairKey), packTradingView(value)); }
    });
    views = next; viewsDirty = false;
    viewError = null; viewRetryAt = 0; viewRetryDelay = 750;
  }
  function resetViews() {
    views.clear();
    stmt.prepare('DELETE FROM trading_views_v2').run();
    invalidateViews(); flushViews({ required: true });
  }
  function restoreViews() {
    const restored = new Map();
    for (const pair of TRADING_PAIRS) for (const days of [7, 30]) {
      const pairKey = tradingPairKey(pair), saved = stmt.prepare('SELECT * FROM trading_views_v2 WHERE pair_key=? AND days=?').get(pairKey, days);
      if (!saved || saved.version !== TRADING_VIEW_VERSION || saved.source_key !== sourceKey(pair)) return false;
      try {
        const value = unpackTradingView(saved.json, days, now(), pair);
        const start = timeOf(value.period.start), end = timeOf(value.period.end);
        value.funding.events = entriesFor(pair).filter(({ row }) => row.credentials).flatMap(({ snapshot }) => snapshot.funding.events)
          .filter(event => timeOf(event.time) >= start && timeOf(event.time) < end).sort((a, b) => timeOf(b.time) - timeOf(a.time) || a.id.localeCompare(b.id));
        restored.set(`${pairKey}:${days}`, value);
      } catch { return false; }
    }
    views = restored; return true;
  }
  function state(days = 7, { page, pair: inputPair } = {}) {
    if (![7, 30].includes(days)) throw new TradingError(400, '资金费区间仅支持 7 天或 30 天');
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0 || page > 1999)) throw new TradingError(400, '流水页码无效');
    let pair;
    try { pair = normalizeTradingPair(inputPair); } catch { throw new TradingError(400, '请选择两个不同的交易所'); }
    const current = now(), saved = views.get(`${tradingPairKey(pair)}:${days}`);
    if (!saved) throw new TradingError(503, '交易缓存更新失败，暂时无法读取，请稍后重试');
    // All history scans and monetary aggregation happened before publication.
    // Only bounded account freshness, four positions and one ledger slice remain.
    const accounts = entriesFor().map(({ row, snapshot }) => {
      const connected = !!row.credentials;
      const funding = { fetchedAt: snapshot.funding.fetchedAt, error: snapshot.funding.error,
        coverageStart: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage[0].start) : null,
        coverageEnd: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage.at(-1).end) : null,
        complete: connected && covered(snapshot.funding.coverage, timeOf(saved.period.start), timeOf(saved.period.end)) };
      const fundingState = readState(connected, funding, current, FUNDING_STALE);
      return { exchange: row.exchange, name: NAMES[row.exchange], accountMode: row.account_mode, connected, revision: row.revision, verifiedAt: row.verified_at,
        refreshing: [...jobs.keys()].some(key => key.startsWith(`${row.exchange}:`)),
        positions: { state: readState(connected, snapshot.positions, current, POSITION_STALE), fetchedAt: snapshot.positions.fetchedAt, error: snapshot.positions.error },
        funding: { ...funding, state: fundingState, complete: funding.complete && fundingState === 'live' },
        trades: tradesStatus(connected, snapshot.trades, current) };
    });
    const legs = pair.flatMap(exchange => SYMBOLS.map(symbol => {
      const account = accounts.find(account => account.exchange === exchange), snapshot = cache.get(exchange);
      const positions = account.connected ? snapshot.positions.rows.filter(row => row.symbol === symbol) : [];
      const stored = saved.legs.find(leg => leg.id === `${exchange}:${symbol}`), known = !!account.positions.fetchedAt;
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol === 'CLUSDT' ? 'CL · WTI' : 'BZ · 布伦特', state: account.positions.state,
        fetchedAt: account.positions.fetchedAt, positions, grossNotional: known ? sumOrUnknown(positions, 'notional') : null,
        netNotional: known ? sumOrUnknown(positions, 'notional', true) : null, unrealizedPnl: known ? sumOrUnknown(positions, 'unrealizedPnl') : null,
        fundingNet: !account.funding.complete && !stored.fundingReceiptCount ? null : stored.fundingNet, fundingComplete: account.funding.complete };
    }));
    const hynixAccounts = entriesFor(pair).map(({ row, snapshot }) => ({ exchange: row.exchange,
      state: readState(!!row.credentials, snapshot.hynix, current, POSITION_STALE), fetchedAt: snapshot.hynix.fetchedAt, error: snapshot.hynix.error }));
    const hynixLegs = pair.flatMap(exchange => HYNIX_SYMBOLS.map(symbol => {
      const account = hynixAccounts.find(item => item.exchange === exchange), known = !!account.fetchedAt;
      const positions = accounts.find(item => item.exchange === exchange).connected ? cache.get(exchange).hynix.rows.filter(row => row.symbol === symbol) : [];
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: HYNIX_NAMES[symbol], state: account.state, fetchedAt: account.fetchedAt, positions,
        grossNotional: known ? sumOrUnknown(positions, 'notional') : null, netNotional: known ? sumOrUnknown(positions, 'notional', true) : null,
        unrealizedPnl: known ? sumOrUnknown(positions, 'unrealizedPnl') : null };
    }));
    const selectedAccounts = accounts.filter(account => pair.includes(account.exchange));
    const complete = selectedAccounts.every(account => account.funding.complete), events = saved.funding.events;
    const totals = !complete && !events.length ? { income: null, expense: null, net: null } : { income: saved.funding.income, expense: saved.funding.expense, net: saved.funding.net };
    const allFundingFresh = selectedAccounts.every(account => account.funding.state === 'live');
    const daily = saved.funding.daily.map(({ receiptCount, ...day }) => {
      const complete = day.complete && allFundingFresh;
      return { ...day, complete, ...(!complete && !receiptCount ? { income: null, expense: null, net: null } : {}) };
    });
    const historical = saved.pnl, last = historical.latest;
    const expired = last && current - last.time > POSITION_STALE && (last.unrealizedPnl !== null || last.totalPnl !== null);
    const latest = expired ? { time: current, unrealizedPnl: null, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null } : last;
    const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE)), selected = Math.min(page ?? 0, pages - 1);
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: saved.generatedAt,
      exchanges: pair, period: saved.period, accounts, legs, structure: structure(legs), hynix: { accounts: hynixAccounts, legs: hynixLegs },
      funding: { complete, ...totals, currency: 'USDT', daily, events: page === undefined ? events : events.slice(selected * PAGE_SIZE, (selected + 1) * PAGE_SIZE), pagination: { page: selected, pageSize: PAGE_SIZE, total: events.length, pages } },
      pnl: { ...historical, end: current, points: expired ? [...historical.points, latest] : historical.points, latest, status: expired ? 'incomplete' : historical.status },
      cache: { builtAt: saved.generatedAt, servedAt: iso(current), rebuilding: viewsDirty, error: viewError },
    };
  }
  async function connect(exchange, body, { credentialReader, beforeSave, signal: externalSignal, timeoutMs = validationTimeoutMs } = {}) {
    exchangeOf(exchange); const revision = revisionOf(body.revision);
    const accountMode = accountModeOf(exchange, body.accountMode);
    let credentials = credentialReader ? null : credentialsOf(body, exchange);
    if (closed) throw new TradingError(503, '交易模块正在关闭');
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    if (validations.has(exchange)) throw new TradingError(409, '此交易所正在验证连接，请稍候');
    const controller = new AbortController(); validations.set(exchange, controller);
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await deadline(controller, timeoutMs, async signal => {
        if (credentialReader) credentials = credentialsOf(await credentialReader(signal), exchange);
        signal.throwIfAborted();
        return clients.get(exchange).verify(credentials, { signal, accountMode });
      });
      controller.signal.throwIfAborted();
      if (closed) throw new TradingError(503, '交易模块正在关闭');
      if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，本次验证结果未保存');
      beforeSave?.();
      const positions = normalizePositions(result, exchange, now()), snapshot = emptySnapshot(exchange);
      snapshot.positions = { ...snapshot.positions, ...positions, lastAttemptAt: iso(now()) };
      const encrypted = encrypt({ exchange, ...credentials });
      const serialized = JSON.stringify(snapshot);
      const saved = stmt.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=?,account_mode=?,verified_at=?,snapshot=? WHERE exchange=? AND revision=?').run(encrypted, accountMode, iso(now()), serialized, exchange, revision);
      if (!saved.changes) throw new TradingError(409, '连接已被更新，本次验证结果未保存');
      cancel(exchange); cache.set(exchange, snapshot);
      serializedCache.set(exchange, serialized); // Update serialization cache
      snapshotHashes.set(exchange, ledgerHash(snapshot));
      recordPnl();
      resetViews();
      if (!fundingBatchEnd || now() - fundingBatchEnd >= FUNDING_INTERVAL) fundingBatchEnd = now();
      for (const kind of Object.keys(LEDGERS)) void run(exchange, kind, { end: fundingBatchEnd }).catch(() => {});
      void run(exchange, 'hynix').catch(() => {});
      void run(exchange, 'anthropic').catch(() => {});
    } catch (error) {
      if (error instanceof TradingError) throw error;
      throw new TradingError(400, controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError' ? '连接验证已取消' : safeError(error));
    } finally { externalSignal?.removeEventListener('abort', abort); if (validations.get(exchange) === controller) validations.delete(exchange); }
  }
  function disconnect(exchange, revision) {
    exchangeOf(exchange); revisionOf(revision);
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    stmt.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=NULL,verified_at=NULL,snapshot=NULL WHERE exchange=? AND revision=?').run(exchange, revision);
    validations.get(exchange)?.abort(); cancel(exchange);
    const emptySnap = emptySnapshot(exchange);
    cache.set(exchange, emptySnap);
    serializedCache.set(exchange, JSON.stringify(emptySnap)); // Update serialization cache
    snapshotHashes.set(exchange, ledgerHash(cache.get(exchange))); resetViews();
  }
  if (!restoreViews()) {
    viewsDirty = true;
    try { flushViews({ required: true }); }
    catch (error) { closed = true; clearTimeout(viewTimer); throw error; }
  }
  const timer = intervalMs > 0 ? setInterval(() => { if (!closed) void refresh(); }, intervalMs) : null; timer?.unref();
  const first = intervalMs > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();
  /** Anthropic legs on the read-only accounts, independent of the selected pair. */
  function anthropic() {
    const current = now();
    return ANTHROPIC_EXCHANGES.map(exchange => {
      const row = rowFor(exchange), snapshot = cache.get(exchange).anthropic, connected = !!row.credentials;
      return { exchange, connected, state: readState(connected, snapshot, current, POSITION_STALE), fetchedAt: snapshot.fetchedAt, error: snapshot.error,
        refreshing: jobs.has(`${exchange}:anthropic`), positions: connected ? snapshot.rows : [], accountIdentity: connected ? snapshot.accountIdentity ?? null : null };
    });
  }
  return { state, refresh, connect, disconnect, anthropic,
    async close() { closed = true; clearInterval(timer); clearTimeout(first); clearTimeout(viewTimer); for (const watcher of watchers.values()) watcher.unsubscribe(); watchers.clear(); for (const client of clients.values()) client.close?.(); for (const controller of validations.values()) controller.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); jobs.clear(); validations.clear(); },
  };
}
