// ASTER ADL contracts: the trading connector a pair's two sub-accounts are read
// and reduced through, and the checks every value from it passes. ASTER is not a
// Venue; this surface exists only for the ADL emergency handling (plan 2.3b).
import { cmp, isZero, sub } from './decimal.ts';
import { exactKeys, integer, oneOf, reject, decimalField, text } from './contracts.ts';
import type { CallOptions, SendOptions } from './connector.ts';

/** The venue's own client id on every order it closes by auto-deleveraging; a marker only, never a dedup key. */
export const ADL_CLIENT_ID = 'adl_autoclose';
export const ADL_SYMBOL = /^[A-Z0-9_]{1,64}$/;
/** `adl-` + 28 hex: unique per batch, under the 36-character client id limit of Binance-style venues. */
export const ADL_ORDER_ID = /^adl-[0-9a-f]{28}$/;
export type AdlPositionSide = 'LONG' | 'SHORT' | 'BOTH';
export type Direction = 'long' | 'short';
export const DIRECTION_NAMES: Record<Direction, string> = { long: '多', short: '空' };

// ---- per-pair settings ---------------------------------------------------------
export interface AdlConfig {
  /** Off: positions are still read and an incident still completes once balanced, but nothing is sent. */
  autoReduce: boolean;
  /** Notional cap of one reduce-only market batch, in the contract's quote asset. */
  batchNotional: string;
}
export const DEFAULT_ADL_CONFIG: Readonly<AdlConfig> = Object.freeze({ autoReduce: true, batchNotional: '1000' });
export function parseAdlConfig(value: unknown): AdlConfig {
  const raw = exactKeys(value, ['autoReduce', 'batchNotional']);
  if (typeof raw.autoReduce !== 'boolean') return reject('invalid_value', '自动减仓开关无效');
  const batchNotional = decimalField(raw.batchNotional, '单批金额上限');
  if (cmp(batchNotional, '1') < 0 || cmp(batchNotional, '1000000') > 0) reject('invalid_value', '单批金额上限须为 1 至 1000000');
  return { autoReduce: raw.autoReduce, batchNotional };
}

// ---- venue reads -----------------------------------------------------------------
/** One position row; zero rows are kept because their update time still proves what the venue has applied (L054). */
export interface AdlPosition { symbol: string; positionSide: AdlPositionSide; direction: Direction | null; quantity: string; markPrice: string; updateTime: number }
export interface AdlOpenOrder { symbol: string; clientOrderId: string }
export interface AdlAccountSnapshot {
  accountId: string;
  canTrade: boolean;
  /** Every position row of the requested symbols, zero rows included. */
  positions: AdlPosition[];
  /** Every open order of the requested symbols. */
  openOrders: AdlOpenOrder[];
  /** Local receive time, never a venue time. */
  receivedAt: number;
}
const venueTime = (value: unknown, name: string, now: number, toleranceMs: number): number => {
  const at = integer(value, 0, Number.MAX_SAFE_INTEGER, name);
  if (at > now + toleranceMs) reject('venue_time', `${name}超前本机时钟`, 502);
  return at;
};
export function parseAdlPosition(value: unknown, now: number, toleranceMs: number): AdlPosition {
  const raw = exactKeys(value, ['symbol', 'positionSide', 'amount', 'markPrice', 'updateTime']);
  const symbol = text(raw.symbol, '合约', ADL_SYMBOL), positionSide = oneOf(raw.positionSide, ['LONG', 'SHORT', 'BOTH'] as const, '持仓方向');
  const amount = decimalField(raw.amount, '持仓数量', 'any'), markPrice = decimalField(raw.markPrice, '标记价格');
  const sign = cmp(amount, '0');
  if ((positionSide === 'LONG' && sign < 0) || (positionSide === 'SHORT' && sign > 0)) reject('position_shape', `${symbol} ${positionSide} 持仓数量符号不一致`, 502);
  return { symbol, positionSide, direction: sign > 0 ? 'long' : sign < 0 ? 'short' : null, quantity: sign < 0 ? sub('0', amount) : amount, markPrice, updateTime: venueTime(raw.updateTime, '持仓更新时间', now, toleranceMs) };
}
export function parseAdlAccount(value: unknown, accountId: string, symbols: readonly string[], now: number, toleranceMs: number): AdlAccountSnapshot {
  const raw = exactKeys(value, ['accountId', 'canTrade', 'positions', 'openOrders', 'receivedAt']);
  if (raw.accountId !== accountId) reject('account_identity', 'ASTER 子账户身份与配对不一致', 409);
  if (typeof raw.canTrade !== 'boolean' || !Array.isArray(raw.positions) || !Array.isArray(raw.openOrders)) return reject('account_shape', 'ASTER 账户快照结构无效', 502);
  const wanted = new Set(symbols);
  const positions = raw.positions.map(row => parseAdlPosition(row, now, toleranceMs)).filter(row => wanted.has(row.symbol));
  const seen = new Set<string>();
  for (const row of positions) {
    const key = `${row.symbol}|${row.positionSide}`;
    if (seen.has(key)) reject('position_shape', `${row.symbol} ${row.positionSide} 持仓重复`, 502);
    seen.add(key);
  }
  const openOrders = raw.openOrders.map(row => {
    const order = exactKeys(row, ['symbol', 'clientOrderId']);
    return { symbol: text(order.symbol, '挂单合约', ADL_SYMBOL), clientOrderId: text(order.clientOrderId, '挂单客户编号') };
  });
  return { accountId, canTrade: raw.canTrade, positions, openOrders, receivedAt: venueTime(raw.receivedAt, '快照接收时间', now, toleranceMs) };
}

