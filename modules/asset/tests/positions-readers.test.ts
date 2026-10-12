import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Wallet } from 'ethers/wallet';
import { positionsGet, readBinancePositions, readBybitPositions, readOkxPositions, readAsterPositions } from '../lib/positions-readers.ts';
import { asterGet } from '../lib/exchanges.ts';

const c = { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const bybit = { ...c, region: 'global' as const };
const okx = { ...c, passphrase: 'synthetic-passphrase' };
const writes = ['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const permissions = () => ({ enableReading: true, ...Object.fromEntries(writes.map(key => [key, false])) });
const at = 1750000000000;
function mock(handler: (url: URL, init: RequestInit) => unknown): typeof fetch {
  return (async (url, init = {}) => { assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); return Response.json(await handler(new URL(String(url)), init)); }) as typeof fetch;
}
const linearPosition = (positionAmt = '1.000000000000000001', positionSide = 'BOTH') => ({ symbol: 'BTCUSDT', positionAmt, positionSide, entryPrice: '90000.123456789012345678', markPrice: '95000', notional: '95000', unRealizedProfit: '-1.000000000000000001', updateTime: at });
const linearMetadata = { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT' }] };

test('Binance UM and PM UM preserve precision, both hedge legs, fixed GET signature and explicit empty positions', async () => {
  for (const scope of ['um', 'pm-um'] as const) {
    const calls: URL[] = [];
    const result = await readBinancePositions(c, mock((url, init) => {
      calls.push(url);
      if (url.pathname.endsWith('/exchangeInfo')) { assert.deepEqual(init.headers, {}); return linearMetadata; }
      assert.equal((init.headers as Record<string, string>)['X-MBX-APIKEY'], c.apiKey);
      const query = new URLSearchParams(url.search); const signature = query.get('signature'); query.delete('signature');
      assert.equal(signature, createHmac('sha256', c.apiSecret).update(query.toString()).digest('hex'));
      if (url.pathname.includes('apiRestrictions')) return permissions();
      assert.equal(url.hostname, scope === 'um' ? 'fapi.binance.com' : 'papi.binance.com');
      return [linearPosition('1.000000000000000001', 'LONG'), linearPosition('-2', 'SHORT'), linearPosition('0', 'BOTH')];
    }), undefined, scope);
    assert.equal(calls.length, 3); assert.equal(result.length, 2);
    assert.equal(result[0].quantity, '1.000000000000000001'); assert.equal(result[0].entryPrice, '90000.123456789012345678');
    assert.equal(result[0].unrealizedPnl, '-1.000000000000000001'); assert.equal(result[1].quantity, '2'); assert.equal(result[1].side, 'short');
    assert.equal(result[0].quantityUnit, 'BTC'); assert.equal(result[0].pnlCurrency, 'USDT'); assert.notEqual(result[0].id, result[1].id);
    if (scope === 'pm-um') assert.equal(result[0].marginMode, 'portfolio');
  }
  assert.deepEqual(await readBinancePositions(c, mock(url => url.pathname.includes('apiRestrictions') ? permissions() : [])), []);
});

test('Binance CM and PM CM preserve contract counts, face size, and coin P&L without USD conversion', async () => {
  for (const scope of ['cm', 'pm-cm'] as const) {
    const [result] = await readBinancePositions(c, mock(url => {
      if (url.pathname.includes('apiRestrictions')) return permissions();
      if (url.pathname.endsWith('/exchangeInfo')) return { symbols: [{ symbol: 'BTCUSD_PERP', baseAsset: 'BTC', quoteAsset: 'USD', marginAsset: 'BTC', contractSize: 100 }] };
      assert.equal(url.hostname, scope === 'cm' ? 'dapi.binance.com' : 'papi.binance.com');
      return [{ ...linearPosition('-7'), symbol: 'BTCUSD_PERP', unRealizedProfit: '-0.000000000000000001' }];
    }), undefined, scope);
    assert.equal(result.quantity, '7'); assert.equal(result.contractSize, '100'); assert.equal(result.notional, '700');
    assert.equal(result.quantityUnit, '张（USD/张）'); assert.equal(result.notionalCurrency, 'USD'); assert.equal(result.pnlCurrency, 'BTC');
  }
});

test('malformed or unauthorized Binance responses fail rather than returning flat; duplicate rows are rejected', async () => {
  for (const payload of [{}, [{ positionAmt: null }], [{ positionAmt: 0 }], [linearPosition(), linearPosition()]]) {
    await assert.rejects(readBinancePositions(c, mock(url => url.pathname.includes('apiRestrictions') ? permissions() : url.pathname.endsWith('/exchangeInfo') ? linearMetadata : payload)));
  }
  let calls = 0;
  await assert.rejects(readBinancePositions(c, mock(() => { calls++; return { ...permissions(), enableFutures: true }; })));
  assert.equal(calls, 1);
});

const bybitPosition = (side = 'Buy', symbol = 'BTCUSDT') => ({ symbol, side, size: '0.000000000000000001', avgPrice: '100', markPrice: '102', positionValue: '0.000000000000000102', unrealisedPnl: '-0.01', leverage: '', liqPrice: '', updatedTime: String(at) });
test('Bybit follows every cursor and normalizes USDT/USDC/inverse/option using instrument currency metadata', async () => {
  for (const scope of ['linear-usdt', 'linear-usdc', 'inverse', 'option'] as const) {
    const category = scope.startsWith('linear-') ? 'linear' : scope;
    const settleCoin = scope === 'linear-usdt' ? 'USDT' : scope === 'inverse' ? 'BTC' : 'USDC';
    const symbol = scope === 'linear-usdt' ? 'BTCUSDT' : scope === 'linear-usdc' ? 'BTCPERP' : scope === 'inverse' ? 'BTCUSD' : 'BTC-30DEC26-80000-C';
    let pages = 0;
    const result = await readBybitPositions({ ...bybit, region: 'eu' }, scope, mock((url, init) => {
      assert.equal(url.hostname, 'api.bybit.eu');
      if (url.pathname === '/v5/user/query-api') return { retCode: 0, result: { readOnly: 1 } };
      if (url.pathname.includes('instruments-info')) { assert.deepEqual(init.headers, {}); return { retCode: 0, result: { list: [{ symbol, baseCoin: 'BTC', quoteCoin: category === 'inverse' ? 'USD' : settleCoin, settleCoin }] } }; }
      const headers = init.headers as Record<string, string>;
      assert.equal(headers['X-BAPI-SIGN'], createHmac('sha256', c.apiSecret).update(headers['X-BAPI-TIMESTAMP'] + c.apiKey + '10000' + url.search.slice(1)).digest('hex'));
      assert.equal(url.searchParams.get('category'), category); assert.equal(url.searchParams.get('limit'), '200');
      if (category === 'linear') assert.equal(url.searchParams.get('settleCoin'), settleCoin);
      const cursor = url.searchParams.get('cursor'); if (pages++) assert.equal(cursor, 'second page +/&');
      return { retCode: 0, result: { category, list: [bybitPosition(cursor ? 'Sell' : 'Buy', symbol)], nextPageCursor: cursor ? '' : 'second page +/&' } };
    }));
    assert.equal(pages, 2); assert.equal(result.length, 2); assert.equal(result[0].quantity, '0.000000000000000001');
    assert.equal(result[0].pnlCurrency, settleCoin); assert.equal(result[0].leverage, null); assert.equal(result[0].liquidationPrice, null);
    assert.equal(result[0].notionalCurrency, category === 'inverse' ? 'BTC' : settleCoin);
    assert.equal(result[0].quantityUnit, category === 'inverse' ? 'USD' : 'BTC'); assert.equal(result[1].side, 'short');
  }
});

test('Bybit missing cursor, repeating cursor, failed later page and malformed records never produce partial results', async () => {
  for (const scenario of ['missing', 'loop', 'failure', 'bad-row']) {
    let page = 0;
    await assert.rejects(readBybitPositions(bybit, 'linear-usdt', mock(url => {
      if (url.pathname.endsWith('query-api')) return { retCode: 0, result: { readOnly: 1 } };
      if (scenario === 'failure' && page++) return { retCode: 10001, retMsg: 'SECRET PROVIDER CONTENT' };
      return { retCode: 0, result: { category: 'linear', list: scenario === 'bad-row' ? [{}] : [bybitPosition()],
        ...(scenario === 'missing' ? {} : { nextPageCursor: scenario === 'bad-row' ? '' : 'same' }) } };
    })));
  }
});

test('OKX keeps contract count and ctVal × ctMult exactly, preserving inverse settlement and nullable fields', async () => {
  for (const inverse of [false, true]) {
    const symbol = inverse ? 'BTC-USD-SWAP' : 'BTC-USDT-SWAP';
    const result = await readOkxPositions(okx, 'SWAP', mock((url, init) => {
      if (url.pathname.endsWith('/config')) return { code: '0', data: [{ perm: 'read_only' }] };
      if (url.pathname.endsWith('/instruments')) {
        assert.deepEqual(init.headers, {}); return { code: '0', data: [{ instId: symbol, instType: 'SWAP', uly: inverse ? 'BTC-USD' : 'BTC-USDT', settleCcy: inverse ? 'BTC' : 'USDT', ctVal: inverse ? '100' : '0.010000000000000001', ctMult: '2', ctValCcy: inverse ? 'USD' : 'BTC' }] };
      }
      const headers = init.headers as Record<string, string>;
      assert.equal(headers['OK-ACCESS-SIGN'], createHmac('sha256', c.apiSecret).update(headers['OK-ACCESS-TIMESTAMP'] + 'GET' + url.pathname + url.search).digest('base64'));
      return { code: '0', data: [{ instId: symbol, instType: 'SWAP', pos: '-3', posSide: 'net', posId: '123', mgnMode: 'cross', avgPx: '100000', markPx: '99000', notionalUsd: '600', upl: '-0.001', lever: '5', liqPx: '', uTime: String(at) }] };
    }));
    assert.equal(result[0].quantity, '3'); assert.equal(result[0].side, 'short'); assert.equal(result[0].contractSize, inverse ? '200' : '0.020000000000000002');
    assert.equal(result[0].quantityUnit, inverse ? '张（USD/张）' : '张（BTC/张）'); assert.equal(result[0].pnlCurrency, inverse ? 'BTC' : 'USDT');
    assert.equal(result[0].notionalCurrency, 'USD'); assert.equal(result[0].liquidationPrice, null);
  }
});

test('Aster uses its fixed API Pro GET and retains separate hedge positions', async () => {
  const privateKey = '0'.repeat(63) + '1'; const wallet = new Wallet(privateKey);
  const result = await readAsterPositions({ privateKey, walletAddress: wallet.address, includeSpot: true }, mock(url => {
    assert.equal(url.hostname, 'fapi.asterdex.com');
    if (url.pathname.endsWith('exchangeInfo')) return linearMetadata;
    assert.equal(url.pathname, '/fapi/v3/positionRisk'); assert.equal(url.searchParams.get('signer'), wallet.address);
    assert.ok(url.searchParams.get('signature')?.startsWith('0x')); assert.equal(url.search.includes(privateKey), false);
    return [linearPosition('3', 'LONG'), linearPosition('-4', 'SHORT')];
  }));
  assert.equal(result.length, 2); assert.equal(result[0].side, 'long'); assert.equal(result[1].side, 'short');
});

test('Aster balance and position reads allocate distinct nonces for the same wallet in the same millisecond', async t => {
  t.mock.method(Date, 'now', () => at);
  const privateKey = '0'.repeat(63) + '1', wallet = new Wallet(privateKey);
  const c = { privateKey, walletAddress: wallet.address, includeSpot: false };
  const nonces: string[] = [];
  const fetcher = (async (input, init) => {
    assert.equal(init?.method, 'GET'); const url = new URL(String(input));
    nonces.push(url.searchParams.get('nonce')!); return Response.json(url.pathname.endsWith('positionRisk') ? [] : { assets: [] });
  }) as typeof fetch;
  await Promise.all([asterGet(c, '/fapi/v3/accountWithJoinMargin', fetcher), readAsterPositions(c, fetcher)]);
  assert.equal(nonces.length, 2); assert.equal(new Set(nonces).size, 2);
});

test('read allowlists and sanitized transport errors prevent writes, redirects, signed URLs and upstream secrets from escaping', async () => {
  for (const exchange of ['binance', 'bybit', 'okx'] as const) {
    await assert.rejects(positionsGet(exchange, { ...okx, region: 'global' }, '/order', new URLSearchParams(), mock(() => assert.fail('network must not run'))), /只读/);
  }
  const secretFailure = (async () => { throw new Error('https://upstream?signature=PRIVATE ' + c.apiSecret); }) as typeof fetch;
  await assert.rejects(readBinancePositions(c, secretFailure), error => error instanceof Error && !error.message.includes('PRIVATE') && !error.message.includes(c.apiSecret));
  const redirect = (async () => new Response('', { status: 302, headers: { Location: 'https://evil.invalid' } })) as typeof fetch;
  await assert.rejects(readBinancePositions(c, redirect));
  const badJson = (async () => new Response('PRIVATE ' + c.apiSecret)) as typeof fetch;
  await assert.rejects(readBinancePositions(c, badJson), error => error instanceof Error && !error.message.includes(c.apiSecret));
});
