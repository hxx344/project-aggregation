// Read-only display of every position held by the two ASTER sub-accounts of
// each margin-balance pair (plan 2.3c, simulated only). Nothing is written to
// the store and nothing is sent: rows are kept in memory with the local time the
// read started, a failed read keeps the previous rows only until they reach
// `positionsMaxAgeMs`, and the state view never waits on the venue.
import { ContractError, decimalField, exactKeys, integer, oneOf, reject, text } from './contracts.ts';
import { add, cmp, isZero, mul, sub } from './decimal.ts';
import type { CallOptions } from './connector.ts';
import { ADL_SYMBOL, type AdlPositionSide, type Direction } from './adl-contracts.ts';
import type { PairRecord } from './transfer.ts';

export interface PositionsBudgets {
  /** Wanted spacing between the starts of two refresh rounds; the entry loop subtracts the round's own duration. */
  positionsRefreshMs: number;
  /** Limit of one account read. */
  positionsReadTimeoutMs: number;
  /** Rows older than this are no longer shown, whatever the latest read did. Must exceed refresh plus read timeout. */
  positionsMaxAgeMs: number;
  /** Accounts read at the same time. */
  positionsConcurrency: number;
}
export const DEFAULT_POSITIONS_BUDGETS: Readonly<PositionsBudgets> = Object.freeze({ positionsRefreshMs: 15_000, positionsReadTimeoutMs: 8_000, positionsMaxAgeMs: 45_000, positionsConcurrency: 4 });
/** More held rows are refused instead of kept: the display is not meant for that many. */
export const MAX_POSITION_ROWS = 500;
/** The venue lists every symbol, zero rows included; an answer longer than this is refused before it is parsed. */
export const MAX_ANSWER_ROWS = 10_000;

/** Every call is made with the named sub-account's own read authority. */
export interface AsterPositionsConnector {
  readonly venue: 'aster';
  readonly capabilities: { transport: 'simulated' };
  /** All position rows of the sub-account, zero rows allowed. */
  positions(accountId: string, options: CallOptions): Promise<unknown>;
}

export interface AsterPosition {
  symbol: string; positionSide: AdlPositionSide; direction: Direction;
  /** Absolute size in base units. */
  quantity: string;
  entryPrice: string; markPrice: string;
  /** quantity × markPrice, in the quote asset. */
  notional: string;
  /** As answered by the venue. */
  unrealizedProfit: string;
  updateTime: number;
}
export interface AsterPositionsSnapshot { accountId: string; positions: AsterPosition[]; receivedAt: number }

export function parseAsterPositions(value: unknown, accountId: string, now: number, toleranceMs: number): AsterPositionsSnapshot {
  const raw = exactKeys(value, ['accountId', 'positions', 'receivedAt']);
  if (raw.accountId !== accountId) reject('account_identity', 'ASTER 子账户身份与配对不一致', 409);
  if (!Array.isArray(raw.positions)) return reject('positions_shape', 'ASTER 持仓结构无效', 502);
  if (raw.positions.length > MAX_ANSWER_ROWS) reject('positions_shape', `ASTER 持仓回复超过 ${MAX_ANSWER_ROWS} 行`, 502);
  const notAhead = (at: number, name: string): number => { if (at > now + toleranceMs) reject('venue_time', `${name}超前本机时钟`, 502); return at; };
  const seen = new Set<string>(), positions: AsterPosition[] = [];
  for (const row of raw.positions) {
    const item = exactKeys(row, ['symbol', 'positionSide', 'amount', 'entryPrice', 'markPrice', 'unrealizedProfit', 'updateTime']);
    const symbol = text(item.symbol, '合约', ADL_SYMBOL), positionSide = oneOf(item.positionSide, ['LONG', 'SHORT', 'BOTH'] as const, '持仓方向');
    const key = `${symbol}|${positionSide}`;
    if (seen.has(key)) reject('position_shape', `${symbol} ${positionSide} 持仓重复`, 502);
    seen.add(key);
    const amount = decimalField(item.amount, '持仓数量', 'any'), sign = cmp(amount, '0');
    if ((positionSide === 'LONG' && sign < 0) || (positionSide === 'SHORT' && sign > 0)) reject('position_shape', `${symbol} ${positionSide} 持仓数量符号不一致`, 502);
    // A zero row of a delisted symbol may carry no usable price; it is not shown, so its prices are not checked.
    if (sign === 0) continue;
    if (positions.length >= MAX_POSITION_ROWS) reject('positions_shape', `ASTER 持仓超过 ${MAX_POSITION_ROWS} 行`, 502);
    const entryPrice = decimalField(item.entryPrice, '开仓均价', 'nonnegative'), markPrice = decimalField(item.markPrice, '标记价格'), unrealizedProfit = decimalField(item.unrealizedProfit, '未实现盈亏', 'any');
    const updateTime = notAhead(integer(item.updateTime, 0, Number.MAX_SAFE_INTEGER, '持仓更新时间'), '持仓更新时间');
    const quantity = sign < 0 ? sub('0', amount) : amount;
    positions.push({ symbol, positionSide, direction: sign > 0 ? 'long' : 'short', quantity, entryPrice, markPrice, notional: mul(quantity, markPrice), unrealizedProfit, updateTime });
  }
  positions.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.positionSide < b.positionSide ? -1 : a.positionSide > b.positionSide ? 1 : 0);
  return { accountId, positions, receivedAt: notAhead(integer(raw.receivedAt, 0, Number.MAX_SAFE_INTEGER, '持仓接收时间'), '持仓接收时间') };
}

