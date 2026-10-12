// Public feeds only. Robinhood Lighter is a separate deployment and order book;
// Entropy is the `io` HIP-3 namespace, not Hyperliquid's native perpetual venue.
import { AUXILIARY_BOOK_POLL_MS, RH_LIGHTER_BOOK_CONFIRM_MS } from './collection-policy.mjs';
export const ADDITIONAL_EXCHANGES = [
  { id: 'rh-lighter', name: 'rh-Lighter', type: 'dex', website: 'https://robinhoodchain.lighter.xyz', docsUrl: 'https://apidocs.rh.lighter.xyz/docs/websocket', description: 'Robinhood Chain 独立盘口 · USDG · WS 买卖一档' },
  { id: 'entropy', name: 'Entropy', type: 'dex', website: 'https://entropy.io', docsUrl: 'https://docs.entropy.io', description: 'Hyperliquid HIP-3 io · USDC · WS 买卖一档；非标准合约独立展示' },
];

const RH_API = 'https://api.rh.lighter.xyz';
const HL_API = 'https://api.hyperliquid.xyz/info';
const ENTROPY_EQUITIES = new Set(['SNDK', 'NBIS', 'GPRO', 'IONQ']);
const RH_PREIPO = new Set(['OPENAI', 'ANTHROPIC', 'SPCX', 'SHEIN']);
// Verified against the venue's public underlying_tracking contract descriptions
// and asset_type registry (robinhoodchain.lighter.xyz, 2026-09-19).
const RH_EQUITIES = new Set(['AAPL', 'AMD', 'AMZN', 'ASML', 'COIN', 'CRCL', 'GOOGL', 'HOOD', 'INTC', 'META', 'MSFT', 'MSTR', 'MU', 'NBIS', 'NVDA', 'ORCL', 'SNDK', 'TSLA']);
const RH_CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'ZEC', 'LIT', 'NEAR', 'SUI', 'VVV']);
const present = value => value !== undefined;
const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const price = value => { const number = finite(value); return number !== null && number > 0 ? number : null; };
function timestamp(value) {
  const number = price(value);
  if (number === null) return null;
  return number > 1e14 ? Math.floor(number / 1000) : number < 1e11 ? number * 1000 : number;
}
function quote(market, receivedAt, sourceTime, fields) {
  return { id: market.id, exchange: market.exchange, symbol: market.symbol, base: market.base, displayBase: market.displayBase, quoteCurrency: market.quoteCurrency, collateralCurrency: market.collateralCurrency, multiplier: market.multiplier, ...(typeof market.contractUnit === 'string' ? { contractUnit: market.contractUnit } : {}), ...(typeof market.comparable === 'boolean' ? { comparable: market.comparable } : {}), receivedAt, sourceTime, transport: 'ws', ...fields };
}
async function request(url, options, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetchImpl(url, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`公开合约目录请求失败 (${response.status})`);
  return response.json();
}

