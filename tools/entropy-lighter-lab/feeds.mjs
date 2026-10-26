// Public data only. No real account, signing, order or credential requests.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const SOURCES = Object.freeze({
  entropy: 'https://docs.entropy.io/about-entropy/readme',
  entropyEquity: 'https://docs.entropy.io/asset-directory/equity-assets',
  entropyPreIpo: 'https://docs.entropy.io/market-types/pre-ipo-perpetuals',
  hyperliquidWs: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions',
  hyperliquidMinimum: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses',
  hyperliquidLotSize: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size',
  hyperliquidFees: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees',
  hyperliquidFeeSchedule: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-fees',
  hyperliquidDeployerFees: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions',
  lighterMarketData: 'https://apidocs.lighter.xyz/docs/market-data',
  lighterWs: 'https://apidocs.lighter.xyz/docs/websocket-reference',
  lighterTimestamps: 'https://apidocs.lighter.xyz/docs/timestamps',
  lighterAccounts: 'https://apidocs.lighter.xyz/docs/account-types',
  lighterFeeTiers: 'https://apidocs.lighter.xyz/reference/feetiers',
  lighterPreIpo: 'https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets',
  binanceSndk: 'https://www.binance.com/en/support/announcement/detail/80549fadb3e447d1a859b8cedd0ccd69',
  binanceAnth: 'https://www.binance.com/en/support/announcement/detail/2b9ff1e1acf8433793bc40c59a0cb852',
  binanceWs: 'https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams',
});

const SYMBOLS = Object.freeze({
  entropy: { SNDK: 'io:SNDK', ANTH: 'io:ANTH' },
  lighter: { SNDK: 'SNDK', ANTH: 'ANTHROPIC' },
  binance: { SNDK: 'SNDKUSDT', ANTH: 'ANTHROPICUSDT' },
});
const ENDPOINTS = Object.freeze({
  entropy: 'https://api.hyperliquid.xyz/info',
  lighter: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails',
  binance: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
});
const LIGHTER_FEE_ENDPOINT = 'https://mainnet.zklighter.elliot.ai/api/v1/feeTiers?filter=perps';
const FEE_SCOPE = 'public_default_tier_no_builder';
const FEE_TTL_MS = 20 * 60_000;
const sharedCooldowns = {};
const sequence = value => typeof value === 'string' && /^\d+$/.test(value)
  ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const positiveTime = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
class CallbackFailure extends Error {
  constructor(cause) { super('feed_callback_failed', { cause }); }
}
function invoke(callback, value) {
  try { callback?.(value); } catch (cause) { throw new CallbackFailure(cause); }
}
const diagnostic = (callback, value) => invoke(callback, { at: Date.now(), ...value });
const cooldownAt = (cooldowns, venue) => Number.isSafeInteger(cooldowns[venue]) && cooldowns[venue] > 0 ? cooldowns[venue] : 0;

