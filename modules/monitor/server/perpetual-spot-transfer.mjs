// Public, unauthenticated data only. See docs/CROSSEX_SIGNALS.md for coverage.
export const SPOT_TRANSFER_TTL_MS = 180_000;
export const SPOT_TRANSFER_SOURCES = Object.freeze({
  binance: ['https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT&showPermissionSets=false', 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll'],
  gate: ['https://api.gateio.ws/api/v4/spot/currency_pairs', 'https://api.gateio.ws/api/v4/spot/currencies'],
});
export const TRANSFER_UNAVAILABLE = Object.freeze({
  bybit: '正式充提接口需要凭据，当前未接入可核验的公开链级数据',
  okx: '正式充提接口需要凭据，当前未接入可核验的公开链级数据',
  kraken: '公开资产状态不能确认共同网络的充值和提现状态',
  hyperliquid: '尚无可核验的对应现货与链级充提数据',
  lighter: '尚无可核验的对应现货与链级充提数据',
});
const baseName = value => typeof value === 'string' && /^[A-Z0-9]{1,30}$/.test(value);
// Only explicit network equivalences; unknown aliases must never be guessed.
const aliases = { ARBEVM: 'ARBITRUM', ARB: 'ARBITRUM', OPETH: 'OPTIMISM', BASEEVM: 'BASE', AVAX_C: 'AVAXC', MATIC: 'POLYGON' };
const networkName = value => typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? aliases[value] ?? value : null;
// Empty addresses are only accepted for an explicitly known native asset/network.
const native = { BTC: ['BTC'], ETH: ['ETH', 'ARBITRUM', 'OPTIMISM', 'BASE'], SOL: ['SOL'], BNB: ['BSC'], DOGE: ['DOGE'], LTC: ['LTC'], BCH: ['BCH'], XRP: ['XRP'], ADA: ['ADA'], DOT: ['DOT'], TRX: ['TRX'], AVAX: ['AVAXC'], SUI: ['SUI'], TON: ['TON'], NEAR: ['NEAR'], ATOM: ['ATOM'], XLM: ['XLM'] };
const evmNetworks = new Set(['ETH', 'ARBITRUM', 'OPTIMISM', 'BASE', 'BSC', 'AVAXC', 'POLYGON']);
const address = (value, network) => {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (!value) return '';
  if (evmNetworks.has(network)) return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  return value;
};
function chain(base, network, contract, deposit, withdraw) {
  const name = networkName(network), addr = contract === null && native[base]?.includes(name) ? '' : address(contract, name);
  if (!name || addr === null || (!addr && !native[base]?.includes(name))) return null;
  return { network: name, contract: addr, deposit: deposit === true, withdraw: withdraw === true };
}
// A duplicated network is ambiguous, even if one of its rows reports open transfers.
function uniqueNetworks(rows, networkField, parse) {
  if (!Array.isArray(rows)) return [];
  // Count raw canonical keys before validating address/status/asset fields: a
  // malformed closed record must not disappear and leave a conflicting open one.
  const networks = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => ({ row, network: networkName(row[networkField]) }));
  const counts = new Map();
  for (const entry of networks) if (entry.network) counts.set(entry.network, (counts.get(entry.network) ?? 0) + 1);
  return networks.filter(entry => entry.network && counts.get(entry.network) === 1).map(entry => parse(entry.row)).filter(Boolean);
}
function rows(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30_000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('公开数据格式无效');
  return value;
}

