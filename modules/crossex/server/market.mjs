import { createHash } from 'node:crypto';
import { AppError, defaults, configuration, validateFeed, validSignal, validManualPair, pairKey, quoteKey, contractIdentity,
  freshQuote, quoteTime, catalogRule, manualCatalogRule, displayCatalogRule, validateBooks, fxRate, referencePrice, settlement, SUPPORTED_VENUES, transferEligibility } from './model.mjs';
import { loadCatalog, loadFeed, loadDepth, loadManualDepth, loadFx, resolveCrossexQuote, resolveManualQuote } from './clients.mjs';
import { D, Decimal } from './money.mjs';
import { feeSnapshot, roundTripFeeBps } from './fees.mjs';
import { fundingOpportunities } from './funding-opportunities.mjs';

const CONFIG_KEYS = ['entryPaused', 'monitorUrl', 'monitorUsername', 'notionalPerLeg', 'maxOpen', 'maxTotalNotional', 'feeBps', 'feeSchedule', 'slippageBps', 'minNetBps', 'cooldownSeconds'];
const safeMessage = error => error instanceof AppError ? error.message : '行情读取失败，请检查来源连接';
const positiveDecimal = value => { try { return typeof value === 'string' && value.trim() !== '' && D(value).gt(0); } catch { return false; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const catalogKey = (symbol, exchange, business) => JSON.stringify([symbol, exchange, business]);
const signalKey = (signal, declared = false) => JSON.stringify([declared ? signal.pairKey : pairKey(signal), contractIdentity(signal.long), contractIdentity(signal.short)]);

function indexCatalog(items) {
  // Preserve catalogRule's first exact match, including a suspended duplicate.
  // Malformed legacy catalogs retain the existing validation path.
  if (!Array.isArray(items) || items.some(row => !row || typeof row !== 'object')) return null;
  const rules = new Map();
  for (const row of items) {
    const key = catalogKey(row.symbol, row.exchange_type, row.business_type);
    if (!rules.has(key)) rules.set(key, row);
  }
  return rules;
}
function indexFeed(snapshot) {
  const quotes = new Map(), signals = new Map(), venues = new Map(), counts = new Map(), liveVenues = new Set(), times = [], freshTimes = [];
  for (const venue of snapshot?.exchanges || []) {
    if (!venues.has(venue.id)) venues.set(venue.id, venue.status);
    if (venue.status === 'live') liveVenues.add(venue.id);
  }
  for (const quote of snapshot?.quotes || []) {
    quotes.set(quoteKey(quote), { quote, identity: contractIdentity(quote) });
    counts.set(quote.exchange, (counts.get(quote.exchange) || 0) + 1);
    const at = quoteTime(quote);
    if (Number.isFinite(at) && at > 0) {
      times.push(at);
      // Cache only structural validity. The current time window is checked on
      // every view, including when no new snapshot arrives or the clock moves.
      if (liveVenues.has(quote.exchange) && freshQuote(quote, at)) freshTimes.push(at);
    }
  }
  for (const signal of snapshot?.signals || []) if (signal?.long && signal?.short) {
    const key = signalKey(signal, true);
    if (!signals.has(key)) signals.set(key, signal);
  }
  times.sort((a, b) => a - b); freshTimes.sort((a, b) => a - b);
  return { quotes, signals, venues, counts, times, freshTimes };
}
function latestAtOrBefore(times, upper) {
  let low = 0, high = times.length;
  while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= upper) low = mid + 1; else high = mid; }
  return low ? times[low - 1] : null;
}