export function retryNotBefore({ status, headers, body, now = Date.now() }) {
  const retryAfter = headers?.get?.('retry-after');
  const seconds = retryAfter !== null && retryAfter !== undefined && /^\d+(\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : null;
  const headerAt = seconds !== null ? now + seconds : Date.parse(retryAfter || '');
  const banMatch = typeof body?.msg === 'string' ? body.msg.match(/banned until (\d{10,16})/i) : null;
  const banAt = banMatch ? Number(banMatch[1]) : 0;
  const defaultAt = now + (status === 418 ? 30 * 60_000 : 60_000);
  return Math.max(now, Number.isFinite(headerAt) ? headerAt : 0, banAt, defaultAt);
}

async function readJson(venue, { signal, fetchImpl, onDiagnostic, cooldowns }, purpose = 'metadata') {
  const until = cooldownAt(cooldowns, venue);
  if (until > Date.now()) {
    const error = new Error('venue_cooldown');
    error.retryNotBefore = until;
    throw error;
  }
  // At most three read attempts, 8s each; only transport/5xx failures retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const retryUntil = cooldownAt(cooldowns, venue);
    if (retryUntil > Date.now()) {
      const error = new Error('venue_cooldown');
      error.retryNotBefore = retryUntil;
      throw error;
    }
    const started = performance.now();
    try {
      const response = await fetchImpl(venue === 'lighter' && purpose === 'fees' ? LIGHTER_FEE_ENDPOINT : ENDPOINTS[venue], {
        method: venue === 'entropy' ? 'POST' : 'GET',
        ...(venue === 'entropy' ? {
          headers: { 'Content-Type': 'application/json' },
          // The immutable zero address is used only to retrieve the global schedule.
          body: JSON.stringify(purpose === 'fees'
            ? { type: 'userFees', user: '0x0000000000000000000000000000000000000000' }
            : { type: 'metaAndAssetCtxs', dex: 'io' }),
        } : {}),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]),
      });
      let text = '';
      let bytes = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > 8_000_000) throw new Error('metadata_body_limit');
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      diagnostic(onDiagnostic, { level: 'info', event: 'http_rtt', venue,
        message: 'Public metadata request RTT; not order acknowledgement or fill latency.',
        details: { rttMs: performance.now() - started, status: response.status, purpose, measurement: 'public_http_body', notOrderLatency: true } });
      let body;
      try { body = JSON.parse(text); }
      catch { if (response.ok) throw new Error('metadata_invalid_json'); body = null; }
      if (response.status === 418 || response.status === 429 || body?.code === -1003) {
        const notBefore = retryNotBefore({ status: response.status, headers: response.headers, body });
        cooldowns[venue] = Math.max(cooldownAt(cooldowns, venue), notBefore);
        const error = new Error('rate_limited');
        error.retryNotBefore = notBefore;
        diagnostic(onDiagnostic, { level: 'warn', event: 'cooldown', venue,
          message: 'Public API rate limit; all connections for this venue wait until retryNotBefore.',
          details: { status: response.status, code: body?.code, retryNotBefore: notBefore } });
        throw error;
      }
      if (!response.ok) {
        const error = new Error('metadata_http_error');
        error.status = response.status;
        throw error;
      }
      if (venue === 'lighter' && (purpose === 'metadata' ? body?.code !== 200 : body?.code !== undefined && body.code !== 200)) {
        throw new Error('metadata_api_error');
      }
      // Discard all zero-address account rates, volumes, referral and staking state.
      return venue === 'entropy' && purpose === 'fees' ? { feeSchedule: { cross: body?.feeSchedule?.cross } } : body;
    } catch (error) {
      if (error instanceof CallbackFailure || signal?.aborted || error.retryNotBefore || error.status && error.status < 500
        || !['TypeError', 'TimeoutError'].includes(error.name) && !(error.status >= 500)) throw error;
      diagnostic(onDiagnostic, { level: 'warn', event: 'metadata_retry', venue,
        message: 'Transient metadata read failed.', details: { attempt: attempt + 1, status: error.status || null } });
      if (attempt === 2) throw error;
      await delay(250 * 2 ** attempt, undefined, { signal });
    }
  }
}

const feeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;