export async function discoverAdditionalMarkets(exchangeId, { fetchImpl = fetch, signal, now = Date.now() } = {}) {
  if (exchangeId === 'rh-lighter') {
    const data = await request(`${RH_API}/api/v1/orderBookDetails`, {}, fetchImpl, signal);
    if (data.code !== 200 || !Array.isArray(data.order_book_details)) throw new Error('rh-Lighter 合约目录格式异常');
    return data.order_book_details.filter(item => item.market_type === 'perp' && item.status === 'active' && Number.isInteger(item.market_id) && typeof item.symbol === 'string' && item.symbol.length > 0).map(item => {
      const share = RH_EQUITIES.has(item.symbol), crypto = RH_CRYPTO.has(item.symbol), preipo = RH_PREIPO.has(item.symbol);
      const base = share ? `EQUITY:${item.symbol}` : crypto ? item.symbol : `RH-LIGHTER:${item.symbol}:${preipo ? 'PREIPO' : 'CONTRACT'}`;
      // The public directory reports percentage units for the Standard tier.
      // Premium/Plus account fees are different and require an account override.
      // https://apidocs.rh.lighter.xyz/reference/orderbooks
      const feePercent = finite(item.taker_fee);
      const takerFeeRate = feePercent !== null && feePercent >= 0 && feePercent <= 10 ? feePercent / 100 : null;
      return { id: `rh-lighter:${item.symbol}`, exchange: 'rh-lighter', symbol: item.symbol, base, displayBase: item.symbol, quoteCurrency: 'USDG', collateralCurrency: 'USDG', multiplier: 1, fundingIntervalHours: 1, marketId: item.market_id, contractUnit: share ? '每股' : crypto ? '每枚' : preipo ? '平台独立 Pre-IPO 规格' : 'rh-Lighter 独立合约规格', comparable: share || crypto, takerFeeRate, takerFeeAt: takerFeeRate === null ? null : now, takerFeeSource: takerFeeRate === null ? null : 'rh-lighter-standard' };
    });
  }
  if (exchangeId === 'entropy') {
    const data = await request(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta', dex: 'io' }) }, fetchImpl, signal);
    if (!Array.isArray(data.universe) || data.collateralToken !== 0) throw new Error('Entropy 合约目录或抵押资产发生变化');
    return data.universe.filter(item => !item.isDelisted && typeof item.name === 'string' && /^io:[A-Za-z0-9._-]+$/.test(item.name)).map(item => {
      const symbol = item.name, displayBase = symbol.slice(3), share = ENTROPY_EQUITIES.has(displayBase), preipo = ['OAI', 'ANTH'].includes(displayBase);
      // Tier-0 API fees on USDC collateral; market-specific deployer and growth
      // multipliers are read from the existing directory, never assumed.
      // https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
      const deployerScale = finite(item.deployerFeeScale);
      const knownGrowth = item.growthMode === 'enabled' || item.growthMode === 'disabled';
      const takerFeeRate = deployerScale !== null && deployerScale >= 0 && deployerScale <= 3 && knownGrowth
        ? 0.00045 * (deployerScale < 1 ? 1 + deployerScale : 2 * deployerScale) * (item.growthMode === 'enabled' ? 0.1 : 1) : null;
      // New markets and market-cap contracts must not collide with unrelated CEX
      // tokens or similarly named per-share products. Review their specs first.
      return { id: `entropy:${symbol}`, exchange: 'entropy', symbol, base: share ? `EQUITY:${displayBase}` : `ENTROPY:${displayBase}:${preipo ? 'MARKETCAP' : 'CONTRACT'}`, displayBase, quoteCurrency: 'USDC', collateralCurrency: 'USDC', multiplier: 1, fundingIntervalHours: 1, dex: 'io', contractUnit: share ? '每股' : preipo ? '每 1 美元报价代表 10 亿美元市值' : 'Entropy 独立合约规格', comparable: share, takerFeeRate, takerFeeAt: takerFeeRate === null ? null : now, takerFeeSource: takerFeeRate === null ? null : 'entropy-standard' };
    });
  }
  throw new Error(`不支持的合约平台: ${exchangeId}`);
}

export function createAdditionalSubscriptions(exchangeId, markets) {
  const selected = markets.filter(market => market.exchange === exchangeId);
  if (!selected.length) return [];
  if (exchangeId === 'rh-lighter') {
    // The official market_stats stream carries current best_bid/ask_price.
    // Refresh its snapshot for unchanged markets without per-market tickers.
    return [{ url: `${RH_API.replace('https:', 'wss:')}/stream?readonly=true`, markets: selected, context: {}, subscribe: [{ type: 'subscribe', channel: 'market_stats/all' }], sendIntervalMs: 400, heartbeat: { type: 'ping' }, heartbeatMs: 30000,
      poll: { messages: [{ type: 'unsubscribe', channel: 'market_stats/all' }, { type: 'subscribe', channel: 'market_stats/all' }], intervalMs: RH_LIGHTER_BOOK_CONFIRM_MS, sendIntervalMs: 400 } }];
  }
  if (exchangeId === 'entropy') {
    const chunks = [];
    for (let index = 0; index < selected.length; index += 80) {
      const batch = selected.slice(index, index + 80);
      chunks.push({ url: 'wss://api.hyperliquid.xyz/ws', markets: batch, context: {}, subscribe: batch.flatMap(market => ['bbo', 'activeAssetCtx'].map(type => ({ method: 'subscribe', subscription: { type, coin: market.symbol } }))), sendIntervalMs: 50, startDelayMs: chunks.length * 1500, heartbeat: { method: 'ping' }, heartbeatMs: 30000,
        // Share Hyperliquid's host-wide auxiliary budget; active BBO needs no
        // extra request. Rate-limit backoff must not drop its live subscription.
        poll: { messages: batch.map((market, id) => ({ method: 'post', id, request: { type: 'info', payload: { type: 'l2Book', coin: market.symbol } } })), intervalMs: AUXILIARY_BOOK_POLL_MS, sendIntervalMs: 100, staleBookAfterMs: 15000, maxPerMinute: 60 } });
    }
    return chunks;
  }
  return [];
}

export function parseAdditionalMessage(exchangeId, payload, markets, receivedAt = Date.now(), context = {}) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.error || payload.channel === 'error' || (payload.channel === 'post' && payload.data?.response?.type === 'error')) throw new Error(`${exchangeId} WebSocket: ${String(payload.error?.message || payload.error || payload.data?.response?.payload || payload.data).slice(0, 300)}`);
  if (context.indexMarkets !== markets || context.indexExchange !== exchangeId) {
    context.indexMarkets = markets; context.indexExchange = exchangeId;
    context.marketIndex = new Map(); context.marketIdIndex = new Map();
    for (const market of markets) if (market.exchange === exchangeId) { context.marketIndex.set(market.symbol, market); if (market.marketId !== undefined) context.marketIdIndex.set(market.marketId, market); }
  }
  if (exchangeId === 'rh-lighter') {
    const match = /^ticker:(\d+)$/.exec(payload.channel ?? '');
    if (match && payload.ticker && ['subscribed/ticker', 'update/ticker'].includes(payload.type)) {
      const market = context.marketIdIndex.get(Number(match[1]));
      if (!market || payload.ticker.s !== market.symbol) return [];
      const sourceTime = timestamp(payload.ticker.last_updated_at ?? payload.last_updated_at ?? payload.timestamp);
      context.bboTimes ??= new Map();
      if (sourceTime !== null && sourceTime < (context.bboTimes.get(market.id) ?? 0)) return [];
      if (sourceTime !== null) context.bboTimes.set(market.id, sourceTime);
      const side = value => price(value?.size) === null ? null : price(value?.price);
      return [quote(market, receivedAt, sourceTime, { bid: side(payload.ticker.b), ask: side(payload.ticker.a) })];
    }
    if (!/^market_stats:(?:all|\d+)$/.test(payload.channel ?? '') || !['subscribed/market_stats', 'update/market_stats'].includes(payload.type) || !payload.market_stats) return [];
    const stats = payload.channel === 'market_stats:all' ? Object.values(payload.market_stats) : [payload.market_stats];
    return stats.flatMap(item => {
      const market = context.marketIdIndex.get(item?.market_id);
      if (!market || market.symbol !== item?.symbol) return [];
      const fields = {};
      if (present(item.best_bid_price)) fields.bid = price(item.best_bid_price);
      if (present(item.best_ask_price)) fields.ask = price(item.best_ask_price);
      if (present(item.mark_price)) fields.mark = price(item.mark_price);
      if (present(item.last_trade_price)) fields.last = price(item.last_trade_price);
      if (present(item.current_funding_rate)) {
        const rate = finite(item.current_funding_rate);
        fields.fundingRate = rate === null ? null : rate / 100;
        fields.fundingIntervalHours = 1;
      }
      // Only present price fields confirm a book. Mark/funding-only frames
      // remain partial and cannot refresh a cached price.
      return Object.keys(fields).length ? [quote(market, receivedAt, timestamp(payload.timestamp), fields)] : [];
    });
  }
  if (exchangeId === 'entropy') {
    const bookResponse = payload.channel === 'post' && payload.data?.response?.type === 'info' && payload.data.response.payload?.type === 'l2Book';
    const data = bookResponse ? payload.data.response.payload.data : payload.data;
    if (!data || typeof data.coin !== 'string') return [];
    const market = context.marketIndex.get(data.coin);
    if (!market) return [];
    const levels = bookResponse && Array.isArray(data.levels) && data.levels.length === 2 ? [data.levels[0]?.[0] ?? null, data.levels[1]?.[0] ?? null] : data.bbo;
    if ((bookResponse || payload.channel === 'bbo') && Array.isArray(levels) && levels.length === 2) {
      const sourceTime = timestamp(data.time);
      context.bboTimes ??= new Map();
      if (sourceTime !== null && sourceTime < (context.bboTimes.get(market.id) ?? 0)) return [];
      if (sourceTime !== null) context.bboTimes.set(market.id, sourceTime);
      const side = value => price(value?.sz) === null ? null : price(value?.px);
      return [quote(market, receivedAt, sourceTime, { bid: side(levels[0]), ask: side(levels[1]) })];
    }
    if (payload.channel === 'activeAssetCtx' && data.ctx) {
      const fields = {};
      if (present(data.ctx.markPx)) fields.mark = price(data.ctx.markPx);
      if (present(data.ctx.funding)) { fields.fundingRate = finite(data.ctx.funding); fields.fundingIntervalHours = 1; }
      return Object.keys(fields).length ? [quote(market, receivedAt, null, fields)] : [];
    }
  }
  return [];
}

export function getAdditionalControlResponse(exchangeId, payload) {
  return exchangeId === 'rh-lighter' && payload?.type === 'ping' ? { type: 'pong' } : null;
}
