// Phase 1 executor for the Binance + Bybit oil two-leg slice. It owns its own
// database and only accepts simulated connectors, so it cannot take execution
// rights over a real account (plan 1, 5.3, 8).
import { createHash, randomUUID } from 'node:crypto';
import { add, cmp, floorToStep, isMultiple, isZero, mul, sub, units, fromUnits } from './decimal.ts';
import {
  ContractError, UUID, VENUE_NAMES, VENUE_READ_SYMBOLS, accountKey, checkQuoteFresh, orderSideOf, parseAccountSnapshot, parseBinding, parseConfirm, parseInstrument, parseIntent, parseQuote, positionOf, reject,
  type AccountBinding, type AccountSnapshot, type Action, type Environment, type Instrument, type Intent, type OrderSide, type OrderType, type PositionSide, type Quote, type Venue,
} from './contracts.ts';
import { VenueError, parseOrderReport, type OrderReport, type OrderRequest, type VenueConnector } from './connector.ts';
import type { Store } from './store.ts';

/** Start values come from the legacy constants registered in plan 6.4; none of them is a met performance target. */
export interface Budgets {
  previewTtlMs: number;
  previewQuoteMaxAgeMs: number;
  sendQuoteMaxAgeMs: number;
  futureToleranceMs: number;
  callTimeoutMs: number;
  createObserveMs: number;
  createArrivalMarginMs: number;
  absentChecks: number;
  absentSpacingMs: number;
  cancelAttempts: number;
  cancelRetryMs: number;
  leaseTtlMs: number;
  /** How long an unresolvable unknown order, or a failing hedge account read, may last before a person takes over. */
  unresolvedGraceMs: number;
}
export const DEFAULT_BUDGETS: Readonly<Budgets> = Object.freeze({
  previewTtlMs: 30_000, previewQuoteMaxAgeMs: 10_000, sendQuoteMaxAgeMs: 10_000, futureToleranceMs: 1_000, callTimeoutMs: 35_000,
  createObserveMs: 120_000, createArrivalMarginMs: 60_000, absentChecks: 2, absentSpacingMs: 5_000, cancelAttempts: 5, cancelRetryMs: 10_000, leaseTtlMs: 60_000,
  unresolvedGraceMs: 60_000,
});

export class WriterLostError extends ContractError { constructor(message: string) { super(503, 'writer_lost', message); } }

export type JobStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'stopped' | 'attention';
const FINAL_JOB = new Set<JobStatus>(['completed', 'failed', 'stopped', 'attention']);
/**
 * prepared: persisted, transport not called. sending: transport may have been called.
 * open: the venue confirmed a resting order. unknown: sent without a usable answer.
 * filled / canceled / rejected / not-sent / not-created are settled facts.
 */
export type OpState = 'prepared' | 'sending' | 'open' | 'unknown' | 'filled' | 'canceled' | 'rejected' | 'not-sent' | 'not-created';
const SETTLED = new Set<OpState>(['filled', 'canceled', 'rejected', 'not-sent', 'not-created']);

export interface PlannedLeg {
  index: 0 | 1;
  venue: Venue;
  symbol: string;
  side: PositionSide;
  orderSide: OrderSide;
  quantity: string;
  orderType: OrderType;
  limitPrice: string | null;
  reduceOnly: boolean;
  accountKey: string;
  accountId: string;
  credentialVersion: number;
  accountMode: string;
  positionMode: 'one-way' | 'hedge';
  baseline: string;
  instrument: Instrument;
  quote: Pick<Quote, 'bid' | 'ask' | 'receivedAt' | 'connectionGeneration' | 'sequence'>;
}
export interface Preview {
  id: string;
  expiresAt: number;
  writerGeneration: number;
  intent: Intent;
  legs: [PlannedLeg, PlannedLeg];
  notes: string[];
}
export interface Job {
  id: string;
  status: JobStatus;
  reason: string | null;
  createdAt: number;
  deadlineAt: number;
  previewId: string;
  requestId: string;
  action: Action;
  legs: [PlannedLeg, PlannedLeg];
  /** Set by takeover recovery: reconcile what was sent, never send anything new for this job. */
  holdNewSends: boolean;
  /** attention keeps its symbol locks until a person acknowledges the remaining exposure. */
  acknowledgedAt: number | null;
  /** First failed hedge-side account read; bounded by unresolvedGraceMs. Absent in rows written before it existed. */
  hedgeWaitSince?: number | null;
}
export interface Operation {
  id: string;
  jobId: string;
  leg: 0 | 1;
  venue: Venue;
  clientOrderId: string;
  request: OrderRequest;
  state: OpState;
  remoteId: string | null;
  filledQuantity: string;
  averagePrice: string | null;
  venueStatus: OrderReport['status'] | null;
  preparedAt: number;
  sentAt: number | null;
  lastCheckedAt: number | null;
  absentChecks: number;
  absentAt: number | null;
  positionMismatchAt: number | null;
  cancelSent: number;
  cancelRequestedAt: number | null;
  note: string | null;
}

export interface ExecutorOptions {
  store: Store;
  connectors: readonly VenueConnector[];
  environment?: Environment;
  now?: () => number;
  budgets?: Partial<Budgets>;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exposure = (quantity: string, instrument: Instrument): string => mul(quantity, instrument.contractSize);
const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
/** `pa1-` + 24 hex + `-` + leg index. */
const CLIENT_ORDER_ID_LENGTH = 30;

export function createExecutor({ store, connectors, environment = 'simulated', now = Date.now, budgets: overrides = {} }: ExecutorOptions) {
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...overrides };
  const venues = new Map<Venue, VenueConnector>();
  for (const connector of connectors) {
    // The prototype must not be able to reach a real venue by configuration mistake.
    if (connector.capabilities.transport !== 'simulated' || environment !== 'simulated') throw new ContractError(500, 'live_transport_refused', '阶段 1 原型只接受模拟传输');
    if (venues.has(connector.venue)) throw new ContractError(500, 'duplicate_connector', `重复的 ${connector.venue} 连接器`);
    venues.set(connector.venue, connector);
  }
  const db = store.db;
  const owner = randomUUID();
  let generation = 0, held = false, retired = false, closed = false, heldSince = 0;
  let ticking: Promise<void> | null = null;
  /** Operations whose send is running in this process; any other prepared or sending row was interrupted. */
  const inFlight = new Set<string>();

