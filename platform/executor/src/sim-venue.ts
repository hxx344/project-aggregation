// In-memory venue for offline simulation, replay and fault injection. It has no
// network code; it only models the observable behavior the executor relies on.
import { randomUUID } from 'node:crypto';
import { add, cmp, fromUnits, isMultiple, mul, sub, units } from './decimal.ts';
import { VENUE_READ_SYMBOLS, type AccountBinding, type AccountSnapshot, type Instrument, type Quote, type Venue, type PositionSide } from './contracts.ts';
import {
  VenueError, type CallOptions, type ConnectorCapabilities, type OrderReport, type OrderRequest, type SendOptions, type StrategyAck, type StrategyReport, type StrategyRequest, type StrategyStatus, type VenueConnector,
} from './connector.ts';

export type Operation = 'instrument' | 'quote' | 'account' | 'place' | 'query' | 'cancel' | 'strategy-place' | 'strategy-query' | 'strategy-stop' | 'strategy-list';
/**
 * reject: definitive venue refusal. not-sent: refused before transmission.
 * lost-request: the call fails as uncertain and the venue never saw it.
 * lost-response: the venue applies it, the caller gets an uncertain failure.
 * hang-after-apply: the venue applies it and the call never answers until released.
 * read-fail: a read gives no usable answer. not-found: a query misses an order that exists (visibility lag).
 * partial: a market order fills only `filled`; the rest is canceled (IOC). A chase strategy fills only `filled` and keeps working;
 *   `filled` on any other strategy-place fault (lost-response, say) has the same effect.
 * paused: a chase strategy fills `filled` (default nothing), then the venue pauses it.
 * children-lag: a stop ends the strategy, but the next query still shows a child open; the query after that settles it.
 * wrong-id: a chase create is applied, but its answer names `strategyId` instead of the strategy it made.
 * fill-on-stop: a child fills `filled` more just before the stop ends the strategy.
 */
export type FaultMode = 'reject' | 'not-sent' | 'lost-request' | 'lost-response' | 'hang-after-apply' | 'read-fail' | 'not-found' | 'partial' | 'paused' | 'children-lag' | 'wrong-id' | 'fill-on-stop';
export interface Fault { operation: Operation; mode: FaultMode; times?: number; filled?: string; clientOrderId?: string; strategyId?: string }

interface Book { bid: string; ask: string; ageMs: number; complete: boolean; sequence: number }
interface SimOrder { request: OrderRequest; accountId: string; remoteId: string; filled: string; notional: string; status: OrderReport['status']; updatedAt: number }
interface SimStrategy { id: string; accountId: string; request: StrategyRequest; filled: string; notional: string; status: StrategyStatus; childrenSettled: boolean; lagQueries: number; createdAt: number; updatedAt: number }
interface SimAccount { accountId: string; positionModes: Record<string, 'one-way' | 'hedge'>; positions: Map<string, string>; foreignOrders: { symbol: string; remoteId: string }[] }

const TERMINAL = new Set(['filled', 'canceled', 'rejected', 'expired']);

export class SimulatedVenue implements VenueConnector {
  readonly venue: Venue;
  readonly capabilities: ConnectorCapabilities;
  readonly instruments = new Map<string, Instrument>();
  readonly books = new Map<string, Book>();
  readonly accounts = new Map<string, SimAccount>();
  readonly orders = new Map<string, SimOrder>();
  readonly strategies = new Map<string, SimStrategy>();
  /** Requests that reached the venue's matching engine, per operation. */
  readonly arrived: Record<'place' | 'cancel' | 'strategy-place' | 'strategy-stop', number> = { place: 0, cancel: 0, 'strategy-place': 0, 'strategy-stop': 0 };
  readonly calls: Record<Operation, number> = { instrument: 0, quote: 0, account: 0, place: 0, query: 0, cancel: 0, 'strategy-place': 0, 'strategy-query': 0, 'strategy-stop': 0, 'strategy-list': 0 };
  connectionGeneration = 1;
  private faults: Fault[] = [];
  private hung: (() => void)[] = [];
  private nextRemote = 1;
  private readonly clock: () => number;

  constructor(venue: Venue, clock: () => number, { requestValidityMs = 5000 }: { requestValidityMs?: number } = {}) {
    this.venue = venue; this.clock = clock;
    this.capabilities = { transport: 'simulated', clientOrderId: true, queryByClientOrderId: true, cancelByClientOrderId: true, maxClientOrderIdLength: 36, requestValidityMs, ...(venue === 'bybit' ? { chase: true as const } : {}) };
  }

