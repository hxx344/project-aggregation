// Public Kraken Multi-M perpetual feeds only. No account or trading endpoints.
// https://docs.kraken.com/api-reference/instrument-details/get-instruments
// https://docs.kraken.com/exchange/api-reference/futures-websocket/ticker
// https://support.kraken.com/articles/4844429542676-trading-multi-collateral-derivatives
export const KRAKEN_EXCHANGE = Object.freeze({ id: 'kraken', name: 'Kraken', type: 'cex', website: 'https://www.kraken.com', docsUrl: 'https://docs.kraken.com/exchange/api-reference/futures-websocket/ticker' });
const API = 'https://futures.kraken.com/derivatives/api/v3/instruments';
const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => { const result = finite(value); return result !== null && result > 0 ? result : null; };
const baseAlias = base => base === 'XBT' ? 'BTC' : base;
const validTime = (value, now) => { const result = positive(value); return Number.isSafeInteger(result) && result >= 1e12 && result <= now + 5_000 ? result : null; };

export async function discoverKrakenMarkets({ fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetchImpl(API, { credentials: 'omit', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Kraken: HTTP ${response.status}`);
  const data = await response.json();
  if (data?.result !== 'success' || !Array.isArray(data.instruments)) throw new Error('Kraken: invalid market list');
  const markets = [], symbols = new Set();
  for (const row of data.instruments) {
    if (!row || row.type !== 'flexible_futures' || row.tradeable !== true || row.isExpired !== false || row.tradfi !== false
      || row.postOnly === true || row.quote !== 'USD' || positive(row.contractSize) !== 1
      || typeof row.base !== 'string' || !/^[A-Z0-9]{1,40}$/.test(row.base)
      || typeof row.symbol !== 'string' || !/^PF_[A-Z0-9]+USD$/.test(row.symbol)) continue;
    const base = baseAlias(row.base), nativeBase = row.symbol.slice(3, -3);
    // BTC is explicitly named XBT in the native product id. No general ticker
    // stripping or numeric-prefix normalization is used for other assets.
    if (baseAlias(nativeBase) !== base) continue;
    let delistingAt = null;
    if (row.lastTradingTime !== undefined && row.lastTradingTime !== null && row.lastTradingTime !== '') {
      delistingAt = typeof row.lastTradingTime === 'string' ? Date.parse(row.lastTradingTime) : NaN;
      if (!Number.isSafeInteger(delistingAt) || delistingAt <= now || delistingAt > 8.64e15) continue;
    }
    if (symbols.has(row.symbol)) throw new Error('Kraken: duplicate market identity');
    symbols.add(row.symbol);
    markets.push({
      id: `kraken:${row.symbol}`, exchange: 'kraken', symbol: row.symbol, rawBase: row.base, base,
      quoteCurrency: 'USD', collateralCurrency: 'MULTI', settlementCurrency: 'USD', counterCurrency: 'USD',
      contractKind: 'linear', multiplier: 1, contractUnit: '每枚', fundingIntervalHours: null,
      assetClass: 'crypto', comparable: true, identityVerified: true,
      identitySource: `Kraken instruments: base=${row.base};quote=USD;type=flexible_futures;contractSize=1;tradfi=false;isExpired=false`,
      crossexSymbol: `KRAKEN_FUTURE_${base}_USD`, delisting: delistingAt !== null, delistingAt,
    });
  }
  return markets.sort((a, b) => a.base.localeCompare(b.base) || a.symbol.localeCompare(b.symbol));
}

export function createKrakenSubscriptions(markets) {
  const selected = markets.filter(market => market.exchange === 'kraken'), result = [];
  for (let index = 0; index < selected.length; index += 100) {
    const group = selected.slice(index, index + 100);
    result.push({ url: 'wss://futures.kraken.com/ws/v1', markets: group, context: {}, sendIntervalMs: 250, startDelayMs: result.length * 500,
      subscribe: [{ event: 'subscribe', feed: 'heartbeat' }, { event: 'subscribe', feed: 'ticker', product_ids: group.map(market => market.symbol) }] });
  }
  return result;
}

export function parseKrakenMessage(payload, markets, receivedAt = Date.now(), context = {}) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.event === 'error' || payload.event === 'subscribed_failed' || payload.event === 'unsubscribed_failed') {
    throw new Error(`Kraken WebSocket: ${String(payload.message || payload.event).slice(0, 250)}`);
  }
  if (payload.feed !== 'ticker' || payload.event !== undefined || payload.tag !== 'perpetual') return [];
  if (context.indexMarkets !== markets) {
    context.indexMarkets = markets;
    context.marketIndex = new Map(markets.filter(market => market.exchange === 'kraken').map(market => [market.symbol, market]));
    context.krakenTimes = new Map();
  }
  const market = context.marketIndex.get(payload.product_id), sourceTime = validTime(payload.time, receivedAt);
  if (!market || sourceTime === null || sourceTime < (context.krakenTimes.get(market.id) ?? 0)) return [];
  if (typeof payload.pair !== 'string' || baseAlias(payload.pair.split(':')[0]) !== market.base || payload.pair.split(':')[1] !== 'USD') return [];
  const fields = {};
  // Kraken ticker is a full refresh, but malformed/partial messages must never
  // use a funding or mark update to confirm a cached best bid/ask.
  if (payload.suspended === true || payload.post_only === true) { fields.bid = null; fields.ask = null; }
  else if (Object.hasOwn(payload, 'bid') && Object.hasOwn(payload, 'ask')) {
    fields.bid = positive(payload.bid_size) === null ? null : positive(payload.bid);
    fields.ask = positive(payload.ask_size) === null ? null : positive(payload.ask);
  }
  if (Object.hasOwn(payload, 'markPrice')) fields.mark = positive(payload.markPrice);
  if (Object.hasOwn(payload, 'last')) fields.last = positive(payload.last);
  // funding_rate is a cash amount, not a decimal rate. Leave funding unknown
  // until the venue's relative rate and accrual interval are both established.
  if (!Object.keys(fields).length) return [];
  context.krakenTimes.set(market.id, sourceTime);
  return [{ id: market.id, exchange: 'kraken', symbol: market.symbol, base: market.base,
    quoteCurrency: market.quoteCurrency, collateralCurrency: market.collateralCurrency, settlementCurrency: market.settlementCurrency,
    multiplier: 1, contractUnit: market.contractUnit, comparable: market.comparable,
    receivedAt, sourceTime, transport: 'ws', ...fields }];
}
