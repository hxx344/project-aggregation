// Venue connector contract. Each connector declares its real idempotency
// identity and whether an uncertain result can be queried (plan 5.3).
import {
  TRAN_ID, TRANSFER_ASSET, exactKeys, oneOf, text, integer, decimalField, reject,
  type AccountBinding, type AccountSnapshot, type Instrument, type OrderSide, type OrderType, type PositionSide, type Quote, type SubAccountList, type TransferBalance, type TransferHistory, type Venue,
} from './contracts.ts';
import { cmp } from './decimal.ts';

/**
 * not-sent: provably never left this process (local guard, pre-send refusal).
 * rejected: the venue answered with a definitive refusal; nothing rests or fills.
 * uncertain: the request may have reached the venue (timeout, reset, 5xx).
 * read-failed: a read gave no usable answer; it says nothing about any order.
 */
export type VenueErrorKind = 'not-sent' | 'rejected' | 'uncertain' | 'read-failed';
export class VenueError extends Error {
  readonly kind: VenueErrorKind;
  constructor(kind: VenueErrorKind, message: string) { super(message); this.kind = kind; }
}

export interface ConnectorCapabilities {
  /** live: a real venue (3.0b). The executor still refuses every transport but simulated until live wiring (3.0c). */
  transport: 'simulated' | 'live';
  /** Orders carry a client order id the venue indexes and returns. */
  clientOrderId: true;
  queryByClientOrderId: true;
  cancelByClientOrderId: true;
  maxClientOrderIdLength: number;
  /** After this long past the send attempt the venue no longer accepts the signed request (Binance recvWindow, Bybit recv_window). */
  requestValidityMs: number;
  /**
   * Venue-native chase strategy (Bybit /v5/strategy/*). It takes no client id and no idempotency token,
   * so a create without a usable answer can never be retried or matched automatically.
   */
  chase?: true;
}

export interface OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  quantity: string;
  type: OrderType;
  limitPrice: string | null;
  /** ioc: whatever does not fill at once is canceled by the venue. Market orders are always ioc. Absent in rows written before it existed means gtc. */
  timeInForce?: 'gtc' | 'ioc';
  reduceOnly: boolean;
}

export type OrderStatus = 'new' | 'partially-filled' | 'filled' | 'canceled' | 'rejected' | 'expired';
export interface OrderReport {
  clientOrderId: string;
  remoteId: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  status: OrderStatus;
  terminal: boolean;
  updatedAt: number;
}

export function parseOrderReport(value: unknown, request: Pick<OrderRequest, 'clientOrderId' | 'symbol' | 'side' | 'quantity'>): OrderReport {
  const raw = exactKeys(value, ['clientOrderId', 'remoteId', 'symbol', 'side', 'quantity', 'filledQuantity', 'averagePrice', 'status', 'terminal', 'updatedAt']);
  const report: OrderReport = {
    clientOrderId: text(raw.clientOrderId, '客户订单号'),
    remoteId: text(raw.remoteId, '交易所订单号'),
    symbol: text(raw.symbol, '合约'),
    side: oneOf(raw.side, ['buy', 'sell'] as const, '委托方向'),
    quantity: decimalField(raw.quantity, '委托数量'),
    filledQuantity: decimalField(raw.filledQuantity, '成交数量', 'nonnegative'),
    averagePrice: raw.averagePrice === null ? null : decimalField(raw.averagePrice, '成交均价'),
    status: oneOf(raw.status, ['new', 'partially-filled', 'filled', 'canceled', 'rejected', 'expired'] as const, '委托状态'),
    terminal: typeof raw.terminal === 'boolean' ? raw.terminal : reject('report_shape', '委托终态标记无效', 502),
    updatedAt: integer(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, '委托更新时间'),
  };
  // A report for another order, or one that overstates fills, never settles this operation.
  if (report.clientOrderId !== request.clientOrderId || report.symbol !== request.symbol || report.side !== request.side || cmp(report.quantity, request.quantity) !== 0) reject('report_identity', '委托回报的身份或数量与本操作不一致', 409);
  if (cmp(report.filledQuantity, report.quantity) > 0) reject('report_overfill', '委托回报成交数量超过委托数量', 409);
  if (report.terminal !== ['filled', 'canceled', 'rejected', 'expired'].includes(report.status)) reject('report_terminal', '委托终态与状态不一致', 502);
  if ((report.averagePrice === null) !== (cmp(report.filledQuantity, '0') === 0)) reject('report_price', '成交均价与成交数量不一致', 502);
  return report;
}

