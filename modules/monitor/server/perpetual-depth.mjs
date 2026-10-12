import { PerpetualWebSocket } from './perpetual-socket.mjs';
import { quoteCurrencyFx } from '../lib/perpetual-fx.ts';
import { pairTakerFees } from '../lib/perpetual-fees.ts';
import { calculatePerpetualExitPnl, perpetualContractIdentity, perpetualExitIdentity, validatePerpetualExitPosition } from '../lib/perpetual-exit.ts';

// One-shot public depth inspection only: no full-market subscriptions or history.
// Official formats verified 2026-09-21:
// https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book
// https://bybit-exchange.github.io/docs/v5/market/orderbook
// https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book
// https://www.bitget.com/docs/catalog/classic-contract-market
// https://www.gate.com/docs/developers/apiv4/en/futures/
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot
// https://apidocs.lighter.xyz/docs/websocket-reference
// https://apidocs.rh.lighter.xyz/docs/websocket
// https://asterdex.github.io/aster-api-website/futures/market-data/#order-book
// https://docs.kraken.com/exchange/api-reference/futures-websocket/book
// https://docs.kraken.com/api-reference/market-data/get-order-book
const IDS = new Set(['binance', 'bybit', 'okx', 'bitget', 'gate', 'kraken', 'hyperliquid', 'lighter', 'rh-lighter', 'aster', 'entropy']);
const MAX_BOOK_AGE = 10_000, MAX_SKEW = 5_000, LEVELS = 50;
const positive = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const validTime = (value, now) => Number.isFinite(Number(value)) && Number(value) >= 1e12 && Number(value) <= now + 5_000 ? Number(value) : null;

/** Shared bounded budget for depth, metadata and FX. Errors never grow a queue. */
export function createInspectionBudget({ clock = Date.now, spacingMs = 500, maxPerMinute = 60, concurrency = 2, maxQueue = 12 } = {}) {
  const queue = [], starts = []; let running = 0, lastStart = -Infinity, timer = null, stopped = false, blockedUntil = 0;
  function pump() {
    if (stopped || timer || running >= concurrency || !queue.length) return;
    const now = clock();
    while (starts.length && starts[0] <= now - 60_000) starts.shift();
    if (now < blockedUntil || starts.length >= maxPerMinute) {
      for (const item of queue.splice(0)) item.reject(failure('盘口查询已达限额，请稍后重试', 429));
      return;
    }
    const delay = Math.max(0, lastStart + spacingMs - now);
    if (delay) { timer = setTimeout(() => { timer = null; pump(); }, delay); return; }
    const item = queue.shift(); starts.push(now); lastStart = now; running++;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { running--; pump(); });
    pump();
  }
  return {
    run(task) {
      if (stopped) return Promise.reject(failure('盘口服务已停止', 503));
      if (queue.length >= maxQueue) return Promise.reject(failure('盘口查询繁忙，请稍后重试', 429));
      return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
    },
    backoff(ms = 30_000) { blockedUntil = Math.max(blockedUntil, clock() + Math.min(300_000, Math.max(1_000, ms))); },
    metrics: () => ({ inFlight: running, queued: queue.length, recentRequests: starts.length, blockedUntil }),
    stop() { stopped = true; clearTimeout(timer); timer = null; for (const item of queue.splice(0)) item.reject(failure('盘口服务已停止', 503)); },
  };
}

export function normalizeDepthLevels(rows, { multiplier = 1, contractSize = 1, side = 'asks', limit = LEVELS } = {}) {
  if (!Array.isArray(rows) || !positive(multiplier) || !positive(contractSize)) throw failure('盘口数量或合约单位缺失');
  const levels = new Map();
  // Guard untrusted upstream payloads and aggregate repeated order prices.
  for (const row of rows.slice(0, 250)) {
    if (!row || typeof row !== 'object') continue;
    const rawPrice = positive(Array.isArray(row) ? row[0] : row.p ?? row.px ?? row.price);
    const rawSize = positive(Array.isArray(row) ? row[1] : row.s ?? row.sz ?? row.size ?? row.remaining_base_amount);
    if (!rawPrice || !rawSize) continue;
    const price = rawPrice / multiplier, size = rawSize * contractSize * multiplier;
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    levels.set(price, (levels.get(price) ?? 0) + size);
  }
  return [...levels].sort((a, b) => side === 'asks' ? a[0] - b[0] : b[0] - a[0]).slice(0, limit);
}