// Price limits are rounded towards the reference quote, never beyond the user's
// adverse-price budget. These are previews, not fabricated exchange fills.
function priceLimit(price, side, rule, slippageBps) {
  const value = D(price).times(D(1).plus(D(slippageBps).div(10000).times(side === 'BUY' ? 1 : -1)));
  // Hyperliquid additionally limits non-integer prices to five significant
  // figures. The CrossEx tick alone can be finer than this native constraint.
  const tick = rule.symbol.startsWith('HYPERLIQUID_')
    ? Decimal.max(rule.tick_size, D(10).pow(Math.min(0, value.e - 4))) : D(rule.tick_size);
  const ticks = value.div(tick);
  const limit = (side === 'BUY' ? ticks.floor() : ticks.ceil()).times(tick);
  if (limit.lte(0)) throw new AppError('价格限制取整后无效');
  return limit.toString();
}
function checkPrice(price, rule) {
  const p = D(price);
  if (p.lte(0) || !p.mod(rule.tick_size).isZero() || rule.symbol.startsWith('HYPERLIQUID_') && !p.isInteger() && p.sd() > 5) throw new AppError('价格不满足当前合约精度，请重新预览');
}
function depthEstimate(book, side, quantity, limit) {
  let remaining = D(quantity), amount = D(0);
  for (const [p, q] of side === 'BUY' ? book.asks : book.bids) {
    const price = D(p);
    if (side === 'BUY' ? price.gt(limit) : price.lt(limit)) break;
    const take = Decimal.min(remaining, D(q)); amount = amount.plus(take.times(price)); remaining = remaining.minus(take);
    if (remaining.isZero()) break;
  }
  if (!remaining.isZero()) throw new AppError('价格限制内的盘口深度不足，请降低数量或重新预览');
  return { price: amount.div(quantity).toString(), notional: amount.toString() };
}
function commonQuantity(budget, legs, rules, fx, now) {
  const decimals = Math.max(...rules.map(r => D(r.lot_size).decimalPlaces()));
  if (decimals > 30) throw new AppError('合约数量精度超出支持范围');
  const scale = 10n ** BigInt(decimals), steps = rules.map(r => BigInt(D(r.lot_size).times(scale.toString()).toFixed(0)));
  if (steps.some(s => s <= 0n)) throw new AppError('合约数量步长无效');
  const step = steps.reduce((a, b) => a / gcd(a, b) * b);
  const caps = legs.map(l => D(budget).div(Decimal.max(l.price, l.referencePrice).times(fxRate(l.settlementCurrency, fx, now).ask)));
  for (const r of rules) if (r.max_limit_size !== null && r.max_limit_size !== undefined) caps.push(D(r.max_limit_size));
  const units = BigInt(Decimal.min(...caps).times(scale.toString()).floor().toFixed(0));
  return D((units / step * step).toString()).div(scale.toString()).toString();
}
function checkQuantity(quantity, price, rule, orderType = 'LIMIT') {
  const q = D(quantity);
  if (q.lte(0) || !q.mod(rule.lot_size).isZero() || q.lt(rule.min_size)) throw new AppError('数量未满足合约最小值或步长');
  if (rule.min_notional !== null && q.times(price).lt(rule.min_notional)) throw new AppError('数量未达到合约最小名义额');
  const maximum = orderType === 'MARKET' ? rule.max_market_size : rule.max_limit_size;
  if (maximum !== undefined && maximum !== null && q.gt(maximum)) throw new AppError('数量超过合约单笔上限，请分次手动处理');
}
function budgetValue(leg, latestPrice, fx, now, budget) {
  const price = Decimal.max(leg.price, latestPrice), rate = D(fxRate(leg.settlementCurrency, fx, now).ask);
  const value = D(leg.quantity).times(price).times(rate);
  if (value.gt(budget)) {
    const show = n => D(n).toDecimalPlaces(6, Decimal.ROUND_UP).toString();
    throw new AppError(`${leg.symbol} 订单校验金额约 ${show(value)} USDT，超过单腿预算 ${show(budget)} USDT（超出约 ${show(value.minus(budget))} USDT）。预算按数量 × 较高的委托价或盘口估值 × 汇率计算，是名义额而非保证金`, 409);
  }
  return { referencePrice: String(latestPrice), notionalUSDT: value.toString(), budgetPrice: price.toString(), budgetFxRate: rate.toString(), singleLegBudgetUSDT: D(budget).toString() };
}