/** What the venue receives for a chase strategy; maxChasePrice is the worst price it may chase to. */
export interface StrategyRequest {
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  quantity: string;
  maxChasePrice: string;
  reduceOnly: boolean;
}
/** Local record of a chase create. clientOrderId only names the operation here and in the shared registry; the venue never sees it. */
export interface ChaseRequest extends StrategyRequest { clientOrderId: string; type: 'chase' }
export const strategyRequestOf = ({ symbol, side, positionSide, quantity, maxChasePrice, reduceOnly }: ChaseRequest): StrategyRequest => ({ symbol, side, positionSide, quantity, maxChasePrice, reduceOnly });

export const STRATEGY_ID = /^[A-Za-z0-9_-]{1,100}$/;
export interface StrategyAck { strategyId: string }
export function parseStrategyAck(value: unknown): StrategyAck {
  const raw = exactKeys(value, ['strategyId']);
  return { strategyId: text(raw.strategyId, '策略编号', STRATEGY_ID) };
}

/** working: may still place children. paused: stopped by the venue, not over. terminal: no new children. */
export type StrategyStatus = 'working' | 'paused' | 'terminal';
export interface StrategyReport {
  strategyId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  reduceOnly: boolean;
  quantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  status: StrategyStatus;
  maxChasePrice: string;
  /** No child order still open and the children's fills add up to the strategy's executed size; a terminal status alone is not settled. */
  childrenSettled: boolean;
  /** Venue clock. */
  createdAt: number;
  updatedAt: number;
}
export type StrategyIdentity = Pick<StrategyReport, 'symbol' | 'side' | 'positionSide' | 'reduceOnly' | 'quantity' | 'maxChasePrice'> & { strategyId?: string };
/** Without expected the report is only checked for shape, as for a listing; with it, identity must match exactly. */
export function parseStrategyReport(value: unknown, expected?: StrategyIdentity): StrategyReport {
  const raw = exactKeys(value, ['strategyId', 'symbol', 'side', 'positionSide', 'reduceOnly', 'quantity', 'filledQuantity', 'averagePrice', 'status', 'maxChasePrice', 'childrenSettled', 'createdAt', 'updatedAt']);
  const flag = (item: unknown, name: string): boolean => typeof item === 'boolean' ? item : reject('report_shape', `${name}无效`, 502);
  const report: StrategyReport = {
    strategyId: text(raw.strategyId, '策略编号', STRATEGY_ID),
    symbol: text(raw.symbol, '合约'),
    side: oneOf(raw.side, ['buy', 'sell'] as const, '策略方向'),
    positionSide: oneOf(raw.positionSide, ['long', 'short'] as const, '仓位方向'),
    reduceOnly: flag(raw.reduceOnly, '只减仓标记'),
    quantity: decimalField(raw.quantity, '策略数量'),
    filledQuantity: decimalField(raw.filledQuantity, '成交数量', 'nonnegative'),
    averagePrice: raw.averagePrice === null ? null : decimalField(raw.averagePrice, '成交均价'),
    status: oneOf(raw.status, ['working', 'paused', 'terminal'] as const, '策略状态'),
    maxChasePrice: decimalField(raw.maxChasePrice, '最高追价'),
    childrenSettled: flag(raw.childrenSettled, '子单结清标记'),
    createdAt: integer(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, '策略创建时间'),
    updatedAt: integer(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, '策略更新时间'),
  };
  if (expected && ((expected.strategyId !== undefined && report.strategyId !== expected.strategyId) || report.symbol !== expected.symbol || report.side !== expected.side
    || report.positionSide !== expected.positionSide || report.reduceOnly !== expected.reduceOnly || cmp(report.quantity, expected.quantity) !== 0 || cmp(report.maxChasePrice, expected.maxChasePrice) !== 0)) reject('strategy_identity', '策略的合约、方向、仓位方向、数量、最高追价或只减仓与本委托不一致', 409);
  if (cmp(report.filledQuantity, report.quantity) > 0) reject('report_overfill', '策略回报成交数量超过策略数量', 409);
  if ((report.averagePrice === null) !== (cmp(report.filledQuantity, '0') === 0)) reject('report_price', '成交均价与成交数量不一致', 502);
  return report;
}

export interface CallOptions { signal: AbortSignal }
export interface SendOptions extends CallOptions {
  /** Called synchronously right before transmission; a throw means the request was not sent. */
  beforeSend: () => void;
}

