// Venue connector contract. Each connector declares its real idempotency
// identity and whether an uncertain result can be queried (plan 5.3).
import { exactKeys, oneOf, text, integer, decimalField, reject, type AccountBinding, type AccountSnapshot, type Instrument, type OrderSide, type OrderType, type PositionSide, type Quote, type Venue } from './contracts.ts';
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
  /** Only simulated transports exist in the phase 1 prototype. */
  transport: 'simulated';
  /** Orders carry a client order id the venue indexes and returns. */
  clientOrderId: true;
  queryByClientOrderId: true;
  cancelByClientOrderId: true;
  maxClientOrderIdLength: number;
  /** After this long past the send attempt the venue no longer accepts the signed request (Binance recvWindow, Bybit recv_window). */
  requestValidityMs: number;
}

export interface OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  quantity: string;
  type: OrderType;
  limitPrice: string | null;
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
}