/** Read-only market discovery and order previews. No private client or writer. */
export function createMarket(store, { catalogReader = loadCatalog, feedReader = loadFeed, depthReader = loadDepth,
  fxReader = loadFx, identityReader = resolveCrossexQuote,
  manualIdentityReader = identityReader === resolveCrossexQuote ? resolveManualQuote : identityReader,
  manualDepthReader = depthReader === loadDepth ? loadManualDepth : depthReader, clock = Date.now } = {}) {
  let feed = null, sourceError = '等待首次读取价差服务', sourceCheckedAt = null, sourceReceivedAt = null, sourceDurationMs = null;
  let catalog = store.get('catalog', { at: 0, items: [] }), catalogError = null, catalogAttempt = -Infinity;
  let sourceFlight = null, catalogFlight = null, generation = 0, stopping = false;
  let entryPolicyKnown = store.get('entryPolicyKnown', false);
  const recentSignals = new Map();
  let feedIndex = indexFeed(null), catalogIndex = indexCatalog(catalog.items);
  // Keep simulation controls out of both settings and production execution.
  const config = () => { const saved = store.config(); return Object.fromEntries(CONFIG_KEYS.map(k => [k, saved[k]])); };
  const revision = () => hash([config(), store.get('liveMarketRevision', 0)]);
  const catalogAvailable = () => Array.isArray(catalog.items) && catalog.items.length > 0 && catalog.at <= clock() + 1000 && clock() - catalog.at <= 900000;
  const sourceLive = (now = clock()) => !sourceError && feed && now - feed.generatedAt <= 10000 && feed.generatedAt <= now + 1000;
  function indexedValidSignal(signal, snapshot = feed, index = feedIndex, now = clock()) {
    const quotes = [signal?.long, signal?.short].flatMap(q => {
      if (!q) return [];
      const current = index.quotes.get(quoteKey(q));
      return current?.identity === contractIdentity(q) ? [current.quote] : [];
    });
    // Reuse every existing identity, venue, transfer, expiry and FX check while
    // limiting the nested quote search to the exact two current identities.
    return validSignal(signal, { ...snapshot, quotes }, now);
  }
  function refreshCatalog() {
    if (stopping) return Promise.resolve();
    if (catalogFlight) return catalogFlight;
    if (catalogAvailable() && clock() - catalog.at < 300000 || clock() - catalogAttempt < 30000) return Promise.resolve();
    catalogAttempt = clock();
    catalogFlight = (async () => {
      try {
        const items = await catalogReader();
        if (!Array.isArray(items) || !items.length || items.length > 50000) throw new AppError('CrossEx 合约目录无效');
        if (!stopping) { catalogIndex = indexCatalog(items); catalog = { at: clock(), items }; store.set('catalog', catalog); catalogError = null; }
      } catch (error) { if (!stopping) catalogError = safeMessage(error); }
    })().finally(() => { catalogFlight = null; });
    return catalogFlight;
  }
  function refreshSource() {
    if (stopping) return Promise.resolve();
    if (sourceFlight) return sourceFlight;
    const current = generation, started = clock(); sourceCheckedAt = started;
    sourceFlight = (async () => {
      try {
        const next = validateFeed(await feedReader(config(), store.decrypt(store.get('monitorPassword'))), clock());
        if (stopping || current !== generation) return;
        const nextIndex = indexFeed(next);
        feed = next; feedIndex = nextIndex; sourceError = null; sourceReceivedAt = clock();
        if (next.crossexFilter !== undefined && !entryPolicyKnown) { entryPolicyKnown = true; store.set('entryPolicyKnown', true); }
        for (const [id, s] of recentSignals) if (s.expiresAt <= clock()) recentSignals.delete(id);
        for (const s of next.signals) if (indexedValidSignal(s, next, nextIndex)) recentSignals.set(s.id, s);
        while (recentSignals.size > 800) recentSignals.delete(recentSignals.keys().next().value);
      } catch (error) { if (!stopping && current === generation) sourceError = safeMessage(error); }
      finally { if (!stopping && current === generation) sourceDurationMs = Math.max(0, clock() - started); }
    })().finally(() => { sourceFlight = null; });
    return sourceFlight;
  }
  async function refresh() { await Promise.all([refreshCatalog(), refreshSource()]); }
  function eligibility(signal, original = true, now = clock()) {
    let transfer = transferEligibility(signal, feed, now);
    if (!sourceLive(now)) return { transfer, reason: sourceError || '价差数据已过期' };
    if (entryPolicyKnown && feed.crossexFilter === undefined) return { transfer: { ...transfer, state: 'blocked' }, reason: 'Monitor 筛选策略缺失，请等待来源恢复' };
    if (original && transfer.state === 'blocked') return { transfer, reason: transfer.reason };
    const latest = feedIndex.signals.get(signalKey(signal));
    if (!latest) return { transfer, reason: 'Monitor 已撤回或不再列出此方向的机会' };
    transfer = transferEligibility(latest, feed, now);
    if (transfer.state === 'blocked') return { transfer, reason: transfer.reason };
    if (!indexedValidSignal(latest, feed, feedIndex, now) || original && !indexedValidSignal(signal, feed, feedIndex, now)) return { transfer, reason: '报价过期、合约身份不明或双腿不同步' };
    return { transfer, reason: '', latest };
  }
  function validatedRule(q, validator) {
    if (!catalogAvailable()) throw new AppError('CrossEx 合约目录未就绪或已过期');
    const exchange = typeof q?.exchange === 'string' ? q.exchange.toUpperCase() : null;
    const symbol = q?.crossexSymbol ?? (exchange ? `${exchange}_FUTURE_${q.base}_USDT` : null);
    const match = catalogIndex?.get(catalogKey(symbol, exchange, 'FUTURE'));
    return finishRule(validator(q, catalogIndex ? match ? [match] : [] : catalog.items));
  }
  const ruleFor = q => validatedRule(q, catalogRule);
  const manualRuleFor = q => validatedRule(q, manualCatalogRule);
  function finishRule(r) {
    // Older directory fixtures omit this new LIMIT-specific bound; production
    // must explicitly supply null when the exchange does not publish a maximum.
    if (r.max_limit_size !== null && !positiveDecimal(r.max_limit_size)) throw new AppError(`${r.symbol} 缺少有效的最大限价数量规则`);
    return { ...r, unverifiedConstraints: [
      ...r.unverifiedConstraints.filter(w => !w.includes('最大市价数量')),
      ...(r.max_limit_size === null ? [`${r.symbol}：目录未提供最大限价数量，最终由交易所校验`] : []),
    ] };
  }
  function candidates(signals = feed?.signals || []) {
    const c = config();
    return signals.slice(0, 200).map(signal => {
      const entry = eligibility(signal), fees = feeSnapshot(c, signal.long, signal.short);
      let grossBps = null, netBps = null, reason = entry.reason, warnings = [];
      try {
        grossBps = (referencePrice(signal.short, signal.short.bid, 'sell', feed?.fx, clock()) / referencePrice(signal.long, signal.long.ask, 'buy', feed?.fx, clock()) - 1) * 10000;
        for (const q of [signal.long, signal.short]) fxRate(settlement(q), feed?.fx, clock());
        netBps = grossBps - roundTripFeeBps(fees) - 4 * c.slippageBps;
        warnings = [ruleFor(signal.long), ruleFor(signal.short)].flatMap(r => r.unverifiedConstraints);
        if (!reason && c.entryPaused) reason = '新开仓已暂停，平仓仍可使用';
        if (!reason && netBps < c.minNetBps) reason = '预算净价差未达到开仓门槛';
      } catch (error) { reason ||= safeMessage(error); }
      return { ...signal, transfer: entry.transfer, grossBps, netBps, feeSnapshot: fees, eligible: !reason, reason, warnings };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity));
  }
  function view({ includeOpportunities = true } = {}) {
    const now = clock(), live = sourceLive(now), latestFresh = latestAtOrBefore(feedIndex.freshTimes, now + 1000);
    const hasFresh = latestFresh !== null && now - latestFresh <= 10000;
    return { now, config: { ...config(), hasMonitorPassword: !!store.get('monitorPassword') },
      source: { state: live && hasFresh ? feed.status : sourceError ? 'offline' : 'stale', error: sourceError,
        checkedAt: sourceCheckedAt, receivedAt: sourceReceivedAt, durationMs: sourceDurationMs, generatedAt: feed?.generatedAt ?? null,
        updatedAt: latestAtOrBefore(feedIndex.times, now + 1000), quoteCount: feed?.quotes.length || 0,
        entryPolicy: feed?.crossexFilter ? { ...feed.crossexFilter } : null },
      catalog: { state: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable', updatedAt: catalog.at || null, count: catalog.items.length, error: catalogError },
      venues: SUPPORTED_VENUES.map(id => ({ id, state: live ? feedIndex.venues.get(id) ?? 'unavailable' : 'offline', quoteCount: feedIndex.counts.get(id) || 0 })),
      fx: ['USDC', 'USD'].map(currency => { try { return { currency, state: 'live', ...fxRate(currency, feed?.fx, clock()) }; } catch (e) { return { currency, state: 'unavailable', error: safeMessage(e) }; } }),
      opportunities: includeOpportunities ? candidates() : [],
      fundingOpportunities: includeOpportunities ? fundingOpportunities(feed, { now, ruleFor: manualRuleFor,
        sourceReason: live ? '' : sourceError || '价差数据已过期', entryPaused: config().entryPaused, entryPolicyKnown,
        catalogExpiresAt: catalog.at + 900000,
        signals: feedIndex.signals.values(), signalValid: signal => indexedValidSignal(signal, feed, feedIndex, now) }) : [] };
  }
  async function booksAndFx(quotes, requireFx = true, reader = depthReader) {
    const [books, fx] = await Promise.all([
      Promise.all(quotes.map(q => reader(q))),
      quotes.every(q => q.quoteCurrency === 'USDT' && settlement(q) === 'USDT') ? null : Promise.resolve().then(fxReader).catch(error => { if (requireFx) throw error; return null; }),
    ]);
    validateBooks(books.length === 1 ? [books[0], books[0]] : books, clock());
    return { books, fx };
  }
  function buildLeg(q, side, positionSide, rule, book) {
    return { symbol: rule.symbol, exchange: q.exchange, base: q.base, side, positionSide,
      price: priceLimit(side === 'BUY' ? book.asks[0][0] : book.bids[0][0], side, rule, config().slippageBps),
      referencePrice: String(side === 'BUY' ? book.asks[0][0] : book.bids[0][0]),
      quoteCurrency: q.quoteCurrency, settlementCurrency: settlement(q), quote: q, rule };
  }
  async function previewOpen(signalId) {
    await refresh();
    const c = config(), marketRevision = revision();
    if (c.entryPaused) throw new AppError('新开仓已暂停，平仓仍可使用');
    const current = candidates().find(s => s.id === signalId), remembered = recentSignals.get(signalId);
    const candidate = current || (remembered ? candidates([remembered])[0] : null);
    if (!candidate?.eligible) throw new AppError(candidate?.reason || '机会已过期，请选择最新机会');
    const quotes = [candidate.long, candidate.short], rules = quotes.map(ruleFor), { books, fx } = await booksAndFx(quotes);
    await refreshSource();
    if (marketRevision !== revision()) throw new AppError('设置已变化，请重新预览', 409);
    const entry = eligibility(candidate);
    if (entry.reason) throw new AppError(entry.reason);
    validateBooks(books, clock());
    const legs = quotes.map((q, i) => buildLeg(q, i ? 'SELL' : 'BUY', i ? 'SHORT' : 'LONG', rules[i], books[i]));
    const quantity = commonQuantity(c.notionalPerLeg, legs, rules, fx, clock());
    for (const [i, leg] of legs.entries()) {
      checkPrice(leg.price, rules[i]);
      checkQuantity(quantity, leg.price, rules[i]);
      const estimate = depthEstimate(books[i], leg.side, quantity, leg.price);
      checkQuantity(quantity, estimate.price, rules[i]);
      Object.assign(leg, { quantity, ...budgetValue({ ...leg, quantity }, estimate.price, fx, clock(), c.notionalPerLeg),
        notional: D(quantity).times(leg.price).toString(), sourceAt: books[i].at });
    }
    const fees = feeSnapshot(c, ...quotes);
    const expectedNetBps = (referencePrice(quotes[1], legs[1].referencePrice, 'sell', fx, clock()) / referencePrice(quotes[0], legs[0].referencePrice, 'buy', fx, clock()) - 1) * 10000 - roundTripFeeBps(fees) - 2 * c.slippageBps;
    if (expectedNetBps < c.minNetBps) throw new AppError('复核深度后净价差未达到开仓门槛');
    return { kind: 'open', source: 'monitor', base: candidate.base, signalId, signal: candidate, marketRevision, sourceAt: Math.min(...books.map(b => b.at)), expiresAt: clock() + 30000,
      legs, expectedNetBps, feeSnapshot: fees, limits: { maxOpen: c.maxOpen, maxTotalNotional: c.maxTotalNotional, cooldownSeconds: c.cooldownSeconds },
      warnings: [...new Set(rules.flatMap(r => r.unverifiedConstraints)), '费用按已保存的预算费率估算；实际费用以账户成交回报为准', '限价 IOC 可能部分成交；未成交数量不会自动补单'] };
  }
  async function revalidateOpen(plan) {
    if (['direct', 'pair'].includes(plan.source)) return revalidateManual(plan);
    await refresh();
    if (revision() !== plan.marketRevision || config().entryPaused) throw new AppError('设置或开仓状态已变化，请重新预览', 409);
    const entry = eligibility(plan.signal, false);
    if (entry.reason) throw new AppError(entry.reason);
    const quotes = [entry.latest.long, entry.latest.short];
    const { books, fx } = await booksAndFx(quotes);
    await refreshSource();
    const finalEntry = eligibility(plan.signal, false);
    if (finalEntry.reason || revision() !== plan.marketRevision || config().entryPaused) throw new AppError(finalEntry.reason || '设置已变化，请重新预览', 409);
    validateBooks(books, clock());
    const prices = plan.legs.map((leg, i) => {
      if (contractIdentity(quotes[i]) !== contractIdentity(leg.quote)) throw new AppError('合约身份已变化，请重新预览');
      const rule = ruleFor(quotes[i]);
      checkPrice(leg.price, rule);
      checkQuantity(leg.quantity, leg.price, rule);
      const estimate = depthEstimate(books[i], leg.side, leg.quantity, leg.price);
      checkQuantity(leg.quantity, estimate.price, rule);
      return estimate.price;
    });
    const c = config(), fees = feeSnapshot(c, ...quotes);
    const net = (referencePrice(quotes[1], prices[1], 'sell', fx, clock()) / referencePrice(quotes[0], prices[0], 'buy', fx, clock()) - 1) * 10000 - roundTripFeeBps(fees) - 2 * c.slippageBps;
    if (net < c.minNetBps) throw new AppError('最新深度的净价差已不足，请重新预览');
    // Refresh valuation only; the confirmed order's quantity and price never change.
    // Runtime rechecks total exposure, margin and risk tiers using these values.
    const values = plan.legs.map((leg, i) => budgetValue(leg, prices[i], fx, clock(), c.notionalPerLeg));
    plan.legs.forEach((leg, i) => Object.assign(leg, values[i]));
    return true;
  }
  // Manual ticket and A/B hedge concepts follow your-quantguy/gate-crossex,
  // reference 423356d. Every preview remains inert until an explicit confirmation.
  async function instruments() {
    await refreshCatalog();
    if (!catalogAvailable()) throw new AppError('CrossEx 合约目录未就绪或已过期');
    return { updatedAt: catalog.at, items: catalog.items.flatMap(rule => {
      const match = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_([A-Z0-9]{1,30})_(USDT|USDC|USD)$/.exec(rule.symbol);
      if (!match || rule.state !== 'live' || rule.business_type !== 'FUTURE' || String(rule.delist_time ?? '') !== '0' || rule.exchange_type !== match[1]) return [];
      return [{ ...rule, exchange: match[1].toLowerCase(), base: match[2], quoteCurrency: match[3], settlementCurrency: match[3] }];
    }) };
  }
  async function resolveSymbol(symbol) {
    if (typeof symbol !== 'string' || symbol.length > 100) throw new AppError('请选择有效的 CrossEx 永续合约');
    await refreshCatalog();
    const quote = await manualIdentityReader(symbol);
    const rule = manualRuleFor(quote);
    if (rule.symbol !== symbol) throw new AppError('合约身份不一致');
    return { quote, rule };
  }
  async function resolveDisplaySymbol(symbol) {
    if (typeof symbol !== 'string' || symbol.length > 100) throw new AppError('请选择有效的 CrossEx 永续合约');
    await refreshCatalog();
    if (!catalogAvailable()) throw new AppError('CrossEx 合约目录未就绪或已过期');
    const exchange = symbol.split('_')[0], match = catalogIndex?.get(catalogKey(symbol, exchange, 'FUTURE'));
    const rule = finishRule(displayCatalogRule(symbol, catalogIndex ? match ? [match] : [] : catalog.items));
    const [, , base, currency] = symbol.split('_');
    // This descriptor authorizes CrossEx display only. It deliberately carries
    // no native symbol, identityVerified flag or quantity conversion factor.
    return { quote: { exchange: exchange.toLowerCase(), base, quoteCurrency: currency, settlementCurrency: currency, crossexSymbol: symbol }, rule };
  }
  // A quantity-independent, inert view of the same identity/price rules used by
  // manual previews. No preview is constructed and no private client is used.
  async function openCapacityContext(request) {
    const c = config(), marketRevision = revision();
    const resolved = await Promise.all(request.requests.map(r => resolveSymbol(r.symbol)));
    if (request.source === 'pair' && !validManualPair(resolved[0].quote, resolved[1].quote)) throw new AppError('双腿须为身份可比、同一基础币的不同交易所加密合约');
    const { books, fx } = await booksAndFx(resolved.map(r => r.quote), true, manualDepthReader);
    if (marketRevision !== revision()) throw new AppError('设置已变化，请重新读取开仓容量', 409);
    const notes = [...new Set(resolved.flatMap(r => r.rule.unverifiedConstraints))];
    let expiresAt = Math.min(catalog.at + 900000, ...books.map(b => b.at + 10000)), sourceAt = Math.min(...books.map(b => b.at));
    const legs = request.requests.map((r, i) => {
      const { quote, rule } = resolved[i], built = buildLeg(quote, r.side, r.side === 'BUY' ? 'LONG' : 'SHORT', rule, books[i]);
      const price = r.price ?? built.price;
      checkPrice(price, rule);
      const rate = fxRate(settlement(quote), fx, clock());
      if (settlement(quote) !== 'USDT') { expiresAt = Math.min(expiresAt, rate.at + Math.min(180000, fx.staleAfterMs)); sourceAt = Math.min(sourceAt, rate.at); }
      const immediate = r.orderType === 'MARKET' || ['IOC', 'FOK'].includes(r.timeInForce);
      const depthQuantity = immediate ? (r.side === 'BUY' ? books[i].asks : books[i].bids)
        .filter(([p]) => r.side === 'BUY' ? D(p).lte(price) : D(p).gte(price)).reduce((sum, [, q]) => sum.plus(q), D(0)).toString() : null;
      if (request.source === 'direct' && r.orderType === 'LIMIT' && r.price === undefined) notes.push('限价尚未填写，暂按当前盘口保护价估算');
      return { symbol: rule.symbol, side: r.side, quoteCurrency: quote.quoteCurrency, orderType: r.orderType, timeInForce: r.timeInForce,
        price, budgetPrice: Decimal.max(price, built.referencePrice).toString(), fxRate: String(rate.ask), depthQuantity, rule };
    });
    if (legs.some(l => l.orderType === 'MARKET')) notes.push('市价单按当前保护价内深度估算；实际成交价格由提交时盘口决定');
    return { base: resolved[0].quote.base, legs, config: c, marketRevision, sourceAt, expiresAt, notes };
  }
  async function manualPlan(requests, source) {
    const c = config(), marketRevision = revision();
    if (c.entryPaused) throw new AppError('新开仓已暂停，平仓仍可使用');
    const resolved = await Promise.all(requests.map(r => resolveSymbol(r.symbol)));
    if (source === 'pair' && !validManualPair(resolved[0].quote, resolved[1].quote)) throw new AppError('双腿须为身份可比、同一基础币的不同交易所加密合约');
    const quotes = resolved.map(r => r.quote), { books, fx } = await booksAndFx(quotes, true, manualDepthReader);
    if (marketRevision !== revision()) throw new AppError('设置已变化，请重新预览', 409);
    const legs = requests.map((request, i) => {
      const { quote: q, rule } = resolved[i], leg = buildLeg(q, request.side, request.side === 'BUY' ? 'LONG' : 'SHORT', rule, books[i]);
      const price = request.orderType === 'LIMIT' && request.price !== undefined ? request.price : leg.price;
      if (!positiveDecimal(price)) throw new AppError('限价须为有效的精确小数字符串');
      checkPrice(price, rule); checkQuantity(request.quantity, price, rule, request.orderType);
      const immediate = request.orderType === 'MARKET' || ['IOC', 'FOK'].includes(request.timeInForce);
      const estimate = immediate ? depthEstimate(books[i], request.side, request.quantity, price) : { price: leg.referencePrice };
      const valuation = budgetValue({ ...leg, price, quantity: request.quantity }, estimate.price, fx, clock(), c.notionalPerLeg);
      return { ...leg, price, quantity: request.quantity, orderType: request.orderType, timeInForce: request.timeInForce,
        ...valuation, notional: D(request.quantity).times(price).toString(), sourceAt: books[i].at };
    });
    return { kind: 'open', source, base: quotes[0].base, marketRevision, sourceAt: Math.min(...books.map(b => b.at)), expiresAt: clock() + 30000, legs,
      expectedNetBps: null, limits: { maxOpen: c.maxOpen, maxTotalNotional: c.maxTotalNotional, cooldownSeconds: c.cooldownSeconds },
      warnings: [...new Set(resolved.flatMap(r => r.rule.unverifiedConstraints)),
        ...(source === 'pair' ? ['双腿依次提交；首腿完全成交后才提交另一腿，部分成交需手动处理'] : []),
        ...(legs.some(l => l.orderType === 'MARKET') ? ['市价单按提交时的市场成交，预览价格不是最终成交价格或成交上限'] : []),
        ...(legs.some(l => ['GTC', 'POC'].includes(l.timeInForce)) ? ['挂单可能保持未成交，需在订单记录中手动撤单'] : [])] };
  }
  async function previewDirect(order) {
    if (!order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some(k => !['symbol', 'side', 'quantity', 'orderType', 'price', 'timeInForce'].includes(k))
      || !['BUY', 'SELL'].includes(order.side) || !['LIMIT', 'MARKET'].includes(order.orderType) || !positiveDecimal(order.quantity)
      || !['GTC', 'IOC', 'FOK', 'POC'].includes(order.timeInForce) || order.orderType === 'MARKET' && !['IOC', 'FOK'].includes(order.timeInForce)
      || order.orderType === 'LIMIT' && !positiveDecimal(order.price) || order.orderType === 'MARKET' && order.price !== undefined) throw new AppError('手动订单的方向、类型、数量、价格或有效期无效');
    return manualPlan([order], 'direct');
  }
  async function previewPair(pair) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(k => !['longSymbol', 'shortSymbol', 'quantity'].includes(k)) || !positiveDecimal(pair.quantity)) throw new AppError('双腿合约或基础币数量无效');
    return manualPlan([{ symbol: pair.longSymbol, side: 'BUY', quantity: pair.quantity, orderType: 'LIMIT', timeInForce: 'IOC' },
      { symbol: pair.shortSymbol, side: 'SELL', quantity: pair.quantity, orderType: 'LIMIT', timeInForce: 'IOC' }], 'pair');
  }
  async function revalidateManual(plan) {
    await refreshCatalog();
    const c = config();
    if (revision() !== plan.marketRevision || c.entryPaused) throw new AppError('设置或开仓状态已变化，请重新预览', 409);
    const resolved = await Promise.all(plan.legs.map(l => resolveSymbol(l.symbol)));
    if (plan.source === 'pair' && !validManualPair(resolved[0]?.quote, resolved[1]?.quote)) throw new AppError('双腿合约身份不再可比，请重新预览');
    const { books, fx } = await booksAndFx(resolved.map(r => r.quote), true, manualDepthReader);
    const values = [];
    for (const [i, leg] of plan.legs.entries()) {
      const { quote, rule } = resolved[i];
      if (contractIdentity(quote) !== contractIdentity(leg.quote)) throw new AppError('合约身份已变化，请重新预览');
      checkPrice(leg.price, rule); checkQuantity(leg.quantity, leg.price, rule, leg.orderType);
      const immediate = leg.orderType === 'MARKET' || ['IOC', 'FOK'].includes(leg.timeInForce);
      const reference = immediate ? depthEstimate(books[i], leg.side, leg.quantity, leg.price).price : leg.side === 'BUY' ? books[i].asks[0][0] : books[i].bids[0][0];
      values.push(budgetValue(leg, reference, fx, clock(), c.notionalPerLeg));
    }
    if (revision() !== plan.marketRevision || config().entryPaused) throw new AppError('设置已变化，请重新预览', 409);
    plan.legs.forEach((leg, i) => Object.assign(leg, values[i]));
    return true;
  }
  async function previewClose(position, requestedQuantity) {
    await refreshCatalog();
    if (!position || typeof position.symbol !== 'string' || !['LONG', 'SHORT'].includes(position.position_side)) throw new AppError('持仓合约或方向无效');
    const { quote: q, rule } = await resolveSymbol(position.symbol);
    if (requestedQuantity !== undefined && typeof requestedQuantity !== 'string') throw new AppError('平仓数量须为精确小数字符串');
    const held = D(position.position_qty).abs(), quantity = requestedQuantity === undefined ? held.toString() : requestedQuantity;
    if (!positiveDecimal(quantity) || D(quantity).gt(held)) throw new AppError('平仓数量必须大于零且不超过当前持仓');
    const marketRevision = revision(), { books, fx } = await booksAndFx([q], false, manualDepthReader);
    if (marketRevision !== revision()) throw new AppError('设置已变化，请重新预览', 409);
    const leg = buildLeg(q, position.position_side === 'LONG' ? 'SELL' : 'BUY', position.position_side, rule, books[0]);
    checkPrice(leg.price, rule);
    checkQuantity(quantity, leg.price, rule);
    const estimate = depthEstimate(books[0], leg.side, quantity, leg.price);
    checkQuantity(quantity, estimate.price, rule);
    let notionalUSDT = null;
    try { notionalUSDT = D(quantity).times(leg.price).times(fxRate(leg.settlementCurrency, fx, clock()).ask).toString(); } catch { /* Native reduce-only orders do not need a USD conversion. */ }
    Object.assign(leg, { quantity, referencePrice: estimate.price, notional: D(quantity).times(leg.price).toString(),
      notionalUSDT, sourceAt: books[0].at, reduceOnly: true });
    return { kind: 'close', base: q.base, marketRevision, sourceAt: books[0].at, expiresAt: clock() + 30000, legs: [leg],
      warnings: [...rule.unverifiedConstraints, ...(notionalUSDT === null ? ['汇率暂不可用，仅展示原币金额'] : []), '仅减少所选方向的仓位；限价 IOC 未成交部分继续保留，需手动处理'] };
  }
  async function revalidateClose(plan) {
    await refreshCatalog();
    if (revision() !== plan.marketRevision) throw new AppError('设置已变化，请重新预览', 409);
    for (const leg of plan.legs) {
      const { quote, rule } = await resolveSymbol(leg.symbol);
      if (contractIdentity(quote) !== contractIdentity(leg.quote)) throw new AppError('合约身份已变化，请重新预览');
      const { books } = await booksAndFx([quote], false, manualDepthReader);
      checkPrice(leg.price, rule);
      checkQuantity(leg.quantity, leg.price, rule);
      const estimate = depthEstimate(books[0], leg.side, leg.quantity, leg.price);
      checkQuantity(leg.quantity, estimate.price, rule);
    }
    if (revision() !== plan.marketRevision) throw new AppError('设置已变化，请重新预览', 409);
    return true;
  }
  async function positionsValuation(positions) {
    const active = positions.filter(p => !D(p.position_qty).isZero());
    const fx = active.some(p => !p.symbol.endsWith('_USDT')) ? await fxReader() : null;
    let total = D(0), expiresAt = Infinity;
    for (const p of active) {
      const match = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/.exec(p.symbol);
      if (!match || !positiveDecimal(p.mark_price)) throw new AppError('已有持仓的名义金额无法核实，暂不能新开仓');
      const rate = fxRate(match[2], fx, clock());
      if (match[2] !== 'USDT') expiresAt = Math.min(expiresAt, rate.at + Math.min(180000, fx.staleAfterMs));
      total = total.plus(D(p.position_qty).abs().times(p.mark_price).times(rate.ask));
    }
    return { notionalUSDT: total.toString(), expiresAt };
  }
  async function positionsNotional(positions) { return (await positionsValuation(positions)).notionalUSDT; }
  function settings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['config', 'monitorPassword', 'clearMonitorPassword'].includes(k))) throw new AppError('设置格式无效');
    if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config) || Object.keys(input.config).some(k => !CONFIG_KEYS.includes(k))) throw new AppError('实盘仅支持手动交易；设置字段无效');
    const previous = config(), next = configuration(input.config, { ...defaults, ...previous });
    if (input.monitorPassword !== undefined && (typeof input.monitorPassword !== 'string' || input.monitorPassword.length > 1024)) throw new AppError('价差服务密码无效');
    if (input.clearMonitorPassword !== undefined && typeof input.clearMonitorPassword !== 'boolean') throw new AppError('清除密码选项无效');
    const changed = previous.monitorUrl !== next.monitorUrl || previous.monitorUsername !== next.monitorUsername;
    store.transaction(() => {
      // Persist only manual settings. Any saved paper controls remain inert.
      store.set('liveMarketConfig', Object.fromEntries(CONFIG_KEYS.map(k => [k, next[k]])));
      store.set('config', { ...store.config(), ...Object.fromEntries(CONFIG_KEYS.map(k => [k, next[k]])), enabled: false });
      if (changed || input.clearMonitorPassword) store.set('monitorPassword', null);
      if (input.monitorPassword) store.set('monitorPassword', store.encrypt(input.monitorPassword));
      store.set('liveMarketRevision', store.get('liveMarketRevision', 0) + 1);
    });
    if (changed || input.clearMonitorPassword || input.monitorPassword) {
      generation++; feed = null; feedIndex = indexFeed(null); recentSignals.clear(); sourceCheckedAt = sourceReceivedAt = sourceDurationMs = null;
      entryPolicyKnown = false; store.set('entryPolicyKnown', false); sourceError = '连接设置已更改，等待重新读取';
    }
    return view({ includeOpportunities: false });
  }
  return { view, config, revision, refresh, refreshSource, refreshCatalog, instruments, resolveSymbol, resolveDisplaySymbol, openCapacityContext, previewDirect, previewPair, previewOpen, revalidateOpen, previewClose, revalidateClose, positionsNotional, positionsValuation, settings,
    async stop() { stopping = true; await Promise.all([sourceFlight, catalogFlight]); } };
}
