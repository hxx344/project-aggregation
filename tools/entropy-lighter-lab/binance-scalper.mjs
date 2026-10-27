// Public-data, directional paper research only. No private API or order transport.
const SYMBOLS = ['SNDK', 'ANTH'];
const NATIVE = { SNDK: 'SNDKUSDT', ANTH: 'ANTHROPICUSDT' };
const RATIOS = [1.1, 1.2];
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const positive = (n) => finite(n) && n > 0;
const clone = (value) => structuredClone(value);
const rebates = (fees, net) => RATIOS.map((ratio) => ({ ratio, contingentRebate: fees * ratio, net: net === null ? null : net + fees * ratio }));
const sequence = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  return String(value);
};
const summary = () => ({ signals: 0, completed: 0, failedEntries: 0, unresolved: 0, lossesBeforeRebate: 0,
  turnover: 0, fees: 0, costReserve: 0, settledGrossPnl: 0, settledNetBeforeRebate: 0, minNetBeforeRebate: null });

export class BinanceScalper {
  constructor(config, emit = () => {}, { fresh, market, entropyFee, sweep, suspendedReason = null }) {
    this.config = config;
    this.emit = emit;
    this.dependencies = { fresh, market, entropyFee, sweep };
    this.suspendedReason = suspendedReason;
    this.leaders = new Map();
    this.leaderSequences = new Map();
    this.entropyObservations = new Map();
    this.nextId = 1;
    this.states = new Map(SYMBOLS.map((symbol) => [symbol, new Map(config.simulation.latencyScenarios.map((scenario) => [scenario.name, {
      name: scenario.name, entropyMs: scenario.entropyMs, state: 'waiting', reason: 'waiting_leader', armed: null,
      task: null, cooldownUntil: null, stats: summary(), recentTrades: [], lastEventAt: null,
    }]))]));
  }

  event(state, type, now, wall, extra = {}) {
    state.lastEventAt = wall;
    // Events and reports never expose live task, fee or configuration objects.
    this.emit(clone({ type: `binance_scalp_${type}`, symbol: state.symbol, scenario: state.name, at: wall, mono: now, ...extra }));
  }

  validBook(book, venue, symbol, now, wall, depth = 1) {
    if (!book || book.venue !== venue || book.symbol !== symbol || !positive(book.sourceAt)
      || !finite(book.receivedMono) || now < book.receivedMono || now - book.receivedMono > this.config.maxBookAgeMs
      || !finite(book.receivedAt) || wall < book.receivedAt - 100 || wall - book.receivedAt > this.config.maxBookAgeMs
      || wall < book.sourceAt - 100 || wall - book.sourceAt > this.config.maxSourceAgeMs) return false;
    for (const side of ['bids', 'asks']) {
      if (!Array.isArray(book[side]) || book[side].length < depth) return false;
      let previous = side === 'bids' ? Infinity : 0;
      for (const row of book[side]) {
        if (!Array.isArray(row) || !positive(row[0]) || !positive(row[1])
          || (side === 'bids' ? row[0] >= previous : row[0] <= previous)) return false;
        previous = row[0];
      }
    }
    return book.bids[0][0] < book.asks[0][0];
  }

  leader(symbol, now, wall) {
    const market = this.dependencies.market('binance', symbol);
    if (!market || market.status !== 'active' || market.nativeSymbol !== NATIVE[symbol] || market.quote !== 'USDT') {
      return { book: null, market, reason: 'leader_metadata_unavailable' };
    }
    const book = this.dependencies.fresh('binance', symbol, now, wall);
    if (!this.validBook(book, 'binance', symbol, now, wall) || book.nativeSymbol !== NATIVE[symbol] || book.quote !== 'USDT' || !sequence(book.sequence)) {
      return { book: null, market, reason: 'leader_unavailable' };
    }
    if (!this.validBook(book, 'binance', symbol, now, wall, 4)) return { book: null, market, reason: 'leader_depth_unavailable' };
    return { book, market, reason: null };
  }