export function parseSpotTransfer(exchange, markets, currencies, now = Date.now()) {
  const result = new Map(), spot = new Map();
  const addSpot = (base, symbol) => { if (baseName(base) && typeof symbol === 'string' && /^[A-Z0-9_]{2,80}$/.test(symbol)) { const list = spot.get(base) ?? []; list.push(symbol); spot.set(base, list); } };
  if (exchange === 'binance') {
    for (const row of rows(markets?.symbols)) if (row.status === 'TRADING' && row.isSpotTradingAllowed === true) addSpot(row.baseAsset, row.symbol);
    if (currencies?.code !== '000000') throw new Error('Binance 公开充提数据不可用');
    for (const row of rows(currencies.data)) {
      if (!baseName(row.coin)) continue;
      if (result.has(row.coin)) throw new Error('币种记录重复');
      const networks = uniqueNetworks(row.networkList, 'network', n => n.coin !== row.coin ? null : chain(row.coin, n.network, n.contractAddress,
        row.depositAllEnable === true && n.depositEnable === true && row.depositHideAll === false && n.depositHideEnable === false,
        row.withdrawAllEnable === true && n.withdrawEnable === true && row.withdrawHideAll === false && n.withdrawHideEnable === false && n.busy === false));
      result.set(row.coin, { base: row.coin, spotSymbols: row.isLegalMoney === false && row.trading === true ? spot.get(row.coin) ?? [] : [], networks });
    }
  } else if (exchange === 'gate') {
    // Gate publishes buy/sell start times in epoch seconds; a tradable flag alone
    // must not admit a market whose advertised opening time has not arrived.
    const started = value => value === undefined || (Number.isSafeInteger(value) && value >= 0 && value * 1000 <= now);
    for (const row of rows(markets)) if (row.trade_status === 'tradable' && started(row.buy_start) && started(row.sell_start)
      && (row.type === undefined || row.type === 'normal') && (row.delisting_time === undefined || row.delisting_time === 0)) addSpot(row.base, row.id);
    for (const row of rows(currencies)) {
      if (!baseName(row.currency)) continue;
      if (result.has(row.currency)) throw new Error('币种记录重复');
      const networks = uniqueNetworks(row.chains, 'name', n => chain(row.currency, n.name, n.addr,
        row.deposit_disabled === false && n.deposit_disabled === false,
        row.withdraw_disabled === false && row.withdraw_delayed === false && n.withdraw_disabled === false && n.withdraw_delayed === false));
      result.set(row.currency, { base: row.currency, spotSymbols: row.delisted === false && row.trade_disabled === false ? spot.get(row.currency) ?? [] : [], networks });
    }
  } else throw new Error('没有可核验的公开充提数据');
  if (!result.size) throw new Error('公开币种目录为空');
  return result;
}

export function createSpotTransferReader({ fetchImpl = fetch, clock = Date.now } = {}) {
  async function json(url, signal) {
    const startedAt = clock();
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`公开数据请求失败（HTTP ${response.status}）`);
    const age = Number(response.headers.get('age') ?? 0);
    if (!Number.isFinite(age) || age < 0 || age * 1000 >= SPOT_TRANSFER_TTL_MS) throw new Error('公开数据缓存已经过期');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 16_000_000) throw new Error('公开数据超出容量限制'); chunks.push(chunk); }
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), at: startedAt - age * 1000 };
  }
  return async (exchange, signal) => {
    const sources = SPOT_TRANSFER_SOURCES[exchange];
    if (!sources) throw new Error('没有可核验的公开充提数据');
    const results = await Promise.allSettled(sources.map(url => json(url, signal)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const values = results.map(result => result.value);
    const at = Math.min(...values.map(value => value.at));
    return { at, assets: parseSpotTransfer(exchange, ...values.map(value => value.data), at) };
  };
}

export function spotTransferEvidence(long, short, metadata, now) {
  if (!Number.isFinite(now) || now <= 0 || !baseName(long.base) || long.base !== short.base || long.exchange === short.exchange) return null;
  const legs = [long, short].map(q => {
    const data = metadata.get(q.exchange), asset = data?.assets?.get(q.base);
    if (data?.error || !Number.isFinite(data?.at) || data.at <= 0 || data.at > now || now - data.at >= SPOT_TRANSFER_TTL_MS || !asset?.spotSymbols?.length || asset.base !== q.base || q.multiplier !== 1) return null;
    return { ...asset, at: data.at };
  });
  if (legs.some(leg => !leg)) return null;
  const networks = legs[0].networks.filter(a => a.deposit && a.withdraw && legs[1].networks.some(b => b.deposit && b.withdraw && a.network === b.network && a.contract === b.contract));
  return networks.length ? { networks: [...new Set(networks.map(n => n.network))].sort(), checkedAt: Math.min(...legs.map(leg => leg.at)), expiresAt: Math.min(...legs.map(leg => leg.at)) + SPOT_TRANSFER_TTL_MS } : null;
}
