// ASTER ADL emergency handling for the margin-balance pairs (plan 2.3b, simulated
// transport only). When the venue auto-deleverages one side of a pair, the
// pair's long and short totals of that contract no longer match. An incident then
// reduces the excess side with reduce-only market batches until both totals are
// equal again, persisting each batch before it is sent. A batch without a usable
// answer is never resent: it is queried by its own client id a bounded number of
// times, and after the observation window the next batch is planned from fresh
// positions. Every venue fact an order relies on must be newer than the ADL fill
// and the last batch fill it follows (L054).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { cmp, floorToStep, fromUnits, isZero, min, sub, add, units } from './decimal.ts';
import { ContractError, PAIR_ID, UUID, exactKeys, reject, text, type PairSide } from './contracts.ts';
import { VenueError } from './connector.ts';
import { ADL_CANCEL_OPERATION_PREFIX, ADL_OPERATION_PREFIX, ControlRefusal, parseAdlOperationId, type AccountControl, type WriterOperation } from './account-control.ts';
import {
  DEFAULT_ADL_CONFIG, DIRECTION_NAMES, TERMINAL_ADL_ORDER, evidenceDirection, parseAdlAccount, parseAdlConfig, parseAdlEvidence, parseAdlOrderReport, parseAdlRule,
  type AdlAccountSnapshot, type AdlConfig, type AdlConnector, type AdlEvidenceRow, type AdlOrderReport, type AdlOrderRequest, type AdlPositionSide, type AdlRule, type Direction,
} from './adl-contracts.ts';
import type { PairRecord } from './transfer.ts';

const SIDES = ['long', 'short'] as const;
const SIDE_NAMES: Record<PairSide, string> = { long: '多侧', short: '空侧' };
/** Pushed rows waiting for the next pass; older ones are dropped beyond this, the force-order history still covers them. */
const PUSH_QUEUE_LIMIT = 1_000;
const PUSH_STORE_ATTEMPTS = 3;
/** Filled batches younger than this are checked against the positions' update times. */
const FILL_CHECK_WINDOW_MS = 24 * 3_600_000;
/** Cancels sent for one working batch before the incident halts for a person to cancel it at the venue. */
const ADL_CANCEL_LIMIT = 3;
/** Pending history windows kept per side; past it the newest window is stretched instead of a new one added. */
const SCAN_WINDOW_LIMIT = 100;
/** The same failure of the same pair is written to the event log at most this often; the throttle lives in memory. */
const FAILURE_EVENT_MS = 60_000;

export const ADL_BUDGET_KEYS = [
  'adlScanIntervalMs', 'adlScanOverlapMs', 'adlScanRequests', 'adlReadTimeoutMs', 'adlOrderTimeoutMs', 'adlSceneMaxAgeMs', 'adlRetryMs', 'adlNotSentRetryMs', 'adlNotSentLimit',
  'adlQueryLimit', 'adlQuerySpacingMs', 'adlObservationMs', 'adlCancelAfterMs', 'adlActiveQueryMs', 'adlMaxActiveMs', 'adlMaxBatches', 'adlWatchMs', 'adlWatchSceneMs', 'adlTickBudgetMs',
] as const;
export type AdlBudgets = Record<typeof ADL_BUDGET_KEYS[number], number>;
/** Legacy constants (`modules/aster/trading/adl.py:28-37`, `adl_recovery.py:11-14`) except adlWatchMs and adlNotSentLimit, which are new (user decision 2026-11-11, L084). */
export const DEFAULT_ADL_BUDGETS: Readonly<AdlBudgets> = Object.freeze({
  adlScanIntervalMs: 60_000, adlScanOverlapMs: 60_000, adlScanRequests: 2, adlReadTimeoutMs: 8_000, adlOrderTimeoutMs: 3_000, adlSceneMaxAgeMs: 8_000, adlRetryMs: 10_000,
  adlNotSentRetryMs: 1_000, adlNotSentLimit: 20, adlQueryLimit: 3, adlQuerySpacingMs: 2_000, adlObservationMs: 120_000, adlCancelAfterMs: 10_000, adlActiveQueryMs: 30_000,
  adlMaxActiveMs: 1_800_000, adlMaxBatches: 500, adlWatchMs: 600_000, adlWatchSceneMs: 10_000, adlTickBudgetMs: 10_000,
});

// ---- records -------------------------------------------------------------------
interface Scan {
  accountId: string;
  /** Nothing before this is read: a newly installed account is not traced back. */
  since: number;
  /** The latest window end read completely; windows still pending may lie before it. */
  coveredUntil: number;
  /** Windows still to read, oldest first. */
  windows: [number, number][];
  nextAt: number;
  note: string | null;
}
export interface AdlPairRecord { pairId: string; identity: string; config: AdlConfig; installedAt: number; scans: Record<PairSide, Scan> }

/**
 * When the cumulative fill last grew (L054). `at` is the venue time of the first report that showed the current fill, so a
 * later report with the same fill (a cancel or expiry of the rest) never moves it. `after` is a venue time at which the fill was
 * known to be smaller (or the order did not exist yet); `seenAt` is the local time the current fill was first seen.
 */
export interface FillMark { at: number; after: number | null; seenAt: number }
export interface Evidence {
  key: string; pairId: string; side: PairSide; accountId: string; symbol: string; orderId: string; positionSide: AdlPositionSide; orderSide: 'buy' | 'sell'; direction: Direction;
  quantity: string; filledQuantity: string; status: AdlEvidenceRow['status']; averagePrice: string | null; updateTime: number;
  fill: FillMark | null;
  /** Fill already covered by a completed incident. */
  handledQuantity: string;
  /** Immutable fields of the same order disagreed; the incident stays blocked until a person looks at it. */
  conflict: string | null;
  sources: ('push' | 'history')[];
  firstSeenAt: number; updatedAt: number;
}

export type IncidentStatus = 'active' | 'blocked' | 'halted' | 'watching' | 'completed';
export type ProgressStatus = 'balanced' | 'residual' | 'reducing' | 'pending' | 'blocked' | 'held' | 'manual';
export interface SymbolProgress { status: ProgressStatus; residual: string; direction: Direction | null; reason?: string }
interface ScenePosition { side: PairSide; symbol: string; positionSide: AdlPositionSide; direction: Direction; quantity: string }
interface Scene { at: number; positions: ScenePosition[] }
export interface Incident {
  id: string; pairId: string; identity: string; status: IncidentStatus; createdAt: number; updatedAt: number;
  symbols: string[];
  /** Evidence this incident covers, with the fill it covered when last included. */
  evidence: { key: string; filledQuantity: string }[];
  reason: string | null; haltReason: string | null; retryAt: number;
  /** Time spent active before activeSince; blocked time is not counted (user decision). */
  activeMs: number; activeSince: number | null;
  /** Halt conditions count batches from here; set at the start and by every restart. */
  restartedAt: number; restarts: number;
  /** Sends in a row that never left this process (L084). */
  notSentStreak: number;
  before: Scene | null; after: Scene | null;
  progress: Record<string, SymbolProgress>;
  residuals: { symbol: string; quantity: string; direction: Direction }[];
  completedAt: number | null; watchUntil: number | null; closedAt: number | null;
  parentId: string | null;
}

/**
 * prepared: persisted, transport not called. sending: transport may have been called.
 * open: the venue reported it working. unknown: no usable answer; queried by the client id.
 * unknown-verified: still no answer after the bounded queries and the observation window; planning continues from fresh
 * positions, the order is never resent, a late report revokes it. done: terminal with a report (filled, canceled or expired).
 * rejected: definitive venue refusal. not-sent: never left this process. unknown-closed: the watch ended without a report.
 */
export type BatchState = 'prepared' | 'sending' | 'open' | 'unknown' | 'unknown-verified' | 'done' | 'rejected' | 'not-sent' | 'unknown-closed';
const SETTLED_BATCH = new Set<BatchState>(['done', 'rejected', 'not-sent', 'unknown-closed']);
export interface Batch {
  id: string; incidentId: string; pairId: string; side: PairSide; accountId: string;
  symbol: string; positionSide: AdlPositionSide; orderSide: 'buy' | 'sell'; direction: Direction; quantity: string; clientOrderId: string;
  positionBefore: string; excessBefore: string; markPrice: string;
  /** Venue update time of the planned position, read before the order existed: its fill came later (L054). */
  positionTime: number;
  state: BatchState; preparedAt: number; sentAt: number | null;
  /** The latest moment the order or its cancel could have reached the venue. */
  lastPossibleSendAt: number | null;
  report: AdlOrderReport | null;
  fill: FillMark | null;
  queries: number; postCancelQueries: number; queryAfter: number; activeQueryAfter: number;
  cancelRequestedAt: number | null; cancels: number; verifiedAt: number | null; recovered: boolean; note: string | null;
}

// ---- planning --------------------------------------------------------------------
export interface AdlPlan { side: PairSide; symbol: string; positionSide: AdlPositionSide; direction: Direction; quantity: string; positionBefore: string; excessBefore: string; markPrice: string; positionTime: number }
const divide = (left: string, right: string): string => fromUnits(units(left) * units('1') / units(right));
const net = (positions: readonly { symbol: string; direction: Direction | null; quantity: string }[], symbol: string): string =>
  positions.filter(row => row.symbol === symbol && row.direction).reduce((sum, row) => row.direction === 'long' ? add(sum, row.quantity) : sub(sum, row.quantity), '0');
const abs = (value: string): string => cmp(value, '0') < 0 ? sub('0', value) : value;

