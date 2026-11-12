// Real Binance USDT-M connector (3.0b). Endpoints, the recvWindow and the list of codes that prove a refusal mirror the
// production client server/trading-execution-exchanges.mjs, which stays unchanged; only orders by client id are used here.
import { createHash } from 'node:crypto';
import { binanceSignedQuery } from '../../../../server/exchange-transport/binance.mjs';
import { VENUE_EXECUTION_SYMBOLS, VENUE_READ_SYMBOLS, accountKey, type AccountBinding, type AccountSnapshot, type Instrument, type OpenOrder, type Position, type Quote } from '../contracts.ts';
import { VenueError, type CallOptions, type ConnectorCapabilities, type OrderReport, type OrderRequest, type OrderStatus, type SendOptions, type VenueConnector } from '../connector.ts';
import { cmp, isZero, sub } from '../decimal.ts';
import { exchange, type FetchLike, type HttpReply } from './http.ts';
import { PreflightError, binanceIpProblem, binancePermissionProblem } from './permissions.ts';
import { ShapeError, amount, describe, hedgeClose, identifier, list, millis, optionalPrice, record, validCredentials, type LiveCredentials } from './values.ts';

export type { LiveCredentials } from './values.ts';
export interface BinanceConnectorOptions {
  /** Resolves the key for one binding; a throw refuses the call before anything is sent. */
  credentials: (binding: AccountBinding) => LiveCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Per HTTP exchange; must stay well under the executor's callTimeoutMs (a timestamp retry makes three exchanges). */
  timeoutMs?: number;
  ruleTtlMs?: number;
}

const RECV_WINDOW = '5000';
const PUBLIC_HOST = 'https://fapi.binance.com';
const SPOT_HOST = 'https://api.binance.com';
const MAX_CLOCK_OFFSET_MS = 300_000;
const IDENTITY_TTL_MS = 60_000;
const MODE_TTL_MS = 60_000;
const CLIENT_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/;
const TERMINAL: Record<string, OrderStatus> = { FILLED: 'filled', CANCELED: 'canceled', EXPIRED: 'expired', EXPIRED_IN_MATCH: 'expired', REJECTED: 'rejected' };
const WORKING: Record<string, OrderStatus> = { NEW: 'new', PARTIALLY_FILLED: 'partially-filled' };
/**
 * Only explicit parameter, permission, balance and limit refusals prove that nothing executed (copied from the production
 * client). Duplicate, processing, unknown-order and every other code stay uncertain for a write.
 */
const KNOWN_REJECTIONS = new Set([
  -1002, -1003, -1008, -1013, -1015, -1020, -1022,
  -1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1114, -1115, -1116, -1117, -1118, -1119, -1121, -1128, -1130,
  -2014, -2015, -2017, -2018, -2019, -2022, -2025, -2026, -2027,
  -4001, -4002, -4003, -4004, -4005, -4013, -4014, -4016, -4023, -4024, -4061, -4164, -5022,
]);
const TIMESTAMP_CODE = -1021;
const NOT_FOUND_CODE = -2013;

type Mode = 'one-way' | 'hedge';
interface Endpoint { host: string; path: string; method: 'GET' | 'POST' | 'DELETE' }
function endpoints(accountMode: string) {
  const portfolio = accountMode === 'portfolio-margin';
  const host = portfolio ? 'https://papi.binance.com' : 'https://fapi.binance.com', prefix = portfolio ? '/papi/v1/um' : '/fapi/v1';
  const at = (path: string, method: Endpoint['method'] = 'GET', base = host): Endpoint => ({ host: base, path, method });
  return {
    identity: at('/api/v3/account', 'GET', SPOT_HOST),
    permissions: at('/sapi/v1/account/apiRestrictions', 'GET', SPOT_HOST),
    config: at(`${prefix}/accountConfig`),
    positions: at(portfolio ? `${prefix}/positionRisk` : '/fapi/v3/positionRisk'),
    openOrders: at(`${prefix}/openOrders`),
    openAlgoOrders: at(portfolio ? `${prefix}/algo/openAlgoOrders` : '/fapi/v1/openAlgoOrders'),
    place: at(`${prefix}/order`, 'POST'),
    query: at(`${prefix}/order`),
    cancel: at(`${prefix}/order`, 'DELETE'),
  };
}

