import { validIdentity, contractIdentity } from './model.mjs';
import { D } from './money.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR, MAX_BYTES = 8 * 1024 * 1024, MAX_PAGES = 3;
const BASE = Object.freeze({ binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com', okx: 'https://www.okx.com', gate: 'https://api.gateio.ws', kraken: 'https://futures.kraken.com', hyperliquid: 'https://api.hyperliquid.xyz', lighter: 'https://mainnet.zklighter.elliot.ai' });
const fail = message => { throw new Error(message); };
const decimal = (value, positive = false) => {
  if (!['string', 'number'].includes(typeof value) || String(value).length > 100 || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(String(value))) return null;
  try { const n = D(value); return n.abs().lte('1e30') && (!positive || n.gt(0)) ? n.toString() : null; } catch { return null; }
};
const time = value => { const n = Number(value); return Number.isSafeInteger(n) && n >= 1e12 && n < 5e12 ? n : null; };
const hours = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 24 ? Number(value) : null;
const array = value => Array.isArray(value) && value.length <= 50_000 ? value : fail('资金费响应列表无效');
const rowFor = (rows, field, symbol) => array(rows).find(row => row?.[field] === symbol) || fail('资金费响应合约不一致');
const source = (venue, path, params = {}) => { const url = new URL(path, BASE[venue]); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value)); return url.href; };
async function together(reads) { const results = await Promise.allSettled(reads), failed = results.find(row => row.status === 'rejected'); if (failed) throw failed.reason; return results.map(row => row.value); }

