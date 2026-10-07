import { createTradingExchangeClient, TradingExchangeError, MAX_FUNDING_EVENTS } from './trading-exchanges.mjs';
import { decimal, addDecimals, negateDecimal, compareDecimals } from './trading-decimal.mjs';
import { normalizeTradingDiagnostic, formatTradingDiagnostic } from './trading-diagnostics.mjs';
import { createTradingPnl } from './trading-pnl.mjs';
import { createHash } from 'node:crypto';
import { TRADING_VIEW_VERSION, packTradingView, unpackTradingView } from './trading-view-cache.mjs';

const EXCHANGES = ['binance', 'bybit'];
const SYMBOLS = ['CLUSDT', 'BZUSDT'];
const NAMES = { binance: 'Binance', bybit: 'Bybit' };
const DAY = 86_400_000;
const POSITION_INTERVAL = 30_000, FUNDING_INTERVAL = 300_000;
const POSITION_STALE = 75_000, FUNDING_STALE = 900_000;
const PAGE_SIZE = 50;
const iso = time => new Date(time).toISOString();
const timeOf = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export class TradingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function emptySnapshot(exchange) {
  return { version: 1, exchange,
    positions: { rows: [], fetchedAt: null, lastAttemptAt: null, error: null, diagnostic: null },
    funding: { events: [], coverage: [], fetchedAt: null, lastAttemptAt: null, requestedEnd: null, error: null, diagnostic: null } };
}
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
function credentialsOf(body) {
  const valid = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
  if (!valid(body.apiKey) || !valid(body.apiSecret)) throw new TradingError(400, '请填写有效的 HMAC API Key 和 API Secret');
  return { apiKey: body.apiKey, apiSecret: body.apiSecret };
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
function normalizePositions(result, exchange, now) {
  if (!result || !Array.isArray(result.positions) || result.positions.length > 4 || timeOf(result.fetchedAt) === null || timeOf(result.fetchedAt) > now + 60_000) throw new Error('Invalid positions');
  const ids = new Set();
  const rows = result.positions.map(item => {
    if (!item || item.exchange !== exchange || !SYMBOLS.includes(item.symbol) || !['long', 'short'].includes(item.side) || !['one-way', 'hedge'].includes(item.mode)) throw new Error('Invalid position identity');
    const id = `${exchange}:${item.symbol}:${item.mode}:${item.side}`;
    if (ids.has(id)) throw new Error('Duplicate position'); ids.add(id);
    const optional = (value, nonnegative = false) => value == null ? null : decimal(value, { nonnegative });
    return { id, exchange, symbol: item.symbol, side: item.side, mode: item.mode,
      quantity: decimal(item.quantity, { positive: true }), entryPrice: optional(item.entryPrice, true), markPrice: optional(item.markPrice, true),
      notional: optional(item.notional, true), unrealizedPnl: optional(item.unrealizedPnl), leverage: optional(item.leverage, true),
      liquidationPrice: optional(item.liquidationPrice, true), sourceUpdatedAt: timeOf(item.sourceUpdatedAt) === null ? null : iso(timeOf(item.sourceUpdatedAt)) };
  });
  for (const symbol of SYMBOLS) {
    const positions = rows.filter(row => row.symbol === symbol);
    if (positions.some(row => row.mode === 'one-way') && positions.length > 1) throw new Error('Conflicting position modes');
  }
  return { rows, fetchedAt: iso(timeOf(result.fetchedAt)) };
}
function normalizeReceipts(events, exchange, start = 0, end = Infinity) {
  if (!Array.isArray(events) || events.length > MAX_FUNDING_EVENTS * 2) throw new Error('Invalid funding events');
  const result = new Map();
  for (const item of events) {
    const time = timeOf(item?.time);
    if (!item || item.exchange !== exchange || !SYMBOLS.includes(item.symbol) || item.currency !== 'USDT' || typeof item.id !== 'string' || !item.id || item.id.length > 250 || /[\u0000-\u001f]/.test(item.id) || time === null || time < start || time >= end) throw new Error('Invalid funding receipt');
    const row = { id: item.id, exchange, symbol: item.symbol, time: iso(time), amount: decimal(item.amount), currency: 'USDT' };
    const previous = result.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting funding receipt');
    result.set(row.id, row);
    if (result.size > MAX_FUNDING_EVENTS) throw new Error('Invalid funding event count');
  }
  return [...result.values()].sort((a, b) => timeOf(a.time) - timeOf(b.time) || a.id.localeCompare(b.id));
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
    return { ...fallback, positions: { ...positions, lastAttemptAt: safeStamp(value.positions.lastAttemptAt), diagnostic: positionsDiagnostic, error: formatTradingDiagnostic(positionsDiagnostic) || (value.positions.error ? '上次仓位读取失败，请刷新重试' : null) },
      funding: { events, coverage, fetchedAt: safeStamp(value.funding.fetchedAt), lastAttemptAt: safeStamp(value.funding.lastAttemptAt),
        requestedEnd: Number.isSafeInteger(value.funding.requestedEnd) ? value.funding.requestedEnd : null, diagnostic: fundingDiagnostic, error: formatTradingDiagnostic(fundingDiagnostic) || (value.funding.error ? '上次资金费读取未完成，请刷新重试' : null) } };
  } catch {
    fallback.positions.error = fallback.funding.error = '本地交易缓存无效，请刷新重新读取';
    return fallback;
  }
}
function readState(connected, data, now, staleMs) {
  if (!connected) return 'unconfigured';
  if (!data.fetchedAt) return data.error ? 'error' : 'loading';
  return data.error || now - timeOf(data.fetchedAt) > staleMs ? 'stale' : 'live';
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
export function createTrading({ db, encrypt, decrypt, clientFactory = createTradingExchangeClient, now = Date.now, intervalMs = 1000, taskTimeoutMs = 60000, validationTimeoutMs = 35000 } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec("CREATE TABLE IF NOT EXISTS trading_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, verified_at TEXT, snapshot TEXT, account_mode TEXT NOT NULL DEFAULT 'standard')");
    if (!db.prepare('PRAGMA table_info(trading_accounts)').all().some(column => column.name === 'account_mode')) {
      db.exec("ALTER TABLE trading_accounts ADD COLUMN account_mode TEXT NOT NULL DEFAULT 'standard'; UPDATE trading_accounts SET account_mode='unified' WHERE exchange='bybit'");
    }
    for (const exchange of EXCHANGES) db.prepare('INSERT OR IGNORE INTO trading_accounts(exchange,account_mode) VALUES (?,?)').run(exchange, accountModeOf(exchange));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const rowFor = exchange => db.prepare('SELECT exchange,revision,credentials,verified_at,account_mode FROM trading_accounts WHERE exchange=?').get(exchangeOf(exchange));
  const storedRows = db.prepare('SELECT * FROM trading_accounts ORDER BY exchange').all();
  const cache = new Map(storedRows.map(row => [row.exchange, parseSnapshot(row)]));
  const hash = value => createHash('sha256').update(value || '').digest('hex');
  const fundingHash = funding => hash(JSON.stringify([funding.fetchedAt, funding.requestedEnd, funding.events, funding.coverage]));
  const snapshotHashes = new Map(EXCHANGES.map(exchange => [exchange, fundingHash(cache.get(exchange).funding)]));
  const pnl = createTradingPnl(db);
  const entriesFor = () => EXCHANGES.map(exchange => ({ row: rowFor(exchange), snapshot: cache.get(exchange) }));
  const clients = new Map(EXCHANGES.map(exchange => [exchange, clientFactory(exchange)]));
  const jobs = new Map(), validations = new Map();
  db.exec('CREATE TABLE IF NOT EXISTS trading_views (days INTEGER PRIMARY KEY, version INTEGER NOT NULL, source_key TEXT NOT NULL, json TEXT NOT NULL)');
  let views = new Map(), viewsDirty = false, viewTimer = null;
  let closed = false;
  let fundingBatchEnd = Math.max(0, ...EXCHANGES.map(exchange => cache.get(exchange).funding.requestedEnd || 0));
  function write(exchange, revision, change) {
    if (closed || rowFor(exchange).revision !== revision) return false;
    const next = change(cache.get(exchange));
    const serialized = JSON.stringify(next);
    if (!db.prepare('UPDATE trading_accounts SET snapshot=? WHERE exchange=? AND revision=?').run(serialized, exchange, revision).changes) return false;
    const previous = cache.get(exchange);
    cache.set(exchange, next);
    if (previous.funding.events !== next.funding.events || previous.funding.coverage !== next.funding.coverage || previous.funding.requestedEnd !== next.funding.requestedEnd) snapshotHashes.set(exchange, fundingHash(next.funding));
    if (previous.funding.events !== next.funding.events || previous.funding.coverage !== next.funding.coverage) invalidateViews();
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
    for (const [key, job] of jobs) if (key.startsWith(`${exchange}:`)) { job.controller.abort(); jobs.delete(key); }
  }
  function privateCredentials(row) {
    const value = decrypt(row.credentials);
    if (!value || value.exchange !== row.exchange) throw new Error('Invalid credential identity');
    return credentialsOf(value);
  }
  function run(exchange, kind, { force = false, end = now() } = {}) {
    if (closed) return Promise.resolve();
    const row = rowFor(exchange), key = `${exchange}:${kind}`;
    if (!row.credentials) return Promise.resolve();
    if (jobs.has(key)) return jobs.get(key).promise;
    const previous = cache.get(exchange)[kind];
    const newFundingBatch = kind === 'funding' && (previous.requestedEnd || 0) < end;
    const cooldown = force || newFundingBatch ? 5000 : kind === 'positions' ? POSITION_INTERVAL : FUNDING_INTERVAL;
    if (previous.lastAttemptAt && now() - timeOf(previous.lastAttemptAt) < cooldown) return Promise.resolve();
    const controller = new AbortController();
    const start = kind === 'funding' ? fundingStart(previous, end) : null;
    const saveFunding = (result, progress = false) => {
      if (controller.signal.aborted || closed || rowFor(exchange).revision !== row.revision) return;
      if (timeOf(result?.fetchedAt) === null || timeOf(result.fetchedAt) > now() + 60000 || typeof result.complete !== 'boolean' || !Array.isArray(result.coverage)) throw new Error('Invalid funding response');
      const added = normalizeReceipts(result.events, exchange, start, end), incomingCoverage = mergeCoverage(result.coverage);
      if (incomingCoverage.some(item => item.start < start || item.end > end) || result.complete && !covered(incomingCoverage, start, end)) throw new Error('Invalid funding coverage');
      const diagnostic = progress || result.complete ? null : normalizeTradingDiagnostic(result.diagnostic);
      write(exchange, row.revision, snapshot => {
        const events = normalizeReceipts([...snapshot.funding.events.filter(item => timeOf(item.time) >= end - 31 * DAY), ...added], exchange);
        const coverage = mergeCoverage([...snapshot.funding.coverage, ...incomingCoverage]).filter(item => item.end > end - 31 * DAY).map(item => ({ start: Math.max(item.start, end - 31 * DAY), end: item.end }));
        return { ...snapshot, funding: { ...snapshot.funding, events, coverage, fetchedAt: result.fetchedAt, diagnostic,
          error: progress || result.complete ? null : formatTradingDiagnostic(diagnostic) || '资金费记录未取全，当前仅显示已获取记录，请刷新重试' } };
      });
    };
    write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], lastAttemptAt: iso(now()), ...(kind === 'funding' ? { requestedEnd: end } : {}) } }));
    const promise = (async () => {
      try {
        const credentials = privateCredentials(row), accountMode = accountModeOf(exchange, row.account_mode);
        const result = await deadline(controller, taskTimeoutMs, signal => kind === 'positions' ? clients.get(exchange).positions(credentials, { signal, accountMode }) : clients.get(exchange).funding(credentials, { start, end, signal, accountMode, onProgress: result => saveFunding(result, true) }));
        if (controller.signal.aborted || closed || rowFor(exchange).revision !== row.revision) return;
        if (kind === 'positions') {
          const value = normalizePositions(result, exchange, now());
          write(exchange, row.revision, snapshot => ({ ...snapshot, positions: { ...snapshot.positions, ...value, error: null, diagnostic: null } }));
        } else {
          saveFunding(result);
        }
      } catch (error) {
        if (closed || rowFor(exchange).revision !== row.revision || controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
        const diagnostic = normalizeTradingDiagnostic(error?.diagnostic) || normalizeTradingDiagnostic({ version: 1, exchange, accountMode: row.account_mode, operation: kind, code: error?.name === 'TimeoutError' ? 'timeout' : 'upstream' });
        write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], diagnostic, error: formatTradingDiagnostic(diagnostic) || safeError(error) } }));
      }
    })().finally(() => { if (jobs.get(key)?.promise === promise) jobs.delete(key); });
    jobs.set(key, { controller, promise }); return promise;
  }
  function refresh({ force = false } = {}) {
    const current = now();
    if (!fundingBatchEnd || current - fundingBatchEnd >= (force ? 5000 : FUNDING_INTERVAL)) fundingBatchEnd = current;
    const positions = Promise.allSettled(EXCHANGES.map(exchange => run(exchange, 'positions', { force, end: current }))).then(() => { if (!closed && pnl.record(entriesFor(), now())) invalidateViews(); });
    return Promise.allSettled([positions, ...EXCHANGES.map(exchange => run(exchange, 'funding', { force, end: fundingBatchEnd }))]).then(result => { if (!closed) flushViews(); return result; });
  }
  function buildState(days = 7) {
    if (![7, 30].includes(days)) throw new TradingError(400, '资金费区间仅支持 7 天或 30 天');
    const current = now();
    const entries = EXCHANGES.map(exchange => ({ row: rowFor(exchange), snapshot: cache.get(exchange) }));
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
          complete: fundingState === 'live' && covered(snapshot.funding.coverage, start, end) } };
    });
    const events = entries.filter(({ row }) => row.credentials).flatMap(({ snapshot }) => snapshot.funding.events).filter(item => timeOf(item.time) >= start && timeOf(item.time) < end).sort((a, b) => timeOf(b.time) - timeOf(a.time) || a.id.localeCompare(b.id));
    const complete = accounts.every(account => account.funding.complete);
    const totals = cashTotals(events, complete);
    const legs = EXCHANGES.flatMap(exchange => SYMBOLS.map(symbol => {
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
      accounts, legs, structure: structure(legs), funding: { complete, ...totals, currency: 'USDT', events, daily }, pnl: pnl.read(entries, start, current) };
  }
  function sourceKey() {
    const entries = entriesFor();
    return JSON.stringify([entries.map(({ row }) => [row.exchange, row.revision, !!row.credentials, snapshotHashes.get(row.exchange)]), pnl.sourceKey(entries)]);
  }
  function invalidateViews() {
    viewsDirty = true;
    if (closed || viewTimer) return;
    // Coalesce partial ledger windows and independent account completions. This
    // timer only calculates local data; no HTTP reader triggers or awaits it.
    viewTimer = setTimeout(() => { viewTimer = null; try { flushViews(); } catch { if (!closed) invalidateViews(); } }, 750);
    viewTimer.unref?.();
  }
  function flushViews() {
    if (closed || !viewsDirty) return;
    clearTimeout(viewTimer); viewTimer = null;
    const key = sourceKey();
    const next = new Map([7, 30].map(days => [days, buildState(days)]));
    if (key !== sourceKey()) { invalidateViews(); return; }
    db.exec('BEGIN IMMEDIATE');
    try {
      const save = db.prepare('INSERT INTO trading_views(days,version,source_key,json) VALUES (?,?,?,?) ON CONFLICT(days) DO UPDATE SET version=excluded.version,source_key=excluded.source_key,json=excluded.json');
      for (const [days, value] of next) save.run(days, TRADING_VIEW_VERSION, key, packTradingView(value));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    views = next; viewsDirty = false;
  }
  function resetViews() {
    views.clear();
    db.prepare('DELETE FROM trading_views').run();
    invalidateViews(); flushViews();
  }
  function restoreViews() {
    const key = sourceKey(), restored = new Map();
    for (const days of [7, 30]) {
      const saved = db.prepare('SELECT * FROM trading_views WHERE days=?').get(days);
      if (!saved || saved.version !== TRADING_VIEW_VERSION || saved.source_key !== key) return false;
      try {
        const value = unpackTradingView(saved.json, days, now());
        const start = timeOf(value.period.start), end = timeOf(value.period.end);
        value.funding.events = entriesFor().filter(({ row }) => row.credentials).flatMap(({ snapshot }) => snapshot.funding.events)
          .filter(event => timeOf(event.time) >= start && timeOf(event.time) < end).sort((a, b) => timeOf(b.time) - timeOf(a.time) || a.id.localeCompare(b.id));
        restored.set(days, value);
      } catch { return false; }
    }
    views = restored; return true;
  }
  function state(days = 7, { page } = {}) {
    if (![7, 30].includes(days)) throw new TradingError(400, '资金费区间仅支持 7 天或 30 天');
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0 || page > 1999)) throw new TradingError(400, '流水页码无效');
    const current = now(), saved = views.get(days);
    // All history scans and monetary aggregation happened before publication.
    // Only bounded account freshness, four positions and one ledger slice remain.
    const accounts = entriesFor().map(({ row, snapshot }) => {
      const connected = !!row.credentials;
      const stored = saved.accounts.find(account => account.exchange === row.exchange).funding;
      const funding = { ...stored, error: snapshot.funding.error };
      const fundingState = readState(connected, funding, current, FUNDING_STALE);
      return { exchange: row.exchange, name: NAMES[row.exchange], accountMode: row.account_mode, connected, revision: row.revision, verifiedAt: row.verified_at,
        refreshing: [...jobs.keys()].some(key => key.startsWith(`${row.exchange}:`)),
        positions: { state: readState(connected, snapshot.positions, current, POSITION_STALE), fetchedAt: snapshot.positions.fetchedAt, error: snapshot.positions.error },
        funding: { ...funding, state: fundingState, complete: stored.complete && fundingState === 'live' } };
    });
    const legs = EXCHANGES.flatMap(exchange => SYMBOLS.map(symbol => {
      const account = accounts.find(account => account.exchange === exchange), snapshot = cache.get(exchange);
      const positions = account.connected ? snapshot.positions.rows.filter(row => row.symbol === symbol) : [];
      const stored = saved.legs.find(leg => leg.id === `${exchange}:${symbol}`), known = !!account.positions.fetchedAt;
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol === 'CLUSDT' ? 'CL · WTI' : 'BZ · 布伦特', state: account.positions.state,
        fetchedAt: account.positions.fetchedAt, positions, grossNotional: known ? sumOrUnknown(positions, 'notional') : null,
        netNotional: known ? sumOrUnknown(positions, 'notional', true) : null, unrealizedPnl: known ? sumOrUnknown(positions, 'unrealizedPnl') : null,
        fundingNet: !account.funding.complete && !stored.fundingReceiptCount ? null : stored.fundingNet, fundingComplete: account.funding.complete };
    }));
    const complete = accounts.every(account => account.funding.complete), events = saved.funding.events;
    const totals = !complete && !events.length ? { income: null, expense: null, net: null } : { income: saved.funding.income, expense: saved.funding.expense, net: saved.funding.net };
    const allFundingFresh = accounts.every(account => account.funding.state === 'live');
    const daily = saved.funding.daily.map(({ receiptCount, ...day }) => {
      const complete = day.complete && allFundingFresh;
      return { ...day, complete, ...(!complete && !receiptCount ? { income: null, expense: null, net: null } : {}) };
    });
    const historical = saved.pnl, last = historical.latest;
    const expired = last && current - last.time > POSITION_STALE && (last.unrealizedPnl !== null || last.totalPnl !== null);
    const latest = expired ? { time: current, unrealizedPnl: null, fundingPnl: null, totalPnl: null } : last;
    const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE)), selected = Math.min(page ?? 0, pages - 1);
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: saved.generatedAt,
      period: saved.period, accounts, legs, structure: structure(legs),
      funding: { complete, ...totals, currency: 'USDT', daily, events: page === undefined ? events : events.slice(selected * PAGE_SIZE, (selected + 1) * PAGE_SIZE), pagination: { page: selected, pageSize: PAGE_SIZE, total: events.length, pages } },
      pnl: { ...historical, end: current, points: expired ? [...historical.points, latest] : historical.points, latest, status: expired ? 'incomplete' : historical.status },
      cache: { builtAt: saved.generatedAt, servedAt: iso(current), rebuilding: viewsDirty },
    };
  }
  async function connect(exchange, body, { credentialReader, beforeSave, signal: externalSignal, timeoutMs = validationTimeoutMs } = {}) {
    exchangeOf(exchange); const revision = revisionOf(body.revision);
    const accountMode = accountModeOf(exchange, body.accountMode);
    let credentials = credentialReader ? null : credentialsOf(body);
    if (closed) throw new TradingError(503, '交易模块正在关闭');
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    if (validations.has(exchange)) throw new TradingError(409, '此交易所正在验证连接，请稍候');
    const controller = new AbortController(); validations.set(exchange, controller);
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await deadline(controller, timeoutMs, async signal => {
        if (credentialReader) credentials = credentialsOf(await credentialReader(signal));
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
      const saved = db.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=?,account_mode=?,verified_at=?,snapshot=? WHERE exchange=? AND revision=?').run(encrypted, accountMode, iso(now()), serialized, exchange, revision);
      if (!saved.changes) throw new TradingError(409, '连接已被更新，本次验证结果未保存');
      cancel(exchange); cache.set(exchange, snapshot);
      snapshotHashes.set(exchange, fundingHash(snapshot.funding));
      pnl.record(entriesFor(), now());
      resetViews();
      if (!fundingBatchEnd || now() - fundingBatchEnd >= FUNDING_INTERVAL) fundingBatchEnd = now();
      void run(exchange, 'funding', { end: fundingBatchEnd }).catch(() => {});
    } catch (error) {
      if (error instanceof TradingError) throw error;
      throw new TradingError(400, controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError' ? '连接验证已取消' : safeError(error));
    } finally { externalSignal?.removeEventListener('abort', abort); if (validations.get(exchange) === controller) validations.delete(exchange); }
  }
  function disconnect(exchange, revision) {
    exchangeOf(exchange); revisionOf(revision);
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    db.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=NULL,verified_at=NULL,snapshot=NULL WHERE exchange=? AND revision=?').run(exchange, revision);
    validations.get(exchange)?.abort(); cancel(exchange); cache.set(exchange, emptySnapshot(exchange));
    snapshotHashes.set(exchange, fundingHash(cache.get(exchange).funding)); resetViews();
  }
  if (!restoreViews()) { viewsDirty = true; flushViews(); }
  const timer = intervalMs > 0 ? setInterval(() => { if (!closed) void refresh(); }, intervalMs) : null; timer?.unref();
  const first = intervalMs > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();
  return { state, refresh, connect, disconnect,
    async close() { closed = true; clearInterval(timer); clearTimeout(first); clearTimeout(viewTimer); for (const controller of validations.values()) controller.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); jobs.clear(); validations.clear(); },
  };
}