  entropy(symbol, now, wall) {
    const book = this.dependencies.fresh('entropy', symbol, now, wall);
    if (!this.validBook(book, 'entropy', symbol, now, wall)) return { book: null, market: null, reason: 'entropy_unavailable' };
    const market = this.dependencies.market('entropy', symbol);
    if (!market || market.status !== 'active' || market.nativeSymbol !== book.nativeSymbol || market.quote !== book.quote
      || !Number.isInteger(market.sizeDecimals) || market.sizeDecimals < 0 || market.sizeDecimals > 10
      || Number(market.multiplier) !== 1 || !finite(Number(market.minBaseAmount)) || Number(market.minBaseAmount) < 0
      || !positive(Number(market.minQuoteAmount))) return { book: null, market, reason: 'entropy_metadata_unavailable' };
    return { book, market, reason: null };
  }

  disarm(state, reason, now, wall) {
    if (state.armed) this.event(state, 'disarmed', now, wall, { reason, armed: this.publicArmed(state.armed) });
    state.armed = null;
    if (!state.task && state.state !== 'cooldown') { state.state = 'waiting'; state.reason = reason; }
  }

  invalidate(venue, symbol, reason) {
    if (!['binance', 'entropy'].includes(venue)) return;
    for (const key of symbol ? [symbol] : SYMBOLS) {
      if (!this.states.has(key)) continue;
      if (venue === 'binance') this.leaders.delete(key);
      for (const state of this.states.get(key).values()) {
        state.invalidated = { venue, reason, armed: this.publicArmed(state.armed) };
        state.armed = null;
        if (!state.task && state.state !== 'cooldown') { state.state = 'waiting'; state.reason = `${venue === 'binance' ? 'leader' : 'entropy'}_invalid`; }
        if (venue === 'binance' && state.task && !state.task.exitIntent && state.state !== 'unresolved') {
          // invalidate has no clock argument. The next advance supplies the real
          // monotonic send time instead of mixing Date.now with monotonic time.
          state.task.exitIntent = { reason: 'leader_invalid', detail: reason, at: null, mono: null };
        }
      }
    }
  }

  requestExit(state, reason, now, wall) {
    const task = state.task;
    if (!task || task.exitIntent || state.state === 'unresolved') return;
    task.exitIntent = { reason, at: wall, mono: now };
    this.event(state, 'exit_intent', now, wall, { id: task.id, reason });
  }

  sendExit(state, now, wall) {
    const task = state.task;
    if (!task.entry || task.exitSent) return;
    task.exitSent = true;
    task.exitSentMono = now;
    task.exitSentAt = wall;
    task.exitDue = now + task.scenario.entropyMs;
    task.exitDueAt = wall + task.scenario.entropyMs;
    task.exitDeadline = task.exitDue + task.costConfig.fillWaitMs;
    state.state = 'exit_pending'; state.reason = task.exitIntent.reason;
    this.event(state, 'exit_sent', now, wall, { id: task.id, exitDueAt: task.exitDueAt, reason: task.exitIntent.reason });
  }

  remember(state, result, now, wall) {
    state.recentTrades.push(clone(result));
    if (state.recentTrades.length > 20) state.recentTrades.shift();
    this.event(state, 'result', now, wall, result);
  }

  result(task, now, wall, outcome, reason, exit = null) {
    const entry = task.entry;
    const fees = (entry?.fee ?? 0) + (exit?.fee ?? 0);
    const turnover = (entry?.cash ?? 0) + (exit?.cash ?? 0);
    const reserve = entry ? entry.cash * task.costConfig.fundingReserveBpsPerRoundTrip / 10000 : 0;
    const gross = entry && exit ? (task.direction === 'long' ? 1 : -1) * task.quantity * (exit.price - entry.price) : null;
    const net = gross === null ? null : gross - fees - reserve;
    return { id: task.id, symbol: task.symbol, scenario: task.scenario.name, at: wall, direction: task.direction, outcome, reason,
      signalAt: task.signalAt, triggerPrice: task.triggerPrice, entryAt: entry?.at ?? null, exitAt: exit?.at ?? null,
      entryPrice: entry?.price ?? null, exitPrice: exit?.price ?? null, quantity: task.quantity,
      exitReason: task.exitIntent?.reason ?? null, durationMs: entry ? (exit?.mono ?? now) - entry.mono : null,
      grossPnl: gross, fees, costReserve: reserve, netBeforeRebate: net, turnover, rebateScenarios: rebates(fees, net),
      feeSnapshot: task.feeSnapshot, costConfig: task.costConfig };
  }