/** Fixed public endpoints only; no account identifier, key, signer or trading endpoint. */
export function createFundingClient({ fetcher = fetch, clock = Date.now, timeoutMs = 8000 } = {}) {
  const flights = new Map(), cache = new Map(), venueState = new Map();
  async function json(url, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(8000, Math.max(1, timeoutMs)));
    let response;
    try {
      response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) fail(`公开资金费来源响应 ${response.status}`);
      if (Number(response.headers?.get('content-length')) > MAX_BYTES) fail('资金费响应超过 8 MB');
      let size = 0; const chunks = [];
      if (!response.body) fail('资金费响应为空');
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) { controller.abort(); fail('资金费响应超过 8 MB'); } chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  const get = (venue, path, params) => json(source(venue, path, params));
  const info = body => json(source('hyperliquid', '/info'), body);
  function point(row, at, rate, url, extra = {}) {
    at = time(at); rate = decimal(rate);
    if (!row || at === null || at > clock() || rate === null) fail('资金费结算时间或费率无效');
    return { at, rate, markPrice: null, unit: 'rate', intervalHours: null, source: url, ...extra };
  }
  function current(rate, intervalHours, nextFundingAt, sourceAt, markPrice = null) {
    rate = decimal(rate); sourceAt = time(sourceAt);
    if (rate === null || sourceAt === null || sourceAt > clock() + 1000 || clock() - sourceAt > 180_000) fail('当前资金费缺少新鲜来源时间');
    return { rate, intervalHours: hours(intervalHours), nextFundingAt: time(nextFundingAt), sourceAt, markPrice: decimal(markPrice, true) };
  }
  async function readCurrent(q) {
    const { exchange: v, symbol } = q;
    if (v === 'binance') {
      const [row, intervals] = await together([get(v, '/fapi/v1/premiumIndex', { symbol }), get(v, '/fapi/v1/fundingInfo')]);
      if (row.symbol !== symbol) fail('Binance 当前资金费合约不一致');
      const adjustment = array(intervals).find(x => x.symbol === symbol);
      return current(row.lastFundingRate, adjustment ? adjustment.fundingIntervalHours : 8, row.nextFundingTime, row.time, row.markPrice);
    }
    if (v === 'bybit') {
      const [ticker, metadata] = await together([get(v, '/v5/market/tickers', { category: 'linear', symbol }), get(v, '/v5/market/instruments-info', { category: 'linear', symbol })]);
      if (ticker.retCode !== 0 || ticker.result?.category !== 'linear' || metadata.retCode !== 0) fail('Bybit 当前资金费响应无效');
      const row = rowFor(ticker.result.list, 'symbol', symbol), rule = rowFor(metadata.result?.list, 'symbol', symbol);
      return current(row.fundingRate, Number(rule.fundingInterval) / 60, row.nextFundingTime, ticker.time, row.markPrice);
    }
    if (v === 'okx') {
      const data = await get(v, '/api/v5/public/funding-rate', { instId: symbol });
      if (data.code !== '0') fail('OKX 当前资金费响应无效');
      const row = rowFor(data.data, 'instId', symbol);
      return current(row.fundingRate, (Number(row.nextFundingTime) - Number(row.fundingTime)) / HOUR, row.fundingTime, row.ts);
    }
    if (v === 'gate') {
      const row = await get(v, `/api/v4/futures/usdt/contracts/${encodeURIComponent(symbol)}`);
      if (row.name !== symbol || row.type !== 'direct' || row.in_delisting !== false) fail('Gate 当前合约未确认');
      return current(row.funding_rate, Number(row.funding_interval) / 3600, Number(row.funding_next_apply) * 1000, clock(), row.mark_price);
    }
    if (v === 'hyperliquid') {
      const data = await info({ type: 'metaAndAssetCtxs' });
      const index = array(data?.[0]?.universe).findIndex(row => row.name === symbol && !row.isDelisted);
      if (index < 0 || data[0].collateralToken !== 0) fail('Hyperliquid 当前合约未确认');
      const row = array(data[1])[index];
      // The next hour boundary is scheduled, and the current oracle price is not a historical settlement price.
      return current(row?.funding, 1, (Math.floor(clock() / HOUR) + 1) * HOUR, clock());
    }
    // Lighter's /funding-rates is a cross-venue comparison, not its live settlement feed.
    return null;
  }
  async function history(q, from, to) {
    const { exchange: v, symbol } = q, all = [];
    let exhausted = false, cursor = ['binance', 'hyperliquid'].includes(v) ? from : to, coveredFrom = from, coveredTo = to;
    if (v === 'kraken') {
      const url = source(v, '/derivatives/api/v3/historical-funding-rates', { symbol });
      const data = await json(url);
      const serverAt = time(Date.parse(data.serverTime));
      if (data.result !== 'success' || serverAt === null || serverAt > clock() + 1000 || clock() - serverAt > 180_000) fail('Kraken 历史资金费响应无效或来源过期');
      const rows = array(data.rates).map(row => ({ at: time(Date.parse(row.timestamp)), rate: decimal(row.fundingRate), relative: decimal(row.relativeFundingRate) })).sort((a, b) => a.at - b.at);
      if (!rows.length || rows.some((row, i) => row.at === null || row.rate === null || row.at > clock() || i && row.at <= rows[i - 1].at)) fail('Kraken 资金费历史缺失或重复');
      const accruals = rows.filter(row => row.at < to && row.at + HOUR > from).map(row => ({ at: row.at + HOUR, accrualStart: row.at, accrualEnd: row.at + HOUR, rate: row.rate, markPrice: null, unit: 'per_base', intervalHours: 1, source: url }));
      // A rate fixed at the start of each hour accrues continuously during that hour.
      let through = from;
      for (const row of accruals) { if (row.accrualStart > through) break; through = Math.max(through, Math.min(to, row.accrualEnd)); }
      const last = rows.at(-1);
      return { settlements: accruals.filter(row => row.at <= to), accruals, coveredFrom: rows[0].at <= from ? from : rows[0].at, coveredTo: through, complete: rows[0].at <= from && through >= to, source: url, current: clock() >= last.at && clock() < last.at + HOUR && last.relative !== null ? { rate: last.relative, intervalHours: 1, nextFundingAt: last.at + HOUR, sourceAt: Date.parse(data.serverTime), markPrice: null } : null };
    }
    if (v === 'lighter') {
      const data = await get(v, '/api/v1/orderBookDetails', { market_id: q.marketId });
      const row = rowFor(data.order_book_details, 'market_id', q.marketId);
      if (data.code !== 200 || row.symbol !== symbol || row.market_type !== 'perp' || row.status !== 'active' || Number(row.funding_premium_multiplier) !== 100 || Number(row.multiplier) !== 1) fail('Lighter 资金费 market_id 或合约身份变化');
    }
    for (let page = 0; page < MAX_PAGES; page++) {
      let rows, points, limit, url;
      if (v === 'binance') {
        limit = 1000; url = source(v, '/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime: to, limit }); rows = array(await json(url));
        points = rows.map(row => { if (row.symbol !== symbol || row.rateType && row.rateType !== 'Regular') fail('Binance 历史资金费合约或类型不一致'); return point(row, row.fundingTime, row.fundingRate, url, { markPrice: decimal(row.markPrice, true) }); });
      } else if (v === 'bybit') {
        limit = 200; url = source(v, '/v5/market/funding/history', { category: 'linear', symbol, startTime: from, endTime: cursor, limit }); const data = await json(url);
        if (data.retCode !== 0 || data.result?.category !== 'linear') fail('Bybit 历史资金费响应无效'); rows = array(data.result.list);
        points = rows.map(row => { if (row.symbol !== symbol) fail('Bybit 历史资金费合约不一致'); return point(row, row.fundingRateTimestamp, row.fundingRate, url); });
      } else if (v === 'okx') {
        limit = 400; url = source(v, '/api/v5/public/funding-rate-history', { instId: symbol, before: from - 1, after: cursor + 1, limit }); const data = await json(url);
        if (data.code !== '0') fail('OKX 历史资金费响应无效'); rows = array(data.data);
        // realizedRate, never the estimated fundingRate, is the rate that actually settled.
        points = rows.map(row => { if (row.instId !== symbol || row.instType !== 'SWAP') fail('OKX 历史资金费合约不一致'); return point(row, row.fundingTime, row.realizedRate, url); });
        coveredFrom = Math.max(from, clock() - 89 * DAY);
      } else if (v === 'gate') {
        limit = 1000; url = source(v, '/api/v4/futures/usdt/funding_rate', { contract: symbol, from: Math.floor(from / 1000), to: Math.floor(cursor / 1000), limit }); rows = array(await json(url));
        points = rows.map(row => point(row, Number(row.t) * 1000, row.r, url));
      } else if (v === 'hyperliquid') {
        limit = 500; url = source(v, '/info'); rows = array(await info({ type: 'fundingHistory', coin: symbol, startTime: cursor, endTime: to }));
        points = rows.map(row => { if (row.coin !== symbol) fail('Hyperliquid 历史资金费合约不一致'); return point(row, row.time, row.fundingRate, url, { intervalHours: 1 }); });
      } else {
        limit = 750; url = source(v, '/api/v1/fundings', { market_id: q.marketId, resolution: '1h', start_timestamp: Math.floor(from / 1000), end_timestamp: Math.floor(cursor / 1000), count_back: limit }); const data = await json(url);
        if (data.code !== 200 || data.resolution !== '1h') fail('Lighter 历史资金费响应无效'); rows = array(data.fundings);
        points = rows.map(row => {
          const rate = decimal(row.rate);
          if (rate === null || !['long', 'short'].includes(row.direction) || D(rate).lt(0)) fail('Lighter 资金费方向或百分比无效');
          return point(row, Number(row.timestamp) * 1000, D(rate).div(100).times(row.direction === 'long' ? 1 : -1).toString(), url, { intervalHours: 1 });
        });
      }
      if (rows.length > limit) fail('资金费历史超过分页上限');
      points.sort((a, b) => a.at - b.at);
      if (points.some((row, i) => i && row.at === points[i - 1].at)) fail('资金费历史包含重复结算');
      all.push(...points.filter(row => row.at >= from && row.at <= to));
      const forward = ['binance', 'hyperliquid'].includes(v);
      if (rows.length < limit || points.length && (forward ? points.at(-1).at >= to : points[0].at <= from)) { exhausted = true; break; }
      const next = forward ? points.at(-1).at + 1 : points[0].at - 1;
      if (forward ? next <= cursor : next >= cursor) fail('资金费分页未推进');
      cursor = next;
    }
    const unique = new Map();
    for (const row of all) { const old = unique.get(row.at); if (old && (old.rate !== row.rate || old.markPrice !== row.markPrice)) fail('同一结算出现冲突数据'); unique.set(row.at, row); }
    const settlements = [...unique.values()].sort((a, b) => a.at - b.at);
    for (let i = 1; i < settlements.length; i++) if (settlements[i].intervalHours === null) settlements[i].intervalHours = hours((settlements[i].at - settlements[i - 1].at) / HOUR);
    if (!exhausted && settlements.length) { if (['binance', 'hyperliquid'].includes(v)) coveredTo = settlements.at(-1).at; else coveredFrom = settlements[0].at; }
    return { settlements, coveredFrom, coveredTo, complete: exhausted && coveredFrom === from, source: BASE[v] };
  }
  function unknown(q, from, to, error) { return { exchange: q?.exchange ?? '', symbol: q?.symbol ?? '', from, to, coveredFrom: null, coveredTo: null, complete: false, source: BASE[q?.exchange] ?? '', sourceAt: clock(), current: null, settlements: [], error }; }
  async function collect(q, from, to) {
    const [past, present] = await Promise.allSettled([history(q, from, Math.min(to, clock())), readCurrent(q)]);
    if (past.status !== 'fulfilled') return unknown(q, from, to, past.reason?.message || '读取公开资金费失败');
    const value = past.value, current = value.current ?? (present.status === 'fulfilled' ? present.value : null);
    let complete = value.complete && to <= clock();
    if (!value.settlements.length && !value.accruals?.length) {
      // An empty history response is not proof of zero funding unless a native schedule excludes a settlement.
      const previous = current?.nextFundingAt - current?.intervalHours * HOUR;
      complete = !!(current?.nextFundingAt > to && Number.isFinite(previous) && previous < from && current.intervalHours !== null);
    }
    if (current?.intervalHours && current.nextFundingAt) {
      const lastDue = current.nextFundingAt - current.intervalHours * HOUR;
      if (lastDue >= from && lastDue <= to && !value.settlements.some(row => Math.abs(row.at - lastDue) < 1000) && !value.accruals) complete = false;
    }
    return { exchange: q.exchange, symbol: q.symbol, from, to, ...value, current, complete, sourceAt: clock(), ...(!complete ? { error: '历史覆盖不足、分页受限或结算数据尚未发布' } : {}), ...(present.status === 'rejected' ? { currentError: '当前资金费读取失败；历史结果单独保留' } : {}) };
  }
  async function read(q, from, to) {
    if (!validIdentity(q)) return unknown(q, from, to, '资金费合约身份无效');
    if (!time(from) || !time(to) || from > to || to - from > 366 * DAY) return unknown(q, from, to, '资金费区间须为有效毫秒时间，且最多 366 天');
    const key = JSON.stringify([contractIdentity(q), from, to]), previous = cache.get(key), now = clock();
    if (flights.has(key)) return structuredClone(await flights.get(key));
    if (previous && now >= previous.at && now - previous.at < 30_000) return structuredClone(previous.value);
    const state = venueState.get(q.exchange);
    if (state?.busy || state?.until > now) return unknown(q, from, to, '公开资金费查询冷却中，等待下一轮');
    venueState.set(q.exchange, { busy: true, until: now + 1000 });
    const flight = collect(q, from, to).catch(() => unknown(q, from, to, '读取公开资金费失败')).then(value => {
      cache.set(key, { at: clock(), value }); while (cache.size > 128) cache.delete(cache.keys().next().value);
      venueState.set(q.exchange, { busy: false, until: clock() + (value.coveredFrom === null ? 30_000 : 1000) }); return value;
    }).finally(() => flights.delete(key));
    flights.set(key, flight); return structuredClone(await flight);
  }
  return { read };
}
const defaultClient = createFundingClient();
export const loadFunding = (quote, from, to) => defaultClient.read(quote, from, to);
