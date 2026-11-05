import { randomUUID } from 'node:crypto';
import { cashUnits, createCostExecution, decimalOf, feeUnits, numberOf, units, validCostSequence } from './binance-lighter-execution.mjs';
import { applyInventoryFill, createInventoryLedger, inventoryUnrealized } from './binance-lighter-ledger.mjs';

export const DEFAULT_COST_CONFIG = Object.freeze({
  schema: 2, symbols: Object.freeze(['BTC']), latencyScenarios: Object.freeze([300, 600, 1000]),
  orderNotional: 1000, maxInventoryNotional: 5000, maxUnhedgedNotional: 2000, hedgeThresholdNotional: 1000,
  quoteOffsetBps: 0, inventorySkewBps: 2, quoteRefreshMs: 1000, quoteMaxAgeMs: 15000,
  hedgeWaitMs: 2000, maxBookAgeMs: 1000, maxSourceAgeMs: 2000, maxPairSkewMs: 750,
  maxHedgeSlippageBps: 5, queueMultiplier: 1, binanceMakerFeeBps: 0, lighterTakerFeeBps: 0,
  fundingCostBpsPerHour: null,
});
const SCALE = 10n ** 18n;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const venues = ['binance', 'lighter'];
const sides = ['buy', 'sell'];
const keyOf = (venue, symbol) => `${venue}:${symbol}`;
const channelKey = (venue, channel, symbol) => `${venue}:${channel}:${symbol}`;
const requiredChannels = venue => venue === 'binance' ? ['book', 'trades'] : ['book'];
const sign = side => side === 'buy' ? 1n : -1n;
const abs = n => n < 0n ? -n : n;
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const clamp = (n, low, high) => max(low, min(n, high));
const METADATA_TTL_MS = 20 * 60000, SOURCE_CLOCK_TOLERANCE_MS = 250;
const MAX_HEDGE_ATTEMPTS = 3, HEDGE_RETRY_MS = 1000;
const boundedPush = (list, value, limit) => { list.push(value); if (list.length > limit) list.shift(); };
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const roundDown = (quantity, step) => quantity / step * step;
const costRatio = (cost, turnover) => turnover ? numberOf(cost * 10000n * SCALE / turnover) : null;
const ruleVersion = market => JSON.stringify(Object.fromEntries(Object.entries(market).filter(([key]) => key !== 'observedAt').sort(([a], [b]) => a.localeCompare(b))));
const positiveDecimal = value => { try { return positive(Number(value)) && units(value) > 0n; } catch { return false; } };
const midUnits = book => (units(book.bids[0][0]) + units(book.asks[0][0])) / 2n;

