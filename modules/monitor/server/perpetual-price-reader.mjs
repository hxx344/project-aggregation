import { PRICE_HOUR_MS as HOUR } from '../lib/perpetual-price-history.ts';

const SUPPORTED = new Set(['binance', 'aster', 'bybit', 'gate', 'okx', 'bitget', 'hyperliquid', 'entropy']);
const MAX_CHUNK = 168 * HOUR;
const unsupported = reason => Object.assign(new Error(reason), { code: 'UNSUPPORTED' });
const numeric = input => {
  if (typeof input !== 'number' && (typeof input !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input))) throw Error('成交价历史数值无效');
  const value = Number(input);
  if (!Number.isFinite(value)) throw Error('成交价历史数值无效');
  return value;
};
const timestamp = input => {
  const value = numeric(input);
  if (!Number.isSafeInteger(value) || value < Date.UTC(2020, 0, 1)) throw Error('成交价历史时间无效');
  return value;
};
function validateMarket(market) {
  if (!market || !/^[a-z][a-z0-9-]{0,39}$/.test(market.exchange) || typeof market.symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(market.symbol)) throw Error('成交价历史合约无效');
  if (!SUPPORTED.has(market.exchange)) throw unsupported('该平台尚未接入已核实的成交价小时线。');
  if (!Number.isFinite(market.multiplier ?? 1) || (market.multiplier ?? 1) <= 0) throw Error('合约价格倍率无效');
  const currencies = ['binance', 'aster'].includes(market.exchange) ? ['USDT', 'USDC', 'USD1'] : ['hyperliquid', 'entropy'].includes(market.exchange) ? ['USDC', 'USD'] : ['USDT', 'USDC'];
  if (!currencies.includes(market.quoteCurrency)) throw unsupported('该计价币的成交价历史接口尚未核实。');
  if (market.exchange === 'gate' && (market.quoteCurrency !== 'USDT' || !/^[A-Z0-9._]+_USDT$/.test(market.symbol))) throw unsupported('Gate 暂只接入 USDT 永续成交价历史。');
  if (market.exchange === 'bitget' && market.productType !== undefined && market.productType !== `${market.quoteCurrency}-FUTURES`) throw Error('Bitget 产品类型不匹配');
  if (market.exchange === 'entropy' && !/^io:[A-Za-z0-9._-]+$/.test(market.symbol)) throw Error('Entropy 合约命名空间不匹配');
}

/** Public trade candles only. All times become the UTC hour's exclusive end;
 * directory multipliers convert package prices to one unit of the shared base.
 * No mark/index candles, FX assumptions, gap filling or partial candles. */
export function normalizePerpetualPriceCandles(exchange, rows, market, range, now) {
  if (!Array.isArray(rows) || rows.length > 2000) throw Error('成交价历史响应无效');
  const points = new Map();
  for (const row of rows) {
    let open, close, closed = true;
    if (['gate', 'hyperliquid', 'entropy'].includes(exchange)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('成交价历史记录无效');
      open = timestamp(exchange === 'gate' ? numeric(row.t) * 1000 : row.t); close = row.c;
      if (exchange !== 'gate') {
        if (row.s !== market.symbol || row.i !== '1h' || timestamp(row.T) !== open + HOUR - 1) throw Error('成交价历史合约或周期不匹配');
      }
    } else {
      if (!Array.isArray(row) || row.length < 5) throw Error('成交价历史记录无效');
      open = timestamp(row[0]); close = row[4];
      if (['binance', 'aster'].includes(exchange) && timestamp(row[6]) !== open + HOUR - 1) throw Error('成交价历史收盘时间不匹配');
      if (exchange === 'okx') {
        if (!['0', '1'].includes(String(row[8]))) throw Error('OKX K线确认状态无效');
        closed = String(row[8]) === '1';
      }
    }
    if (open % HOUR !== 0 || open > Math.floor(now / HOUR) * HOUR) throw Error('成交价历史小时边界无效');
    const time = open + HOUR;
    if (!closed || time > now) continue;
    const price = numeric(close) / (market.multiplier ?? 1);
    if (!(price > 0) || !Number.isFinite(price) || price > 1e20) throw Error('成交价历史价格无效');
    if (points.has(time) && points.get(time) !== price) throw Error('成交价历史重复记录冲突');
    points.set(time, price);
  }
  return [...points].filter(([time]) => time > range.from && time <= range.to).sort(([a], [b]) => a - b).map(([time, close]) => ({ time, close }));
}

