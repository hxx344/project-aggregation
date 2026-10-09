import { createHash, randomUUID } from 'node:crypto';
import { createExecutionExchangeClient, ExecutionExchangeError } from './trading-execution-exchanges.mjs';
import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';
import { ExecutionError, EXECUTION_EXCHANGES, exactKeys, normalizeIntent, buildPlan, normalizeMarket, checkPosition, ensureNoExternalOrders, checkChildQuantity, checkContract, stopReached, subtract, positionSide } from './trading-execution-plan.mjs';
import { TRADING_NAMES } from './trading-markets.mjs';

const iso = time => new Date(time).toISOString();
const FINAL = new Set(['completed', 'stopped']);
const ACTIVE = new Set(['queued', 'running', 'stopping']);
const PREVIEW_TTL = 30_000, LEASE_TTL = 60_000;
class NotSubmittedError extends ExecutionError { constructor(message) { super(409, message); } }
const safeError = error => error instanceof ExecutionError || error instanceof ExecutionExchangeError ? error.message.slice(0, 220) : '交易所响应无法确认，请核对任务与交易所委托';
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const modeOf = (exchange, mode) => {
  if (!(exchange === 'binance' ? ['standard', 'portfolio-margin'] : exchange === 'okx' ? ['cross', 'isolated'] : ['unified']).includes(mode)) throw new ExecutionError(400, '请选择正确的实盘账户模式');
  return mode;
};

