// In-memory ASTER main account with sub-accounts, a transfer ledger and each
// account's receipt history, for offline simulation and fault injection. It has
// no network code; it only models what the transfer recovery relies on.
import { add, cmp, isMultiple, sub } from './decimal.ts';
import { TRANSFER_ASSET, TRANSFER_UNIT, type SubAccountList, type TransferBalance, type TransferHistory, type TransferReceipt } from './contracts.ts';
import { VenueError, type CallOptions, type SendOptions, type TransferAck, type TransferCapabilities, type TransferConnector, type TransferRequest } from './connector.ts';

export type AsterOperation = 'sub-accounts' | 'balance' | 'history' | 'transfer';
/**
 * reject: definitive venue refusal. not-sent: refused before transmission.
 * lost-request: the call fails as uncertain and the venue never saw it.
 * lost-response: the venue applies the transfer, the caller gets an uncertain failure.
 * hang-after-apply: the venue applies it and the call never answers until released.
 * ack-without-tranId: applied and acknowledged, but the answer carries no transaction id.
 * ack-not-success: the answer has a success code without the success message (confirmed false); `applied` false
 *   leaves the transfer unapplied, `hint` puts the transaction id into the answer.
 * one-side: applied, the answer is lost and only the source's receipt shows; the destination's shows after `delayMs`, or never.
 * delayed-history: applied, the answer is lost and both receipts show only after `delayMs`.
 * read-fail: a read gives no usable answer. incomplete-history: a history read answers complete false with what it has.
 * hang: a read does not answer until released.
 * `accountId` limits a balance or history fault to that account.
 */
export type AsterFaultMode = 'reject' | 'not-sent' | 'lost-request' | 'lost-response' | 'hang-after-apply' | 'ack-without-tranId' | 'ack-not-success' | 'one-side' | 'delayed-history' | 'read-fail' | 'incomplete-history' | 'hang';
export interface AsterFault { operation: AsterOperation; mode: AsterFaultMode; times?: number; accountId?: string; delayMs?: number; applied?: boolean; hint?: boolean }

interface SimSub { accountId: string; mainAccountId: string; available: string; equity: string; maxWithdraw: string | null; frozen: boolean }
interface SimReceipt extends TransferReceipt { accountId: string; visibleAt: number }
export interface LedgerEntry { tranId: string; source: string; destination: string; amount: string; time: number }

export class SimulatedAster implements TransferConnector {
  readonly venue = 'aster' as const;
  readonly capabilities: TransferCapabilities;
  readonly calls: Record<AsterOperation, number> = { 'sub-accounts': 0, balance: 0, history: 0, transfer: 0 };
  /** Transfer requests that reached the venue. */
  readonly arrived = { transfer: 0 };
  /** Transfers the venue applied, in order. */
  readonly ledger: LedgerEntry[] = [];
  /** When true the two sides of one transfer get different transaction ids. */
  splitTranIds = false;
  /** How old a balance snapshot is when it is answered. */
  balanceAgeMs = 0;
  /** A history window holding more rows than this answers complete false. */
  pageLimit = 1000;
  private readonly subs = new Map<string, SimSub>();
  private readonly receipts: SimReceipt[] = [];
  private readonly unlisted = new Set<string>();
  private faults: AsterFault[] = [];
  private hung: (() => void)[] = [];
  private nextId = 1;
  private readonly clock: () => number;

  // 120 s: the documented 60 s nonce window plus 60 s of clock skew, as the legacy balancer assumes.
  constructor(clock: () => number, { requestValidityMs = 120_000 }: { requestValidityMs?: number } = {}) {
    this.clock = clock;
    this.capabilities = { transport: 'simulated', clientTransferId: false, requestValidityMs, attribution: 'side-amount-time' };
  }

