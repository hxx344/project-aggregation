import { createHash, randomUUID } from 'node:crypto';
import { createExecutionExchangeClient, ExecutionExchangeError, MAX_STRATEGY_WINDOW } from './trading-execution-exchanges.mjs';
import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';
import { ExecutionError, WaitError, StaleMarketError, ExternalOrdersError, EXECUTION_EXCHANGES, QUOTE_MAX_AGE, exactKeys, normalizeIntent, buildPlan, normalizeMarket, checkPosition, currentPosition, ensureNoExternalOrders, checkChildQuantity, checkContract, stopReached, subtract, positionSide, legOrderType, notional } from './trading-execution-plan.mjs';
import { TRADING_NAMES, EXECUTION_MARKETS, EXECUTION_VENUE_SYMBOLS } from './trading-markets.mjs';
import { orderPrice, stepDecimals } from './trading-hyperliquid-execution.mjs';
import { orderPrice as rhLighterOrderPrice, RH_LIGHTER_TX_EXPIRES_MS } from './trading-rh-lighter-execution.mjs';
import { createStatementCache } from './db-cache.mjs';
import { accountKey } from './execution/account-writer.mjs';
import { EXECUTION_CALL_TIMEOUT_MS, FINAL_EXECUTION as FINAL, UNFINISHED_EXECUTION_JOB_SQL } from './control/execution-jobs.mjs';
import { immediate } from './control/schema.mjs';
import { isSqliteBusy } from './sqlite-writes.mjs';
import { evaluateRule, boundsFor, SPREADS } from './trading-auto.mjs';
import { REDUCTION_RISK_MAX_AGE_MS, normalizeReductionConfig, readReductionRisk, reductionQuantities, reductionIntent, checkReductionDuration } from './trading-reduction-plan.mjs';

const iso = time => new Date(time).toISOString();
const ACTIVE = new Set(['queued', 'running', 'stopping']);
const PREVIEW_TTL = 30_000, LEASE_TTL = 60_000;
// Binance rejects signed requests older than recvWindow (5s), OKX rejects
// timestamps older than 30s and Hyperliquid actions carry expiresAfter = nonce
// + 30s, so after the call deadline plus this margin an unanswered create can
// no longer be accepted by any venue.
const CREATE_ARRIVAL_MARGIN_MS = 60_000, CREATE_OBSERVE_MS = 120_000, ABSENT_CREATE_CHECKS = 2;
const ATTENTION_RETRY_MS = 15_000, CANCEL_RETRY_MS = 10_000, CANCEL_ATTEMPTS = 5, CANCEL_DEFERRALS = 30, MISMATCH_RECHECK_MS = 60_000;
// A status read that failed in transport (timeout, connection, 5xx, rate limit)
// says nothing about the order. Nothing is amended, cancelled or sent while it
// is unread, so a resting hedge leg is kept for this window before the job
// pauses and cancels it (which would leave the filled sibling unhedged). Both
// bounds apply, so a read that hangs until the call deadline still gets retries.
const READ_RETRY_MS = 20_000, READ_RETRY_ATTEMPTS = 3;
// Only a fully settled previous reduction batch may have a lagging position
// projection. Initial read plus three retries, all inside this durable window.
const POSITION_READ_WINDOW_MS = 20_000, POSITION_READ_ATTEMPTS = 4, POSITION_READ_INTERVAL_MS = 1000;
// An explicit Lighter read cooldown can exceed the generic transport window.
// Wait without polling, then re-enter all normal checks. Three recovery tries
// and a fixed three-minute window bound the entire streak, not each endpoint.
const RATE_READ_RETRY_MS = 10_000, RATE_READ_WINDOW_MS = 180_000, RATE_READ_RETRIES = 3;
// Binance -1003, Bybit 10006 and OKX 50011 are request-rate refusals.
const RATE_LIMIT_CODES = new Set([-1003, 10006, 50011]);
// Bybit strategy times come from the venue clock; allow the adapter's clock tolerance.
const VENUE_CLOCK_TOLERANCE_MS = 300_000;
// The client rounds the window out to whole seconds; stay inside its limit after rounding.
const STRATEGY_QUERY_STEP_MS = MAX_STRATEGY_WINDOW - 1000;
// Connecting reads the original oil scope so a newer market cannot block it; previews read their own symbols.
// Hyperliquid and Lighter RH list no oil contract, so their connections read their own contracts.
const connectSymbols = exchange => WALLET_VENUES.has(exchange) ? EXECUTION_VENUE_SYMBOLS[exchange] : EXECUTION_MARKETS.oil.symbols;
const DEFAULT_MODES = Object.freeze({ binance: 'standard', bybit: 'unified', okx: 'cross', hyperliquid: 'agent', 'rh-lighter': 'api-key' });
// Wallet venues rest chase legs at an explicit post-only price.
const WALLET_VENUES = new Set(['hyperliquid', 'rh-lighter']);
// Preserve the minimum spacing even though Lighter RH reprices the original order.
const RH_LIGHTER_MIN_REPRICE_MS = 5000;
// A Lighter RH create refused before it left this process (local rate limit,
// venue cooldown, a failed pre-send read) or by the venue firewall did not
// reach the order book. It settles as rejected and the leg is re-planned on a
// later tick, at least this far apart and not before the cooldown ends, at most
// this many times in a row (L084): only a send that reached the venue resets it.
const SEND_DEFER_MS = 10_000, MAX_SEND_DEFER_MS = 120_000, CREATE_DEFERRALS = 30;
const DEFERRABLE_CODES = new Set(['timeout', 'transport', 'upstream', 'aborted']);
// Finished jobs are history. Every other status, including a missing or
// unknown one, is unfinished and always read in full for recovery.
const JOB_STATUS = "json_extract(json,'$.status')", JOB_CREATED = "json_extract(json,'$.createdAt')";
const FINAL_SQL = [...FINAL].map(status => `'${status}'`).join(',');
const UNFINISHED_JOB = UNFINISHED_EXECUTION_JOB_SQL, FINISHED_JOB = `${JOB_STATUS} IN (${FINAL_SQL})`;
const FINISHED_JOB_PAGE = 30;
// Automatic jobs send only from books received within this window of the send decision.
const AUTO_BOOK_WINDOW_MS = 1500;
// Only JSON true or 1 counts as settled here. Other truthy values and rows
// that are not strict JSON are indexed as unsettled, which costs a read but
// never skips them. This assumes rows the executor wrote with JSON.stringify:
// with duplicate settled keys SQLite takes the first and JSON.parse the last,
// which only a hand-edited row can contain.
const UNSETTLED_ORDER = "(CASE WHEN json_valid(json) THEN json_extract(json,'$.settled') END) IS NOT 1";
// The partial indexes read with INDEXED BY must have exactly these
// definitions: SQLite answers "no query solution" when an index of the same
// name has another condition, and IF NOT EXISTS keeps such an index. One can be
// left by another release (a later one that changed the condition, before a
// rollback to this one) or by a hand edit, so this code replaces any other
// definition of them (docs/hub-schema-inventory.md sections 5 and 6).
const READ_INDEXES = Object.freeze({
  execution_jobs_unfinished: `CREATE INDEX execution_jobs_unfinished ON execution_jobs(${JOB_CREATED}) WHERE ${UNFINISHED_JOB}`,
  execution_jobs_finished: `CREATE INDEX execution_jobs_finished ON execution_jobs(${JOB_CREATED}) WHERE ${FINISHED_JOB}`,
  execution_orders_unsettled: `CREATE INDEX execution_orders_unsettled ON execution_orders(job_id) WHERE ${UNSETTLED_ORDER}`,
});
const ifMissing = name => `${READ_INDEXES[name].replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')};`;
const JOB_INDEXES_SQL = ifMissing('execution_jobs_unfinished') + ifMissing('execution_jobs_finished');
const ORDER_INDEX_SQL = ifMissing('execution_orders_unsettled');
// SQLite stores the CREATE text without IF NOT EXISTS; whitespace is not significant.
const sameSql = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();
class NotSubmittedError extends ExecutionError { constructor(message) { super(409, message); } }
class PositionProjectionWait extends ExecutionError {}
class RateLimitedReadError extends ExecutionError {
  constructor(exchange, symbol, error) {
    super(502, `${TRADING_NAMES[exchange]} ${symbol}：${safeError(error)}`);
    this.retryAt = error.retryAt;
  }
}
const QUOTES_TTL_MS = 2000, QUOTE_TIMEOUT_MS = 6000;
const safeError = error => error instanceof ExecutionError || error instanceof ExecutionExchangeError ? error.message.slice(0, 220) : '交易所响应无法确认，请核对任务与交易所委托';
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const modeOf = (exchange, mode) => {
  if (!(exchange === 'binance' ? ['standard', 'portfolio-margin'] : exchange === 'okx' ? ['cross', 'isolated'] : exchange === 'hyperliquid' ? ['agent'] : exchange === 'rh-lighter' ? ['api-key'] : ['unified']).includes(mode)) throw new ExecutionError(400, '请选择正确的实盘账户模式');
  return mode;
};