/** Public default fee facts only; never an estimate of a connected user's fee tier. */
export function deriveAutoFees({ venue, markets, feeBody, feeError = null, fetchedAt = Date.now(), ttlMs = FEE_TTL_MS }) {
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0
    || !Number.isSafeInteger(fetchedAt + ttlMs)) throw new Error('invalid_fee_lifetime');
  const sourceUrls = venue === 'entropy'
    ? [ENDPOINTS.entropy, SOURCES.hyperliquidFeeSchedule, SOURCES.hyperliquidFees, SOURCES.hyperliquidDeployerFees]
    : venue === 'lighter' ? [LIGHTER_FEE_ENDPOINT, ENDPOINTS.lighter, SOURCES.lighterFeeTiers, SOURCES.lighterAccounts] : [];
  return new Map(markets.map(market => {
    const fee = {
      status: 'unavailable', takerFeeBps: null, baseTakerBps: null, growthMultiplier: null, deployerFeeScale: null,
      scope: FEE_SCOPE, accountTier: venue === 'lighter' ? 'standard' : 'default',
      sourceUrls, fetchedAt, expiresAt: fetchedAt + ttlMs, revision: null, reason: null,
      assumptions: ['public_default_tier_not_actual_account_rate', 'no_builder_fee_added', 'no_account_referral_or_staking_discount'],
    };
    if (!['entropy', 'lighter'].includes(venue)) fee.reason = 'research_source_only';
    else if (feeError) fee.reason = 'fee_request_unavailable';
    else if (!feeBody) fee.reason = 'fee_schedule_missing';
    else if (venue === 'entropy') {
      const baseRate = feeNumber(feeBody.feeSchedule?.cross);
      const scale = feeNumber(market.raw?.deployerFeeScale);
      const growthMode = market.raw?.growthMode;
      if (baseRate === null || baseRate <= 0 || baseRate >= 1) fee.reason = 'invalid_base_fee_schedule';
      else if (market.collateralToken !== 0) fee.reason = 'unsupported_collateral_token';
      else if (!['enabled', 'disabled'].includes(growthMode)) fee.reason = 'unknown_growth_mode';
      else if (scale === null || (growthMode === 'enabled' ? scale >= 10 : scale > 3)) fee.reason = 'invalid_deployer_fee_scale';
      else {
        fee.baseTakerBps = baseRate * 10_000;
        fee.deployerFeeScale = scale;
        fee.growthMultiplier = growthMode === 'enabled' ? 0.1 : 1;
        // Official fee formula: scale < 1 => 1 + scale; otherwise 2 * scale.
        fee.takerFeeBps = fee.baseTakerBps * (scale < 1 ? 1 + scale : 2 * scale) * fee.growthMultiplier;
        fee.assumptions.push('native_usdc_collateral_no_aligned_quote_discount');
      }
    } else {
      const standard = Array.isArray(feeBody.user_tiers) ? feeBody.user_tiers.filter(row => row?.name === 'standard') : [];
      const ticks = standard.length === 1 ? standard[0].taker_fee_ticks : null;
      if (!Number.isSafeInteger(ticks) || ticks < 0) fee.reason = 'invalid_standard_fee_tier';
      // Nonzero market fees need a separate verified unit and composition contract.
      else if (feeNumber(market.raw?.taker_fee) !== 0 || market.raw?.is_taker_fee_enabled !== true) {
        fee.reason = 'unsupported_market_fee';
      } else {
        fee.baseTakerBps = ticks / 100; // 1 fee tick = 0.0001% = 0.01 bps.
        fee.takerFeeBps = fee.baseTakerBps;
        fee.growthMultiplier = 1;
        fee.assumptions.push('standard_account_regular_taker_order', 'market_specific_taker_fee_is_zero');
      }
    }
    if (fee.reason === null) {
      fee.status = 'available';
      fee.revision = createHash('sha256').update(JSON.stringify({
        venue, symbol: market.symbol, nativeSymbol: market.nativeSymbol, scope: fee.scope, accountTier: fee.accountTier,
        takerFeeBps: fee.takerFeeBps, baseTakerBps: fee.baseTakerBps, growthMultiplier: fee.growthMultiplier,
        deployerFeeScale: fee.deployerFeeScale, collateralToken: market.collateralToken ?? null, noBuilder: true,
      })).digest('hex');
    }
    return [market.nativeSymbol, fee];
  }));
}