  openSubAccount(mainAccountId: string, accountId: string, { available, equity = available, maxWithdraw = null }: { available: string; equity?: string; maxWithdraw?: string | null }): void {
    this.subs.set(accountId, { accountId, mainAccountId, available, equity, maxWithdraw, frozen: false });
  }
  setBalance(accountId: string, change: Partial<Pick<SimSub, 'available' | 'equity' | 'maxWithdraw'>>): void { Object.assign(this.requireSub(accountId), change); }
  available(accountId: string): string { return this.requireSub(accountId).available; }
  freeze(accountId: string, frozen = true): void { this.requireSub(accountId).frozen = frozen; }
  /** Moves a sub-account under another main account, as if it had never belonged to the first. */
  reassign(accountId: string, mainAccountId: string): void { this.requireSub(accountId).mainAccountId = mainAccountId; }
  /** Leaves a sub-account out of the listing while its balance and history stay readable. */
  unlist(accountId: string, hidden = true): void { this.requireSub(accountId); if (hidden) this.unlisted.add(accountId); else this.unlisted.delete(accountId); }
  inject(fault: AsterFault): void { this.faults.push({ times: 1, ...fault }); }
  clearFaults(): void { this.faults = []; }
  /** Lets every hung call answer (the caller may already have given up on it). */
  releaseHung(): void { const waiting = this.hung; this.hung = []; for (const release of waiting) release(); }
  /** One receipt as another tool or a person would leave it; balances are not touched. */
  addReceipt(accountId: string, { direction, amount, time = this.clock(), tranId = `x${this.nextId++}`, asset = TRANSFER_ASSET, type = 'transfer' }: Partial<TransferReceipt> & Pick<TransferReceipt, 'direction' | 'amount'>): string {
    this.requireSub(accountId);
    this.receipts.push({ accountId, tranId, asset, type, direction, amount, time, visibleAt: 0 });
    return tranId;
  }
  /** A transfer this executor did not send: both receipts under one transaction id, at the given venue time. Balances are not touched. */
  addExternalTransfer(source: string, destination: string, amount: string, time = this.clock()): string {
    const tranId = this.addReceipt(source, { direction: 'out', amount, time });
    this.addReceipt(destination, { direction: 'in', amount, time, tranId });
    return tranId;
  }
  receiptsOf(accountId: string): TransferReceipt[] {
    return this.receipts.filter(row => row.accountId === accountId).map(({ accountId: _account, visibleAt: _visible, ...row }) => row);
  }

  private requireSub(accountId: string): SimSub {
    const account = this.subs.get(accountId);
    if (!account) throw new Error(`unknown sub-account ${accountId}`);
    return account;
  }
  private takeFault(operation: AsterOperation, accountId?: string): AsterFault | null {
    const index = this.faults.findIndex(fault => fault.operation === operation && (!fault.accountId || fault.accountId === accountId));
    if (index < 0) return null;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }
  private enter(operation: AsterOperation, signal: AbortSignal): void {
    this.calls[operation]++;
    if (signal.aborted) throw new VenueError(operation === 'transfer' ? 'not-sent' : 'read-failed', '请求已取消');
  }
  private async readFault(fault: AsterFault | null, message: string): Promise<void> {
    if (fault?.mode === 'read-fail') throw new VenueError('read-failed', message);
    if (fault?.mode === 'hang') await new Promise<void>(resolve => this.hung.push(resolve));
  }
  private owned(mainAccountId: string, accountId: string): SimSub {
    const account = this.subs.get(accountId);
    if (!account || account.mainAccountId !== mainAccountId) throw new VenueError('read-failed', '模拟主账户下没有该子账户');
    return account;
  }

