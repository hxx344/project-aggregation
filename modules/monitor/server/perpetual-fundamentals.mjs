const API_ROOT = 'https://api.coingecko.com/api/v3';
const DIRECTORY_TTL_MS = 24 * 60 * 60_000;
const MARKETS_TTL_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
// Canonical assets used by the monitor's normalized crypto markets; directory
// IDs/names checked against /coins/list. Never pick the largest homonymous token.
const DEFAULT_COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple',
  DOGE: 'dogecoin', ADA: 'cardano', TRX: 'tron', LINK: 'chainlink', AVAX: 'avalanche-2',
  DOT: 'polkadot', LTC: 'litecoin', BCH: 'bitcoin-cash', NEAR: 'near', SUI: 'sui',
  APT: 'aptos', ARB: 'arbitrum', OP: 'optimism', UNI: 'uniswap', AAVE: 'aave',
  ETC: 'ethereum-classic', XLM: 'stellar', HBAR: 'hedera-hashgraph', ICP: 'internet-computer',
  FIL: 'filecoin', INJ: 'injective-protocol', SEI: 'sei-network', TIA: 'celestia',
  LDO: 'lido-dao', JUP: 'jupiter-exchange-solana', ENA: 'ethena', WLD: 'worldcoin-wld',
  ONDO: 'ondo-finance', TAO: 'bittensor', RENDER: 'render-token', PYTH: 'pyth-network', PENDLE: 'pendle', ATOM: 'cosmos',
};

