import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './model.mjs';
import { D } from './money.mjs';
import { createGateClient, GATE_EXCHANGES } from './live-client.mjs';
import { capacityRequest, capacityResult, calculateCapacity } from './open-capacity.mjs';
import { isBaseBlocked } from '../../../server/asset-identity.mjs';
import { bindPositionAction, positionKey, positionDirection, validatePositionLegs } from './position-actions.mjs';

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'FAIL', 'REJECT', 'UNSENT']);
const ACTIVE = new Set(['NEW', 'OPEN', 'PARTIALLY_FILLED']);
const REMOTE = new Set([...ACTIVE, 'FILLED', 'CANCELLED', 'FAIL', 'REJECT']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const id = () => randomUUID();
const fail = (message, status = 409) => { throw new AppError(message, status); };
const numeric = value => { try { return D(value); } catch { return null; } };
const positive = value => numeric(value)?.gt(0) === true;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const requestKey = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) fail('请求标识无效，请刷新页面重试', 400); return value; };
const exchangeOf = symbol => String(symbol || '').split('_')[0].toLowerCase();
const increasingLegs = plan => plan.kind === 'open' ? plan.legs : plan.kind === 'position' ? plan.legs.filter(leg => !leg.reduceOnly) : [];
const credentialError = () => new AppError('账户验证未完成，请核对 API 凭据和 CrossEx 读取权限', 400);

