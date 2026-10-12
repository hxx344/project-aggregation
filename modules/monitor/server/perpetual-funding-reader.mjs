import { createCexFundingHistoryReader } from '../lib/exchange-funding-cex.ts';
import { parseLighterFundingHistory } from '../lib/exchange-funding-service.ts';

const HOUR = 3_600_000;
const MAX_RANGE_MS = 4 * 24 * HOUR;
const MAX_PAGES = 32;
const CEX_EXCHANGES = new Set(['binance', 'bybit', 'okx', 'bitget', 'aster']);
const LIGHTER_HOSTS = { lighter: 'https://mainnet.zklighter.elliot.ai', 'rh-lighter': 'https://api.rh.lighter.xyz' };
const numeric = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw Error('历史资金费数值无效');
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw Error('历史资金费数值无效');
  return parsed;
};
const milliseconds = value => {
  const time = numeric(value);
  if (!Number.isSafeInteger(time) || time < Date.UTC(2020, 0, 1)) throw Error('历史资金费时间戳无效');
  return time;
};
const seconds = value => {
  const time = numeric(value);
  if (!Number.isSafeInteger(time) || time < 1_000_000_000 || time >= 100_000_000_000) throw Error('历史资金费秒时间戳无效');
  return milliseconds(time * 1000);
};
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('历史资金费响应格式无效');
  return value;
};
const list = value => {
  if (!Array.isArray(value)) throw Error('历史资金费记录列表无效');
  return value;
};
const unsupported = reason => Object.assign(new Error(reason), { code: 'UNSUPPORTED' });
function add(records, time, inputRate) {
  const rate = numeric(inputRate);
  if (Math.abs(rate) > 1) throw Error('历史资金费率超出有效范围');
  if (records.has(time) && records.get(time) !== rate) throw Error('历史资金费结算记录冲突');
  records.set(time, rate);
}
const result = (records, range) => [...records].filter(([time]) => time >= range.from && time <= range.to).sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));