/** Durable, explicit live execution. Read endpoints never submit exchange requests. */
export function createTradingExecution({ db, stmt, encrypt, decrypt, clientFactory = createExecutionExchangeClient, now = Date.now, intervalMs = 1000, callTimeoutMs = EXECUTION_CALL_TIMEOUT_MS, quoteTimeoutMs = QUOTE_TIMEOUT_MS, isSessionActive = () => true, accountWriter = null } = {}) {
  // If stmt is explicitly null, use raw db.prepare (for tests that mock db.prepare)
  // If stmt is undefined, create a cached version for production
  // If stmt is provided, use it
  if (stmt === undefined) stmt = createStatementCache(db);
  else if (stmt === null) stmt = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, account_mode TEXT NOT NULL, identity TEXT, key_label TEXT, verified_at TEXT, snapshot TEXT);
    CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    ${JOB_INDEXES_SQL}
    CREATE TABLE IF NOT EXISTS execution_orders (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_orders_job ON execution_orders(job_id);
    ${ORDER_INDEX_SQL}
    CREATE TABLE IF NOT EXISTS execution_previews (id TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL, json TEXT NOT NULL, consumed TEXT);
    CREATE INDEX IF NOT EXISTS idx_execution_previews_expires ON execution_previews(expires) WHERE consumed IS NULL;
    CREATE TABLE IF NOT EXISTS execution_requests (id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, job_id TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_locks (resource TEXT PRIMARY KEY, job_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_stop_requests (job_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL);
  `);
  // Replaces, under the write lock, each read index whose stored definition is
  // not this code's; a missing one is left to IF NOT EXISTS. Object names are
  // case-insensitive in SQLite, so the stored name is the one dropped. A
  // connection already in a transaction keeps the change inside it.
  const replaceChangedIndexes = () => {
    const stored = stmt.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND name=? COLLATE NOCASE");
    const changed = () => Object.entries(READ_INDEXES).map(([name, sql]) => [stored.get(name), sql]).filter(([row, sql]) => row && !sameSql(row.sql, sql));
    if (!changed().length) return;
    const replace = () => { for (const [row, sql] of changed()) db.exec(`DROP INDEX "${row.name.replaceAll('"', '""')}"; ${sql}`); };
    if (db.isTransaction) replace(); else immediate(db, replace);
  };
  // Only this replacement tolerates a busy database (later startup writes still
  // wait and may fail): an indexed read that the old definition cannot serve
  // retries it. One that still serves the query leaves it to the next start.
  try { replaceChangedIndexes(); } catch (error) { if (!isSqliteBusy(error)) throw error; }
  for (const exchange of EXECUTION_EXCHANGES) stmt.prepare('INSERT OR IGNORE INTO execution_accounts(exchange,account_mode) VALUES (?,?)').run(exchange, DEFAULT_MODES[exchange]);
  const owner = randomUUID(), clients = new Map(EXECUTION_EXCHANGES.map(exchange => [exchange, clientFactory(exchange)]));
  const pending = new Set(), controllers = new Set(), busyJobs = new Set(), connecting = new Set();
  const writerTickets = new Map(), verifiedAccounts = new Map(), protectionErrors = new Map(), recoveredWriterJobs = new Set();
  const attentionChecks = new Map();
  const readFailures = new Map();
  const marketFailures = new Map();
  const rateReadFailures = new Map();
  const externalWaits = new Map();
  let protectionReady = !accountWriter;
  let closed = false, closing = false, leader = false, heldLease = false, retired = false, ticking = null;
  function lostLease() {
    retired = true; leader = false;
    throw new ExecutionError(503, '执行服务已失去运行锁，请重启服务后核对任务');
  }
  const transaction = operation => immediate(db, operation);
  const accountRow = exchange => {
    if (!EXECUTION_EXCHANGES.includes(exchange)) throw new ExecutionError(404, '交易所不存在');
    return stmt.prepare('SELECT * FROM execution_accounts WHERE exchange=?').get(exchange);
  };
  // SQLite otherwise favours a rowid table scan to preserve insertion order,
  // evaluating JSON status across all history. INDEXED BY forces the partial
  // indexes; rowid ordering still keeps tick and restart processing stable.
  // An index dropped or redefined after startup is restored once per read.
  const indexedJobRows = (sql, ...args) => {
    const read = () => stmt.prepare(sql).all(...args);
    try { return read(); }
    catch (error) {
      if (!/^(no such index: execution_(jobs_unfinished|jobs_finished|orders_unsettled)|no query solution)$/.test(error?.message)) throw error;
      replaceChangedIndexes();
      db.exec(JOB_INDEXES_SQL + ORDER_INDEX_SQL);
      return read();
    }
  };
  const unfinishedJobs = () => indexedJobRows(`SELECT json FROM execution_jobs INDEXED BY execution_jobs_unfinished WHERE ${UNFINISHED_JOB} ORDER BY rowid`).map(row => JSON.parse(row.json));
  const finishedJobs = limit => indexedJobRows(`SELECT json FROM execution_jobs INDEXED BY execution_jobs_finished WHERE ${FINISHED_JOB} ORDER BY ${JOB_CREATED} DESC, rowid LIMIT ?`, limit).map(row => JSON.parse(row.json));
  const jobFor = id => { const row = stmt.prepare('SELECT json FROM execution_jobs WHERE id=?').get(id); if (!row) throw new ExecutionError(404, '执行任务不存在'); return JSON.parse(row.json); };
  const accountIdentity = (exchange, id) => id ? { authority: exchange, environment: 'mainnet', accountId: id } : null;
  const jobExchanges = job => [...new Set([...(job.totals || []), ...job.plan.legs].map(leg => leg.exchange))];
  function bindAccount(exchange, revision, identity) {
    if (!accountWriter) return;
    accountWriter.bind(`hub:${exchange}`, accountIdentity(exchange, identity), revision, { authority: exchange, environment: 'mainnet' });
    if (identity) { verifiedAccounts.set(exchange, { revision, identity }); protectionErrors.delete(exchange); }
    else { verifiedAccounts.delete(exchange); protectionErrors.set(exchange, '账户真实身份尚未核验，仅允许读取'); }
  }
  function protectJob(job, replace = false) {
    if (!accountWriter) return null;
    if (!protectionReady) throw new NotSubmittedError('账户写入保护正在恢复，请稍后核对');
    let ticket = replace ? null : writerTickets.get(job.id);
    if (!ticket) {
      const identities = jobExchanges(job).map(exchange => {
        const row = accountRow(exchange), verified = verifiedAccounts.get(exchange);
        if (!verified || verified.revision !== row.revision || verified.identity !== row.identity) throw new NotSubmittedError('账户真实身份尚未核验，仅允许读取与本地停止');
        return accountIdentity(exchange, row.identity);
      });
      try { ticket = accountWriter.claim(identities); }
      catch (error) { const blocked = new NotSubmittedError('账户已由其他模块使用或写入所有权无法确认，请先核对账户保护状态'); blocked.protectionCode = error.code; throw blocked; }
      writerTickets.set(job.id, ticket);
    }
    try { accountWriter.assertOwned(ticket, callTimeoutMs); }
    catch { throw new NotSubmittedError('账户写入所有权或连接版本已变化，本次操作未获准发送'); }
    return ticket;
  }
  function assertJob(id) {
    if (!accountWriter || !writerTickets.has(id)) return;
    accountWriter.assertOwned(writerTickets.get(id), 0);
  }
  function prepareWrite(order, action, payload = {}) {
    if (!accountWriter) return null;
    const ticket = protectJob(jobFor(order.jobId));
    const suffix = action === 'amend' ? `:${order.amendCount}` : action === 'cancel' ? `:${order.cancelAttempt || 0}` : '';
    const operationId = `hub:${action}:${order.localId}${suffix}`;
    if (action === 'cancel' && order.writerOperation?.operationId === operationId && ['sending', 'unknown', 'confirmed'].includes(order.writerOperation.state)) return { skip: true, operationId, ticket };
    const job = jobFor(order.jobId);
    const semantic = { groupId: `hub:${job.id}:${job.phase}:${job.batchIndex}:${action}`, action, exchange: order.exchange, symbol: order.spec.symbol, clientId: order.spec.clientId, remoteId: action === 'create' ? null : order.remoteId,
      ...(['amend', 'cancel'].includes(action) ? { intentAction: action, intentTarget: { accountKey: accountKey(accountIdentity(order.exchange, accountRow(order.exchange).identity)), symbol: order.spec.symbol, clientOrderId: order.spec.clientId } } : {}), ...payload };
    const previousOperation = order.writerOperation, previousDispatch = order.writerDispatch;
    order.writerOperation = { operationId, action, payload: semantic, state: 'prepared' };
    order.writerDispatch = 'prepared'; saveOrder(order);
    let operation;
    try { operation = accountWriter.prepare(ticket, operationId, semantic); }
    catch (error) {
      order.writerOperation = previousOperation; order.writerDispatch = previousDispatch; saveOrder(order);
      if (action === 'cancel' && ['ALREADY_SUBMITTED', 'OPERATION_UNRESOLVED', 'ALREADY_REJECTED'].includes(error.code)) return { skip: true, operationId, ticket };
      throw new NotSubmittedError('账户存在未核对操作或重复意图，本次操作未获准发送');
    }
    order.writerDispatch = 'sending'; order.writerOperation.state = 'sending';
    try { saveOrder(order); }
    catch {
      // No transport has been called. Keep the durable prepared identity even
      // if this second private-store write fails, and settle it when possible.
      order.writerDispatch = 'prepared'; order.writerOperation.state = 'prepared';
      try { finishWrite(operation, 'rejected', order); } catch { /* Prepared evidence survives for restart recovery. */ }
      throw new NotSubmittedError('发送前状态保存失败，本次操作未发送');
    }
    return operation;
  }
  function finishWrite(operation, outcome, order) {
    if (operation && !operation.skip) {
      if (order?.writerOperation?.operationId === operation.operationId) { order.writerOperation.state = outcome; order.writerDispatch = outcome; }
      // Durable adapter evidence precedes releasing the shared operation. A
      // crash between these stores can be recovered without guessing a result.
      saveOrder(order);
      accountWriter.finish(operation, outcome);
    }
  }
  const stopRequested = id => !!stmt.prepare('SELECT 1 FROM execution_stop_requests WHERE job_id=?').get(id);
  function recoverWriterOperation(order, ticket) {
    if (!accountWriter) return;
    let operation = order.writerOperation;
    if (!operation && (order.unknown || order.amendPending || order.cancelRequestedAt)) {
      const action = order.amendPending ? 'legacy-amend' : order.cancelRequestedAt ? 'legacy-cancel' : 'create';
      const operationId = action === 'create' ? `hub:create:${order.localId}` : `hub:${action}:${order.localId}`;
      const payload = { action, exchange: order.exchange, symbol: order.spec.symbol, clientId: order.spec.clientId, remoteId: action === 'create' ? null : order.remoteId,
        ...(action === 'legacy-amend' ? { intentAction: 'amend', intentTarget: { accountKey: accountKey(accountIdentity(order.exchange, accountRow(order.exchange).identity)), symbol: order.spec.symbol, clientOrderId: order.spec.clientId } } : {}) };
      operation = order.writerOperation = { operationId, action, payload, state: 'unknown' };
    }
    if (!operation) return;
    const imported = accountWriter.importUnknown(ticket, operation.operationId, operation.payload);
    if (order.writerDispatch === 'prepared' || operation.state === 'rejected' || imported.state === 'rejected') {
      accountWriter.resolve(operation.operationId, ticket, 'rejected'); operation.state = 'rejected';
      if (operation.action === 'create') Object.assign(order, { state: 'rejected', settled: true, unknown: false });
      // A recovered cancel keeps its sequence, send count and send time; the
      // next cancel takes a new sequence and still honours the spacing.
      else if (!(order.exchange === 'rh-lighter' && order.amendPending && operation.action === 'cancel')) { order.unknown = false; order.amendPending = false; }
    } else if (operation.state === 'confirmed' || order.settled) accountWriter.resolve(operation.operationId, ticket);
    saveOrder(order);
  }
  function protectAndRecover(job) {
    const ticket = protectJob(job);
    if (accountWriter && !recoveredWriterJobs.has(job.id)) {
      for (const order of orders(job.id)) recoverWriterOperation(order, ticket);
      recoveredWriterJobs.add(job.id);
    }
    return ticket;
  }
  // Recovery only needs unfinished jobs, jobs with an unsettled order, and jobs
  // whose order still owns a shared sending/unknown operation. That last set
  // includes finished jobs whose settled order recorded its result privately
  // before a crash left the shared operation open. Every hub operation id
  // embeds the order's localId (a UUID) as its third segment.
  function recoveryJobs(pendingOperationIds = []) {
    const ids = new Set(unfinishedJobs().map(job => job.id));
    for (const { job_id: jobId } of indexedJobRows(`SELECT DISTINCT job_id FROM execution_orders INDEXED BY execution_orders_unsettled WHERE ${UNSETTLED_ORDER}`)) ids.add(jobId);
    for (const operationId of pendingOperationIds) {
      const localId = operationId.split(':')[2], row = localId && stmt.prepare('SELECT job_id FROM execution_orders WHERE id=?').get(localId);
      if (row) ids.add(row.job_id);
    }
    return stmt.prepare('SELECT json FROM execution_jobs WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(JSON.stringify([...ids])).map(row => JSON.parse(row.json));
  }
  async function initializeProtection() {
    if (!accountWriter) return;
    const savedJobs = recoveryJobs();
    const legacyExchanges = new Set(savedJobs.flatMap(job => ACTIVE.has(job.status) || orders(job.id).some(order => !order.settled) ? jobExchanges(job) : []));
    const configured = EXECUTION_EXCHANGES.map(accountRow).filter(row => row.credentials);
    for (const row of EXECUTION_EXCHANGES.map(accountRow)) if (row.credentials || legacyExchanges.has(row.exchange)) bindAccount(row.exchange, row.revision, null);
    await Promise.all(configured.map(async row => {
      try {
        const ctx = context(row.exchange, row.revision);
        const value = await call(signal => ctx.client.verify(ctx.credentials, { accountMode: row.account_mode, signal, requireIdentity: true }));
        if (closed || accountRow(row.exchange).revision !== row.revision) return;
        if (row.identity && value.identity && row.identity !== value.identity) throw new Error('Changed account');
        if (value.identity) stmt.prepare('UPDATE execution_accounts SET identity=? WHERE exchange=? AND revision=?').run(value.identity, row.exchange, row.revision);
        bindAccount(row.exchange, row.revision, value.identity || null);
      } catch { protectionErrors.set(row.exchange, '账户真实身份尚未核验，仅允许读取与本地停止'); }
    }));
    protectionReady = true;
    const sharedPending = accountWriter.snapshot().operations.some(row => row.moduleId === 'hub' && ['sending', 'unknown'].includes(row.state));
    for (const job of recoveryJobs(sharedPending ? accountWriter.pendingOperationIds() : [])) if (ACTIVE.has(job.status) || orders(job.id).some(order => !order.settled) || sharedPending && orders(job.id).some(order => order.writerOperation)) {
      try {
        protectAndRecover(job);
        if (FINAL.has(job.status)) { writerTickets.delete(job.id); recoveredWriterJobs.delete(job.id); }
      } catch (error) {
        const identities = jobExchanges(job).flatMap(exchange => verifiedAccounts.has(exchange) ? [accountIdentity(exchange, accountRow(exchange).identity)] : []);
        if (identities.length && ['ACCOUNT_PINNED', 'OWNER_ALIVE'].includes(error.protectionCode)) { try { accountWriter.freeze(identities, 'legacy-conflict'); } catch { /* Unknown identities remain read-only. */ } }
      }
    }
  }
  const saveJob = job => {
    assertJob(job.id);
    job.updatedAt = iso(now());
    const result = stmt.prepare('INSERT INTO execution_jobs(id,json) SELECT ?,? WHERE EXISTS(SELECT 1 FROM execution_lease WHERE id=1 AND owner=? AND expires>?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job), owner, now());
    if (!result.changes) lostLease();
    return job;
  };
  const orders = jobId => stmt.prepare('SELECT json FROM execution_orders WHERE job_id=? ORDER BY rowid').all(jobId).map(row => JSON.parse(row.json));
  const saveOrder = order => {
    assertJob(order.jobId);
    const result = stmt.prepare('INSERT INTO execution_orders(id,job_id,json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM execution_lease WHERE id=1 AND owner=? AND expires>?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(order.localId, order.jobId, JSON.stringify(order), owner, now());
    if (!result.changes) lostLease();
  };
  const orderFor = id => { const row = stmt.prepare('SELECT json FROM execution_orders WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; };
  const event = (job, message) => { job.events.push({ time: iso(now()), message }); job.events = job.events.slice(-80); };
  const locked = exchange => !!stmt.prepare('SELECT 1 FROM execution_locks WHERE resource LIKE ? LIMIT 1').get(`${exchange}:%`);
  function pause(id, reason, target = 'paused') {
    const job = jobFor(id);
    if (FINAL.has(job.status)) return;
    job.status = 'stopping';
    job.stopTarget = job.stopTarget === 'stopped' ? 'stopped' : target;
    if (job.reason !== reason) event(job, reason);
    job.reason = reason; saveJob(job);
  }
  function acquire() {
    if (closed || retired) return false;
    const wasLeader = leader;
    leader = transaction(() => {
      const row = stmt.prepare('SELECT * FROM execution_lease WHERE id=1').get();
      // One instance owns at most one continuous lease. Never revive callbacks
      // from an earlier lease after another process has reconciled their intents.
      if (heldLease && (!row || row.owner !== owner || row.expires <= now())) { retired = true; return false; }
      if (row && row.owner !== owner && row.expires > now()) return false;
      stmt.prepare('INSERT INTO execution_lease(id,owner,expires) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(owner, now() + LEASE_TTL);
      heldLease = true;
      if (!wasLeader || (row && row.expires <= now())) {
        for (const job of unfinishedJobs()) if (ACTIVE.has(job.status)) pause(job.id, '服务恢复：已暂停后续下单，正在核对并撤销未结束委托');
        for (const { job_id: jobId } of stmt.prepare('SELECT DISTINCT job_id FROM execution_locks').all()) {
          const row = stmt.prepare('SELECT json FROM execution_jobs WHERE id=?').get(jobId);
          if (row && FINAL.has(JSON.parse(row.json).status)) stmt.prepare('DELETE FROM execution_locks WHERE job_id=?').run(jobId);
        }
      }
      return true;
    });
    return leader;
  }
  function requireLease() {
    const row = stmt.prepare('SELECT * FROM execution_lease WHERE id=1').get();
    if (retired || heldLease && (!row || row.owner !== owner || row.expires <= now())) lostLease();
    if (closed || !leader || row?.owner !== owner || row.expires <= now()) throw new ExecutionError(503, '执行服务暂未取得运行锁，请稍后重试');
  }
  function writable() { if (closing) throw new ExecutionError(503, '执行服务正在停止'); requireLease(); }
  function checkSession(session) { if (session !== undefined && !isSessionActive(session)) throw new ExecutionError(401, '登录已失效，请重新登录'); }
  function connection(row) {
    return { exchange: row.exchange, connected: !!row.credentials, revision: row.revision, accountMode: row.account_mode,
      identity: row.identity, keyLabel: row.key_label, verifiedAt: row.verified_at, locked: locked(row.exchange),
      ...(accountWriter ? { writeProtection: { identityVerified: verifiedAccounts.get(row.exchange)?.revision === row.revision, reason: accountWriter.retired ? '账户写入所有权已失效，仅允许读取与本地停止；请重启服务后核对任务' : protectionErrors.get(row.exchange) || null } } : {}) };
  }
  function context(exchange, revision) {
    const row = accountRow(exchange);
    if (!row.credentials || (revision !== undefined && row.revision !== revision)) throw new ExecutionError(409, '实盘连接已改变，请重新预览');
    const credentials = decrypt(row.credentials);
    if (!credentials || credentials.exchange !== exchange || credentials.purpose !== 'execution') throw new ExecutionError(503, '实盘凭据无法解密，请重新连接');
    const secrets = exchange === 'hyperliquid' ? { address: credentials.address, agentKey: credentials.agentKey }
      : exchange === 'rh-lighter' ? { address: credentials.address, accountIndex: credentials.accountIndex, apiKeyIndex: credentials.apiKeyIndex, apiKey: credentials.apiKey }
      : { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, ...(exchange === 'okx' ? { passphrase: credentials.passphrase } : {}) };
    return { row, credentials: secrets, client: clients.get(exchange), options: { accountMode: row.account_mode, beforeMutation: requireLease } };
  }
  // `outer` is the page request's signal for the calls a request makes itself
  // (account checks, previews); it ends them once the API stopped waiting.
  async function call(fn, outer) {
    if (outer?.aborted) throw new ExecutionError(503, '请求已取消，未执行');
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('Execution deadline', 'TimeoutError')), callTimeoutMs); timer.unref?.();
    const cancel = () => controller.abort(new DOMException('Request canceled', 'AbortError'));
    outer?.addEventListener('abort', cancel, { once: true });
    const promise = Promise.resolve().then(() => fn(controller.signal)); pending.add(promise);
    try { return await promise; }
    catch (error) { if (outer?.aborted) throw new ExecutionError(503, '请求已取消，未完成'); throw error; }
    finally { clearTimeout(timer); outer?.removeEventListener('abort', cancel); controllers.delete(controller); pending.delete(promise); }
  }
  const totalFilled = (all, legId, phase, batch) => addDecimals(all.filter(order => order.legId === legId && (phase === undefined || order.phase === phase) && (batch === undefined || order.batch === batch)).map(order => order.filledQuantity));
  function reductionPositionBaselines(job) {
    const baseline = (leg, phase) => ({ quantity: leg.currentQuantity, positionMode: leg.positionMode, phase });
    const positions = Object.fromEntries(job.totals.map(leg => [leg.id, baseline(leg, 0)]));
    Object.assign(positions, job.riskReduction?.positionBaselines);
    for (const leg of job.plan.legs) positions[leg.id] = baseline(leg, job.phase);
    return positions;
  }
  const unsettled = order => !order.settled;
  function publicJob(job) {
    const all = orders(job.id);
    return { id: job.id, market: job.plan.market ?? 'oil', preset: job.plan.preset, action: job.plan.action, status: job.status, ...(job.auto ? { auto: { ruleId: job.auto.ruleId, action: job.auto.action, ...(job.auto.unsent ? { unsent: true } : {}) } } : {}),
      createdAt: job.createdAt, updatedAt: job.updatedAt, deadlineAt: job.deadlineAt, batchIndex: job.batchIndex, batchCount: job.plan.batchCount,
      reason: job.reason, ...(stopRequested(job.id) ? { stopRequested: true } : {}), canResume: job.status === 'paused' && all.every(order => order.settled) && job.totals.some(leg => compareDecimals(totalFilled(all, leg.id), leg.quantity) < 0),
      legs: job.totals.map(leg => {
        const filledQuantity = totalFilled(all, leg.id), last = all.filter(order => order.legId === leg.id).at(-1);
        return { id: leg.id, exchange: leg.exchange, symbol: leg.symbol, side: leg.side, orderSide: leg.orderSide, quantity: leg.quantity, orderType: legOrderType(leg), stopPrice: leg.stopPrice ?? null,
          filledQuantity, remainingQuantity: subtract(leg.quantity, filledQuantity),
          currentOrder: last ? { id: last.remoteId, clientId: last.spec.clientId, kind: last.kind, state: last.state, lastCheckedAt: last.lastCheckedAt, price: last.price, filledQuantity: last.filledQuantity, unknown: last.unknown,
            ...(last.kind === 'strategy' && last.unknown && !last.remoteId ? { confirmAfter: iso(createSettledAt(last)) } : {}) } : null };
      }), events: job.events };
  }
  // A preview reads only its own symbols; keep the other symbols' last positions with their own read time.
  function mergeSnapshot(previous, account, symbols) {
    const at = iso(now()), covered = new Set(symbols);
    let old = null;
    try { old = previous ? JSON.parse(previous) : null; } catch { old = null; }
    const kept = old?.account?.positions?.filter(position => !covered.has(position.symbol)) ?? [];
    const symbolsAt = Object.fromEntries(kept.map(position => [position.symbol, old.symbolsAt?.[position.symbol] ?? old.at]));
    for (const symbol of symbols) symbolsAt[symbol] = at;
    return { at, symbolsAt, account: { ...account, positions: [...kept, ...account.positions] } };
  }
  function state(trackedJobId = null) {
    if (trackedJobId !== null && (typeof trackedJobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(trackedJobId))) throw new ExecutionError(400, '执行编号无效');
    const rows = EXECUTION_EXCHANGES.map(accountRow);
    const jobs = [...unfinishedJobs().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), ...finishedJobs(FINISHED_JOB_PAGE)];
    // A long-running job can finish behind newer history; its observer still needs the final receipt.
    if (trackedJobId && !jobs.some(job => job.id === trackedJobId)) jobs.push(jobFor(trackedJobId));
    return { generatedAt: iso(now()), connections: rows.map(connection), positions: rows.flatMap(row => {
      if (!row.snapshot) return [];
      const snapshot = JSON.parse(row.snapshot);
      return snapshot.account.positions.map(position => ({ exchange: row.exchange, ...position, fetchedAt: snapshot.symbolsAt?.[position.symbol] ?? snapshot.at }));
    }), jobs: jobs.map(publicJob) };
  }
  function checkAvailable(exchange, revision) {
    writable();
    if (!validRevision(revision) || accountRow(exchange).revision !== revision) throw new ExecutionError(409, '连接版本已改变，请刷新后重试');
    if (locked(exchange)) throw new ExecutionError(409, '该交易所有未结束任务，先停止并完成委托核对后再更换连接');
  }
  async function connect(exchange, body, session, { signal } = {}) {
    const wallet = exchange === 'hyperliquid', lighter = exchange === 'rh-lighter';
    exactKeys(body, ['revision', 'accountMode', ...(wallet ? ['address', 'agentKey'] : lighter ? ['address', 'accountIndex', 'apiKeyIndex', 'apiKey'] : ['apiKey', 'apiSecret']), ...(exchange === 'okx' ? ['passphrase'] : [])]); checkSession(session); checkAvailable(exchange, body.revision);
    const mode = modeOf(exchange, body.accountMode);
    const valid = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
    const index = (value, min, max) => { const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value; return Number.isSafeInteger(number) && number >= min && number <= max ? number : null; };
    if (wallet) {
      if (typeof body.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.address) || typeof body.agentKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.agentKey)) throw new ExecutionError(400, '请填写主账户地址（0x 开头 40 位）和 API 钱包私钥（0x 开头 64 位）');
    } else if (lighter) {
      const apiKeyIndex = index(body.apiKeyIndex, 4, 254);
      if (typeof body.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.address) || index(body.accountIndex, 1, Number.MAX_SAFE_INTEGER) === null || apiKeyIndex === null || apiKeyIndex === 157
        || typeof body.apiKey !== 'string' || !/^(?:0x)?[0-9a-fA-F]{80}$/.test(body.apiKey)) throw new ExecutionError(400, '请填写钱包地址（0x 开头 40 位）、账户索引、API Key 索引（4–254，157 除外）和 API 私钥（80 位十六进制）');
    } else if (!valid(body.apiKey) || !valid(body.apiSecret)) throw new ExecutionError(400, '请填写有效的 HMAC 实盘 API Key 和 Secret');
    if (exchange === 'okx' && (typeof body.passphrase !== 'string' || body.passphrase.length < 8 || body.passphrase.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(body.passphrase))) throw new ExecutionError(400, '请填写有效的 OKX Passphrase');
    if (connecting.has(exchange)) throw new ExecutionError(409, '此交易所正在验证实盘连接');
    connecting.add(exchange);
    const previous = accountRow(exchange), previousVerified = verifiedAccounts.get(exchange);
    let rebound = false;
    try {
      const credentials = wallet ? { address: body.address.toLowerCase(), agentKey: body.agentKey }
        : lighter ? { address: body.address.toLowerCase(), accountIndex: index(body.accountIndex, 1, Number.MAX_SAFE_INTEGER), apiKeyIndex: index(body.apiKeyIndex, 4, 254), apiKey: body.apiKey.replace(/^0x/, '').toLowerCase() }
        : { apiKey: body.apiKey, apiSecret: body.apiSecret, ...(exchange === 'okx' ? { passphrase: body.passphrase } : {}) }, client = clients.get(exchange);
      const symbols = connectSymbols(exchange);
      const result = await call(async callSignal => { const options = { accountMode: mode, signal: callSignal, requireIdentity: !!accountWriter }; const verified = await client.verify(credentials, options); const account = await client.account(credentials, { ...options, symbols: [...symbols] }); return { verified, account }; }, signal);
      // The page was told the result is unconfirmed; it must find the old connection.
      if (signal?.aborted) throw new ExecutionError(503, '请求已取消，未保存实盘连接');
      checkSession(session); checkAvailable(exchange, body.revision);
      if (result.verified.identity && result.account.identity && result.verified.identity !== result.account.identity) throw new ExecutionError(409, '交易账户身份不一致');
      if (accountWriter) {
        try {
          accountWriter.releaseBinding(`hub:${exchange}`);
          rebound = true;
          bindAccount(exchange, body.revision + 1, result.verified.identity && result.account.identity ? result.verified.identity : null);
        } catch { throw new ExecutionError(409, '原账户仍有未核对操作或账户保护不可用，请先恢复原操作'); }
      }
      stmt.prepare('UPDATE execution_accounts SET revision=revision+1,credentials=?,account_mode=?,identity=?,key_label=?,verified_at=?,snapshot=? WHERE exchange=? AND revision=?').run(
        // Wallet labels are public (API wallet address tail, Lighter account and key index), never part of a private key.
        encrypt({ purpose: 'execution', exchange, ...credentials }), mode, result.verified.identity ?? null, wallet ? String(result.verified.agentAddress ?? '').slice(-4) || null : lighter ? `${credentials.accountIndex}#${credentials.apiKeyIndex}` : body.apiKey.slice(-4), iso(now()), JSON.stringify(mergeSnapshot(null, result.account, symbols)), exchange, body.revision);
      return state();
    } catch (error) {
      if (rebound) {
        try { if (previous.credentials) bindAccount(exchange, previous.revision, previousVerified?.identity || null); else accountWriter.releaseBinding(`hub:${exchange}`); }
        catch { verifiedAccounts.delete(exchange); protectionErrors.set(exchange, '账户保护绑定恢复未确认，仅允许读取'); }
      }
      if (error instanceof ExecutionError) throw error; throw new ExecutionError(400, safeError(error));
    }
    finally { connecting.delete(exchange); }
  }
  function disconnect(exchange, body, session) {
    exactKeys(body, ['revision']); checkSession(session); checkAvailable(exchange, body.revision);
    accountWriter?.releaseBinding(`hub:${exchange}`);
    verifiedAccounts.delete(exchange); protectionErrors.delete(exchange);
    clients.get(exchange)?.forget?.();
    stmt.prepare('UPDATE execution_accounts SET revision=revision+1,credentials=NULL,identity=NULL,key_label=NULL,verified_at=NULL,snapshot=NULL WHERE exchange=?').run(exchange);
    return state();
  }
  async function readCall(exchange, symbol, operation, outer) {
    try { return await call(operation, outer); }
    catch (error) {
      // Only a known read can acquire this classification. A create/cancel
      // response, including an uncertain send, never becomes a retryable read.
      if (exchange === 'rh-lighter' && error instanceof ExecutionExchangeError && error.rateLimited === true && !error.uncertain && Number.isSafeInteger(error.retryAt)) {
        throw new RateLimitedReadError(exchange, symbol, error);
      }
      throw error;
    }
  }
  async function readGroup(reads) {
    const results = await Promise.allSettled(reads), errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (!errors.length) return;
    // Finish sibling reads and surface a hard failure even if the rate-limited
    // read rejected first. No in-flight snapshot is carried into the next tick.
    const hard = errors.find(error => !(error instanceof RateLimitedReadError));
    throw hard ?? errors.reduce((latest, error) => error.retryAt > latest.retryAt ? error : latest);
  }
  // Display-only evidence. Do not reuse collect()/collectMarkets(): those paths
  // persist snapshots, bind account ownership, and require the writer lease.
  // One bounded attempt per deduplicated account/book; no completed-result cache.
  async function exposureEvidence(legs, { signal: outer, ruleIds = [] } = {}) {
    const selected = [...new Map(legs.map(leg => [`${leg.exchange}:${leg.symbol}`, { exchange: leg.exchange, symbol: leg.symbol }])).values()];
    if (selected.length > 12 || selected.some(leg => !['binance', 'bybit', 'okx'].includes(leg.exchange) || !['CLUSDT', 'BZUSDT', 'SKHYUSDT', 'SKHYNIXUSDT'].includes(leg.symbol))) throw new ExecutionError(400, '敞口读取范围无效');
    const exchanges = [...new Set(selected.map(leg => leg.exchange))];
    const before = exchanges.map(exchange => accountRow(exchange));
    const accountSignature = row => JSON.stringify([row.revision, !!row.credentials, row.identity, row.account_mode]);
    const jobEvidence = job => {
      const view = publicJob(job), all = orders(job.id);
      return { ...view, accounts: (job.plan.connections ?? []).map(row => ({ exchange: row.exchange, revision: row.revision, identity: row.identity ?? null })),
        legs: view.legs.map(leg => ({ ...leg, rule: job.totals.find(item => item.id === leg.id)?.rule ?? null,
          unresolved: all.filter(order => order.legId === leg.id && !order.settled).map(order => ({ unknown: !!order.unknown, id: order.remoteId ?? null, kind: order.kind })) })) };
    };
    // No indexed-read recovery here: even a missing index must not cause a GET
    // to recreate schema. SQLite may use its existing partial index normally.
    const readJobs = () => stmt.prepare(`SELECT json FROM execution_jobs WHERE ${UNFINISHED_JOB} OR id IN (SELECT job_id FROM execution_orders WHERE ${UNSETTLED_ORDER}) ORDER BY rowid`).all().map(row => jobEvidence(JSON.parse(row.json)));
    const jobs = readJobs(), startedAt = iso(now());
    const accounts = [], markets = [];
    await Promise.all([
      ...before.map(async row => {
        const symbols = selected.filter(leg => leg.exchange === row.exchange).map(leg => leg.symbol), at = iso(now());
        try {
          const ctx = context(row.exchange, row.revision);
          const account = await call(async signal => {
            const options = { accountMode: row.account_mode, signal, requireIdentity: true, symbols };
            const verified = await ctx.client.verify(ctx.credentials, options);
            const result = await ctx.client.account(ctx.credentials, options);
            if (!verified.identity || !result.identity || verified.identity !== result.identity || row.identity && row.identity !== result.identity) throw new ExecutionError(409, '账户真实身份无法核验或已经改变');
            return result;
          }, outer);
          accounts.push({ exchange: row.exchange, revision: row.revision, identity: account.identity, at, symbols, account });
        } catch (error) { accounts.push({ exchange: row.exchange, revision: row.revision, at, symbols, error: safeError(error) }); }
      }),
      ...selected.map(async leg => {
        try {
          const value = await call(signal => clients.get(leg.exchange).market(leg.symbol, { signal }), outer);
          markets.push({ ...leg, market: normalizeMarket(value, leg.symbol, now(), leg.exchange) });
        } catch (error) { markets.push({ ...leg, error: safeError(error) }); }
      }),
    ]);
    if (outer?.aborted) throw new ExecutionError(503, '敞口读取已取消');
    const changed = before.filter(row => accountSignature(row) !== accountSignature(accountRow(row.exchange))).map(row => row.exchange);
    const heldContracts = [...new Set(ruleIds)].slice(0, 12).flatMap(ruleId => {
      const row = stmt.prepare("SELECT json FROM execution_jobs WHERE json_extract(json,'$.auto.ruleId')=? AND json_extract(json,'$.plan.action')='open' AND json_extract(json,'$.status')='completed' ORDER BY rowid DESC LIMIT 1").get(ruleId);
      return row ? [jobEvidence(JSON.parse(row.json))] : [];
    });
    return { startedAt, finishedAt: iso(now()), accounts, markets, jobs, heldContracts, changed, jobsChanged: JSON.stringify(jobs) !== JSON.stringify(readJobs()) };
  }
  async function collectMarkets(legs, validate = () => {}, outer) {
    const markets = new Map(), received = new Map();
    const checked = (leg, value, allowStale = false) => {
      let market;
      try { market = normalizeMarket(value, leg.symbol, now(), leg.exchange); }
      catch (error) { if (allowStale && error instanceof StaleMarketError) return; throw error; }
      validate(leg, market);
    };
    const read = async leg => {
      const value = await readCall(leg.exchange, leg.symbol, signal => clients.get(leg.exchange).market(leg.symbol, { signal }), outer);
      requireLease();
      const key = `${leg.exchange}:${leg.symbol}`;
      markets.set(key, value); received.set(key, now());
      // Hard failures in a returned sibling book outrank another leg's rate
      // limit. Old books alone still get the bounded refresh below.
      checked(leg, value, true);
    };
    await readGroup(legs.map(read));
    // A slow sibling or cold rule lookup can age a fast book while we await the
    // group. Refresh only old books once, under the same per-call timeout. Keep
    // venue timestamps and validate the entire group again after this wait.
    const stale = legs.filter(leg => {
      try { normalizeMarket(markets.get(`${leg.exchange}:${leg.symbol}`), leg.symbol, now(), leg.exchange); return false; }
      catch (error) { if (error instanceof StaleMarketError) return true; throw error; }
    });
    await readGroup(stale.map(read));
    for (const leg of legs) checked(leg, markets.get(`${leg.exchange}:${leg.symbol}`));
    requireLease(); return { markets, received };
  }
  async function collect(legs, { validateAccount = () => {}, validateMarket, requireIdentity = false, signal: outer } = {}) {
    const exchanges = [...new Set(legs.map(leg => leg.exchange))], snapshots = new Map(), connections = new Map(), positionWaits = [];
    await readGroup(exchanges.map(async exchange => {
      const expected = legs.find(leg => leg.exchange === exchange)?.accountRevision;
      const ctx = context(exchange, expected);
      const symbols = [...new Set(legs.filter(leg => leg.exchange === exchange).map(leg => leg.symbol))];
      const account = await readCall(exchange, symbols.join(' / '), async signal => { const options = { ...ctx.options, signal, requireIdentity: !!accountWriter || requireIdentity, symbols }; const verified = await ctx.client.verify(ctx.credentials, options); const snapshot = await ctx.client.account(ctx.credentials, options); if (verified.identity && snapshot.identity && verified.identity !== snapshot.identity || requireIdentity && (!verified.identity || !snapshot.identity)) throw new ExecutionError(409, '交易账户身份不一致或无法核验'); return snapshot; }, outer);
      requireLease();
      if (accountRow(exchange).revision !== ctx.row.revision) throw new ExecutionError(409, '实盘连接已改变，请重新预览');
      if (ctx.row.identity && account.identity && ctx.row.identity !== account.identity) throw new ExecutionError(409, '交易账户身份不一致');
      for (const leg of legs.filter(item => item.exchange === exchange)) {
        try { validateAccount(leg, account); }
        catch (error) {
          // Inspect all sibling legs and books before deferring: a lagging
          // position must not hide another leg's identity or contract failure.
          if (!(error instanceof PositionProjectionWait)) throw error;
          positionWaits.push(error);
        }
      }
      if (accountWriter) {
        if (!ctx.row.identity && account.identity) stmt.prepare('UPDATE execution_accounts SET identity=? WHERE exchange=? AND revision=?').run(account.identity, exchange, ctx.row.revision);
        bindAccount(exchange, ctx.row.revision, account.identity);
      }
      snapshots.set(exchange, account); connections.set(exchange, connection(ctx.row));
      stmt.prepare('UPDATE execution_accounts SET snapshot=? WHERE exchange=? AND revision=?').run(JSON.stringify(mergeSnapshot(ctx.row.snapshot, account, symbols)), exchange, ctx.row.revision);
    }));
    const { markets, received } = await collectMarkets(legs, validateMarket, outer);
    if (positionWaits.length) throw positionWaits[0];
    requireLease(); return { snapshots, markets, connections, received };
  }
  // Display-only top of book on every venue (same-venue spreads are the main
  // use, so the view does not depend on the selected pair). Public book only
  // (withRule: false, so no exchangeInfo download) via the same clients the
  // executor trades with; one attempt per leg, no retry, each leg bounded by
  // QUOTE_TIMEOUT_MS; a failed leg is reported on that leg only. A read in
  // flight is shared (up to twice the leg timeout, in case a client ignores the
  // signal), and a finished one for QUOTES_TTL_MS after it settles, so several
  // tabs or a slow leg do not multiply exchange requests; expiry is by time only.
  let quoteCache = null;
  function quotes() {
    const started = now();
    const age = quoteCache ? started - quoteCache.at : -1;
    if (quoteCache && age >= 0 && age < (quoteCache.pending ? quoteTimeoutMs * 2 : QUOTES_TTL_MS)) return quoteCache.promise;
    const entry = { at: started, pending: true, promise: null };
    // Only contracts a venue lists; a request for any other pair would only return an error.
    const legs = EXECUTION_EXCHANGES.flatMap(exchange => EXECUTION_VENUE_SYMBOLS[exchange].map(symbol => ({ exchange, symbol })));
    const timeouts = legs.map(() => AbortSignal.timeout(quoteTimeoutMs));
    const promise = Promise.allSettled(legs.map((leg, index) => call(signal => clients.get(leg.exchange).market(leg.symbol, { signal: AbortSignal.any([signal, timeouts[index]]), withRule: false }))))
      .then(results => ({
        generatedAt: new Date(now()).toISOString(), maxAgeMs: QUOTE_MAX_AGE,
        books: legs.map((leg, index) => {
          const result = results[index];
          // The leg timeout aborts the client from outside, which reports it as an interruption.
          if (result.status === 'rejected') return { ...leg, error: timeouts[index].aborted && result.reason?.code === 'aborted' ? '交易所请求超时' : safeError(result.reason) };
          const { symbol, bid, ask, at } = result.value ?? {};
          if (symbol !== leg.symbol) return { ...leg, error: '交易所未返回完整盘口' };
          return { ...leg, bid, ask, at };
        }),
      }))
      .finally(() => { entry.pending = false; entry.at = now(); });
    entry.promise = promise; quoteCache = entry;
    return promise;
  }

  async function preview(body, session, { signal } = {}) {
    writable(); checkSession(session);
    if (typeof session !== 'string' || !session) throw new ExecutionError(401, '请重新登录');
    let intent, resumeJobId = null;
    if (body && Object.hasOwn(body, 'resumeJobId')) {
      exactKeys(body, ['resumeJobId']);
      const job = jobFor(body.resumeJobId), view = publicJob(job);
      if (!view.canResume) throw new ExecutionError(409, '任务尚有未核对委托或不可继续，请先处理异常');
      resumeJobId = job.id;
      intent = { ...job.plan, market: job.plan.market ?? 'oil', equalSize: null, batchCount: Math.max(1, job.plan.batchCount - job.batchIndex), legs: view.legs.filter(leg => compareDecimals(leg.remainingQuantity, '0') > 0).map(leg => ({ exchange: leg.exchange, symbol: leg.symbol, side: leg.side, quantity: leg.remainingQuantity, orderType: leg.orderType, stopPrice: leg.stopPrice })) };
    } else intent = normalizeIntent(body);
    for (const leg of intent.legs) {
      const lock = stmt.prepare('SELECT job_id FROM execution_locks WHERE resource=?').get(`${leg.exchange}:${leg.symbol}`);
      if (lock && lock.job_id !== resumeJobId) throw new ExecutionError(409, '所选合约已有未结束任务');
    }
    let collected;
    try { collected = await collect(intent.legs, { signal }); } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError(400, safeError(error)); }
    if (signal?.aborted) throw new ExecutionError(503, '请求已取消，未生成预览');
    const plan = buildPlan(intent, collected.snapshots, collected.markets, collected.connections, now(), { resume: !!resumeJobId });
    const value = { ...plan, id: randomUUID(), expiresAt: iso(now() + PREVIEW_TTL), resumeJobId, connections: [...collected.connections.values()] };
    writable(); checkSession(session); stmt.prepare('DELETE FROM execution_previews WHERE expires<? AND consumed IS NULL').run(now());
    stmt.prepare('INSERT INTO execution_previews(id,session,expires,json) VALUES (?,?,?,?)').run(value.id, session, now() + PREVIEW_TTL, JSON.stringify(value));
    return value;
  }
  function start(body, session) {
    exactKeys(body, ['previewId', 'requestId', 'confirmLive']); writable(); checkSession(session);
    if (body.confirmLive !== true || typeof body.previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw new ExecutionError(400, '请从有效预览明确确认实盘执行');
    return transaction(() => {
      const request = stmt.prepare('SELECT * FROM execution_requests WHERE id=?').get(body.requestId);
      if (request) {
        if (request.preview_id !== body.previewId || request.session !== session) throw new ExecutionError(409, '请求标识已被使用');
        return { ...state(), acceptedJob: publicJob(jobFor(request.job_id)) };
      }
      const record = stmt.prepare('SELECT * FROM execution_previews WHERE id=?').get(body.previewId);
      if (!record || record.session !== session || record.expires <= now() || record.consumed) throw new ExecutionError(409, '预览已过期或已提交，请重新预览');
      const plan = JSON.parse(record.json);
      for (const leg of plan.legs) {
        context(leg.exchange, leg.accountRevision);
        const lock = stmt.prepare('SELECT job_id FROM execution_locks WHERE resource=?').get(`${leg.exchange}:${leg.symbol}`);
        if (lock && lock.job_id !== plan.resumeJobId) throw new ExecutionError(409, '所选合约已有未结束任务');
      }
      let job;
      if (plan.resumeJobId) {
        job = jobFor(plan.resumeJobId);
        if (!publicJob(job).canResume) throw new ExecutionError(409, '任务状态已改变，请重新预览');
        for (const leg of plan.legs) if (compareDecimals(publicJob(job).legs.find(row => row.id === leg.id).remainingQuantity, leg.quantity) !== 0) throw new ExecutionError(409, '已成交数量改变，请重新预览');
        // Preserve every leg's last confirmed position baseline even when a
        // fully filled leg drops out of a later manual remaining-quantity plan.
        const reductionPositions = job.riskReduction ? reductionPositionBaselines(job) : null;
        job.plan = plan; job.phase += 1;
        if (reductionPositions) {
          for (const leg of plan.legs) reductionPositions[leg.id] = { quantity: leg.currentQuantity, positionMode: leg.positionMode, phase: job.phase };
          job.riskReduction.positionBaselines = reductionPositions;
        }
        // A person confirmed the remaining quantity: the rule's threshold no longer holds it back.
        if (job.auto?.guard) job.auto = { ...job.auto, guard: null };
      } else job = { id: randomUUID(), createdAt: iso(now()), totals: plan.legs, plan, phase: 0, events: [] };
      Object.assign(job, { status: 'queued', stopTarget: null, reason: null, batchIndex: 0, nextBatchAt: now(), deadlineAt: iso(now() + plan.timeoutMs), sendDeferrals: {} });
      // A newly confirmed remaining plan has its own position baseline.
      delete job.positionReadWait;
      protectJob(job, !!plan.resumeJobId);
      recoveredWriterJobs.add(job.id);
      stmt.prepare('DELETE FROM execution_stop_requests WHERE job_id=?').run(job.id);
      event(job, plan.resumeJobId ? '已确认剩余数量，等待重新核对账户与盘口' : '已确认实盘预览，等待核对账户与盘口'); saveJob(job);
      for (const leg of plan.legs) stmt.prepare('INSERT OR IGNORE INTO execution_locks(resource,job_id) VALUES (?,?)').run(`${leg.exchange}:${leg.symbol}`, job.id);
      stmt.prepare('UPDATE execution_previews SET consumed=? WHERE id=?').run(job.id, plan.id);
      stmt.prepare('INSERT INTO execution_requests(id,preview_id,job_id,session) VALUES (?,?,?,?)').run(body.requestId, plan.id, job.id, session);
      return { ...state(), acceptedJob: publicJob(job) };
    });
  }
  // The unfinished job (manual or automatic) holding one of the symbols, if any.
  function lockOwner(legs) {
    for (const leg of legs) { const row = stmt.prepare('SELECT job_id FROM execution_locks WHERE resource=?').get(`${leg.exchange}:${leg.symbol}`); if (row) return row.job_id; }
    return null;
  }
  // Server-side start for a saved automatic rule. It runs the same account,
  // book, position and lock checks as a preview, then saves the job, its locks
  // and the caller's own record (commit) in one transaction: a crash can never
  // leave a job the rule does not know about, and a rule that changed while the
  // books were read aborts the job instead of trading on old settings.
  // check sees the books the plan is built from, so a trigger decided on the
  // shared display cache is confirmed on the same read the orders start from.
  // accounts pins each venue to a connection revision: a close must reach the
  // account that opened, not whatever is connected now.
  async function startAutomatic(body, { auto, commit, check, accounts = null }) {
    writable();
    if (!auto || typeof auto.ruleId !== 'string' || !['open', 'close'].includes(auto.action) || typeof commit !== 'function' || typeof check !== 'function' || !auto.guard) throw new ExecutionError(500, '自动任务参数无效');
    const { market, exchange, direction, openThreshold, closeThreshold } = auto.guard, guard = { market, exchange, direction, openThreshold, closeThreshold };
    const intent = normalizeIntent(body);
    if (intent.action !== auto.action) throw new ExecutionError(500, '自动任务参数无效');
    if (accounts) intent.legs = intent.legs.map(leg => {
      if (!Number.isSafeInteger(accounts[leg.exchange])) throw new ExecutionError(500, '自动任务参数无效');
      return { ...leg, accountRevision: accounts[leg.exchange] };
    });
    const lockedLeg = () => lockOwner(intent.legs) !== null;
    if (lockedLeg()) throw new WaitError(409, '所选合约已有未结束任务');
    let collected;
    try { collected = await collect(intent.legs); } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError(400, safeError(error)); }
    check({ books: [...collected.markets].map(([key, market]) => ({ exchange: key.split(':')[0], symbol: market.symbol, bid: market.bid, ask: market.ask, at: market.at })) });
    const plan = { ...buildPlan(intent, collected.snapshots, collected.markets, collected.connections, now()), id: randomUUID(), resumeJobId: null, connections: [...collected.connections.values()] };
    writable();
    return transaction(() => {
      for (const leg of plan.legs) context(leg.exchange, leg.accountRevision);
      if (lockedLeg()) throw new WaitError(409, '所选合约已有未结束任务');
      const job = { id: randomUUID(), createdAt: iso(now()), totals: plan.legs, plan, phase: 0, events: [], auto: { ruleId: auto.ruleId, action: auto.action, guard },
        status: 'queued', stopTarget: null, reason: null, batchIndex: 0, nextBatchAt: now(), deadlineAt: iso(now() + plan.timeoutMs) };
      commit(job.id);
      try {
        protectJob(job);
        recoveredWriterJobs.add(job.id);
        event(job, `自动规则触发${auto.action === 'open' ? '开仓' : '平仓'}${auto.trigger ? '：' + String(auto.trigger).slice(0, 200) : ''}`); saveJob(job);
        for (const leg of plan.legs) stmt.prepare('INSERT INTO execution_locks(resource,job_id) VALUES (?,?)').run(`${leg.exchange}:${leg.symbol}`, job.id);
      } catch (error) { writerTickets.delete(job.id); recoveredWriterJobs.delete(job.id); throw error; }
      return job.id;
    });
  }
  // Risk reductions have no spread guard. The same fresh, authenticated
  // snapshot supplies both the liquidation trigger and the native quantities.
  async function startRiskReduction(body, { ruleId, accounts, previousJobId = null, check, commit }) {
    writable();
    const config = normalizeReductionConfig(body);
    if (!config.enabled || ruleId !== 'anthropic-reduction' || typeof check !== 'function' || typeof commit !== 'function') throw new ExecutionError(500, '自动减仓参数无效');
    const legs = config.legs.map(leg => {
      const binding = accounts?.[leg.exchange];
      if (!validRevision(binding?.revision) || typeof binding.identity !== 'string' || !binding.identity) throw new ExecutionError(409, '自动减仓缺少已核验的实盘账户绑定');
      return { ...leg, accountRevision: binding.revision };
    });
    if (lockOwner(legs)) throw new WaitError(409, '所选合约已有未结束任务，等待其结束后重新核验');
    // A completed order does not prove that the account snapshot reflects its
    // fills. Reconcile once between rounds before sizing from the remainder.
    let previousLegs = null;
    if (previousJobId) {
      const previous = jobFor(previousJobId), all = orders(previousJobId);
      if (previous.status !== 'completed' || previous.riskReduction?.ruleId !== ruleId || all.some(order => !order.settled || order.unknown)) throw new ExecutionError(409, '上一轮减仓尚未完整确认，不能开始下一轮');
      const baselines = reductionPositionBaselines(previous);
      previousLegs = legs.map(leg => {
        const prior = previous.totals.find(item => item.exchange === leg.exchange && item.symbol === leg.symbol && item.side === leg.side);
        const binding = previous.riskReduction.accounts[leg.exchange];
        // A new credential revision may re-verify the same account. The old
        // fills are evidence only; every live read/send uses the new binding.
        if (!prior || binding?.identity !== accounts[leg.exchange].identity) throw new ExecutionError(409, '上一轮减仓合约或账户身份不一致，请恢复原账户完成剩余持仓核对');
        const baseline = baselines[prior.id], legOrders = all.filter(order => order.legId === prior.id);
        const expected = subtract(baseline.quantity, totalFilled(legOrders.filter(order => order.phase >= baseline.phase), prior.id));
        if (compareDecimals(totalFilled(legOrders, prior.id), prior.quantity) !== 0 || compareDecimals(expected, '0') < 0) throw new ExecutionError(409, '上一轮减仓成交数量无法核对，请核对');
        const last = legOrders.filter(order => compareDecimals(order.filledQuantity, '0') > 0).sort((a, b) => b.phase - a.phase || b.batch - a.batch)[0];
        return { leg: { ...prior, positionMode: baseline.positionMode }, expected,
          beforeLast: addDecimals([expected, totalFilled(legOrders, prior.id, last.phase, last.batch)]) };
      });
    }
    let collected;
    try { collected = await collect(legs, { requireIdentity: true, validateAccount(leg, account) {
      if (account.identity !== accounts[leg.exchange].identity) throw new ExecutionError(409, '自动减仓账户身份已变化');
      const previous = previousLegs?.find(item => item.leg.exchange === leg.exchange && item.leg.symbol === leg.symbol && item.leg.side === leg.side);
      if (previous) {
        const current = checkPosition(account, previous.leg, 'close', '0');
        if (compareDecimals(current, previous.expected) !== 0) {
          if (compareDecimals(current, previous.beforeLast) === 0) throw new ExecutionError(502, `${leg.exchange} ${leg.symbol} 持仓尚未反映上一轮最后一批成交，等待核对后再触发`);
          throw new ExecutionError(409, `${leg.exchange} ${leg.symbol} 持仓与上一轮减仓后的预期不一致，请核对`);
        }
      }
    } }); } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError(502, safeError(error)); }
    check();
    if (previousLegs?.every(item => compareDecimals(item.expected, '0') === 0)) return { jobId: null, live: null, exhausted: true };
    if (previousLegs?.some(item => compareDecimals(item.expected, '0') === 0)) throw new ExecutionError(409, '其中一条腿已无可减仓持仓，请核对双边剩余仓位');
    const reading = readReductionRisk(config, collected.snapshots, now());
    // Quantity and batch feasibility changes with the live position. Check it
    // on every monitoring round, before the liquidation trigger is reached.
    const quantities = reductionQuantities(config, reading, collected.markets, now());
    // Display evidence only: the send path still performs its own fresh checks.
    reading.validUntil = iso(Math.min(...reading.legs.flatMap(leg => [Date.parse(leg.riskAt) + REDUCTION_RISK_MAX_AGE_MS,
      Date.parse(collected.markets.get(`${leg.exchange}:${leg.symbol}`).at) + QUOTE_MAX_AGE])));
    const intent = normalizeIntent(reductionIntent(config, quantities));
    let built;
    try { built = buildPlan(intent, collected.snapshots, collected.markets, collected.connections, now()); }
    catch (error) {
      if (!(error instanceof ExternalOrdersError)) throw error;
      error.reading = reading;
      if (reading.met) throw error;
      const blocked = [];
      for (const leg of config.legs) {
        try { ensureNoExternalOrders(collected.snapshots.get(leg.exchange), leg.symbol); }
        catch { blocked.push(`${leg.exchange} ${leg.symbol}`); }
      }
      return { jobId: null, live: { ...reading, warning: blocked.length ? `${blocked.join('、')} 存在其它活动委托或无法核对委托；达到阈值时将等待其撤销后才能减仓` : null } };
    }
    checkReductionDuration(built.batchCount, built.batchIntervalMs, built.timeoutMs);
    // Lighter IOC exempts the venue's minimum notional. Hyperliquid documents
    // a general minimum but no blanket reduce-only exception: surface that
    // uncertainty without changing the existing close-order send policy.
    const small = built.legs.filter(leg => leg.exchange === 'hyperliquid' && leg.batchQuantities.some(quantity =>
      compareDecimals(notional(quantity, leg.bid, leg.rule.contractSize), leg.rule.minNotional) < 0));
    reading.warning = small.length ? `${small.map(leg => `${TRADING_NAMES[leg.exchange]} ${leg.symbol}`).join('、')} 单批预计金额低于交易所一般最低金额，减仓豁免条件未确认；请核对或调整比例、批次数` : null;
    if (!reading.met) return { jobId: null, live: reading };
    const plan = { ...built, id: randomUUID(), resumeJobId: null, connections: [...collected.connections.values()] };
    writable();
    const jobId = transaction(() => {
      check();
      for (const leg of plan.legs) context(leg.exchange, leg.accountRevision);
      if (lockOwner(legs)) throw new WaitError(409, '所选合约已有未结束任务');
      const job = { id: randomUUID(), createdAt: iso(now()), totals: plan.legs, plan, phase: 0, events: [],
        riskReduction: { ruleId, config, accounts, trigger: reading }, status: 'queued', stopTarget: null, reason: null, batchIndex: 0, nextBatchAt: now(), deadlineAt: iso(now() + plan.timeoutMs) };
      commit(job.id, reading);
      try {
        protectJob(job); recoveredWriterJobs.add(job.id);
        event(job, `ANT 强平距离触发双边市价减仓：总比例 ${config.reducePercent}%，实际 ${plan.batchCount} 批`); saveJob(job);
        for (const leg of plan.legs) stmt.prepare('INSERT INTO execution_locks(resource,job_id) VALUES (?,?)').run(`${leg.exchange}:${leg.symbol}`, job.id);
      } catch (error) { writerTickets.delete(job.id); recoveredWriterJobs.delete(job.id); throw error; }
      return job.id;
    });
    return { jobId, live: reading };
  }
  const jobView = id => publicJob(jobFor(id));
  const canRepeatRiskReduction = id => { const job = jobFor(id); return job.status === 'completed' && job.riskReduction?.ruleId === 'anthropic-reduction' && job.phase === 0; };
  const jobAccounts = id => (jobFor(id).plan.connections ?? []).map(row => ({ exchange: row.exchange, revision: row.revision, identity: row.identity ?? null }));
  const connectionOf = exchange => { const row = accountRow(exchange); return { revision: row.revision, connected: !!row.credentials }; };
  // Narrow read-only bridge: credentials stay in the execution service and
  // history reads do not acquire a writer ticket or modify account snapshots.
  const historyControllers = new Set();
  const historyConnections = () => ['hyperliquid', 'rh-lighter'].map(exchange => {
    const row = accountRow(exchange);
    return { exchange, revision: row.revision, connected: !closed && !closing && !!row.credentials, identity: row.identity };
  });
  async function readAnthropicHistory(exchange, { revision, identity, start, end, signal } = {}) {
    if (!['hyperliquid', 'rh-lighter'].includes(exchange)) throw new ExecutionError(400, '不支持此交易所的 ANT 原生成交读取');
    const current = () => {
      const row = accountRow(exchange);
      if (closed || closing || signal?.aborted || !row.credentials || !validRevision(revision) || row.revision !== revision || !identity || row.identity !== identity)
        throw new ExecutionError(409, '实盘连接已改变，已丢弃旧账户成交');
    };
    current();
    const ctx = context(exchange, revision);
    if (typeof ctx.client?.history !== 'function') throw new ExecutionError(501, '当前交易所尚不支持 ANT 原生成交读取');
    const controller = new AbortController(); historyControllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('History deadline', 'TimeoutError')), 45_000); timer.unref?.();
    let onAbort;
    const interrupted = new Promise((_resolve, reject) => {
      onAbort = () => reject(new ExecutionExchangeError(combined.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted'));
      combined.addEventListener('abort', onAbort, { once: true });
    });
    try {
      combined.throwIfAborted();
      const result = await Promise.race([ctx.client.history(ctx.credentials, { start, end, signal: combined }), interrupted]);
      current(); combined.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', onAbort); historyControllers.delete(controller); controller.abort();
    }
  }
  function leading() { try { requireLease(); return !closing; } catch { return false; } }
  // A diagnostic GET must not invoke requireLease()/lostLease(), which can
  // retire local execution state. This value authorizes no write operation.
  function coverageAvailable() {
    const row = stmt.prepare('SELECT owner,expires FROM execution_lease WHERE id=1').get();
    return !closed && !closing && !retired && leader && row?.owner === owner && row.expires > now();
  }
  function validateInspection(order, value, { explicit = false, cancelRecovery = false } = {}) {
    const reducedOriginal = cancelRecovery && order.exchange === 'okx' && order.remoteId && order.spec.reduceOnly && value && compareDecimals(value.quantity, '0') > 0 && compareDecimals(value.quantity, order.spec.quantity) <= 0;
    if (!value || typeof value.id !== 'string' || !value.id || (order.remoteId && value.id !== order.remoteId) || value.symbol !== order.spec.symbol || value.side !== order.spec.side || value.reduceOnly !== order.spec.reduceOnly || (value.positionSide !== null && value.positionSide !== order.spec.positionSide) || value.kind !== order.kind || !reducedOriginal && compareDecimals(value.quantity, order.spec.quantity) !== 0) throw new ExecutionError(409, '委托身份或数量与本任务不一致，禁止认领或补单');
    const filled = decimal(value.filledQuantity, { nonnegative: true });
    if (compareDecimals(filled, order.filledQuantity) < 0 || compareDecimals(filled, order.spec.quantity) > 0 || typeof value.terminal !== 'boolean' || typeof value.childrenSettled !== 'boolean') throw new ExecutionError(409, '委托成交记录不一致，暂停自动执行');
    if (explicit && (value.positionSide === null || !value.createdAt || !Number.isFinite(Date.parse(value.createdAt)) || Date.parse(value.createdAt) < Date.parse(order.createdAt) - 5000 || Date.parse(value.createdAt) > Date.parse(order.createdAt) + callTimeoutMs + 5000)) throw new ExecutionError(409, '策略方向或创建时间不匹配，禁止认领其他策略');
    return filled;
  }
  function lighterAmendVisible(order, value) {
    if (order.exchange !== 'rh-lighter' || !order.amendPending) return true;
    // A settled original is safe to reconcile even if the modify never ran.
    if (value.terminal && value.childrenSettled) return true;
    const version = value.orderVersion ?? 0;
    if (!validRevision(version) || !Number.isSafeInteger(order.amendVersion) || order.amendVersion <= 0 || !order.amendTarget?.limitPrice) throw new ExecutionError(409, 'Lighter RH 改单版本或目标缺失，保留原委托待核对');
    if (version > order.amendVersion) throw new ExecutionError(409, 'Lighter RH 原委托已被其他操作修改，禁止认领改单结果');
    if (version < order.amendVersion) return false;
    if (!value.price || compareDecimals(value.price, order.amendTarget.limitPrice) !== 0) throw new ExecutionError(409, 'Lighter RH 改单价格与目标不一致，禁止认领改单结果');
    return true;
  }
  async function inspectOrder(order, explicitId, cancelRecovery = false) {
    requireLease();
    if (order.kind === 'strategy' && !order.remoteId && !explicitId) return false;
    const ctx = context(order.exchange, order.accountRevision);
    let value;
    try { value = await readCall(order.exchange, order.spec.symbol, signal => ctx.client.inspect(ctx.credentials, { ...order.spec, id: explicitId ?? order.remoteId }, { ...ctx.options, signal, cancelRecovery })); }
    catch (error) { if (error?.notFound && await absentCreate(order)) return true; throw error; }
    requireLease();
    const current = orderFor(order.localId), filledQuantity = validateInspection(current, value, { explicit: !!explicitId, cancelRecovery });
    const pendingAmend = current.exchange === 'rh-lighter' && current.amendPending;
    const amendVisible = lighterAmendVisible(current, value);
    if (!amendVisible) {
      // A readable old version proves only its cumulative fills. It cannot
      // acknowledge the modify, release its shared writer intent or be absent-create evidence.
      Object.assign(current, { filledQuantity, price: value.price ?? null, lastCheckedAt: iso(now()), unknown: true });
      saveOrder(current); return false;
    }
    if (pendingAmend) {
      if (value.orderVersion === current.amendVersion) current.spec = { ...current.spec, ...current.amendTarget };
      current.amendPending = false;
      if (current.writerOperation?.action === 'amend') { current.writerOperation.state = 'confirmed'; current.writerDispatch = 'confirmed'; }
      // Record matching evidence before releasing the shared unknown intent.
      Object.assign(current, { filledQuantity, unknown: false, state: value.status, settled: value.terminal && value.childrenSettled });
      saveOrder(current);
    }
    if (accountWriter) {
      const ticket = protectJob(jobFor(order.jobId));
      const known = new Set([`hub:create:${order.localId}`, `hub:legacy-amend:${order.localId}`, `hub:legacy-cancel:${order.localId}`]);
      for (const operation of accountWriter.unresolved(ticket)) {
        const belongs = known.has(operation.operationId) || operation.operationId.startsWith(`hub:amend:${order.localId}:`) || operation.operationId.startsWith(`hub:cancel:${order.localId}:`);
        if (belongs && (operation.operationId === `hub:create:${order.localId}` || value.terminal && value.childrenSettled || pendingAmend && (operation.operationId === `hub:amend:${order.localId}:${current.amendCount}` || operation.operationId === `hub:legacy-amend:${order.localId}`))) accountWriter.resolve(operation.operationId, ticket);
      }
      assertJob(order.jobId);
    }
    Object.assign(current, { remoteId: value.id, filledQuantity, unknown: false, state: value.status, price: value.price ?? null, lastCheckedAt: iso(now()), settled: value.terminal && value.childrenSettled });
    if (current.exchange === 'rh-lighter' && validRevision(value.orderVersion ?? 0)) current.orderVersion = value.orderVersion ?? 0;
    if (current.settled || pendingAmend) clearAmendDeferral(current);
    // Lighter RH accepts a post-only order and cancels it on execution when the book
    // already crossed it; like a Hyperliquid ALO refusal, nothing rested or filled.
    const bounced = current.exchange === 'rh-lighter' && value.bounced === true && value.terminal && filledQuantity === '0' && !current.bounced && !current.cancelRequestedAt;
    if (bounced) current.bounced = true;
    saveOrder(current);
    if (bounced) {
      const job = jobFor(current.jobId), leg = job.plan.legs.find(item => item.id === current.legId);
      if (leg && job.lastBounceEvent !== leg.id) { job.lastBounceEvent = leg.id; event(job, `${TRADING_NAMES[current.exchange]} ${current.spec.symbol} 只挂单因盘口变化被取消，按最新盘口重新挂单`); saveJob(job); }
    }
    return true;
  }
  // Every create left unknown had an uncertain result (timeout, 5xx, unknown
  // code), so a missing client ID is not proof by itself (L039/L062). After the
  // bounded observation window (no request can still arrive: Binance recvWindow
  // 5 s, OKX 30 s timestamp expiry) and spaced misses, a fresh account read with
  // no other order on the symbol and the position equal to the preview baseline
  // plus known fills adopts reality. Bybit market orders carry orderLinkId and
  // follow the same path; Bybit strategies have no client ID and are confirmed
  // by the operator.
  // A Lighter RH transaction stays executable until its signed expiry (10 min after signing).
  const createSettledAt = order => Date.parse(order.createdAt) + Math.max(CREATE_OBSERVE_MS, callTimeoutMs + CREATE_ARRIVAL_MARGIN_MS,
    order.exchange === 'rh-lighter' ? RH_LIGHTER_TX_EXPIRES_MS + callTimeoutMs + CREATE_ARRIVAL_MARGIN_MS : 0);
  const pendingVisible = order => order.exchange === 'rh-lighter' && !!order.acceptedAt && !order.remoteId && order.unknown && !order.settled
    && now() < createSettledAt(order) + MISMATCH_RECHECK_MS;
  const pendingAmendVisible = order => order.exchange === 'rh-lighter' && order.amendPending && order.unknown && !order.settled
    && Number.isFinite(Date.parse(order.amendSentAt)) && now() < Date.parse(order.amendSentAt) + RH_LIGHTER_TX_EXPIRES_MS + callTimeoutMs + CREATE_ARRIVAL_MARGIN_MS;
  async function absentCreate(order) {
    requireLease();
    const current = orderFor(order.localId);
    if (current.kind !== 'order' || current.remoteId || !current.unknown || current.settled) return false;
    const expired = now() >= createSettledAt(current);
    // Misses count only once per spaced check, so one pass cannot confirm itself.
    if (!expired) current.absentChecks = 0;
    else if (!current.absentAt || now() - Date.parse(current.absentAt) >= ATTENTION_RETRY_MS / 3) { current.absentChecks = (current.absentChecks || 0) + 1; current.absentAt = iso(now()); }
    if (!expired || current.absentChecks < ABSENT_CREATE_CHECKS) { saveOrder(current); return false; }
    // A known mismatch is re-read at a slower cadence than the attention tick.
    if (current.positionCheckedAt && now() - Date.parse(current.positionCheckedAt) < MISMATCH_RECHECK_MS) { saveOrder(current); return false; }
    current.positionCheckedAt = iso(now()); saveOrder(current);
    const { matches } = await freshPosition(current);
    const latest = orderFor(current.localId);
    if (latest.settled || latest.remoteId) return false;
    if (!matches) {
      if (!latest.positionMismatchAt) { latest.positionMismatchAt = iso(now()); saveOrder(latest); const job = jobFor(latest.jobId); event(job, `${TRADING_NAMES[latest.exchange]} ${latest.spec.symbol} 查无原委托，但当前仓位或挂单与已知成交不一致，继续保留待核对`); saveJob(job); }
      return false;
    }
    settleNotCreated(latest, `${TRADING_NAMES[latest.exchange]} ${latest.spec.symbol} 结果未知的委托超过观察窗口后多次按客户订单号查询均不存在，且该合约无其他挂单、仓位与已知成交一致，按现实判定未送达`);
    return true;
  }
  // Fresh single-symbol read. It matches only when the position equals the
  // preview baseline plus this phase's known fills and the symbol carries no
  // order or strategy other than this job's settled ones.
  async function freshPosition(order) {
    const job = jobFor(order.jobId), leg = job.plan.legs.find(item => item.id === order.legId);
    const ctx = context(order.exchange, order.accountRevision);
    const account = await readCall(order.exchange, order.spec.symbol, signal => ctx.client.account(ctx.credentials, { ...ctx.options, signal, symbols: [order.spec.symbol] }));
    requireLease();
    if (!leg?.currentQuantity || !Array.isArray(account?.openOrders) || !Array.isArray(account?.strategies)) return { account, matches: false };
    const busy = account.openOrders.some(item => item.symbol === order.spec.symbol) || account.strategies.some(item => item.symbol === order.spec.symbol && item.status !== 'terminal');
    const filled = totalFilled(orders(job.id), leg.id, job.phase);
    const expected = job.plan.action === 'open' ? addDecimals([leg.currentQuantity, filled]) : subtract(leg.currentQuantity, filled);
    return { account, matches: !busy && compareDecimals(currentPosition(account, leg), expected) === 0 };
  }
  function settleNotCreated(current, message) {
    if (accountWriter) {
      const ticket = protectJob(jobFor(current.jobId)), operationId = `hub:create:${current.localId}`;
      if (accountWriter.unresolved(ticket).some(operation => operation.operationId === operationId)) accountWriter.resolve(operationId, ticket, 'rejected');
      if (current.writerOperation?.operationId === operationId) { current.writerOperation.state = 'rejected'; current.writerDispatch = 'rejected'; }
    }
    Object.assign(current, { state: 'rejected', settled: true, unknown: false, lastCheckedAt: iso(now()) });
    saveOrder(current);
    const job = jobFor(current.jobId); event(job, message); saveJob(job);
  }
  // Operator confirmation for a Bybit strategy create without an answer. It is
  // accepted only after the request can no longer arrive, while the symbol has
  // no live strategy, no unclaimed strategy created around the request (venue
  // clock tolerance included), including ones that already ended (status 3,
  // read from a bounded window starting at the request), and the position matches
  // the known fills.
  async function confirmNotCreated(order) {
    const created = Date.parse(order.createdAt);
    if (!Number.isFinite(created) || now() < createSettledAt(order)) throw new ExecutionError(409, '下单请求仍可能送达交易所，请稍后再确认');
    const window = callTimeoutMs + VENUE_CLOCK_TOLERANCE_MS, ctx = context(order.exchange, order.accountRevision);
    // Runs through now plus clock skew, in segments: a strategy created near the
    // request may have ended much later, and truncating the range would miss it.
    const startTime = created - window, endTime = Math.max(created + window, now() + VENUE_CLOCK_TOLERANCE_MS), ended = [];
    for (let from = startTime; from < endTime; from += STRATEGY_QUERY_STEP_MS) {
      const range = { startTime: from, endTime: Math.min(from + STRATEGY_QUERY_STEP_MS, endTime) };
      const rows = await call(signal => ctx.client.endedStrategies(ctx.credentials, { ...ctx.options, signal, symbol: order.spec.symbol, ...range }));
      requireLease();
      if (!Array.isArray(rows)) throw new ExecutionError(502, '无法读取 Bybit 已终结追逐策略，暂不确认');
      ended.push(...rows);
    }
    // History can span several awaited reads. Take the current position/orders
    // only after all segments finish, then keep the final checks synchronous.
    const { account, matches } = await freshPosition(order);
    context(order.exchange, order.accountRevision);
    if (!Array.isArray(account?.strategies)) throw new ExecutionError(502, '无法读取 Bybit 追逐策略，暂不确认');
    // Strategies any Hub job already claimed are accounted for by that job.
    const claimed = new Set(stmt.prepare("SELECT json_extract(json,'$.remoteId') AS id FROM execution_orders WHERE json_extract(json,'$.exchange')='bybit' AND IFNULL(json_extract(json,'$.kind'),'strategy')='strategy' AND json_extract(json,'$.remoteId') IS NOT NULL").all().map(row => row.id));
    const nearby = strategy => { const time = Date.parse(strategy.createdAt); return !Number.isFinite(time) || Math.abs(time - created) <= window; };
    const candidates = [...account.strategies, ...ended].filter(strategy => strategy.symbol === order.spec.symbol && !claimed.has(strategy.id));
    if (candidates.some(strategy => strategy.status !== 'terminal')) throw new ExecutionError(409, 'Bybit 该合约仍有运行中的追逐策略，请填写其策略编号核对');
    if (candidates.some(nearby)) throw new ExecutionError(409, 'Bybit 存在下单时段前后创建的同合约追逐策略，请填写其策略编号核对');
    if (!matches) throw new ExecutionError(409, 'Bybit 当前仓位或挂单与本任务已知成交不一致，不能确认策略未创建');
    const current = orderFor(order.localId);
    if (current.settled || current.remoteId) return;
    if (!current.unknown) throw new ExecutionError(409, '待核对委托已变化，请重新核对');
    settleNotCreated(current, `Bybit ${current.spec.symbol} 经人工确认且交易所无对应追逐策略，判定未创建`);
  }
  // A cancel that was sent but left the order working is retried a bounded
  // number of times; repeating an exact-ID cancel can only reduce exposure.
  // `sending` survives here only when the process stopped during the request.
  // `cancelAttempt` only names the shared operation; the budget counts
  // requests that may have reached the venue (`cancelSent`). Older records
  // without it assume every past sequence number was sent.
  const cancelSends = order => order.cancelSent ?? (order.cancelRequestedAt || order.cancelAttempt ? (order.cancelAttempt || 0) + 1 : 0);
  const cancelSpent = order => cancelSends(order) >= CANCEL_ATTEMPTS;
  const cancelRecent = order => !!order.cancelRequestedAt && now() - Date.parse(order.cancelRequestedAt) < CANCEL_RETRY_MS;
  function retryCancel(order, operation) {
    if (order.settled || !order.remoteId || cancelSpent(order)) return false;
    if (order.writerOperation?.operationId !== operation.operationId || !['sending', 'unknown', 'confirmed'].includes(order.writerOperation.state)) return false;
    if (cancelRecent(order)) return false;
    if (accountWriter && order.writerOperation.state !== 'confirmed') {
      const ticket = protectJob(jobFor(order.jobId));
      if (accountWriter.unresolved(ticket).some(item => item.operationId === operation.operationId)) accountWriter.resolve(operation.operationId, ticket, 'rejected');
      order.writerOperation.state = 'rejected';
    }
    order.cancelSent ??= cancelSends(order); order.cancelAttempt = (order.cancelAttempt || 0) + 1; saveOrder(order);
    return true;
  }
  async function cancelOrder(order) {
    requireLease();
    if (order.settled) return;
    if (accountWriter && order.unknown && order.remoteId) {
      try { await inspectOrder(order, undefined, true); } catch { /* A known original ID can still be safely cancelled; the adapter validates it again. */ }
      order = orderFor(order.localId); if (order.settled) return;
    }
    if (!order.remoteId) {
      try { await inspectOrder(order); } catch { /* An absent Binance lookup is never proof that create failed. */ }
      order = orderFor(order.localId);
      if (!order.remoteId || order.settled) return;
    }
    const ctx = context(order.exchange, order.accountRevision);
    // A rejected cancel, or any repeat cancel when no shared writer records
    // outcomes, is resent under the same attempt limit and spacing.
    if (order.writerOperation?.action === 'cancel' && order.writerOperation.state === 'rejected' || !accountWriter && order.cancelRequestedAt) {
      if (cancelSpent(order) || cancelRecent(order)) { await inspectOrder(order, undefined, true); return; }
      order.cancelSent ??= cancelSends(order); order.cancelAttempt = (order.cancelAttempt || 0) + 1;
    }
    let operation;
    try { operation = prepareWrite(order, 'cancel'); }
    catch { await inspectOrder(order, undefined, true); return; }
    if (operation?.skip) {
      await inspectOrder(order, undefined, true);
      if (!retryCancel(orderFor(order.localId), operation)) return;
      order = orderFor(order.localId);
      try { operation = prepareWrite(order, 'cancel'); }
      catch { await inspectOrder(order, undefined, true); return; }
      if (operation?.skip) return;
    }
    // Count the request before transport so a crash mid-request stays counted;
    // only a guard refusal (nothing sent) gives the attempt and spacing back.
    const sentBefore = cancelSends(order), requestedBefore = order.cancelRequestedAt;
    order.cancelRequestedAt = iso(now()); order.cancelSent = sentBefore + 1; order.state = 'canceling'; saveOrder(order);
    try {
      await call(signal => ctx.client.stop(ctx.credentials, { ...order.spec, id: order.remoteId }, { ...ctx.options, signal, beforeMutation: () => { requireLease(); if (operation) { try { accountWriter.assertOwned(operation, callTimeoutMs); } catch { throw new NotSubmittedError('账户写入许可已变化，本次撤单未发送'); } } } }));
      order.cancelDeferrals = 0; finishWrite(operation, 'confirmed', order); saveOrder(order);
    }
    catch (error) {
      if (error instanceof NotSubmittedError) Object.assign(order, { cancelSent: sentBefore, cancelRequestedAt: requestedBefore });
      // An adapter refusal before sending (venue cooldown, local rate limit)
      // keeps the spacing but not the attempt, so a cooldown cannot use up
      // the cancel budget; its own cap keeps the retries bounded.
      else if (error instanceof ExecutionExchangeError && error.notSent) {
        if ((order.cancelDeferrals ?? 0) < CANCEL_DEFERRALS) Object.assign(order, { cancelSent: sentBefore, cancelDeferrals: (order.cancelDeferrals ?? 0) + 1 });
      } else order.cancelDeferrals = 0;
      finishWrite(operation, error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain ? 'rejected' : 'unknown', order);
      saveOrder(order);
      /* Even a failed or timed-out stop must be reconciled by a fresh query. */
    }
    await inspectOrder(orderFor(order.localId), undefined, true);
  }
  async function amendOrder(job, leg, order, market) {
    writable();
    if (!['binance', 'okx', 'rh-lighter'].includes(order.exchange) || legOrderType(order.spec) !== 'chase' || !order.remoteId || order.settled || order.unknown || order.amendPending || order.cancelRequestedAt) throw new ExecutionError(409, '原订单尚未确认，禁止追价');
    if ((order.amendCount ?? 0) >= 9000) throw new ExecutionError(409, '原订单已达到追价次数上限，请停止后重新预览');
    const ctx = context(order.exchange, order.accountRevision), lighter = order.exchange === 'rh-lighter';
    const passive = leg.orderSide === 'buy' ? market.bid : market.ask;
    // A manual resume drops the automatic guard and uses the plan's own limit.
    const target = lighter ? { limitPrice: passive, stopPrice: jobFor(job.id).auto?.guard ? order.spec.stopPrice : leg.stopPrice ?? null }
      : order.spec.limitPrice ? (jobFor(job.id).auto?.guard ? { limitPrice: passive } : { limitPrice: null, stopPrice: leg.stopPrice ?? null }) : {};
    if (lighter) {
      const amendVersion = Math.max(now(), (order.orderVersion ?? 0) + 1, (order.amendVersion ?? 0) + 1);
      if (!Number.isSafeInteger(amendVersion) || amendVersion <= 0) throw new ExecutionError(409, 'Lighter RH 改单版本超出安全范围，停止追价');
      Object.assign(order, { amendVersion, amendTarget: target, amendSentAt: iso(now()) });
    }
    // Amend the original total, never its remainder. Existing fills continue to
    // belong to the same order; this intent must survive a lost acknowledgement.
    Object.assign(order, { state: 'amending', amendPending: true, unknown: true, lastAmendAt: iso(now()), amendCount: (order.amendCount ?? 0) + 1 });
    saveOrder(order);
    let operation;
    try {
      operation = prepareWrite(order, 'amend', { quantity: order.spec.quantity, price: passive, ...(lighter ? { amendVersion: order.amendVersion } : {}) });
      const beforeMutation = () => {
        requireLease();
        if (operation) { try { accountWriter.assertOwned(operation, callTimeoutMs); } catch { throw new NotSubmittedError('账户写入许可已变化，本次追价未发送'); } }
        const current = jobFor(job.id), original = orderFor(order.localId);
        if (closing || stopRequested(job.id) || !['queued', 'running'].includes(current.status) || current.phase !== job.phase || current.batchIndex !== job.batchIndex || now() >= Date.parse(current.deadlineAt)
            || original.settled || original.remoteId !== order.remoteId || !original.amendPending) throw new NotSubmittedError('任务或原订单已停止，本次追价未发送');
        try { normalizeMarket(market, leg.symbol, now(), leg.exchange); } catch (error) { throw new NotSubmittedError(`${safeError(error)}；本次追价未发送`); }
        if (stopReached(leg, market)) throw new NotSubmittedError('已达到追价界限，本次追价未发送');
        if (current.auto?.guard && atBound(original, leg, market)) throw new NotSubmittedError('已达到本批价差界限，本次追价未发送');
      };
      const value = await call(signal => ctx.client.amend(ctx.credentials, { ...order.spec, ...target, id: order.remoteId }, { ...ctx.options, signal, beforeMutation, amendSequence: order.amendCount, ...(lighter ? { amendVersion: order.amendVersion } : {}) }));
      requireLease();
      const current = orderFor(order.localId), filledQuantity = validateInspection(current, value);
      if (!lighterAmendVisible(current, value)) throw new ExecutionExchangeError('upstream', { uncertain: true, detail: 'Lighter RH 改单目标版本尚未可见' });
      Object.assign(current, { spec: { ...current.spec, ...target }, filledQuantity, unknown: false, amendPending: false, state: value.status, price: value.price ?? null, lastCheckedAt: iso(now()), settled: value.terminal && value.childrenSettled });
      if (lighter) { current.orderVersion = value.orderVersion ?? 0; clearAmendDeferral(current); }
      finishWrite(operation, 'confirmed', current);
      saveOrder(current);
      if (current.settled && compareDecimals(current.filledQuantity, current.spec.quantity) < 0) pause(job.id, '原生追价后订单提前终止且未全部成交，暂停其余交易腿');
    } catch (error) {
      requireLease();
      // A rejected amendment says nothing about whether the original order is
      // still live. Keep it unsettled until inspection and stop finish normally.
      const current = orderFor(order.localId);
      const rejected = error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain;
      finishWrite(operation, rejected ? 'rejected' : 'unknown', current);
      if (current.amendPending) {
        current.amendPending = lighter && !rejected;
        current.unknown = !rejected;
        current.state = current.unknown ? 'unknown' : 'working'; saveOrder(current);
      }
      if (lighter && error instanceof ExecutionExchangeError) {
        if (error.uncertain) {
          clearAmendDeferral(current); saveOrder(current);
          const latest = jobFor(job.id);
          event(latest, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 改单结果尚未确认，继续核对原委托版本，期间不追价、不下新单`); saveJob(latest); return;
        }
        if (error.notSent && (error.rateLimited || DEFERRABLE_CODES.has(error.code)) && deferAmend(current, error)) return;
      }
      pause(job.id, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 原生追价结果：${safeError(error)}`);
    }
  }
  function deferAmend(order, error) {
    const time = now(), previous = order.amendDeferral, since = previous?.since ?? time, count = previous?.count ?? 0;
    if (count >= RATE_READ_RETRIES || time - since >= RATE_READ_WINDOW_MS) return false;
    const reason = `${TRADING_NAMES[order.exchange]} ${order.spec.symbol} 改单明确未发送（${safeError(error)}），保留原委托，等待恢复后自动核对`;
    order.amendDeferral = { since, count: count + 1, retryAt: Math.max(time + SEND_DEFER_MS, Number.isSafeInteger(error.retryAt) ? error.retryAt : 0), reason };
    saveOrder(order);
    const job = jobFor(order.jobId); job.reason = reason;
    if (!previous) event(job, `${reason}（最多重试 ${RATE_READ_RETRIES} 次、${RATE_READ_WINDOW_MS / 1000} 秒）`);
    saveJob(job); return true;
  }
  function clearAmendDeferral(order) {
    if (!order.amendDeferral) return;
    const job = jobFor(order.jobId);
    if (job.reason === order.amendDeferral.reason) job.reason = null;
    event(job, 'Lighter RH 改单等待已结束，已核对原委托状态'); saveJob(job);
    order.amendDeferral = null;
  }
  // A remainder the venue would refuse (below its minimum) keeps resting at its price instead of being cancelled.
  function resendable(order, market, action) {
    try { checkChildQuantity(subtract(order.spec.quantity, order.filledQuantity), market, action, 'chase'); return true; } catch { return false; }
  }
  function hyperliquidLimit(leg, market) {
    const passive = leg.orderSide === 'buy' ? market.bid : market.ask, taker = leg.orderSide === 'buy' ? market.ask : market.bid;
    return legOrderType(leg) === 'market' ? taker : passive;
  }
  // The adapter repeats this check, but only after a sibling leg may already be sent.
  function checkHyperliquidPrice(leg, market) {
    const order = { side: leg.orderSide, orderType: legOrderType(leg), limitPrice: hyperliquidLimit(leg, market), stopPrice: leg.stopPrice ?? null };
    const decimals = leg.exchange === 'rh-lighter' ? null : stepDecimals(leg.rule?.quantityStep);
    const { problem } = leg.exchange === 'rh-lighter' ? rhLighterOrderPrice(order, market.rule.tickSize)
      : decimals === null ? { problem: '下单步长不是十的整数次幂' } : orderPrice(order, decimals);
    if (problem) throw new ExecutionError(409, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} ${problem}，本组交易腿均未发送`);
  }
  function resendAt(job, all, leg) {
    if (leg.exchange !== 'rh-lighter') return 0;
    const last = all.filter(order => order.legId === leg.id).reduce((latest, order) => !latest || order.createdAt > latest.createdAt ? order : latest, null);
    return Math.max(job.sendDeferrals?.[leg.id]?.retryAt ?? 0, last?.bounced ? Date.parse(last.createdAt) + RH_LIGHTER_MIN_REPRICE_MS : 0);
  }
  function clearSendDeferral(jobId, legId) {
    const job = jobFor(jobId);
    if (!job.sendDeferrals?.[legId]) return;
    const { [legId]: _cleared, ...rest } = job.sendDeferrals;
    job.sendDeferrals = rest; saveJob(job);
  }
  // True when a Lighter RH create that did not reach the order book is left for a later tick.
  function deferSend(jobId, leg, error) {
    if (error.uncertain || !(error.rateLimited || error.notSent && DEFERRABLE_CODES.has(error.code))) return false;
    const job = jobFor(jobId), count = job.sendDeferrals?.[leg.id]?.count ?? 0;
    if (count >= CREATE_DEFERRALS) return false;
    const time = now(), hinted = Number.isSafeInteger(error.retryAt) ? Math.min(error.retryAt, time + MAX_SEND_DEFER_MS) : 0;
    const retryAt = Math.max(time + SEND_DEFER_MS, hinted);
    job.sendDeferrals = { ...job.sendDeferrals, [leg.id]: { count: count + 1, retryAt } };
    if (!count) event(job, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 本次建单未送达交易所（${safeError(error)}），${Math.ceil((retryAt - time) / 1000)} 秒后按最新盘口重新下单；连续 ${CREATE_DEFERRALS} 次未送达则暂停`);
    saveJob(job);
    return true;
  }
  async function submit(job, leg, quantity, market) {
    writable();
    if (!['queued', 'running'].includes(jobFor(job.id).status)) return;
    const all = orders(job.id);
    if (all.length >= 4000) throw new ExecutionError(409, '已达到本任务委托次数上限，请停止后另建任务');
    if (all.some(order => order.legId === leg.id && !order.settled)) throw new ExecutionError(409, '前一委托尚未结束，禁止重复下单');
    const ctx = context(leg.exchange, leg.accountRevision), localId = randomUUID();
    const orderType = legOrderType(leg);
    const bound = job.auto?.guard && orderType === 'chase' ? job.auto.boundsBatch === job.batchIndex && job.auto.bounds?.[leg.id] : null;
    if (bound === false || bound === undefined) throw new ExecutionError(409, '自动任务缺少本批价差界限，暂停发送');
    // Binance QUEUE prices at match time, so an automatic leg there rests at the
    // explicit maker price already checked against its limit instead.
    // Hyperliquid has no venue-side book pegging: chase legs rest at the same-side
    // best price and market legs start from the opposite best (the adapter adds
    // its 1% protection), both from the book that just passed the send checks.
    const limitPrice = WALLET_VENUES.has(leg.exchange) ? hyperliquidLimit(leg, market) : bound && leg.exchange === 'binance' ? (leg.orderSide === 'buy' ? market.bid : market.ask) : null;
    const spec = { symbol: leg.symbol, side: leg.orderSide, positionSide: positionSide(leg), quantity, reduceOnly: job.plan.action === 'close', clientId: 'h' + createHash('sha256').update(localId).digest('hex').slice(0, 30), orderType, stopPrice: bound ?? leg.stopPrice ?? null,
      ...(limitPrice ? { limitPrice } : {}), ...(leg.exchange === 'okx' ? { contractSize: leg.rule.contractSize, instrumentId: leg.rule.instrumentId } : {}),
      ...(WALLET_VENUES.has(leg.exchange) ? { assetId: leg.rule.assetId } : {}) };
    const order = { localId, jobId: job.id, legId: leg.id, exchange: leg.exchange, accountRevision: leg.accountRevision, phase: job.phase, batch: job.batchIndex,
      kind: leg.exchange === 'bybit' && orderType === 'chase' ? 'strategy' : 'order', remoteId: null, spec, state: 'submitting', unknown: true, settled: false, filledQuantity: '0', price: null, lastCheckedAt: null, createdAt: iso(now()), cancelRequestedAt: null };
    // Persist intent before the network call. On restart an unanswered intent is uncertain.
    saveOrder(order);
    let operation;
    try {
      operation = prepareWrite(order, 'create', { quantity, side: spec.side, positionSide: spec.positionSide, reduceOnly: spec.reduceOnly, orderType, stopPrice: spec.stopPrice });
      const beforeMutation = () => {
        requireLease();
        if (operation) { try { accountWriter.assertOwned(operation, callTimeoutMs); } catch { throw new NotSubmittedError('账户写入许可已变化，本次建单未发送'); } }
        const current = jobFor(job.id);
        if (closing || stopRequested(job.id) || !['queued', 'running'].includes(current.status) || current.phase !== job.phase || current.batchIndex !== job.batchIndex || now() >= Date.parse(current.deadlineAt)) throw new NotSubmittedError('任务已停止或执行时间已到，本次建单未发送');
        try { normalizeMarket(market, leg.symbol, now(), leg.exchange); } catch (error) { throw new NotSubmittedError(`${safeError(error)}；本次建单未发送`); }
      };
      const result = await call(signal => ctx.client.create(ctx.credentials, spec, { ...ctx.options, signal, beforeMutation }));
      requireLease();
      if (!result || typeof result.id !== 'string' || !result.id || result.kind !== order.kind) throw new Error('Uncertain acknowledgement');
      Object.assign(order, { remoteId: result.id, unknown: false, state: 'working' });
      finishWrite(operation, 'confirmed', order);
      saveOrder(order);
      clearSendDeferral(job.id, leg.id);
    } catch (error) {
      // A stale process must not overwrite reconciliation performed by a new owner.
      requireLease();
      finishWrite(operation, error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain ? 'rejected' : 'unknown', order);
      if (error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain) Object.assign(order, { state: 'rejected', settled: true, unknown: false });
      else Object.assign(order, { state: 'unknown', unknown: true });
      if (order.exchange === 'rh-lighter' && error instanceof ExecutionExchangeError) {
        // Accepted by sendTx but not yet visible: the order is looked up by its
        // client index on later ticks (pendingVisible) instead of pausing the
        // task and cancelling a hedge leg that may already have filled.
        if (error.uncertain && error.accepted) {
          order.acceptedAt = iso(now()); saveOrder(order); clearSendDeferral(job.id, leg.id);
          const latest = jobFor(job.id);
          event(latest, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 委托已被交易所接受但尚未查到，按客户订单号继续核对，期间不追价、不撤单、不下新单`); saveJob(latest);
          return;
        }
        if (deferSend(job.id, leg, error)) { saveOrder(order); return; }
      }
      if (!(error instanceof NotSubmittedError)) clearSendDeferral(job.id, leg.id);
      // A post-only bounce rests and fills nothing; the next pass re-reads the
      // book and re-sends through the full send checks instead of pausing.
      if (error instanceof ExecutionExchangeError && error.repriceable && !error.uncertain && order.exchange === 'hyperliquid') {
        order.bounced = true; saveOrder(order);
        const latest = jobFor(job.id); if (latest.lastBounceEvent !== leg.id) { latest.lastBounceEvent = leg.id; event(latest, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 只挂单因盘口变化被拒绝，按最新盘口重新挂单`); saveJob(latest); }
        return;
      }
      saveOrder(order); pause(job.id, `${leg.exchange} ${leg.symbol} 下单结果：${safeError(error)}`);
    }
  }
  async function stopping(job) {
    const initial = orders(job.id).filter(unsettled);
    await Promise.allSettled(initial.map(cancelOrder));
    // An exact original-order cancel can clear an unknown amendment while a
    // sibling was blocked by that uncertainty. Allow one bounded cleanup pass.
    const remaining = orders(job.id).filter(unsettled);
    if (accountWriter && remaining.length && remaining.length < initial.length) await Promise.allSettled(remaining.map(cancelOrder));
    requireLease();
    const latest = jobFor(job.id), all = orders(job.id);
    if (all.every(order => order.settled)) {
      // A durable stop request outlives a pause that could not be saved (lost account ownership, restart recovery).
      latest.status = latest.stopTarget === 'stopped' || stopRequested(latest.id) ? 'stopped' : 'paused';
      event(latest, latest.status === 'stopped' ? '所有已知委托已结束；任务停止，已成交仓位保留' : '余单已核对结束；保留已成交仓位，继续需重新预览剩余数量');
      transaction(() => { saveJob(latest); if (latest.status === 'stopped') stmt.prepare('DELETE FROM execution_locks WHERE job_id=?').run(job.id); });
    } else {
      latest.status = 'attention'; latest.reason = '仍有委托结果未确认；已停止后续下单，请核对策略编号或重试撤单'; saveJob(latest);
    }
  }
  // An automatic job re-checks its rule's threshold on the books each new
  // batch is sent from. Nothing sent yet: the job ends unsent and the rule
  // goes back to waiting. A later batch waits for the spread (or the deadline)
  // so the legs already filled are not added to at a worse spread. A passing
  // check fixes per-leg chase limits for the batch (boundsFor): every order
  // and amendment of the batch stays inside them, including a leg re-sent
  // alone, so fills keep the spread at or beyond the threshold.
  function guardMet(id, job, candidates, markets, all, received) {
    const raw = leg => markets.get(`${leg.exchange}:${leg.symbol}`);
    const books = { books: candidates.map(({ leg }) => { const value = raw(leg); return { exchange: leg.exchange, symbol: value.symbol, bid: value.bid, ask: value.ask, at: value.at }; }) };
    // Both books must be just read (local receive time, immune to venue clock
    // skew): a slow leg must not pair a current book with one seconds old.
    const oldest = Math.min(...candidates.map(({ leg }) => received.get(`${leg.exchange}:${leg.symbol}`) ?? -Infinity));
    const reading = now() - oldest > AUTO_BOOK_WINDOW_MS ? { error: '两腿盘口读取间隔过长' } : evaluateRule(job.auto.guard, job.plan.action, books, now());
    const latest = jobFor(id);
    if (!['queued', 'running'].includes(latest.status)) return false;
    let bounds = null;
    if (!reading.error && reading.met) {
      const premiumSymbol = SPREADS[job.auto.guard.market].premium, book = leg => ({ ...raw(leg), tickSize: raw(leg).rule.tickSize });
      const premiumLeg = job.plan.legs.find(leg => leg.symbol === premiumSymbol), baseLeg = job.plan.legs.find(leg => leg.symbol !== premiumSymbol);
      const limits = boundsFor(job.auto.guard, job.plan.action, book(premiumLeg), book(baseLeg));
      if (limits) bounds = { [premiumLeg.id]: limits.premium, [baseLeg.id]: limits.base };
      // Every limit is checked before any leg is sent, so no leg can go out alone.
      if (bounds && job.plan.legs.some(leg => legOrderType(leg) === 'chase' && (compareDecimals(bounds[leg.id], '0') <= 0 || stopReached({ ...leg, stopPrice: bounds[leg.id] }, raw(leg))))) bounds = null;
    }
    if (bounds) {
      if (latest.auto.waiting) event(latest, '可成交价差重新满足阈值，继续发送');
      latest.auto = { ...latest.auto, waiting: false, bounds, boundsBatch: latest.batchIndex };
      saveJob(latest);
      return true;
    }
    const why = reading.error ? `盘口不可用（${reading.error}）` : reading.met ? '无法设定有效的价差界限' : '可成交价差已不满足阈值';
    if (!all.length) {
      Object.assign(latest, { status: 'stopped', reason: `发送前复核：${why}，未发送任何委托`, auto: { ...latest.auto, unsent: true } });
      event(latest, latest.reason);
      transaction(() => { saveJob(latest); stmt.prepare('DELETE FROM execution_locks WHERE job_id=?').run(id); });
    } else if (!latest.auto.waiting) { latest.auto = { ...latest.auto, waiting: true }; event(latest, `${why}，暂缓发送下一批`); saveJob(latest); }
    return false;
  }
  const atBound = (order, leg, market) => !!order.spec.stopPrice && stopReached({ ...leg, stopPrice: order.spec.stopPrice }, market);
  function holdAtBound(id, leg) {
    const latest = jobFor(id), key = `${latest.batchIndex}:${leg.id}`;
    if (latest.auto.held === key) return;
    latest.auto = { ...latest.auto, held: key }; event(latest, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 已到本批价差界限，委托保留原价、不再追价`); saveJob(latest);
  }
  const heldRemainders = new Set();
  function holdRemainder(id, leg) {
    const latest = jobFor(id), key = `${id}:${latest.batchIndex}:${leg.id}`;
    if (heldRemainders.has(key)) return;
    heldRemainders.add(key); event(latest, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 剩余数量低于交易所最小下单量，委托保留原价、不再追价`); saveJob(latest);
  }
  // Transport-level read failures; data, identity and rejection errors still pause at once.
  const transientRead = error => !closing && (error instanceof RateLimitedReadError || error instanceof ExecutionExchangeError
    && (['timeout', 'transport', 'upstream', 'aborted'].includes(error.code) || error.code === 'rejected' && RATE_LIMIT_CODES.has(error.providerCode)));
  function deferRateRead(id, error) {
    const time = now(), previous = rateReadFailures.get(id), since = previous?.since ?? time;
    const count = previous?.count ?? 0;
    if (count >= RATE_READ_RETRIES || time - since >= RATE_READ_WINDOW_MS) return false;
    const reason = `${safeError(error)}；等待限速恢复后自动核对，期间不追价、不下新单`;
    const job = jobFor(id);
    if (!previous) event(job, `${reason}（最多重试 ${RATE_READ_RETRIES} 次、${RATE_READ_WINDOW_MS / 1000} 秒）`);
    rateReadFailures.set(id, { since, count: count + 1, retryAt: Math.max(time + RATE_READ_RETRY_MS, error.retryAt), reason });
    job.reason = reason; saveJob(job); return true;
  }
  function rateReadsRecovered(id) {
    const previous = rateReadFailures.get(id);
    if (!previous) return;
    rateReadFailures.delete(id);
    const job = jobFor(id);
    if (job.reason === previous.reason) job.reason = null;
    event(job, 'Lighter RH 限速后的必要读取与校验已恢复，继续执行'); saveJob(job);
  }
  function externalOrdersRecovered(id) {
    const reason = externalWaits.get(id);
    if (reason === undefined) return;
    externalWaits.delete(id);
    const job = jobFor(id);
    if (job.reason === reason) job.reason = null;
    event(job, '外部委托已撤销，继续下一批'); saveJob(job);
  }
  function marketsRecovered(id) {
    if (!marketFailures.delete(id)) return;
    const job = jobFor(id); job.reason = null;
    event(job, '盘口已恢复新鲜，继续校验并执行'); saveJob(job);
  }
  function deferPositionRead(id, error) {
    const job = jobFor(id), previous = job.positionReadWait;
    const time = now(), attempts = (previous?.attempts ?? 0) + 1;
    const deadlineAt = previous?.deadlineAt ?? Math.min(time + POSITION_READ_WINDOW_MS, Date.parse(job.deadlineAt));
    if (previous && (previous.phase !== job.phase || previous.batchIndex !== job.batchIndex)
      || attempts >= POSITION_READ_ATTEMPTS || time >= deadlineAt) return false;
    const reason = `${safeError(error)}；等待交易所持仓反映上一批成交，期间不发送新批次`;
    if (!previous) event(job, `${reason}（最多重读 ${POSITION_READ_ATTEMPTS - 1} 次、${POSITION_READ_WINDOW_MS / 1000} 秒）`);
    job.positionReadWait = { phase: job.phase, batchIndex: job.batchIndex, since: previous?.since ?? time, deadlineAt,
      attempts, retryAt: time + POSITION_READ_INTERVAL_MS, reason };
    job.reason = reason; saveJob(job); return true;
  }
  function checkPositionReadBudget(job) {
    const wait = job.positionReadWait;
    if (wait && (wait.phase !== job.phase || wait.batchIndex !== job.batchIndex || now() >= wait.deadlineAt || wait.attempts >= POSITION_READ_ATTEMPTS)) {
      throw new ExecutionError(409, '持仓反映已成交减仓的等待已达上限，请核对后再继续');
    }
  }
  function positionsRecovered(id) {
    const job = jobFor(id), wait = job.positionReadWait;
    if (!wait) return;
    // A successful but slow read cannot extend the absolute wait window.
    checkPositionReadBudget(job);
    if (job.reason === wait.reason) job.reason = null;
    delete job.positionReadWait;
    event(job, '持仓已反映上一批确认成交，重新核验通过，继续下一批'); saveJob(job);
  }
  async function runJob(id) {
    if (busyJobs.has(id)) return; busyJobs.add(id);
    try {
      requireLease(); let job = jobFor(id);
      protectAndRecover(job);
      if (stopRequested(id) && ACTIVE.has(job.status) && job.status !== 'stopping') { pause(id, '用户停止：等待当前合法写者核对原委托', 'stopped'); job = jobFor(id); }
      if (job.status === 'stopping' || job.status === 'attention') { await stopping(job); return; }
      if (!['queued', 'running'].includes(job.status)) return;
      protectJob(job);
      if (now() >= Date.parse(job.deadlineAt)) { pause(id, '执行时间已到，停止追价并撤销余单'); await stopping(jobFor(id)); return; }
      checkPositionReadBudget(job);
      if (job.positionReadWait && now() < job.positionReadWait.retryAt) return;
      const rateWait = rateReadFailures.get(id);
      if (rateWait && now() - rateWait.since >= RATE_READ_WINDOW_MS) throw new ExecutionError(502, 'Lighter RH 持续限速，自动恢复已达到时间上限，暂停并核对余单');
      if (rateWait && now() < rateWait.retryAt) return;
      const amendWaits = orders(id).filter(unsettled).map(order => order.amendDeferral).filter(Boolean);
      if (amendWaits.some(wait => now() - wait.since >= RATE_READ_WINDOW_MS)) throw new ExecutionError(502, 'Lighter RH 改单持续未能发送，自动恢复已达到时间上限，暂停并核对余单');
      if (amendWaits.some(wait => now() < wait.retryAt)) return;
      const allBefore = orders(id), working = allBefore.filter(unsettled);
      if (working.length) {
        const readings = await Promise.allSettled(working.map(order => inspectOrder(order)));
        const active = [];
        for (const [index, original] of working.entries()) {
          if (readings[index].status !== 'fulfilled' || readings[index].value !== true) continue;
          const order = orderFor(original.localId), leg = job.plan.legs.find(item => item.id === order.legId);
          if (order.settled) {
            if (compareDecimals(order.filledQuantity, order.spec.quantity) < 0 && !order.cancelRequestedAt && !order.bounced) throw new ExecutionError(409, legOrderType(order.spec) === 'market' ? `${TRADING_NAMES[order.exchange]} ${order.spec.symbol} 市价单未全部成交（流动性不足或交易所价格保护），暂停其余交易腿` : '委托提前终止且未全部成交，暂停其余交易腿');
            continue;
          }
          if (order.state === 'paused' || order.state === 'terminal') throw new ExecutionError(409, '交易所策略暂停或子单尚未结束，暂停其余交易腿');
          active.push({ order, leg });
        }
        const unread = working.map((order, index) => ({ order, result: readings[index] })).filter(({ result }) => result.status === 'rejected' || result.value === false);
        // An accepted Lighter RH create that is not visible yet holds the task (no
        // reprice, cancel or new send) until its signed expiry plus the
        // not-created check has passed; only then does a miss pause the task.
        const pending = unread.filter(({ order, result }) => {
          const current = orderFor(order.localId);
          return pendingVisible(current) && result.status === 'rejected' && (result.reason?.notFound || transientRead(result.reason))
            || pendingAmendVisible(current) && (result.status === 'fulfilled' && result.value === false || result.status === 'rejected' && (result.reason?.notFound || transientRead(result.reason)));
        });
        const failed = unread.filter(item => !pending.includes(item));
        const limited = unread.filter(({ result }) => result.status === 'rejected' && result.reason instanceof RateLimitedReadError);
        // A malformed/foreign sibling response still wins over a cooldown.
        if (limited.length && failed.every(({ result }) => result.status === 'rejected' && transientRead(result.reason))) {
          throw limited.reduce((latest, item) => item.result.reason.retryAt > latest.retryAt ? item.result.reason : latest, limited[0].result.reason);
        }
        if (!failed.length && pending.length) {
          // A definitive not-found is a successful read while an accepted
          // transaction is still becoming visible. Keep its original signed
          // observation window; a past rate limit must not shorten that window.
          if (pending.every(({ result }) => result.status === 'fulfilled' || result.reason?.notFound)) rateReadsRecovered(id);
          // Every other read succeeded: an earlier transient streak must not carry over the hold.
          if (readFailures.delete(id)) { const latest = jobFor(id); event(latest, '委托状态已恢复读取，继续执行'); saveJob(latest); }
          return;
        }
        if (failed.length) {
          const detail = failed.map(({ order, result }) => `${TRADING_NAMES[order.exchange]} ${order.spec.symbol}：${result.status === 'rejected' ? safeError(result.reason) : '提交结果尚未查到'}`).join('；');
          const streak = readFailures.get(id) ?? { since: now(), count: 0 };
          if (failed.every(({ result }) => result.status === 'rejected' && transientRead(result.reason)) && (streak.count < READ_RETRY_ATTEMPTS || now() - streak.since < READ_RETRY_MS)) {
            if (!streak.count) { const latest = jobFor(id); event(latest, `委托状态暂时读取失败（${detail}），至少重试 ${READ_RETRY_ATTEMPTS} 次、${READ_RETRY_MS / 1000} 秒，期间不追价、不下新单`); saveJob(latest); }
            readFailures.set(id, { ...streak, count: streak.count + 1 });
            return;
          }
          readFailures.delete(id);
          pause(id, `委托状态读取失败或提交结果不明（${detail}），暂停并撤销余单`); await stopping(jobFor(id)); return;
        }
        if (readFailures.delete(id)) { const latest = jobFor(id); event(latest, '委托状态已恢复读取，继续执行'); saveJob(latest); }
        job = jobFor(id);
        if (job.status === 'stopping') { await stopping(job); return; }
        // Check every resting leg before any reprice/cancel; a later stale leg
        // must not leave an earlier sibling already changed in this round.
        const { markets } = await collectMarkets(active.map(item => item.leg), (leg, market) => {
          checkContract(leg, market);
          if (stopReached(leg, market)) throw new ExecutionError(409, `${leg.exchange} ${leg.symbol} 已达到追价界限`);
        });
        for (const { order, leg } of active) {
          const market = normalizeMarket(markets.get(`${leg.exchange}:${leg.symbol}`), leg.symbol, now(), leg.exchange);
          // An automatic order rests at its last price rather than chase past the batch limit.
          if (job.auto?.guard && atBound(order, leg, market)) {
            if (order.amendDeferral) { clearAmendDeferral(order); saveOrder(order); }
            holdAtBound(id, leg); continue;
          }
          const repriceMs = leg.exchange === 'rh-lighter' ? Math.max(job.plan.repriceIntervalMs, RH_LIGHTER_MIN_REPRICE_MS) : job.plan.repriceIntervalMs;
          const repriceDue = legOrderType(leg) === 'chase' && now() - Date.parse(order.lastAmendAt ?? order.createdAt) >= repriceMs
            && (order.price === null || compareDecimals(order.price, leg.orderSide === 'buy' ? market.bid : market.ask) !== 0);
          if (order.amendDeferral && order.price !== null && compareDecimals(order.price, leg.orderSide === 'buy' ? market.bid : market.ask) === 0) { clearAmendDeferral(order); saveOrder(order); }
          if (['binance', 'okx', 'rh-lighter'].includes(leg.exchange) && !order.cancelRequestedAt && repriceDue) {
            await amendOrder(job, leg, order, market);
            if (jobFor(id).status === 'stopping') break;
            const latest = orderFor(order.localId);
            if (latest.amendPending || latest.amendDeferral) return;
          } else if (leg.exchange === 'hyperliquid' && order.remoteId && !order.unknown && !order.cancelRequestedAt && repriceDue && !resendable(order, market, job.plan.action)) {
            holdRemainder(id, leg);
          } else if (WALLET_VENUES.has(leg.exchange) && order.remoteId && !order.unknown && (order.cancelRequestedAt ? !cancelRecent(order) : leg.exchange === 'hyperliquid' && repriceDue && resendable(order, market, job.plan.action))) {
            // Hyperliquid modify assigns a new order id, so cancel the exact
            // original before sending its confirmed remainder. Also finish any
            // Lighter cancel already persisted by an earlier service version.
            // A cancel that left the order working is retried with the same spacing and budget as stopping.
            if (order.cancelRequestedAt && cancelSpent(order)) throw new ExecutionError(409, `${TRADING_NAMES[leg.exchange]} 追价撤单多次未生效，暂停其余交易腿`);
            await cancelOrder(order);
            if (jobFor(id).status === 'stopping') break;
          }
        }
      } else readFailures.delete(id);
      job = jobFor(id);
      if (job.status === 'stopping') { await stopping(job); return; }
      if (!['queued', 'running'].includes(job.status)) return;
      const all = orders(id);
      const remaining = job.plan.legs.map(leg => ({ leg, quantity: subtract(leg.batchQuantities[job.batchIndex], totalFilled(all, leg.id, job.phase, job.batchIndex)) }));
      if (remaining.some(item => compareDecimals(item.quantity, '0') < 0)) throw new ExecutionError(409, '本批成交量超出计划，请核对仓位');
      if (remaining.every(item => item.quantity === '0') && all.every(order => order.settled)) {
        rateReadsRecovered(id);
        marketsRecovered(id); job = jobFor(id);
        job.batchIndex += 1;
        event(job, `第 ${job.batchIndex} / ${job.plan.batchCount} 批全部成交且委托已结束`);
        if (job.batchIndex >= job.plan.batchCount) { job.status = 'completed'; job.reason = null; transaction(() => { saveJob(job); stmt.prepare('DELETE FROM execution_locks WHERE job_id=?').run(id); }); return; }
        job.nextBatchAt = now() + job.plan.batchIntervalMs; saveJob(job); return;
      }
      if (now() < job.nextBatchAt) return;
      const candidates = remaining.filter(item => compareDecimals(item.quantity, '0') > 0 && !all.some(order => order.legId === item.leg.id && !order.settled));
      if (!candidates.length) { rateReadsRecovered(id); marketsRecovered(id); return; }
      // The group waits for a deferred Lighter RH create and keeps re-sends after a post-only bounce apart.
      if (candidates.some(({ leg }) => now() < resendAt(job, all, leg))) return;
      const quantityFor = leg => candidates.find(item => item.leg.id === leg.id).quantity;
      const { markets, received, snapshots } = await collect(candidates.map(item => item.leg), {
        requireIdentity: !!job.riskReduction,
        validateAccount(leg, account) {
          const current = checkPosition(account, leg, job.plan.action, quantityFor(leg));
          if (job.riskReduction) {
            if (account.identity !== job.riskReduction.accounts[leg.exchange]?.identity) throw new ExecutionError(409, '自动减仓账户身份已变化');
            // Every batch must observe the prior fills. A stale pre-fill
            // position or an external position change cannot fund a new batch.
            const expected = subtract(leg.currentQuantity, totalFilled(all, leg.id, job.phase));
            if (compareDecimals(current, expected) !== 0) {
              const prior = all.filter(order => order.legId === leg.id && order.phase === job.phase && order.batch === job.batchIndex - 1);
              const filled = totalFilled(prior, leg.id, job.phase);
              const knownPrior = job.batchIndex > 0 && prior.length > 0 && all.every(order => order.settled && !order.unknown)
                && !all.some(order => order.phase === job.phase && order.batch >= job.batchIndex)
                && compareDecimals(filled, leg.batchQuantities[job.batchIndex - 1]) === 0;
              const message = `${leg.exchange} ${leg.symbol} 持仓未反映已成交减仓或被外部更改，请核对后再继续`;
              if (!knownPrior || compareDecimals(current, addDecimals([expected, filled])) !== 0) throw new ExecutionError(409, message);
              ensureNoExternalOrders(account, leg.symbol);
              throw new PositionProjectionWait(409, `${leg.exchange} ${leg.symbol} 仍返回上一批成交前持仓`);
            }
          }
          // Candidates have no unsettled own order. Even an eventually
          // consistent remaining venue order blocks another submit.
          ensureNoExternalOrders(account, leg.symbol);
        },
        validateMarket(leg, market) {
          checkContract(leg, market);
          checkChildQuantity(quantityFor(leg), market, job.plan.action, legOrderType(leg));
          if (stopReached(leg, market)) throw new ExecutionError(409, '最新盘口已达到追价界限');
          if (WALLET_VENUES.has(leg.exchange)) checkHyperliquidPrice(leg, market);
        },
      });
      positionsRecovered(id); rateReadsRecovered(id); marketsRecovered(id); externalOrdersRecovered(id); job = jobFor(id);
      if (job.riskReduction && !all.length && !readReductionRisk(job.riskReduction.config, snapshots, now()).met) {
        job.status = 'stopped'; job.reason = '首批发送前强平距离已恢复，本轮双边均未发送';
        event(job, job.reason);
        transaction(() => { saveJob(job); stmt.prepare('DELETE FROM execution_locks WHERE job_id=?').run(id); });
        return;
      }
      if (job.auto?.guard && candidates.length === job.plan.legs.length && !guardMet(id, job, candidates, markets, all, received)) return;
      writable(); job = jobFor(id);
      if (!['queued', 'running'].includes(job.status)) return;
      if (now() >= Date.parse(job.deadlineAt)) throw new ExecutionError(409, '执行时间已到，停止追价');
      job.status = 'running'; saveJob(job);
      // Every candidate is checked before any leg in this group is sent.
      await Promise.all(candidates.map(({ leg, quantity }) => submit(job, leg, quantity, markets.get(`${leg.exchange}:${leg.symbol}`))));
      if (jobFor(id).status === 'stopping') await stopping(jobFor(id));
    } catch (error) {
      try {
        requireLease();
        const latest = jobFor(id);
        let message = safeError(error);
        if (error instanceof PositionProjectionWait && latest.riskReduction && !closing && !stopRequested(id) && ['queued', 'running'].includes(latest.status) && now() < Date.parse(latest.deadlineAt)) {
          if (deferPositionRead(id, error)) return;
          message = '持仓反映已成交减仓的等待已达上限，请核对后再继续';
        }
        if (error instanceof RateLimitedReadError && !closing && !stopRequested(id) && ['queued', 'running'].includes(latest.status) && now() < Date.parse(latest.deadlineAt)) {
          if (deferRateRead(id, error)) return;
          message = `Lighter RH 持续限速，自动恢复已达到重试上限（${message}）`;
        }
        // A risk reduction must not be abandoned because the owner placed a
        // TP/SL or limit order between batches: hold the next batch (nothing
        // is sent or cancelled) until it is gone or the task deadline passes.
        if (error instanceof ExternalOrdersError && latest.riskReduction && !closing && !stopRequested(id) && ['queued', 'running'].includes(latest.status) && now() < Date.parse(latest.deadlineAt)) {
          const reason = `${message.replace(/，请先处理后再预览$/, '')}；撤销后继续下一批，期间不发送新批次`;
          if (latest.reason !== reason) { latest.reason = reason; event(latest, reason); saveJob(latest); }
          externalWaits.set(id, reason); return;
        }
        if (error instanceof StaleMarketError && !closing && !stopRequested(id) && ['queued', 'running'].includes(latest.status) && now() < Date.parse(latest.deadlineAt)) {
          const streak = marketFailures.get(id) ?? { since: now(), count: 0 };
          if (streak.count < READ_RETRY_ATTEMPTS || now() - streak.since < READ_RETRY_MS) {
            if (!streak.count) event(latest, `${message}；至少重试 ${READ_RETRY_ATTEMPTS} 次、${READ_RETRY_MS / 1000} 秒，期间不追价、不下新单`);
            marketFailures.set(id, { ...streak, count: streak.count + 1 });
            latest.reason = message; saveJob(latest); return;
          }
        }
        // A failed attention check stays in attention for the next spaced check; a repeated error is logged once.
        if (latest.status === 'attention') { if (latest.attentionError !== message) { latest.attentionError = message; event(latest, message); saveJob(latest); } }
        else { pause(id, error instanceof StaleMarketError ? `持续未取得新鲜盘口，已暂停（${message}）` : message); await stopping(jobFor(id)); }
      } catch { /* A new lease owner will reconcile durable intents. */ }
    } finally {
      busyJobs.delete(id);
      if (!['queued', 'running'].includes(jobFor(id).status)) { readFailures.delete(id); marketFailures.delete(id); rateReadFailures.delete(id); externalWaits.delete(id); }
      if (FINAL.has(jobFor(id).status)) { writerTickets.delete(id); recoveredWriterJobs.delete(id); attentionChecks.delete(id); }
    }
  }
  function tick() {
    if (closed || closing || !protectionReady) return Promise.resolve();
    if (ticking) return ticking;
    if (!acquire()) return Promise.resolve();
    // Unconfirmed jobs are re-read at a low rate until every order settles.
    const due = job => ACTIVE.has(job.status) || job.status === 'attention' && now() - (attentionChecks.get(job.id) ?? 0) >= ATTENTION_RETRY_MS;
    const selected = unfinishedJobs().filter(due);
    for (const job of selected) if (job.status === 'attention') attentionChecks.set(job.id, now());
    ticking = Promise.allSettled(selected.map(job => runJob(job.id))).finally(() => { ticking = null; });
    return ticking;
  }
  function stop(id, body, session) {
    exactKeys(body, []); checkSession(session);
    const job = jobFor(id);
    stmt.prepare('INSERT INTO execution_stop_requests(job_id,requested_at) VALUES (?,?) ON CONFLICT(job_id) DO NOTHING').run(id, now());
    if (!FINAL.has(job.status)) {
      try { writable(); pause(id, '用户停止：停止后续下单并撤销余单，保留已成交仓位', 'stopped'); }
      catch (error) { if (!accountWriter) throw error; /* The local stop command survives loss of account ownership. */ }
    }
    return state();
  }
  async function reconcile(id, body, session) {
    exactKeys(body, ['legId', 'strategyId', 'acknowledge', 'notCreated']); writable(); checkSession(session);
    const job = jobFor(id);
    if (!['attention', 'paused'].includes(job.status) || busyJobs.has(id)) throw new ExecutionError(409, '任务正在执行或核对中');
    const order = orders(id).filter(item => item.legId === body.legId && !item.settled).at(-1);
    if (!order) throw new ExecutionError(409, '该交易腿没有待核对委托');
    const notCreated = body.notCreated !== undefined;
    if (notCreated && (body.notCreated !== true || body.acknowledge !== true || body.strategyId !== undefined || order.kind !== 'strategy' || order.remoteId)) throw new ExecutionError(400, '只有尚无策略编号的 Bybit 交易腿可以确认未创建');
    if (!notCreated && order.kind === 'strategy' && !order.remoteId && (body.acknowledge !== true || typeof body.strategyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.strategyId))) throw new ExecutionError(400, '请核对并填写交易所显示的原生追价策略编号');
    if (order.kind !== 'strategy' && body.strategyId !== undefined) throw new ExecutionError(400, '此交易所按本任务客户订单号核对');
    busyJobs.add(id);
    try {
      if (notCreated) await confirmNotCreated(order);
      else await inspectOrder(order, order.kind === 'strategy' && !order.remoteId ? body.strategyId : undefined, true);
      pause(id, '正在核对并撤销确认的剩余委托', job.stopTarget || 'paused');
      await stopping(jobFor(id)); return state();
    } catch (error) { throw new ExecutionError(409, safeError(error)); } finally { busyJobs.delete(id); }
  }
  acquire();
  const heartbeat = intervalMs > 0 ? setInterval(() => { if (!closing) { try { acquire(); void tick(); } catch { /* Retry on the next pulse. */ } } }, intervalMs) : null;
  heartbeat?.unref();
  return { state, quotes, exposureEvidence, connect, disconnect, preview, start, startAutomatic, startRiskReduction, canRepeatRiskReduction, lockOwner, jobView, jobAccounts, connectionOf, historyConnections, readAnthropicHistory, leading, coverageAvailable, stop, reconcile, tick, initializeProtection,
    async close() {
      if (closed || closing) return; closing = true; clearInterval(heartbeat);
      for (const controller of historyControllers) controller.abort();
      let ownsLease = false;
      try { requireLease(); ownsLease = true; } catch { /* The current owner handles recovery. */ }
      const timeout = setTimeout(() => { for (const controller of controllers) controller.abort(); }, 8000); timeout.unref?.();
      try {
        if (ownsLease) for (const job of unfinishedJobs()) if (ACTIVE.has(job.status)) { try { pause(job.id, '服务关闭：暂停后续交易并撤销余单'); } catch (error) { if (!accountWriter) throw error; } }
        await Promise.allSettled([...(ticking ? [ticking] : []), ...pending]);
        if (ownsLease) await Promise.allSettled(unfinishedJobs().filter(job => job.status === 'stopping').map(job => runJob(job.id)));
      } finally {
        clearTimeout(timeout); closed = true; writerTickets.clear(); recoveredWriterJobs.clear(); stmt.prepare('DELETE FROM execution_lease WHERE id=1 AND owner=?').run(owner);
        await Promise.allSettled([...clients.values()].map(client => Promise.resolve().then(() => client.close?.())));
      }
    } };
}