export interface PositionsDeps {
  connector: AsterPositionsConnector | null;
  now: () => number;
  budgets: PositionsBudgets & { venueClockToleranceMs: number };
  /** Readable pair records; a pair's accounts are looked up again at every read and every view. */
  pairs: () => PairRecord[];
  callVenue: <T>(kind: 'read', operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number) => Promise<T>;
}

export function checkPositionsBudgets(budgets: PositionsBudgets): void {
  for (const key of ['positionsRefreshMs', 'positionsReadTimeoutMs', 'positionsMaxAgeMs', 'positionsConcurrency'] as const) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] <= 0) throw new ContractError(500, 'budget', `${key} 须为正整数`);
  }
  // A read that ends by timeout after a full spacing must still find the previous rows valid, or one slow read blanks the display.
  // This holds while a round lasts no longer than the spacing (README 《已知限制》); a longer round can only blank rows, never keep them past their age.
  if (budgets.positionsMaxAgeMs <= budgets.positionsRefreshMs + budgets.positionsReadTimeoutMs) throw new ContractError(500, 'budget', 'positionsMaxAgeMs 须大于 positionsRefreshMs 与 positionsReadTimeoutMs 之和');
}

/** fresh: the latest read succeeded. retained: the latest read failed, the rows shown are older but still valid. */
export type PositionsState = 'pending' | 'fresh' | 'retained' | 'unavailable';
interface Entry { snapshot: { positions: AsterPosition[]; sampledAt: number } | null; failure: { reason: string; at: number } | null }

const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
const message = (error: unknown): string => error instanceof Error ? error.message.slice(0, 200) : '未知错误';
const signed = (row: AsterPosition): string => row.direction === 'short' ? sub('0', row.quantity) : row.quantity;

