// In-memory ASTER sub-accounts with hedge-mode positions, symbol rules,
// reduce-only market orders and ADL closes (pushed and in the force-order
// history), for offline simulation and fault injection of the ADL handling.
// It has no network code.
import { randomBytes } from 'node:crypto';
import { add, cmp, isZero, min, mul, sub } from './decimal.ts';
import { VenueError, type CallOptions, type SendOptions } from './connector.ts';
import { ADL_CLIENT_ID, type AdlCapabilities, type AdlConnector, type AdlOrderRequest, type AdlPositionSide } from './adl-contracts.ts';
import type { AsterPositionsConnector } from './positions.ts';

export type AdlOperation = 'account' | 'positions' | 'rule' | 'place' | 'query' | 'cancel' | 'history';
/**
 * reject: definitive venue refusal. not-sent: refused before transmission.
 * lost-request: uncertain failure, the venue never saw it. lost-response: applied, the caller gets an uncertain failure.
 * rest: the order is accepted but rests unfilled until canceled or `fill()` is called. zero-fill: the order expires unfilled.
 * partial: the order fills `fraction` of its quantity, then expires.
 * read-fail: a read gives no usable answer. not-found: a query answers that no such order exists.
 * malformed: a read answers a row that fails its contract. hang: the call does not answer until released.
 * `accountId` limits a fault to that account.
 */
export type AdlFaultMode = 'reject' | 'not-sent' | 'lost-request' | 'lost-response' | 'rest' | 'zero-fill' | 'partial' | 'read-fail' | 'not-found' | 'malformed' | 'hang';
export interface AdlFault { operation: AdlOperation; mode: AdlFaultMode; times?: number; accountId?: string; fraction?: string }

interface SimPosition { amount: string; updateTime: number; entryPrice: string }
interface SimOrder { request: AdlOrderRequest; orderId: string; filled: string; averagePrice: string | null; status: 'new' | 'partially-filled' | 'filled' | 'canceled' | 'expired'; updateTime: number }
interface SimAccount { canTrade: boolean; positions: Map<string, SimPosition>; orders: Map<string, SimOrder>; extraOpenOrders: { symbol: string; clientOrderId: string }[]; frozenView: Map<string, SimPosition> | null }
interface SimRule { symbol: string; quantityStep: string; minQuantity: string; maxMarketQuantity: string; tradable: boolean; quoteAsset: string }
interface AdlRow { accountId: string; row: Record<string, unknown> }

export class SimulatedAsterTrading implements AdlConnector, AsterPositionsConnector {
  readonly venue = 'aster' as const;
  readonly capabilities: AdlCapabilities;
  readonly calls: Record<AdlOperation, number> = { account: 0, positions: 0, rule: 0, place: 0, query: 0, cancel: 0, history: 0 };
  /** Orders that reached the venue. */
  readonly arrived = { place: 0, cancel: 0 };
  private readonly accounts = new Map<string, SimAccount>();
  private readonly rules = new Map<string, SimRule>();
  private readonly marks = new Map<string, string>();
  private readonly adlRows: AdlRow[] = [];
  private readonly listeners = new Set<(accountId: string, row: unknown) => void>();
  private faults: AdlFault[] = [];
  private hung: (() => void)[] = [];
  /** Requests a lost-request fault kept from the venue, by client id; `arriveLate` delivers one. */
  private readonly lostRequests = new Map<string, { accountId: string; request: AdlOrderRequest }>();
  private nextOrderId = 1_000;
  private readonly clock: () => number;

  constructor(clock: () => number, { historyPageLimit = 100 }: { historyPageLimit?: number } = {}) {
    this.clock = clock;
    this.capabilities = { transport: 'simulated', historyPageLimit };
  }

