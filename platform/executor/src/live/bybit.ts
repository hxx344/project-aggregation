// Real Bybit V5 connector (3.0b): linear orders by orderLinkId and the native chase strategy (/v5/strategy/*). Endpoints
// and the codes that prove a refusal mirror the production client server/trading-execution-exchanges.mjs; the chase shapes
// follow the real-account report in docs/unified-platform-phase0-inventory.md item 47.
import { bybitAuthHeaders } from '../../../../server/exchange-transport/bybit.mjs';
import { createHash } from 'node:crypto';
import { VENUE_EXECUTION_SYMBOLS, accountKey, type AccountBinding, type AccountSnapshot, type Instrument, type OpenOrder, type Position, type PositionSide, type Quote } from '../contracts.ts';
import {
  STRATEGY_ID, VenueError, type CallOptions, type ChaseConnector, type ConnectorCapabilities, type OrderReport, type OrderRequest, type OrderStatus, type SendOptions,
  type StrategyAck, type StrategyReport, type StrategyRequest,
} from '../connector.ts';
import { add, cmp, isZero } from '../decimal.ts';
import { exchange, type FetchLike, type HttpReply } from './http.ts';
import { ShapeError, amount, describe, hedgeClose, identifier, list, millis, optionalPrice, record, validCredentials, type LiveCredentials } from './values.ts';

export interface BybitConnectorOptions {
  /** Resolves the key for one binding; a throw refuses the call before anything is sent. */
  credentials: (binding: AccountBinding) => LiveCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Per HTTP exchange; must stay well under the executor's callTimeoutMs (a create plus its follow-up read is two). */
  timeoutMs?: number;
  ruleTtlMs?: number;
}

const HOST = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const MAX_CLOCK_OFFSET_MS = 300_000;
const IDENTITY_TTL_MS = 60_000;
const MODE_TTL_MS = 60_000;
const MAX_PAGES = 40;
const PAGE_SIZE = 50;
/** The venue lists ended strategies for at most 7 days per query; segments leave 2 s for the widened whole-second bounds. */
const STRATEGY_SEGMENT_MS = 7 * 86_400_000 - 2_000;
const MAX_STRATEGY_WINDOW_MS = 366 * 86_400_000;
const MAX_REMEMBERED_STRATEGIES = 1_000;
const ORDER_LINK_ID = /^[A-Za-z0-9_-]{1,36}$/;
const ORDER_TERMINAL: Record<string, OrderStatus> = { Filled: 'filled', Cancelled: 'canceled', PartiallyFilledCanceled: 'canceled', Deactivated: 'canceled', Rejected: 'rejected' };
const ORDER_WORKING: Record<string, OrderStatus> = { Created: 'new', New: 'new', PartiallyFilled: 'partially-filled' };
/** Strategy status: 2 running, 3 and 4 ended, 5 and 6 paused by the venue. Child status 2 and 4 are still open. */
const STRATEGY_STATES = [2, 3, 4, 5, 6] as const;
const CHILD_STATES = [2, 3, 4, 5, 6, 7] as const;
/**
 * Only explicit parameter, permission, balance and limit refusals prove that nothing executed (copied from the production
 * client). 60081 (same-side chase exists) created nothing. 60062 (strategy terminated, also for an unknown id) and every
 * other code stay uncertain for a write.
 */
const KNOWN_REJECTIONS = new Set([
  10001, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10017, 10024, 10027, 10028, 100029,
  110003, 110004, 110007, 110009, 110012, 110016, 110017, 110020, 110021, 110022, 110032, 110094,
  60063, 60064, 60066, 60067, 60069, 60070, 60075, 60077, 60078, 60079, 60081,
]);
const TIMESTAMP_CODE = 10002;

type Mode = 'one-way' | 'hedge';
type Failure = { kind: 'timestamp' | 'rejected' | 'unknown'; message: string };
function classify(reply: HttpReply): Failure | null {
  const data = reply.data, raw = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as { retCode?: unknown }).retCode : undefined;
  const code = Number.isSafeInteger(raw) ? raw as number : undefined;
  if (reply.status >= 200 && reply.status < 300 && code === 0) return null;
  const text = (data as { retMsg?: unknown } | null)?.retMsg;
  const message = `Bybit HTTP ${reply.status}${code === undefined ? '' : ` 错误码 ${code}`}${typeof text === 'string' ? `：${text.slice(0, 120)}` : ''}`;
  if (reply.status >= 500 || code === undefined) return { kind: 'unknown', message };
  if (code === TIMESTAMP_CODE) return { kind: 'timestamp', message };
  return { kind: KNOWN_REJECTIONS.has(code) ? 'rejected' : 'unknown', message };
}
const sideText = (side: 'buy' | 'sell'): string => side === 'buy' ? 'Buy' : 'Sell';
const sideOf = (value: unknown): 'buy' | 'sell' => value === 'Buy' ? 'buy' : value === 'Sell' ? 'sell' : (() => { throw new ShapeError('方向无效'); })();
function numeric<T extends number>(value: unknown, allowed: readonly T[], name: string): T {
  const parsed = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (!allowed.includes(parsed as T)) throw new ShapeError(`${name} ${String(value).slice(0, 16)} 无法识别`);
  return parsed as T;
}
/** positionIdx: 0 one-way, 1 hedge long, 2 hedge short. */
const positionIdx = (mode: Mode, side: PositionSide): number => mode === 'one-way' ? 0 : side === 'long' ? 1 : 2;
/** The position a one-way order acts on follows from its side and reduceOnly; in hedge mode the two must agree with it. */
const positionSideOf = (side: 'buy' | 'sell', reduceOnly: boolean): PositionSide => (side === 'buy') !== reduceOnly ? 'long' : 'short';