export function createPositions({ connector, now, budgets, pairs, callVenue }: PositionsDeps) {
  checkPositionsBudgets(budgets);
  const entries = new Map<string, Entry>();
  let running: Promise<void> | null = null, closed = false;

  const accounts = (): string[] => [...new Set(pairs().flatMap(pair => [pair.long, pair.short]))];

  async function readAccount(venue: AsterPositionsConnector, accountId: string): Promise<void> {
    // The read's start, not its end, is what the rows can be trusted from.
    const sampledAt = now();
    let result: Entry['snapshot'] = null, reason: string | null = null;
    try {
      const raw = await callVenue('read', signal => venue.positions(accountId, { signal }), budgets.positionsReadTimeoutMs);
      result = { positions: parseAsterPositions(raw, accountId, now(), budgets.venueClockToleranceMs).positions, sampledAt };
    } catch (error) { reason = `ASTER 持仓读取失败：${message(error)}`; }
    // Entries are only dropped at the start of a round and rounds never overlap, so the entry is still there.
    const entry = entries.get(accountId);
    if (closed || !entry) return;
    if (result) { entry.snapshot = result; entry.failure = null; }
    else entry.failure = { reason: reason!, at: sampledAt };
  }

  async function round(venue: AsterPositionsConnector): Promise<void> {
    const wanted = accounts(), keep = new Set(wanted);
    for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
    for (const id of wanted) if (!entries.has(id)) entries.set(id, { snapshot: null, failure: null });
    let next = 0;
    const worker = async () => { while (next < wanted.length && !closed) await readAccount(venue, wanted[next++]); };
    await Promise.all(Array.from({ length: Math.min(budgets.positionsConcurrency, wanted.length) }, worker));
  }

  /** One round over every paired account; a call while a round is in flight joins it. */
  function refresh(): Promise<void> {
    if (closed || !connector) return Promise.resolve();
    if (!running) running = round(connector).finally(() => { running = null; });
    return running;
  }

  function sideView(accountId: string, at: number) {
    const entry = entries.get(accountId), snapshot = entry?.snapshot ?? null, failure = entry?.failure ?? null;
    const age = snapshot ? at - snapshot.sampledAt : null;
    // A clock that moved back gives no usable age either.
    const valid = snapshot != null && age! >= 0 && age! <= budgets.positionsMaxAgeMs;
    const state: PositionsState = valid ? (failure ? 'retained' : 'fresh') : snapshot || failure ? 'unavailable' : 'pending';
    const note = state === 'retained' ? failure!.reason
      : state === 'unavailable' ? (failure && (!snapshot || failure.at >= snapshot.sampledAt) ? failure.reason : `持仓超过 ${Math.round(budgets.positionsMaxAgeMs / 1000)} 秒未更新`)
        : null;
    return { account: maskId(accountId), state, sampledAt: valid ? snapshot!.sampledAt : null, ageMs: valid ? age : null, note, positions: valid ? snapshot!.positions : [] };
  }

  /** A verdict needs both latest reads to have succeeded and to lie within one read limit of each other. */
  function verdictNote(long: ReturnType<typeof sideView>, short: ReturnType<typeof sideView>): string | null {
    if (long.state !== 'fresh' || short.state !== 'fresh') return '有一侧最新读取失败';
    if (Math.abs(long.sampledAt! - short.sampledAt!) > budgets.positionsReadTimeoutMs) return '两侧采样相隔过久';
    return null;
  }
  /** Per symbol: the signed net of each side and their sum, with the same arithmetic as the ADL balance check. */
  function totals(long: ReturnType<typeof sideView>, short: ReturnType<typeof sideView>, note: string | null) {
    if (long.state === 'pending' || long.state === 'unavailable' || short.state === 'pending' || short.state === 'unavailable') return null;
    const symbols = [...new Set([...long.positions, ...short.positions].map(row => row.symbol))].sort();
    const net = (rows: AsterPosition[], symbol: string) => add('0', ...rows.filter(row => row.symbol === symbol).map(signed));
    return symbols.map(symbol => {
      const longNet = net(long.positions, symbol), shortNet = net(short.positions, symbol), total = add(longNet, shortNet);
      return { symbol, long: longNet, short: shortNet, total, balanced: note ? null : isZero(total) };
    });
  }

  function view() {
    const at = now();
    return {
      available: connector != null, refreshMs: budgets.positionsRefreshMs, maxAgeMs: budgets.positionsMaxAgeMs, checkedAt: at,
      pairs: pairs().map(pair => {
        const long = sideView(pair.long, at), short = sideView(pair.short, at), note = verdictNote(long, short);
        return { pairId: pair.id, enabled: pair.enabled, long, short, totals: totals(long, short, note), verdictNote: note };
      }),
    };
  }

  return {
    refresh, view,
    /** In-flight reads end by their own timeout; their results are dropped. */
    close: () => { closed = true; },
  };
}
export type Positions = ReturnType<typeof createPositions>;