  // ---- scenario setup ----------------------------------------------------------
  openAccount(accountId: string, { canTrade = true }: { canTrade?: boolean } = {}): void {
    this.accounts.set(accountId, { canTrade, positions: new Map(), orders: new Map(), extraOpenOrders: [], frozenView: null });
  }
  setCanTrade(accountId: string, canTrade: boolean): void { this.requireAccount(accountId).canTrade = canTrade; }
  listRule(rule: Partial<SimRule> & Pick<SimRule, 'symbol'>, markPrice: string): void {
    this.rules.set(rule.symbol, { quantityStep: '0.001', minQuantity: '0.001', maxMarketQuantity: '100', tradable: true, quoteAsset: 'USDT', ...rule });
    this.marks.set(rule.symbol, markPrice);
  }
  setRule(symbol: string, change: Partial<SimRule>): void { Object.assign(this.requireRule(symbol), change); }
  setMark(symbol: string, markPrice: string): void { this.requireRule(symbol); this.marks.set(symbol, markPrice); }
  /** amount is signed: positive long, negative short. The entry price defaults to the current mark. */
  setPosition(accountId: string, symbol: string, positionSide: AdlPositionSide, amount: string, updateTime = this.clock(), entryPrice = this.marks.get(symbol) ?? '0'): void {
    this.requireAccount(accountId).positions.set(`${symbol}|${positionSide}`, { amount, updateTime, entryPrice });
  }
  position(accountId: string, symbol: string, positionSide: AdlPositionSide): string { return this.requireAccount(accountId).positions.get(`${symbol}|${positionSide}`)?.amount ?? '0'; }
  /** Account reads keep answering the positions as they are now, with their old update times, until thawed. */
  freezePositions(accountId: string, frozen = true): void {
    const account = this.requireAccount(accountId);
    account.frozenView = frozen ? new Map([...account.positions].map(([key, value]) => [key, { ...value }])) : null;
  }
  addOpenOrder(accountId: string, symbol: string, clientOrderId: string): void { this.requireAccount(accountId).extraOpenOrders.push({ symbol, clientOrderId }); }
  clearOpenOrders(accountId: string): void { this.requireAccount(accountId).extraOpenOrders = []; }
  inject(fault: AdlFault): void { this.faults.push({ times: 1, ...fault }); }
  clearFaults(): void { this.faults = []; }
  releaseHung(): void { const waiting = this.hung; this.hung = []; for (const release of waiting) release(); }
  orders(accountId: string): { clientOrderId: string; status: string; quantity: string; filled: string }[] {
    return [...this.requireAccount(accountId).orders.values()].map(order => ({ clientOrderId: order.request.clientOrderId, status: order.status, quantity: order.request.quantity, filled: order.filled }));
  }
  /** A request a lost-request fault held back reaches the venue now and rests unfilled. */
  arriveLate(clientOrderId: string): void {
    const lost = this.lostRequests.get(clientOrderId);
    if (!lost) throw new Error(`no lost request ${clientOrderId}`);
    this.lostRequests.delete(clientOrderId);
    this.requireAccount(lost.accountId).orders.set(clientOrderId, { request: lost.request, orderId: String(this.nextOrderId++), filled: '0', averagePrice: null, status: 'new', updateTime: this.clock() });
  }
  /** Someone cancels a resting order on the venue directly (not through the executor). */
  cancelOnVenue(accountId: string, clientOrderId: string): void {
    const order = this.requireAccount(accountId).orders.get(clientOrderId);
    if (!order || (order.status !== 'new' && order.status !== 'partially-filled')) throw new Error(`no resting order ${clientOrderId}`);
    order.status = 'canceled'; order.updateTime = this.clock();
  }
  /** Fills a resting order (whole remainder by default) and reduces the position. */
  fill(accountId: string, clientOrderId: string, quantity?: string): void {
    const account = this.requireAccount(accountId), order = account.orders.get(clientOrderId);
    if (!order || (order.status !== 'new' && order.status !== 'partially-filled')) throw new Error(`no resting order ${clientOrderId}`);
    this.execute(account, order, quantity ?? sub(order.request.quantity, order.filled));
    if (order.status === 'partially-filled' && cmp(order.filled, order.request.quantity) === 0) order.status = 'filled';
  }
  /**
   * The venue closes `quantity` of the position by auto-deleveraging. The history row and the push carry the venue's
   * marker client id; `push` false leaves only the history row, `filled` below `quantity` leaves it partly filled.
   */
  adl(accountId: string, symbol: string, positionSide: AdlPositionSide, quantity: string, { push = true, filled = quantity, at = this.clock() }: { push?: boolean; filled?: string; at?: number } = {}): string {
    const account = this.requireAccount(accountId), key = `${symbol}|${positionSide}`, current = account.positions.get(key);
    if (!current) throw new Error(`no position ${key}`);
    const long = cmp(current.amount, '0') > 0;
    account.positions.set(key, { ...current, amount: long ? sub(current.amount, filled) : add(current.amount, filled), updateTime: at });
    const orderId = String(this.nextOrderId++);
    const row = {
      clientOrderId: ADL_CLIENT_ID, symbol, orderId, positionSide, side: long ? 'sell' : 'buy', quantity, filledQuantity: filled,
      status: isZero(filled) ? 'new-adl' : cmp(filled, quantity) === 0 ? 'filled' : 'partially-filled', averagePrice: isZero(filled) ? null : this.marks.get(symbol) ?? null, time: at, updateTime: at,
    };
    this.adlRows.push({ accountId, row });
    if (push) for (const listener of this.listeners) listener(accountId, { ...row });
    return orderId;
  }
  /** A pushed update for an existing ADL order (cumulative fill grows); the history row follows it. */
  adlUpdate(accountId: string, orderId: string, change: Record<string, unknown>, { push = true }: { push?: boolean } = {}): void {
    const entry = this.adlRows.find(item => item.accountId === accountId && item.row.orderId === orderId);
    if (!entry) throw new Error(`no ADL order ${orderId}`);
    Object.assign(entry.row, change);
    if (push) for (const listener of this.listeners) listener(accountId, { ...entry.row });
  }
  /** Pushes a raw row as the stream would, valid or not. */
  pushRaw(accountId: string, row: unknown): void { for (const listener of this.listeners) listener(accountId, row); }