/**
 * Plans every symbol on its own and returns at most one batch, for the first symbol (by name) that has a legal one.
 * The excess side's largest position is reduced by min(excess, position, market max, notional cap ÷ mark), floored to the step;
 * a batch is never enlarged to the minimum. An excess below the minimum quantity is a residual and counts as balanced
 * (user decision 2026-11-11); a notional cap that cannot buy one lot keeps the symbol blocked.
 */
export function planReductions(positions: Record<PairSide, readonly AdlAccountSnapshot['positions'][number][]>, symbols: readonly string[], rules: ReadonlyMap<string, AdlRule | string>, batchNotional: string): { plan: AdlPlan | null; progress: Record<string, SymbolProgress> } {
  let plan: AdlPlan | null = null;
  const progress: Record<string, SymbolProgress> = {};
  const all = SIDES.flatMap(side => positions[side].map(row => ({ side, row })));
  for (const symbol of [...symbols].sort()) {
    const excess = net(all.map(item => item.row), symbol);
    if (isZero(excess)) { progress[symbol] = { status: 'balanced', residual: '0', direction: null }; continue; }
    const direction: Direction = cmp(excess, '0') > 0 ? 'long' : 'short', amount = abs(excess);
    const entry = (status: ProgressStatus, reason?: string): SymbolProgress => ({ status, residual: amount, direction, ...(reason ? { reason } : {}) });
    const rule = rules.get(symbol);
    if (rule === undefined || typeof rule === 'string') { progress[symbol] = entry('blocked', rule ?? `${symbol} 交易规则不可用`); continue; }
    if (cmp(floorToStep(amount, rule.quantityStep), rule.minQuantity) < 0) { progress[symbol] = entry('residual'); continue; }
    if (!rule.tradable) { progress[symbol] = entry('blocked', `${symbol} 当前不可交易`); continue; }
    const candidates = all.filter(item => item.row.symbol === symbol && item.row.direction === direction)
      .sort((a, b) => cmp(b.row.quantity, a.row.quantity) || a.side.localeCompare(b.side) || a.row.positionSide.localeCompare(b.row.positionSide));
    let capBlocked = false, found: AdlPlan | null = null;
    for (const { side, row } of candidates) {
      const cap = floorToStep(divide(batchNotional, row.markPrice), rule.quantityStep);
      if (cmp(cap, rule.minQuantity) < 0) { capBlocked = true; continue; }
      const quantity = floorToStep(min(min(amount, row.quantity), min(rule.maxMarketQuantity, cap)), rule.quantityStep);
      if (cmp(quantity, rule.minQuantity) < 0) continue;
      found = { side, symbol, positionSide: row.positionSide, direction, quantity, positionBefore: row.quantity, excessBefore: amount, markPrice: row.markPrice, positionTime: row.updateTime };
      break;
    }
    if (found) {
      if (!plan) plan = found;
      progress[symbol] = entry(plan === found ? 'reducing' : 'pending');
    } else {
      progress[symbol] = entry('blocked', capBlocked
        ? `${symbol} 单批金额上限 ${batchNotional} ${rule.quoteAsset} 不足以满足最小数量 ${rule.minQuantity}（配置问题）`
        : `${symbol} 剩余差额 ${amount} 分散在多个持仓，单个持仓不足最小数量 ${rule.minQuantity}`);
    }
  }
  return { plan, progress };
}

