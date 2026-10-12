import { createHmac } from 'node:crypto';
import { nextAsterNonce, validateAsterWallet } from './exchanges.ts';
import type { AsterCredential, BinanceCredential, BybitCredential } from './exchanges.ts';
import type { OkxCredential } from './okx.ts';
import type { Position } from './positions-types.ts';
import { absolute, decimal, isZero, multiplyDecimals, optionalDecimal, position, positionId, record, rows, text, timestamp, uniquePositions, POSITIONS_FAILED, POSITIONS_INVALID } from './positions-values.ts';

type Fetcher = typeof fetch;
type Json = Record<string, unknown>;
const BYBIT_HOSTS = { global: 'https://api.bybit.com', nl: 'https://api.bybit.nl', tr: 'https://api.bybit-tr.com', kz: 'https://api.bybit.kz', ge: 'https://api.bybitgeorgia.ge', ae: 'https://api.bybit.ae', eu: 'https://api.bybit.eu' };
const ENDPOINTS = {
  binance: new Set(['/sapi/v1/account/apiRestrictions', '/fapi/v3/positionRisk', '/papi/v1/um/positionRisk', '/fapi/v1/exchangeInfo',
    '/dapi/v1/positionRisk', '/papi/v1/cm/positionRisk', '/dapi/v1/exchangeInfo']),
  bybit: new Set(['/v5/user/query-api', '/v5/position/list', '/v5/market/instruments-info']),
  okx: new Set(['/api/v5/account/config', '/api/v5/account/positions', '/api/v5/public/instruments']),
  aster: new Set(['/fapi/v3/positionRisk', '/fapi/v3/exchangeInfo']),
};

async function getJson(url: string, headers: Record<string, string>, fetcher: Fetcher, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 2_000_000) throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2_000_000) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error(POSITIONS_FAILED); }
}

