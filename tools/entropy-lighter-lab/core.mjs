// Independent, public-data research. This module never creates or sends orders.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SYMBOLS = ['SNDK', 'ANTH'];
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const positive = (n) => finite(n) && n > 0;
const bounded = (n, lo, hi) => finite(n) && n >= lo && n <= hi;

export function validateConfig(c) {
  const fail = (key) => { throw new Error(`Invalid configuration: ${key}`); };
  if (!c || c.schema !== 1) fail('schema');
  if (typeof c.region !== 'string' || c.region.length > 100) fail('region');
  if (typeof c.recordRaw !== 'boolean') fail('recordRaw');
  for (const [key, lo, hi] of [
    ['maxDataMb', 16, 1048576], ['retentionDays', 1, 365],
    ['maxBookAgeMs', 50, 10000], ['maxSourceAgeMs', 100, 30000],
    ['maxPairSkewMs', 0, 5000], ['sampleIntervalMs', 50, 5000],
  ]) if (!bounded(c[key], lo, hi)) fail(key);
  const s = c.simulation;
  if (!s || typeof s.enabled !== 'boolean') fail('simulation.enabled');
  if (!Array.isArray(s.verifiedSymbols) || new Set(s.verifiedSymbols).size !== s.verifiedSymbols.length || s.verifiedSymbols.some((v) => !SYMBOLS.includes(v))) fail('verifiedSymbols');
  for (const key of ['entropyTakerFeeBps', 'lighterTakerFeeBps']) {
    if (s[key] !== null && !bounded(s[key], 0, 100)) fail(key);
    if (s.enabled && s[key] === null) fail(`${key}: required for paper mode`);
  }
  if (s.enabled && !s.verifiedSymbols.length) fail('verifiedSymbols: required for paper mode');
  for (const [key, lo, hi] of [
    ['notionalPerLeg', 1, 100000], ['minEntryEdgeBps', 0, 1000],
    ['slippageBpsPerFill', 0, 100], ['fundingReserveBpsPerRoundTrip', 0, 100],
    ['holdMs', 100, 60000], ['fillWaitMs', 100, 10000], ['cooldownMs', 1000, 3600000],
  ]) if (!bounded(s[key], lo, hi)) fail(key);
  if (!Array.isArray(s.rebateRatios) || !s.rebateRatios.length || s.rebateRatios.length > 10 || s.rebateRatios.some((x) => !bounded(x, 0, 2))) fail('rebateRatios');
  if (!Array.isArray(s.latencyScenarios) || !s.latencyScenarios.length || s.latencyScenarios.length > 8) fail('latencyScenarios');
  const names = new Set();
  for (const l of s.latencyScenarios) {
    if (!l || !/^[a-zA-Z0-9_-]{1,40}$/.test(l.name) || names.has(l.name) || !bounded(l.entropyMs, 0, 10000) || !bounded(l.lighterMs, 300, 10000)) fail('latencyScenarios: Standard taker floor is 300ms');
    names.add(l.name);
  }
  return c;
}

export function validateBook(b, now, wallNow, config) {
  if (!b || !['entropy', 'lighter', 'binance'].includes(b.venue) || !SYMBOLS.includes(b.symbol)) return 'identity';
  if (!finite(b.receivedMono) || now < b.receivedMono || now - b.receivedMono > config.maxBookAgeMs) return 'stale_receive';
  if (!finite(b.receivedAt) || wallNow < b.receivedAt - 100 || wallNow - b.receivedAt > config.maxBookAgeMs) return 'wall_clock';
  if (b.sourceAt !== null && (!finite(b.sourceAt) || wallNow < b.sourceAt - 100 || wallNow - b.sourceAt > config.maxSourceAgeMs)) return 'stale_source';
  for (const side of ['bids', 'asks']) {
    if (!Array.isArray(b[side]) || !b[side].length) return 'empty_depth';
    let previous = side === 'bids' ? Infinity : 0;
    for (const row of b[side]) {
      if (!Array.isArray(row) || !positive(row[0]) || !positive(row[1])) return 'invalid_depth';
      if (side === 'bids' ? row[0] >= previous : row[0] <= previous) return 'unsorted_depth';
      previous = row[0];
    }
  }
  if (b.bids[0][0] >= b.asks[0][0]) return 'crossed_book';
  return null;
}

