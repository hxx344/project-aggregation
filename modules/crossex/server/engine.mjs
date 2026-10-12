import { randomUUID, createHash } from 'node:crypto';
import { AppError, configuration, validateFeed, validSignal, pairKey, quoteKey, contractIdentity, freshQuote, quoteTime, catalogRule, commonQuantity, validateBooks, fill, partialFill, pnl, fxRate, referencePrice, notionalUSDT, storedNotional, settlement, SUPPORTED_VENUES } from './model.mjs';
import { loadCatalog, loadFeed, loadDepth, loadFx } from './clients.mjs';
import { D } from './money.mjs';
import { commonQuantityExact, transferEligibility } from './model.mjs';
import { feeSnapshot, roundTripFeeBps } from './fees.mjs';
import { createExecutionRunner, markedPnl } from './execution.mjs';
import { loadFunding } from './funding-client.mjs';
import { fundingLedger } from './funding.mjs';
import { analyticsView, sampleAnalytics } from './analytics.mjs';

const safeMessage = error => error instanceof AppError ? error.message : '读取来源失败，请检查服务连接后重试';
export function createEngine(store, { catalogReader = loadCatalog, feedReader = loadFeed, depthReader = loadDepth, fxReader = loadFx, fundingReader = loadFunding, clock = Date.now } = {}) {
  let feed = null, sourceError = '等待首次读取价差服务', sourceCheckedAt = null, catalogError = null;
  let sourceReceivedAt = null, sourceDurationMs = null;
  let catalog = store.get('catalog', { at: 0, items: [] }), catalogAttempt = 0, chain = Promise.resolve(), closing = false;
  let sourceFlight = null, sourceGeneration = 0;
  let entryPolicyKnown = store.get('entryPolicyKnown', false);
  const recentSignals = new Map();
  let indexedFeed = null, quoteIndex = new Map(), venueCounts = new Map(), cachedHistory = null;
  const historyEpoch = randomUUID();
  const calculate = (p, long, short, fx, at = clock()) => markedPnl(p, pnl(p, long, short, fx, at));
  const execution = createExecutionRunner(store, { clock, depthReader, fxReader, checkIdentity: checkPositionIdentity, checkEntry, calculate });
  let accountingFlight = null, depthFlight = null;
  const fundingAttempts = new Map();
  const quantity = (p, leg) => p[`${leg}Quantity`] ?? p.quantity;
  function effectiveFunding(p) {
    if (p.status === 'closed') return p.funding ?? fundingLedger(p, {}, clock());
    const reports = {};
    for (const leg of ['long', 'short']) {
      const report = p.fundingReports?.[leg], current = report?.current;
      // A native schedule can prove no further point settlement was due. Never extend continuous Kraken accruals.
      reports[leg] = report?.complete && p[leg].exchange !== 'kraken' && current?.intervalHours > 0 && Number.isFinite(current.sourceAt) && current.sourceAt <= clock() + 1000 && clock() - current.sourceAt <= 180000 && current.nextFundingAt > clock() && report.coveredTo >= current.nextFundingAt - current.intervalHours * 3600000
        ? { ...report, to: clock(), coveredTo: clock() } : report;
    }
    return fundingLedger(p, reports, clock());
  }
  function funded(p, result) { const funding = effectiveFunding(p); return { ...result, netWithFunding: funding.status === 'complete' && Number.isFinite(result.net) ? D(result.net).plus(funding.confirmed).toNumber() : null }; }
  function publicPosition(p) {
    const { fundingReports, quantityHistory, executionRules, ...value } = p;
    const funding = effectiveFunding(p);
    return { ...value, funding: { ...funding, entries: funding.entries.slice(-100), entryCount: funding.entries.length } };
  }
  const publicExecution = e => ({ ...e, orderCount: e.orders.length, fillCount: e.fills.length, orders: e.orders.slice(-100).map(({ receipt, ...order }) => order), fills: e.fills.slice(-100) });
  function indexFeed() {
    if (indexedFeed === feed) return;
    indexedFeed = feed; quoteIndex = new Map(); venueCounts = new Map();
    for (const q of feed?.quotes || []) { quoteIndex.set(quoteKey(q), q); venueCounts.set(q.exchange, (venueCounts.get(q.exchange) || 0) + 1); }
  }
  function historyView(knownVersion) {
    const eventId = store.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id;
    const closed = store.prepare("SELECT count(*) AS count,max(json_extract(json,'$.closedAt')) AS at FROM positions WHERE status='closed'").get();
    const version = [historyEpoch, eventId, closed.count, closed.at || 0, store.get('historyRevision', 0)].join(':');
    if (version === knownVersion) return { historyVersion: version };
    if (cachedHistory?.historyVersion !== version) cachedHistory = { historyVersion: version, history: store.positions('closed', 200).map(publicPosition), events: store.prepare('SELECT at,message FROM events ORDER BY id DESC LIMIT 100').all(), analytics: analyticsView(store, config()) };
    return cachedHistory;
  }
  // Simulation actions remain serialized; read-only source refreshes have their own lane.
  const serial = action => { const result = chain.then(() => { if (closing) throw new AppError('服务正在关闭', 503); return action(); }); chain = result.catch(() => {}); return result; };
  const config = () => store.config();
  function catalogAvailable() { return Array.isArray(catalog.items) && catalog.items.length > 0 && catalog.at <= clock() + 1000 && clock() - catalog.at <= 900000; }
  async function refreshCatalog() {
    if (clock() - catalog.at < 300000 && catalogAvailable()) return;
    if (catalogAttempt && clock() - catalogAttempt < 30000) return;
    catalogAttempt = clock();
    try { const items = await catalogReader(); if (!Array.isArray(items) || !items.length || items.length > 50000) throw new AppError('CrossEx 合约目录无效'); catalog = { at: clock(), items }; store.set('catalog', catalog); catalogError = null; }
    catch (error) { catalogError = safeMessage(error); }
  }
  async function refreshFeed(generation) {
    const startedAt = clock(); sourceCheckedAt = startedAt;
    try {
      const next = await feedReader(config(), store.decrypt(store.get('monitorPassword')));
      if (closing || generation !== sourceGeneration) return;
      feed = validateFeed(next, clock()); sourceError = null; sourceReceivedAt = clock();
      if (feed.crossexFilter !== undefined && !entryPolicyKnown) { entryPolicyKnown = true; store.set('entryPolicyKnown', true); }
      for (const [id, signal] of recentSignals) if (!Number.isFinite(signal.expiresAt) || signal.expiresAt < clock()) recentSignals.delete(id);
      for (const signal of feed.signals) if (validSignal(signal, feed, clock())) recentSignals.set(signal.id, signal);
      while (recentSignals.size > 800) recentSignals.delete(recentSignals.keys().next().value);
    }
    catch (error) { if (!closing && generation === sourceGeneration) sourceError = safeMessage(error); }
    finally { if (!closing && generation === sourceGeneration) sourceDurationMs = Math.max(0, clock() - startedAt); }
  }
  function refreshSource() {
    if (closing) return Promise.resolve();
    // Slow reads are shared, never queued. A settings change invalidates both
    // successful and failed responses from the previous connection.
    if (!sourceFlight) sourceFlight = refreshFeed(sourceGeneration).finally(() => { sourceFlight = null; });
    return sourceFlight;
  }
  function sourceLive() { return !sourceError && feed && clock() - feed.generatedAt <= 10000 && feed.generatedAt <= clock() + 1000; }
  function entryEligibility(signal, original = true) {
    let transfer = transferEligibility(signal, feed, clock());
    if (entryPolicyKnown && feed?.crossexFilter === undefined) transfer = { ...transfer, state: 'blocked', reason: 'Monitor 筛选策略缺失，等待恢复；不能沿用旧资格' };
    if (!sourceLive()) return { transfer, reason: sourceError || '价差信号已经过期' };
    if (transfer.state === 'blocked' && original) return { transfer, reason: transfer.reason };
    const latest = feed.signals.find(current => current.pairKey === pairKey(signal)
      && contractIdentity(current.long) === contractIdentity(signal.long) && contractIdentity(current.short) === contractIdentity(signal.short));
    if (!latest) return { transfer, reason: 'Monitor 已撤回或不再列出此方向的机会，请等待新机会' };
    transfer = transferEligibility(latest, feed, clock());
    if (entryPolicyKnown && feed.crossexFilter === undefined) return { transfer: { ...transfer, state: 'blocked' }, reason: 'Monitor 筛选策略缺失，等待恢复；不能沿用旧资格' };
    if (transfer.state === 'blocked') return { transfer, reason: transfer.reason };
    if (!validSignal(latest, feed, clock()) || (original && !validSignal(signal, feed, clock()))) return { transfer, reason: '报价过期、身份不明、下架或双腿不同步' };
    return { transfer, reason: '', latest };
  }
  // Staged execution authorizes each new receipt with the current pair, not the
  // ten-second signal used when the task was created. Reconciliation/exit bypass it.
  async function checkEntry(p) {
    await refreshSource();
    if (config().entryPaused) throw new AppError('新仓已暂停，停止新增开仓分片');
    const eligibility = entryEligibility(p, false);
    if (eligibility.reason) throw new AppError(eligibility.reason);
    if (!catalogAvailable()) throw new AppError('CrossEx 合约目录已过期，停止新增开仓分片');
    for (const q of [p.long, p.short]) catalogRule(q, catalog.items);
    p.entryTransfer = eligibility.transfer;
    p.entryFilter = feed.crossexFilter ?? null;
  }
  function candidates(signals = feed?.signals || []) {
    if (!feed) return [];
    const c = config();
    return signals.slice(0, 200).map(signal => {
      let grossBps = NaN, reason = '', warnings = [];
      const eligibility = entryEligibility(signal);
      try { grossBps = (referencePrice(signal.short, signal.short.bid, 'sell', feed.fx, clock()) / referencePrice(signal.long, signal.long.ask, 'buy', feed.fx, clock()) - 1) * 10000; for (const q of [signal.long, signal.short]) fxRate(settlement(q), feed.fx, clock()); } catch (error) { reason = safeMessage(error); }
      const fees = feeSnapshot(c, signal.long, signal.short), netBps = grossBps - roundTripFeeBps(fees) - 4 * c.slippageBps;
      if (eligibility.reason) reason = eligibility.reason;
      else if (!catalogAvailable()) reason = '等待有效的 CrossEx 合约目录';
      else if (!reason) { try { warnings = [catalogRule(signal.long, catalog.items), catalogRule(signal.short, catalog.items)].flatMap(rule => rule.unverifiedConstraints); } catch (error) { reason = safeMessage(error); } }
      if (!reason && netBps < c.minNetBps) reason = '扣除往返费用与滑点预算后未达开仓阈值';
      return { ...signal, transfer: eligibility.transfer, grossBps: Number.isFinite(grossBps) ? grossBps : null, netBps: Number.isFinite(netBps) ? netBps : null, feeSnapshot: fees, eligible: !reason, reason, warnings };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity) || a.pairKey.localeCompare(b.pairKey));
  }
  function valuation(p) {
    if (p.status === 'closed') return { at: p.closedAt, stale: false, ...p.result };
    indexFeed();
    const long = quoteIndex.get(quoteKey(p.long)), short = quoteIndex.get(quoteKey(p.short));
    const quoteTimes = { long: Number.isFinite(quoteTime(long)) ? quoteTime(long) : null, short: Number.isFinite(quoteTime(short)) ? quoteTime(short) : null };
    const old = reason => ({ ...(p.lastValuation || { at: null, net: null }), stale: true, reason, quoteTimes });
    if (!sourceLive()) return old(sourceError || '价差数据包超过 10 秒，等待来源更新');
    for (const [q, leg] of [[long, p.long], [short, p.short]]) {
      if (!q) return old(`${leg.exchange} 缺少该合约盘口`);
      if (contractIdentity(q) !== contractIdentity(leg)) return old(`${leg.exchange} 合约身份已变化`);
      if (!freshQuote(q, clock())) {
        const at = quoteTime(q);
        if (Number.isFinite(at) && at > 0 && clock() - at > 10000) return old(`${leg.exchange} 盘口已 ${((clock() - at) / 1000).toFixed(1)} 秒未更新`);
        if (at > clock() + 1000) return old(`${leg.exchange} 盘口时间领先服务器超过 1 秒`);
        return old(`${leg.exchange} 盘口价格、时间或合约身份无效`);
      }
      if (!feed.exchanges.some(x => x.id === q.exchange && x.status === 'live')) return old(`${leg.exchange} 行情连接未就绪`);
    }
    const gap = Math.abs(quoteTime(long) - quoteTime(short));
    if (gap > 5000) return old(`双腿盘口相差 ${(gap / 1000).toFixed(1)} 秒，超过 5 秒同步要求`);
    try { return { at: Math.min(quoteTime(long), quoteTime(short)), stale: false, quoteTimes, spreadBps: (referencePrice(short, short.ask, 'buy', feed.fx, clock()) / referencePrice(long, long.bid, 'sell', feed.fx, clock()) - 1) * 10000, ...funded(p, calculate(p, long.bid, short.ask, feed.fx)) }; } catch (error) { return old(safeMessage(error)); }
  }
  function totals(positions, marks = null) {
    const open = positions.filter(p => p.status === 'open');
    marks ??= open.map(valuation);
    const closed = store.closedTotals(), tasks = execution.active();
    const unrealizedPnl = marks.some(x => x.stale || x.net === null) ? null : marks.reduce((n, p) => n + p.net, 0);
    const realizedWithFunding = closed.fundingUnknown ? null : closed.realizedPnl + closed.fundingKnown;
    const unrealizedWithFunding = marks.some(x => x.stale || !Number.isFinite(x.netWithFunding)) ? null : marks.reduce((n, p) => n + p.netWithFunding, 0);
    const usedNotional = open.reduce((sum, p) => ['long', 'short'].reduce((n, leg) => { const filled = p[`${leg}Fill`]; return D(filled.quantity ?? 0).isZero() ? n : n.plus(D(storedNotional(filled)).mul(quantity(p, leg)).div(filled.exact?.quantity ?? filled.quantity)); }, sum), D(0)).toNumber();
    const funding = open.map(effectiveFunding);
    return { openCount: open.length, ...closed, usedNotional, unrealizedPnl, stalePositions: marks.filter(x => x.stale).length,
      fundingKnown: closed.fundingKnown + funding.reduce((n, f) => n + f.known, 0), fundingComplete: !closed.fundingUnknown && funding.every(f => f.status === 'complete'), realizedWithFunding, unrealizedWithFunding,
      netWithFunding: realizedWithFunding === null || unrealizedWithFunding === null ? null : realizedWithFunding + unrealizedWithFunding,
      reservedNotional: tasks.reduce((n, e) => n + e.reservedNotional, 0), activeExecutions: tasks.length };
  }
  function view({ includeHistory = true, historyVersion } = {}) {
    indexFeed();
    const positions = store.positions('open'), publicConfig = { ...config(), hasMonitorPassword: !!store.get('monitorPassword') };
    const sourceTimes = (feed?.quotes || []).map(quoteTime).filter(at => Number.isFinite(at) && at > 0 && at <= clock() + 1000);
    const hasFreshSource = (feed?.quotes || []).some(q => freshQuote(q, clock()) && feed.exchanges.some(x => x.id === q.exchange && x.status === 'live'));
    const venues = SUPPORTED_VENUES.map(id => { const upstream = feed?.exchanges.find(x => x.id === id); return { id, state: sourceLive() ? upstream?.status ?? 'unavailable' : 'offline', quoteCount: venueCounts.get(id) || 0 }; });
    const fx = ['USDC', 'USD'].map(currency => { try { return { currency, state: 'live', ...fxRate(currency, feed?.fx, clock()) }; } catch (error) { return { currency, state: 'unavailable', error: safeMessage(error) }; } });
    return { mode: 'paper', liveTradingAvailable: false, now: clock(), venues, fx, config: publicConfig, executions: store.executions().map(publicExecution), source: { state: sourceLive() && hasFreshSource ? feed.status : sourceError ? 'offline' : 'stale', error: sourceError, checkedAt: sourceCheckedAt, receivedAt: sourceReceivedAt, durationMs: sourceDurationMs, generatedAt: feed?.generatedAt ?? null, updatedAt: sourceTimes.length ? Math.max(...sourceTimes) : null, quoteCount: feed?.quotes.length || 0, entryPolicy: feed?.crossexFilter && typeof feed.crossexFilter.requireSpotTransfer === 'boolean' && Array.isArray(feed.crossexFilter.blockedBases) ? { requireSpotTransfer: feed.crossexFilter.requireSpotTransfer, blockedBases: feed.crossexFilter.blockedBases.filter(base => typeof base === 'string'), excluded: Number.isSafeInteger(feed.crossexFilter.excluded) ? feed.crossexFilter.excluded : 0, revision: feed.crossexFilter.revision } : null }, catalog: { state: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable', updatedAt: catalog.at || null, count: catalog.items.length, error: catalogError }, totals: totals(positions), opportunities: candidates(), positions: positions.filter(p => p.status === 'open').map(p => ({ ...publicPosition(p), exitQuote: p.exitQuote ? { ...p.exitQuote, stale: p.exitQuote.stale || clock() - p.exitQuote.sourceAt > 10000 } : undefined, valuation: valuation(p) })), ...(includeHistory ? historyView(historyVersion) : {}) };
  }
  // Read only the open positions and aggregate totals; no candidate ranking or history payload.
  function summary() {
    indexFeed();
    const now = clock(), positions = store.positions('open'), marks = positions.map(valuation), value = totals(positions, marks), messages = [];
    const liveVenues = new Set(feed?.exchanges.filter(x => x.status === 'live').map(x => x.id));
    let oldest = Infinity, latestFresh = -Infinity, fresh = 0, expired = 0;
    for (const q of quoteIndex.values()) {
      const at = quoteTime(q);
      if (Number.isFinite(at) && at > 0 && at <= now + 1000) oldest = Math.min(oldest, at);
      if (freshQuote(q, now) && liveVenues.has(q.exchange)) { fresh++; latestFresh = Math.max(latestFresh, at); }
      else expired++;
    }
    let state = !feed || sourceError ? 'offline' : !sourceLive() || !fresh ? 'stale' : 'online';
    let updatedAt = oldest;
    if (state === 'online') {
      // A partial feed is still active while usable quotes arrive. Neither a
      // request heartbeat nor a newer unrelated quote may freshen held PnL.
      updatedAt = Math.min(feed.generatedAt, latestFresh);
      if (value.unrealizedPnl !== null) for (const mark of marks) updatedAt = Math.min(updatedAt, mark.at);
    }
    if (sourceError) messages.push(sourceError);
    if (expired) messages.push(expired + ' 条盘口过期、无效或交易所未连接');
    const unavailable = feed?.exchanges.filter(x => x.status !== 'live').map(x => x.id) || [];
    if (unavailable.length) messages.push('行情异常：' + unavailable.join('、'));
    if (feed?.status !== 'live' && feed) messages.push('行情源状态：' + feed.status);
    if (!catalogAvailable() || catalogError) messages.push(catalogError || 'CrossEx 合约目录未就绪或已过期');
    if (value.stalePositions) messages.push(value.stalePositions + ' 组持仓估值过期');
    if (state === 'online' && messages.length) state = 'partial';
    return { updatedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null,
      health: { state, message: messages.join('；') || '行情与合约目录正常', staleAfterSeconds: 10 }, metrics: [
        { key: 'mode', label: '执行模式', value: config().enabled ? '自动模拟' : '模拟已暂停', detail: '仅本地模拟，不发送交易所订单' },
        { key: 'source', label: '价差信号', value: state, detail: messages.join('；') || '七所同币种永续，按实际汇率折算 USDT' },
        { key: 'positions', label: '模拟持仓', value: value.openCount, unit: '组' },
        { key: 'realized', label: '模拟已实现盈亏', value: value.realizedPnl, unit: 'USDT', detail: '已扣手续费，未含资金费；不计入资产账本' },
        { key: 'unrealized', label: '模拟浮动盈亏', value: value.unrealizedPnl, unit: 'USDT', detail: '按平仓方向盘口估值；过期时不汇总' },
        { key: 'catalog', label: 'CrossEx 目录', value: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable' },
      ] };
  }
  function requestResult(requestId, fingerprint) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(requestId)) throw new AppError('缺少有效的请求编号');
    const row = store.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
    if (row && row.fingerprint !== fingerprint) throw new AppError('请求编号已用于其他操作', 409);
    if (!row) return null;
    const value = JSON.parse(row.result);
    return value.executionRef ? store.findExecution(value.executionRef) : value;
  }
  const saveResult = (id, fingerprint, result) => store.prepare('INSERT INTO requests VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result));
  async function open(signalId, requestId) {
    const fingerprint = `open:${signalId}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    await refreshSource();
    const c = config(), remembered = recentSignals.get(signalId);
    if (c.entryPaused) throw new AppError('新仓已暂停，已有持仓仍可管理');
    // A browser and the collector need not poll in phase. Keep the exact server-seen
    // quote version only until its original expiry, then recheck current depth.
    const stillListed = remembered && [remembered.long, remembered.short].every(q => feed?.quotes.some(current => contractIdentity(current) === contractIdentity(q) && current.identityVerified === true && !current.delisting && !current.delistingAt));
    const candidate = candidates().find(s => s.id === signalId) || (stillListed ? candidates([remembered])[0] : null);
    if (!candidate?.eligible) throw new AppError(candidate?.reason || '机会已变化，请刷新后重新选择');
    const active = store.positions('open'), positions = [...active, ...store.positions('closed', 200)];
    if (active.length >= c.maxOpen) throw new AppError('已达到最大持仓数量');
    if (store.hasSignal(signalId)) throw new AppError('这份信号已执行过模拟', 409);
    if (active.some(p => p.base === candidate.base)) throw new AppError('该币种已有模拟持仓，不重复或反向开仓', 409);
    if (store.coolingBases(clock() - c.cooldownSeconds * 1000).includes(candidate.base)) throw new AppError('该币种仍在开仓冷却期');
    const rules = [catalogRule(candidate.long, catalog.items), catalogRule(candidate.short, catalog.items)];
    const legs = [candidate.long, candidate.short];
    const [books, fx] = await Promise.all([Promise.all(legs.map(q => depthReader(q))), legs.every(q => q.quoteCurrency === 'USDT' && settlement(q) === 'USDT') ? null : fxReader()]);
    await refreshSource();
    const eligibility = entryEligibility(candidate);
    if (eligibility.reason || !catalogAvailable()) throw new AppError(`深度检查期间信号过期或资格变化：${eligibility.reason || 'CrossEx 合约目录已过期'}`);
    validateBooks(books, clock());
    const prices = [books[0].asks[0][0], books[1].bids[0][0]];
    const quantity = commonQuantityExact(c.notionalPerLeg, prices, rules, legs.map((q, i) => notionalUSDT(q, prices[i], fx, clock())));
    const staged = c.executionMode === 'staged';
    const longFill = fill(staged ? [[prices[0], quantity]] : books[0].asks, quantity, 'buy', c.slippageBps), shortFill = fill(staged ? [[prices[1], quantity]] : books[1].bids, quantity, 'sell', c.slippageBps);
    for (const [i, filled] of [longFill, shortFill].entries()) { filled.notionalUSDT = notionalUSDT(legs[i], filled.notional, fx, clock()); if (rules[i].min_notional !== null && filled.notional < Number(rules[i].min_notional)) throw new AppError('逐档成交未满足最小名义额'); }
    if (Math.max(longFill.notionalUSDT, shortFill.notionalUSDT) > c.notionalPerLeg + 1e-8) throw new AppError('逐档成交名义额超过单腿额度');
    const entryGrossBps = (referencePrice(candidate.short, shortFill.price, 'sell', fx, clock()) / referencePrice(candidate.long, longFill.price, 'buy', fx, clock()) - 1) * 10000;
    const fees = feeSnapshot(c, candidate.long, candidate.short);
    if (entryGrossBps - roundTripFeeBps(fees) - 2 * c.slippageBps < c.minNetBps) throw new AppError('重新检查深度后净价差不足');
    const total = totals(positions), reservation = staged ? c.notionalPerLeg * 2 : longFill.notionalUSDT + shortFill.notionalUSDT;
    if (D(total.usedNotional).plus(total.reservedNotional).plus(reservation).gt(c.maxTotalNotional)) throw new AppError('已达到双腿总名义额上限');
    const entryFees = D(longFill.notionalUSDT).mul(fees.long.entry.bps).plus(D(shortFill.notionalUSDT).mul(fees.short.entry.bps)).div(10000);
    const p = { accountingVersion: 3, id: randomUUID(), signalId, pairKey: pairKey(candidate), base: candidate.base, status: 'open', openedAt: clock(), quantity: Number(quantity), quantityExact: quantity, longQuantity: String(quantity), shortQuantity: String(quantity), long: candidate.long, short: candidate.short, crossexSymbols: rules.map(x => x.symbol), executionRules: rules, unverifiedConstraints: rules.flatMap(r => r.unverifiedConstraints), longFill, shortFill, entryFx: fx, depthAt: books.map(x => x.at), feeBps: c.feeBps, feeSnapshot: fees, slippageBps: c.slippageBps, takeProfitBps: c.takeProfitBps, stopLossBps: c.stopLossBps, maxHoldMinutes: c.maxHoldMinutes, entryFees: entryFees.toNumber(), entryFeesExact: entryFees.toString(), entryGrossBps, fundingPnl: null };
    p.entryTransfer = eligibility.transfer; p.entryFilter = feed.crossexFilter ?? null;
    if (staged) { p.longQuantity = p.shortQuantity = '0'; p.longFill = { quantity: 0, price: null, notional: 0, notionalUSDT: 0 }; p.shortFill = { ...p.longFill }; p.entryFees = 0; p.entryFeesExact = '0'; }
    p.quantityHistory = [{ at: p.openedAt, longQuantity: p.longQuantity, shortQuantity: p.shortQuantity, fx }];
    p.funding = fundingLedger(p, {}, clock());
    let task;
    store.transaction(() => { store.savePosition(p); if (staged) { task = execution.create(p, 'open', c); task.automatic = requestId.startsWith('auto-open:'); store.saveExecution(task); } saveResult(requestId, fingerprint, task ? { executionRef: task.id } : p); store.event(clock(), `${p.base} ${staged ? '已创建分阶段模拟任务，等待逐腿成交' : `已模拟开仓，双腿各 ${quantity}；按可见深度全量撮合`}`); });
    return task ?? p;
  }
  function checkPositionIdentity(p) {
    for (const q of [p.long, p.short]) { const current = feed?.quotes.find(x => quoteKey(x) === quoteKey(q)); if (current && contractIdentity(current) !== contractIdentity(q)) throw new AppError('合约身份或结算规则发生变化，暂停此持仓操作'); }
  }
  async function closePosition(id, requestId, reason = '手动平仓') {
    const fingerprint = `close:${id}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    const p = store.findPosition(id);
    if (!p || p.status !== 'open') throw new AppError('持仓不存在或已经平仓', 409);
    if (execution.active().some(e => e.positionId === p.id)) throw new AppError('该持仓仍有执行任务，请先完成或撤销并对账', 409);
    if (config().executionMode === 'staged') {
      checkPositionIdentity(p);
      if (reason === '达到止盈') {
        const [books, fx] = await Promise.all([Promise.all([p.long, p.short].map(depthReader)), [p.long, p.short].every(q => settlement(q) === 'USDT') ? null : fxReader()]);
        checkPositionIdentity(p); validateBooks(books, clock());
        const empty = { quantity: 0, price: null, notional: 0 };
        const long = D(quantity(p, 'long')).isZero() ? empty : fill(books[0].bids, quantity(p, 'long'), 'sell', p.slippageBps), short = D(quantity(p, 'short')).isZero() ? empty : fill(books[1].asks, quantity(p, 'short'), 'buy', p.slippageBps);
        if (calculate(p, long, short, fx).net / storedNotional(p.longFill) * 10000 < p.takeProfitBps) throw new AppError('深度复核后尚未达到止盈，继续持有');
      }
      let task; store.transaction(() => { task = execution.create(p, 'close', config(), reason); task.automatic = requestId.startsWith('auto-close:'); store.saveExecution(task); saveResult(requestId, fingerprint, { executionRef: task.id }); }); return task;
    }
    checkPositionIdentity(p);
    const [books, fx] = await Promise.all([Promise.all([depthReader(p.long), depthReader(p.short)]), [p.long, p.short].every(q => settlement(q) === 'USDT') ? null : fxReader()]);
    checkPositionIdentity(p);
    validateBooks(books, clock());
    const empty = { quantity: 0, price: null, notional: 0 };
    const longExit = D(quantity(p, 'long')).isZero() ? empty : fill(books[0].bids, quantity(p, 'long'), 'sell', p.slippageBps), shortExit = D(quantity(p, 'short')).isZero() ? empty : fill(books[1].asks, quantity(p, 'short'), 'buy', p.slippageBps);
    const result = calculate(p, longExit, shortExit, fx);
    // Profit-triggered exits are rechecked after fetching independent depth snapshots.
    if (reason === '达到止盈' && result.net / storedNotional(p.longFill) * 10000 < p.takeProfitBps) throw new AppError('深度复核后尚未达到止盈，继续持有');
    const closed = { ...p, status: 'closed', closedAt: clock(), reason, longExit, shortExit, exitFx: fx, exitDepthAt: books.map(x => x.at), result, longQuantity: '0', shortQuantity: '0', quantityHistory: [...(p.quantityHistory || [{ at: p.openedAt, longQuantity: String(p.quantity), shortQuantity: String(p.quantity), fx: p.entryFx }]), { at: clock(), longQuantity: '0', shortQuantity: '0', fx }] };
    closed.funding = fundingLedger(closed, p.fundingReports, clock()); closed.result = funded(closed, result);
    store.transaction(() => { store.savePosition(closed); saveResult(requestId, fingerprint, closed); store.event(clock(), `${p.base} ${reason}，模拟净盈亏 ${result.net.toFixed(4)} USDT（未含资金费）`); });
    return closed;
  }
  async function tick({ refreshSource: readSource = true } = {}) {
    await Promise.all([refreshCatalog(), readSource ? refreshSource() : undefined]);
    for (const task of execution.active()) {
      const held = store.findPosition(task.positionId);
      if (config().enabled && task.kind === 'open' && !task.cancelRequested && held && clock() - held.openedAt >= held.maxHoldMinutes * 60000) execution.action(task.id, 'cancel');
      await execution.advance(task.id);
    }
    const positions = store.positions('open');
    for (const p of positions) {
      const value = valuation(p);
      if (!value.stale) store.savePosition({ ...p, lastValuation: value });
      const task = execution.active().find(e => e.positionId === p.id);
      if (task && !value.stale && Number.isFinite(value.net)) { task.worstLoss = Math.max(task.worstLoss ?? 0, -value.net, 0); store.saveExecution(task); }
      if (!config().enabled || execution.active().some(e => e.positionId === p.id)) continue;
      const bps = value.stale ? null : value.net / storedNotional(p.longFill) * 10000;
      const reason = clock() - p.openedAt >= p.maxHoldMinutes * 60000 ? '达到最长持有时间' : bps !== null && bps >= p.takeProfitBps ? '达到止盈' : bps !== null && bps <= -p.stopLossBps ? '达到止损' : '';
      if (reason) { try { const attempt = store.prepare("SELECT count(*) AS n FROM executions WHERE position_id=? AND state='cancelled' AND json_extract(json,'$.kind')='close'").get(p.id).n; await closePosition(p.id, `auto-close:${p.id}:${attempt}`, reason); } catch (error) { recordFailure(`${p.base} 自动平仓未完成：${safeMessage(error)}`); } }
    }
    if (config().enabled && !config().entryPaused) {
      const active = store.positions('open');
      const busyBases = new Set([...active.map(p => p.base), ...store.coolingBases(clock() - config().cooldownSeconds * 1000)]);
      for (const [key, until] of retryAfter) if (until <= clock()) retryAfter.delete(key);
      const candidate = active.length < config().maxOpen ? candidates().find(s => s.eligible && !busyBases.has(s.base) && !store.hasSignal(s.id) && !retryAfter.has(s.pairKey)) : null;
      if (candidate) { try { await open(candidate.id, `auto-open:${createHash('sha256').update(candidate.id).digest('hex')}`); } catch (error) { retryAfter.set(candidate.pairKey, clock() + 30000); recordFailure(`${candidate.base} 自动开仓未完成：${safeMessage(error)}`); } }
    }
    const sampled = store.positions('open').map(p => ({ ...p, valuation: valuation(p) }));
    sampleAnalytics(store, sampled, totals(sampled, sampled.map(p => p.valuation)), clock());
    return view();
  }
  const retryAfter = new Map();
  let lastFailure = '', lastFailureAt = 0;
  function recordFailure(message) { if (message !== lastFailure || clock() - lastFailureAt > 60000) { store.event(clock(), message); lastFailure = message; lastFailureAt = clock(); } }
  function refreshAccounting() {
    if (closing || !config().fundingEnabled) return Promise.resolve();
    if (accountingFlight) return accountingFlight;
    // Public accounting has its own lane and cannot delay risk exits or source polling.
    const pending = store.prepare("SELECT json FROM positions WHERE json_extract(json,'$.accountingVersion')>=3 AND (status='open' OR coalesce(json_extract(json,'$.funding.status'),'unknown')!='complete') ORDER BY coalesce(json_extract(json,'$.fundingCheckedAt'),0) ASC LIMIT 10").all().map(row => JSON.parse(row.json))
      .filter(p => clock() - Math.max(p.fundingCheckedAt ?? 0, fundingAttempts.get(p.id) ?? 0) >= 60000).slice(0, 1);
    accountingFlight = Promise.all(pending.map(async original => {
      fundingAttempts.set(original.id, clock());
      const end = original.closedAt ?? clock(), reports = {};
      await Promise.all(['long', 'short'].map(async leg => { try { reports[leg] = await fundingReader(original[leg], original.openedAt, end); } catch { reports[leg] = null; } }));
      if (closing) return;
      await serial(() => {
        const p = store.findPosition(original.id); if (!p) return;
        // Do not claim coverage for fills that happened after this public-data request.
        const through = Math.min(end, p.closedAt ?? clock());
        for (const leg of ['long', 'short']) {
          const old = p.fundingReports?.[leg], next = reports[leg];
          if (!old || next?.complete) continue;
          if (!next || next.coveredFrom === null) { reports[leg] = { ...old, complete: false, to: through, current: next?.current ?? old.current, error: next?.error ?? '读取失败，保留此前已确认结算' }; continue; }
          const merge = name => [...new Map([...(old[name] || []), ...(next[name] || [])].map(row => [JSON.stringify(row), row])).values()];
          reports[leg] = { ...next, settlements: merge('settlements'), accruals: merge('accruals'), coveredFrom: Math.min(old.coveredFrom ?? Infinity, next.coveredFrom), coveredTo: Math.max(old.coveredTo ?? 0, next.coveredTo ?? 0) };
        }
        p.fundingReports = reports; p.funding = fundingLedger(p, reports, through); p.fundingCheckedAt = clock();
        if (p.status === 'closed') { if (end < p.closedAt) p.funding = { ...p.funding, status: 'partial', confirmed: null, estimated: null, reason: '等待覆盖最终平仓时刻的资金费记录' }; p.result = funded(p, p.result); }
        p.fundingPnl = p.funding.confirmed;
        store.transaction(() => { store.savePosition(p); store.revision(); });
      });
    })).catch(error => { if (!closing) recordFailure(`资金费更新未完成：${safeMessage(error)}`); }).finally(() => { accountingFlight = null; });
    return accountingFlight;
  }
  function refreshValuations() {
    if (closing) return Promise.resolve();
    if (depthFlight) return depthFlight;
    const pending = store.positions('open').filter(p => !p.exitQuote || p.exitQuote.stale || clock() - p.exitQuote.at >= config().depthRefreshSeconds * 1000);
    depthFlight = Promise.all(pending.map(async original => {
      let books, fx, error;
      try { [books, fx] = await Promise.all([Promise.all([original.long, original.short].map(depthReader)), [original.long, original.short].every(q => settlement(q) === 'USDT') ? null : fxReader()]); validateBooks(books, clock()); }
      catch (failure) { error = safeMessage(failure); }
      if (closing) return;
      await serial(() => {
        const p = store.findPosition(original.id); if (!p || p.status !== 'open') return;
        try {
          if (error) throw new AppError(error);
          checkPositionIdentity(p); validateBooks(books, clock());
          const empty = { quantity: 0, remaining: 0, price: null, notional: 0 };
          const long = D(quantity(p, 'long')).isZero() ? empty : partialFill(books[0].bids, quantity(p, 'long'), 'sell', p.slippageBps);
          const short = D(quantity(p, 'short')).isZero() ? empty : partialFill(books[1].asks, quantity(p, 'short'), 'buy', p.slippageBps);
          const complete = !long.remaining && !short.remaining;
          const value = complete ? funded(p, calculate(p, long, short, fx)) : null;
          p.exitQuote = { at: clock(), sourceAt: Math.min(...books.map(b => b.at)), stale: false, complete, net: value?.netWithFunding ?? null, priceOnlyNet: value?.net ?? null,
            longQuantity: long.quantity, shortQuantity: short.quantity, reason: complete ? null : '滑点预算内深度不足，不能按此快照全部退出',
            slippageBps: { long: long.price === null ? 0 : (1 - long.price / books[0].bids[0][0]) * 10000, short: short.price === null ? 0 : (short.price / books[1].asks[0][0] - 1) * 10000 } };
        } catch (failure) { p.exitQuote = { ...(p.exitQuote || {}), at: clock(), stale: true, complete: false, net: null, priceOnlyNet: null, reason: safeMessage(failure) }; }
        store.savePosition(p);
      });
    })).catch(error => { if (!closing) recordFailure(`深度估值未完成：${safeMessage(error)}`); }).finally(() => { depthFlight = null; });
    return depthFlight;
  }
  function executionAction(id, action, requestId) {
    const fingerprint = `execution:${id}:${action}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    let result; store.transaction(() => { result = execution.action(id, action); saveResult(requestId, fingerprint, { executionRef: result.id }); }); return result;
  }
  function settings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['config', 'monitorPassword', 'clearMonitorPassword'].includes(k))) throw new AppError('设置格式无效');
    const previous = config(), next = configuration(input.config, previous);
    if (input.monitorPassword !== undefined && (typeof input.monitorPassword !== 'string' || input.monitorPassword.length > 1024)) throw new AppError('价差服务密码过长');
    if (input.clearMonitorPassword !== undefined && typeof input.clearMonitorPassword !== 'boolean') throw new AppError('清除密码选项无效');
    const changed = previous.monitorUrl !== next.monitorUrl || previous.monitorUsername !== next.monitorUsername;
    store.transaction(() => { store.set('config', next); if (changed || input.clearMonitorPassword) store.set('monitorPassword', null); if (input.monitorPassword) store.set('monitorPassword', store.encrypt(input.monitorPassword)); store.event(clock(), next.enabled ? '已开启自动模拟；配置已保存' : '自动模拟已暂停；配置已保存'); });
    if (changed || input.clearMonitorPassword || input.monitorPassword) { sourceGeneration++; feed = null; recentSignals.clear(); entryPolicyKnown = false; store.set('entryPolicyKnown', false); sourceCheckedAt = null; sourceReceivedAt = null; sourceDurationMs = null; sourceError = '连接设置已更改，等待重新读取'; }
    return view();
  }
  return { view, summary, refreshSource, refreshAccounting, refreshValuations, tick: options => serial(() => tick(options)), open: (s, r) => serial(() => open(s, r)), closePosition: (id, r) => serial(() => closePosition(id, r)), executionAction: (id, action, r) => serial(() => executionAction(id, action, r)), settings: input => serial(() => settings(input)), async stop() { closing = true; await Promise.all([chain, sourceFlight, accountingFlight, depthFlight]); } };
}
