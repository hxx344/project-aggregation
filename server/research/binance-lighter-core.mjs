import { randomUUID } from 'node:crypto';
import { cashUnits, createCostExecution, feeUnits, numberOf, units, validCostSequence } from './binance-lighter-execution.mjs';

export const DEFAULT_COST_CONFIG = Object.freeze({
  schema: 1, symbols: Object.freeze(['BTC', 'ETH']), notionalPerLeg: 1000, latencyScenarios: Object.freeze([300, 600, 1000]),
  makerWaitMs: 15000, holdMs: 5000, hedgeWaitMs: 2000, cooldownMs: 3000, maxBookAgeMs: 1000,
  maxSourceAgeMs: 2000, maxPairSkewMs: 750, maxHedgeSlippageBps: 5, queueMultiplier: 1,
  binanceMakerFeeBps: 0, lighterTakerFeeBps: 0, fundingCostBpsPerHour: null,
});
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const venues = ['binance', 'lighter'];
const keyOf = (venue, symbol) => `${venue}:${symbol}`;
const channelKey = (venue, channel, symbol) => `${venue}:${channel}:${symbol}`;
const requiredChannels = venue => venue === 'binance' ? ['book', 'trades'] : ['book'];
const opposite = side => side === 'buy' ? 'sell' : 'buy';
const sign = side => side === 'buy' ? 1n : -1n;
const abs = n => n < 0n ? -n : n;
const METADATA_TTL_MS = 20 * 60000;
const SOURCE_CLOCK_TOLERANCE_MS = 250;
// 12 scenarios * 20 retained rounds * 64 fills stays below the manager's 8 MiB
// report limit. Reaching a bound preserves the current risk instead of truncating.
const MAX_FILLS = 64, MAX_HEDGES = 64;
const boundedPush = (list, value, limit) => { list.push(value); if (list.length > limit) list.shift(); };
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const roundDown = (quantity, step) => quantity / step * step;
const costRatio = (cost, turnover) => turnover ? numberOf(cost * 10000n * 10n ** 18n / turnover) : null;
const ruleVersion = market => JSON.stringify(Object.fromEntries(Object.entries(market).filter(([key]) => key !== 'observedAt').sort(([a], [b]) => a.localeCompare(b))));
const positiveDecimal = value => { try { return positive(Number(value)) && units(value) > 0n; } catch { return false; } };