type Failure = { kind: 'timestamp' | 'not-found' | 'rejected' | 'unknown'; message: string };
function classify(reply: HttpReply): Failure | null {
  const data = reply.data;
  const coded = data !== null && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'code');
  if (reply.status >= 200 && reply.status < 300 && !coded) return null;
  const raw = coded ? (data as { code: unknown }).code : undefined, code = Number.isSafeInteger(raw) ? raw as number : undefined;
  const detail = coded && typeof (data as { msg?: unknown }).msg === 'string' ? `：${(data as { msg: string }).msg.slice(0, 120)}` : '';
  const message = `Binance HTTP ${reply.status}${code === undefined ? '' : ` 错误码 ${code}`}${detail}`;
  if (reply.status >= 500 || code === undefined) return { kind: 'unknown', message };
  if (code === TIMESTAMP_CODE) return { kind: 'timestamp', message };
  if (code === NOT_FOUND_CODE) return { kind: 'not-found', message };
  return { kind: KNOWN_REJECTIONS.has(code) ? 'rejected' : 'unknown', message };
}

export function createBinanceConnector(options: BinanceConnectorOptions): VenueConnector {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 10_000, ruleTtlMs = options.ruleTtlMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20_000) throw new Error('Binance 连接器单次请求超时须在 100–20000 毫秒之间');
  let offset = 0;
  const rules = new Map<string, { instrument: Instrument; expiresAt: number }>();
  const identities = new Map<string, { uid: string; at: number; apiKey: string }>();
  const modes = new Map<string, { mode: Mode; at: number; apiKey: string }>();
  const bindingKey = (binding: AccountBinding): string => `${accountKey(binding)}:${binding.credentialVersion}:${binding.accountMode}`;

  function credentialsOf(binding: AccountBinding, mutation: boolean): LiveCredentials {
    const fail = (message: string): never => { throw new VenueError(mutation ? 'not-sent' : 'read-failed', message); };
    if (binding.venue !== 'binance' || binding.environment !== 'mainnet') fail('Binance 实盘连接器只接受 mainnet 的 Binance 账户');
    if (binding.accountMode !== 'standard' && binding.accountMode !== 'portfolio-margin') fail(`Binance 账户模式 ${binding.accountMode} 无效`);
    let credentials: LiveCredentials;
    try { credentials = options.credentials(binding); } catch (error) { return fail(`Binance 凭据不可用：${describe(error)}`); }
    if (!validCredentials(credentials)) fail('Binance 凭据不完整或格式无效');
    return credentials;
  }

  async function syncClock(signal: AbortSignal): Promise<void> {
    const before = now();
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${PUBLIC_HOST}/fapi/v1/time`, method: 'GET', maxBytes: 4096 }, { signal });
    const after = now(), serverTime = record(reply.data, '服务器时间').serverTime;
    if (classify(reply) || !Number.isSafeInteger(serverTime) || after - before > 5_000) throw new VenueError('read-failed', 'Binance 服务器时间读取失败');
    const next = Math.round((serverTime as number) - (before + after) / 2);
    if (Math.abs(next) > MAX_CLOCK_OFFSET_MS) throw new VenueError('read-failed', `本机时钟与 Binance 相差 ${next} 毫秒，超过上限`);
    offset = next;
  }

  /** Public reads; a refusal or unknown answer is a read failure. */
  async function publicRead(path: string, params: Record<string, string>, signal: AbortSignal, maxBytes?: number): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${PUBLIC_HOST}${path}${query ? `?${query}` : ''}`, method: 'GET', maxBytes }, { signal });
    const failure = classify(reply);
    if (failure) throw new VenueError('read-failed', failure.message);
    return reply.data;
  }

  /**
   * Signed request. A timestamp refusal proves the request did not execute, so it is sent once more with the same
   * parameters (the same client id) after a clock sync; beforeSend runs again right before the second transmission.
   * Returns null only for the venue's "no such order" answer to a read.
   */
  async function signed(binding: AccountBinding, endpoint: Endpoint, params: Record<string, string>, { signal, beforeSend }: { signal: AbortSignal; beforeSend?: () => void }): Promise<unknown> {
    const mutation = endpoint.method !== 'GET';
    const credentials = credentialsOf(binding, mutation);
    for (let attempt = 0; ; attempt++) {
      let request;
      try {
        const signedQuery = binanceSignedQuery(credentials, params, { timestamp: String(now() + offset), recvWindow: RECV_WINDOW });
        request = { url: `${endpoint.host}${endpoint.path}?${signedQuery.query}`, method: endpoint.method, headers: { ...signedQuery.headers } };
      } catch (error) { // A resend follows a refusal of the first transmission, so that refusal is the answer.
        throw new VenueError(!mutation ? 'read-failed' : attempt > 0 ? 'rejected' : 'not-sent', `Binance 请求签名失败：${describe(error)}`); }
      let reply: HttpReply;
      try { reply = await exchange(fetchImpl, timeoutMs, request, { signal, ...(mutation ? { beforeSend: beforeSend ?? (() => undefined) } : {}) }); }
      catch (error) {
        // The first transmission was already refused; a retry stopped before sending leaves that refusal as the answer.
        if (attempt > 0 && error instanceof VenueError && error.kind === 'not-sent') throw new VenueError('rejected', `Binance 时间戳被拒后未重发：${error.message}`);
        throw error;
      }
      const failure = classify(reply);
      if (!failure) return reply.data;
      if (failure.kind === 'timestamp' && attempt === 0) {
        // The refused request did not execute. A failed sync leaves that refusal as the answer.
        try { await syncClock(signal); } catch (error) { throw new VenueError(mutation ? 'rejected' : 'read-failed', `${failure.message}；时钟同步失败：${describe(error)}`); }
        continue;
      }
      if (failure.kind === 'not-found' && !mutation) return null;
      throw new VenueError(mutation ? (failure.kind === 'rejected' || failure.kind === 'timestamp' ? 'rejected' : 'uncertain') : 'read-failed', failure.message);
    }
  }

  async function readMode(binding: AccountBinding, signal: AbortSignal): Promise<Mode> {
    const config = record(await signed(binding, endpoints(binding.accountMode).config, {}, { signal }), '账户配置');
    if (typeof config.dualSidePosition !== 'boolean') throw new ShapeError('持仓模式缺失');
    const mode: Mode = config.dualSidePosition ? 'hedge' : 'one-way';
    modes.set(bindingKey(binding), { mode, at: now(), apiKey: credentialsOf(binding, false).apiKey });
    return mode;
  }
  async function readIdentity(binding: AccountBinding, signal: AbortSignal): Promise<string> {
    const key = bindingKey(binding), apiKey = credentialsOf(binding, false).apiKey, cached = identities.get(key), time = now();
    if (cached && cached.apiKey === apiKey && time >= cached.at && time - cached.at < IDENTITY_TTL_MS) return cached.uid;
    const account = record(await signed(binding, endpoints(binding.accountMode).identity, { omitZeroBalances: 'true' }, { signal }), '账户身份');
    const uid = identifier(account.uid, 'Binance UID');
    if (!/^[1-9]\d{0,39}$/.test(uid)) throw new ShapeError('Binance UID 无效');
    identities.set(key, { uid, at: now(), apiKey });
    return uid;
  }

  /** Every malformed or mismatched answer to a write is uncertain: the venue answered, but not in a way that settles anything. */
  function orderReport(value: unknown, request: OrderRequest, kind: 'uncertain' | 'read-failed'): OrderReport {
    try {
      const row = record(value, '委托回报');
      if (row.clientOrderId !== request.clientOrderId || row.symbol !== request.symbol) throw new ShapeError('委托回报的客户订单号或合约与请求不一致');
      const side = row.side === 'BUY' ? 'buy' : row.side === 'SELL' ? 'sell' : null;
      if (side !== request.side) throw new ShapeError('委托回报方向与请求不一致');
      if (row.type !== (request.type === 'market' ? 'MARKET' : 'LIMIT')) throw new ShapeError('委托回报类型与请求不一致');
      if (request.type === 'limit') {
        if (row.timeInForce !== (request.timeInForce === 'ioc' ? 'IOC' : 'GTC') || request.limitPrice === null || cmp(amount(row.price, '委托价格'), request.limitPrice) !== 0) throw new ShapeError('委托回报的价格或有效方式与请求不一致');
      }
      if (row.positionSide === 'BOTH') { if (row.reduceOnly !== request.reduceOnly) throw new ShapeError('委托回报只减仓标记与请求不一致'); }
      else if (row.positionSide === 'LONG' || row.positionSide === 'SHORT') {
        if (row.positionSide !== (request.positionSide === 'long' ? 'LONG' : 'SHORT') || hedgeClose(request.side, request.positionSide) !== request.reduceOnly) throw new ShapeError('委托回报仓位方向与请求不一致');
      } else throw new ShapeError('委托回报仓位方向无效');
      const quantity = amount(row.origQty, '委托数量'), filledQuantity = amount(row.executedQty, '成交数量', 'nonnegative');
      if (cmp(quantity, request.quantity) !== 0 || cmp(filledQuantity, quantity) > 0) throw new ShapeError('委托回报数量无效');
      const status = typeof row.status === 'string' ? TERMINAL[row.status] ?? WORKING[row.status] : undefined;
      if (!status) throw new ShapeError(`委托状态 ${String(row.status).slice(0, 32)} 无法识别`);
      if (status === 'filled' && cmp(filledQuantity, quantity) !== 0) throw new ShapeError('全部成交的委托成交数量不足');
      const averagePrice = isZero(filledQuantity) ? null : optionalPrice(row.avgPrice, '成交均价');
      if (!isZero(filledQuantity) && averagePrice === null) throw new ShapeError('有成交但没有成交均价');
      return {
        clientOrderId: request.clientOrderId, remoteId: identifier(row.orderId, '交易所订单号'), symbol: request.symbol, side, quantity, filledQuantity, averagePrice,
        status, terminal: Object.hasOwn(TERMINAL, row.status as string), updatedAt: millis(row.updateTime ?? row.time, '委托更新时间'),
      };
    } catch (error) {
      if (error instanceof ShapeError) throw new VenueError(kind, `Binance 委托回报无法使用：${error.message}`);
      throw error;
    }
  }
  /** Wraps a read whose answer is parsed here: a malformed answer is a read failure, never a thrown shape error. */
  async function reading<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ShapeError) throw new VenueError('read-failed', `Binance 应答无法使用：${error.message}`);
      throw error;
    }
  }

  function parseInstrument(info: unknown, symbol: string): Instrument {
    const matches = list(record(info, '合约目录').symbols, '合约目录').filter(row => (row as { symbol?: unknown })?.symbol === symbol);
    if (matches.length !== 1) throw new ShapeError(`合约目录里没有唯一的 ${symbol}`);
    const row = record(matches[0], '合约');
    if (row.status !== 'TRADING' || !['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row.contractType as string) || row.quoteAsset !== 'USDT' || row.marginAsset !== 'USDT') throw new ShapeError(`${symbol} 当前不可交易或不是 USDT 永续`);
    const orderTypes = list(row.orderTypes, '委托类型'), timeInForce = list(row.timeInForce, '有效方式');
    if (!orderTypes.includes('LIMIT') || !orderTypes.includes('MARKET') || !timeInForce.includes('GTC') || !timeInForce.includes('IOC')) throw new ShapeError(`${symbol} 不支持限价、市价或 IOC/GTC`);
    const filters = list(row.filters, '交易规则', 50);
    const filter = (name: string): Record<string, unknown> => {
      const found = filters.filter(item => (item as { filterType?: unknown })?.filterType === name);
      if (found.length !== 1) throw new ShapeError(`${symbol} 缺少 ${name}`);
      return record(found[0], name);
    };
    const price = filter('PRICE_FILTER'), lot = filter('LOT_SIZE'), market = filter('MARKET_LOT_SIZE'), notional = filter('MIN_NOTIONAL');
    const quantityStep = amount(lot.stepSize, '数量步长');
    // One step serves both order types, so a split sized for one fits the other.
    if (cmp(amount(market.stepSize, '市价数量步长'), quantityStep) !== 0) throw new ShapeError(`${symbol} 市价单与限价单数量步长不同`);
    const lotMin = amount(lot.minQty, '最小数量'), marketMin = amount(market.minQty, '市价最小数量');
    const fields = {
      tickSize: amount(price.tickSize, '价格步长'), quantityStep, minQuantity: cmp(marketMin, lotMin) > 0 ? marketMin : lotMin,
      maxQuantity: amount(lot.maxQty, '最大数量'), maxMarketQuantity: amount(market.maxQty, '市价最大数量'), minNotional: amount(notional.notional, '最小名义金额', 'nonnegative'),
    };
    const catalogVersion = `bn-${createHash('sha256').update(JSON.stringify([row.contractType, fields])).digest('hex').slice(0, 16)}`;
    return { venue: 'binance', symbol, kind: 'linear-perpetual', settleAsset: 'USDT', contractSize: '1', ...fields, catalogVersion };
  }

  function checkOrder(request: OrderRequest): void {
    const refuse = (message: string): never => { throw new VenueError('not-sent', `Binance 委托未发送：${message}`); };
    if (!VENUE_EXECUTION_SYMBOLS.binance.includes(request.symbol)) refuse(`${request.symbol} 不是可执行合约`);
    if (!CLIENT_ID.test(request.clientOrderId)) refuse('客户订单号格式无效');
    try { amount(request.quantity, '数量'); if (request.limitPrice !== null) amount(request.limitPrice, '限价'); } catch { refuse('数量或价格无效'); }
    if (request.type === 'market' && (request.limitPrice !== null || request.timeInForce === 'gtc')) refuse('市价单不带限价，只能 IOC');
    if (request.type === 'limit' && request.limitPrice === null) refuse('限价单缺少价格');
  }
  const orderParams = (request: OrderRequest) => ({ symbol: request.symbol, origClientOrderId: request.clientOrderId });

  const capabilities: ConnectorCapabilities = {
    transport: 'live', clientOrderId: true, queryByClientOrderId: true, cancelByClientOrderId: true, maxClientOrderIdLength: 36,
    // The venue accepts a request only while its timestamp is within recvWindow (5 s) of its own clock and at most 1 s
    // ahead of it, so a request stops being accepted at most 6 s after it was signed; 10 s leaves room for scheduling.
    requestValidityMs: 10_000,
  };

  return {
    venue: 'binance',
    capabilities,

    preflight: (binding: AccountBinding, { signal }: CallOptions) => reading(async () => {
      const routes = endpoints(binding.accountMode);
      const restrictions = record(await signed(binding, routes.permissions, {}, { signal }), '密钥权限');
      const problem = binancePermissionProblem(restrictions, binding.accountMode) ?? binanceIpProblem(restrictions);
      if (problem) throw new PreflightError(`Binance 密钥权限不符合要求：${problem}`);
      if (record(await signed(binding, routes.config, {}, { signal }), '账户配置').canTrade !== true) throw new PreflightError('Binance 合约账户当前不可交易');
      await readMode(binding, signal);
      const uid = await readIdentity(binding, signal);
      if (uid !== binding.accountId) throw new PreflightError(`Binance 密钥属于 UID ${uid}，与配置的账户 ${binding.accountId} 不一致`);
    }),

    instrument: (symbol: string, { signal }: CallOptions) => reading(async () => {
      if (!VENUE_READ_SYMBOLS.binance.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在 Binance 可读合约内`);
      const cached = rules.get(symbol), time = now();
      if (cached && time >= cached.expiresAt - ruleTtlMs && time < cached.expiresAt) return { ...cached.instrument };
      const info = await publicRead('/fapi/v1/exchangeInfo', {}, signal, 16 * 1024 * 1024);
      const instrument = parseInstrument(info, symbol);
      rules.set(symbol, { instrument, expiresAt: now() + ruleTtlMs });
      return { ...instrument };
    }),

    quote: (symbol: string, { signal }: CallOptions) => reading(async (): Promise<Quote> => {
      if (!VENUE_READ_SYMBOLS.binance.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在 Binance 可读合约内`);
      const book = record(await publicRead('/fapi/v1/ticker/bookTicker', { symbol }, signal, 4096), '盘口');
      const receivedAt = now();
      if (book.symbol !== symbol) throw new ShapeError('盘口合约与请求不一致');
      const bid = amount(book.bidPrice, '买一价'), ask = amount(book.askPrice, '卖一价');
      amount(book.bidQty, '买一量'); amount(book.askQty, '卖一量');
      return { venue: 'binance', symbol, bid, ask, sourceTime: millis(book.time, '盘口时间'), receivedAt, connectionGeneration: 0, sequence: null, complete: true };
    }),

    account: (binding: AccountBinding, symbols: readonly string[], { signal }: CallOptions) => reading(async (): Promise<AccountSnapshot> => {
      if (symbols.length === 0 || symbols.some(symbol => !VENUE_READ_SYMBOLS.binance.includes(symbol))) throw new VenueError('read-failed', '账户快照的合约无效');
      const routes = endpoints(binding.accountMode);
      const [accountId, mode] = await Promise.all([readIdentity(binding, signal), readMode(binding, signal)]);
      const positions: Position[] = [], openOrders: OpenOrder[] = [], positionModes: Record<string, Mode> = {};
      for (const symbol of symbols) {
        positionModes[symbol] = mode;
        // Orders before positions: an order that fills between the two reads still shows up in the later position read.
        const [ordinary, conditional] = await Promise.all([signed(binding, routes.openOrders, { symbol }, { signal }), signed(binding, routes.openAlgoOrders, { symbol }, { signal })]);
        for (const item of list(ordinary, '活动委托')) {
          const row = record(item, '活动委托');
          if (row.symbol !== symbol) throw new ShapeError('活动委托合约与请求不一致');
          const clientOrderId = typeof row.clientOrderId === 'string' && /^[\x21-\x7e]{1,64}$/.test(row.clientOrderId) ? row.clientOrderId : null;
          openOrders.push({ symbol, clientOrderId, remoteId: identifier(row.orderId, '交易所订单号') });
        }
        // Conditional orders live apart from ordinary ones and never carry our client ids: any of them is foreign.
        for (const item of list(conditional, '条件委托')) {
          const row = record(item, '条件委托');
          if (row.symbol !== symbol) throw new ShapeError('条件委托合约与请求不一致');
          openOrders.push({ symbol, clientOrderId: null, remoteId: `algo-${identifier(row.algoId, '条件委托编号')}` });
        }
        const seen = new Set<string>();
        for (const item of list(await signed(binding, routes.positions, { symbol }, { signal }), '持仓', 20)) {
          const row = record(item, '持仓');
          if (row.symbol !== symbol || (binding.accountMode === 'standard' && row.marginAsset !== 'USDT') || (Object.hasOwn(row, 'marginAsset') && row.marginAsset !== 'USDT')) throw new ShapeError('持仓合约或保证金币种与请求不一致');
          const positionSide = row.positionSide;
          if (positionSide !== 'BOTH' && positionSide !== 'LONG' && positionSide !== 'SHORT') throw new ShapeError('持仓方向无效');
          if ((positionSide === 'BOTH') !== (mode === 'one-way') || seen.has(positionSide)) throw new ShapeError('持仓记录与持仓模式不一致');
          seen.add(positionSide);
          const signedAmount = amount(row.positionAmt, '持仓数量', 'any');
          if ((positionSide === 'LONG' && cmp(signedAmount, '0') < 0) || (positionSide === 'SHORT' && cmp(signedAmount, '0') > 0)) throw new ShapeError('持仓数量符号与方向不一致');
          if (isZero(signedAmount)) continue;
          positions.push({ symbol, side: cmp(signedAmount, '0') > 0 ? 'long' : 'short', quantity: cmp(signedAmount, '0') > 0 ? signedAmount : sub('0', signedAmount) });
        }
      }
      return { venue: 'binance', accountId, positionModes, positions, openOrders, receivedAt: now() };
    }),

    async place(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      checkOrder(request);
      // The venue takes positionSide in hedge mode and refuses reduceOnly there; the mode comes from a recent account read
      // or a fresh one. A wrong mode is refused by the venue (-4061), never executed with the other meaning.
      const cached = modes.get(bindingKey(binding)), time = now();
      let mode: Mode;
      if (cached && cached.apiKey === credentialsOf(binding, true).apiKey && time >= cached.at && time - cached.at < MODE_TTL_MS) mode = cached.mode;
      else {
        try { mode = await reading(() => readMode(binding, signal)); }
        catch (error) { throw new VenueError('not-sent', `Binance 持仓模式读取失败，委托未发送：${describe(error)}`); }
      }
      const positionSide = request.positionSide === 'long' ? 'LONG' : 'SHORT';
      if (mode === 'hedge' && hedgeClose(request.side, request.positionSide) !== request.reduceOnly) throw new VenueError('not-sent', 'Binance 双向持仓模式下只减仓标记与方向不一致，委托未发送');
      const params: Record<string, string> = {
        symbol: request.symbol, side: request.side === 'buy' ? 'BUY' : 'SELL', type: request.type === 'market' ? 'MARKET' : 'LIMIT', quantity: request.quantity,
        ...(request.type === 'limit' ? { price: request.limitPrice as string, timeInForce: request.timeInForce === 'ioc' ? 'IOC' : 'GTC' } : {}),
        ...(mode === 'hedge' ? { positionSide } : { positionSide: 'BOTH', reduceOnly: String(request.reduceOnly) }),
        newClientOrderId: request.clientOrderId, newOrderRespType: 'RESULT',
      };
      return orderReport(await signed(binding, endpoints(binding.accountMode).place, params, { signal, beforeSend }), request, 'uncertain');
    },

    async query(binding: AccountBinding, request: OrderRequest, { signal }: CallOptions): Promise<OrderReport | null> {
      const row = await signed(binding, endpoints(binding.accountMode).query, orderParams(request), { signal });
      return row === null ? null : orderReport(row, request, 'read-failed');
    },

    async cancel(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      if (!VENUE_EXECUTION_SYMBOLS.binance.includes(request.symbol) || !CLIENT_ID.test(request.clientOrderId)) throw new VenueError('not-sent', 'Binance 撤单未发送：合约或客户订单号无效');
      return orderReport(await signed(binding, endpoints(binding.accountMode).cancel, orderParams(request), { signal, beforeSend }), request, 'uncertain');
    },
  };
}