export interface AdlRule { symbol: string; quantityStep: string; minQuantity: string; maxMarketQuantity: string; tradable: boolean; quoteAsset: string }
export function parseAdlRule(value: unknown, symbol: string): AdlRule {
  const raw = exactKeys(value, ['symbol', 'quantityStep', 'minQuantity', 'maxMarketQuantity', 'tradable', 'quoteAsset']);
  if (raw.symbol !== symbol) reject('rule_identity', `${symbol} 交易规则身份不一致`, 502);
  const rule: AdlRule = {
    symbol, quantityStep: decimalField(raw.quantityStep, '数量步长'), minQuantity: decimalField(raw.minQuantity, '最小数量'),
    maxMarketQuantity: decimalField(raw.maxMarketQuantity, '市价最大数量'), tradable: typeof raw.tradable === 'boolean' ? raw.tradable : reject('rule_shape', '交易状态无效', 502),
    quoteAsset: text(raw.quoteAsset, '计价资产', /^[A-Z0-9]{1,16}$/),
  };
  if (cmp(rule.minQuantity, rule.maxMarketQuantity) > 0) reject('rule_shape', `${symbol} 最小数量大于市价最大数量`, 502);
  return rule;
}

// ---- orders ---------------------------------------------------------------------
export interface AdlOrderRequest { clientOrderId: string; symbol: string; side: 'buy' | 'sell'; positionSide: AdlPositionSide; quantity: string; reduceOnly: true; type: 'market' }
export type AdlOrderStatus = 'new' | 'partially-filled' | 'filled' | 'canceled' | 'expired' | 'rejected';
export const TERMINAL_ADL_ORDER = new Set<AdlOrderStatus>(['filled', 'canceled', 'expired', 'rejected']);
export interface AdlOrderReport {
  clientOrderId: string; orderId: string; symbol: string; side: 'buy' | 'sell'; positionSide: AdlPositionSide;
  quantity: string; filledQuantity: string; averagePrice: string | null; status: AdlOrderStatus; updateTime: number;
}
export function parseAdlOrderReport(value: unknown, request: Pick<AdlOrderRequest, 'clientOrderId' | 'symbol' | 'side' | 'positionSide' | 'quantity'>, now: number, toleranceMs: number): AdlOrderReport {
  const raw = exactKeys(value, ['clientOrderId', 'orderId', 'symbol', 'side', 'positionSide', 'quantity', 'filledQuantity', 'averagePrice', 'status', 'updateTime']);
  const report: AdlOrderReport = {
    clientOrderId: text(raw.clientOrderId, '客户订单号'), orderId: text(raw.orderId, '交易所订单号', /^[0-9]{1,20}$/), symbol: text(raw.symbol, '合约', ADL_SYMBOL),
    side: oneOf(raw.side, ['buy', 'sell'] as const, '委托方向'), positionSide: oneOf(raw.positionSide, ['LONG', 'SHORT', 'BOTH'] as const, '持仓方向'),
    quantity: decimalField(raw.quantity, '委托数量'), filledQuantity: decimalField(raw.filledQuantity, '成交数量', 'nonnegative'),
    averagePrice: raw.averagePrice === null ? null : decimalField(raw.averagePrice, '成交均价'),
    status: oneOf(raw.status, ['new', 'partially-filled', 'filled', 'canceled', 'expired', 'rejected'] as const, '委托状态'),
    updateTime: venueTime(raw.updateTime, '委托更新时间', now, toleranceMs),
  };
  // A report for another order, or one that overstates fills, never settles this batch.
  if (report.clientOrderId !== request.clientOrderId || report.symbol !== request.symbol || report.side !== request.side || report.positionSide !== request.positionSide
    || cmp(report.quantity, request.quantity) !== 0) reject('report_identity', '减仓委托回报的身份或数量与本批不一致', 409);
  if (cmp(report.filledQuantity, report.quantity) > 0) reject('report_shape', '减仓委托成交数量超过委托数量', 502);
  if (report.status === 'filled' && cmp(report.filledQuantity, report.quantity) !== 0) reject('report_shape', '完全成交状态与数量不一致', 502);
  if ((report.status === 'new' || report.status === 'rejected') && !isZero(report.filledQuantity)) reject('report_shape', '未成交状态与数量不一致', 502);
  return report;
}