/** Durable, explicit live execution. Read endpoints never submit exchange requests. */
export function createTradingExecution({ db, encrypt, decrypt, clientFactory = createExecutionExchangeClient, now = Date.now, intervalMs = 1000, callTimeoutMs = 35_000, isSessionActive = () => true } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, account_mode TEXT NOT NULL, identity TEXT, key_label TEXT, verified_at TEXT, snapshot TEXT);
    CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_orders (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_orders_job ON execution_orders(job_id);
    CREATE TABLE IF NOT EXISTS execution_previews (id TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL, json TEXT NOT NULL, consumed TEXT);
    CREATE TABLE IF NOT EXISTS execution_requests (id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, job_id TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_locks (resource TEXT PRIMARY KEY, job_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  for (const exchange of EXECUTION_EXCHANGES) db.prepare('INSERT OR IGNORE INTO execution_accounts(exchange,account_mode) VALUES (?,?)').run(exchange, exchange === 'binance' ? 'standard' : exchange === 'okx' ? 'cross' : 'unified');
  const owner = randomUUID(), clients = new Map(EXECUTION_EXCHANGES.map(exchange => [exchange, clientFactory(exchange)]));
  const pending = new Set(), controllers = new Set(), busyJobs = new Set(), connecting = new Set();
  let closed = false, closing = false, leader = false, heldLease = false, retired = false, ticking = null;
  function lostLease() {
    retired = true; leader = false;
    throw new ExecutionError(503, '执行服务已失去运行锁，请重启服务后核对任务');
  }
  const transaction = operation => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const accountRow = exchange => {
    if (!EXECUTION_EXCHANGES.includes(exchange)) throw new ExecutionError(404, '交易所不存在');
    return db.prepare('SELECT * FROM execution_accounts WHERE exchange=?').get(exchange);
  };
  const jobs = () => db.prepare('SELECT json FROM execution_jobs').all().map(row => JSON.parse(row.json));
  const jobFor = id => { const row = db.prepare('SELECT json FROM execution_jobs WHERE id=?').get(id); if (!row) throw new ExecutionError(404, '执行任务不存在'); return JSON.parse(row.json); };
  const saveJob = job => {
    job.updatedAt = iso(now());
    const result = db.prepare('INSERT INTO execution_jobs(id,json) SELECT ?,? WHERE EXISTS(SELECT 1 FROM execution_lease WHERE id=1 AND owner=? AND expires>?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job), owner, now());
    if (!result.changes) lostLease();
    return job;
  };
  const orders = jobId => db.prepare('SELECT json FROM execution_orders WHERE job_id=? ORDER BY rowid').all(jobId).map(row => JSON.parse(row.json));
  const saveOrder = order => {
    const result = db.prepare('INSERT INTO execution_orders(id,job_id,json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM execution_lease WHERE id=1 AND owner=? AND expires>?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(order.localId, order.jobId, JSON.stringify(order), owner, now());
    if (!result.changes) lostLease();
  };
  const orderFor = id => { const row = db.prepare('SELECT json FROM execution_orders WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; };
  const event = (job, message) => { job.events.push({ time: iso(now()), message }); job.events = job.events.slice(-80); };
  const locked = exchange => !!db.prepare('SELECT 1 FROM execution_locks WHERE resource LIKE ? LIMIT 1').get(`${exchange}:%`);
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
      const row = db.prepare('SELECT * FROM execution_lease WHERE id=1').get();
      // One instance owns at most one continuous lease. Never revive callbacks
      // from an earlier lease after another process has reconciled their intents.
      if (heldLease && (!row || row.owner !== owner || row.expires <= now())) { retired = true; return false; }
      if (row && row.owner !== owner && row.expires > now()) return false;
      db.prepare('INSERT INTO execution_lease(id,owner,expires) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(owner, now() + LEASE_TTL);
      heldLease = true;
      if (!wasLeader || (row && row.expires <= now())) {
        for (const job of jobs()) if (ACTIVE.has(job.status)) pause(job.id, '服务恢复：已暂停后续下单，正在核对并撤销未结束委托');
        for (const job of jobs()) if (FINAL.has(job.status)) db.prepare('DELETE FROM execution_locks WHERE job_id=?').run(job.id);
      }
      return true;
    });
    return leader;
  }
  function requireLease() {
    const row = db.prepare('SELECT * FROM execution_lease WHERE id=1').get();
    if (retired || heldLease && (!row || row.owner !== owner || row.expires <= now())) lostLease();
    if (closed || !leader || row?.owner !== owner || row.expires <= now()) throw new ExecutionError(503, '执行服务暂未取得运行锁，请稍后重试');
  }
  function writable() { if (closing) throw new ExecutionError(503, '执行服务正在停止'); requireLease(); }
  function checkSession(session) { if (session !== undefined && !isSessionActive(session)) throw new ExecutionError(401, '登录已失效，请重新登录'); }
  function connection(row) {
    return { exchange: row.exchange, connected: !!row.credentials, revision: row.revision, accountMode: row.account_mode,
      identity: row.identity, keyLabel: row.key_label, verifiedAt: row.verified_at, locked: locked(row.exchange) };
  }
  function context(exchange, revision) {
    const row = accountRow(exchange);
    if (!row.credentials || (revision !== undefined && row.revision !== revision)) throw new ExecutionError(409, '实盘连接已改变，请重新预览');
    const credentials = decrypt(row.credentials);
    if (!credentials || credentials.exchange !== exchange || credentials.purpose !== 'execution') throw new ExecutionError(503, '实盘凭据无法解密，请重新连接');
    return { row, credentials: { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, ...(exchange === 'okx' ? { passphrase: credentials.passphrase } : {}) }, client: clients.get(exchange), options: { accountMode: row.account_mode, beforeMutation: requireLease } };
  }
  async function call(fn) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('Execution deadline', 'TimeoutError')), callTimeoutMs); timer.unref?.();
    const promise = Promise.resolve().then(() => fn(controller.signal)); pending.add(promise);
    try { return await promise; } finally { clearTimeout(timer); controllers.delete(controller); pending.delete(promise); }
  }
  const totalFilled = (all, legId, phase, batch) => addDecimals(all.filter(order => order.legId === legId && (phase === undefined || order.phase === phase) && (batch === undefined || order.batch === batch)).map(order => order.filledQuantity));
  const unsettled = order => !order.settled;
  function publicJob(job) {
    const all = orders(job.id);
    return { id: job.id, preset: job.plan.preset, action: job.plan.action, status: job.status,
      createdAt: job.createdAt, updatedAt: job.updatedAt, deadlineAt: job.deadlineAt, batchIndex: job.batchIndex, batchCount: job.plan.batchCount,
      reason: job.reason, canResume: job.status === 'paused' && all.every(order => order.settled) && job.totals.some(leg => compareDecimals(totalFilled(all, leg.id), leg.quantity) < 0),
      legs: job.totals.map(leg => {
        const filledQuantity = totalFilled(all, leg.id), last = all.filter(order => order.legId === leg.id).at(-1);
        return { id: leg.id, exchange: leg.exchange, symbol: leg.symbol, side: leg.side, orderSide: leg.orderSide, quantity: leg.quantity, stopPrice: leg.stopPrice,
          filledQuantity, remainingQuantity: subtract(leg.quantity, filledQuantity),
          currentOrder: last ? { id: last.remoteId, clientId: last.spec.clientId, kind: last.kind, state: last.state, lastCheckedAt: last.lastCheckedAt, price: last.price, filledQuantity: last.filledQuantity, unknown: last.unknown } : null };
      }), events: job.events };
  }
  function state() {
    const rows = EXECUTION_EXCHANGES.map(accountRow);
    return { generatedAt: iso(now()), connections: rows.map(connection), positions: rows.flatMap(row => {
      if (!row.snapshot) return [];
      const snapshot = JSON.parse(row.snapshot);
      return snapshot.account.positions.map(position => ({ exchange: row.exchange, ...position, fetchedAt: snapshot.at }));
    }), jobs: (() => { const sorted = jobs().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return [...sorted.filter(job => !FINAL.has(job.status)), ...sorted.filter(job => FINAL.has(job.status)).slice(0, 30)].map(publicJob); })() };
  }
  function checkAvailable(exchange, revision) {
    writable();
    if (!validRevision(revision) || accountRow(exchange).revision !== revision) throw new ExecutionError(409, '连接版本已改变，请刷新后重试');
    if (locked(exchange)) throw new ExecutionError(409, '该交易所有未结束任务，先停止并完成委托核对后再更换连接');
  }
  async function connect(exchange, body, session) {
    exactKeys(body, ['revision', 'accountMode', 'apiKey', 'apiSecret', ...(exchange === 'okx' ? ['passphrase'] : [])]); checkSession(session); checkAvailable(exchange, body.revision);
    const mode = modeOf(exchange, body.accountMode);
    const valid = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
    if (!valid(body.apiKey) || !valid(body.apiSecret)) throw new ExecutionError(400, '请填写有效的 HMAC 实盘 API Key 和 Secret');
    if (exchange === 'okx' && (typeof body.passphrase !== 'string' || body.passphrase.length < 8 || body.passphrase.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(body.passphrase))) throw new ExecutionError(400, '请填写有效的 OKX Passphrase');
    if (connecting.has(exchange)) throw new ExecutionError(409, '此交易所正在验证实盘连接');
    connecting.add(exchange);
    try {
      const credentials = { apiKey: body.apiKey, apiSecret: body.apiSecret, ...(exchange === 'okx' ? { passphrase: body.passphrase } : {}) }, client = clients.get(exchange);
      const result = await call(async signal => { const verified = await client.verify(credentials, { accountMode: mode, signal }); const account = await client.account(credentials, { accountMode: mode, signal }); return { verified, account }; });
      checkSession(session); checkAvailable(exchange, body.revision);
      db.prepare('UPDATE execution_accounts SET revision=revision+1,credentials=?,account_mode=?,identity=?,key_label=?,verified_at=?,snapshot=? WHERE exchange=? AND revision=?').run(
        encrypt({ purpose: 'execution', exchange, ...credentials }), mode, result.verified.identity ?? null, body.apiKey.slice(-4), iso(now()), JSON.stringify({ at: iso(now()), account: result.account }), exchange, body.revision);
      return state();
    } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError(400, safeError(error)); }
    finally { connecting.delete(exchange); }
  }
  function disconnect(exchange, body, session) {
    exactKeys(body, ['revision']); checkSession(session); checkAvailable(exchange, body.revision);
    db.prepare('UPDATE execution_accounts SET revision=revision+1,credentials=NULL,identity=NULL,key_label=NULL,verified_at=NULL,snapshot=NULL WHERE exchange=?').run(exchange);
    return state();
  }
  async function collect(legs) {
    const exchanges = [...new Set(legs.map(leg => leg.exchange))], snapshots = new Map(), markets = new Map(), connections = new Map();
    await Promise.all(exchanges.map(async exchange => {
      const expected = legs.find(leg => leg.exchange === exchange)?.accountRevision;
      const ctx = context(exchange, expected);
      const account = await call(async signal => { await ctx.client.verify(ctx.credentials, { ...ctx.options, signal }); return ctx.client.account(ctx.credentials, { ...ctx.options, signal }); });
      requireLease();
      if (accountRow(exchange).revision !== ctx.row.revision) throw new ExecutionError(409, '实盘连接已改变，请重新预览');
      if (ctx.row.identity && account.identity && ctx.row.identity !== account.identity) throw new ExecutionError(409, '交易账户身份不一致');
      snapshots.set(exchange, account); connections.set(exchange, connection(ctx.row));
      db.prepare('UPDATE execution_accounts SET snapshot=? WHERE exchange=? AND revision=?').run(JSON.stringify({ account, at: iso(now()) }), exchange, ctx.row.revision);
    }));
    await Promise.all(legs.map(async leg => {
      const value = await call(signal => clients.get(leg.exchange).market(leg.symbol, { signal })); markets.set(`${leg.exchange}:${leg.symbol}`, value);
    }));
    requireLease(); return { snapshots, markets, connections };
  }
  async function preview(body, session) {
    writable(); checkSession(session);
    if (typeof session !== 'string' || !session) throw new ExecutionError(401, '请重新登录');
    let intent, resumeJobId = null;
    if (body && Object.hasOwn(body, 'resumeJobId')) {
      exactKeys(body, ['resumeJobId']);
      const job = jobFor(body.resumeJobId), view = publicJob(job);
      if (!view.canResume) throw new ExecutionError(409, '任务尚有未核对委托或不可继续，请先处理异常');
      resumeJobId = job.id;
      intent = { ...job.plan, batchCount: Math.max(1, job.plan.batchCount - job.batchIndex), legs: view.legs.filter(leg => compareDecimals(leg.remainingQuantity, '0') > 0).map(leg => ({ exchange: leg.exchange, symbol: leg.symbol, side: leg.side, quantity: leg.remainingQuantity, stopPrice: leg.stopPrice })) };
    } else intent = normalizeIntent(body);
    for (const leg of intent.legs) {
      const lock = db.prepare('SELECT job_id FROM execution_locks WHERE resource=?').get(`${leg.exchange}:${leg.symbol}`);
      if (lock && lock.job_id !== resumeJobId) throw new ExecutionError(409, '所选合约已有未结束任务');
    }
    let collected;
    try { collected = await collect(intent.legs); } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError(400, safeError(error)); }
    const plan = buildPlan(intent, collected.snapshots, collected.markets, collected.connections, now());
    const value = { ...plan, id: randomUUID(), expiresAt: iso(now() + PREVIEW_TTL), resumeJobId, connections: [...collected.connections.values()] };
    writable(); checkSession(session); db.prepare('DELETE FROM execution_previews WHERE expires<? AND consumed IS NULL').run(now());
    db.prepare('INSERT INTO execution_previews(id,session,expires,json) VALUES (?,?,?,?)').run(value.id, session, now() + PREVIEW_TTL, JSON.stringify(value));
    return value;
  }
  function start(body, session) {
    exactKeys(body, ['previewId', 'requestId', 'confirmLive']); writable(); checkSession(session);
    if (body.confirmLive !== true || typeof body.previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw new ExecutionError(400, '请从有效预览明确确认实盘执行');
    return transaction(() => {
      const request = db.prepare('SELECT * FROM execution_requests WHERE id=?').get(body.requestId);
      if (request) {
        if (request.preview_id !== body.previewId || request.session !== session) throw new ExecutionError(409, '请求标识已被使用');
        return state();
      }
      const record = db.prepare('SELECT * FROM execution_previews WHERE id=?').get(body.previewId);
      if (!record || record.session !== session || record.expires <= now() || record.consumed) throw new ExecutionError(409, '预览已过期或已提交，请重新预览');
      const plan = JSON.parse(record.json);
      for (const leg of plan.legs) {
        context(leg.exchange, leg.accountRevision);
        const lock = db.prepare('SELECT job_id FROM execution_locks WHERE resource=?').get(`${leg.exchange}:${leg.symbol}`);
        if (lock && lock.job_id !== plan.resumeJobId) throw new ExecutionError(409, '所选合约已有未结束任务');
      }
      let job;
      if (plan.resumeJobId) {
        job = jobFor(plan.resumeJobId);
        if (!publicJob(job).canResume) throw new ExecutionError(409, '任务状态已改变，请重新预览');
        for (const leg of plan.legs) if (compareDecimals(publicJob(job).legs.find(row => row.id === leg.id).remainingQuantity, leg.quantity) !== 0) throw new ExecutionError(409, '已成交数量改变，请重新预览');
        job.plan = plan; job.phase += 1;
      } else job = { id: randomUUID(), createdAt: iso(now()), totals: plan.legs, plan, phase: 0, events: [] };
      Object.assign(job, { status: 'queued', stopTarget: null, reason: null, batchIndex: 0, nextBatchAt: now(), deadlineAt: iso(now() + plan.timeoutMs) });
      event(job, plan.resumeJobId ? '已确认剩余数量，等待重新核对账户与盘口' : '已确认实盘预览，等待核对账户与盘口'); saveJob(job);
      for (const leg of plan.legs) db.prepare('INSERT OR IGNORE INTO execution_locks(resource,job_id) VALUES (?,?)').run(`${leg.exchange}:${leg.symbol}`, job.id);
      db.prepare('UPDATE execution_previews SET consumed=? WHERE id=?').run(job.id, plan.id);
      db.prepare('INSERT INTO execution_requests(id,preview_id,job_id,session) VALUES (?,?,?,?)').run(body.requestId, plan.id, job.id, session);
      return state();
    });
  }
  function validateInspection(order, value, { explicit = false } = {}) {
    if (!value || typeof value.id !== 'string' || !value.id || (order.remoteId && value.id !== order.remoteId) || value.symbol !== order.spec.symbol || value.side !== order.spec.side || value.reduceOnly !== order.spec.reduceOnly || (value.positionSide !== null && value.positionSide !== order.spec.positionSide) || value.kind !== order.kind || compareDecimals(value.quantity, order.spec.quantity) !== 0) throw new ExecutionError(409, '委托身份或数量与本任务不一致，禁止认领或补单');
    const filled = decimal(value.filledQuantity, { nonnegative: true });
    if (compareDecimals(filled, order.filledQuantity) < 0 || compareDecimals(filled, order.spec.quantity) > 0 || typeof value.terminal !== 'boolean' || typeof value.childrenSettled !== 'boolean') throw new ExecutionError(409, '委托成交记录不一致，暂停自动执行');
    if (explicit && (value.positionSide === null || !value.createdAt || !Number.isFinite(Date.parse(value.createdAt)) || Date.parse(value.createdAt) < Date.parse(order.createdAt) - 5000 || Date.parse(value.createdAt) > Date.parse(order.createdAt) + callTimeoutMs + 5000)) throw new ExecutionError(409, '策略方向或创建时间不匹配，禁止认领其他策略');
    return filled;
  }
  async function inspectOrder(order, explicitId) {
    requireLease();
    if (order.exchange === 'bybit' && !order.remoteId && !explicitId) return false;
    const ctx = context(order.exchange, order.accountRevision);
    const value = await call(signal => ctx.client.inspect(ctx.credentials, { ...order.spec, id: explicitId ?? order.remoteId }, { ...ctx.options, signal }));
    requireLease();
    const current = orderFor(order.localId), filledQuantity = validateInspection(current, value, { explicit: !!explicitId });
    Object.assign(current, { remoteId: value.id, filledQuantity, unknown: false, state: value.status, price: value.price ?? null, lastCheckedAt: iso(now()), settled: value.terminal && value.childrenSettled });
    saveOrder(current); return true;
  }
  async function cancelOrder(order) {
    requireLease();
    if (order.settled) return;
    if (!order.remoteId) {
      try { await inspectOrder(order); } catch { /* An absent Binance lookup is never proof that create failed. */ }
      order = orderFor(order.localId);
      if (!order.remoteId || order.settled) return;
    }
    const ctx = context(order.exchange, order.accountRevision);
    order.cancelRequestedAt = iso(now()); order.state = 'canceling'; saveOrder(order);
    try { await call(signal => ctx.client.stop(ctx.credentials, { ...order.spec, id: order.remoteId }, { ...ctx.options, signal })); }
    catch { /* Even a failed or timed-out stop must be reconciled by a fresh query. */ }
    await inspectOrder(orderFor(order.localId));
  }
  async function amendOrder(job, leg, order, market) {
    writable();
    if (!['binance', 'okx'].includes(order.exchange) || !order.remoteId || order.settled || order.unknown || order.amendPending) throw new ExecutionError(409, '原订单尚未确认，禁止追价');
    if ((order.amendCount ?? 0) >= 9000) throw new ExecutionError(409, '原订单已达到追价次数上限，请停止后重新预览');
    const ctx = context(order.exchange, order.accountRevision);
    // Amend the original total, never its remainder. Existing fills continue to
    // belong to the same order; this intent must survive a lost acknowledgement.
    Object.assign(order, { state: 'amending', amendPending: true, unknown: true, lastAmendAt: iso(now()), amendCount: (order.amendCount ?? 0) + 1 });
    saveOrder(order);
    try {
      const beforeMutation = () => {
        requireLease();
        const current = jobFor(job.id), original = orderFor(order.localId);
        if (closing || !['queued', 'running'].includes(current.status) || current.phase !== job.phase || current.batchIndex !== job.batchIndex || now() >= Date.parse(current.deadlineAt)
            || original.settled || original.remoteId !== order.remoteId || !original.amendPending) throw new NotSubmittedError('任务或原订单已停止，本次追价未发送');
        try { normalizeMarket(market, leg.symbol, now()); } catch { throw new NotSubmittedError('盘口已过期，本次追价未发送'); }
        if (stopReached(leg, market)) throw new NotSubmittedError('已达到追价停止价，本次追价未发送');
      };
      const value = await call(signal => ctx.client.amend(ctx.credentials, { ...order.spec, id: order.remoteId }, { ...ctx.options, signal, beforeMutation }));
      requireLease();
      const current = orderFor(order.localId), filledQuantity = validateInspection(current, value);
      Object.assign(current, { filledQuantity, unknown: false, amendPending: false, state: value.status, price: value.price ?? null, lastCheckedAt: iso(now()), settled: value.terminal && value.childrenSettled });
      saveOrder(current);
      if (current.settled && compareDecimals(current.filledQuantity, current.spec.quantity) < 0) throw new ExecutionError(409, '原生追价后订单提前终止且未全部成交，暂停其余交易腿');
    } catch (error) {
      requireLease();
      // A rejected amendment says nothing about whether the original order is
      // still live. Keep it unsettled until inspection and stop finish normally.
      const current = orderFor(order.localId);
      if (current.amendPending) {
        current.amendPending = false;
        current.unknown = !(error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain);
        current.state = current.unknown ? 'unknown' : 'working'; saveOrder(current);
      }
      pause(job.id, `${TRADING_NAMES[leg.exchange]} ${leg.symbol} 原生追价结果：${safeError(error)}`);
    }
  }
  async function submit(job, leg, quantity, market) {
    writable();
    if (!['queued', 'running'].includes(jobFor(job.id).status)) return;
    const all = orders(job.id);
    if (all.length >= 4000) throw new ExecutionError(409, '已达到本任务委托次数上限，请停止后另建任务');
    if (all.some(order => order.legId === leg.id && !order.settled)) throw new ExecutionError(409, '前一委托尚未结束，禁止重复下单');
    const ctx = context(leg.exchange, leg.accountRevision), localId = randomUUID();
    const spec = { symbol: leg.symbol, side: leg.orderSide, positionSide: positionSide(leg), quantity, reduceOnly: job.plan.action === 'close', clientId: 'h' + createHash('sha256').update(localId).digest('hex').slice(0, 30), stopPrice: leg.stopPrice,
      ...(leg.exchange === 'okx' ? { contractSize: leg.rule.contractSize, instrumentId: leg.rule.instrumentId } : {}) };
    const order = { localId, jobId: job.id, legId: leg.id, exchange: leg.exchange, accountRevision: leg.accountRevision, phase: job.phase, batch: job.batchIndex,
      kind: leg.exchange === 'bybit' ? 'strategy' : 'order', remoteId: null, spec, state: 'submitting', unknown: true, settled: false, filledQuantity: '0', price: null, lastCheckedAt: null, createdAt: iso(now()), cancelRequestedAt: null };
    // Persist intent before the network call. On restart an unanswered intent is uncertain.
    saveOrder(order);
    try {
      const beforeMutation = () => {
        requireLease();
        const current = jobFor(job.id);
        if (closing || !['queued', 'running'].includes(current.status) || current.phase !== job.phase || current.batchIndex !== job.batchIndex || now() >= Date.parse(current.deadlineAt)) throw new NotSubmittedError('任务已停止或执行时间已到，本次建单未发送');
        try { normalizeMarket(market, leg.symbol, now()); } catch { throw new NotSubmittedError('盘口已过期，本次建单未发送'); }
      };
      const result = await call(signal => ctx.client.create(ctx.credentials, spec, { ...ctx.options, signal, beforeMutation }));
      requireLease();
      if (!result || typeof result.id !== 'string' || !result.id || result.kind !== order.kind) throw new Error('Uncertain acknowledgement');
      Object.assign(order, { remoteId: result.id, unknown: false, state: 'working' }); saveOrder(order);
    } catch (error) {
      // A stale process must not overwrite reconciliation performed by a new owner.
      requireLease();
      if (error instanceof NotSubmittedError || error instanceof ExecutionExchangeError && !error.uncertain) Object.assign(order, { state: 'rejected', settled: true, unknown: false });
      else Object.assign(order, { state: 'unknown', unknown: true });
      saveOrder(order); pause(job.id, `${leg.exchange} ${leg.symbol} 下单结果：${safeError(error)}`);
    }
  }
  async function stopping(job) {
    await Promise.allSettled(orders(job.id).filter(unsettled).map(cancelOrder));
    requireLease();
    const latest = jobFor(job.id), all = orders(job.id);
    if (all.every(order => order.settled)) {
      latest.status = latest.stopTarget === 'stopped' ? 'stopped' : 'paused';
      event(latest, latest.status === 'stopped' ? '所有已知委托已结束；任务停止，已成交仓位保留' : '余单已核对结束；保留已成交仓位，继续需重新预览剩余数量');
      transaction(() => { saveJob(latest); if (latest.status === 'stopped') db.prepare('DELETE FROM execution_locks WHERE job_id=?').run(job.id); });
    } else {
      latest.status = 'attention'; latest.reason = '仍有委托结果未确认；已停止后续下单，请核对策略编号或重试撤单'; saveJob(latest);
    }
  }
  async function runJob(id) {
    if (busyJobs.has(id)) return; busyJobs.add(id);
    try {
      requireLease(); let job = jobFor(id);
      if (job.status === 'stopping') { await stopping(job); return; }
      if (!['queued', 'running'].includes(job.status)) return;
      if (now() >= Date.parse(job.deadlineAt)) { pause(id, '执行时间已到，停止追价并撤销余单'); await stopping(jobFor(id)); return; }
      const allBefore = orders(id), working = allBefore.filter(unsettled);
      if (working.length) {
        const readings = await Promise.allSettled(working.map(order => inspectOrder(order)));
        if (readings.some(result => result.status === 'rejected' || result.value === false)) { pause(id, '委托状态读取失败或提交结果不明，暂停并撤销余单'); await stopping(jobFor(id)); return; }
        job = jobFor(id);
        if (job.status === 'stopping') { await stopping(job); return; }
        for (const original of working) {
          const order = orderFor(original.localId), leg = job.plan.legs.find(item => item.id === order.legId);
          if (order.settled) {
            if (compareDecimals(order.filledQuantity, order.spec.quantity) < 0 && !order.cancelRequestedAt) throw new ExecutionError(409, '委托提前终止且未全部成交，暂停其余交易腿');
            continue;
          }
          if (order.state === 'paused' || order.state === 'terminal') throw new ExecutionError(409, '交易所策略暂停或子单尚未结束，暂停其余交易腿');
          const market = normalizeMarket(await call(signal => clients.get(leg.exchange).market(leg.symbol, { signal })), leg.symbol, now());
          checkContract(leg, market);
          if (stopReached(leg, market)) throw new ExecutionError(409, `${leg.exchange} ${leg.symbol} 已达到追价停止价`);
          if (['binance', 'okx'].includes(leg.exchange) && now() - Date.parse(order.lastAmendAt ?? order.createdAt) >= job.plan.repriceIntervalMs
              && (order.price === null || compareDecimals(order.price, leg.orderSide === 'buy' ? market.bid : market.ask) !== 0)) {
            await amendOrder(job, leg, order, market);
            if (jobFor(id).status === 'stopping') break;
          }
        }
      }
      job = jobFor(id);
      if (job.status === 'stopping') { await stopping(job); return; }
      if (!['queued', 'running'].includes(job.status)) return;
      const all = orders(id);
      const remaining = job.plan.legs.map(leg => ({ leg, quantity: subtract(leg.batchQuantities[job.batchIndex], totalFilled(all, leg.id, job.phase, job.batchIndex)) }));
      if (remaining.some(item => compareDecimals(item.quantity, '0') < 0)) throw new ExecutionError(409, '本批成交量超出计划，请核对仓位');
      if (remaining.every(item => item.quantity === '0') && all.every(order => order.settled)) {
        job.batchIndex += 1;
        event(job, `第 ${job.batchIndex} / ${job.plan.batchCount} 批全部成交且委托已结束`);
        if (job.batchIndex >= job.plan.batchCount) { job.status = 'completed'; job.reason = null; transaction(() => { saveJob(job); db.prepare('DELETE FROM execution_locks WHERE job_id=?').run(id); }); return; }
        job.nextBatchAt = now() + job.plan.batchIntervalMs; saveJob(job); return;
      }
      if (now() < job.nextBatchAt) return;
      const candidates = remaining.filter(item => compareDecimals(item.quantity, '0') > 0 && !all.some(order => order.legId === item.leg.id && !order.settled));
      if (!candidates.length) return;
      const { snapshots, markets } = await collect(candidates.map(item => item.leg));
      for (const { leg, quantity } of candidates) {
        const market = normalizeMarket(markets.get(`${leg.exchange}:${leg.symbol}`), leg.symbol, now());
        checkContract(leg, market);
        checkPosition(snapshots.get(leg.exchange), leg, job.plan.action, quantity);
        // Candidates have no unsettled order on this symbol. Any remaining venue
        // order (including eventually consistent own orders) blocks a new submit.
        ensureNoExternalOrders(snapshots.get(leg.exchange), leg.symbol);
        checkChildQuantity(quantity, market, job.plan.action);
        if (stopReached(leg, market)) throw new ExecutionError(409, '最新盘口已达到追价停止价');
      }
      writable(); job = jobFor(id);
      if (!['queued', 'running'].includes(job.status)) return;
      if (now() >= Date.parse(job.deadlineAt)) throw new ExecutionError(409, '执行时间已到，停止追价');
      job.status = 'running'; saveJob(job);
      // Every candidate is checked before any leg in this group is sent.
      await Promise.all(candidates.map(({ leg, quantity }) => submit(job, leg, quantity, markets.get(`${leg.exchange}:${leg.symbol}`))));
      if (jobFor(id).status === 'stopping') await stopping(jobFor(id));
    } catch (error) {
      try { requireLease(); pause(id, safeError(error)); await stopping(jobFor(id)); } catch { /* A new lease owner will reconcile durable intents. */ }
    } finally { busyJobs.delete(id); }
  }
  function tick() {
    if (closed || closing) return Promise.resolve();
    if (ticking) return ticking;
    if (!acquire()) return Promise.resolve();
    ticking = Promise.allSettled(jobs().filter(job => ACTIVE.has(job.status)).map(job => runJob(job.id))).finally(() => { ticking = null; });
    return ticking;
  }
  function stop(id, body, session) {
    exactKeys(body, []); writable(); checkSession(session);
    const job = jobFor(id);
    if (!FINAL.has(job.status)) pause(id, '用户停止：停止后续下单并撤销余单，保留已成交仓位', 'stopped');
    return state();
  }
  async function reconcile(id, body, session) {
    exactKeys(body, ['legId', 'strategyId', 'acknowledge']); writable(); checkSession(session);
    const job = jobFor(id);
    if (!['attention', 'paused'].includes(job.status) || busyJobs.has(id)) throw new ExecutionError(409, '任务正在执行或核对中');
    const order = orders(id).filter(item => item.legId === body.legId && !item.settled).at(-1);
    if (!order) throw new ExecutionError(409, '该交易腿没有待核对委托');
    if (order.exchange === 'bybit' && !order.remoteId && (body.acknowledge !== true || typeof body.strategyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.strategyId))) throw new ExecutionError(400, '请核对并填写交易所显示的原生追价策略编号');
    if (order.exchange !== 'bybit' && body.strategyId !== undefined) throw new ExecutionError(400, '此交易所按本任务客户订单号核对');
    busyJobs.add(id);
    try {
      await inspectOrder(order, order.exchange === 'bybit' && !order.remoteId ? body.strategyId : undefined);
      pause(id, '正在核对并撤销确认的剩余委托', job.stopTarget || 'paused');
      await stopping(jobFor(id)); return state();
    } catch (error) { throw new ExecutionError(409, safeError(error)); } finally { busyJobs.delete(id); }
  }
  acquire();
  const heartbeat = intervalMs > 0 ? setInterval(() => { if (!closing) { try { acquire(); void tick(); } catch { /* Retry on the next pulse. */ } } }, intervalMs) : null;
  heartbeat?.unref();
  return { state, connect, disconnect, preview, start, stop, reconcile, tick,
    async close() {
      if (closed || closing) return; closing = true; clearInterval(heartbeat);
      let ownsLease = false;
      try { requireLease(); ownsLease = true; } catch { /* The current owner handles recovery. */ }
      if (ownsLease) for (const job of jobs()) if (ACTIVE.has(job.status)) pause(job.id, '服务关闭：暂停后续交易并撤销余单');
      const timeout = setTimeout(() => { for (const controller of controllers) controller.abort(); }, 8000); timeout.unref?.();
      try {
        await Promise.allSettled([...(ticking ? [ticking] : []), ...pending]);
        if (ownsLease) await Promise.allSettled(jobs().filter(job => job.status === 'stopping').map(job => runJob(job.id)));
      } finally { clearTimeout(timeout); closed = true; db.prepare('DELETE FROM execution_lease WHERE id=1 AND owner=?').run(owner); }
    } };
}
