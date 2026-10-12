// Public terminal feeds adapted from your-quantguy/gate-crossex at 423356d.
// Copyright (c) the original contributors. AGPL-3.0-only; see THIRD_PARTY_NOTICES.md.
import WebSocket from 'ws';
import { getJson, loadManualDepth } from './clients.mjs';
import { AppError, validateBooks } from './model.mjs';
import { D, Decimal } from './money.mjs';

const WS_URL = 'wss://api.gateio.ws/ws/crossex/public';
export const INTERVALS = Object.freeze({ '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 });
const BARS = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const numeric = (v, positive = false) => { try { return ['string', 'number'].includes(typeof v) && String(v).trim() && D(v).isFinite() && (!positive || D(v).gt(0)) ? D(v).toString() : null; } catch { return null; } };
const time = v => { if (typeof v !== 'number' && (typeof v !== 'string' || !/^[0-9]+$/.test(v))) return null; const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const failure = () => new AppError('公开历史行情响应无效', 502);
export function normalizeCandles(rows, interval, now, keep = 240) {
  if (!Array.isArray(rows) || rows.length > 5000) throw failure();
  const unique = new Map();
  for (const row of rows) {
    const candle = { time: time(row.time), open: numeric(row.open, true), high: numeric(row.high, true), low: numeric(row.low, true), close: numeric(row.close, true), volume: numeric(row.volume) };
    if (!candle.time || candle.time > now + 1000 || candle.time % INTERVALS[interval] !== 0 || Object.values(candle).some(v => v === null) || D(candle.volume).lt(0)
      || D(candle.high).lt(Decimal.max(candle.open, candle.close, candle.low)) || D(candle.low).gt(Decimal.min(candle.open, candle.close, candle.high))) throw failure();
    if (unique.has(candle.time)) throw failure();
    unique.set(candle.time, candle);
  }
  // Preserve genuine gaps. The chart must not manufacture missing candles.
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-keep);
}

export function createCandleReader({ fetcher = fetch, clock = Date.now } = {}) {
  const get = url => getJson(url, { fetcher, maxBytes: 4000000 });
  return async function candles(q, interval) {
    if (!Object.hasOwn(INTERVALS, interval)) throw new AppError('不支持的 K 线周期');
    const encoded = encodeURIComponent(q.symbol), end = clock(), start = end - INTERVALS[interval] * 240;
    let data, rows;
    if (q.exchange === 'binance') {
      data = await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=240`);
      rows = data?.map?.(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    } else if (q.exchange === 'bybit') {
      data = await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encoded}&interval=${BARS[interval]}&limit=240`);
      if (data.retCode !== 0) throw failure();
      rows = data.result?.list?.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    } else if (q.exchange === 'okx') {
      const bar = interval.endsWith('h') ? interval.toUpperCase() : interval === '1d' ? '1Dutc' : interval;
      data = await get(`https://www.okx.com/api/v5/market/candles?instId=${encoded}&bar=${bar}&limit=240`);
      if (data.code !== '0') throw failure();
      // OKX's seventh column is volume in base currency; column six is contracts.
      rows = data.data?.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[6] }));
    } else if (q.exchange === 'gate') {
      const [candles, contract] = await Promise.all([get(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encoded}&interval=${interval}&limit=240`), get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encoded}`)]);
      if (!numeric(contract.quanto_multiplier, true) || contract.name !== q.symbol) throw failure();
      rows = candles?.map?.(r => ({ time: Number(r.t) * 1000, open: r.o, high: r.h, low: r.l, close: r.c, volume: D(r.v).times(contract.quanto_multiplier).toString() }));
    } else if (q.exchange === 'kraken') {
      data = await get(`https://futures.kraken.com/api/charts/v1/trade/${encoded}/${interval}?count=240`);
      rows = data.candles?.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    } else if (q.exchange === 'hyperliquid') {
      // Public read-only POST. No account, authentication or order payload exists here.
      const response = await fetcher('https://api.hyperliquid.xyz/info', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: q.symbol, interval, startTime: start, endTime: end } }) });
      if (!response.ok) { await response.body?.cancel(); throw failure(); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body || []) { length += chunk.length; if (length > 4000000) throw failure(); chunks.push(chunk); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      rows = data?.map?.(r => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
    } else if (q.exchange === 'lighter') {
      if (!Number.isInteger(q.marketId) || q.marketId < 0) throw failure();
      data = await get(`https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=${q.marketId}&resolution=${interval}&start_timestamp=${start}&end_timestamp=${end}&count_back=240`);
      rows = data.c?.map(r => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
    } else if (q.exchange === 'deribit') {
      data = await get(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${encoded}&start_timestamp=${start}&end_timestamp=${end}&resolution=${interval === '4h' ? '60' : interval === '1d' ? '1D' : BARS[interval]}`);
      const r = data.result;
      if (data.error || !r || !['ok', 'no_data'].includes(r.status)) throw failure();
      if (r.status === 'no_data') return [];
      if (!Array.isArray(r.ticks) || ['open', 'high', 'low', 'close', 'volume'].some(k => r[k]?.length !== r.ticks.length)) throw failure();
      rows = r.ticks.map((t, i) => ({ time: t, open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume[i] }));
      if (interval === '4h') {
        const hours = normalizeCandles(rows, '1h', clock(), 960), buckets = new Map();
        for (const c of hours) { const t = Math.floor(c.time / INTERVALS['4h']) * INTERVALS['4h']; const list = buckets.get(t) || []; list.push(c); buckets.set(t, list); }
        // Only complete four-hour groups or a contiguous current partial bar are shown.
        rows = [...buckets].flatMap(([t, list]) => list[0].time === t && list.every((c, i) => c.time === t + i * INTERVALS['1h']) && (list.length === 4 || t + INTERVALS['4h'] > clock())
          ? [{ time: t, open: list[0].open, high: Decimal.max(...list.map(c => c.high)).toString(), low: Decimal.min(...list.map(c => c.low)).toString(), close: list.at(-1).close, volume: list.reduce((v, c) => v.plus(c.volume), D(0)).toString() }] : []);
      }
    } else throw new AppError('不支持此公开行情来源');
    return normalizeCandles(rows, interval, clock());
  };
}

/** Authenticated HTTP readers share one bounded, credential-free public stream. */
export function createTerminalMarket({ market, depthReader = loadManualDepth, candleReader = createCandleReader(), WebSocketImpl = WebSocket, clock = Date.now } = {}) {
  const entries = new Map(), subscribed = new Set();
  let socket = null, stopped = false, lastConnect = -Infinity;
  const active = e => clock() - e.touched < 120000;
  const bookChannel = symbol => symbol.startsWith('KRAKEN_') ? null : symbol.startsWith('BYBIT_') ? 'order_book_1' : 'order_book_5';
  const freshAt = (at, age = 10000) => time(at) && at <= clock() + 1000 && clock() - at <= age;
  const unitOf = e => ['gate', 'okx'].includes(e.display.quote.exchange) ? numeric(e.quote?.nativeUnit, true) : '1';
  // Keep the raw stream so a newly confirmed multiplier never mixes units.
  const streamBook = e => {
    if (!e.streamBook) return null;
    const unit = unitOf(e);
    return { ...e.streamBook, quantityUnit: unit ? 'base' : 'contracts', ...Object.fromEntries(['bids', 'asks'].map(side => [side, e.streamBook[side].map(([p, q]) => [p, unit ? D(q).times(unit).toString() : q])])) };
  };
  async function briefly(promise) {
    if (!promise) return;
    let timer;
    try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, 150); })]); }
    finally { clearTimeout(timer); }
  }
  function send(event, symbols) {
    if (socket?.readyState !== 1 || !symbols.length) return;
    symbols = symbols.filter(s => event === 'subscribe' ? !subscribed.has(s) : subscribed.has(s));
    if (!symbols.length) return;
    for (const channel of ['ticker', 'trade', 'funding_rate', 'mark_price', 'order_book_1', 'order_book_5']) {
      const payload = channel.startsWith('order_book_') ? symbols.filter(s => bookChannel(s) === channel) : symbols;
      if (payload.length) socket.send(JSON.stringify({ time: Math.floor(clock() / 1000), event, channel, payload }));
    }
    for (const s of symbols) if (event === 'subscribe') subscribed.add(s); else subscribed.delete(s);
  }
  function ensureSocket() {
    if (stopped || socket || clock() - lastConnect < 5000) return;
    lastConnect = clock();
    let current;
    try { current = new WebSocketImpl(WS_URL, { maxPayload: 1000000, handshakeTimeout: 8000 }); } catch { return; }
    socket = current;
    current.on('open', () => { if (current === socket) send('subscribe', [...entries].filter(([, e]) => active(e) && e.display).map(([s]) => s)); });
    current.on('error', () => { current.close(); });
    current.on('close', () => { if (current === socket) { socket = null; subscribed.clear(); } });
    current.on('message', raw => {
      try {
        const m = JSON.parse(String(raw)), r = m.result, e = entries.get(r?.s);
        if (m.event !== 'update' || !e?.display || !active(e)) return;
        if (m.channel === 'ticker' && numeric(r.lp, true) && numeric(r.bp, true) && numeric(r.ap, true) && time(r.ts) && r.ts <= clock() + 1000 && clock() - r.ts <= 10000) {
          if (e.tickerAt && r.ts < e.tickerAt || D(r.bp).gt(r.ap)) return;
          e.ticker = { ...e.ticker, lastPrice: numeric(r.lp), change24h: numeric(r.o, true) ? D(r.lp).div(r.o).minus(1).toString() : null,
            // Volume units differ by venue on WS; do not label unknown units as base.
            volume24h: null, bidPrice: numeric(r.bp), askPrice: numeric(r.ap) }; e.tickerAt = time(r.ts);
        } else if (m.channel === bookChannel(r.s) && freshAt(r.ts) && (!e.streamBook || r.ts >= e.streamBook.at)) {
          const sides = {};
          for (const [side, rows] of [['bids', r.b], ['asks', r.a]]) {
            const limit = m.channel === 'order_book_1' ? 1 : 5;
            if (!Array.isArray(rows) || !rows.length || rows.length > limit) return;
            sides[side] = rows.map(row => Array.isArray(row) && row.length >= 2 ? [numeric(row[0], true), numeric(row[1], true)] : [null, null]);
            if (sides[side].some(row => row.some(v => v === null))) return;
            for (let i = 1; i < sides[side].length; i++) if (side === 'bids' ? D(sides[side][i][0]).gte(sides[side][i - 1][0]) : D(sides[side][i][0]).lte(sides[side][i - 1][0])) return;
          }
          if (D(sides.bids[0][0]).gt(sides.asks[0][0])) return;
          e.streamBook = { ...sides, at: time(r.ts) };
        } else if (m.channel === 'mark_price' && numeric(r.mp, true) && freshAt(m.time_ms) && (!e.mark || m.time_ms >= e.mark.at)) {
          e.mark = { price: numeric(r.mp), at: time(m.time_ms) };
        } else if (m.channel === 'funding_rate' && numeric(r.r) !== null && time(r.T) && r.T > clock() && time(m.time_ms)
          && m.time_ms <= clock() + 1000 && clock() - m.time_ms < 60000 && (!e.funding || m.time_ms >= e.funding.at)) {
          e.funding = { fundingRate: numeric(r.r), nextFundingAt: time(r.T), at: time(m.time_ms) };
        } else if (m.channel === 'trade' && typeof r.i === 'string' && r.i.length > 0 && r.i.length < 200 && numeric(r.p, true) && numeric(r.q, true) && ['BUY', 'SELL'].includes(r.S) && time(r.ts) && r.ts <= clock() + 1000 && clock() - r.ts < 300000) {
          if (!e.trades.some(t => t.id === r.i)) e.trades = [{ id: r.i, price: numeric(r.p), quantity: numeric(r.q), side: r.S, at: time(r.ts) }, ...e.trades].sort((a, b) => b.at - a.at).slice(0, 60);
        }
      } catch { /* Invalid public frames never replace validated data. */ }
    });
  }
  const sweep = setInterval(() => {
    const removed = [];
    for (const [symbol, e] of entries) if (!active(e) && !e.flight && !e.displayFlight) { removed.push(symbol); entries.delete(symbol); }
    send('unsubscribe', removed);
    if (!entries.size) { socket?.close(); socket = null; subscribed.clear(); }
    else if (socket?.readyState === 1) socket.ping();
  }, 25000); sweep.unref();
  async function read(symbol, interval = '5m') {
    if (stopped) throw new AppError('行情服务已停止', 503);
    if (!Object.hasOwn(INTERVALS, interval)) throw new AppError('不支持的 K 线周期');
    if (typeof symbol !== 'string' || !/^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/.test(symbol)) throw new AppError('合约格式无效');
    let e = entries.get(symbol);
    if (!e) {
      if (entries.size >= 12) {
        const oldest = [...entries].filter(([, x]) => !x.flight && !x.displayFlight).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw new AppError('行情查询繁忙，请稍后重试', 429);
        send('unsubscribe', [oldest[0]]); entries.delete(oldest[0]);
      }
      e = { touched: clock(), book: null, bookAttempt: -Infinity, identityAttempt: -Infinity, flight: null, ticker: {}, tickerAt: 0, trades: [], candles: new Map() }; entries.set(symbol, e);
    }
    e.touched = clock();
    // A current CrossEx listing authorizes public subscription, not execution.
    if (!e.displayFlight) e.displayFlight = Promise.resolve().then(() => (market.resolveDisplaySymbol ?? market.resolveSymbol)(symbol)).finally(() => { e.displayFlight = null; });
    try { e.display = await e.displayFlight; }
    catch (error) { if (entries.get(symbol) === e) { send('unsubscribe', [symbol]); entries.delete(symbol); } throw error; }
    if (stopped) throw new AppError('行情服务已停止', 503);
    if (entries.get(symbol) !== e) throw new AppError('行情查询已失效，请重试', 409);
    ensureSocket(); send('subscribe', [symbol]);
    if (!e.flight && clock() - e.bookAttempt >= 1500) {
      e.bookAttempt = clock();
      e.flight = (async () => {
        try {
          // Display metadata has a bounded retry interval. Actual preview and
          // confirmation resolve current native metadata independently.
          if (clock() - e.identityAttempt >= 30000) {
            e.identityAttempt = clock();
            let resolved;
            try { resolved = await market.resolveSymbol(symbol); }
            catch (error) { e.quote = null; e.tradingError = error instanceof AppError ? error.message : '原生合约身份暂未确认'; throw error; }
            const { quote, rule } = resolved;
            if (e.quote && (e.quote.symbol !== quote.symbol || e.quote.nativeUnit !== quote.nativeUnit)) { e.book = null; e.candles.clear(); }
            e.quote = quote; e.rule = rule;
          }
          if (!e.quote) throw new AppError(e.tradingError || '原生合约身份暂未确认');
          if (stopped) return;
          e.tradingError = null;
          if (e.streamBook && freshAt(e.streamBook.at)) return;
          const book = await depthReader(e.quote); validateBooks([book, book], clock());
          if (e.book && book.at < e.book.at) throw new AppError('盘口来源时间回退');
          e.book = { bids: book.bids.map(r => r.map(String)), asks: book.asks.map(r => r.map(String)), at: book.at, quantityUnit: 'base' }; e.error = null;
        } catch (error) { e.error = error instanceof AppError ? error.message : '公开盘口暂不可用';
          if (!e.quote) e.tradingError = e.error;
        }
      })().finally(() => { e.flight = null; });
    }
    await briefly(e.flight);
    if (stopped) throw new AppError('行情服务已停止', 503);
    let history = e.candles.get(interval);
    if (e.quote && (!history || clock() - history.at >= 15000)) {
      if (!history) { history = { data: [], at: -Infinity, flight: null, error: null }; e.candles.set(interval, history); }
      if (!history.flight) {
        history.at = clock();
        history.flight = Promise.resolve().then(() => candleReader(e.quote, interval)).then(rows => { history.data = normalizeCandles(rows, interval, clock()); history.error = null; }, () => { history.error = '历史 K 线暂不可用'; }).catch(() => { history.error = '历史 K 线响应无效'; }).finally(() => { history.flight = null; });
      }
    }
    await briefly(history?.flight);
    const publicBook = streamBook(e), book = publicBook && (!e.book || publicBook.at >= e.book.at) ? publicBook : e.book;
    const bookFresh = book && freshAt(book.at), tickerFresh = freshAt(e.tickerAt);
    const currentBbo = tickerFresh && (!bookFresh || e.tickerAt > book.at);
    const fresh = (bookFresh && (book === publicBook || !e.error)) || tickerFresh, asOf = currentBbo ? e.tickerAt : book?.at ?? null;
    const unit = unitOf(e), tradingAvailable = !!e.quote && !e.tradingError;
    return { symbol, exchange: e.quote?.exchange ?? symbol.split('_')[0].toLowerCase(), base: e.quote?.base ?? symbol.split('_')[2], quoteCurrency: e.quote?.quoteCurrency ?? symbol.split('_').at(-1),
      status: fresh ? 'live' : book ? 'stale' : 'unavailable', asOf, error: fresh ? null : e.error ?? '等待公开盘口',
      tradingAvailable, tradingReason: tradingAvailable ? null : `暂不可交易：${e.tradingError || '正在确认原生合约身份和数量单位'}`,
      ticker: { lastPrice: null, change24h: null, volume24h: null, ...(tickerFresh ? e.ticker : {}),
        bidPrice: currentBbo ? e.ticker.bidPrice : book?.bids[0]?.[0] ?? null, askPrice: currentBbo ? e.ticker.askPrice : book?.asks[0]?.[0] ?? null,
        markPrice: e.mark && freshAt(e.mark.at) ? e.mark.price : null, markPriceAt: e.mark && freshAt(e.mark.at) ? e.mark.at : null,
        ...(e.funding && freshAt(e.funding.at, 60000) && e.funding.nextFundingAt > clock() ? { fundingRate: e.funding.fundingRate, nextFundingAt: e.funding.nextFundingAt } : { fundingRate: null, nextFundingAt: null }) },
      book, candles: history?.data ?? [], candleError: history?.error ?? (!e.quote ? '尚未确认原生历史 K 线来源' : null), candleAsOf: history && Number.isFinite(history.at) ? history.at : null,
      trades: e.trades.filter(t => clock() - t.at < 300000).map(t => ({ ...t, quantity: unit ? D(t.quantity).times(unit).toString() : t.quantity, quantityUnit: unit ? 'base' : 'contracts' })), interval };
  }
  return { read, async stop() { stopped = true; clearInterval(sweep); socket?.close(); socket = null; await Promise.allSettled([...entries.values()].flatMap(e => [e.displayFlight, e.flight, ...[...e.candles.values()].map(h => h.flight)])); entries.clear(); } };
}