export function validateCostConfig(value) {
  const fail = field => { throw new TypeError(`invalid_cost_config:${field}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(DEFAULT_COST_CONFIG).length
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_COST_CONFIG, key))) fail('fields');
  if (value.schema !== 2) fail('schema');
  if (!Array.isArray(value.symbols) || value.symbols.length !== 1 || value.symbols[0] !== 'BTC') fail('symbols');
  if (!Array.isArray(value.latencyScenarios) || !value.latencyScenarios.length || value.latencyScenarios.length > 3
    || new Set(value.latencyScenarios).size !== value.latencyScenarios.length
    || value.latencyScenarios.some(ms => !Number.isInteger(ms) || ms < 300 || ms > 10000)) fail('latencyScenarios');
  for (const [name, low, high, integer] of [
    ['orderNotional', 10, 100000], ['maxInventoryNotional', 10, 1000000], ['maxUnhedgedNotional', 10, 1000000], ['hedgeThresholdNotional', 0, 1000000],
    ['quoteOffsetBps', 0, 100], ['inventorySkewBps', 0, 100], ['quoteRefreshMs', 1000, 60000, true], ['quoteMaxAgeMs', 1000, 120000, true],
    ['hedgeWaitMs', 100, 10000, true], ['maxBookAgeMs', 100, 5000, true], ['maxSourceAgeMs', 100, 10000, true],
    ['maxPairSkewMs', 0, 5000, true], ['maxHedgeSlippageBps', 0, 100], ['queueMultiplier', 1, 10],
    ['binanceMakerFeeBps', 0, 100], ['lighterTakerFeeBps', 0, 100],
  ]) if (!finite(value[name]) || value[name] < low || value[name] > high || integer && !Number.isInteger(value[name])) fail(name);
  if (value.maxInventoryNotional < value.orderNotional) fail('maxInventoryNotional');
  if (value.hedgeThresholdNotional > value.maxUnhedgedNotional) fail('hedgeThresholdNotional');
  try {
    if (value.hedgeThresholdNotional > 0 && units(value.hedgeThresholdNotional) === 0n) fail('hedgeThresholdNotional');
  } catch { fail('hedgeThresholdNotional'); }
  if (value.quoteMaxAgeMs < value.quoteRefreshMs) fail('quoteMaxAgeMs');
  if (value.fundingCostBpsPerHour !== null && (!finite(value.fundingCostBpsPerHour) || Math.abs(value.fundingCostBpsPerHour) > 100)) fail('fundingCostBpsPerHour');
  return structuredClone(value);
}

function validMarket(market, now) {
  return market && venues.includes(market.venue) && ['BTC', 'ETH'].includes(market.symbol)
    && market.nativeSymbol === (market.venue === 'binance' ? `${market.symbol}USDC` : market.symbol)
    && market.quote === 'USDC' && market.settlement === 'USDC' && market.priceUnit === (market.venue === 'binance' ? 'USDC' : 'USD')
    && market.status === 'active' && Number(market.multiplier) === 1
    && (market.venue !== 'lighter' || Number.isSafeInteger(market.marketId) && market.marketId >= 0)
    && [market.tickSize, market.quantityStep, market.minQuantity].every(positiveDecimal)
    && finite(Number(market.minNotional)) && Number(market.minNotional) >= 0 && finite(market.observedAt)
    && now >= market.observedAt && now - market.observedAt <= METADATA_TTL_MS;
}
function freshBook(book, config, now, mono) {
  if (!book || !finite(book.receivedMono) || mono < book.receivedMono || mono - book.receivedMono > config.maxBookAgeMs
    || !finite(book.receivedAt) || now < book.receivedAt || now - book.receivedAt > config.maxBookAgeMs
    || !finite(book.sourceAt) || book.sourceAt - now > SOURCE_CLOCK_TOLERANCE_MS || now - book.sourceAt > config.maxSourceAgeMs) return false;
  for (const side of ['bids', 'asks']) {
    if (!Array.isArray(book[side]) || !book[side].length || book[side].length > 1000) return false;
    let previous = side === 'bids' ? Infinity : 0;
    for (const row of book[side]) {
      if (!Array.isArray(row) || row.length !== 2 || !row.every(positive) || (side === 'bids' ? row[0] >= previous : row[0] <= previous)) return false;
      previous = row[0];
    }
  }
  return book.bids[0][0] < book.asks[0][0];
}

export class CostLabEngine {
  constructor(config = DEFAULT_COST_CONFIG, { now = Date.now, mono = () => performance.now(), sessionId = randomUUID(), emit = () => {} } = {}) {
    this.config = validateCostConfig(config); this.now = now; this.mono = mono; this.emit = emit;
    this.sessionId = sessionId; this.startedAt = now(); this.stopped = false; this.interrupted = false;
    this.markets = new Map(); this.books = new Map(); this.invalid = new Map(); this.channelHealth = new Map(); this.tradeSequences = new Map();
    this.execution = createCostExecution(); this.serial = 0;
    this.scenarios = this.config.symbols.flatMap(symbol => this.config.latencyScenarios.map(latencyMs => ({
      id: `${symbol}-inventory-${latencyMs}`, symbol, latencyMs, status: 'waiting', reason: 'waiting_market_data',
      ledgers: { binance: createInventoryLedger(), lighter: createInventoryLedger() }, quotes: { buy: null, sell: null }, hedge: null,
      rules: null, lastRefreshMono: -Infinity, hedgeAttempts: 0, nextHedgeMono: 0,
      fundingIntegral: 0n, fundingMono: this.mono(), recentFills: [], history: [], events: [], historyMono: -Infinity,
      stats: { quoteUpdates: 0, makerFills: 0, hedgeFills: 0, hedgeFailures: 0 },
      totals: { binanceTurnover: 0n, lighterTurnover: 0n, fees: 0n },
    })));
  }
  event(type, scenario, reason = null) {
    if (scenario) boundedPush(scenario.events, { at: this.now(), type, reason }, 30);
    this.emit({ type, sessionId: this.sessionId, scenarioId: scenario?.id ?? null, at: this.now() });
  }
  setMarkets(markets) {
    if (this.stopped) return;
    const next = new Map();
    for (const market of Array.isArray(markets) ? markets : []) {
      if (venues.includes(market?.venue) && this.config.symbols.includes(market.symbol)) next.set(keyOf(market.venue, market.symbol), structuredClone(market));
    }
    for (const scenario of this.scenarios) {
      if (!scenario.rules || scenario.status === 'blocked') continue;
      if (venues.some(venue => {
        const market = next.get(keyOf(venue, scenario.symbol));
        return market && ruleVersion(market) !== scenario.rules[venue];
      })) this.block(scenario, 'market_rules_changed');
    }
    this.markets = next; this.event('markets'); this.tick();
  }
  bookQuality(venue, symbol, wall = this.now(), mono = this.mono()) {
    const market = this.markets.get(keyOf(venue, symbol)), book = this.books.get(keyOf(venue, symbol));
    if (!validMarket(market, wall)) return 'market_metadata_unavailable';
    if (this.invalid.has(channelKey(venue, 'book', symbol)) || !freshBook(book, this.config, wall, mono)
      || book.nativeSymbol !== market.nativeSymbol) return 'book_unavailable';
    return null;
  }
  pairQuality(symbol, wall = this.now(), mono = this.mono()) {
    for (const venue of venues) { const failure = this.bookQuality(venue, symbol, wall, mono); if (failure) return failure; }
    const binance = this.books.get(keyOf('binance', symbol)), lighter = this.books.get(keyOf('lighter', symbol));
    return Math.abs(binance.receivedMono - lighter.receivedMono) > this.config.maxPairSkewMs
      || Math.abs(binance.sourceAt - lighter.sourceAt) > this.config.maxPairSkewMs ? 'book_pair_skew' : null;
  }
  quality(symbol) {
    const failure = this.pairQuality(symbol); if (failure) return failure;
    const trades = channelKey('binance', 'trades', symbol);
    return this.invalid.has(trades) || this.channelHealth.get(trades) !== 'live' ? 'trade_channel_unavailable' : null;
  }
  onBook(book) {
    if (this.stopped || !venues.includes(book?.venue) || !this.config.symbols.includes(book.symbol)) return;
    const key = keyOf(book.venue, book.symbol), old = this.books.get(key), channel = channelKey(book.venue, 'book', book.symbol);
    if (!validCostSequence(book.sequence) || !freshBook(book, this.config, this.now(), this.mono())) {
      this.invalidate({ venue: book.venue, symbol: book.symbol, channel: 'book', reason: 'invalid_book' }); return;
    }
    if (old && (book.sourceAt < old.sourceAt || book.receivedMono < old.receivedMono || book.receivedAt < old.receivedAt)) {
      this.invalidate({ venue: book.venue, symbol: book.symbol, channel: 'book', reason: 'book_time_regression' }); return;
    }
    // Healthy streams order frames by sequence: source and receive clocks may
    // legitimately repeat. A reconnect must prove new source/monotonic evidence
    // before it can reset the sequence and recover the channel.
    if (old && (this.invalid.has(channel)
      ? book.sourceAt <= old.sourceAt || book.receivedMono <= old.receivedMono
      : BigInt(book.sequence) <= BigInt(old.sequence))) return;
    this.books.set(key, structuredClone(book)); this.invalid.delete(channel); this.channelHealth.set(channel, 'live');
    if (book.venue === 'lighter') for (const scenario of this.scenarios) {
      if (scenario.symbol === book.symbol && scenario.status !== 'blocked') this.fillHedge(scenario, book);
    }
    this.tick();
  }
  onTrade(trade) {
    if (this.stopped || trade?.venue !== 'binance' || !this.config.symbols.includes(trade.symbol)) return;
    const invalid = reason => this.invalidate({ venue: 'binance', channel: 'trades', symbol: trade.symbol, reason });
    if (!validCostSequence(trade.sequence)) { invalid('invalid_trade_sequence'); return; }
    if (!positive(trade.price) || !finite(trade.quantity) || trade.quantity < 0 || typeof trade.buyerMaker !== 'boolean') { invalid('invalid_trade'); return; }
    const last = this.tradeSequences.get(trade.symbol);
    if (last !== undefined && BigInt(trade.sequence) <= BigInt(last)) return;
    const wall = this.now(), mono = this.mono();
    if (!finite(trade.sourceAt) || !finite(trade.receivedAt) || !finite(trade.receivedMono)
      || trade.sourceAt - wall > SOURCE_CLOCK_TOLERANCE_MS || wall - trade.sourceAt > this.config.maxSourceAgeMs
      || trade.receivedAt > wall || wall - trade.receivedAt > this.config.maxBookAgeMs
      || trade.receivedMono > mono || mono - trade.receivedMono > this.config.maxBookAgeMs) { invalid('invalid_trade_time'); return; }
    this.tradeSequences.set(trade.symbol, trade.sequence);
    const channel = channelKey('binance', 'trades', trade.symbol);
    this.invalid.delete(channel); this.channelHealth.set(channel, 'live');
    // Execute old orders first. Neither startup nor an elapsed refresh interval
    // can create an order that retrospectively consumes this same trade.
    for (const scenario of this.scenarios) {
      if (scenario.symbol !== trade.symbol || scenario.status === 'blocked') continue;
      if (this.quality(scenario.symbol)) { this.cancelQuotes(scenario); continue; }
      this.withdrawUnsafe(scenario);
      const side = trade.buyerMaker ? 'buy' : 'sell', quote = scenario.quotes[side];
      if (!quote || trade.quantity === 0) continue; // nq=0 establishes health only.
      const fill = this.execution.observeTrade(quote.id, trade);
      if (!fill) continue;
      this.recordFill(scenario, fill);
      if (!this.execution.queryOrder(quote.id)?.remainingQuantity) this.cancelQuote(scenario, side);
      this.scheduleHedge(scenario);
      this.withdrawUnsafe(scenario);
    }
    this.tick();
  }
  onStatus(status) {
    if (this.stopped || !status || !venues.includes(status.venue) || !requiredChannels(status.venue).includes(status.channel)) return;
    if (status.state !== 'live') this.invalidate(status);
    // A transport notice never restores data freshness or trade-channel evidence.
  }
  invalidate({ venue, channel, symbol, reason = 'feed_unavailable' }) {
    if (this.stopped || !venues.includes(venue)) return;
    const affected = channel ? requiredChannels(venue).filter(value => value === channel) : requiredChannels(venue);
    if (!affected.length) return;
    for (const s of this.config.symbols.filter(value => !symbol || symbol === value)) {
      for (const name of affected) {
        const key = channelKey(venue, name, s); this.invalid.set(key, reason); this.channelHealth.set(key, 'unavailable');
      }
      for (const scenario of this.scenarios.filter(item => item.symbol === s && item.status !== 'blocked')) {
        this.cancelQuotes(scenario); this.setStatus(scenario, scenario.rules ? 'recovering' : 'waiting', `${channel || 'feed'}:${reason}`);
      }
    }
    this.event('invalidated'); this.tick();
  }
  commonStep(symbol) {
    const steps = venues.map(venue => units(this.markets.get(keyOf(venue, symbol)).quantityStep));
    return steps[0] / gcd(steps[0], steps[1]) * steps[1];
  }
  acceptable(symbol, quantity, price, venue) {
    const market = this.markets.get(keyOf(venue, symbol));
    return quantity > 0n && quantity >= units(market.minQuantity) && cashUnits(quantity, price) >= units(market.minNotional)
      && quantity % units(market.quantityStep) === 0n;
  }
  residual(scenario) { return scenario.ledgers.binance.quantity + scenario.ledgers.lighter.quantity; }
  residualNotional(scenario, wall = this.now(), mono = this.mono()) {
    if (this.bookQuality('lighter', scenario.symbol, wall, mono)) return null;
    return abs(this.residual(scenario)) * midUnits(this.books.get(keyOf('lighter', scenario.symbol))) / SCALE;
  }
  projected(scenario) { return this.residual(scenario) + (scenario.hedge ? sign(scenario.hedge.side) * scenario.hedge.quantity : 0n); }
  quoteCapacity(scenario, side, price) {
    const book = this.books.get(keyOf('binance', scenario.symbol));
    const reference = max(midUnits(book), units(price));
    const inventoryLimit = units(this.config.maxInventoryNotional) * SCALE / reference;
    const deltaLimit = units(this.config.maxUnhedgedNotional) * SCALE / reference;
    const direction = sign(side);
    return max(0n, min(inventoryLimit - direction * scenario.ledgers.binance.quantity,
      min(deltaLimit - direction * this.residual(scenario), deltaLimit - direction * this.projected(scenario))));
  }
  quoteTarget(scenario, side) {
    const book = this.books.get(keyOf('binance', scenario.symbol)), market = this.markets.get(keyOf('binance', scenario.symbol));
    const tick = units(market.tickSize), bid = units(book.bids[0][0]), ask = units(book.asks[0][0]), mid = midUnits(book);
    if (bid % tick || ask % tick) return null;
    const r = clamp(scenario.ledgers.binance.quantity * mid / units(this.config.maxInventoryNotional), -SCALE, SCALE);
    const skew = mid * units(this.config.inventorySkewBps) / (10000n * SCALE) * r / SCALE;
    const top = side === 'buy' ? bid : ask;
    const offset = top * units(this.config.quoteOffsetBps) / (10000n * SCALE);
    let price = top - sign(side) * offset - skew;
    price = side === 'buy' ? roundDown(max(tick, price), tick) : (max(tick, price) + tick - 1n) / tick * tick;
    price = side === 'buy' ? min(price, ask - tick) : max(price, bid + tick);
    let queue = 0n;
    if (!(price > bid && price < ask)) {
      const rows = book[side === 'buy' ? 'bids' : 'asks'].filter(row => units(row[0]) % tick === 0n);
      if (!rows.length) return null;
      // Snap to a visible level; beyond the finite depth there is no evidence for
      // a zero queue. Clamping keeps extreme inventory skew observable.
      const level = rows.find(row => side === 'buy' ? units(row[0]) <= price : units(row[0]) >= price) ?? rows.at(-1);
      price = units(level[0]); queue = units(level[1]) * units(this.config.queueMultiplier) / SCALE;
    }
    if (price <= 0n || (side === 'buy' ? price >= ask : price <= bid)) return null;
    const target = units(this.config.orderNotional) * (SCALE - sign(side) * r) / price;
    const quantity = roundDown(min(target, this.quoteCapacity(scenario, side, decimalOf(price))), this.commonStep(scenario.symbol));
    return this.acceptable(scenario.symbol, quantity, decimalOf(price), 'binance') ? { price: numberOf(price), quantity, queue } : null;
  }
  cancelQuote(scenario, side) {
    const quote = scenario.quotes[side]; if (!quote) return;
    this.execution.cancelOrder(quote.id); this.execution.forgetOrder(quote.id); scenario.quotes[side] = null;
  }
  cancelQuotes(scenario) { for (const side of sides) this.cancelQuote(scenario, side); }
  withdrawUnsafe(scenario) {
    const book = this.books.get(keyOf('binance', scenario.symbol)); if (!book) return;
    for (const side of sides) {
      const quote = scenario.quotes[side]; if (!quote) continue;
      const order = this.execution.orders.get(quote.id);
      if (!order || this.mono() - quote.submittedMono >= this.config.quoteMaxAgeMs
        || order.remaining > this.quoteCapacity(scenario, side, quote.price)
        || (side === 'buy' ? quote.price >= book.asks[0][0] : quote.price <= book.bids[0][0])) this.cancelQuote(scenario, side);
    }
  }
  refreshQuotes(scenario) {
    this.withdrawUnsafe(scenario);
    if (this.mono() - scenario.lastRefreshMono < this.config.quoteRefreshMs) return;
    scenario.lastRefreshMono = this.mono();
    scenario.rules ??= Object.fromEntries(venues.map(venue => [venue, ruleVersion(this.markets.get(keyOf(venue, scenario.symbol)))]));
    for (const side of sides) {
      const target = this.quoteTarget(scenario, side), old = scenario.quotes[side];
      const order = old && this.execution.orders.get(old.id);
      if (target && old && old.price === target.price && order?.remaining === target.quantity
        && this.mono() - old.submittedMono < this.config.quoteMaxAgeMs) continue;
      this.cancelQuote(scenario, side);
      if (!target) continue;
      const book = this.books.get(keyOf('binance', scenario.symbol));
      const id = `${this.sessionId}:${scenario.id}:quote:${++this.serial}`;
      this.execution.submitOrder({ version: 2, clientOrderId: id, venue: 'binance', symbol: scenario.symbol,
        side, phase: 'quote', type: 'limit_maker', quantity: decimalOf(target.quantity), limitPrice: target.price,
        queueAhead: decimalOf(target.queue), submittedAt: this.now(), submittedMono: this.mono(), sourceAfter: Math.max(book.sourceAt, this.now()) });
      scenario.quotes[side] = { id, side, price: target.price, quantity: target.quantity, submittedAt: this.now(), submittedMono: this.mono() };
      scenario.stats.quoteUpdates++; this.event('quote_submitted', scenario);
    }
  }
  accrueFunding(scenario) {
    const elapsed = units(Math.max(0, this.mono() - scenario.fundingMono));
    scenario.fundingIntegral += scenario.ledgers.binance.cost * elapsed / SCALE; scenario.fundingMono = this.mono();
  }
  recordFill(scenario, fill) {
    this.accrueFunding(scenario);
    const fee = feeUnits(fill.cashUnits, fill.venue === 'binance' ? this.config.binanceMakerFeeBps : this.config.lighterTakerFeeBps);
    applyInventoryFill(scenario.ledgers[fill.venue], fill.side, fill.quantityUnits, fill.cashUnits);
    scenario.totals[`${fill.venue}Turnover`] += fill.cashUnits; scenario.totals.fees += fee;
    scenario.stats[fill.venue === 'binance' ? 'makerFills' : 'hedgeFills']++;
    const { quantityUnits: ignoredQuantity, cashUnits: ignoredCash, ...publicFill } = fill;
    boundedPush(scenario.recentFills, { ...publicFill, fee: numberOf(fee) }, 200); this.event('fill', scenario);
  }
  hedgeFailure(scenario, reason) {
    scenario.stats.hedgeFailures++; this.event('hedge_failed', scenario, reason);
    scenario.nextHedgeMono = this.mono() + HEDGE_RETRY_MS;
  }
  scheduleHedge(scenario) {
    if (scenario.status === 'blocked' || scenario.hedge) return;
    const residual = this.residual(scenario);
    if (!residual) { scenario.hedgeAttempts = 0; scenario.nextHedgeMono = 0; return; }
    const notional = this.residualNotional(scenario), threshold = units(this.config.hedgeThresholdNotional);
    // Unknown valuation cannot prove a small exposure or retire its retry budget.
    // A zero threshold retains the earlier immediate-hedge recovery behavior.
    if (threshold > 0n && notional === null) return;
    if (notional !== null && notional < threshold) {
      scenario.hedgeAttempts = 0; scenario.nextHedgeMono = 0; return;
    }
    // Judge the remaining demand before exhausting retries: the third partial
    // IOC may already have brought the account below its configured threshold.
    if (scenario.hedgeAttempts >= MAX_HEDGE_ATTEMPTS) { this.block(scenario, 'hedge_retries_exhausted'); return; }
    if (this.mono() < scenario.nextHedgeMono) return;
    if (this.bookQuality('lighter', scenario.symbol)) {
      scenario.hedgeAttempts++; this.hedgeFailure(scenario, 'hedge_book_unavailable'); return;
    }
    const book = this.books.get(keyOf('lighter', scenario.symbol)), market = this.markets.get(keyOf('lighter', scenario.symbol));
    const side = residual > 0n ? 'sell' : 'buy', reference = book[side === 'buy' ? 'asks' : 'bids'][0][0];
    const quantity = roundDown(abs(residual), units(market.quantityStep));
    // Dust stays in the account; later quotes may make it executable. It is still
    // included in both current and projected delta reservations.
    if (!this.acceptable(scenario.symbol, quantity, reference, 'lighter')) return;
    const tick = units(market.tickSize), price = units(reference);
    const adjustment = price * units(this.config.maxHedgeSlippageBps) / (10000n * SCALE);
    const limit = numberOf(side === 'buy' ? roundDown(price + adjustment, tick) : (price - adjustment + tick - 1n) / tick * tick);
    if (!positive(limit) || !this.acceptable(scenario.symbol, quantity, limit, 'lighter')) return;
    const id = `${this.sessionId}:${scenario.id}:hedge:${++this.serial}`, dueMono = this.mono() + scenario.latencyMs;
    scenario.hedgeAttempts++;
    this.execution.submitOrder({ version: 2, clientOrderId: id, venue: 'lighter', symbol: scenario.symbol,
      side, phase: 'hedge', type: 'ioc', quantity: decimalOf(quantity), limitPrice: limit, quantityStep: market.quantityStep,
      submittedAt: this.now(), submittedMono: this.mono(), sourceAfter: book.sourceAt });
    scenario.hedge = { id, side, quantity, dueMono, dueAt: this.now() + scenario.latencyMs,
      deadlineMono: dueMono + this.config.hedgeWaitMs, sourceAfter: book.sourceAt, attempt: scenario.hedgeAttempts };
    this.event('hedge_scheduled', scenario);
  }
  finishHedge(scenario) {
    if (!scenario.hedge) return;
    this.execution.cancelOrder(scenario.hedge.id); this.execution.forgetOrder(scenario.hedge.id); scenario.hedge = null;
  }
  fillHedge(scenario, book) {
    const hedge = scenario.hedge;
    if (!hedge || this.bookQuality('lighter', scenario.symbol)) return;
    if (this.mono() > hedge.deadlineMono) { this.finishHedge(scenario); this.hedgeFailure(scenario, 'hedge_timeout'); return; }
    if (book.receivedMono <= hedge.dueMono || book.receivedAt <= hedge.dueAt || book.sourceAt <= hedge.sourceAfter
      || book.sourceAt < hedge.dueAt - SOURCE_CLOCK_TOLERANCE_MS) return;
    const result = this.execution.executeTaker(hedge.id, book); if (!result) return;
    if (result.fill) this.recordFill(scenario, result.fill);
    this.finishHedge(scenario);
    if (result.remainingQuantity > 0) this.hedgeFailure(scenario, 'hedge_ioc_partial_or_slippage');
    else { scenario.hedgeAttempts = 0; scenario.nextHedgeMono = 0; }
    // Recompute the remainder only after this immutable IOC becomes terminal.
    this.scheduleHedge(scenario);
  }
  setStatus(scenario, status, reason = null) {
    if (scenario.status === status && scenario.reason === reason) return;
    scenario.status = status; scenario.reason = reason; this.event(status, scenario, reason);
  }
  block(scenario, reason) {
    this.cancelQuotes(scenario); this.finishHedge(scenario); this.setStatus(scenario, 'blocked', reason);
  }
  valuation(scenario, wall, mono) {
    const reason = this.pairQuality(scenario.symbol, wall, mono);
    const binance = this.books.get(keyOf('binance', scenario.symbol)), lighter = this.books.get(keyOf('lighter', scenario.symbol));
    return { at: reason ? null : Math.min(binance.sourceAt, lighter.sourceAt, binance.receivedAt, lighter.receivedAt),
      valid: !reason, reason, binanceMark: reason ? null : numberOf(midUnits(binance)), lighterMark: reason ? null : numberOf(midUnits(lighter)) };
  }
  statistics(scenario, valuation, mono) {
    const { totals, ledgers } = scenario;
    const realized = ledgers.binance.realized + ledgers.lighter.realized;
    const unrealized = valuation.valid ? venues.reduce((sum, venue) => sum
      + inventoryUnrealized(ledgers[venue], decimalOf(midUnits(this.books.get(keyOf(venue, scenario.symbol))))), 0n) : null;
    const net = unrealized === null ? null : realized + unrealized - totals.fees;
    const integral = scenario.fundingIntegral + ledgers.binance.cost * units(Math.max(0, mono - scenario.fundingMono)) / SCALE;
    const funding = this.config.fundingCostBpsPerHour === null ? null : integral * units(this.config.fundingCostBpsPerHour) / (3600000n * 10000n * SCALE);
    return { ...scenario.stats, binanceTurnover: numberOf(totals.binanceTurnover), lighterTurnover: numberOf(totals.lighterTurnover),
      fees: numberOf(totals.fees), realizedPnl: numberOf(realized), unrealizedPnl: unrealized === null ? null : numberOf(unrealized),
      netPnl: net === null ? null : numberOf(net), markedCost: net === null ? null : numberOf(-net),
      costPer10000: net === null ? null : costRatio(-net, totals.binanceTurnover), fundingScenarioCost: funding === null ? null : numberOf(funding),
      modeledCostPer10000: net === null || funding === null ? null : costRatio(-net + funding, totals.binanceTurnover) };
  }
  tick() {
    if (this.stopped) return;
    for (const scenario of this.scenarios) {
      if (scenario.status !== 'blocked') {
        if (scenario.hedge && this.mono() > scenario.hedge.deadlineMono) {
          this.finishHedge(scenario); this.hedgeFailure(scenario, 'hedge_timeout');
        }
        this.scheduleHedge(scenario); // Progress and retry budgets do not depend on Maker admission.
        if (scenario.status !== 'blocked') {
          const failure = this.quality(scenario.symbol);
          if (failure) { this.cancelQuotes(scenario); this.setStatus(scenario, scenario.rules ? 'recovering' : 'waiting', failure); }
          else {
            this.refreshQuotes(scenario);
            const notional = this.residualNotional(scenario);
            const below = this.residual(scenario) !== 0n && notional !== null && notional < units(this.config.hedgeThresholdNotional);
            this.setStatus(scenario, scenario.hedge || this.residual(scenario) && !below ? 'hedging' : 'quoting',
              !scenario.hedge && below ? 'below_hedge_threshold' : null);
          }
        }
      }
      if (this.mono() - scenario.historyMono >= 1000) {
        const valuation = this.valuation(scenario, this.now(), this.mono()), stats = this.statistics(scenario, valuation, this.mono());
        boundedPush(scenario.history, { at: this.now(), costPer10000: stats.costPer10000, modeledCostPer10000: stats.modeledCostPer10000,
          binanceQuantity: numberOf(scenario.ledgers.binance.quantity), residualQuantity: numberOf(this.residual(scenario)) }, 300);
        scenario.historyMono = this.mono();
      }
    }
  }
  stop(reason = 'stopped') {
    if (this.stopped) return;
    const unfinished = this.scenarios.some(scenario => scenario.status === 'blocked' || scenario.hedge);
    for (const scenario of this.scenarios) {
      this.accrueFunding(scenario); this.cancelQuotes(scenario); this.finishHedge(scenario); this.setStatus(scenario, 'stopped', reason);
    }
    this.stoppedAt = this.now(); this.stoppedMono = this.mono(); this.stopped = true;
    this.interrupted = reason !== 'stopped' || unfinished || this.scenarios.some(scenario => venues.some(venue => scenario.ledgers[venue].quantity !== 0n));
    this.event('stopped');
  }
  report({ summary = false, scenarioId } = {}) {
    const wall = this.stopped ? this.stoppedAt : this.now(), mono = this.stopped ? this.stoppedMono : this.mono();
    return { schema: 2, strategy: 'inventory_quotes', sessionId: this.sessionId, startedAt: this.startedAt, updatedAt: wall, stopped: this.stopped,
      interrupted: this.interrupted, mode: 'paper', detailLevel: summary ? 'summary' : scenarioId === undefined ? 'full' : 'scenario',
      sessionConfig: structuredClone(this.config), markets: structuredClone([...this.markets.values()]),
      books: [...this.books.values()].map(book => ({ venue: book.venue, symbol: book.symbol, nativeSymbol: book.nativeSymbol,
        bid: book.bids[0]?.[0] ?? null, ask: book.asks[0]?.[0] ?? null, sourceAt: book.sourceAt, receivedAt: book.receivedAt,
        ageMs: Math.max(0, mono - book.receivedMono), sourceClockDeltaMs: book.receivedAt - book.sourceAt,
        sourceClockUncertain: book.sourceAt > book.receivedAt, valid: !this.bookQuality(book.venue, book.symbol, wall, mono) })), channels: [], diagnostics: [],
      scenarios: this.scenarios.filter(scenario => scenarioId === undefined || scenario.id === scenarioId).map(scenario => {
        const valuation = this.valuation(scenario, wall, mono), bn = scenario.ledgers.binance, lt = scenario.ledgers.lighter;
        const residualNotional = this.residualNotional(scenario, wall, mono);
        const bnBook = this.books.get(keyOf('binance', scenario.symbol));
        const notional = !this.bookQuality('binance', scenario.symbol, wall, mono) ? bn.quantity * midUnits(bnBook) / SCALE : null;
        return { id: scenario.id, symbol: scenario.symbol, latencyMs: scenario.latencyMs, status: scenario.status, reason: scenario.reason,
          inventory: { binanceQuantity: numberOf(bn.quantity), lighterQuantity: numberOf(lt.quantity), residualQuantity: numberOf(this.residual(scenario)),
            residualNotional: residualNotional === null ? null : numberOf(residualNotional),
            projectedResidualQuantity: numberOf(this.projected(scenario)), binanceAveragePrice: bn.quantity ? numberOf(bn.cost * SCALE / abs(bn.quantity)) : null,
            lighterAveragePrice: lt.quantity ? numberOf(lt.cost * SCALE / abs(lt.quantity)) : null, binanceNotional: notional === null ? null : numberOf(notional),
            utilization: notional === null ? null : numberOf(notional * SCALE / units(this.config.maxInventoryNotional)), limitNotional: this.config.maxInventoryNotional },
          quotes: Object.fromEntries(sides.map(side => {
            const quote = scenario.quotes[side], order = quote && this.execution.queryOrder(quote.id);
            return [side, quote && order ? { id: quote.id, side, price: quote.price, quantity: numberOf(quote.quantity),
              remainingQuantity: order.remainingQuantity, queueAhead: order.queueAhead, submittedAt: quote.submittedAt } : null];
          })), hedge: scenario.hedge ? { id: scenario.hedge.id, side: scenario.hedge.side, quantity: numberOf(scenario.hedge.quantity),
            dueAt: scenario.hedge.dueAt, attempt: scenario.hedge.attempt } : null,
          stats: this.statistics(scenario, valuation, mono), valuation,
          recentFills: summary ? [] : structuredClone(scenario.recentFills), history: summary ? [] : structuredClone(scenario.history), events: summary ? [] : structuredClone(scenario.events) };
      }), assumptions: [
        '真实公开行情上的持续双边库存报价模拟；主动成交队列代理不证明真实 Maker 成交或成交概率。',
        '币种与延迟情景为独立账户，成交额和盈亏不得相加。',
        '盯市成本包含未平库存按各场所新鲜中间价估值，不是已平仓成本或可兑现利润；分母是全部 BN 模拟成交额。',
        '零手续费为本会话的公开优惠假设，账户实际费率、活动资格、有效活动成交额及奖励未核验。',
        'USDC 名义结算；Lighter 原生 USD 参考价不等于美元法币估值。',
        '资金费为独立可选情景：按 abs(BN库存) × 平均成本价 × 持有时间积分；实际资金费未知。',
        '来源时钟允许最多超前本机250毫秒；对冲延迟至少300毫秒，按本机单调接收时间及新来源证据共同核验。',
        '每情景最多一个在途IOC；失败最多尝试3次，重试间隔1000毫秒，耗尽保留库存并阻止报价。',
        '净敞口按Lighter新鲜中间价计算USDC名义额；低于会话阈值不提交新的对冲，达到阈值后对冲完整净数量，已提交IOC保持原参数。',
        '逐笔成交仅保留最近200条、曲线300点、事件30条；累计成交额、费用和盈亏保留完整会话。',
      ] };
  }
}
