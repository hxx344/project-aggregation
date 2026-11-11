// Contracts the executor accepts at its boundaries. Every value that crosses a
// process, venue or storage boundary goes through one of these checks; the
// TypeScript types alone are not trusted (plan 5.2).
import { decimal, cmp } from './decimal.ts';

export class ContractError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const reject = (code: string, message: string, status = 400): never => { throw new ContractError(status, code, message); };

export const VENUES = ['binance', 'bybit'] as const;
export type Venue = typeof VENUES[number];
export const VENUE_NAMES: Record<Venue, string> = { binance: 'Binance', bybit: 'Bybit' };
/** Oil contracts each first-batch venue lists in the baseline catalog; ANT is read-only on Binance and absent on Bybit. */
export const OIL_SYMBOLS = ['CLUSDT', 'BZUSDT'] as const;
export const VENUE_EXECUTION_SYMBOLS: Record<Venue, readonly string[]> = { binance: OIL_SYMBOLS, bybit: OIL_SYMBOLS };
export const VENUE_READ_SYMBOLS: Record<Venue, readonly string[]> = { binance: [...OIL_SYMBOLS, 'ANTHROPICUSDT'], bybit: OIL_SYMBOLS };
export const ACCOUNT_MODES: Record<Venue, readonly string[]> = { binance: ['standard', 'portfolio-margin'], bybit: ['unified'] };
export type Environment = 'simulated' | 'mainnet';

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
export function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): Json {
  if (!isObject(value)) return reject('invalid_shape', '参数必须是对象');
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find(key => !allowed.has(key));
  if (extra) reject('unknown_field', `不支持的字段：${extra.slice(0, 40)}`);
  const missing = required.find(key => !Object.hasOwn(value, key));
  if (missing) reject('missing_field', `缺少字段：${missing}`);
  return value;
}
export function oneOf<T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return reject('invalid_value', `${name}无效`);
  return value as T;
}
export function text(value: unknown, name: string, pattern = /^[\x21-\x7e]{1,64}$/): string {
  if (typeof value !== 'string' || !pattern.test(value)) return reject('invalid_value', `${name}无效`);
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return reject('invalid_value', `${name}须为 ${minimum} 至 ${maximum} 的整数`);
  return value as number;
}
export function decimalField(value: unknown, name: string, sign: 'positive' | 'nonnegative' | 'any' = 'positive'): string {
  try { return decimal(value, sign); } catch { return reject('invalid_decimal', `${name}必须是${sign === 'positive' ? '正的' : sign === 'nonnegative' ? '非负的' : ''}十进制字符串`); }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An account is the venue's real principal; a credential version is only a
 * binding to it. Rotating a key keeps the account key and raises the version.
 */
export interface AccountBinding {
  venue: Venue;
  environment: Environment;
  accountId: string;
  accountMode: string;
  credentialVersion: number;
}
export const accountKey = (binding: Pick<AccountBinding, 'venue' | 'environment' | 'accountId'>): string => `${binding.venue}:${binding.environment}:${binding.accountId}`;
export function parseBinding(value: unknown): AccountBinding {
  const raw = exactKeys(value, ['venue', 'environment', 'accountId', 'accountMode', 'credentialVersion']);
  const venue = oneOf(raw.venue, VENUES, '交易所');
  return {
    venue,
    environment: oneOf(raw.environment, ['simulated', 'mainnet'] as const, '环境'),
    accountId: text(raw.accountId, '账户真实身份', /^[0-9A-Za-z_-]{1,64}$/),
    accountMode: oneOf(raw.accountMode, ACCOUNT_MODES[venue], '账户模式'),
    credentialVersion: integer(raw.credentialVersion, 1, Number.MAX_SAFE_INTEGER, '凭据版本'),
  };
}

/** Executable contract. Display names never authorize execution. */
export interface Instrument {
  venue: Venue;
  symbol: string;
  kind: 'linear-perpetual';
  settleAsset: 'USDT';
  contractSize: string;
  tickSize: string;
  quantityStep: string;
  minQuantity: string;
  maxQuantity: string;
  maxMarketQuantity: string;
  minNotional: string;
  catalogVersion: string;
}
export function parseInstrument(value: unknown, venue: Venue, symbol: string): Instrument {
  const raw = exactKeys(value, ['venue', 'symbol', 'kind', 'settleAsset', 'contractSize', 'tickSize', 'quantityStep', 'minQuantity', 'maxQuantity', 'maxMarketQuantity', 'minNotional', 'catalogVersion']);
  if (raw.venue !== venue || raw.symbol !== symbol) reject('instrument_identity', '合约目录身份与请求不一致', 502);
  const instrument: Instrument = {
    venue, symbol,
    kind: oneOf(raw.kind, ['linear-perpetual'] as const, '合约类型'),
    settleAsset: oneOf(raw.settleAsset, ['USDT'] as const, '结算币'),
    contractSize: decimalField(raw.contractSize, '合约乘数'),
    tickSize: decimalField(raw.tickSize, '价格步长'),
    quantityStep: decimalField(raw.quantityStep, '数量步长'),
    minQuantity: decimalField(raw.minQuantity, '最小数量'),
    maxQuantity: decimalField(raw.maxQuantity, '最大数量'),
    maxMarketQuantity: decimalField(raw.maxMarketQuantity, '市价单最大数量'),
    minNotional: decimalField(raw.minNotional, '最小名义金额', 'nonnegative'),
    catalogVersion: text(raw.catalogVersion, '目录版本'),
  };
  if (cmp(instrument.minQuantity, instrument.maxQuantity) > 0) reject('instrument_rule', '合约数量规则不一致', 502);
  return instrument;
}

/**
 * Top of book with its own provenance. receivedAt is the local wall clock when
 * this process received it; forwarding must keep the original value (plan 4.1).
 */
export interface Quote {
  venue: Venue;
  symbol: string;
  bid: string;
  ask: string;
  sourceTime: number | null;
  receivedAt: number;
  connectionGeneration: number;
  sequence: number | null;
  complete: boolean;
}
export function parseQuote(value: unknown, venue: Venue, symbol: string): Quote {
  const raw = exactKeys(value, ['venue', 'symbol', 'bid', 'ask', 'sourceTime', 'receivedAt', 'connectionGeneration', 'sequence', 'complete']);
  if (raw.venue !== venue || raw.symbol !== symbol) reject('quote_identity', '盘口来源与请求合约不一致', 502);
  if (typeof raw.complete !== 'boolean') reject('quote_shape', '盘口完整性标记无效', 502);
  const quote: Quote = {
    venue, symbol,
    bid: decimalField(raw.bid, '买一价'), ask: decimalField(raw.ask, '卖一价'),
    sourceTime: raw.sourceTime === null ? null : integer(raw.sourceTime, 0, Number.MAX_SAFE_INTEGER, '来源时间'),
    receivedAt: integer(raw.receivedAt, 0, Number.MAX_SAFE_INTEGER, '接收时间'),
    connectionGeneration: integer(raw.connectionGeneration, 0, Number.MAX_SAFE_INTEGER, '连接代次'),
    sequence: raw.sequence === null ? null : integer(raw.sequence, 0, Number.MAX_SAFE_INTEGER, '序列'),
    complete: raw.complete as boolean,
  };
  if (cmp(quote.bid, quote.ask) >= 0) reject('quote_crossed', '盘口交叉，暂不使用', 502);
  return quote;
}

/** Freshness is judged from the original receive time; staleness, gaps and future stamps are refusals, not warnings. */
export function checkQuoteFresh(quote: Quote, now: number, maxAgeMs: number, futureToleranceMs: number): void {
  const name = `${VENUE_NAMES[quote.venue]} ${quote.symbol}`;
  if (!quote.complete) reject('quote_incomplete', `${name} 盘口不完整（序列缺口或重建中），暂不下单`, 409);
  if (quote.receivedAt - now > futureToleranceMs) reject('quote_future', `${name} 盘口时间超前，请检查时钟`, 409);
  if (now - quote.receivedAt > maxAgeMs) reject('quote_stale', `${name} 盘口已过期（${now - quote.receivedAt} 毫秒，上限 ${maxAgeMs} 毫秒）`, 409);
}

export type PositionSide = 'long' | 'short';
export interface Position { symbol: string; side: PositionSide; quantity: string }
export interface OpenOrder { symbol: string; clientOrderId: string | null; remoteId: string }
export interface AccountSnapshot {
  venue: Venue;
  accountId: string;
  positionModes: Record<string, 'one-way' | 'hedge'>;
  positions: Position[];
  openOrders: OpenOrder[];
  receivedAt: number;
}
export function parseAccountSnapshot(value: unknown, venue: Venue): AccountSnapshot {
  const raw = exactKeys(value, ['venue', 'accountId', 'positionModes', 'positions', 'openOrders', 'receivedAt']);
  if (raw.venue !== venue) reject('account_identity', '账户快照来源与请求交易所不一致', 502);
  if (!isObject(raw.positionModes) || !Array.isArray(raw.positions) || !Array.isArray(raw.openOrders)) return reject('account_shape', '账户快照结构无效', 502);
  const positionModes: Record<string, 'one-way' | 'hedge'> = {};
  for (const [symbol, mode] of Object.entries(raw.positionModes)) positionModes[text(symbol, '合约')] = oneOf(mode, ['one-way', 'hedge'] as const, '持仓模式');
  const seen = new Set<string>();
  const positions = raw.positions.map(item => {
    const position = exactKeys(item, ['symbol', 'side', 'quantity']);
    const parsed: Position = { symbol: text(position.symbol, '合约'), side: oneOf(position.side, ['long', 'short'] as const, '仓位方向'), quantity: decimalField(position.quantity, '仓位数量', 'nonnegative') };
    const key = `${parsed.symbol}:${parsed.side}`;
    if (seen.has(key)) reject('account_duplicate_position', '交易所返回重复仓位，暂不使用', 502);
    seen.add(key);
    return parsed;
  });
  const openOrders = raw.openOrders.map(item => {
    const order = exactKeys(item, ['symbol', 'clientOrderId', 'remoteId']);
    return { symbol: text(order.symbol, '合约'), clientOrderId: order.clientOrderId === null ? null : text(order.clientOrderId, '客户订单号'), remoteId: text(order.remoteId, '交易所订单号') };
  });
  return { venue, accountId: text(raw.accountId, '账户真实身份', /^[0-9A-Za-z_-]{1,64}$/), positionModes, positions, openOrders, receivedAt: integer(raw.receivedAt, 0, Number.MAX_SAFE_INTEGER, '接收时间') };
}
export function positionOf(snapshot: AccountSnapshot, symbol: string, side: PositionSide): string {
  return snapshot.positions.find(item => item.symbol === symbol && item.side === side)?.quantity ?? '0';
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
/** chase: a venue-native chase strategy, lead leg on Bybit only; it is a strategy, not an order. */
export type LegOrderType = OrderType | 'chase';
export type Action = 'open' | 'close';
export const orderSideOf = (action: Action, side: PositionSide): OrderSide => (action === 'open') === (side === 'long') ? 'buy' : 'sell';

export interface LegIntent { venue: Venue; side: PositionSide; quantity: string; orderType: LegOrderType; limitPrice: string | null }
/** maxSlippageBps: how far either book may move against the preview before the lead is sent; null uses the executor default. */
export interface Intent { market: 'oil'; preset: 'cross-exchange'; symbol: string; action: Action; timeoutMs: number; maxSlippageBps: number | null; legs: [LegIntent, LegIntent] }
export const MAX_SLIPPAGE_BPS = 1_000;
/** First execution slice: one oil contract, two venues, opposite sides. */
export function parseIntent(value: unknown): Intent {
  const raw = exactKeys(value, ['market', 'preset', 'symbol', 'action', 'timeoutMs', 'legs'], ['maxSlippageBps']);
  oneOf(raw.market, ['oil'] as const, '品种');
  oneOf(raw.preset, ['cross-exchange'] as const, '交易预设');
  const symbol = oneOf(raw.symbol, OIL_SYMBOLS, '原油合约');
  const action = oneOf(raw.action, ['open', 'close'] as const, '开平仓操作');
  if (!Array.isArray(raw.legs) || raw.legs.length !== 2) reject('leg_count', '跨所双腿需要正好两条腿');
  const legs = (raw.legs as unknown[]).map(item => {
    const leg = exactKeys(item, ['venue', 'side', 'quantity', 'orderType'], ['limitPrice']);
    const venue = oneOf(leg.venue, VENUES, '交易所');
    if (!VENUE_EXECUTION_SYMBOLS[venue].includes(symbol)) reject('venue_symbol', `${VENUE_NAMES[venue]} 不支持 ${symbol} 执行`);
    const orderType = oneOf(leg.orderType, ['market', 'limit', 'chase'] as const, '下单方式');
    const limitPrice = leg.limitPrice === undefined || leg.limitPrice === null ? null : decimalField(leg.limitPrice, '限价');
    if ((orderType === 'limit') !== (limitPrice !== null)) reject('limit_price', orderType === 'limit' ? '限价单需要限价' : orderType === 'chase' ? '追价策略不设限价（最高追价取预览的价格保护界限）' : '市价单不设限价');
    return { venue, side: oneOf(leg.side, ['long', 'short'] as const, '仓位方向'), quantity: decimalField(leg.quantity, '每腿数量'), orderType, limitPrice };
  }) as [LegIntent, LegIntent];
  if (legs[0].venue === legs[1].venue) reject('same_venue', '跨所双腿须选择两个不同交易所');
  if (legs[0].side === legs[1].side) reject('same_side', '双腿方向必须相反');
  // The hedge must go out at once for whatever the lead filled; a strategy that may rest or pause cannot do that.
  if (legs[1].orderType === 'chase') reject('chase_unsupported', '追价策略只能用于首腿，对冲腿按市价发送');
  if (legs[0].orderType === 'chase' && legs[0].venue !== 'bybit') reject('chase_unsupported', '只有 Bybit 支持原生追价策略');
  const maxSlippageBps = raw.maxSlippageBps === undefined || raw.maxSlippageBps === null ? null : integer(raw.maxSlippageBps, 1, MAX_SLIPPAGE_BPS, '价格保护基点');
  return { market: 'oil', preset: 'cross-exchange', symbol, action, timeoutMs: integer(raw.timeoutMs, 30_000, 3_600_000, '最长执行毫秒数'), maxSlippageBps, legs };
}

/** Confirmation body; confirmLive in the prototype authorizes only the simulated transport. */
export interface Confirm { previewId: string; requestId: string; confirmLive: true }
export function parseConfirm(value: unknown): Confirm {
  const raw = exactKeys(value, ['previewId', 'requestId', 'confirmLive']);
  if (raw.confirmLive !== true) reject('confirm_required', '请从有效预览明确确认执行');
  return { previewId: text(raw.previewId, '预览编号', UUID), requestId: text(raw.requestId, '请求编号', UUID), confirmLive: true };
}

// ---- ASTER margin-balance transfers ---------------------------------------------
// ASTER is not a Venue: it lists no executable contract and takes no account binding, so the order side never sees it.
export const TRANSFER_ASSET = 'USD1';
/** Transfers are sized in whole multiples of this. */
export const TRANSFER_UNIT = '0.00000001';
const TRANSFER_AMOUNT_LIMIT = '1000000000';
/** ASTER principals are wallet addresses; they are compared in lowercase only. */
export const ASTER_ADDRESS = /^0x[0-9a-f]{40}$/;
export const PAIR_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const TRAN_ID = /^[0-9A-Za-z_-]{1,64}$/;
export type PairSide = 'long' | 'short';

export interface TransferConfig {
  /** No transfer unless the two sides' available balances differ by strictly more than this. */
  threshold: string;
  minTransfer: string;
  maxTransfer: string;
  /** Share of the source's equity that stays there as cash. */
  bufferRatio: string;
  cooldownMs: number;
  checkIntervalMs: number;
}
/** Legacy defaults (modules/aster/trading/margin_balance.py DEFAULT_MARGIN). */
export const DEFAULT_TRANSFER_CONFIG: Readonly<TransferConfig> = Object.freeze({ threshold: '10', minTransfer: '1', maxTransfer: '1000', bufferRatio: '0.05', cooldownMs: 30_000, checkIntervalMs: 5_000 });
export function parseTransferConfig(value: unknown): TransferConfig {
  const raw = exactKeys(value ?? {}, [], ['threshold', 'minTransfer', 'maxTransfer', 'bufferRatio', 'cooldownMs', 'checkIntervalMs']);
  const amount = (key: 'threshold' | 'minTransfer' | 'maxTransfer' | 'bufferRatio', name: string, sign: 'positive' | 'nonnegative'): string => {
    const parsed = decimalField(raw[key] ?? DEFAULT_TRANSFER_CONFIG[key], name, sign);
    return cmp(parsed, TRANSFER_AMOUNT_LIMIT) > 0 ? reject('invalid_value', `${name}超出范围`) : parsed;
  };
  const config: TransferConfig = {
    threshold: amount('threshold', '划转门槛', 'nonnegative'),
    minTransfer: amount('minTransfer', '最小划转额', 'positive'),
    maxTransfer: amount('maxTransfer', '单次划转上限', 'positive'),
    bufferRatio: amount('bufferRatio', '现金保留比例', 'nonnegative'),
    cooldownMs: integer(raw.cooldownMs ?? DEFAULT_TRANSFER_CONFIG.cooldownMs, 1_000, 86_400_000, '划转冷却毫秒数'),
    checkIntervalMs: integer(raw.checkIntervalMs ?? DEFAULT_TRANSFER_CONFIG.checkIntervalMs, 1_000, 3_600_000, '检查间隔毫秒数'),
  };
  if (cmp(config.bufferRatio, '1') >= 0) reject('invalid_value', '现金保留比例须小于 1');
  if (cmp(config.minTransfer, TRANSFER_UNIT) < 0 || cmp(config.maxTransfer, config.minTransfer) < 0) reject('invalid_value', `最小划转额至少为 ${TRANSFER_UNIT} USD1，且不得大于单次划转上限`);
  return config;
}

/** A long-side and a short-side sub-account under one main account; funds only ever move between these two. */
export interface TransferPairInput { id: string; mainAccountId: string; long: string; short: string; config: TransferConfig }
export function parseTransferPair(value: unknown): TransferPairInput {
  const raw = exactKeys(value, ['id', 'mainAccountId', 'long', 'short'], ['config']);
  const pair: TransferPairInput = {
    id: text(raw.id, '配对编号', PAIR_ID),
    mainAccountId: text(raw.mainAccountId, '主账户地址', ASTER_ADDRESS),
    long: text(raw.long, '多侧子账户地址', ASTER_ADDRESS),
    short: text(raw.short, '空侧子账户地址', ASTER_ADDRESS),
    config: parseTransferConfig(raw.config),
  };
  if (new Set([pair.mainAccountId, pair.long, pair.short]).size !== 3) reject('pair_accounts', '主账户、多侧与空侧须是三个不同的账户');
  return pair;
}

export interface TransferBalance {
  accountId: string;
  asset: typeof TRANSFER_ASSET;
  /** May be negative on a venue; a negative side has nothing to give. */
  available: string;
  /** May be negative on a venue; planning treats a negative equity as zero. */
  equity: string;
  /** The venue's own withdrawal limit, which already accounts for positions and reserved funds. */
  maxWithdraw: string;
  receivedAt: number;
}
export function parseTransferBalance(value: unknown, accountId: string): TransferBalance {
  const raw = exactKeys(value, ['accountId', 'asset', 'available', 'equity', 'maxWithdraw', 'receivedAt']);
  if (raw.accountId !== accountId) reject('balance_identity', '余额快照的账户与请求不一致', 502);
  return {
    accountId,
    asset: oneOf(raw.asset, [TRANSFER_ASSET] as const, '余额资产'),
    available: decimalField(raw.available, '可用余额', 'any'),
    equity: decimalField(raw.equity, '账户权益', 'any'),
    maxWithdraw: decimalField(raw.maxWithdraw, '可划上限', 'nonnegative'),
    receivedAt: integer(raw.receivedAt, 0, Number.MAX_SAFE_INTEGER, '接收时间'),
  };
}

export interface SubAccountList { mainAccountId: string; subAccounts: { accountId: string; frozen: boolean }[]; receivedAt: number }
/** The listing must name the expected main account and list no sub-account twice; anything else proves no ownership. */
export function parseSubAccountList(value: unknown, mainAccountId: string): SubAccountList {
  const raw = exactKeys(value, ['mainAccountId', 'subAccounts', 'receivedAt']);
  if (raw.mainAccountId !== mainAccountId) reject('sub_account_main', '子账户列表不属于所配置的主账户', 409);
  if (!Array.isArray(raw.subAccounts)) return reject('sub_account_shape', '子账户列表结构无效', 502);
  const seen = new Set<string>();
  const subAccounts = raw.subAccounts.map(item => {
    const row = exactKeys(item, ['accountId', 'frozen']);
    const accountId = text(row.accountId, '子账户地址', ASTER_ADDRESS);
    if (seen.has(accountId)) reject('sub_account_duplicate', '子账户列表包含重复账户', 502);
    seen.add(accountId);
    return { accountId, frozen: typeof row.frozen === 'boolean' ? row.frozen : reject('sub_account_shape', '子账户冻结标记无效', 502) };
  });
  return { mainAccountId, subAccounts, receivedAt: integer(raw.receivedAt, 0, Number.MAX_SAFE_INTEGER, '接收时间') };
}

/** One account's side of a movement. The venue gives a transfer no client id, so this is all that identifies it. */
export interface TransferReceipt { tranId: string; asset: string; type: string; direction: 'in' | 'out'; amount: string; time: number }
/** complete false: the window was not read in full, so the rows prove existence but never absence. */
export interface TransferHistory { accountId: string; rows: TransferReceipt[]; complete: boolean }
export function parseTransferHistory(value: unknown, accountId: string): TransferHistory {
  const raw = exactKeys(value, ['accountId', 'rows', 'complete']);
  if (raw.accountId !== accountId) reject('history_identity', '划转流水的账户与请求不一致', 502);
  if (!Array.isArray(raw.rows) || typeof raw.complete !== 'boolean') return reject('history_shape', '划转流水结构无效', 502);
  const rows = raw.rows.map(item => {
    const row = exactKeys(item, ['tranId', 'asset', 'type', 'direction', 'amount', 'time']);
    return {
      tranId: text(row.tranId, '交易编号', TRAN_ID), asset: text(row.asset, '流水资产'), type: text(row.type, '流水类型'),
      direction: oneOf(row.direction, ['in', 'out'] as const, '流水方向'), amount: decimalField(row.amount, '流水金额'),
      time: integer(row.time, 0, Number.MAX_SAFE_INTEGER, '流水时间'),
    };
  });
  return { accountId, rows, complete: raw.complete };
}