export interface VenueConnector {
  readonly venue: Venue;
  readonly capabilities: ConnectorCapabilities;
  instrument(symbol: string, options: CallOptions): Promise<Instrument>;
  quote(symbol: string, options: CallOptions): Promise<Quote>;
  account(binding: AccountBinding, symbols: readonly string[], options: CallOptions): Promise<AccountSnapshot>;
  place(binding: AccountBinding, order: OrderRequest, options: SendOptions): Promise<OrderReport>;
  /** null means the venue answered that no order with this client id exists. */
  query(binding: AccountBinding, order: OrderRequest, options: CallOptions): Promise<OrderReport | null>;
  cancel(binding: AccountBinding, order: OrderRequest, options: SendOptions): Promise<OrderReport>;
  /** Present only with capabilities.chase. An answer only proves acceptance; fills are read with queryStrategy. */
  placeChase?(binding: AccountBinding, request: StrategyRequest, options: SendOptions): Promise<StrategyAck>;
  /** null means the venue answered that no strategy with this id exists on the account. */
  queryStrategy?(binding: AccountBinding, strategyId: string, options: CallOptions): Promise<StrategyReport | null>;
  /** An answer does not prove that nothing filled; the strategy must be read again. */
  stopStrategy?(binding: AccountBinding, strategyId: string, options: SendOptions): Promise<StrategyAck>;
  /**
   * Every working or paused strategy on the symbol, whenever created, plus the ended ones created within [from, to] (venue clock).
   * The answer must be complete (every page read); a listing that cannot be read in full must throw a read failure, never return part of it.
   */
  listStrategies?(binding: AccountBinding, symbol: string, window: { from: number; to: number }, options: CallOptions): Promise<StrategyReport[]>;
}
export type ChaseConnector = VenueConnector & Required<Pick<VenueConnector, 'placeChase' | 'queryStrategy' | 'stopStrategy' | 'listStrategies'>>;
export const supportsChase = (connector: VenueConnector): connector is ChaseConnector => connector.capabilities.chase === true
  && typeof connector.placeChase === 'function' && typeof connector.queryStrategy === 'function' && typeof connector.stopStrategy === 'function' && typeof connector.listStrategies === 'function';

// ---- transfers --------------------------------------------------------------
export interface TransferCapabilities {
  transport: 'simulated';
  /** The transfer endpoint takes no client id and no idempotency token: a send without a usable answer can never be retried or queried by identity. */
  clientTransferId: false;
  /** After this long past the send attempt the venue no longer accepts the signed request (nonce window plus clock skew). */
  requestValidityMs: number;
  /** A receipt can only be tied to a request by account side, amount and time, so another same-amount transfer looks the same. */
  attribution: 'side-amount-time';
}
export interface TransferRequest { source: string; destination: string; asset: typeof TRANSFER_ASSET; amount: string }
/**
 * confirmed true: the venue answered success. confirmed false: it answered with a success code but did not
 * confirm success, so the result is unknown; tranId is then only a hint for matching receipts later.
 */
export interface TransferAck { confirmed: boolean; tranId: string | null }
export function parseTransferAck(value: unknown): TransferAck {
  const raw = exactKeys(value, ['confirmed', 'tranId']);
  return { confirmed: typeof raw.confirmed === 'boolean' ? raw.confirmed : reject('report_shape', '划转回执结构无效', 502), tranId: raw.tranId === null ? null : text(raw.tranId, '交易编号', TRAN_ID) };
}

/** Every call is made with the main account's authority; accountId names one of its sub-accounts. */
export interface TransferConnector {
  readonly venue: 'aster';
  readonly capabilities: TransferCapabilities;
  subAccounts(mainAccountId: string, options: CallOptions): Promise<SubAccountList>;
  balance(mainAccountId: string, accountId: string, options: CallOptions): Promise<TransferBalance>;
  /**
   * The account's receipts with venue time in [from, to]; to null means up to the venue's own now.
   * A window that could not be read in full (a full last page, a later page that failed) answers complete false
   * with the rows that were read; a read with nothing usable throws a read failure.
   */
  history(mainAccountId: string, accountId: string, window: { from: number; to: number | null }, options: CallOptions): Promise<TransferHistory>;
  /** Throws not-sent, rejected or uncertain like an order send; an answer is an acknowledgement, not proof that both receipts exist. */
  transfer(mainAccountId: string, request: TransferRequest, options: SendOptions): Promise<TransferAck>;
}