  failEntry(state, reason, now, wall) {
    const task = state.task;
    state.stats.failedEntries++;
    this.remember(state, this.result(task, now, wall, 'failed_entry', reason), now, wall);
    state.task = null; state.state = 'cooldown'; state.reason = reason;
    state.cooldownUntil = now + task.costConfig.cooldownMs;
  }

  start(state, symbol, direction, armed, entropy, fee, now, wall) {
    const costConfig = clone(this.config.simulation);
    const side = direction === 'long' ? 'buy' : 'sell';
    const price = entropy.book[side === 'buy' ? 'asks' : 'bids'][0][0] * (1 + (side === 'buy' ? 1 : -1) * costConfig.slippageBpsPerFill / 10000);
    const scale = 10 ** entropy.market.sizeDecimals;
    const quantity = Math.floor(costConfig.notionalPerLeg / price * scale) / scale;
    const scenario = { name: state.name, entropyMs: state.entropyMs };
    const task = { id: `binance-scalp-${this.nextId++}`, symbol, scenario, direction,
      triggerPrice: direction === 'long' ? armed.upper : armed.lower, signalAt: wall, signalMono: now, quantity,
      entrySent: true, entrySentAt: wall, entryDue: now + scenario.entropyMs, entryDueAt: wall + scenario.entropyMs,
      entryDeadline: now + scenario.entropyMs + costConfig.fillWaitMs, entry: null, exit: null,
      exitSent: false, exitDue: null, exitDueAt: null, exitDeadline: null, exitIntent: null,
      feeSnapshot: clone(fee), costConfig, market: clone(entropy.market), lastFillFailure: null };
    state.stats.signals++;
    state.task = task; state.armed = null; state.state = 'entry_pending'; state.reason = 'entry_pending';
    this.event(state, 'signal', now, wall, { id: task.id, direction, triggerPrice: task.triggerPrice,
      entryDueAt: task.entryDueAt, quantity, feeSnapshot: task.feeSnapshot, assumedOrder: true, ocoOtherSideCancelled: true });
    if (!positive(quantity) || quantity < Number(task.market.minBaseAmount) || quantity * price < Number(task.market.minQuoteAmount)) {
      this.failEntry(state, 'minimum_order_size', now, wall);
    }
  }

