import { PERPETUAL_MARKET_METRICS_REFRESH_MS } from '../lib/perpetual-market-metrics.ts';

const STEP = 300_000, DAY = 86_400_000;
const LIGHTER_HOSTS = { lighter: 'https://mainnet.zklighter.elliot.ai', 'rh-lighter': 'https://api.rh.lighter.xyz' };
const API_HOSTS = { binance: 'fapi.binance.com', bybit: 'api.bybit.com', okx: 'www.okx.com', bitget: 'api.bitget.com', gate: 'api.gateio.ws', kraken: 'futures.kraken.com', hyperliquid: 'api.hyperliquid.xyz', entropy: 'api.hyperliquid.xyz', aster: 'fapi.asterdex.com', lighter: 'mainnet.zklighter.elliot.ai', 'rh-lighter': 'api.rh.lighter.xyz' };
const SUPPORTED = new Set(['binance', 'bybit', 'okx', 'bitget', 'gate', 'kraken', 'hyperliquid', 'entropy', 'aster', ...Object.keys(LIGHTER_HOSTS)]);
const amount = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const positive = value => { const n = amount(value); return n > 0 ? n : null; };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('指标响应格式异常'); return value; };
const list = value => { if (!Array.isArray(value) || value.length > 20_000) throw Error('指标列表格式异常'); return value; };
const unsupported = message => Object.assign(Error(message), { code: 'UNSUPPORTED' });
const missing = (error, source = '') => ({ value: null, currency: null, observedAt: null, source, error });
const aborted = () => new DOMException('Aborted', 'AbortError');
function metric(value, currency, observedAt, source, reason = '接口未提供有效金额') {
  const n = amount(value);
  return n === null || observedAt === null ? missing(n === null ? reason : '接口未提供有效数据时间', source) : { value: n, currency, observedAt, source, error: '' };
}
function multiply(size, mark, scale = 1) {
  const quantity = amount(size), price = positive(mark), multiplier = positive(scale);
  return quantity === null || price === null || multiplier === null ? null : amount(quantity * price * multiplier);
}
function indexRows(rows, field) {
  const result = new Map();
  for (const raw of list(rows)) {
    const row = object(raw), key = row[field];
    if (typeof key !== 'string' || !key || result.has(key)) throw Error('指标响应合约标识重复或无效');
    result.set(key, row);
  }
  return result;
}
function success(data, exchange) {
  object(data);
  if (exchange === 'bybit' && data.retCode !== 0) throw Error('Bybit 指标接口返回失败');
  if (['okx', 'bitget', 'lighter', 'rh-lighter'].includes(exchange) && !['0', '00000', '200'].includes(String(data.code))) throw Error('指标接口返回失败');
  if (exchange === 'kraken' && data.result !== 'success') throw Error('Kraken 指标接口返回失败');
  return data;
}
function validateMarket(market) {
  if (!market || typeof market.exchange !== 'string' || typeof market.symbol !== 'string' || !market.symbol || market.symbol.length > 160 || /[\s/?#&]/.test(market.symbol) || typeof market.quoteCurrency !== 'string') throw Error('合约指标元数据无效');
  if (!SUPPORTED.has(market.exchange)) throw unsupported('该平台尚无已核实的成交额和持仓金额接口');
  if (market.exchange === 'gate' && (market.quoteCurrency !== 'USDT' || !market.symbol.endsWith('_USDT'))) throw unsupported('Gate 指标仅支持已接入的 USDT 正向合约');
  if (market.exchange === 'entropy' && (market.dex !== 'io' || !/^io:[A-Za-z0-9._-]+$/.test(market.symbol) || market.quoteCurrency !== 'USDC')) throw Error('Entropy 指标合约命名空间或币种不匹配');
  if (market.exchange === 'hyperliquid' && market.symbol.includes(':')) throw Error('Hyperliquid 原生合约不能使用其他命名空间');
  if (market.exchange === 'kraken' && (!/^PF_[A-Z0-9]+USD$/.test(market.symbol) || market.quoteCurrency !== 'USD' || market.contractKind !== 'linear' || market.multiplier !== 1)) throw unsupported('Kraken 指标仅支持已核实的 PF 线性每币合约');
  if (Object.hasOwn(LIGHTER_HOSTS, market.exchange) && (!Number.isInteger(market.marketId) || market.marketId < 0 || market.marketId > 32767)) throw Error('Lighter 指标缺少有效市场编号');
  if (market.exchange === 'lighter' && market.quoteCurrency !== 'USDC') throw Error('Lighter 计价币不匹配');
  if (market.exchange === 'rh-lighter' && market.quoteCurrency !== 'USDG') throw Error('rh-Lighter 计价币不匹配');
  if (['binance', 'aster', 'bybit', 'okx', 'bitget'].includes(market.exchange) && !['USDT', 'USDC', 'USD1'].includes(market.quoteCurrency)) throw unsupported('该计价币指标口径尚未核实');
  if (market.exchange === 'bitget' && market.productType !== `${market.quoteCurrency}-FUTURES`) throw Error('Bitget 指标产品类型不匹配');
}

/** Only complete quote-volume candles are persisted; prices and raw contracts are not sums. */
export function sanitizePerpetualMetricsReaderState(state, market, now) {
  if (market.exchange !== 'okx' || !state || state.version !== 1 || state.symbol !== market.symbol || state.currency !== market.quoteCurrency || !Array.isArray(state.candles) || state.candles.length > 288) return undefined;
  const rows = new Map();
  for (const row of state.candles) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 1e12 || row[0] % STEP || row[0] + STEP > now || amount(row[1]) === null || rows.has(row[0])) return undefined;
    rows.set(row[0], Number(row[1]));
  }
  return { version: 1, symbol: market.symbol, currency: market.quoteCurrency, candles: [...rows].sort(([a], [b]) => a - b) };
}