export function attachFeeFacts(markets, options = {}) {
  const byVenue = new Map([...new Set(markets.map(market => market.venue))].map(venue => [venue,
    deriveAutoFees({ ...options, venue, markets: markets.filter(market => market.venue === venue) })]));
  return markets.map(market => ({ ...market, fee: byVenue.get(market.venue).get(market.nativeSymbol) }));
}

export function parseMetadata(venue, body) {
  const universe = venue === 'entropy' ? body?.[0]?.universe
    : venue === 'lighter' ? body?.order_book_details : body?.symbols;
  if (!Array.isArray(universe)) throw new Error('metadata_schema_error');
  return attachFeeFacts(Object.entries(SYMBOLS[venue]).map(([symbol, nativeSymbol]) => {
    const raw = universe.find(row => (venue === 'entropy' ? row.name : row.symbol) === nativeSymbol);
    if (!raw) throw new Error(`missing_market:${nativeSymbol}`);
    if (venue === 'binance' && (raw.quoteAsset !== 'USDT' || raw.contractType !== 'PERPETUAL')) {
      throw new Error('binance_contract_identity_mismatch');
    }
    if (venue === 'lighter' && (!Number.isInteger(raw.market_id) || raw.market_type !== 'perp')) {
      throw new Error('lighter_contract_identity_mismatch');
    }
    const index = universe.indexOf(raw);
    const identityVerified = symbol === 'SNDK' && (venue !== 'lighter' || Number(raw.multiplier) === 1);
    const lotFilter = raw.filters?.find(row => row.filterType === 'LOT_SIZE');
    const ntlFilter = raw.filters?.find(row => row.filterType === 'MIN_NOTIONAL');
    return {
      venue, symbol, nativeSymbol, quote: venue === 'binance' ? 'USDT' : 'USDC',
      collateralToken: venue === 'entropy' ? body[0].collateralToken ?? null : null,
      priceUnit: venue === 'binance' ? 'USDT' : 'USD', settlement: venue === 'binance' ? 'USDT' : 'USDC',
      marketId: venue === 'lighter' ? raw.market_id : null,
      status: venue === 'entropy' ? raw.isDelisted ? 'delisted' : 'active'
        : venue === 'binance' ? raw.status === 'TRADING' ? 'active' : raw.status : raw.status,
      sizeDecimals: venue === 'entropy' ? raw.szDecimals
        : venue === 'lighter' ? raw.size_decimals ?? raw.supported_size_decimals : raw.quantityPrecision,
      priceDecimals: venue === 'entropy' ? null
        : venue === 'lighter' ? raw.price_decimals ?? raw.supported_price_decimals : raw.pricePrecision,
      maxPriceDecimals: venue === 'entropy' ? 6 - raw.szDecimals : null,
      maxLeverage: raw.maxLeverage ?? null,
      minBaseAmount: venue === 'entropy' ? 10 ** -raw.szDecimals
        : venue === 'lighter' ? raw.min_base_amount ?? null : lotFilter?.minQty ?? null,
      minQuoteAmount: venue === 'entropy' ? '10'
        : venue === 'lighter' ? raw.min_quote_amount ?? null : ntlFilter?.notional ?? ntlFilter?.minNotional ?? null,
      multiplier: venue === 'lighter' ? raw.multiplier ?? null : 1,
      takerLatencyMs: venue === 'lighter' ? 300 : null,
      takerLatencySource: venue === 'lighter' ? SOURCES.lighterAccounts : null,
      identityVerified, simulationEnabled: identityVerified && venue !== 'binance',
      settlementEquivalence: symbol === 'ANTH' ? 'unverified' : 'same_reference_equity_price',
      identityNote: symbol === 'ANTH'
        ? 'Same referenced company; Entropy is a market-cap perpetual ($1 = $1B). Lighter conversion and Binance estimated-share/IPO rules differ. Economic equivalence is unverified.'
        : 'SanDisk equity-price perpetual; venue oracles, funding and settlement rules still differ.',
      role: venue === 'binance' ? 'leader_research_only' : 'simulated_taker_leg',
      raw, context: venue === 'entropy' ? body[1]?.[index] ?? null : null,
    };
  }));
}