  fill(state, incoming, entropy, now, wall) {
    const task = state.task;
    const entering = state.state === 'entry_pending';
    const due = entering ? task.entryDue : task.exitDue;
    const sent = entering ? task.signalMono : task.exitSentMono;
    if (!incoming || !entropy.book || incoming.venue !== 'entropy' || incoming.symbol !== task.symbol
      || incoming.receivedMono < due || incoming.receivedMono <= sent || now < due
      || incoming.receivedMono !== entropy.book.receivedMono || incoming.sourceAt !== entropy.book.sourceAt) return;
    if (entropy.market.nativeSymbol !== task.market.nativeSymbol || entropy.market.quote !== task.market.quote
      || entropy.market.sizeDecimals !== task.market.sizeDecimals || Number(entropy.market.multiplier) !== Number(task.market.multiplier)) {
      task.lastFillFailure = 'entropy_metadata_changed'; return;
    }
    const side = (task.direction === 'long') === entering ? 'buy' : 'sell';
    const swept = this.dependencies.sweep(incoming, side, task.quantity, task.costConfig.slippageBpsPerFill);
    if (!swept || !positive(swept.cash) || !positive(swept.price)) { task.lastFillFailure = 'insufficient_depth'; return; }
    if (task.quantity < Math.max(Number(task.market.minBaseAmount), Number(entropy.market.minBaseAmount))
      || swept.cash < Math.max(Number(task.market.minQuoteAmount), Number(entropy.market.minQuoteAmount))) {
      task.lastFillFailure = 'minimum_order_size'; return;
    }
    const fill = { ...swept, venue: 'entropy', at: wall, mono: now, sourceAt: incoming.sourceAt,
      receivedMono: incoming.receivedMono, fee: swept.cash * task.feeSnapshot.takerBps / 10000 };
    state.stats.fees += fill.fee; state.stats.turnover += fill.cash;
    if (entering) {
      task.entry = fill;
      state.stats.costReserve += fill.cash * task.costConfig.fundingReserveBpsPerRoundTrip / 10000;
      state.state = 'holding'; state.reason = 'holding';
      this.event(state, 'entry_fill', now, wall, { id: task.id, fill });
      if (task.exitIntent) this.sendExit(state, now, wall);
      return;
    }
    task.exit = fill;
    const result = this.result(task, now, wall, 'completed', null, fill);
    state.stats.completed++;
    state.stats.settledGrossPnl += result.grossPnl;
    state.stats.settledNetBeforeRebate += result.netBeforeRebate;
    if (result.netBeforeRebate < 0) state.stats.lossesBeforeRebate++;
    state.stats.minNetBeforeRebate = state.stats.minNetBeforeRebate === null ? result.netBeforeRebate : Math.min(state.stats.minNetBeforeRebate, result.netBeforeRebate);
    this.event(state, 'exit_fill', now, wall, { id: task.id, fill });
    this.remember(state, result, now, wall);
    state.task = null; state.state = 'cooldown'; state.reason = 'cooldown'; state.cooldownUntil = now + task.costConfig.cooldownMs;
  }

