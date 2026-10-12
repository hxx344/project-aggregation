import { validateExchangeQuote, type ExchangeLeg, type ExchangeQuote } from './exchange-quotes.ts';
import type { VariationalSession } from './variational-api.ts';
import { readVariationalAuthenticatedMarks, readVariationalPublicFunding, withVariationalFunding } from './variational-market.ts';

type JsonObject = Record<string, unknown>;
type LighterMarket = { symbol: 'BRENTOIL' | 'WTI'; marketId: number };
type LighterObservation = { marketId: number; sourceTime: number; leg: ExchangeLeg };
type Request = (url: string) => Promise<unknown>;
type Shared = (key: string, ttl: number, load: () => Promise<unknown>) => Promise<unknown>;
type SocketConstructor = typeof WebSocket;
const HOUR = 3_600_000;
const LIGHTER_ORIGIN = 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_SOCKET = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
const VAR_STATS = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('原油行情响应格式无效');
  return value as JsonObject;
}
function rows(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw Error('原油合约目录格式无效');
  return value.map(object);
}
function number(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function positive(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
function sourceTime(value: unknown, now: number): number {
  const parsed = number(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed < now - 120_000 || parsed > now + 60_000) throw Error('原油行情时间无效或已过期');
  return parsed;
}
function unique(items: JsonObject[], key: string, symbol: string): JsonObject {
  const matches = items.filter(row => row[key] === symbol);
  if (matches.length !== 1) throw Error(`原油合约 ${symbol} 缺失或重复`);
  return matches[0];
}

/** Discover IDs on each metadata refresh: deployments can change IDs.
 * https://apidocs.lighter.xyz/reference/orderbookdetails
 */
export function parseLighterOilMarkets(input: unknown): LighterMarket[] {
  const response = object(input);
  if (response.code !== 200) throw Error('Lighter 原油合约目录读取失败');
  const items = rows(response.order_book_details);
  const markets = (['BRENTOIL', 'WTI'] as const).map(symbol => {
    const row = unique(items, 'symbol', symbol), marketId = number(row.market_id);
    if (row.market_type !== 'perp' || row.status !== 'active' || number(row.multiplier) !== 1 || row.is_frozen === true || marketId === null || !Number.isSafeInteger(marketId) || marketId < 0 || marketId > 32_767) throw Error(`Lighter ${symbol} 合约暂不可用或规格已变化`);
    return { symbol, marketId };
  });
  if (markets[0].marketId === markets[1].marketId) throw Error('Lighter 原油合约编号重复');
  return markets;
}

/** current_funding_rate is upcoming hourly funding in percentage points;
 * funding_rate/funding_timestamp describe the last payment and are never fallback.
 * Payment uses index price: https://docs.lighter.xyz/trading/funding
 * https://apidocs.lighter.xyz/docs/websocket-reference#market-stats
 */
export function parseLighterOilObservation(input: unknown, market: LighterMarket, now = Date.now()): LighterObservation {
  const message = object(input), row = object(message.market_stats);
  if (!['subscribed/market_stats', 'update/market_stats'].includes(String(message.type)) || message.channel !== `market_stats:${market.marketId}` || row.symbol !== market.symbol || row.market_id !== market.marketId) throw Error('Lighter 原油行情合约不匹配');
  const timestamp = sourceTime(message.timestamp, now), price = positive(row.mark_price);
  if (price === null) throw Error(`Lighter ${market.symbol} 标记价格不可用`);
  const fundingPrice = positive(row.index_price), percentage = number(row.current_funding_rate);
  const fundingRate = fundingPrice !== null && percentage !== null && Math.abs(percentage) <= 100 ? percentage / 100 : null;
  return {
    marketId: market.marketId,
    sourceTime: timestamp,
    leg: { symbol: market.symbol, price, fundingPrice, fundingRate, fundingIntervalHours: 1, nextFundingAt: new Date((Math.floor(timestamp / HOUR) + 1) * HOUR).toISOString(), nextFundingEstimated: true },
  };
}

export function parseLighterOilQuote(observations: LighterObservation[], now = Date.now()): ExchangeQuote {
  const leg = (symbol: string) => {
    const matches = observations.filter(row => row.leg.symbol === symbol);
    if (matches.length !== 1) throw Error(`Lighter ${symbol} 行情缺失或重复`);
    sourceTime(matches[0].sourceTime, now);
    return matches[0];
  };
  const brent = leg('BRENTOIL'), wti = leg('WTI');
  if (Math.abs(brent.sourceTime - wti.sourceTime) > 15_000) throw Error('Lighter 原油双腿行情不同步');
  const fetchedAt = new Date(Math.min(brent.sourceTime, wti.sourceTime)).toISOString();
  // Across an hour boundary the two estimates can refer to different payments.
  const complete = [brent, wti].every(row => row.leg.fundingRate !== null) && brent.leg.nextFundingAt === wti.leg.nextFundingAt;
  return validateExchangeQuote({
    exchange: 'lighter', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'index', timestampBasis: 'source', fetchedAt,
    fundingFetchedAt: complete ? fetchedAt : null, status: 'live',
    left: { ...brent.leg, fundingRate: complete ? brent.leg.fundingRate : null },
    right: { ...wti.leg, fundingRate: complete ? wti.leg.fundingRate : null },
    fundingError: complete ? '' : '当前资金费率或指数价格暂不可用，价格仍正常更新。',
  }, 'lighter', 'oil');
}

/** A bounded, unauthenticated snapshot subscription; no trading/account channels. */
export function readLighterOilSnapshot(markets: LighterMarket[], { clock = Date.now, WebSocketImpl = globalThis.WebSocket, timeoutMs = 9_000 }: { clock?: () => number; WebSocketImpl?: SocketConstructor; timeoutMs?: number } = {}): Promise<ExchangeQuote> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') { reject(Error('Lighter 行情连接暂不可用')); return; }
    let socket: WebSocket;
    try { socket = new WebSocketImpl(LIGHTER_SOCKET); }
    catch { reject(Error('Lighter 行情连接失败')); return; }
    let settled = false;
    const observations = new Map<number, LighterObservation>();
    const cleanup = () => {
      clearTimeout(timer);
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(); } catch { /* A failed connection may already be closed. */ }
    };
    const finish = (error?: Error, quote?: ExchangeQuote) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(quote!);
    };
    const timer = setTimeout(() => finish(Error('Lighter 原油双腿行情读取超时')), Math.min(10_000, Math.max(1, timeoutMs)));
    socket.onopen = () => {
      try { for (const market of markets) socket.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${market.marketId}` })); }
      catch { finish(Error('Lighter 行情订阅失败')); }
    };
    socket.onerror = () => finish(Error('Lighter 行情连接失败'));
    socket.onclose = () => finish(Error('Lighter 行情连接已关闭，双腿快照不完整'));
    socket.onmessage = event => {
      if (settled) return;
      try {
        const message = object(JSON.parse(String(event.data)));
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        if (message.type === 'error' || message.error !== undefined) throw Error('Lighter 行情订阅被拒绝');
        const market = markets.find(row => message.channel === `market_stats:${row.marketId}`);
        if (!market) return;
        observations.set(market.marketId, parseLighterOilObservation(message, market, clock()));
        if (observations.size === 2) finish(undefined, parseLighterOilQuote([...observations.values()], clock()));
      } catch (error) { finish(error instanceof Error ? error : Error('Lighter 原油行情响应无效')); }
    };
  });
}

/** Public stats expose mark_price but no mark timestamp or next settlement.
 * quotes.updated_at timestamps cached RFQs, not mark_price. Funding's temporal
 * basis cannot be established from this API, so do not annualize funding_rate.
 * Prices are USDC: https://docs.variational.io/technical-documentation/api
 * CL/BZ futures identity: https://docs.variational.io/omni/trading/tradfi-perpetuals
 */
export function parseVariationalOilQuote(input: unknown, receivedAt = Date.now()): ExchangeQuote {
  const items = rows(object(input).listings);
  const leg = (symbol: string): ExchangeLeg => {
    const row = unique(items, 'ticker', symbol), price = positive(row.mark_price);
    if (price === null) throw Error(`Variational ${symbol} 标记价格不可用`);
    const intervalSeconds = number(row.funding_interval_s);
    const fundingIntervalHours = intervalSeconds !== null && intervalSeconds > 0 && intervalSeconds <= 86_400 && Number.isInteger(intervalSeconds / 3600) ? intervalSeconds / 3600 : null;
    return { symbol, price, fundingPrice: price, fundingRate: null, fundingIntervalHours, nextFundingAt: null };
  };
  return validateExchangeQuote({
    exchange: 'variational', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt: new Date(receivedAt).toISOString(), timestampBasis: 'received',
    fundingFetchedAt: null, status: 'live', left: leg('BZ'), right: leg('CL'),
    fundingError: '等待公开资金费更新；行情时间为本地接收时间。',
  }, 'variational', 'oil');
}

export function createOilDexReader({ request, shared, clock = Date.now, WebSocketImpl, variationalSession, fetcher = fetch }: { request: Request; shared: Shared; clock?: () => number; WebSocketImpl?: SocketConstructor; variationalSession?: VariationalSession; fetcher?: typeof fetch }) {
  const publicVariational = async () => await shared('variational/oil/quote', 1_000, async () => parseVariationalOilQuote(await request(VAR_STATS), clock())) as ExchangeQuote;
  const sameSession = (before: ReturnType<VariationalSession['current']>) => {
    const current = variationalSession!.current();
    return current.revision === before.revision && current.token === before.token;
  };
  async function variationalMarks(): Promise<{ quote: ExchangeQuote; session: ReturnType<VariationalSession['current']> | null }> {
    if (!variationalSession) return { quote: await publicVariational(), session: null };
    // Only authenticated marks depend on the session revision. Public funding
    // has its own cache and survives missing, rejected, or rotating credentials.
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = variationalSession.current();
      if (session.token) {
        try {
          const quote = await shared(`variational/oil/authenticated/${session.revision}`, 1_000, () => readVariationalAuthenticatedMarks(session.token!, { fetcher, clock })) as ExchangeQuote;
          if (!sameSession(session)) continue;
          variationalSession.report(session.revision, 'ready');
          return { quote, session };
        } catch (error) {
          if (!sameSession(session)) continue;
          const denied = Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);
          variationalSession.report(session.revision, denied ? 'rejected' : 'unavailable');
        }
      }
      const fallbackSession = variationalSession.current();
      try {
        const quote = await publicVariational();
        if (!sameSession(fallbackSession)) continue;
        return { quote, session: null };
      } catch (error) {
        if (!sameSession(fallbackSession)) continue;
        throw error;
      }
    }
    // Continuous session changes must not interrupt public market data.
    return { quote: await publicVariational(), session: null };
  }
  return async (exchange: 'lighter' | 'variational'): Promise<ExchangeQuote> => {
    if (exchange === 'lighter') {
      const markets = await shared('lighter/oil/instruments', 60_000, async () => parseLighterOilMarkets(await request(`${LIGHTER_ORIGIN}/api/v1/orderBookDetails`))) as LighterMarket[];
      return await shared('lighter/oil/quote', 1_000, () => readLighterOilSnapshot(markets, { clock, WebSocketImpl })) as ExchangeQuote;
    }
    if (exchange === 'variational') {
      const [initialMarks, funding] = await Promise.all([
        variationalMarks(),
        shared('variational/oil/public-funding', 1_000, () => readVariationalPublicFunding({ fetcher, clock })).catch(() => null),
      ]);
      let marks = initialMarks;
      // Funding can finish after a rotation even when the old marks finished first.
      if (marks.session && !sameSession(marks.session)) marks = await variationalMarks();
      if (marks.session && !sameSession(marks.session)) marks = { quote: await publicVariational(), session: null };
      return withVariationalFunding(marks.quote, funding as Awaited<ReturnType<typeof readVariationalPublicFunding>> | null, clock());
    }
    throw Error('未知原油交易所');
  };
}