  listInstrument(instrument: Omit<Instrument, 'venue'>, book: { bid: string; ask: string }): void {
    this.instruments.set(instrument.symbol, { ...instrument, venue: this.venue });
    this.books.set(instrument.symbol, { ...book, ageMs: 0, complete: true, sequence: 1 });
  }
  setBook(symbol: string, change: Partial<Omit<Book, 'sequence'>>): void {
    const book = this.books.get(symbol);
    if (!book) throw new Error(`unknown symbol ${symbol}`);
    Object.assign(book, change); book.sequence++;
  }
  openAccount(accountId: string, positionModes: Record<string, 'one-way' | 'hedge'>): void {
    this.accounts.set(accountId, { accountId, positionModes, positions: new Map(), foreignOrders: [] });
  }
  setPosition(accountId: string, symbol: string, side: PositionSide, quantity: string): void { this.requireAccount(accountId).positions.set(`${symbol}:${side}`, quantity); }
  position(accountId: string, symbol: string, side: PositionSide): string { return this.requireAccount(accountId).positions.get(`${symbol}:${side}`) ?? '0'; }
  addForeignOrder(accountId: string, symbol: string): void { this.requireAccount(accountId).foreignOrders.push({ symbol, remoteId: `foreign-${this.nextRemote++}` }); }
  inject(fault: Fault): void { this.faults.push({ times: 1, ...fault }); }
  clearFaults(): void { this.faults = []; }
  /** Lets every hung call answer (the caller may already have given up on it). */
  releaseHung(): void { const waiting = this.hung; this.hung = []; for (const release of waiting) release(); }
  /** Fill part of a resting limit order, as a counterparty would. */
  fillResting(clientOrderId: string, quantity: string): void {
    const order = this.orders.get(clientOrderId);
    if (!order || TERMINAL.has(order.status)) throw new Error('order not resting');
    this.fill(order, quantity, order.request.limitPrice as string);
  }
  /** Fill part of a working chase strategy at the current taker price, as its children would. */
  fillStrategy(strategyId: string, quantity: string): void {
    const strategy = this.strategies.get(strategyId), book = strategy && this.books.get(strategy.request.symbol);
    if (!strategy || !book || strategy.status !== 'working') throw new Error('strategy not working');
    this.strategyFill(strategy, quantity, strategy.request.side === 'buy' ? book.ask : book.bid);
  }
  /** A strategy this executor did not create (another tool or a person); it never moves positions here. */
  addForeignStrategy(accountId: string, request: StrategyRequest, { status = 'working', createdAt = this.clock() }: { status?: StrategyStatus; createdAt?: number } = {}): string {
    this.requireAccount(accountId);
    const id = randomUUID();
    this.strategies.set(id, { id, accountId, request: { ...request }, filled: '0', notional: '0', status, childrenSettled: status === 'terminal', lagQueries: 0, createdAt, updatedAt: createdAt });
    return id;
  }
  strategiesOf(accountId: string): StrategyReport[] {
    return [...this.strategies.values()].filter(item => item.accountId === accountId).map(item => this.strategyReport(item));
  }

