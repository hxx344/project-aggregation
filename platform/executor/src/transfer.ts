// ASTER margin balancing: moves USD1 between the two sub-accounts of a pair so
// their available balances stay level. The venue gives a transfer no client id,
// so a send without a usable answer is never resent and never queried by
// identity: it waits until the signed request can no longer be accepted, is
// then labeled once from both accounts' receipts and settled whatever was read.
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { cmp, floorToStep, fromUnits, min, sub, units } from './decimal.ts';
import {
  ContractError, PAIR_ID, TRANSFER_ASSET, TRANSFER_UNIT, UUID, exactKeys, parseSubAccountList, parseTransferBalance, parseTransferHistory, parseTransferPair, reject, text,
  type PairSide, type TransferBalance, type TransferConfig, type TransferPairInput, type TransferReceipt,
} from './contracts.ts';
import { VenueError, parseTransferAck, type TransferAck, type TransferConnector } from './connector.ts';

/**
 * prepared: persisted, transport not called. sending: transport may have been called.
 * acknowledged: the venue answered success; only the balances are read again, nothing is ever resent.
 * unknown: sent without a usable answer; settled from receipts once the request has expired.
 * confirmed: executed (see label.basis for how that is known). expired-not-executed: a complete read of both sides
 * showed no receipt. expired-unverified: settled without knowing whether it executed.
 */
export type TransferState = 'prepared' | 'sending' | 'acknowledged' | 'unknown' | 'confirmed' | 'rejected' | 'not-sent' | 'expired-not-executed' | 'expired-unverified';
const SETTLED = new Set<TransferState>(['confirmed', 'rejected', 'not-sent', 'expired-not-executed', 'expired-unverified']);
export type TransferBasis = 'acknowledged' | 'late_receipt_confirmed' | 'nonce_expired_no_receipt' | 'nonce_expired_partial_receipt' | 'nonce_expired_ambiguous_receipt' | 'nonce_expired_unreadable' | 'identity_changed';
/** Settlements that leave it open whether money moved wait longer before the pair is balanced again. */
const UNCERTAIN = new Set<TransferBasis>(['nonce_expired_partial_receipt', 'nonce_expired_ambiguous_receipt', 'nonce_expired_unreadable']);
type Role = 'source' | 'destination';
const ROLES = ['source', 'destination'] as const;
const SIDES = ['long', 'short'] as const;
const SIDE_NAMES: Record<PairSide, string> = { long: '多侧', short: '空侧' };
const EVIDENCE_LIMIT = 20;
/** A pre-send snapshot longer than this is dropped: a truncated list would not be a complete exclusion. */
const BASELINE_LIMIT = 100;
/** The same failure of the same transfer is written to the event log at most this often; the count is kept in memory only. */
const SETTLE_FAILURE_EVENT_MS = 300_000;

const TRANSFER_BUDGET_KEYS = [
  'callTimeoutMs', 'transferHistorySpanMs', 'transferClockToleranceMs', 'transferLabelDeferMs', 'transferSettleCooldownMs', 'transferUncertainCooldownMs', 'transferRetryMs',
  'transferReadTimeoutMs', 'transferBaselineTimeoutMs', 'transferBalanceMaxAgeMs', 'transferRefreshDeferMs', 'transferTickBudgetMs', 'futureToleranceMs',
] as const;
export type TransferBudgets = Record<typeof TRANSFER_BUDGET_KEYS[number], number>;

export interface PairRecord extends TransferPairInput {
  enabled: boolean;
  /** Hash of the pair id and its three accounts; a transfer settles against the identity it was sent under. */
  identity: string;
  createdAt: number;
  cooldownUntil: number;
  nextCheckAt: number;
  /** Transaction ids already attributed to a settled transfer, with when; never attributed again while a later transfer could still see them. */
  usedReceipts: { tranId: string; at: number }[];
  /** A transfer touching one of this pair's accounts was settled then; only balances received later are planned from. */
  freshAfter?: number;
  /** Sends in a row that never left this process; each one doubles the wait before the next try. */
  notSentStreak?: number;
  balances: Record<PairSide, TransferBalance> | null;
  note: string | null;
}
export interface Transfer {
  /** Request id: one per transfer, never reused for a second send. */
  id: string;
  pairId: string;
  state: TransferState;
  mainAccountId: string;
  sourceSide: PairSide;
  source: string;
  destination: string;
  asset: typeof TRANSFER_ASSET;
  amount: string;
  identity: string;
  preparedAt: number;
  sentAt: number | null;
  ackAt: number | null;
  /** From the acknowledgement, or a hint from an answer that did not confirm success. */
  tranId: string | null;
  /** Same-amount receipts seen right before the send, per side that was read completely; a missing side has no snapshot. */
  beforeReceipts: Partial<Record<Role, string[]>>;
  /** Candidate receipts seen by any label read. They prove something exists, not which request made it. */
  evidence: { role: Role; tranId: string }[];
  label: { basis: TransferBasis; receipt?: string; note: string | null } | null;
  settledAt: number | null;
  /** null on a confirmed transfer: it was settled on its acknowledgement alone, the balances could not be read again in time. */
  balancesRefreshedAt: number | null;
  /** Earliest next read after a failed balance refresh or a deferred label read. */
  retryAt: number | null;
  /** When an unknown result is settled. Fixed when the send is marked, so budgets changed afterwards cannot bring it forward; absent on older records. */
  readyAt?: number;
  /** Set by takeover recovery on a transfer the previous writer left unsettled. */
  recoveredAt: number | null;
  note: string | null;
}