  async subAccounts(mainAccountId: string, { signal }: CallOptions): Promise<SubAccountList> {
    this.enter('sub-accounts', signal);
    await this.readFault(this.takeFault('sub-accounts'), '模拟子账户列表读取失败');
    const subAccounts = [...this.subs.values()].filter(item => item.mainAccountId === mainAccountId && !this.unlisted.has(item.accountId)).map(item => ({ accountId: item.accountId, frozen: item.frozen }));
    return { mainAccountId, subAccounts, receivedAt: this.clock() };
  }
  async balance(mainAccountId: string, accountId: string, { signal }: CallOptions): Promise<TransferBalance> {
    this.enter('balance', signal);
    await this.readFault(this.takeFault('balance', accountId), '模拟余额读取失败');
    const account = this.owned(mainAccountId, accountId);
    return { accountId, asset: TRANSFER_ASSET, available: account.available, equity: account.equity, maxWithdraw: account.maxWithdraw ?? account.available, receivedAt: this.clock() - this.balanceAgeMs };
  }
  async history(mainAccountId: string, accountId: string, { from, to }: { from: number; to: number | null }, { signal }: CallOptions): Promise<TransferHistory> {
    this.enter('history', signal);
    const fault = this.takeFault('history', accountId);
    await this.readFault(fault, '模拟划转流水读取失败');
    this.owned(mainAccountId, accountId);
    const now = this.clock();
    const rows = this.receipts.filter(row => row.accountId === accountId && row.visibleAt <= now && row.time >= from && (to === null || row.time <= to))
      .sort((a, b) => a.time - b.time).map(({ accountId: _account, visibleAt: _visible, ...row }) => row);
    return { accountId, rows: rows.slice(0, this.pageLimit), complete: fault?.mode !== 'incomplete-history' && rows.length <= this.pageLimit };
  }
  async transfer(mainAccountId: string, request: TransferRequest, { signal, beforeSend }: SendOptions): Promise<TransferAck> {
    this.enter('transfer', signal);
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    const fault = this.takeFault('transfer');
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'lost-request') throw new VenueError('uncertain', '模拟请求超时（未到达交易所）');
    this.arrived.transfer++;
    if (fault?.mode === 'reject') throw new VenueError('rejected', '模拟交易所拒绝划转');
    if (fault?.mode === 'ack-not-success' && fault.applied === false) return { confirmed: false, tranId: null };
    const tranId = this.apply(mainAccountId, request, fault);
    if (fault?.mode === 'lost-response' || fault?.mode === 'one-side' || fault?.mode === 'delayed-history') throw new VenueError('uncertain', '模拟回报丢失（交易所已处理）');
    if (fault?.mode === 'hang-after-apply') await new Promise<void>(resolve => this.hung.push(resolve));
    if (fault?.mode === 'ack-not-success') return { confirmed: false, tranId: fault.hint ? tranId : null };
    return { confirmed: true, tranId: fault?.mode === 'ack-without-tranId' ? null : tranId };
  }
  private apply(mainAccountId: string, request: TransferRequest, fault: AsterFault | null): string {
    const source = this.subs.get(request.source), destination = this.subs.get(request.destination);
    if (!source || !destination || source === destination || source.mainAccountId !== mainAccountId || destination.mainAccountId !== mainAccountId) throw new VenueError('rejected', '子账户不属于该主账户');
    if (source.frozen || destination.frozen) throw new VenueError('rejected', '子账户已冻结');
    if (request.asset !== TRANSFER_ASSET || cmp(request.amount, '0') <= 0 || !isMultiple(request.amount, TRANSFER_UNIT)) throw new VenueError('rejected', '划转资产或金额无效');
    if (cmp(request.amount, source.available) > 0 || (source.maxWithdraw !== null && cmp(request.amount, source.maxWithdraw) > 0)) throw new VenueError('rejected', '可划余额不足');
    const { amount } = request, time = this.clock();
    source.available = sub(source.available, amount); source.equity = sub(source.equity, amount);
    if (source.maxWithdraw !== null) source.maxWithdraw = sub(source.maxWithdraw, amount);
    destination.available = add(destination.available, amount); destination.equity = add(destination.equity, amount);
    if (destination.maxWithdraw !== null) destination.maxWithdraw = add(destination.maxWithdraw, amount);
    const tranId = `t${this.nextId++}`, inboundId = this.splitTranIds ? `t${this.nextId++}` : tranId;
    const delayed = fault?.mode === 'delayed-history' ? time + (fault.delayMs ?? 0) : 0;
    const base = { asset: TRANSFER_ASSET, type: 'transfer', amount, time };
    this.receipts.push({ ...base, accountId: source.accountId, tranId, direction: 'out', visibleAt: delayed });
    if (fault?.mode !== 'one-side' || fault.delayMs !== undefined) {
      this.receipts.push({ ...base, accountId: destination.accountId, tranId: inboundId, direction: 'in', visibleAt: fault?.mode === 'one-side' ? time + (fault.delayMs ?? 0) : delayed });
    }
    this.ledger.push({ tranId, source: source.accountId, destination: destination.accountId, amount, time });
    return tranId;
  }
}