  // ---- connector ---------------------------------------------------------------
  subscribe(listener: (accountId: string, row: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async account(accountId: string, symbols: readonly string[], { signal }: CallOptions): Promise<unknown> {
    const fault = this.enter('account', signal, accountId);
    await this.readFault(fault, '模拟账户读取失败');
    const account = this.requireAccount(accountId), now = this.clock(), view = account.frozenView ?? account.positions;
    const positions: Record<string, unknown>[] = [];
    for (const symbol of symbols) {
      if (!this.marks.has(symbol)) continue;
      for (const positionSide of ['LONG', 'SHORT'] as const) {
        const row = view.get(`${symbol}|${positionSide}`) ?? { amount: '0', updateTime: 0, entryPrice: '0' };
        positions.push({ symbol, positionSide, amount: row.amount, markPrice: this.marks.get(symbol), updateTime: row.updateTime });
      }
    }
    const openOrders = [...account.orders.values()].filter(order => (order.status === 'new' || order.status === 'partially-filled') && symbols.includes(order.request.symbol))
      .map(order => ({ symbol: order.request.symbol, clientOrderId: order.request.clientOrderId }))
      .concat(account.extraOpenOrders.filter(order => symbols.includes(order.symbol)));
    if (fault?.mode === 'malformed') return { accountId, canTrade: account.canTrade, positions: [{ symbol: 'X' }], openOrders, receivedAt: now };
    return { accountId, canTrade: account.canTrade, positions, openOrders, receivedAt: now };
  }
  /** Every stored row of the account, zero rows included, as the venue's position list answers. */
  async positions(accountId: string, { signal }: CallOptions): Promise<unknown> {
    const fault = this.enter('positions', signal, accountId);
    await this.readFault(fault, '模拟持仓读取失败');
    const account = this.requireAccount(accountId), view = account.frozenView ?? account.positions;
    // Like account(), a symbol without a listed mark is left out.
    const positions = [...view].filter(([key]) => this.marks.has(key.split('|')[0])).map(([key, row]) => {
      const [symbol, positionSide] = key.split('|'), markPrice = this.marks.get(symbol)!;
      return { symbol, positionSide, amount: row.amount, entryPrice: row.entryPrice, markPrice, unrealizedProfit: mul(sub(markPrice, row.entryPrice), row.amount), updateTime: row.updateTime };
    });
    if (fault?.mode === 'malformed') return { accountId, positions: [{ symbol: 'X' }], receivedAt: this.clock() };
    return { accountId, positions, receivedAt: this.clock() };
  }
  async rule(symbol: string, { signal }: CallOptions): Promise<unknown> {
    const fault = this.enter('rule', signal);
    await this.readFault(fault, '模拟交易规则读取失败');
    const rule = this.rules.get(symbol);
    if (!rule) throw new VenueError('read-failed', `模拟交易所没有 ${symbol}`);
    return { ...rule };
  }
  async place(accountId: string, request: AdlOrderRequest, { signal, beforeSend }: SendOptions): Promise<unknown> {
    const fault = this.enter('place', signal, accountId);
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'lost-request') { this.lostRequests.set(request.clientOrderId, { accountId, request }); throw new VenueError('uncertain', '模拟请求超时（未到达交易所）'); }
    if (fault?.mode === 'hang') { await new Promise<void>(resolve => this.hung.push(resolve)); throw new VenueError('uncertain', '模拟请求挂起后断开'); }
    this.arrived.place++;
    const account = this.requireAccount(accountId);
    if (fault?.mode === 'reject') throw new VenueError('rejected', '模拟交易所拒绝减仓单');
    if (!account.canTrade) throw new VenueError('rejected', '模拟账户无交易权限');
    if (account.orders.has(request.clientOrderId)) throw new VenueError('rejected', '客户订单号重复');
    const rule = this.rules.get(request.symbol);
    if (!rule || !rule.tradable || cmp(request.quantity, rule.minQuantity) < 0 || cmp(request.quantity, rule.maxMarketQuantity) > 0) throw new VenueError('rejected', '数量或合约不符合交易规则');
    const order: SimOrder = { request, orderId: String(this.nextOrderId++), filled: '0', averagePrice: null, status: 'new', updateTime: this.clock() };
    account.orders.set(request.clientOrderId, order);
    if (fault?.mode === 'rest') return this.report(order);
    if (fault?.mode === 'zero-fill') { order.status = 'expired'; return this.report(order); }
    const position = account.positions.get(`${request.symbol}|${request.positionSide}`);
    const held = position ? (cmp(position.amount, '0') < 0 ? sub('0', position.amount) : position.amount) : '0';
    // Reduce-only: never more than the position holds.
    let quantity = min(request.quantity, held);
    if (fault?.mode === 'partial') quantity = min(quantity, fault.fraction ?? '0');
    if (!isZero(quantity)) this.execute(account, order, quantity);
    order.status = cmp(order.filled, request.quantity) === 0 ? 'filled' : 'expired';
    order.updateTime = this.clock();
    if (fault?.mode === 'lost-response') throw new VenueError('uncertain', '模拟回报丢失（交易所已处理）');
    return this.report(order);
  }
  async query(accountId: string, symbol: string, clientOrderId: string, { signal }: CallOptions): Promise<unknown> {
    const fault = this.enter('query', signal, accountId);
    await this.readFault(fault, '模拟订单查询失败');
    if (fault?.mode === 'not-found') return null;
    const order = this.requireAccount(accountId).orders.get(clientOrderId);
    if (!order || order.request.symbol !== symbol) return null;
    return this.report(order);
  }
  async cancel(accountId: string, symbol: string, clientOrderId: string, { signal, beforeSend }: SendOptions): Promise<unknown> {
    const fault = this.enter('cancel', signal, accountId);
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'lost-request') throw new VenueError('uncertain', '模拟撤单超时（未到达交易所）');
    this.arrived.cancel++;
    const order = this.requireAccount(accountId).orders.get(clientOrderId);
    if (!order || order.request.symbol !== symbol) throw new VenueError('rejected', '订单不存在');
    if (order.status === 'new' || order.status === 'partially-filled') { order.status = 'canceled'; order.updateTime = this.clock(); }
    if (fault?.mode === 'lost-response') throw new VenueError('uncertain', '模拟撤单回报丢失（交易所已处理）');
    return this.report(order);
  }
  async adlHistory(accountId: string, { from, to }: { from: number; to: number }, limit: number, { signal }: CallOptions): Promise<unknown[]> {
    const fault = this.enter('history', signal, accountId);
    await this.readFault(fault, '模拟 ADL 历史读取失败');
    this.requireAccount(accountId);
    const rows = this.adlRows.filter(item => item.accountId === accountId && (item.row.updateTime as number) >= from && (item.row.updateTime as number) <= to)
      .sort((a, b) => (a.row.updateTime as number) - (b.row.updateTime as number)).slice(0, limit).map(item => ({ ...item.row }));
    if (fault?.mode === 'malformed') rows.push({ clientOrderId: ADL_CLIENT_ID, symbol: 'bad symbol' });
    return rows;
  }