export async function discover({ signal, onDiagnostic, fetchImpl = fetch, cooldowns = sharedCooldowns } = {}) {
  const results = await Promise.all(Object.keys(SYMBOLS).map(async venue => {
    try {
      const options = { signal, fetchImpl, onDiagnostic, cooldowns };
      const fetchedAt = Date.now();
      const [metadata, fees] = await Promise.allSettled([
        readJson(venue, options),
        venue === 'binance' ? Promise.resolve(null) : readJson(venue, options, 'fees'),
      ]);
      if (metadata.status === 'rejected') throw metadata.reason;
      if (fees.status === 'rejected' && (fees.reason instanceof CallbackFailure || signal?.aborted)) throw fees.reason;
      const parsed = attachFeeFacts(parseMetadata(venue, metadata.value), {
        feeBody: fees.status === 'fulfilled' ? fees.value : null,
        feeError: fees.status === 'rejected' ? fees.reason : null, fetchedAt,
      });
      if (parsed.some(market => market.fee.status === 'unavailable') && venue !== 'binance') {
        diagnostic(onDiagnostic, { level: 'warn', event: 'fees_unavailable', venue,
          message: 'Public default fee unavailable; market data remains usable, simulated entry requires valid fees.',
          details: { reasons: [...new Set(parsed.map(market => market.fee.reason).filter(Boolean))] } });
      }
      return parsed;
    }
    catch (error) {
      if (error instanceof CallbackFailure || signal?.aborted) throw error;
      diagnostic(onDiagnostic, { level: 'error', event: 'metadata_unavailable', venue,
        message: 'Market metadata unavailable; no simulated trading on unverified metadata.',
        details: { category: error.message.split(':')[0], retryNotBefore: error.retryNotBefore || null } });
      // Binance remains a public-data research source based on official listing announcements.
      // Its venue cooldown still blocks connecting before the server's deadline.
      return venue !== 'binance' ? [] : attachFeeFacts(Object.entries(SYMBOLS.binance).map(([symbol, nativeSymbol]) => ({
        venue, symbol, nativeSymbol, quote: 'USDT', priceUnit: 'USDT', settlement: 'USDT',
        status: 'unverified', identityVerified: false, simulationEnabled: false,
        settlementEquivalence: 'unverified', role: 'leader_research_only', raw: null,
        retryNotBefore: error.retryNotBefore || null,
      })));
    }
  }));
  return { markets: results.flat(), sources: SOURCES, discoveredAt: Date.now() };
}