  const connectorFor = (venue: Venue): VenueConnector => venues.get(venue) ?? reject('venue_unavailable', `${VENUE_NAMES[venue]} 连接器不可用`, 503);
  const event = (jobId: string | null, type: string, detail: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO events(job_id, type, at, json) VALUES (?, ?, ?, ?)').run(jobId, type, now(), JSON.stringify(detail));

  // ---- writer lease and fence --------------------------------------------------
  function assertWriter(): void {
    if (retired) throw new WriterLostError('执行器已失去写入权，请重启后核对');
    const row = db.prepare('SELECT owner, generation, expires_at FROM writer WHERE id = 1').get() as { owner: string; generation: number; expires_at: number } | undefined;
    if (!held || !row || row.owner !== owner || row.generation !== generation || row.expires_at <= now()) {
      if (held) retired = true;
      throw new WriterLostError(held ? '执行器写入租约已失效或被接管，本实例停止写入' : '执行器尚未取得写入租约');
    }
  }
  const write = <T>(operation: () => T): T => store.tx(() => { assertWriter(); return operation(); });

  /** Takes or renews the single-writer lease. A lapsed lease is never revived by the same instance. */
  function acquire(): boolean {
    if (closed || retired) return false;
    return store.tx(() => {
      const row = db.prepare('SELECT owner, generation, expires_at FROM writer WHERE id = 1').get() as { owner: string; generation: number; expires_at: number } | undefined;
      if (held) {
        if (!row || row.owner !== owner || row.generation !== generation || row.expires_at <= now()) { retired = true; return false; }
        db.prepare('UPDATE writer SET expires_at = ? WHERE id = 1').run(now() + budgets.leaseTtlMs);
        return true;
      }
      if (row && row.expires_at > now()) return false;
      generation = (row?.generation ?? 0) + 1;
      db.prepare('INSERT INTO writer(id, owner, generation, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, expires_at = excluded.expires_at')
        .run(owner, generation, now() + budgets.leaseTtlMs);
      held = true; heldSince = now();
      recoverAfterTakeover();
      return true;
    });
  }

  /**
   * A new writer cannot know what the previous one did after its last commit.
   * prepared never reached transport; sending may have; jobs keep reconciling
   * but never send anything new (plan 8 step 5).
   */
  function recoverAfterTakeover(): void {
    for (const op of unsettledOps()) {
      if (op.state === 'prepared') { Object.assign(op, { state: 'not-sent', note: '恢复：落盘后、发送前中断，传输未调用' }); saveOp(op); event(op.jobId, 'operation-recovered', { op: op.id, state: op.state }); }
      else if (op.state === 'sending') { Object.assign(op, { state: 'unknown', note: '恢复：发送中断，结果未知，按原客户订单号核对' }); saveOp(op); event(op.jobId, 'operation-recovered', { op: op.id, state: op.state }); }
    }
    for (const job of unfinishedJobs()) {
      if (job.status === 'accepted' && !opsOf(job.id).length) finish(job, 'failed', '服务重启时任务尚未发送，已取消；请重新预览');
      else if (!job.holdNewSends) { job.holdNewSends = true; job.reason = '服务恢复：核对已发送委托，不再发送新委托'; saveJob(job); event(job.id, 'job-held', {}); }
    }
  }

  // ---- persistence -------------------------------------------------------------
  const readJob = (id: string): Job => {
    const row = db.prepare('SELECT json FROM jobs WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Job : reject('job_missing', '执行任务不存在', 404);
  };
  const unfinishedJobs = (): Job[] => (db.prepare('SELECT json FROM jobs WHERE final = 0 ORDER BY created_at, rowid').all() as { json: string }[]).map(row => JSON.parse(row.json) as Job);
  const opsOf = (jobId: string): Operation[] => (db.prepare('SELECT json FROM operations WHERE job_id = ? ORDER BY leg').all(jobId) as { json: string }[]).map(row => JSON.parse(row.json) as Operation);
  const unsettledOps = (): Operation[] => (db.prepare('SELECT json FROM operations WHERE settled = 0 ORDER BY rowid').all() as { json: string }[]).map(row => JSON.parse(row.json) as Operation);
  const readOp = (id: string): Operation => JSON.parse((db.prepare('SELECT json FROM operations WHERE id = ?').get(id) as { json: string }).json) as Operation;
  function saveJob(job: Job): void {
    db.prepare('UPDATE jobs SET status = ?, final = ?, version = version + 1, updated_at = ?, json = ? WHERE id = ?').run(job.status, FINAL_JOB.has(job.status) ? 1 : 0, now(), JSON.stringify(job), job.id);
  }
  function saveOp(op: Operation): void {
    db.prepare('UPDATE operations SET state = ?, settled = ?, version = version + 1, json = ? WHERE id = ?').run(op.state, SETTLED.has(op.state) ? 1 : 0, JSON.stringify(op), op.id);
  }
  const stopRequested = (jobId: string): boolean => !!db.prepare('SELECT 1 FROM stop_requests WHERE job_id = ?').get(jobId);
  function finish(job: Job, status: JobStatus, reason: string | null): void {
    job.status = status; job.reason = reason; saveJob(job);
    // An unhedged or unverified exposure must not let a new job trade the same symbol on that account.
    if (status !== 'attention') db.prepare('DELETE FROM locks WHERE job_id = ?').run(job.id);
    event(job.id, 'job-finished', { status, reason });
  }

  // ---- accounts ----------------------------------------------------------------
  interface AccountRow { account_key: string; venue: Venue; environment: Environment; account_id: string; account_mode: string; credential_version: number }
  const accountFor = (venue: Venue): AccountRow | undefined => db.prepare('SELECT * FROM accounts WHERE venue = ? AND environment = ?').get(venue, environment) as AccountRow | undefined;
  const bindingOf = (row: AccountRow): AccountBinding => ({ venue: row.venue, environment: row.environment, accountId: row.account_id, accountMode: row.account_mode, credentialVersion: row.credential_version });
  const lockedBy = (key: string): boolean => !!db.prepare('SELECT 1 FROM locks WHERE substr(resource, 1, ?) = ? LIMIT 1').get(key.length + 1, `${key}:`);

  /** Binds a verified principal. Rotation keeps the account key; changing principal needs no unfinished job on the old one. */
  function registerAccount(input: unknown): { accountKey: string; credentialVersion: number } {
    const binding = parseBinding(input);
    if (binding.environment !== environment) reject('environment', '账户环境与执行器环境不一致', 409);
    return write(() => {
      const current = accountFor(binding.venue), key = accountKey(binding);
      if (current && current.account_id === binding.accountId) {
        if (binding.credentialVersion < current.credential_version) reject('credential_version', '凭据版本不能回退', 409);
        if (binding.credentialVersion === current.credential_version && binding.accountMode === current.account_mode) return { accountKey: key, credentialVersion: binding.credentialVersion };
      }
      if (current && lockedBy(current.account_key)) reject('account_busy', '该账户有未结束任务，先完成核对再更换连接', 409);
      if (current && current.account_key !== key) db.prepare('DELETE FROM accounts WHERE account_key = ?').run(current.account_key);
      db.prepare(`INSERT INTO accounts(account_key, venue, environment, account_id, account_mode, credential_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET account_mode = excluded.account_mode, credential_version = excluded.credential_version, updated_at = excluded.updated_at`)
        .run(key, binding.venue, binding.environment, binding.accountId, binding.accountMode, binding.credentialVersion, now());
      event(null, 'account-bound', { accountKey: key, credentialVersion: binding.credentialVersion });
      return { accountKey: key, credentialVersion: binding.credentialVersion };
    });
  }

  // ---- venue calls -------------------------------------------------------------
  async function callVenue<T>(kind: 'read' | 'write', operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, fail) => {
      timer = setTimeout(() => { controller.abort(); fail(new VenueError(kind === 'write' ? 'uncertain' : 'read-failed', `交易所调用超过 ${budgets.callTimeoutMs} 毫秒`)); }, budgets.callTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    finally { clearTimeout(timer); }
  }
  const readFailure = (error: unknown): never => {
    if (error instanceof ContractError) throw error;
    throw new ContractError(502, 'venue_read_failed', `交易所读取失败：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`);
  };
  async function readQuote(venue: Venue, symbol: string): Promise<Quote> {
    try { return parseQuote(await callVenue('read', signal => connectorFor(venue).quote(symbol, { signal })), venue, symbol); } catch (error) { return readFailure(error); }
  }
  async function readAccount(binding: AccountBinding, symbol: string): Promise<AccountSnapshot> {
    let snapshot: AccountSnapshot;
    try { snapshot = parseAccountSnapshot(await callVenue('read', signal => connectorFor(binding.venue).account(binding, [symbol], { signal })), binding.venue); } catch (error) { return readFailure(error); }
    if (snapshot.accountId !== binding.accountId) reject('account_identity', `${VENUE_NAMES[binding.venue]} 账户真实身份与绑定不一致`, 409);
    return snapshot;
  }
  async function readInstrument(venue: Venue, symbol: string): Promise<Instrument> {
    try { return parseInstrument(await callVenue('read', signal => connectorFor(venue).instrument(symbol, { signal })), venue, symbol); } catch (error) { return readFailure(error); }
  }

  // ---- preview -----------------------------------------------------------------
  function checkLegAccount(leg: Pick<PlannedLeg, 'venue' | 'symbol' | 'side' | 'quantity'>, snapshot: AccountSnapshot, action: Action, foreignAllowed: readonly string[] = []): { baseline: string; positionMode: 'one-way' | 'hedge' } {
    const name = `${VENUE_NAMES[leg.venue]} ${leg.symbol}`;
    const positionMode = snapshot.positionModes[leg.symbol] ?? reject('position_mode', `${name} 持仓模式无法确认，禁止下单`, 409);
    const baseline = positionOf(snapshot, leg.symbol, leg.side);
    if (action === 'close' && cmp(leg.quantity, baseline) > 0) reject('close_exceeds_position', `${name} 可平数量不足（持仓 ${baseline}）`, 409);
    const opposite = positionOf(snapshot, leg.symbol, leg.side === 'long' ? 'short' : 'long');
    if (action === 'open' && positionMode === 'one-way' && cmp(opposite, '0') > 0) reject('implicit_reduce', `${name} 单向模式已有反向仓位，开仓会变成隐式减仓`, 409);
    if (snapshot.openOrders.some(order => order.symbol === leg.symbol && !foreignAllowed.includes(order.clientOrderId ?? ''))) reject('external_orders', `${name} 存在本任务之外的活动委托`, 409);
    return { baseline, positionMode };
  }
  function checkQuantity(leg: Pick<PlannedLeg, 'venue' | 'symbol' | 'quantity' | 'orderType' | 'limitPrice'>, instrument: Instrument, quote: Quote, action: Action): void {
    const name = `${VENUE_NAMES[leg.venue]} ${leg.symbol}`;
    const maximum = leg.orderType === 'market' ? (cmp(instrument.maxMarketQuantity, instrument.maxQuantity) < 0 ? instrument.maxMarketQuantity : instrument.maxQuantity) : instrument.maxQuantity;
    if (!isMultiple(leg.quantity, instrument.quantityStep)) reject('quantity_step', `${name} 数量须为 ${instrument.quantityStep} 的整数倍`);
    if (cmp(leg.quantity, instrument.minQuantity) < 0 || cmp(leg.quantity, maximum) > 0) reject('quantity_range', `${name} 数量须在 ${instrument.minQuantity} 至 ${maximum} 之间`);
    if (leg.limitPrice !== null && !isMultiple(leg.limitPrice, instrument.tickSize)) reject('price_step', `${name} 限价须为 ${instrument.tickSize} 的整数倍`);
    if (action === 'open' && cmp(mul(mul(leg.quantity, quote.bid), instrument.contractSize), instrument.minNotional) < 0) reject('min_notional', `${name} 名义金额低于 ${instrument.minNotional} USDT`);
  }

  async function preview(input: unknown, session: string): Promise<Preview> {
    if (typeof session !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(session)) reject('session', '会话无效', 401);
    const intent = parseIntent(input);
    assertWriter();
    const accounts = intent.legs.map(leg => accountFor(leg.venue) ?? reject('account_missing', `${VENUE_NAMES[leg.venue]} 尚未绑定已核验的账户`, 409));
    for (const leg of intent.legs) if (connectorFor(leg.venue).capabilities.maxClientOrderIdLength < CLIENT_ORDER_ID_LENGTH) reject('client_order_id', `${VENUE_NAMES[leg.venue]} 客户订单号长度上限不足`, 409);
    for (const row of accounts) if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(`${row.account_key}:${intent.symbol}`)) reject('symbol_locked', '所选合约已有未结束任务', 409);
    const reads = await Promise.all(intent.legs.map(async (leg, index) => {
      const binding = bindingOf(accounts[index]);
      const [instrument, quote, snapshot] = await Promise.all([readInstrument(leg.venue, intent.symbol), readQuote(leg.venue, intent.symbol), readAccount(binding, intent.symbol)]);
      return { binding, instrument, quote, snapshot };
    }));
    const at = now();
    const legs = intent.legs.map((leg, index) => {
      const { binding, instrument, quote, snapshot } = reads[index];
      checkQuoteFresh(quote, at, budgets.previewQuoteMaxAgeMs, budgets.futureToleranceMs);
      const planned = { venue: leg.venue, symbol: intent.symbol, side: leg.side, quantity: leg.quantity, orderType: leg.orderType, limitPrice: leg.limitPrice };
      checkQuantity(planned, instrument, quote, intent.action);
      const { baseline, positionMode } = checkLegAccount(planned, snapshot, intent.action);
      const result: PlannedLeg = {
        ...planned, index: index as 0 | 1, orderSide: orderSideOf(intent.action, leg.side), reduceOnly: intent.action === 'close',
        accountKey: accountKey(binding), accountId: binding.accountId, credentialVersion: binding.credentialVersion, accountMode: binding.accountMode, positionMode, baseline, instrument,
        quote: { bid: quote.bid, ask: quote.ask, receivedAt: quote.receivedAt, connectionGeneration: quote.connectionGeneration, sequence: quote.sequence },
      };
      return result;
    }) as [PlannedLeg, PlannedLeg];
    // Settlement completes only on equal barrels, so the plan must already be equal; a tolerance here would end every such job in attention.
    const [a, b] = legs.map(leg => units(exposure(leg.quantity, leg.instrument)));
    if (a !== b) reject('unbalanced', `两腿桶数不相等：${fromUnits(a)} 与 ${fromUnits(b)}`);
    const value: Preview = {
      id: randomUUID(), expiresAt: at + budgets.previewTtlMs, writerGeneration: generation, intent, legs,
      notes: [`先发送 ${VENUE_NAMES[legs[0].venue]} 腿，成交确认后按其成交量发送 ${VENUE_NAMES[legs[1].venue]} 对冲腿。`, '模拟传输：不会访问任何真实交易所。'],
    };
    write(() => {
      db.prepare('DELETE FROM previews WHERE expires_at < ? AND consumed_job IS NULL').run(now());
      db.prepare('INSERT INTO previews(id, session, expires_at, json) VALUES (?, ?, ?, ?)').run(value.id, session, value.expiresAt, JSON.stringify(value));
    });
    return value;
  }

  // ---- confirm -----------------------------------------------------------------
  function confirm(input: unknown, session: string): { accepted: true; duplicate: boolean; job: ReturnType<typeof jobView> } {
    const body = parseConfirm(input);
    const payload = digest({ kind: 'confirm', previewId: body.previewId, confirmLive: body.confirmLive });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(body.requestId) as { kind: string; digest: string; session: string; job_id: string } | undefined;
      if (existing) {
        if (existing.kind !== 'confirm' || existing.digest !== payload || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
        return { accepted: true as const, duplicate: true, job: jobView(existing.job_id) };
      }
      const record = db.prepare('SELECT * FROM previews WHERE id = ?').get(body.previewId) as { session: string; expires_at: number; consumed_job: string | null; json: string } | undefined;
      if (!record || record.session !== session || record.expires_at <= now() || record.consumed_job) reject('preview_invalid', '预览已过期、已提交或不属于本会话，请重新预览', 409);
      const plan = JSON.parse((record as { json: string }).json) as Preview;
      if (plan.writerGeneration !== generation) reject('preview_generation', '执行器已重启或换代，请重新预览', 409);
      for (const leg of plan.legs) {
        const row = accountFor(leg.venue);
        if (!row || row.account_key !== leg.accountKey || row.credential_version !== leg.credentialVersion || row.account_mode !== leg.accountMode) reject('binding_changed', `${VENUE_NAMES[leg.venue]} 账户绑定已变化，请重新预览`, 409);
        if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(`${leg.accountKey}:${leg.symbol}`)) reject('symbol_locked', '所选合约已有未结束任务', 409);
      }
      const job: Job = { id: randomUUID(), status: 'accepted', reason: null, createdAt: now(), deadlineAt: now() + plan.intent.timeoutMs, previewId: plan.id, requestId: body.requestId, action: plan.intent.action, legs: plan.legs, holdNewSends: false, acknowledgedAt: null, hedgeWaitSince: null };
      db.prepare('INSERT INTO jobs(id, status, final, version, created_at, updated_at, json) VALUES (?, ?, 0, 1, ?, ?, ?)').run(job.id, job.status, job.createdAt, job.createdAt, JSON.stringify(job));
      for (const leg of plan.legs) db.prepare('INSERT INTO locks(resource, job_id) VALUES (?, ?)').run(`${leg.accountKey}:${leg.symbol}`, job.id);
      db.prepare('UPDATE previews SET consumed_job = ? WHERE id = ?').run(job.id, plan.id);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(body.requestId, 'confirm', payload, session, job.id, now());
      event(job.id, 'job-accepted', { previewId: plan.id, requestId: body.requestId });
      return { accepted: true as const, duplicate: false, job: jobView(job.id) };
    });
  }