/** Private reads are automatic. Every exchange write requires a fresh manual API action. */
export function createLiveRuntime(store, { market, clientFactory = createGateClient, clock = Date.now,
  freshnessMs = 15000, requestTimeoutMs = 12000, ownerLeaseMs = 60000, confirmationPollMs = 15000, pollIntervalMs = 250,
  confirmationWaitMs = 20000, postConfirmRefreshMs = 2000, capacityTimeoutMs = 4000, capacityRiskTtlMs = 5000, accountWriter } = {}) {
  if (!market) throw new Error('Live runtime requires a market reader');
  const db = store.db, owner = id();
  db.exec(`CREATE TABLE IF NOT EXISTS live_connection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_cache (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS live_previews (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_executions (id TEXT PRIMARY KEY, preview_id TEXT UNIQUE NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_orders (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, text TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_supplemental (version INTEGER PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_trades (version INTEGER NOT NULL, transaction_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(version,transaction_id));
    CREATE TABLE IF NOT EXISTS live_account_book (version INTEGER NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(version,id));`);
  const readSingleton = table => { const row = store.prepare(`SELECT json FROM ${table} WHERE singleton=1`).get(); return row ? JSON.parse(row.json) : null; };
  const putSingleton = (table, value) => store.prepare(`INSERT INTO ${table} VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json`).run(JSON.stringify(value));
  const connectionRecord = () => readSingleton('live_connection');
  const cacheRecord = () => readSingleton('live_cache') || { account: null, positions: [], openOrders: [], asOf: null, error: null };
  const supplementalRecord = version => { const row = store.prepare('SELECT json FROM live_supplemental WHERE version=?').get(version || 0); return row ? JSON.parse(row.json) : {}; };
  const historyRows = (table, version) => store.prepare(`SELECT json FROM ${table} WHERE version=? ORDER BY created_at DESC LIMIT 200`).all(version || 0).map(r => JSON.parse(r.json));
  const orderRecords = () => store.prepare('SELECT json FROM live_orders ORDER BY updated_at DESC').all().map(r => JSON.parse(r.json));
  const executionRecords = () => store.prepare('SELECT json FROM live_executions ORDER BY updated_at DESC LIMIT 100').all().map(r => JSON.parse(r.json));
  const findOrder = orderId => { const row = store.prepare('SELECT json FROM live_orders WHERE id=? OR text=?').get(orderId, orderId); return row ? JSON.parse(row.json) : orderRecords().find(o => o.orderId === orderId); };
  const getExecution = executionId => { const row = store.prepare('SELECT json FROM live_executions WHERE id=?').get(executionId); return row ? executionView(JSON.parse(row.json)) : null; };
  let stopped = false, lostOwnership = false, queue = Promise.resolve(), queuedOperations = 0, clientVersion = null, privateClient = null, supplementalFlight = null, supplementalAttempt = -Infinity;
  let writerTicket = null, writerError = null, writerLost = false, activeSubmission = null, writerHistoryReady = !accountWriter;
  const writerScope = { authority: 'gate-crossex', environment: 'mainnet' }, bindingId = 'crossex:live';
  // CrossEx authenticates one Gate subject. Venue prefixes are instruments,
  // never evidence of the underlying exchanges' native account identities.
  const writerIdentity = record => record?.enabled && record.accountUid ? { ...writerScope, accountId: record.accountUid } : null;
  function writerFailure(error) {
    const failure = new AppError('账户写入保护未通过，仅允许读取和原单核对', 409);
    if (typeof error?.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)) failure.code = error.code;
    writerError = failure.message; return failure;
  }
  function recoveryFailure(error, record) {
    if (accountWriter && error?.code === 'ACCOUNT_PINNED' && writerIdentity(record) && activeOrders().length) {
      accountWriter.freeze([writerIdentity(record)], 'legacy-conflict');
    }
    writerError = writerFailure(error).message;
  }
  function bindWriter(record) {
    if (!accountWriter) return;
    writerHistoryReady = false;
    try {
      accountWriter.bind(bindingId, writerIdentity(record), record?.version ?? 0, writerScope);
      writerTicket = writerIdentity(record) ? accountWriter.claim([writerIdentity(record)]) : null;
      writerError = null;
    } catch (error) { writerTicket = null; throw writerFailure(error); }
  }
  function assertWriter(ticket = writerTicket, budgetMs = requestTimeoutMs) {
    assertOwner();
    if (!writerIdentity(connectionRecord())) fail('账户 UID 尚未核实，仅允许读取和预览');
    if (!accountWriter) return;
    if (writerLost || !ticket) throw writerFailure();
    try { accountWriter.assertOwned(ticket, budgetMs); }
    catch (error) {
      const operationDenied = budgetMs > 0 && ticket.operationId && ['ACCOUNT_UNRESOLVED', 'ALREADY_SUBMITTED', 'ALREADY_REJECTED', 'OPERATION_UNRESOLVED', 'OPERATION_NOT_FOUND', 'OPERATION_CONFLICT'].includes(error?.code);
      if (!operationDenied) writerLost = true;
      throw writerFailure(error);
    }
  }
  function claimWriter(record) {
    if (!writerIdentity(record)) fail('账户 UID 尚未核实，仅允许读取和预览');
    if (!accountWriter) return null;
    if (writerLost || !writerHistoryReady) throw writerFailure();
    try { writerTicket = accountWriter.claim([writerIdentity(record)]); }
    catch (error) { throw writerFailure(error); }
    assertWriter(writerTicket); writerError = null; return writerTicket;
  }
  function assertConnectionSettled(record) {
    if (!accountWriter || !writerIdentity(record)) return;
    try {
      const ticket = claimWriter(record);
      if (accountWriter.unresolved(ticket).length) throw writerFailure({ code: 'BINDING_UNRESOLVED' });
    } catch (error) { throw writerFailure(error); }
  }
  function mayPersist(ticket = writerTicket) {
    if (!owns()) return false;
    if (!accountWriter) return true;
    try { assertWriter(ticket, 0); return true; } catch { return false; }
  }
  function createPayload(order) {
    return { symbol: order.symbol, side: order.side, position_side: order.positionSide, qty: order.quantity,
      ...(order.orderType === 'LIMIT' ? { price: order.price } : {}), type: order.orderType,
      time_in_force: order.timeInForce, reduce_only: String(order.reduceOnly), text: order.text };
  }
  const createOperation = order => order.writerCreateId || `crossex:create:${order.text}`;
  const createSemantic = (order, record) => ({ action: 'create_order', identity: writerIdentity(record), order: createPayload(order) });
  const cancelSemantic = (order, record) => ({ action: 'cancel_order', identity: writerIdentity(record), orderId: order.orderId, symbol: order.symbol, text: order.clientText ?? order.text });
  function prepareOperation(ticket, operationId, payload) {
    assertWriter(ticket);
    if (!accountWriter) return null;
    try { return accountWriter.prepare(ticket, operationId, payload); }
    catch (error) { throw writerFailure(error); }
  }
  function finishOperation(operation, outcome) {
    if (!accountWriter || !operation) return;
    assertWriter(operation, 0);
    accountWriter.finish(operation, outcome);
  }
  function clearSettledWriterError(ticket) {
    if (!accountWriter || writerLost) return;
    assertWriter(ticket, 0);
    if (accountWriter.unresolved(ticket).length === 0) writerError = null;
  }
  function resolveOperation(operationId, ticket, outcome = 'confirmed') {
    if (!accountWriter || !operationId) return;
    assertWriter(ticket, 0);
    try { accountWriter.resolve(operationId, ticket, outcome); }
    catch (error) { if (error?.code !== 'OPERATION_NOT_FOUND') throw writerFailure(error); }
  }
  function resolveOrder(order, ticket = writerTicket) {
    if (!order.external) resolveOperation(createOperation(order), ticket, order.writerRejectedState ? 'rejected' : 'confirmed');
    if (order.writerCancelId && !order.writerCancelPrepared && TERMINAL.has(order.status)) resolveOperation(order.writerCancelId, ticket);
  }
  function importWriterHistory(record) {
    if (!accountWriter) return;
    if (!record?.enabled) { writerHistoryReady = true; return; }
    if (!writerTicket) return;
    if (activeOrders().some(order => order.version !== record.version)) throw writerFailure();
    for (const order of orderRecords().filter(order => order.version === record.version)) {
      if (order.writerCancelPrepared) {
        resolveOperation(order.writerCancelId, writerTicket, 'rejected');
        delete order.writerCancelId; delete order.writerCancelPrepared;
        assertWriter(writerTicket, 0); writeOrder(order);
      }
      if (order.status === 'UNSENT') {
        if (order.writerCreateId) resolveOperation(order.writerCreateId, writerTicket, 'rejected');
        continue;
      }
      if (TERMINAL.has(order.status) && !order.writerCreateId && !order.writerCancelId) continue;
      if (!order.external) {
        const operation = accountWriter.importUnknown(writerTicket, createOperation(order), createSemantic(order, record));
        if (operation.state === 'rejected') {
          if (!D(order.executedQty).isZero() || order.orderId || order.raw) throw writerFailure({ code: 'OPERATION_CONFLICT' });
          order.status = order.writerRejectedState === 'UNSENT' ? 'UNSENT' : 'REJECT';
          order.writerRejectedState = order.status;
          order.error = '原操作已明确拒绝，不会重新发送此订单';
          assertWriter(writerTicket, 0); writeOrder(order);
        }
      }
      if (order.status === 'CANCEL_PENDING' || order.writerCancelId) {
        if (!order.writerCancelId) { order.writerCancelId = `crossex:cancel:legacy:${order.id}`; assertWriter(writerTicket, 0); writeOrder(order); }
        accountWriter.importUnknown(writerTicket, order.writerCancelId, cancelSemantic(order, record));
      }
      if (order.writerRejectedState || TERMINAL.has(order.status) && order.raw && validateOrderResult(order, order.raw)) resolveOrder(order);
    }
    writerHistoryReady = true;
  }
  function beforeSubmit({ method, path, payload }) {
    const active = activeSubmission, record = connectionRecord();
    if (!active || record?.version !== active.version || record?.accountUid !== active.accountUid
      || method !== active.method || (method === 'POST' ? hash(Object.entries(payload).sort()) !== active.payloadHash : path !== `/crossex/orders/${active.orderId}`)
      || active.expiresAt !== undefined && (clock() >= active.expiresAt || remaining(active.deadline) <= 0 || configFingerprint() !== active.configFingerprint)) fail('连接或发送许可已变化');
    assertWriter(active.ticket);
  }
  const newClient = credentials => clientFactory({ ...credentials, clock, beforeSubmit });
  const capacityReads = new Map(), capacityFlights = new Set();
  function exclusive(fn) {
    queuedOperations++;
    const result = queue.then(() => { if (stopped) fail('实盘服务正在停止', 503); return fn(); }).finally(() => { queuedOperations--; });
    queue = result.catch(() => {}); return result;
  }
  function takeOwnership() {
    return store.transaction(() => {
      const row = store.prepare('SELECT owner,expires_at FROM live_owner WHERE singleton=1').get();
      if (row && row.owner !== owner && row.expires_at > clock()) return false;
      store.prepare('INSERT INTO live_owner VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner, clock() + ownerLeaseMs);
      return true;
    });
  }
  const owns = () => {
    if (stopped || lostOwnership) return false;
    const row = store.prepare('SELECT owner,expires_at FROM live_owner WHERE singleton=1').get();
    if (row?.owner !== owner || row.expires_at <= clock()) { lostOwnership = true; return false; }
    return true;
  };
  function assertOwner() {
    if (!owns()) fail('另一服务实例正在管理此账户或本实例执行锁已失效，请重启后只读核对');
  }
  function writeOrder(order) {
    if (!owns()) fail('实盘执行锁已失效，订单仅允许查询确认');
    order.updatedAt = clock();
    store.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,json=excluded.json')
      .run(order.id, order.executionId, order.text, order.version, order.status, order.updatedAt, JSON.stringify(order));
  }
  function executionView(execution, executionOrders) {
    const legs = (executionOrders ?? orderRecords().filter(o => o.executionId === execution.id)).toSorted((a, b) => a.index - b.index);
    const unknown = legs.some(o => ['UNKNOWN', 'SENDING', 'INVALID', 'CANCEL_PENDING'].includes(o.status));
    const anyFill = legs.some(o => D(o.executedQty).gt(0));
    const allFilled = legs.length > 0 && legs.every(o => o.status === 'FILLED');
    const state = allFilled ? 'completed' : unknown ? 'reconciling' : legs.some(o => !TERMINAL.has(o.status)) ? 'pending' : anyFill ? 'partial' : 'failed';
    return { ...execution, state, legs: legs.map(o => ({ ...o, filledQuantity: o.executedQty })) };
  }
  function recoverUnsent() {
    for (const order of orderRecords()) {
      if (order.status === 'PREPARED') { order.status = 'UNSENT'; order.error = '服务重启后未发送此腿，请按当前实际持仓手动处理'; writeOrder(order); }
      else if (order.status === 'SENDING') { order.status = 'UNKNOWN'; order.error = '服务中断，正在按原订单标识只读核对'; writeOrder(order); }
    }
  }
  if (takeOwnership()) {
    recoverUnsent();
    try { bindWriter(connectionRecord()); importWriterHistory(connectionRecord()); }
    catch (error) { recoveryFailure(error, connectionRecord()); }
  } else lostOwnership = true;
  const heartbeat = setInterval(() => { if (!stopped && owns()) store.prepare('UPDATE live_owner SET expires_at=? WHERE singleton=1 AND owner=?').run(clock() + ownerLeaseMs, owner); }, Math.max(1000, Math.floor(ownerLeaseMs / 3)));
  heartbeat.unref();
  function getClient(record = connectionRecord()) {
    if (!record?.enabled) fail('请先连接 Gate CrossEx 账户');
    if (clientVersion !== record.version) {
      privateClient = newClient({ apiKey: store.decrypt(record.apiKey), apiSecret: store.decrypt(record.apiSecret) }); clientVersion = record.version;
    }
    return privateClient;
  }
  async function bounded(promise, timeoutMs = requestTimeoutMs) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('REQUEST_UNCERTAIN')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  const remaining = deadline => deadline === Infinity ? requestTimeoutMs : Math.max(0, deadline - performance.now());
  function withinDeadline(fn, deadline = Infinity) {
    const timeoutMs = Math.min(requestTimeoutMs, remaining(deadline));
    if (timeoutMs <= 0) return Promise.reject(new AppError('本次确认等待时间已用尽，请查看已记录的实际订单结果', 503));
    return bounded(fn(), timeoutMs);
  }
  function remoteUid(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw credentialError();
    if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]{0,39}$/.test(String(value))) throw credentialError();
    return String(value);
  }
  function validateAccount(account) {
    if (!object(account)) throw credentialError();
    return remoteUid(account.user_id);
  }
  function verifyUid(value, expected) {
    const observed = remoteUid(value);
    if (observed !== null && expected !== null && expected !== undefined && observed !== expected) fail('交易所返回的账户 UID 与当前连接不一致');
    return observed;
  }
  function validateLists(positions, orders, accountUid) {
    if (!Array.isArray(positions) || !Array.isArray(orders)) fail('交易所持仓或挂单列表不完整');
    const observed = new Set(accountUid ? [accountUid] : []);
    for (const p of positions) {
      if (!object(p) || typeof p.symbol !== 'string' || !['NONE', 'LONG', 'SHORT'].includes(p.position_side) || !numeric(p.position_qty)) fail('交易所持仓字段不完整，禁止交易');
      const uid = verifyUid(p.user_id, accountUid); if (uid) observed.add(uid);
    }
    for (const o of orders) {
      if (!object(o) || !o.order_id || typeof o.symbol !== 'string' || typeof o.state !== 'string' || !numeric(o.qty)?.gte(0) || !numeric(o.executed_qty)) fail('交易所挂单字段不完整，禁止交易');
      const uid = verifyUid(o.user_id, accountUid); if (uid) observed.add(uid);
    }
    if (observed.size > 1) fail('交易所返回了不同账户的持仓或挂单');
  }
  function activeOrders() { return orderRecords().filter(o => !TERMINAL.has(o.status)); }
  function freshCache() {
    const record = connectionRecord(), cache = cacheRecord();
    if (!record?.enabled) fail('请先连接 Gate CrossEx 账户');
    if (!cache.asOf || cache.error || clock() - cache.asOf > freshnessMs || cache.asOf > clock() + 1000 || cache.version !== record.version) fail('账户或订单数据未完整同步，请刷新后再操作');
    if (!['SINGLE', 'DUAL'].includes(cache.account?.position_mode)) fail('交易所持仓模式不明，禁止下单');
    if (!['CROSS_EXCHANGE', 'ISOLATED_EXCHANGE'].includes(cache.account?.account_mode)) fail('交易所账户模式不明，禁止下单');
    return { record, cache };
  }
  function accountFingerprint(cache) {
    return hash([cache.account?.user_id, cache.account?.position_mode, cache.account?.account_mode,
      cache.positions.map(p => [p.position_id ?? null, p.symbol, p.position_side, D(p.position_qty).toString(), p.entry_price ?? null, p.margin_mode ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      cache.openOrders.map(o => [String(o.order_id), o.symbol, o.side, o.state, o.qty, o.executed_qty]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  }
  const configFingerprint = () => market.revision ? market.revision() : hash(market.view().config);
  function validateOrderResult(order, result) {
    if (!object(result)) return false;
    const quantity = numeric(result.qty), filled = numeric(result.executed_qty);
    try { verifyUid(result.user_id, connectionRecord()?.accountUid); } catch { return false; }
    if (!result.order_id || result.text !== (order.clientText ?? order.text) || result.symbol !== order.symbol || result.side !== order.side || !quantity?.eq(order.quantity) || !filled || filled.lt(order.executedQty) || filled.gt(order.quantity) || filled.lt(0) || !REMOTE.has(result.state)) return false;
    if (order.orderId && String(result.order_id) !== order.orderId) return false;
    if (result.position_side != null && result.position_side !== '' && result.position_side !== order.positionSide) return false;
    if (result.reduce_only != null && result.reduce_only !== '' && String(result.reduce_only) !== String(order.reduceOnly)) return false;
    if (result.type != null && result.type !== '' && result.type !== order.orderType) return false;
    if (result.time_in_force != null && result.time_in_force !== '' && result.time_in_force !== order.timeInForce) return false;
    if (order.orderType === 'LIMIT' && result.price != null && result.price !== '' && !numeric(result.price)?.eq(order.price)) return false;
    if (result.state === 'FILLED' && !filled.eq(order.quantity)) return false;
    if (TERMINAL.has(order.status) && result.state !== order.status) return false;
    return true;
  }
  function applyResult(order, result, ticket = writerTicket) {
    if (!mayPersist(ticket)) return false;
    if (!validateOrderResult(order, result)) {
      order.status = 'INVALID'; order.error = '订单回报身份、状态或累计成交不一致，已冻结写操作'; writeOrder(order); return false;
    }
    const wasCancel = order.status === 'CANCEL_PENDING';
    order.orderId = String(result.order_id); order.executedQty = D(result.executed_qty).toString();
    order.status = wasCancel && ACTIVE.has(result.state) ? 'CANCEL_PENDING' : result.state;
    order.exchangeState = result.state; order.executedAmount = result.executed_amount ?? null; order.averagePrice = result.executed_avg_price ?? null;
    order.raw = result; order.error = order.status === 'CANCEL_PENDING' ? '撤单请求已发送，等待交易所终态' : null; writeOrder(order);
    resolveOrder(order, ticket); return true;
  }
  async function reconcileOrder(order, client, knownOrders, deadline = Infinity) {
    // Once an order id is known it is the only identity: external clients (web/app) can share one text.
    const matches = o => order.orderId ? String(o.order_id) === order.orderId : o.text === order.text;
    let result = knownOrders.find(matches);
    if (!result) {
      try { result = await withinDeadline(() => client.getOrder(order.orderId || order.text), deadline); }
      catch {
        try { const history = await withinDeadline(() => client.getHistoryOrders({ symbol: order.symbol, from: order.createdAt - 60000, to: clock() }), deadline);
          if (Array.isArray(history)) result = history.find(matches);
        } catch { /* Missing history never proves an order was not accepted. */ }
      }
    }
    if (result) applyResult(order, result);
    else if (mayPersist()) { order.status = order.status === 'CANCEL_PENDING' ? 'CANCEL_PENDING' : 'UNKNOWN'; order.error = '未能确认原订单状态；不会重新发单，请等待或在交易所核对'; writeOrder(order); }
  }
  async function readConnectionAccount(client, exchangeType) {
    try { return { account: await bounded(client.getAccount(exchangeType)), exchangeType }; }
    catch (error) {
      if (exchangeType !== undefined || ![400, 422].includes(error?.sourceStatus)) throw error;
      // Isolated CrossEx accounts can require an explicit venue even for the
      // first account read. This fallback is read-only and never changes mode.
      const results = await Promise.allSettled(GATE_EXCHANGES.map(venue => bounded(client.getAccount(venue)).then(account => ({ account, exchangeType: venue }))));
      const available = results.filter(r => r.status === 'fulfilled' && r.value.account?.account_mode === 'ISOLATED_EXCHANGE').map(r => r.value);
      if (!available.length) throw error;
      return available[0];
    }
  }
  function saveSupplemental(version, values) {
    const next = { ...supplementalRecord(version), ...values };
    store.prepare('INSERT INTO live_supplemental VALUES (?,?) ON CONFLICT(version) DO UPDATE SET json=excluded.json').run(version, JSON.stringify(next));
  }
  function refreshSupplemental(force = false) {
    if (supplementalFlight) return supplementalFlight;
    const record = connectionRecord();
    if (!record?.enabled || !owns() || !force && clock() - supplementalAttempt < 30000) return Promise.resolve();
    const client = getClient(record), startedAt = clock(), previous = supplementalRecord(record.version);
    supplementalAttempt = startedAt;
    const current = () => owns() && connectionRecord()?.version === record.version;
    const parts = [
      ['recentTrades', () => client.getTrades({ from: Math.max(0, (previous.recentTradesAsOf || startedAt - 86400000) - 60000), to: startedAt })],
      ['accountBook', () => client.getAccountBook({ limit: 200 })],
      ['fees', () => client.getFees()],
      ['adl', () => client.getAdlRanks([...new Set(cacheRecord().positions.filter(p => !D(p.position_qty).isZero()).map(p => p.symbol))])],
    ];
    supplementalFlight = Promise.all(parts.map(async ([name, read]) => {
      try {
        const values = await bounded(Promise.resolve().then(read));
        if (!Array.isArray(values)) throw new Error('INVALID_SUPPLEMENTAL');
        const observedUids = new Set(values.map(value => verifyUid(value?.user_id, record.accountUid)).filter(Boolean));
        if (observedUids.size > 1) throw new Error('INCONSISTENT_ACCOUNT');
        if (!current()) return;
        store.transaction(() => {
          if (name === 'recentTrades') for (const trade of values) {
            if (!trade.transaction_id || !trade.order_id || typeof trade.symbol !== 'string' || !['BUY', 'SELL'].includes(trade.side) || !positive(trade.qty) || !positive(trade.price)) throw new Error('INVALID_TRADE');
            const previousRow = store.prepare('SELECT json FROM live_trades WHERE version=? AND transaction_id=?').get(record.version, trade.transaction_id);
            let completeTrade = trade;
            if (previousRow) {
              const known = JSON.parse(previousRow.json);
              if (['order_id', 'symbol', 'side'].some(k => known[k] !== trade[k]) || !D(known.qty).eq(trade.qty) || !D(known.price).eq(trade.price)) throw new Error('CONFLICTING_TRADE');
              completeTrade = { ...known, ...Object.fromEntries(Object.entries(trade).filter(([, value]) => value !== null && value !== undefined)) };
            }
            store.prepare('INSERT INTO live_trades VALUES (?,?,?,?) ON CONFLICT(version,transaction_id) DO UPDATE SET json=excluded.json')
              .run(record.version, String(trade.transaction_id), Number(trade.create_time) || 0, JSON.stringify(completeTrade));
          }
          if (name === 'accountBook') for (const entry of values) {
            if (!entry.id) throw new Error('INVALID_ACCOUNT_ENTRY');
            store.prepare('INSERT INTO live_account_book VALUES (?,?,?,?) ON CONFLICT(version,id) DO UPDATE SET json=excluded.json')
              .run(record.version, String(entry.id), Number(entry.create_time) || 0, JSON.stringify(entry));
          }
          saveSupplemental(record.version, { ...(name === 'fees' || name === 'adl' ? { [name]: values } : {}), [`${name}AsOf`]: startedAt, [`${name}Error`]: null });
        });
      } catch {
        if (current()) saveSupplemental(record.version, { [`${name}Error`]: '补充账户资料暂未更新，保留已核实记录' });
      }
    })).finally(() => { supplementalFlight = null; });
    return supplementalFlight;
  }
  async function refreshInternal({ deadline = Infinity, reconcile = true, includeView = true } = {}) {
    assertOwner();
    let record = connectionRecord(); if (!record?.enabled) return includeView ? view() : undefined;
    const client = getClient(record), previous = cacheRecord(), readStartedAt = clock();
    try {
      const [account, positions, openOrders, detail] = await Promise.all([
        withinDeadline(() => client.getAccount(record.exchangeType), deadline),
        withinDeadline(() => client.getPositions(), deadline),
        withinDeadline(() => client.getOpenOrders(), deadline),
        !record.accountUid && typeof client.getAccountDetail === 'function'
          ? withinDeadline(() => bounded(client.getAccountDetail(), Math.min(requestTimeoutMs, 2000)), deadline).catch(() => null) : null,
      ]);
      if (!owns() || connectionRecord()?.version !== record.version) fail('连接版本已变化');
      const observedAccountUid = verifyUid(validateAccount(account), record.accountUid);
      validateLists(positions, openOrders, record.accountUid ?? observedAccountUid);
      const uids = new Set([observedAccountUid, remoteUid(detail?.user_id), ...positions.map(position => remoteUid(position.user_id)), ...openOrders.map(order => remoteUid(order.user_id))].filter(Boolean));
      if (uids.size > 1) throw credentialError();
      if (!record.accountUid && uids.size === 1) {
        record = { ...record, accountUid: [...uids][0], verifiedAt: clock() };
        // Credentials and original connection generation stay unchanged. The
        // newly signed identity invalidates UID-less previews and binds recovery.
        putSingleton('live_connection', record);
        try { bindWriter(record); importWriterHistory(record); }
        catch (error) { recoveryFailure(error, record); }
      }
      if (reconcile) for (const order of activeOrders().filter(o => o.version === record.version && o.status !== 'PREPARED')) await reconcileOrder(order, client, openOrders, deadline);
      putSingleton('live_cache', { account, positions, openOrders, version: record.version, asOf: readStartedAt, error: null });
      void refreshSupplemental();
    } catch {
      if (owns()) putSingleton('live_cache', { ...previous, error: '账户或订单同步未完成，保留上次结果并暂停交易' });
    }
    return includeView ? view() : undefined;
  }
  async function connectInternal(input) {
    assertOwner();
    if (!object(input) || typeof input.apiKey !== 'string' || typeof input.apiSecret !== 'string' || !input.apiKey.trim() || !input.apiSecret.trim() || input.apiKey.length > 1024 || input.apiSecret.length > 2048) throw credentialError();
    if (input.exchangeType !== undefined && (typeof input.exchangeType !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(input.exchangeType))) fail('交易所类型格式无效', 400);
    let previous = connectionRecord();
    if (previous?.enabled) await refreshInternal({ includeView: false });
    previous = connectionRecord();
    if (activeOrders().length || cacheRecord().openOrders?.some(o => !TERMINAL.has(o.state))) fail('仍有活动或未知订单，不能更换凭据或账户');
    if (previous?.enabled && cacheRecord().error) fail('原账户状态未核实，不能更换凭据或账户');
    assertConnectionSettled(previous);
    const candidate = newClient({ apiKey: input.apiKey.trim(), apiSecret: input.apiSecret.trim() });
    let account, positions, openOrders, accountDetail, exchangeType;
    const readStartedAt = clock();
    let accountUid;
    try {
      const [accountResult, currentPositions, currentOrders, detail] = await Promise.all([
        readConnectionAccount(candidate, input.exchangeType), bounded(candidate.getPositions()), bounded(candidate.getOpenOrders()),
        typeof candidate.getAccountDetail === 'function' ? bounded(candidate.getAccountDetail(), Math.min(requestTimeoutMs, 2000)).catch(() => null) : null,
      ]);
      ({ account, exchangeType } = accountResult); positions = currentPositions; openOrders = currentOrders; accountDetail = detail;
      const uids = [validateAccount(account), remoteUid(accountDetail?.user_id), ...positions.map(p => remoteUid(p.user_id)), ...openOrders.map(o => remoteUid(o.user_id))].filter(Boolean);
      if (new Set(uids).size > 1) throw credentialError();
      accountUid = uids[0] || null;
      validateLists(positions, openOrders, accountUid);
    }
    catch { throw credentialError(); }
    assertOwner();
    assertConnectionSettled(previous);
    const record = { enabled: true, version: (previous?.version || 0) + 1, accountUid, accountReference: hash(input.apiKey.trim()), keySuffix: input.apiKey.trim().slice(-4),
      apiKey: store.encrypt(input.apiKey.trim()), apiSecret: store.encrypt(input.apiSecret.trim()), exchangeType, verifiedAt: clock(), tradePermission: 'unknown' };
    const previousCache = readSingleton('live_cache'); let saved = false;
    try {
      bindWriter(record);
      store.transaction(() => { putSingleton('live_connection', record); putSingleton('live_cache', { account, positions, openOrders, version: record.version, asOf: readStartedAt, error: null }); });
      saved = true; importWriterHistory(record);
    } catch (error) {
      if (saved) store.transaction(() => {
        if (previous) putSingleton('live_connection', previous); else store.prepare('DELETE FROM live_connection WHERE singleton=1').run();
        if (previousCache) putSingleton('live_cache', previousCache); else store.prepare('DELETE FROM live_cache WHERE singleton=1').run();
      });
      // A rejected candidate must not replace the still-valid connection's
      // binding or ticket. The rollback gets a fresh binding generation.
      try { bindWriter(previous); importWriterHistory(previous); }
      catch (restoreError) { recoveryFailure(restoreError, previous); }
      throw error;
    }
    privateClient = candidate; clientVersion = record.version; supplementalAttempt = -Infinity; void refreshSupplemental(); return connectionView();
  }
  function disconnectInternal() {
    assertOwner();
    if (activeOrders().length || cacheRecord().openOrders?.some(o => !TERMINAL.has(o.state))) fail('仍有活动或未知订单，请先核实订单后断开');
    const record = connectionRecord();
    if (accountWriter) {
      try { accountWriter.releaseBinding(bindingId); }
      catch (error) { throw writerFailure(error); }
    }
    if (record) putSingleton('live_connection', { ...record, enabled: false, apiKey: null, apiSecret: null, version: record.version + 1 });
    writerTicket = null; writerError = null; writerHistoryReady = !accountWriter;
    privateClient = null; clientVersion = null; return connectionView();
  }
  function checkPositionLimit(plan, cache) {
    const held = cache.positions.filter(p => !D(p.position_qty).isZero());
    if (Number.isFinite(plan.limits?.maxOpen) && held.length + (plan.kind === 'position' ? 0 : plan.legs.length) > plan.limits.maxOpen * 2) fail('实际持仓数量已达到上限');
  }
  function checkCooldown(plan) {
    const cooldown = Number(plan.limits?.cooldownSeconds || 0) * 1000;
    // Historical executions have no venue field. Conservatively retain the
    // cooldown across verified alias spellings without rewriting native orders.
    const bases = new Set([plan.base]);
    if (cooldown > 0 && executionRecords().some(e => isBaseBlocked(bases, e.base) && clock() - e.createdAt < cooldown)) fail('此资产仍在手动交易冷却期');
  }
  async function positionsNotional(cache) {
    const held = cache.positions.filter(p => !D(p.position_qty).isZero());
    let total = market.positionsNotional ? D(await market.positionsNotional(held)) : D(0);
    const fx = market.view({ includeOpportunities: false }).fx || [];
    for (const p of market.positionsNotional ? [] : held) {
      const quote = p.symbol.split('_').at(-1), price = p.mark_price;
      if (!positive(price)) fail('现有持仓缺少有效标记价，无法验证总名义额上限');
      const rate = quote === 'USDT' ? '1' : fx.find(f => f.currency === quote && f.state === 'live')?.ask;
      if (!positive(rate)) fail('现有持仓汇率不可用，无法验证总名义额上限');
      total = total.plus(D(p.position_qty).abs().times(price).times(rate));
    }
    return total;
  }
  async function validateLimits(plan, cache) {
    const additions = increasingLegs(plan);
    if (!additions.length) return;
    checkPositionLimit(plan, cache);
    let total = await positionsNotional(cache);
    // Reductions are not filled yet: do not spend their anticipated released capacity.
    for (const leg of additions) { if (!positive(leg.notionalUSDT)) fail('订单名义额无效'); total = total.plus(leg.notionalUSDT); }
    if (!positive(plan.limits?.maxTotalNotional) || total.gt(plan.limits.maxTotalNotional)) fail('订单超过账户总名义额上限');
    checkCooldown(plan);
  }
  function checkConflicts(plan, cache) {
    if (activeOrders().some(o => ['UNKNOWN', 'INVALID', 'SENDING', 'CANCEL_PENDING'].includes(o.status)) || cache.openOrders.some(o => !REMOTE.has(o.state))) fail('存在未知或待确认订单，暂停新的交易');
    if (['open', 'position'].includes(plan.kind) && (activeOrders().length || cache.openOrders.some(o => !TERMINAL.has(o.state)))) fail('账户仍有活动委托，请先核实或撤销挂单后再调整仓位');
    const symbols = new Set(plan.legs.map(l => l.symbol));
    if (activeOrders().some(o => symbols.has(o.symbol)) || cache.openOrders.some(o => symbols.has(o.symbol) && !TERMINAL.has(o.state))) fail('同一合约已有挂单，请先核实或手动撤单');
    if (plan.kind === 'open' && cache.positions.some(p => symbols.has(p.symbol) && !D(p.position_qty).isZero())) fail('同一合约已有实际持仓，请先管理现有敞口');
  }
  function direction(p, mode = cacheRecord().account?.position_mode) {
    return positionDirection(p, mode);
  }
  // Capacity reads do not enter the execution queue. Capture balances as well as
  // positions/orders: the preview fingerprint deliberately excludes balances.
  // asOf alone changes on every background poll; freshness is checked separately.
  const capacitySignature = () => hash([connectionRecord(), { ...cacheRecord(), asOf: null }, configFingerprint(),
    activeOrders().map(o => [o.id, o.version, o.status, o.executedQty]), executionRecords().map(e => [e.id, e.createdAt])]);
  function capacityRead(key, read) {
    const now = clock();
    for (const [k, entry] of capacityReads) if (!entry.pending && entry.expiresAt <= now + Math.min(1000, capacityRiskTtlMs / 5)) capacityReads.delete(k);
    let entry = capacityReads.get(key);
    if (!entry) {
      if (capacityReads.size >= 64 || [...capacityReads.values()].filter(value => value.pending).length >= 8) return Promise.reject(new Error('CAPACITY_READ_BUSY'));
      entry = { pending: true, asOf: now, expiresAt: now + capacityRiskTtlMs };
      // Retain even timed-out in-flight reads until they settle, preventing a
      // slow provider from multiplying concurrent private requests on retries.
      entry.promise = Promise.resolve().then(read).then(value => ({ value, asOf: entry.asOf, expiresAt: entry.expiresAt }), error => {
        entry.expiresAt = clock() + 1000; throw error;
      }).finally(() => { entry.pending = false; });
      capacityReads.set(key, entry);
    }
    return bounded(entry.promise, Math.min(requestTimeoutMs, capacityTimeoutMs));
  }
  async function openCapacityInternal(request) {
    let record, cache;
    try { ({ record, cache } = freshCache()); }
    catch { return capacityResult(request, clock(), connectionRecord()?.version || 0, 'unavailable', '账户或订单数据未完整同步，请刷新后再查看容量'); }
    const stamp = capacitySignature(), config = market.config ? market.config() : market.view({ includeOpportunities: false }).config;
    const plan = { kind: 'open', base: request.requests[0].symbol.split('_')[2], legs: request.requests, limits: config };
    try {
      if (config.entryPaused) fail('新开仓已暂停，平仓仍可使用');
      if (!owns()) fail('本实例未持有执行锁，暂不能新开仓');
      if (record.tradePermission === 'denied') fail('此凭据没有交易权限');
      checkConflicts(plan, cache); checkPositionLimit(plan, cache); checkCooldown(plan);
    } catch (error) {
      return { ...capacityResult(request, clock(), record.version, 'blocked', error.message), asOf: cache.asOf,
        expiresAt: Math.min(clock() + capacityRiskTtlMs, cache.asOf + freshnessMs) };
    }
    let context;
    try { context = await market.openCapacityContext(request); }
    catch { return capacityResult(request, clock(), record.version, 'unavailable', '行情、合约规则或汇率未能核实，请稍后重试'); }
    if (stopped) return capacityResult(request, clock(), record.version, 'unavailable', '实盘服务正在停止');
    if (stamp !== capacitySignature()) return capacityResult(request, clock(), record.version, 'unavailable', '账户、持仓或设置已变化，请重新读取容量');
    try {
      const client = getClient(record), prefix = `${record.version}:${record.accountReference}:`, venues = [...new Set(context.legs.map(l => l.symbol.split('_')[0]))];
      const [symbolReads, isolatedReads, heldValuation] = await Promise.all([
        Promise.all(context.legs.map(leg => capacityRead(`${prefix}risk:${leg.symbol}`, async () => {
          const [leverage, limits] = await Promise.all([client.getLeverages([leg.symbol]), client.getRiskLimits([leg.symbol])]);
          if (!object(leverage) || !Array.isArray(limits) || limits.length !== 1 || limits[0]?.symbol !== leg.symbol) throw new Error('RISK_UNKNOWN');
          return { symbol: leg.symbol, leverage: leverage[leg.symbol], tiers: limits[0].tiers };
        }))),
        cache.account.account_mode === 'ISOLATED_EXCHANGE' ? Promise.all(venues.map(venue => capacityRead(`${prefix}account:${venue}:${hash(cache)}`, async () => {
          const account = await client.getAccount(venue), accountUid = verifyUid(validateAccount(account), record.accountUid);
          if (account.account_mode !== 'ISOLATED_EXCHANGE' || account.exchange_type !== venue || account.position_mode !== cache.account.position_mode) throw new Error('ISOLATED_ACCOUNT_UNKNOWN');
          return { venue, accountUid, availableMargin: account.available_margin };
        }))) : [],
        market.positionsValuation ? market.positionsValuation(cache.positions) : positionsNotional(cache).then(value => ({ notionalUSDT: value,
          expiresAt: cache.positions.some(p => !D(p.position_qty).isZero() && !p.symbol.endsWith('_USDT')) ? clock() : cache.asOf + freshnessMs })),
      ]);
      if (stopped) return capacityResult(request, clock(), record.version, 'unavailable', '实盘服务正在停止');
      // A UID-less initial connection may acquire identity evidence later. Keep
      // that evidence on cached venue reads and compare every observed identity.
      const observedUids = new Set([record.accountUid, cache.account?.user_id, ...cache.positions.map(p => p.user_id),
        ...cache.openOrders.map(o => o.user_id), ...isolatedReads.map(r => r.value.accountUid)].map(remoteUid).filter(Boolean));
      if (observedUids.size > 1) throw new Error('INCONSISTENT_CAPACITY_ACCOUNT');
      const now = clock(), expiresAt = Math.min(cache.asOf + freshnessMs, heldValuation.expiresAt, ...symbolReads.map(r => r.expiresAt), ...isolatedReads.map(r => r.expiresAt));
      if (stamp !== capacitySignature() || !owns()) return capacityResult(request, now, record.version, 'unavailable', '账户、持仓或设置已变化，请重新读取容量');
      if (now >= expiresAt || now >= context.expiresAt) return capacityResult(request, now, record.version, 'unavailable', '容量依赖的账户、盘口或风险快照已过期');
      const risk = symbolReads.map(row => {
        const venue = row.value.symbol.split('_')[0], isolated = isolatedReads.find(r => r.value.venue === venue);
        return { ...row.value, asOf: Math.min(row.asOf, isolated?.asOf ?? cache.asOf), marginGroup: isolated ? venue : 'CROSSEX',
          availableMargin: isolated ? isolated.value.availableMargin : cache.account.available_margin };
      });
      return calculateCapacity(request, context, risk, { now, connectionVersion: record.version, positionsNotional: heldValuation.notionalUSDT, expiresAt });
    } catch { return capacityResult(request, clock(), record.version, 'unavailable', '当前杠杆、风险档位、持仓估值或可用保证金未能核实'); }
  }
  function openCapacity(input) {
    const request = capacityRequest(input), version = connectionRecord()?.version || 0;
    if (stopped || capacityFlights.size >= 4) return Promise.resolve(capacityResult(request, clock(), version, 'unavailable', '容量读取繁忙，请稍后重试'));
    const pending = openCapacityInternal(request).finally(() => capacityFlights.delete(pending));
    capacityFlights.add(pending);
    return bounded(pending, capacityTimeoutMs).catch(() => capacityResult(request, clock(), version, 'unavailable', '容量读取超时，请稍后重试'));
  }
  async function riskPreview(plan, record, cache) {
    const additions = increasingLegs(plan);
    if (!additions.length) return null;
    const client = getClient(record), symbols = [...new Set(additions.map(l => l.symbol))];
    if (typeof client.getLeverages !== 'function' || typeof client.getRiskLimits !== 'function') fail('缺少杠杆或风险档位读取能力，暂不能新开仓');
    try {
      const [leverageRows, limits] = await Promise.all([
        Promise.all(symbols.map(symbol => bounded(client.getLeverages([symbol])))), bounded(client.getRiskLimits(symbols)),
      ]);
      if (!Array.isArray(limits)) throw new Error('INVALID_RISK_LIMITS');
      const leverages = Object.assign({}, ...leverageRows), requirements = new Map();
      const legs = additions.map(leg => {
        const leverage = numeric(leverages[leg.symbol]);
        if (!leverage?.gt(0) || !positive(leg.notionalUSDT)) throw new Error('LEVERAGE_UNKNOWN');
        const eligible = (limits.find(r => r.symbol === leg.symbol)?.tiers || []).filter(tier => numeric(tier.leverage_max)?.gte(leverage) && positive(tier.max_risk_limit_value));
        if (!eligible.length) throw new Error('RISK_TIER_UNKNOWN');
        const maximum = eligible.reduce((a, tier) => D(tier.max_risk_limit_value).gt(a) ? D(tier.max_risk_limit_value) : a, D(0));
        const existing = cache.positions.filter(p => p.symbol === leg.symbol && (cache.account.position_mode !== 'DUAL' || p.position_side === leg.positionSide))
          .reduce((sum, p) => sum.plus(D(p.position_qty).abs().times(direction(p) === 'SHORT' ? -1 : 1)), D(0));
        const price = positive(leg.referencePrice) && D(leg.referencePrice).gt(leg.price) ? D(leg.referencePrice) : D(leg.price);
        const projected = existing.plus(D(leg.quantity).times(leg.side === 'BUY' ? 1 : -1)).abs().times(price);
        if (projected.gt(maximum)) fail(`${leg.symbol} 超过当前杠杆允许的风险档位名义额`);
        const required = D(leg.notionalUSDT).div(leverage).times('1.10'), venue = leg.symbol.split('_')[0];
        requirements.set(venue, (requirements.get(venue) || D(0)).plus(required));
        return { symbol: leg.symbol, leverage: leverage.toString(), requiredMargin: required.toString(), maxPositionNotional: maximum.toString(), projectedNotional: projected.toString(), quoteCurrency: leg.quoteCurrency || leg.symbol.split('_').at(-1) };
      });
      const requiredMargin = [...requirements.values()].reduce((sum, value) => sum.plus(value), D(0));
      let availableMargin, accounts;
      if (cache.account.account_mode === 'CROSS_EXCHANGE') {
        availableMargin = numeric(cache.account.available_margin);
        if (!availableMargin || availableMargin.lt(requiredMargin)) fail('账户可用保证金不足以覆盖订单及 10% 预留');
        accounts = [{ exchangeType: 'CROSSEX', availableMargin: availableMargin.toString(), requiredMargin: requiredMargin.toString() }];
      } else if (cache.account.account_mode === 'ISOLATED_EXCHANGE') {
        const isolated = await Promise.all([...requirements.keys()].map(async venue => {
          const account = await bounded(client.getAccount(venue)); verifyUid(validateAccount(account), record.accountUid);
          if (account.account_mode !== 'ISOLATED_EXCHANGE' || account.exchange_type !== venue || account.position_mode !== cache.account.position_mode) throw new Error('ISOLATED_MODE_UNKNOWN');
          const available = numeric(account.available_margin), required = requirements.get(venue);
          if (!available || available.lt(required)) fail(`${venue} 隔离账户可用保证金不足`);
          return { exchangeType: venue, availableMargin: available.toString(), requiredMargin: required.toString() };
        }));
        accounts = isolated; availableMargin = isolated.reduce((sum, a) => sum.plus(a.availableMargin), D(0));
      } else throw new Error('ACCOUNT_MODE_UNKNOWN');
      return { requiredMargin: requiredMargin.toString(), availableMargin: availableMargin.toString(), marginCurrency: 'USDT', reserveFactor: '1.10', accountMode: cache.account.account_mode, accounts, legs, asOf: clock() };
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail('当前杠杆、风险档位或可用保证金未能核实，暂不能新开仓');
    }
  }
  function feeEstimate(plan, version) {
    const data = supplementalRecord(version), fees = data.fees || [];
    return { asOf: data.feesAsOf || null, error: data.feesError || null, legs: plan.legs.map(leg => {
      const venue = fees.find(f => f.exchange_type === leg.symbol.split('_')[0]), special = venue?.special_fee_list?.find(f => f.symbol === leg.symbol);
      const maker = special?.maker_fee_rate ?? venue?.future_maker_fee, taker = special?.taker_fee_rate ?? venue?.future_taker_fee;
      const rate = leg.timeInForce === 'POC' ? maker : taker, known = numeric(rate);
      return { symbol: leg.symbol, makerRate: numeric(maker)?.toString() ?? null, takerRate: numeric(taker)?.toString() ?? null,
        assumedRate: known?.toString() ?? null, estimatedFee: known ? D(leg.quantity).times(leg.price).times(known).toString() : null,
        currency: leg.quoteCurrency || leg.symbol.split('_').at(-1), source: known ? 'gate_crossex_fee' : 'unavailable' };
    }) };
  }
  async function previewInternal(input) {
    assertOwner();
    if (!object(input) || !['open', 'close', 'position'].includes(input.kind)) fail('预览类型无效', 400);
    await refreshInternal({ includeView: false });
    const { record, cache } = freshCache();
    let plan;
    const selected = [];
    if (input.kind === 'open') {
      if ([input.order, input.pair, input.signalId].filter(v => v !== undefined).length !== 1) fail('请选择一种开仓方式', 400);
      plan = input.order !== undefined ? await market.previewDirect(input.order) : input.pair !== undefined ? await market.previewPair(input.pair) : await market.previewOpen(input.signalId);
    } else if (input.kind === 'position') {
      const binding = bindPositionAction(input, cache, record.version);
      plan = await market.previewPosition({ ...binding, action: input.action, strategy: input.strategy });
      plan.positionRequest = copy(input);
      selected.push(...binding.positions);
    } else {
      const selections = input.positions === undefined ? [{ positionId: input.positionId, quantity: input.quantity, positionSide: input.positionSide }] : input.positions;
      if (!Array.isArray(selections) || !selections.length || selections.length > 16 || new Set(selections.map(s => s?.positionId)).size !== selections.length) fail('请选择 1–16 个不同的真实持仓', 400);
      const fragments = [];
      for (const selection of selections) {
        const position = cache.positions.find(p => positionKey(p) === selection?.positionId && !D(p.position_qty).isZero());
        if (!position) fail('实际持仓不存在或已平仓');
        const positionSide = direction(position), directionSource = ['LONG', 'SHORT'].includes(position.position_side) ? 'exchange' : positionSide ? 'quantity_sign' : 'unknown';
        if (!positionSide) fail('持仓方向无法核实，暂不能平仓');
        if (selection.positionSide !== undefined && selection.positionSide !== positionSide) fail('所选方向与实际持仓不一致');
        const fragment = await market.previewClose({ ...position, position_side: positionSide }, selection.quantity);
        if (fragment.legs?.length !== 1) fail('平仓计划不完整');
        const leg = fragment.legs[0];
        if (leg.symbol !== position.symbol || !positive(leg.quantity) || D(leg.quantity).gt(D(position.position_qty).abs()) || leg.side !== (positionSide === 'LONG' ? 'SELL' : 'BUY')) fail('平仓计划与实际持仓不匹配，不能越过零仓位');
        Object.assign(leg, { positionId: positionKey(position), directionSource });
        selected.push({ positionId: positionKey(position), symbol: position.symbol, positionSide, directionSource, quantity: leg.quantity, heldQuantity: D(position.position_qty).abs().toString() });
        fragments.push(fragment);
      }
      if (new Set(fragments.map(p => p.base || p.legs[0].symbol.split('_')[2])).size !== 1) fail('批量平仓仅支持同一基础资产的持仓');
      plan = { ...fragments[0], legs: fragments.flatMap(p => p.legs), expiresAt: Math.min(...fragments.map(p => p.expiresAt || Infinity)), warnings: [...new Set(fragments.flatMap(p => p.warnings || []))] };
    }
    if (!Array.isArray(plan.legs) || !plan.legs.length || plan.legs.length > (input.kind === 'close' ? 16 : 2)) fail('交易计划不完整');
    for (const leg of plan.legs) {
      if (!positive(leg.quantity) || !positive(leg.price) || !['BUY', 'SELL'].includes(leg.side) || !['LONG', 'SHORT'].includes(leg.positionSide)) fail('订单数量、价格或方向无效');
      leg.orderType ||= 'LIMIT'; leg.timeInForce ||= 'IOC';
      if (input.kind !== 'position') leg.reduceOnly = input.kind === 'close';
      if (!['LIMIT', 'MARKET'].includes(leg.orderType) || !['GTC', 'IOC', 'FOK', 'POC'].includes(leg.timeInForce)) fail('订单类型或生效方式无效');
      if (input.kind === 'open' && plan.legs.length === 2 && (leg.orderType !== 'LIMIT' || leg.timeInForce !== 'IOC')) fail('双腿开仓必须使用保护限价 IOC');
      if (cache.account.position_mode === 'SINGLE') leg.positionSide = 'NONE';
    }
    if (input.kind === 'position') validatePositionLegs(plan, { positions: selected }, cache.account.position_mode);
    checkConflicts(plan, cache); await validateLimits(plan, cache);
    const risk = await riskPreview(plan, record, cache);
    const preview = { ...plan, id: id(), createdAt: clock(), expiresAt: Math.min(plan.expiresAt || Infinity, clock() + 30000),
      connectionVersion: record.version, accountUid: record.accountUid, accountFingerprint: accountFingerprint(cache), configFingerprint: configFingerprint(), positionId: selected.length === 1 ? selected[0].positionId : null,
      selectedPositionSide: selected.length === 1 ? selected[0].positionSide : null, positions: selected, risk, feeEstimate: feeEstimate(plan, record.version), canConfirm: !!record.accountUid && !writerError && !writerLost,
      warnings: [...(plan.warnings || []), '这是实盘订单，交易权限未能预先核实，最终由 Gate 校验',
        ...(selected.some(p => p.directionSource === 'quantity_sign') ? ['单向净仓方向按持仓数量符号推导；减仓单仅减少持仓，不跨过零仓位'] : []),
        ...(input.kind === 'open' && plan.legs.length === 2 ? ['两腿依次提交；第一腿未在本次确认中全成则不发送第二腿，可能留下单边敞口，需手动处理'] : []),
        ...(input.kind === 'close' && plan.legs.length > 1 ? ['所选持仓分别提交一次减仓单；其中一腿未成交时，其他腿仍按本次确认提交，不自动补单'] : [])] };
    store.prepare('INSERT INTO live_previews(id,expires_at,json) VALUES (?,?,?)').run(preview.id, preview.expiresAt, JSON.stringify(preview));
    return copy(preview);
  }
  function savedRequest(requestId, fingerprint) {
    const row = store.prepare('SELECT * FROM live_requests WHERE id=?').get(requestId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) fail('同一请求标识不能用于不同操作');
    const result = JSON.parse(row.result); return row.kind === 'confirm' ? getExecution(result.executionId) : { ...result, order: findOrder(result.orderId) };
  }
  async function confirmInternal(input) {
    assertOwner();
    const requestId = requestKey(input?.requestId), fingerprint = hash(['confirm', input?.previewId]);
    const previous = savedRequest(requestId, fingerprint); if (previous) return previous;
    const deadline = performance.now() + confirmationWaitMs;
    const row = store.prepare('SELECT * FROM live_previews WHERE id=?').get(String(input?.previewId || ''));
    if (!row || row.consumed) fail('预览不存在或已确认，请重新预览');
    const plan = JSON.parse(row.json);
    if (clock() >= plan.expiresAt) fail('预览已过期，请重新预览');
    await refreshInternal({ deadline, includeView: false });
    const { record, cache } = freshCache();
    if (record.version !== plan.connectionVersion || record.accountUid !== plan.accountUid || accountFingerprint(cache) !== plan.accountFingerprint || configFingerprint() !== plan.configFingerprint) fail('账户、持仓或设置已变化，请重新预览');
    if (record.tradePermission === 'denied') fail('此凭据没有交易权限');
    if (plan.kind === 'position') validatePositionLegs(plan, bindPositionAction(plan.positionRequest, cache, record.version), cache.account.position_mode);
    checkConflicts(plan, cache);
    // Market refreshes valuation without changing the user's quantity or order price.
    // Every financial check must run afterwards; otherwise it would use stale amounts.
    await withinDeadline(() => plan.kind === 'open' ? market.revalidateOpen(plan) : plan.kind === 'position' ? market.revalidatePosition(plan) : market.revalidateClose(plan), deadline);
    if (plan.kind === 'position') validatePositionLegs(plan, bindPositionAction(plan.positionRequest, cache, record.version), cache.account.position_mode);
    await withinDeadline(() => validateLimits(plan, cache), deadline);
    const currentRisk = await withinDeadline(() => riskPreview(plan, record, cache), deadline);
    if (currentRisk && plan.risk && hash(currentRisk.legs.map(l => [l.symbol, l.leverage])) !== hash(plan.risk.legs.map(l => [l.symbol, l.leverage]))) fail('账户杠杆已变化，请重新预览');
    assertOwner();
    if (remaining(deadline) <= 0 || clock() >= plan.expiresAt || connectionRecord()?.version !== record.version || configFingerprint() !== plan.configFingerprint) fail('预览或连接已变化，请重新预览');
    const ticket = claimWriter(record);
    const execution = { id: id(), requestId, previewId: plan.id, kind: plan.kind, ...(plan.kind === 'position' ? { action: plan.action, strategy: plan.strategy, targetQuantity: plan.targetQuantity } : {}), base: plan.base, accountUid: record.accountUid, connectionVersion: record.version, createdAt: clock(), updatedAt: clock() };
    const legs = plan.legs.map((leg, index) => ({ id: id(), executionId: execution.id, index, text: `cx-${id()}`, version: record.version, status: 'PREPARED',
      symbol: leg.symbol, exchange: leg.exchange, side: leg.side, positionSide: leg.positionSide, quantity: D(leg.quantity).toString(), price: D(leg.price).toString(),
      reduceOnly: plan.kind === 'position' ? leg.reduceOnly : plan.kind === 'close', orderType: leg.orderType || 'LIMIT', timeInForce: leg.timeInForce || 'IOC', executedQty: '0', orderId: null, createdAt: clock(), updatedAt: clock(), error: null }));
    for (const order of legs) order.writerCreateId = createOperation(order);
    store.transaction(() => {
      assertWriter(ticket, 0);
      store.prepare('UPDATE live_previews SET consumed=1 WHERE id=?').run(plan.id);
      store.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run(execution.id, plan.id, clock(), JSON.stringify(execution));
      for (const leg of legs) writeOrder(leg);
      store.prepare('INSERT INTO live_requests VALUES (?,?,?,?)').run(requestId, fingerprint, 'confirm', JSON.stringify({ executionId: execution.id }));
    });
    const client = getClient(record);
    const confirmationStarted = performance.now();
    for (const [index, order] of legs.entries()) {
      const legStarted = performance.now(), legPollMs = ['open', 'position'].includes(plan.kind) && legs.length > 1 ? confirmationPollMs : Math.min(confirmationPollMs, legs.length > 1 ? 1000 : 1500);
      const currentConnection = connectionRecord();
      if (['open', 'position'].includes(plan.kind) && index && legs[index - 1].status !== 'FILLED' || remaining(deadline) <= 0 || clock() >= plan.expiresAt || !owns()
        || !currentConnection?.enabled || currentConnection.version !== record.version || currentConnection.accountUid !== record.accountUid || configFingerprint() !== plan.configFingerprint) {
        if (mayPersist(ticket)) { order.status = 'UNSENT'; order.error = '前腿未全成、确认超时或设置/连接已变化，此腿没有发送；请管理实际敞口'; writeOrder(order); } continue;
      }
      let operation = null, invoked = false;
      try {
        operation = prepareOperation(ticket, order.writerCreateId, createSemantic(order, record));
        const submissionTicket = operation ?? ticket;
        assertWriter(submissionTicket); order.status = 'SENDING'; writeOrder(order);
        activeSubmission = { ticket: submissionTicket, version: record.version, accountUid: record.accountUid, method: 'POST',
          payloadHash: hash(Object.entries(createPayload(order)).sort()), expiresAt: plan.expiresAt, deadline, configFingerprint: plan.configFingerprint };
        const response = await withinDeadline(() => { assertWriter(submissionTicket); invoked = true; return client.createOrder(createPayload(order)); }, deadline);
        if (mayPersist(ticket)) {
          if (object(response) && response.order_id && response.text === order.text && response.state === undefined) {
            order.orderId = String(response.order_id); order.status = 'UNKNOWN'; order.error = '交易所已接单，成交尚待核实'; writeOrder(order);
            await reconcileOrder(order, client, [], deadline);
          } else applyResult(order, response, ticket);
          while ((order.orderType === 'MARKET' || ['IOC', 'FOK'].includes(order.timeInForce)) && mayPersist(ticket) && ACTIVE.has(order.status) && remaining(deadline) > 0 && performance.now() - confirmationStarted < confirmationPollMs && performance.now() - legStarted < legPollMs && clock() < plan.expiresAt) {
            await new Promise(resolve => setTimeout(resolve, Math.min(remaining(deadline), pollIntervalMs, Math.max(1, legPollMs - (performance.now() - legStarted)))));
            if (remaining(deadline) <= 0 || performance.now() - confirmationStarted >= confirmationPollMs || performance.now() - legStarted >= legPollMs || clock() >= plan.expiresAt || !mayPersist(ticket)) break;
            await reconcileOrder(order, client, [], deadline);
          }
        }
      } catch (error) {
        if (mayPersist(ticket)) {
          // No transport/API failure is proof that a write did not reach Gate.
          let outcome = 'unknown', denied = false;
          if (!invoked || error.code === 'GATE_SUBMISSION_BLOCKED') {
            order.status = 'UNSENT'; order.error = '账户写入许可未通过，此腿没有发送'; outcome = 'rejected';
          } else if (error.code === 'GATE_HTTP_ERROR' && error.uncertain === false && error.label === 'READ_ONLY') {
            order.status = 'REJECT'; order.error = 'Gate 明确拒绝：此凭据只有读取权限'; outcome = 'rejected'; denied = true;
          } else { order.status = 'UNKNOWN'; order.error = '提交结果未能核实，正在按原订单标识查询；不会重试下单'; }
          if (outcome === 'rejected') order.writerRejectedState = order.status;
          writeOrder(order);
          if (denied) putSingleton('live_connection', { ...record, tradePermission: 'denied' });
          finishOperation(operation, outcome);
          if (outcome === 'rejected') clearSettledWriterError(ticket);
        }
      } finally { activeSubmission = null; }
    }
    // Refresh actual balances/positions once, within this request's remaining
    // budget. This read is not part of the durable execution result and cannot
    // turn a recorded fill into a failed request.
    if (mayPersist(ticket) && connectionRecord()?.version === record.version) {
      putSingleton('live_cache', { ...cacheRecord(), error: '订单结果已记录，等待更新账户与实际持仓快照' });
      if (remaining(deadline) > 0 && postConfirmRefreshMs > 0) {
        try { await refreshInternal({ deadline: Math.min(deadline, performance.now() + postConfirmRefreshMs), reconcile: false, includeView: false }); }
        catch { /* The normal read-only refresh will pick this up. */ }
      }
    }
    return getExecution(execution.id);
  }
  async function cancelInternal(input) {
    assertOwner();
    const requestId = requestKey(input?.requestId), orderId = String(input?.orderId || ''), fingerprint = hash(['cancel', orderId]);
    const previous = savedRequest(requestId, fingerprint); if (previous) return previous;
    await refreshInternal({ includeView: false });
    const { record, cache } = freshCache();
    let order = findOrder(orderId);
    if (!order) {
      const raw = cache.openOrders.find(o => String(o.order_id) === orderId);
      if (!raw || !ACTIVE.has(raw.state) || !['BUY', 'SELL'].includes(raw.side) || typeof raw.text !== 'string' || !positive(raw.qty)) fail('可撤订单不存在或信息不足');
      order = { id: id(), executionId: `external-${id()}`, index: 0, text: `external-${raw.order_id}`, clientText: raw.text, version: record.version, orderId: String(raw.order_id), symbol: raw.symbol,
        exchange: exchangeOf(raw.symbol), side: raw.side, positionSide: raw.position_side, orderType: raw.type, timeInForce: raw.time_in_force, quantity: D(raw.qty).toString(), price: raw.price, executedQty: D(raw.executed_qty).toString(),
        reduceOnly: String(raw.reduce_only) === 'true', status: raw.state, createdAt: clock(), updatedAt: clock(), external: true, raw };
    }
    if (order.version !== record.version || !order.orderId || !ACTIVE.has(order.status)) fail('订单状态尚未确认、已结束或撤单处理中，不能重复撤单');
    const ticket = claimWriter(record), original = copy(order);
    const operationId = `crossex:cancel:${requestId}`;
    // Persist the original target before the shared intent. This marker proves
    // a restart before CANCEL_PENDING could not have reached the transport.
    order.writerCancelId = operationId; order.writerCancelPrepared = true;
    assertWriter(ticket, 0); writeOrder(order);
    let operation;
    try { operation = prepareOperation(ticket, operationId, cancelSemantic(order, record)); }
    catch (error) { if (mayPersist(ticket)) writeOrder(original); throw error; }
    order.writerCancelPrepared = false;
    order.status = 'CANCEL_PENDING'; order.error = '撤单请求待交易所确认';
    const result = { requestId, orderId: order.id, status: 'CANCEL_PENDING' };
    store.transaction(() => { assertWriter(ticket, 0); writeOrder(order); store.prepare('INSERT INTO live_requests VALUES (?,?,?,?)').run(requestId, fingerprint, 'cancel', JSON.stringify(result)); });
    let invoked = false;
    try {
      const submissionTicket = operation ?? ticket;
      activeSubmission = { ticket: submissionTicket, version: record.version, accountUid: record.accountUid, method: 'DELETE', orderId: order.orderId };
      assertWriter(submissionTicket); invoked = true;
      const response = await bounded(getClient(record).cancelOrder(order.orderId));
      if (mayPersist(ticket) && object(response) && response.state) applyResult(order, response, ticket);
    } catch (error) {
      if ((!invoked || error.code === 'GATE_SUBMISSION_BLOCKED') && mayPersist(ticket)) {
        const unsent = { ...original, writerCancelId: operationId, writerCancelPrepared: true };
        result.status = 'UNSENT';
        store.transaction(() => {
          assertWriter(ticket, 0); writeOrder(unsent);
          store.prepare('UPDATE live_requests SET result=? WHERE id=?').run(JSON.stringify(result), requestId);
        });
        finishOperation(operation, 'rejected');
        delete unsent.writerCancelId; delete unsent.writerCancelPrepared; writeOrder(unsent);
        clearSettledWriterError(ticket);
      }
      // Other failures retain the cancel intent; reconciliation never retries DELETE.
    }
    finally { activeSubmission = null; if (mayPersist(ticket) && findOrder(order.id)?.status === 'CANCEL_PENDING') finishOperation(operation, 'unknown'); }
    return { ...result, order: findOrder(order.id) };
  }
  function positionView(p, at, adl = []) {
    const parts = p.symbol.split('_'), side = direction(p), quantity = D(p.position_qty).abs().toString();
    const directionSource = ['LONG', 'SHORT'].includes(p.position_side) ? 'exchange' : side ? 'quantity_sign' : 'unknown';
    const sourceAt = Number(p.update_time) > 0 ? Number(p.update_time) : null, rank = adl.find(r => r.symbol === p.symbol);
    const createdAt = Number(p.create_time);
    const openedAt = Number.isSafeInteger(createdAt) && createdAt > 0 && createdAt <= Math.min(sourceAt ?? at, at) ? createdAt : null;
    return { ...p, id: positionKey(p), exchange: exchangeOf(p.symbol), side: side || 'UNKNOWN', directionSource, quantity, baseQuantity: quantity,
      signedQuantity: side ? D(quantity).times(side === 'SHORT' ? -1 : 1).toString() : null,
      baseCurrency: parts[2] || '', quoteCurrency: parts.slice(3).join('_'), entryPrice: p.avg_price ?? p.entry_price ?? null,
      markPrice: p.mark_price ?? null, notional: numeric(p.position_value)?.abs().toString() ?? null, positionValue: p.position_value ?? null,
      unrealizedPnl: p.upnl ?? null, unrealizedPnlRate: p.upnl_rate ?? null, pnlCurrency: p.currency || parts.at(-1), margin: p.initial_margin ?? null,
      maintenanceMargin: p.maintenance_margin ?? null, leverage: p.leverage ?? null, maxLeverage: p.max_leverage ?? null, riskLimit: p.risk_limit ?? null,
      fee: p.fee ?? null, fundingFee: p.funding_fee ?? null, fundingTime: p.funding_time ?? null, realizedPnl: p.closed_pnl ?? null,
      marginCurrency: p.currency || parts.at(-1), liquidationPrice: p.liq_price ?? null, crossExAdlRank: rank?.crossex_adl_rank ?? null, exchangeAdlRank: rank?.exchange_adl_rank ?? null,
      source: 'gate_crossex_authenticated_rest', sourceAt, openedAt, external: true, updatedAt: sourceAt ?? at };
  }
  function orderView(order, external = false) {
    return { ...order, id: external ? String(order.order_id) : order.id, orderId: external ? String(order.order_id) : order.orderId,
      exchange: order.exchange || exchangeOf(order.symbol), status: external ? order.state : order.status,
      quantity: external ? String(order.qty) : order.quantity, filledQuantity: external ? String(order.executed_qty) : order.executedQty,
      reduceOnly: external ? String(order.reduce_only) === 'true' : order.reduceOnly,
      canCancel: !!(external ? order.order_id : order.orderId) && ACTIVE.has(external ? order.state : order.status), external };
  }
  function connectionView(record = connectionRecord(), cache = cacheRecord()) {
    const connected = !!record?.enabled;
    return { configured: connected, connected, status: !connected ? 'disconnected' : cache.error ? 'error' : 'connected', accountId: record?.accountUid ?? null,
      keySuffix: record?.keySuffix ?? null, apiKeySuffix: record?.keySuffix ?? null, version: record?.version ?? 0,
      positionMode: cache.account?.position_mode ?? null, permissions: { read: connected ? 'verified' : 'unknown', trade: record?.tradePermission || 'unknown' },
      lastVerifiedAt: record?.verifiedAt ?? null, error: cache.error };
  }
  function view(options) {
    const record = connectionRecord(), cache = cacheRecord(), tracked = orderRecords(), details = supplementalRecord(record?.version);
    const held = cache.positions.filter(p => !D(p.position_qty).isZero());
    const current = tracked.filter(o => o.version === record?.version), unknown = current.some(o => ['SENDING', 'UNKNOWN', 'INVALID', 'CANCEL_PENDING'].includes(o.status)) || cache.openOrders.some(o => !REMOTE.has(o.state));
    const stale = !cache.asOf || clock() - cache.asOf > freshnessMs || cache.asOf > clock() + 1000;
    const connected = !!record?.enabled, partial = connected && (!!cache.error || unknown);
    const freshnessState = !connected ? 'offline' : partial ? 'partial' : stale ? 'stale' : 'live';
    const knownMode = ['SINGLE', 'DUAL'].includes(cache.account?.position_mode) && ['CROSS_EXCHANGE', 'ISOLATED_EXCHANGE'].includes(cache.account?.account_mode), reasons = [];
    if (!connected) reasons.push('尚未连接实盘账户');
    if (stale) reasons.push('账户数据已过期');
    if (cache.error) reasons.push(cache.error);
    if (unknown) reasons.push('存在未知或待确认订单，只能继续查询');
    if (connected && !record.accountUid) reasons.push('账户 UID 尚未核实，仅允许读取和预览');
    if (writerError) reasons.push(writerError);
    if (!knownMode) reasons.push('账户持仓模式不明');
    if (record?.tradePermission === 'denied') reasons.push('此凭据只有读取权限');
    if (!owns()) reasons.push('本实例未持有执行锁');
    const externalOrders = cache.openOrders.filter(raw => !current.some(o => o.orderId ? o.orderId === String(raw.order_id) : o.text === raw.text));
    const byExecution = new Map();
    for (const order of tracked) {
      if (!byExecution.has(order.executionId)) byExecution.set(order.executionId, []);
      byExecution.get(order.executionId).push(order);
    }
    return { ...market.view({ ...options, includeFundingOpportunities: options?.includeOpportunities === false ? false : options?.includeFundingOpportunities,
      includePositionFunding: options?.includeFundingOpportunities === true, positionSymbols: held.map(p => p.symbol) }), mode: 'live', live: {
      connection: connectionView(record, cache),
      status: freshnessState, freshnessState, stale, partial, asOf: cache.asOf, tradingAllowed: connected && !!record.accountUid && !writerError && !writerLost && !stale && !partial && knownMode && record?.tradePermission !== 'denied' && owns(), reasons,
      account: cache.account, balances: Array.isArray(cache.account?.assets) ? cache.account.assets : [],
      positions: held.map(p => positionView(p, cache.asOf, details.adl || [])),
      orders: [...current.map(o => orderView(o)), ...externalOrders.map(o => orderView(o, true))].slice(0, 300),
      recentTrades: historyRows('live_trades', record?.version), recentTradesAsOf: details.recentTradesAsOf ?? null, recentTradesError: details.recentTradesError ?? null,
      accountBook: historyRows('live_account_book', record?.version), accountBookAsOf: details.accountBookAsOf ?? null, accountBookError: details.accountBookError ?? null,
      fees: details.fees || [], feesAsOf: details.feesAsOf ?? null, feesError: details.feesError ?? null, adlAsOf: details.adlAsOf ?? null, adlError: details.adlError ?? null,
      executions: executionRecords().map(execution => executionView(execution, byExecution.get(execution.id) || [])), alerts: reasons, updatedAt: clock() } };
  }
  function summary() {
    const record = connectionRecord(), cache = cacheRecord(), connected = !!record?.enabled;
    const orders = orderRecords().filter(o => o.version === record?.version), unknown = orders.filter(o => ['SENDING', 'UNKNOWN', 'INVALID', 'CANCEL_PENDING'].includes(o.status));
    const stale = !cache.asOf || clock() - cache.asOf > freshnessMs || cache.asOf > clock() + 1000;
    const externalOrders = cache.openOrders.filter(raw => !orders.some(o => o.orderId ? o.orderId === String(raw.order_id) : o.text === raw.text));
    const knownMode = ['SINGLE', 'DUAL'].includes(cache.account?.position_mode) && ['CROSS_EXCHANGE', 'ISOLATED_EXCHANGE'].includes(cache.account?.account_mode);
    const state = !connected ? 'offline' : cache.error || unknown.length || !knownMode || !record.accountUid || writerError ? 'partial' : stale ? 'stale' : 'online';
    const message = !connected ? '尚未连接 Gate CrossEx 实盘账户' : cache.error || writerError || (!record.accountUid ? '账户 UID 尚未核实，仅允许读取和预览' : unknown.length ? '存在未知或待确认订单，仅继续只读对账' : !knownMode ? '账户模式尚未核实，仅可查看' : stale ? '账户快照已过期' : '实盘账户已同步，仅接受手动确认下单');
    return { name: 'Gate CrossEx', mode: 'live', updatedAt: connected && cache.asOf ? new Date(cache.asOf).toISOString() : null,
      health: { state, message, staleAfterSeconds: Math.floor(freshnessMs / 1000) },
      metrics: [
        { key: 'livePositions', label: '实际持仓', value: cache.positions.filter(p => !D(p.position_qty).isZero()).length, unit: '条' },
        { key: 'liveOrders', label: '活动订单', value: orders.filter(o => !TERMINAL.has(o.status)).length + externalOrders.filter(o => !TERMINAL.has(o.state)).length, unit: '笔' },
        { key: 'unconfirmedOrders', label: '待确认订单', value: unknown.length, unit: '笔' },
      ] };
  }
  function manualAction(input, action) {
    return exclusive(async () => {
      try { return await action(input); }
      catch (error) {
        const saved = typeof input?.requestId === 'string' && store.prepare('SELECT id FROM live_requests WHERE id=?').get(input.requestId);
        if (!saved && error && typeof error === 'object') error.requestStatus = 'not_submitted';
        throw error;
      }
    });
  }
  function requestStatusInternal(input) {
    const requestId = requestKey(input), row = store.prepare('SELECT kind,fingerprint FROM live_requests WHERE id=?').get(requestId);
    if (row) return { requestId, requestStatus: 'submitted', kind: row.kind, result: savedRequest(requestId, row.fingerprint) };
    // Only the sole executing process can prove its preceding queue contains no
    // preflight request which has not reached the durable intent transaction.
    assertOwner();
    return { requestId, requestStatus: 'not_submitted' };
  }
  function updateStatus() {
    if (queuedOperations || capacityFlights.size) return { busy: true, reason: '实盘请求仍在处理，请完成后再更新' };
    let cache = cacheRecord();
    if (connectionRecord()?.enabled) {
      try { assertOwner(); ({ cache } = freshCache()); }
      catch { return { busy: true, reason: '实盘账户状态或执行锁尚未核实，暂不能更新' }; }
    }
    if (activeOrders().length || cache.openOrders.some(order => !TERMINAL.has(order.state))) return { busy: true, reason: '仍有活动或待核实委托，请核实订单后再更新' };
    return { busy: false };
  }
  return { connection: input => exclusive(() => connectInternal(input)), disconnect: () => exclusive(disconnectInternal),
    refresh: options => exclusive(() => refreshInternal(options)), preview: input => exclusive(() => previewInternal(input)), openCapacity, confirm: input => manualAction(input, confirmInternal),
    cancel: input => manualAction(input, cancelInternal), requestStatus: requestId => exclusive(() => requestStatusInternal(requestId)), refreshDetails: () => refreshSupplemental(true), view, connectionView, summary, updateStatus,
    async stop() { clearInterval(heartbeat); await queue; stopped = true; await supplementalFlight; store.prepare('DELETE FROM live_owner WHERE singleton=1 AND owner=?').run(owner); } };
}