  advance(now, wall, incoming = null) {
    if (!finite(now) || !finite(wall)) throw new Error('Invalid scalper clock');
    let newLeader = null, newEntropy = null;
    if (incoming?.venue === 'binance' && this.states.has(incoming.symbol)) {
      const symbol = incoming.symbol, view = this.leader(symbol, now, wall), seq = sequence(incoming.sequence);
      const previous = this.leaders.get(symbol), lastSequence = this.leaderSequences.get(symbol);
      if (!view.book || incoming.receivedMono !== view.book.receivedMono || incoming.sequence !== view.book.sequence) {
        this.invalidate('binance', symbol, view.reason || 'invalid_incoming');
      } else if (lastSequence && BigInt(seq) < BigInt(lastSequence)
        || previous && (incoming.receivedMono < previous.receivedMono || incoming.sourceAt < previous.sourceAt || incoming.receivedAt < previous.receivedAt)) {
        this.invalidate('binance', symbol, 'out_of_order');
      } else if (!lastSequence || BigInt(seq) > BigInt(lastSequence)) {
        // Receiving a fresh replacement must not bridge a stale or disconnected
        // interval with an old armed threshold.
        if (!previous || !this.validBook(previous, 'binance', symbol, now, wall, 4)) this.invalidate('binance', symbol, 'leader_gap');
        this.leaderSequences.set(symbol, seq);
        this.leaders.set(symbol, clone(incoming));
        newLeader = incoming;
      }
    } else if (incoming?.venue === 'entropy' && this.states.has(incoming.symbol)) {
      const symbol = incoming.symbol, view = this.entropy(symbol, now, wall), previous = this.entropyObservations.get(symbol);
      if (view.book && incoming.receivedMono === view.book.receivedMono && incoming.sourceAt === view.book.sourceAt) {
        if (previous && (incoming.receivedMono < previous.receivedMono || incoming.sourceAt < previous.sourceAt)) {
          this.invalidate('entropy', symbol, 'out_of_order');
        } else if (!previous || incoming.sourceAt > previous.sourceAt && incoming.receivedMono > previous.receivedMono) {
          this.entropyObservations.set(symbol, { receivedMono: incoming.receivedMono, sourceAt: incoming.sourceAt });
          newEntropy = incoming;
        }
      } else this.invalidate('entropy', symbol, view.reason || 'invalid_incoming');
    }
    for (const symbol of SYMBOLS) {
      const leader = this.leader(symbol, now, wall), entropy = this.entropy(symbol, now, wall);
      const observed = this.leaders.get(symbol);
      const leaderAvailable = Boolean(leader.book && observed && this.validBook(observed, 'binance', symbol, now, wall, 4));
      const fee = this.dependencies.entropyFee(symbol, now, wall);
      const feeReason = fee?.status === 'expired' ? 'entropy_fee_expired' : 'entropy_fee_unavailable';
      const feeAvailable = fee?.status === 'available' && finite(fee.takerBps) && fee.takerBps >= 0
        && fee.takerBps <= 10000 && typeof fee.revision === 'string' && fee.revision.length > 0;
      for (const state of this.states.get(symbol).values()) {
        state.symbol = symbol;
        if (state.invalidated) {
          this.event(state, 'invalidated', now, wall, state.invalidated);
          state.invalidated = null;
        }
        if (state.task) {
          const task = state.task;
          if (state.state === 'unresolved') continue;
          if (!leaderAvailable) this.requestExit(state, 'leader_invalid', now, wall);
          if (task.exitIntent?.mono === null) {
            task.exitIntent.mono = now; task.exitIntent.at = wall;
            this.event(state, 'exit_intent', now, wall, { id: task.id, reason: task.exitIntent.reason });
          }
          if (newLeader?.symbol === symbol && leaderAvailable) {
            const recross = task.direction === 'long' ? newLeader.bids[0][0] < task.triggerPrice : newLeader.asks[0][0] > task.triggerPrice;
            if (recross) this.requestExit(state, 'recross_trigger', now, wall);
          }
          if (task.entry && now >= task.entry.mono + task.costConfig.holdMs) this.requestExit(state, 'hold_timeout', now, wall);
          if (task.entry && task.exitIntent) this.sendExit(state, now, wall);
          if (state.state === 'entry_pending' && now > task.entryDeadline) {
            this.failEntry(state, 'entry_timeout', now, wall); continue;
          }
          if (state.state === 'exit_pending' && now > task.exitDeadline) {
            state.state = 'unresolved'; state.reason = 'exit_timeout'; state.stats.unresolved++;
            this.remember(state, this.result(task, now, wall, 'unresolved', 'exit_timeout'), now, wall);
            continue;
          }
          if (state.state === 'entry_pending' || state.state === 'exit_pending') this.fill(state, newEntropy, entropy, now, wall);
          continue;
        }
        if (state.state === 'cooldown') {
          if (now < state.cooldownUntil) continue;
          state.state = 'waiting'; state.reason = 'waiting_leader'; state.cooldownUntil = null;
        }
        const reason = this.suspendedReason || (!leaderAvailable ? leader.reason || 'waiting_leader' : entropy.reason || (!feeAvailable ? feeReason : null));
        if (reason) { this.disarm(state, reason, now, wall); continue; }
        if (!state.armed) {
          state.armed = { at: wall, mono: now, upper: observed.asks[3][0], lower: observed.bids[3][0], sequence: sequence(observed.sequence),
            previousBid: observed.bids[0][0], previousAsk: observed.asks[0][0] };
          state.state = 'armed'; state.reason = 'armed';
          this.event(state, 'armed', now, wall, { armed: this.publicArmed(state.armed) });
          continue;
        }
        if (newLeader?.symbol !== symbol) continue;
        const armed = state.armed;
        const long = armed.previousBid < armed.upper && newLeader.bids[0][0] >= armed.upper;
        const short = armed.previousAsk > armed.lower && newLeader.asks[0][0] <= armed.lower;
        armed.previousBid = newLeader.bids[0][0]; armed.previousAsk = newLeader.asks[0][0];
        if (long || short) this.start(state, symbol, long ? 'long' : 'short', armed, entropy, fee, now, wall);
      }
    }
  }