export function createBybitConnector(options: BybitConnectorOptions): ChaseConnector {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 10_000, ruleTtlMs = options.ruleTtlMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw new Error('Bybit 连接器单次请求超时须在 100–15000 毫秒之间');
  let offset = 0;
  const rules = new Map<string, { instrument: Instrument; expiresAt: number }>();
  const identities = new Map<string, { uid: string; at: number; apiKey: string }>();
  const modes = new Map<string, { mode: Mode; at: number; apiKey: string }>();
  /** Symbol of each strategy created here; a strategy id from elsewhere (a restart, a person) is looked up on every symbol. */
  const strategySymbols = new Map<string, string>();
  const bindingKey = (binding: AccountBinding, symbol = ''): string => `${accountKey(binding)}:${binding.credentialVersion}:${symbol}`;

  function credentialsOf(binding: AccountBinding, mutation: boolean): LiveCredentials {
    const fail = (message: string): never => { throw new VenueError(mutation ? 'not-sent' : 'read-failed', message); };
    if (binding.venue !== 'bybit' || binding.environment !== 'mainnet' || binding.accountMode !== 'unified') fail('Bybit 实盘连接器只接受 mainnet 的 Bybit 统一账户');
    let credentials: LiveCredentials;
    try { credentials = options.credentials(binding); } catch (error) { return fail(`Bybit 凭据不可用：${describe(error)}`); }
    if (!validCredentials(credentials)) fail('Bybit 凭据不完整或格式无效');
    return credentials;
  }

  async function syncClock(signal: AbortSignal): Promise<void> {
    const before = now();
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}/v5/market/time`, method: 'GET', maxBytes: 4096 }, { signal });
    const after = now();
    const nano = classify(reply) ? undefined : (record(record(reply.data, '服务器时间').result, '服务器时间').timeNano);
    if (typeof nano !== 'string' || !/^\d{1,25}$/.test(nano) || after - before > 5_000) throw new VenueError('read-failed', 'Bybit 服务器时间读取失败');
    const next = Math.round(Number(BigInt(nano) / 1_000_000n) - (before + after) / 2);
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_CLOCK_OFFSET_MS) throw new VenueError('read-failed', `本机时钟与 Bybit 相差 ${next} 毫秒，超过上限`);
    offset = next;
  }

  async function publicRead(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}${path}?${new URLSearchParams(params)}`, method: 'GET' }, { signal });
    const failure = classify(reply);
    if (failure) throw new VenueError('read-failed', failure.message);
    return record(record(reply.data, '应答').result, '应答结果');
  }

  /**
   * Signed request answering the V5 result object. A timestamp refusal (10002) proves the request did not execute, so it is
   * sent once more with the same body after a clock sync; beforeSend runs again right before the second transmission.
   */
  async function signed(binding: AccountBinding, method: 'GET' | 'POST', path: string, params: Record<string, unknown>, { signal, beforeSend }: { signal: AbortSignal; beforeSend?: () => void }): Promise<Record<string, unknown>> {
    const mutation = method === 'POST';
    const credentials = credentialsOf(binding, mutation);
    const query = mutation ? '' : new URLSearchParams(params as Record<string, string>).toString(), body = mutation ? JSON.stringify(params) : undefined;
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string>;
      try { headers = { ...bybitAuthHeaders(credentials, { timestamp: String(now() + offset), recvWindow: RECV_WINDOW, payload: body ?? query }), ...(mutation ? { 'Content-Type': 'application/json' } : {}) }; }
      catch (error) { // A resend follows a refusal of the first transmission, so that refusal is the answer.
        throw new VenueError(!mutation ? 'read-failed' : attempt > 0 ? 'rejected' : 'not-sent', `Bybit 请求签名失败：${describe(error)}`); }
      let reply: HttpReply;
      try { reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}${path}${query ? `?${query}` : ''}`, method, headers, ...(body === undefined ? {} : { body }) }, { signal, ...(mutation ? { beforeSend: beforeSend ?? (() => undefined) } : {}) }); }
      catch (error) {
        // The first transmission was already refused; a retry stopped before sending leaves that refusal as the answer.
        if (attempt > 0 && error instanceof VenueError && error.kind === 'not-sent') throw new VenueError('rejected', `Bybit 时间戳被拒后未重发：${error.message}`);
        throw error;
      }
      const failure = classify(reply);
      if (!failure) {
        try { return record(record(reply.data, '应答').result, '应答结果'); }
        catch (error) { throw new VenueError(mutation ? 'uncertain' : 'read-failed', `Bybit 应答无法使用：${describe(error)}`); }
      }
      if (failure.kind === 'timestamp' && attempt === 0) {
        try { await syncClock(signal); } catch (error) { throw new VenueError(mutation ? 'rejected' : 'read-failed', `${failure.message}；时钟同步失败：${describe(error)}`); }
        continue;
      }
      throw new VenueError(mutation ? (failure.kind === 'unknown' ? 'uncertain' : 'rejected') : 'read-failed', failure.message);
    }
  }

  /**
   * Every page of a listing. A cursor that repeats, a page beyond the limit or a non-string cursor is a read failure; an
   * absent cursor ends the listing only on a short page (the order-list outer keys are not verified on a real account).
   */
  async function pages(binding: AccountBinding, path: string, params: Record<string, string>, cursorField: string, signal: AbortSignal, category?: string): Promise<unknown[]> {
    const rows: unknown[] = [], seen = new Set<string>();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await signed(binding, 'GET', path, { ...params, ...(cursor ? { cursor } : {}) }, { signal });
      if (category !== undefined && result.category !== category) throw new ShapeError('列表分类与请求不一致');
      const items = list(result.list, '列表', PAGE_SIZE);
      rows.push(...items);
      if (!Object.hasOwn(result, cursorField)) { if (items.length < PAGE_SIZE) return rows; throw new ShapeError('满页列表没有分页游标'); }
      const next = result[cursorField];
      if (typeof next !== 'string' || next.length > 2000 || /[\r\n\0]/.test(next)) throw new ShapeError('分页游标无效');
      if (!next) return rows;
      if (items.length === 0 || seen.has(next)) throw new ShapeError('分页游标重复或空页仍有下一页');
      seen.add(next); cursor = next;
    }
    throw new ShapeError(`列表超过 ${MAX_PAGES} 页`);
  }

  async function reading<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ShapeError) throw new VenueError('read-failed', `Bybit 应答无法使用：${error.message}`);
      throw error;
    }
  }

  /** Position rows of one symbol on one page: exactly index 0 (one-way) or exactly 1 and 2 (hedge). */
  async function readPositions(binding: AccountBinding, symbol: string, signal: AbortSignal): Promise<{ mode: Mode; positions: Position[] }> {
    const result = await signed(binding, 'GET', '/v5/position/list', { category: 'linear', symbol, limit: '200' }, { signal });
    if (result.category !== 'linear') throw new ShapeError('持仓分类与请求不一致');
    const positions: Position[] = [], indices = new Set<number>();
    for (const item of list(result.list, '持仓', 200)) {
      const row = record(item, '持仓');
      if (row.symbol !== symbol) throw new ShapeError('持仓合约与请求不一致');
      const idx = numeric(row.positionIdx, [0, 1, 2] as const, '持仓方向编号');
      if (indices.has(idx)) throw new ShapeError(`持仓方向编号 ${idx} 重复`);
      indices.add(idx);
      const quantity = amount(row.size, '持仓数量', 'nonnegative');
      if (isZero(quantity)) {
        if (!['', 'Buy', 'Sell', 'None'].includes(row.side as string) || (idx === 1 && row.side === 'Sell') || (idx === 2 && row.side === 'Buy')) throw new ShapeError('空仓记录方向无效');
        continue;
      }
      const side = sideOf(row.side);
      if ((idx === 1 && side !== 'buy') || (idx === 2 && side !== 'sell')) throw new ShapeError('持仓方向与编号不一致');
      positions.push({ symbol, side: side === 'buy' ? 'long' : 'short', quantity });
    }
    const mode: Mode | null = indices.size === 1 && indices.has(0) ? 'one-way' : indices.size === 2 && indices.has(1) && indices.has(2) ? 'hedge' : null;
    if (!mode) throw new ShapeError(`${symbol} 的持仓记录不完整，无法确定持仓模式`);
    modes.set(bindingKey(binding, symbol), { mode, at: now(), apiKey: credentialsOf(binding, false).apiKey });
    return { mode, positions };
  }
  async function modeFor(binding: AccountBinding, symbol: string, signal: AbortSignal): Promise<Mode> {
    const cached = modes.get(bindingKey(binding, symbol)), time = now();
    if (cached && cached.apiKey === credentialsOf(binding, true).apiKey && time >= cached.at && time - cached.at < MODE_TTL_MS) return cached.mode;
    try { return (await reading(() => readPositions(binding, symbol, signal))).mode; }
    catch (error) { throw new VenueError('not-sent', `Bybit 持仓模式读取失败，委托未发送：${describe(error)}`); }
  }
  async function readIdentity(binding: AccountBinding, signal: AbortSignal): Promise<string> {
    const key = bindingKey(binding), apiKey = credentialsOf(binding, false).apiKey, cached = identities.get(key), time = now();
    if (cached && cached.apiKey === apiKey && time >= cached.at && time - cached.at < IDENTITY_TTL_MS) return cached.uid;
    const uid = identifier((await signed(binding, 'GET', '/v5/user/query-api', {}, { signal })).userID, 'Bybit 用户编号');
    if (!/^[1-9]\d{0,39}$/.test(uid)) throw new ShapeError('Bybit 用户编号无效');
    identities.set(key, { uid, at: now(), apiKey });
    return uid;
  }

  function orderReport(value: unknown, request: OrderRequest, kind: 'uncertain' | 'read-failed'): OrderReport {
    try {
      const row = record(value, '委托回报');
      if (row.orderLinkId !== request.clientOrderId || row.symbol !== request.symbol || sideOf(row.side) !== request.side) throw new ShapeError('委托回报的客户订单号、合约或方向与请求不一致');
      if (row.orderType !== (request.type === 'market' ? 'Market' : 'Limit')) throw new ShapeError('委托回报类型与请求不一致');
      if (request.type === 'limit' && (row.timeInForce !== (request.timeInForce === 'ioc' ? 'IOC' : 'GTC') || request.limitPrice === null || cmp(amount(row.price, '委托价格'), request.limitPrice) !== 0)) throw new ShapeError('委托回报的价格或有效方式与请求不一致');
      const idx = numeric(row.positionIdx, [0, 1, 2] as const, '持仓方向编号');
      if (typeof row.reduceOnly !== 'boolean' || row.reduceOnly !== request.reduceOnly || (idx !== 0 && idx !== (request.positionSide === 'long' ? 1 : 2))) throw new ShapeError('委托回报仓位方向或只减仓标记与请求不一致');
      const quantity = amount(row.qty, '委托数量'), filledQuantity = amount(row.cumExecQty, '成交数量', 'nonnegative');
      if (cmp(quantity, request.quantity) !== 0 || cmp(filledQuantity, quantity) > 0) throw new ShapeError('委托回报数量无效');
      const statusText = row.orderStatus as string, status = ORDER_TERMINAL[statusText] ?? ORDER_WORKING[statusText];
      if (typeof statusText !== 'string' || !status) throw new ShapeError(`委托状态 ${String(statusText).slice(0, 32)} 无法识别`);
      if (status === 'filled' && cmp(filledQuantity, quantity) !== 0) throw new ShapeError('全部成交的委托成交数量不足');
      const averagePrice = isZero(filledQuantity) ? null : optionalPrice(row.avgPrice, '成交均价');
      if (!isZero(filledQuantity) && averagePrice === null) throw new ShapeError('有成交但没有成交均价');
      return {
        clientOrderId: request.clientOrderId, remoteId: identifier(row.orderId, '交易所订单号'), symbol: request.symbol, side: request.side, quantity, filledQuantity, averagePrice,
        status, terminal: Object.hasOwn(ORDER_TERMINAL, statusText), updatedAt: millis(row.updatedTime ?? row.createdTime, '委托更新时间'),
      };
    } catch (error) {
      if (error instanceof ShapeError) throw new VenueError(kind, `Bybit 委托回报无法使用：${error.message}`);
      throw error;
    }
  }
  /** Recent orders (open or closed) come from realtime, older ones from history; both are keyed by orderLinkId. */
  /** A working order on this symbol and side that a chase placed, or that carries no client id (an unattributed one counts too). */
  async function chaseOrderOpen(binding: AccountBinding, symbol: string, side: 'buy' | 'sell', signal: AbortSignal): Promise<boolean> {
    for (const item of await pages(binding, '/v5/order/realtime', { category: 'linear', symbol, openOnly: '0', limit: String(PAGE_SIZE) }, 'nextPageCursor', signal, 'linear')) {
      const row = record(item, '活动委托');
      if (row.symbol !== symbol || Object.hasOwn(ORDER_TERMINAL, row.orderStatus as string) || sideOf(row.side) !== side) continue;
      if (row.createType === 'CreateByChaseOrder' || typeof row.orderLinkId !== 'string' || row.orderLinkId === '') return true;
    }
    return false;
  }
  async function findOrder(binding: AccountBinding, request: OrderRequest, signal: AbortSignal): Promise<unknown | null> {
    const params = { category: 'linear', symbol: request.symbol, orderLinkId: request.clientOrderId, limit: String(PAGE_SIZE) };
    let rows = await reading(() => pages(binding, '/v5/order/realtime', params, 'nextPageCursor', signal, 'linear'));
    if (rows.length === 0) rows = await reading(() => pages(binding, '/v5/order/history', params, 'nextPageCursor', signal, 'linear'));
    if (rows.length > 1) throw new VenueError('read-failed', 'Bybit 同一客户订单号返回了多笔委托');
    return rows[0] ?? null;
  }

  function strategyReport(value: unknown, children: unknown[] | null): StrategyReport {
    const row = record(value, '策略');
    if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(row.symbol as string) || row.category !== 'UTA_USDT' || row.strategyType !== 'chaseOrder' || typeof row.reduceOnly !== 'boolean') throw new ShapeError('策略的合约、分类或类型无效');
    const strategyId = typeof row.strategyId === 'string' && STRATEGY_ID.test(row.strategyId) ? row.strategyId : (() => { throw new ShapeError('策略编号无效'); })();
    const side = sideOf(row.side), positionSide = positionSideOf(side, row.reduceOnly);
    const state = numeric(row.status, STRATEGY_STATES, '策略状态');
    const quantity = amount(row.size, '策略数量'), filledQuantity = amount(row.executedSize, '策略成交数量', 'nonnegative');
    if (cmp(filledQuantity, quantity) > 0) throw new ShapeError('策略成交数量超过策略数量');
    const averagePrice = isZero(filledQuantity) ? null : optionalPrice(row.executedAvgPrice, '策略成交均价');
    if (!isZero(filledQuantity) && averagePrice === null) throw new ShapeError('策略有成交但没有成交均价');
    // Status 4 is still ending and may have a resting order, so only status 3 can settle.
    const terminal = state === 3 || state === 4, createdAt = millis(row.createdTimeE3, '策略创建时间');
    let childrenSettled = false;
    if (children) {
      const known = new Map<string, { fingerprint: string; filled: string }>();
      let open = false;
      for (const item of children) {
        const child = record(item, '子单');
        if (child.strategyId !== strategyId || child.symbol !== row.symbol || sideOf(child.side) !== side || (Object.hasOwn(child, 'category') && child.category !== 'UTA_USDT')) throw new ShapeError('子单的策略、合约或方向与策略不一致');
        const idx = numeric(child.positionIdx, [0, 1, 2] as const, '子单持仓方向编号');
        if (idx !== 0 && idx !== (positionSide === 'long' ? 1 : 2)) throw new ShapeError('子单仓位方向与策略不一致');
        const childState = numeric(child.status, CHILD_STATES, '子单状态');
        const size = amount(child.size, '子单数量'), filled = amount(child.executedSize, '子单成交数量', 'nonnegative');
        // The venue reports the text UNKNOWN for a chase child (documented as 1 market, 2 limit).
        if ((child.orderType !== 'UNKNOWN' && numeric(child.orderType, [1, 2] as const, '子单类型') !== 2) || cmp(filled, size) > 0 || (childState === 5 && cmp(filled, size) !== 0)) throw new ShapeError('子单类型或数量无效');
        const id = identifier(child.orderId, '子单编号'), fingerprint = JSON.stringify([idx, childState, size, filled]);
        const seen = known.get(id);
        if (seen) { if (seen.fingerprint !== fingerprint) throw new ShapeError('同一子单在分页中前后不一致'); continue; }
        known.set(id, { fingerprint, filled });
        if (childState === 2 || childState === 4) open = true;
      }
      const childFilled = add('0', ...[...known.values()].map(item => item.filled));
      if (cmp(childFilled, quantity) > 0) throw new ShapeError('子单成交合计超过策略数量');
      // REST snapshots race: release only when the strategy has ended, no child is open and the totals agree.
      childrenSettled = state === 3 && !open && cmp(childFilled, filledQuantity) === 0;
    }
    return {
      strategyId, symbol: row.symbol as string, side, positionSide, reduceOnly: row.reduceOnly, quantity, filledQuantity, averagePrice,
      status: terminal ? 'terminal' : state === 2 ? 'working' : 'paused', maxChasePrice: amount(row.maxChasePrice, '最高追价'), childrenSettled,
      createdAt, updatedAt: row.updatedTimeE3 === undefined ? createdAt : millis(row.updatedTimeE3, '策略更新时间'),
    };
  }
  const strategyQuery = (symbol: string, extra: Record<string, string>) => ({ category: 'UTA_USDT', symbol, strategyType: 'chaseOrder', pageSize: String(PAGE_SIZE), ...extra });

  async function sideChecked(binding: AccountBinding, symbol: string, side: 'buy' | 'sell', positionSide: PositionSide, reduceOnly: boolean, signal: AbortSignal): Promise<number> {
    const mode = await modeFor(binding, symbol, signal);
    if (mode === 'hedge' && hedgeClose(side, positionSide) !== reduceOnly) throw new VenueError('not-sent', 'Bybit 双向持仓模式下只减仓标记与仓位方向不一致，未发送');
    if (mode === 'one-way' && positionSideOf(side, reduceOnly) !== positionSide) throw new VenueError('not-sent', 'Bybit 单向持仓模式下仓位方向与买卖方向、只减仓标记不一致，未发送');
    return positionIdx(mode, positionSide);
  }

  const capabilities: ConnectorCapabilities = {
    transport: 'live', clientOrderId: true, queryByClientOrderId: true, cancelByClientOrderId: true, maxClientOrderIdLength: 36,
    // Bybit accepts a request while server time - recv_window <= timestamp < server time + 1000 ms, so at most about 6 s
    // after it was signed; 10 s leaves room for scheduling.
    requestValidityMs: 10_000,
    chase: true,
  };

  return {
    venue: 'bybit',
    capabilities,

    instrument: (symbol: string, { signal }: CallOptions) => reading(async (): Promise<Instrument> => {
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在 Bybit 可读合约内`);
      const cached = rules.get(symbol), time = now();
      if (cached && time >= cached.expiresAt - ruleTtlMs && time < cached.expiresAt) return { ...cached.instrument };
      const result = await publicRead('/v5/market/instruments-info', { category: 'linear', symbol }, signal);
      const rows = list(result.list, '合约目录', 2);
      if (result.category !== 'linear' || rows.length !== 1) throw new ShapeError(`合约目录里没有唯一的 ${symbol}`);
      const row = record(rows[0], '合约');
      if (row.symbol !== symbol || row.status !== 'Trading' || row.contractType !== 'LinearPerpetual' || row.quoteCoin !== 'USDT' || row.settleCoin !== 'USDT' || row.unifiedMarginTrade !== true) throw new ShapeError(`${symbol} 当前不可交易或不是 USDT 永续`);
      const price = record(row.priceFilter, '价格规则'), lot = record(row.lotSizeFilter, '数量规则');
      const fields = {
        tickSize: amount(price.tickSize, '价格步长'), quantityStep: amount(lot.qtyStep, '数量步长'), minQuantity: amount(lot.minOrderQty, '最小数量'), maxQuantity: amount(lot.maxOrderQty, '最大数量'),
        maxMarketQuantity: amount(lot.maxMktOrderQty, '市价最大数量'), minNotional: amount(lot.minNotionalValue, '最小名义金额', 'nonnegative'),
      };
      const instrument: Instrument = { venue: 'bybit', symbol, kind: 'linear-perpetual', settleAsset: 'USDT', contractSize: '1', ...fields, catalogVersion: `by-${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16)}` };
      rules.set(symbol, { instrument, expiresAt: now() + ruleTtlMs });
      return { ...instrument };
    }),

    quote: (symbol: string, { signal }: CallOptions) => reading(async (): Promise<Quote> => {
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在 Bybit 可读合约内`);
      const book = await publicRead('/v5/market/orderbook', { category: 'linear', symbol, limit: '1' }, signal);
      const receivedAt = now();
      const level = (side: unknown, name: string): string => {
        const levels = list(side, name, 1), top = list(levels[0], name, 2);
        if (levels.length !== 1 || top.length !== 2) throw new ShapeError(`${name}缺失`);
        amount(top[1], `${name}数量`);
        return amount(top[0], name);
      };
      if (book.s !== symbol) throw new ShapeError('盘口合约与请求不一致');
      return { venue: 'bybit', symbol, bid: level(book.b, '买一价'), ask: level(book.a, '卖一价'), sourceTime: millis(book.ts, '盘口时间'), receivedAt, connectionGeneration: 0, sequence: null, complete: true };
    }),

    account: (binding: AccountBinding, symbols: readonly string[], { signal }: CallOptions) => reading(async (): Promise<AccountSnapshot> => {
      if (symbols.length === 0 || symbols.some(symbol => !VENUE_EXECUTION_SYMBOLS.bybit.includes(symbol))) throw new VenueError('read-failed', '账户快照的合约无效');
      const accountId = await readIdentity(binding, signal);
      const positions: Position[] = [], openOrders: OpenOrder[] = [], positionModes: Record<string, Mode> = {}, seenOrders = new Set<string>(), seenStrategies = new Set<string>();
      for (const symbol of symbols) {
        // Orders and strategies before positions: one that fills between the reads still shows up in the later position read.
        for (const item of await pages(binding, '/v5/order/realtime', { category: 'linear', symbol, openOnly: '0', limit: String(PAGE_SIZE) }, 'nextPageCursor', signal, 'linear')) {
          const row = record(item, '活动委托');
          if (row.symbol !== symbol) throw new ShapeError('活动委托合约与请求不一致');
          const id = identifier(row.orderId, '交易所订单号'), status = row.orderStatus as string;
          if (!Object.hasOwn(ORDER_TERMINAL, status) && !Object.hasOwn(ORDER_WORKING, status) && status !== 'Untriggered' && status !== 'Triggered') throw new ShapeError(`委托状态 ${String(status).slice(0, 32)} 无法识别`);
          if (seenOrders.has(id)) throw new ShapeError('活动委托重复');
          seenOrders.add(id);
          // A chase's resting order has an empty orderLinkId (createType CreateByChaseOrder) and counts as foreign.
          if (!Object.hasOwn(ORDER_TERMINAL, status)) openOrders.push({ symbol, clientOrderId: typeof row.orderLinkId === 'string' && /^[\x21-\x7e]{1,64}$/.test(row.orderLinkId) ? row.orderLinkId : null, remoteId: id });
        }
        // A running or paused chase may place orders at any time, and one ending (4) may still have orders (as in the
        // production client), so every one of them counts as foreign activity.
        for (const status of ['2', '4', '5', '6']) {
          for (const item of await pages(binding, '/v5/strategy/list', strategyQuery(symbol, { status }), 'nextCursor', signal)) {
            // Only the id and symbol are needed here; a strategy created elsewhere may lack fields the executor's own need.
            const strategy = record(item, '策略');
            if (strategy.symbol !== symbol || typeof strategy.strategyId !== 'string' || !STRATEGY_ID.test(strategy.strategyId)) throw new ShapeError('策略合约或编号无效');
            // A strategy can move between status buckets during this snapshot.
            if (seenStrategies.has(strategy.strategyId)) continue;
            seenStrategies.add(strategy.strategyId);
            openOrders.push({ symbol, clientOrderId: null, remoteId: `chase-${strategy.strategyId}` });
          }
        }
        const read = await readPositions(binding, symbol, signal);
        positionModes[symbol] = read.mode;
        positions.push(...read.positions);
      }
      return { venue: 'bybit', accountId, positionModes, positions, openOrders, receivedAt: now() };
    }),

    async place(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      const refuse = (message: string): never => { throw new VenueError('not-sent', `Bybit 委托未发送：${message}`); };
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(request.symbol)) refuse(`${request.symbol} 不是可执行合约`);
      if (!ORDER_LINK_ID.test(request.clientOrderId)) refuse('客户订单号格式无效');
      try { amount(request.quantity, '数量'); if (request.limitPrice !== null) amount(request.limitPrice, '限价'); } catch { refuse('数量或价格无效'); }
      if (request.type === 'market' && (request.limitPrice !== null || request.timeInForce === 'gtc')) refuse('市价单不带限价，只能 IOC');
      if (request.type === 'limit' && request.limitPrice === null) refuse('限价单缺少价格');
      credentialsOf(binding, true);
      const idx = await sideChecked(binding, request.symbol, request.side, request.positionSide, request.reduceOnly, signal);
      const body = {
        category: 'linear', symbol: request.symbol, side: sideText(request.side), orderType: request.type === 'market' ? 'Market' : 'Limit', qty: request.quantity,
        ...(request.type === 'limit' ? { price: request.limitPrice, timeInForce: request.timeInForce === 'ioc' ? 'IOC' : 'GTC' } : {}),
        positionIdx: idx, reduceOnly: request.reduceOnly, orderLinkId: request.clientOrderId,
      };
      const ack = await signed(binding, 'POST', '/v5/order/create', body, { signal, beforeSend });
      let remoteId: string;
      try {
        if (ack.orderLinkId !== request.clientOrderId) throw new ShapeError('下单回执的客户订单号与请求不一致');
        remoteId = identifier(ack.orderId, '交易所订单号');
      } catch (error) { throw new VenueError('uncertain', `Bybit 下单回执无法使用：${describe(error)}`); }
      // The create answers only an acknowledgement. One read gives the first state; when it fails the acceptance is
      // reported as a new order with nothing filled, which the executor reconciles by client id like any working order.
      // An order that is found but does not match is an identity conflict, not a fallback.
      let row: unknown = null;
      try { row = await findOrder(binding, request, signal); }
      catch (error) { if (!(error instanceof VenueError && error.kind === 'read-failed')) throw error; }
      if (row !== null) {
        const report = orderReport(row, request, 'uncertain');
        if (report.remoteId !== remoteId) throw new VenueError('uncertain', 'Bybit 同一客户订单号查到的委托编号与下单回执不一致');
        return report;
      }
      return { clientOrderId: request.clientOrderId, remoteId, symbol: request.symbol, side: request.side, quantity: request.quantity, filledQuantity: '0', averagePrice: null, status: 'new', terminal: false, updatedAt: now() + offset };
    },

    async query(binding: AccountBinding, request: OrderRequest, { signal }: CallOptions): Promise<OrderReport | null> {
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(request.symbol)) throw new VenueError('read-failed', `${request.symbol} 不是可执行合约`);
      const row = await findOrder(binding, request, signal);
      return row === null ? null : orderReport(row, request, 'read-failed');
    },

    async cancel(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(request.symbol) || !ORDER_LINK_ID.test(request.clientOrderId)) throw new VenueError('not-sent', 'Bybit 撤单未发送：合约或客户订单号无效');
      const ack = await signed(binding, 'POST', '/v5/order/cancel', { category: 'linear', symbol: request.symbol, orderLinkId: request.clientOrderId }, { signal, beforeSend });
      if (ack.orderLinkId !== request.clientOrderId) throw new VenueError('uncertain', 'Bybit 撤单回执的客户订单号与请求不一致');
      // The cancel answers only an acknowledgement; without a readable order the outcome stays open and is read again later.
      let row: unknown;
      try { row = await findOrder(binding, request, signal); } catch (error) { throw new VenueError('uncertain', `Bybit 撤单已受理，委托回报读取失败：${describe(error)}`); }
      if (row === null) throw new VenueError('uncertain', 'Bybit 撤单已受理，但查不到该委托');
      return orderReport(row, request, 'uncertain');
    },

    async placeChase(binding: AccountBinding, request: StrategyRequest, { signal, beforeSend }: SendOptions): Promise<StrategyAck> {
      const refuse = (message: string): never => { throw new VenueError('not-sent', `Bybit 追价策略未发送：${message}`); };
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(request.symbol)) refuse(`${request.symbol} 不是可执行合约`);
      try { amount(request.quantity, '数量'); amount(request.maxChasePrice, '最高追价'); } catch { refuse('数量或最高追价无效'); }
      credentialsOf(binding, true);
      const idx = await sideChecked(binding, request.symbol, request.side, request.positionSide, request.reduceOnly, signal);
      // chasePercentE4 0 chases at the best price; chaseDistance "0" is refused by the venue (10001).
      const body = {
        category: 'UTA_USDT', symbol: request.symbol, side: sideText(request.side), size: request.quantity, strategyType: 'chaseOrder',
        positionIdx: idx, reduceOnly: request.reduceOnly, chasePercentE4: 0, maxChasePrice: request.maxChasePrice,
      };
      const ack = await signed(binding, 'POST', '/v5/strategy/create', body, { signal, beforeSend });
      if (ack.result !== null || typeof ack.strategyId !== 'string' || !STRATEGY_ID.test(ack.strategyId)) throw new VenueError('uncertain', 'Bybit 追价策略回执无法使用');
      strategySymbols.set(ack.strategyId, request.symbol);
      // Bounded: a forgotten id is found again by trying every execution symbol.
      if (strategySymbols.size > MAX_REMEMBERED_STRATEGIES) strategySymbols.delete(strategySymbols.keys().next().value!);
      return { strategyId: ack.strategyId };
    },

    queryStrategy: (binding: AccountBinding, strategyId: string, { signal }: CallOptions) => reading(async (): Promise<StrategyReport | null> => {
      if (!STRATEGY_ID.test(strategyId)) throw new VenueError('read-failed', '策略编号格式无效');
      const remembered = strategySymbols.get(strategyId);
      // An unknown id answers an empty list, so trying each execution symbol is a complete search.
      for (const symbol of remembered ? [remembered] : VENUE_EXECUTION_SYMBOLS.bybit) {
        const rows = await pages(binding, '/v5/strategy/list', strategyQuery(symbol, { strategyId }), 'nextCursor', signal);
        if (rows.length === 0) continue;
        if (rows.length !== 1) throw new ShapeError('同一策略编号返回了多条记录');
        const children = await pages(binding, '/v5/strategy/order-list', { strategyId, symbol, strategyType: 'chaseOrder', pageSize: String(PAGE_SIZE) }, 'nextCursor', signal);
        const report = strategyReport(rows[0], children);
        if (report.strategyId !== strategyId || report.symbol !== symbol) throw new ShapeError('策略记录的编号或合约与查询不一致');
        // While a chase rests its order is listed only in realtime, never as a child (inventory item 47), and it may
        // linger there after the strategy ends: any working chase-created order on this side holds the release.
        if (report.childrenSettled && await chaseOrderOpen(binding, symbol, report.side, signal)) return { ...report, childrenSettled: false };
        return report;
      }
      return null;
    }),

    async stopStrategy(binding: AccountBinding, strategyId: string, { signal, beforeSend }: SendOptions): Promise<StrategyAck> {
      if (!STRATEGY_ID.test(strategyId)) throw new VenueError('not-sent', 'Bybit 停止策略未发送：策略编号格式无效');
      const ack = await signed(binding, 'POST', '/v5/strategy/stop', { strategyId }, { signal, beforeSend });
      if (ack.strategyId !== strategyId) throw new VenueError('uncertain', 'Bybit 停止回执的策略编号与请求不一致');
      return { strategyId };
    },

    /**
     * Running and paused strategies whatever their age, plus ended ones created in the window. The venue filters by creation
     * time in whole seconds and an end may be exclusive, so the query starts a second early and the rows are filtered again.
     * Listing reports never read children: childrenSettled is always false here.
     */
    listStrategies: (binding: AccountBinding, symbol: string, window: { from: number; to: number }, { signal }: CallOptions) => reading(async (): Promise<StrategyReport[]> => {
      if (!VENUE_EXECUTION_SYMBOLS.bybit.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不是可执行合约`);
      if (!Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.from < 0 || window.to < window.from || window.to - window.from > MAX_STRATEGY_WINDOW_MS) throw new VenueError('read-failed', '策略查询时间窗无效');
      const found = new Map<string, StrategyReport>();
      const keep = (report: StrategyReport): void => {
        if (report.symbol !== symbol) throw new ShapeError('策略合约与请求不一致');
        const seen = found.get(report.strategyId);
        // A strategy can move between buckets while they are read; a running state anywhere wins.
        if (!seen || (seen.status === 'terminal' && report.status !== 'terminal')) found.set(report.strategyId, report);
      };
      const inWindow = (report: StrategyReport): boolean => report.status !== 'terminal' || (report.createdAt >= window.from && report.createdAt <= window.to);
      // Active buckets have no time filter (status 4 is an ending strategy that may still have orders); ended ones (3) are
      // read for the window only, starting a second early because the venue's bounds may be exclusive.
      for (const status of ['2', '4', '5', '6']) {
        for (const item of await pages(binding, '/v5/strategy/list', strategyQuery(symbol, { status }), 'nextCursor', signal)) {
          const report = strategyReport(item, null);
          if (inWindow(report)) keep(report);
        }
      }
      for (let from = window.from; from <= window.to; from += STRATEGY_SEGMENT_MS) {
        const to = Math.min(from + STRATEGY_SEGMENT_MS, window.to);
        const range = { beginTimeE0: String(Math.floor(from / 1000) - 1), endTimeE0: String(Math.ceil(to / 1000)) };
        for (const item of await pages(binding, '/v5/strategy/list', strategyQuery(symbol, { status: '3', ...range }), 'nextCursor', signal)) {
          const report = strategyReport(item, null);
          if (inWindow(report)) keep(report);
        }
        if (to === window.to) break;
      }
      return [...found.values()];
    }),
  };
}