const baseKey = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const supportedBase = base => /^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(base);
const fresh = (at, now, ttl) => at !== null && now >= at && now - at < ttl;
function nonnegative(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function sourceTimestamp(value) {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}
function requestError(status, message, name = 'Error') {
  const error = new Error(message);
  error.status = status;
  error.name = name;
  return error;
}

/** USD fundamentals are independent of perpetual quote freshness and contract multipliers.
 * Keyless access is IP-limited; the caller owns retry/backoff scheduling.
 * https://docs.coingecko.com/demo/reference/coins-markets
 * https://docs.coingecko.com/demo/reference/coins-list
 */
export function createFundamentalsClient({ fetchImpl = fetch, coinIds = {}, apiKey = '', clock = Date.now } = {}) {
  const explicitIds = new Map(Object.entries({ ...DEFAULT_COIN_IDS, ...coinIds }).map(([base, id]) => [baseKey(base), id]));
  const cache = new Map();
  let directory = null, directoryAt = null, queue = Promise.resolve();

  async function request(path, signal) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      requestSignal.throwIfAborted();
      const headers = { Accept: 'application/json' };
      if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
      const response = await fetchImpl(`${API_ROOT}${path}`, { headers, signal: requestSignal });
      if (!response.ok) {
        const error = requestError(response.status, `CoinGecko HTTP ${response.status}`);
        const retryAfter = response.headers?.get?.('retry-after');
        if (retryAfter) error.retryAfter = retryAfter;
        throw error;
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw requestError(502, 'CoinGecko returned invalid market data');
      return data;
    } catch (error) {
      if (Number.isFinite(error?.status)) throw error;
      if (signal?.aborted || error?.name === 'AbortError') throw requestError(499, 'CoinGecko request aborted', 'AbortError');
      if (requestSignal.aborted || error?.name === 'TimeoutError') throw requestError(408, 'CoinGecko request timed out', 'TimeoutError');
      // Do not expose API keys, proxy credentials, or upstream error response bodies.
      throw requestError(502, 'CoinGecko request failed');
    }
  }

  async function ensureDirectory(signal) {
    if (directory && fresh(directoryAt, clock(), DIRECTORY_TTL_MS)) return;
    const rows = await request('/coins/list', signal);
    const byId = new Map(), bySymbol = new Map();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || typeof row.symbol !== 'string' || !row.symbol.trim()) continue;
      const coin = { id: row.id, symbol: baseKey(row.symbol), name: typeof row.name === 'string' ? row.name : row.id };
      byId.set(coin.id, coin);
      if (!bySymbol.has(coin.symbol)) bySymbol.set(coin.symbol, new Set());
      bySymbol.get(coin.symbol).add(coin.id);
    }
    if (!byId.size) throw requestError(502, 'CoinGecko returned an empty asset directory');
    directory = { byId, bySymbol };
    directoryAt = clock();
  }

  function resolve(base) {
    if (!supportedBase(base)) return { status: 'unsupported', coinId: null, reason: '独立合约规格或无效币种，未自动映射' };
    if (!directory) return { status: 'pending', coinId: null, reason: '等待资产目录' };
    if (explicitIds.has(base)) {
      const id = explicitIds.get(base);
      return typeof id === 'string' && directory.byId.has(id)
        ? { status: 'mapped', coinId: id }
        : { status: 'unmapped', coinId: null, reason: '指定的资产 ID 不在当前目录中' };
    }
    const candidates = [...(directory.bySymbol.get(base) ?? [])];
    if (candidates.length > 1) return { status: 'ambiguous', coinId: null, candidates, reason: '存在同名代币，需要明确资产 ID' };
    if (!candidates.length) return { status: 'unmapped', coinId: null, reason: '资产目录中未找到该币种' };
    return { status: 'mapped', coinId: candidates[0] };
  }

  function get(base) {
    const mapping = resolve(baseKey(base));
    if (!mapping.coinId) return null;
    const entry = cache.get(mapping.coinId);
    return entry?.value && fresh(entry.fetchedAt, clock(), MARKETS_TTL_MS) ? { ...entry.value } : null;
  }

  function describe(value) {
    const base = baseKey(value), mapping = resolve(base);
    if (mapping.status !== 'mapped') return { base, ...mapping };
    const entry = cache.get(mapping.coinId);
    if (!entry) return { base, coinId: mapping.coinId, status: 'pending', reason: '等待基本面数据' };
    if (!fresh(entry.fetchedAt, clock(), MARKETS_TTL_MS)) return { base, coinId: mapping.coinId, status: 'stale', updatedAt: entry.value?.updatedAt ?? null, reason: '基本面缓存已过期' };
    if (!entry.value) return { base, coinId: mapping.coinId, status: 'missing', reason: '数据源未返回该资产的基本面' };
    return { base, coinId: mapping.coinId, status: 'ready', updatedAt: entry.value.updatedAt, reason: null };
  }

  async function refreshNow(values, signal) {
    signal?.throwIfAborted();
    const bases = [...new Set(values.map(baseKey).filter(Boolean))];
    if (!bases.some(supportedBase)) return {};
    await ensureDirectory(signal);
    const ids = [...new Set(bases.map(base => resolve(base).coinId).filter(Boolean))];
    const pending = ids.filter(id => !fresh(cache.get(id)?.fetchedAt ?? null, clock(), MARKETS_TTL_MS))
      .sort((left, right) => (cache.get(left)?.fetchedAt ?? -Infinity) - (cache.get(right)?.fetchedAt ?? -Infinity))
      .slice(0, 1000);
    for (let offset = 0; offset < pending.length; offset += 250) {
      const batch = pending.slice(offset, offset + 250), requested = new Set(batch);
      const query = new URLSearchParams({ vs_currency: 'usd', ids: batch.join(','), per_page: '250', sparkline: 'false' });
      const rows = await request(`/coins/markets?${query}`, signal);
      const fetchedAt = clock(), results = new Map();
      for (const row of rows) {
        if (!row || !requested.has(row.id)) continue;
        const value = {
          coinId: row.id, name: typeof row.name === 'string' ? row.name : directory.byId.get(row.id).name,
          marketCapUsd: nonnegative(row.market_cap), fdvUsd: nonnegative(row.fully_diluted_valuation),
          circulatingSupply: nonnegative(row.circulating_supply), totalSupply: nonnegative(row.total_supply), maxSupply: nonnegative(row.max_supply),
          updatedAt: sourceTimestamp(row.last_updated), source: 'coingecko',
        };
        results.set(row.id, value);
      }
      // Cache missing rows too, so an unsupported coin cannot trigger a retry storm.
      for (const id of batch) cache.set(id, { fetchedAt, value: results.get(id) ?? null });
      if (cache.size > 4000) {
        const oldest = [...cache].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
        for (const [id] of oldest.slice(0, cache.size - 4000)) cache.delete(id);
      }
    }
    return Object.fromEntries(bases.map(base => [base, get(base)]).filter(([, value]) => value !== null));
  }

  function refresh(bases, { signal } = {}) {
    // Serialize callers so overlapping refreshes share already-cached directory/data.
    const values = [...bases];
    const result = queue.then(() => refreshNow(values, signal));
    queue = result.catch(() => {});
    return result;
  }
  return { refresh, get, describe };
}