export interface TransferDeps {
  db: DatabaseSync;
  now: () => number;
  budgets: TransferBudgets;
  connector: TransferConnector | null;
  /** A shared account-writer registry is injected. Transfers are not registered there, so none is sent. */
  controlled: boolean;
  write<T>(operation: () => T): T;
  assertWriter(): void;
  callVenue<T>(kind: 'read' | 'write', operation: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  event(jobId: string | null, type: string, detail?: Record<string, unknown>): void;
  isWriterLost(error: unknown): boolean;
}

export type TransferPlan = { source: PairSide; destination: PairSide; amount: string };
const SCALE = 10n ** 18n;
/**
 * Half the gap in available balance goes from the richer side to the poorer one, capped by the per-transfer limit,
 * the venue's withdrawal limit and what is left after the cash reserve, rounded down to the transfer unit.
 * A negative available balance counts in the gap as it is and leaves nothing to take from that side.
 */
export function planTransfer(balances: Record<PairSide, TransferBalance>, config: TransferConfig): TransferPlan | { reason: string } {
  const delta = sub(balances.long.available, balances.short.available), gap = cmp(delta, '0') < 0 ? sub('0', delta) : delta;
  if (cmp(gap, config.threshold) <= 0) return { reason: `两侧可用余额差 ${gap} USD1 未超过划转门槛 ${config.threshold} USD1（须严格大于）` };
  const half = floorToStep(fromUnits(units(gap) / 2n), TRANSFER_UNIT);
  if (cmp(half, config.minTransfer) < 0) return { reason: `两侧可用余额差 ${gap} USD1 的一半取整为 ${half} USD1，低于最小划转额 ${config.minTransfer} USD1` };
  const source: PairSide = cmp(delta, '0') > 0 ? 'long' : 'short', from = balances[source];
  // Rounded up, so truncation can never leave less cash behind than the configured share.
  const reserve = cmp(from.equity, '0') > 0 ? fromUnits((units(from.equity) * units(config.bufferRatio) + SCALE - 1n) / SCALE) : '0';
  const limit = [config.maxTransfer, from.maxWithdraw, sub(from.available, reserve)].reduce(min, half);
  const amount = cmp(limit, '0') > 0 ? floorToStep(limit, TRANSFER_UNIT) : '0';
  if (cmp(amount, config.minTransfer) < 0) return { reason: `转出侧${SIDE_NAMES[source]}按单次上限、可划上限与现金保留 ${reserve} USD1 约束后可划 ${amount} USD1，低于最小划转额 ${config.minTransfer} USD1` };
  return { source, destination: source === 'long' ? 'short' : 'long', amount };
}

const why = (error: unknown): string => error instanceof Error ? error.message.slice(0, 160) : '未知错误';
const maskId = (id: string): string => `***${id.slice(-4)}`;
const fingerprint = ({ id, mainAccountId, long, short }: Pick<TransferPairInput, 'id' | 'mainAccountId' | 'long' | 'short'>): string =>
  createHash('sha256').update(JSON.stringify({ pair: id, main: mainAccountId, long, short })).digest('hex');
const isCandidate = (row: TransferReceipt, role: Role, amount: string): boolean =>
  row.asset === TRANSFER_ASSET && row.type === 'transfer' && row.direction === (role === 'source' ? 'out' : 'in') && cmp(row.amount, amount) === 0;
const sameSet = (left: Set<string>, right: Set<string>): boolean => left.size === right.size && [...left].every(item => right.has(item));

function checkBudgets(budgets: TransferBudgets, connector: TransferConnector | null): void {
  const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
  for (const key of TRANSFER_BUDGET_KEYS) {
    // The future tolerance is shared with the quote checks, where zero is a valid setting.
    if (key === 'futureToleranceMs') { if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 0) throw new ContractError(500, 'budget', `${key} 须为非负整数`); }
    else if (!positive(budgets[key])) throw new ContractError(500, 'budget', `${key} 须为正整数`);
  }
  if (connector && !positive(connector.capabilities.requestValidityMs)) throw new ContractError(500, 'budget', '划转连接器的 requestValidityMs 须为正整数');
  // The label read starts one tolerance before the send; a tolerance as long as the span would make it reach past the whole wait.
  if (budgets.transferClockToleranceMs >= budgets.transferHistorySpanMs) throw new ContractError(500, 'budget', 'transferClockToleranceMs 须小于 transferHistorySpanMs');
}

