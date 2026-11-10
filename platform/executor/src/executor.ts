// Phase 1 executor for the Binance + Bybit oil two-leg slice. It owns its own
// database and only accepts simulated connectors, so it cannot take execution
// rights over a real account (plan 1, 5.3, 8).
import { createHash, randomUUID } from 'node:crypto';
import { add, bandEdge, cmp, floorToStep, isMultiple, isZero, mul, sub, units, fromUnits } from './decimal.ts';
import {
  ContractError, MAX_SLIPPAGE_BPS, UUID, VENUE_NAMES, VENUE_READ_SYMBOLS, accountKey, checkQuoteFresh, orderSideOf, parseAccountSnapshot, parseBinding, parseConfirm, parseInstrument, parseIntent, parseQuote, positionOf, reject,
  type AccountBinding, type AccountSnapshot, type Action, type Environment, type Instrument, type Intent, type OrderSide, type OrderType, type PositionSide, type Quote, type Venue,
} from './contracts.ts';
import { VenueError, parseOrderReport, type OrderReport, type OrderRequest, type VenueConnector } from './connector.ts';
import type { Store } from './store.ts';
import { ControlRefusal, MAX_OWNED_BUDGET_MS, createAccountControl, parseOperationId, type AccountWriterPort, type ControlEnvironment, type WriteOutcome, type WriterOperation } from './account-control.ts';

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
  /** How far either book may move against the preview before the lead is sent; also the lead's IOC limit. */
  maxSlippageBps: number;
  /** Both legs' books must have been received within this window of each other (L100). */
  pairQuoteWindowMs: number;
  /** Hedge orders per job, counting the first; a definitive venue refusal stops earlier. */
  hedgeAttempts: number;
  /** Events, commands and consumed previews of finished jobs older than this are deleted; jobs and orders are kept. */
  historyRetentionMs: number;
  pruneIntervalMs: number;
  pruneBatch: number;
}
export const DEFAULT_BUDGETS: Readonly<Budgets> = Object.freeze({
  previewTtlMs: 30_000, previewQuoteMaxAgeMs: 10_000, sendQuoteMaxAgeMs: 10_000, futureToleranceMs: 1_000, callTimeoutMs: 35_000,
  createObserveMs: 120_000, createArrivalMarginMs: 60_000, absentChecks: 2, absentSpacingMs: 5_000, cancelAttempts: 5, cancelRetryMs: 10_000, leaseTtlMs: 60_000,
  unresolvedGraceMs: 60_000, maxSlippageBps: 50, pairQuoteWindowMs: 1_500, hedgeAttempts: 5,
  historyRetentionMs: 90 * 24 * 3_600_000, pruneIntervalMs: 3_600_000, pruneBatch: 500,
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
  /** Worst acceptable book price for this leg's side, fixed at preview. The lead sends it as an IOC limit; the hedge only checks it before the lead goes out. Absent in rows written before it existed. */
  priceBound?: string | null;
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
  /** 0 for the first order of a leg; hedge resumes count up. Absent in rows written before it existed means 0. */
  attempt?: number;
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
  /** Monotonic cancel sequence for shared-registry operation ids; unlike cancelSent it is never given back. Absent means 0. */
  cancelSeq?: number;
  /** Start of the latest query that still found this order resting. */
  openCheckedFrom?: number | null;
  /** First time the shared registry refused a cancel of this order. */
  cancelBlockedAt?: number | null;
  note: string | null;
}

export interface ExecutorOptions {
  store: Store;
  connectors: readonly VenueConnector[];
  environment?: Environment;
  now?: () => number;
  budgets?: Partial<Budgets>;
  /** Shared account-writer registry; absent means this executor writes no shared state. */
  control?: { writer: AccountWriterPort; environment: ControlEnvironment };
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exposure = (quantity: string, instrument: Instrument): string => mul(quantity, instrument.contractSize);
const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
/** `pa1-` + 24 hex + `-` + leg index, plus `r` + attempt for a resumed hedge (at most two digits). */
const CLIENT_ORDER_ID_LENGTH = 33;

export function createExecutor({ store, connectors, environment = 'simulated', now = Date.now, budgets: overrides = {}, control: controlOptions }: ExecutorOptions) {
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...overrides };
  // The client order id reserves two digits for the resume index, and the band must stay strictly inside the book.
  if (!Number.isSafeInteger(budgets.hedgeAttempts) || budgets.hedgeAttempts < 1 || budgets.hedgeAttempts > 99) throw new ContractError(500, 'budget', 'hedgeAttempts 须为 1–99');
  if (!Number.isSafeInteger(budgets.maxSlippageBps) || budgets.maxSlippageBps < 1 || budgets.maxSlippageBps > MAX_SLIPPAGE_BPS) throw new ContractError(500, 'budget', `maxSlippageBps 须为 1–${MAX_SLIPPAGE_BPS}`);
  if (controlOptions && budgets.callTimeoutMs > MAX_OWNED_BUDGET_MS) throw new ContractError(500, 'control_budget', `共享写者登记要求单次调用不超过 ${MAX_OWNED_BUDGET_MS} 毫秒`);
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
  /** Operations whose cancel is running in this process. */
  const cancelling = new Set<string>();
  const control = controlOptions ? createAccountControl({ ...controlOptions, lost: (message: string): never => { retired = true; throw new WriterLostError(message); } }) : null;

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
    const renewed = store.tx(() => {
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
    if (renewed && control) { try { control.keepAlive(); } catch (error) { if (!(error instanceof WriterLostError)) throw error; } }
    return renewed && !retired;
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
      else if (!job.holdNewSends) { job.holdNewSends = true; job.reason = '服务恢复：核对已发送委托；首腿不再新发并撤销挂单，已成交部分按落盘进度补发对冲腿'; saveJob(job); event(job.id, 'job-held', {}); }
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
    for (const { quote } of reads) checkQuoteFresh(quote, at, budgets.previewQuoteMaxAgeMs, budgets.futureToleranceMs);
    if (Math.abs(reads[0].quote.receivedAt - reads[1].quote.receivedAt) > budgets.pairQuoteWindowMs) reject('quote_window', `两腿盘口接收时间相差超过 ${budgets.pairQuoteWindowMs} 毫秒，请重新预览`, 409);
    const slippageBps = intent.maxSlippageBps ?? budgets.maxSlippageBps;
    const legs = intent.legs.map((leg, index) => {
      const { binding, instrument, quote, snapshot } = reads[index];
      const orderSide = orderSideOf(intent.action, leg.side);
      const priceBound = orderSide === 'buy' ? bandEdge(quote.ask, slippageBps, 'up', instrument.tickSize) : bandEdge(quote.bid, slippageBps, 'down', instrument.tickSize);
      const planned = { venue: leg.venue, symbol: intent.symbol, side: leg.side, quantity: leg.quantity, orderType: leg.orderType, limitPrice: leg.limitPrice };
      checkQuantity(planned, instrument, quote, intent.action);
      // A marketable limit beyond the band would fill past the protection the plan promises (L100).
      if (planned.limitPrice !== null && (orderSide === 'buy' ? cmp(planned.limitPrice, priceBound) > 0 : cmp(planned.limitPrice, priceBound) < 0)) reject('limit_beyond_bound', `${VENUE_NAMES[leg.venue]} ${intent.symbol} 限价 ${planned.limitPrice} 越过价格保护界限 ${priceBound}`, 409);
      const { baseline, positionMode } = checkLegAccount(planned, snapshot, intent.action);
      const result: PlannedLeg = {
        ...planned, index: index as 0 | 1, orderSide, reduceOnly: intent.action === 'close', priceBound,
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
      notes: [
        `先发送 ${VENUE_NAMES[legs[0].venue]} 腿，成交确认后按其成交量发送 ${VENUE_NAMES[legs[1].venue]} 对冲腿。`,
        legs[0].orderType === 'market'
          ? `价格保护 ${slippageBps} 基点：首腿以 IOC 限价 ${legs[0].priceBound} 发送，未即时成交的部分由交易所撤销；发送前任一腿盘口越过界限（对冲腿界限 ${legs[1].priceBound}）即不发送。`
          : `首腿按限价 ${legs[0].limitPrice} 挂单；发送前任一腿盘口越过 ${slippageBps} 基点界限即不发送。`,
        '对冲腿按市价发送；首腿成交后，包括服务重启接管后，按已落盘成交量补发对冲腿，补发不设价格限制。',
        '模拟传输：不会访问任何真实交易所。',
      ],
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
    const view = write(() => {
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
    if (!control) return view;
    releaseControl(jobId);
    return jobView(jobId);
  }
  /**
   * A person has taken over the job's exposure. Its writes still unresolved in the shared registry are
   * released as possibly executed, so the account is writable again; local reconciliation goes on.
   */
  function releaseControl(jobId: string): void {
    const mine = new Set(opsOf(jobId).map(op => op.clientOrderId));
    try { if (!control?.anyPending()) return; } catch (error) { if (error instanceof WriterLostError) throw error; return; }
    for (const leg of readJob(jobId).legs) {
      // Writes on a principal that is no longer bound stay in the registry for manual recovery.
      const row = accountFor(leg.venue);
      if (!row || row.account_key !== leg.accountKey) continue;
      const binding = bindingOf(row);
      // A refusal here is retried by settleControl on every pass, which treats the acknowledgement as settling.
      let pending: string[];
      try { pending = control.pending(binding); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
      for (const operationId of pending) {
        const parsed = parseOperationId(operationId);
        if (!parsed || !mine.has(parsed.clientOrderId)) continue;
        try { control.resolve(binding, operationId, 'confirmed'); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
        write(() => event(jobId, 'control-released', { operationId }));
      }
    }
  }

  /** Read-only market and position view. ANT is observable on Binance only and never executable here. */
  async function observe(venue: Venue, symbol: string): Promise<{ instrument: Instrument; quote: Quote; ageMs: number; position: { long: string; short: string } | null }> {
    if (!VENUE_READ_SYMBOLS[venue]?.includes(symbol)) reject('venue_symbol', `${VENUE_NAMES[venue] ?? venue} 不提供 ${symbol} 数据`, 400);
    const row = accountFor(venue);
    const [instrument, quote, snapshot] = await Promise.all([readInstrument(venue, symbol), readQuote(venue, symbol), row ? readAccount(bindingOf(row), symbol) : Promise.resolve(null)]);
    return { instrument, quote, ageMs: now() - quote.receivedAt, position: snapshot ? { long: positionOf(snapshot, symbol, 'long'), short: positionOf(snapshot, symbol, 'short') } : null };
  }

  // ---- sending -----------------------------------------------------------------
  const clientOrderIdFor = (job: Job, leg: 0 | 1, attempt: number): string => `pa1-${job.id.replace(/-/g, '').slice(0, 24)}-${leg}${attempt ? `r${attempt}` : ''}`;
  const attemptOf = (op: Operation): number => op.attempt ?? 0;
  const legOps = (jobId: string, index: 0 | 1): Operation[] => opsOf(jobId).filter(item => item.leg === index).sort((a, b) => attemptOf(a) - attemptOf(b));
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
    // A stale or broken book is a refusal; only two fresh books read too far apart are retried, like a failed read.
    for (const { quote } of checks) checkQuoteFresh(quote, at, budgets.sendQuoteMaxAgeMs, budgets.futureToleranceMs);
    if (Math.abs(checks[0].quote.receivedAt - checks[1].quote.receivedAt) > budgets.pairQuoteWindowMs) reject('quote_window', `两腿盘口接收时间相差超过 ${budgets.pairQuoteWindowMs} 毫秒，暂不发送`, 409);
    for (const { leg, quote, snapshot } of checks) {
      const price = leg.orderSide === 'buy' ? quote.ask : quote.bid, bound = leg.priceBound ?? null;
      if (bound !== null && (leg.orderSide === 'buy' ? cmp(price, bound) > 0 : cmp(price, bound) < 0)) reject('price_moved', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 盘口 ${price} 已越过价格保护界限 ${bound}，未发送`, 409);
      const { baseline, positionMode } = checkLegAccount(leg, snapshot, job.action);
      if (cmp(baseline, leg.baseline) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，请重新预览`, 409);
    }
    // Both accounts: a lead whose hedge account cannot be written would leave an exposure nobody can close.
    for (const leg of job.legs) admit(leg);
  }
  function admit(leg: PlannedLeg): void {
    if (control) control.admit(bindingStillValid(leg), budgets.callTimeoutMs);
  }
  /**
   * The hedge reduces the lead's exposure: only the account basis that decides its quantity is required (L084).
   * A resumed hedge expects the preview baseline moved by the fills of this job's earlier hedge orders.
   */
  async function guardHedge(job: Job): Promise<void> {
    const leg = job.legs[1], binding = bindingStillValid(leg), snapshot = await readAccount(binding, leg.symbol);
    const { baseline, positionMode } = checkLegAccount({ ...leg, quantity: '0' }, snapshot, job.action);
    if (cmp(baseline, expectedPosition(job, 1)) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，对冲腿未发送`, 409);
    admit(leg);
  }

  async function send(job: Job, index: 0 | 1, quantity: string, attempt = 0): Promise<void> {
    const leg = job.legs[index];
    // A market lead goes out as an IOC limit at its preview bound, so the venue itself enforces the protection (L100).
    const protectedLead = index === 0 && leg.orderType === 'market' && leg.priceBound != null;
    const request: OrderRequest = {
      clientOrderId: clientOrderIdFor(job, index, attempt), symbol: leg.symbol, side: leg.orderSide, positionSide: leg.side, quantity,
      type: protectedLead ? 'limit' : leg.orderType, limitPrice: protectedLead ? leg.priceBound as string : leg.limitPrice,
      timeInForce: protectedLead || leg.orderType === 'market' ? 'ioc' : 'gtc', reduceOnly: leg.reduceOnly,
    };
    const op: Operation = { id: randomUUID(), jobId: job.id, leg: index, attempt, venue: leg.venue, clientOrderId: request.clientOrderId, request, state: 'prepared', remoteId: null, filledQuantity: '0', averagePrice: null, venueStatus: null,
      preparedAt: now(), sentAt: null, lastCheckedAt: null, absentChecks: 0, absentAt: null, positionMismatchAt: null, cancelSent: 0, cancelRequestedAt: null, note: null };
    inFlight.add(op.id);
    try { await sendPrepared(job, index, op, request); } finally { inFlight.delete(op.id); }
  }
  async function sendPrepared(job: Job, index: 0 | 1, op: Operation, request: OrderRequest): Promise<void> {
    const leg = job.legs[index], quantity = request.quantity;
    const binding = write(() => {
      const current = readJob(job.id);
      // After a takeover only the hedge may still go out; any earlier order of the same leg must be settled and older.
      const earlier = opsOf(job.id).filter(item => item.leg === index);
      if (FINAL_JOB.has(current.status) || (index === 0 && current.holdNewSends) || stopRequested(job.id)
        || earlier.some(item => attemptOf(item) >= attemptOf(op) || !SETTLED.has(item.state))) reject('send_superseded', '任务状态已变化，本次不发送', 409);
      const valid = bindingStillValid(leg);
      db.prepare('INSERT INTO operations(id, job_id, leg, venue, client_order_id, state, settled, version, json) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)').run(op.id, job.id, index, leg.venue, op.clientOrderId, op.state, JSON.stringify(op));
      if (current.status === 'accepted') { current.status = 'running'; saveJob(current); }
      event(job.id, 'operation-prepared', { op: op.id, leg: index, quantity });
      return valid;
    });
    // The shared operation is recorded after the local prepared row and before the sending mark, so either store alone proves transport was not called.
    let registered: WriterOperation | null = null;
    if (control) {
      try { registered = control.prepareCreate(binding, job.id, request); }
      catch (error) {
        if (!(error instanceof ControlRefusal)) throw error;
        write(() => { const current = readOp(op.id); Object.assign(current, { state: 'not-sent', note: error.message.slice(0, 200) }); saveOp(current); event(job.id, 'operation-sent', { op: op.id, state: current.state, filled: '0' }); });
        return;
      }
    }
    try { write(() => { Object.assign(op, { state: 'sending', sentAt: now() }); saveOp(op); }); }
    catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
    let report: OrderReport | null = null, failure: unknown = null;
    const beforeSend = () => { assertWriter(); if (registered) control?.assertSend(registered, budgets.callTimeoutMs); };
    try { report = parseOrderReport(await callVenue('write', signal => connectorFor(leg.venue).place(binding, request, { signal, beforeSend })), request); }
    catch (error) { failure = error; }
    const settled = write(() => {
      const current = readOp(op.id);
      if (current.state !== 'sending') return null;
      if (report) applyReport(current, report);
      else if (failure instanceof VenueError && failure.kind === 'not-sent') Object.assign(current, { state: 'not-sent', note: failure.message.slice(0, 200) });
      else if (failure instanceof VenueError && failure.kind === 'rejected') Object.assign(current, { state: 'rejected', note: failure.message.slice(0, 200) });
      // Any other outcome, including a report that fails validation, leaves the result unknown.
      else Object.assign(current, { state: 'unknown', note: `结果未知：${failure instanceof Error ? failure.message.slice(0, 160) : '无回报'}` });
      saveOp(current);
      event(job.id, 'operation-sent', { op: op.id, state: current.state, filled: current.filledQuantity });
      return current.state;
    });
    // Released only after the local result is durable; anything left open is settled from local facts later.
    if (registered && settled) control?.finish(registered, outcomeOf(settled));
  }
  function outcomeOf(state: OpState): WriteOutcome {
    if (state === 'open' || state === 'filled' || state === 'canceled') return 'confirmed';
    return state === 'rejected' || state === 'not-sent' || state === 'not-created' ? 'rejected' : 'unknown';
  }

  function applyReport(op: Operation, report: OrderReport): void {
    // Cumulative fills never go backwards; a lower count is a stale or foreign answer.
    if (cmp(report.filledQuantity, op.filledQuantity) < 0) reject('report_regressed', '委托回报的成交数量回退，保留原状态', 409);
    const state: OpState = report.status === 'filled' ? 'filled' : report.terminal ? (report.status === 'rejected' && isZero(report.filledQuantity) ? 'rejected' : 'canceled') : 'open';
    Object.assign(op, { state, remoteId: report.remoteId, filledQuantity: report.filledQuantity, averagePrice: report.averagePrice, venueStatus: report.status, lastCheckedAt: now(), absentChecks: 0, absentAt: null });
  }

  // ---- reconciliation ----------------------------------------------------------
  /** The send starts at most a call timeout after the count; the venue then accepts the signed cancel until its validity ends. */
  const cancelSettledAt = (op: Operation): number => (op.cancelRequestedAt ?? 0) + budgets.callTimeoutMs + connectorFor(op.venue).capabilities.requestValidityMs + budgets.createArrivalMarginMs;
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
    const binding = bindingOf(row), startedAt = now();
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
      write(() => {
        const current = readOp(op.id);
        if (SETTLED.has(current.state)) return;
        applyReport(current, found); current.note = null;
        if (current.state === 'open') current.openCheckedFrom = startedAt;
        saveOp(current); event(job.id, 'operation-reconciled', { op: op.id, state: current.state });
      });
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
    const seq = (op.cancelSeq ?? 0) + 1;
    // The shared operation comes first: a sequence above the local one then proves this cancel was never sent.
    let registered: WriterOperation | null = null;
    if (control) {
      try { registered = control.prepareCancel(binding, job.id, op.request, seq); }
      catch (error) {
        if (!(error instanceof ControlRefusal)) throw error;
        write(() => { const current = readOp(op.id); current.cancelBlockedAt ??= now(); current.note = `撤单未发送：${error.message.slice(0, 160)}`; saveOp(current); });
        return;
      }
    }
    cancelling.add(op.id);
    try {
      // Counted before transport so a crash mid-request stays counted; only a provable not-sent gives it back.
      try { write(() => { const current = readOp(op.id); current.cancelSent += 1; current.cancelSeq = seq; current.cancelRequestedAt = now(); current.cancelBlockedAt = null; saveOp(current); event(job.id, 'cancel-sent', { op: op.id, attempt: current.cancelSent }); }); }
      catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
      let outcome: WriteOutcome | null = null;
      const beforeSend = () => { assertWriter(); if (registered) control?.assertSend(registered, budgets.callTimeoutMs); };
      try {
        const report = parseOrderReport(await callVenue('write', signal => connectorFor(op.venue).cancel(binding, op.request, { signal, beforeSend })), op.request);
        outcome = 'confirmed';
        write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; applyReport(current, report); saveOp(current); });
      } catch (error) {
        outcome ??= error instanceof VenueError && (error.kind === 'not-sent' || error.kind === 'rejected') ? 'rejected' : 'unknown';
        write(() => {
          const current = readOp(op.id);
          if (error instanceof VenueError && error.kind === 'not-sent') current.cancelSent -= 1;
          current.note = `撤单未确认：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveOp(current);
        });
      }
      if (registered) control?.finish(registered, outcome);
    } finally { cancelling.delete(op.id); }
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
    // A write this pass settled must not read as an unresolved registry entry when the same pass resends.
    settleControl();
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
    // A refusal caused by this order's own unknown cancel clears once that cancel's window has passed, so the grace counts from then;
    // like every grace here it starts no earlier than this writer's takeover.
    const blocked = withdraw ? opsOf(job.id).find(item => item.state === 'open' && item.cancelBlockedAt != null && now() >= Math.max(item.cancelBlockedAt, item.cancelRequestedAt === null ? 0 : cancelSettledAt(item), heldSince) + budgets.unresolvedGraceMs) : undefined;
    if (blocked) { write(() => finish(readJob(job.id), 'attention', `撤单被账户写入登记阻止超过 ${budgets.unresolvedGraceMs} 毫秒（${(blocked.note ?? '').slice(0, 120)}），委托仍在挂单；需人工核对`)); return; }
    const lead = legOps(job.id, 0)[0], hedges = legOps(job.id, 1);
    if (!lead) {
      if (stop) { write(() => finish(readJob(job.id), 'stopped', '已停止，未发送任何委托')); return; }
      if (job.holdNewSends) { write(() => finish(readJob(job.id), 'failed', '服务恢复后不再发送新委托')); return; }
      try { await guardLead(job); }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : '发送前检查失败';
        // A failed read may clear before the deadline; any other refusal ends the job before anything is sent.
        const retry = error instanceof ContractError && (error.code === 'venue_read_failed' || error.code === 'quote_window') || error instanceof ControlRefusal && error.transient;
        if (retry && now() < job.deadlineAt) { write(() => { const current = readJob(job.id); current.reason = reason; saveJob(current); }); return; }
        write(() => finish(readJob(job.id), 'failed', reason)); return;
      }
      await send(job, 0, job.legs[0].quantity);
      return;
    }
    if (!SETTLED.has(lead.state)) return;
    if (hedges.some(item => !SETTLED.has(item.state))) return;
    // Resume from what is on disk (L095): hedge what the lead filled minus what earlier hedge orders filled.
    const hedgeLeg = job.legs[1], hedged = add('0', ...hedges.map(item => item.filledQuantity));
    const target = hedgeQuantityFor(job, lead.filledQuantity), gap = sub(target, hedged);
    const remaining = cmp(gap, '0') > 0 ? floorToStep(gap, hedgeLeg.instrument.quantityStep) : '0';
    const refused = hedges.at(-1)?.state === 'rejected';
    if (!refused && !stop && cmp(remaining, hedgeLeg.instrument.minQuantity) >= 0) {
      if (hedges.length >= budgets.hedgeAttempts) {
        write(() => finish(readJob(job.id), 'attention', `对冲腿已发送 ${hedges.length} 次仍差 ${remaining}，不再补发；首腿敞口保留，需人工处理`));
        return;
      }
      try { await guardHedge(job); }
      catch (error) {
        // A position that disagrees may be the venue lagging behind the last fill (L110); it must persist through the grace before a person is called.
        const waiting = error instanceof ContractError && error.code === 'venue_read_failed' ? '账户读取' : error instanceof ControlRefusal && error.transient ? '账户写入登记'
          : error instanceof ContractError && error.code === 'position_changed' ? '持仓核对' : null;
        if (waiting) {
          const message = error instanceof Error ? error.message : '未知';
          write(() => {
            // A wait recorded by a previous writer restarts at the takeover, so a fresh process still gets the full grace.
            const current = readJob(job.id), since = Math.max(current.hedgeWaitSince ?? now(), heldSince);
            if (now() - since >= budgets.unresolvedGraceMs) { finish(current, 'attention', `对冲腿持续无法发送（最后原因：${waiting}，${message.slice(0, 120)}）；首腿敞口保留，需人工处理`); return; }
            current.hedgeWaitSince = since; current.reason = `对冲腿等待${waiting}：${message.slice(0, 160)}`; saveJob(current);
          });
          return;
        }
        write(() => finish(readJob(job.id), 'attention', `对冲腿未发送：${error instanceof Error ? error.message.slice(0, 160) : '检查失败'}；首腿敞口保留，需人工处理`)); return;
      }
      // Each wait is bounded on its own: an earlier wait that cleared must not shorten the next one.
      if (job.hedgeWaitSince != null) write(() => { const current = readJob(job.id); current.hedgeWaitSince = null; saveJob(current); });
      await send(job, 1, remaining, hedges.length);
      return;
    }
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
    const refused = ops.filter(item => item.leg === 1).sort((a, b) => attemptOf(a) - attemptOf(b)).at(-1);
    if (isZero(leadExposure) && isZero(hedgeExposure)) {
      finish(job, stopRequested(job.id) ? 'stopped' : 'failed', `首腿未成交（${lead?.state ?? '未发送'}），未发送对冲腿`);
      return;
    }
    const gap = sub(leadExposure, hedgeExposure);
    if (isZero(gap)) { finish(job, 'completed', null); return; }
    const why = refused?.state === 'rejected' ? `对冲腿被交易所拒绝（${(refused.note ?? '').slice(0, 80)}），不再补发；` : stopRequested(job.id) ? '已请求停止，不再补发对冲腿；' : '';
    finish(job, 'attention', `${why}两腿成交不平衡：${VENUE_NAMES[job.legs[0].venue]} ${filled(0)}，${VENUE_NAMES[job.legs[1].venue]} ${filled(1)}，未对冲 ${gap} 桶；敞口保留，需人工处理`);
  }

  // ---- retention ---------------------------------------------------------------
  // Only history of jobs that are over, have every order settled and need no one's attention is removed;
  // an unknown order or an unacknowledged exposure keeps its evidence (plan 6.1).
  const DONE_JOB = `SELECT id FROM jobs j WHERE j.final = 1 AND j.updated_at < ?
    AND NOT (j.status = 'attention' AND json_extract(j.json, '$.acknowledgedAt') IS NULL)
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.job_id = j.id AND o.settled = 0)`;
  let prunedAt = 0;
  /** Deletes at most pruneBatch rows per table in one short transaction; returns what it removed. */
  function prune(): { events: number; commands: number; previews: number } {
    const cutoff = now() - budgets.historyRetentionMs, limit = budgets.pruneBatch;
    return write(() => {
      const events = Number(db.prepare(`DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at < ? AND (job_id IS NULL OR job_id IN (${DONE_JOB})) ORDER BY seq LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      const commands = Number(db.prepare(`DELETE FROM commands WHERE request_id IN (SELECT request_id FROM commands WHERE accepted_at < ? AND job_id IN (${DONE_JOB}) LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      const previews = Number(db.prepare(`DELETE FROM previews WHERE id IN (SELECT id FROM previews WHERE expires_at < ? AND (consumed_job IS NULL OR consumed_job IN (${DONE_JOB})) LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      if (events + commands + previews) event(null, 'history-pruned', { events, commands, previews, before: cutoff });
      return { events, commands, previews };
    });
  }

  // ---- loop --------------------------------------------------------------------
  /**
   * Resolves this module's open shared operations from local facts, after a crash or a failed finish.
   * Nothing is resolved while its write may still be in flight or the local evidence is missing.
   */
  function settleControl(): void {
    if (!control) return;
    try { if (!control.anyPending()) return; } catch (error) { if (error instanceof WriterLostError) throw error; return; }
    for (const row of db.prepare('SELECT * FROM accounts WHERE environment = ?').all(environment) as unknown as AccountRow[]) {
      const binding = bindingOf(row);
      let pending: string[];
      try { pending = control.pending(binding); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
      for (const operationId of pending) {
        // One entry that cannot be judged (a venue without a connector, say) must not stop the rest or the pass.
        let outcome: ReturnType<typeof controlOutcome>;
        try { outcome = controlOutcome(operationId); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
        if (!outcome) continue;
        try { control.resolve(binding, operationId, outcome); event(jobOfOperation(operationId), 'control-resolved', { operationId, outcome }); }
        catch (error) { if (error instanceof WriterLostError) throw error; }
      }
    }
  }
  /** The job owning a registry entry, so its resolution shows in that job's history. */
  function jobOfOperation(operationId: string): string | null {
    const parsed = parseOperationId(operationId);
    const row = parsed && db.prepare('SELECT job_id FROM operations WHERE client_order_id = ?').get(parsed.clientOrderId) as { job_id: string } | undefined;
    return row?.job_id ?? null;
  }
  function controlOutcome(operationId: string): 'confirmed' | 'rejected' | null {
    const parsed = parseOperationId(operationId);
    const row = parsed && db.prepare('SELECT json FROM operations WHERE client_order_id = ?').get(parsed.clientOrderId) as { json: string } | undefined;
    if (!parsed || !row) return null;
    const op = JSON.parse(row.json) as Operation;
    if (inFlight.has(op.id) || cancelling.has(op.id)) return null;
    const proven = provenOutcome(parsed, op);
    if (proven) return proven;
    // A person who acknowledged the job owns its exposure; its writes are released as possibly executed (plan 6.1).
    const job = readJob(op.jobId);
    return job.status === 'attention' && job.acknowledgedAt != null ? 'confirmed' : null;
  }
  function provenOutcome(parsed: NonNullable<ReturnType<typeof parseOperationId>>, op: Operation): 'confirmed' | 'rejected' | null {
    if (parsed.kind === 'create') {
      // prepared never reached transport: the sending mark commits before any send.
      if (op.state === 'prepared' || op.state === 'not-sent' || op.state === 'rejected' || op.state === 'not-created') return 'rejected';
      return op.state === 'open' || op.state === 'filled' || op.state === 'canceled' ? 'confirmed' : null;
    }
    if (parsed.seq > (op.cancelSeq ?? 0)) return 'rejected';
    // Once the order is over, a cancel of it can no longer change anything.
    if (SETTLED.has(op.state)) return 'confirmed';
    // Past the window in which the venue could still accept the signed cancel, an order seen resting afterwards proves it did nothing (L091).
    return op.state === 'open' && op.cancelRequestedAt !== null && op.openCheckedFrom != null && op.openCheckedFrom >= cancelSettledAt(op) ? 'rejected' : null;
  }

  async function runTick(): Promise<void> {
    if (!acquire()) return;
    settleControl();
    if (now() - prunedAt >= budgets.pruneIntervalMs) {
      prunedAt = now();
      try { prune(); } catch (error) { if (error instanceof WriterLostError) throw error; }
    }
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
    // Again at the end, so a result reconciled in this pass releases its account before the next one.
    settleControl();
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
        const mine = ops.filter(item => item.leg === leg.index).sort((a, b) => attemptOf(a) - attemptOf(b)), op = mine.at(-1);
        return { venue: leg.venue, symbol: leg.symbol, side: leg.side, orderSide: leg.orderSide, plannedQuantity: leg.quantity, accountId: maskId(leg.accountId), priceBound: leg.priceBound ?? null,
          attempts: mine.length, filledQuantity: add('0', ...mine.map(item => item.filledQuantity)),
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
    prune,
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