export function sweep(book, side, quantity, slippageBps = 0) {
  if (!positive(quantity)) return null;
  let left = quantity, cash = 0;
  for (const [price, size] of book[side === 'buy' ? 'asks' : 'bids']) {
    const take = Math.min(left, size);
    cash += take * price;
    left -= take;
    if (left <= quantity * 1e-10) break;
  }
  if (left > quantity * 1e-10) return null; // All-or-none paper IOC; never assumes hidden depth.
  cash *= 1 + (side === 'buy' ? 1 : -1) * slippageBps / 10000;
  return { side, quantity, price: cash / quantity, cash };
}

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function atomicJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Synchronous bounded writes deliberately fail closed on ENOSPC/IO errors.
export class Recorder {
  constructor(directory, config, session) {
    this.directory = directory;
    this.config = config;
    this.session = session;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.segment = 0;
    this.bytes = 0;
    this.lastPrune = 0;
    this.prune(Date.now());
  }
  prune(now) {
    const files = readdirSync(this.directory).filter((n) => /^events-\d{13}-[a-f0-9-]+-\d+\.jsonl$/.test(n))
      .map((name) => ({ name, ...statSync(join(this.directory, name)) })).sort((a, b) => a.name.localeCompare(b.name));
    let total = files.reduce((n, f) => n + f.size, 0);
    const cap = this.config.maxDataMb * 1024 * 1024;
    for (const f of files) {
      if (f.name === this.active) continue;
      if (now - Number(f.name.slice(7, 20)) > this.config.retentionDays * 86400000 || total > cap * 0.85) {
        unlinkSync(join(this.directory, f.name));
        total -= f.size;
      }
    }
    this.totalBytes = total;
    this.lastPrune = now;
  }
  write(event) {
    const now = Date.now();
    if (!this.active || this.bytes >= 8 * 1024 * 1024) {
      this.active = `events-${String(now).padStart(13, '0')}-${this.session}-${this.segment++}.jsonl`;
      this.bytes = 0;
      this.prune(now);
    } else if (now - this.lastPrune > 60000) this.prune(now);
    const row = `${JSON.stringify({ ...event, session: this.session })}\n`;
    const bytes = Buffer.byteLength(row);
    if (bytes > 4 * 1024 * 1024) throw new Error('Record exceeds 4 MiB limit');
    if (this.totalBytes + bytes > this.config.maxDataMb * 1024 * 1024) {
      this.prune(now);
      if (this.totalBytes + bytes > this.config.maxDataMb * 1024 * 1024) throw new Error('Data quota exhausted');
    }
    appendFileSync(join(this.directory, this.active), row, { mode: 0o600 });
    this.bytes += bytes;
    this.totalBytes += bytes;
  }
}

const mid = (b) => (b.bids[0][0] + b.asks[0][0]) / 2;
const pairKey = (venue, symbol) => `${venue}:${symbol}`;
const summaries = () => ({ completed: 0, lossesBeforeRebate: 0, settledGrossPnl: 0, fees: 0, entropyFees: 0, costReserve: 0, turnover: { entropy: 0, lighter: 0 }, settledNetBeforeRebate: 0, minNetBeforeRebate: null, failedLegs: 0, unresolved: 0 });

// An entry cash-space estimate, not a realized roundtrip PnL. Both opening
// sweeps already include slippage; only the two exit slippages are reserved here.
export function studyEvaluation({ buy, sell, config, at, sourceTimeUncertain = false }) {
  const s = config.simulation;
  const entropyCash = buy.venue === 'entropy' ? buy.cash : sell.cash;
  const lighterCash = buy.venue === 'lighter' ? buy.cash : sell.cash;
  const knownFees = finite(s.entropyTakerFeeBps) && finite(s.lighterTakerFeeBps);
  const entropyFees = finite(s.entropyTakerFeeBps) ? 2 * entropyCash * s.entropyTakerFeeBps / 10000 : null;
  const fees = knownFees ? 2 * (entropyCash * s.entropyTakerFeeBps + lighterCash * s.lighterTakerFeeBps) / 10000 : null;
  const exitSlippage = (buy.cash + sell.cash) * s.slippageBpsPerFill / 10000;
  const funding = (buy.cash + sell.cash) / 2 * s.fundingReserveBpsPerRoundTrip / 10000;
  const total = fees === null ? null : fees + exitSlippage + funding;
  const gross = sell.cash - buy.cash;
  const surplus = total === null ? null : gross - total;
  const surplusBps = surplus === null ? null : surplus / buy.cash * 10000;
  return { at, quantity: buy.quantity, buyPrice: buy.price, sellPrice: sell.price, buyNotional: buy.cash, sellNotional: sell.cash,
    grossCash: gross, grossBps: gross / buy.cash * 10000,
    costs: { feesRoundTripCash: fees, exitSlippageReserveCash: exitSlippage, fundingReserveCash: funding, totalReserveCash: total },
    surplusBeforeRebateCash: surplus, surplusBeforeRebateBps: surplusBps, entropyRoundTripFeesCash: entropyFees,
    rebates: s.rebateRatios.map((ratio) => ({ ratio, contingentRebateCash: entropyFees === null ? null : entropyFees * ratio, surplusCash: surplus === null || entropyFees === null ? null : surplus + entropyFees * ratio })),
    gatePassed: surplusBps !== null && surplusBps >= s.minEntryEdgeBps, sourceTimeUncertain };
}