  private requireAccount(accountId: string): SimAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    return account;
  }
  private takeFault(operation: Operation, clientOrderId?: string): Fault | null {
    const index = this.faults.findIndex(fault => fault.operation === operation && (!fault.clientOrderId || fault.clientOrderId === clientOrderId));
    if (index < 0) return null;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }
  private enter(operation: Operation, signal: AbortSignal): void {
    this.calls[operation]++;
    if (signal.aborted) throw new VenueError(['place', 'cancel', 'strategy-place', 'strategy-stop'].includes(operation) ? 'not-sent' : 'read-failed', '请求已取消');
  }
  private requireChase(kind: 'not-sent' | 'read-failed'): void {
    if (!this.capabilities.chase) throw new VenueError(kind, '模拟交易所不支持原生追价策略');
  }
  private strategyReport(strategy: SimStrategy): StrategyReport {
    const { request, filled } = strategy;
    return { strategyId: strategy.id, symbol: request.symbol, side: request.side, positionSide: request.positionSide, reduceOnly: request.reduceOnly, quantity: request.quantity, filledQuantity: filled,
      averagePrice: cmp(filled, '0') === 0 ? null : averagePrice(strategy.notional, filled), status: strategy.status, maxChasePrice: request.maxChasePrice, childrenSettled: strategy.childrenSettled, createdAt: strategy.createdAt, updatedAt: strategy.updatedAt };
  }
  private strategyFill(strategy: SimStrategy, quantity: string, price: string): void {
    const account = this.requireAccount(strategy.accountId), key = `${strategy.request.symbol}:${strategy.request.positionSide}`;
    const current = account.positions.get(key) ?? '0';
    const opening = (strategy.request.side === 'buy') === (strategy.request.positionSide === 'long');
    account.positions.set(key, opening ? add(current, quantity) : sub(current, quantity));
    strategy.filled = add(strategy.filled, quantity); strategy.notional = add(strategy.notional, mul(quantity, price));
    if (cmp(strategy.filled, strategy.request.quantity) === 0) { strategy.status = 'terminal'; strategy.childrenSettled = true; }
    strategy.updatedAt = this.clock();
  }
  private readFault(operation: Operation): void {
    const fault = this.takeFault(operation);
    if (fault?.mode === 'read-fail') throw new VenueError('read-failed', `模拟${operation}读取失败`);
  }
  private report(order: SimOrder): OrderReport {
    const filled = order.filled;
    return { clientOrderId: order.request.clientOrderId, remoteId: order.remoteId, symbol: order.request.symbol, side: order.request.side, quantity: order.request.quantity,
      filledQuantity: filled, averagePrice: cmp(filled, '0') === 0 ? null : averagePrice(order.notional, filled), status: order.status, terminal: TERMINAL.has(order.status), updatedAt: order.updatedAt };
  }
  private fill(order: SimOrder, quantity: string, price: string): void {
    const account = this.requireAccount(order.accountId), key = `${order.request.symbol}:${order.request.positionSide}`;
    const current = account.positions.get(key) ?? '0';
    const opening = (order.request.side === 'buy') === (order.request.positionSide === 'long');
    account.positions.set(key, opening ? add(current, quantity) : sub(current, quantity));
    order.filled = add(order.filled, quantity); order.notional = add(order.notional, mul(quantity, price));
    order.status = cmp(order.filled, order.request.quantity) === 0 ? 'filled' : 'partially-filled';
    order.updatedAt = this.clock();
  }
  private async answer<T>(apply: () => T, fault: Fault | null): Promise<T> {
    if (fault?.mode === 'lost-request') throw new VenueError('uncertain', '模拟请求超时（未到达交易所）');
    const value = apply();
    if (fault?.mode === 'lost-response') throw new VenueError('uncertain', '模拟回报丢失（交易所已处理）');
    if (fault?.mode === 'hang-after-apply') await new Promise<void>(resolve => this.hung.push(resolve));
    return value;
  }

  async instrument(symbol: string, { signal }: CallOptions): Promise<Instrument> {
    this.enter('instrument', signal); this.readFault('instrument');
    const instrument = this.instruments.get(symbol);
    if (!instrument) throw new VenueError('read-failed', `模拟交易所未上架 ${symbol}`);
    return { ...instrument };
  }
  async quote(symbol: string, { signal }: CallOptions): Promise<Quote> {
    this.enter('quote', signal); this.readFault('quote');
    const book = this.books.get(symbol);
    if (!book) throw new VenueError('read-failed', `模拟交易所无 ${symbol} 盘口`);
    const receivedAt = this.clock() - book.ageMs;
    return { venue: this.venue, symbol, bid: book.bid, ask: book.ask, sourceTime: receivedAt, receivedAt, connectionGeneration: this.connectionGeneration, sequence: book.sequence, complete: book.complete };
  }
  async account(binding: AccountBinding, symbols: readonly string[], { signal }: CallOptions): Promise<AccountSnapshot> {
    this.enter('account', signal); this.readFault('account');
    const account = this.requireAccount(binding.accountId), wanted = new Set(symbols.filter(symbol => VENUE_READ_SYMBOLS[this.venue].includes(symbol)));
    const positions = [...account.positions].flatMap(([key, quantity]) => {
      const [symbol, side] = key.split(':') as [string, PositionSide];
      return wanted.has(symbol) && cmp(quantity, '0') > 0 ? [{ symbol, side, quantity }] : [];
    });
    // A working strategy, or an ended one whose child is not settled, shows its child as an order without a client id.
    const children = [...this.strategies.values()].filter(item => item.accountId === account.accountId && (item.status === 'working' || (item.status === 'terminal' && !item.childrenSettled)))
      .map(item => ({ symbol: item.request.symbol, clientOrderId: null, remoteId: `child-${item.id.slice(0, 8)}` }));
    const openOrders = [...[...this.orders.values()].filter(order => order.accountId === account.accountId && !TERMINAL.has(order.status)).map(order => ({ symbol: order.request.symbol, clientOrderId: order.request.clientOrderId, remoteId: order.remoteId })),
      ...account.foreignOrders.map(order => ({ symbol: order.symbol, clientOrderId: null, remoteId: order.remoteId })), ...children].filter(order => wanted.has(order.symbol));
    const positionModes = Object.fromEntries(Object.entries(account.positionModes).filter(([symbol]) => wanted.has(symbol)));
    return { venue: this.venue, accountId: account.accountId, positionModes, positions, openOrders, receivedAt: this.clock() };
  }
  async place(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
    this.enter('place', signal);
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    const fault = this.takeFault('place', request.clientOrderId);
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'reject') { this.arrived.place++; throw new VenueError('rejected', '模拟交易所拒绝委托'); }
    return this.answer(() => {
      this.arrived.place++;
      const existing = this.orders.get(request.clientOrderId);
      if (existing) throw new VenueError('rejected', '客户订单号重复');
      const account = this.requireAccount(binding.accountId), instrument = this.instruments.get(request.symbol), book = this.books.get(request.symbol);
      if (!instrument || !book || !isMultiple(request.quantity, instrument.quantityStep)) throw new VenueError('rejected', '数量或合约无效');
      if (request.reduceOnly && cmp(request.quantity, account.positions.get(`${request.symbol}:${request.positionSide}`) ?? '0') > 0) throw new VenueError('rejected', '只减仓数量超过持仓');
      const order: SimOrder = { request: { ...request }, accountId: account.accountId, remoteId: `${this.venue}-${this.nextRemote++}`, filled: '0', notional: '0', status: 'new', updatedAt: this.clock() };
      this.orders.set(request.clientOrderId, order);
      const takerPrice = request.side === 'buy' ? book.ask : book.bid;
      const crosses = request.type === 'market' || (request.side === 'buy' ? cmp(request.limitPrice as string, book.ask) >= 0 : cmp(request.limitPrice as string, book.bid) <= 0);
      if (crosses) {
        const quantity = fault?.mode === 'partial' ? fault.filled ?? '0' : request.quantity;
        if (cmp(quantity, '0') > 0) this.fill(order, quantity, takerPrice);
      }
      if ((request.type === 'market' || request.timeInForce === 'ioc') && order.status !== 'filled') { order.status = 'canceled'; order.updatedAt = this.clock(); }
      return this.report(order);
    }, fault);
  }
  async query(_binding: AccountBinding, request: OrderRequest, { signal }: CallOptions): Promise<OrderReport | null> {
    this.enter('query', signal);
    const fault = this.takeFault('query', request.clientOrderId);
    if (fault?.mode === 'read-fail') throw new VenueError('read-failed', '模拟查询失败');
    const order = this.orders.get(request.clientOrderId);
    if (!order || fault?.mode === 'not-found') return null;
    return this.report(order);
  }
  async cancel(_binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
    this.enter('cancel', signal);
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    const fault = this.takeFault('cancel', request.clientOrderId);
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'reject') { this.arrived.cancel++; throw new VenueError('rejected', '模拟交易所拒绝撤单'); }
    return this.answer(() => {
      this.arrived.cancel++;
      const order = this.orders.get(request.clientOrderId);
      if (!order) throw new VenueError('rejected', '委托不存在');
      if (!TERMINAL.has(order.status)) { order.status = 'canceled'; order.updatedAt = this.clock(); }
      return this.report(order);
    }, fault);
  }

  async placeChase(binding: AccountBinding, request: StrategyRequest, { signal, beforeSend }: SendOptions): Promise<StrategyAck> {
    this.enter('strategy-place', signal); this.requireChase('not-sent');
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    const fault = this.takeFault('strategy-place');
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'reject') { this.arrived['strategy-place']++; throw new VenueError('rejected', '模拟交易所拒绝追价策略'); }
    return this.answer(() => {
      this.arrived['strategy-place']++;
      const account = this.requireAccount(binding.accountId), instrument = this.instruments.get(request.symbol), book = this.books.get(request.symbol);
      if (!instrument || !book || !isMultiple(request.quantity, instrument.quantityStep) || !isMultiple(request.maxChasePrice, instrument.tickSize)) throw new VenueError('rejected', '数量、价格或合约无效');
      if (request.reduceOnly && cmp(request.quantity, account.positions.get(`${request.symbol}:${request.positionSide}`) ?? '0') > 0) throw new VenueError('rejected', '只减仓数量超过持仓');
      const at = this.clock(), strategy: SimStrategy = { id: randomUUID(), accountId: account.accountId, request: { ...request }, filled: '0', notional: '0', status: 'working', childrenSettled: false, lagQueries: 0, createdAt: at, updatedAt: at };
      this.strategies.set(strategy.id, strategy);
      const price = request.side === 'buy' ? book.ask : book.bid;
      const reachable = request.side === 'buy' ? cmp(price, request.maxChasePrice) <= 0 : cmp(price, request.maxChasePrice) >= 0;
      const quantity = fault?.filled ?? (fault?.mode === 'paused' ? '0' : request.quantity);
      if (reachable && cmp(quantity, '0') > 0) this.strategyFill(strategy, quantity, price);
      if (fault?.mode === 'paused' && strategy.status === 'working') strategy.status = 'paused';
      return { strategyId: fault?.mode === 'wrong-id' && fault.strategyId ? fault.strategyId : strategy.id };
    }, fault);
  }
  async queryStrategy(binding: AccountBinding, strategyId: string, { signal }: CallOptions): Promise<StrategyReport | null> {
    this.enter('strategy-query', signal); this.requireChase('read-failed');
    const fault = this.takeFault('strategy-query');
    if (fault?.mode === 'read-fail') throw new VenueError('read-failed', '模拟策略查询失败');
    const strategy = this.strategies.get(strategyId);
    if (fault?.mode === 'hang-after-apply') await new Promise<void>(resolve => this.hung.push(resolve));
    if (!strategy || strategy.accountId !== binding.accountId || fault?.mode === 'not-found') return null;
    if (strategy.status === 'terminal' && !strategy.childrenSettled) {
      if (strategy.lagQueries > 0) strategy.lagQueries--;
      else { strategy.childrenSettled = true; strategy.updatedAt = this.clock(); }
    }
    return this.strategyReport(strategy);
  }
  async stopStrategy(binding: AccountBinding, strategyId: string, { signal, beforeSend }: SendOptions): Promise<StrategyAck> {
    this.enter('strategy-stop', signal); this.requireChase('not-sent');
    try { beforeSend(); } catch (error) { throw new VenueError('not-sent', `发送前守卫拒绝：${(error as Error).message}`); }
    const fault = this.takeFault('strategy-stop');
    if (fault?.mode === 'not-sent') throw new VenueError('not-sent', '模拟本地限流，未发送');
    if (fault?.mode === 'reject') { this.arrived['strategy-stop']++; throw new VenueError('rejected', '模拟交易所拒绝停止策略'); }
    return this.answer(() => {
      this.arrived['strategy-stop']++;
      const strategy = this.strategies.get(strategyId);
      if (!strategy || strategy.accountId !== binding.accountId) throw new VenueError('rejected', '策略不存在');
      if (strategy.status !== 'terminal') {
        const book = this.books.get(strategy.request.symbol);
        if (fault?.mode === 'fill-on-stop' && fault.filled && book) this.strategyFill(strategy, fault.filled, strategy.request.side === 'buy' ? book.ask : book.bid);
      }
      if (strategy.status !== 'terminal') {
        const lag = fault?.mode === 'children-lag';
        Object.assign(strategy, { status: 'terminal', childrenSettled: !lag, lagQueries: lag ? 1 : 0, updatedAt: this.clock() });
      }
      return { strategyId: strategy.id };
    }, fault);
  }
  async listStrategies(binding: AccountBinding, symbol: string, { from, to }: { from: number; to: number }, { signal }: CallOptions): Promise<StrategyReport[]> {
    this.enter('strategy-list', signal); this.requireChase('read-failed'); this.readFault('strategy-list');
    return [...this.strategies.values()].filter(item => item.accountId === binding.accountId && item.request.symbol === symbol && (item.status !== 'terminal' || (item.createdAt >= from && item.createdAt <= to)))
      .map(item => this.strategyReport(item));
  }
}

/** Truncated at 18 digits; the venue's own average is display data, fills stay as quantity and notional. */
const averagePrice = (notional: string, filled: string): string => fromUnits(units(notional) * 10n ** 18n / units(filled));