function validateMarket(market) {
  if (!market || typeof market.exchange !== 'string' || typeof market.symbol !== 'string' || !market.symbol.trim() || market.symbol.length > 160 || /[\s/?#&]/.test(market.symbol)) throw Error('历史资金费合约元数据无效');
  if (market.exchange === 'kraken') {
    // The public history includes the rate currently accruing, not only settled
    // periods. Its timestamp semantics are not specified by the endpoint.
    // Never sum fundingRate (USD/contract/hour), or label the current relative
    // rate as settled. https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates
    throw unsupported('Kraken 历史接口包含当前计提周期，公开时间戳尚不能可靠对应已结算区间，暂不累计。');
  }
  if (CEX_EXCHANGES.has(market.exchange)) {
    const currencies = ['aster', 'binance'].includes(market.exchange) ? ['USDT', 'USDC', 'USD1'] : ['USDT', 'USDC'];
    if (!currencies.includes(market.quoteCurrency)) throw unsupported('该计价币的历史资金费接口尚未核实。');
    if (market.exchange === 'bitget' && market.productType !== undefined && market.productType !== `${market.quoteCurrency}-FUTURES`) throw Error('Bitget 历史资金费产品类型不匹配');
    return;
  }
  if (market.exchange === 'gate') {
    // The connected Gate directory contains USDT linear contracts only.
    if (market.quoteCurrency !== 'USDT' || !/^[A-Z0-9._]+_USDT$/.test(market.symbol)) throw unsupported('Gate 暂只支持已接入的 USDT 永续合约历史资金费。');
    return;
  }
  if (market.exchange === 'hyperliquid' || market.exchange === 'entropy') {
    if (market.exchange === 'entropy' && !/^io:[A-Za-z0-9._-]+$/.test(market.symbol)) throw Error('Entropy 历史资金费合约命名空间不匹配');
    return;
  }
  if (Object.hasOwn(LIGHTER_HOSTS, market.exchange)) {
    if (!Number.isInteger(market.marketId) || market.marketId < 0 || market.marketId > 32767) throw Error('Lighter 历史资金费缺少有效市场编号');
    return;
  }
  throw unsupported('该平台尚未提供已核实的历史结算资金费接口。');
}

function retryAfter(response, now) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

/** Public histories for exact directory-verified contracts. Returned rates are
 * decimal amounts at their actual settlement timestamps, in inclusive bounds.
 * The owning service controls market authorization, host budgets and caching. */
export function createPerpetualFundingReader({ fetchImpl = fetch, clock = Date.now, requestSpacingMs = 0 } = {}) {
  const lastRequest = new Map();
  return async (market, range, { signal, onProgress } = {}) => {
    validateMarket(market);
    const now = milliseconds(clock());
    const from = milliseconds(range?.from), to = milliseconds(range?.to);
    const maxRange = market.exchange === 'bitget' ? 32 * 24 * HOUR : MAX_RANGE_MS;
    if (from > to || to > now || to - from > maxRange) throw Error('历史资金费查询区间无效');
    range = { from, to };
    signal?.throwIfAborted();
    async function request(url, init = {}) {
      signal?.throwIfAborted();
      const host = new URL(url).host, delay = Math.max(0, (lastRequest.get(host) ?? 0) + requestSpacingMs - clock());
      if (delay) await new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, delay);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      signal?.throwIfAborted(); lastRequest.set(host, clock());
      const timeout = AbortSignal.timeout(10_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal });
      requestSignal.throwIfAborted();
      if (!response.ok) {
        const error = Object.assign(new Error(`历史资金费请求失败（HTTP ${response.status}）`), { status: response.status });
        const duration = retryAfter(response, clock());
        if (duration !== undefined) error.retryAfterMs = duration;
        throw error;
      }
      const data = await response.json();
      requestSignal.throwIfAborted();
      return data;
    }
    if (CEX_EXCHANGES.has(market.exchange)) {
      // The optional exact allowlist is created only from the server's verified
      // market. Existing oil readers retain their fixed BZ/CL allowlist.
      const read = createCexFundingHistoryReader({ request, clock: () => now, contracts: { [market.exchange]: [market.symbol] }, bitgetProductType: market.quoteCurrency === 'USDC' ? 'USDC-FUTURES' : 'USDT-FUTURES', onProgress: market.exchange === 'bitget' ? onProgress : undefined });
      return read(market.exchange, market.symbol, range);
    }
    if (Object.hasOwn(LIGHTER_HOSTS, market.exchange)) {
      // count_back overrides start_timestamp when nonzero. Ask for the entire
      // hourly window (<100 rows in four days), with one preceding hour because
      // this API uses candle-style start boundaries. Filter exact bounds below.
      // RH has its own deployment and market ids; never send them to mainnet.
      // https://apidocs.rh.lighter.xyz/reference/fundings
      // https://apidocs.lighter.xyz/reference/fundings
      const startSeconds = Math.floor(from / HOUR) * 3600 - 3600;
      const query = new URLSearchParams({ market_id: String(market.marketId), resolution: '1h', start_timestamp: String(startSeconds), end_timestamp: String(Math.floor(to / 1000)), count_back: '0' });
      const input = object(await request(`${LIGHTER_HOSTS[market.exchange]}/api/v1/fundings?${query}`));
      const raw = list(input.fundings);
      if (input.resolution !== '1h' || raw.length >= 750 || raw.some(row => seconds(object(row).timestamp) > to || seconds(row.timestamp) < startSeconds * 1000)) throw Error('Lighter 历史资金费查询区间不完整');
      if (input.market_id !== undefined && numeric(input.market_id) !== market.marketId) throw Error('Lighter 历史资金费市场编号不匹配');
      for (const row of raw) {
        numeric(row.rate);
        if (row.market_id !== undefined && numeric(row.market_id) !== market.marketId) throw Error('Lighter 历史资金费市场编号不匹配');
      }
      // Shared parser verifies payer direction, percentage-to-decimal units,
      // exact market id, duplicate conflicts and actual zero settlements.
      return parseLighterFundingHistory(input, market.marketId, to).filter(row => row.time >= from && row.time <= to).sort((a, b) => a.time - b.time);
    }
    const records = new Map();
    if (market.exchange === 'gate') {
      // Gate's time bounds are seconds; live checks confirm `to` is exclusive.
      // https://www.gate.com/docs/developers/apiv4/en/futures/#futures-market-historical-funding-rate
      let cursor = Math.floor(to / 1000) + 1;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ contract: market.symbol, limit: '100', from: String(Math.floor(from / 1000)), to: String(cursor) });
        const rows = list(await request(`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?${query}`));
        if (rows.length > 100) throw Error('Gate 历史资金费分页大小无效');
        if (!rows.length) return result(records, range);
        let oldest = Infinity;
        for (const value of rows) {
          const row = object(value), time = seconds(row.t);
          if ((row.contract !== undefined && row.contract !== market.symbol) || time > to || time >= cursor * 1000 || time < Math.floor(from / 1000) * 1000) throw Error('Gate 历史资金费合约或时间边界无效');
          add(records, time, row.r); oldest = Math.min(oldest, time);
        }
        if (rows.length < 100 || oldest <= from) return result(records, range);
        const next = oldest / 1000;
        if (next >= cursor) throw Error('Gate 历史资金费分页没有前进');
        cursor = next;
      }
      throw Error('Gate 历史资金费分页超限，不能返回截断记录');
    }
    // HIP-3 uses the complete directory name (e.g. io:SNDK), without stripping
    // or reassigning its namespace. These are historical, not predictedFundings.
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-historical-funding-rates
    let cursor = from;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = list(await request('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin: market.symbol, startTime: cursor, endTime: to }) }));
      if (rows.length > 500) throw Error('Hyperliquid 历史资金费分页大小无效');
      let newest = -Infinity;
      for (const value of rows) {
        const row = object(value), time = milliseconds(row.time);
        if (row.coin !== market.symbol || time < cursor || time > to) throw Error('Hyperliquid 历史资金费合约或时间边界无效');
        add(records, time, row.fundingRate); newest = Math.max(newest, time);
      }
      if (rows.length < 500 || newest >= to) return result(records, range);
      if (newest < cursor) throw Error('Hyperliquid 历史资金费分页没有前进');
      cursor = newest + 1;
    }
    throw Error('Hyperliquid 历史资金费分页超限，不能返回截断记录');
  };
}