/** Public API references checked 2026-10-08. Batch caches are shared across pairs,
 * failures are cached too, and callers never get to select an upstream host.
 * Binance: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
 * Bybit: https://bybit-exchange.github.io/docs/v5/market/tickers
 * Bitget: https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market
 * OKX: https://app.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks
 * Gate: https://www.gate.com/docs/developers/apiv4/en/futures/
 * Kraken: https://docs.kraken.com/api-reference/market-data/get-tickers
 * Hyperliquid: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 * Lighter: https://github.com/elliottech/lighter-python/blob/main/docs/PerpsOrderBookDetail.md
 * Aster: https://asterdex.github.io/aster-api-website/futures/market-data/
 */
export function createPerpetualMetricsReader({ fetchImpl = fetch, clock = Date.now, cacheMs = PERPETUAL_MARKET_METRICS_REFRESH_MS, cacheLimit = 800, maxConcurrent = 3, hostSpacingMs = 150 } = {}) {
  const cache = new Map(), queue = [], activeHosts = new Set(), hostUntil = new Map(), rateLimitUntil = new Map(), candleCache = new Map();
  let active = 0, timer;
  const observed = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    const n = typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value) ? Date.parse(value) : amount(value);
    return Number.isSafeInteger(n) && n >= 1e12 && n <= clock() + 5000 ? n : null;
  };
  function pump() {
    clearTimeout(timer); timer = undefined;
    let wait = Infinity;
    for (let index = 0; index < queue.length && active < maxConcurrent;) {
      const job = queue[index], now = clock();
      if (job.signal.aborted) { queue.splice(index, 1); job.reject(aborted()); continue; }
      const blockedUntil = rateLimitUntil.get(job.host) ?? 0;
      if (blockedUntil > now) {
        queue.splice(index, 1);
        job.reject(Object.assign(Error('指标主机仍在限流退避期'), { status: 429, retryAfterMs: blockedUntil - now }));
        continue;
      }
      if (activeHosts.has(job.host)) { index++; continue; }
      const delay = (hostUntil.get(job.host) ?? 0) - now;
      if (delay > 0) { wait = Math.min(wait, delay); index++; continue; }
      queue.splice(index, 1); active++; activeHosts.add(job.host); hostUntil.set(job.host, now + hostSpacingMs);
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; activeHosts.delete(job.host); pump(); });
    }
    if (queue.length && wait < Infinity) { timer = setTimeout(pump, Math.max(1, wait)); timer.unref?.(); }
  }
  function schedule(url, signal, run) {
    return new Promise((resolve, reject) => {
      if (queue.length >= 1000) { reject(Error('指标请求队列已满')); return; }
      queue.push({ host: new URL(url).host, signal, run, resolve, reject }); pump();
    });
  }
  async function request(url, init, signal) {
    return schedule(url, signal, async () => {
      signal.throwIfAborted();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const response = await fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal });
      requestSignal.throwIfAborted();
      if (!response.ok) {
        const error = Object.assign(Error(`合约指标请求失败（HTTP ${response.status}）`), { status: response.status });
        const retry = response.headers?.get?.('retry-after');
        if (retry) { const value = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - clock(); if (Number.isFinite(value) && value >= 0) error.retryAfterMs = value; }
        if ([418, 429].includes(response.status)) {
          const host = new URL(url).host, until = clock() + Math.max(60_000, Math.min(900_000, error.retryAfterMs ?? 60_000));
          hostUntil.set(host, until); rateLimitUntil.set(host, until);
        }
        throw error;
      }
      const data = await response.json(); requestSignal.throwIfAborted();
      return { data, fetchedAt: clock() };
    });
  }
  function cached(key, url, init, signal, ttl = cacheMs) {
    signal?.throwIfAborted();
    let entry = cache.get(key);
    if (entry && !entry.promise && clock() >= entry.expires) { cache.delete(key); entry = null; }
    if (entry?.controller.signal.aborted) { cache.delete(key); entry = null; }
    if (!entry) {
      for (const [oldKey, old] of cache) { if (cache.size < cacheLimit) break; if (!old.promise) cache.delete(oldKey); }
      if (cache.size >= cacheLimit) return Promise.reject(Error('指标共享缓存繁忙'));
      entry = { controller: new AbortController(), users: 0, expires: Infinity, promise: null };
      cache.set(key, entry);
      entry.promise = request(url, init, entry.controller.signal).then(value => {
        entry.value = value; entry.expires = clock() + ttl; return value;
      }, error => {
        entry.error = error; entry.expires = clock() + Math.max(60_000, Math.min(900_000, error.retryAfterMs ?? 60_000)); throw error;
      }).finally(() => { entry.promise = null; if (entry.controller.signal.aborted && cache.get(key) === entry) cache.delete(key); });
    }
    if (!entry.promise) return entry.error ? Promise.reject(entry.error) : Promise.resolve(entry.value);
    const promise = entry.promise;
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const end = (fn, value) => { if (finished) return; finished = true; signal?.removeEventListener('abort', cancel); entry.users--; fn(value); if (!entry.users && entry.promise) entry.controller.abort(); };
      const cancel = () => end(reject, aborted());
      signal?.addEventListener('abort', cancel, { once: true });
      promise.then(value => end(resolve, value), error => end(reject, error));
      if (signal?.aborted) cancel();
    });
  }
  const get = (key, url, signal, ttl) => cached(key, url, {}, signal, ttl);
  const sourceBucket = () => Math.floor(clock() / STEP) * STEP;
  const keysFor = market => {
    const ex = market.exchange;
    if (ex === 'binance') return ['binance:tickers', `binance:oi:${market.symbol}:${sourceBucket()}`];
    if (ex === 'okx') return ['okx:oi', `okx:candles:${market.symbol}:${sourceBucket()}`];
    if (ex === 'bybit') return ['bybit:linear'];
    if (ex === 'bitget') return [`bitget:${market.productType}`];
    if (ex === 'gate') return ['gate:usdt'];
    if (ex === 'kraken') return ['kraken:tickers'];
    if (ex === 'hyperliquid' || ex === 'entropy') return [`hyperliquid:${ex === 'entropy' ? 'io' : ''}`];
    if (Object.hasOwn(LIGHTER_HOSTS, ex)) return [`${ex}:details`];
    if (ex === 'aster') return ['aster:tickers'];
    return [];
  };
  async function okxVolume(market, signal, state) {
    const key = `${market.symbol}:${market.quoteCurrency}`, end = Math.floor(clock() / STEP) * STEP;
    let saved = candleCache.get(key) ?? sanitizePerpetualMetricsReaderState(state, market, clock());
    const candles = new Map(saved?.candles ?? []);
    for (const time of candles.keys()) if (time < end - DAY || time >= end) candles.delete(time);
    const newest = Math.max(0, ...candles.keys());
    // Refill an interior hole instead of repeatedly fetching just the newest
    // bars while a permanently incomplete cached window ages for a day.
    const oldest = Math.min(end, ...candles.keys());
    const contiguous = candles.size && newest - oldest === (candles.size - 1) * STEP;
    const limit = newest && contiguous && oldest <= end - DAY ? Math.min(300, Math.ceil((end - newest) / STEP) + 2) : 300;
    const source = 'OKX 288 根已完成 5 分钟 K 线 volCcyQuote 合计；截至上一完整 5 分钟';
    const fetched = await get(`okx:candles:${market.symbol}:${end}`, `https://www.okx.com/api/v5/market/candles?${new URLSearchParams({ instId: market.symbol, bar: '5m', limit: String(limit) })}`, signal, STEP);
    const rows = list(success(fetched.data, 'okx').data), seen = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 9) throw Error('OKX 成交额 K 线格式异常');
      const time = observed(row[0], null), value = amount(row[7]);
      if (time === null || time % STEP || value === null || !['0', '1'].includes(String(row[8]))) throw Error('OKX 成交额 K 线字段无效');
      if (seen.has(time) && (seen.get(time)[0] !== value || seen.get(time)[1] !== String(row[8]))) throw Error('OKX 成交额 K 线重复冲突');
      seen.set(time, [value, String(row[8])]);
      if (String(row[8]) !== '1' || time < end - DAY || time >= end) continue;
      if (candles.has(time) && candles.get(time) !== value) throw Error('OKX 已完成成交额 K 线发生冲突');
      candles.set(time, value);
    }
    saved = { version: 1, symbol: market.symbol, currency: market.quoteCurrency, candles: [...candles].sort(([a], [b]) => a - b) };
    candleCache.delete(key); candleCache.set(key, saved);
    while (candleCache.size > 500) candleCache.delete(candleCache.keys().next().value);
    let total = 0;
    for (let time = end - DAY; time < end; time += STEP) {
      if (!candles.has(time)) return { metric: missing('缺少完整 24 小时已完成 K 线，暂不显示成交额', source), state: saved };
      total += candles.get(time);
    }
    return { metric: metric(total, market.quoteCurrency, end, source), state: saved };
  }
  const read = async (market, { signal, readerState } = {}) => {
    validateMarket(market); signal?.throwIfAborted();
    const ex = market.exchange, symbol = market.symbol, currency = market.quoteCurrency;
    if (ex === 'binance') {
      const results = await Promise.allSettled([
        get('binance:tickers', 'https://fapi.binance.com/fapi/v1/ticker/24hr', signal),
        get(`binance:oi:${symbol}:${sourceBucket()}`, `https://fapi.binance.com/futures/data/openInterestHist?${new URLSearchParams({ symbol, period: '5m', limit: '1' })}`, signal, STEP),
      ]);
      signal?.throwIfAborted();
      if (results.every(row => row.status === 'rejected')) throw results[0].reason;
      let volume24h = missing('Binance 成交额读取失败'), openInterest = missing('Binance 持仓金额读取失败');
      if (results[0].status === 'fulfilled') {
        const { data, fetchedAt } = results[0].value, row = indexRows(data, 'symbol').get(symbol);
        volume24h = row ? metric(row.quoteVolume, currency, observed(row.closeTime, fetchedAt), 'Binance 24h ticker quoteVolume') : missing('批量接口未返回该合约成交额');
      }
      if (results[1].status === 'fulfilled') {
        const rows = list(results[1].value.data);
        if (rows.length > 1 || rows.some(row => object(row).symbol !== symbol)) throw Error('Binance 持仓响应合约不匹配');
        openInterest = rows[0] ? metric(rows[0].sumOpenInterestValue, currency, observed(rows[0].timestamp, null), 'Binance 最近 5 分钟 sumOpenInterestValue') : missing('接口尚无该合约的持仓金额记录');
      }
      return { volume24h, openInterest };
    }
    if (ex === 'okx') {
      const results = await Promise.allSettled([get('okx:oi', 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP', signal), okxVolume(market, signal, readerState)]);
      signal?.throwIfAborted(); if (results.every(row => row.status === 'rejected')) throw results[0].reason;
      let openInterest = missing('OKX 持仓金额读取失败'), volume24h = missing('OKX 成交额读取失败'), state;
      if (results[0].status === 'fulfilled') { const { data, fetchedAt } = results[0].value, row = indexRows(success(data, ex).data, 'instId').get(symbol); openInterest = row ? metric(row.oiUsd, 'USD', observed(row.ts, fetchedAt), 'OKX public/open-interest oiUsd') : missing('批量接口未返回该合约持仓金额'); }
      if (results[1].status === 'fulfilled') { volume24h = results[1].value.metric; state = results[1].value.state; }
      return { volume24h, openInterest, readerState: state };
    }
    let fetched, row;
    if (ex === 'bybit') {
      fetched = await get('bybit:linear', 'https://api.bybit.com/v5/market/tickers?category=linear', signal);
      row = indexRows(success(fetched.data, ex).result?.list, 'symbol').get(symbol);
      if (!row) throw Error('Bybit 批量接口未返回该合约');
      const at = observed(fetched.data.time, fetched.fetchedAt);
      // The current official schema explicitly labels the legacy field as both
      // sides. Prefer the new single-side value, then halve the documented total.
      const single = amount(row.singleOpenInterestValue), both = amount(row.openInterestValue);
      return { volume24h: metric(row.turnover24h, currency, at, 'Bybit turnover24h'), openInterest: metric(single ?? (both === null ? null : both / 2), currency, at, single !== null ? 'Bybit singleOpenInterestValue（单边）' : 'Bybit openInterestValue（官方双边值 ÷ 2）') };
    }
    if (ex === 'bitget') {
      fetched = await get(`bitget:${market.productType}`, `https://api.bitget.com/api/v2/mix/market/tickers?productType=${encodeURIComponent(market.productType)}`, signal);
      row = indexRows(success(fetched.data, ex).data, 'symbol').get(symbol); if (!row) throw Error('Bitget 批量接口未返回该合约');
      const at = observed(row.ts, fetched.fetchedAt);
      return { volume24h: metric(row.quoteVolume, currency, at, 'Bitget quoteVolume（24h 计价币成交额）'), openInterest: metric(multiply(row.holdingAmount, row.markPrice), currency, at, 'Bitget holdingAmount（币）× 同次快照 markPrice') };
    }
    if (ex === 'gate') {
      fetched = await get('gate:usdt', 'https://api.gateio.ws/api/v4/futures/usdt/tickers', signal);
      row = indexRows(fetched.data, 'contract').get(symbol); if (!row) throw Error('Gate 批量接口未返回该合约');
      return { volume24h: metric(row.volume_24h_quote, currency, fetched.fetchedAt, 'Gate volume_24h_quote；时间为接口接收时刻'), openInterest: metric(multiply(row.total_size, row.mark_price, market.contractSize ?? null), currency, fetched.fetchedAt, 'Gate total_size（张）× quanto_multiplier（币/张）× mark_price；时间为接口接收时刻', '缺少持仓张数、已核实的合约乘数或标记价格') };
    }
    if (ex === 'kraken') {
      fetched = await get('kraken:tickers', 'https://futures.kraken.com/derivatives/api/v3/tickers?contractType=flexible_futures', signal);
      row = indexRows(success(fetched.data, ex).tickers, 'symbol').get(symbol); if (!row || row.tag !== 'perpetual') throw Error('Kraken 批量接口未返回该永续合约');
      if (typeof row.pair !== 'string' || row.pair.split(':')[1] !== 'USD' || row.pair.split(':')[0].replace(/^XBT$/, 'BTC') !== market.base) throw Error('Kraken 指标合约币种不匹配');
      const at = observed(fetched.data.serverTime, fetched.fetchedAt);
      return { volume24h: metric(row.volumeQuote, 'USD', at, 'Kraken Multi-M volumeQuote（24h USD 成交额）'), openInterest: metric(multiply(row.openInterest, row.markPrice), 'USD', at, 'Kraken PF openInterest（每币线性合约）× markPrice') };
    }
    if (ex === 'hyperliquid' || ex === 'entropy') {
      const dex = ex === 'entropy' ? 'io' : '';
      fetched = await cached(`hyperliquid:${dex}`, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', ...(dex ? { dex } : {}) }) }, signal);
      const data = list(fetched.data), universe = list(object(data[0]).universe), contexts = list(data[1]);
      if (data.length !== 2 || universe.length !== contexts.length || (ex === 'entropy' && data[0].collateralToken !== 0)) throw Error('Hyperliquid 指标与目录不匹配');
      indexRows(universe, 'name');
      const index = universe.findIndex(item => item.name === symbol);
      if (index < 0 || universe[index].isDelisted) throw Error('Hyperliquid 指标合约不匹配');
      row = object(contexts[index]);
      // Native contracts quote USDT except HYPE/PURR (USDC); USDC collateral
      // does not change the price denomination. HIP-3 io uses its verified USDC.
      return { volume24h: metric(row.dayNtlVlm, currency, fetched.fetchedAt, `${ex} dayNtlVlm；时间为接口接收时刻`), openInterest: metric(multiply(row.openInterest, row.markPx), currency, fetched.fetchedAt, `${ex} openInterest（原合约单位）× 原始 markPx；时间为接口接收时刻`) };
    }
    if (Object.hasOwn(LIGHTER_HOSTS, ex)) {
      fetched = await get(`${ex}:details`, `${LIGHTER_HOSTS[ex]}/api/v1/orderBookDetails`, signal);
      const rows = list(success(fetched.data, ex).order_book_details);
      const found = rows.filter(item => object(item).market_id === market.marketId);
      if (found.length !== 1 || found[0].symbol !== symbol || found[0].market_type !== 'perp') throw Error('Lighter 指标合约标识不匹配');
      row = found[0];
      return { volume24h: metric(row.daily_quote_token_volume, currency, fetched.fetchedAt, `${ex} daily_quote_token_volume；时间为接口接收时刻`), openInterest: missing('官方 REST open_interest 未明确币量或金额单位，暂不换算', `${ex} orderBookDetails：持仓金额口径待核实`) };
    }
    fetched = await get('aster:tickers', 'https://fapi.asterdex.com/fapi/v1/ticker/24hr', signal);
    row = indexRows(fetched.data, 'symbol').get(symbol); if (!row) throw Error('Aster 批量接口未返回该合约');
    return { volume24h: metric(row.quoteVolume, currency, observed(row.closeTime, fetched.fetchedAt), 'Aster 24h ticker quoteVolume'), openInterest: missing('Aster 官方市场接口文档尚无可核实的持仓金额字段', 'Aster 官方市场数据接口') };
  };
  // Only already settled responses qualify for the collector's bounded fast
  // path. A cold per-contract request still uses the ordinary host queue.
  read.isCached = market => {
    const keys = keysFor(market), now = clock();
    return keys.length > 0 && keys.every(key => { const entry = cache.get(key); return entry && !entry.promise && !entry.error && !entry.controller.signal.aborted && now < entry.expires; });
  };
  read.retryAt = market => rateLimitUntil.get(API_HOSTS[market.exchange]) ?? 0;
  read.stop = () => { clearTimeout(timer); for (const entry of cache.values()) if (entry.promise) entry.controller.abort(); for (const job of queue.splice(0)) job.reject(aborted()); };
  read.metrics = () => ({ cacheEntries: cache.size, queued: queue.length, inFlight: active, candleEntries: candleCache.size });
  return read;
}

export const createPerpetualMarketMetricsReader = createPerpetualMetricsReader;