// ---- module ----------------------------------------------------------------------
export interface AdlDeps {
  db: DatabaseSync;
  now: () => number;
  budgets: AdlBudgets & { futureToleranceMs: number };
  connector: AdlConnector | null;
  /**
   * The shared account-writer registry, when injected: each reduction order and each cancel is registered there before
   * its send, checked again inside beforeSend, finished after its local result, and resolved from local facts.
   */
  control: AccountControl | null;
  write<T>(operation: () => T): T;
  assertWriter(): void;
  callVenue<T>(kind: 'read' | 'write', operation: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  event(jobId: string | null, type: string, detail?: Record<string, unknown>): void;
  isWriterLost(error: unknown): boolean;
  /** Current, readable margin-balance pairs. */
  pairs(): PairRecord[];
  /** True while a margin transfer of the pair is being sent; no batch is sent meanwhile (one pair, one lock, as in the legacy system). */
  transferSending?(pairId: string): boolean;
}

const TRANSFER_SENDING = '配对的保证金划转正在发送，等划转有结果后再减仓';
/** A transfer send ends within its call timeout; looking again each second keeps the reduction close behind it. */
const TRANSFER_WAIT_MS = 1_000;

/** A reason to stop this pass and look again after retryMs (adlRetryMs when not given); never an exchange answer about an order. */
class Hold extends Error {
  readonly retryMs: number | null;
  constructor(message: string, retryMs: number | null = null) { super(message); this.retryMs = retryMs; }
}

function checkBudgets(budgets: AdlDeps['budgets'], connector: AdlConnector | null): void {
  for (const key of ADL_BUDGET_KEYS) if (!Number.isSafeInteger(budgets[key]) || budgets[key] <= 0) throw new ContractError(500, 'budget', `${key} 须为正整数`);
  if (connector && (!Number.isSafeInteger(connector.capabilities.historyPageLimit) || connector.capabilities.historyPageLimit < 2)) throw new ContractError(500, 'budget', 'ADL 连接器的 historyPageLimit 须为不小于 2 的整数');
}
const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
const message = (error: unknown): string => error instanceof Error ? error.message.slice(0, 200) : '未知错误';
const clientOrderId = (): string => `adl-${randomBytes(14).toString('hex')}`;
/**
 * What a batch's local state proves for its order's registry entry: rejected when it never reached the venue, confirmed
 * once the venue answered or the observation window handed it to fresh positions (it may have filled; a late report still
 * counts), null while the result is open.
 */
export function adlRegistryOutcome(state: BatchState): 'confirmed' | 'rejected' | null {
  if (state === 'prepared' || state === 'not-sent' || state === 'rejected') return 'rejected';
  if (state === 'open' || state === 'done' || state === 'unknown-verified' || state === 'unknown-closed') return 'confirmed';
  return null;
}

export function createAdl({ db, now, budgets, connector, control, write, assertWriter, callVenue, event, isWriterLost, pairs, transferSending }: AdlDeps) {
  checkBudgets(budgets, connector);
  const tolerance = budgets.futureToleranceMs;
  /** Batches whose send or cancel runs in this process; any other prepared or sending row was interrupted. */
  const inFlight = new Set<string>();
  /** The stamp of this process's latest cancel attempt (see cancelBatch). */
  let lastCancelStamp = 0;
  /** Batches whose last cancel the registry refused, until when the next cancel waits (queries go on meanwhile). */
  const cancelRefusedUntil = new Map<string, number>();
  const pushed: { accountId: string; row: unknown }[] = [];
  let droppedPushes = 0;
  let resumeAfter: string | null = null;
  const failures = new Map<string, { reason: string; at: number }>();
  const unsubscribe = connector?.subscribe((accountId, row) => {
    if (pushed.length >= PUSH_QUEUE_LIMIT) { pushed.shift(); droppedPushes++; }
    pushed.push({ accountId, row });
  }) ?? null;

  // ---- persistence -------------------------------------------------------------
  const readAdlPair = (pairId: string): AdlPairRecord | null => {
    const row = db.prepare('SELECT json FROM adl_pairs WHERE pair_id = ?').get(pairId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as AdlPairRecord : null;
  };
  function saveAdlPair(record: AdlPairRecord): void {
    db.prepare(`INSERT INTO adl_pairs(pair_id, version, updated_at, json) VALUES (?, 1, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at, json = excluded.json`).run(record.pairId, now(), JSON.stringify(record));
  }
  const readIncident = (id: string): Incident | null => {
    const row = db.prepare('SELECT json FROM adl_incidents WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Incident : null;
  };
  const requireIncident = (id: string): Incident => readIncident(id) ?? reject('adl_incident_missing', 'ADL 事件不存在', 404);
  const incidentVersion = (id: string): number => (db.prepare('SELECT version FROM adl_incidents WHERE id = ?').get(id) as { version: number } | undefined)?.version ?? -1;
  const openIncident = (pairId: string): Incident | null => {
    const row = db.prepare('SELECT json FROM adl_incidents WHERE pair_id = ? AND final = 0').get(pairId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Incident : null;
  };
  function saveIncident(incident: Incident): void {
    incident.updatedAt = now();
    db.prepare('UPDATE adl_incidents SET status = ?, final = ?, version = version + 1, json = ? WHERE id = ?').run(incident.status, incident.status === 'completed' ? 1 : 0, JSON.stringify(incident), incident.id);
  }
  const readBatch = (id: string): Batch => JSON.parse((db.prepare('SELECT json FROM adl_batches WHERE id = ?').get(id) as { json: string }).json) as Batch;
  function saveBatch(batch: Batch): void {
    db.prepare('UPDATE adl_batches SET state = ?, settled = ?, version = version + 1, json = ? WHERE id = ?').run(batch.state, SETTLED_BATCH.has(batch.state) ? 1 : 0, JSON.stringify(batch), batch.id);
  }
  const batchesOf = (incidentId: string): Batch[] => (db.prepare('SELECT json FROM adl_batches WHERE incident_id = ? ORDER BY created_at, rowid').all(incidentId) as { json: string }[]).map(row => JSON.parse(row.json) as Batch);
  const openBatches = (pairId: string): Batch[] => (db.prepare('SELECT json FROM adl_batches WHERE pair_id = ? AND settled = 0 ORDER BY created_at, rowid').all(pairId) as { json: string }[]).map(row => JSON.parse(row.json) as Batch);
  const recentFilled = (pairId: string): Batch[] => (db.prepare('SELECT json FROM adl_batches WHERE pair_id = ? AND created_at >= ? ORDER BY created_at, rowid').all(pairId, now() - FILL_CHECK_WINDOW_MS) as { json: string }[])
    .map(row => JSON.parse(row.json) as Batch).filter(batch => batch.report && !isZero(batch.report.filledQuantity));
  const readEvidence = (key: string): Evidence | null => {
    const row = db.prepare('SELECT json FROM adl_evidence WHERE key = ?').get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Evidence : null;
  };
  const pendingEvidence = (pairId: string): Evidence[] => (db.prepare('SELECT json FROM adl_evidence WHERE pair_id = ? AND pending = 1 ORDER BY updated_at, key').all(pairId) as { json: string }[]).map(row => JSON.parse(row.json) as Evidence);
  function saveEvidence(evidence: Evidence): void {
    const pending = evidence.conflict !== null || cmp(evidence.filledQuantity, evidence.handledQuantity) > 0 ? 1 : 0;
    db.prepare(`INSERT INTO adl_evidence(key, pair_id, pending, updated_at, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET pending = excluded.pending, updated_at = excluded.updated_at, json = excluded.json`).run(evidence.key, evidence.pairId, pending, now(), JSON.stringify(evidence));
  }
  const evidenceSignature = (pairId: string): string => createHash('sha256').update(JSON.stringify(pendingEvidence(pairId).map(item => [item.key, item.filledQuantity, item.conflict]))).digest('hex');

  /** Leaving active adds the time spent there; blocked, halted and watching time is not counted. */
  function transition(incident: Incident, status: IncidentStatus): void {
    const at = now();
    if (incident.status === 'active' && status !== 'active' && incident.activeSince !== null) { incident.activeMs += Math.max(0, at - incident.activeSince); incident.activeSince = null; }
    if (status === 'active' && incident.activeSince === null) incident.activeSince = at;
    incident.status = status;
  }
  const activeElapsed = (incident: Incident): number => incident.activeMs + (incident.activeSince !== null ? Math.max(0, now() - incident.activeSince) : 0);

  // ---- pairs and evidence --------------------------------------------------------
  function newScan(accountId: string, previous: AdlPairRecord | null): Scan {
    const kept = previous ? SIDES.map(side => previous.scans[side]).find(scan => scan.accountId === accountId) : undefined;
    return kept ?? { accountId, since: now(), coveredUntil: now(), windows: [], nextAt: now() + budgets.adlScanIntervalMs, note: null };
  }
  /** Creates the ADL settings of a pair, or follows its accounts after a change; an account that stays keeps its scan progress. */
  /** Inside a write. */
  function installPair(pair: PairRecord): AdlPairRecord {
    const current = readAdlPair(pair.id);
    if (current && current.identity === pair.identity) return current;
    const record: AdlPairRecord = { pairId: pair.id, identity: pair.identity, config: current?.config ?? { ...DEFAULT_ADL_CONFIG }, installedAt: current?.installedAt ?? now(),
      scans: { long: newScan(pair.long, current), short: newScan(pair.short, current) } };
    saveAdlPair(record);
    event(null, current ? 'adl-pair-accounts-changed' : 'adl-pair-installed', { pair: pair.id });
    return record;
  }
  function ensurePair(pair: PairRecord): AdlPairRecord {
    const existing = readAdlPair(pair.id);
    return existing && existing.identity === pair.identity ? existing : write(() => installPair(pair));
  }
  function mergeEvidence(pair: PairRecord, side: PairSide, row: AdlEvidenceRow, source: 'push' | 'history'): void {
    const accountId = pair[side], key = `${pair.id}|${accountId}|${row.symbol}|${row.orderId}`, at = now();
    const existing = readEvidence(key);
    if (!existing) {
      saveEvidence({ key, pairId: pair.id, side, accountId, symbol: row.symbol, orderId: row.orderId, positionSide: row.positionSide, orderSide: row.side, direction: evidenceDirection(row),
        quantity: row.quantity, filledQuantity: row.filledQuantity, status: row.status, averagePrice: row.averagePrice, updateTime: row.updateTime,
        fill: isZero(row.filledQuantity) ? null : { at: row.updateTime, after: row.time - 1, seenAt: at }, handledQuantity: '0', conflict: null,
        sources: [source], firstSeenAt: at, updatedAt: at });
      event(null, 'adl-evidence', { pair: pair.id, side, symbol: row.symbol, orderId: row.orderId, filledQuantity: row.filledQuantity, source });
      return;
    }
    const next: Evidence = { ...existing, sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source] };
    if (existing.positionSide !== row.positionSide || existing.orderSide !== row.side || cmp(existing.quantity, row.quantity) !== 0) {
      next.conflict ??= `同一 ADL 订单前后回报的持仓方向、买卖方向或原始数量不一致（${existing.positionSide}/${existing.orderSide}/${existing.quantity} 与 ${row.positionSide}/${row.side}/${row.quantity}）`;
    } else if (cmp(row.filledQuantity, existing.filledQuantity) > 0) {
      // Cumulative fills only grow; a smaller one is an older report and is ignored.
      const updateTime = Math.max(existing.updateTime, row.updateTime);
      Object.assign(next, { filledQuantity: row.filledQuantity, status: row.status, averagePrice: row.averagePrice ?? existing.averagePrice, updateTime,
        fill: { at: updateTime, after: Math.max(existing.updateTime, row.time - 1), seenAt: at } });
    } else if (cmp(row.filledQuantity, existing.filledQuantity) === 0 && row.updateTime > existing.updateTime) {
      Object.assign(next, { status: row.status, updateTime: row.updateTime });
    }
    if (JSON.stringify(next) === JSON.stringify(existing)) return;
    next.updatedAt = at;
    saveEvidence(next);
    event(null, 'adl-evidence', { pair: pair.id, side, symbol: row.symbol, orderId: row.orderId, filledQuantity: next.filledQuantity, source, conflict: next.conflict });
  }
  /** Pairs an account belongs to; a pushed row is recorded for each. */
  const owners = (accountId: string, list: PairRecord[]): { pair: PairRecord; side: PairSide }[] =>
    list.flatMap(pair => SIDES.filter(side => pair[side] === accountId).map(side => ({ pair, side })));
  /** Consecutive failed stores of the same pushed rows; past PUSH_STORE_ATTEMPTS they are dropped and counted. */
  let pushStoreFailures = 0;
  function flushPushed(list: PairRecord[]): void {
    if (!pushed.length && !droppedPushes) return;
    const batch = pushed.splice(0), dropped = droppedPushes;
    droppedPushes = 0;
    try {
      write(() => {
        let invalid = 0;
        for (const { accountId, row } of batch) {
          const targets = owners(accountId, list);
          if (!targets.length) continue;
          let parsed: AdlEvidenceRow;
          try { parsed = parseAdlEvidence(row, now(), tolerance); } catch { invalid++; continue; }
          // Like the history scan, an order created before the account was first seen is not traced back.
          for (const { pair, side } of targets) if (parsed.time >= installPair(pair).scans[side].since) mergeEvidence(pair, side, parsed, 'push');
        }
        // Invalid pushes are dropped like the legacy stream parser does; the force-order history is the complete source.
        if (invalid || dropped) event(null, 'adl-push-dropped', { invalid, overflow: dropped });
      });
      pushStoreFailures = 0;
    } catch (error) {
      // Nothing was stored: the rows go back in front of newer pushes, within the same queue limit, unless they keep failing.
      if (!isWriterLost(error) && ++pushStoreFailures >= PUSH_STORE_ATTEMPTS) { pushStoreFailures = 0; droppedPushes += dropped + batch.length; throw error; }
      const room = Math.max(0, PUSH_QUEUE_LIMIT - pushed.length), kept = batch.slice(Math.max(0, batch.length - room));
      pushed.unshift(...kept);
      droppedPushes += dropped + batch.length - kept.length;
      throw error;
    }
  }

  // ---- venue calls -------------------------------------------------------------
  const venue = (): AdlConnector => connector ?? reject('adl_unavailable', 'ADL 连接器不可用', 503);
  async function read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try { return await callVenue('read', operation, budgets.adlReadTimeoutMs); }
    catch (error) { if (error instanceof ContractError || isWriterLost(error)) throw error; throw new Hold(`ASTER 读取失败：${message(error)}`); }
  }

  /** Reads the force-order history window by window; a full page is split, and its rows are still recorded. */
  async function scan(pair: PairRecord, record: AdlPairRecord): Promise<void> {
    for (const side of SIDES) {
      const scanState = record.scans[side];
      if (scanState.accountId !== pair[side]) continue;
      const at = now();
      // New time keeps being queued while older windows wait, so one window that cannot be read never stops the scan.
      const queuedUntil = Math.max(scanState.coveredUntil, ...scanState.windows.map(window => window[1]));
      if (at < scanState.nextAt) continue;
      if (at - queuedUntil >= (scanState.windows.length ? budgets.adlScanIntervalMs : 0)) {
        const last = scanState.windows.at(-1);
        if (last && scanState.windows.length >= SCAN_WINDOW_LIMIT) last[1] = at;
        else scanState.windows.push([Math.max(scanState.since, queuedUntil - budgets.adlScanOverlapMs), at]);
      }
      let note: string | null = null;
      for (let requests = 0; requests < budgets.adlScanRequests && scanState.windows.length; requests++) {
        const [from, to] = scanState.windows[0];
        let rows: AdlEvidenceRow[];
        try {
          const raw = await read(signal => venue().adlHistory(pair[side], { from, to }, venue().capabilities.historyPageLimit, { signal }));
          if (!Array.isArray(raw)) throw new Hold('ADL 历史返回结构无效');
          rows = raw.map(row => parseAdlEvidence(row, now(), tolerance));
        } catch (error) {
          if (isWriterLost(error)) throw error;
          note = `ADL 历史读取失败，保留待查时间窗 ${from}–${to}：${message(error)}`;
          scanState.windows.push(scanState.windows.shift() as [number, number]);
          break;
        }
        write(() => { for (const row of rows) mergeEvidence(pair, side, row, 'history'); });
        if (rows.length >= venue().capabilities.historyPageLimit) {
          if (to - from <= 1) { note = `ADL 历史在 ${from}–${to} 内满页且无法再细分，保留待查`; scanState.windows.push(scanState.windows.shift() as [number, number]); break; }
          const middle = Math.floor((from + to) / 2);
          scanState.windows.splice(0, 1, [from, middle], [middle, to]);
        } else {
          scanState.windows.shift();
          scanState.coveredUntil = Math.max(scanState.coveredUntil, to);
        }
      }
      write(() => {
        const current = readAdlPair(pair.id);
        if (!current || current.identity !== record.identity) return;
        current.scans[side] = { ...scanState, note, nextAt: scanState.windows.length ? now() + (note ? budgets.adlRetryMs : 0) : now() + budgets.adlScanIntervalMs };
        saveAdlPair(current);
        record.scans[side] = current.scans[side];
      });
    }
  }

  async function readScene(pair: PairRecord, symbols: readonly string[]): Promise<Record<PairSide, AdlAccountSnapshot>> {
    const [long, short] = await Promise.all(SIDES.map(side => read(signal => venue().account(pair[side], symbols, { signal }))
      .then(raw => parseAdlAccount(raw, pair[side], symbols, now(), tolerance))));
    return { long, short };
  }
  const sceneOf = (snapshots: Record<PairSide, AdlAccountSnapshot>): Scene => ({
    at: Math.min(snapshots.long.receivedAt, snapshots.short.receivedAt),
    positions: SIDES.flatMap(side => snapshots[side].positions.filter(row => row.direction).map(row => ({ side, symbol: row.symbol, positionSide: row.positionSide, direction: row.direction as Direction, quantity: row.quantity }))),
  });
  async function readRules(symbols: readonly string[]): Promise<Map<string, AdlRule | string>> {
    const rules = new Map<string, AdlRule | string>();
    for (const symbol of symbols) {
      // A rule that cannot be read stops every symbol for this pass: the scene would not be complete.
      const raw = await read(signal => venue().rule(symbol, { signal }));
      rules.set(symbol, parseAdlRule(raw, symbol));
    }
    return rules;
  }

  // ---- incidents -----------------------------------------------------------------
  function startIncident(pair: PairRecord, pending: Evidence[], parent: Incident | null): Incident {
    const at = now(), symbols = [...new Set([...pending.map(item => item.symbol), ...(parent?.symbols ?? [])])].sort();
    const incident: Incident = {
      id: randomUUID(), pairId: pair.id, identity: pair.identity, status: 'active', createdAt: at, updatedAt: at, symbols,
      evidence: pending.map(item => ({ key: item.key, filledQuantity: item.filledQuantity })), reason: '新的 ADL 事件，读取两侧持仓', haltReason: null, retryAt: 0,
      activeMs: 0, activeSince: at, restartedAt: at, restarts: 0, notSentStreak: 0, before: null, after: null, progress: {}, residuals: [],
      completedAt: null, watchUntil: null, closedAt: null, parentId: parent?.id ?? null,
    };
    db.prepare('INSERT INTO adl_incidents(id, pair_id, status, final, created_at, version, json) VALUES (?, ?, ?, 0, ?, 1, ?)').run(incident.id, pair.id, incident.status, at, JSON.stringify(incident));
    event(null, 'adl-incident-opened', { incident: incident.id, pair: pair.id, symbols, parent: incident.parentId });
    return incident;
  }
  /** Ends an incident. Unknown batches are closed with it unless a successor incident keeps watching them. */
  function close(incident: Incident, reason: string, keepUnknown: boolean): void {
    transition(incident, 'completed');
    incident.closedAt = now(); incident.watchUntil = null; incident.reason = reason;
    if (!keepUnknown) {
      for (const batch of openBatches(incident.pairId).filter(item => item.state === 'unknown-verified')) {
        Object.assign(batch, { state: 'unknown-closed', note: '观察期满仍无回执，结果未知，观察结束（原单从未重发）' });
        saveBatch(batch);
      }
    }
    saveIncident(incident);
    event(null, 'adl-incident-closed', { incident: incident.id, pair: incident.pairId, reason });
  }
  function block(id: string, reason: string, retryMs = budgets.adlRetryMs): void {
    write(() => {
      const incident = readIncident(id);
      if (!incident || incident.status === 'completed' || incident.status === 'watching') return;
      // A halted incident stays halted until a person restarts it; only its current reason changes.
      if (incident.status !== 'halted') transition(incident, 'blocked');
      for (const entry of Object.values(incident.progress)) if (entry.status === 'reducing' || entry.status === 'pending') Object.assign(entry, { status: 'held', reason });
      const changed = incident.reason !== reason;
      incident.reason = reason; incident.retryAt = now() + retryMs;
      saveIncident(incident);
      if (changed) event(null, 'adl-incident-blocked', { incident: id, reason });
    });
  }
  function halt(incident: Incident, reason: string): void {
    transition(incident, 'halted');
    incident.haltReason = reason; incident.reason = reason;
    for (const entry of Object.values(incident.progress)) if (entry.status === 'reducing' || entry.status === 'pending') Object.assign(entry, { status: 'held', reason });
    saveIncident(incident);
    event(null, 'adl-incident-halted', { incident: incident.id, reason });
  }

  // ---- batches -------------------------------------------------------------------
  /** Accepts a report for a batch; a report that goes backwards or changes identity is refused and blocks the incident. */
  function accept(batch: Batch, report: AdlOrderReport): void {
    const previous = batch.report;
    if (previous) {
      if (cmp(report.filledQuantity, previous.filledQuantity) < 0) reject('report_regress', `减仓批次 ${batch.clientOrderId} 累计成交数量倒退`, 409);
      if (report.orderId !== previous.orderId) reject('report_identity', `减仓批次 ${batch.clientOrderId} 交易所订单号发生变化`, 409);
      if (TERMINAL_ADL_ORDER.has(previous.status) && report.status !== previous.status) reject('report_regress', `减仓批次 ${batch.clientOrderId} 终态发生变化`, 409);
      // An equal or older report adds nothing.
      if (report.updateTime < previous.updateTime) return;
    }
    if (cmp(report.filledQuantity, previous?.filledQuantity ?? '0') > 0) batch.fill = { at: report.updateTime, after: previous ? previous.updateTime : batch.positionTime, seenAt: now() };
    batch.report = report;
    batch.verifiedAt = null;
    batch.state = report.status === 'rejected' ? 'rejected' : TERMINAL_ADL_ORDER.has(report.status) ? 'done' : 'open';
    if (batch.state === 'done' || batch.state === 'rejected') batch.note = null;
  }
  const parseReport = (raw: unknown, batch: Batch): AdlOrderReport =>
    parseAdlOrderReport(raw, { clientOrderId: batch.clientOrderId, symbol: batch.symbol, side: batch.orderSide, positionSide: batch.positionSide, quantity: batch.quantity }, now(), tolerance);
  function interrupt(batch: Batch): void {
    if (batch.state === 'prepared') Object.assign(batch, { state: 'not-sent', note: '中断：落盘后、发送前中断，传输未调用' });
    else if (batch.state === 'sending') Object.assign(batch, { state: 'unknown', recovered: true, note: '中断：发送中断，结果未知，按原客户订单号核对，不重发' });
    else return;
    saveBatch(batch);
    event(null, 'adl-batch-recovered', { batch: batch.id, state: batch.state });
  }
  /**
   * Marks the cancel intent before the call; only a provable not-sent takes it back. Each attempt is registered under its
   * own stamp, strictly above every earlier attempt of this process and stored as cancelRequestedAt, so a refused or
   * taken-back attempt never reuses a registry entry and settleRegistry reads an unmarked stamp as never sent.
   * Returns false when the registry refused it: nothing was marked and the caller goes on querying the order.
   */
  async function cancelBatch(batch: Batch): Promise<boolean> {
    const previous = { cancelRequestedAt: batch.cancelRequestedAt, cancels: batch.cancels, lastPossibleSendAt: batch.lastPossibleSendAt, postCancelQueries: batch.postCancelQueries, queryAfter: batch.queryAfter };
    const at = lastCancelStamp = Math.max(now(), lastCancelStamp + 1, (batch.cancelRequestedAt ?? 0) + 1, 1);
    inFlight.add(batch.id);
    try {
      let registered: WriterOperation | null = null;
      if (control) {
        try { registered = control.prepareAdlCancel(batch.accountId, batch.id, { symbol: batch.symbol, clientOrderId: batch.clientOrderId }, at); }
        catch (error) {
          if (!(error instanceof ControlRefusal)) throw error;
          cancelRefusedUntil.set(batch.id, now() + budgets.adlRetryMs);
          write(() => {
            const current = readBatch(batch.id);
            current.note = `撤单未发送：${message(error)}`;
            saveBatch(current);
            Object.assign(batch, current);
          });
          // Only a busy registry or an unresolved write clears by itself; any other refusal needs a person, and the
          // order's own queries still notice when that person has cancelled it.
          if (!error.transient) stuck(batch, `减仓批次 ${batch.clientOrderId} 撤单被账户写入登记拒绝（${error.registryCode}），需人工在交易所撤单`);
          return false;
        }
        cancelRefusedUntil.delete(batch.id);
      }
      try {
        write(() => {
          Object.assign(batch, { cancelRequestedAt: at, cancels: batch.cancels + 1, lastPossibleSendAt: Math.max(batch.lastPossibleSendAt ?? 0, at + budgets.adlOrderTimeoutMs), postCancelQueries: 0, queryAfter: at + budgets.adlQuerySpacingMs });
          saveBatch(batch);
          event(null, 'adl-batch-cancel', { batch: batch.id });
        });
      } catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
      const beforeSend = registered ? () => { assertWriter(); control?.assertSend(registered, budgets.adlOrderTimeoutMs); } : assertWriter;
      let outcome: { report: AdlOrderReport } | { error: unknown };
      try { outcome = { report: parseReport(await callVenue('write', signal => venue().cancel(batch.accountId, batch.symbol, batch.clientOrderId, { signal, beforeSend }), budgets.adlOrderTimeoutMs), batch) }; }
      catch (error) { if (isWriterLost(error)) throw error; outcome = { error }; }
      write(() => {
        const current = readBatch(batch.id);
        if ('report' in outcome) accept(current, outcome.report);
        else if (outcome.error instanceof VenueError && outcome.error.kind === 'not-sent') Object.assign(current, previous, { queryAfter: now() + budgets.adlQuerySpacingMs, note: `撤单未发送：${message(outcome.error)}` });
        else if (outcome.error instanceof ContractError) throw outcome.error;
        else current.note = `撤单结果未知或被拒绝：${message(outcome.error)}；继续按原客户订单号核对，仍在挂单时 ${Math.round(budgets.adlCancelAfterMs / 1000)} 秒后再撤（最多 ${ADL_CANCEL_LIMIT} 次）`;
        saveBatch(current);
        Object.assign(batch, current);
      });
      // A cancel never adds exposure: only a provable not-sent is rejected; anything else releases the account and the
      // batch's own queries decide what became of the order.
      if (registered) control?.finish(registered, 'error' in outcome && outcome.error instanceof VenueError && outcome.error.kind === 'not-sent' ? 'rejected' : 'confirmed');
      return true;
    } finally { inFlight.delete(batch.id); }
  }
  /**
   * A working batch is cancelled adlCancelAfterMs after its send, and again adlCancelAfterMs after each cancel that left it
   * working, at most ADL_CANCEL_LIMIT times. A cancel the registry refuses is not counted and waits adlRetryMs while the
   * order is still queried: a transient refusal is tried again then, any other also stops the open incident (see stuck).
   */
  const cancelDue = (batch: Batch, at: number): boolean => batch.state === 'open' && batch.cancels < ADL_CANCEL_LIMIT && at >= (cancelRefusedUntil.get(batch.id) ?? 0)
    && at - (batch.cancelRequestedAt ?? batch.sentAt ?? at) >= budgets.adlCancelAfterMs;
  /**
   * A batch a query still finds working after every cancel stops the pair's open incident (which may be a later one than the
   * batch's own): a person cancels it at the venue, then restarts. A watching incident keeps watching and says why.
   */
  function haltOnStuck(batch: Batch, at: number): void {
    if (batch.state !== 'open' || batch.cancels < ADL_CANCEL_LIMIT || at - (batch.cancelRequestedAt ?? at) < budgets.adlCancelAfterMs) return;
    stuck(batch, `减仓批次 ${batch.clientOrderId} 撤单 ${batch.cancels} 次后仍在挂单，需人工在交易所撤单`);
  }
  function stuck(batch: Batch, reason: string): void {
    write(() => {
      const incident = openIncident(batch.pairId);
      if (!incident) return;
      if (incident.status === 'active' || incident.status === 'blocked') halt(incident, `${reason}；挂单结束后再重新开始自动减仓`);
      else if (incident.status === 'watching' && !(incident.reason ?? '').includes(reason)) { incident.reason = `${incident.reason ?? ''}；${reason}`.replace(/^；/, ''); saveIncident(incident); event(null, 'adl-batch-stuck', { batch: batch.id, incident: incident.id }); }
    });
  }
  /**
   * One bounded recovery step of an open or unknown batch: query by the original client id at most adlQueryLimit times
   * adlQuerySpacingMs apart, cancel a working order adlCancelAfterMs after its send, and after adlObservationMs past the
   * last possible send hand an answerless batch to fresh positions. Returns whether it is settled or verified.
   */
  async function reconcileBatch(batch: Batch): Promise<boolean> {
    const at = now();
    if (batch.state === 'unknown-verified') {
      // Late receipts revoke the verification; looked for at the slow pace only.
      if (at < batch.activeQueryAfter) return true;
    } else {
      const anchor = Math.max(batch.sentAt ?? batch.preparedAt, batch.lastPossibleSendAt ?? 0, batch.cancelRequestedAt ?? 0);
      if (at < batch.queryAfter) return false;
      if (cancelDue(batch, at) && await cancelBatch(batch)) return SETTLED_BATCH.has(batch.state);
      const count = batch.cancelRequestedAt !== null ? batch.postCancelQueries : batch.queries;
      if (count >= budgets.adlQueryLimit && !batch.report) {
        if (at < anchor || at - anchor < budgets.adlObservationMs) return false;
        write(() => {
          const current = readBatch(batch.id);
          Object.assign(current, { state: 'unknown-verified', verifiedAt: now(), activeQueryAfter: now() + budgets.adlActiveQueryMs,
            note: `按原客户订单号查询 ${count} 次（含读取失败）且观察 ${Math.round(budgets.adlObservationMs / 1000)} 秒仍无回执；按新现场继续，原单不重发，迟到回执会撤销此判定` });
          saveBatch(current);
          Object.assign(batch, current);
          event(null, 'adl-batch-verified-unknown', { batch: batch.id });
        });
        return true;
      }
      if (count >= budgets.adlQueryLimit && at < batch.activeQueryAfter) return false;
    }
    write(() => {
      const current = readBatch(batch.id), key = current.cancelRequestedAt !== null ? 'postCancelQueries' : 'queries';
      if (current.state !== 'unknown-verified') current[key] = Math.min(budgets.adlQueryLimit, current[key] + 1);
      current.queryAfter = now() + budgets.adlQuerySpacingMs;
      if (current.state === 'unknown-verified' || (current.report && current[key] >= budgets.adlQueryLimit)) current.activeQueryAfter = now() + budgets.adlActiveQueryMs;
      saveBatch(current);
      Object.assign(batch, current);
    });
    let note: string | null = null, report: AdlOrderReport | null = null;
    try {
      const raw = await read(signal => venue().query(batch.accountId, batch.symbol, batch.clientOrderId, { signal }));
      if (raw === null) note = '交易所查无该客户订单号（不能证明未发送），继续有界核对';
      else report = parseReport(raw, batch);
    } catch (error) {
      if (error instanceof ContractError || isWriterLost(error)) throw error;
      note = `按原客户订单号查询失败：${message(error)}`;
    }
    write(() => {
      const current = readBatch(batch.id);
      if (report) { const before = current.state; accept(current, report); if (before === 'unknown-verified') event(null, 'adl-batch-late-report', { batch: batch.id, state: current.state }); }
      else if (current.state !== 'unknown-verified') current.note = note;
      saveBatch(current);
      Object.assign(batch, current);
    });
    if (cancelDue(batch, now())) await cancelBatch(batch);
    else if (report) haltOnStuck(batch, now());
    if (SETTLED_BATCH.has(batch.state)) cancelRefusedUntil.delete(batch.id);
    return SETTLED_BATCH.has(batch.state) || batch.state === 'unknown-verified';
  }
  /** Brings every unsettled batch of the pair one step forward; true when none is still waiting for an answer. */
  async function settleBatches(pairId: string): Promise<boolean> {
    let ready = true;
    for (const batch of openBatches(pairId)) {
      if ((batch.state === 'prepared' || batch.state === 'sending') && !inFlight.has(batch.id)) write(() => { const current = readBatch(batch.id); interrupt(current); Object.assign(batch, current); });
      if (batch.state === 'prepared' || batch.state === 'sending') { ready = false; continue; }
      if (SETTLED_BATCH.has(batch.state)) continue;
      if (!(await reconcileBatch(batch))) ready = false;
    }
    return ready;
  }

  // ---- evaluation ----------------------------------------------------------------
  function sharedWith(pair: PairRecord, list: PairRecord[]): string | null {
    const other = list.find(item => item.id !== pair.id && SIDES.some(side => SIDES.some(otherSide => item[otherSide] === pair[side])));
    return other ? `子账户与配对 ${other.id} 共用，两个配对会对同一持仓重复减仓，ADL 不自动处理，需人工核对` : null;
  }
  /** Every captured ADL fill and every recent batch fill must be visible in the positions' venue update times (L054). */
  function requireReflected(pairId: string, incident: Incident, snapshots: Record<PairSide, AdlAccountSnapshot>): void {
    const updated = (side: PairSide, symbol: string, positionSide: AdlPositionSide): number =>
      snapshots[side].positions.find(row => row.symbol === symbol && row.positionSide === positionSide)?.updateTime ?? -1;
    // The first report that shows a fill may already be the cancel of the rest, later than the fill itself. When the position moved
    // after a moment the fill was known smaller and adlObservationMs has passed since the fill was seen, a stale read has had its
    // time to clear, so that position counts as reflecting it.
    const reflected = (position: number, fill: FillMark): boolean =>
      position >= fill.at || (fill.after !== null && position > fill.after && now() - fill.seenAt >= budgets.adlObservationMs);
    for (const { key } of incident.evidence) {
      const evidence = readEvidence(key);
      if (evidence?.fill && !reflected(updated(evidence.side, evidence.symbol, evidence.positionSide), evidence.fill)) {
        throw new Hold(`${evidence.symbol} ${SIDE_NAMES[evidence.side]}持仓更新时间尚未覆盖 ADL 成交，等待交易所现场同步`);
      }
    }
    for (const batch of recentFilled(pairId)) {
      if (batch.fill && !reflected(updated(batch.side, batch.symbol, batch.positionSide), batch.fill)) throw new Hold(`${batch.symbol} 减仓成交尚未反映到${SIDE_NAMES[batch.side]}持仓，等待新的现场，暂不继续减仓`);
    }
  }

  async function evaluate(pair: PairRecord, list: PairRecord[], incidentId: string): Promise<void> {
    const initial = requireIncident(incidentId);
    if (now() < initial.retryAt) return;
    try {
      const shared = sharedWith(pair, list);
      if (shared) throw new Hold(shared);
      const conflict = pendingEvidence(pair.id).find(item => item.conflict);
      if (conflict) throw new Hold(`ADL 证据冲突（${conflict.symbol} 订单 ${conflict.orderId}：${conflict.conflict}），需人工核对`);
      if (!(await settleBatches(pair.id))) {
        write(() => { const incident = requireIncident(incidentId); if (incident.status === 'completed' || incident.status === 'watching' || incident.status === 'halted') return; incident.reason = '正在按原客户订单号核对减仓批次，确认结果后才发送下一批'; saveIncident(incident); });
        return;
      }
      // A halted incident sends nothing either way, so a transfer on the wire does not replace its reason.
      if (initial.status !== 'halted' && transferSending?.(pair.id)) throw new Hold(TRANSFER_SENDING, TRANSFER_WAIT_MS);
      const version = incidentVersion(incidentId), signature = evidenceSignature(pair.id);
      const incident = requireIncident(incidentId), symbols = incident.symbols;
      const snapshots = await readScene(pair, symbols);
      requireReflected(pair.id, incident, snapshots);
      const busy = SIDES.flatMap(side => snapshots[side].openOrders.filter(order => symbols.includes(order.symbol)).map(order => `${SIDE_NAMES[side]} ${order.symbol}`));
      if (busy.length) throw new Hold(`事件合约有未完成挂单（${busy.join('、')}），等待挂单结束后再减仓`);
      const imbalanced = symbols.filter(symbol => !isZero(net([...snapshots.long.positions, ...snapshots.short.positions], symbol)));
      const config = ensurePair(pair).config;
      const { plan, progress } = planReductions({ long: snapshots.long.positions, short: snapshots.short.positions }, symbols, await readRules(imbalanced), config.batchNotional);
      const scene = sceneOf(snapshots);
      if (Object.values(progress).every(entry => entry.status === 'balanced' || entry.status === 'residual')) { complete(pair, incidentId, version, signature, scene, progress); return; }
      if (!config.autoReduce) {
        for (const entry of Object.values(progress)) if (entry.status === 'reducing' || entry.status === 'pending') entry.status = 'manual';
        record(incidentId, scene, progress);
        throw new Hold('自动减仓已关闭：只核对持仓，等待手工平衡（两侧平衡后事件自动完成）');
      }
      const recorded = record(incidentId, scene, progress);
      const blockedReasons = Object.entries(progress).filter(([, entry]) => entry.status === 'blocked').map(([, entry]) => entry.reason);
      if (!plan) throw new Hold(`${blockedReasons.join('；')}；已保留现场`);
      const halted = write(() => checkHalt(incidentId));
      if (halted) return;
      if (!snapshots[plan.side].canTrade) throw new Hold(`${SIDE_NAMES[plan.side]}子账户没有交易权限，已保留现场`);
      if (now() - scene.at > budgets.adlSceneMaxAgeMs) throw new Hold('两侧持仓读取已超过有效期，重新读取', 0);
      await send(pair, incidentId, recorded, signature, config, plan, blockedReasons);
    } catch (error) {
      if (isWriterLost(error)) throw error;
      block(incidentId, error instanceof Hold || error instanceof ContractError ? message(error) : `ADL 处理出错：${message(error)}`, error instanceof Hold && error.retryMs !== null ? error.retryMs : budgets.adlRetryMs);
    }
  }
  /** Returns the incident version after the write; a batch is only prepared while nothing else changed the incident since. */
  function record(incidentId: string, scene: Scene, progress: Record<string, SymbolProgress>): number {
    return write(() => {
      const incident = requireIncident(incidentId);
      if (incident.status === 'completed' || incident.status === 'watching') return -1;
      incident.before ??= scene;
      incident.after = scene;
      // A halted incident keeps showing why nothing is sent.
      if (incident.status === 'halted') for (const entry of Object.values(progress)) if (entry.status === 'reducing' || entry.status === 'pending') Object.assign(entry, { status: 'held', reason: incident.haltReason });
      incident.progress = progress;
      saveIncident(incident);
      return incidentVersion(incidentId);
    });
  }
  /** Halt conditions count only batches since the incident started or was last restarted. Returns true when it is halted. */
  function checkHalt(incidentId: string): boolean {
    const incident = requireIncident(incidentId);
    if (incident.status === 'halted') return true;
    const sent = batchesOf(incidentId).filter(batch => batch.preparedAt >= incident.restartedAt && batch.state !== 'not-sent' && batch.state !== 'prepared');
    const last = sent.at(-1);
    if (last?.state === 'rejected') { halt(incident, `最后一批被交易所拒绝（${(last.note ?? '').slice(0, 80)}），已停止自动减仓并保留现场`); return true; }
    if (activeElapsed(incident) >= budgets.adlMaxActiveMs || sent.length >= budgets.adlMaxBatches) { halt(incident, 'ADL 自动减仓达到处理时限或批次数上限，已保留剩余仓位与完整记录'); return true; }
    const recent = sent.slice(-3);
    if (recent.length === 3 && recent.every(batch => batch.state === 'done' && batch.report && isZero(batch.report.filledQuantity))) { halt(incident, '连续三批未成交，已停止自动重试并保留现场'); return true; }
    if (incident.notSentStreak >= budgets.adlNotSentLimit) { halt(incident, `连续 ${incident.notSentStreak} 批未能发出，已停止自动重试并保留现场`); return true; }
    return false;
  }

  async function send(pair: PairRecord, incidentId: string, version: number, signature: string, config: AdlConfig, plan: AdlPlan, blockedReasons: (string | undefined)[]): Promise<void> {
    const at = now();
    const batch: Batch = {
      id: randomUUID(), incidentId, pairId: pair.id, side: plan.side, accountId: pair[plan.side], symbol: plan.symbol, positionSide: plan.positionSide,
      orderSide: plan.direction === 'long' ? 'sell' : 'buy', direction: plan.direction, quantity: plan.quantity, clientOrderId: clientOrderId(),
      positionBefore: plan.positionBefore, excessBefore: plan.excessBefore, markPrice: plan.markPrice, positionTime: plan.positionTime, state: 'prepared', preparedAt: at, sentAt: null, lastPossibleSendAt: null,
      report: null, fill: null, queries: 0, postCancelQueries: 0, queryAfter: 0, activeQueryAfter: 0, cancelRequestedAt: null, cancels: 0, verifiedAt: null, recovered: false, note: null,
    };
    // Everything the plan was made from must still hold when the batch is persisted.
    const prepared = write(() => {
      const incident = readIncident(incidentId);
      if (!incident || incidentVersion(incidentId) !== version) return false;
      if (incident.status === 'halted' || incident.status === 'watching' || incident.status === 'completed') return false;
      const current = readAdlPair(pair.id);
      if (!current || current.identity !== pair.identity || JSON.stringify(current.config) !== JSON.stringify(config)) return false;
      if (pairs().find(item => item.id === pair.id)?.identity !== pair.identity) return false;
      if (evidenceSignature(pair.id) !== signature) return false;
      if (openBatches(pair.id).some(item => item.state !== 'unknown-verified')) return false;
      // A transfer that started while the scene was read: the next pass shows why it waits.
      if (transferSending?.(pair.id)) return false;
      db.prepare('INSERT INTO adl_batches(id, incident_id, pair_id, client_order_id, state, settled, created_at, version, json) VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)')
        .run(batch.id, incidentId, pair.id, batch.clientOrderId, batch.state, at, JSON.stringify(batch));
      transition(incident, 'active');
      incident.reason = `正在分批市价减少 ${plan.symbol} 多出的${DIRECTION_NAMES[plan.direction]}仓（本批 ${plan.quantity}）` + (blockedReasons.length ? `；受阻合约保留现场：${blockedReasons.join('；')}` : '');
      incident.retryAt = 0;
      saveIncident(incident);
      event(null, 'adl-batch-prepared', { incident: incidentId, batch: batch.id, symbol: plan.symbol, side: plan.side, quantity: plan.quantity });
      inFlight.add(batch.id);
      return true;
    });
    if (!prepared) return;
    try {
      let registered: WriterOperation | null = null;
      if (control) {
        try { registered = control.prepareAdlOrder(batch.accountId, batch.id, { clientOrderId: batch.clientOrderId, symbol: batch.symbol, side: batch.orderSide, positionSide: batch.positionSide, quantity: batch.quantity }); }
        catch (error) {
          if (!(error instanceof ControlRefusal)) throw error;
          write(() => {
            const current = readBatch(batch.id), incident = requireIncident(incidentId);
            Object.assign(current, { state: 'not-sent', note: message(error) });
            // A refusal that clears by itself (an unknown transfer of the pair gates the account until it expires or settles)
            // waits like any other hold instead of counting toward the not-sent halt.
            if (error.transient) incident.retryAt = now() + budgets.adlRetryMs;
            else { incident.notSentStreak += 1; incident.retryAt = now() + budgets.adlNotSentRetryMs; }
            saveBatch(current); saveIncident(incident);
            event(null, 'adl-batch-sent', { batch: batch.id, state: current.state, control: error.registryCode });
          });
          return;
        }
      }
      // A registered entry whose send never starts is rejected here; settleRegistry repeats it if this finish fails.
      try {
        write(() => {
          const current = readBatch(batch.id);
          current.state = 'sending'; current.sentAt = now(); current.lastPossibleSendAt = current.sentAt + budgets.adlOrderTimeoutMs;
          saveBatch(current);
          Object.assign(batch, current);
        });
      } catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
      const request: AdlOrderRequest = { clientOrderId: batch.clientOrderId, symbol: batch.symbol, side: batch.orderSide, positionSide: batch.positionSide, quantity: batch.quantity, reduceOnly: true, type: 'market' };
      const beforeSend = registered ? () => { assertWriter(); control?.assertSend(registered, budgets.adlOrderTimeoutMs); } : assertWriter;
      let outcome: { report: AdlOrderReport } | { error: unknown };
      try { outcome = { report: parseReport(await callVenue('write', signal => venue().place(batch.accountId, request, { signal, beforeSend }), budgets.adlOrderTimeoutMs), batch) }; }
      catch (error) { if (isWriterLost(error)) throw error; outcome = { error }; }
      const state = write(() => {
        const current = readBatch(batch.id), incident = requireIncident(incidentId);
        if ('report' in outcome) { accept(current, outcome.report); current.lastPossibleSendAt = Math.min(current.lastPossibleSendAt ?? now(), now()); }
        else if (outcome.error instanceof VenueError && outcome.error.kind === 'not-sent') {
          Object.assign(current, { state: 'not-sent', note: message(outcome.error) });
          incident.notSentStreak += 1; incident.retryAt = now() + budgets.adlNotSentRetryMs;
        } else if (outcome.error instanceof VenueError && outcome.error.kind === 'rejected') Object.assign(current, { state: 'rejected', note: message(outcome.error) });
        else Object.assign(current, { state: 'unknown', note: `减仓结果未知（${message(outcome.error)}），按原客户订单号核对，不重发` });
        if (current.state !== 'not-sent') incident.notSentStreak = 0;
        saveBatch(current); saveIncident(incident);
        event(null, 'adl-batch-sent', { batch: batch.id, state: current.state, filledQuantity: current.report?.filledQuantity ?? null });
        return current.state;
      });
      if (registered) control?.finish(registered, adlRegistryOutcome(state) ?? 'unknown');
    } finally { inFlight.delete(batch.id); }
  }

  function complete(pair: PairRecord, incidentId: string, version: number, signature: string, scene: Scene, progress: Record<string, SymbolProgress>): void {
    write(() => {
      const incident = requireIncident(incidentId);
      if (incident.status === 'completed' || incident.status === 'watching' || incidentVersion(incidentId) !== version) return;
      // New or grown evidence since the scene was read is first included and checked in the next pass.
      const pending = pendingEvidence(pair.id);
      if (evidenceSignature(pair.id) !== signature || pending.some(item => item.conflict || incident.evidence.find(captured => captured.key === item.key)?.filledQuantity !== item.filledQuantity)) return;
      for (const item of pending) { item.handledQuantity = item.filledQuantity; saveEvidence(item); }
      const at = now();
      incident.before ??= scene;
      incident.after = scene; incident.progress = progress; incident.completedAt = at; incident.haltReason = null;
      incident.residuals = Object.entries(progress).filter(([, entry]) => entry.status === 'residual' && entry.direction).map(([symbol, entry]) => ({ symbol, quantity: entry.residual, direction: entry.direction as Direction }));
      const residualText = incident.residuals.length ? `；残差 ${incident.residuals.map(item => `${item.symbol} 多出${DIRECTION_NAMES[item.direction]}仓 ${item.quantity}`).join('、')}（小于最小下单量，记为完成）` : '';
      const unknown = openBatches(pair.id).filter(batch => batch.state === 'unknown-verified');
      const until = unknown.length ? Math.max(...unknown.map(batch => batch.lastPossibleSendAt ?? batch.sentAt ?? batch.preparedAt)) + budgets.adlWatchMs : null;
      event(null, 'adl-incident-completed', { incident: incidentId, residuals: incident.residuals, unknown: unknown.length });
      if (until !== null && until > at) {
        transition(incident, 'watching');
        incident.watchUntil = until; incident.retryAt = at + budgets.adlWatchSceneMs;
        incident.reason = `多空总量已一致${residualText}；${unknown.length} 笔结果未知的减仓单继续观察到 ${new Date(until).toISOString()}，期间再现净差即开新事件`;
        saveIncident(incident);
      } else close(incident, `多空总量已一致${residualText}`, false);
    });
  }

  /** A completed incident with unknown batches: their late reports and any new net difference are watched until watchUntil. */
  async function watch(pair: PairRecord, incidentId: string): Promise<void> {
    const incident = requireIncident(incidentId);
    // A late report can turn a verified batch back into a working one; the watch ends only after it settles again.
    const live = openBatches(pair.id).some(batch => batch.state !== 'unknown-verified');
    if (now() >= (incident.watchUntil ?? 0) && !live) { write(() => { const current = requireIncident(incidentId); if (current.status === 'watching') close(current, `${current.reason ?? ''}；观察期满，自动关闭`.replace(/^；/, ''), false); }); return; }
    if (now() < incident.retryAt) return;
    try {
      await settleBatches(pair.id);
      const snapshots = await readScene(pair, incident.symbols);
      const positions = [...snapshots.long.positions, ...snapshots.short.positions];
      const expected = (symbol: string): string => { const residual = incident.residuals.find(item => item.symbol === symbol); return residual ? (residual.direction === 'long' ? residual.quantity : sub('0', residual.quantity)) : '0'; };
      const moved = incident.symbols.filter(symbol => cmp(net(positions, symbol), expected(symbol)) !== 0);
      write(() => {
        const current = requireIncident(incidentId);
        if (current.status !== 'watching') return;
        if (moved.length) {
          close(current, `观察期内 ${moved.join('、')} 出现新的净差，转入新事件`, true);
          startIncident(pair, [], current);
        } else { current.retryAt = now() + budgets.adlWatchSceneMs; saveIncident(current); }
      });
    } catch (error) {
      if (isWriterLost(error)) throw error;
      write(() => { const current = requireIncident(incidentId); if (current.status !== 'watching') return; current.retryAt = now() + budgets.adlWatchSceneMs; saveIncident(current); });
      throw error;
    }
  }

  async function processPair(pair: PairRecord, list: PairRecord[]): Promise<void> {
    const record = ensurePair(pair);
    await scan(pair, record);
    const pending = pendingEvidence(pair.id);
    let incident = openIncident(pair.id);
    if (!incident) {
      if (!pending.length) { if (openBatches(pair.id).length) await settleBatches(pair.id); return; }
      incident = write(() => openIncident(pair.id) ?? startIncident(pair, pending, null));
    } else if (incident.status === 'watching') {
      if (!pending.length) { await watch(pair, incident.id); return; }
      const parent = incident;
      incident = write(() => {
        const current = requireIncident(parent.id);
        if (current.status !== 'watching') return current;
        close(current, '观察期内收到新的 ADL 证据，转入新事件', true);
        return startIncident(pair, pending, current);
      });
    } else if (pending.some(item => incident!.evidence.find(captured => captured.key === item.key)?.filledQuantity !== item.filledQuantity)) {
      const id = incident.id;
      write(() => {
        const current = requireIncident(id);
        for (const item of pendingEvidence(pair.id)) {
          const captured = current.evidence.find(entry => entry.key === item.key);
          if (captured) captured.filledQuantity = item.filledQuantity; else current.evidence.push({ key: item.key, filledQuantity: item.filledQuantity });
          if (!current.symbols.includes(item.symbol)) current.symbols = [...current.symbols, item.symbol].sort();
        }
        current.retryAt = 0;
        saveIncident(current);
        event(null, 'adl-incident-evidence', { incident: id, symbols: current.symbols });
      });
    }
    await evaluate(pair, list, incident.id);
  }

  // ---- public ----------------------------------------------------------------------
  /** Runs inside the takeover transaction: a new writer cannot know what was sent after the last commit. */
  function recover(): void {
    for (const row of db.prepare("SELECT json FROM adl_batches WHERE state IN ('prepared', 'sending')").all() as { json: string }[]) interrupt(JSON.parse(row.json) as Batch);
    for (const row of db.prepare("SELECT json FROM adl_incidents WHERE final = 0 AND status = 'active'").all() as { json: string }[]) {
      const incident = JSON.parse(row.json) as Incident;
      // Time while no writer ran is not active time; the last commit bounds what was.
      if (incident.activeSince !== null) { incident.activeMs += Math.max(0, incident.updatedAt - incident.activeSince); incident.activeSince = now(); }
      incident.retryAt = 0;
      saveIncident(incident);
    }
    inFlight.clear();
  }

  /**
   * Resolves this module's open registry entries of reduction orders and cancels from local facts: after a failed finish,
   * a takeover, or once an unknown batch is settled or verified. Entries of a batch being sent or without a record stay.
   */
  function settleRegistry(): void {
    if (!control) return;
    let ids: string[];
    try { ids = control.asterPending().filter(id => id.startsWith(ADL_OPERATION_PREFIX) || id.startsWith(ADL_CANCEL_OPERATION_PREFIX)); }
    catch (error) { if (isWriterLost(error)) throw error; return; }
    for (const operationId of ids) {
      const parsed = parseAdlOperationId(operationId);
      const row = parsed && db.prepare('SELECT json FROM adl_batches WHERE client_order_id = ?').get(parsed.clientOrderId) as { json: string } | undefined;
      if (!parsed || !row) continue;
      let batch: Batch;
      try { batch = JSON.parse(row.json) as Batch; } catch { continue; }
      if (inFlight.has(batch.id)) continue;
      // A cancel attempt whose stamp was never marked (or was taken back as not sent) never left this process; a later
      // attempt's mark also reads as sent, which only errs towards confirmed.
      const outcome = parsed.kind === 'create' ? adlRegistryOutcome(batch.state) : (batch.cancelRequestedAt ?? 0) < parsed.stamp ? 'rejected' : 'confirmed';
      if (!outcome) continue;
      try { control.asterResolve([batch.accountId], operationId, outcome); write(() => event(null, 'adl-control-resolved', { batch: batch.id, operationId, outcome })); }
      catch (error) { if (isWriterLost(error) || !(error instanceof ControlRefusal)) throw error; }
    }
  }

  async function tick(): Promise<void> {
    if (!connector) return;
    settleRegistry();
    const list = pairs();
    flushPushed(list);
    const started = performance.now();
    const start = resumeAfter ? list.findIndex(pair => pair.id > (resumeAfter as string)) : 0;
    const ordered = start > 0 ? [...list.slice(start), ...list.slice(0, start)] : list;
    resumeAfter = null;
    for (const pair of ordered) {
      if (performance.now() - started >= budgets.adlTickBudgetMs) break;
      try { await processPair(pair, list); }
      catch (error) {
        if (isWriterLost(error)) throw error;
        const reason = message(error), at = now(), last = failures.get(pair.id);
        if (!last || last.reason !== reason || at - last.at >= FAILURE_EVENT_MS) {
          failures.set(pair.id, { reason, at });
          write(() => event(null, 'adl-pair-failed', { pair: pair.id, reason }));
        }
      }
      resumeAfter = pair.id;
    }
    if (resumeAfter === ordered.at(-1)?.id) resumeAfter = null;
    settleRegistry();
  }

  /** Why a pair's accounts cannot be changed now (an unfinished incident or unhandled evidence), or null. */
  function busy(pairId: string): string | null {
    if (db.prepare('SELECT 1 FROM adl_incidents WHERE pair_id = ? AND final = 0').get(pairId)) return '配对有未结束的 ADL 事件，结束后才能更换账户';
    if (db.prepare('SELECT 1 FROM adl_evidence WHERE pair_id = ? AND pending = 1 LIMIT 1').get(pairId)) return '配对有尚未处理的 ADL 成交证据，处理后才能更换账户';
    if (db.prepare('SELECT 1 FROM adl_batches WHERE pair_id = ? AND settled = 0 LIMIT 1').get(pairId)) return '配对有未结清的 ADL 减仓批次，结清后才能更换账户';
    return null;
  }

  const commandReplayed = (requestId: string, payload: string, session: string): boolean => {
    const existing = db.prepare('SELECT digest, session FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
    if (existing && (existing.digest !== payload || existing.session !== session)) reject('request_reused', '请求编号已用于其他内容', 409);
    return !!existing;
  };
  const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  /** Durable, idempotent change of a pair's ADL settings; it applies from the next evaluation. */
  function setConfig(input: unknown, session: string) {
    const raw = exactKeys(input, ['pairId', 'requestId', 'autoReduce', 'batchNotional']);
    const pairId = text(raw.pairId, '配对编号', PAIR_ID), requestId = raw.requestId;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return reject('request_id', '请求编号无效');
    const config = parseAdlConfig({ autoReduce: raw.autoReduce, batchNotional: raw.batchNotional });
    const payload = digest({ kind: 'adl-config', pairId, config });
    return write(() => {
      const pair = pairs().find(item => item.id === pairId) ?? reject('pair_missing', '划转配对不存在', 404);
      if (!commandReplayed(requestId, payload, session)) {
        const record = installPair(pair);
        db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'adl-config', payload, session, pairId, now());
        record.config = config;
        saveAdlPair(record);
        const open = openIncident(pairId);
        if (open && open.status === 'blocked') { open.retryAt = 0; saveIncident(open); }
        event(null, 'adl-config-changed', { pair: pairId, ...config, requestId });
      }
      return pairView(pair, pairs());
    });
  }

  /** The manual way out of a halted incident: time and batch limits start again, every guard still applies. */
  function restart(input: unknown, session: string) {
    const raw = exactKeys(input, ['incidentId', 'requestId']);
    const incidentId = text(raw.incidentId, '事件编号', UUID), requestId = raw.requestId;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return reject('request_id', '请求编号无效');
    const payload = digest({ kind: 'adl-restart', incidentId });
    return write(() => {
      if (!commandReplayed(requestId, payload, session)) {
        const incident = requireIncident(incidentId);
        if (incident.status !== 'halted') reject('adl_not_halted', '只有已停止自动减仓的事件可以重新开始', 409);
        db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'adl-restart', payload, session, incidentId, now());
        transition(incident, 'blocked');
        Object.assign(incident, { activeMs: 0, activeSince: null, restartedAt: now(), restarts: incident.restarts + 1, notSentStreak: 0, haltReason: null, retryAt: 0, reason: '已人工重新开始自动减仓，重新核对现场' });
        saveIncident(incident);
        event(null, 'adl-incident-restarted', { incident: incidentId, requestId });
      }
      return incidentView(requireIncident(incidentId));
    });
  }

  // ---- views ---------------------------------------------------------------------
  const maskScene = (scene: Scene | null) => scene && { at: scene.at, positions: scene.positions };
  function batchView(batch: Batch) {
    return { id: batch.id, side: batch.side, account: maskId(batch.accountId), symbol: batch.symbol, positionSide: batch.positionSide, orderSide: batch.orderSide, direction: batch.direction,
      quantity: batch.quantity, filledQuantity: batch.report?.filledQuantity ?? null, averagePrice: batch.report?.averagePrice ?? null, orderStatus: batch.report?.status ?? null,
      state: batch.state, clientOrderId: batch.clientOrderId, preparedAt: batch.preparedAt, sentAt: batch.sentAt, queries: batch.queries + batch.postCancelQueries,
      cancelRequested: batch.cancelRequestedAt !== null, recovered: batch.recovered, note: batch.note, positionBefore: batch.positionBefore, excessBefore: batch.excessBefore };
  }
  function evidenceView(evidence: Evidence) {
    return { side: evidence.side, account: maskId(evidence.accountId), symbol: evidence.symbol, positionSide: evidence.positionSide, orderId: evidence.orderId, direction: evidence.direction, quantity: evidence.quantity,
      filledQuantity: evidence.filledQuantity, handledQuantity: evidence.handledQuantity, status: evidence.status, updateTime: evidence.updateTime, sources: evidence.sources, conflict: evidence.conflict };
  }
  function incidentView(incident: Incident) {
    const batches = batchesOf(incident.id);
    return {
      id: incident.id, pairId: incident.pairId, status: incident.status, reason: incident.reason, haltReason: incident.haltReason, createdAt: incident.createdAt, completedAt: incident.completedAt,
      closedAt: incident.closedAt, watchUntil: incident.watchUntil, parentId: incident.parentId, symbols: incident.symbols, activeMs: activeElapsed(incident), restarts: incident.restarts,
      batchesSinceRestart: batches.filter(batch => batch.preparedAt >= incident.restartedAt && batch.state !== 'not-sent').length, totalBatches: batches.length,
      progress: incident.progress, residuals: incident.residuals, before: maskScene(incident.before), after: maskScene(incident.after),
      evidence: incident.evidence.map(item => readEvidence(item.key)).filter((item): item is Evidence => !!item).map(evidenceView),
      batches: batches.slice(-20).reverse().map(batchView),
    };
  }
  function pairView(pair: PairRecord, list: PairRecord[]) {
    const record = readAdlPair(pair.id), open = openIncident(pair.id);
    const candidates = (db.prepare('SELECT json FROM adl_evidence WHERE pair_id = ? ORDER BY updated_at DESC LIMIT 20').all(pair.id) as { json: string }[])
      .map(row => JSON.parse(row.json) as Evidence).filter(item => isZero(item.filledQuantity) && !item.conflict).map(evidenceView);
    return {
      pairId: pair.id, long: maskId(pair.long), short: maskId(pair.short), config: record?.config ?? { ...DEFAULT_ADL_CONFIG }, shared: sharedWith(pair, list),
      scans: record ? Object.fromEntries(SIDES.map(side => [side, { coveredUntil: record.scans[side].coveredUntil, pendingWindows: record.scans[side].windows.length, nextAt: record.scans[side].nextAt, note: record.scans[side].note }])) : null,
      incident: open ? incidentView(open) : null, candidates,
    };
  }

  return {
    recover, tick, busy, setConfig, restart,
    /** Why a batch of the pair is on the wire (persisted for sending, sent or resting), or null; the pair's transfers wait for it. */
    sending: (pairId: string): string | null => db.prepare("SELECT 1 FROM adl_batches WHERE pair_id = ? AND settled = 0 AND state IN ('prepared', 'sending', 'open') LIMIT 1").get(pairId) ? 'ADL 减仓单正在发送或挂单' : null,
    pairs: () => { const list = pairs(); return list.map(pair => pairView(pair, list)); },
    incident: (id: string) => incidentView(requireIncident(id)),
    recent: (limit = 10) => (db.prepare('SELECT json FROM adl_incidents ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(Math.max(1, Math.trunc(limit)), 50)) as { json: string }[])
      .map(row => incidentView(JSON.parse(row.json) as Incident)),
    close: () => { unsubscribe?.(); },
  };
}
export type Adl = ReturnType<typeof createAdl>;