  /** Durable, idempotent stop. It stops new sends; orders already sent keep being reconciled. */
  function requestStop(jobId: string, requestId: string, session: string): ReturnType<typeof jobView> {
    if (!UUID.test(requestId)) reject('request_id', '请求编号无效');
    const payload = digest({ kind: 'stop', jobId });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
      if (existing && (existing.digest !== payload || existing.session !== session)) reject('request_reused', '请求编号已用于其他内容', 409);
      const job = readJob(jobId);
      if (!existing) {
        db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'stop', payload, session, jobId, now());
        if (!FINAL_JOB.has(job.status)) { db.prepare('INSERT OR IGNORE INTO stop_requests(job_id, request_id, requested_at) VALUES (?, ?, ?)').run(jobId, requestId, now()); event(jobId, 'stop-requested', { requestId }); }
      }
      return jobView(jobId);
    });
  }

  /** A person has handled an attention job's exposure outside the executor; only then are its symbols free again. */
  function acknowledge(jobId: string, requestId: string, session: string): ReturnType<typeof jobView> {
    if (!UUID.test(requestId)) reject('request_id', '请求编号无效');
    const payload = digest({ kind: 'acknowledge', jobId });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
      if (existing) {
        if (existing.digest !== payload || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
        return jobView(jobId);
      }
      const job = readJob(jobId);
      if (job.status !== 'attention') reject('not_attention', '只有待人工处理的任务需要确认', 409);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'acknowledge', payload, session, jobId, now());
      job.acknowledgedAt = now(); saveJob(job);
      db.prepare('DELETE FROM locks WHERE job_id = ?').run(jobId);
      event(jobId, 'attention-acknowledged', { requestId });
      return jobView(jobId);
    });
  }

  /** Read-only market and position view. ANT is observable on Binance only and never executable here. */
  async function observe(venue: Venue, symbol: string): Promise<{ instrument: Instrument; quote: Quote; ageMs: number; position: { long: string; short: string } | null }> {
    if (!VENUE_READ_SYMBOLS[venue]?.includes(symbol)) reject('venue_symbol', `${VENUE_NAMES[venue] ?? venue} 不提供 ${symbol} 数据`, 400);
    const row = accountFor(venue);
    const [instrument, quote, snapshot] = await Promise.all([readInstrument(venue, symbol), readQuote(venue, symbol), row ? readAccount(bindingOf(row), symbol) : Promise.resolve(null)]);
    return { instrument, quote, ageMs: now() - quote.receivedAt, position: snapshot ? { long: positionOf(snapshot, symbol, 'long'), short: positionOf(snapshot, symbol, 'short') } : null };
  }

  // ---- sending -----------------------------------------------------------------
  const clientOrderIdFor = (job: Job, leg: 0 | 1): string => `pa1-${job.id.replace(/-/g, '').slice(0, 24)}-${leg}`;
  /** Page and API view of a preview: account principals are masked like everywhere else. */
  const publicPreview = (value: Preview) => ({
    ...value,
    legs: value.legs.map(({ accountKey: _key, accountId, ...leg }) => ({ ...leg, accountId: maskId(accountId) })),
  });
  function bindingStillValid(leg: PlannedLeg): AccountBinding {
    const row = accountFor(leg.venue);
    if (!row || row.account_key !== leg.accountKey || row.credential_version !== leg.credentialVersion || row.account_mode !== leg.accountMode) reject('binding_changed', `${VENUE_NAMES[leg.venue]} 账户绑定已变化，本任务不再发送`, 409);
    return bindingOf(row as AccountRow);
  }

  /** Final send guard of an exposure-opening lead leg: both books fresh, both accounts unchanged since preview. */
  async function guardLead(job: Job): Promise<void> {
    if (now() >= job.deadlineAt) reject('deadline', '任务已超过最长执行时间，未发送', 409);
    const checks = await Promise.all(job.legs.map(async leg => {
      const binding = bindingStillValid(leg);
      const [quote, snapshot] = await Promise.all([readQuote(leg.venue, leg.symbol), readAccount(binding, leg.symbol)]);
      return { leg, quote, snapshot };
    }));
    const at = now();
    for (const { leg, quote, snapshot } of checks) {
      checkQuoteFresh(quote, at, budgets.sendQuoteMaxAgeMs, budgets.futureToleranceMs);
      const { baseline, positionMode } = checkLegAccount(leg, snapshot, job.action);
      if (cmp(baseline, leg.baseline) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，请重新预览`, 409);
    }
  }
  /** The hedge reduces the lead's exposure: only the account basis that decides its quantity is required (L084). */
  async function guardHedge(job: Job): Promise<void> {
    const leg = job.legs[1], binding = bindingStillValid(leg), snapshot = await readAccount(binding, leg.symbol);
    const { baseline, positionMode } = checkLegAccount({ ...leg, quantity: '0' }, snapshot, job.action);
    if (cmp(baseline, leg.baseline) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，对冲腿未发送`, 409);
  }

  async function send(job: Job, index: 0 | 1, quantity: string): Promise<void> {
    const leg = job.legs[index];
    const request: OrderRequest = { clientOrderId: clientOrderIdFor(job, index), symbol: leg.symbol, side: leg.orderSide, positionSide: leg.side, quantity, type: leg.orderType, limitPrice: leg.limitPrice, reduceOnly: leg.reduceOnly };
    const op: Operation = { id: randomUUID(), jobId: job.id, leg: index, venue: leg.venue, clientOrderId: request.clientOrderId, request, state: 'prepared', remoteId: null, filledQuantity: '0', averagePrice: null, venueStatus: null,
      preparedAt: now(), sentAt: null, lastCheckedAt: null, absentChecks: 0, absentAt: null, positionMismatchAt: null, cancelSent: 0, cancelRequestedAt: null, note: null };
    inFlight.add(op.id);
    try { await sendPrepared(job, index, op, request); } finally { inFlight.delete(op.id); }
  }
  async function sendPrepared(job: Job, index: 0 | 1, op: Operation, request: OrderRequest): Promise<void> {
    const leg = job.legs[index], quantity = request.quantity;
    const binding = write(() => {
      const current = readJob(job.id);
      if (FINAL_JOB.has(current.status) || current.holdNewSends || stopRequested(job.id) || opsOf(job.id).some(item => item.leg === index)) reject('send_superseded', '任务状态已变化，本次不发送', 409);
      const valid = bindingStillValid(leg);
      db.prepare('INSERT INTO operations(id, job_id, leg, venue, client_order_id, state, settled, version, json) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)').run(op.id, job.id, index, leg.venue, op.clientOrderId, op.state, JSON.stringify(op));
      if (current.status === 'accepted') { current.status = 'running'; saveJob(current); }
      event(job.id, 'operation-prepared', { op: op.id, leg: index, quantity });
      return valid;
    });
    write(() => { Object.assign(op, { state: 'sending', sentAt: now() }); saveOp(op); });
    let report: OrderReport | null = null, failure: unknown = null;
    try { report = parseOrderReport(await callVenue('write', signal => connectorFor(leg.venue).place(binding, request, { signal, beforeSend: assertWriter })), request); }
    catch (error) { failure = error; }
    write(() => {
      const current = readOp(op.id);
      if (current.state !== 'sending') return;
      if (report) applyReport(current, report);
      else if (failure instanceof VenueError && failure.kind === 'not-sent') Object.assign(current, { state: 'not-sent', note: failure.message.slice(0, 200) });
      else if (failure instanceof VenueError && failure.kind === 'rejected') Object.assign(current, { state: 'rejected', note: failure.message.slice(0, 200) });
      // Any other outcome, including a report that fails validation, leaves the result unknown.
      else Object.assign(current, { state: 'unknown', note: `结果未知：${failure instanceof Error ? failure.message.slice(0, 160) : '无回报'}` });
      saveOp(current);
      event(job.id, 'operation-sent', { op: op.id, state: current.state, filled: current.filledQuantity });
    });
  }

  function applyReport(op: Operation, report: OrderReport): void {
    // Cumulative fills never go backwards; a lower count is a stale or foreign answer.
    if (cmp(report.filledQuantity, op.filledQuantity) < 0) reject('report_regressed', '委托回报的成交数量回退，保留原状态', 409);
    const state: OpState = report.status === 'filled' ? 'filled' : report.terminal ? (report.status === 'rejected' && isZero(report.filledQuantity) ? 'rejected' : 'canceled') : 'open';
    Object.assign(op, { state, remoteId: report.remoteId, filledQuantity: report.filledQuantity, averagePrice: report.averagePrice, venueStatus: report.status, lastCheckedAt: now(), absentChecks: 0, absentAt: null });
  }

  // ---- reconciliation ----------------------------------------------------------
  const createSettledAt = (op: Operation): number => (op.sentAt ?? op.preparedAt) + Math.max(budgets.createObserveMs, budgets.callTimeoutMs + budgets.createArrivalMarginMs, connectorFor(op.venue).capabilities.requestValidityMs + budgets.createArrivalMarginMs);

  /**
   * A prepared or sending row that this process is not sending was interrupted by a failed write.
   * prepared never reached transport (the sending mark commits first); sending may have.
   */
  function recoverIdle(op: Operation): void {
    if (inFlight.has(op.id) || (op.state !== 'prepared' && op.state !== 'sending')) return;
    if (op.state === 'sending' && now() - (op.sentAt ?? op.preparedAt) < budgets.callTimeoutMs) return;
    write(() => {
      const current = readOp(op.id);
      if (inFlight.has(current.id) || (current.state !== 'prepared' && current.state !== 'sending')) return;
      Object.assign(current, current.state === 'prepared'
        ? { state: 'not-sent', note: '落盘后发送标记未写入，传输未调用' }
        : { state: 'unknown', note: '发送结果未能写入，按原客户订单号核对' });
      saveOp(current); event(op.jobId, 'operation-recovered', { op: op.id, state: current.state });
    });
  }

  async function reconcile(job: Job, op: Operation): Promise<void> {
    const leg = job.legs[op.leg], row = accountFor(leg.venue);
    // Reconciling on another principal could find nothing and wrongly conclude not-created.
    if (!row || row.account_key !== leg.accountKey) { write(() => { const current = readOp(op.id); current.note = '账户绑定已变化，暂停核对'; saveOp(current); }); return; }
    const binding = bindingOf(row);
    let report: OrderReport | null;
    try { const value = await callVenue('read', signal => connectorFor(op.venue).query(binding, op.request, { signal })); report = value === null ? null : parseOrderReport(value, op.request); }
    catch (error) {
      write(() => {
        const current = readOp(op.id);
        current.note = `核对读取失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; current.lastCheckedAt = now();
        // Misses must be consecutive answers; a failed read in between starts the count again.
        if (current.state === 'unknown') { current.absentChecks = 0; current.absentAt = null; }
        saveOp(current);
      });
      return;
    }
    if (report) {
      const found = report;
      write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; applyReport(current, found); current.note = null; saveOp(current); event(job.id, 'operation-reconciled', { op: op.id, state: current.state }); });
      return;
    }
    if (op.state === 'open') { write(() => { const current = readOp(op.id); current.note = '交易所查无已确认的委托，保留待人工核对'; saveOp(current); }); return; }
    if (op.state !== 'unknown') return;
    // A miss is not proof (L039/L093): wait out the request validity window, count spaced misses, then require the account to show no trace.
    const counted = write(() => {
      const current = readOp(op.id);
      if (current.state !== 'unknown') return null;
      if (now() < createSettledAt(current)) { current.absentChecks = 0; current.lastCheckedAt = now(); saveOp(current); return null; }
      if (current.absentAt !== null && now() - current.absentAt < budgets.absentSpacingMs) return null;
      current.absentChecks += 1; current.absentAt = now(); current.lastCheckedAt = now(); saveOp(current);
      return current.absentChecks >= budgets.absentChecks ? current : null;
    });
    if (!counted) return;
    // The account read happens after the order query so the decision uses the latest evidence (L091).
    let snapshot: AccountSnapshot;
    try { snapshot = await readAccount(binding, leg.symbol); }
    catch (error) {
      if (error instanceof WriterLostError) throw error;
      write(() => { const current = readOp(op.id); if (current.state !== 'unknown') return; current.note = `查无原委托，但账户读取失败，无法确认无痕迹：${error instanceof Error ? error.message.slice(0, 120) : '未知'}`; saveOp(current); });
      return;
    }
    const expected = expectedPosition(job, op.leg);
    const traceFree = cmp(positionOf(snapshot, leg.symbol, leg.side), expected) === 0 && !snapshot.openOrders.some(order => order.symbol === leg.symbol);
    write(() => {
      const current = readOp(op.id);
      if (current.state !== 'unknown') return;
      if (!traceFree) {
        if (current.positionMismatchAt === null) { current.positionMismatchAt = now(); event(job.id, 'operation-mismatch', { op: op.id }); }
        current.note = '查无原委托，但当前持仓或挂单与已知成交不一致，保留待核对'; saveOp(current); return;
      }
      Object.assign(current, { state: 'not-created', note: '超过请求有效窗口后多次按客户订单号查询均不存在，且持仓与挂单无痕迹，判定未送达' });
      saveOp(current); event(job.id, 'operation-not-created', { op: op.id });
    });
  }
  /** Baseline plus this job's settled fills on the leg, excluding the operation under test (which has none known). */
  function expectedPosition(job: Job, index: 0 | 1): string {
    const leg = job.legs[index], filled = add('0', ...opsOf(job.id).filter(item => item.leg === index).map(item => item.filledQuantity));
    return job.action === 'open' ? add(leg.baseline, filled) : sub(leg.baseline, filled);
  }

  async function cancel(job: Job, op: Operation): Promise<void> {
    if (op.cancelSent >= budgets.cancelAttempts || (op.cancelRequestedAt !== null && now() - op.cancelRequestedAt < budgets.cancelRetryMs)) return;
    const leg = job.legs[op.leg], binding = bindingOf(accountFor(leg.venue) ?? reject('account_missing', '账户绑定缺失，保留待核对', 409));
    // Counted before transport so a crash mid-request stays counted; only a provable not-sent gives it back.
    write(() => { const current = readOp(op.id); current.cancelSent += 1; current.cancelRequestedAt = now(); saveOp(current); event(job.id, 'cancel-sent', { op: op.id, attempt: current.cancelSent }); });
    try {
      const report = parseOrderReport(await callVenue('write', signal => connectorFor(op.venue).cancel(binding, op.request, { signal, beforeSend: assertWriter })), op.request);
      write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; applyReport(current, report); saveOp(current); });
    } catch (error) {
      write(() => {
        const current = readOp(op.id);
        if (error instanceof VenueError && error.kind === 'not-sent') current.cancelSent -= 1;
        current.note = `撤单未确认：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveOp(current);
      });
    }
  }

  // ---- job progression ---------------------------------------------------------
  async function progress(job: Job): Promise<void> {
    for (const op of opsOf(job.id).filter(item => !SETTLED.has(item.state))) recoverIdle(op);
    for (const op of opsOf(job.id).filter(item => !SETTLED.has(item.state))) {
      if (op.state !== 'unknown' && op.state !== 'open') continue;
      // A failed check must not skip the bounded escalation below.
      try { await reconcile(job, op); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; current.note = `核对失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveOp(current); });
      }
    }
    // The grace starts no earlier than this writer's takeover, so a long outage still gets full checks before escalation.
    const unresolved = opsOf(job.id).find(item => item.state === 'unknown' && now() >= Math.max(createSettledAt(item), heldSince) + budgets.unresolvedGraceMs);
    if (unresolved) {
      write(() => finish(readJob(job.id), 'attention', `${VENUE_NAMES[unresolved.venue]} 委托超过观察窗仍无法确认（${(unresolved.note ?? '无回报').slice(0, 120)}），不再发送；需人工核对`));
      return;
    }
    job = readJob(job.id);
    const stop = stopRequested(job.id);
    const pastDeadline = now() >= job.deadlineAt;
    // After a takeover nothing new is sent, so resting orders are withdrawn instead of waiting for the deadline.
    const withdraw = stop || pastDeadline || job.holdNewSends;
    for (const op of opsOf(job.id).filter(item => item.state === 'open')) if (withdraw) await cancel(job, op);
    job = readJob(job.id);
    if (FINAL_JOB.has(job.status)) return;
    const exhausted = withdraw ? opsOf(job.id).find(item => item.state === 'open' && item.cancelSent >= budgets.cancelAttempts && item.cancelRequestedAt !== null && now() - item.cancelRequestedAt >= budgets.cancelRetryMs) : undefined;
    if (exhausted) { write(() => finish(readJob(job.id), 'attention', `撤单 ${exhausted.cancelSent} 次仍未确认，委托可能仍在挂单；需人工核对`)); return; }
    const ops = opsOf(job.id), lead = ops.find(item => item.leg === 0), hedge = ops.find(item => item.leg === 1);
    if (!lead) {
      if (stop) { write(() => finish(readJob(job.id), 'stopped', '已停止，未发送任何委托')); return; }
      if (job.holdNewSends) { write(() => finish(readJob(job.id), 'failed', '服务恢复后不再发送新委托')); return; }
      try { await guardLead(job); }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : '发送前检查失败';
        // A failed read may clear before the deadline; any other refusal ends the job before anything is sent.
        if (error instanceof ContractError && error.code === 'venue_read_failed' && now() < job.deadlineAt) { write(() => { const current = readJob(job.id); current.reason = reason; saveJob(current); }); return; }
        write(() => finish(readJob(job.id), 'failed', reason)); return;
      }
      await send(job, 0, job.legs[0].quantity);
      return;
    }
    if (!SETTLED.has(lead.state)) return;
    const hedgeQuantity = hedgeQuantityFor(job, lead.filledQuantity);
    if (!hedge && !isZero(lead.filledQuantity) && cmp(hedgeQuantity, job.legs[1].instrument.minQuantity) >= 0 && !job.holdNewSends && !stop) {
      try { await guardHedge(job); }
      catch (error) {
        if (error instanceof ContractError && error.code === 'venue_read_failed') {
          write(() => {
            const current = readJob(job.id), since = current.hedgeWaitSince ?? now();
            if (now() - since >= budgets.unresolvedGraceMs) { finish(current, 'attention', `对冲腿账户读取持续失败：${error.message.slice(0, 120)}；首腿敞口保留，需人工处理`); return; }
            current.hedgeWaitSince = since; current.reason = `对冲腿等待账户读取：${error.message.slice(0, 160)}`; saveJob(current);
          });
          return;
        }
        write(() => finish(readJob(job.id), 'attention', `对冲腿未发送：${error instanceof Error ? error.message.slice(0, 160) : '检查失败'}；首腿敞口保留，需人工处理`)); return;
      }
      await send(job, 1, hedgeQuantity);
      return;
    }
    if (hedge && !SETTLED.has(hedge.state)) return;
    write(() => settleJob(readJob(job.id)));
  }

  /** Hedge the lead's actual fill in the planned proportion, floored to the hedge venue's step. */
  function hedgeQuantityFor(job: Job, leadFilled: string): string {
    const [lead, hedge] = job.legs;
    const scaled = fromUnits(units(hedge.quantity) * units(leadFilled) / units(lead.quantity));
    return floorToStep(scaled, hedge.instrument.quantityStep);
  }

  function settleJob(job: Job): void {
    if (FINAL_JOB.has(job.status)) return;
    const ops = opsOf(job.id), filled = (index: 0 | 1) => add('0', ...ops.filter(item => item.leg === index).map(item => item.filledQuantity));
    const leadExposure = exposure(filled(0), job.legs[0].instrument), hedgeExposure = exposure(filled(1), job.legs[1].instrument);
    const lead = ops.find(item => item.leg === 0);
    if (isZero(leadExposure) && isZero(hedgeExposure)) {
      finish(job, stopRequested(job.id) ? 'stopped' : 'failed', `首腿未成交（${lead?.state ?? '未发送'}），未发送对冲腿`);
      return;
    }
    const gap = sub(leadExposure, hedgeExposure);
    if (isZero(gap)) { finish(job, 'completed', null); return; }
    finish(job, 'attention', `两腿成交不平衡：${VENUE_NAMES[job.legs[0].venue]} ${filled(0)}，${VENUE_NAMES[job.legs[1].venue]} ${filled(1)}，未对冲 ${gap} 桶；敞口保留，需人工处理`);
  }

  // ---- loop --------------------------------------------------------------------
  async function runTick(): Promise<void> {
    if (!acquire()) return;
    for (const job of unfinishedJobs()) {
      try { await progress(job); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        write(() => { const current = readJob(job.id); current.reason = `本轮处理失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveJob(current); });
      }
    }
    // attention sends and cancels nothing more, but its unsettled orders keep being reconciled so the person sees current facts.
    for (const op of unsettledOps()) {
      const job = readJob(op.jobId);
      if (job.status !== 'attention') continue;
      try {
        recoverIdle(op);
        const current = readOp(op.id);
        if (current.state === 'unknown' || current.state === 'open') await reconcile(job, current);
      } catch (error) { if (error instanceof WriterLostError) throw error; }
    }
  }
  /** One serialized pass over unfinished jobs. */
  function tick(): Promise<void> {
    if (!ticking) ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  function jobView(id: string) {
    const job = readJob(id), ops = opsOf(id);
    const events = (db.prepare('SELECT type, at, json FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT 40').all(id) as { type: string; at: number; json: string }[]).reverse().map(row => ({ type: row.type, at: row.at, ...JSON.parse(row.json) }));
    return {
      id: job.id, status: job.status, reason: job.reason, stopRequested: stopRequested(id), createdAt: job.createdAt, deadlineAt: job.deadlineAt, holdNewSends: job.holdNewSends,
      locked: !!db.prepare('SELECT 1 FROM locks WHERE job_id = ? LIMIT 1').get(id), acknowledgedAt: job.acknowledgedAt,
      legs: job.legs.map(leg => {
        const op = ops.find(item => item.leg === leg.index);
        return { venue: leg.venue, symbol: leg.symbol, side: leg.side, orderSide: leg.orderSide, plannedQuantity: leg.quantity, accountId: maskId(leg.accountId),
          operation: op ? { clientOrderId: op.clientOrderId, state: op.state, quantity: op.request.quantity, filledQuantity: op.filledQuantity, averagePrice: op.averagePrice, remoteId: op.remoteId, note: op.note } : null };
      }),
      events,
    };
  }

  return {
    owner,
    get generation() { return generation; },
    get retired() { return retired; },
    budgets,
    acquire,
    registerAccount,
    preview,
    publicPreview,
    confirm,
    requestStop,
    acknowledge,
    observe,
    tick,
    jobView,
    unfinished: () => unfinishedJobs().map(job => job.id),
    recentJobs: (limit = 20) => (db.prepare('SELECT id FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(Math.max(1, Math.trunc(limit)), 100)) as { id: string }[]).map(row => jobView(row.id)),
    /** Principal ids are masked: the page needs to tell accounts apart, not to see who they are. */
    accounts: () => (db.prepare('SELECT * FROM accounts WHERE environment = ? ORDER BY venue').all(environment) as unknown as AccountRow[])
      .map(row => ({ venue: row.venue, accountMode: row.account_mode, credentialVersion: row.credential_version, accountId: maskId(row.account_id) })),
    /**
     * Stops writing and hands the lease back so a clean restart need not wait for expiry.
     * A write still in flight then fails the fence; its operation stays sending and the next writer recovers it as unknown.
     */
    close() {
      if (closed) return;
      closed = true;
      if (held && !retired) {
        store.tx(() => db.prepare('UPDATE writer SET expires_at = ? WHERE id = 1 AND owner = ? AND generation = ?').run(now(), owner, generation));
        retired = true;
      }
    },
  };
}
export type Executor = ReturnType<typeof createExecutor>;