/** Budget is a long-leg USDT notional; both legs hold the same underlying amount. */
export function estimateDepthPair(longBook, shortBook, notional, fx, now = Date.now()) {
  const base = { notional, notionalCurrency: 'USDT', generatedAt: now, staleAfterMs: MAX_BOOK_AGE, complete: false, estimatedSpreadPct: null, entrySlippagePct: null, quantity: null, long: null, short: null, reasons: [] };
  if (!positive(notional) || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
  for (const [name, book] of [['做多', longBook], ['做空', shortBook]]) {
    if (!book || book.reason) base.reasons.push(`${name}腿：${book?.reason || '盘口缺失'}`);
    else if (!validTime(book.sourceTime, now) || !validTime(book.receivedAt, now) || now - book.sourceTime > MAX_BOOK_AGE || now - book.receivedAt > MAX_BOOK_AGE) base.reasons.push(`${name}腿：盘口时间缺失或超过 10 秒`);
    else if (!book.asks?.length || !book.bids?.length || book.bids[0][0] > book.asks[0][0]) base.reasons.push(`${name}腿：盘口为空或买卖价格倒挂`);
  }
  if (base.reasons.length) return base;
  if (Math.abs(longBook.sourceTime - shortBook.sourceTime) > MAX_SKEW) { base.reasons.push('两腿盘口时间相差超过 5 秒，请重新校验'); return base; }
  const longFx = quoteCurrencyFx(longBook.quoteCurrency, fx, now), shortFx = quoteCurrencyFx(shortBook.quoteCurrency, fx, now);
  if (!longFx || !shortFx) { base.reasons.push('计价币兑 USDT 汇率缺失或过期，无法按统一金额校验'); return base; }
  const asks = longBook.asks.map(([price, size]) => [price * longFx.ask, size]);
  const bids = shortBook.bids.map(([price, size]) => [price * shortFx.bid, size]);
  let remaining = notional, quantity = 0, longValue = 0;
  for (const [price, size] of asks) { const used = Math.min(size, remaining / price); quantity += used; longValue += used * price; remaining = Math.max(0, remaining - used * price); if (remaining < notional * 1e-10) break; }
  const longComplete = remaining <= notional * 1e-8;
  let shortRemaining = quantity, shortValue = 0, shortQuantity = 0;
  for (const [price, size] of bids) { const used = Math.min(size, shortRemaining); shortQuantity += used; shortValue += used * price; shortRemaining = Math.max(0, shortRemaining - used); if (shortRemaining < quantity * 1e-10) break; }
  const shortComplete = shortRemaining <= quantity * 1e-8;
  const view = (book, levels, filledQuantity, filledNotional, complete) => ({ exchange: book.exchange, symbol: book.symbol, quoteCurrency: book.quoteCurrency, sourceTime: book.sourceTime, receivedAt: book.receivedAt, transport: book.transport, source: book.source, levels: levels.length, complete, filledQuantity, filledNotional, vwap: filledQuantity > 0 ? filledNotional / filledQuantity : null, capacityQuantity: levels.reduce((sum, row) => sum + row[1], 0), capacityNotional: levels.reduce((sum, row) => sum + row[0] * row[1], 0) });
  base.long = view(longBook, asks, quantity, longValue, longComplete);
  base.short = view(shortBook, bids, shortQuantity, shortValue, shortComplete);
  base.quantity = quantity;
  if (!longComplete) base.reasons.push(`做多腿公开 ${asks.length} 档盘口不足目标金额`);
  if (!shortComplete) base.reasons.push(`做空腿公开 ${bids.length} 档盘口不足以匹配做多数量`);
  base.complete = longComplete && shortComplete;
  if (base.complete) {
    base.estimatedSpreadPct = (shortValue / longValue - 1) * 100;
    base.entrySlippagePct = Math.max(0, (bids[0][0] / asks[0][0] - 1) * 100 - base.estimatedSpreadPct);
  }
  return base;
}

/** Same-asset, linear USDT close: sell the long into bids, buy the short from asks. */
export function estimateExitPair(longBook, shortBook, input, quotes, now = Date.now()) {
  validatePerpetualExitPosition(input);
  const { quantity, entryLongPrice, entryShortPrice, entryFeePaid, settledFunding, capital } = input;
  const position = { quantity, entryLongPrice, entryShortPrice, entryFeePaid, settledFunding, capital };
  const fees = pairTakerFees({ long: quotes[0], short: quotes[1] }, input.takerOverrides ?? {}, now);
  const result = { kind: 'exit', identity: perpetualExitIdentity(quotes[0], quotes[1]), base: quotes[0].base, currency: 'USDT', position,
    generatedAt: now, staleAfterMs: MAX_BOOK_AGE, bookComplete: false, complete: false,
    entryLongNotional: quantity * entryLongPrice, entryShortNotional: quantity * entryShortPrice, entryNotional: quantity * entryLongPrice,
    longPnl: null, shortPnl: null, rawPnl: null, entryFeePaid, closeFeePaid: null, settledFunding, netPnl: null, notionalReturnPercent: null, capitalReturnPercent: null,
    fees, long: null, short: null, reasons: [] };
  if (input.identity !== undefined && input.identity !== result.identity) { result.reasons.push('合约身份或数量单位已变化，请重新确认持仓'); return result; }
  if (quotes[0].base !== quotes[1].base || quotes[0].exchange === quotes[1].exchange || quotes.some(quote => quote.comparable === false)) {
    result.reasons.push('两腿需为可比较的相同标的、不同交易所'); return result;
  }
  if (quotes.some(quote => quote.quoteCurrency !== 'USDT' || (quote.collateralCurrency != null && quote.collateralCurrency !== 'USDT'))) {
    result.reasons.push('平仓测算当前仅支持两腿均以 USDT 计价及结算的线性合约，跨币种资金流暂不估算'); return result;
  }
  for (const [index, book] of [longBook, shortBook].entries()) {
    const name = index === 0 ? '做多' : '做空', quote = quotes[index];
    if (!book || book.reason) result.reasons.push(`${name}腿：${book?.reason || '盘口缺失'}`);
    else if (book.exchange !== quote.exchange || book.symbol !== quote.symbol || book.base !== quote.base || book.quoteCurrency !== 'USDT') result.reasons.push(`${name}腿：盘口合约与持仓身份不符`);
    else if (!validTime(book.sourceTime, now) || !validTime(book.receivedAt, now) || now - book.sourceTime > MAX_BOOK_AGE || now - book.receivedAt > MAX_BOOK_AGE) result.reasons.push(`${name}腿：盘口时间缺失或超过 10 秒`);
    else if (![book.asks, book.bids].every(levels => Array.isArray(levels) && levels.length > 0 && levels.every(row => Array.isArray(row) && positive(row[0]) && positive(row[1]))) || book.bids[0][0] > book.asks[0][0]) result.reasons.push(`${name}腿：盘口为空或买卖价格倒挂`);
  }
  if (result.reasons.length) return result;
  if (Math.abs(longBook.sourceTime - shortBook.sourceTime) > MAX_SKEW) { result.reasons.push('两腿盘口时间相差超过 5 秒，请重新校验'); return result; }
  const fill = (book, levels, action, fee, entryPrice) => {
    let remaining = quantity, filledQuantity = 0, filledNotional = 0;
    for (const [price, size] of levels) {
      const used = Math.min(remaining, size); filledQuantity += used; filledNotional += used * price; remaining = Math.max(0, remaining - used);
      if (remaining <= quantity * 1e-10) break;
    }
    const complete = remaining <= quantity * 1e-8;
    return { exchange: book.exchange, symbol: book.symbol, quoteCurrency: 'USDT', sourceTime: book.sourceTime, receivedAt: book.receivedAt, transport: book.transport, source: book.source,
      levels: levels.length, complete, filledQuantity, filledNotional, vwap: filledQuantity > 0 ? filledNotional / filledQuantity : null,
      capacityQuantity: levels.reduce((sum, row) => sum + row[1], 0), capacityNotional: levels.reduce((sum, row) => sum + row[0] * row[1], 0),
      action, fee, pnl: complete ? (action === 'sell' ? filledNotional - quantity * entryPrice : quantity * entryPrice - filledNotional) : null,
      closeFee: complete && fee.percent !== null ? filledNotional * fee.percent / 100 : null };
  };
  result.long = fill(longBook, longBook.bids, 'sell', fees.long, entryLongPrice);
  result.short = fill(shortBook, shortBook.asks, 'buy', fees.short, entryShortPrice);
  result.longPnl = result.long.pnl; result.shortPnl = result.short.pnl;
  for (const [name, leg] of [['做多', result.long], ['做空', result.short]]) {
    if (!leg.complete) result.reasons.push(`${name}腿公开 ${leg.levels} 档盘口不足以全部平仓，已显示部分容量`);
    if (leg.fee.percent === null) result.reasons.push(`${name}腿：${leg.fee.detail}`);
  }
  result.bookComplete = result.long.complete && result.short.complete;
  if (result.bookComplete) {
    Object.assign(result, calculatePerpetualExitPnl(position, result.long.vwap, result.short.vwap, fees));
    result.complete = result.netPnl !== null;
  }
  if (quotes.some(quote => quote.delistingAt && quote.delistingAt <= now)) result.reasons.push('合约已到公告下架时间；此处仅为盘口估值，请核实平台是否仍允许平仓');
  return result;
}

export function createPerpetualExecutionService({ getQuote, getMarket = () => null, fetchImpl = fetch, clock = Date.now, WebSocketImpl = PerpetualWebSocket, budget: suppliedBudget, maxMarkets = 10, cacheMs = 5_000 } = {}) {
  const budget = suppliedBudget ?? createInspectionBudget({ clock });
  const books = new Map(), metadata = new Map(), controller = new AbortController();
  let fxSnapshot = null, fxFlight = null, fxAttemptAt = -Infinity;
  async function json(url, body) {
    return budget.run(async () => {
      const response = await fetchImpl(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        if ([418, 429].includes(response.status)) budget.backoff((positive(response.headers?.get?.('retry-after')) ?? 30) * 1_000);
        throw failure(`公开接口 HTTP ${response.status}`, 502);
      }
      const data = await response.json();
      const code = data?.retCode ?? data?.code;
      if (code !== undefined && !['0', '00000', '200'].includes(String(code))) {
        if (['429', '10006', '50011', '-1003'].includes(String(code))) budget.backoff();
        throw failure(`公开接口返回错误 ${String(code).slice(0, 25)}`, 502);
      }
      return data;
    });
  }
  async function contractSize(quote) {
    if (!['gate', 'okx'].includes(quote.exchange)) return 1;
    const key = `${quote.exchange}:${quote.symbol}`, cached = metadata.get(key);
    const identity = perpetualContractIdentity(quote);
    if (cached && cached.identity === identity && clock() - cached.at < 300_000) return cached.value;
    let value;
    if (quote.exchange === 'gate') {
      const row = await json(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(quote.symbol)}`);
      if (row.name !== quote.symbol || row.type !== 'direct') throw failure('Gate 合约数量单位未确认');
      value = positive(row.quanto_multiplier);
    } else {
      const data = await json(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(quote.symbol)}`);
      const row = data.data?.find(row => row.instId === quote.symbol);
      if (!row || row.ctType !== 'linear' || row.ctValCcy !== quote.symbol.split('-')[0]) throw failure('OKX 合约数量单位未确认');
      value = positive(row.ctVal); // Official linear size × ctVal, quoted in ctValCcy.
      if (row.ctMult && Number(row.ctMult) !== 1) throw failure('OKX 非标准 ctMult 暂不支持盘口金额估算');
    }
    if (!value) throw failure('合约数量乘数缺失');
    if (metadata.size >= maxMarkets && !metadata.has(key)) metadata.delete(metadata.keys().next().value);
    metadata.set(key, { value, identity, at: clock() }); return value;
  }
  function lighterSnapshot(quote, market) {
    if (!Number.isInteger(market?.marketId)) return Promise.reject(failure('合约目录缺少 Lighter market_id'));
    const host = quote.exchange === 'lighter' ? 'mainnet.zklighter.elliot.ai' : 'api.rh.lighter.xyz';
    return budget.run(() => new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`wss://${host}/stream?readonly=true`);
      let done = false;
      const finish = (error, data) => {
        if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        socket.terminate(); if (error) reject(error); else resolve({ data, source: `https://${host}`, transport: 'ws' });
      };
      const aborted = () => finish(failure('盘口查询已取消', 503));
      const timer = setTimeout(() => finish(failure('盘口快照连接超时', 502)), 8_000);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${market.marketId}` })));
      socket.on('error', () => finish(failure('盘口快照连接失败', 502)));
      socket.on('close', () => finish(failure('盘口快照连接关闭', 502)));
      socket.on('message', raw => {
        let data; try { data = JSON.parse(String(raw)); } catch { return; }
        if (data.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        // Delta frames are never treated as a full order book.
        if (data.channel === `order_book:${market.marketId}` && data.type === 'subscribed/order_book') finish(null, data);
      });
    }));
  }
  function krakenIdentity(quote, market) {
    if (!market || market.exchange !== 'kraken' || market.symbol !== quote.symbol || market.base !== quote.base
      || market.quoteCurrency !== 'USD' || quote.quoteCurrency !== 'USD' || market.collateralCurrency !== 'MULTI'
      || market.settlementCurrency !== 'USD' || market.contractKind !== 'linear' || market.multiplier !== 1
      || market.identityVerified !== true || market.comparable === false
      || perpetualContractIdentity(quote) !== perpetualContractIdentity(market)) throw failure('Kraken 当前合约目录身份或数量单位未确认');
    return JSON.stringify([perpetualContractIdentity(market), market.contractKind, market.settlementCurrency, market.identityVerified]);
  }
  function krakenSnapshot(quote, market) {
    const identity = krakenIdentity(quote, market);
    return budget.run(() => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(failure('盘口查询已取消', 503)); return; }
      const socket = new WebSocketImpl('wss://futures.kraken.com/ws/v1');
      let done = false;
      const finish = (error, data) => {
        if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        socket.terminate();
        if (!error) {
          try { if (identity !== krakenIdentity(quote, getMarket(quote.exchange, quote.symbol))) error = failure('Kraken 查询期间合约身份或数量单位已变化'); }
          catch (cause) { error = cause; }
        }
        if (error) reject(error); else resolve({ data, source: 'https://futures.kraken.com', transport: 'ws' });
      };
      const aborted = () => finish(failure('盘口查询已取消', 503));
      const timer = setTimeout(() => finish(failure('Kraken 盘口快照连接超时', 502)), 8_000);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ event: 'subscribe', feed: 'book', product_ids: [quote.symbol] })));
      socket.on('error', () => finish(failure('Kraken 盘口快照连接失败', 502)));
      socket.on('close', () => finish(failure('Kraken 盘口快照连接关闭', 502)));
      socket.on('message', raw => {
        let data; try { data = JSON.parse(String(raw)); } catch { return; }
        if (['error', 'subscribed_failed', 'unsubscribed_failed'].includes(data.event)) { finish(failure('Kraken 盘口订阅失败', 502)); return; }
        if (data.feed !== 'book_snapshot') return; // Never treat a delta as a complete book.
        if (data.product_id !== quote.symbol) { finish(failure('Kraken 返回合约与请求不一致', 502)); return; }
        finish(null, data);
      });
    }));
  }
  async function loadBook(quote, market) {
    const { exchange, symbol } = quote, symbolParam = encodeURIComponent(symbol);
    let data, source, sourceTime, bids, asks, transport = 'rest';
    const unit = await contractSize(quote);
    if (['binance', 'aster'].includes(exchange)) {
      source = `https://fapi.${exchange === 'binance' ? 'binance.com' : 'asterdex.com'}/fapi/v1/depth?symbol=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = data.E;
    } else if (exchange === 'bybit') {
      source = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbolParam}&limit=${LEVELS}`;
      data = (await json(source)).result;
      if (data?.s !== symbol) throw failure('Bybit 返回合约与请求不一致');
      bids = data.b; asks = data.a; sourceTime = data.ts;
    } else if (exchange === 'okx') {
      source = `https://www.okx.com/api/v5/market/books?instId=${symbolParam}&sz=${LEVELS}`;
      data = (await json(source)).data?.[0]; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'bitget') {
      if (!['USDT', 'USDC'].includes(quote.quoteCurrency)) throw failure('Bitget 该计价币盘口暂未接入');
      source = `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbolParam}&productType=${quote.quoteCurrency}-FUTURES&limit=${LEVELS}&precision=scale0`;
      data = (await json(source)).data; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'gate') {
      source = `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = Number(data.current) * 1_000;
    } else if (exchange === 'kraken') {
      const result = await krakenSnapshot(quote, market); ({ data, source, transport } = result);
      bids = Array.isArray(data.bids) ? data.bids.slice(0, 250).map(row => [row.price, row.qty]) : null;
      asks = Array.isArray(data.asks) ? data.asks.slice(0, 250).map(row => [row.price, row.qty]) : null;
      sourceTime = data.timestamp;
    } else if (['hyperliquid', 'entropy'].includes(exchange)) {
      source = 'https://api.hyperliquid.xyz/info'; data = await json(source, { type: 'l2Book', coin: symbol });
      if (data.coin !== symbol) throw failure('Hyperliquid 返回合约与请求不一致');
      [bids, asks] = data.levels ?? []; sourceTime = data.time;
    } else if (['lighter', 'rh-lighter'].includes(exchange)) {
      const result = await lighterSnapshot(quote, market); ({ data, source, transport } = result);
      bids = data.order_book?.bids; asks = data.order_book?.asks; sourceTime = data.timestamp;
    } else throw failure('该交易所的盘口暂未接入');
    const receivedAt = clock();
    return { exchange, symbol, base: quote.base, quoteCurrency: quote.quoteCurrency, source, sourceTime: validTime(sourceTime, receivedAt), receivedAt, transport,
      bids: normalizeDepthLevels(bids, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'bids' }),
      asks: normalizeDepthLevels(asks, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'asks' }) };
  }
  function book(quote) {
    const key = `${quote.exchange}:${quote.symbol}`, cached = books.get(key), now = clock(), market = getMarket(quote.exchange, quote.symbol);
    const identity = JSON.stringify([perpetualContractIdentity(quote), market?.marketId ?? null, market?.multiplier ?? quote.multiplier ?? 1,
      ...(quote.exchange === 'kraken' ? [market ? perpetualContractIdentity(market) : null, market?.contractKind, market?.settlementCurrency, market?.identityVerified, market?.comparable] : [])]);
    if (cached?.identity === identity && cached.flight) return cached.flight;
    if (cached?.identity === identity && cached.value && now - cached.at < (cached.value.reason ? 10_000 : cacheMs)) return Promise.resolve(cached.value);
    // Active market leases prevent many browsers cycling through the whole market.
    for (const [id, item] of books) if (!item.flight && now - item.at > 30_000) books.delete(id);
    if (!books.has(key) && books.size >= maxMarkets) return Promise.resolve({ reason: '全站最多同时校验 10 个合约，请 30 秒后重试' });
    const entry = { at: now, identity, value: null, flight: null };
    entry.flight = loadBook(quote, market).catch(error => ({ reason: error.message })).then(value => { entry.value = value; entry.at = clock(); entry.flight = null; return value; });
    books.set(key, entry); return entry.flight;
  }
  async function fx() {
    if (fxFlight) return fxFlight;
    if (fxSnapshot && clock() - fxAttemptAt < 60_000) return fxSnapshot;
    fxAttemptAt = clock();
    fxFlight = (async () => {
      const rates = { USDT: { bid: 1, ask: 1, at: clock(), source: 'USDT 计价基准' } }, reasons = {};
      await Promise.all(['USDC', 'USD1', 'USDG', 'USD'].map(async currency => {
        const previous = quoteCurrencyFx(currency, fxSnapshot, clock());
        if (previous) rates[currency] = previous;
        const source = currency === 'USD' ? 'https://api.kraken.com/0/public/Depth?pair=USDTUSD&count=1'
          : `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${currency}_USDT&limit=1`;
        try {
          const data = await json(source);
          let bid, ask, at;
          if (currency === 'USD') {
            const keys = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? Object.keys(data.result) : [];
            if (!Array.isArray(data.error) || data.error.length || keys.length !== 1 || keys[0] !== 'USDTZUSD') throw failure('USD 汇率交易对或响应无效');
            const spot = data.result.USDTZUSD, rawBid = positive(spot.bids?.[0]?.[0]), rawAsk = positive(spot.asks?.[0]?.[0]);
            const bidAt = validTime(Number(spot.bids?.[0]?.[2]) * 1000, clock()), askAt = validTime(Number(spot.asks?.[0]?.[2]) * 1000, clock());
            if (!rawBid || !rawAsk || rawBid > rawAsk || !bidAt || !askAt || !positive(spot.bids?.[0]?.[1]) || !positive(spot.asks?.[0]?.[1])) throw failure('USD 汇率盘口缺失或过期');
            // Spot is USD per USDT; invert AND swap sides to express USDT per USD.
            bid = 1 / rawAsk; ask = 1 / rawBid; at = Math.min(bidAt, askAt);
          } else {
            bid = positive(data.bids?.[0]?.[0]); ask = positive(data.asks?.[0]?.[0]);
            at = validTime(data.update, clock()); // `current` is response time, not a new order-book version.
            if (!positive(data.bids?.[0]?.[1]) || !positive(data.asks?.[0]?.[1])) throw failure('汇率盘口缺失或过期');
          }
          if (!bid || !ask || !Number.isFinite(bid) || !Number.isFinite(ask) || bid > ask || !at || clock() - at > 180_000) throw failure('汇率盘口缺失或过期');
          if (previous && at < previous.at) throw failure('汇率盘口时间回退');
          rates[currency] = { bid, ask, at, source };
        } catch (error) {
          // Retain last valid exchange timestamp across temporary errors; never
          // rejuvenate old FX with the latest batch or local receipt time.
          if (!quoteCurrencyFx(currency, { baseCurrency: 'USDT', staleAfterMs: 180_000, rates }, clock())) delete rates[currency];
          reasons[currency] = previous ? `更新失败，沿用上次有效汇率：${error.message}` : error.message;
        }
      }));
      fxSnapshot = { baseCurrency: 'USDT', generatedAt: clock(), staleAfterMs: 180_000, rates, reasons }; return fxSnapshot;
    })().finally(() => { fxFlight = null; });
    return fxFlight;
  }
  function selectLegs(input, closing = false) {
      const legs = ['long', 'short'].map(side => {
        const leg = input?.[side];
        if (!leg || !IDS.has(leg.exchange) || typeof leg.symbol !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(leg.symbol)) throw failure('请选择有效的交易所与合约');
        const quote = getQuote?.(leg.exchange, leg.symbol);
        if (!quote || quote.comparable === false) throw failure('合约不在当前可比较目录中');
        if (!closing && quote.delistingAt && quote.delistingAt <= clock()) throw failure('该合约已到下架时间');
        return { ...quote };
      });
      if (legs[0].base !== legs[1].base || legs[0].exchange === legs[1].exchange) throw failure('两腿需为相同标的、不同交易所');
      return legs;
  }
  return {
    fx,
    peekFx: () => fxSnapshot,
    async exit(input) {
      try { validatePerpetualExitPosition(input); } catch (error) { throw failure(error.message); }
      const legs = selectLegs(input, true), identity = perpetualExitIdentity(legs[0], legs[1]);
      if (input.identity !== undefined && (typeof input.identity !== 'string' || input.identity !== identity)) throw failure('合约身份或数量单位已变化，请重新确认持仓', 409);
      if (legs.some(quote => quote.quoteCurrency !== 'USDT' || (quote.collateralCurrency != null && quote.collateralCurrency !== 'USDT'))) throw failure('平仓测算当前仅支持两腿均以 USDT 计价及结算的线性合约，跨币种资金流暂不估算');
      if (input.takerOverrides !== undefined && (!input.takerOverrides || typeof input.takerOverrides !== 'object' || Array.isArray(input.takerOverrides))) throw failure('账户手续费设置格式无效');
      const [longBook, shortBook] = await Promise.all(legs.map(book));
      const latest = selectLegs(input, true);
      if (identity !== perpetualExitIdentity(latest[0], latest[1])) throw failure('查询期间合约身份或数量单位已变化，请重新确认持仓', 409);
      return estimateExitPair(longBook, shortBook, input, latest, clock());
    },
    async depth(input) {
      const legs = selectLegs(input);
      const notional = positive(input?.notional);
      if (!notional || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
      // Obtain FX first: depth must not age while waiting for extra FX requests.
      const rates = legs.every(leg => leg.quoteCurrency === 'USDT') ? null : await fx();
      const [longBook, shortBook] = await Promise.all(legs.map(book));
      return estimateDepthPair(longBook, shortBook, notional, rates, clock());
    },
    metrics: () => ({ ...budget.metrics(), cachedMarkets: books.size, maxMarkets, metadataMarkets: metadata.size, fxAt: fxSnapshot?.generatedAt ?? null }),
    stop() { controller.abort(); if (!suppliedBudget) budget.stop(); books.clear(); metadata.clear(); },
  };
}