  publicArmed(armed) { return armed ? { at: armed.at, upper: armed.upper, lower: armed.lower, sequence: armed.sequence } : null; }

  publicPosition(task) {
    return task ? { direction: task.direction, triggerPrice: task.triggerPrice, signalAt: task.signalAt,
      entryAt: task.entry?.at ?? null, entryPrice: task.entry?.price ?? null, quantity: task.quantity, entryCash: task.entry?.cash ?? null,
      entryDueAt: task.entryDueAt, exitDueAt: task.exitDueAt, exitIntent: task.exitIntent, feeSnapshot: task.feeSnapshot,
      entrySent: task.entrySent, exitSent: task.exitSent } : null;
  }

  report(now, wall) {
    this.advance(now, wall);
    const bySymbol = {}, openTasks = [];
    for (const symbol of SYMBOLS) {
      const view = this.leader(symbol, now, wall);
      bySymbol[symbol] = { leader: { status: view.book && this.leaders.has(symbol) ? 'available' : 'unavailable',
        nativeSymbol: view.market?.nativeSymbol ?? NATIVE[symbol], identityVerified: view.market?.identityVerified === true,
        settlementEquivalence: view.market?.settlementEquivalence ?? 'unverified', reason: view.reason }, scenarios: {} };
      for (const state of this.states.get(symbol).values()) {
        const hasOpenExposure = Boolean(state.task), stats = state.stats;
        const net = hasOpenExposure ? null : stats.settledNetBeforeRebate;
        bySymbol[symbol].scenarios[state.name] = { name: state.name, entropyMs: state.entropyMs, state: state.state, reason: state.reason,
          armed: this.publicArmed(state.armed), position: this.publicPosition(state.task), stats: { ...stats, hasOpenExposure,
            grossPnl: hasOpenExposure ? null : stats.settledGrossPnl, netBeforeRebate: net,
            nonLossRateBeforeRebate: stats.completed ? (stats.completed - stats.lossesBeforeRebate) / stats.completed : null,
            rebateScenarios: rebates(stats.fees, net) }, recentTrades: state.recentTrades, lastEventAt: state.lastEventAt };
        if (state.task) openTasks.push({ ...state.task, state: state.state, blockedPermanent: state.state === 'unresolved' });
      }
    }
    const s = this.config.simulation;
    return clone({ schema: 1, strategy: 'binance_depth4_entropy_taker', mode: 'directional_research', enabled: true,
      suspendedReason: this.suspendedReason, observedAt: wall,
      policy: { level: 4, maxHoldMs: s.holdMs, cooldownMs: s.cooldownMs, notionalPerTrade: s.notionalPerLeg,
        slippageBpsPerFill: s.slippageBpsPerFill, fundingReserveBpsPerRoundTrip: s.fundingReserveBpsPerRoundTrip,
        latency: 'assumed', entry: 'bid1_crosses_ask4_or_ask1_crosses_bid4', exit: 'recross_trigger_or_hold_timeout_or_leader_invalid' },
      bySymbol, openTasks, assumptions: { actualOrders: false, venues: ['binance', 'entropy'], binanceRole: 'direction_only',
        crossVenuePriceComparison: false, contractEquivalence: 'unverified_directional_hypothesis',
        scenarios: 'alternative_counterfactuals_do_not_sum', entryAndExit: 'fresh_post_arrival_entropy_book_all_or_none',
        fees: 'locked_public_entropy_taker_fee_snapshot', rebateBasis: 'total_entropy_fees', rebateRatios: RATIOS,
        rebates: 'contingent_not_received', funding: 'fixed_reserve_not_realized_funding',
        turnover: 'actual_simulated_entry_plus_exit_cash', unresolved: 'permanently_blocked_exposure_retained',
        strategy: 'directional_signal_research_not_volume_generation', retention: 'latest_20_outcomes_per_symbol_and_scenario_cumulative_stats_retained' } });
  }
}