/** Every authenticated request is a fixed GET; callers cannot supply hosts or write paths. */
export async function positionsGet(exchange: 'binance' | 'bybit' | 'okx', credential: BinanceCredential | BybitCredential | OkxCredential,
  path: string, params: URLSearchParams, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<unknown> {
  if (!ENDPOINTS[exchange].has(path)) throw new Error('仅允许只读仓位接口');
  const c = credential; const query = new URLSearchParams(params); const headers: Record<string, string> = {};
  let host: string; let payload: unknown;
  if (exchange === 'binance') {
    host = path.startsWith('/sapi/') ? 'https://api.binance.com' : path.startsWith('/papi/') ? 'https://papi.binance.com'
      : path.startsWith('/dapi/') ? 'https://dapi.binance.com' : 'https://fapi.binance.com';
    if (!path.endsWith('/exchangeInfo')) {
      query.set('timestamp', String(Date.now())); query.set('recvWindow', '10000');
      query.set('signature', createHmac('sha256', c.apiSecret).update(query.toString()).digest('hex'));
      headers['X-MBX-APIKEY'] = c.apiKey;
    }
    payload = await getJson(host + path + (query.size ? '?' + query : ''), headers, fetcher, signal);
    if (!Array.isArray(payload) && Object.hasOwn(record(payload), 'code')) throw new Error(POSITIONS_FAILED);
    return payload;
  }
  if (exchange === 'bybit') {
    const region = (c as BybitCredential).region;
    if (!Object.hasOwn(BYBIT_HOSTS, region)) throw new Error(POSITIONS_FAILED);
    host = BYBIT_HOSTS[region];
    if (!path.startsWith('/v5/market/')) {
      const at = String(Date.now());
      Object.assign(headers, { 'X-BAPI-API-KEY': c.apiKey, 'X-BAPI-TIMESTAMP': at, 'X-BAPI-RECV-WINDOW': '10000',
        'X-BAPI-SIGN': createHmac('sha256', c.apiSecret).update(at + c.apiKey + '10000' + query).digest('hex') });
    }
    const data = record(await getJson(host + path + (query.size ? '?' + query : ''), headers, fetcher, signal));
    if (data.retCode !== 0) throw new Error(POSITIONS_FAILED);
    return record(data.result);
  }
  host = 'https://openapi.okx.com';
  const requestPath = path + (query.size ? '?' + query : '');
  if (!path.startsWith('/api/v5/public/')) {
    const at = new Date().toISOString();
    Object.assign(headers, { 'OK-ACCESS-KEY': c.apiKey, 'OK-ACCESS-TIMESTAMP': at, 'OK-ACCESS-PASSPHRASE': (c as OkxCredential).passphrase,
      'OK-ACCESS-SIGN': createHmac('sha256', c.apiSecret).update(at + 'GET' + requestPath).digest('base64') });
  }
  const data = record(await getJson(host + requestPath, headers, fetcher, signal));
  if (data.code !== '0') throw new Error(POSITIONS_FAILED);
  return rows(data.data);
}

function signedQuantity(row: Json, field: string, sideField: string): { quantity: string; side: Position['side'] } | null {
  const quantity = decimal(row[field]); if (isZero(quantity)) return null;
  const side = row[sideField];
  if (!['BOTH', 'LONG', 'SHORT', 'net', 'long', 'short'].includes(String(side))) throw new Error(POSITIONS_INVALID);
  if (side === 'LONG' || side === 'long') { if (quantity.startsWith('-')) throw new Error(POSITIONS_INVALID); return { quantity, side: 'long' }; }
  if (side === 'SHORT' || side === 'short') return { quantity, side: 'short' };
  return { quantity, side: quantity.startsWith('-') ? 'short' : 'long' };
}

function normalizeLinear(data: unknown, metadata: unknown): Position[] {
  const instruments = new Map(rows(record(metadata).symbols).map(item => [text(item.symbol), item]));
  return uniquePositions(rows(data).flatMap(row => {
    const parsed = signedQuantity(row, 'positionAmt', 'positionSide'); if (!parsed) return [];
    const symbol = text(row.symbol), instrument = instruments.get(symbol); if (!instrument) throw new Error(POSITIONS_INVALID);
    const base = text(instrument.baseAsset), quote = text(instrument.quoteAsset), settlement = text(instrument.marginAsset);
    const result = position(symbol, parsed.side, parsed.quantity, base);
    return [{ ...result, contractSize: '1', entryPrice: optionalDecimal(row.entryPrice), markPrice: optionalDecimal(row.markPrice),
      notional: row.notional === undefined ? null : absolute(decimal(row.notional)), unrealizedPnl: optionalDecimal(row.unRealizedProfit),
      leverage: optionalDecimal(row.leverage), liquidationPrice: optionalDecimal(row.liquidationPrice),
      priceCurrency: quote, notionalCurrency: quote, pnlCurrency: settlement,
      marginMode: typeof row.marginType === 'string' ? text(row.marginType) : null, sourceUpdatedAt: timestamp(row.updateTime) }];
  }));
}

export type BinanceScope = 'um' | 'pm-um' | 'cm' | 'pm-cm';
export async function readBinancePositions(c: BinanceCredential, fetcher: Fetcher = fetch, signal?: AbortSignal, scope: BinanceScope = 'um'): Promise<Position[]> {
  const permissions = record(await positionsGet('binance', c, '/sapi/v1/account/apiRestrictions', new URLSearchParams(), fetcher, signal));
  const writes = ['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
  if (permissions.enableReading !== true || writes.some(key => permissions[key] !== false)
    || ['enableFixApiTrade', 'enablePortfolioMarginTrading'].some(key => Object.hasOwn(permissions, key) && permissions[key] !== false)) throw new Error(POSITIONS_FAILED);
  const coinMargined = scope === 'cm' || scope === 'pm-cm', portfolioMargin = scope.startsWith('pm-');
  const path = portfolioMargin ? '/papi/v1/' + (coinMargined ? 'cm' : 'um') + '/positionRisk' : coinMargined ? '/dapi/v1/positionRisk' : '/fapi/v3/positionRisk';
  const data = await positionsGet('binance', c, path, new URLSearchParams(), fetcher, signal);
  if (!rows(data).some(row => !isZero(decimal(row.positionAmt)))) return [];
  const metadata = await positionsGet('binance', c, coinMargined ? '/dapi/v1/exchangeInfo' : '/fapi/v1/exchangeInfo', new URLSearchParams(), fetcher, signal);
  const result = coinMargined ? normalizeBinanceInverse(data, metadata) : normalizeLinear(data, metadata);
  return portfolioMargin ? result.map(item => ({ ...item, marginMode: 'portfolio' })) : result;
}

function normalizeBinanceInverse(data: unknown, metadata: unknown): Position[] {
  const instruments = new Map(rows(record(metadata).symbols).map(item => [text(item.symbol), item]));
  return uniquePositions(rows(data).flatMap(row => {
    const parsed = signedQuantity(row, 'positionAmt', 'positionSide'); if (!parsed) return [];
    const symbol = text(row.symbol), instrument = instruments.get(symbol); if (!instrument) throw new Error(POSITIONS_INVALID);
    const quote = text(instrument.quoteAsset), settlement = text(instrument.marginAsset);
    const contractSize = decimal(typeof instrument.contractSize === 'number' && Number.isSafeInteger(instrument.contractSize)
      ? String(instrument.contractSize) : instrument.contractSize);
    if (contractSize.startsWith('-') || isZero(contractSize)) throw new Error(POSITIONS_INVALID);
    const item = position(symbol, parsed.side, parsed.quantity, '张（' + quote + '/张）');
    return [{ ...item, contractSize, entryPrice: optionalDecimal(row.entryPrice), markPrice: optionalDecimal(row.markPrice),
      notional: multiplyDecimals(absolute(parsed.quantity), contractSize), notionalCurrency: quote, priceCurrency: quote,
      unrealizedPnl: optionalDecimal(row.unRealizedProfit), pnlCurrency: settlement, leverage: optionalDecimal(row.leverage),
      liquidationPrice: optionalDecimal(row.liquidationPrice), marginMode: typeof row.marginType === 'string' ? text(row.marginType) : null,
      sourceUpdatedAt: timestamp(row.updateTime) }];
  }));
}

export type BybitScope = 'linear-usdt' | 'linear-usdc' | 'inverse' | 'option';
export async function readBybitPositions(c: BybitCredential, scope: BybitScope, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<Position[]> {
  const info = record(await positionsGet('bybit', c, '/v5/user/query-api', new URLSearchParams(), fetcher, signal));
  if (Number(info.readOnly) !== 1) throw new Error(POSITIONS_FAILED);
  const category = scope.startsWith('linear-') ? 'linear' : scope;
  const settleCoin = scope === 'linear-usdt' ? 'USDT' : scope === 'linear-usdc' ? 'USDC' : undefined;
  const params = new URLSearchParams({ category, limit: '200', ...(settleCoin ? { settleCoin } : {}) });
  const seen = new Set<string>(), items: Json[] = [];
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error(POSITIONS_INVALID);
    const data = record(await positionsGet('bybit', c, '/v5/position/list', params, fetcher, signal));
    if (data.category !== category || typeof data.nextPageCursor !== 'string') throw new Error(POSITIONS_INVALID);
    items.push(...rows(data.list)); if (items.length > 10_000) throw new Error(POSITIONS_INVALID);
    if (!data.nextPageCursor) break;
    if (seen.has(data.nextPageCursor) || data.nextPageCursor.length > 4096) throw new Error(POSITIONS_INVALID);
    seen.add(data.nextPageCursor); params.set('cursor', data.nextPageCursor);
  }
  const metadata = new Map<string, Json>(); const result: Position[] = [];
  for (const row of items) {
    const quantity = decimal(row.size); if (isZero(quantity)) continue;
    if (quantity.startsWith('-') || !['Buy', 'Sell'].includes(String(row.side))) throw new Error(POSITIONS_INVALID);
    const symbol = text(row.symbol);
    if (!metadata.has(symbol)) {
      const data = record(await positionsGet('bybit', c, '/v5/market/instruments-info', new URLSearchParams({ category, symbol }), fetcher, signal));
      const matched = rows(data.list).filter(item => item.symbol === symbol);
      if (matched.length !== 1) throw new Error(POSITIONS_INVALID);
      metadata.set(symbol, matched[0]);
    }
    const instrument = metadata.get(symbol)!; const base = text(instrument.baseCoin), quote = text(instrument.quoteCoin), settlement = text(instrument.settleCoin);
    if (settleCoin && settlement !== settleCoin) throw new Error(POSITIONS_INVALID);
    const item = position(symbol, row.side === 'Buy' ? 'long' : 'short', quantity, category === 'inverse' ? quote : base);
    result.push({ ...item, contractSize: '1', entryPrice: optionalDecimal(row.avgPrice), markPrice: optionalDecimal(row.markPrice),
      notional: optionalDecimal(row.positionValue), unrealizedPnl: optionalDecimal(row.unrealisedPnl), leverage: optionalDecimal(row.leverage),
      liquidationPrice: optionalDecimal(row.liqPrice), priceCurrency: quote, notionalCurrency: category === 'inverse' ? base : quote,
      pnlCurrency: settlement, sourceUpdatedAt: timestamp(row.updatedTime) });
  }
  return uniquePositions(result);
}

export async function readOkxPositions(c: OkxCredential, scope: 'SWAP' | 'FUTURES', fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<Position[]> {
  const config = rows(await positionsGet('okx', c, '/api/v5/account/config', new URLSearchParams(), fetcher, signal));
  if (config.length !== 1 || config[0].perm !== 'read_only') throw new Error(POSITIONS_FAILED);
  const data = rows(await positionsGet('okx', c, '/api/v5/account/positions', new URLSearchParams({ instType: scope }), fetcher, signal));
  const metadata = new Map<string, Json>(), result: Position[] = [];
  for (const row of data) {
    if (row.instType !== scope) throw new Error(POSITIONS_INVALID);
    const parsed = signedQuantity(row, 'pos', 'posSide'); if (!parsed) continue;
    const symbol = text(row.instId);
    if (!metadata.has(symbol)) {
      const items = rows(await positionsGet('okx', c, '/api/v5/public/instruments', new URLSearchParams({ instType: scope, instId: symbol }), fetcher, signal));
      if (items.length !== 1 || items[0].instId !== symbol || items[0].instType !== scope) throw new Error(POSITIONS_INVALID);
      metadata.set(symbol, items[0]);
    }
    const instrument = metadata.get(symbol)!;
    const contractSize = multiplyDecimals(decimal(instrument.ctVal), decimal(instrument.ctMult));
    if (isZero(contractSize) || contractSize.startsWith('-')) throw new Error(POSITIONS_INVALID);
    // ctValCcy is explicit: inverse contracts have a quote-currency face value.
    const faceCurrency = text(instrument.ctValCcy), settlement = text(instrument.settleCcy);
    const pair = text(instrument.uly).split('-'); if (pair.length !== 2) throw new Error(POSITIONS_INVALID);
    const item = position(symbol, parsed.side, parsed.quantity, '张（' + faceCurrency + '/张）');
    result.push({ ...item, id: positionId(symbol, text(row.posId), parsed.side), contractSize,
      entryPrice: optionalDecimal(row.avgPx), markPrice: optionalDecimal(row.markPx), notional: optionalDecimal(row.notionalUsd),
      unrealizedPnl: optionalDecimal(row.upl), leverage: optionalDecimal(row.lever), liquidationPrice: optionalDecimal(row.liqPx),
      priceCurrency: pair[1], notionalCurrency: 'USD', pnlCurrency: settlement, marginMode: text(row.mgnMode), sourceUpdatedAt: timestamp(row.uTime) });
  }
  return uniquePositions(result);
}

export async function readAsterPositions(c: AsterCredential, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<Position[]> {
  const wallet = validateAsterWallet(c); const path = '/fapi/v3/positionRisk';
  if (!ENDPOINTS.aster.has(path)) throw new Error(POSITIONS_FAILED);
  const params = new URLSearchParams({ nonce: nextAsterNonce(), signer: wallet.address });
  const signature = await wallet.signTypedData({ name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' }, { Message: [{ name: 'msg', type: 'string' }] }, { msg: params.toString() });
  params.set('signature', signature);
  const data = await getJson('https://fapi.asterdex.com' + path + '?' + params, {}, fetcher, signal);
  if (!rows(data).some(row => !isZero(decimal(row.positionAmt)))) return [];
  const metadata = await getJson('https://fapi.asterdex.com/fapi/v3/exchangeInfo', {}, fetcher, signal);
  return normalizeLinear(data, metadata);
}