  // ---- internals ---------------------------------------------------------------
  private execute(account: SimAccount, order: SimOrder, quantity: string): void {
    const key = `${order.request.symbol}|${order.request.positionSide}`, position = account.positions.get(key);
    if (!position) throw new Error(`no position ${key}`);
    const now = this.clock();
    account.positions.set(key, { ...position, amount: cmp(position.amount, '0') < 0 ? add(position.amount, quantity) : sub(position.amount, quantity), updateTime: now });
    order.filled = add(order.filled, quantity);
    order.averagePrice = this.marks.get(order.request.symbol) ?? null;
    order.status = cmp(order.filled, order.request.quantity) === 0 ? 'filled' : 'partially-filled';
    order.updateTime = now;
  }
  private report(order: SimOrder): Record<string, unknown> {
    const { request } = order;
    return { clientOrderId: request.clientOrderId, orderId: order.orderId, symbol: request.symbol, side: request.side, positionSide: request.positionSide, quantity: request.quantity,
      filledQuantity: order.filled, averagePrice: order.averagePrice, status: order.status, updateTime: order.updateTime };
  }
  private requireAccount(accountId: string): SimAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new VenueError('read-failed', '模拟交易所没有该子账户');
    return account;
  }
  private requireRule(symbol: string): SimRule {
    const rule = this.rules.get(symbol);
    if (!rule) throw new Error(`unknown symbol ${symbol}`);
    return rule;
  }
  private takeFault(operation: AdlOperation, accountId?: string): AdlFault | null {
    const index = this.faults.findIndex(fault => fault.operation === operation && (!fault.accountId || fault.accountId === accountId));
    if (index < 0) return null;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }
  private enter(operation: AdlOperation, signal: AbortSignal, accountId?: string): AdlFault | null {
    this.calls[operation]++;
    if (signal.aborted) throw new VenueError(operation === 'place' || operation === 'cancel' ? 'not-sent' : 'read-failed', '请求已取消');
    return this.takeFault(operation, accountId);
  }
  private async readFault(fault: AdlFault | null, message: string): Promise<void> {
    if (fault?.mode === 'read-fail') throw new VenueError('read-failed', message);
    if (fault?.mode === 'hang') { await new Promise<void>(resolve => this.hung.push(resolve)); throw new VenueError('read-failed', message); }
  }
}

/** A fresh batch client id: `adl-` + 28 hex. */
export const newAdlClientOrderId = (): string => `adl-${randomBytes(14).toString('hex')}`;
