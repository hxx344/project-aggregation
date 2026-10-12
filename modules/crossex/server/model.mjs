import { D, Decimal } from './money.mjs';

export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const defaults = Object.freeze({ enabled: false, entryPaused: false, monitorUrl: 'http://127.0.0.1:3000', monitorUsername: 'admin', notionalPerLeg: 100, maxOpen: 3, maxTotalNotional: 1000, feeBps: 6, feeSchedule: Object.freeze([]), slippageBps: 5, minNetBps: 20, takeProfitBps: 10, stopLossBps: 100, maxHoldMinutes: 60, cooldownSeconds: 60, executionMode: 'atomic', executionScenario: 'normal', executionSeed: 1, executionDelayMs: 250, clipNotional: 25, partialFillPct: 50, repairAttempts: 3, fundingEnabled: true, depthRefreshSeconds: 15, historySampleSeconds: 15 });
export const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export function monitorUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new AppError('价差服务地址无效');
  let url; try { url = new URL(value); } catch { throw new AppError('价差服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AppError('价差服务须为同机 localhost / 127.0.0.1 / [::1] 地址，不含路径或凭据');
  return url.origin;
}
export function configuration(input, previous = defaults) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const validKeys = (value, allowed) => plain(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key) && Object.hasOwn(allowed, key));
  if (!validKeys(input, defaults) || !validKeys(previous, defaults)) throw new AppError('配置字段无效');
  const result = { ...defaults, ...previous, ...input };
  for (const key of ['enabled', 'entryPaused', 'fundingEnabled']) if (typeof result[key] !== 'boolean') throw new AppError(`${key} 开关无效`);
  result.monitorUrl = monitorUrl(result.monitorUrl);
  if (typeof result.monitorUsername !== 'string' || result.monitorUsername.length > 100 || /[:\r\n]/.test(result.monitorUsername)) throw new AppError('价差服务用户名无效');
  const bounds = { notionalPerLeg: [5, 100000], maxOpen: [1, 20], maxTotalNotional: [10, 2000000], feeBps: [0, 100], slippageBps: [0, 100], minNetBps: [0, 5000], takeProfitBps: [1, 5000], stopLossBps: [1, 10000], maxHoldMinutes: [1, 10080], cooldownSeconds: [10, 86400], executionSeed: [1, 2147483648], executionDelayMs: [0, 10000], clipNotional: [1, 100000], partialFillPct: [1, 100], repairAttempts: [1, 10], depthRefreshSeconds: [5, 300], historySampleSeconds: [5, 300] };
  for (const [key, [min, max]] of Object.entries(bounds)) if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new AppError(`${key} 应为 ${min}–${max}`);
  for (const key of ['maxOpen', 'executionSeed', 'repairAttempts']) if (!Number.isInteger(result[key])) throw new AppError(`${key} 须为整数`);
  if (D(result.maxTotalNotional).lt(D(result.notionalPerLeg).times(2))) throw new AppError('总双腿额度不得低于单腿额度的两倍');
  if (!['atomic', 'staged'].includes(result.executionMode) || !['normal', 'partial', 'reject-short', 'unknown-short', 'cancel-delay', 'cancel-reject'].includes(result.executionScenario)) throw new AppError('执行模式或场景无效');
  if (!Array.isArray(result.feeSchedule) || result.feeSchedule.length > 100) throw new AppError('费率表最多允许 100 项');
  const seen = new Set(), fields = { exchange: '', symbol: '', makerBps: 0, takerBps: 0, source: '', updatedAt: null };
  result.feeSchedule = result.feeSchedule.map(item => {
    if (!validKeys(item, fields)) throw new AppError('费率表字段无效');
    const row = { symbol: '', source: 'manual', updatedAt: null, ...item };
    if (!SUPPORTED_VENUES.includes(row.exchange) || typeof row.symbol !== 'string' || row.symbol.length > 100 || /[\x00-\x1f]/.test(row.symbol) || typeof row.source !== 'string' || !row.source.trim() || row.source.length > 200 || /[\x00-\x1f]/.test(row.source)) throw new AppError('费率交易所、合约或来源无效');
    if (typeof row.makerBps !== 'number' || !Number.isFinite(row.makerBps) || row.makerBps < -100 || row.makerBps > 100 || typeof row.takerBps !== 'number' || !Number.isFinite(row.takerBps) || row.takerBps < 0 || row.takerBps > 100) throw new AppError('maker 费率须为 -100–100，taker 费率须为 0–100 bps');
    if (row.updatedAt !== null && (!Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 || row.updatedAt > 8640000000000000)) throw new AppError('费率更新时间无效');
    const key = JSON.stringify([row.exchange, row.symbol]);
    if (seen.has(key)) throw new AppError('费率表包含重复交易所与合约');
    seen.add(key); return row;
  });
  return result;
}
export const quoteKey = q => `${q.exchange}:${q.symbol}`;
export const pairKey = s => JSON.stringify([s.base, quoteKey(s.long), quoteKey(s.short)]);
export const SUPPORTED_VENUES = Object.freeze(['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter', 'deribit']);
export const settlement = q => q?.settlementCurrency ?? q?.quoteCurrency ?? 'USDT';
export function contractIdentity(q) {
  return JSON.stringify([q.exchange, q.symbol, q.base, q.rawBase ?? q.base, q.quoteCurrency, settlement(q), q.collateralCurrency, q.multiplier, q.contractKind ?? 'linear', q.counterCurrency ?? q.quoteCurrency, q.crossexSymbol ?? `${q.exchange.toUpperCase()}_FUTURE_${q.base}_${q.quoteCurrency}`, q.marketId ?? null, q.identityScope ?? 'comparable', q.nativeUnit ?? null, q.assetClass, q.comparable ?? true]);
}
export function validIdentity(q) {
  if (!q || q.identityScope !== undefined && q.identityScope !== 'comparable' || q.assetClass !== 'crypto' || q.comparable === false) return false;
  return identityShape(q);
}
// Manual identities are created by the native instrument reader, never by a
// browser flag or Monitor. They do not authorize the strict Monitor path.
export function validManualIdentity(q) {
  if (!q || q.identityScope !== 'manual' || q.identitySource !== 'exchange-instrument-metadata'
    || !['crypto', 'stock', 'commodity', 'forex', 'bond', 'index'].includes(q.assetClass)
    || q.rawBase !== q.base || typeof q.nativeUnit !== 'string' || !positive(Number(q.nativeUnit)) || typeof q.comparable !== 'boolean') return false;
  return identityShape(q, true);
}
export function validManualPair(left, right) {
  const comparable = q => validManualIdentity(q) ? q.assetClass === 'crypto' && q.comparable === true && identityShape(q) : validIdentity(q);
  return comparable(left) && comparable(right) && left.base === right.base && left.exchange !== right.exchange;
}
function identityShape(q, manual = false) {
  if (!q || !SUPPORTED_VENUES.includes(q.exchange) || !/^[A-Z0-9]{1,30}$/.test(q.base) || (q.rawBase !== undefined && q.rawBase !== q.base) || q.multiplier !== 1 || q.identityVerified !== true || typeof q.identitySource !== 'string' || !q.identitySource) return false;
  const currency = q.quoteCurrency, base = q.base;
  let symbol, counter = currency, settle = currency, collateral = currency, kind = 'linear';
  if (['binance', 'bybit', 'okx'].includes(q.exchange)) {
    if (!['USDT', 'USDC'].includes(currency)) return false;
    symbol = q.exchange === 'okx' ? `${base}-${currency}-SWAP` : q.exchange === 'bybit' && currency === 'USDC' ? `${base}PERP` : `${base}${currency}`;
  } else if (q.exchange === 'gate') { if (currency !== 'USDT' || !manual && base === 'EDGE') return false; symbol = `${base}_USDT`; }
  else if (q.exchange === 'kraken') { if (currency !== 'USD') return false; symbol = `PF_${base === 'BTC' ? 'XBT' : base}USD`; collateral = 'MULTI'; }
  else if (q.exchange === 'hyperliquid') { if (currency !== (['HYPE', 'PURR'].includes(base) ? 'USDC' : 'USDT')) return false; symbol = base; settle = collateral = counter = 'USDC'; kind = currency === 'USDC' ? 'linear' : 'quanto'; }
  else if (q.exchange === 'deribit') { if (currency !== 'USDC') return false; symbol = `${base}_USDC-PERPETUAL`; }
  else { if (currency !== 'USDC' || !manual && base === 'AI' || !Number.isInteger(q.marketId) || q.marketId < 0) return false; symbol = base; }
  const legacy = !manual && ['binance', 'bybit'].includes(q.exchange) && currency === 'USDT' && q.settlementCurrency === undefined && q.contractKind === undefined && q.crossexSymbol === undefined;
  return q.symbol === symbol && q.collateralCurrency === collateral && (legacy || (q.settlementCurrency === settle && q.contractKind === kind && q.counterCurrency === counter && q.crossexSymbol === `${q.exchange.toUpperCase()}_FUTURE_${base}_${counter}`));
}
export function fxRate(currency, fx, now) {
  if (currency === 'USDT') return { bid: 1, ask: 1, at: now, source: 'USDT 计价基准' };
  const rate = fx?.baseCurrency === 'USDT' && Object.hasOwn(fx.rates || {}, currency) ? fx.rates[currency] : null;
  const age = Math.min(180000, fx?.staleAfterMs ?? 0);
  if (!['USDC', 'USD'].includes(currency) || !rate || !positive(rate.bid) || !positive(rate.ask) || rate.ask < rate.bid || !Number.isFinite(rate.at) || rate.at <= 0 || rate.at > now + 1000 || !positive(age) || now - rate.at > age || typeof rate.source !== 'string' || !rate.source) throw new AppError(`${currency} / USDT 汇率缺失或过期`);
  return rate;
}
const converted = (value, currency, fx, now) => { const amount = D(value), rate = fxRate(currency, fx, now); return amount.times(amount.gte(0) ? rate.bid : rate.ask); };
const notionalConverted = (q, amount, fx, now) => D(amount).times(fxRate(settlement(q), fx, now).ask);
export function convert(value, currency, fx, now) { return converted(value, currency, fx, now).toNumber(); }
export function referencePrice(q, price, side, fx, now) { return D(price).times(fxRate(q.quoteCurrency, fx, now)[side === 'buy' ? 'ask' : 'bid']).toNumber(); }
export function notionalUSDT(q, amount, fx, now) { return notionalConverted(q, amount, fx, now).toNumber(); }
export const storedNotional = fill => fill.notionalUSDT ?? fill.notional;
export function quoteTime(q) { return Math.min(q?.bidAskAt ?? NaN, q?.receivedAt ?? NaN); }
export function freshQuote(q, now) {
  const at = quoteTime(q);
  return validIdentity(q) && positive(q.bid) && positive(q.ask) && q.bid <= q.ask && Number.isFinite(at) && at > 0 && at <= now + 1000 && now - at <= 10000;
}
// Monitor owns spot/network collection and address matching. Its certificate is
// bounded evidence, not a timeless boolean or a replacement for BBO checks.
export function transferEligibility(signal, feed, now) {
  const policy = feed?.crossexFilter;
  const blocked = reason => ({ state: 'blocked', reason, networks: [], checkedAt: null, expiresAt: null });
  if (policy !== undefined && (!policy || typeof policy.requireSpotTransfer !== 'boolean' || !Array.isArray(policy.blockedBases)
    || policy.blockedBases.length > 200 || policy.blockedBases.some(base => typeof base !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(base))
    || (policy.revision !== undefined && (!Number.isSafeInteger(policy.revision) || policy.revision < 0)))) return blocked('Monitor 新仓筛选策略无效，等待重新核验');
  if (policy?.blockedBases.includes(signal?.base)) return blocked('该币种已被 Monitor 屏蔽，停止新仓');
  const evidence = signal?.spotTransfer;
  if (evidence === undefined && !policy?.requireSpotTransfer) return { state: policy ? 'disabled' : 'unverified', reason: policy ? '现货与充提筛选未启用' : '来源未提供现货与充提策略', networks: [], checkedAt: null, expiresAt: null };
  if (!evidence || !Array.isArray(evidence.networks) || !evidence.networks.length || evidence.networks.length > 100
    || evidence.networks.some(network => typeof network !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(network))
    || new Set(evidence.networks).size !== evidence.networks.length
    || !Number.isFinite(evidence.checkedAt) || evidence.checkedAt <= 0 || evidence.checkedAt > now
    || !Number.isFinite(evidence.expiresAt) || evidence.expiresAt <= evidence.checkedAt || evidence.expiresAt > evidence.checkedAt + 180000
    || now >= evidence.expiresAt || signal.expiresAt > evidence.expiresAt) return blocked('双边现货、共同网络或双向充提证据缺失、无效或已过期');
  return { state: 'verified', reason: '双边现货可交易，共同网络双向充提正常', networks: [...evidence.networks], checkedAt: evidence.checkedAt, expiresAt: evidence.expiresAt };
}
export function validSignal(s, feed, now) {
  if (!s || typeof s.id !== 'string' || s.id.length > 150 || !s.id || s.base !== s.long?.base || s.base !== s.short?.base || s.quoteCurrency !== 'USDT' || s.long?.exchange === s.short?.exchange || !freshQuote(s.long, now) || !freshQuote(s.short, now) || s.pairKey !== pairKey(s)) return false;
  if (Math.abs(quoteTime(s.long) - quoteTime(s.short)) > 5000 || !Number.isFinite(s.expiresAt) || s.expiresAt <= now || s.expiresAt > Math.min(quoteTime(s.long), quoteTime(s.short)) + 10000 || transferEligibility(s, feed, now).state === 'blocked') return false;
  try { for (const q of [s.long, s.short]) { fxRate(q.quoteCurrency, feed.fx, now); fxRate(settlement(q), feed.fx, now); } } catch { return false; }
  return [s.long, s.short].every(q => !q.delisting && !q.delistingAt && feed.exchanges.some(x => x.id === q.exchange && x.status === 'live') && feed.quotes.some(current => quoteKey(current) === quoteKey(q) && contractIdentity(current) === contractIdentity(q) && freshQuote(current, now) && !current.delisting && !current.delistingAt));
}
export function validateFeed(feed, now) {
  if (!feed || ![1, 2].includes(feed.schemaVersion) || feed.mode !== 'paper' || feed.source !== 'market-monitor' || feed.monitorId !== 'perpetual' || !Array.isArray(feed.quotes) || feed.quotes.length > 5000 || !Array.isArray(feed.signals) || feed.signals.length > 200 || !Array.isArray(feed.exchanges) || !Number.isFinite(feed.generatedAt) || feed.generatedAt > now + 1000 || now - feed.generatedAt > 10000) throw new AppError('价差信号格式不兼容或已经过期', 502);
  if (new Set(feed.quotes.map(quoteKey)).size !== feed.quotes.length) throw new AppError('价差来源包含重复合约', 502);
  if (!['live', 'partial'].includes(feed.status) || feed.storageError || feed.error) throw new AppError('价差服务没有可用的实时行情', 502);
  return feed;
}
export function catalogRule(q, catalog) {
  if (!validIdentity(q)) throw new AppError('仅支持身份明确、单位为 1 的普通加密永续');
  const symbol = q.crossexSymbol ?? `${q.exchange.toUpperCase()}_FUTURE_${q.base}_USDT`;
  return displayCatalogRule(symbol, catalog);
}
export function manualCatalogRule(q, catalog) {
  if (!validManualIdentity(q) && !validIdentity(q)) throw new AppError('合约原生身份或数量单位未确认');
  return displayCatalogRule(q.crossexSymbol ?? `${q.exchange.toUpperCase()}_FUTURE_${q.base}_USDT`, catalog);
}
export function displayCatalogRule(symbol, catalog) {
  const match = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_([A-Z0-9]{1,30})_(USDT|USDC|USD)$/.exec(symbol);
  if (!match) throw new AppError('请选择有效的 CrossEx 永续合约');
  const rule = catalog.find(x => x.symbol === symbol && x.exchange_type === match[1] && x.business_type === 'FUTURE');
  if (!rule || rule.state !== 'live' || String(rule.delist_time ?? '') !== '0') throw new AppError(`${symbol} 未在 CrossEx 确认为可用合约`);
  for (const field of ['min_size', 'lot_size', 'tick_size']) if (!positive(Number(rule[field]))) throw new AppError(`${symbol} 缺少有效的数量或价格规则`);
  const unverifiedConstraints = [];
  for (const field of ['min_notional', 'max_market_size']) {
    if (rule[field] === null) { unverifiedConstraints.push(`${symbol}：目录未提供${field === 'min_notional' ? '最小名义额' : '最大市价数量'}`); continue; }
    if (rule[field] === undefined || String(rule[field]).trim() === '' || !Number.isFinite(Number(rule[field])) || (field === 'max_market_size' ? Number(rule[field]) <= 0 : Number(rule[field]) < 0)) throw new AppError(`${symbol} 缺少有效的${field === 'min_notional' ? '最小名义额' : '最大数量'}规则`);
  }
  return { ...rule, unverifiedConstraints };
}
const SCALE = 100000000n;
function units(value) {
  let decimal; try { decimal = D(value); } catch { throw new AppError('数量步长精度超出模拟器支持范围'); }
  if (decimal.isNegative() || decimal.decimalPlaces() > 8) throw new AppError('数量步长精度超出模拟器支持范围');
  return BigInt(decimal.times(SCALE.toString()).toFixed(0));
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function quantityDecimal(budget, prices, rules, budgetPrices = prices) {
  if (!Array.isArray(prices) || !Array.isArray(budgetPrices) || !Array.isArray(rules) || prices.length !== 2 || budgetPrices.length !== 2 || rules.length !== 2) throw new AppError('双腿额度或数量规则无效');
  const steps = rules.map(x => units(x.lot_size));
  if (!positive(budget) || [...prices, ...budgetPrices].some(n => !positive(n)) || steps.some(n => n <= 0n)) throw new AppError('额度或数量规则无效');
  const step = steps[0] / gcd(steps[0], steps[1]) * steps[1];
  const max = Decimal.min(D(budget).div(Decimal.max(...budgetPrices)), ...rules.filter(x => x.max_market_size !== null).map(x => D(x.max_market_size)));
  const scaled = BigInt(max.times(SCALE.toString()).floor().toFixed(0));
  const quantity = D((scaled / step * step).toString()).div(SCALE.toString());
  if (quantity.lte(0) || rules.some((r, i) => quantity.lt(r.min_size) || (r.min_notional !== null && quantity.times(prices[i]).lt(r.min_notional)))) throw new AppError('额度取整后未满足双腿最小数量或最小名义额');
  return quantity;
}
export const commonQuantity = (...args) => quantityDecimal(...args).toNumber();
export const commonQuantityExact = (...args) => quantityDecimal(...args).toString();
export function validateBooks(books, now) {
  for (const book of books) {
    if (!Number.isFinite(book.at) || now - book.at > 10000 || book.at > now + 1000) throw new AppError('深度快照已经过期或时间异常');
    for (const side of ['bids', 'asks']) {
      if (!Array.isArray(book[side]) || !book[side].length || book[side].length > 1000) throw new AppError('深度快照缺失');
      for (const [i, level] of book[side].entries()) if (!Array.isArray(level) || !positive(level[0]) || !positive(level[1]) || (i && (side === 'bids' ? level[0] >= book[side][i - 1][0] : level[0] <= book[side][i - 1][0]))) throw new AppError('深度快照价格或排序异常');
    }
    if (book.bids[0][0] > book.asks[0][0]) throw new AppError('深度快照买卖价交叉');
  }
  if (Math.abs(books[0].at - books[1].at) > 5000) throw new AppError('双腿深度时间差超过 5 秒');
}
export function partialFill(levels, quantity, side, slippageBps) {
  let requested, slippage;
  try { requested = D(quantity); slippage = D(slippageBps); } catch { throw new AppError('成交数量或滑点无效'); }
  if (!Array.isArray(levels) || requested.lte(0) || slippage.lt(0) || slippage.gt(10000) || !['buy', 'sell'].includes(side)) throw new AppError('成交数量或滑点无效');
  let remaining = requested, value = D(0), limit;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) throw new AppError('成交深度无效');
    let price, available;
    try { price = D(level[0]); available = D(level[1]); } catch { throw new AppError('成交深度无效'); }
    if (price.lte(0) || available.lte(0)) throw new AppError('成交深度无效');
    limit ??= price.times(D(1).plus(slippage.div(10000).times(side === 'buy' ? 1 : -1)));
    if (side === 'buy' ? price.gt(limit) : price.lt(limit)) break;
    const take = Decimal.min(remaining, available);
    value = value.plus(take.times(price)); remaining = remaining.minus(take);
    if (remaining.isZero()) break;
  }
  const actual = requested.minus(remaining), price = actual.isZero() ? null : value.div(actual);
  return { quantity: actual.toNumber(), requestedQuantity: requested.toNumber(), remaining: remaining.toNumber(), price: price?.toNumber() ?? null, notional: value.toNumber(), status: actual.isZero() ? 'empty' : remaining.isZero() ? 'filled' : 'partial', exact: { quantity: actual.toString(), requestedQuantity: requested.toString(), remaining: remaining.toString(), price: price?.toString() ?? null, notional: value.toString() } };
}
export function fill(levels, quantity, side, slippageBps) {
  const result = partialFill(levels, quantity, side, slippageBps);
  if (result.status !== 'filled') throw new AppError('滑点上限内深度不足，双腿模拟均未记账');
  return result;
}
export function pnl(position, longExit, shortExit, fx, now = Date.now()) {
  const quantities = { long: position.longQuantity ?? position.longFill?.exact?.quantity ?? position.longFill?.quantity ?? position.quantity, short: position.shortQuantity ?? position.shortFill?.exact?.quantity ?? position.shortFill?.quantity ?? position.quantity };
  const notional = (execution, quantity) => {
    if (quantity.isZero()) return D(0);
    if (execution && typeof execution === 'object' && !(execution instanceof Decimal)) {
      if (execution.exact?.notional !== undefined && D(execution.exact.quantity ?? execution.quantity ?? quantity).eq(quantity)) return D(execution.exact.notional);
      return quantity.times(execution.exact?.price ?? execution.price);
    }
    return quantity.times(execution);
  };
  const parts = {};
  for (const [leg, exit] of [['long', longExit], ['short', shortExit]]) {
    const quantity = D(quantities[leg]), entryValue = notional(position[`${leg}Fill`], quantity), exitValue = notional(exit, quantity);
    const rawGross = leg === 'long' ? exitValue.minus(entryValue) : entryValue.minus(exitValue);
    const exitBps = position.feeSnapshot?.[leg]?.exit?.bps ?? position.feeBps;
    parts[leg] = { rawGross, gross: quantity.isZero() ? D(0) : converted(rawGross, settlement(position[leg]), fx, now), exitFees: quantity.isZero() ? D(0) : notionalConverted(position[leg], exitValue, fx, now).times(exitBps).div(10000) };
  }
  const gross = parts.long.gross.plus(parts.short.gross), exitFees = parts.long.exitFees.plus(parts.short.exitFees);
  const entryFees = D(position.exact?.entryFees ?? position.entryFeesExact ?? position.entryFees);
  const priceOnlyNet = gross.minus(entryFees).minus(exitFees);
  let grossAtEntryFx = null;
  try { grossAtEntryFx = converted(parts.long.rawGross, settlement(position.long), position.entryFx, position.openedAt ?? now).plus(converted(parts.short.rawGross, settlement(position.short), position.entryFx, position.openedAt ?? now)); } catch { /* Legacy entries may lack a valid historical FX reference. */ }
  const values = { gross, entryFees, exitFees, net: priceOnlyNet, priceOnlyNet, longGross: parts.long.rawGross, shortGross: parts.short.rawGross };
  return { ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toNumber()])), grossAtEntryFx: grossAtEntryFx?.toNumber() ?? null, fxImpact: grossAtEntryFx === null ? null : gross.minus(grossAtEntryFx).toNumber(), exact: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toString()])) };
}