function levels(rows, { zeros = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('invalid_levels');
  const seen = new Set();
  return rows.map(row => {
    const price = Number(Array.isArray(row) ? row[0] : row.px ?? row.price);
    const size = Number(Array.isArray(row) ? row[1] : row.sz ?? row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0
      || !zeros && size === 0 || seen.has(price)) throw new Error('invalid_level');
    seen.add(price);
    return [price, size];
  });
}

/** Stateful decoder is exported for offline replay; live WS uses this exact path. */
export function createFeedDecoder({ markets, onBook, onDiagnostic, onRaw, resubscribe = () => {} }) {
  const states = new Map();
  const keys = new Map(markets.map(m => [`${m.venue}:${m.nativeSymbol}`, m]));
  function invalidate(venue, symbol, reason, details) {
    for (const market of markets.filter(m => m.venue === venue && (!symbol || m.symbol === symbol))) {
      states.delete(`${venue}:${market.symbol}`);
      diagnostic(onDiagnostic, { level: 'warn', event: 'invalidated', venue, symbol: market.symbol,
        reason, message: 'Book invalidated; a new snapshot is required.', details });
    }
  }
  function publish(market, bids, asks, sourceAt, seq, clocks) {
    if (!sourceAt) throw new Error('missing_source_timestamp');
    const sortedBids = bids.filter(x => x[1] > 0).sort((a, b) => b[0] - a[0]);
    const sortedAsks = asks.filter(x => x[1] > 0).sort((a, b) => a[0] - b[0]);
    if (!sortedBids.length || !sortedAsks.length || sortedBids[0][0] >= sortedAsks[0][0]) throw new Error('empty_or_crossed_book');
    const key = `${market.venue}:${market.symbol}`;
    const previous = states.get(key);
    if (previous?.sourceAt > sourceAt) throw new Error('source_timestamp_regression');
    const book = {
      venue: market.venue, symbol: market.symbol, nativeSymbol: market.nativeSymbol,
      quote: market.quote, priceUnit: market.priceUnit, settlement: market.settlement,
      receivedAt: clocks.receivedAt, receivedMono: clocks.receivedMono,
      sourceAt, sequence: seq, bids: sortedBids, asks: sortedAsks,
    };
    states.set(key, { ...previous, sourceAt, receivedMono: clocks.receivedMono, book });
    invoke(onBook, book);
  }
  function handle(venue, raw, clocks = { receivedAt: Date.now(), receivedMono: performance.now() }) {
    invoke(onRaw, { venue, payload: raw, ...clocks });
    let payload;
    try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { invalidate(venue, null, 'invalid_json'); return; }
    let market;
    try {
      if (venue === 'entropy') {
        if (payload.channel !== 'l2Book') return;
        const data = payload.data;
        market = keys.get(`entropy:${data?.coin}`);
        if (!market) return;
        if (!Array.isArray(data.levels) || data.levels.length !== 2) throw new Error('invalid_book_schema');
        const old = states.get(`entropy:${market.symbol}`);
        const sourceAt = positiveTime(data.time);
        if (old?.sourceAt === sourceAt) return;
        publish(market, levels(data.levels[0]), levels(data.levels[1]), sourceAt, null, clocks);
      } else if (venue === 'lighter') {
        if (!['subscribed/order_book', 'update/order_book'].includes(payload.type)) return;
        const id = payload.channel?.match(/^order_book:(\d+)$/)?.[1];
        market = markets.find(m => m.venue === 'lighter' && String(m.marketId) === id);
        if (!market) return;
        const ob = payload.order_book;
        const seq = sequence(ob?.nonce);
        if (seq === null) throw new Error('missing_or_unsafe_nonce');
        const key = `lighter:${market.symbol}`;
        let state = states.get(key);
        if (payload.type === 'subscribed/order_book') {
          state = { bids: new Map(), asks: new Map(), nonce: null };
          states.set(key, state);
        } else {
          if (!state?.nonce) return; // Incrementals cannot initialise an order book.
          if (seq === state.nonce) return;
          if (sequence(ob.begin_nonce) !== state.nonce || BigInt(seq) < BigInt(state.nonce)) {
            invalidate('lighter', market.symbol, 'sequence_gap', { previous: state.nonce, beginNonce: sequence(ob.begin_nonce), nonce: seq });
            resubscribe(market);
            return;
          }
        }
        for (const [side, changes] of [[state.bids, ob.bids], [state.asks, ob.asks]]) {
          for (const [price, size] of levels(changes, { zeros: true })) {
            if (size === 0) side.delete(price); else side.set(price, size);
          }
        }
        state.nonce = seq;
        const sourceAt = positiveTime(ob.last_updated_at ?? payload.last_updated_at);
        publish(market, [...state.bids], [...state.asks], sourceAt ? sourceAt / 1000 : null, seq, clocks);
      } else if (venue === 'binance') {
        const data = payload.data ?? payload;
        if (data.e !== 'depthUpdate' || data.st && data.st !== 1) return;
        market = keys.get(`binance:${data.s}`);
        if (!market) return;
        const seq = sequence(data.u);
        if (!seq) throw new Error('missing_or_unsafe_sequence');
        const old = states.get(`binance:${market.symbol}`);
        if (old?.book.sequence && BigInt(seq) <= BigInt(old.book.sequence)) return;
        // depth20 is a complete top-20 replacement; it is not the diff-depth stream.
        publish(market, levels(data.b, { zeros: true }), levels(data.a, { zeros: true }), positiveTime(data.T ?? data.E), seq, clocks);
      }
    } catch (error) {
      if (error instanceof CallbackFailure) throw error;
      invalidate(venue, market?.symbol, error.message);
      if (market?.venue === 'lighter') resubscribe(market);
    }
  }
  return { handle, invalidate, states };
}

export function startFeeds({ markets, onBook, onDiagnostic, onRaw, signal,
  WebSocketImpl = WebSocket, timings = {}, cooldowns = sharedCooldowns }) {
  const settings = { connectMs: 8_000, staleMs: 10_000, watchdogMs: 1_000,
    heartbeatMs: 30_000, retryBaseMs: 1_000, maxAttempts: 5, cooldownMs: 60_000, ...timings };
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const sockets = new Set();
  const active = markets.filter(m => m.status === 'active' || m.venue === 'binance' && m.role === 'leader_research_only');
  const tasks = Object.keys(SYMBOLS).filter(venue => active.some(m => m.venue === venue)).map(async venue => {
    const venueMarkets = active.filter(m => m.venue === venue);
    let failures = 0;
    while (!combined.aborted) {
      const notBefore = Math.max(cooldownAt(cooldowns, venue), ...venueMarkets.map(m => m.retryNotBefore || 0));
      if (notBefore > Date.now()) {
        diagnostic(onDiagnostic, { level: 'warn', event: 'cooldown', venue,
          message: 'Venue connections paused until server deadline.', details: { retryNotBefore: notBefore } });
        try { await delay(notBefore - Date.now(), undefined, { signal: combined }); } catch { break; }
      }
      if (combined.aborted) break;
      const openedAt = performance.now();
      await new Promise((resolve, reject) => {
        let ws;
        let finished = false;
        let ready = false;
        let connectedAt = openedAt;
        let connectTimer;
        let heartbeat;
        let watchdog;
        let pingStarted = null;
        const sentResync = new Map();
        const decoder = createFeedDecoder({ markets: venueMarkets, onBook, onDiagnostic, onRaw,
          resubscribe(market) {
            // A malformed stream must not generate an unbounded subscribe loop.
            const count = (sentResync.get(market.symbol) || 0) + 1;
            sentResync.set(market.symbol, count);
            if (count > 3) { finish('resync_limit'); return; }
            send({ type: 'unsubscribe', channel: `order_book/${market.marketId}` });
            send({ type: 'subscribe', channel: `order_book/${market.marketId}` });
          },
        });
        const send = value => { if (ws?.readyState === 1) ws.send(JSON.stringify(value)); };
        function sendHeartbeat() {
          if (pingStarted !== null) return;
          pingStarted = performance.now();
          send(venue === 'entropy' ? { method: 'ping' } : venue === 'lighter'
            ? { type: 'ping' } : { method: 'LIST_SUBSCRIPTIONS', id: 9001 });
        }
        function finish(reason, fatal) {
          if (finished) return;
          finished = true;
          clearTimeout(connectTimer);
          clearInterval(heartbeat);
          clearInterval(watchdog);
          combined.removeEventListener('abort', abort);
          try { decoder.invalidate(venue, null, reason); } catch (error) { fatal ||= error; }
          if (ws) { sockets.delete(ws); try { ws.close(); } catch (error) { fatal ||= error; } }
          if (fatal) reject(fatal); else resolve();
        }
        const guard = action => { try { action(); } catch (error) { finish('callback_or_socket_failure', error); } };
        const abort = () => finish('stopped');
        combined.addEventListener('abort', abort, { once: true });
        let url = venue === 'entropy' ? 'wss://api.hyperliquid.xyz/ws'
          : venue === 'lighter' ? 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true'
            : `wss://fstream.binance.com/public/stream?streams=${venueMarkets.map(m => `${m.nativeSymbol.toLowerCase()}@depth20@100ms`).join('/')}`;
        try { ws = new WebSocketImpl(url); sockets.add(ws); }
        catch { finish('connection_failed'); return; }
        connectTimer = setTimeout(() => finish('connect_timeout'), settings.connectMs);
        ws.onopen = () => guard(() => {
          if (finished) return;
          ready = true;
          connectedAt = performance.now();
          clearTimeout(connectTimer);
          diagnostic(onDiagnostic, { level: 'info', event: 'connected', venue, message: 'Public market-data socket connected.' });
          for (const market of venueMarkets) {
            if (venue === 'entropy') {
              send({ method: 'subscribe', subscription: { type: 'l2Book', coin: market.nativeSymbol, fast: true } });
              send({ method: 'subscribe', subscription: { type: 'trades', coin: market.nativeSymbol } });
              send({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: market.nativeSymbol } });
            } else if (venue === 'lighter') {
              send({ type: 'subscribe', channel: `order_book/${market.marketId}` });
              send({ type: 'subscribe', channel: `trade/${market.marketId}` });
              send({ type: 'subscribe', channel: `market_stats/${market.marketId}` });
            }
          }
          sendHeartbeat();
          heartbeat = setInterval(() => guard(sendHeartbeat), settings.heartbeatMs);
          watchdog = setInterval(() => guard(() => {
            const now = performance.now();
            const stale = venueMarkets.find(m => now - (decoder.states.get(`${venue}:${m.symbol}`)?.receivedMono ?? connectedAt) > settings.staleMs);
            if (stale) finish('stale_watchdog');
          }), settings.watchdogMs);
        });
        ws.onmessage = event => guard(() => {
          if (finished || !ready) return;
          const raw = typeof event.data === 'string' ? event.data : '';
          if (!raw || raw.length > 8_000_000) { finish('message_limit'); return; }
          const clocks = { receivedAt: Date.now(), receivedMono: performance.now() };
          decoder.handle(venue, raw, clocks);
          let control;
          try { control = JSON.parse(raw); } catch { return; }
          const pong = venue === 'entropy' ? control.channel === 'pong'
            : venue === 'lighter' ? control.type === 'pong' : control.id === 9001 && Array.isArray(control.result);
          if (pong && pingStarted !== null) {
            diagnostic(onDiagnostic, { level: 'info', event: 'ws_rtt', venue,
              message: 'Public socket round-trip only; not order acknowledgement or fill latency.',
              details: { rttMs: clocks.receivedMono - pingStarted,
                measurement: venue === 'binance' ? 'list_subscriptions_response' : 'application_ping_pong', notOrderLatency: true } });
            pingStarted = null;
          }
        });
        ws.onerror = () => finish('socket_error');
        ws.onclose = () => finish('disconnected');
      });
      if (combined.aborted) break;
      failures = performance.now() - openedAt > 60_000 ? 1 : failures + 1;
      const waitMs = failures >= settings.maxAttempts ? settings.cooldownMs
        : Math.min(settings.cooldownMs, settings.retryBaseMs * 2 ** (failures - 1));
      diagnostic(onDiagnostic, { level: 'warn', event: 'reconnect_wait', venue,
        message: 'Retrying public socket after bounded backoff.', details: { attempt: failures, waitMs } });
      if (failures >= settings.maxAttempts) failures = 0;
      try { await delay(waitMs, undefined, { signal: combined }); } catch { break; }
    }
  });
  const done = Promise.all(tasks).then(() => undefined).catch(error => { controller.abort(); throw error; });
  return { done, async stop() { controller.abort(); for (const ws of sockets) ws.close(); await done; } };
}