/** Time pages stay below the smallest venue limit (Bitget: 200). A 30-day
 * request requires at most five pages; the service normally asks one page.
 * Official contracts checked 2026-10-11:
 * Binance: developers.binance.com/.../Kline-Candlestick-Data
 * Aster: asterdex.github.io/aster-api-website/futures/market-data/#klinecandlestick-data
 * Bybit: bybit-exchange.github.io/docs/v5/market/kline
 * Gate: gate.com/docs/developers/apiv4/en/futures/#get-futures-candlesticks
 * OKX: okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks-history
 * Bitget: bitget.com/docs/catalog/classic-contract-market/classic-contract-market
 * Hyperliquid: hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#candle-snapshot
 */
export function createPerpetualPriceReader({ fetchImpl = fetch, clock = Date.now, requestSpacingMs = 350 } = {}) {
  const lastRequest = new Map();
  return async (market, range, { signal } = {}) => {
    validateMarket(market);
    const now = timestamp(clock()), from = timestamp(range?.from), to = timestamp(range?.to);
    if (from >= to || from % HOUR || to % HOUR || to > now || to - from > 30 * 24 * HOUR) throw Error('成交价历史区间无效');
    const points = new Map();
    async function request(base, params, init = {}) {
      signal?.throwIfAborted();
      const host = new URL(base).host;
      const wait = Math.max(0, (lastRequest.get(host) ?? 0) + requestSpacingMs - clock());
      if (wait) await new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, wait);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted(); lastRequest.set(host, clock());
      const timeout = AbortSignal.timeout(10_000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(params ? `${base}?${new URLSearchParams(params)}` : base, { ...init, signal: requestSignal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      requestSignal.throwIfAborted();
      if (!response.ok) throw Object.assign(Error(`成交价历史请求失败（HTTP ${response.status}）`), { status: response.status });
      const data = await response.json(); requestSignal.throwIfAborted();
      return data;
    }
    // Work backwards so recent history becomes available first at the service.
    for (let end = to; end > from;) {
      signal?.throwIfAborted();
      const start = Math.max(from, end - MAX_CHUNK), exchange = market.exchange;
      let rows;
      if (exchange === 'binance' || exchange === 'aster') {
        rows = await request(exchange === 'binance' ? 'https://fapi.binance.com/fapi/v1/klines' : 'https://fapi.asterdex.com/fapi/v1/klines', { symbol: market.symbol, interval: '1h', startTime: String(start), endTime: String(end - 1), limit: '200' });
      } else if (exchange === 'bybit') {
        const data = await request('https://api.bybit.com/v5/market/kline', { category: 'linear', symbol: market.symbol, interval: '60', start: String(start), end: String(end - 1), limit: '200' });
        if (data?.retCode !== 0 || data.result?.symbol !== market.symbol || data.result.category !== 'linear') throw Error('Bybit 成交价历史响应无效');
        rows = data.result.list;
      } else if (exchange === 'gate') {
        rows = await request('https://api.gateio.ws/api/v4/futures/usdt/candlesticks', { contract: market.symbol, interval: '1h', from: String(start / 1000), to: String(end / 1000 - 1) });
      } else if (exchange === 'okx') {
        const data = await request('https://www.okx.com/api/v5/market/history-candles', { instId: market.symbol, bar: '1H', before: String(start - 1), after: String(end), limit: '300' });
        if (data?.code !== '0') throw Error('OKX 成交价历史响应无效');
        rows = data.data;
      } else if (exchange === 'bitget') {
        // endTime is an exact boundary; no rounding up by one extra interval.
        const data = await request('https://api.bitget.com/api/v2/mix/market/history-candles', { symbol: market.symbol, productType: `${market.quoteCurrency}-FUTURES`, granularity: '1H', startTime: String(start - HOUR), endTime: String(end), limit: '200' });
        if (data?.code !== '00000') throw Error('Bitget 成交价历史响应无效');
        rows = data.data;
      } else {
        rows = await request('https://api.hyperliquid.xyz/info', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: market.symbol, interval: '1h', startTime: start, endTime: end - 1 } }) });
      }
      for (const point of normalizePerpetualPriceCandles(exchange, rows, market, { from, to }, now)) {
        if (points.has(point.time) && points.get(point.time) !== point.close) throw Error('成交价历史分页记录冲突');
        points.set(point.time, point.close);
      }
      end = start;
    }
    return [...points].sort(([a], [b]) => a - b).map(([time, close]) => ({ time, close }));
  };
}