// ---- ADL evidence ------------------------------------------------------------------
/** One ADL order the venue closed on an account, as reported by the push stream or the force-order history. */
export interface AdlEvidenceRow {
  symbol: string; orderId: string; positionSide: AdlPositionSide; side: 'buy' | 'sell'; quantity: string; filledQuantity: string;
  status: 'new-adl' | 'new' | 'partially-filled' | 'filled' | 'canceled' | 'expired';
  averagePrice: string | null; updateTime: number;
  /** Venue creation time; an ADL fill happens at or after it. */
  time: number;
}
export function parseAdlEvidence(value: unknown, now: number, toleranceMs: number): AdlEvidenceRow {
  const raw = exactKeys(value, ['clientOrderId', 'symbol', 'orderId', 'positionSide', 'side', 'quantity', 'filledQuantity', 'status', 'averagePrice', 'time', 'updateTime']);
  if (raw.clientOrderId !== ADL_CLIENT_ID) reject('evidence_shape', 'ADL 记录的客户编号不是自动减仓标识', 502);
  const row: AdlEvidenceRow = {
    symbol: text(raw.symbol, 'ADL 合约', ADL_SYMBOL), orderId: text(raw.orderId, 'ADL 订单号', /^[0-9]{1,20}$/),
    positionSide: oneOf(raw.positionSide, ['LONG', 'SHORT', 'BOTH'] as const, 'ADL 持仓方向'), side: oneOf(raw.side, ['buy', 'sell'] as const, 'ADL 买卖方向'),
    quantity: decimalField(raw.quantity, 'ADL 原始数量'), filledQuantity: decimalField(raw.filledQuantity, 'ADL 累计成交', 'nonnegative'),
    status: oneOf(raw.status, ['new-adl', 'new', 'partially-filled', 'filled', 'canceled', 'expired'] as const, 'ADL 订单状态'),
    averagePrice: raw.averagePrice === null ? null : decimalField(raw.averagePrice, 'ADL 成交均价'),
    updateTime: venueTime(raw.updateTime, 'ADL 更新时间', now, toleranceMs), time: venueTime(raw.time, 'ADL 创建时间', now, toleranceMs),
  };
  if (row.updateTime < row.time) reject('evidence_shape', 'ADL 更新时间早于创建时间', 502);
  if ((row.positionSide === 'LONG' && row.side !== 'sell') || (row.positionSide === 'SHORT' && row.side !== 'buy')) reject('evidence_shape', 'ADL 减仓方向与持仓方向不一致', 502);
  if (cmp(row.filledQuantity, row.quantity) > 0) reject('evidence_shape', 'ADL 累计成交超过原始数量', 502);
  if (row.status === 'filled' && cmp(row.filledQuantity, row.quantity) !== 0) reject('evidence_shape', 'ADL 完全成交状态与数量不一致', 502);
  if (row.status === 'partially-filled' && (isZero(row.filledQuantity) || cmp(row.filledQuantity, row.quantity) >= 0)) reject('evidence_shape', 'ADL 部分成交状态与数量不一致', 502);
  if ((row.status === 'new' || row.status === 'new-adl') && !isZero(row.filledQuantity)) reject('evidence_shape', 'ADL 未成交状态与数量不一致', 502);
  return row;
}
/** The direction a closed ADL order reduced: a sell closes a long, a buy closes a short. */
export const evidenceDirection = (row: Pick<AdlEvidenceRow, 'side'>): Direction => row.side === 'sell' ? 'long' : 'short';

// ---- connector -------------------------------------------------------------------
export interface AdlCapabilities {
  transport: 'simulated';
  /** The force-order history answers at most this many rows per page; a full page proves nothing about coverage. */
  historyPageLimit: number;
}
/** Every call is made with the named sub-account's own trading authority. */
export interface AdlConnector {
  readonly venue: 'aster';
  readonly capabilities: AdlCapabilities;
  account(accountId: string, symbols: readonly string[], options: CallOptions): Promise<unknown>;
  rule(symbol: string, options: CallOptions): Promise<unknown>;
  /** Throws not-sent, rejected or uncertain like any order send. */
  place(accountId: string, request: AdlOrderRequest, options: SendOptions): Promise<unknown>;
  /** null: the venue answered that it knows no such order, which proves nothing about a request still in flight. */
  query(accountId: string, symbol: string, clientOrderId: string, options: CallOptions): Promise<unknown>;
  cancel(accountId: string, symbol: string, clientOrderId: string, options: SendOptions): Promise<unknown>;
  /** ADL closes with venue update time in [from, to], oldest first, at most limit rows. */
  adlHistory(accountId: string, window: { from: number; to: number }, limit: number, options: CallOptions): Promise<unknown[]>;
  /** Pushed order updates; only ADL closes are passed on. Returns the unsubscribe function. */
  subscribe(listener: (accountId: string, row: unknown) => void): () => void;
}