export function createTransfers({ db, now, budgets, connector, controlled, write, assertWriter, callVenue, event, isWriterLost }: TransferDeps) {
  checkBudgets(budgets, connector);
  /** Transfers whose send is running in this process; any other prepared or sending row was interrupted. */
  const inFlight = new Set<string>();
  /** The last work item a pass got to before its time ran out; the next pass starts after it, so none is starved. */
  let resumeAfter: string | null = null;
  /** Unsettled transfers whose last settlement attempts threw: count is the failures in a row, eventAt when one was last written to the event log. */
  const settleFailures = new Map<string, { reason: string; count: number; eventAt: number | null }>();
  /**
   * A receipt attributed at local time S carries a venue time of at most S plus one clock tolerance, and a transfer
   * only considers receipts from one tolerance before its own send. Past two tolerances no new transfer can see it;
   * the history span is added as margin.
   */
  const usedReceiptWindowMs = 2 * budgets.transferClockToleranceMs + budgets.transferHistorySpanMs;

  // ---- persistence -------------------------------------------------------------
  const readPair = (id: string): PairRecord | null => {
    const row = db.prepare('SELECT json FROM transfer_pairs WHERE id = ?').get(id) as { json: string } | undefined;
    // A fixed message: the parser's own may quote the row, which holds unmasked account ids.
    return row ? parsePairRow(row.json) ?? reject('pair_corrupt', '配对记录无法解析', 409) : null;
  };
  const requirePair = (id: string): PairRecord => readPair(id) ?? reject('pair_missing', '划转配对不存在', 404);
  const savePair = (pair: PairRecord): void => {
    db.prepare('UPDATE transfer_pairs SET enabled = ?, version = version + 1, updated_at = ?, json = ? WHERE id = ?').run(pair.enabled ? 1 : 0, now(), JSON.stringify(pair), pair.id);
  };
  const readTransfer = (id: string): Transfer => JSON.parse((db.prepare('SELECT json FROM transfers WHERE id = ?').get(id) as { json: string }).json) as Transfer;
  const saveTransfer = (transfer: Transfer): void => {
    db.prepare('UPDATE transfers SET state = ?, settled = ?, version = version + 1, json = ? WHERE id = ?').run(transfer.state, SETTLED.has(transfer.state) ? 1 : 0, JSON.stringify(transfer), transfer.id);
  };
  /** null for a row that is not a usable pair record. */
  const parsePairRow = (json: string): PairRecord | null => {
    try {
      const pair = JSON.parse(json) as PairRecord | null;
      return pair && [pair.id, pair.mainAccountId, pair.long, pair.short].every(item => typeof item === 'string') && typeof pair.config === 'object' && pair.config !== null && Array.isArray(pair.usedReceipts) ? pair : null;
    } catch { return null; }
  };
  /** transfer is null for a row that cannot be parsed; such a row still blocks its pair. */
  const unsettled = (): { id: string; pairId: string; transfer: Transfer | null }[] =>
    (db.prepare('SELECT id, pair_id, json FROM transfers WHERE settled = 0 ORDER BY created_at, rowid').all() as { id: string; pair_id: string; json: string }[]).map(row => {
      try { return { id: row.id, pairId: row.pair_id, transfer: JSON.parse(row.json) as Transfer }; } catch { return { id: row.id, pairId: row.pair_id, transfer: null }; }
    });
  const useReceipt = (pair: PairRecord, tranId: string, at: number): void => {
    if (!pair.usedReceipts.some(item => item.tranId === tranId)) pair.usedReceipts = [...pair.usedReceipts, { tranId, at }];
  };
  /**
   * Inside a write. What a settlement leaves behind holds for every pair using one of the transfer's accounts, not only
   * its own: they plan from balances read after this moment, never attribute its receipt again, and wait until
   * `sharedCooldownUntil` when it is still open whether money moved. The owner is saved by the caller.
   */
  function requireNewBalances(transfer: Transfer, at: number, owner: PairRecord | null, receipt: string | null, sharedCooldownUntil = 0): void {
    if (owner) {
      owner.freshAfter = Math.max(owner.freshAfter ?? 0, at);
      if (receipt) useReceipt(owner, receipt, at);
    }
    for (const { json } of db.prepare('SELECT json FROM transfer_pairs WHERE id != ?').all(transfer.pairId) as { json: string }[]) {
      const other = parsePairRow(json);
      if (!other || ![other.long, other.short].some(account => account === transfer.source || account === transfer.destination)) continue;
      other.freshAfter = Math.max(other.freshAfter ?? 0, at);
      // A pair that never sends would otherwise only collect them. One with an open transfer keeps all: its label read may come later than the window.
      if (!db.prepare('SELECT 1 FROM transfers WHERE pair_id = ? AND settled = 0').get(other.id)) other.usedReceipts = other.usedReceipts.filter(item => item.at + usedReceiptWindowMs > at);
      if (receipt) useReceipt(other, receipt, at);
      other.cooldownUntil = Math.max(other.cooldownUntil, sharedCooldownUntil);
      savePair(other);
    }
  }
  /** Inside a write. A send that never left waits one check interval, then twice as long each time in a row, up to the pair's cooldown. */
  function backOff(owner: PairRecord, at: number): void {
    const streak = (owner.notSentStreak ?? 0) + 1, ceiling = Math.max(owner.config.cooldownMs, owner.config.checkIntervalMs);
    owner.notSentStreak = streak;
    owner.nextCheckAt = Math.max(owner.nextCheckAt, at + Math.min(ceiling, owner.config.checkIntervalMs * 2 ** Math.min(streak - 1, 30)));
  }

  /** Why this pair may not send now, or null. One unsettled transfer blocks its own pair and every pair sharing an account with it. */
  function blockedBy(pair: PairRecord): string | null {
    if (controlled) return '已注入共享写者登记，划转尚未接入登记，不发送';
    const open = unsettled();
    const recovered = open.filter(item => item.transfer?.recoveredAt != null);
    if (recovered.length) {
      // Without this a restart, the first thing an operator tries, would hide the only on-page sign that one of them will never settle by itself.
      const failing = recovered.map(item => settleFailures.get(item.id)).find(item => item?.count);
      return `接管后有未结清的划转，结清前不发送新划转${failing ? `；其中有划转结算出错（连续 ${failing.count} 次：${failing.reason}），持续出错需人工处置` : ''}`;
    }
    for (const { id, pairId, transfer } of open) {
      const own = pairId === pair.id;
      if (!own) {
        let accounts: string[] | null = transfer ? [transfer.source, transfer.destination] : null;
        if (!accounts) {
          try { const owner = readPair(pairId); accounts = owner ? [owner.long, owner.short] : null; } catch { accounts = null; }
          if (!accounts) return '有无法读取的未结清划转记录，其账户未知，不发送，需人工处置';
        }
        if (!accounts.some(account => account === pair.long || account === pair.short)) continue;
      }
      const where = own ? '本配对' : '共用账户的配对';
      // A row that will not settle by itself is told apart from one that is only waiting for its expiry.
      if (!transfer) return `${where}的未结清划转记录损坏，需人工处置`;
      const failure = settleFailures.get(id);
      if (failure?.count) return `${where}的未结清划转结算出错（连续 ${failure.count} 次：${failure.reason}），持续出错需人工处置`;
      return `${where}有未结清的划转`;
    }
    return null;
  }

  /** prepared never reached transport, because the sending mark commits before any send; sending may have. */
  function interrupt(transfer: Transfer, cause: string): void {
    if (transfer.state === 'prepared') {
      Object.assign(transfer, { state: 'not-sent', settledAt: now(), note: `${cause}：落盘后、发送前中断，传输未调用` });
      // Runs inside a takeover: the transfer is settled whether or not its pair can still be read.
      let owner: PairRecord | null = null;
      try { owner = readPair(transfer.pairId); } catch { /* only the back-off is skipped */ }
      if (owner) { backOff(owner, now()); savePair(owner); }
    } else if (transfer.state === 'sending') Object.assign(transfer, { state: 'unknown', note: `${cause}：发送中断，结果未知；划转无客户端编号，不重发，原请求过期后核对流水结算` });
    else return;
    saveTransfer(transfer);
    event(null, 'transfer-recovered', { pair: transfer.pairId, transfer: transfer.id, state: transfer.state });
  }
  /** Runs inside the lease transaction of a takeover. */
  function recover(): void {
    for (const { transfer } of unsettled()) {
      if (!transfer) continue;
      interrupt(transfer, '恢复');
      if (SETTLED.has(transfer.state)) continue;
      transfer.recoveredAt = now(); saveTransfer(transfer);
    }
  }

  // ---- venue reads -------------------------------------------------------------
  const venue = (): TransferConnector => connector ?? reject('transfer_unavailable', 'ASTER 划转连接器不可用', 503);
  async function read<T>(operation: (connector: TransferConnector, signal: AbortSignal) => Promise<unknown>, parse: (value: unknown) => T, timeoutMs = budgets.transferReadTimeoutMs): Promise<T> {
    const target = venue();
    try { return parse(await callVenue('read', signal => operation(target, signal), timeoutMs)); }
    catch (error) { throw error instanceof ContractError ? error : new ContractError(502, 'venue_read_failed', `ASTER 读取失败：${why(error)}`); }
  }
  const readBalance = (mainAccountId: string, accountId: string): Promise<TransferBalance> =>
    read((target, signal) => target.balance(mainAccountId, accountId, { signal }), value => parseTransferBalance(value, accountId));
  async function readBalances(pair: PairRecord): Promise<Record<PairSide, TransferBalance>> {
    const [long, short] = await Promise.all([readBalance(pair.mainAccountId, pair.long), readBalance(pair.mainAccountId, pair.short)]);
    return { long, short };
  }
  const readHistory = (mainAccountId: string, accountId: string, window: { from: number; to: number | null }, timeoutMs?: number) =>
    read((target, signal) => target.history(mainAccountId, accountId, window, { signal }), value => parseTransferHistory(value, accountId), timeoutMs);
  /** Both sub-accounts must be listed exactly once under the configured main account and not be frozen. */
  async function verifyOwnership(pair: PairRecord): Promise<void> {
    const list = await read((target, signal) => target.subAccounts(pair.mainAccountId, { signal }), value => parseSubAccountList(value, pair.mainAccountId));
    for (const side of SIDES) {
      const row = list.subAccounts.find(item => item.accountId === pair[side]);
      if (!row) reject('sub_account_missing', `${SIDE_NAMES[side]}子账户不在主账户的子账户列表中，无法确认归属`, 409);
      if (row?.frozen) reject('sub_account_frozen', `${SIDE_NAMES[side]}子账户已冻结，禁止划转`, 409);
    }
  }
  /**
   * Best effort, on its own short timeout: a side that cannot be read completely in time gets no snapshot, and the
   * send goes ahead without it. The rows are kept whole because the amount is only fixed by the balances read afterwards.
   */
  async function baseline(pair: PairRecord): Promise<Partial<Record<PairSide, TransferReceipt[]>>> {
    const from = now() - budgets.transferClockToleranceMs, result: Partial<Record<PairSide, TransferReceipt[]>> = {};
    await Promise.all(SIDES.map(async side => {
      try {
        const history = await readHistory(pair.mainAccountId, pair[side], { from, to: null }, budgets.transferBaselineTimeoutMs);
        if (history.complete) result[side] = history.rows;
      } catch { /* optional evidence */ }
    }));
    return result;
  }
  /** Why these balances may not be planned from, or null. */
  function staleness(pair: PairRecord, balances: Record<PairSide, TransferBalance>): string | null {
    const at = now(), oldest = Math.min(balances.long.receivedAt, balances.short.receivedAt), ahead = Math.max(balances.long.receivedAt, balances.short.receivedAt) - at;
    // A stamp from the future would pass both age checks below for as long as the clocks disagree.
    if (ahead > budgets.futureToleranceMs) return `余额快照的接收时刻超前本机时钟 ${ahead} 毫秒（容限 ${budgets.futureToleranceMs} 毫秒），请检查时钟`;
    if (oldest < at - budgets.transferBalanceMaxAgeMs) return `余额快照已超过 ${budgets.transferBalanceMaxAgeMs} 毫秒`;
    if (oldest < (pair.freshAfter ?? 0)) return '余额快照早于上一笔划转的结算时刻';
    return null;
  }

  // ---- planning and sending ----------------------------------------------------
  /** Records why nothing was sent and waits one check interval. A pair re-registered meanwhile is left alone. */
  function defer(pair: PairRecord, note: string, balances?: Record<PairSide, TransferBalance>): void {
    write(() => {
      const current = readPair(pair.id);
      if (!current || current.identity !== pair.identity) return;
      current.nextCheckAt = Math.max(current.nextCheckAt, now() + current.config.checkIntervalMs); current.note = note.slice(0, 300);
      if (balances) current.balances = balances;
      savePair(current);
    });
  }
  async function evaluate(pairId: string): Promise<void> {
    const pair = readPair(pairId), at = now();
    if (!pair || !pair.enabled || at < pair.cooldownUntil || at < pair.nextCheckAt || blockedBy(pair)) return;
    let balances: Record<PairSide, TransferBalance>;
    try { balances = await readBalances(pair); }
    catch (error) { defer(pair, `余额读取失败，未划转：${why(error)}`); return; }
    let stale = staleness(pair, balances);
    if (stale) { defer(pair, `${stale}，未划转`); return; }
    const outlook = planTransfer(balances, pair.config);
    if ('reason' in outlook) { defer(pair, outlook.reason, balances); return; }
    // The plan above only decided that it is worth doing. The balances the send goes by are read last, after the
    // waits for ownership and the receipt snapshot, so nothing slow sits between them and the send.
    let before: Partial<Record<PairSide, TransferReceipt[]>>;
    try { await verifyOwnership(pair); before = await baseline(pair); balances = await readBalances(pair); }
    catch (error) { defer(pair, `发送前复核失败，未划转：${why(error)}`); return; }
    stale = staleness(pair, balances);
    if (stale) { defer(pair, `发送前重读：${stale}，未划转`); return; }
    const plan = planTransfer(balances, pair.config);
    if ('reason' in plan) { defer(pair, `发送前重读后不再划转：${plan.reason}`, balances); return; }
    const accounts = { source: pair[plan.source], destination: pair[plan.destination] };
    const beforeReceipts: Transfer['beforeReceipts'] = {};
    for (const role of ROLES) {
      const rows = before[plan[role]];
      const seen = rows && [...new Set(rows.filter(row => isCandidate(row, role, plan.amount)).map(row => row.tranId))];
      if (seen && seen.length <= BASELINE_LIMIT) beforeReceipts[role] = seen;
    }
    const transfer: Transfer = {
      id: randomUUID(), pairId: pair.id, state: 'prepared', mainAccountId: pair.mainAccountId, sourceSide: plan.source, ...accounts, asset: TRANSFER_ASSET, amount: plan.amount, identity: pair.identity,
      preparedAt: now(), sentAt: null, ackAt: null, tranId: null, beforeReceipts, evidence: [], label: null, settledAt: null, balancesRefreshedAt: null, retryAt: null, recoveredAt: null, note: null,
    };
    inFlight.add(transfer.id);
    try { await send(pair, transfer, balances); } finally { inFlight.delete(transfer.id); }
  }
  async function send(pair: PairRecord, transfer: Transfer, balances: Record<PairSide, TransferBalance>): Promise<void> {
    const target = venue();
    const refusal = write(() => {
      const current = readPair(pair.id);
      if (!current || !current.enabled || current.identity !== transfer.identity || now() < current.cooldownUntil) return '配对状态已变化，本次不划转';
      // The amount was planned under the settings read when this evaluation began.
      if (JSON.stringify(current.config) !== JSON.stringify(pair.config)) return '配对配置在评估途中已更改，本次不划转，下一轮按新配置规划';
      const blocked = blockedBy(current) ?? staleness(current, balances);
      if (blocked) return `${blocked}，本次不划转`;
      const at = now();
      current.usedReceipts = current.usedReceipts.filter(item => item.at + usedReceiptWindowMs > at);
      db.prepare('INSERT INTO transfers(id, pair_id, state, settled, created_at, version, json) VALUES (?, ?, ?, 0, ?, 1, ?)').run(transfer.id, transfer.pairId, transfer.state, transfer.preparedAt, JSON.stringify(transfer));
      current.balances = balances; current.note = null; savePair(current);
      event(null, 'transfer-prepared', { pair: pair.id, transfer: transfer.id, sourceSide: transfer.sourceSide, amount: transfer.amount });
      return null;
    });
    if (refusal) { defer(pair, refusal); return; }
    write(() => { const sentAt = now(); Object.assign(transfer, { state: 'sending', sentAt, readyAt: sentAt + expiryMs(target) }); saveTransfer(transfer); });
    let ack: TransferAck | null = null, failure: unknown = null;
    const { source, destination, asset, amount } = transfer;
    try { ack = parseTransferAck(await callVenue('write', signal => target.transfer(transfer.mainAccountId, { source, destination, asset, amount }, { signal, beforeSend: assertWriter }))); }
    catch (error) { failure = error; }
    const state = write(() => {
      const current = readTransfer(transfer.id);
      if (current.state !== 'sending') return current.state;
      const at = now(), owner = readPair(current.pairId), sentAt = current.sentAt ?? at;
      if (failure instanceof VenueError && failure.kind === 'not-sent') {
        Object.assign(current, { state: 'not-sent', settledAt: at, note: failure.message.slice(0, 200) });
        if (owner) backOff(owner, at);
      } else {
        if (owner) owner.notSentStreak = 0;
        if (ack?.confirmed) {
          Object.assign(current, { state: 'acknowledged', ackAt: at, tranId: ack.tranId });
          if (owner) owner.cooldownUntil = Math.max(owner.cooldownUntil, sentAt + owner.config.cooldownMs);
        } else if (failure instanceof VenueError && failure.kind === 'rejected') {
          Object.assign(current, { state: 'rejected', settledAt: at, note: failure.message.slice(0, 200) });
          if (owner) owner.cooldownUntil = Math.max(owner.cooldownUntil, sentAt + owner.config.cooldownMs);
        // Any other outcome, including an answer that fails validation or does not confirm success, leaves the result unknown.
        } else Object.assign(current, { state: 'unknown', tranId: ack?.tranId ?? null, note: `结果未知（${failure ? why(failure) : '回执未确认成功'}）；划转无客户端编号，不重发，原请求过期后核对流水结算` });
      }
      saveTransfer(current);
      if (owner) savePair(owner);
      event(null, 'transfer-sent', { pair: current.pairId, transfer: current.id, state: current.state, ...(current.tranId ? { tranId: current.tranId } : {}) });
      return current.state;
    });
    if (state === 'acknowledged') await refresh(readTransfer(transfer.id));
  }

  // ---- settlement --------------------------------------------------------------
  /**
   * An acknowledged transfer is done; it only waits for both balances to be read after the acknowledgement. That wait
   * is bounded from the persisted acknowledgement time: past it the transfer is settled on the acknowledgement alone,
   * so an account that can no longer be read cannot hold this pair, or every pair after a takeover, forever.
   */
  async function refresh(transfer: Transfer): Promise<void> {
    let balances: { source: TransferBalance; destination: TransferBalance } | null = null, failure = '';
    try {
      const [source, destination] = await Promise.all([readBalance(transfer.mainAccountId, transfer.source), readBalance(transfer.mainAccountId, transfer.destination)]);
      if (Math.min(source.receivedAt, destination.receivedAt) < (transfer.ackAt ?? 0)) reject('balance_stale', '余额快照早于划转回执', 409);
      if (Math.max(source.receivedAt, destination.receivedAt) - now() > budgets.futureToleranceMs) reject('balance_future', '余额快照的接收时刻超前本机时钟', 409);
      balances = { source, destination };
    } catch (error) { failure = why(error); }
    write(() => {
      const current = readTransfer(transfer.id);
      if (current.state !== 'acknowledged') return;
      const at = now(), ackAt = current.ackAt ?? current.sentAt ?? current.preparedAt;
      if (!balances && at < ackAt + budgets.transferRefreshDeferMs) {
        Object.assign(current, { retryAt: at + budgets.transferRetryMs, note: `已回执，余额刷新失败（${failure}），之后只读重试，不重发` });
        saveTransfer(current);
        return;
      }
      const notes = [current.tranId ? null : '回执未带交易编号', balances ? null : `余额未刷新：回执后 ${budgets.transferRefreshDeferMs} 毫秒内未读到两侧新余额（${failure}），按回执结算`].filter(item => item !== null);
      Object.assign(current, { state: 'confirmed', settledAt: at, balancesRefreshedAt: balances ? Math.min(balances.source.receivedAt, balances.destination.receivedAt) : null, retryAt: null, note: null,
        label: { basis: 'acknowledged', ...(current.tranId ? { receipt: current.tranId } : {}), note: notes.join('；') || null } });
      saveTransfer(current);
      const owner = readPair(current.pairId);
      requireNewBalances(current, at, owner, current.tranId);
      if (owner) {
        owner.cooldownUntil = Math.max(owner.cooldownUntil, (current.sentAt ?? ackAt) + owner.config.cooldownMs);
        if (owner.identity === current.identity) owner.balances = !balances ? null : current.sourceSide === 'long' ? { long: balances.source, short: balances.destination } : { long: balances.destination, short: balances.source };
        savePair(owner);
      }
      event(null, 'transfer-settled', { pair: current.pairId, transfer: current.id, state: current.state, basis: 'acknowledged', balancesRefreshed: balances !== null });
    });
  }

  /** From the send until the signed request can no longer be accepted and the history span is over, whichever is later. */
  const expiryMs = (target: TransferConnector): number => Math.max(budgets.callTimeoutMs + target.capabilities.requestValidityMs, budgets.transferHistorySpanMs);
  /** The moment persisted with the send; a record from before it was persisted falls back to the current budgets. */
  const readyAt = (transfer: Transfer, target: TransferConnector): number => transfer.readyAt ?? (transfer.sentAt ?? transfer.preparedAt) + expiryMs(target);

  /**
   * One label read per attempt. Evidence adds up across attempts, but only a single complete read of both sides
   * confirms, and absence is only stated after such a read. Past the deferral limit the transfer is settled from
   * whatever evidence there is; nothing here waits for a person.
   */
  async function settleUnknown(transfer: Transfer, target: TransferConnector): Promise<void> {
    const ready = readyAt(transfer, target), at = now();
    if (at < ready || (transfer.retryAt !== null && at < transfer.retryAt)) return;
    const pair = readPair(transfer.pairId);
    if (!pair || pair.identity !== transfer.identity) return finish(transfer.id, 'identity_changed', null, '配对账户身份已变化，未核对流水', transfer.evidence);
    const sent = transfer.sentAt ?? transfer.preparedAt, from = sent - budgets.transferClockToleranceMs, to = Math.min(at, Math.max(sent + budgets.transferHistorySpanMs, ready));
    const used = new Set(pair.usedReceipts.map(item => item.tranId));
    const reads = await Promise.all(ROLES.map(async role => {
      try {
        const history = await readHistory(transfer.mainAccountId, transfer[role], { from, to });
        return { rows: history.rows, problem: history.complete ? null : '读取不完整' };
      } catch (error) { return { rows: [] as TransferReceipt[], problem: why(error) }; }
    }));
    const found = (start: number): Set<string>[] => ROLES.map((role, index) => new Set(reads[index].rows.filter(row => isCandidate(row, role, transfer.amount) && row.time >= start && row.time <= to
      && (!transfer.tranId || row.tranId === transfer.tranId) && !transfer.beforeReceipts[role]?.includes(row.tranId) && !used.has(row.tranId)).map(row => row.tranId)));
    const evidence = [...transfer.evidence];
    found(from).forEach((ids, index) => { for (const tranId of ids) if (!evidence.some(item => item.role === ROLES[index] && item.tranId === tranId)) evidence.push({ role: ROLES[index], tranId }); });
    evidence.splice(EVIDENCE_LIMIT);
    const problems = reads.flatMap((item, index) => item.problem ? [`${index === 0 ? '转出侧' : '转入侧'}${item.problem}`] : []);
    const unreadable = problems.length ? `流水暂不可读（${problems.join('；').slice(0, 200)}）` : null;
    if (unreadable && at < ready + budgets.transferLabelDeferMs) {
      write(() => {
        const current = readTransfer(transfer.id);
        if (current.state !== 'unknown') return;
        Object.assign(current, { evidence, retryAt: at + budgets.transferRetryMs, note: `${unreadable}，推迟结算，不重发` });
        saveTransfer(current);
      });
      return;
    }
    const [source, destination] = ROLES.map(role => new Set(evidence.filter(item => item.role === role && !used.has(item.tranId)).map(item => item.tranId)));
    const common = [...source].filter(tranId => destination.has(tranId));
    const oneToOne = common.length === 1 && source.size === 1 && destination.size === 1;
    const suffix = unreadable ? `；${unreadable}` : '';
    if (!unreadable && oneToOne) {
      // Without the venue's own transaction id, a receipt older than the request may belong to an earlier transfer inside the clock-tolerance window.
      const current = found(transfer.tranId ? from : Math.max(from, transfer.preparedAt));
      if (sameSet(current[0], source) && sameSet(current[1], destination)) {
        const snapshot = transfer.beforeReceipts.source && transfer.beforeReceipts.destination ? '' : '；缺少发送前流水快照';
        return finish(transfer.id, 'late_receipt_confirmed', common[0], transfer.tranId ? null : `无原交易编号，按金额与时间归属，可能误认其他同额划转${snapshot}`, evidence);
      }
    }
    if (source.size && destination.size && !oneToOne) return finish(transfer.id, 'nonce_expired_ambiguous_receipt', null, `归属歧义：同额候选流水 ${source.size}/${destination.size} 笔，无法确定哪笔属于本次请求${suffix}`, evidence);
    if (oneToOne) return finish(transfer.id, 'nonce_expired_partial_receipt', null, unreadable ? `两侧均见该笔流水，但本次读取不完整${suffix}` : '两侧均见同额流水，但时间早于本次请求，不能确认', evidence);
    if (source.size || destination.size) return finish(transfer.id, 'nonce_expired_partial_receipt', null, `两侧流水只部分匹配${suffix}`, evidence);
    if (unreadable) return finish(transfer.id, 'nonce_expired_unreadable', null, unreadable, evidence);
    return finish(transfer.id, 'nonce_expired_no_receipt', null, '两侧流水均无该笔划转', evidence);
  }
  /** Label, final state, used receipt and the pair's cooldown commit together, so a crash never leaves one without the others. */
  function finish(id: string, basis: TransferBasis, receipt: string | null, note: string | null, evidence: Transfer['evidence']): void {
    write(() => {
      const current = readTransfer(id);
      if (current.state !== 'unknown') return;
      const state: TransferState = basis === 'late_receipt_confirmed' ? 'confirmed' : basis === 'nonce_expired_no_receipt' ? 'expired-not-executed' : 'expired-unverified';
      const at = now();
      Object.assign(current, { state, evidence, label: { basis, ...(receipt ? { receipt } : {}), note }, settledAt: at, retryAt: null });
      saveTransfer(current);
      const owner = readPair(current.pairId);
      const uncertain = UNCERTAIN.has(basis) || (basis === 'late_receipt_confirmed' && !current.tranId);
      requireNewBalances(current, at, owner, receipt, uncertain ? at + budgets.transferUncertainCooldownMs : 0);
      if (owner) {
        owner.cooldownUntil = Math.max(owner.cooldownUntil, at + Math.max(owner.config.cooldownMs, uncertain ? budgets.transferUncertainCooldownMs : budgets.transferSettleCooldownMs));
        savePair(owner);
      }
      event(null, 'transfer-settled', { pair: current.pairId, transfer: id, state, basis, ...(receipt ? { receipt } : {}) });
    });
  }

  /** Counts the failure for the pair's blocked reason and writes it to the event log, the same reason at most once per interval. */
  function settleFailed(id: string, pairId: string, reason: string): void {
    const last = settleFailures.get(id), at = now();
    const entry = { reason, count: (last?.count ?? 0) + 1, eventAt: last?.eventAt ?? null };
    settleFailures.set(id, entry);
    if (last && last.reason === reason && last.eventAt !== null && at - last.eventAt < SETTLE_FAILURE_EVENT_MS) return;
    try { write(() => event(null, 'transfer-settle-failed', { pair: pairId, transfer: id, reason, failures: entry.count })); entry.eventAt = at; }
    catch (inner) { if (isWriterLost(inner)) throw inner; }
  }
  /** One unsettled transfer; whatever goes wrong with it stays with it. */
  async function settle(id: string, pairId: string, target: TransferConnector): Promise<void> {
    try {
      let transfer: Transfer;
      // The parser's own message may quote the row.
      try { transfer = readTransfer(id); } catch (error) { throw error instanceof SyntaxError ? new Error('划转记录无法解析') : error; }
      if (transfer.state === 'prepared' || transfer.state === 'sending') {
        if (!inFlight.has(id)) write(() => { if (!inFlight.has(id)) interrupt(readTransfer(id), '中断'); });
      } else if (transfer.state === 'acknowledged') {
        if (transfer.retryAt === null || now() >= transfer.retryAt) await refresh(transfer);
      } else if (transfer.state === 'unknown') await settleUnknown(transfer, target);
      else if (!SETTLED.has(transfer.state)) throw new Error('未结清划转记录的状态无效');
      const failure = settleFailures.get(id);
      if (failure) failure.count = 0;
    } catch (error) {
      if (isWriterLost(error)) throw error;
      settleFailed(id, pairId, why(error));
    }
  }
  async function planPair(pairId: string): Promise<void> {
    try { await evaluate(pairId); }
    catch (error) {
      if (isWriterLost(error)) throw error;
      try { const pair = readPair(pairId); if (pair) defer(pair, `本轮处理失败：${why(error)}`); }
      catch (inner) { if (isWriterLost(inner)) throw inner; }
    }
  }
  /**
   * Settles what is open first, then plans; a transfer settled in this pass still leaves its pair in cooldown.
   * The pass stops starting new work once its time budget is spent and the next one picks up after the last item
   * done, so a venue that answers slowly delays the job loop by at most the budget plus one item.
   */
  async function tick(): Promise<void> {
    if (!connector) return;
    const deadline = performance.now() + budgets.transferTickBudgetMs;
    const open = db.prepare('SELECT id, pair_id FROM transfers WHERE settled = 0 ORDER BY created_at, rowid').all() as { id: string; pair_id: string }[];
    for (const id of [...settleFailures.keys()]) if (!open.some(row => row.id === id)) settleFailures.delete(id);
    const work = [
      ...open.map(({ id, pair_id }) => ({ key: `transfer:${id}`, run: () => settle(id, pair_id, connector) })),
      ...(db.prepare('SELECT id FROM transfer_pairs WHERE enabled = 1 ORDER BY id').all() as { id: string }[]).map(({ id }) => ({ key: `pair:${id}`, run: () => planPair(id) })),
    ];
    const start = resumeAfter === null ? 0 : work.findIndex(item => item.key === resumeAfter) + 1;
    resumeAfter = null;
    const ordered = [...work.slice(start), ...work.slice(0, start)];
    for (const [index, item] of ordered.entries()) {
      if (index > 0 && performance.now() >= deadline) { resumeAfter = ordered[index - 1].key; return; }
      await item.run();
    }
  }

  // ---- pairs and views ---------------------------------------------------------
  function transferView(transfer: Transfer) {
    return {
      id: transfer.id, pairId: transfer.pairId, state: transfer.state, sourceSide: transfer.sourceSide, destinationSide: transfer.sourceSide === 'long' ? 'short' as const : 'long' as const,
      asset: transfer.asset, amount: transfer.amount, preparedAt: transfer.preparedAt, sentAt: transfer.sentAt, ackAt: transfer.ackAt, tranId: transfer.tranId,
      /** When an unknown transfer is labeled and settled. */
      readyAt: transfer.state === 'unknown' && connector ? readyAt(transfer, connector) : null,
      basis: transfer.label?.basis ?? null, receipt: transfer.label?.receipt ?? null, labelNote: transfer.label?.note ?? null, evidence: transfer.evidence.length,
      baseline: ROLES.filter(role => transfer.beforeReceipts[role] !== undefined), settledAt: transfer.settledAt, balancesRefreshedAt: transfer.balancesRefreshedAt, recovered: transfer.recoveredAt != null, note: transfer.note,
    };
  }
  function pairView(pair: PairRecord) {
    const open = db.prepare('SELECT json FROM transfers WHERE pair_id = ? AND settled = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1').get(pair.id) as { json: string } | undefined;
    let current: ReturnType<typeof transferView> | null = null;
    try { current = open ? transferView(JSON.parse(open.json) as Transfer) : null; } catch { /* an unreadable row shows through blocked */ }
    const balance = (value: TransferBalance) => ({ available: value.available, equity: value.equity, maxWithdraw: value.maxWithdraw, receivedAt: value.receivedAt });
    return {
      id: pair.id, mainAccountId: maskId(pair.mainAccountId), long: maskId(pair.long), short: maskId(pair.short), config: pair.config, enabled: pair.enabled,
      cooldownUntil: pair.cooldownUntil, nextCheckAt: pair.nextCheckAt, balances: pair.balances ? { long: balance(pair.balances.long), short: balance(pair.balances.short) } : null,
      blocked: pair.enabled ? blockedBy(pair) : null, note: pair.note, current,
    };
  }

  /** Creates a pair disabled, or updates one. Changing any account disables it; a transfer already sent keeps the identity it was sent under. */
  function registerPair(input: unknown): ReturnType<typeof pairView> {
    const parsed = parseTransferPair(input), identity = fingerprint(parsed);
    return write(() => {
      // Two pairs over the same two accounts would each plan the same money from their own cooldown and pacing.
      const accounts = new Set([parsed.long, parsed.short]);
      for (const { json } of db.prepare('SELECT json FROM transfer_pairs WHERE id != ?').all(parsed.id) as { json: string }[]) {
        const other = parsePairRow(json);
        if (other && other.mainAccountId === parsed.mainAccountId && sameSet(accounts, new Set([other.long, other.short]))) reject('pair_duplicate', `配对 ${other.id} 已使用同一主账户下的这两个子账户`, 409);
      }
      const existing = readPair(parsed.id);
      if (!existing) {
        const pair: PairRecord = { ...parsed, enabled: false, identity, createdAt: now(), cooldownUntil: 0, nextCheckAt: 0, usedReceipts: [], balances: null, note: null };
        db.prepare('INSERT INTO transfer_pairs(id, enabled, version, updated_at, json) VALUES (?, 0, 1, ?, ?)').run(pair.id, now(), JSON.stringify(pair));
      } else {
        const changed = existing.identity !== identity;
        Object.assign(existing, parsed, { identity }, changed ? { enabled: false, balances: null, note: '配对账户已更换，已停用；核对后重新启用' } : {});
        savePair(existing);
      }
      event(null, 'transfer-pair-registered', { pair: parsed.id });
      return pairView(requirePair(parsed.id));
    });
  }

  /** Durable, idempotent switch; a replayed request never undoes a later one. Enabling first proves both sub-accounts belong to the main account. */
  async function setEnabled(input: unknown, session: string): Promise<ReturnType<typeof pairView>> {
    const raw = exactKeys(input, ['pairId', 'enabled', 'requestId']);
    const pairId = text(raw.pairId, '配对编号', PAIR_ID), requestId = raw.requestId, enabled = raw.enabled;
    if (typeof enabled !== 'boolean') return reject('invalid_value', '启用标记无效');
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return reject('request_id', '请求编号无效');
    const payload = createHash('sha256').update(JSON.stringify({ kind: 'transfer-enable', pairId, enabled })).digest('hex');
    const replayed = (): boolean => {
      const existing = db.prepare('SELECT digest, session FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
      if (existing && (existing.digest !== payload || existing.session !== session)) reject('request_reused', '请求编号已用于其他内容', 409);
      return !!existing;
    };
    if (replayed()) return pairView(requirePair(pairId));
    const pair = requirePair(pairId);
    if (enabled) {
      if (controlled) reject('transfer_control_unsupported', '已注入共享写者登记，划转尚未接入登记，不能启用', 409);
      await verifyOwnership(pair);
    }
    return write(() => {
      if (replayed()) return pairView(requirePair(pairId));
      const current = requirePair(pairId);
      if (enabled && current.identity !== pair.identity) reject('pair_changed', '配对账户已变化，请重新启用', 409);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'transfer-enable', payload, session, pairId, now());
      current.enabled = enabled;
      if (enabled) { current.nextCheckAt = 0; current.note = null; }
      savePair(current);
      event(null, 'transfer-pair-switched', { pair: pairId, enabled, requestId });
      return pairView(current);
    });
  }

  /** Rows that are not usable pair records are left out and named, so one of them does not fail the whole listing. */
  function listPairs(): { pairs: PairRecord[]; corrupt: string[] } {
    const pairs: PairRecord[] = [], corrupt: string[] = [];
    for (const row of db.prepare('SELECT id, json FROM transfer_pairs ORDER BY id').all() as { id: string; json: string }[]) {
      const pair = parsePairRow(row.json);
      if (pair) pairs.push(pair); else corrupt.push(row.id);
    }
    return { pairs, corrupt };
  }

  return {
    recover, tick, registerPair, setEnabled,
    pairs: () => listPairs().pairs.map(pairView),
    corruptPairs: () => listPairs().corrupt,
    recent: (limit = 20) => (db.prepare('SELECT json FROM transfers ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(Math.max(1, Math.trunc(limit)), 100)) as { json: string }[])
      .flatMap(row => { try { return [transferView(JSON.parse(row.json) as Transfer)]; } catch { return []; } }),
  };
}