export function validateCostConfig(value) {
  const fail = field => { throw new TypeError(`invalid_cost_config:${field}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(DEFAULT_COST_CONFIG).length
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_COST_CONFIG, key))) fail('fields');
  if (value.schema !== 1) fail('schema');
  if (!Array.isArray(value.symbols) || !value.symbols.length || value.symbols.length > 2 || new Set(value.symbols).size !== value.symbols.length
    || value.symbols.some(symbol => !['BTC', 'ETH'].includes(symbol))) fail('symbols');
  if (!Array.isArray(value.latencyScenarios) || !value.latencyScenarios.length || value.latencyScenarios.length > 3
    || new Set(value.latencyScenarios).size !== value.latencyScenarios.length
    || value.latencyScenarios.some(ms => !Number.isInteger(ms) || ms < 300 || ms > 10000)) fail('latencyScenarios');
  for (const [name, low, high, integer] of [
    ['notionalPerLeg', 10, 100000], ['makerWaitMs', 1000, 120000, true], ['holdMs', 0, 3600000, true],
    ['hedgeWaitMs', 100, 10000, true], ['cooldownMs', 0, 60000, true], ['maxBookAgeMs', 100, 5000, true],
    ['maxSourceAgeMs', 100, 10000, true], ['maxPairSkewMs', 0, 5000, true], ['maxHedgeSlippageBps', 0, 100],
    ['queueMultiplier', 1, 10], ['binanceMakerFeeBps', 0, 100], ['lighterTakerFeeBps', 0, 100],
  ]) if (!finite(value[name]) || value[name] < low || value[name] > high || integer && !Number.isInteger(value[name])) fail(name);
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
    this.scenarios = this.config.symbols.flatMap(symbol => ['buy', 'sell'].flatMap(direction => this.config.latencyScenarios.map(latencyMs => ({
      id: `${symbol}-${direction}-${latencyMs}`, symbol, direction, latencyMs, status: 'waiting', reason: 'waiting_market_data', task: null,
      nextMono: 0, recentRounds: [], history: [],
      stats: { attempts: 0, completed: 0, unfilled: 0, unresolved: 0, binanceTurnover: 0, closedBinanceTurnover: 0,
        fees: 0, closedFees: 0, tradingPnl: 0, tradingCost: 0, costPer10000: null,
        fundingScenarioCost: config.fundingCostBpsPerHour === null ? null : 0, modeledCostPer10000: null },
      totals: { turnover: 0n, closedTurnover: 0n, fees: 0n, closedFees: 0n, pnl: 0n },
    }))));
  }
  event(type, scenario) { this.emit({ type, sessionId: this.sessionId, scenarioId: scenario?.id ?? null, at: this.now() }); }
  setMarkets(markets) {
    if (this.stopped) return;
    const next = new Map();
    for (const market of Array.isArray(markets) ? markets : []) {
      if (venues.includes(market?.venue) && this.config.symbols.includes(market.symbol)) next.set(keyOf(market.venue, market.symbol), structuredClone(market));
    }
    for (const scenario of this.scenarios) {
      if (!scenario.task || scenario.status === 'unresolved') continue;
      const changed = venues.some(venue => {
        const market = next.get(keyOf(venue, scenario.symbol));
        return !validMarket(market, this.now()) || ruleVersion(market) !== scenario.task.rules[venue];
      });
      if (changed) this.fail(scenario, 'market_rules_changed');
    }
    this.markets = next; this.event('markets'); this.tick();
  }
  quality(symbol) {
    const wall = this.now(), mono = this.mono();
    for (const venue of venues) {
      const key = keyOf(venue, symbol), market = this.markets.get(key), book = this.books.get(key);
      if (!validMarket(market, wall)) return 'market_metadata_unavailable';
      if (this.invalid.has(channelKey(venue, 'book', symbol)) || !freshBook(book, this.config, wall, mono) || book.nativeSymbol !== market.nativeSymbol) return 'book_unavailable';
    }
    const trades = channelKey('binance', 'trades', symbol);
    if (this.invalid.has(trades) || this.channelHealth.get(trades) !== 'live') return 'trade_channel_unavailable';
    const binance = this.books.get(keyOf('binance', symbol)), lighter = this.books.get(keyOf('lighter', symbol));
    if (Math.abs(binance.receivedMono - lighter.receivedMono) > this.config.maxPairSkewMs
      || Math.abs(binance.sourceAt - lighter.sourceAt) > this.config.maxPairSkewMs) return 'book_pair_skew';
    return null;
  }
  onBook(book) {
    if (this.stopped || !venues.includes(book?.venue) || !this.config.symbols.includes(book.symbol)) return;
    const key = keyOf(book.venue, book.symbol), old = this.books.get(key);
    const channel = channelKey(book.venue, 'book', book.symbol);
    if (!validCostSequence(book.sequence) || !freshBook(book, this.config, this.now(), this.mono())) {
      this.invalidate({ venue: book.venue, symbol: book.symbol, channel: 'book', reason: 'invalid_book' }); return;
    }
    if (old && (book.sourceAt < old.sourceAt || book.receivedMono < old.receivedMono)) {
      this.invalidate({ venue: book.venue, symbol: book.symbol, channel: 'book', reason: 'book_time_regression' }); return;
    }
    if (old && !this.invalid.has(channel) && BigInt(book.sequence) <= BigInt(old.sequence)) return;
    this.books.set(key, structuredClone(book)); this.invalid.delete(channel); this.channelHealth.set(channel, 'live');
    // Only this newly received Lighter frame may execute due IOC orders.
    if (book.venue === 'lighter') for (const scenario of this.scenarios) {
      if (scenario.symbol === book.symbol && scenario.task && scenario.status !== 'unresolved') this.fillHedges(scenario, book);
    }
    this.tick();
  }
  onTrade(trade) {
    if (this.stopped || trade?.venue !== 'binance' || !this.config.symbols.includes(trade.symbol)) return;
    if (!validCostSequence(trade.sequence)) {
      this.invalidate({ venue: 'binance', channel: 'trades', symbol: trade.symbol, reason: 'invalid_trade_sequence' }); return;
    }
    if (!positive(trade.price) || !finite(trade.quantity) || trade.quantity < 0 || typeof trade.buyerMaker !== 'boolean') {
      this.invalidate({ venue: 'binance', channel: 'trades', symbol: trade.symbol, reason: 'invalid_trade' }); return;
    }
    const last = this.tradeSequences.get(trade.symbol);
    if (last !== undefined && BigInt(trade.sequence) <= BigInt(last)) return;
    const wall = this.now(), mono = this.mono();
    if (!finite(trade.sourceAt) || !finite(trade.receivedAt) || !finite(trade.receivedMono)
      || trade.sourceAt - wall > SOURCE_CLOCK_TOLERANCE_MS || wall - trade.sourceAt > this.config.maxSourceAgeMs
      || trade.receivedAt > wall || wall - trade.receivedAt > this.config.maxBookAgeMs
      || trade.receivedMono > mono || mono - trade.receivedMono > this.config.maxBookAgeMs) {
      this.invalidate({ venue: 'binance', channel: 'trades', symbol: trade.symbol, reason: 'invalid_trade_time' }); return;
    }
    this.tradeSequences.set(trade.symbol, trade.sequence);
    const channel = channelKey('binance', 'trades', trade.symbol);
    this.invalid.delete(channel); this.channelHealth.set(channel, 'live');
    this.tick();
    // A fresh nq=0 message proves the normal trade stream is readable but
    // contributes no executable quantity to any simulated Maker queue.
    if (trade.quantity === 0) return;
    for (const scenario of this.scenarios) {
      const task = scenario.task;
      if (scenario.symbol !== trade.symbol || !task?.maker || scenario.status === 'unresolved') continue;
      const fill = this.execution.observeTrade(task.maker.id, trade);
      if (!fill) continue;
      this.recordFill(scenario, fill);
      if (scenario.status === 'unresolved') continue;
      if (this.execution.queryOrder(task.maker.id).remainingQuantity === 0) this.finishMaker(scenario);
      this.scheduleHedge(scenario, trade);
      this.advance(scenario);
    }
  }
  onStatus(status) {
    if (this.stopped || !status || !venues.includes(status.venue) || !requiredChannels(status.venue).includes(status.channel)) return;
    if (status.state !== 'live') { this.invalidate(status); return; }
    // Transport liveness is not evidence of usable market data. Only onBook
    // or onTrade may recover its channel after validating source/receive time.
  }
  invalidate({ venue, channel, symbol, reason = 'feed_unavailable' }) {
    if (this.stopped || !venues.includes(venue)) return;
    const affected = channel ? requiredChannels(venue).filter(value => value === channel) : requiredChannels(venue);
    if (!affected.length) return;
    for (const s of this.config.symbols.filter(value => !symbol || symbol === value)) {
      // Each source recovers only with evidence for its own channel. In particular,
      // fresh depth never proves that the independent trade stream has recovered.
      for (const name of affected) {
        const key = channelKey(venue, name, s);
        this.invalid.set(key, reason); this.channelHealth.set(key, 'unavailable');
      }
      for (const scenario of this.scenarios.filter(item => item.symbol === s)) {
        if (scenario.task && scenario.status !== 'unresolved') this.fail(scenario, `${channel || 'feed'}:${reason}`);
        else if (!scenario.task && scenario.status !== 'unresolved') { scenario.status = 'waiting'; scenario.reason = reason; }
      }
    }
    this.event('invalidated');
  }
  commonStep(symbol) {
    const steps = venues.map(venue => units(this.markets.get(keyOf(venue, symbol)).quantityStep));
    return steps[0] / gcd(steps[0], steps[1]) * steps[1];
  }
  placeMaker(scenario, phase, quantity) {
    const task = scenario.task, book = this.books.get(keyOf('binance', scenario.symbol));
    const side = phase === 'entry' ? scenario.direction : opposite(scenario.direction);
    const [price, queue] = book[side === 'buy' ? 'bids' : 'asks'][0];
    const id = `${task.id}:maker:${phase}`;
    this.execution.submitOrder({ version: 1, clientOrderId: id, venue: 'binance', symbol: scenario.symbol,
      side, type: 'limit_maker', phase, quantity: numberOf(quantity), limitPrice: price,
      queueAhead: numberOf(units(queue) * units(this.config.queueMultiplier) / 10n ** 18n), submittedAt: this.now(), submittedMono: this.mono(),
      sourceAfter: Math.max(book.sourceAt, this.now()) });
    task.maker = { id, side, price, deadlineMono: this.mono() + this.config.makerWaitMs };
    task.orders.push(id); task.phase = phase; task.makerDone = false;
    scenario.status = `maker_${phase}`; scenario.reason = null; this.event('maker_submitted', scenario);
  }
  start(scenario) {
    const failure = this.quality(scenario.symbol);
    if (failure) { scenario.status = 'waiting'; scenario.reason = failure; return; }
    const books = venues.map(venue => this.books.get(keyOf(venue, scenario.symbol)));
    const price = books[0][scenario.direction === 'buy' ? 'bids' : 'asks'][0][0];
    const step = this.commonStep(scenario.symbol);
    const quantity = roundDown(units(this.config.notionalPerLeg) * 10n ** 18n / units(price), step);
    if (units(price) % units(this.markets.get(keyOf('binance', scenario.symbol)).tickSize) !== 0n) {
      scenario.status = 'waiting'; scenario.reason = 'invalid_price_tick'; return;
    }
    if (!this.acceptable(scenario.symbol, quantity, price, 'binance')
      || !this.acceptable(scenario.symbol, quantity, books[1][scenario.direction === 'buy' ? 'bids' : 'asks'][0][0], 'lighter')) {
      scenario.status = 'waiting'; scenario.reason = 'below_market_minimum'; return;
    }
    scenario.stats.attempts++;
    scenario.task = { id: `${this.sessionId}:${scenario.id}:${++this.serial}`, startedAt: this.now(), phase: 'entry',
      target: quantity, step, bn: 0n, lt: 0n, opened: 0n, cash: 0n, turnover: 0n, fees: 0n, fills: [], orders: [],
      pendingHedges: [], maker: null, makerDone: false, unhedgedSince: null, fundingIntegral: 0, exposureNotional: 0n,
      fundingMono: this.mono(), rules: Object.fromEntries(venues.map(venue => [venue, ruleVersion(this.markets.get(keyOf(venue, scenario.symbol)))])) };
    this.placeMaker(scenario, 'entry', quantity);
  }
  acceptable(symbol, quantity, price, venue) {
    const market = this.markets.get(keyOf(venue, symbol));
    return quantity > 0n && quantity >= units(market.minQuantity) && cashUnits(quantity, price) >= units(market.minNotional)
      && quantity % units(market.quantityStep) === 0n;
  }
  recordFill(scenario, fill) {
    const task = scenario.task, quantity = fill.quantityUnits, cash = fill.cashUnits;
    const fee = feeUnits(cash, fill.venue === 'binance' ? this.config.binanceMakerFeeBps : this.config.lighterTakerFeeBps);
    task.fundingIntegral += numberOf(task.exposureNotional) * Math.max(0, this.mono() - task.fundingMono);
    task.fundingMono = this.mono();
    if (fill.venue === 'binance') {
      if (fill.phase === 'entry') { task.opened += quantity; task.exposureNotional += cash; }
      else if (task.bn) task.exposureNotional -= task.exposureNotional * quantity / abs(task.bn);
      task.bn += sign(fill.side) * quantity; task.turnover += cash; scenario.totals.turnover += cash;
    } else task.lt += sign(fill.side) * quantity;
    task.cash -= sign(fill.side) * cash; task.fees += fee; scenario.totals.fees += fee;
    const { quantityUnits: ignoredQuantity, cashUnits: ignoredCash, ...publicFill } = fill;
    task.fills.push({ ...publicFill, fee: numberOf(fee) });
    this.syncStats(scenario); this.event('fill', scenario);
    if (task.fills.length >= MAX_FILLS) this.fail(scenario, 'fill_limit');
  }
  finishMaker(scenario) {
    const task = scenario.task;
    if (task.maker) this.execution.cancelOrder(task.maker.id);
    task.maker = null; task.makerDone = true; scenario.status = `hedge_${task.phase}`;
    this.event('maker_finished', scenario);
  }
  scheduleHedge(scenario, trade) {
    const task = scenario.task;
    const reserved = task.pendingHedges.reduce((total, hedge) => total + sign(hedge.side) * hedge.quantity, 0n);
    const imbalance = task.bn + task.lt + reserved;
    const quantity = roundDown(abs(imbalance), task.step);
    if (!imbalance) { task.unhedgedSince = null; return; }
    task.unhedgedSince ??= this.mono();
    const side = imbalance > 0n ? 'sell' : 'buy', book = this.books.get(keyOf('lighter', scenario.symbol));
    const reference = book[side === 'buy' ? 'asks' : 'bids'][0][0];
    if (!this.acceptable(scenario.symbol, quantity, reference, 'lighter')) return;
    if (task.pendingHedges.length >= MAX_HEDGES) { this.fail(scenario, 'pending_hedge_limit'); return; }
    const tick = units(this.markets.get(keyOf('lighter', scenario.symbol)).tickSize);
    const priceUnits = units(reference), adjustment = priceUnits * units(this.config.maxHedgeSlippageBps) / (10000n * 10n ** 18n);
    const limit = numberOf(side === 'buy' ? (priceUnits + adjustment) / tick * tick : (priceUnits - adjustment + tick - 1n) / tick * tick);
    if (!this.acceptable(scenario.symbol, quantity, limit, 'lighter')) return;
    const id = `${task.id}:hedge:${++this.serial}`, dueMono = this.mono() + scenario.latencyMs;
    this.execution.submitOrder({ version: 1, clientOrderId: id, venue: 'lighter', symbol: scenario.symbol,
      side, phase: task.phase, type: 'ioc', quantity: numberOf(quantity), limitPrice: limit,
      quantityStep: Number(this.markets.get(keyOf('lighter', scenario.symbol)).quantityStep),
      submittedAt: this.now(), submittedMono: this.mono(), sourceAfter: book.sourceAt });
    task.orders.push(id);
    task.pendingHedges.push({ id, phase: task.phase, side, quantity, dueMono, dueAt: this.now() + scenario.latencyMs,
      deadlineMono: dueMono + this.config.hedgeWaitMs, sourceAfter: book.sourceAt, reference });
    if (quantity === abs(imbalance)) task.unhedgedSince = null;
    this.event('hedge_scheduled', scenario);
  }
  fillHedges(scenario, book) {
    const task = scenario.task;
    if (this.quality(scenario.symbol)) return;
    const available = structuredClone(book);
    for (const hedge of [...task.pendingHedges]) {
      if (book.receivedMono <= hedge.dueMono || book.receivedAt <= hedge.dueAt || book.sourceAt <= hedge.sourceAfter
        || book.sourceAt < hedge.dueAt - SOURCE_CLOCK_TOLERANCE_MS) continue;
      if (this.mono() > hedge.deadlineMono) { this.fail(scenario, 'hedge_timeout'); return; }
      const result = this.execution.executeTaker(hedge.id, available);
      if (!result) continue;
      if (result.fill) {
        this.recordFill(scenario, result.fill);
        // Independent scenarios may reuse a frame, pending orders within one
        // scenario may not consume the same visible size twice.
        for (const used of result.consumedDepth) {
          const row = available[hedge.side === 'buy' ? 'asks' : 'bids'][used.index];
          row[1] = numberOf(units(row[1]) - units(used.quantity));
        }
      }
      this.execution.forgetOrder(hedge.id);
      task.pendingHedges = task.pendingHedges.filter(item => item !== hedge);
      if (scenario.status === 'unresolved') return;
      if (result.remainingQuantity > 0) { this.fail(scenario, 'hedge_ioc_partial_or_slippage'); return; }
    }
    this.advance(scenario);
  }
  advance(scenario) {
    const task = scenario.task;
    if (!task || scenario.status === 'unresolved' || !task.makerDone || task.pendingHedges.length) return;
    if (task.bn + task.lt !== 0n) { this.fail(scenario, 'unhedgeable_remainder'); return; }
    if (task.phase === 'entry') {
      if (!task.opened) { this.finish(scenario, 'unfilled', 'maker_timeout'); return; }
      task.phase = 'holding'; task.holdUntil = this.mono() + this.config.holdMs;
      scenario.status = 'holding'; this.event('holding', scenario);
    } else if (task.phase === 'exit') {
      if (task.bn !== 0n || task.lt !== 0n) { this.fail(scenario, 'exit_incomplete'); return; }
      this.finish(scenario, 'completed', null);
    }
  }
  fail(scenario, reason) {
    const task = scenario.task;
    if (!task || scenario.status === 'unresolved') return;
    if (!task.fills.length) { this.finish(scenario, 'unfilled', reason); return; }
    if (task.maker) this.execution.cancelOrder(task.maker.id);
    for (const hedge of task.pendingHedges) this.execution.cancelOrder(hedge.id);
    for (const id of task.orders) this.execution.forgetOrder(id);
    task.maker = null; task.phase = 'unresolved'; scenario.status = 'unresolved'; scenario.reason = reason;
    scenario.stats.unresolved++;
    boundedPush(scenario.recentRounds, this.round(scenario, 'unresolved', reason), 20);
    boundedPush(scenario.history, { at: this.now(), costPer10000: null, modeledCostPer10000: null }, 300);
    this.event('unresolved', scenario);
  }
  round(scenario, outcome, reason) {
    const task = scenario.task, complete = outcome === 'completed';
    const pnl = complete ? numberOf(task.cash) : null, cost = complete ? numberOf(task.fees - task.cash) : null;
    const turnover = numberOf(task.turnover);
    const funding = complete && this.config.fundingCostBpsPerHour !== null
      ? task.fundingIntegral / 3600000 * this.config.fundingCostBpsPerHour / 10000 : null;
    return { id: task.id, startedAt: task.startedAt, endedAt: this.now(), outcome, reason, quantity: numberOf(task.opened),
      binanceTurnover: turnover, fees: numberOf(task.fees), tradingPnl: pnl, tradingCost: cost,
      costPer10000: complete ? costRatio(task.fees - task.cash, task.turnover) : null, fundingScenarioCost: funding,
      modeledCostPer10000: complete && funding !== null && turnover > 0 ? (cost + funding) / turnover * 10000 : null,
      fills: structuredClone(task.fills) };
  }
  finish(scenario, outcome, reason) {
    const task = scenario.task, round = this.round(scenario, outcome, reason);
    if (outcome === 'completed') {
      scenario.stats.completed++; scenario.totals.closedTurnover += task.turnover; scenario.totals.closedFees += task.fees;
      scenario.totals.pnl += task.cash;
      if (round.fundingScenarioCost !== null) scenario.stats.fundingScenarioCost += round.fundingScenarioCost;
    } else scenario.stats.unfilled++;
    for (const id of task.orders) { this.execution.cancelOrder(id); this.execution.forgetOrder(id); }
    boundedPush(scenario.recentRounds, round, 20);
    this.syncStats(scenario);
    boundedPush(scenario.history, { at: this.now(), costPer10000: round.costPer10000, modeledCostPer10000: round.modeledCostPer10000 }, 300);
    scenario.task = null; scenario.status = 'cooldown'; scenario.reason = reason;
    scenario.nextMono = this.mono() + this.config.cooldownMs; this.event('round_finished', scenario);
  }
  syncStats(scenario) {
    const { stats, totals } = scenario;
    stats.binanceTurnover = numberOf(totals.turnover); stats.closedBinanceTurnover = numberOf(totals.closedTurnover);
    stats.fees = numberOf(totals.fees); stats.closedFees = numberOf(totals.closedFees); stats.tradingPnl = numberOf(totals.pnl);
    stats.tradingCost = numberOf(totals.closedFees - totals.pnl);
    stats.costPer10000 = costRatio(totals.closedFees - totals.pnl, totals.closedTurnover);
    stats.modeledCostPer10000 = totals.closedTurnover && stats.fundingScenarioCost !== null
      ? (stats.tradingCost + stats.fundingScenarioCost) / stats.closedBinanceTurnover * 10000 : null;
  }
  tick() {
    if (this.stopped) return;
    for (const scenario of this.scenarios) {
      if (scenario.status === 'unresolved') continue;
      if (!scenario.task) { if (this.mono() >= scenario.nextMono) this.start(scenario); continue; }
      const task = scenario.task, failure = this.quality(scenario.symbol);
      if (failure) { this.fail(scenario, failure); continue; }
      if (task.pendingHedges.some(hedge => this.mono() > hedge.deadlineMono)) { this.fail(scenario, 'hedge_timeout'); continue; }
      if (task.unhedgedSince !== null && this.mono() - task.unhedgedSince > scenario.latencyMs + this.config.hedgeWaitMs) {
        this.fail(scenario, 'unhedgeable_remainder'); continue;
      }
      if (task.maker && this.mono() >= task.maker.deadlineMono) {
        if (task.phase === 'exit') { this.fail(scenario, 'exit_maker_timeout'); continue; }
        this.finishMaker(scenario); this.advance(scenario);
      }
      if (scenario.task?.phase === 'holding' && this.mono() >= task.holdUntil) {
        if (!this.acceptable(scenario.symbol, abs(task.bn), this.books.get(keyOf('binance', scenario.symbol))[opposite(scenario.direction) === 'buy' ? 'bids' : 'asks'][0][0], 'binance')) {
          this.fail(scenario, 'exit_below_market_minimum'); continue;
        }
        this.placeMaker(scenario, 'exit', abs(task.bn));
      }
    }
  }
  stop(reason = 'stopped') {
    if (this.stopped) return;
    for (const scenario of this.scenarios) {
      if (scenario.task) this.fail(scenario, reason);
      if (scenario.status !== 'unresolved') { scenario.status = 'stopped'; scenario.reason = reason; }
    }
    this.stoppedAt = this.now(); this.stoppedMono = this.mono();
    this.stopped = true; this.interrupted = reason !== 'stopped' || this.scenarios.some(scenario => scenario.status === 'unresolved');
    this.event('stopped');
  }
  report({ summary = false, scenarioId } = {}) {
    const wall = this.stopped ? this.stoppedAt : this.now(), mono = this.stopped ? this.stoppedMono : this.mono();
    return { schema: 1, sessionId: this.sessionId, startedAt: this.startedAt, updatedAt: wall, stopped: this.stopped,
      interrupted: this.interrupted, mode: 'paper', detailLevel: summary ? 'summary' : scenarioId === undefined ? 'full' : 'scenario',
      sessionConfig: structuredClone(this.config),
      markets: structuredClone([...this.markets.values()]), books: [...this.books.values()].map(book => ({
        venue: book.venue, symbol: book.symbol, nativeSymbol: book.nativeSymbol, bid: book.bids[0]?.[0] ?? null, ask: book.asks[0]?.[0] ?? null,
        sourceAt: book.sourceAt, receivedAt: book.receivedAt, ageMs: Math.max(0, mono - book.receivedMono),
        sourceClockDeltaMs: book.receivedAt - book.sourceAt, sourceClockUncertain: book.sourceAt > book.receivedAt,
        valid: !this.invalid.has(channelKey(book.venue, 'book', book.symbol)) && freshBook(book, this.config, wall, mono)
          && validMarket(this.markets.get(keyOf(book.venue, book.symbol)), wall),
      })), channels: [], diagnostics: {},
      scenarios: this.scenarios.filter(scenario => scenarioId === undefined || scenario.id === scenarioId).map(scenario => {
        const task = scenario.task, order = task?.maker ? this.execution.queryOrder(task.maker.id) : null;
        return { id: scenario.id, symbol: scenario.symbol, direction: scenario.direction, latencyMs: scenario.latencyMs,
          status: scenario.status, reason: scenario.reason,
          task: task ? { id: task.id, startedAt: task.startedAt, phase: task.phase, targetQuantity: numberOf(task.target),
            binanceQuantity: numberOf(task.bn), lighterQuantity: numberOf(task.lt), residualQuantity: numberOf(task.bn + task.lt),
            maker: task.maker ? { side: task.maker.side, price: task.maker.price, remainingQuantity: order.remainingQuantity, queueAhead: order.queueAhead } : null,
            pendingHedges: task.pendingHedges.map(hedge => ({ id: hedge.id, phase: hedge.phase, side: hedge.side, quantity: numberOf(hedge.quantity), dueAt: hedge.dueAt })) } : null,
          stats: structuredClone(scenario.stats), recentRounds: summary ? [] : structuredClone(scenario.recentRounds),
          history: summary ? [] : structuredClone(scenario.history) };
      }), assumptions: [
        '真实公开行情上的模拟；主动成交队列代理不证明真实 Maker 成交或成交概率。',
        '币种、方向与延迟情景互相独立，成交额和盈亏不得相加。',
        '零手续费为本会话的公开优惠假设，账户实际费率、活动资格、有效活动成交额及奖励未核验。',
        'USDC 名义结算；Lighter 原生 USD 参考价不等于美元法币估值。',
        '盘口扫单价已包含滑点与延迟影响；实际资金费未知，资金费情景按 Binance 开仓名义敞口随时间积分。',
        '来源时钟允许最多超前本机250毫秒；对冲延迟始终按本机单调接收时钟，超前不缩短等待。',
        '对冲盘口来源时间还须达到计划延迟时刻减250毫秒的下界，不以迟到旧帧模拟成交。',
      ] };
  }
}