export class Lab {
  constructor(config, emit = () => {}) {
    this.config = validateConfig(config);
    this.emit = emit;
    this.books = new Map();
    this.markets = new Map();
    this.tasks = new Map();
    this.next = new Map();
    this.lastSample = new Map();
    this.history = new Map();
    this.leadPending = [];
    this.leadStats = new Map();
    this.spreads = new Map();
    this.recentSpreads = new Map(SYMBOLS.map((symbol) => [symbol, []]));
    this.studyStats = new Map();
    this.studyProbes = new Map();
    this.lastStudy = new Map();
    this.studyIntervalMs = Math.max(2000, Math.min(10000, config.simulation.cooldownMs));
    this.counts = { books: 0, candidates: 0, invalidated: 0, rejected: {} };
    this.results = new Map(config.simulation.latencyScenarios.map((s) => [s.name, summaries()]));
  }
  setMarkets(markets) { this.markets = new Map(markets.map((m) => [pairKey(m.venue, m.symbol), m])); }
  reject(reason) { this.counts.rejected[reason] = (this.counts.rejected[reason] || 0) + 1; }
  invalidate(venue, symbol, reason) {
    if (venue !== 'binance') for (const probe of [...this.studyProbes.values()]) {
      if ((!symbol || probe.symbol === symbol) && probe.legs.some((leg) => leg.venue === venue)) this.endStudy(probe, null, 'invalidated');
    }
    for (const s of symbol ? [symbol] : SYMBOLS) {
      this.books.delete(pairKey(venue, s));
      this.history.delete(pairKey(venue, s));
      const points = this.recentSpreads.get(s);
      if (venue !== 'binance' && points?.length && points.at(-1).midBasisBps !== null) {
        points.push({ at: Date.now(), midBasisBps: null, takerEdgeBps: null, buy: null, sell: null, sourceClockUncertain: true });
        if (points.length > 600) points.shift();
      }
    }
    this.leadPending = this.leadPending.filter((p) => p.venue !== venue && venue !== 'binance');
    this.counts.invalidated++;
    this.emit({ type: 'invalidated', venue, symbol, reason });
  }
  book(b) {
    const error = validateBook({ ...b, sourceAt: null }, b.receivedMono, b.receivedAt, this.config);
    if (error) { this.invalidate(b.venue, b.symbol, error); this.reject(error); return; }
    const key = pairKey(b.venue, b.symbol);
    const old = this.books.get(key);
    if (old && (b.receivedMono < old.receivedMono || b.receivedAt < old.receivedAt)) { this.invalidate(b.venue, b.symbol, 'out_of_order'); return; }
    this.books.set(key, b);
    this.counts.books++;
    const sourceTimeError = validateBook(b, b.receivedMono, b.receivedAt, this.config);
    if (sourceTimeError) this.reject(sourceTimeError);
    this.emit({ type: 'book', ...b, sourceClockDeltaMs: b.sourceAt === null ? null : b.receivedAt - b.sourceAt, sourceTimeError, sourceClockUncertain: b.sourceAt === null || Boolean(sourceTimeError) });
    this.advance(b.receivedMono, b.receivedAt, b);
    this.sampleLead(b);
    if (b.venue === 'binance') return;
    const last = this.lastSample.get(b.symbol);
    if (last !== undefined && b.receivedMono - last < this.config.sampleIntervalMs) return;
    this.samplePair(b.symbol, b.receivedMono, b.receivedAt);
  }
  fresh(venue, symbol, now, wall, requireSourceTime = true) {
    const b = this.books.get(pairKey(venue, symbol));
    return b && !validateBook(requireSourceTime ? b : { ...b, sourceAt: null }, now, wall, this.config) ? b : null;
  }
  samplePair(symbol, now, wall) {
    const a = this.fresh('entropy', symbol, now, wall, false), b = this.fresh('lighter', symbol, now, wall, false);
    if (!a || !b) { this.reject('missing_or_stale_pair'); return; }
    if (a.quote !== b.quote || Math.abs(a.receivedMono - b.receivedMono) > this.config.maxPairSkewMs) { this.reject('quote_or_time_mismatch'); return; }
    this.lastSample.set(symbol, now);
    const spread = (mid(a) / mid(b) - 1) * 10000;
    const stats = this.spreads.get(symbol) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    stats.count++; stats.sum += spread; stats.min = Math.min(stats.min, spread); stats.max = Math.max(stats.max, spread);
    this.spreads.set(symbol, stats);
    const directions = [{ buy: a, sell: b }, { buy: b, sell: a }].map((d) => ({ ...d, edgeBps: (d.sell.bids[0][0] / d.buy.asks[0][0] - 1) * 10000 }));
    directions.sort((x, y) => y.edgeBps - x.edgeBps);
    const d = directions[0];
    const sourceTimeErrors = [a, b].map((book) => ({ venue: book.venue, error: book.sourceAt === null ? 'missing_source_time' : validateBook(book, now, wall, this.config), sourceClockDeltaMs: book.sourceAt === null ? null : wall - book.sourceAt }));
    const points = this.recentSpreads.get(symbol);
    if (!points.length || points.at(-1).midBasisBps === null || wall - points.at(-1).at >= 2000) {
      points.push({ at: wall, midBasisBps: spread, takerEdgeBps: d.edgeBps, buy: d.buy.venue, sell: d.sell.venue, sourceClockUncertain: sourceTimeErrors.some((e) => e.error) });
      if (points.length > 600) points.shift();
    }
    this.emit({ type: 'spread', symbol, at: wall, mono: now, entropyMid: mid(a), lighterMid: mid(b), midBasisBps: spread, takerEdgeBps: d.edgeBps, buy: d.buy.venue, sell: d.sell.venue, sourceTimeErrors, observation: 'receive_time_only_not_source_freshness_proof', settlementEquivalence: 'requires_verification' });
    this.sampleStudy(symbol, a, b, now, wall);
    const s = this.config.simulation;
    if (!s.enabled || !s.verifiedSymbols.includes(symbol)) { this.reject('paper_disabled_or_contract_unverified'); return; }
    if (sourceTimeErrors.some((e) => e.error)) { this.reject('paper_source_time_unverified'); return; }
    const ma = this.markets.get(pairKey('entropy', symbol)), mb = this.markets.get(pairKey('lighter', symbol));
    if (!ma || !mb || ma.status !== 'active' || mb.status !== 'active' || [ma, mb].some((m) => !Number.isInteger(m.sizeDecimals) || !bounded(m.sizeDecimals, 0, 10) || Number(m.multiplier) !== 1 || !bounded(Number(m.minBaseAmount), 0, 1e10) || !positive(Number(m.minQuoteAmount)))) { this.reject('metadata_unavailable'); return; }
    const decimals = Math.min(ma.sizeDecimals, mb.sizeDecimals);
    const quantity = Math.floor(s.notionalPerLeg / Math.max(mid(a), mid(b)) * 10 ** decimals) / 10 ** decimals;
    const buy = sweep(d.buy, 'buy', quantity, s.slippageBpsPerFill), sell = sweep(d.sell, 'sell', quantity, s.slippageBpsPerFill);
    if (!buy || !sell) { this.reject('insufficient_depth_or_size'); return; }
    if ([ma, mb].some((m) => quantity < Number(m.minBaseAmount) || quantity * Math.min(buy.price, sell.price) < Number(m.minQuoteAmount))) { this.reject('minimum_order_size'); return; }
    // Entry spread must pay all four taker fees and reserves without a rebate.
    const costBps = 2 * (s.entropyTakerFeeBps + s.lighterTakerFeeBps) + 2 * s.slippageBpsPerFill + s.fundingReserveBpsPerRoundTrip;
    const executableEdge = (sell.price / buy.price - 1) * 10000;
    if (executableEdge < s.minEntryEdgeBps + costBps) { this.reject('entry_cost_threshold'); return; }
    for (const scenario of s.latencyScenarios) {
      const key = `${scenario.name}:${symbol}`;
      if (this.tasks.has(key) || now < (this.next.get(key) || 0)) continue;
      const legs = [d.buy, d.sell].map((book, i) => ({ venue: book.venue, side: i === 0 ? 'buy' : 'sell', due: now + scenario[`${book.venue}Ms`], state: 'pending', entry: null, exit: null }));
      const task = { key, symbol, scenario, quantity, signalAt: wall, signalMono: now, edgeBps: executableEdge, phase: 'entry', legs, failed: false };
      this.tasks.set(key, task); this.counts.candidates++;
      this.emit({ type: 'paper_signal', ...task, assumption: 'independent_latency_scenarios_not_additive' });
    }
  }
  advance(now, wall, incoming = null) {
    this.advanceStudies(now, wall, incoming);
    const s = this.config.simulation;
    for (const t of this.tasks.values()) {
      for (const leg of t.legs) {
        if (leg.state !== 'pending' && leg.state !== 'closing') continue;
        const closing = leg.state === 'closing';
        if (now > leg.due + s.fillWaitMs) {
          if (closing) {
            leg.state = 'unresolved';
            this.emit({ type: 'paper_unresolved', key: t.key, symbol: t.symbol, venue: leg.venue, at: wall, reason: 'no_exit_quote_or_depth', entry: leg.entry });
          } else { leg.state = 'rejected'; t.failed = true; this.results.get(t.scenario.name).failedLegs++; }
          continue;
        }
        // Only a new post-arrival observation may fill, never a trigger-time book.
        if (!incoming || incoming.venue !== leg.venue || incoming.symbol !== t.symbol || incoming.receivedMono < leg.due || validateBook(incoming, now, wall, this.config)) continue;
        const side = closing ? (leg.side === 'buy' ? 'sell' : 'buy') : leg.side;
        const fill = sweep(incoming, side, t.quantity, s.slippageBpsPerFill);
        if (!fill) {
          if (!closing) { leg.state = 'rejected'; t.failed = true; this.results.get(t.scenario.name).failedLegs++; }
          continue;
        }
        const feeBps = leg.venue === 'entropy' ? s.entropyTakerFeeBps : s.lighterTakerFeeBps;
        const record = { ...fill, fee: fill.cash * feeBps / 10000, receivedAt: wall, receivedMono: now, sourceAt: incoming.sourceAt, sequence: incoming.sequence };
        leg[closing ? 'exit' : 'entry'] = record;
        leg.state = closing ? 'closed' : 'open';
        this.emit({ type: 'paper_fill', key: t.key, symbol: t.symbol, venue: leg.venue, phase: closing ? 'exit' : 'entry', ...record });
      }
      if (t.phase === 'entry' && t.legs.every((l) => l.state !== 'pending')) {
        t.phase = 'holding'; t.exitAt = now + (t.failed ? 0 : s.holdMs);
      }
      if (t.phase === 'holding' && now >= t.exitAt) {
        t.phase = 'exit';
        for (const leg of t.legs) if (leg.state === 'open') { leg.state = 'closing'; leg.due = now + t.scenario[`${leg.venue}Ms`]; }
      }
      if (t.phase === 'exit' && t.legs.every((l) => ['closed', 'rejected', 'unresolved'].includes(l.state))) this.finish(t, now, wall);
    }
  }
  studyMetric(symbol, buy, sell, scenario) {
    const id = `${symbol}:${scenario ? `latency:${scenario.name}` : 'raw'}:${buy}:${sell}`;
    if (!this.studyStats.has(id)) this.studyStats.set(id, { symbol, buy, sell, scenario: scenario ? { ...scenario } : null,
      attempts: 0, completed: 0, failed: 0, costed: 0, passedAfterCosts: 0, sumSurplusBps: 0, minSurplusBps: null,
      spanMs: 0, firstAt: null, lastAt: null, latest: null, failureReasons: {}, firstMono: null,
      qualitySpanMs: 0, qualityFirstAt: null, qualityLastAt: null, qualityFirstMono: null, uncertainSourceSamples: 0 });
    return this.studyStats.get(id);
  }
  attemptStudy(metric, now, wall) {
    metric.attempts++;
    metric.firstAt ??= wall; metric.firstMono ??= now;
    metric.lastAt = wall; metric.spanMs = Math.max(0, now - metric.firstMono);
  }
  recordStudy(metric, evaluation, reason, now = performance.now()) {
    if (reason) { metric.failed++; metric.failureReasons[reason] = (metric.failureReasons[reason] || 0) + 1; return; }
    metric.completed++; metric.latest = evaluation;
    if (evaluation.sourceTimeUncertain) metric.uncertainSourceSamples++;
    if (evaluation.surplusBeforeRebateBps !== null && !evaluation.sourceTimeUncertain) {
      metric.qualityFirstAt ??= evaluation.at; metric.qualityFirstMono ??= now;
      metric.qualityLastAt = evaluation.at; metric.qualitySpanMs = Math.max(0, now - metric.qualityFirstMono);
      metric.costed++; metric.sumSurplusBps += evaluation.surplusBeforeRebateBps;
      metric.minSurplusBps = metric.minSurplusBps === null ? evaluation.surplusBeforeRebateBps : Math.min(metric.minSurplusBps, evaluation.surplusBeforeRebateBps);
      if (evaluation.gatePassed) metric.passedAfterCosts++;
    }
  }
  sampleStudy(symbol, entropy, lighter, now, wall) {
    if (now - (this.lastStudy.get(symbol) ?? -Infinity) < this.studyIntervalMs) return;
    this.lastStudy.set(symbol, now);
    const markets = ['entropy', 'lighter'].map((v) => this.markets.get(pairKey(v, symbol)));
    const validMarket = markets.every((m) => m && m.status === 'active' && Number.isInteger(m.sizeDecimals) && bounded(m.sizeDecimals, 0, 10)
      && Number(m.multiplier) === 1 && positive(Number(m.minQuoteAmount)) && bounded(Number(m.minBaseAmount), 0, 1e10));
    const decimals = validMarket ? Math.min(...markets.map((m) => m.sizeDecimals)) : 0;
    const quantity = validMarket ? Math.floor(this.config.simulation.notionalPerLeg / Math.max(mid(entropy), mid(lighter)) * 10 ** decimals) / 10 ** decimals : 0;
    for (const [buyBook, sellBook] of [[entropy, lighter], [lighter, entropy]]) {
      const buy = sweep(buyBook, 'buy', quantity, this.config.simulation.slippageBpsPerFill);
      const sell = sweep(sellBook, 'sell', quantity, this.config.simulation.slippageBpsPerFill);
      const reason = !validMarket ? 'metadata_unavailable' : !buy || !sell ? 'insufficient_depth'
        : markets.some((m) => quantity < Number(m.minBaseAmount) || Math.min(buy.cash, sell.cash) < Number(m.minQuoteAmount)) ? 'minimum_order_size' : null;
      const metric = this.studyMetric(symbol, buyBook.venue, sellBook.venue, null);
      this.attemptStudy(metric, now, wall);
      const evaluation = reason ? null : studyEvaluation({ buy: { ...buy, venue: buyBook.venue }, sell: { ...sell, venue: sellBook.venue }, config: this.config, at: wall,
        sourceTimeUncertain: [buyBook, sellBook].some((b) => b.sourceAt === null || Boolean(validateBook(b, now, wall, this.config))) });
      this.recordStudy(metric, evaluation, reason, now);
      for (const scenario of this.config.simulation.latencyScenarios) {
        const key = `${scenario.name}:${symbol}:${buyBook.venue}:${sellBook.venue}`;
        if (this.studyProbes.has(key)) continue;
        const delayed = this.studyMetric(symbol, buyBook.venue, sellBook.venue, scenario);
        this.attemptStudy(delayed, now, wall);
        if (reason) { this.recordStudy(delayed, null, reason, now); continue; }
        this.studyProbes.set(key, { key, symbol, quantity, metric: delayed, signalAt: wall,
          legs: [{ venue: buyBook.venue, side: 'buy', due: now + scenario[`${buyBook.venue}Ms`], fill: null },
            { venue: sellBook.venue, side: 'sell', due: now + scenario[`${sellBook.venue}Ms`], fill: null }] });
      }
    }
  }
  endStudy(probe, evaluation, reason, now = performance.now()) {
    this.recordStudy(probe.metric, evaluation, reason, now);
    this.studyProbes.delete(probe.key);
    this.emit({ type: 'delay_study', symbol: probe.symbol, buy: probe.metric.buy, sell: probe.metric.sell,
      scenario: probe.metric.scenario, signalAt: probe.signalAt, evaluation, failure: reason || null,
      assumption: 'alternative_post_arrival_entry_probes_not_roundtrip_profit_or_executable_volume' });
  }
  advanceStudies(now, wall, incoming) {
    for (const probe of [...this.studyProbes.values()]) {
      if (probe.legs.some((leg) => !leg.fill && now > leg.due + this.config.simulation.fillWaitMs)) { this.endStudy(probe, null, 'timeout'); continue; }
      if (!incoming || incoming.symbol !== probe.symbol) continue;
      const leg = probe.legs.find((l) => l.venue === incoming.venue && !l.fill && now >= l.due);
      if (!leg) continue;
      const fill = sweep(incoming, leg.side, probe.quantity, this.config.simulation.slippageBpsPerFill);
      if (!fill) { this.endStudy(probe, null, 'insufficient_depth'); continue; }
      const market = this.markets.get(pairKey(incoming.venue, probe.symbol));
      if (!market || fill.cash < Number(market.minQuoteAmount) || probe.quantity < Number(market.minBaseAmount)) { this.endStudy(probe, null, 'minimum_order_size'); continue; }
      leg.fill = { ...fill, venue: incoming.venue, sourceTimeUncertain: incoming.sourceAt === null || Boolean(validateBook(incoming, now, wall, this.config)) };
      if (probe.legs.every((l) => l.fill)) this.endStudy(probe, studyEvaluation({ buy: probe.legs[0].fill, sell: probe.legs[1].fill, config: this.config, at: wall,
        sourceTimeUncertain: probe.legs.some((l) => l.fill.sourceTimeUncertain) }), null, now);
    }
  }
  finish(t, now, wall) {
    const r = this.results.get(t.scenario.name);
    const unresolved = t.legs.some((l) => l.state === 'unresolved');
    let gross = 0, fees = 0, entropyFees = 0, entryNotional = 0;
    const turnover = { entropy: 0, lighter: 0 };
    for (const l of t.legs) {
      for (const f of [l.entry, l.exit].filter(Boolean)) { fees += f.fee; turnover[l.venue] += f.cash; if (l.venue === 'entropy') entropyFees += f.fee; }
      if (l.entry) entryNotional += l.entry.cash;
      if (l.exit) gross += l.side === 'buy' ? l.exit.cash - l.entry.cash : l.entry.cash - l.exit.cash;
    }
    const reserve = entryNotional / 2 * this.config.simulation.fundingReserveBpsPerRoundTrip / 10000;
    const net = unresolved ? null : gross - fees - reserve;
    const outcome = { type: 'paper_result', key: t.key, symbol: t.symbol, at: wall, scenario: t.scenario.name, failed: t.failed, unresolved, grossPnl: unresolved ? null : gross, fees, entropyFees, costReserve: reserve, netBeforeRebate: net, turnover, durationMs: now - t.signalMono, rebateScenarios: this.config.simulation.rebateRatios.map((ratio) => ({ ratio, contingentRebate: entropyFees * ratio, net: net === null ? null : net + entropyFees * ratio })), legs: t.legs };
    r.turnover.entropy += turnover.entropy; r.turnover.lighter += turnover.lighter;
    r.fees += fees; r.entropyFees += entropyFees; r.costReserve += reserve;
    if (unresolved) {
      r.unresolved++;
      // Keep the symbol blocked: lost paper exposure must never silently reset.
      this.next.set(t.key, Infinity);
    } else {
      r.completed++; r.settledGrossPnl += gross; r.settledNetBeforeRebate += net;
      if (net < 0) r.lossesBeforeRebate++;
      r.minNetBeforeRebate = r.minNetBeforeRebate === null ? net : Math.min(r.minNetBeforeRebate, net);
      this.next.set(t.key, now + this.config.simulation.cooldownMs);
    }
    this.emit(outcome); this.tasks.delete(t.key);
  }
  sampleLead(b) {
    const key = pairKey(b.venue, b.symbol), price = mid(b);
    const history = this.history.get(key) || [];
    history.push({ mono: b.receivedMono, price });
    while (history.length && (history[0].mono < b.receivedMono - 5000 || history.length > 5000)) history.shift();
    this.history.set(key, history);
    for (const p of this.leadPending) {
      if (p.symbol !== b.symbol || p.venue !== b.venue || b.receivedMono < p.due || b.receivedMono > p.due + this.config.maxBookAgeMs) continue;
      const moveBps = (price / p.start - 1) * 10000;
      const k = `${p.symbol}:${p.venue}:${p.lagMs}`;
      const stats = this.leadStats.get(k) || { count: 0, directionHits: 0, sumSignedMoveBps: 0 };
      stats.count++; if (moveBps * p.direction > 0) stats.directionHits++;
      stats.sumSignedMoveBps += moveBps * p.direction;
      this.leadStats.set(k, stats);
      this.emit({ type: 'leader_markout', symbol: p.symbol, venue: p.venue, lagMs: p.lagMs, binanceMoveBps: p.moveBps, followerMoveBps: moveBps, observedLagMs: b.receivedMono - p.created, method: 'local_receive_times_directional_returns_no_fx_level_comparison' });
      p.done = true;
    }
    this.leadPending = this.leadPending.filter((p) => !p.done && b.receivedMono <= p.due + this.config.maxBookAgeMs);
    if (b.venue !== 'binance') return;
    const previous = history.findLast((p) => p.mono <= b.receivedMono - 250);
    if (!previous || b.receivedMono - previous.mono > this.config.maxBookAgeMs) return;
    const moveBps = (price / previous.price - 1) * 10000;
    if (Math.abs(moveBps) < 2 || b.receivedMono < (this.next.get(`leader:${b.symbol}`) || 0)) return;
    this.next.set(`leader:${b.symbol}`, b.receivedMono + 2000);
    for (const venue of ['entropy', 'lighter']) {
      const follower = this.fresh(venue, b.symbol, b.receivedMono, b.receivedAt, false);
      if (!follower) continue;
      for (const lagMs of [100, 300, 500, 1000, 2000]) this.leadPending.push({ symbol: b.symbol, venue, lagMs, start: mid(follower), direction: Math.sign(moveBps), moveBps, created: b.receivedMono, due: b.receivedMono + lagMs });
    }
  }
  report(now = performance.now(), wall = Date.now()) {
    return {
      observedAt: wall,
      observation: { asOf: wall, silenceAfterMs: 10000 },
      counts: this.counts,
      latestQuotes: [...this.books.values()].map((b) => ({ venue: b.venue, symbol: b.symbol, nativeSymbol: b.nativeSymbol, bid: b.bids[0][0], ask: b.asks[0][0], receivedAt: b.receivedAt, sourceAt: b.sourceAt,
        receiveAgeMs: now >= b.receivedMono ? now - b.receivedMono : null, executionQuality: b.sourceAt === null ? 'missing_source_time' : validateBook(b, now, wall, this.config),
        sourceClockUncertain: b.sourceAt === null || b.receivedAt - b.sourceAt < -100 || b.receivedAt - b.sourceAt > this.config.maxSourceAgeMs })),
      opportunityStudy: { sampleIntervalMs: this.studyIntervalMs, bySymbol: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
        raw: Object.fromEntries([...this.studyStats.values()].filter((m) => m.symbol === symbol && !m.scenario).map(({ firstMono, qualityFirstMono, symbol: ignoredSymbol, ...m }) => [`${m.buy}:${m.sell}`, m])),
        latency: Object.fromEntries([...this.studyStats.values()].filter((m) => m.symbol === symbol && m.scenario).map(({ firstMono, qualityFirstMono, symbol: ignoredSymbol, ...m }) => [`${m.scenario.name}:${m.buy}:${m.sell}`, m])),
      }])) },
      recentSpreads: Object.fromEntries(this.recentSpreads),
      basis: Object.fromEntries([...this.spreads].map(([symbol, s]) => [symbol, { samples: s.count, meanBps: s.sum / s.count, minBps: s.min, maxBps: s.max }])),
      leaderMarkouts: Object.fromEntries([...this.leadStats].map(([key, s]) => [key, { samples: s.count, directionHitRate: s.directionHits / s.count, meanSignedMoveBps: s.sumSignedMoveBps / s.count }])),
      paper: Object.fromEntries([...this.results].map(([key, s]) => {
        const open = [...this.tasks.values()].filter((t) => t.scenario.name === key);
        const net = s.unresolved || open.length ? null : s.settledNetBeforeRebate;
        const fills = open.flatMap((t) => t.legs.flatMap((l) => [l.entry, l.exit].filter(Boolean).map((f) => ({ ...f, venue: l.venue }))));
        const knownFees = s.fees + fills.reduce((n, f) => n + f.fee, 0);
        const knownEntropyFees = s.entropyFees + fills.filter((f) => f.venue === 'entropy').reduce((n, f) => n + f.fee, 0);
        return [key, { ...s, fees: knownFees, entropyFees: knownEntropyFees, openTasks: open.length, grossPnl: net === null ? null : s.settledGrossPnl, netBeforeRebate: net, rebateScenarios: this.config.simulation.rebateRatios.map((ratio) => ({ ratio, contingentRebate: knownEntropyFees * ratio, net: net === null ? null : net + knownEntropyFees * ratio })) }];
      })),
      openPaperTasks: [...this.tasks.values()],
      assumptions: { orderLatency: 'assumed_not_measured', fills: 'post_arrival_public_book_proxy_all_or_none_not_queue_or_real_fills', funding: 'reserve_not_actual_settlement', rebate: 'contingent_not_received', scenarios: 'alternative_not_additive', leader: 'receive_time_markouts_not_causal_proof', volume: 'paper_turnover_not_realizable_capacity' },
    };
  }
}

export function readPreviousReport(directory) {
  const path = join(directory, 'report.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
